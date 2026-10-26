// Run ingestion: one cached artifact read back from the store and run through the adapters.
import { Effect } from "effect";
import { runAdapters, type FileRef, type RunContext } from "@quality-sh/tag-adapters";
import { withTags } from "@quality-sh/tag-schema";
import type { ArtifactMeta, RunMeta } from "./artifact-source.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { ResultStore } from "./result-store.ts";
import { type IngestError, type Interface, type RecordError } from "./ingest-contract.ts";
import { COMPLETE } from "./ingest-cache.ts";
import { ZipError } from "./zip.ts";

/** Cache an artifact, then read its files and index every report the adapters produce. */
export type IngestArtifact = (
  run: RunMeta,
  artifact: ArtifactMeta,
  acc: { reports: number; inserted: number; cached: number },
) => Effect.Effect<
  { readonly files: ReadonlyArray<FileRef>; readonly reports: number },
  IngestError
>;

export const makeIngestArtifact = (deps: {
  readonly store: ArtifactStore.Interface;
  readonly results: ResultStore.Interface;
  readonly cacheArtifact: Interface["cacheArtifact"];
}) => {
  const { store, results, cacheArtifact } = deps;

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

  const contextOf = (run: RunMeta, artifact: ArtifactMeta): RunContext => ({
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
  });

  const ingestArtifact = Effect.fn("Ingest.ingestArtifact")(function* (
    run: RunMeta,
    artifact: ArtifactMeta,
    acc: { reports: number; inserted: number; cached: number },
  ) {
    const { prefix, fetched } = yield* cacheArtifact(artifact);
    if (fetched) acc.cached++;
    const files = yield* filesUnder(prefix);
    const produced = yield* Effect.tryPromise({
      try: () => runAdapters({ files, context: contextOf(run, artifact) }),
      catch: (cause) =>
        new ZipError({
          reason: `adapter failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    let reports = 0;
    for (const { adapter, reports: group } of produced) {
      for (const report of group) {
        reports++;
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
    return { files, reports };
  });

  return { ingestArtifact };
};

/** What indexing one run adds to the tally of the pass or the queued ingest around it. */
export interface RunTally {
  runs: number;
  artifacts: number;
  reports: number;
  inserted: number;
  cached: number;
  readonly errors: string[];
}

/**
 * One run, wherever it was found: record a fresh run's artifacts and mark it seen, then
 * cache and index each artifact. A failed artifact stays "listed" for the next attempt.
 */
export const makeIndexRun = (deps: {
  readonly results: ResultStore.Interface;
  readonly ingestArtifact: IngestArtifact;
  readonly recordError: RecordError;
}) => {
  const { results, ingestArtifact, recordError } = deps;

  /** A seen run's artifacts still waiting for a download, read from the index. */
  const indexedArtifacts = Effect.fn("Ingest.indexedArtifacts")(function* (run: RunMeta) {
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

  const indexRun = Effect.fn("Ingest.indexRun")(function* (
    run: RunMeta,
    listed: ReadonlyArray<ArtifactMeta>,
    fresh: boolean,
    acc: RunTally,
  ) {
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

  return { indexedArtifacts, indexRun };
};

export type IndexRun = ReturnType<typeof makeIndexRun>;
