/**
 * The public pages and a real account, signed out to deleted: the landing,
 * privacy and terms at 390 and 1440 in light and dark (no horizontal scroll,
 * axe at zero), then sign-up with a passkey (Chromium's virtual
 * authenticator over CDP, `WebAuthn.addVirtualAuthenticator`), landing on
 * `next`, Settings → Account showing the passkey, Sign Out, signing back in,
 * and Delete Account.
 *
 * Runs with no stand-in session (playwright.config.ts gives every other spec
 * one): these visits are signed out until they sign in.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = process.env.SCORELINE_SCREENSHOTS ?? join("test-results", "screenshots");
mkdirSync(OUT, { recursive: true });

test.use({ storageState: { cookies: [], origins: [] } });

const WIDTHS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 900 },
] as const;
const SCHEMES = ["light", "dark"] as const;

async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
    .disableRules(["label-content-name-mismatch"])
    .analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const size of WIDTHS) {
  for (const scheme of SCHEMES) {
    test.describe(`${size.name} ${scheme}`, () => {
      test.use({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, reducedMotion: "reduce" });

      test("the landing, privacy and terms", async ({ page }) => {
        const errors: string[] = [];
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

        await page.goto("/");
        await expect(page.getByRole("heading", { level: 1, name: "Scoreline" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeEnabled();
        await expect(page.getByRole("button", { name: "New here? Create a passkey" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Download", exact: true })).toHaveAttribute("href", "https://github.com/SubwooferLullaby/scoreline/releases/latest/download/Scoreline.dmg");
        await noSideScroll(page);
        await axe(page);
        await page.screenshot({ path: join(OUT, `landing-${size.name}-${scheme}.png`), fullPage: true });

        for (const name of ["privacy", "terms"] as const) {
          await page.goto(`/${name}`);
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          await noSideScroll(page);
          await axe(page);
          await page.screenshot({ path: join(OUT, `${name}-${size.name}-${scheme}.png`), fullPage: true });
        }

        // Before the 404, which Chromium logs as a failed load.
        expect(errors).toEqual([]);

        const missing = await page.goto("/no-such-page");
        expect(missing?.status()).toBe(404);
        await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
        await axe(page);
      });
    });
  }
}

/** A platform authenticator that holds discoverable credentials and verifies the user without a prompt. */
async function virtualAuthenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

test("a passkey account from sign-up to deletion", async ({ context, page }) => {
  test.setTimeout(120_000);
  await virtualAuthenticator(context, page);

  // Signed out, an app route sends you to the landing, which remembers it.
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/\?next=%2Fsettings$/);
  const api = await page.request.get("/api/site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
  expect(api.status()).toBe(401);

  // Sign up: one passkey, and you land where you were going.
  await page.getByRole("button", { name: "New here? Create a passkey" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  const account = page.getByRole("group", { name: "Account", exact: true });
  await expect(account.getByText("Scoreline user")).toBeVisible();
  const passkeys = page.getByRole("group", { name: "Passkeys" });
  await expect(passkeys.getByText("1 passkey")).toBeVisible();
  // The only way back in can't be removed.
  await expect(passkeys.getByRole("button", { name: /^Remove / })).toBeDisabled();
  await passkeys.getByRole("button", { name: /^Rename / }).click();
  await passkeys.getByRole("textbox", { name: "Passkey name" }).fill("Test Key");
  await passkeys.getByRole("textbox", { name: "Passkey name" }).press("Enter");
  await expect(passkeys.getByText("Test Key")).toBeVisible();
  await page.screenshot({ path: join(OUT, "account-settings.png"), fullPage: false });

  // Sign Out: back to the landing, and the app is closed again.
  await account.getByRole("button", { name: "Sign Out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  await page.goto("/following");
  await expect(page).toHaveURL(/\/\?next=%2Ffollowing$/);

  // Sign in with the passkey: back to the page you asked for.
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL(/\/following$/);

  // Delete Account, behind a confirmation.
  await page.goto("/settings");
  await page.getByRole("button", { name: "Delete Account…" }).click();
  await expect(page.getByText("Delete your account?")).toBeVisible();
  await page.getByRole("button", { name: "Delete Account", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();

  // The passkey can't sign in again: Chromium drops it from the authenticator
  // when the page signals it unknown (WebAuthn's Signal API); a browser without
  // that signal is told by the server it belongs to no account.
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page.getByRole("status")).toContainText(/doesn't belong to a Scoreline account|No passkey was used/);
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/\?next=%2Fsettings$/);
});
