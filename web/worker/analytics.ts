/**
 * First-party analytics in the Worker (ARCHITECTURE.md § Analytics): the
 * ingest at `POST /api/t`, the landing page's visit count, and the owner's
 * numbers at `GET /api/admin/stats`. Everything lands in D1 (`DB`,
 * migrations/0100_analytics.sql); nothing goes to a third party.
 *
 * The promise the privacy page repeats: no IP addresses and no user agents
 * are stored (country comes from the edge, the device is a class, the
 * referrer is a host); a browser sending Global Privacy Control or Do Not
 * Track is counted only in aggregate, with no anonymous, session or user ID.
 *
 * Who is asking comes from the accounts layer as a `CurrentUser` (the
 * session's user, or null); this module never reads cookies itself.
 */
import { EVENT_NAMES, MAX_BATCH, MAX_BODY_BYTES, MAX_MESSAGE, MAX_STACK, SIGNED_OUT_EVENTS } from "../shared/analytics";
import { STATS_QUERIES, shapeStats, utcDay, type Row, type StatsQuery } from "../shared/stats";

/** The signed-in user, from the accounts layer (worker/auth.ts' session), or null. */
export type CurrentUser = { readonly id: string; readonly email?: string | null; readonly emailVerified?: boolean | null } | null;

/** What this module needs of the Worker's env (cloudflare.config.ts). */
export interface AnalyticsEnv {
  readonly DB: D1Database;
  /** Comma-separated; a secret set at deploy time, never in the repo. */
  readonly ADMIN_EMAILS?: string;
  readonly ADMIN_USER_IDS?: string;
}

type Device = "phone" | "tablet" | "desktop";

interface EventRow {
  ts: number;
  day: string;
  user_id: string | null;
  anon_id: string | null;
  session_id: string | null;
  name: string;
  path: string | null;
  league: string | null;
  props: string | null;
  country: string | null;
  device: Device;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
}

interface ErrorRow {
  day: string;
  ts: number;
  user_id: string | null;
  message: string;
  stack: string | null;
  path: string | null;
  release: string | null;
}

const NAMES = new Set<string>(EVENT_NAMES);
const SIGNED_OUT = new Set<string>(SIGNED_OUT_EVENTS);

const ID = /^[A-Za-z0-9_-]{8,40}$/;
/** A route pattern: literal segments of letters and dashes, `:params`, a splat. No digits, so no raw IDs. */
const SEGMENT = String.raw`(?:[a-z-]+|:[A-Za-z]+\??|\*)`;
const PATH = new RegExp(String.raw`^\/(?:${SEGMENT}(?:\/${SEGMENT})*)?$`);
const LEAGUE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const PROP_KEY = /^[a-z][A-Za-z0-9_]{0,23}$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const TAG = /^[\w .:+-]{1,64}$/;
const RELEASE = /^[\w.+-]{1,40}$/;
const COUNTRY = /^[A-Z0-9]{2}$/;
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|headless|lighthouse/i;

const MAX_PROPS = 8;
const MAX_PROP_VALUE = 64;
const MAX_PROPS_JSON = 512;

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
/** The ingest's only answer: whatever was dropped, the client never hears of it. */
const accepted = () => new Response(null, { status: 204, headers: NO_STORE });

// MARK: - Reading the request

/** Phone, tablet or desktop, from the client hint or the user agent (which is read here and never kept). */
export function deviceClass(headers: Headers): Device {
  const ua = headers.get("User-Agent") ?? "";
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (headers.get("Sec-CH-UA-Mobile") === "?1" || /Mobi|iPhone|iPod|Android/i.test(ua)) return "phone";
  return "desktop";
}

/** Global Privacy Control or Do Not Track: counted, never identified. */
export function optedOut(headers: Headers): boolean {
  return headers.get("Sec-GPC") === "1" || headers.get("DNT") === "1";
}

function country(request: Request): string | null {
  const value = (request as { cf?: { country?: unknown } }).cf?.country;
  return typeof value === "string" && COUNTRY.test(value) ? value : null;
}

/** A referrer's host, lowercased; null for this site's own pages or anything that isn't a host. */
function refHost(raw: unknown, self: string): string | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  let host = raw.toLowerCase();
  if (host.includes("/")) {
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  host = host.replace(/^www\./, "");
  return host.length <= 100 && HOST.test(host) && host !== self.toLowerCase().replace(/^www\./, "") ? host : null;
}

const tag = (v: unknown): string | null => (typeof v === "string" && TAG.test(v) ? v.toLowerCase() : null);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

function props(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kept: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= MAX_PROPS || !PROP_KEY.test(key)) continue;
    if ((typeof value === "string" && value.length <= MAX_PROP_VALUE) || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      kept[key] = value;
      n++;
    }
  }
  if (n === 0) return null;
  const json = JSON.stringify(kept);
  return json.length <= MAX_PROPS_JSON ? json : null;
}

