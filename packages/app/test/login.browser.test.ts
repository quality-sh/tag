// The login page in the built dashboard against a fake OIDC provider: the provider button
// beside the password, a denied domain spelled out, then a signed-in dashboard; and with
// OIDC alone, no password field at all.
import { expect, test } from "bun:test";
import { chromium, expect as expectPage, type Page } from "playwright/test";
import { buildWeb, webRoot } from "./helpers.ts";
import { withOidcApp, type FakeOidcProvider } from "./oidc-provider.ts";

const withLoginPage = async (
  password: string,
  drive: (page: Page, base: string, provider: FakeOidcProvider) => Promise<void>,
) => {
  await buildWeb();
  const browser = await chromium.launch();
  try {
    await withOidcApp({ password, webRoot }, async ({ base, provider }) => {
      const page = await browser.newPage();
      page.setDefaultTimeout(5000);
      await drive(page, base, provider);
    });
  } finally {
    await browser.close();
  }
};

test("both sign-ins: a denied domain is spelled out, an allowed one signs in", async () => {
  await withLoginPage("test", async (page, base, provider) => {
    provider.claims.email = "eve@elsewhere.org";
    await page.goto(base);
    const title = page.getByRole("heading", { name: "Sign in to TAG." });
    await expectPage(title).toBeVisible();
    await expectPage(page.getByLabel("Viewer password")).toBeVisible();
    const button = page.getByRole("button", { name: "Sign in with Test IdP" });
    await button.click();
    await expectPage(
      page.getByText("That account's email domain is not allowed to sign in here."),
    ).toBeVisible();
    await expectPage(page).toHaveURL(`${base}/`);

    provider.claims.email = "ada@example.com";
    await button.click();
    await expectPage(title).toHaveCount(0);
    const session = await (await page.request.get(`${base}/api/session`)).json();
    expect(session).toMatchObject({ authenticated: true, email: "ada@example.com" });
  });
}, 30_000);

test("OIDC alone: the password form is hidden and the button signs in", async () => {
  await withLoginPage("", async (page, base) => {
    await page.goto(base);
    await expectPage(page.getByText("Sign in with your Test IdP account.")).toBeVisible();
    await expectPage(page.locator("input")).toHaveCount(0);
    await page.getByRole("button", { name: "Sign in with Test IdP" }).click();
    await expectPage(page.getByRole("heading", { name: "Sign in to TAG." })).toHaveCount(0);
  });
}, 30_000);
