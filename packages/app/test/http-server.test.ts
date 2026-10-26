import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { BunHttpServer } from "@effect/platform-bun";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { Retention } from "../src/server/retention.ts";
import { Auth } from "../src/server/auth.ts";
import { Installation } from "../src/server/installation.ts";
import { App } from "../src/server/http.ts";
import { testLayer } from "./helpers.ts";

const SCAN_FIXTURES = new URL("../../../fixtures-scan/", import.meta.url).pathname;

describe("the dashboard app", () => {
  test("answers 401 signed out, then serves the scans and the repository's own branch", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "tag-web-"));
    const { layer } = await testLayer(ArtifactSource.makeFixtures(SCAN_FIXTURES));
    const services = Layer.mergeAll(Auth.layer, Retention.layer, Installation.layer).pipe(
      Layer.provideMerge(layer),
    );
    // Reserve a port so the test knows where the server landed.
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const server = HttpRouter.serve(App(webRoot)).pipe(
      Layer.provide(BunHttpServer.layer({ port })),
    );
    const app = Layer.mergeAll(server).pipe(Layer.provide(services));
    const drive = async (base: string) => {
      // Signed out, the API is closed.
      expect((await fetch(`${base}/api/overview`)).status).toBe(401);

      // Sign in, drive a pass, then read the overview.
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.getSetCookie()[0]?.split(";")[0];
      if (cookie === undefined) throw new Error("the login set no session cookie");
      expect(cookie).toStartWith("tag_session=");

      const started = await fetch(`${base}/api/ingest`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: "{}",
      });
      expect(started.status).toBe(202);
      const { passId } = (await started.json()) as { passId: string };

      const status = async () =>
        (await (await fetch(`${base}/api/ingest/status`, { headers: { cookie } })).json()) as {
          running: unknown;
          lastFinished: { passId: string; summary: { errors: string[] } } | null;
        };
      let state = await status();
      for (let i = 0; i < 250 && state.lastFinished === null; i++) {
        await Bun.sleep(20);
        state = await status();
      }
      expect(state.lastFinished?.passId).toBe(passId);
      expect(state.lastFinished?.summary.errors).toEqual([]);

      const overview = (await (
        await fetch(`${base}/api/overview`, { headers: { cookie } })
      ).json()) as {
        repos: Array<{ owner: string; repo: string; defaultBranch: string | null }>;
        scans: Record<string, { classification: string | null; defaultBranch: string | null }>;
      };
      expect(Object.keys(overview.scans).sort()).toEqual([
        "acme/bun-suite",
        "acme/nextest-matrix",
        "acme/polyglot",
        "acme/quiet",
        "acme/scanrepo",
        "acme/tap-only",
        "acme/web-suite",
        "acme/workflow-only",
      ]);
      expect(overview.scans["acme/quiet"]).toMatchObject({
        classification: "no-tests",
        defaultBranch: "trunk",
      });
      // The repository's own default branch beats the guess from its runs.
      const scanrepo = overview.repos.find((r) => r.repo === "scanrepo");
      expect(scanrepo?.defaultBranch).toBe("trunk");
    };
    await Effect.runPromise(
      Effect.promise(() => drive(`http://127.0.0.1:${port}`)).pipe(Effect.provide(app)),
    );
  }, 20_000);
});
