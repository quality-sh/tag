// The fake GitHub the proposal tests share: one repository whose workflow runs Vitest and
// Playwright, with no runs, and write endpoints each test can make refuse or fail.
import { readFileSync } from "node:fs";
import { fakeGithub } from "./helpers.ts";

const WORKFLOW = readFileSync(
  new URL(
    "../../../fixtures-scan/acme/workflow-only/tree/.github/workflows/ci.yml",
    import.meta.url,
  ),
  "utf8",
);
const base64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
export const REPO = "/repos/acme/widgets";
export const BRANCH_REF = `${REPO}/git/refs/heads/tag/upload-test-reports`;
export const CONTENTS = `${REPO}/contents/.github/workflows/ci.yml`;

/** A GitHub holding one repository whose workflow runs Vitest and Playwright, with no runs. */
export const proposalGithub = (writes: {
  readonly put?: () => Response;
  readonly createRef?: () => Response;
  readonly openPull?: () => Response;
  readonly branchFile?: () => Response;
}) =>
  fakeGithub({
    [REPO]: () => ({ default_branch: "main" }),
    [`${REPO}/environments`]: () => ({ environments: [] }),
    [`${REPO}/actions/runs`]: () => ({ workflow_runs: [] }),
    [`${REPO}/actions/artifacts`]: () => ({ artifacts: [] }),
    [`${REPO}/releases`]: () => [],
    [`${REPO}/tags`]: () => [],
    [`${REPO}/deployments`]: () => [],
    [`${REPO}/git/trees/main`]: () => ({
      tree: [
        { path: ".github/workflows/ci.yml", type: "blob" },
        { path: "vitest.config.ts", type: "blob" },
      ],
    }),
    [CONTENTS]: (url, _headers, req) =>
      req.method === "PUT"
        ? (writes.put?.() ?? Response.json({ content: {} }, { status: 200 }))
        : url.searchParams.get("ref") === "main"
          ? { content: base64(WORKFLOW), encoding: "base64" }
          : (writes.branchFile?.() ?? { sha: "blob-sha", content: base64(WORKFLOW) }),
    [`${REPO}/git/ref/heads/main`]: () => ({ object: { sha: "c0ffee" } }),
    [`${REPO}/git/refs`]: () =>
      writes.createRef?.() ?? Response.json({ ref: "refs/heads/x" }, { status: 201 }),
    [BRANCH_REF]: () => Response.json({ ref: "refs/heads/x" }, { status: 200 }),
    [`${REPO}/pulls`]: (url, _headers, req) =>
      req.method === "POST"
        ? (writes.openPull?.() ??
          Response.json(
            {
              number: 12,
              html_url: "https://github.com/acme/widgets/pull/12",
              state: "open",
              merged_at: null,
            },
            { status: 201 },
          ))
        : url.searchParams.get("head") === "acme:tag/upload-test-reports"
          ? [{ number: 9, html_url: "https://github.com/acme/widgets/pull/9", state: "open" }]
          : [],
  });
