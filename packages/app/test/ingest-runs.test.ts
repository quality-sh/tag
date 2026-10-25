// Runs seen and listing behaviour: the repository artifacts listed once a
// pass, the runs marked seen only after their artifacts are indexed, and the
// retry of a listed artifact from the index.
import { describe, expect, test } from "bun:test";
import { Context, Effect, Layer } from "effect";
import { Ingest } from "../src/server/ingest.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { FIXTURES, testLayer } from "./helpers.ts";

describe("ingest pipeline (fixtures -> fs store -> sqlite)", () => {
  test("lists repository artifacts once per pass and never lists a run's artifacts", async () => {
    const fixtures = ArtifactSource.makeFixtures(FIXTURES);
    const requestedRuns: string[][] = [];
    let runCalls = 0;
    const source = ArtifactSource.Service.of({
      ...fixtures,
      listRepoArtifacts: Effect.fn(function* (repo, runIds) {
        requestedRuns.push([...runIds].sort());
        return yield* fixtures.listRepoArtifacts(repo, runIds);
      }),
      listArtifacts: Effect.fn(function* (run) {
        runCalls++;
        return yield* fixtures.listArtifacts(run);
      }),
    });
    const { layer } = await testLayer(source);
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const results = yield* ResultStore.Service;
        const first = yield* ingest.ingestAll();
        const second = yield* ingest.ingestAll();
        expect(first).toMatchObject({ runs: 3, artifacts: 7, cached: 7, inserted: 7, errors: [] });
        expect(second).toMatchObject({ cached: 0, inserted: 0, errors: [] });
        expect(requestedRuns).toEqual([["run-1001", "run-1002", "run-1003"], []]);
        expect(runCalls).toBe(0);
        expect([...(yield* results.seenRuns("acme", "widgets"))].sort()).toEqual(requestedRuns[0]!);
      }).pipe(Effect.provide(layer)),
    );
  });

  test("retries a listed artifact from the index without listing its run again", async () => {
    const fixtures = ArtifactSource.makeFixtures(FIXTURES);
    const failedId = "run-1002__playwright-report";
    let attempts = 0;
    let runCalls = 0;
    const source = ArtifactSource.Service.of({
      ...fixtures,
      listArtifacts: Effect.fn(function* (run) {
        runCalls++;
        return yield* fixtures.listArtifacts(run);
      }),
      openArtifact: Effect.fn(function* (artifact) {
        if (artifact.artifactId === failedId && ++attempts === 1)
          return yield* new ArtifactSource.SourceError({
            operation: "openArtifact",
            detail: "download failed",
          });
        return yield* fixtures.openArtifact(artifact);
      }),
    });
    const { layer } = await testLayer(source);
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const results = yield* ResultStore.Service;
        const first = yield* ingest.ingestAll();
        expect(first.errors).toHaveLength(1);
        expect(first.cached).toBe(6);
        expect(yield* results.getArtifact(failedId)).toMatchObject({ value: { state: "listed" } });
        expect((yield* results.seenRuns("acme", "widgets")).has("run-1002")).toBe(true);
        const second = yield* ingest.ingestAll();
        expect(second).toMatchObject({ cached: 1, inserted: 1, errors: [] });
        expect(yield* results.getArtifact(failedId)).toMatchObject({ value: { state: "cached" } });
        expect(attempts).toBe(2);
        expect(runCalls).toBe(0);
      }).pipe(Effect.provide(layer)),
    );
  });

  test("does not mark runs seen when the repository artifact listing fails", async () => {
    const fixtures = ArtifactSource.makeFixtures(FIXTURES);
    let calls = 0;
    const source = ArtifactSource.Service.of({
      ...fixtures,
      listRepoArtifacts: Effect.fn(function* (repo, runIds) {
        if (++calls === 1)
          return yield* new ArtifactSource.SourceError({
            operation: "listRepoArtifacts",
            detail: "unavailable",
          });
        return yield* fixtures.listRepoArtifacts(repo, runIds);
      }),
    });
    const { layer } = await testLayer(source);
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const results = yield* ResultStore.Service;
        expect((yield* ingest.ingestAll()).errors).toHaveLength(1);
        expect((yield* results.seenRuns("acme", "widgets")).size).toBe(0);
        expect(yield* ingest.ingestAll()).toMatchObject({ cached: 7, inserted: 7, errors: [] });
      }).pipe(Effect.provide(layer)),
    );
  });

  test("does not mark a run seen until every artifact row is indexed", async () => {
    const { layer } = await testLayer();
    await Effect.runPromise(
      Effect.gen(function* () {
        const results = yield* ResultStore.Service;
        let failIndex = true;
        const context = yield* Layer.build(Layer.fresh(Ingest.layer)).pipe(
          Effect.provideService(ResultStore.Service, {
            ...results,
            upsertArtifact: (row) =>
              row.runId === "run-1002" && failIndex
                ? Effect.fail(
                    new ResultStore.DbError({
                      operation: "upsertArtifact",
                      cause: "index unavailable",
                    }),
                  )
                : results.upsertArtifact(row),
          }),
        );
        const ingest = Context.get(context, Ingest.Service);
        expect((yield* ingest.ingestAll()).errors.length).toBeGreaterThan(0);
        expect((yield* results.seenRuns("acme", "widgets")).has("run-1002")).toBe(false);
        failIndex = false;
        expect((yield* ingest.ingestAll()).errors).toEqual([]);
        expect(yield* results.artifactsOfRun("acme", "widgets", "run-1002")).toHaveLength(3);
        expect((yield* results.seenRuns("acme", "widgets")).has("run-1002")).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });
});
