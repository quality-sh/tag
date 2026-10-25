import { expect, test } from "bun:test";
import { Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as Reactivity from "effect/reactivity/Reactivity";
import { TagApi } from "../src/web/client.ts";
import type { IngestPass, IngestStatus, IngestSummary } from "../src/server/ingest.ts";

// Route state reads the browser location when the module loads.
const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
Object.defineProperty(globalThis, "location", { configurable: true, value: { hash: "" } });
const { checkForNewRuns } = await import("../src/web/state.ts");
if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
else Reflect.deleteProperty(globalThis, "location");

test("ingest polling refreshes runs per completed repository and waits for the final summary", async () => {
  const summary: IngestSummary = {
    runs: 1,
    refs: 0,
    artifacts: 1,
    reports: 1,
    inserted: 1,
    cached: 1,
    waits: 0,
    remaining: null,
    errors: [],
  };
  const repository = { owner: "acme", repo: "widgets" };
  const pass: IngestPass = {
    passId: "pass-1",
    startedAt: "2026-10-25T00:00:00Z",
    repositories: [],
    currentRepository: repository,
    errors: [],
  };
  let status: IngestStatus = { running: pass, lastFinished: null };
  let reads = 0;
  let refreshes = 0;
  const api = Layer.mock(TagApi, {
    ingest: () => Effect.succeed({ passId: pass.passId }),
    ingestStatus: () =>
      Effect.sync(() => {
        reads++;
        return status;
      }),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const reactivity = yield* Reactivity.Reactivity;
      const unregister = reactivity.registerUnsafe(["runs"], () => {
        refreshes++;
      });
      yield* Effect.addFinalizer(() => Effect.sync(unregister));
      const pending = yield* checkForNewRuns().pipe(Effect.forkScoped);
      yield* TestClock.adjust(0);
      expect(reads).toBe(1);
      expect(refreshes).toBe(0);
      expect(pending.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("2 seconds");
      expect(reads).toBe(2);
      expect(refreshes).toBe(0);
      const progress = { ...pass, repositories: [{ repository, summary }] };
      status = { running: progress, lastFinished: null };
      yield* TestClock.adjust("2 seconds");
      expect(refreshes).toBe(1);
      expect(pending.pollUnsafe()).toBeUndefined();
      status = {
        running: null,
        lastFinished: {
          ...progress,
          currentRepository: null,
          finishedAt: "2026-10-25T00:00:10Z",
          summary,
        },
      };
      yield* TestClock.adjust("2 seconds");
      expect(yield* Fiber.join(pending)).toEqual(summary);
      expect(refreshes).toBe(2);
      yield* TestClock.adjust("4 seconds");
      expect(reads).toBe(4);
    }).pipe(
      Effect.scoped,
      Effect.provide(api),
      Effect.provide(Reactivity.layer),
      Effect.provide(TestClock.layer()),
    ),
  );
});
