// The HTTP ingest endpoints: one 202 that starts a pass, the status of the
// running pass shared with every caller, and each repository published as it
// finishes.
import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { ApiRoutes } from "../src/server/http.ts";
import { Auth } from "../src/server/auth.ts";
import { Retention } from "../src/server/retention.ts";
import { Installation } from "../src/server/installation.ts";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { FIXTURES, testLayer } from "./helpers.ts";

describe("ingest pipeline (fixtures -> fs store -> sqlite)", () => {
  test("HTTP ingest returns 202, shares the active pass, and publishes each repository", async () => {
    const fixtures = ArtifactSource.makeFixtures(FIXTURES);
    const discovering = Deferred.makeUnsafe<void>();
    const discovered = Deferred.makeUnsafe<void>();
    const laterEntered = Deferred.makeUnsafe<void>();
    const laterRelease = Deferred.makeUnsafe<void>();
    const nextEntered = Deferred.makeUnsafe<void>();
    const nextRelease = Deferred.makeUnsafe<void>();
    const selected: Array<{ repo: string; limit: number | undefined }> = [];
    let discoveries = 0;
    const source = ArtifactSource.Service.of({
      ...fixtures,
      repos: Effect.fn(function* () {
        discoveries++;
        yield* Deferred.succeed(discovering, undefined);
        yield* Deferred.await(discovered);
        return [
          { owner: "acme", repo: "widgets" },
          { owner: "acme", repo: "broken" },
          { owner: "acme", repo: "later" },
          { owner: "acme", repo: "last" },
        ];
      }),
      listRuns: Effect.fn(function* (repo, opts) {
        selected.push({ repo: repo.repo, limit: opts?.limit });
        if (opts?.limit === 1) {
          yield* Deferred.succeed(nextEntered, undefined);
          yield* Deferred.await(nextRelease);
        }
        if (repo.repo === "broken")
          return yield* new ArtifactSource.SourceError({
            operation: "listRuns",
            detail: "offline",
          });
        if (repo.repo === "later") {
          yield* Deferred.succeed(laterEntered, undefined);
          yield* Deferred.await(laterRelease);
        }
        return yield* fixtures.listRuns(repo, opts);
      }),
    });
    const { layer } = await testLayer(source);
    const app = HttpRouter.toWebHandler(
      ApiRoutes.pipe(
        Layer.provide(
          Layer.mergeAll(Auth.layer, Retention.layer, Installation.layer).pipe(
            Layer.provideMerge(layer),
          ),
        ),
      ),
      { disableLogger: true },
    );
    const request = (path: string, method = "GET", body?: string) =>
      app.handler(
        new Request(`http://local/api/${path}`, {
          method,
          signal: AbortSignal.timeout(900),
          ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
        }),
      );
    try {
      expect(await (await request("ingest/status")).json()).toEqual({
        running: null,
        lastFinished: null,
      });
      const response = await request("ingest", "POST");
      expect(response.status).toBe(202);
      const { passId } = (await response.json()) as { passId: string };
      expect(passId).toBeString();
      await Effect.runPromise(Deferred.await(discovering));
      const duplicate = await request("ingest", "POST");
      expect(duplicate.status).toBe(202);
      expect(await duplicate.json()).toEqual({ passId });
      expect(await (await request("ingest/status")).json()).toMatchObject({
        running: { passId, repositories: [], currentRepository: null, errors: [] },
        lastFinished: null,
      });
      await Effect.runPromise(Deferred.succeed(discovered, undefined));
      await Effect.runPromise(Deferred.await(laterEntered));
      const progress = await (await request("ingest/status")).json();
      expect(progress).toMatchObject({
        running: {
          passId,
          repositories: [
            { repository: { owner: "acme", repo: "widgets" }, summary: { inserted: 7 } },
            { repository: { owner: "acme", repo: "broken" }, summary: { inserted: 0 } },
          ],
          currentRepository: { owner: "acme", repo: "later" },
        },
        lastFinished: null,
      });
      expect(progress.running.errors).toHaveLength(1);
      expect(await (await request("runs")).json()).toHaveLength(7);
      await Effect.runPromise(Deferred.succeed(laterRelease, undefined));
      const finished = await Effect.runPromise(
        Effect.promise(() => request("ingest/status").then((r) => r.json())).pipe(
          Effect.repeat({ until: (status) => status.lastFinished !== null }),
          Effect.timeout("1 second"),
        ),
      );
      expect(finished).toMatchObject({
        running: null,
        lastFinished: { passId, currentRepository: null, summary: { inserted: 7 } },
      });
      expect(finished.lastFinished.repositories).toHaveLength(4);
      expect(finished.lastFinished.summary.errors).toHaveLength(1);
      expect(discoveries).toBe(1);
      const nextResponse = await request(
        "ingest",
        "POST",
        JSON.stringify({
          owner: "acme",
          repo: "widgets",
          limit: 1,
        }),
      );
      expect(nextResponse.status).toBe(202);
      const next = (await nextResponse.json()) as { passId: string };
      expect(next.passId).not.toBe(passId);
      await Effect.runPromise(Deferred.await(nextEntered));
      expect(await (await request("ingest/status")).json()).toMatchObject({
        running: { passId: next.passId },
        lastFinished: { passId },
      });
      await Effect.runPromise(Deferred.succeed(nextRelease, undefined));
      const nextFinished = await Effect.runPromise(
        Effect.promise(() => request("ingest/status").then((r) => r.json())).pipe(
          Effect.repeat({ until: (status) => status.lastFinished.passId === next.passId }),
          Effect.timeout("1 second"),
        ),
      );
      expect(nextFinished.lastFinished.summary).toMatchObject({ inserted: 0, errors: [] });
      expect(nextFinished.lastFinished.repositories).toHaveLength(1);
      expect(selected.at(-1)).toEqual({ repo: "widgets", limit: 1 });
      expect(discoveries).toBe(1);
    } finally {
      await app.dispose();
    }
  });
});
