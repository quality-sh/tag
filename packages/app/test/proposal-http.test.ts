// The proposal routes on the real dashboard app over a fake GitHub: the generated change for a
// needs-change repository, the pull request it opens, and the diff it answers with instead
// when the App may not write.
import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { ArtifactSource } from "../src/server/artifact-source.ts";
import { cfg } from "./github-fixtures.ts";
import { FIXTURES, serveApp, signInAndIngest, type Hit } from "./helpers.ts";
import { BRANCH_REF, CONTENTS, REPO, proposalGithub } from "./github-proposal.ts";

const writesOf = (hits: ReadonlyArray<Hit>) =>
  hits.filter((h) => h.method !== "GET").map((h) => `${h.method} ${h.url.pathname}`);

interface ProposalBody {
  outcome?: string;
  reason?: string;
  description: string;
  files: Array<{ path: string; diff: string; created: boolean }>;
  pullRequest: { number: number; url: string; state: string; branch: string } | null;
}

describe("the proposal routes", () => {
  test("show the change, open the pull request once, and report it after", async () => {
    const gh = proposalGithub({});
    const app = await serveApp({ overrides: { github: Option.some(cfg()) }, http: gh.layer });
    try {
      const path = "/api/repositories/acme/widgets/proposal";
      expect((await fetch(`${app.base}${path}`)).status).toBe(401);
      const call = await signInAndIngest(app.base);

      const shown = await call(path);
      expect(shown.status).toBe(200);
      const proposal = (await shown.json()) as ProposalBody;
      expect(proposal.pullRequest).toBeNull();
      expect(proposal.files.map((f) => [f.path, f.created])).toEqual([
        [".github/workflows/ci.yml", false],
      ]);
      expect(proposal.files[0]?.diff).toContain("+      - name: Save the Vitest report\n");
      expect(proposal.description).toContain("uploaded as test-results-playwright");
      expect((await call("/api/repositories/acme/other/proposal")).status).toBe(404);

      const opened = await call(`${path}/pull-request`, "POST");
      expect(opened.status).toBe(201);
      const body = (await opened.json()) as ProposalBody;
      expect(body.outcome).toBe("opened");
      expect(body.pullRequest).toMatchObject({
        number: 12,
        url: "https://github.com/acme/widgets/pull/12",
        state: "open",
        branch: "tag/upload-test-reports",
      });
      expect(writesOf(gh.hits)).toEqual([
        `POST ${REPO}/git/refs`,
        `PUT ${CONTENTS}`,
        `POST ${REPO}/pulls`,
      ]);
      const sent = (method: string, path: string) =>
        gh.hits.find((h) => h.method === method && h.url.pathname === path)?.body;
      expect(sent("POST", `${REPO}/git/refs`)).toEqual({
        ref: "refs/heads/tag/upload-test-reports",
        sha: "c0ffee",
      });
      const put = sent("PUT", CONTENTS) as { content: string; branch: string; sha: string };
      expect([put.branch, put.sha]).toEqual(["tag/upload-test-reports", "blob-sha"]);
      expect(Buffer.from(put.content, "base64").toString("utf8")).toContain(
        "      - run: npx playwright test --reporter=html,junit\n",
      );
      expect(sent("POST", `${REPO}/pulls`)).toMatchObject({
        title: "Upload test reports for TAG",
        head: "tag/upload-test-reports",
        base: "main",
        body: proposal.description,
      });

      const after = (await (await call(path)).json()) as ProposalBody;
      expect(after.pullRequest?.number).toBe(12);
      const again = await call(`${path}/pull-request`, "POST");
      expect(again.status).toBe(200);
      expect(writesOf(gh.hits)).toHaveLength(3);
    } finally {
      await app.stop();
    }
  });

  test("without write permission, answers with the diff and the reason and leaves nothing", async () => {
    const gh = proposalGithub({
      put: () =>
        Response.json(
          { message: "Resource not accessible by integration" },
          { status: 403, headers: { "x-ratelimit-remaining": "4999" } },
        ),
    });
    const app = await serveApp({ overrides: { github: Option.some(cfg()) }, http: gh.layer });
    try {
      const call = await signInAndIngest(app.base);
      const path = "/api/repositories/acme/widgets/proposal";
      const res = await call(`${path}/pull-request`, "POST");
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProposalBody;
      expect(body.outcome).toBe("denied");
      expect(body.reason).toContain("Resource not accessible by integration");
      expect(body.reason).toContain("workflows");
      expect(body.files[0]?.diff).toContain("+          name: test-results-vitest\n");
      expect(body.pullRequest).toBeNull();
      // The branch it made is deleted again and no pull request is opened.
      expect(writesOf(gh.hits)).toEqual([
        `POST ${REPO}/git/refs`,
        `PUT ${CONTENTS}`,
        `DELETE ${BRANCH_REF}`,
      ]);
      expect(((await (await call(path)).json()) as ProposalBody).pullRequest).toBeNull();
    } finally {
      await app.stop();
    }
  });

  test("moves a branch left from before and finds the pull request already open", async () => {
    const gh = proposalGithub({
      createRef: () => Response.json({ message: "Reference already exists" }, { status: 422 }),
      branchFile: () => Response.json({ message: "Not Found" }, { status: 404 }),
      openPull: () =>
        Response.json(
          { message: "A pull request already exists for acme:tag/upload-test-reports." },
          { status: 422 },
        ),
    });
    const app = await serveApp({ overrides: { github: Option.some(cfg()) }, http: gh.layer });
    try {
      const call = await signInAndIngest(app.base);
      const res = await call("/api/repositories/acme/widgets/proposal/pull-request", "POST");
      expect(res.status).toBe(201);
      expect(((await res.json()) as ProposalBody).pullRequest?.number).toBe(9);
      expect(writesOf(gh.hits)).toEqual([
        `POST ${REPO}/git/refs`,
        `PATCH ${BRANCH_REF}`,
        `PUT ${CONTENTS}`,
        `POST ${REPO}/pulls`,
      ]);
      expect(gh.hits.find((h) => h.method === "PATCH")?.body).toEqual({
        sha: "c0ffee",
        force: true,
      });
      // A new file on the branch is written without a blob sha.
      expect(gh.hits.find((h) => h.method === "PUT")?.body).not.toHaveProperty("sha");
    } finally {
      await app.stop();
    }
  });

  test("another GitHub failure answers 502 with the diff, and the fixtures source refuses", async () => {
    const gh = proposalGithub({
      put: () => Response.json({ message: "conflict" }, { status: 409 }),
    });
    const app = await serveApp({ overrides: { github: Option.some(cfg()) }, http: gh.layer });
    try {
      const call = await signInAndIngest(app.base);
      const res = await call("/api/repositories/acme/widgets/proposal/pull-request", "POST");
      expect(res.status).toBe(502);
      const body = (await res.json()) as ProposalBody;
      expect(body.outcome).toBe("failed");
      expect(body.files).toHaveLength(1);
    } finally {
      await app.stop();
    }
    const refused = await Effect.runPromise(
      Effect.flip(
        ArtifactSource.makeFixtures(FIXTURES).openPullRequest(
          { owner: "acme", repo: "widgets" },
          { branch: "b", title: "t", body: "", files: [] },
        ),
      ),
    );
    expect(refused._tag).toBe("ArtifactSource.WriteDenied");
  });
});
