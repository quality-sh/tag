import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Deferred, Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from "effect/http";
import { BunHttpServer } from "@effect/platform-bun";
import { AppConfig } from "../src/server/config.ts";
import { ArtifactStore } from "../src/server/artifact-store.ts";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { GitHubSource } from "../src/server/github-source.ts";
import { Installation } from "../src/server/installation.ts";
import { ResultStore } from "../src/server/result-store.ts";
import { Ingest } from "../src/server/ingest.ts";
import { Retention } from "../src/server/retention.ts";
import { Auth } from "../src/server/auth.ts";
import { App } from "../src/server/http.ts";

export const FIXTURES = new URL("../../../fixtures/", import.meta.url).pathname;

export const testConfig = (overrides: Partial<AppConfig.Interface> = {}): AppConfig.Interface => ({
  s3: Option.none(),
  dataDir: ".data-test",
  sqlitePath: ":memory:",
  source: "fixtures",
  fixturesDir: FIXTURES,
  github: Option.none(),
  password: Redacted.make("test"),
  sessionSecret: Redacted.make("test-secret"),
  port: 0,
  artifactPort: 0,
  copyPolicy: "copy",
  artifactRetentionDays: 90,
  ...overrides,
});

// bun test never runs process exit hooks, so every run sweeps the temp dirs of the
// runs that came before it: the suite hands out dozens of megabyte-scale store dirs
// per run, and without this, looping the suite floods /tmp with writeback that
// stalls fsync-heavy steps (SQLite open and close) for whole seconds.
const sweepLeakedTmpDirs = () => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  try {
    for (const entry of readdirSync(tmpdir())) {
      if (!entry.startsWith("tag-")) continue;
      const full = join(tmpdir(), entry);
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true });
    }
  } catch {
    // A missing or crowded tmpdir only means less to sweep; the suite runs regardless.
  }
};
sweepLeakedTmpDirs();

export const tmpDir = () => mkdtemp(join(tmpdir(), "tag-"));
/** Same as `tmpDir`, where the caller needs the path before any await. */
export const tmpDirSync = () => mkdtempSync(join(tmpdir(), "tag-"));

/** Full stack on a temp filesystem store and an in-memory index. */
export const testLayer = async (
  sourceOverride?: ArtifactSource.Interface,
  overrides: Partial<AppConfig.Interface> = {},
) => {
  const dir = await tmpDir();
  const config = Layer.succeed(AppConfig.Service, testConfig(overrides));
  const store = ArtifactStore.layerFs(join(dir, "store"));
  const source = sourceOverride
    ? Layer.succeed(ArtifactSource.Service, sourceOverride)
    : ArtifactSource.layerFixtures(FIXTURES);
  const results = ResultStore.layer.pipe(Layer.provide(Layer.mergeAll(config, store)));
  const ingest = Ingest.layer.pipe(Layer.provide(Layer.mergeAll(config, store, source, results)));
  return { dir, layer: Layer.mergeAll(config, store, source, results, ingest) };
};

export const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

export type Hit = { method: string; url: URL; auth: string | undefined; etag: string | undefined };

/** A GitHub that answers from a table of path -> body, remembering every request. */
export const fakeGithub = (
  routes: Record<string, (url: URL, headers: Readonly<Record<string, string>>) => unknown>,
) => {
  const hits: Hit[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      hits.push({
        method: request.method,
        url,
        auth: request.headers["authorization"],
        etag: request.headers["if-none-match"],
      });
      const route = routes[url.pathname];
      if (!route)
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
        );
      const out = route(url, request.headers);
      return HttpClientResponse.fromWeb(
        request,
        out instanceof Response
          ? out
          : new Response(JSON.stringify(out), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
      );
    }),
  );
  return { hits, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

/** Poll a real server's side effect; false when it never came true within `ms`. */
export const eventually = async (f: () => boolean, ms = 5000): Promise<boolean> => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) return false;
    await Bun.sleep(10);
  }
  return true;
};

