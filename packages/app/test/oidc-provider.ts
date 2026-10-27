// A fake OpenID Connect provider on a real local port: discovery, an authorize endpoint that
// signs the user straight in, a token endpoint that checks PKCE, and a JWKS whose key is
// generated per provider. `claims` changes what the next ID token says.
import { createHash, randomUUID } from "node:crypto";
import { Option, Redacted } from "effect";
import { SignJWT, exportJWK, generateKeyPair, type JWTPayload } from "jose";
import type { OidcConfig } from "../src/server/config.ts";
import { freePort, serveApp } from "./helpers.ts";

export const CLIENT_ID = "tag-test-client";
const CLIENT_SECRET = "tag-test-secret";
const KEY_ID = "test-key";

export interface IdTokenShape {
  /** Defaults to the provider's own issuer. */
  issuer?: string;
  /** Defaults to CLIENT_ID. */
  audience?: string;
  /** Seconds from now until the token expires; negative for an expired one. */
  expiresIn?: number;
  email?: string;
  emailVerified?: boolean;
  /** Sign with a key the JWKS does not hold. */
  foreignKey?: boolean;
}

export const fakeOidcProvider = async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const foreign = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string }>();
  const claims: IdTokenShape = {};

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const issuer = url.origin;
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        if (q.get("client_id") !== CLIENT_ID || q.get("code_challenge_method") !== "S256")
          return new Response("bad authorize request", { status: 400 });
        const code = randomUUID();
        const redirectUri = q.get("redirect_uri") ?? "";
        codes.set(code, {
          nonce: q.get("nonce") ?? "",
          challenge: q.get("code_challenge") ?? "",
          redirectUri,
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        return Response.redirect(back.toString(), 302);
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        const basic = req.headers.get("authorization");
        const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
        if (basic !== expected) return Response.json({ error: "invalid_client" }, { status: 401 });
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (
          !grant ||
          form.get("redirect_uri") !== grant.redirectUri ||
          createHash("sha256").update(verifier).digest("base64url") !== grant.challenge
        )
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        const payload: JWTPayload = {
          nonce: grant.nonce,
          email: claims.email ?? "ada@example.com",
          email_verified: claims.emailVerified ?? true,
        };
        const idToken = await new SignJWT(payload)
          .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
          .setIssuer(claims.issuer ?? issuer)
          .setAudience(claims.audience ?? CLIENT_ID)
          .setSubject("user-1")
          .setIssuedAt()
          .setExpirationTime(Math.floor(Date.now() / 1000) + (claims.expiresIn ?? 300))
          .sign(claims.foreignKey ? foreign.privateKey : privateKey);
        return Response.json({ access_token: "at", token_type: "Bearer", id_token: idToken });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    issuer: `http://127.0.0.1:${server.port}`,
    /** Mutate to shape the next ID token. */
    claims,
    stop: () => server.stop(true),
  };
};

export type FakeOidcProvider = Awaited<ReturnType<typeof fakeOidcProvider>>;

/** The OIDC config that points the app at `provider`, with the app on `port`. */
export const oidcConfig = (
  provider: FakeOidcProvider,
  port: number,
  overrides: Partial<OidcConfig> = {},
): OidcConfig => ({
  issuer: provider.issuer,
  clientId: CLIENT_ID,
  clientSecret: Redacted.make(CLIENT_SECRET),
  allowedDomains: ["example.com"],
  providerName: "Test IdP",
  redirectUri: `http://127.0.0.1:${port}/api/auth/oidc/callback`,
  ...overrides,
});

/** The dashboard with OIDC pointed at a fresh fake provider; the password stays as given. */
export const withOidcApp = async (
  opts: {
    readonly password?: string;
    readonly oidc?: Partial<OidcConfig>;
    readonly webRoot?: string;
  },
  drive: (app: { base: string; provider: FakeOidcProvider }) => Promise<void>,
) => {
  const provider = await fakeOidcProvider();
  const port = freePort();
  const app = await serveApp({
    port,
    ...(opts.webRoot !== undefined ? { webRoot: opts.webRoot } : {}),
    overrides: {
      oidc: Option.some(oidcConfig(provider, port, opts.oidc)),
      password: Redacted.make(opts.password ?? ""),
    },
  });
  try {
    await drive({ base: app.base, provider });
  } finally {
    await app.stop();
    await provider.stop();
  }
};
