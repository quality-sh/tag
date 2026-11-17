// The artifact origin: files of a cached artifact, an on-view fetch for one that is not,
// and a file list where the dashboard's "index.html" link meets an artifact without one.
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { BunHttpServer } from "@effect/platform-bun";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { ArtifactApp } from "../src/server/artifact-server.ts";
import { ARTIFACT_COOKIE, Auth } from "../src/server/auth.ts";
import { Ingest } from "../src/server/ingest.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { fixturesWithBuildOutput, testLayer } from "./helpers.ts";

describe("the artifact server", () => {
  test("serves files, fetches a skipped artifact on view, and lists one without index.html", async () => {
    const { layer } = await testLayer(ArtifactSource.makeFixtures(await fixturesWithBuildOutput()));
    const services = Auth.layer.pipe(Layer.provideMerge(layer));
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const server = HttpRouter.serve(ArtifactApp).pipe(Layer.provide(BunHttpServer.layer({ port })));
    const base = `http://127.0.0.1:${port}/a/acme/widgets`;

    await Effect.runPromise(
      Effect.gen(function* () {
        const ingest = yield* Ingest.Service;
        const results = yield* ResultStore.Service;
        const auth = yield* Auth.Service;
        yield* ingest.ingestAll();
        const cookie = `${ARTIFACT_COOKIE}=${auth.issueSession()}`;
        const get = (path: string) =>
          Effect.promise(() => fetch(`${base}/${path}`, { headers: { cookie } }));

        // Signed out, nothing is served.
        expect(
          (yield* Effect.promise(() => fetch(`${base}/run-1001__junit-results/`))).status,
        ).toBe(401);

        // A cached artifact without index.html: the link the dashboard offers lists its files.
        const junit = yield* get("run-1001__junit-results/index.html");
        expect(junit.status).toBe(200);
        expect(junit.headers.get("content-type")).toContain("text/html");
        expect(junit.headers.get("content-security-policy")).toContain("default-src 'self'");
        expect(yield* Effect.promise(() => junit.text())).toContain('href="results.xml"');

        // A real file is served as itself, and a missing one is still a 404.
        expect((yield* get("run-1001__junit-results/results.xml")).status).toBe(200);
        expect((yield* get("run-1001__junit-results/nope.xml")).status).toBe(404);

        // A skipped artifact is fetched on first view; its names are escaped in the list.
        const build = yield* get("run-1001__build-output/");
        expect(build.status).toBe(200);
        const html = yield* Effect.promise(() => build.text());
        expect(html).toContain('href="app.bin"');
        expect(html).toContain('href="notes%20%26%20%3Creadme%3E.txt"');
        expect(html).toContain("notes &amp; &lt;readme&gt;.txt");
        expect(html).not.toContain("<readme>");
        const rows = yield* results.artifactsOfRun("acme", "widgets", "run-1001");
        expect(rows.find((r) => r.name === "build-output")?.state).toBe("cached");
        expect((yield* get("run-1001__build-output/app.bin")).status).toBe(200);
      }).pipe(Effect.provide(Layer.mergeAll(services, server.pipe(Layer.provide(services))))),
    );
  });
});
