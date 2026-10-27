// Sign-in through any OpenID Connect provider: the authorization code flow with PKCE.
// The state, PKCE verifier and nonce travel in a sealed cookie; the ID token is checked
// against the provider's discovery document and JWKS before its email opens a session.
import { createHash, randomBytes } from "node:crypto";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { AppConfig, type OidcConfig } from "./config.ts";
import { Auth } from "./auth.ts";

/** The cookie that carries one sign-in attempt from the start route to the callback. */
export const FLOW_COOKIE = "tag_oidc";
export const FLOW_TTL_MS = 10 * 60 * 1000;
const CLOCK_TOLERANCE_SECONDS = 30;

/** Why a sign-in failed; the login page shows `domain` and `unverified` in words. */
export const OidcFailure = Schema.Literals(["state", "provider", "token", "unverified", "domain"]);
export type OidcFailure = typeof OidcFailure.Type;

export class OidcError extends Schema.TaggedError<OidcError>()("Oidc.OidcError", {
  reason: OidcFailure,
  detail: Schema.String,
}) {}

export interface Callback {
  readonly code: string | null;
  readonly state: string | null;
  /** Set when the provider itself refused, for example when the user cancelled. */
  readonly error: string | null;
  /** The FLOW_COOKIE value. */
  readonly flow: string | undefined;
}

export interface Interface {
  /** The sign-in button's provider name; none when OIDC is off. */
  readonly providerName: Option.Option<string>;
  /** The provider's authorize URL and the FLOW_COOKIE value to set beside it. */
  readonly start: () => Effect.Effect<{ readonly url: string; readonly flow: string }, OidcError>;
  /** Check the provider's answer and give back the verified, allowed email. */
  readonly finish: (callback: Callback) => Effect.Effect<string, OidcError>;
}

export class Service extends Context.Service<Service, Interface>()("@tag/Oidc") {}

const Discovery = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  jwks_uri: Schema.String,
  token_endpoint_auth_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
});
type Discovery = typeof Discovery.Type;

const TokenResponse = Schema.Struct({ id_token: Schema.String });

/** jose checks each key itself; this only makes sure there is a key list to hand it. */
const isJwks = (body: unknown): body is JSONWebKeySet =>
  typeof body === "object" &&
  body !== null &&
  "keys" in body &&
  Array.isArray(body.keys) &&
  body.keys.every((key) => typeof key === "object" && key !== null);

const fail = (reason: OidcFailure, detail: string) => new OidcError({ reason, detail });

const randomToken = () => randomBytes(32).toString("base64url");
const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, "");

/** The email of a verified account in an allowed domain, or why not. */
export const allowedEmail = (
  claims: JWTPayload,
  allowedDomains: ReadonlyArray<string>,
): Effect.Effect<string, OidcError> => {
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  if (email === "" || !email.includes("@"))
    return Effect.fail(fail("unverified", "the provider returned no email"));
  // Some providers send the flag as a string.
  if (claims.email_verified !== true && claims.email_verified !== "true")
    return Effect.fail(fail("unverified", `${email} is not verified by the provider`));
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  if (allowedDomains.length > 0 && !allowedDomains.includes(domain))
    return Effect.fail(fail("domain", `${domain} is not in OIDC_ALLOWED_DOMAINS`));
  return Effect.succeed(email);
};

