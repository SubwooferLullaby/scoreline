/**
 * First-party analytics in the browser (ARCHITECTURE.md § Analytics): a
 * queue of small events, sent to our own Worker (`POST /api/t`,
 * worker/analytics.ts) and nowhere else. No dependencies, no cookies.
 *
 *     track("game_open", { sport: "football" }, "nfl");
 *
 * The queue flushes 10 s after its first event, and at once when the tab
 * hides or the page goes away (`sendBeacon`, else `fetch` with keepalive).
 * No timer runs while nothing is queued.
 *
 * Paths are route patterns from React Router ("/game/:id"), never the URL,
 * so no game, team or player ID is recorded. A browser sending Global
 * Privacy Control or Do Not Track gets no anonymous or session ID (and the
 * Worker drops the user's). Off in development unless the URL has `?analytics`.
 */
import { INGEST_PATH, MAX_BATCH, MAX_MESSAGE, MAX_STACK, type EventName, type WireBatch, type WireEvent } from "../../shared/analytics";
import { subscribeSettingChanges, type Settings } from "./settings";

/** The build's version (vite.config.ts: `git describe`). */
declare const __RELEASE__: string | undefined;

type Props = Record<string, string | number | boolean>;

const FLUSH_MS = 10_000;
const MAX_ERRORS = 10;

