// The fake GitHub behind the README's sizzle GIF: an acme org with three reporting
// repositories (one green, one failing, one with a flaky test, an open pull request and a
// release), one whose CI needs a change, and one with no tests.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { fakeGithub } from "../test/helpers.ts";
import { buildZip } from "../src/server/zip.ts";

type Routes = Parameters<typeof fakeGithub>[0];
type Status = "passed" | "failed" | "skipped";

const WORKFLOW = readFileSync(
  new URL(
    "../../../fixtures-scan/acme/workflow-only/tree/.github/workflows/ci.yml",
    import.meta.url,
  ),
  "utf8",
);
const DAY = 24 * 60 * 60 * 1000;
const base64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const sha = (n: number) => n.toString(16).padStart(8, "0").repeat(5);

/** One test as each run saw it: newest run first; a run past the end repeats the last. */
type Case = {
  readonly suite: string;
  readonly name: string;
  readonly duration: number;
  readonly history: ReadonlyArray<Status | "flaky">;
  readonly message?: string;
};

type RunSpec = {
  readonly id: number;
  readonly daysAgo: number;
  readonly branch: string;
  readonly event: string;
};

type Repo = {
  readonly name: string;
  readonly tool: string;
  readonly cases: ReadonlyArray<Case>;
  readonly runs: ReadonlyArray<RunSpec>;
  readonly pulls?: ReadonlyArray<{ number: number; title: string; branch: string; run: number }>;
  readonly releases?: ReadonlyArray<{ tag: string; title: string; run: number }>;
};

const DISCOUNT = [
  "Error: expect(locator).toHaveText(expected) failed",
  "",
  "Locator:  locator('#total')",
  'Expected: "$37.80"',
  'Received: "$42.00"',
  "Timeout:  5000ms",
].join("\n");

const mainRuns = (first: number, count: number): ReadonlyArray<RunSpec> =>
  Array.from({ length: count }, (_, i) => ({
    id: first + count - 1 - i,
    daysAgo: i * 1.4 + 0.2,
    branch: "main",
    event: "push",
  }));

const REPOS: ReadonlyArray<Repo> = [
  {
    name: "widgets",
    tool: "playwright",
    runs: [
      { id: 1120, daysAgo: 0.05, branch: "feat/stacked-coupons", event: "pull_request" },
      ...mainRuns(1110, 9),
    ],
    pulls: [
      { number: 42, title: "Stack two coupon codes", branch: "feat/stacked-coupons", run: 1120 },
    ],
    releases: [{ tag: "v1.4.0", title: "1.4.0: gift cards", run: 1114 }],
    cases: [
      { suite: "auth", name: "logs in with a valid password", duration: 1109, history: ["passed"] },
      {
        suite: "auth",
        name: "rejects a bad password",
        duration: 534,
        history: ["flaky", "passed", "flaky", "passed", "passed", "flaky", "passed"],
      },
      { suite: "cart", name: "adds an item to the cart", duration: 1160, history: ["passed"] },
      { suite: "cart", name: "shows the total", duration: 493, history: ["passed"] },
      {
        suite: "checkout",
        name: "applies a discount code",
        duration: 5400,
        history: ["failed", "failed", "failed", "passed"],
        message: DISCOUNT,
      },
      { suite: "checkout", name: "pays with a gift card", duration: 2210, history: ["passed"] },
      { suite: "checkout", name: "ships internationally", duration: 0, history: ["skipped"] },
    ],
  },
  {
    name: "gizmos",
    tool: "vitest",
    runs: mainRuns(2201, 8),
    cases: [
      ["parser", "reads a semver range", 12],
      ["parser", "rejects an empty range", 4],
      ["parser", "keeps build metadata", 6],
      ["cache", "evicts the oldest entry", 31],
      ["cache", "survives a restart", 88],
      ["cli", "prints help", 19],
      ["cli", "exits 2 on a bad flag", 15],
      ["cli", "reads the config file", 42],
    ].map(([suite, name, duration]) => ({
      suite: String(suite),
      name: String(name),
      duration: Number(duration),
      history: ["passed"],
    })),
  },
  {
    name: "sprockets",
    tool: "pytest",
    runs: mainRuns(3301, 7),
    cases: [
      { suite: "test_api", name: "test_list_orders", duration: 210, history: ["passed"] },
      { suite: "test_api", name: "test_create_order", duration: 340, history: ["passed"] },
      {
        suite: "test_api",
        name: "test_refund_partial",
        duration: 410,
        history: ["failed", "failed", "passed"],
        message: "AssertionError: assert 4200 == 3780\n  where 4200 = refund.amount_cents",
      },
      { suite: "test_tax", name: "test_vat_eu", duration: 120, history: ["passed"] },
      {
        suite: "test_tax",
        name: "test_vat_uk",
        duration: 118,
        history: ["failed", "passed"],
        message: "KeyError: 'GB'",
      },
      { suite: "test_tax", name: "test_sales_tax_us", duration: 133, history: ["passed"] },
      { suite: "test_db", name: "test_migrations_apply", duration: 1900, history: ["passed"] },
    ],
  },
];

