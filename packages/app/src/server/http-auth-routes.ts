// Auth and session routes: the session probe, password and OIDC login, logout, and the
// GitHub App handshake.
import { Effect, Option, Result, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Scope } from "effect";
import { AppConfig } from "./config.ts";
import { Auth, SESSION_COOKIE } from "./auth.ts";
import { Installation } from "./installation.ts";
import { FLOW_COOKIE, FLOW_TTL_MS, Oidc } from "./oidc.ts";
import type { Ingest } from "./ingest.ts";
import { json, query } from "./http-helpers.ts";
import { WEBHOOK_PATH } from "./http-webhook-routes.ts";

export const OIDC_START_PATH = "/api/auth/oidc/start";
export const OIDC_CALLBACK_PATH = "/api/auth/oidc/callback";

// GitHub posts the webhook with no session; its signature stands in for one.
const PUBLIC_PATHS = new Set([
  "/api/health",
  "/api/login",
  "/api/session",
  OIDC_START_PATH,
  OIDC_CALLBACK_PATH,
  WEBHOOK_PATH,
]);

const SESSION_SECONDS = 7 * 24 * 3600;

const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: `${maxAgeSeconds} seconds` as const,
});

// The flow cookie only ever goes back to the callback.
const flowCookieOptions = (maxAgeSeconds: number) => ({
  ...cookieOptions(maxAgeSeconds),
  path: "/api/auth/oidc",
});

const LoginBody = Schema.Struct({ password: Schema.String });

/** Reject unauthenticated API calls. The static app is public; it shows the login screen itself. */
export const requireSession = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      const auth = yield* Auth.Service;
      const path = new URL(req.url, "http://local").pathname;
      if (!path.startsWith("/api/") || PUBLIC_PATHS.has(path)) return yield* httpEffect;
      if (auth.verifySession(req.cookies[SESSION_COOKIE])) return yield* httpEffect;
      return json({ error: "unauthorized" }, 401);
    }),
  { global: true },
);

