// A proposal's own CI run: a pull request run on a branch other than the default one, whose
// report artifact TAG lists, ingests and shows against that branch.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Option } from "effect";
import { buildZip } from "../src/server/zip.ts";
import { cfg, run } from "./github-fixtures.ts";
import { fakeGithub, serveApp, signInAndIngest } from "./helpers.ts";

const JUNIT = readFileSync(
  new URL(
    "../../../fixtures-scan/acme/scanrepo/run-1/test-results-ubuntu-latest/results.xml",
    import.meta.url,
  ),
);
const BRANCH = "tag/upload-test-reports";
const REPO = "/repos/acme/widgets";

describe("ingest of a pull request run", () => {
  test("lists completed runs of every event and shows the branch run's report", async () => {
    const zip = buildZip([{ path: "test-results/vitest.xml", bytes: new Uint8Array(JUNIT) }]);
    const gh = fakeGithub({
      [REPO]: () => ({ default_branch: "main" }),
      [`${REPO}/environments`]: () => ({ environments: [] }),
      [`${REPO}/actions/runs`]: () => ({
        workflow_runs: [run(2001, { head_branch: BRANCH, event: "pull_request" })],
      }),
      [`${REPO}/actions/artifacts`]: () => ({
        artifacts: [
          {
            id: 501,
            name: "test-results-vitest",
            size_in_bytes: zip.length,
            expired: false,
            expires_at: "2027-01-01T00:00:00Z",
            workflow_run: { id: 2001, head_branch: BRANCH, head_sha: "e4f5a6b".padEnd(40, "0") },
          },
        ],
      }),
      [`${REPO}/actions/artifacts/501/zip`]: () =>
        new Response(null, { status: 302, headers: { location: "https://blob.test/zip-501" } }),
      "/zip-501": () => new Response(new Uint8Array(zip), { status: 200 }),
      [`${REPO}/releases`]: () => [],
      [`${REPO}/tags`]: () => [],
      [`${REPO}/pulls`]: () => [],
      [`${REPO}/deployments`]: () => [],
      [`${REPO}/git/trees/main`]: () => ({ tree: [] }),
    });
    const app = await serveApp({ overrides: { github: Option.some(cfg()) }, http: gh.layer });
    try {
      const call = await signInAndIngest(app.base);
      const listing = gh.hits.find((h) => h.url.pathname === `${REPO}/actions/runs`);
      expect(listing?.url.searchParams.get("status")).toBe("completed");
      expect(listing?.url.searchParams.has("event")).toBe(false);
      expect(listing?.url.searchParams.has("branch")).toBe(false);

      const runs = (await (
        await call(`/api/runs?branch=${encodeURIComponent(BRANCH)}`)
      ).json()) as Array<{ branch: string; tool: string; tests: number; failed: number }>;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ branch: BRANCH, tests: 3, failed: 1 });

      const groups = (await (await call("/api/groups?by=branch&range=all")).json()) as {
        groups: Array<{ key: string }>;
      };
      expect(groups.groups.map((g) => g.key)).toContain(BRANCH);
    } finally {
      await app.stop();
    }
  });
});
