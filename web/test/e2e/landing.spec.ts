/**
 * The public pages and a real account, signed out to deleted: the landing,
 * privacy, terms and 404 at 390 and 1440 in light and dark (no horizontal
 * scroll, axe at zero), then the gate (an app route sends you to
 * `/?next=`, `/api` answers 401), sign-up with a passkey (Chromium's virtual
 * authenticator over CDP, `WebAuthn.addVirtualAuthenticator`) landing on
 * `next`, Settings → Account, a game page, Sign Out, signing back in,
 * settings sync across two browser contexts, and Delete Account, with no
 * CSP violation anywhere. Run it against the production preview too
 * (ARCHITECTURE.md, Testing), where the CSP is on.
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
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const credentials = async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
  return {
    credentials,
    add: async (credential: Awaited<ReturnType<typeof credentials>>[number]) => {
      await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
    },
  };
}

/** Content-Security-Policy violations on a page (Chromium reports each as a console error). */
function watchCSP(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (m) => /Content Security Policy|Refused to/i.test(m.text()) && violations.push(`${page.url()}: ${m.text()}`));
  return violations;
}

/** The settings this device holds (the store's own key, src/state/settings.ts). */
const storedTheme = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem("scoreline.settings.v1") ?? "{}") as { theme?: string }).theme ?? null);

test("a passkey account from sign-up to deletion", async ({ browser, context, page }) => {
  test.setTimeout(180_000);
  const authenticator = await virtualAuthenticator(context, page);
  const csp = watchCSP(page);

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

  // Signed in, /api answers, and a game page loads under the CSP.
  expect((await page.request.get("/api/site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard")).status()).toBe(200);
  await page.goto("/");
  await page.waitForFunction(() => document.querySelectorAll("[data-nav-id]").length > 0 || document.querySelector('[role="alert"]') != null, null, { timeout: 30_000 });
  const game = page.locator('a[href^="/game/"]').first();
  if (await game.count()) await game.click();
  else await page.goto("/game/espn-401908044");
  await expect(page).toHaveURL(/\/game\//);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1_500);

  // Sign Out: back to the landing, and the app is closed again.
  await page.goto("/settings");
  await account.getByRole("button", { name: "Sign Out" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  await page.goto("/following");
  await expect(page).toHaveURL(/\/\?next=%2Ffollowing$/);

  // Sign in with the passkey: back to the page you asked for.
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL(/\/following$/);

  // Settings follow the account: a change here reaches a second browser, and its change comes back.
  // (After the last sign-in here: the cloned passkey's signature counter moves on in the other browser.)
  await page.goto("/settings");
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect.poll(() => storedTheme(page)).toBe("dark");
  await page.waitForTimeout(3_000); // the 2 s debounce, then the PUT
  const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const second = await other.newPage();
  const secondAuthenticator = await virtualAuthenticator(other, second);
  for (const credential of await authenticator.credentials()) await secondAuthenticator.add(credential);
  await second.goto("/settings");
  await second.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(second).toHaveURL(/\/settings$/);
  await expect.poll(() => storedTheme(second), { timeout: 15_000 }).toBe("dark");
  await expect(second.locator("html")).toHaveAttribute("data-theme", "dark");
  await second.getByRole("radio", { name: "Light" }).click();
  await second.waitForTimeout(3_000);
  await other.close();
  await page.reload();
  await expect.poll(() => storedTheme(page), { timeout: 15_000 }).toBe("light");

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

  // The landing, a game page and Settings all ran under the CSP without a violation.
  expect(csp).toEqual([]);
});