const statusAt = (c: Case, index: number) => c.history[Math.min(index, c.history.length - 1)];

/** A CTRF report for the `index`th run of a repository, newest first. */
const report = (repo: Repo, index: number, start: number) => {
  let clock = start;
  const tests = repo.cases.map((c, n) => {
    const seen = statusAt(c, index) ?? "passed";
    const status = seen === "flaky" ? "passed" : seen;
    const test = {
      testId: `${repo.name}-${n}`,
      name: c.name,
      status,
      duration: c.duration,
      start: clock,
      stop: clock + c.duration,
      suite: [c.suite],
      filePath: `tests/${c.suite}.spec.ts`,
      retries: seen === "flaky" ? 1 : 0,
      flaky: seen === "flaky",
      ...(status === "failed" && c.message ? { message: c.message } : {}),
    };
    clock += c.duration;
    return test;
  });
  const count = (s: Status) => tests.filter((t) => t.status === s).length;
  return {
    reportFormat: "CTRF",
    specVersion: "0.2.0",
    reportId: randomUUID(),
    timestamp: new Date(clock).toISOString(),
    generatedBy: `${repo.tool}-ctrf-json-reporter`,
    results: {
      tool: { name: repo.tool },
      summary: {
        tests: tests.length,
        passed: count("passed"),
        failed: count("failed"),
        pending: 0,
        skipped: count("skipped"),
        other: 0,
        flaky: tests.filter((t) => t.flaky).length,
        start,
        stop: clock,
      },
      tests,
    },
  };
};

