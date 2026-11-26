/**
 * First-party analytics end to end: the app in a real browser against the
 * running Worker (`pnpm dev`) and its local D1, read and seeded through the
 * dev server's Local Explorer API. Pages visited and a game opened land in
 * `events` by route pattern with no raw IDs, sent by the `pagehide` flush;
 * Sec-GPC leaves anonymous rows; a thrown error lands in `client_errors`;
 * /admin draws seeded numbers for an admin and says Admins Only otherwise.
 *
 * Needs a dev server with `ADMIN_USER_IDS=e2e-admin` (copy .dev.vars.example
 * to .dev.vars). Signed in means the dev server's stand-in cookie
 * (`scoreline_dev_user`, worker/index.ts) until accounts land. Every row it
 * writes is deleted afterwards, and Better Auth's `user` table too if this
 * spec had to create it.
 */
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RUN = Date.now().toString(36);
const USER = `e2e-user-${RUN}`;
const ERROR_USER = `e2e-errors-${RUN}`;
const ADMIN = "e2e-admin";
const EXPLORER = "/cdn-cgi/local/explorer/api/d1/database";
const MIGRATION = readFileSync(join(import.meta.dirname, "..", "..", "migrations", "0100_analytics.sql"), "utf8");
const USER_TABLE = `CREATE TABLE IF NOT EXISTS "user" ("id" text NOT NULL PRIMARY KEY, "name" text NOT NULL, "email" text NOT NULL UNIQUE, "emailVerified" integer NOT NULL, "image" text, "createdAt" date NOT NULL, "updatedAt" date NOT NULL)`;

type Row = Record<string, unknown>;
let database = "";
let started = 0;
let createdUserTable = false;

/** One statement against the dev server's local D1; its rows as objects. */
async function sql(request: APIRequestContext, statement: string, params: unknown[] = []): Promise<Row[]> {
  // The explorer takes parameters as strings; SQLite compares them with the integer columns as numbers.
  const response = await request.post(`${EXPLORER}/${database}/raw`, { data: { sql: statement, params: params.map(String) } });
  const body = (await response.json()) as { success: boolean; errors?: unknown; result?: { results: { columns: string[]; rows: unknown[][] } }[] };
  if (!body.success) throw new Error(`D1: ${JSON.stringify(body.errors)} for ${statement}`);
  const set = body.result?.at(-1)?.results ?? { columns: [], rows: [] };
  return set.rows.map((row) => Object.fromEntries(set.columns.map((column, i) => [column, row[i]])));
}

async function signedIn(context: BrowserContext, id: string, baseURL: string) {
  await context.addCookies([{ name: "scoreline_dev_user", value: id, url: baseURL }]);
}

/** Leaves the page, which fires pagehide: the queue's last flush. */
const leave = (page: Page) => page.goto("about:blank");

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  const list = (await (await request.get(EXPLORER)).json()) as { result: { name: string; uuid: string }[] };
  database = list.result.find((db) => db.name === "DB")?.uuid ?? "";
  expect(database, "the dev server binds D1 as DB").not.toBe("");
  for (const statement of MIGRATION.split(/;\s*$/m).map((s) => s.trim()).filter((s) => s.replace(/--.*$/gm, "").trim())) await sql(request, statement);
  createdUserTable = (await sql(request, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'`)).length === 0;
  await sql(request, USER_TABLE);
  started = Date.now();
});

test.afterAll(async ({ request }) => {
  await sql(request, `DELETE FROM events WHERE ts >= ?`, [started - 60_000]);
  await sql(request, `DELETE FROM client_errors WHERE ts >= ?`, [started - 60_000]);
  if (createdUserTable) await sql(request, `DROP TABLE "user"`);
  else await sql(request, `DELETE FROM "user" WHERE id LIKE 'e2e-%'`);
});

test("pages and a game open land by route pattern, with no raw IDs, on the pagehide flush", async ({ page, context, request, baseURL }) => {
  await signedIn(context, USER, baseURL!);
  await page.goto("/game/espn-401908044?demo&mlb=6&analytics");
  await expect(page.locator("main h1, main [role=heading]").first()).toBeVisible({ timeout: 30_000 });
  // In-app navigations: Settings (comma), the Schedule (S), then Appearance's theme.
  await page.keyboard.press(",");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/schedule/);
  await leave(page);

  await expect.poll(async () => (await sql(request, `SELECT name FROM events WHERE user_id = ?`, [USER])).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(5);
  const rows = await sql(request, `SELECT name, path, league, props, anon_id, session_id, device FROM events WHERE user_id = ? ORDER BY ts, id`, [USER]);
  const views = rows.filter((r) => r.name === "page_view").map((r) => r.path);
  expect(views).toEqual(["/game/:id", "/settings", "/schedule/:scope?"]);
  expect(rows.find((r) => r.name === "game_open")).toMatchObject({ path: "/game/:id", league: "mlb", props: '{"sport":"baseball"}' });
  expect(rows.find((r) => r.name === "theme")).toMatchObject({ path: "/settings", props: '{"theme":"dark"}' });
  // One browser, one tab: the same anonymous and session IDs on every row, and a device class, never a user agent.
  expect(new Set(rows.map((r) => r.anon_id)).size).toBe(1);
  expect(new Set(rows.map((r) => r.session_id)).size).toBe(1);
  expect(rows[0]!.anon_id).toMatch(/^[a-f0-9]{32}$/);
  expect(rows.every((r) => r.device === "desktop")).toBe(true);
  expect(JSON.stringify(rows)).not.toMatch(/401908044|espn-|Mozilla|Chrome\//);
});

test("Sec-GPC: 1 leaves anonymous rows, and the browser stores no ID", async ({ browser, request, baseURL }) => {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { "Sec-GPC": "1" } });
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true }));
  await signedIn(context, `e2e-gpc-${RUN}`, baseURL!);
  const page = await context.newPage();
  const before = Date.now();
  await page.goto("/settings?analytics");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("scoreline.anon"))).toBeNull();
  // The pagehide flush, with the page kept alive: a beacon sent while it unloads doesn't survive the header injection.
  const sent = page.waitForRequest((r) => r.url().endsWith("/api/t") && r.method() === "POST");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  expect((await sent).headers()["sec-gpc"]).toBe("1");
  await expect.poll(async () => (await sql(request, `SELECT id FROM events WHERE ts >= ? AND name = 'page_view' AND path = '/settings' AND user_id IS NULL`, [before])).length, { timeout: 15_000 }).toBe(1);
  const [row] = await sql(request, `SELECT user_id, anon_id, session_id FROM events WHERE ts >= ? AND path = '/settings'`, [before]);
  expect(row).toEqual({ user_id: null, anon_id: null, session_id: null });
  expect(await sql(request, `SELECT id FROM events WHERE user_id = ?`, [`e2e-gpc-${RUN}`])).toEqual([]);
  await context.close();
});

