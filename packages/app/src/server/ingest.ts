// The pipeline: source -> zip -> store -> adapters -> result store. Idempotent at every step.
import { Context, Deferred, Effect, Exit, Layer, Option, Ref as StateRef, Semaphore } from "effect";
import { runAdapters, type FileRef, type RunContext } from "@quality-sh/tag-adapters";
import { withTags } from "@quality-sh/tag-schema";
import type { Ref } from "../grouping.ts";
import { AppConfig } from "./config.ts";
import {
  ArtifactSource,
  type ArtifactMeta,
  type RepoRef,
  type RunMeta,
} from "./artifact-source.ts";
import { ArtifactStore, contentTypeFor } from "./artifact-store.ts";
import { ResultStore } from "./result-store.ts";
import { extractZip, ZipError } from "./zip.ts";

export interface IngestSummary {
  readonly waits: number;
  readonly remaining: number | null;
  readonly runs: number;
  readonly refs: number;
  readonly artifacts: number;
  readonly cached: number;
  readonly reports: number;
  readonly inserted: number;
  readonly errors: ReadonlyArray<string>;
}

export interface IngestPass {
  readonly passId: string;
  readonly startedAt: string;
  readonly repositories: ReadonlyArray<{
    readonly repository: RepoRef;
    readonly summary: IngestSummary;
  }>;
  readonly currentRepository: RepoRef | null;
  readonly errors: ReadonlyArray<string>;
}

export interface IngestStatus {
  readonly running: IngestPass | null;
  readonly lastFinished:
    (IngestPass & { readonly finishedAt: string; readonly summary: IngestSummary }) | null;
}

type IngestOptions = { readonly limit?: number; readonly branch?: string };

const emptySummary = (): IngestSummary => ({
  waits: 0,
  remaining: null,
  runs: 0,
  refs: 0,
  artifacts: 0,
  cached: 0,
  reports: 0,
  inserted: 0,
  errors: [],
});

const addSummary = (total: IngestSummary, next: IngestSummary): IngestSummary => ({
  waits: total.waits + next.waits,
  remaining: next.remaining,
  runs: total.runs + next.runs,
  refs: total.refs + next.refs,
  artifacts: total.artifacts + next.artifacts,
  cached: total.cached + next.cached,
  reports: total.reports + next.reports,
  inserted: total.inserted + next.inserted,
  errors: [...total.errors, ...next.errors],
});

export interface Interface {
  /** Start a service-owned pass, or return the pass already running. */
  readonly start: (
    repo?: RepoRef,
    opts?: IngestOptions,
  ) => Effect.Effect<{ readonly passId: string }>;
  readonly status: () => Effect.Effect<IngestStatus>;

  /** Discover recent runs for a repository and ingest every artifact. */
  readonly ingestRepo: (
    repo: RepoRef,
    opts?: { readonly limit?: number; readonly branch?: string },
  ) => Effect.Effect<IngestSummary, never>;
  /** Every repository the source knows about. */
  readonly ingestAll: (opts?: { readonly limit?: number }) => Effect.Effect<IngestSummary, never>;
  /** Make sure an artifact's files are in the store; returns the key prefix. */
  readonly cacheArtifact: (
    artifact: ArtifactMeta,
  ) => Effect.Effect<
    { readonly prefix: string; readonly fetched: boolean },
    ArtifactSource.SourceError | ArtifactStore.StoreError | ZipError | ResultStore.DbError
  >;
}

export class Service extends Context.Service<Service, Interface>()("@tag/Ingest") {}

export const artifactPrefix = (a: { owner: string; repo: string; artifactId: string }) =>
  `artifacts/${a.owner}/${a.repo}/${a.artifactId}/`;

