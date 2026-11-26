/**
 * The owner's numbers (`/admin`, features/admin): the report drawn from a
 * stats answer (the Worker's endpoint stood in, as shared/stats.ts shapes
 * it) at 390 and 1440 in light and dark, with axe at zero; Admins Only for
 * anyone else; and Settings' link, which shows only when the probe says so.
 */
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Stats } from "../../shared/stats";

const out = process.env.SCORELINE_SCREENSHOTS ?? "test-results/screenshots";
mkdirSync(out, { recursive: true });

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 26, 15);
const day = (offset: number) => new Date(now + offset * DAY).toISOString().slice(0, 10);
const series = (f: (i: number) => number) => Array.from({ length: 30 }, (_, i) => ({ day: day(i - 29), n: f(i) }));

const STATS: Stats = {
  generatedAt: new Date(now).toISOString(),
  totals: { users: 1284, signups30d: 412, dau: 318, wau: 702, mau: 1104, landings30d: 5230, conversion: 412 / 5230, },
  signupsByDay: series((i) => Math.round(6 + 10 * Math.sin(i / 4) ** 2 + (i > 24 ? 20 : 0))),
  activeByDay: series((i) => 180 + i * 5 + (i % 7 === 5 ? 60 : 0)),
  landingsByDay: series((i) => (i === 26 ? 980 : 90 + i * 3)),
  referrers: [{ key: "news.ycombinator.com", n: 1840 }, { key: "reddit.com", n: 920 }, { key: "x.com", n: 310 }, { key: "a-very-long-referrer-host-name.example.co.uk", n: 12 }],
  campaigns: [{ source: "newsletter", medium: "email", campaign: "launch", n: 640 }, { source: "reddit", medium: "", campaign: "", n: 88 }],
  leagues: [{ key: "nfl", n: 2210 }, { key: "eng.1", n: 1530 }, { key: "nba", n: 980 }, { key: "cs2", n: 140 }],
  routes: [{ key: "/", n: 9120 }, { key: "/game/:id", n: 6400 }, { key: "/settings", n: 380 }, { key: "/schedule/:scope?", n: 210 }],
  devices: [{ key: "phone", n: 6100 }, { key: "desktop", n: 3800 }, { key: "tablet", n: 420 }],
  countries: [{ key: "US", n: 6200 }, { key: "GB", n: 2100 }, { key: "DE", n: 600 }],
  retention: {
    cohorts: Array.from({ length: 10 }, (_, i) => ({ day: day(i - 10), users: 10 + i * 3, d1: 4 + i, d7: i < 4 ? 2 + i : 0 })),
    d1: 0.42,
    d7: 0.18,
  },
  errors: [
    { message: "TypeError: Cannot read properties of undefined (reading 'competitors')", path: "/game/:id", release: "v1.0.33-41-gc388dde", stack: "TypeError: Cannot read properties of undefined (reading 'competitors')\n    at parse (https://scoreline.example/assets/espn-abc.js:1:2048)\n    at render (https://scoreline.example/assets/GamePage-def.js:1:900)", count: 37, lastSeen: now - 3_600_000 },
    { message: "ChunkLoadError: Loading chunk failed", path: "/", release: "v1.0.33-41-gc388dde", stack: null, count: 4, lastSeen: now - 7_200_000 },
  ],
};

async function answer(page: Page, status: number, admin: boolean) {
  await page.route("**/api/admin/stats**", (route) =>
    route.request().url().includes("probe") ? route.fulfill({ json: { admin } }) : status === 200 ? route.fulfill({ json: STATS }) : route.fulfill({ status, json: { error: { status } } }),
  );
}

for (const size of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`Admin ${size.width} ${colorScheme}`, () => {
      test.use({ viewport: size, colorScheme, reducedMotion: "reduce" });

      test("the report, with axe at zero", async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await answer(page, 200, true);
        await page.goto("/admin");
        await expect(page.getByRole("heading", { level: 1, name: "Admin" })).toBeVisible();
        await expect(page.getByText("1,284", { exact: true })).toBeVisible();
        await expect(page.getByRole("img", { name: /^Sign-ups: [\d,]+ in 30 days, most on / })).toBeVisible();
        await expect(page.getByRole("group", { name: "Top Referrers" }).getByText("news.ycombinator.com")).toBeVisible();
        await expect(page.getByRole("table")).toBeVisible();
        // Nothing runs off the page's side.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.getByText("TypeError: Cannot read properties", { exact: false }).first().click();
        await expect(page.getByText("at parse (", { exact: false })).toBeVisible();
        await page.screenshot({ animations: "disabled", fullPage: true, path: join(out, `admin-${size.width}-${colorScheme}.png`) });
        const axe = await new AxeBuilder({ page }).analyze();
        expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
        expect(errors).toEqual([]);
      });

      test("Admins Only for anyone else, and no link in Settings", async ({ page }) => {
        await answer(page, 403, false);
        await page.goto("/admin");
        await expect(page.getByRole("heading", { level: 1, name: "Admins Only" })).toBeVisible();
        await page.screenshot({ animations: "disabled", path: join(out, `admin-denied-${size.width}-${colorScheme}.png`) });
        await page.goto("/settings");
        await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
        await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
      });
    });
  }
}

test("Settings links to Admin for an admin", async ({ page }) => {
  await answer(page, 200, true);
  await page.goto("/settings");
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByText("1,284", { exact: true })).toBeVisible();
});
