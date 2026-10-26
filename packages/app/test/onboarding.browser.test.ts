import { expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Option, Redacted } from "effect";
import { chromium, expect as expectPage } from "playwright/test";
import { validateReport } from "@quality-sh/tag-schema";
import type { GithubConfig } from "../src/server/config.ts";
import { buildZip } from "../src/server/zip.ts";
import { run } from "./github-fixtures.ts";
import { buildWeb, fakeGithub, FIXTURES, serveApp, webRoot } from "./helpers.ts";

test("onboarding installs GitHub, backfills three runs and opens the first report", async () => {
  await buildWeb();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const github: GithubConfig = {
    auth: {
      _tag: "app",
      appId: "12345",
      privateKey: Redacted.make(privateKey.export({ type: "pkcs1", format: "pem" }).toString()),
      installationId: Option.none(),
    },
    apiUrl: "https://api.github.test",
    slug: Option.some("tag-app"),
    repos: [],
  };
  const fixture = validateReport(
    await Bun.file(
      join(FIXTURES, "acme/widgets/run-1001/playwright-report/ctrf-report.json"),
    ).json(),
  );
  if (!fixture.ok) throw new Error(fixture.errors.join("; "));
  const now = Date.now();
  const runs = [1003, 1002, 1001].map((id, day) => {
    const timestamp = new Date(now - day * 24 * 60 * 60 * 1000).toISOString();
    return run(id, { created_at: timestamp, run_started_at: timestamp });
  });
  const uploads = runs.map((run) => {
    const zip = buildZip([
      {
        path: "ctrf-report.json",
        // Each upload is a separate report, with the fixture's original test results.
        bytes: new TextEncoder().encode(
          JSON.stringify({ ...fixture.report, reportId: randomUUID() }),
        ),
      },
    ]);
    return {
      zip,
      artifact: {
        id: run.id,
        name: "playwright-report",
        size_in_bytes: zip.length,
        expired: false,
        workflow_run: { id: run.id, head_branch: run.head_branch, head_sha: run.head_sha },
      },
    };
  });
  // Keep the pass in backfill until the browser has observed its progress.
  const download = Promise.withResolvers<void>();
  const routes: Parameters<typeof fakeGithub>[0] = {
    "/app/installations/555/access_tokens": () => ({
      token: "ghs_installation",
      expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
    }),
    "/installation/repositories": () => ({
      repositories: [{ name: "widgets", owner: { login: "acme" } }],
    }),
    "/repos/acme/widgets": () => ({ default_branch: "main" }),
    "/repos/acme/widgets/environments": () => ({ environments: [] }),
    "/repos/acme/widgets/git/trees/main": () => ({ tree: [], truncated: false }),
    "/repos/acme/widgets/actions/runs": () => ({ workflow_runs: runs }),
    "/repos/acme/widgets/actions/artifacts": () => ({ artifacts: uploads.map((u) => u.artifact) }),
    "/repos/acme/widgets/releases": () => [],
    "/repos/acme/widgets/tags": () => [],
    "/repos/acme/widgets/pulls": () => [],
    "/repos/acme/widgets/deployments": () => [],
  };
  for (const { artifact, zip } of uploads) {
    routes[`/repos/acme/widgets/actions/runs/${artifact.id}/artifacts`] = () => ({
      artifacts: [artifact],
    });
    routes[`/repos/acme/widgets/actions/artifacts/${artifact.id}/zip`] = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await download.promise;
            controller.enqueue(zip);
            controller.close();
          },
        }),
      );
  }
  const gh = fakeGithub(routes);
  const browser = await chromium.launch();
  try {
    const app = await serveApp({
      webRoot,
      http: gh.layer,
      overrides: { github: Option.some(github), password: Redacted.make("") },
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(app.base);
      await expectPage(page).toHaveURL(/#\/onboarding$/);
      const install = page.getByRole("link", { name: "Install on GitHub", exact: true });
      await expectPage(install).toBeVisible();
      await expectPage(install).toHaveAttribute("href", "/api/install");

      const redirect = await page.request.get(`${app.base}/api/install`, { maxRedirects: 0 });
      expect(redirect.status()).toBe(302);
      const state = new URL(redirect.headers()["location"] ?? "").searchParams.get("state");
      expect(state).toBeString();
      await page.goto(
        `${app.base}/api/install/callback?installation_id=555&state=${encodeURIComponent(state ?? "")}`,
      );
      const progress = page
        .getByRole("status")
        .filter({ hasText: "acme/widgets: backfilling, 0 of 3" });
      await expectPage(progress).toBeVisible();
      download.resolve();
      await expectPage(
        page.getByText("The first report is in: 6 tests from playwright in acme/widgets."),
      ).toBeVisible();

      // The overview is one hash change away, so no reload sends the page back to onboarding.
      await page.getByRole("link", { name: "overview", exact: true }).click();
      await expectPage(
        page.getByRole("link", { name: "acme/widgets →", exact: true }),
      ).toBeVisible();
      await expectPage(page.getByRole("link", { name: "3 runs", exact: true })).toBeVisible();
      const rows = page
        .getByRole("row")
        .filter({ has: page.getByRole("link", { name: /^100[123]$/ }) });
      await expectPage(rows).toHaveCount(3);
      for (const run of runs) {
        const row = rows.filter({
          has: page.getByRole("link", { name: String(run.id), exact: true }),
        });
        await expectPage(row.getByRole("link", { name: "playwright", exact: true })).toBeVisible();
        await expectPage(row.getByRole("cell", { name: "4", exact: true })).toBeVisible();
        await expectPage(row.getByRole("cell", { name: "1", exact: true })).toBeVisible();
      }
      await expectPage(page.getByText(/backfilling/)).toHaveCount(0);
      await expectPage(install).toHaveCount(0);

      await page.getByRole("link", { name: "1003", exact: true }).click();
      await expectPage(page.getByRole("heading", { name: "1003", exact: true })).toBeVisible();
      await expectPage(page.getByText(/^4 of 6 tests passed on main/)).toBeVisible();
      await expectPage(
        page.getByRole("link", { name: "logs in with a valid password", exact: true }),
      ).toBeVisible();
    } finally {
      download.resolve();
      await app.stop();
    }
  } finally {
    await browser.close();
  }
}, 30_000);
