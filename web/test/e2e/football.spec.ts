/**
 * The NFL and college game pages, any time of day: the `?demo` harness
 * replays the finish of a recorded NFL game through the football lane
 * (src/data/demo.ts: the Texans' tying drive in the 2-minute drill, then the
 * Giants' overtime walk-off; `nfl=<n>` starts n plays in, `nfl=final` shows
 * it as it ended) and serves a recorded college final between two ranked
 * teams. At 390, 1024 and 1440 pixels, light and dark: the live page (the
 * Field with its drive, chips and drive list, the hero's possession), the
 * final page (the score by quarter with overtime, scoring plays, team stats),
 * the college table with AP ranks and its links, the docked bar's down and
 * possession, a touchdown's moment, the drive named for its team after a
 * punt, and linked focus (a scoring play lights
 * its quarter; a drive row lights its bar). Saves screenshots to
 * SCORELINE_SCREENSHOTS.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.env.SCORELINE_SCREENSHOTS ?? join("test-results", "screenshots");
mkdirSync(OUT, { recursive: true });

const WIDTHS = [
  { name: "390", width: 390, height: 844, mobile: true },
  { name: "1024", width: 1024, height: 768, mobile: false },
  { name: "1440", width: 1440, height: 900, mobile: false },
] as const;

const NFL = "/game/espn-401873016";
const CFB = "/game/espn-401856732?demo&league=college-football";

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("Failed to load resource") && errors.push(m.text()));
  return errors;
}

const scrollTo = (page: Page, y: number) =>
  page.evaluate((top) => {
    const main = document.getElementById("main");
    (main && main.scrollHeight > main.clientHeight ? main : window).scrollTo(0, top);
  }, y);

for (const size of WIDTHS) {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${size.name} ${scheme} football`, () => {
      test.use({ viewport: { width: size.width, height: size.height }, colorScheme: scheme, isMobile: size.mobile, hasTouch: size.mobile, deviceScaleFactor: 2 });

      test("live NFL page: hero, the field and its drive, chips, linked focus", async ({ page }) => {
        const errors = watchErrors(page);
        await page.goto(`${NFL}?demo&nfl=6`);
        // The hero is the page's heading: the game in words, with who has the ball.
        await expect(page.getByRole("heading", { level: 1, name: /Giants \d+, Texans \d+.*Texans ball/ })).toBeAttached({ timeout: 20_000 });
        await expect(page.getByRole("heading", { name: /^Field/ })).toBeVisible();
        // The field says the down, the red zone, the 2-minute drill and the drive in words.
        await expect(page.getByRole("group", { name: /& .*Red zone\. Two-minute drill\. HOU drive · \d+ plays/ })).toBeAttached({ timeout: 15_000 });
        await expect(page.locator('[data-section="field"]').getByText("Red Zone", { exact: true })).toBeVisible();
        await expect(page.locator('[data-section="field"]').getByText(/^2[- ]MIN/)).toBeVisible();
        await expect(page.locator('[data-section="field"] ul li').first()).toBeVisible();
        // The play theater is the Live View, its own module above the Field (theaters.spec.ts).
        await expect(page.locator('[data-section="liveView"]')).toHaveCount(1);
        await page.waitForTimeout(800);
        await page.screenshot({ path: join(OUT, `${size.name}-${scheme}-football-live.png`) });

        if (!size.mobile) {
          // A drive row lights its snap's bar on the field.
          const row = page.locator('[data-section="field"] ul li').first();
          await row.hover();
          await expect(page.locator('[data-section="field"] [aria-hidden="true"] [data-lit="true"]')).toBeAttached();
          // A scoring play lights its quarter in the line score.
          const play = page.locator('[data-section="moments"] li').first();
          await play.scrollIntoViewIfNeeded();
          await play.hover();
          await expect(page.locator('[data-section="linescore"] [data-lit="true"]')).toHaveCount(1);
        }
        expect(errors, errors.join("\n")).toEqual([]);
      });

      test("final NFL page: the score by quarter with overtime, scoring plays, team stats", async ({ page }) => {
        const errors = watchErrors(page);
        await page.goto(`${NFL}?demo&nfl=final`);
        await expect(page.getByRole("heading", { level: 1, name: /Giants 27, Texans 21.*Giants won/ })).toBeAttached({ timeout: 20_000 });
        await expect(page.getByRole("heading", { name: /Score by Quarter/ })).toBeVisible();
        await expect(page.locator('[data-section="linescore"]').getByText("OT", { exact: true })).toBeAttached();
        await expect(page.getByRole("heading", { name: /^Scoring/ })).toBeAttached();
        await expect(page.getByRole("heading", { name: /^Team Stats/ })).toBeAttached();
        // No field once it's over.
        await expect(page.locator('[data-section="field"]')).toHaveCount(0);
        await page.waitForTimeout(600);
        await page.screenshot({ path: join(OUT, `${size.name}-${scheme}-football-final.png`) });
        expect(errors, errors.join("\n")).toEqual([]);
      });

      // The rest at two of the six sizes each, to keep the run (and the screenshots) small.
      if ((size.name === "1024" && scheme === "light") || (size.name === "390" && scheme === "dark")) {
        test("college final: AP ranks, the conference table and its links", async ({ page }) => {
          const errors = watchErrors(page);
          await page.goto(CFB);
          await expect(page.getByRole("heading", { level: 1 })).toBeAttached({ timeout: 20_000 });
          await expect(page.getByRole("heading", { name: /^Conference/ })).toBeAttached({ timeout: 15_000 });
          const table = page.locator('[data-section="table"]');
          await expect(table.getByRole("link", { name: /Texas/ }).first()).toBeAttached();
          await expect(table.getByRole("link", { name: /Full Standings/ })).toHaveAttribute("href", /\/standings\/college-football\?ring=/);
          await expect(table.getByRole("link", { name: /Top 25/ })).toHaveAttribute("href", "/rankings/college-football");
          await table.scrollIntoViewIfNeeded();
          await page.waitForTimeout(500);
          await page.screenshot({ path: join(OUT, `${size.name}-${scheme}-college-final.png`) });
          expect(errors, errors.join("\n")).toEqual([]);
        });
      }

      if ((size.name === "390" && scheme === "light") || (size.name === "1440" && scheme === "dark")) {
        test("docked bar: the ball beside its team, the down and distance", async ({ page }) => {
          const errors = watchErrors(page);
          // Short enough that the page scrolls at every width.
          await page.setViewportSize({ width: size.width, height: 520 });
          await page.goto(`${NFL}?demo&nfl=6`);
          await expect(page.getByRole("heading", { name: /^Field/ })).toBeVisible({ timeout: 20_000 });
          await expect(page.locator('[data-section="field"] ul li').first()).toBeVisible({ timeout: 15_000 });
          const bar = page.locator('button[title="Back to top"]').locator("..");
          await scrollTo(page, 600);
          await expect(bar).toHaveCSS("opacity", "1");
          // The possession slot holds the ball on the Texans' side.
          await expect(bar.locator('[data-on="true"]')).toHaveCount(1);
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(OUT, `${size.name}-${scheme}-football-docked.png`) });
          expect(errors, errors.join("\n")).toEqual([]);
        });
      }

      if (size.name === "1024" && scheme === "light") {
        test("a touchdown: the moment's caption, the end zone lit, the burst", async ({ page }) => {
          const errors = watchErrors(page);
          // Ten plays in, the tying touchdown is the next play (5 s on).
          await page.goto(`${NFL}?demo&nfl=10`);
          const field = page.locator('[data-section="field"]');
          await expect(field.getByText("Touchdown", { exact: true })).toBeVisible({ timeout: 30_000 });
          await page.waitForTimeout(650);
          await field.screenshot({ path: join(OUT, `${size.name}-${scheme}-football-touchdown.png`) });
          expect(errors, errors.join("\n")).toEqual([]);
        });

        test("after a punt, the drive on the field is still the punting team's", async ({ page }) => {
          // Twenty-two plays in, the Texans have just punted: the Giants have the ball, the listed snaps are Houston's.
          await page.goto(`${NFL}?demo&nfl=22`);
          await expect(page.getByRole("group", { name: /^1st & 10 at NYG \d+\. HOU drive · 3 plays · 0 yards$/ })).toBeAttached({ timeout: 15_000 });
        });
      }
    });
  }
}

/**
 * The college hero at 390: a long ranked name keeps the rank and the follow
 * star on its line, the name giving way to two lines at most (the Mac's
 * HStack, `lineLimit(2)`), never the star wrapping under it. The recorded
 * college final's summary, its teams renamed to the longest ranked names.
 */
