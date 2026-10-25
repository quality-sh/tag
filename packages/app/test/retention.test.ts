import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ArtifactStore } from "../src/server/artifact-store.ts";
import { AppConfig } from "../src/server/config.ts";
import { Ingest, artifactPrefix } from "../src/server/ingest.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { Retention } from "../src/server/retention.ts";
import { run, testConfig, testLayer } from "./helpers.ts";

const withRetention = async (days: number) => {
  const { layer } = await testLayer();
  // The window comes from this config; the stores come from the shared test layer.
  const retention = Retention.layer.pipe(
    Layer.provide(Layer.succeed(AppConfig.Service, testConfig({ artifactRetentionDays: days }))),
    Layer.provide(layer),
  );
  return Layer.mergeAll(layer, retention);
};

describe("Retention", () => {
  test("sweeps cached files past the window, keeps reports, and the artifact comes back on view", async () => {
    const layer = await withRetention(30);
    const out = await run(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const results = yield* ResultStore.Service;
        const store = yield* ArtifactStore.Service;
        const retention = yield* Retention.Service;
        yield* ingest.ingestAll();
        const before = yield* results.artifactsOfRun("acme", "widgets", "run-1001");
        const first = before[0];
        if (!first) throw new Error("fixture artifact missing");
        const filesBefore = yield* store.list(artifactPrefix(first));
        const reportsBefore = yield* results.reports({});

        // Nothing is old enough yet.
        const noop = yield* retention.sweep({ now: new Date("2026-10-24T00:00:00Z") });
        // A year on, everything is.
        const swept = yield* retention.sweep({ now: new Date("2027-10-24T00:00:00Z") });

        const filesAfter = yield* store.list(artifactPrefix(first));
        const rowAfter = yield* results.getArtifact(first.artifactId);
        const reportsAfter = yield* results.reports({});
        const again = yield* ingest.cacheArtifact({
          owner: first.owner,
          repo: first.repo,
          runId: first.runId,
          artifactId: first.artifactId,
          name: first.name,
          sizeBytes: first.sizeBytes,
        });
        const filesBack = yield* store.list(artifactPrefix(first));
        return {
          noop,
          swept,
          filesBefore: filesBefore.length,
          filesAfter: filesAfter.length,
          state: rowAfter._tag === "Some" ? rowAfter.value.state : null,
          cachedAt: rowAfter._tag === "Some" ? rowAfter.value.cachedAt : "?",
          reportsKept: reportsAfter.length === reportsBefore.length && reportsBefore.length > 0,
          refetched: again.fetched,
          filesBack: filesBack.length,
        };
      }).pipe(Effect.provide(layer)),
    );
    expect(out.noop.artifacts).toBe(0);
    expect(out.swept.artifacts).toBeGreaterThan(0);
    expect(out.swept.files).toBeGreaterThan(0);
    expect(out.swept.errors).toEqual([]);
    expect(out.filesBefore).toBeGreaterThan(0);
    expect(out.filesAfter).toBe(0);
    expect(out.state).toBe("listed");
    expect(out.cachedAt).toBeNull();
    expect(out.reportsKept).toBe(true);
    expect(out.refetched).toBe(true);
    expect(out.filesBack).toBe(out.filesBefore);
  });

  test("retention of 0 days never sweeps", async () => {
    const layer = await withRetention(0);
    const out = await run(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const retention = yield* Retention.Service;
        yield* ingest.ingestAll();
        return yield* retention.sweep({ now: new Date("2030-01-01T00:00:00Z") });
      }).pipe(Effect.provide(layer)),
    );
    expect(out).toEqual({ days: 0, cutoff: null, artifacts: 0, files: 0, errors: [] });
  });
});
