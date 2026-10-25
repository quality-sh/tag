import { describe, expect, test } from "bun:test";
import { Context, Deferred, Effect, Fiber, Layer, Option } from "effect";
import { Ingest } from "../src/server/ingest.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { ArtifactStore } from "../src/server/artifact-store.ts";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { FIXTURES, testLayer } from "./helpers.ts";

describe("ingest pipeline (fixtures -> fs store -> sqlite)", () => {
  test("ingests every fixture artifact, idempotently, and serves queries", async () => {
    const { layer } = await testLayer();
    const program = Effect.gen(function* () {
      const ingest = yield* Ingest.Service;
      const results = yield* ResultStore.Service;
      const store = yield* ArtifactStore.Service;

      const first = yield* ingest.ingestAll();
      expect(first.errors).toEqual([]);
      expect(first.runs).toBe(3);
      expect(first.refs).toBe(4);
      expect(first.artifacts).toBe(7);
      expect(first.cached).toBe(7);
      // 3 adapters x 2 runs + junit on the pull request run
      expect(first.reports).toBe(7);
      expect(first.inserted).toBe(7);

      const second = yield* ingest.ingestAll();
      expect(second.inserted).toBe(0);
      expect(second.cached).toBe(0);

      const runs = yield* results.listRuns({ owner: "acme", repo: "widgets" });
      expect(runs).toHaveLength(7);
      expect(new Set(runs.map((r) => r.tool))).toEqual(
        new Set(["deepeval", "pytest", "playwright"]),
      );
      const latestPw = runs.find((r) => r.tool === "playwright" && r.runId === "run-1002")!;
      expect(latestPw).toMatchObject({
        passed: 5,
        failed: 0,
        skipped: 1,
        branch: "main",
        artifactName: "playwright-report",
      });

      const report = yield* results.getReport(latestPw.reportId);
      expect(Option.isSome(report)).toBe(true);
      const tests = yield* results.testsOf(latestPw.reportId);
      expect(tests).toHaveLength(6);

      const de = runs.find((r) => r.tool === "deepeval" && r.runId === "run-1002")!;
      const metrics = yield* results.metricsOf(de.reportId);
      expect(metrics.length).toBe(18);
      const failing = (yield* results.testsOf(de.reportId)).find((t) => t.status === "failed")!;
      const history = yield* results.testHistory("acme", "widgets", failing.testId, 10);
      expect(history).toHaveLength(2);
      expect(history[0]!.metrics.map((m) => m.name).sort()).toEqual([
        "Answer Relevancy",
        "Faithfulness",
        "Hallucination",
      ]);

      // Artifact files landed in the store, including the Playwright HTML report.
      const keys = yield* store.list("artifacts/acme/widgets/run-1002__playwright-report/");
      expect(keys).toContain("artifacts/acme/widgets/run-1002__playwright-report/index.html");
      const art = yield* results.getArtifact("run-1002__playwright-report");
      expect(Option.isSome(art) && art.value.state).toBe("cached");

      // Index is rebuildable from the bucket alone.
      const rebuilt = yield* results.rebuild();
      expect(rebuilt.reports).toBe(7);
      expect((yield* results.repos())[0]).toMatchObject({
        owner: "acme",
        repo: "widgets",
        reports: 7,
      });
    });
    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  }, 30_000);

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

  test("a concurrent repository pass waits for the entire all-repository pass", async () => {
    const fixtures = ArtifactSource.makeFixtures(FIXTURES);
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const secondStarted = Deferred.makeUnsafe<void>();
    const events: string[] = [];
    let calls = 0;
    const source = ArtifactSource.Service.of({
      ...fixtures,
      repos: Effect.fn(function* () {
        events.push("first started");
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return yield* fixtures.repos();
      }),
      listRuns: Effect.fn(function* (repo, opts) {
        events.push(`repository pass ${++calls}`);
        return yield* fixtures.listRuns(repo, opts);
      }),
    });
    const { layer } = await testLayer(source);
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const first = yield* ingest.ingestAll().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              events.push("first finished");
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        const second = yield* Effect.gen(function* () {
          yield* Deferred.succeed(secondStarted, undefined);
          return yield* ingest.ingestRepo({ owner: "acme", repo: "widgets" });
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(secondStarted);
        expect(events).toEqual(["first started"]);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(first)).toMatchObject({ cached: 7, inserted: 7 });
        expect(yield* Fiber.join(second)).toMatchObject({ cached: 0, inserted: 0 });
        expect(events).toEqual([
          "first started",
          "repository pass 1",
          "first finished",
          "repository pass 2",
        ]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
    );
  });
});
