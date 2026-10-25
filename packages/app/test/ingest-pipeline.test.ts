// The ingest pipeline: a pass over every repository, its errors and
// idempotency across passes, a background pass interrupted with its scope, and
// a repository pass that waits for the whole pass.
import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Option } from "effect";
import { Ingest } from "../src/server/ingest.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { ArtifactStore } from "../src/server/artifact-store.ts";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { FIXTURES, testLayer } from "./helpers.ts";

describe("ingest pipeline (fixtures -> fs store -> sqlite)", () => {
  test("repository discovery failures finish the pass and allow a later pass", async () => {
    let calls = 0;
    const { layer } = await testLayer(
      ArtifactSource.Service.of({
        ...ArtifactSource.makeFixtures(FIXTURES),
        repos: () =>
          ++calls === 1
            ? Effect.fail(new ArtifactSource.SourceError({ operation: "repos", detail: "offline" }))
            : Effect.succeed([]),
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        expect(yield* ingest.ingestAll()).toMatchObject({
          inserted: 0,
          errors: [expect.stringContaining("offline")],
        });
        const failed = yield* ingest.status();
        expect(failed.running).toBeNull();
        expect(failed.lastFinished?.summary.errors).toHaveLength(1);
        expect(yield* ingest.ingestAll()).toMatchObject({ inserted: 0, errors: [] });
        const recovered = yield* ingest.status();
        expect(recovered.running).toBeNull();
        expect(recovered.lastFinished?.passId).not.toBe(failed.lastFinished?.passId);
        expect(recovered.lastFinished?.summary.errors).toEqual([]);
      }).pipe(Effect.provide(layer)),
    );
  });

  test("a repository that will not say its default branch records the error and keeps going", async () => {
    const fixtures = ArtifactSource.makeFixtures(FIXTURES);
    const { layer } = await testLayer(
      ArtifactSource.Service.of({
        ...fixtures,
        repoInfo: () =>
          Effect.fail(new ArtifactSource.SourceError({ operation: "repoInfo", detail: "offline" })),
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const results = yield* ResultStore.Service;
        const summary = yield* ingest.ingestAll();
        expect(summary.errors).toEqual([expect.stringContaining("repoInfo acme/widgets")]);
        expect(summary.inserted).toBe(7);
        expect(Option.isNone(yield* results.scanOf("acme", "widgets"))).toBe(true);
      }).pipe(Effect.provide(layer)),
    );
  });

  test("closing the service scope interrupts a background pass", async () => {
    const entered = Deferred.makeUnsafe<void>();
    const stopped = Deferred.makeUnsafe<void>();
    const { layer } = await testLayer(
      ArtifactSource.Service.of({
        ...ArtifactSource.makeFixtures(FIXTURES),
        repos: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(stopped, undefined)),
          ),
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const passes = yield* Effect.all([ingest.start(), ingest.start()], {
          concurrency: "unbounded",
        });
        expect(passes[0]).toEqual(passes[1]);
        yield* Deferred.await(entered);
      }).pipe(Effect.provide(layer)),
    );
    expect(Effect.runSync(Deferred.isDone(stopped))).toBe(true);
  });

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

      // The repository's own words about its default branch and environments are stored,
      // alongside what the scan found: every fixture artifact name produced a report.
      expect(Option.getOrNull(yield* results.scanOf("acme", "widgets"))).toMatchObject({
        owner: "acme",
        repo: "widgets",
        defaultBranch: "develop",
        environments: ["production", "staging"],
        classification: "reporting",
        reporting: ["deepeval-results", "junit-results", "playwright-report"],
      });

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
