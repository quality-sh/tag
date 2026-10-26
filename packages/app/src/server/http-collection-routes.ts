// Collections and artifacts: the saved scopes, and the short-lived artifact links.
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import { CollectionInput, type Collection, sinceOf } from "../grouping.ts";
import type { AppConfig } from "./config.ts";
import { Auth } from "./auth.ts";
import { ResultStore } from "./result-store.ts";
import { collectionRows, json, notFound, query, slug, BadRequest } from "./http-helpers.ts";

/** Same host as the request, on the artifact port. ARTIFACT_ORIGIN overrides this in production. */
function artifactOriginFor(req: HttpServerRequest.HttpServerRequest, artifactPort: number): string {
  const override = process.env.ARTIFACT_ORIGIN;
  if (override) return override.replace(/\/$/, "");
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(":")[0];
  const proto = req.headers["x-forwarded-proto"] ?? "http";
  return `${proto}://${host}:${artifactPort}`;
}

/** Save a collection under a free id made from its name; the one path every save takes. */
export const createCollection = Effect.fn("Http.createCollection")(function* (
  results: ResultStore.Interface,
  input: typeof CollectionInput.Type,
) {
  const existing = yield* results.collections();
  let id = slug(input.name);
  for (let n = 2; existing.some((c) => c.id === id); n++) id = `${slug(input.name)}-${n}`;
  const c: Collection = {
    id,
    name: input.name,
    description: input.description ?? "",
    query: input.query,
    createdAt: new Date().toISOString(),
  };
  yield* results.saveCollection(c);
  return c;
});

export const addCollectionRoutes = (deps: {
  readonly router: HttpRouter.HttpRouter;
  readonly results: ResultStore.Interface;
  readonly auth: Auth.Interface;
  readonly cfg: AppConfig.Interface;
}) =>
  Effect.gen(function* () {
    const { router, results, auth, cfg } = deps;

    /** Every collection with what it holds now: groups, runs and failing groups over 30 days. */
    yield* router.add("GET", "/api/collections", () =>
      Effect.gen(function* () {
        const list = yield* results.collections();
        const since = sinceOf("30d");
        const reports = yield* results.reports({ since });
        const refs = yield* results.refs();
        return json(collectionRows(list, reports, refs, since));
      }),
    );

    yield* router.add("POST", "/api/collections", () =>
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(CollectionInput).pipe(
          Effect.mapError(() => new BadRequest({ detail: "name and query are required" })),
        );
        return json(yield* createCollection(results, body), 201);
      }),
    );

    yield* router.add("DELETE", "/api/collections/:id", () =>
      Effect.gen(function* () {
        const { id = "" } = yield* HttpRouter.params;
        const removed = yield* results.deleteCollection(id);
        return removed ? json({ ok: true }) : notFound("collection");
      }),
    );

    /** A short-lived link onto the artifact origin, which sets its own cookie and redirects. */
    yield* router.add("GET", "/api/artifacts/:artifactId/link", (req) =>
      Effect.gen(function* () {
        const { artifactId = "" } = yield* HttpRouter.params;
        const art = yield* results.getArtifact(artifactId);
        if (Option.isNone(art)) return notFound("artifact");
        const path = query(req).get("path") ?? "index.html";
        const origin = artifactOriginFor(req, cfg.artifactPort);
        const target = `${origin}/a/${art.value.owner}/${art.value.repo}/${artifactId}/${path}`;
        return json({
          url: auth.enabled ? `${target}?t=${encodeURIComponent(auth.issueHandoff())}` : target,
          cached: art.value.state === "cached",
        });
      }),
    );
  });
