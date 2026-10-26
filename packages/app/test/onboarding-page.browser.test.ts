// The onboarding page in the built dashboard: the install step alone before the App is
// installed; then one reporting, one needs-change and one no-tests repository, each with
// its step, and the first report announced once it lands.
import { test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { Option, Redacted } from "effect";
import { chromium, expect as expectPage, type Page } from "playwright/test";
import type { GithubConfig } from "../src/server/config.ts";
import { repoRoutes, run } from "./github-fixtures.ts";
import { buildWeb, fakeGithub, serveApp, webRoot } from "./helpers.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const appConfig = (installationId: Option.Option<string>): GithubConfig => ({
  auth: {
    _tag: "app",
    appId: "12345",
    privateKey: Redacted.make(privateKey.export({ type: "pkcs1", format: "pem" }).toString()),
    installationId,
  },
  apiUrl: "https://api.github.test",
  slug: Option.some("tag-app"),
  repos: [],
});

const WORKFLOW = readFileSync(
  new URL(
    "../../../fixtures-scan/acme/workflow-only/tree/.github/workflows/ci.yml",
    import.meta.url,
  ),
  "utf8",
);

/** A repository with no runs, whose default branch holds `tree`. */
const quietRepo = (
  path: string,
  tree: ReadonlyArray<string>,
  files: Readonly<Record<string, string>> = {},
): Parameters<typeof fakeGithub>[0] => ({
  [path]: () => ({ default_branch: "main" }),
  [`${path}/environments`]: () => ({ environments: [] }),
  [`${path}/actions/runs`]: () => ({ workflow_runs: [] }),
  [`${path}/actions/artifacts`]: () => ({ artifacts: [] }),
  [`${path}/releases`]: () => [],
  [`${path}/tags`]: () => [],
  [`${path}/pulls`]: () => [],
  [`${path}/deployments`]: () => [],
  [`${path}/git/trees/main`]: () => ({
    tree: tree.map((p) => ({ path: p, type: "blob" })),
    truncated: false,
  }),
  ...Object.fromEntries(
    Object.entries(files).map(([file, text]) => [
      `${path}/contents/${file}`,
      () => ({ content: Buffer.from(text, "utf8").toString("base64"), encoding: "base64" }),
    ]),
  ),
});

const withApp = async (
  routes: Parameters<typeof fakeGithub>[0],
  installationId: Option.Option<string>,
  drive: (page: Page, base: string) => Promise<void>,
) => {
  await buildWeb();
  const browser = await chromium.launch();
  try {
    const app = await serveApp({
      webRoot,
      http: fakeGithub(routes).layer,
      overrides: { github: Option.some(appConfig(installationId)), password: Redacted.make("") },
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      await drive(page, app.base);
    } finally {
      await app.stop();
    }
  } finally {
    await browser.close();
  }
};

const noInputs = (page: Page) => expectPage(page.locator("input, textarea, select")).toHaveCount(0);

test("a user with no installation sees only the install step", async () => {
  await withApp({}, Option.none(), async (page, base) => {
    await page.goto(base);
    await expectPage(page).toHaveURL(/#\/onboarding$/);
    const install = page.getByRole("link", { name: "Install on GitHub", exact: true });
    await expectPage(install).toBeVisible();
    await expectPage(install).toHaveAttribute("href", "/api/install");
    await expectPage(page.getByText("What each repository needs.")).toHaveCount(0);
    await expectPage(page.getByText(/ARTIFACT_RETENTION_DAYS/)).toHaveCount(0);
    await noInputs(page);
  });
}, 30_000);

test("three repositories, mixed: each shows its step, then the first report", async () => {
  const now = Date.now();
  const runs = [1003, 1002, 1001].map((id, day) => {
    const timestamp = new Date(now - day * 24 * 60 * 60 * 1000).toISOString();
    return run(id, { created_at: timestamp, run_started_at: timestamp });
  });
  const widgets = await repoRoutes(runs);
  // Hold every download until the browser has seen the backfill's progress.
  const download = Promise.withResolvers<void>();
  for (const [path, route] of Object.entries(widgets)) {
    if (!path.endsWith("/zip")) continue;
    widgets[path] = (...args) => {
      const held = route(...args);
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await download.promise;
            if (held instanceof Response) controller.enqueue(await held.bytes());
            controller.close();
          },
        }),
      );
    };
  }
  const routes: Parameters<typeof fakeGithub>[0] = {
    "/app/installations/555/access_tokens": () => ({
      token: "ghs_installation",
      expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
    }),
    // The pass walks them in this order, so the other two are scanned while widgets waits.
    "/installation/repositories": () => ({
      repositories: ["gadgets", "quiet", "widgets"].map((name) => ({
        name,
        owner: { login: "acme" },
      })),
    }),
    ...quietRepo("/repos/acme/gadgets", [".github/workflows/ci.yml", "vitest.config.ts"], {
      ".github/workflows/ci.yml": WORKFLOW,
    }),
    ...quietRepo("/repos/acme/quiet", ["README.md"]),
    ...widgets,
  };
  await withApp(routes, Option.some("555"), async (page, base) => {
    try {
      await page.goto(base);
      await expectPage(page).toHaveURL(/#\/onboarding$/);
      await expectPage(page.getByText("Waiting for the first report.")).toBeVisible();
      await expectPage(page.getByText(/ARTIFACT_RETENTION_DAYS/)).toBeVisible();
      await page.request.post(`${base}/api/ingest`, { data: {} });

      await expectPage(
        page.getByRole("status").filter({ hasText: "acme/widgets: backfilling, 0 of 3" }),
      ).toBeVisible();
      const gadgets = page
        .locator("section")
        .filter({ has: page.getByRole("link", { name: "acme/gadgets →", exact: true }) });
      await expectPage(gadgets.getByText("needs a CI change", { exact: true })).toBeVisible();
      const propose = gadgets.getByRole("button", { name: "Propose pull request", exact: true });
      await expectPage(propose).toBeVisible();
      const quiet = page
        .locator("section")
        .filter({ has: page.getByRole("link", { name: "acme/quiet →", exact: true }) });
      await expectPage(quiet.getByText(/No tests were found/)).toBeVisible();
      await noInputs(page);

      download.resolve();
      await expectPage(
        page.getByRole("status").filter({ hasText: "acme/widgets: reporting" }),
      ).toBeVisible();
      await expectPage(
        page.getByText("The first report is in: 6 tests from playwright in acme/widgets."),
      ).toBeVisible();
      const open = page.getByRole("link", { name: "Open widgets", exact: true });
      await expectPage(open).toHaveAttribute("href", "#/r/acme/widgets");
      await expectPage(
        page.getByRole("link", { name: "Open the report", exact: true }),
      ).toHaveAttribute("href", /^#\/report\//);

      await propose.click();
      await expectPage(
        gadgets.getByText("+      - name: Save the Vitest report", { exact: false }),
      ).toBeVisible();
      await expectPage(
        gadgets.getByRole("button", { name: "Open the pull request", exact: true }),
      ).toBeVisible();
      await noInputs(page);

      await open.click();
      await expectPage(page).toHaveURL(/#\/r\/acme\/widgets$/);
    } finally {
      download.resolve();
    }
  });
}, 30_000);
