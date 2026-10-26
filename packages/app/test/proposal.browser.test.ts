// The proposal panel in the built dashboard: a needs-change repository's page offers the
// pull request, shows the diff, and then the pull request's link and state, or the reason
// and a copy button when the App may not write.
import { test } from "bun:test";
import { Option, Redacted } from "effect";
import { chromium, expect as expectPage, type Page } from "playwright/test";
import { cfg } from "./github-fixtures.ts";
import { proposalGithub } from "./github-proposal.ts";
import { buildWeb, serveApp, webRoot } from "./helpers.ts";

/** Run one pass so the repository is scanned, then open its page and the proposal panel. */
const openPanel = async (page: Page, base: string) => {
  const started = await page.request.post(`${base}/api/ingest`, { data: {} });
  const { passId } = (await started.json()) as { passId: string };
  await expectPage
    .poll(async () => {
      const status = (await (await page.request.get(`${base}/api/ingest/status`)).json()) as {
        lastFinished: { passId: string } | null;
      };
      return status.lastFinished?.passId;
    })
    .toBe(passId);
  await page.goto(`${base}/#/r/acme/widgets`);
  await page.getByRole("button", { name: "Propose pull request", exact: true }).click();
  await expectPage(
    page.getByText("+      - name: Save the Vitest report", { exact: false }),
  ).toBeVisible();
};

const withPage = async (
  writes: Parameters<typeof proposalGithub>[0],
  drive: (page: Page, base: string) => Promise<void>,
) => {
  await buildWeb();
  const gh = proposalGithub(writes);
  const browser = await chromium.launch();
  try {
    const app = await serveApp({
      webRoot,
      http: gh.layer,
      overrides: { github: Option.some(cfg()), password: Redacted.make("") },
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

test("a needs-change repository opens its pull request from the panel", async () => {
  await withPage({}, async (page, base) => {
    await openPanel(page, base);
    await expectPage(page.getByText(/uploaded as test-results-playwright/)).toBeVisible();
    await page.getByRole("button", { name: "Open the pull request", exact: true }).click();
    const link = page.getByRole("link", { name: "Pull request #12", exact: true });
    await expectPage(link).toBeVisible();
    await expectPage(link).toHaveAttribute("href", "https://github.com/acme/widgets/pull/12");
    await expectPage(page.getByText("open", { exact: true })).toBeVisible();
  });
}, 30_000);

test("without write permission the panel gives the reason and the diff to copy", async () => {
  await withPage(
    {
      put: () =>
        Response.json({ message: "Resource not accessible by integration" }, { status: 403 }),
    },
    async (page, base) => {
      await openPanel(page, base);
      await page.getByRole("button", { name: "Open the pull request", exact: true }).click();
      await expectPage(page.getByText(/Resource not accessible by integration/)).toBeVisible();
      await expectPage(
        page.getByRole("button", { name: "Copy the diff", exact: true }),
      ).toBeVisible();
      await expectPage(page.getByRole("link", { name: /Pull request #/ })).toHaveCount(0);
    },
  );
}, 30_000);
