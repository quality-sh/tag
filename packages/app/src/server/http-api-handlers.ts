// The read API's handlers: each one a call into the Reads service, with its failures turned
// into the errors the API declares.
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { AppConfig } from "./config.ts";
import { Reads } from "./reads.ts";
import type { ResultStore } from "./result-store.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import { NotFound, ServerError, TagApi } from "./http-api.ts";

const serverError = (e: ResultStore.DbError | ArtifactStore.StoreError) =>
  new ServerError({
    error: e._tag === "ResultStore.DbError" ? "database error" : "store error",
    operation: e.operation,
    detail: String(e.cause),
  });

const notFound = (e: Reads.NotFound) => new NotFound({ error: `${e.what} not found` });

export const ReadHandlers = HttpApiBuilder.group(TagApi, "read", (handlers) =>
  Effect.gen(function* () {
    const reads = yield* Reads.Service;
    const cfg = yield* AppConfig.Service;
    const health = {
      ok: true,
      source: cfg.source,
      store: Option.isSome(cfg.s3) ? ("s3" as const) : ("fs" as const),
    };
    return handlers
      .handle("health", () => Effect.succeed(health))
      .handle("overview", ({ query }) => reads.overview(query).pipe(Effect.mapError(serverError)))
      .handle("repos", () => reads.repos().pipe(Effect.mapError(serverError)))
      .handle("repositories", () => reads.repositories().pipe(Effect.mapError(serverError)))
      .handle("fields", ({ query }) =>
        reads.fields(query.q ?? "").pipe(Effect.mapError(serverError)),
      )
      .handle("groups", ({ query }) => reads.groups(query).pipe(Effect.mapError(serverError)))
      .handle("group", ({ params, query }) =>
        reads.group({ ...params, ...query }).pipe(
          Effect.catchTag("Reads.NotFound", (e) => Effect.fail(notFound(e))),
          Effect.mapError((e) => (e._tag === "NotFound" ? e : serverError(e))),
        ),
      )
      .handle("runs", ({ query }) => reads.runs(query).pipe(Effect.mapError(serverError)))
      .handle("report", ({ params }) =>
        reads.report(params.reportId).pipe(
          Effect.catchTag("Reads.NotFound", (e) => Effect.fail(notFound(e))),
          Effect.mapError((e) => (e._tag === "NotFound" ? e : serverError(e))),
        ),
      )
      .handle("testHistory", ({ params, query }) =>
        reads.testHistory({ ...params, ...query }).pipe(Effect.mapError(serverError)),
      )
      .handle("collections", () => reads.collections().pipe(Effect.mapError(serverError)))
      .handle("suggestions", ({ query }) =>
        reads.suggestions(query.org).pipe(Effect.mapError(serverError)),
      );
  }),
);