export const make = (
  config: OidcConfig,
  auth: Auth.Interface,
  http: HttpClient.HttpClient,
): Interface => {
  const client = HttpClient.filterStatusOk(http);

  const getJson = (url: string, what: string) =>
    client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson)).pipe(
      Effect.flatMap((res) => res.json),
      Effect.mapError((cause) => fail("provider", `${what}: ${String(cause)}`)),
    );

  const discover = Effect.gen(function* () {
    const url = `${withoutTrailingSlash(config.issuer)}/.well-known/openid-configuration`;
    const body = yield* getJson(url, "discovery");
    const doc = yield* Schema.decodeUnknownEffect(Discovery)(body).pipe(
      Effect.mapError(() => fail("provider", `discovery at ${url} is not an OIDC document`)),
    );
    if (withoutTrailingSlash(doc.issuer) !== withoutTrailingSlash(config.issuer))
      return yield* fail("provider", `discovery names issuer ${doc.issuer}, not ${config.issuer}`);
    return doc;
  });

  const exchange = (doc: Discovery, code: string, verifier: string) =>
    Effect.gen(function* () {
      const secret = Redacted.value(config.clientSecret);
      // client_secret_basic is the spec's default; prefer the form post where offered.
      const post = doc.token_endpoint_auth_methods_supported?.includes("client_secret_post");
      const request = HttpClientRequest.post(doc.token_endpoint).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyUrlParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: config.redirectUri,
          code_verifier: verifier,
          client_id: config.clientId,
          ...(post ? { client_secret: secret } : {}),
        }),
        post ? (r) => r : HttpClientRequest.basicAuth(config.clientId, secret),
      );
      const body = yield* client.execute(request).pipe(
        Effect.flatMap((res) => res.json),
        Effect.mapError((cause) => fail("provider", `token exchange: ${String(cause)}`)),
      );
      const tokens = yield* Schema.decodeUnknownEffect(TokenResponse)(body).pipe(
        Effect.mapError(() => fail("provider", "the token response holds no id_token")),
      );
      return tokens.id_token;
    });

  const verify = (doc: Discovery, idToken: string, nonce: string) =>
    Effect.gen(function* () {
      const jwks = yield* getJson(doc.jwks_uri, "jwks");
      if (!isJwks(jwks)) return yield* fail("provider", "the JWKS holds no keys");
      const { payload } = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(idToken, createLocalJWKSet(jwks), {
            issuer: doc.issuer,
            audience: config.clientId,
            clockTolerance: CLOCK_TOLERANCE_SECONDS,
          }),
        catch: (cause) => fail("token", `the ID token was rejected: ${String(cause)}`),
      });
      if (payload.nonce !== nonce) return yield* fail("token", "the ID token nonce does not match");
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)
        return yield* fail("token", "the ID token was issued to another party");
      return payload;
    });

  return {
    providerName: Option.some(config.providerName),
    start: () =>
      Effect.gen(function* () {
        const doc = yield* discover;
        const state = randomToken();
        const verifier = randomToken();
        const nonce = randomToken();
        const url = new URL(doc.authorization_endpoint);
        for (const [key, value] of Object.entries({
          response_type: "code",
          client_id: config.clientId,
          redirect_uri: config.redirectUri,
          scope: "openid email profile",
          state,
          nonce,
          code_challenge: challengeOf(verifier),
          code_challenge_method: "S256",
        }))
          url.searchParams.set(key, value);
        const flow = auth.seal("oidc", [state, verifier, nonce].join("."), FLOW_TTL_MS);
        return { url: url.toString(), flow };
      }),
    finish: (callback) =>
      Effect.gen(function* () {
        const [state = "", verifier = "", nonce = ""] = (
          auth.open("oidc", callback.flow) ?? ""
        ).split(".");
        if (state === "" || callback.state === null || callback.state !== state)
          return yield* fail("state", "the sign-in state is missing, stale or forged");
        if (callback.error !== null)
          return yield* fail("provider", `the provider refused: ${callback.error}`);
        if (callback.code === null) return yield* fail("provider", "the callback has no code");
        const doc = yield* discover;
        const idToken = yield* exchange(doc, callback.code, verifier);
        const claims = yield* verify(doc, idToken, nonce);
        return yield* allowedEmail(claims, config.allowedDomains);
      }),
  };
};

const disabled: Interface = {
  providerName: Option.none(),
  start: () => Effect.fail(fail("provider", "OIDC is not configured")),
  finish: () => Effect.fail(fail("provider", "OIDC is not configured")),
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    const auth = yield* Auth.Service;
    const http = yield* HttpClient.HttpClient;
    return Service.of(Option.isSome(cfg.oidc) ? make(cfg.oidc.value, auth, http) : disabled);
  }),
);

export * as Oidc from "./oidc.ts";
