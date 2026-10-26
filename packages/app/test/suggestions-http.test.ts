// The suggestion API over the real app: detect from fixture refs, dismiss, accept, and the
// org's release rows once a group is saved.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GroupRow, OrgSuggestion } from "../src/grouping.ts";
import { FIXTURES, serveApp, tmpDir } from "./helpers.ts";

const PASSING = join(FIXTURES, "acme/widgets/run-1001/junit-results");
const FAILING = join(FIXTURES, "acme/widgets/run-1002/junit-results");

const release = (key: string, commit: string, timestamp: string) => ({
  kind: "release",
  key,
  commit,
  branch: "main",
  timestamp,
});

/** api and web release v1.3.2 and v1.4.0 together; cli tags on its own cadence. */
const FIXTURE_REPOS: Record<
  string,
  {
    refs: ReturnType<typeof release>[];
    runs: Array<{ id: string; commit: string; at: string; junit: string; env?: string }>;
  }
> = {
  api: {
    refs: [
      release("v1.3.2", "aaa1111", "2026-10-01T10:00:00Z"),
      release("v1.4.0", "aaa2222", "2026-10-10T10:00:00Z"),
    ],
    runs: [
      { id: "run-a1", commit: "aaa1111", at: "2026-10-01T09:00:00Z", junit: PASSING },
      { id: "run-a2", commit: "aaa2222", at: "2026-10-10T09:00:00Z", junit: PASSING },
    ],
  },
  web: {
    refs: [
      release("v1.3.2", "bbb1111", "2026-10-01T18:00:00Z"),
      release("v1.4.0", "bbb2222", "2026-10-11T09:00:00Z"),
    ],
    runs: [
      { id: "run-w1", commit: "bbb1111", at: "2026-10-01T17:00:00Z", junit: PASSING },
      {
        id: "run-w2",
        commit: "bbb2222",
        at: "2026-10-11T08:00:00Z",
        junit: FAILING,
        env: "production",
      },
    ],
  },
  cli: {
    refs: [
      release("v0.9.0", "ccc1111", "2026-10-04T10:00:00Z"),
      release("v1.4.0", "ccc2222", "2026-10-18T10:00:00Z"),
    ],
    runs: [{ id: "run-c1", commit: "ccc2222", at: "2026-10-18T09:00:00Z", junit: PASSING }],
  },
};

const writeFixtures = async () => {
  const dir = await tmpDir();
  for (const [repo, { refs, runs }] of Object.entries(FIXTURE_REPOS)) {
    const base = join(dir, "acme", repo);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "refs.json"), JSON.stringify(refs));
    for (const run of runs) {
      await cp(run.junit, join(base, run.id, "junit-results"), { recursive: true });
      await writeFile(
        join(base, run.id, "run.json"),
        JSON.stringify({
          runId: run.id,
          workflow: "tests",
          branch: "main",
          commit: run.commit,
          timestamp: run.at,
          ...(run.env ? { environment: run.env } : {}),
        }),
      );
    }
  }
  return dir;
};

describe("the suggestion API", () => {
  let app: Awaited<ReturnType<typeof serveApp>>;
  let cookie = "";
  const call = async (method: string, path: string) => {
    const res = await fetch(`${app.base}${path}`, { method, headers: { cookie } });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  const suggestions = async () =>
    (await call("GET", "/api/suggestions?org=acme")).body as OrgSuggestion[];

  beforeAll(async () => {
    app = await serveApp({ overrides: { fixturesDir: await writeFixtures() } });
    const login = await fetch(`${app.base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test" }),
    });
    cookie = login.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const started = await fetch(`${app.base}/api/ingest`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    const { passId } = (await started.json()) as { passId: string };
    for (let i = 0; i < 250; i++) {
      const status = (await call("GET", "/api/ingest/status")).body as {
        lastFinished: { passId: string } | null;
      };
      if (status.lastFinished?.passId === passId) break;
      await Bun.sleep(20);
    }
  });
  afterAll(() => app.stop());

  test("is closed signed out and needs an org", async () => {
    expect((await fetch(`${app.base}/api/suggestions?org=acme`)).status).toBe(401);
    expect((await call("GET", "/api/suggestions")).status).toBe(400);
    expect((await call("POST", "/api/suggestions/nope/accept")).status).toBe(404);
    expect((await call("POST", "/api/suggestions/nope/dismiss")).status).toBe(404);
  });

  test("suggests api and web as a release group, leaves cli out, and forgets a dismissal", async () => {
    const found = await suggestions();
    const groups = found.filter((s) => s.kind === "release-group");
    expect(groups.map((s) => s.save)).toEqual([
      { _tag: "release-group", org: "acme", repositories: ["api", "web"], rule: "same tag name" },
    ]);
    const semver = found.find((s) => s.kind === "semver");
    expect(semver?.save).toMatchObject({ query: "org:acme release:v0.9.0,v1.3.2,v1.4.0" });

    expect((await call("POST", `/api/suggestions/${semver?.id}/dismiss`)).status).toBe(200);
    expect((await suggestions()).some((s) => s.id === semver?.id)).toBe(false);
  });

  test("accepting a collection saves it through the collection path", async () => {
    const production = (await suggestions()).find((s) => s.kind === "production");
    const accepted = await call("POST", `/api/suggestions/${production?.id}/accept`);
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({
      saved: "collection",
      collection: { id: "acme-production", query: "org:acme environment:production" },
    });
    const list = (await call("GET", "/api/collections")).body as Array<{ id: string }>;
    expect(list.map((c) => c.id)).toContain("acme-production");
    expect((await suggestions()).some((s) => s.kind === "production")).toBe(false);
  });

  test("accepting the release group folds the org's release rows by version", async () => {
    const group = (await suggestions()).find((s) => s.kind === "release-group");
    const accepted = await call("POST", `/api/suggestions/${group?.id}/accept`);
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ saved: "release-group" });
    expect((await suggestions()).some((s) => s.kind === "release-group")).toBe(false);

    const page = (await call("GET", "/api/groups?by=release&q=org:acme&range=all")).body as {
      groups: GroupRow[];
    };
    const versions = page.groups.filter((g) => g.members);
    expect(versions.map((g) => [g.key, g.verdict])).toEqual([
      ["v1.4.0", "failed"],
      ["v1.3.2", "passed"],
    ]);
    expect(versions[0]?.members?.map((m) => [m.repo, m.verdict])).toEqual([
      ["api", "passed"],
      ["web", "failed"],
    ]);
    expect(page.groups.filter((g) => !g.members).map((g) => g.repo)).toEqual(["cli"]);
  });
});
