import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { Ingest } from "../src/server/ingest.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { testLayer } from "./helpers.ts";

const SCAN_FIXTURES = new URL("../../../fixtures-scan/", import.meta.url).pathname;

describe("ingest scan (fixtures-scan -> fs store -> sqlite)", () => {
  test("classifies every repository and downloads nothing when names repeat", async () => {
    const fixtures = ArtifactSource.makeFixtures(SCAN_FIXTURES);
    let downloads = 0;
    const source = ArtifactSource.Service.of({
      ...fixtures,
      openArtifact: Effect.fn(function* (artifact) {
        downloads++;
        return yield* fixtures.openArtifact(artifact);
      }),
    });
    const { layer } = await testLayer(source);
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const results = yield* ResultStore.Service;

        const first = yield* ingest.ingestAll();
        expect(first.errors).toEqual([]);

        // A junit artifact under any name: reporting, with the report ingested.
        expect(Option.getOrNull(yield* results.scanOf("acme", "scanrepo"))).toMatchObject({
          classification: "reporting",
          reporting: ["test-results-ubuntu-latest"],
          unread: [],
          names: ["test-results-ubuntu-latest"],
          defaultBranch: "trunk",
        });
        expect(Option.getOrNull(yield* results.scanOf("acme", "scanrepo"))!.scannedAt).toBeString();
        expect(
          (yield* results.listRuns({ owner: "acme", repo: "scanrepo" })).length,
        ).toBeGreaterThan(0);

        // A workflow running vitest and playwright in job Tests: needs-change, named.
        expect(Option.getOrNull(yield* results.scanOf("acme", "workflow-only"))).toMatchObject({
          classification: "needs-change",
          runners: [
            { runner: "playwright", job: "Tests", command: "npx playwright test" },
            { runner: "vitest", job: "Tests", command: "pnpm vitest run" },
          ],
        });

        // A TAP artifact the adapters cannot read: unsupported, the name recorded.
        expect(Option.getOrNull(yield* results.scanOf("acme", "tap-only"))).toMatchObject({
          classification: "unsupported",
          unread: [{ name: "test-output", format: "tap" }],
        });

        // A bare repository: no-tests, with its own branch and environments.
        expect(Option.getOrNull(yield* results.scanOf("acme", "quiet"))).toMatchObject({
          classification: "no-tests",
          defaultBranch: "trunk",
          environments: ["staging"],
          scannedAt: expect.any(String),
        });

        const afterFirst = downloads;
        const second = yield* ingest.ingestAll();
        expect(second.errors).toEqual([]);
        expect(downloads).toBe(afterFirst);
      }).pipe(Effect.provide(layer)),
    );
  });

  test("a failed scan records the error, keeps the row absent, and is retried", async () => {
    const fixtures = ArtifactSource.makeFixtures(SCAN_FIXTURES);
    let treeBroken = true;
    const source = ArtifactSource.Service.of({
      ...fixtures,
      repoTree: (repo) =>
        treeBroken && repo.repo === "quiet"
          ? Effect.fail(
              new ArtifactSource.SourceError({ operation: "repoTree", detail: "offline" }),
            )
          : fixtures.repoTree(repo),
    });
    const { layer } = await testLayer(source);
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const results = yield* ResultStore.Service;

        const first = yield* ingest.ingestAll();
        expect(first.errors).toEqual([expect.stringContaining("scan acme/quiet")]);
        expect(Option.isNone(yield* results.scanOf("acme", "quiet"))).toBe(true);
        // The other repositories still scanned.
        expect(
          Option.getOrNull(yield* results.scanOf("acme", "workflow-only"))?.classification,
        ).toBe("needs-change");

        treeBroken = false;
        const second = yield* ingest.ingestAll();
        expect(second.errors).toEqual([]);
        expect(Option.getOrNull(yield* results.scanOf("acme", "quiet"))?.classification).toBe(
          "no-tests",
        );
      }).pipe(Effect.provide(layer)),
    );
  });
});
