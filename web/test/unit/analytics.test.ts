/**
 * The analytics queue in the browser (state/analytics.ts), with the page's
 * globals stood in: batching and its 10 s flush, the flush on pagehide and
 * on hiding, route patterns with no raw IDs, setting events without
 * values, errors once a visit, and no IDs under Global Privacy Control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WireBatch } from "../../shared/analytics";

type Analytics = typeof import("../../src/state/analytics");
type SettingsModule = typeof import("../../src/state/settings");

let sent: WireBatch[];
let win: EventTarget;
let doc: EventTarget & { visibilityState: string; referrer: string };

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k), clear: () => map.clear(), key: () => null, get length() { return map.size; } };
}

async function load({ search = "?analytics", gpc = false, referrer = "" } = {}): Promise<{ a: Analytics; settings: SettingsModule }> {
  vi.resetModules();
  sent = [];
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), { visibilityState: "visible", referrer });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("location", { search, host: "scoreline.example" });
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("navigator", {
    globalPrivacyControl: gpc,
    sendBeacon: (url: string, body: string) => {
      expect(url).toBe("/api/t");
      sent.push(JSON.parse(body) as WireBatch);
      return true;
    },
  });
  const a = await import("../../src/state/analytics");
  const settings = await import("../../src/state/settings");
  return { a, settings };
}

/** A data router's state, as React Router keeps it, for the given matched route paths. */
const routerState = (pathname: string, paths: (string | undefined)[], search = "") => ({
  location: { pathname, search },
  matches: paths.map((path) => ({ route: { path } })),
  navigation: { state: "idle" },
});

