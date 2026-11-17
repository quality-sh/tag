// OIDC login against a fake provider on a local port: the round trip from the start route
// through the provider to a session cookie, and each way a sign-in is refused.
import { describe, expect, test } from "bun:test";
import { withOidcApp } from "./oidc-provider.ts";
import { serveApp } from "./helpers.ts";

/** The cookies a response sets, by name; an empty value is a cleared cookie. */
const cookiesOf = (res: Response) =>
  Object.fromEntries(
    res.headers.getSetCookie().map((c) => {
      const [pair = ""] = c.split(";");
      const eq = pair.indexOf("=");
      return [pair.slice(0, eq), pair.slice(eq + 1)];
    }),
  );

const go = (url: string, cookie = "") =>
  fetch(url, { redirect: "manual", headers: cookie ? { cookie } : {} });

/** Walk start → provider → callback the way a browser would; tamper with the callback URL. */
const signIn = async (base: string, tamper: (callback: URL) => URL = (u) => u) => {
  const start = await go(`${base}/api/auth/oidc/start`);
  expect(start.status).toBe(302);
  const flow = cookiesOf(start)["tag_oidc"] ?? "";
  expect(flow).not.toBe("");
  const authorize = await go(start.headers.get("location") ?? "");
  expect(authorize.status).toBe(302);
  const callbackUrl = tamper(new URL(authorize.headers.get("location") ?? ""));
  const callback = await go(callbackUrl.toString(), `tag_oidc=${flow}`);
  expect(callback.status).toBe(302);
  return {
    location: callback.headers.get("location"),
    cookies: cookiesOf(callback),
  };
};

const sessionOf = async (base: string, session: string | undefined) =>
  (await (
    await fetch(`${base}/api/session`, { headers: { cookie: `tag_session=${session ?? ""}` } })
  ).json()) as Record<string, unknown>;

describe("OIDC login", () => {
  test("a verified email in an allowed domain gets a session that carries it", async () => {
    await withOidcApp({}, async ({ base }) => {
      const signedOut = await sessionOf(base, undefined);
      expect(signedOut).toMatchObject({
        authenticated: false,
        authRequired: true,
        passwordLogin: false,
        oidcProvider: "Test IdP",
      });
      const { location, cookies } = await signIn(base);
      expect(location).toBe("/");
      expect(cookies["tag_oidc"]).toBe("");
      const session = cookies["tag_session"];
      expect(session).toBeTruthy();
      expect(await sessionOf(base, session)).toMatchObject({
        authenticated: true,
        email: "ada@example.com",
      });
      const repos = await fetch(`${base}/api/repos`, {
        headers: { cookie: `tag_session=${session}` },
      });
      expect(repos.status).toBe(200);
      // The password route stays shut when only OIDC is configured.
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "" }),
      });
      expect(login.status).toBe(401);
    });
  });

  test("an email outside the allowed domains is denied", async () => {
    await withOidcApp({}, async ({ base, provider }) => {
      provider.claims.email = "eve@elsewhere.org";
      const { location, cookies } = await signIn(base);
      expect(location).toBe("/?login_error=domain");
      expect(cookies["tag_session"]).toBeUndefined();
    });
  });

  test("no allowed domains lets any verified email in, but never an unverified one", async () => {
    await withOidcApp({ oidc: { allowedDomains: [] } }, async ({ base, provider }) => {
      provider.claims.email = "eve@elsewhere.org";
      expect((await signIn(base)).location).toBe("/");
      provider.claims.emailVerified = false;
      const unverified = await signIn(base);
      expect(unverified.location).toBe("/?login_error=unverified");
      expect(unverified.cookies["tag_session"]).toBeUndefined();
    });
  });

  const rejected: ReadonlyArray<[string, Parameters<typeof withOidcApp>[1]]> = [
    [
      "a token from another issuer",
      async ({ base, provider }) => {
        provider.claims.issuer = "https://impostor.example.com";
        expect((await signIn(base)).location).toBe("/?login_error=token");
      },
    ],
    [
      "a token for another client",
      async ({ base, provider }) => {
        provider.claims.audience = "someone-else";
        expect((await signIn(base)).location).toBe("/?login_error=token");
      },
    ],
    [
      "an expired token",
      async ({ base, provider }) => {
        provider.claims.expiresIn = -600;
        expect((await signIn(base)).location).toBe("/?login_error=token");
      },
    ],
    [
      "a token signed by a key outside the JWKS",
      async ({ base, provider }) => {
        provider.claims.foreignKey = true;
        expect((await signIn(base)).location).toBe("/?login_error=token");
      },
    ],
    [
      "a forged state",
      async ({ base }) => {
        const { location, cookies } = await signIn(base, (u) => {
          u.searchParams.set("state", "forged");
          return u;
        });
        expect(location).toBe("/?login_error=state");
        expect(cookies["tag_session"]).toBeUndefined();
      },
    ],
    [
      "a callback with no flow cookie",
      async ({ base }) => {
        const callback = await go(`${base}/api/auth/oidc/callback?code=x&state=y`);
        expect(callback.headers.get("location")).toBe("/?login_error=state");
      },
    ],
    [
      "a provider that refused",
      async ({ base }) => {
        const { location } = await signIn(base, (u) => {
          u.searchParams.delete("code");
          u.searchParams.set("error", "access_denied");
          return u;
        });
        expect(location).toBe("/?login_error=provider");
      },
    ],
  ];
  for (const [name, drive] of rejected)
    test(`refuses ${name}`, async () => {
      await withOidcApp({}, drive);
    });

  test("an unreachable provider sends the viewer back with an error", async () => {
    await withOidcApp({ oidc: { issuer: "http://127.0.0.1:9/nowhere" } }, async ({ base }) => {
      const start = await go(`${base}/api/auth/oidc/start`);
      expect(start.headers.get("location")).toBe("/?login_error=provider");
    });
  });

  test("with both configured, the password still signs in and the session has no email", async () => {
    await withOidcApp({ password: "test" }, async ({ base }) => {
      expect(await sessionOf(base, undefined)).toMatchObject({
        passwordLogin: true,
        oidcProvider: "Test IdP",
      });
      const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      expect(login.status).toBe(200);
      const session = cookiesOf(login)["tag_session"];
      const state = await sessionOf(base, session);
      expect(state["authenticated"]).toBe(true);
      expect(state["email"]).toBeUndefined();
    });
  });

  test("with OIDC off, the password path is unchanged and the OIDC routes answer 404", async () => {
    const app = await serveApp();
    try {
      expect(await sessionOf(app.base, undefined)).toEqual({
        authenticated: false,
        authRequired: true,
        passwordLogin: true,
      });
      expect((await go(`${app.base}/api/auth/oidc/start`)).status).toBe(404);
      const wrong = await fetch(`${app.base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "nope" }),
      });
      expect(wrong.status).toBe(401);
    } finally {
      await app.stop();
    }
  });
});