/** The client's clock if it's close to ours (the queue holds events up to 10 s), else ours. */
const eventTime = (ts: unknown, now: number) => (typeof ts === "number" && ts > now - 10 * 60_000 && ts < now + 60_000 ? Math.round(ts) : now);

// MARK: - Rate limit

// Best effort, per isolate: a browser flushes at most every 10 s and when it's
// hidden, so 30 batches a minute is far past honest use. The batch cap
// (MAX_BATCH events, MAX_BODY_BYTES) bounds what any one request can write.
const WINDOW_MS = 60_000;
const PER_WINDOW = 30;
const windows = new Map<string, { start: number; count: number }>();

function allow(key: string | null, now: number): boolean {
  if (!key) return true;
  const entry = windows.get(key);
  if (!entry || now - entry.start > WINDOW_MS) {
    if (windows.size > 10_000) windows.clear();
    windows.set(key, { start: now, count: 1 });
    return true;
  }
  return ++entry.count <= PER_WINDOW;
}

// MARK: - Writing

const INSERT_EVENT = `INSERT INTO events (ts, day, user_id, anon_id, session_id, name, path, league, props, country, device, referrer_host, utm_source, utm_medium, utm_campaign) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const UPSERT_ERROR = `INSERT INTO client_errors (day, hash, ts, user_id, message, stack, path, release, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT (day, hash) DO UPDATE SET count = client_errors.count + 1, ts = excluded.ts, user_id = COALESCE(excluded.user_id, client_errors.user_id),
  stack = excluded.stack, path = excluded.path, release = excluded.release`;

/** The first line of a stack that is a frame ("at f (file:1:2)", "f@file:1:2"). */
function topFrame(stack: string | null): string {
  for (const line of (stack ?? "").split("\n")) {
    const frame = line.trim();
    if (/^at\s|@|:\d+:\d+\)?$/.test(frame)) return frame;
  }
  return "";
}

async function errorHash(message: string, stack: string | null): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${message}\n${topFrame(stack)}`));
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function write(db: D1Database, events: readonly EventRow[], errors: readonly ErrorRow[]): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (events.length > 0) {
    const insert = db.prepare(INSERT_EVENT);
    for (const e of events) {
      statements.push(insert.bind(e.ts, e.day, e.user_id, e.anon_id, e.session_id, e.name, e.path, e.league, e.props, e.country, e.device, e.referrer_host, e.utm_source, e.utm_medium, e.utm_campaign));
    }
  }
  if (errors.length > 0) {
    const upsert = db.prepare(UPSERT_ERROR);
    for (const e of errors) statements.push(upsert.bind(e.day, await errorHash(e.message, e.stack), e.ts, e.user_id, e.message, e.stack, e.path, e.release));
  }
  if (statements.length > 0) await db.batch(statements);
}

const logFailure = (where: string) => (error: unknown) => console.error(JSON.stringify({ analytics: where, error: String(error) }));

// MARK: - POST /api/t

/** What a batch writes: its event rows and its error rows. Pure, for the tests and the ingest. */
export function readBatch(body: unknown, request: Request, user: CurrentUser, now = Date.now()): { events: EventRow[]; errors: ErrorRow[] } {
  const events: EventRow[] = [];
  const errors: ErrorRow[] = [];
  if (!body || typeof body !== "object") return { events, errors };
  const batch = body as Record<string, unknown>;
  if (!Array.isArray(batch.events)) return { events, errors };

  const anonymous = optedOut(request.headers);
  const anon = !anonymous && typeof batch.anon === "string" && ID.test(batch.anon) ? batch.anon : null;
  const session = !anonymous && typeof batch.session === "string" && ID.test(batch.session) ? batch.session : null;
  const userID = !anonymous && user ? user.id : null;
  const release = typeof batch.release === "string" && RELEASE.test(batch.release) ? batch.release : null;
  const base = { country: country(request), device: deviceClass(request.headers) };
  const self = new URL(request.url).hostname;

  for (const raw of batch.events.slice(0, MAX_BATCH)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.name !== "string" || !NAMES.has(e.name)) continue;
    if (!user && !SIGNED_OUT.has(e.name)) continue;
    const ts = eventTime(e.ts, now);
    const path = typeof e.path === "string" && e.path.length <= 64 && PATH.test(e.path) ? e.path : null;

    if (e.name === "error") {
      const message = text(e.message, MAX_MESSAGE);
      if (message) errors.push({ day: utcDay(ts), ts, user_id: userID, message, stack: text(e.stack, MAX_STACK), path, release });
      continue;
    }
    const utm = e.utm && typeof e.utm === "object" ? (e.utm as Record<string, unknown>) : {};
    events.push({
      ts,
      day: utcDay(ts),
      user_id: userID,
      anon_id: anon,
      session_id: session,
      name: e.name,
      path,
      league: typeof e.league === "string" && LEAGUE.test(e.league) ? e.league : null,
      props: props(e.props),
      ...base,
      referrer_host: refHost(e.ref, self),
      utm_source: tag(utm.source),
      utm_medium: tag(utm.medium),
      utm_campaign: tag(utm.campaign),
    });
  }
  return { events, errors };
}