const COMPLETE = ".complete";
const DAY = 86_400_000;

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    const source = yield* ArtifactSource.Service;
    const store = yield* ArtifactStore.Service;
    const results = yield* ResultStore.Service;
    const scope = yield* Effect.scope;
    const status = yield* StateRef.make<IngestStatus>({ running: null, lastFinished: null });
    const updateProgress = (f: (pass: IngestPass) => IngestPass) =>
      StateRef.update(status, (state) => ({
        ...state,
        running: state.running ? f(state.running) : null,
      }));
    const recordError = (errors: string[], message: string) => {
      errors.push(message);
      return updateProgress((pass) => ({ ...pass, errors: [...pass.errors, message] }));
    };

    const cacheArtifact = Effect.fn("Ingest.cacheArtifact")(function* (artifact: ArtifactMeta) {
      const prefix = artifactPrefix(artifact);
      const done = yield* store.has(prefix + COMPLETE);
      if (done) {
        // The files are there (an earlier run, or a rebuilt index): say so, or retention never sees them.
        yield* results.upsertArtifact({
          artifactId: artifact.artifactId,
          owner: artifact.owner,
          repo: artifact.repo,
          runId: artifact.runId,
          name: artifact.name,
          sizeBytes: artifact.sizeBytes,
          expiresAt: artifact.expiresAt ?? null,
          state: "cached",
          cachedAt: null,
        });
        return { prefix, fetched: false };
      }
      const zip = yield* source.openArtifact(artifact);
      const entries = yield* Effect.try({
        try: () => extractZip(zip),
        catch: (e) => (e instanceof ZipError ? e : new ZipError({ reason: String(e) })),
      });
      for (const e of entries) yield* store.put(prefix + e.path, e.bytes, contentTypeFor(e.path));
      yield* store.put(
        prefix + COMPLETE,
        new TextEncoder().encode(
          JSON.stringify({ files: entries.length, cachedAt: new Date().toISOString() }),
        ),
        "application/json",
      );
      yield* results.upsertArtifact({
        artifactId: artifact.artifactId,
        owner: artifact.owner,
        repo: artifact.repo,
        runId: artifact.runId,
        name: artifact.name,
        sizeBytes: artifact.sizeBytes,
        expiresAt: artifact.expiresAt ?? null,
        state: "cached",
        cachedAt: new Date().toISOString(),
      });
      yield* Effect.logInfo(
        `cached ${artifact.owner}/${artifact.repo} ${artifact.artifactId} (${entries.length} files)`,
      );
      return { prefix, fetched: true };
    });

    const filesUnder = Effect.fn("Ingest.filesUnder")(function* (prefix: string) {
      const keys = yield* store.list(prefix);
      const refs: FileRef[] = [];
      for (const key of keys) {
        const path = key.slice(prefix.length);
        if (path === COMPLETE) continue;
        refs.push({
          path,
          size: 0,
          text: async () => {
            const b = await Effect.runPromise(store.get(key));
            return b._tag === "Some" ? new TextDecoder().decode(b.value.bytes) : "";
          },
          bytes: async () => {
            const b = await Effect.runPromise(store.get(key));
            return b._tag === "Some" ? b.value.bytes : new Uint8Array();
          },
        });
      }
      return refs;
    });

    const ingestArtifact = Effect.fn("Ingest.ingestArtifact")(function* (
      run: RunMeta,
      artifact: ArtifactMeta,
      acc: { reports: number; inserted: number; cached: number },
    ) {
      const { prefix, fetched } = yield* cacheArtifact(artifact);
      if (fetched) acc.cached++;
      const files = yield* filesUnder(prefix);
      const context: RunContext = {
        owner: run.owner,
        repo: run.repo,
        runId: run.runId,
        artifactName: artifact.name,
        ...(run.branch ? { branch: run.branch } : {}),
        ...(run.commit ? { commit: run.commit } : {}),
        ...(run.buildUrl ? { buildUrl: run.buildUrl } : {}),
        ...(run.timestamp ? { timestamp: run.timestamp } : {}),
        ...(run.workflow ? { workflow: run.workflow } : {}),
        ...(run.environment ? { environment: run.environment } : {}),
      };
      const produced = yield* Effect.tryPromise({
        try: () => runAdapters({ files, context }),
        catch: (cause) =>
          new ZipError({
            reason: `adapter failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      });
      for (const { adapter, reports } of produced) {
        for (const report of reports) {
          acc.reports++;
          const r = yield* results.ingest(withTags(report, run.tags ?? []), {
            owner: run.owner,
            repo: run.repo,
            adapter,
            artifactId: artifact.artifactId,
            artifactName: artifact.name,
          });
          if (r.inserted) acc.inserted++;
        }
      }
    });

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
        results
          .upsertRepository({ ...repo, state, backfillDone, backfillTotal })
          .pipe(Effect.ignore);
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
      // The repository's own default branch and environments, for the views that compare runs.
      const info = yield* source
        .repoInfo(repo)
        .pipe(
          Effect.catchCause((c) =>
            recordError(acc.errors, `repoInfo ${repo.owner}/${repo.repo}: ${String(c)}`).pipe(
              Effect.as(null),
            ),
          ),
        );
      if (info !== null)
        yield* results
          .upsertScan({
            owner: repo.owner,
            repo: repo.repo,
            defaultBranch: info.defaultBranch,
            environments: info.environments,
            classification: null,
            reporting: [],
            unread: [],
            runners: [],
            names: [],
            scannedAt: null,
          })
          .pipe(Effect.ignore);
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
            return recordError(
              acc.errors,
              `listRuns ${repo.owner}/${repo.repo}: ${String(c)}`,
            ).pipe(Effect.as([] as ReadonlyArray<RunMeta>));
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
      const after = yield* source.requestStats();
      acc.waits = after.waits - before.waits;
      acc.remaining = after.remaining;
      yield* Effect.logInfo(
        `ingest ${repo.owner}/${repo.repo}: ${acc.runs} runs, ${acc.artifacts} artifacts, ${acc.inserted} new reports, ${acc.waits} waits, ${acc.remaining ?? "unknown"} requests remaining${acc.errors.length ? `, ${acc.errors.length} errors` : ""}`,
      );
      return acc;
    });

    const runPass = Effect.fn("Ingest.runPass")(function* (repo?: RepoRef, opts?: IngestOptions) {
      const before = yield* source.requestStats();
      const repos = repo
        ? [repo]
        : yield* source
            .repos()
            .pipe(
              Effect.catch((error) =>
                recordError([], `repos: ${error.detail}`).pipe(
                  Effect.as([] as ReadonlyArray<RepoRef>),
                ),
              ),
            );
      let total = emptySummary();
      for (const repository of repos) {
        yield* updateProgress((pass) => ({ ...pass, currentRepository: repository }));
        const summary = yield* ingestRepo(repository, opts);
        total = addSummary(total, summary);
        yield* updateProgress((pass) => ({
          ...pass,
          currentRepository: null,
          repositories: [...pass.repositories, { repository, summary }],
        }));
      }
      const after = yield* source.requestStats();
      return { ...total, waits: after.waits - before.waits, remaining: after.remaining };
    });

    // Admission is short: requests share the active job while its fiber owns the work.
    const admission = yield* Semaphore.make(1);
    let active: {
      readonly passId: string;
      readonly done: Deferred.Deferred<IngestSummary>;
    } | null = null;
    const launch = Effect.fn("Ingest.launch")(
      function* (repo: RepoRef | undefined, opts: IngestOptions | undefined) {
        if (active) return { job: active, started: false };
        const job = { passId: crypto.randomUUID(), done: yield* Deferred.make<IngestSummary>() };
        const pass: IngestPass = {
          passId: job.passId,
          startedAt: new Date().toISOString(),
          repositories: [],
          currentRepository: null,
          errors: [],
        };
        yield* StateRef.update(status, (state) => ({ ...state, running: pass }));
        active = job;
        yield* runPass(repo, opts).pipe(
          Effect.onExit((exit) =>
            admission.withPermits(1)(
              Effect.gen(function* () {
                const state = yield* StateRef.get(status);
                const progress = state.running ?? pass;
                const summary = Exit.isSuccess(exit)
                  ? exit.value
                  : progress.repositories.reduce(
                      (total, entry) => addSummary(total, entry.summary),
                      emptySummary(),
                    );
                const errors = Exit.isFailure(exit)
                  ? [...progress.errors, String(exit.cause)]
                  : progress.errors;
                const finished = { ...summary, errors };
                yield* StateRef.set(status, {
                  running: null,
                  lastFinished: {
                    ...progress,
                    currentRepository: null,
                    errors,
                    finishedAt: new Date().toISOString(),
                    summary: finished,
                  },
                });
                active = null;
                yield* Deferred.succeed(job.done, finished);
              }),
            ),
          ),
          Effect.forkIn(scope),
        );
        return { job, started: true };
      },
      (effect) => effect.pipe(admission.withPermits(1), Effect.uninterruptible),
    );

    // Synchronous callers still request their own pass after any current one ends.
    const ingest = Effect.fn("Ingest.ingest")(function* (repo?: RepoRef, opts?: IngestOptions) {
      let launched = yield* launch(repo, opts);
      while (!launched.started) {
        yield* Deferred.await(launched.job.done);
        launched = yield* launch(repo, opts);
      }
      return yield* Deferred.await(launched.job.done);
    });
    return Service.of({
      start: Effect.fn("Ingest.start")(function* (repo, opts) {
        const { job } = yield* launch(repo, opts);
        return { passId: job.passId };
      }),
      status: () => StateRef.get(status),
      ingestRepo: (repo, opts) => ingest(repo, opts),
      ingestAll: (opts) => ingest(undefined, opts),
      cacheArtifact,
    });
  }),
);

export * as Ingest from "./ingest.ts";
