// Auth for /mcp, which sits outside /api and so outside requireSession. A dashboard session
// cookie works, and so does `Authorization: Bearer <TAG_PASSWORD>` for agents and scripts
// that cannot log in. The bearer is the shared password until OIDC brings per-user tokens.
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Auth, SESSION_COOKIE } from "./auth.ts";
import { MCP_PATH } from "./mcp.ts";

const bearerOf = (header: string | undefined) => {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1]?.trim();
};

/** Whether a request may use the MCP endpoint: auth off, a session, or the password. */
export const mayUseMcp = (
  auth: Auth.Interface,
  req: Pick<HttpServerRequest.HttpServerRequest, "cookies" | "headers">,
) => {
  if (!auth.enabled || auth.verifySession(req.cookies[SESSION_COOKIE])) return true;
  const bearer = bearerOf(req.headers.authorization);
  return bearer !== undefined && auth.checkPassword(bearer);
};

export const requireMcpAuth = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest;
      if (new URL(req.url, "http://local").pathname !== MCP_PATH) return yield* httpEffect;
      if (mayUseMcp(yield* Auth.Service, req)) return yield* httpEffect;
      return HttpServerResponse.jsonUnsafe(
        { error: "unauthorized" },
        { status: 401, headers: { "www-authenticate": 'Bearer realm="tag"' } },
      );
    }),
  { global: true },
);