const reportingRepo = (repo: Repo, now: number): Routes => {
  const path = `/repos/acme/${repo.name}`;
  const onMain = repo.runs.filter((r) => r.branch === "main");
  const runs = repo.runs.map((spec) => {
    const startedAt = now - spec.daysAgo * DAY;
    const ctrf = report(repo, Math.max(0, onMain.indexOf(spec)), startedAt);
    const failed = ctrf.results.summary.failed > 0;
    const zip = buildZip([
      { path: "ctrf-report.json", bytes: new TextEncoder().encode(JSON.stringify(ctrf)) },
    ]);
    const run = {
      id: spec.id,
      run_number: spec.id % 1000,
      name: "ci",
      head_branch: spec.branch,
      head_sha: sha(spec.id),
      html_url: `https://github.com/acme/${repo.name}/actions/runs/${spec.id}`,
      status: "completed",
      conclusion: failed ? "failure" : "success",
      run_started_at: new Date(startedAt).toISOString(),
      created_at: new Date(startedAt - 60_000).toISOString(),
      event: spec.event,
    };
    const artifact = {
      id: spec.id + 50_000,
      name: `${repo.tool}-report`,
      size_in_bytes: zip.length,
      expired: false,
      workflow_run: { id: spec.id, head_branch: spec.branch, head_sha: run.head_sha },
    };
    return { run, zip, artifact };
  });
  const at = (id: number) => runs.find((r) => r.run.id === id)?.run;
  const routes: Routes = {
    [path]: () => ({ default_branch: "main" }),
    [`${path}/environments`]: () => ({ environments: [] }),
    [`${path}/git/trees/main`]: () => ({ tree: [], truncated: false }),
    [`${path}/actions/runs`]: () => ({ workflow_runs: runs.map((r) => r.run) }),
    [`${path}/actions/artifacts`]: () => ({ artifacts: runs.map((r) => r.artifact) }),
    [`${path}/tags`]: () =>
      (repo.releases ?? []).map((r) => ({ name: r.tag, commit: { sha: sha(r.run) } })),
    [`${path}/releases`]: () =>
      (repo.releases ?? []).map((r) => ({
        tag_name: r.tag,
        name: r.title,
        html_url: `https://github.com/acme/${repo.name}/releases/tag/${r.tag}`,
        draft: false,
        prerelease: false,
        target_commitish: "main",
        published_at: at(r.run)?.run_started_at,
        created_at: at(r.run)?.run_started_at,
      })),
    [`${path}/pulls`]: (url) =>
      url.searchParams.has("head")
        ? []
        : (repo.pulls ?? []).map((p) => ({
            number: p.number,
            title: p.title,
            html_url: `https://github.com/acme/${repo.name}/pull/${p.number}`,
            draft: false,
            created_at: at(p.run)?.created_at,
            closed_at: null,
            merged_at: null,
            head: { ref: p.branch, sha: sha(p.run) },
            base: { ref: "main" },
            user: { login: "ada" },
          })),
    [`${path}/deployments`]: () => [],
  };
  for (const { run, zip, artifact } of runs) {
    routes[`${path}/actions/runs/${run.id}`] = () => run;
    routes[`${path}/actions/runs/${run.id}/artifacts`] = () => ({ artifacts: [artifact] });
    routes[`${path}/actions/artifacts/${artifact.id}/zip`] = () =>
      new Response(new Uint8Array(zip));
  }
  return routes;
};

/** A repository with no runs, whose default branch holds `files`. */
const quietRepo = (name: string, files: Readonly<Record<string, string>>): Routes => {
  const path = `/repos/acme/${name}`;
  return {
    [path]: () => ({ default_branch: "main" }),
    [`${path}/environments`]: () => ({ environments: [] }),
    [`${path}/actions/runs`]: () => ({ workflow_runs: [] }),
    [`${path}/actions/artifacts`]: () => ({ artifacts: [] }),
    [`${path}/releases`]: () => [],
    [`${path}/tags`]: () => [],
    [`${path}/pulls`]: () => [],
    [`${path}/deployments`]: () => [],
    [`${path}/git/trees/main`]: () => ({
      tree: Object.keys(files).map((p) => ({ path: p, type: "blob" })),
      truncated: false,
    }),
    ...Object.fromEntries(
      Object.entries(files).map(([file, text]) => [
        `${path}/contents/${file}`,
        () => ({ content: base64(text), encoding: "base64" }),
      ]),
    ),
  };
};

/** Every route the fake GitHub answers, for an App installation with id 555. */
export const scenario = (now = Date.now()): Routes => {
  const reporting: Routes = {};
  for (const repo of REPOS) Object.assign(reporting, reportingRepo(repo, now));
  return {
    "/app/installations/555/access_tokens": () => ({
      token: "ghs_installation",
      expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
    }),
    "/installation/repositories": () => ({
      repositories: [...REPOS.map((r) => r.name), "gadgets", "quiet"].map((name) => ({
        name,
        owner: { login: "acme" },
      })),
    }),
    ...reporting,
    ...quietRepo("gadgets", { ".github/workflows/ci.yml": WORKFLOW, "vitest.config.ts": "" }),
    ...quietRepo("quiet", { "README.md": "# quiet\n" }),
  };
};
