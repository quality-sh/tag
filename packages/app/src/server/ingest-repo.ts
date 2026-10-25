// The repository pass: backfill state, every run in the window, and the scan riding along.
import { Effect, Option } from "effect";
import type { Ref } from "../grouping.ts";
import {
  type ArtifactMeta,
  type ArtifactSource,
  type RepoRef,
  type RunMeta,
} from "./artifact-source.ts";
import { AppConfig } from "./config.ts";
import { ResultStore } from "./result-store.ts";
import type { RecordError } from "./ingest-contract.ts";
import type { IngestArtifact } from "./ingest-run.ts";
import type { ScanRepo } from "./ingest-scan.ts";

const DAY = 86_400_000;

export const makeIngestRepo = (deps: {
  readonly cfg: AppConfig.Interface;
  readonly source: ArtifactSource.Interface;
  readonly results: ResultStore.Interface;
  readonly ingestArtifact: IngestArtifact;
  readonly scanRepo: ScanRepo;
  readonly recordError: RecordError;
}) => {
  const { cfg, source, results, ingestArtifact, scanRepo, recordError } = deps;
  const ingestRepo = Effect.fn("Ingest.ingestRepo")(function* (
    repo: RepoRef,
    opts?: { readonly limit?: number; readonly branch?: string },
  ) {
    const before = yield* source.requestStats();
    const acc = {
      waits: 0,
      remaining: null as number | null,
      runs: 0,
      refs: 0,
      artifacts: 0,
      reports: 0,
      inserted: 0,
      cached: 0,
      errors: [] as string[],
    };
    // First sight, or a walk cut short earlier: take every run inside the retention window,
    // newest first, and record progress so the pages can show it and a restart resumes it.
    const known = yield* results
      .repository(repo.owner, repo.repo)
      .pipe(Effect.catchCause(() => Effect.succeed(Option.none<ResultStore.RepositoryRow>())));
    const backfill = !opts?.branch && (Option.isNone(known) || known.value.state !== "current");
    const setState = (
      state: ResultStore.RepositoryRow["state"],
      backfillDone: number,
      backfillTotal: number | null,
    ) =>
      results.upsertRepository({ ...repo, state, backfillDone, backfillTotal }).pipe(Effect.ignore);
    if (Option.isNone(known)) yield* setState("new", 0, null);
    const since =
      backfill && cfg.artifactRetentionDays > 0
        ? new Date(Date.now() - cfg.artifactRetentionDays * DAY).toISOString()
        : undefined;
    const refs = yield* source.listRefs(repo).pipe(
      Effect.catchCause((c) => {
        return recordError(acc.errors, `listRefs ${repo.owner}/${repo.repo}: ${String(c)}`).pipe(
          Effect.as([] as ReadonlyArray<Ref>),
        );
      }),
    );
    for (const ref of refs) {
      yield* results.upsertRef(ref).pipe(Effect.ignore);
      acc.refs++;
    }
    // The repository's own default branch and environments, for the scan row and the views.
    const info = yield* source
      .repoInfo(repo)
      .pipe(
        Effect.catchCause((c) =>
          recordError(acc.errors, `repoInfo ${repo.owner}/${repo.repo}: ${String(c)}`).pipe(
            Effect.as(null),
          ),
        ),
      );
    let runsListed = true;
    const runs = yield* source
      .listRuns(
        repo,
        backfill
          ? { limit: Infinity, ...(since ? { since } : {}) }
          : { limit: opts?.limit ?? 20, ...(opts?.branch ? { branch: opts.branch } : {}) },
      )
      .pipe(
        Effect.catchCause((c) => {
          runsListed = false;
          return recordError(acc.errors, `listRuns ${repo.owner}/${repo.repo}: ${String(c)}`).pipe(
            Effect.as([] as ReadonlyArray<RunMeta>),
          );
        }),
      );
    const progress = { done: 0 };
    if (backfill && runsListed) yield* setState("backfilling", 0, runs.length);
    const seen = yield* results
      .seenRuns(repo.owner, repo.repo)
      .pipe(Effect.catchCause(() => Effect.succeed(new Set<string>() as ReadonlySet<string>)));
    const unseen = new Set(runs.filter((run) => !seen.has(run.runId)).map((run) => run.runId));
    const artifacts = yield* source.listRepoArtifacts(repo, unseen).pipe(
      Effect.catch((error) => {
        return recordError(
          acc.errors,
          `listRepoArtifacts ${repo.owner}/${repo.repo}: ${String(error)}`,
        ).pipe(Effect.as(undefined));
      }),
    );
    const byRun = new Map<string, ArtifactMeta[]>();
    for (const artifact of artifacts ?? []) {
      const group = byRun.get(artifact.runId) ?? [];
      group.push(artifact);
      byRun.set(artifact.runId, group);
    }
    // A completed run never changes. Retry failed downloads from its indexed rows.
    const artifactsOf = Effect.fn("Ingest.artifactsOf")(function* (run: RunMeta) {
      if (!seen.has(run.runId)) return byRun.get(run.runId) ?? [];
      const rows = yield* results.artifactsOfRun(run.owner, run.repo, run.runId);
      return rows
        .filter((r) => r.state === "listed")
        .map((r): ArtifactMeta => ({
          artifactId: r.artifactId,
          owner: r.owner,
          repo: r.repo,
          runId: r.runId,
          name: r.name,
          sizeBytes: r.sizeBytes,
          ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
        }));
    });
    const ingestRun = Effect.fn("Ingest.ingestRun")(function* (run: RunMeta) {
      const fresh = !seen.has(run.runId);
      if (fresh && artifacts === undefined) return;
      const listed = yield* artifactsOf(run);
      if (!fresh && listed.length === 0) return;
      acc.runs++;
      if (fresh) {
        for (const artifact of listed) {
          yield* results.upsertArtifact({
            artifactId: artifact.artifactId,
            owner: artifact.owner,
            repo: artifact.repo,
            runId: artifact.runId,
            name: artifact.name,
            sizeBytes: artifact.sizeBytes,
            expiresAt: artifact.expiresAt ?? null,
            state: artifact.expired ? "expired" : "listed",
            cachedAt: null,
          });
        }
        yield* results.markRunSeen(run.owner, run.repo, run.runId);
      }
      for (const artifact of listed) {
        acc.artifacts++;
        if (artifact.expired) continue;
        yield* ingestArtifact(run, artifact, acc).pipe(
          Effect.catchCause((c) => {
            return recordError(acc.errors, `${run.runId}/${artifact.name}: ${String(c)}`);
          }),
        );
      }
    });
    // A few runs at a time: GitHub's secondary limits frown on a burst of parallel calls.
    yield* Effect.forEach(
      runs,
      (run) =>
        ingestRun(run).pipe(
          Effect.catch((error) => {
            return recordError(acc.errors, `index ${run.runId}: ${String(error)}`);
          }),
          Effect.andThen(() =>
            backfill ? setState("backfilling", ++progress.done, runs.length) : Effect.void,
          ),
        ),
      { concurrency: 4, discard: true },
    );
    // Caught up once every run in the window has its artifacts indexed. A failed listing
    // leaves the walk open, so the next pass takes it up again.
    if (backfill && runsListed && artifacts !== undefined)
      yield* setState("current", runs.length, runs.length);
    // The scan rides the pass's own semaphore; a failure leaves the last scan row intact.
    if (info !== null)
      yield* scanRepo(repo, info, runs, acc).pipe(
        Effect.catchCause((c) =>
          recordError(acc.errors, `scan ${repo.owner}/${repo.repo}: ${String(c)}`),
        ),
      );
    const after = yield* source.requestStats();
    acc.waits = after.waits - before.waits;
    acc.remaining = after.remaining;
    yield* Effect.logInfo(
      `ingest ${repo.owner}/${repo.repo}: ${acc.runs} runs, ${acc.artifacts} artifacts, ${acc.inserted} new reports, ${acc.waits} waits, ${acc.remaining ?? "unknown"} requests remaining${acc.errors.length ? `, ${acc.errors.length} errors` : ""}`,
    );
    return acc;
  });
  return { ingestRepo };
};
