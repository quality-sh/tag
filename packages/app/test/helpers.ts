import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

export const tmpDir = () => mkdtemp(join(tmpdir(), "tag-"));

/** Full stack on a temp filesystem store and an in-memory index. */
export const testLayer = async (sourceOverride?: ArtifactSource.Interface) => {
  const dir = await tmpDir();
  const config = Layer.succeed(AppConfig.Service, testConfig());
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
  } = {},
): Promise<{ readonly base: string; readonly stop: () => Promise<void> }> => {
  const dir = await tmpDir();
  const web = join(dir, "web");
  await mkdir(web, { recursive: true });
  await writeFile(join(web, "index.html"), "<!doctype html><title>tag</title>");
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
    : ArtifactSource.layerFixtures(FIXTURES);
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
  // The tap sees the server once it is listening; the same layer value builds once, so the
  // port the tap reads is the port the app serves on.
  const bunServer = BunHttpServer.layer({ port: 0, hostname: "127.0.0.1" }).pipe(
    Layer.tap((ctx) =>
      Effect.gen(function* () {
        const server = Context.get(ctx, HttpServer.HttpServer);
        yield* Deferred.succeed(ready, HttpServer.formatAddress(server.address));
      }),
    ),
  );
  const served = HttpRouter.serve(App(web)).pipe(Layer.provide(services), Layer.provide(bunServer));
  const exited = Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* Layer.build(served);
        yield* Deferred.await(ready);
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