/** Undecided (null) until `startAnalytics`: what's tracked before it (the first page view) waits in the queue. */
let on: boolean | null = null;
let queue: WireEvent[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let ids: { anon?: string; session?: string } = {};
/** The route pattern on screen: every event says where it happened. */
let path: string | undefined;
let first = true;
const changed = new Set<string>();
const reported = new Set<string>();

/** A random ID kept in storage (the browser's for `anon`, the tab's for `session`), or none if storage is blocked. */
function stored(storage: () => Storage, key: string): string | undefined {
  try {
    const s = storage();
    let id = s.getItem(key);
    if (!id) s.setItem(key, (id = crypto.randomUUID().replace(/-/g, "")));
    return id;
  } catch {
    return undefined;
  }
}

/** Where the visit came from, on its first event: the referrer's host and the URL's UTM tags. */
function arrival(): Partial<WireEvent> {
  const query = new URLSearchParams(location.search);
  const utm = { source: query.get("utm_source") ?? undefined, medium: query.get("utm_medium") ?? undefined, campaign: query.get("utm_campaign") ?? undefined };
  let ref: string | undefined;
  try {
    const host = document.referrer && new URL(document.referrer).host;
    if (host && host !== location.host) ref = host;
  } catch {
    // No referrer, or not a URL.
  }
  return { ref, ...(utm.source || utm.medium || utm.campaign ? { utm } : {}) };
}

/** Queues an event. `league` is a league ID ("nfl"); `props` stay small and never hold what someone typed. */
export function track(name: EventName, props?: Props, league?: string | null, extra?: Partial<WireEvent>): void {
  if (on === false) return;
  queue.push({ name, ts: Date.now(), path, league: league ?? undefined, props, ...(first ? arrival() : null), ...extra });
  first = false;
  if (on) timer ??= setTimeout(flush, FLUSH_MS);
}

/** Sends everything queued, in batches the Worker accepts. */
export function flush(): void {
  clearTimeout(timer);
  timer = undefined;
  while (on && queue.length > 0) {
    const batch: WireBatch = { ...ids, release: typeof __RELEASE__ === "string" ? __RELEASE__ : undefined, events: queue.splice(0, MAX_BATCH) };
    const body = JSON.stringify(batch);
    if (!navigator.sendBeacon?.(INGEST_PATH, body)) void fetch(INGEST_PATH, { method: "POST", body, keepalive: true }).catch(() => {});
  }
}

/** An uncaught error, a rejection or a page's error state: each message once a visit, ten at most. */
export function trackError(error: unknown): void {
  const e = error instanceof Error ? error : null;
  const message = (e ? `${e.name}: ${e.message}` : String(error)).slice(0, MAX_MESSAGE);
  // Cross-origin scripts' opaque errors and ResizeObserver's benign loop notice say nothing.
  if (on === false || reported.size >= MAX_ERRORS || reported.has(message) || /^Script error|ResizeObserver loop/.test(message)) return;
  reported.add(message);
  track("error", undefined, null, { message, stack: e?.stack?.slice(0, MAX_STACK) });
}

// MARK: - Routes

interface RouteState {
  readonly location: { readonly pathname: string; readonly search: string };
  readonly matches: readonly { readonly route: { readonly path?: string } }[];
  readonly navigation: { readonly state: string };
}

/** The matched routes' patterns joined: "/game/:id", "/schedule/:scope?", "/" for the index, "/*" for not found. */
export function routePattern(matches: RouteState["matches"]): string {
  return `/${matches.flatMap((m) => m.route.path?.replace(/^\/+|\/+$/g, "") || []).join("/")}`;
}

/** A `page_view` for each page settled on (React Router's data router). A game's carries its league when the URL says. */
export function trackRoutes(router: { readonly state: RouteState; subscribe(listener: (state: RouteState) => void): unknown }): void {
  let last: string | undefined;
  const record = (state: RouteState) => {
    if (state.navigation.state !== "idle" || state.location.pathname === last) return;
    last = state.location.pathname;
    path = routePattern(state.matches);
    track("page_view", undefined, path === "/game/:id" ? new URLSearchParams(state.location.search).get("league") : null);
  };
  record(router.state);
  router.subscribe(record);
}

// MARK: - Settings

/** A followed team's sport, from its ID ("espn-soccer-359", "cs-667"). */
const teamSport = (id: string) => (id.startsWith("cs-") ? "esports" : /^espn-([a-z]+)-/.exec(id)?.[1]);

/**
 * Follows and unfollows (a competition by its league ID; a team by its
 * sport, never its name), the theme, and any other setting once a visit as
 * `setting_change { key }`, never its value.
 */
function settingsChanged(before: Settings, after: Settings): void {
  for (const key of Object.keys(after) as (keyof Settings)[]) {
    const was = before[key];
    const is = after[key];
    // Actions rebuild lists they don't change (a follow refilters `mutedTeams`): only a different list counts.
    if (was === is || (Array.isArray(was) && Array.isArray(is) && was.length === is.length && was.every((x, i) => x === is[i]))) continue;
    if (key === "theme") {
      track("theme", { theme: after.theme });
      continue;
    }
    if (key === "enabledLeagues" || key === "followed") {
      const from = key === "followed" ? before.followed.map((t) => t.id) : before.enabledLeagues;
      const to = key === "followed" ? after.followed.map((t) => t.id) : after.enabledLeagues;
      const follow = (name: EventName, id: string) =>
        key === "followed" ? track(name, { kind: "team", ...(teamSport(id) ? { sport: teamSport(id)! } : null) }) : track(name, { kind: "competition" }, id);
      for (const id of to) if (!from.includes(id)) follow("follow", id);
      for (const id of from) if (!to.includes(id)) follow("unfollow", id);
      if (from.length !== to.length) continue;
    }
    if (!changed.has(key)) {
      changed.add(key);
      track("setting_change", { key });
    }
  }
}

// MARK: - Start

/** Starts the queue and its listeners (main.tsx, before the app renders, so early errors count). */
export function startAnalytics(): void {
  if (on != null) return;
  on = import.meta.env.PROD || /[?&]analytics\b/.test(location.search);
  if (!on) {
    queue = [];
    return;
  }
  if (queue.length > 0) timer = setTimeout(flush, FLUSH_MS);
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (nav.globalPrivacyControl !== true && nav.doNotTrack !== "1") {
    ids = { anon: stored(() => localStorage, "scoreline.anon"), session: stored(() => sessionStorage, "scoreline.session") };
  }
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  window.addEventListener("error", (event) => trackError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => trackError(event.reason));
  subscribeSettingChanges(settingsChanged);
}
