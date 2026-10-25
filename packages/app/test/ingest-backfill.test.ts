// Backfill: a new repository walked to the retention window with an unbounded
// listing, the failed walk left open for the next pass, and the steady state
// that follows the newest runs.
import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { Ingest } from "../src/server/ingest.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { FIXTURES, testLayer } from "./helpers.ts";

describe("ingest pipeline (fixtures -> fs store -> sqlite)", () => {
  test("backfills a new repository to the retention window, then follows the newest runs", async () => {
    const fixtures = ArtifactSource.makeFixtures(FIXTURES);
    const listings: Array<{ limit: number; since: string | undefined }> = [];
    let failListing = true;
    const source = ArtifactSource.Service.of({
      ...fixtures,
      listRuns: Effect.fn(function* (repo, opts) {
        listings.push({ limit: opts.limit, since: opts.since });
        return yield* fixtures.listRuns(repo, opts);
      }),
      listRepoArtifacts: Effect.fn(function* (repo, runIds) {
        if (failListing)
          return yield* new ArtifactSource.SourceError({
            operation: "listRepoArtifacts",
            detail: "offline",
          });
        return yield* fixtures.listRepoArtifacts(repo, runIds);
      }),
    });
    const { layer } = await testLayer(source, { artifactRetentionDays: 30 });
    const widgets = { owner: "acme", repo: "widgets" };
    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const results = yield* ResultStore.Service;
        // A failed listing leaves the walk open, so a restart or the next pass takes it up again.
        expect((yield* ingest.ingestRepo(widgets, { limit: 20 })).errors).toHaveLength(1);
        expect(yield* results.repository("acme", "widgets")).toMatchObject(
          Option.some({ state: "backfilling", backfillDone: 3, backfillTotal: 3 }),
        );
        failListing = false;
        expect(yield* ingest.ingestRepo(widgets, { limit: 20 })).toMatchObject({
          runs: 3,
          inserted: 7,
          errors: [],
        });
        expect(yield* results.repository("acme", "widgets")).toMatchObject(
          Option.some({ state: "current", backfillDone: 3, backfillTotal: 3 }),
        );
        // Caught up: the fixed limit applies again and the window filter is gone.
        yield* ingest.ingestRepo(widgets, { limit: 20 });
        expect(listings.map((l) => l.limit)).toEqual([Infinity, Infinity, 20]);
        const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
        expect(listings[0]?.since?.slice(0, 10)).toBe(cutoff);
        expect(listings[2]?.since).toBeUndefined();
        expect(yield* results.repositories()).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
    );
  });
});
