/**
 * First-party analytics in the Worker (worker/analytics.ts), against SQLite
 * with the real migration (d1.ts): what the ingest keeps and drops, the
 * signed-out allowlist, Global Privacy Control and Do Not Track, error
 * deduplication, the landing page's count, who may read the stats, and the
 * stats queries themselves on a seeded database.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { adminStats, deviceClass, ingest, isAdmin, queryStats, readBatch, recordLandingView, type CurrentUser } from "../../worker/analytics";
import { utcDay } from "../../shared/stats";
import { testD1, type TestD1 } from "./d1";

const ORIGIN = "https://scoreline.example";
const SIGNED_IN: CurrentUser = { id: "user-1", email: "owner@example.com", emailVerified: true };
const ANON = "a1b2c3d4e5f6a7b8";
const SESSION = "s1b2c3d4e5f6a7b8";

let d1: TestD1;
let waits: Promise<unknown>[];
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException: () => {}, props: {} }) as unknown as ExecutionContext;

beforeEach(() => {
  d1 = testD1();
  waits = [];
});

const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/t`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "Sec-Fetch-Site": "same-origin", ...headers } });

async function send(body: unknown, user: CurrentUser = SIGNED_IN, headers: Record<string, string> = {}) {
  const response = await ingest(request(body, headers), { DB: d1.db }, ctx(), user);
  await Promise.all(waits);
  return response;
}

const batch = (events: unknown[], extra: Record<string, unknown> = {}) => ({ anon: ANON, session: SESSION, release: "v1.0.33-4-gabc1234", events, ...extra });

describe("the ingest", () => {
  it("keeps a valid batch in one write, with the session's user and the request's country and device", async () => {
    const now = Date.now();
    const req = request(batch([{ name: "page_view", ts: now, path: "/game/:id", league: "nfl" }, { name: "game_open", ts: now, path: "/game/:id", league: "nfl", props: { sport: "football" } }]), {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148",
    });
    Object.defineProperty(req, "cf", { value: { country: "GB" } });
    const response = await ingest(req, { DB: d1.db }, ctx(), SIGNED_IN);
    await Promise.all(waits);
    expect(response.status).toBe(204);
    const rows = d1.rows("events");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ name: "game_open", user_id: "user-1", anon_id: ANON, session_id: SESSION, path: "/game/:id", league: "nfl", props: '{"sport":"football"}', country: "GB", device: "phone", day: utcDay(now) });
    // No column holds an IP or the user agent.
    expect(Object.keys(rows[0]!)).not.toContain("ip");
    expect(JSON.stringify(rows)).not.toContain("iPhone OS");
  });

  it("drops what isn't on the allowlist, without telling the client", async () => {
    const response = await send(
      batch([
        { name: "purchase", path: "/" },
        { name: "page_view", path: "/game/401772981" },
        { name: "page_view", path: "/team/:id?x=1" },
        { name: "page_view", path: "/settings", league: "<script>" },
        { name: "setting_change", props: { key: "odds", value: { nested: true }, ["x".repeat(30)]: 1 } },
      ]),
    );
    expect(response.status).toBe(204);
    const rows = d1.rows("events");
    // The unknown name is gone; raw IDs and queries in paths are nulled; a bad league is dropped; props keep only flat, short values.
    expect(rows.map((r) => r.name)).toEqual(["page_view", "page_view", "page_view", "setting_change"]);
    expect(rows.map((r) => r.path)).toEqual([null, null, "/settings", null]);
    expect(rows[2]!.league).toBeNull();
    expect(rows[3]!.props).toBe('{"key":"odds"}');
  });

  it("answers 204 to garbage, oversized and cross-site posts, and writes nothing", async () => {
    expect((await send("not json")).status).toBe(204);
    expect((await send({ events: "nope" })).status).toBe(204);
    expect((await send(batch([{ name: "page_view", path: "/" }]), SIGNED_IN, { "Sec-Fetch-Site": "cross-site" })).status).toBe(204);
    // Past 64 KB, the body isn't read.
    expect((await send(JSON.stringify(batch(Array(1200).fill({ name: "page_view", path: "/settings", props: { k: "x".repeat(40) } }))))).status).toBe(204);
    expect(d1.rows("events")).toHaveLength(0);
    expect((await ingest(new Request(`${ORIGIN}/api/t`), { DB: d1.db }, ctx(), SIGNED_IN)).status).toBe(405);
  });

  it("keeps at most 50 events from a batch", async () => {
    await send(batch(Array.from({ length: 80 }, () => ({ name: "page_view", path: "/" }))));
    expect(d1.rows("events")).toHaveLength(50);
  });

  it("lets a signed-out browser send only the landing page's and auth's events", async () => {
    await send(batch(["landing_view", "sign_in_start", "sign_up", "sign_in", "page_view", "game_open", "error"].map((name) => ({ name, path: "/", message: "x" }))), null);
    const rows = d1.rows("events");
    expect(rows.map((r) => r.name)).toEqual(["landing_view", "sign_in_start", "sign_up", "sign_in"]);
    expect(rows.every((r) => r.user_id === null && r.anon_id === ANON)).toBe(true);
    expect(d1.rows("client_errors")).toHaveLength(0);
  });

  it.each([["Sec-GPC"], ["DNT"]])("with %s: 1, keeps the events but no anonymous, session or user ID", async (header) => {
    await send(batch([{ name: "page_view", path: "/settings" }, { name: "error", message: "Boom", stack: "Error: Boom\n    at f (app.js:1:2)" }]), SIGNED_IN, { [header]: "1" });
    expect(d1.rows("events")).toEqual([expect.objectContaining({ name: "page_view", path: "/settings", user_id: null, anon_id: null, session_id: null })]);
    expect(d1.rows("client_errors")).toEqual([expect.objectContaining({ message: "Boom", user_id: null })]);
  });

  it("keeps a visit's referrer host and UTM tags, never its own host or a full URL", () => {
    const { events } = readBatch(
      batch([
        { name: "page_view", path: "/", ref: "https://www.Reddit.com/r/nfl/comments/abc?x=1", utm: { source: "Reddit", medium: "social", campaign: "launch week" } },
        { name: "page_view", path: "/", ref: "scoreline.example" },
        { name: "page_view", path: "/", ref: "javascript:alert(1)", utm: { source: "<b>" } },
      ]),
      request(""),
      SIGNED_IN,
    );
    expect(events.map((e) => [e.referrer_host, e.utm_source, e.utm_medium, e.utm_campaign])).toEqual([
      ["reddit.com", "reddit", "social", "launch week"],
      [null, null, null, null],
      [null, null, null, null],
    ]);
  });

  it("counts the same error at the same frame once a day, with a count, and truncates its stack to 2 KB", async () => {
    const stack = `TypeError: x is undefined\n    at render (https://scoreline.example/assets/GamePage-abc.js:1:200)\n${"    at deep (x.js:1:1)\n".repeat(200)}`;
    const error = { name: "error", path: "/game/:id", message: "TypeError: x is undefined", stack };
    await send(batch([error, error]));
    await send(batch([error]));
    await send(batch([{ ...error, stack: "TypeError: x is undefined\n    at other (y.js:9:9)" }]));
    const rows = d1.rows("client_errors");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ count: 3, user_id: "user-1", path: "/game/:id", release: "v1.0.33-4-gabc1234" });
    expect((rows[0]!.stack as string).length).toBe(2048);
    expect(rows[1]!.count).toBe(1);
    expect(d1.rows("events")).toHaveLength(0);
  });

  it("rate limits one browser past 30 batches a minute", async () => {
    for (let i = 0; i < 35; i++) await send(batch([{ name: "sign_in_start", path: "/" }], { anon: "ratelimit-test-0001" }), null);
    expect(d1.rows("events")).toHaveLength(30);
  });
});

describe("the device class", () => {
  it.each([
    [{ "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" }, "phone"],
    [{ "User-Agent": "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/131 Mobile Safari/537.36" }, "phone"],
    [{ "User-Agent": "Mozilla/5.0 (Linux; Android 14; SM-X710) Chrome/131 Safari/537.36" }, "tablet"],
    [{ "User-Agent": "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" }, "tablet"],
    [{ "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)", "Sec-CH-UA-Mobile": "?1" }, "phone"],
    [{ "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }, "desktop"],
  ])("%o is a %s", (headers, device) => {
    expect(deviceClass(new Headers(headers))).toBe(device);
  });
});

describe("the landing page's count", () => {
  it("records a visit with the referrer's host, the URL's UTM tags, the country and the device", async () => {
    const req = new Request(`${ORIGIN}/?utm_source=Newsletter&utm_medium=email&utm_campaign=launch`, {
      headers: { Referer: "https://news.ycombinator.com/item?id=1", "User-Agent": "Mozilla/5.0 (Macintosh)" },
    });
    Object.defineProperty(req, "cf", { value: { country: "US" } });
    recordLandingView(req, { DB: d1.db }, ctx());
    await Promise.all(waits);
    expect(d1.rows("events")).toEqual([
      expect.objectContaining({ name: "landing_view", path: "/", referrer_host: "news.ycombinator.com", utm_source: "newsletter", utm_medium: "email", utm_campaign: "launch", country: "US", device: "desktop", user_id: null, anon_id: null }),
    ]);
  });

  it("skips crawlers and prefetches", async () => {
    recordLandingView(new Request(`${ORIGIN}/`, { headers: { "User-Agent": "Googlebot/2.1" } }), { DB: d1.db }, ctx());
    recordLandingView(new Request(`${ORIGIN}/`, { headers: { "Sec-Purpose": "prefetch;prerender" } }), { DB: d1.db }, ctx());
    await Promise.all(waits);
    expect(d1.rows("events")).toHaveLength(0);
  });
});

describe("the admin stats", () => {
  const env = () => ({ DB: d1.db, ADMIN_EMAILS: " Owner@Example.com ,second@example.com", ADMIN_USER_IDS: "user-9" });
  const get = (user: CurrentUser, query = "") => adminStats(new Request(`${ORIGIN}/api/admin/stats${query}`), env(), user);

  it("is for admins only, by verified email or by ID", async () => {
    expect(isAdmin(SIGNED_IN, env())).toBe(true);
    expect(isAdmin({ id: "user-9" }, env())).toBe(true);
    expect(isAdmin({ id: "user-2", email: "owner@example.com", emailVerified: false }, env())).toBe(false);
    expect(isAdmin({ id: "user-2", email: "someone@example.com" }, env())).toBe(false);
    expect(isAdmin(SIGNED_IN, {})).toBe(false);
    expect((await get(null)).status).toBe(401);
    expect((await get({ id: "user-2", email: "someone@example.com" })).status).toBe(403);
    expect((await get(SIGNED_IN)).status).toBe(200);
  });

  it("answers a probe with 200 either way, without running the queries", async () => {
    expect(await (await get(null, "?probe")).json()).toEqual({ admin: false });
    expect(await (await get(SIGNED_IN, "?probe")).json()).toEqual({ admin: true });
  });

  it("reports totals, active users, the landing funnel, rankings, retention and errors from a seeded database", async () => {
    const now = Date.now();
    const at = (daysAgo: number) => now - daysAgo * 86_400_000;
    // Three sign-ups: 10 days ago (back the next day and a week on), 8 days ago (back the next day), today.
    d1.addUser("u1", "u1@example.com", new Date(at(10)));
    d1.addUser("u2", "u2@example.com", new Date(at(8)));
    d1.addUser("u3", "u3@example.com", new Date(at(0)));
    d1.addUser("old", "old@example.com", new Date(at(90)));
    const event = (user: string | null, daysAgo: number, name: string, extra: Record<string, string> = {}) => {
      const ts = at(daysAgo);
      d1.sqlite
        .prepare(`INSERT INTO events (ts, day, user_id, name, path, league, device, country, referrer_host, utm_campaign) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ts, utcDay(ts), user, name, extra.path ?? null, extra.league ?? null, extra.device ?? null, extra.country ?? null, extra.ref ?? null, extra.campaign ?? null);
    };
    for (const d of [10, 9, 3]) event("u1", d, "page_view", { path: "/", device: "desktop", country: "US" });
    event("u2", 8, "page_view", { path: "/game/:id", device: "phone", country: "GB" });
    event("u2", 7, "game_open", { path: "/game/:id", league: "nfl" });
    event("u3", 0, "game_open", { path: "/game/:id", league: "nfl" });
    event("u3", 0, "game_open", { path: "/game/:id", league: "eng.1" });
    for (let i = 0; i < 6; i++) event(null, i, "landing_view", { path: "/", device: "phone", ref: i < 4 ? "reddit.com" : "x.com", ...(i < 2 ? { campaign: "launch" } : {}) });
    d1.sqlite.prepare(`INSERT INTO client_errors (day, hash, ts, message, path, release, count) VALUES (?, 'h1', ?, 'Boom', '/game/:id', 'v1', 4), (?, 'h2', ?, 'Bang', '/', 'v1', 9)`).run(utcDay(now), now, utcDay(now), now);

    const stats = await queryStats(d1.db, now);
    expect(stats.totals).toEqual({ users: 4, signups30d: 3, dau: 1, wau: 2, mau: 3, landings30d: 6, conversion: 0.5 });
    expect(stats.signupsByDay).toHaveLength(30);
    expect(stats.signupsByDay.at(-1)).toEqual({ day: utcDay(now), n: 1 });
    expect(stats.landingsByDay.slice(-6).map((d) => d.n)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(stats.referrers).toEqual([{ key: "reddit.com", n: 4 }, { key: "x.com", n: 2 }]);
    expect(stats.leagues).toEqual([{ key: "nfl", n: 2 }, { key: "eng.1", n: 1 }]);
    expect(stats.routes).toEqual([{ key: "/", n: 3 }, { key: "/game/:id", n: 1 }]);
    expect(stats.devices).toEqual([{ key: "phone", n: 7 }, { key: "desktop", n: 3 }]);
    expect(stats.countries).toEqual([{ key: "US", n: 3 }, { key: "GB", n: 1 }]);
    expect(stats.campaigns).toEqual([{ source: "", medium: "", campaign: "launch", n: 2 }]);
    // Day 1: u1 and u2 came back (of the two cohorts old enough). Day 7: u1 only (u2's cohort is 8 days old, so it counts; u2 wasn't back on day 7).
    expect(stats.retention.d1).toBe(1);
    expect(stats.retention.d7).toBe(0.5);
    expect(stats.retention.cohorts.map((c) => [c.users, c.d1, c.d7])).toEqual([[1, 1, 1], [1, 1, 0], [1, 0, 0]]);
    expect(stats.errors.map((e) => [e.message, e.count])).toEqual([["Bang", 9], ["Boom", 4]]);
  });
});
