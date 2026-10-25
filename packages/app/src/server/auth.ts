// Viewer auth for the MVP: one shared password, exchanged for a signed session cookie.
// The artifact origin gets its own cookie through a short-lived signed hand-off token.
import { Context, Effect, Layer, Redacted } from "effect";
import { AppConfig } from "./config.ts";

export const SESSION_COOKIE = "tag_session";
export const ARTIFACT_COOKIE = "tag_artifacts";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HANDOFF_TTL_MS = 60 * 1000;

export interface Interface {
  readonly enabled: boolean;
  readonly checkPassword: (password: string) => boolean;
  /** A session token: "<expiresAtMs>.<hmac>" */
  readonly issueSession: () => string;
  readonly verifySession: (token: string | undefined) => boolean;
  /** One-minute token that the artifact origin exchanges for its own cookie. */
  readonly issueHandoff: () => string;
  readonly verifyHandoff: (token: string | undefined) => boolean;
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

export const make = (password: string, secret: string): Interface => {
  const enabled = password.length > 0;
  const issue = (kind: string, ttl: number) => {
    const exp = Date.now() + ttl;
    return `${exp}.${hmac(secret, `${kind}.${exp}`)}`;
  };
  const verify = (kind: string, token: string | undefined): boolean => {
    if (!enabled) return true;
    if (!token) return false;
    const dot = token.indexOf(".");
    if (dot === -1) return false;
    const exp = Number(token.slice(0, dot));
    if (!Number.isFinite(exp) || exp < Date.now()) return false;
    return constantTimeEqual(token.slice(dot + 1), hmac(secret, `${kind}.${exp}`));
  };
  return {
    enabled,
    checkPassword: (p) => enabled && constantTimeEqual(p, password),
    issueSession: () => issue("session", SESSION_TTL_MS),
    verifySession: (t) => verify("session", t),
    issueHandoff: () => issue("handoff", HANDOFF_TTL_MS),
    verifyHandoff: (t) => verify("handoff", t),
  };
};

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* AppConfig.Service;
    const auth = make(Redacted.value(cfg.password), Redacted.value(cfg.sessionSecret));
    yield* Effect.logInfo(
      auth.enabled ? "auth: shared password enabled" : "auth: DISABLED (set TAG_PASSWORD)",
    );
    return Service.of(auth);
  }),
);

export * as Auth from "./auth.ts";
