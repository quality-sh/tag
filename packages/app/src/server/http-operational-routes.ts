// The operational routes: ingest passes, retention sweeps, and the index rebuild.
import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { ResultStore } from "./result-store.ts";
import type { Ingest } from "./ingest.ts";
import type { Retention } from "./retention.ts";
import { json } from "./http-helpers.ts";

const IngestBody = Schema.Struct({
  owner: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
});

export const addOperationalRoutes = (deps: {
  readonly router: HttpRouter.HttpRouter;
  readonly ingest: Ingest.Interface;
  readonly retention: Retention.Interface;
  readonly results: ResultStore.Interface;
}) =>
  Effect.gen(function* () {
    const { router, ingest, retention, results } = deps;

    yield* router.add("GET", "/api/ingest/status", () => Effect.map(ingest.status(), json));

    yield* router.add("POST", "/api/ingest", () =>
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(IngestBody).pipe(
          Effect.orElseSucceed((): typeof IngestBody.Type => ({})),
        );
        const opts = body.limit !== undefined ? { limit: body.limit } : {};
        const pass = yield* ingest.start(
          body.owner && body.repo ? { owner: body.owner, repo: body.repo } : undefined,
          opts,
        );
        return json(pass, 202);
      }),
    );

    yield* router.add("POST", "/api/retention/sweep", () => Effect.map(retention.sweep(), json));

    yield* router.add(
      "POST",
      "/api/rebuild",
      Effect.map(results.rebuild(), (r) => json(r)),
    );
  });