test("a thrown error lands in client_errors, counted once a visit, sent by the pagehide flush", async ({ page, context, request, baseURL }) => {
  await signedIn(context, ERROR_USER, baseURL!);
  await page.goto("/settings?analytics");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  const message = `e2e boom ${RUN}`;
  await page.evaluate((m) => {
    for (let i = 0; i < 3; i++) setTimeout(() => { throw new Error(m); });
  }, message);
  await page.waitForTimeout(200);
  // Well inside the queue's 10 s: nothing has been sent yet, so what arrives is the pagehide flush.
  expect(await sql(request, `SELECT count FROM client_errors WHERE message = ?`, [`Error: ${message}`])).toEqual([]);
  expect(await sql(request, `SELECT id FROM events WHERE user_id = ?`, [ERROR_USER])).toEqual([]);
  await leave(page);
  await expect.poll(async () => (await sql(request, `SELECT id FROM events WHERE user_id = ? AND path = '/settings'`, [ERROR_USER])).length, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await sql(request, `SELECT count FROM client_errors WHERE message = ?`, [`Error: ${message}`])).length, { timeout: 15_000 }).toBe(1);
  const [row] = await sql(request, `SELECT count, user_id, path, stack, release FROM client_errors WHERE message = ?`, [`Error: ${message}`]);
  expect(row).toMatchObject({ count: 1, user_id: ERROR_USER, path: "/settings" });
  expect(String(row!.stack)).toContain(message);
  expect(String(row!.release)).not.toBe("");
});

test("/admin draws seeded numbers for an admin, linked from Settings", async ({ page, context, request, baseURL }) => {
  const now = new Date();
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  for (let i = 0; i < 3; i++) await sql(request, `INSERT INTO "user" VALUES (?, ?, ?, 1, NULL, ?, ?)`, [`e2e-seed-${RUN}-${i}`, "Seed", `seed-${RUN}-${i}@example.com`, iso, iso]);
  for (let i = 0; i < 4; i++) {
    await sql(request, `INSERT INTO events (ts, day, name, path, device, country, referrer_host) VALUES (?, ?, 'landing_view', '/', 'phone', 'NZ', 'e2e-referrer.example')`, [now.getTime(), day]);
  }
  await sql(request, `INSERT INTO events (ts, day, user_id, name, path, league) VALUES (?, ?, ?, 'game_open', '/game/:id', 'e2e.league')`, [now.getTime(), day, `e2e-seed-${RUN}-0`]);
  await sql(request, `INSERT INTO client_errors (day, hash, ts, message, path, release, count) VALUES (?, ?, ?, ?, '/game/:id', 'e2e', 7)`, [day, `e2e${RUN}`, now.getTime(), `TypeError: seeded ${RUN}`]);

  await signedIn(context, ADMIN, baseURL!);
  await page.goto("/settings");
  await page.getByRole("link", { name: "Admin" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Admin" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Top Referrers" }).getByText("e2e-referrer.example")).toBeVisible();
  await expect(page.getByRole("group", { name: "Leagues by Game Opens" }).getByText("e2e.league")).toBeVisible();
  await expect(page.getByRole("group", { name: "Countries" }).getByText("NZ")).toBeVisible();
  await expect(page.getByText(`TypeError: seeded ${RUN}`)).toBeVisible();
  await expect(page.getByRole("img", { name: /^Sign-ups: [\d,]+ in 30 days, most on / })).toBeVisible();
  // The Users tile counts at least the three seeded.
  const users = await page.locator("span", { hasText: /^Users$/ }).locator("xpath=following-sibling::span[1]").innerText();
  expect(Number(users.replace(/,/g, ""))).toBeGreaterThanOrEqual(3);
  await page.screenshot({ animations: "disabled", fullPage: true, path: join(process.env.SCORELINE_SCREENSHOTS ?? "test-results/screenshots", "admin-seeded.png") });
});

test("/admin says Admins Only to anyone else, and Settings shows no link", async ({ page, context, baseURL }) => {
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Admins Only" })).toBeVisible();
  await signedIn(context, `e2e-nobody-${RUN}`, baseURL!);
  expect((await page.request.get("/api/admin/stats")).status()).toBe(403);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Admins Only" })).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
});
