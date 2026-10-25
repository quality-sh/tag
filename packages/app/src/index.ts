// TAG entrypoint: two Bun HTTP servers (dashboard + artifacts) over one set of services.
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter } from "effect/http";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { AppConfig } from "./server/config.ts";
import { ArtifactStore } from "./server/artifact-store.ts";
import { ArtifactSource } from "./server/artifact-source.ts";
import { GitHubSource } from "./server/github-source.ts";
import { ResultStore } from "./server/result-store.ts";
import { Ingest } from "./server/ingest.ts";
import { Retention } from "./server/retention.ts";
import { Auth } from "./server/auth.ts";
import { App } from "./server/http.ts";
import { ArtifactApp } from "./server/artifact-server.ts";

const WEB_ROOT = new URL("../dist/", import.meta.url).pathname;

const SourceLayer = Layer.unwrap(
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    if (cfg.source === "github")
      return GitHubSource.layer.pipe(Layer.provide(FetchHttpClient.layer));
    return ArtifactSource.layerFixtures(cfg.fixturesDir);
  }),
);

// Built bottom-up: ingest needs the result store, which needs the artifact store; the
// stores, the source and auth all need the config. provideMerge keeps every service visible.
const Services = Layer.mergeAll(Ingest.layer, Retention.layer).pipe(
  Layer.provideMerge(ResultStore.layer),
  Layer.provideMerge(Layer.mergeAll(ArtifactStore.layer, SourceLayer, Auth.layer)),
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
    // An ingest or a sweep answers when it is done, which can take minutes on a busy org;
    // Bun drops a connection after 10 idle seconds unless told otherwise (255 is its ceiling).
    const idleTimeout = 255;
    const dashboard = HttpRouter.serve(App(WEB_ROOT)).pipe(
      Layer.provide(BunHttpServer.layer({ port: cfg.port, idleTimeout })),
    );
    const artifacts = HttpRouter.serve(ArtifactApp).pipe(
      Layer.provide(BunHttpServer.layer({ port: cfg.artifactPort, idleTimeout })),
    );
    yield* Effect.logInfo(
      `dashboard on http://localhost:${cfg.port}  artifacts on http://localhost:${cfg.artifactPort}`,
    );
    return Layer.mergeAll(dashboard, artifacts);
  }),
);

const Main = Layer.mergeAll(Servers, BootIngest, Retention.sweeper).pipe(Layer.provide(Services));

BunRuntime.runMain(Layer.launch(Main));
