// TAG entrypoint: two Bun HTTP servers (dashboard + artifacts) over one set of services.
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { AppConfig } from "./server/config.ts";
import { ArtifactStore } from "./server/artifact-store.ts";
import { ArtifactSource } from "./server/artifact-source.ts";
import { GitHubSource } from "./server/github-source.ts";
import { ResultStore } from "./server/result-store.ts";
import { Installation } from "./server/installation.ts";
import { Ingest } from "./server/ingest.ts";
import { Retention } from "./server/retention.ts";
import { Auth } from "./server/auth.ts";
import { Oidc } from "./server/oidc.ts";
import { App } from "./server/http.ts";
import { ArtifactApp } from "./server/artifact-server.ts";

const WEB_ROOT = new URL("../dist/", import.meta.url).pathname;

// One layer value per resource: every reference in the composition builds once, so the
// source, the install flow and the stores all see the same instances.
const store = ArtifactStore.layer;
const results = ResultStore.layer.pipe(Layer.provide(store));
const installation = Installation.layer.pipe(Layer.provide(results));

const SourceLayer = Layer.unwrap(
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    if (cfg.source === "github")
      return GitHubSource.layer.pipe(
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(installation),
      );
    return ArtifactSource.layerFixtures(cfg.fixturesDir);
  }),
);

// Built bottom-up: ingest needs the result store, which needs the artifact store; the
// stores, the source and auth all need the config; OIDC needs auth. provideMerge keeps every service visible.
const Services = Layer.mergeAll(
  Ingest.layer,
  Retention.layer,
  Oidc.layer.pipe(Layer.provide(FetchHttpClient.layer)),
).pipe(
  Layer.provideMerge(results),
  Layer.provideMerge(Layer.mergeAll(store, SourceLayer, Auth.layer, installation)),
  Layer.provideMerge(AppConfig.layer),
);

/** Ingest recent runs once on boot, in the background. */
const BootIngest = Layer.effectDiscard(
  Effect.gen(function* () {
    const ingest = yield* Ingest.Service;
    yield* ingest.ingestAll({ limit: 20 }).pipe(
      Effect.tap((s) =>
        Effect.logInfo(`boot ingest: ${s.inserted} new reports, ${s.errors.length} errors`),
      ),
      Effect.forkScoped,
    );
  }),
);

const Servers = Layer.unwrap(
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    const dashboard = HttpRouter.serve(App(WEB_ROOT)).pipe(
      Layer.provide(BunHttpServer.layer({ port: cfg.port })),
    );
    const artifacts = HttpRouter.serve(ArtifactApp).pipe(
      Layer.provide(BunHttpServer.layer({ port: cfg.artifactPort })),
    );
    yield* Effect.logInfo(
      `dashboard on http://localhost:${cfg.port}  artifacts on http://localhost:${cfg.artifactPort}`,
    );
    return Layer.mergeAll(dashboard, artifacts);
  }),
);

const Main = Layer.mergeAll(Servers, BootIngest, Retention.sweeper).pipe(Layer.provide(Services));

BunRuntime.runMain(Layer.launch(Main));
