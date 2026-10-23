// Serves cached artifact files (Playwright HTML reports, traces, screenshots) on their own origin.
// A separate origin keeps a hostile artifact from reading the dashboard's cookies. Strict CSP on top.
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { ARTIFACT_COOKIE, Auth } from "./auth.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { ResultStore } from "./result-store.ts";
import { ArtifactSource } from "./artifact-source.ts";
import { Ingest, artifactPrefix } from "./ingest.ts";

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "frame-src 'self' blob:",
  "frame-ancestors *",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const SAFETY_HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "private, max-age=3600",
};

const deny = (status: number, text: string) => HttpServerResponse.text(text, { status });

export const ArtifactRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service;
    const store = yield* ArtifactStore.Service;
    const results = yield* ResultStore.Service;
    const source = yield* ArtifactSource.Service;
    const ingest = yield* Ingest.Service;

    yield* router.add("GET", "/healthz", HttpServerResponse.text("ok"));

    yield* router.add("GET", "/a/:owner/:repo/:artifactId/*", (req) =>
      Effect.gen(function* () {
        const { owner = "", repo = "", artifactId = "" } = yield* HttpRouter.params;
        const url = new URL(req.url, "http://local");
        const rest =
          url.pathname.split("/").slice(5).map(decodeURIComponent).join("/") || "index.html";

        // Hand-off: a one-minute token from the dashboard origin becomes this origin's cookie.
        const handoff = url.searchParams.get("t");
        if (handoff !== null) {
          if (!auth.verifyHandoff(handoff))
            return deny(403, "artifact link expired; reopen it from the dashboard");
          url.searchParams.delete("t");
          return yield* HttpServerResponse.setCookie(ARTIFACT_COOKIE, auth.issueSession(), {
            httpOnly: true,
            sameSite: "lax",
            path: "/",
            maxAge: "7 days",
          })(HttpServerResponse.redirect(url.pathname + url.search, { status: 302 })).pipe(
            Effect.orDie,
          );
        }
        if (!auth.verifySession(req.cookies[ARTIFACT_COOKIE]))
          return deny(401, "sign in on the dashboard, then open the report from there");

        const art = yield* results.getArtifact(artifactId);
        if (Option.isNone(art) || art.value.owner !== owner || art.value.repo !== repo)
          return deny(404, "unknown artifact");

        if (rest.split("/").some((seg) => seg === ".." || seg === "" || seg === ".complete"))
          return deny(400, "bad path");
        const key = artifactPrefix(art.value) + rest;

        // On-view caching: fetch the artifact from the source the first time anyone opens it.
        let blob = yield* store.get(key);
        if (Option.isNone(blob) && art.value.state !== "cached") {
          const metas = yield* source
            .listArtifacts({ owner, repo, runId: art.value.runId })
            .pipe(Effect.orElseSucceed(() => []));
          const meta = metas.find((m) => m.artifactId === artifactId);
          if (!meta) return deny(404, "artifact no longer available at the source");
          yield* ingest.cacheArtifact(meta).pipe(Effect.orDie);
          blob = yield* store.get(key);
        }
        if (Option.isNone(blob)) return deny(404, "file not in artifact");

        return HttpServerResponse.uint8Array(blob.value.bytes, {
          contentType: blob.value.contentType,
        }).pipe(HttpServerResponse.setHeaders(SAFETY_HEADERS));
      }),
    );
  }),
);

const errorsToResponses = HttpRouter.middleware<{
  handles: ResultStore.DbError | ArtifactStore.StoreError;
}>()(
  (httpEffect) =>
    httpEffect.pipe(
      Effect.catchTags({
        "ResultStore.DbError": (e) => Effect.succeed(deny(500, `database error: ${e.operation}`)),
        "ArtifactStore.StoreError": (e) =>
          Effect.succeed(deny(500, `store error: ${e.operation} ${e.key}`)),
      }),
    ),
  { global: true },
);

export const ArtifactApp = ArtifactRoutes.pipe(Layer.provideMerge(errorsToResponses));