function fakeRouter(initial: ReturnType<typeof routerState>) {
  let listener: ((s: ReturnType<typeof routerState>) => void) | undefined;
  return {
    state: initial,
    subscribe(fn: typeof listener) {
      listener = fn;
    },
    go(state: ReturnType<typeof routerState>) {
      listener?.(state);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the analytics queue", () => {
  it("batches events and sends them 10 s after the first, with the browser's and the tab's IDs and the release", async () => {
    const { a } = await load();
    a.startAnalytics();
    a.track("game_open", { sport: "football" }, "nfl");
    a.track("follow", { kind: "competition" }, "nba");
    vi.advanceTimersByTime(9_999);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    const [batch] = sent;
    expect(batch!.events.map((e) => [e.name, e.league])).toEqual([["game_open", "nfl"], ["follow", "nba"]]);
    expect(batch!.anon).toMatch(/^[a-f0-9]{32}$/);
    expect(batch!.session).toMatch(/^[a-f0-9]{32}$/);
    expect(batch!.anon).not.toBe(batch!.session);
    // Nothing queued, nothing scheduled.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("flushes at once on pagehide and when the tab hides", async () => {
    const { a } = await load();
    a.startAnalytics();
    a.track("theme", { theme: "dark" });
    win.dispatchEvent(new Event("pagehide"));
    expect(sent).toHaveLength(1);
    a.track("theme", { theme: "light" });
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(sent).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends at most 50 events a batch", async () => {
    const { a } = await load();
    a.startAnalytics();
    for (let i = 0; i < 120; i++) a.track("setting_change", { key: `k${i}` });
    a.flush();
    expect(sent.map((b) => b.events.length)).toEqual([50, 50, 20]);
  });

  it("records page views by route pattern, never the URL's IDs, and keeps the first one from before it starts", async () => {
    const { a } = await load({ referrer: "https://news.ycombinator.com/item?id=1", search: "?analytics&utm_source=hn" });
    const router = fakeRouter(routerState("/", ["/", undefined]));
    a.trackRoutes(router);
    a.startAnalytics();
    router.go({ ...routerState("/game/espn-401772981", ["/", "game/:id"], "?league=nfl"), navigation: { state: "loading" } });
    router.go(routerState("/game/espn-401772981", ["/", "game/:id"], "?league=nfl"));
    router.go(routerState("/game/espn-401772981", ["/", "game/:id"], "?league=nfl")); // a revalidation: the same page
    router.go(routerState("/schedule/team/espn-football-12", ["/", "schedule/team/:teamID"]));
    router.go(routerState("/nope/98765", ["/", "*"]));
    a.track("theme", { theme: "dark" });
    a.flush();
    const events = sent.flatMap((b) => b.events);
    expect(events.filter((e) => e.name === "page_view").map((e) => [e.path, e.league])).toEqual([
      ["/", undefined],
      ["/game/:id", "nfl"],
      ["/schedule/team/:teamID", undefined],
      ["/*", undefined],
    ]);
    // Every event says where it happened; none carries an ID from the URL.
    expect(events.at(-1)!.path).toBe("/*");
    expect(JSON.stringify(events.map((e) => [e.path, e.league, e.props]))).not.toMatch(/401772981|espn-football-12|nope/);
    // The visit's first event says where it came from.
    expect(events[0]).toMatchObject({ ref: "news.ycombinator.com", utm: { source: "hn" } });
    expect(events[1]!.ref).toBeUndefined();
  });

  it("does nothing in development without ?analytics", async () => {
    const { a } = await load({ search: "" });
    a.track("theme", { theme: "dark" });
    a.startAnalytics();
    a.track("theme", { theme: "light" });
    a.flush();
    win.dispatchEvent(new Event("pagehide"));
    expect(sent).toHaveLength(0);
  });

  it("under Global Privacy Control, sends events with no anonymous or session ID and stores none", async () => {
    const { a } = await load({ gpc: true });
    a.startAnalytics();
    a.track("theme", { theme: "dark" });
    a.flush();
    expect(sent[0]!.anon).toBeUndefined();
    expect(sent[0]!.session).toBeUndefined();
    expect(localStorage.getItem("scoreline.anon")).toBeNull();
  });
});

describe("setting events", () => {
  it("tells follows by league, a setting once a visit by its key and never its value, and the theme", async () => {
    const { a, settings } = await load();
    a.startAnalytics();
    settings.settings.setEnabled("nba", true);
    settings.settings.setEnabled("nba", false);
    settings.settings.toggleFollow({ id: "espn-soccer-359", name: "Arsenal", logo: null });
    settings.settings.set("odds", false);
    settings.settings.set("odds", true);
    settings.settings.set("coStreamer", "someone");
    settings.settings.set("theme", "dark");
    a.flush();
    const events = sent.flatMap((b) => b.events).map((e) => [e.name, e.league ?? null, e.props ?? null]);
    expect(events).toEqual([
      ["follow", "nba", { kind: "competition" }],
      ["unfollow", "nba", { kind: "competition" }],
      ["follow", null, { kind: "team", sport: "soccer" }],
      ["setting_change", null, { key: "odds" }],
      ["setting_change", null, { key: "coStreamer" }],
      ["theme", null, { theme: "dark" }],
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/Arsenal|someone/);
  });
});

describe("errors", () => {
  it("reports uncaught errors and rejections once a visit per message, with the stack", async () => {
    const { a } = await load();
    a.startAnalytics();
    const boom = new TypeError("x is undefined");
    for (let i = 0; i < 3; i++) win.dispatchEvent(Object.assign(new Event("error"), { error: boom, message: boom.message }));
    win.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "timed out" }));
    win.dispatchEvent(Object.assign(new Event("error"), { error: null, message: "Script error." }));
    a.trackError(new Error("from the route"));
    a.flush();
    const errors = sent.flatMap((b) => b.events);
    expect(errors.map((e) => [e.name, e.message])).toEqual([
      ["error", "TypeError: x is undefined"],
      ["error", "timed out"],
      ["error", "Error: from the route"],
    ]);
    expect(errors[0]!.stack).toContain("x is undefined");
  });
});
