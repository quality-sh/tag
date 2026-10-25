// The pipeline entry: source -> zip -> store -> adapters -> result store. Idempotent at every step.
import { Effect, Layer, Ref as StateRef } from "effect";
import { AppConfig } from "./config.ts";
import { ArtifactSource } from "./artifact-source.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { ResultStore } from "./result-store.ts";
import { type IngestPass, type IngestStatus, Service } from "./ingest-contract.ts";
import { makeCacheArtifact } from "./ingest-cache.ts";
import { makeIngestArtifact } from "./ingest-run.ts";
import { makeScanRepo } from "./ingest-scan.ts";
import { makeIngestRepo } from "./ingest-repo.ts";
import { makePass } from "./ingest-pass.ts";

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

    const { cacheArtifact } = makeCacheArtifact({ store, source, results });
    const { ingestArtifact } = makeIngestArtifact({ store, results, cacheArtifact });
    const { scanRepo } = makeScanRepo({ source, results, ingestArtifact });
    const { ingestRepo } = makeIngestRepo({
      cfg,
      source,
      results,
      ingestArtifact,
      scanRepo,
      recordError,
    });
    const { start, ingest } = yield* makePass({
      source,
      status,
      updateProgress,
      recordError,
      ingestRepo,
      scope,
    });

    return Service.of({
      start,
      status: () => StateRef.get(status),
      ingestRepo: (repo, opts) => ingest(repo, opts),
      ingestAll: (opts) => ingest(undefined, opts),
      cacheArtifact,
    });
  }),
);

export * as Ingest from "./ingest.ts";
