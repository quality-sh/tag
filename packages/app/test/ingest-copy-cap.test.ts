// The copy cap: an artifact over ARTIFACT_COPY_MAX_MB is recorded at ingest but not
// downloaded, so a repository that uploads build binaries cannot fill the store.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Ingest } from "../src/server/ingest.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { testLayer } from "./helpers.ts";

const widgets = { owner: "acme", repo: "widgets" };

const statesOf = (runId: string) =>
  Effect.gen(function* () {
    const results = yield* ResultStore.Service;
    const rows = yield* results.artifactsOfRun("acme", "widgets", runId);
    return Object.fromEntries(rows.map((r) => [r.name, r.state]));
  });

describe("artifact copy cap", () => {
  test("leaves an artifact over the cap listed and copies the rest", async () => {
    // The fixture Playwright reports are about 2 MB; the JUnit and DeepEval ones are a few KB.
    const { layer } = await testLayer(undefined, { artifactCopyMaxBytes: 1_000_000 });
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const first = yield* ingest.ingestRepo(widgets, { limit: 20 });
        expect(first.errors).toEqual([]);
        expect(yield* statesOf("run-1001")).toEqual({
          "deepeval-results": "cached",
          "junit-results": "cached",
          "playwright-report": "listed",
        });
        // A later pass skips it again rather than downloading it.
        const second = yield* ingest.ingestRepo(widgets, { limit: 20 });
        expect(second.errors).toEqual([]);
        expect((yield* statesOf("run-1002"))["playwright-report"]).toBe("listed");
      }).pipe(Effect.provide(layer)),
    );
  });

  test("copies everything when the cap is 0", async () => {
    const { layer } = await testLayer(undefined, { artifactCopyMaxBytes: 0 });
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        expect((yield* ingest.ingestRepo(widgets, { limit: 20 })).errors).toEqual([]);
        expect((yield* statesOf("run-1001"))["playwright-report"]).toBe("cached");
      }).pipe(Effect.provide(layer)),
    );
  });
});
