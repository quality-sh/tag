// The dashboard API and static web app. One Bun server on PORT.
import { Effect, Layer } from "effect";
import { HttpRouter, HttpStaticServer } from "effect/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/http-api";
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
import { addCollectionRoutes } from "./http-collection-routes.ts";
import { addProposalRoutes } from "./http-proposal-routes.ts";
import { ArtifactSource } from "./artifact-source.ts";
import { addWebhookRoutes } from "./http-webhook-routes.ts";
import { addSuggestionRoutes } from "./http-suggestion-routes.ts";
import { Reads } from "./reads.ts";
import { DOCS_PATH, OPENAPI_PATH, TagApi } from "./http-api.ts";
import { ReadHandlers } from "./http-api-handlers.ts";
import { McpLayer } from "./mcp.ts";
import { requireMcpAuth } from "./mcp-auth.ts";

export const ApiRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const results = yield* ResultStore.Service;
    const ingest = yield* Ingest.Service;
    const retention = yield* Retention.Service;
    const auth = yield* Auth.Service;
    const cfg = yield* AppConfig.Service;
    const installation = yield* Installation.Service;
    const source = yield* ArtifactSource.Service;
    const reads = yield* Reads.Service;
    // Background passes fork here: the scope lives as long as the server, not the request.
    const background = yield* Effect.scope;

    yield* addAuthRoutes({ router, auth, installation, ingest, cfg, background });
    yield* addOperationalRoutes({ router, ingest, retention, results });
    yield* addCollectionRoutes({ router, results, auth, cfg });
    yield* addProposalRoutes({ router, results, source });
    yield* addWebhookRoutes({ router, cfg, ingest });
    yield* addSuggestionRoutes({ router, results, reads });
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

/** The read routes, declared once in TagApi, with its OpenAPI document and the Scalar page. */
export const ReadApi = Layer.mergeAll(
  HttpApiBuilder.layer(TagApi, { openapiPath: OPENAPI_PATH }).pipe(Layer.provide(ReadHandlers)),
  HttpApiScalar.layer(TagApi, { path: DOCS_PATH }),
);

export const App = (webRoot: string) =>
  Layer.mergeAll(
    ApiRoutes,
    ReadApi,
    McpLayer,
    WebApp(webRoot),
    requireSession,
    requireMcpAuth,
  ).pipe(Layer.provide(Reads.layer), Layer.provideMerge(errorsToResponses));
