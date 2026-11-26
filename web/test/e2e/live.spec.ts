/**
 * Live states, any time of day: the dev server's `?demo` harness replays
 * fixtures with games in progress (src/data/demo.ts). Checks the live count,
 * running clocks, strips and the score flash, and saves screenshots.
 */
import { expect, test } from "@playwright/test";
import { join } from "node:path";

const OUT = process.env.SCORELINE_SCREENSHOTS ?? join("test-results", "screenshots");

for (const { name, width, height, mobile } of [
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "1440", width: 1440, height: 900, mobile: false },
]) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${name} ${scheme} live`, () => {
      test.use({ viewport: { width, height }, colorScheme: scheme, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });

      test("live games: clocks, strips and the score flash", async ({ page }) => {
        await page.goto("/?demo");
        // The live count says itself in words, but isn't a live region (the list never announces).
        await expect(page.getByText(/^\d+ Live$/)).toBeVisible({ timeout: 20_000 });
        await expect(page.getByText(/games? in progress/).first()).toBeAttached();
        await expect(page.locator("aside [role=status], aside [aria-live]:not([aria-live=off])")).toHaveCount(0);
        await page.waitForTimeout(800);
        await page.screenshot({ path: join(OUT, `${name}-${scheme}-live-list.png`) });

        // A refresh makes the demo's games score: the rows flash.
        await page.getByRole("button", { name: "Refresh" }).click();
        await page.waitForTimeout(450);
        await page.screenshot({ path: join(OUT, `${name}-${scheme}-live-flash.png`) });

        await page.getByRole("radio", { name: "Tiles" }).click();
        await page.waitForTimeout(800);
        await page.screenshot({ path: join(OUT, `${name}-${scheme}-live-tiles.png`) });

        // A live game's page.
        await page.locator("[data-nav-id]").first().click();
        await expect(page).toHaveURL(/\/game\//);
        await page.waitForTimeout(700);
        await page.screenshot({ path: join(OUT, `${name}-${scheme}-live-game.png`) });
      });
    });
  }
}

/**
 * The line under a row's teams (a CS2 match's tournament and format, a live
 * situation) runs the row's whole width at 1024, under the status too: it
 * isn't cut where the score column ends while the rest of the row is free.
 */
test.describe("1024 dark list captions", () => {
  test.use({ viewport: { width: 1024, height: 768 }, colorScheme: "dark" });

  test("a row's caption has the row's width", async ({ page }) => {
    await page.goto("/?demo");
    const row = page.locator("aside [data-nav-id]").filter({ hasText: "PGL Masters Bucharest 2026 · Best of 3" }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    const context = row.locator('[class*="_context_"]');
    const status = row.locator('[class*="_status_"]').first();
    const c = (await context.boundingBox())!;
    const s = (await status.boundingBox())!;
    // The caption reaches the status column's right edge, below it.
    expect(c.x + c.width).toBeGreaterThanOrEqual(s.x + s.width - 1);
    expect(c.y).toBeGreaterThanOrEqual(s.y + s.height - 1);
    expect(await context.evaluate((e) => e.scrollWidth <= e.clientWidth + 1), "the caption is cut").toBe(true);
    await page.locator("aside").screenshot({ path: join(OUT, "1024-dark-list-captions.png") });
  });
});
