// Skipped artifacts: ingest keeps the files of an artifact only when an adapter reads a
// report from it. A build binary, a coverage dump or an artifact over ARTIFACT_COPY_MAX_MB
// is recorded as "skipped": no files in the store, no retry each pass, fetched on view.
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { ArtifactStore } from "../src/server/artifact-store.ts";
import { Ingest, artifactPrefix } from "../src/server/ingest.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { FIXTURES, fixturesWithBuildOutput, testLayer } from "./helpers.ts";

const widgets = { owner: "acme", repo: "widgets" };

const statesOf = (runId: string) =>
  Effect.gen(function* () {
    const results = yield* ResultStore.Service;
    const rows = yield* results.artifactsOfRun("acme", "widgets", runId);
    return Object.fromEntries(rows.map((r) => [r.name, r.state]));
  });

const filesOf = (runId: string, name: string) =>
  Effect.gen(function* () {
    const store = yield* ArtifactStore.Service;
    return yield* store.list(artifactPrefix({ ...widgets, artifactId: `${runId}__${name}` }));
  });

describe("skipped artifacts", () => {
  test("drops the files of an artifact no adapter reads, and does not fetch it again", async () => {
    const fixtures = ArtifactSource.makeFixtures(await fixturesWithBuildOutput());
    const fetched: string[] = [];
    const source = ArtifactSource.Service.of({
      ...fixtures,
      openArtifact: (artifact) => {
        fetched.push(artifact.name);
        return fixtures.openArtifact(artifact);
      },
    });
    const { layer } = await testLayer(source);
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        expect((yield* ingest.ingestRepo(widgets, { limit: 20 })).errors).toEqual([]);
        expect(yield* statesOf("run-1001")).toEqual({
          "build-output": "skipped",
          "deepeval-results": "cached",
          "junit-results": "cached",
          "playwright-report": "cached",
        });
        expect(yield* filesOf("run-1001", "build-output")).toEqual([]);
        expect((yield* filesOf("run-1001", "junit-results")).length).toBeGreaterThan(0);

        // The next pass leaves it alone.
        fetched.length = 0;
        expect((yield* ingest.ingestRepo(widgets, { limit: 20 })).errors).toEqual([]);
        expect(fetched.filter((n) => n === "build-output")).toEqual([]);
        expect((yield* statesOf("run-1001"))["build-output"]).toBe("skipped");
      }).pipe(Effect.provide(layer)),
    );
  });

  test("skips an artifact over the copy cap without downloading it", async () => {
    // The fixture Playwright reports are about 2 MB; the JUnit and DeepEval ones are a few KB.
    const fixtures = ArtifactSource.makeFixtures(FIXTURES);
    const fetched: string[] = [];
    const source = ArtifactSource.Service.of({
      ...fixtures,
      openArtifact: (artifact) => {
        fetched.push(artifact.name);
        return fixtures.openArtifact(artifact);
      },
    });
    const { layer } = await testLayer(source, { artifactCopyMaxBytes: 1_000_000 });
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        expect((yield* ingest.ingestRepo(widgets, { limit: 20 })).errors).toEqual([]);
        expect(yield* statesOf("run-1001")).toEqual({
          "deepeval-results": "cached",
          "junit-results": "cached",
          "playwright-report": "skipped",
        });
        // A second pass runs the scan too; neither one downloads the report.
        expect((yield* ingest.ingestRepo(widgets, { limit: 20 })).errors).toEqual([]);
        expect((yield* statesOf("run-1002"))["playwright-report"]).toBe("skipped");
        expect(fetched.filter((n) => n === "playwright-report")).toEqual([]);
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
