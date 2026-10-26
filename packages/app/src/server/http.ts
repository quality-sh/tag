// The dashboard API and static web app. One Bun server on PORT.
import { Effect, Layer } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/http";
import { AppConfig } from "./config.ts";
import { Auth } from "./auth.ts";
import { Installation } from "./installation.ts";
import { ResultStore } from "./result-store.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { Ingest } from "./ingest.ts";
import { Retention } from "./retention.ts";
import { json, type BadRequest } from "./http-helpers.ts";
import { addAuthRoutes, requireSession } from "./http-auth-routes.ts";
import { addOperationalRoutes } from "./http-operational-routes.ts";
import { addReadRoutes } from "./http-read-routes.ts";
import { addCollectionRoutes } from "./http-collection-routes.ts";
import { addWebhookRoutes } from "./http-webhook-routes.ts";

export const ApiRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const results = yield* ResultStore.Service;
    const ingest = yield* Ingest.Service;
    const retention = yield* Retention.Service;
    const auth = yield* Auth.Service;
    const cfg = yield* AppConfig.Service;
    const installation = yield* Installation.Service;
    // Background passes fork here: the scope lives as long as the server, not the request.
    const background = yield* Effect.scope;

    yield* addAuthRoutes({ router, auth, installation, ingest, cfg, background });
    yield* addOperationalRoutes({ router, cfg, ingest, retention, results });
    yield* addReadRoutes({ router, results });
    yield* addCollectionRoutes({ router, results, auth, cfg });
    yield* addWebhookRoutes({ router, cfg, ingest });
  }),
);

/** Map typed failures to responses so one bad request never takes the server down. */
const errorsToResponses = HttpRouter.middleware<{
  handles: ResultStore.DbError | ArtifactStore.StoreError | BadRequest;
}>()(
  (httpEffect) =>
    httpEffect.pipe(
      Effect.catchTags({
        BadRequest: (e) => Effect.succeed(json({ error: e.detail }, 400)),
        "ResultStore.DbError": (e) =>
          Effect.succeed(
            json({ error: "database error", operation: e.operation, detail: String(e.cause) }, 500),
          ),
        "ArtifactStore.StoreError": (e) =>
          Effect.succeed(
            json(
              { error: "store error", operation: e.operation, key: e.key, detail: String(e.cause) },
              500,
            ),
          ),
      }),
    ),
  { global: true },
);

export const WebApp = (root: string) =>
  HttpStaticServer.layer({ root, index: "index.html", spa: true, cacheControl: "no-cache" });

export const App = (webRoot: string) =>
  Layer.mergeAll(ApiRoutes, WebApp(webRoot), requireSession).pipe(
    Layer.provideMerge(errorsToResponses),
  );
