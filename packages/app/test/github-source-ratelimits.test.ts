// GitHubSource under GitHub rate limits: the wait before the one retry, the
// secondary-rate gate across a pass, and the allowances the headers leave.
import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { Ingest } from "../src/server/ingest.ts";
import { buildZip } from "../src/server/zip.ts";
import { fakeGithub, testLayer } from "./helpers.ts";
import { cfg, run, sourceWith, using } from "./github-fixtures.ts";

describe("GitHubSource", () => {
  for (const [status, headers] of [
    [403, { "retry-after": "30" }],
    [429, { "x-ratelimit-reset": "30" }],
    [403, { "retry-after": "Thu, 01 Jan 1970 00:00:30 GMT" }],
  ] as const) {
    test(`waits before retrying ${status} with ${JSON.stringify(headers)}`, async () => {
      let attempts = 0;
      const gh = fakeGithub({
        "/repos/acme/widgets/actions/artifacts": () =>
          ++attempts === 1
            ? Response.json(
                { message: "rate limited" },
                { status, headers: { ...headers, "x-ratelimit-remaining": "0" } },
              )
            : Response.json({ artifacts: [] }, { headers: { "x-ratelimit-remaining": "49" } }),
      });
      await Effect.runPromise(
        Effect.gen(function* () {
          const source = yield* ArtifactSource.Service;
          const pending = yield* source
            .listRepoArtifacts({ owner: "acme", repo: "widgets" }, new Set())
            .pipe(Effect.forkScoped);
          yield* TestClock.adjust("29 seconds");
          expect(attempts).toBe(1);
          yield* TestClock.adjust("1 second");
          expect(yield* Fiber.join(pending)).toEqual([]);
          expect(attempts).toBe(2);
          expect(yield* source.requestStats()).toEqual({ waits: 1, remaining: 49 });
        }).pipe(
          Effect.scoped,
          Effect.provide(sourceWith(cfg(), gh.layer)),
          Effect.provide(TestClock.layer()),
        ),
      );
    });
  }

  test("surfaces HTTP status even when the error body is not JSON", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/artifacts": () => new Response("Forbidden", { status: 403 }),
    });
    const error = await using(sourceWith(cfg(), gh.layer), (source) =>
      source.listRepoArtifacts({ owner: "acme", repo: "widgets" }, new Set()).pipe(Effect.flip),
    );
    expect(error.status).toBe(403);
    expect(error.detail).toContain("GitHub answered 403");
  });

  test("reports a missing scope with GitHub's message without retrying", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/artifacts": () =>
        Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
    });
    const error = await using(sourceWith(cfg(), gh.layer), (source) =>
      source.listRepoArtifacts({ owner: "acme", repo: "widgets" }, new Set()).pipe(Effect.flip),
    );
    expect(error.status).toBe(403);
    expect(error.detail).toContain("Resource not accessible by integration");
    expect(gh.hits).toHaveLength(1);
  });

  test("a pass waits on the fifth download, gates later runs and reports one wait", async () => {
    const limited = Deferred.makeUnsafe<void>();
    const downloads: number[] = [];
    const zip = buildZip([]);
    const gh = fakeGithub({
      "/repos/acme/widgets": () => ({ default_branch: "main" }),
      "/repos/acme/widgets/environments": () => ({ environments: [] }),
      "/repos/acme/widgets/git/trees/main": () => ({ tree: [] }),
      "/repos/acme/widgets/releases": () => [],
      "/repos/acme/widgets/tags": () => [],
      "/repos/acme/widgets/pulls": () => [],
      "/repos/acme/widgets/deployments": () => [],
      "/repos/acme/widgets/actions/runs": (_url, headers) =>
        headers["if-none-match"]
          ? new Response(null, { status: 304 })
          : Response.json(
              { workflow_runs: Array.from({ length: 8 }, (_, i) => run(1001 + i)) },
              { headers: { etag: '"v1"' } },
            ),
      "/repos/acme/widgets/actions/artifacts": () => ({
        artifacts: Array.from({ length: 8 }, (_, i) => ({
          id: 1001 + i,
          name: "report",
          size_in_bytes: zip.length,
          expired: false,
          workflow_run: { id: 1001 + i, head_sha: "abc" },
        })),
      }),
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [
          `/repos/acme/widgets/actions/artifacts/${1001 + i}/zip`,
          () => {
            downloads.push(1001 + i);
            if (downloads.length === 5) {
              Effect.runSync(Deferred.succeed(limited, undefined));
              return Response.json(
                { message: "secondary rate limit" },
                { status: 403, headers: { "retry-after": "30", "x-ratelimit-remaining": "0" } },
              );
            }
            return new Response(new Uint8Array(zip), {
              headers: { "x-ratelimit-remaining": "42" },
            });
          },
        ]),
      ),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* ArtifactSource.Service;
        const { layer } = yield* Effect.promise(() => testLayer(source));
        yield* Effect.gen(function* () {
          const ingest = yield* Ingest.Service;
          const pending = yield* ingest.ingestAll().pipe(Effect.forkScoped);
          yield* Deferred.await(limited);
          yield* TestClock.adjust("29 seconds");
          expect(downloads).toHaveLength(5);
          yield* TestClock.adjust("1 second");
          expect(yield* Fiber.join(pending)).toMatchObject({
            runs: 8,
            cached: 8,
            waits: 1,
            remaining: 42,
            errors: [],
          });
          expect(downloads).toHaveLength(9);
          expect(downloads[5]).toBe(downloads[4]);
          expect(yield* ingest.ingestAll()).toMatchObject({
            runs: 0,
            cached: 0,
            waits: 0,
            remaining: 42,
            errors: [],
          });
          // The first pass walks the retention window, a different page from the steady-state
          // one, so revalidation starts with the second steady-state pass.
          expect(yield* ingest.ingestAll()).toMatchObject({ runs: 0, errors: [] });
          expect(
            gh.hits.filter((hit) => hit.url.pathname.endsWith("/runs")).map((hit) => hit.etag),
          ).toEqual([undefined, undefined, '"v1"']);
        }).pipe(Effect.provide(layer));
      }).pipe(
        Effect.scoped,
        Effect.provide(sourceWith(cfg(), gh.layer)),
        Effect.provide(TestClock.layer()),
      ),
    );
  });

  test("retries a rate-limited request only once and releases the gate on failure", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/artifacts": () =>
        Response.json(
          { message: "still limited" },
          { status: 429, headers: { "retry-after": "30" } },
        ),
      "/repos/acme/widgets/actions/runs": () => ({ workflow_runs: [] }),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* ArtifactSource.Service;
        const pending = yield* source
          .listRepoArtifacts({ owner: "acme", repo: "widgets" }, new Set())
          .pipe(Effect.flip, Effect.forkScoped);
        yield* TestClock.adjust("30 seconds");
        expect(yield* Fiber.join(pending)).toMatchObject({
          status: 429,
          detail: "acme/widgets: GitHub answered 429 still limited",
        });
        expect(gh.hits).toHaveLength(2);
        expect(yield* source.listRuns({ owner: "acme", repo: "widgets" }, { limit: 20 })).toEqual(
          [],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(sourceWith(cfg(), gh.layer)),
        Effect.provide(TestClock.layer()),
      ),
    );
  });

  test("does not retry invalid rate headers and retains the last valid allowance", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/artifacts": () =>
        Response.json(
          { message: "denied" },
          {
            status: 429,
            headers: {
              "retry-after": "invalid",
              "x-ratelimit-reset": "-1",
              "x-ratelimit-remaining": "invalid",
            },
          },
        ),
      "/repos/acme/widgets/actions/runs": () =>
        Response.json({ workflow_runs: [] }, { headers: { "x-ratelimit-remaining": "12" } }),
    });
    await using(sourceWith(cfg(), gh.layer), (source) =>
      Effect.gen(function* () {
        const repo = { owner: "acme", repo: "widgets" };
        yield* source.listRuns(repo, { limit: 20 });
        expect((yield* source.listRepoArtifacts(repo, new Set()).pipe(Effect.flip)).status).toBe(
          429,
        );
        expect(yield* source.requestStats()).toEqual({ waits: 0, remaining: 12 });
        expect(gh.hits).toHaveLength(2);
      }),
    );
  });

  test("a negative retry-after is not an HTTP date", async () => {
    const gh = fakeGithub({
      "/repos/acme/widgets/actions/artifacts": () =>
        Response.json({ message: "denied" }, { status: 403, headers: { "retry-after": "-1" } }),
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const source = yield* ArtifactSource.Service;
        const pending = yield* source
          .listRepoArtifacts({ owner: "acme", repo: "widgets" }, new Set())
          .pipe(Effect.flip, Effect.forkScoped);
        yield* TestClock.adjust(0);
        expect(yield* source.requestStats()).toMatchObject({ waits: 0 });
        expect((yield* Fiber.join(pending)).status).toBe(403);
        expect(gh.hits).toHaveLength(1);
      }).pipe(
        Effect.scoped,
        Effect.provide(sourceWith(cfg(), gh.layer)),
        Effect.provide(TestClock.layer()),
      ),
    );
  });
});