test.describe("390 college hero names", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const summary = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "espn-cfb-summary.json"), "utf8")) as { header: { competitions: { competitors: { rank?: number; team: Record<string, unknown> }[] }[] } };
  const names: [string, number][] = [
    ["Mississippi State", 25],
    ["Louisiana–Monroe", 24],
  ];
  summary.header.competitions[0]!.competitors.forEach((c, i) => {
    const [name, rank] = names[i]!;
    c.rank = rank;
    Object.assign(c.team, { location: name, shortDisplayName: name, displayName: name });
  });

  test("a long ranked name keeps its star beside it", async ({ page }) => {
    const errors = watchErrors(page);
    await page.route("**/api/site.api.espn.com/apis/site/v2/sports/football/college-football/summary?event=401856732**", (route) => route.fulfill({ json: summary }));
    await page.goto("/game/espn-401856732?league=college-football");
    const hero = page.locator('[class*="_heroWrap_"]').first();
    for (const [name, rank] of names) {
      const star = hero.getByRole("button", { name: `Follow ${name}` });
      await expect(star).toBeVisible({ timeout: 20_000 });
      const line = star.locator("xpath=..");
      await expect(line).toContainText(`${rank}`);
      const box = (await line.boundingBox())!;
      // The star itself (its button is a larger target over a smaller footprint).
      const s = (await star.locator("svg").boundingBox())!;
      const label = line.locator('[class*="_name_"]');
      const text = (await label.boundingBox())!;
      // The star sits beside the name, inside its line: not on a line of its own below it.
      expect(s.x).toBeGreaterThanOrEqual(text.x + text.width - 1);
      expect(s.y + s.height / 2).toBeGreaterThan(text.y);
      expect(s.y + s.height / 2).toBeLessThan(text.y + text.height);
      // Two lines of the name at most, and nothing outside the hero.
      const lineHeight = parseFloat(await label.evaluate((e) => getComputedStyle(e).lineHeight));
      expect(text.height).toBeLessThanOrEqual(2 * lineHeight + 1);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await page.screenshot({ path: join(OUT, "390-light-college-hero-long-names.png"), clip: { x: 0, y: 0, width: 390, height: 260 } });
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
