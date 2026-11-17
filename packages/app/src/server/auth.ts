// Viewer auth: a shared password, an OIDC provider, or both, each ending in the same signed
// session cookie. The artifact origin gets its own cookie through a short-lived signed hand-off.
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { AppConfig } from "./config.ts";

export const SESSION_COOKIE = "tag_session";
export const ARTIFACT_COOKIE = "tag_artifacts";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HANDOFF_TTL_MS = 60 * 1000;
const INSTALL_TTL_MS = 10 * 60 * 1000;

export interface Interface {
  /** True when any sign-in is configured: the password, OIDC, or both. */
  readonly enabled: boolean;
  /** True when the shared password is set and so offered on the login page. */
  readonly passwordEnabled: boolean;
  readonly checkPassword: (password: string) => boolean;
  /** A session token: "<expiresAtMs>[:<email>].<hmac>"; OIDC sessions carry the email. */
  readonly issueSession: (email?: string) => string;
  readonly verifySession: (token: string | undefined) => boolean;
  /** The email a valid OIDC session carries; undefined for a password session or none. */
  readonly sessionEmail: (token: string | undefined) => string | undefined;
  /** One-minute token that the artifact origin exchanges for its own cookie. */
  readonly issueHandoff: () => string;
  readonly verifyHandoff: (token: string | undefined) => boolean;
  /** Ten-minute token carried through GitHub's install round trip and verified on the way back. */
  readonly issueInstallState: () => string;
  readonly verifyInstallState: (token: string | undefined) => boolean;
  /** Sign `data` as `kind` for `ttlMs`; `open` gives it back while the token is valid. */
  readonly seal: (kind: string, data: string, ttlMs: number) => string;
  readonly open: (kind: string, token: string | undefined) => string | undefined;
}

export class Service extends Context.Service<Service, Interface>()("@tag/Auth") {}

const hmac = (secret: string, message: string): string => {
  const h = new Bun.CryptoHasher("sha256", secret);
  h.update(message);
  return h.digest("hex");
};

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

const toBase64Url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const fromBase64Url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

const seal = (secret: string, kind: string, data: string, ttlMs: number): string => {
  const exp = Date.now() + ttlMs;
  // A token with no data keeps the old "<exp>.<hmac>" shape, so sessions survive an upgrade.
  const payload = data === "" ? `${exp}` : `${exp}:${toBase64Url(data)}`;
  return `${payload}.${hmac(secret, `${kind}.${payload}`)}`;
};

/** The sealed data of a valid token ("" when it carries none), or undefined. */
const open = (secret: string, kind: string, token: string | undefined): string | undefined => {
  if (!token) return undefined;
  const dot = token.lastIndexOf(".");
  if (dot === -1) return undefined;
  const payload = token.slice(0, dot);
  const colon = payload.indexOf(":");
  const exp = Number(colon === -1 ? payload : payload.slice(0, colon));
  if (!Number.isFinite(exp) || exp < Date.now()) return undefined;
  if (!constantTimeEqual(token.slice(dot + 1), hmac(secret, `${kind}.${payload}`)))
    return undefined;
  return colon === -1 ? "" : fromBase64Url(payload.slice(colon + 1));
};

export const make = (password: string, secret: string, oidcEnabled = false): Interface => {
  const passwordEnabled = password.length > 0;
  const enabled = passwordEnabled || oidcEnabled;
  // Session checks pass when no sign-in is configured; install and sealed tokens always guard.
  const verify = (kind: string, token: string | undefined): boolean =>
    !enabled || open(secret, kind, token) !== undefined;
  return {
    enabled,
    passwordEnabled,
    checkPassword: (p) => passwordEnabled && constantTimeEqual(p, password),
    issueSession: (email = "") => seal(secret, "session", email, SESSION_TTL_MS),
    verifySession: (t) => verify("session", t),
    sessionEmail: (t) => open(secret, "session", t) || undefined,
    issueHandoff: () => seal(secret, "handoff", "", HANDOFF_TTL_MS),
    verifyHandoff: (t) => verify("handoff", t),
    issueInstallState: () => seal(secret, "install", "", INSTALL_TTL_MS),
    verifyInstallState: (t) => open(secret, "install", t) !== undefined,
    seal: (kind, data, ttlMs) => seal(secret, kind, data, ttlMs),
    open: (kind, t) => open(secret, kind, t),
  };
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    const auth = make(
      Redacted.value(cfg.password),
      Redacted.value(cfg.sessionSecret),
      Option.isSome(cfg.oidc),
    );
    const modes = [
      ...(auth.passwordEnabled ? ["shared password"] : []),
      ...(Option.isSome(cfg.oidc) ? [`OIDC (${cfg.oidc.value.issuer})`] : []),
    ];
    yield* Effect.logInfo(
      auth.enabled
        ? `auth: ${modes.join(" and ")} enabled`
        : "auth: DISABLED (set TAG_PASSWORD or OIDC_ISSUER)",
    );
    return Service.of(auth);
  }),
);

export * as Auth from "./auth.ts";
