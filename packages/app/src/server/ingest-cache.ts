// Artifact caching: a zip lands in the store once, then every later pass reads the cache.
import { Effect } from "effect";
import { type ArtifactMeta, ArtifactSource } from "./artifact-source.ts";
import { ArtifactStore, contentTypeFor } from "./artifact-store.ts";
import { ResultStore } from "./result-store.ts";
import { extractZip, ZipError } from "./zip.ts";

export const artifactPrefix = (a: { owner: string; repo: string; artifactId: string }) =>
  `artifacts/${a.owner}/${a.repo}/${a.artifactId}/`;

export const COMPLETE = ".complete";

export const makeCacheArtifact = (deps: {
  readonly store: ArtifactStore.Interface;
  readonly source: ArtifactSource.Interface;
  readonly results: ResultStore.Interface;
}) => {
  const { store, source, results } = deps;
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
  return { cacheArtifact };
};