/**
 * The real dashboard app on an ephemeral port: requireSession, the API routes, the real
 * SQLite store and ingest, over a fake GitHub transport when one is given. Fetch it like
 * a browser would; `stop()` shuts it down.
 */
export const serveApp = async (
  opts: {
    readonly overrides?: Partial<AppConfig.Interface>;
    /** The GitHub transport; its presence selects the GitHub source over the fixtures one. */
    readonly http?: Layer.Layer<HttpClient.HttpClient>;
    /** A built dashboard; by default tests get a minimal placeholder page. */
    readonly webRoot?: string;
  } = {},
): Promise<{ readonly base: string; readonly stop: () => Promise<void> }> => {
  const dir = await tmpDir();
  const web = opts.webRoot ?? join(dir, "web");
  if (opts.webRoot === undefined) {
    await mkdir(web, { recursive: true });
    await writeFile(join(web, "index.html"), "<!doctype html><title>tag</title>");
  }
  const config = Layer.succeed(
    AppConfig.Service,
    testConfig({ source: opts.http ? "github" : "fixtures", ...opts.overrides }),
  );
  const store = ArtifactStore.layerFs(join(dir, "store"));
  const results = ResultStore.layer.pipe(Layer.provide(Layer.mergeAll(config, store)));
  const installation = Installation.layer.pipe(
    Layer.provide(Layer.mergeAll(config, results)),
    Layer.orDie,
  );
  const source = opts.http
    ? GitHubSource.layer.pipe(
        Layer.provide(opts.http),
        Layer.provide(installation),
        Layer.provide(config),
      )
    : ArtifactSource.layerFixtures(opts.overrides?.fixturesDir ?? FIXTURES);
  const ingest = Ingest.layer.pipe(Layer.provide(Layer.mergeAll(config, store, source, results)));
  const retention = Retention.layer.pipe(Layer.provide(Layer.mergeAll(config, store, results)));
  const auth = Auth.layer.pipe(Layer.provide(config));
  const services = Layer.mergeAll(
    config,
    store,
    source,
    results,
    ingest,
    retention,
    auth,
    installation,
  );
  const ready = Deferred.makeUnsafe<string>();
  const done = Deferred.makeUnsafe<void>();
  // Bun.serve listens immediately but answers with a placeholder 404 handler until
  // HttpRouter.serve installs the app, which happens later in the served layer's own
  // build. So the server tap only captures the listening address, and `ready` waits
  // for the whole served layer to be built: the first request always meets the app.
  const listening = Deferred.makeUnsafe<string>();
  const bunServer = BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" }).pipe(
    Layer.tap((ctx) =>
      Effect.gen(function* () {
        const server = Context.get(ctx, HttpServer.HttpServer);
        yield* Deferred.succeed(listening, HttpServer.formatAddress(server.address));
      }),
    ),
  );
  const served = HttpRouter.serve(App(web)).pipe(Layer.provide(services), Layer.provide(bunServer));
  const exited = Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(served);
        const base = yield* Deferred.await(listening);
        yield* Deferred.succeed(ready, base);
        yield* Deferred.await(done);
      }),
    ),
  );
  const base = await Effect.runPromise(Deferred.await(ready));
  return {
    base,
    stop: async () => {
      await Effect.runPromise(Deferred.succeed(done, void 0)).catch(() => {});
      await exited;
      await rm(dir, { recursive: true, force: true });
    },
  };
};

/** S3 config for the local RustFS from docker-compose; undefined when it is not reachable. */
export const localS3 = async (): Promise<AppConfig.S3Config | undefined> => {
  try {
    const res = await fetch("http://localhost:9000/", { signal: AbortSignal.timeout(1500) });
    if (res.status === 0) return undefined;
  } catch {
    return undefined;
  }
  return {
    bucket: "tag",
    endpoint: Option.some("http://localhost:9000"),
    region: "us-east-1",
    accessKeyId: Redacted.make("tag"),
    secretAccessKey: Redacted.make("tagdev"),
  };
};