export const addAuthRoutes = (deps: {
  readonly router: HttpRouter.HttpRouter;
  readonly auth: Auth.Interface;
  readonly installation: Installation.Interface;
  readonly ingest: Ingest.Interface;
  readonly cfg: AppConfig.Interface;
  readonly background: Scope.Scope;
}) =>
  Effect.gen(function* () {
    const { router, auth, installation, ingest, cfg, background } = deps;
    const oidc = yield* Oidc.Service;
    /** The App install link; App credentials plus the slug from GITHUB_APP_SLUG. */
    const installUrl = Option.flatMap(cfg.github, (g) =>
      g.auth._tag === "app"
        ? Option.map(g.slug, (slug) => `https://github.com/apps/${slug}/installations/new`)
        : Option.none<string>(),
    );

    // The dashboard shows "install on GitHub" only while no installation is recorded, and the
    // link goes through /api/install so the signed state travels with it.
    yield* router.add("GET", "/api/session", (req) =>
      Effect.gen(function* () {
        const installed = Option.isSome(yield* installation.current());
        const token = req.cookies[SESSION_COOKIE];
        const email = auth.sessionEmail(token);
        return json({
          authenticated: auth.verifySession(token),
          authRequired: auth.enabled,
          passwordLogin: auth.passwordEnabled,
          ...(Option.isSome(oidc.providerName) ? { oidcProvider: oidc.providerName.value } : {}),
          ...(email !== undefined ? { email } : {}),
          ...(Option.isSome(installUrl) && !installed ? { installUrl: "/api/install" } : {}),
        });
      }),
    );

    yield* router.add("POST", "/api/login", () =>
      Effect.gen(function* () {
        const body = yield* HttpServerRequest.schemaBodyJson(LoginBody).pipe(
          Effect.orElseSucceed(() => ({ password: "" })),
        );
        if (!auth.enabled) return json({ ok: true, authRequired: false });
        if (!auth.checkPassword(body.password)) return json({ error: "wrong password" }, 401);
        return yield* HttpServerResponse.setCookie(
          SESSION_COOKIE,
          auth.issueSession(),
          cookieOptions(SESSION_SECONDS),
        )(json({ ok: true })).pipe(Effect.orDie);
      }),
    );

    yield* router.add(
      "POST",
      "/api/logout",
      HttpServerResponse.setCookie(
        SESSION_COOKIE,
        "",
        cookieOptions(0),
      )(json({ ok: true })).pipe(Effect.orDie),
    );

    /** Send the viewer to the OIDC provider, with the flow's secrets in a sealed cookie. */
    yield* router.add("GET", OIDC_START_PATH, () =>
      Option.isNone(oidc.providerName)
        ? Effect.succeed(json({ error: "OIDC login is not configured" }, 404))
        : oidc.start().pipe(
            Effect.flatMap(({ url, flow }) =>
              HttpServerResponse.setCookie(
                FLOW_COOKIE,
                flow,
                flowCookieOptions(FLOW_TTL_MS / 1000),
              )(HttpServerResponse.redirect(url)).pipe(Effect.orDie),
            ),
            Effect.catchTag("Oidc.OidcError", (e) =>
              Effect.logWarning(`oidc start: ${e.detail}`).pipe(
                Effect.as(HttpServerResponse.redirect(`/?login_error=${e.reason}`)),
              ),
            ),
          ),
    );

    /** The provider sends the viewer back here; a verified, allowed email opens a session. */
    yield* router.add("GET", OIDC_CALLBACK_PATH, (req) =>
      Effect.gen(function* () {
        const q = query(req);
        const email = yield* oidc
          .finish({
            code: q.get("code"),
            state: q.get("state"),
            error: q.get("error"),
            flow: req.cookies[FLOW_COOKIE],
          })
          .pipe(
            Effect.tapError((e) => Effect.logWarning(`oidc callback: ${e.reason}: ${e.detail}`)),
            Effect.result,
          );
        const cookies: Array<readonly [string, string, ReturnType<typeof cookieOptions>]> = [
          [FLOW_COOKIE, "", flowCookieOptions(0)],
        ];
        if (Result.isSuccess(email))
          cookies.push([
            SESSION_COOKIE,
            auth.issueSession(email.success),
            cookieOptions(SESSION_SECONDS),
          ]);
        const location = Result.isSuccess(email) ? "/" : `/?login_error=${email.failure.reason}`;
        return yield* HttpServerResponse.setCookies(cookies)(
          HttpServerResponse.redirect(location),
        ).pipe(Effect.orDie);
      }),
    );

    /** Send the admin to GitHub to pick repositories, with a signed state to come back to. */
    yield* router.add("GET", "/api/install", () =>
      Effect.suspend(() =>
        Option.isNone(installUrl)
          ? Effect.succeed(json({ error: "token mode needs no install" }, 400))
          : Effect.succeed(
              HttpServerResponse.redirect(
                `${installUrl.value}?state=${encodeURIComponent(auth.issueInstallState())}`,
              ),
            ),
      ),
    );

    /** GitHub sends the admin back here; record the installation and start a pass. */
    yield* router.add("GET", "/api/install/callback", (req) =>
      Effect.gen(function* () {
        const q = query(req);
        if (!auth.verifyInstallState(q.get("state") ?? undefined))
          return json({ error: "stale or forged install state" }, 400);
        const id = q.get("installation_id") ?? "";
        if (!/^\d+$/.test(id)) return json({ error: "installation_id missing" }, 400);
        yield* installation.record(id);
        yield* ingest.ingestAll({ limit: 20 }).pipe(
          Effect.tap((s) =>
            Effect.logInfo(
              `install backfill: ${s.inserted} new reports, ${s.errors.length} errors`,
            ),
          ),
          Effect.forkIn(background),
        );
        return HttpServerResponse.redirect("/");
      }),
    );
  });
