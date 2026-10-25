// The install round trip against the real dashboard app: the link, GitHub's redirect back,
// the recorded installation, and the backfill pass it starts.
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Option, Redacted } from "effect";
import type { GithubConfig } from "../src/server/config.ts";
import { fakeGithub, eventually, serveApp } from "./helpers.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const appGithub = (slug: Option.Option<string>): GithubConfig => ({
  auth: {
    _tag: "app",
    appId: "12345",
    privateKey: Redacted.make(pem),
    installationId: Option.none(),
  },
  apiUrl: "https://api.github.test",
  slug,
  repos: [],
});

/** A GitHub whose installation lists one repository with no runs and no refs. */
const github = () =>
  fakeGithub({
    "/app/installations/555/access_tokens": () => ({
      token: "ghs_installation",
      expires_at: "2026-10-24T12:00:00Z",
    }),
    "/installation/repositories": () => ({
      repositories: [{ name: "widgets", owner: { login: "acme" } }],
    }),
    "/repos/acme/widgets/actions/runs": () => ({ workflow_runs: [] }),
    "/repos/acme/widgets/actions/artifacts": () => ({ artifacts: [] }),
    "/repos/acme/widgets/releases": () => [],
    "/repos/acme/widgets/tags": () => [],
    "/repos/acme/widgets/pulls": () => [],
    "/repos/acme/widgets/deployments": () => [],
  });

/** An expired but well-signed install state, as a stolen token from ten minutes ago would be. */
const staleState = (secret: string) => {
  const exp = Date.now() - 1000;
  const sig = new Bun.CryptoHasher("sha256", secret).update(`install.${exp}`).digest("hex");
  return `${exp}.${sig}`;
};

describe("the install flow", () => {
  test("GET /api/install redirects to GitHub with a state token; the session carries the link", async () => {
    const gh = github();
    const app = await serveApp({
      overrides: {
        github: Option.some(appGithub(Option.some("tag-app"))),
        password: Redacted.make(""),
      },
      http: gh.layer,
    });
    try {
      const session = await (await fetch(`${app.base}/api/session`)).json();
      expect(session.installUrl).toBe("/api/install");

      const res = await fetch(`${app.base}/api/install`, { redirect: "manual" });
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location.startsWith("https://github.com/apps/tag-app/installations/new?state=")).toBe(
        true,
      );
      expect(new URL(location).searchParams.get("state")).toContain(".");
    } finally {
      await app.stop();
    }
  });

  test("the callback records the installation and the source lists it in the same process", async () => {
    const gh = github();
    const app = await serveApp({
      overrides: {
        github: Option.some(appGithub(Option.some("tag-app"))),
        password: Redacted.make(""),
      },
      http: gh.layer,
    });
    try {
      const res = await fetch(`${app.base}/api/install`, { redirect: "manual" });
      const state = new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";

      const back = await fetch(
        `${app.base}/api/install/callback?installation_id=555&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      expect(back.status).toBe(302);
      expect(back.headers.get("location")).toBe("/");
      // Installed: the dashboard no longer offers the link.
      const after = await (await fetch(`${app.base}/api/session`)).json();
      expect(after.installUrl).toBeUndefined();

      // The forked pass mints an installation token and lists the installation's repos.
      const listed = await eventually(() =>
        gh.hits.some((h) => h.url.pathname === "/installation/repositories"),
      );
      expect(listed).toBe(true);
      const mint = gh.hits.findIndex((h) => h.method === "POST");
      expect(gh.hits[mint]?.url.pathname).toBe("/app/installations/555/access_tokens");
      expect(gh.hits[mint]?.auth?.split(".").length).toBe(3);
    } finally {
      await app.stop();
    }
  });

  test("a stale or forged state is 400 and records nothing", async () => {
    const gh = github();
    const app = await serveApp({
      overrides: {
        github: Option.some(appGithub(Option.some("tag-app"))),
        password: Redacted.make(""),
      },
      http: gh.layer,
    });
    try {
      for (const state of ["forged", staleState("test-secret")]) {
        const res = await fetch(
          `${app.base}/api/install/callback?installation_id=555&state=${encodeURIComponent(state)}`,
          { redirect: "manual" },
        );
        expect(res.status).toBe(400);
      }
      // Nothing recorded, so no pass started and GitHub saw no calls.
      await new Promise((r) => setTimeout(r, 50));
      expect(gh.hits).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  test("a good state with a missing installation_id records nothing", async () => {
    const gh = github();
    const app = await serveApp({
      overrides: {
        github: Option.some(appGithub(Option.some("tag-app"))),
        password: Redacted.make(""),
      },
      http: gh.layer,
    });
    try {
      const res = await fetch(`${app.base}/api/install`, { redirect: "manual" });
      const state = new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
      const back = await fetch(
        `${app.base}/api/install/callback?state=${encodeURIComponent(state)}`,
        {
          redirect: "manual",
        },
      );
      expect(back.status).toBe(400);
      await new Promise((r) => setTimeout(r, 50));
      expect(gh.hits).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  test("with auth enabled a cookie-less callback is 401", async () => {
    const gh = github();
    const app = await serveApp({
      overrides: { github: Option.some(appGithub(Option.some("tag-app"))) },
      http: gh.layer,
    });
    try {
      const res = await fetch(
        `${app.base}/api/install/callback?installation_id=555&state=whatever`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(401);
      expect(gh.hits).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  test("token mode needs no install and shows no link", async () => {
    const gh = github();
    const tokenMode: GithubConfig = {
      auth: { _tag: "token", token: Redacted.make("ghp_test") },
      apiUrl: "https://api.github.test",
      slug: Option.some("tag-app"),
      repos: [],
    };
    const app = await serveApp({
      overrides: { github: Option.some(tokenMode), password: Redacted.make("") },
      http: gh.layer,
    });
    try {
      const session = await (await fetch(`${app.base}/api/session`)).json();
      expect(session.installUrl).toBeUndefined();
      const res = await fetch(`${app.base}/api/install`, { redirect: "manual" });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "token mode needs no install" });
    } finally {
      await app.stop();
    }
  });
});
