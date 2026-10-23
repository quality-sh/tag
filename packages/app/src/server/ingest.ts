// The pipeline: source -> zip -> store -> adapters -> result store. Idempotent at every step.
import { Context, Effect, Layer } from "effect";
import { runAdapters, type FileRef, type RunContext } from "@quality-sh/verdict-adapters";
import { withTags } from "@quality-sh/verdict-schema";
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
  readonly runs: number;
  readonly refs: number;
  readonly artifacts: number;
  readonly cached: number;
  readonly reports: number;
  readonly inserted: number;
  readonly errors: ReadonlyArray<string>;
}

export interface Interface {
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

export class Service extends Context.Service<Service, Interface>()("@verdict/Ingest") {}

export const artifactPrefix = (a: { owner: string; repo: string; artifactId: string }) =>
  `artifacts/${a.owner}/${a.repo}/${a.artifactId}/`;

const COMPLETE = ".complete";

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    const source = yield* ArtifactSource.Service;
    const store = yield* ArtifactStore.Service;
    const results = yield* ResultStore.Service;

    const cacheArtifact = Effect.fn("Ingest.cacheArtifact")(function* (artifact: ArtifactMeta) {
      const prefix = artifactPrefix(artifact);
      const done = yield* store.has(prefix + COMPLETE);
      if (done) return { prefix, fetched: false };
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
      const acc = {
        runs: 0,
        refs: 0,
        artifacts: 0,
        reports: 0,
        inserted: 0,
        cached: 0,
        errors: [] as string[],
      };
      const refs = yield* source.listRefs(repo).pipe(
        Effect.catchCause((c) => {
          acc.errors.push(`listRefs ${repo.owner}/${repo.repo}: ${String(c)}`);
          return Effect.succeed([] as ReadonlyArray<Ref>);
        }),
      );
      for (const ref of refs) {
        yield* results.upsertRef(ref).pipe(Effect.ignore);
        acc.refs++;
      }
      const runs = yield* source
        .listRuns(repo, {
          limit: opts?.limit ?? 20,
          ...(opts?.branch ? { branch: opts.branch } : {}),
        })
        .pipe(
          Effect.catchCause((c) => {
            acc.errors.push(`listRuns ${repo.owner}/${repo.repo}: ${String(c)}`);
            return Effect.succeed([] as ReadonlyArray<RunMeta>);
          }),
        );
      for (const run of runs) {
        acc.runs++;
        const artifacts = yield* source.listArtifacts(run).pipe(
          Effect.catchCause((c) => {
            acc.errors.push(`listArtifacts ${run.runId}: ${String(c)}`);
            return Effect.succeed([] as ReadonlyArray<ArtifactMeta>);
          }),
        );
        for (const artifact of artifacts) {
          acc.artifacts++;
          yield* results
            .upsertArtifact({
              artifactId: artifact.artifactId,
              owner: artifact.owner,
              repo: artifact.repo,
              runId: artifact.runId,
              name: artifact.name,
              sizeBytes: artifact.sizeBytes,
              expiresAt: artifact.expiresAt ?? null,
              state: artifact.expired ? "expired" : "listed",
              cachedAt: null,
            })
            .pipe(Effect.ignore);
          if (artifact.expired) continue;
          yield* ingestArtifact(run, artifact, acc).pipe(
            Effect.catchCause((c) => {
              acc.errors.push(`${run.runId}/${artifact.name}: ${String(c)}`);
              return Effect.void;
            }),
          );
        }
      }
      yield* Effect.logInfo(
        `ingest ${repo.owner}/${repo.repo}: ${acc.runs} runs, ${acc.artifacts} artifacts, ${acc.inserted} new reports${acc.errors.length ? `, ${acc.errors.length} errors` : ""}`,
      );
      return acc;
    });

    const ingestAll = Effect.fn("Ingest.ingestAll")(function* (opts?: { readonly limit?: number }) {
      const repos = yield* source
        .repos()
        .pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<RepoRef>)));
      const total = {
        runs: 0,
        refs: 0,
        artifacts: 0,
        reports: 0,
        inserted: 0,
        cached: 0,
        errors: [] as string[],
      };
      for (const repo of repos) {
        const s = yield* ingestRepo(repo, opts);
        total.runs += s.runs;
        total.refs += s.refs;
        total.artifacts += s.artifacts;
        total.reports += s.reports;
        total.inserted += s.inserted;
        total.cached += s.cached;
        total.errors.push(...s.errors);
      }
      return total;
    });

    void cfg;
    return Service.of({ ingestRepo, ingestAll, cacheArtifact });
  }),
);

export * as Ingest from "./ingest.ts";
