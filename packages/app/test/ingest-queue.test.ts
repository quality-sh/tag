// The queue worker and the poll on a test clock: a poll pass finds a run the webhook missed,
// a failing run retries with backoff and is dropped after its last attempt, and a queued run
// waits for a pass on its repository.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { AppConfig } from "../src/server/config.ts";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { ArtifactStore } from "../src/server/artifact-store.ts";
import { GitHubSource } from "../src/server/github-source.ts";
import { Installation } from "../src/server/installation.ts";
import { Ingest } from "../src/server/ingest.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { cfg, repoRoutes, run } from "./github-fixtures.ts";
import { FIXTURES, fakeGithub, testConfig, testLayer, tmpDir } from "./helpers.ts";

/** Ingest over the GitHub source on a fake transport, as the app wires it. */
const githubStack = async (
  routes: Parameters<typeof fakeGithub>[0],
  overrides: Partial<AppConfig.Interface> = {},
) => {
  const gh = fakeGithub(routes);
  const dir = await tmpDir();
  const config = Layer.succeed(
    AppConfig.Service,
    testConfig({ source: "github", github: Option.some(cfg()), ...overrides }),
  );
  const store = ArtifactStore.layerFs(join(dir, "store"));
  const results = ResultStore.layer.pipe(Layer.provide(Layer.mergeAll(config, store)));
  const installation = Installation.layer.pipe(
    Layer.provide(Layer.mergeAll(config, results)),
    Layer.orDie,
  );
  const source = GitHubSource.layer.pipe(
    Layer.provide(gh.layer),
    Layer.provide(installation),
    Layer.provide(config),
  );
  const ingest = Ingest.layer.pipe(Layer.provide(Layer.mergeAll(config, store, source, results)));
  return { gh, layer: Layer.mergeAll(results, ingest) };
};

const recent = (id: number) => {
  const at = new Date(Date.now() - 60_000).toISOString();
  return run(id, { created_at: at, run_started_at: at });
};

const widgets = { owner: "acme", repo: "widgets" };

describe("the poll and the queue worker", () => {
  test("the next poll picks up a run the webhook missed and marks it seen", async () => {
    const listed = Promise.withResolvers<void>();
    const { gh, layer } = await githubStack(
      await repoRoutes([recent(2002)], { onListRuns: () => listed.resolve() }),
      { ingestPollMinutes: 10 },
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const results = yield* ResultStore.Service;
        yield* TestClock.adjust("9 minutes");
        expect(gh.hits).toEqual([]);

        yield* TestClock.adjust("1 minute");
        yield* Effect.promise(() => listed.promise);
        yield* ingest.settled();
        expect((yield* results.seenRuns("acme", "widgets")).has("2002")).toBe(true);
        expect(yield* results.listRuns({ runId: "2002" })).toHaveLength(1);
        expect((yield* ingest.status()).lastFinished?.summary).toMatchObject({
          runs: 1,
          inserted: 1,
          errors: [],
        });
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
    );
  });

  test("a failing run retries with backoff and is dropped after the last attempt", async () => {
    const attempts = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
    let reads = 0;
    const { layer } = await githubStack({
      "/repos/acme/widgets/actions/runs/3001": () => {
        attempts[reads++]?.resolve();
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const results = yield* ResultStore.Service;
        yield* ingest.queueRun(undefined, { ...widgets, runId: "3001" });
        for (const [index, attempt] of attempts.entries()) {
          if (index > 0) yield* TestClock.adjust(`${2 ** (index - 1)} minutes`);
          yield* Effect.promise(() => attempt.promise);
          yield* ingest.settled();
          const rows = yield* results.queuedRuns();
          if (index < attempts.length - 1)
            expect(rows).toMatchObject([{ runId: "3001", attempts: index + 1 }]);
          else expect(rows).toEqual([]);
        }
        expect(reads).toBe(5);
      }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
    );
  });

  test("a queued run waits for the pass on its repository", async () => {
    const order: string[] = [];
    const fixtures = ArtifactSource.makeFixtures(FIXTURES);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const source = ArtifactSource.Service.of({
      ...fixtures,
      listRuns: Effect.fn(function* (repo, opts) {
        order.push("pass:listRuns");
        entered.resolve();
        yield* Effect.promise(() => release.promise);
        const runs = yield* fixtures.listRuns(repo, opts);
        order.push("pass:listed");
        return runs.filter((r) => r.runId !== "run-1003");
      }),
      run: Effect.fn(function* (repo, runId) {
        order.push(`queue:${runId}`);
        return yield* fixtures.run(repo, runId);
      }),
    });
    const { layer } = await testLayer(source);
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const results = yield* ResultStore.Service;
        yield* ingest.start(widgets, undefined);
        yield* Effect.promise(() => entered.promise);
        yield* ingest.queueRun("delivery-1", { ...widgets, runId: "run-1003" });
        // Let the worker reach the lock before the pass goes on.
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
        release.resolve();
        yield* ingest.settled();
        expect(order.indexOf("queue:run-1003")).toBeGreaterThan(order.indexOf("pass:listed"));
        expect((yield* results.seenRuns("acme", "widgets")).has("run-1003")).toBe(true);
        expect(yield* results.queuedRuns()).toEqual([]);
      }).pipe(Effect.provide(layer)),
    );
  });

  test("the fixtures source reads one run by id and fails on an unknown one", async () => {
    const fixtures = ArtifactSource.makeFixtures(FIXTURES);
    const found = await Effect.runPromise(fixtures.run(widgets, "run-1001"));
    expect(found).toMatchObject({ ...widgets, runId: "run-1001", status: "completed" });
    const missing = await Effect.runPromise(Effect.flip(fixtures.run(widgets, "run-9999")));
    expect(missing).toMatchObject({ operation: "run", status: 404 });
  });
});
