/**
 * Checks that need a real live game (ESPN through the proxy): each finds one
 * on today's scoreboards and skips when there's none.
 *
 * - A live soccer page opened cold, with the core plays' first look held back
 *   a few seconds: the presentation clock hasn't started, and the page shows
 *   as it would without a broadcast (no NaN minute, no invalid date, no error
 *   page; the Mac's 1.0.33 crash, docs/MAC-WEB-SPLIT.md).
 */
import { expect, test, type Page } from "@playwright/test";

/** Errors worth failing on (resource failures are the network's, not the page's). */
function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
  return errors;
}

/** A game in progress in one of these leagues, by the app's own proxy (one scoreboard read each, until one has one). */
async function liveGame(page: Page, sport: string, leagues: readonly string[], ok: (e: Record<string, unknown>) => boolean = () => true): Promise<{ id: string; league: string } | null> {
  for (const league of leagues) {
    const res = await page.request.get(`/api/site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`);
    if (!res.ok()) continue;
    const events = ((await res.json()) as { events?: Record<string, unknown>[] }).events ?? [];
    const live = events.find((e) => (e.status as { type?: { state?: string } } | undefined)?.type?.state === "in" && ok(e));
    if (live) return { id: String(live.id), league };
  }
  return null;
}

const SOCCER = ["uefa.champions", "uefa.europa", "uefa.europa.conf", "eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "usa.1", "mex.1"] as const;

test.describe("live games", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a live soccer page before its broadcast clock starts: no NaN, no error page", async ({ page }) => {
    const game = await liveGame(page, "soccer", SOCCER);
    test.skip(game == null, "No live soccer game now");
    const errors = watch(page);
    // Hold the core plays' first look back: until it arrives the clock has no plan (p is −∞).
    await page.route(/sports\.core\.api\.espn\.com/, async (route) => {
      await new Promise((r) => setTimeout(r, 6000));
      await route.continue().catch(() => {});
    });
    await page.goto(`/game/espn-${game!.id}?league=${game!.league}`);
    const timeline = page.locator('[data-section="timeline"]');
    await expect(timeline).toBeAttached({ timeout: 20_000 });
    for (let i = 0; i < 16; i++) {
      await expect(page.getByText("Something Went Wrong")).toHaveCount(0);
      const html = await timeline.innerHTML();
      expect(html, "the timeline draws no NaN or infinite value").not.toMatch(/NaN|Infinity/);
      await page.waitForTimeout(500);
    }
    // Once the core plays arrive, the timeline says the minute.
    await expect(timeline.getByLabel(/^Timeline to \d+ minutes/).first()).toBeAttached({ timeout: 15_000 });
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