/**
 * `POST /api/t`: a batch of up to MAX_BATCH events, from `sendBeacon` or
 * `fetch` with keepalive. Always 204: an invalid event, an oversized body or
 * a cross-site post is dropped without telling the client. The write runs
 * after the answer (`ctx.waitUntil`), in one D1 batch.
 */
export async function ingest(request: Request, env: AnalyticsEnv, ctx: ExecutionContext, user: CurrentUser): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin") return accepted();
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY_BYTES) return accepted();

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return accepted();
    body = JSON.parse(raw);
  } catch {
    return accepted();
  }

  const now = Date.now();
  const anon = body && typeof body === "object" ? (body as { anon?: unknown }).anon : null;
  if (!allow(user?.id ?? (typeof anon === "string" ? anon : null), now)) return accepted();

  const { events, errors } = readBatch(body, request, user, now);
  if (events.length > 0 || errors.length > 0) ctx.waitUntil(write(env.DB, events, errors).catch(logFailure("ingest")));
  return accepted();
}

// MARK: - The landing page

/**
 * Counts a visit to the landing page (the Worker calls it as it serves `/`
 * to someone signed out). Referrer host only, UTM tags from the URL, the
 * edge's country, the device class. Crawlers, link previews and prefetches
 * aren't visits. The write runs after the answer.
 */
export function recordLandingView(request: Request, env: AnalyticsEnv, ctx: ExecutionContext): void {
  if (request.method !== "GET" || BOT.test(request.headers.get("User-Agent") ?? "")) return;
  const purpose = request.headers.get("Sec-Purpose") ?? request.headers.get("Purpose") ?? "";
  if (purpose.includes("prefetch")) return;
  const url = new URL(request.url);
  const now = Date.now();
  const row: EventRow = {
    ts: now,
    day: utcDay(now),
    user_id: null,
    anon_id: null,
    session_id: null,
    name: "landing_view",
    path: "/",
    league: null,
    props: null,
    country: country(request),
    device: deviceClass(request.headers),
    referrer_host: refHost(request.headers.get("Referer"), url.hostname),
    utm_source: tag(url.searchParams.get("utm_source")),
    utm_medium: tag(url.searchParams.get("utm_medium")),
    utm_campaign: tag(url.searchParams.get("utm_campaign")),
  };
  ctx.waitUntil(write(env.DB, [row], []).catch(logFailure("landing")));
}

// MARK: - GET /api/admin/stats

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/** An owner's account: its ID in ADMIN_USER_IDS, or its email (unless the session says it's unverified) in ADMIN_EMAILS. */
export function isAdmin(user: CurrentUser, env: Pick<AnalyticsEnv, "ADMIN_EMAILS" | "ADMIN_USER_IDS">): boolean {
  if (!user) return false;
  if (list(env.ADMIN_USER_IDS).includes(user.id.toLowerCase())) return true;
  return !!user.email && user.emailVerified !== false && list(env.ADMIN_EMAILS).includes(user.email.trim().toLowerCase());
}

/** Runs every stats query in one D1 batch and shapes the report. */
export async function queryStats(db: D1Database, now = Date.now()) {
  const names = Object.keys(STATS_QUERIES) as StatsQuery[];
  const results = await db.batch<Row>(names.map((name) => db.prepare(STATS_QUERIES[name])));
  return shapeStats(Object.fromEntries(names.map((name, i) => [name, results[i]?.results ?? []])), now);
}

/**
 * `GET /api/admin/stats`: the owner's numbers (shared/stats.ts), for admins
 * only (401 signed out, 403 otherwise). `?probe` answers `{ admin }` with a
 * 200 and runs nothing: Settings asks it to decide whether to show the link.
 */
export async function adminStats(request: Request, env: AnalyticsEnv, user: CurrentUser): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...NO_STORE, Allow: "GET" } });
  const admin = isAdmin(user, env);
  if (new URL(request.url).searchParams.has("probe")) return Response.json({ admin }, { headers: NO_STORE });
  if (!user) return Response.json({ error: { status: 401, message: "Sign in to see this." } }, { status: 401, headers: NO_STORE });
  if (!admin) return Response.json({ error: { status: 403, message: "Admins only." } }, { status: 403, headers: NO_STORE });
  try {
    return Response.json(await queryStats(env.DB), { headers: NO_STORE });
  } catch (error) {
    logFailure("stats")(error);
    return Response.json({ error: { status: 500, message: "The stats couldn't be read." } }, { status: 500, headers: NO_STORE });
  }
}
