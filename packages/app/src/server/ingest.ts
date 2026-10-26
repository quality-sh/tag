// The pipeline entry: source -> zip -> store -> adapters -> result store. Idempotent at every step.
import { Duration, Effect, Layer, Semaphore, Ref as StateRef } from "effect";
import { AppConfig } from "./config.ts";
import { ArtifactSource, type RepoRef } from "./artifact-source.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { ResultStore } from "./result-store.ts";
import {
  type IngestPass,
  type IngestStatus,
  type RecordError,
  Service,
} from "./ingest-contract.ts";
import { makeCacheArtifact } from "./ingest-cache.ts";
import { makeIndexRun, makeIngestArtifact } from "./ingest-run.ts";
import { makeScanRepo } from "./ingest-scan.ts";
import { makeIngestRepo } from "./ingest-repo.ts";
import { makePass } from "./ingest-pass.ts";
import { makeQueueWorker } from "./ingest-queue.ts";

export * from "./ingest-contract.ts";
export { artifactPrefix } from "./ingest-cache.ts";

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

    // One repository at a time, whether a pass or a queued run reaches it first.
    const repoLocks = new Map<string, Semaphore.Semaphore>();
    const withRepoLock =
      (repo: RepoRef) =>
      <A, E>(effect: Effect.Effect<A, E>) =>
        Effect.suspend(() => {
          const key = `${repo.owner}/${repo.repo}`;
          const lock = repoLocks.get(key) ?? Semaphore.makeUnsafe(1);
          repoLocks.set(key, lock);
          return lock.withPermits(1)(effect);
        });

    const { cacheArtifact } = makeCacheArtifact({ store, source, results });
    const { ingestArtifact } = makeIngestArtifact({ store, results, cacheArtifact });
    const indexRunWith = (record: RecordError) =>
      makeIndexRun({ results, ingestArtifact, recordError: record });
    const { scanRepo } = makeScanRepo({ source, results, ingestArtifact });
    const { ingestRepo } = makeIngestRepo({
      cfg,
      source,
      results,
      indexRun: indexRunWith(recordError),
      scanRepo,
      recordError,
    });
    const { start, ingest, awaitActive } = yield* makePass({
      source,
      status,
      updateProgress,
      recordError,
      ingestRepo: (repo, opts) => ingestRepo(repo, opts).pipe(withRepoLock(repo)),
      scope,
    });
    const { queueRun, queueIdle } = yield* makeQueueWorker({
      source,
      results,
      makeIndexRun: indexRunWith,
      withRepoLock,
      scope,
    });

    // The backstop for missed deliveries, and the only automatic path in token mode.
    if (cfg.ingestPollMinutes > 0)
      yield* Effect.sleep(Duration.minutes(cfg.ingestPollMinutes)).pipe(
        Effect.andThen(ingest(undefined, {})),
        Effect.tap((s) =>
          Effect.logInfo(`poll ingest: ${s.inserted} new reports, ${s.errors.length} errors`),
        ),
        Effect.forever,
        Effect.forkIn(scope),
      );

    return Service.of({
      start,
      status: () => StateRef.get(status),
      ingestRepo: (repo, opts) => ingest(repo, opts),
      ingestAll: (opts) => ingest(undefined, opts),
      queueRun,
      settled: () => queueIdle().pipe(Effect.andThen(awaitActive)),
      cacheArtifact,
    });
  }),
);

export * as Ingest from "./ingest.ts";
