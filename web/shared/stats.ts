/**
 * The owner's numbers: the SQL behind `GET /api/admin/stats` (worker/analytics.ts)
 * and `pnpm stats` (scripts/stats.mjs), and the one shape both report.
 * The queries run against D1 as written, in one batch, over the events and
 * client_errors tables (migrations/0100_analytics.sql) and Better Auth's
 * `user` table (its default names: `id`, `email`, `createdAt`).
 *
 * Windows are in UTC days: "30 days" is today and the 29 before it.
 *
 * No imports: `scripts/stats.mjs` loads this file with Node's type stripping.
 */

/**
 * The sign-up day of a Better Auth user. Its Kysely adapter (and so D1)
 * writes SQLite dates as ISO strings; other adapters write epoch seconds or
 * milliseconds. All three read as a UTC day.
 */
const SIGNUP_DAY = `(CASE WHEN typeof("createdAt") IN ('integer', 'real') THEN date("createdAt" / (CASE WHEN "createdAt" > 100000000000 THEN 1000 ELSE 1 END), 'unixepoch') ELSE date("createdAt") END)`;
const IN_WINDOW = `day >= date('now', '-29 days')`;

/** Named queries, run in this order. */
export const STATS_QUERIES = {
  users: `SELECT COUNT(*) AS n FROM "user"`,
  signups: `SELECT ${SIGNUP_DAY} AS day, COUNT(*) AS n FROM "user" WHERE ${SIGNUP_DAY} >= date('now', '-29 days') GROUP BY 1 ORDER BY 1`,
  active: `SELECT COUNT(DISTINCT CASE WHEN day = date('now') THEN user_id END) AS dau, COUNT(DISTINCT CASE WHEN day >= date('now', '-6 days') THEN user_id END) AS wau, COUNT(DISTINCT user_id) AS mau FROM events WHERE ${IN_WINDOW} AND user_id IS NOT NULL`,
  activeByDay: `SELECT day, COUNT(DISTINCT user_id) AS n FROM events WHERE ${IN_WINDOW} AND user_id IS NOT NULL GROUP BY day ORDER BY day`,
  landings: `SELECT day, COUNT(*) AS n FROM events WHERE name = 'landing_view' AND ${IN_WINDOW} GROUP BY day ORDER BY day`,
  referrers: `SELECT referrer_host AS key, COUNT(*) AS n FROM events WHERE ${IN_WINDOW} AND referrer_host IS NOT NULL GROUP BY 1 ORDER BY n DESC, key LIMIT 10`,
  campaigns: `SELECT COALESCE(utm_source, '') AS source, COALESCE(utm_medium, '') AS medium, COALESCE(utm_campaign, '') AS campaign, COUNT(*) AS n FROM events WHERE ${IN_WINDOW} AND (utm_source IS NOT NULL OR utm_medium IS NOT NULL OR utm_campaign IS NOT NULL) GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 10`,
  leagues: `SELECT league AS key, COUNT(*) AS n FROM events WHERE name = 'game_open' AND ${IN_WINDOW} AND league IS NOT NULL GROUP BY 1 ORDER BY n DESC, key LIMIT 12`,
  routes: `SELECT path AS key, COUNT(*) AS n FROM events WHERE name = 'page_view' AND ${IN_WINDOW} AND path IS NOT NULL GROUP BY 1 ORDER BY n DESC, key LIMIT 12`,
  devices: `SELECT device AS key, COUNT(*) AS n FROM events WHERE name IN ('page_view', 'landing_view') AND ${IN_WINDOW} AND device IS NOT NULL GROUP BY 1 ORDER BY n DESC`,
  countries: `SELECT country AS key, COUNT(*) AS n FROM events WHERE name IN ('page_view', 'landing_view') AND ${IN_WINDOW} AND country IS NOT NULL GROUP BY 1 ORDER BY n DESC, key LIMIT 12`,
  // Sign-up cohorts from 36 days back, so day 7 is measurable for 30 of them.
  retention: `WITH cohort AS (SELECT id, ${SIGNUP_DAY} AS d FROM "user" WHERE ${SIGNUP_DAY} >= date('now', '-36 days')) SELECT d AS day, COUNT(*) AS users, SUM(EXISTS (SELECT 1 FROM events e WHERE e.user_id = cohort.id AND e.day = date(cohort.d, '+1 day'))) AS d1, SUM(EXISTS (SELECT 1 FROM events e WHERE e.user_id = cohort.id AND e.day = date(cohort.d, '+7 days'))) AS d7 FROM cohort GROUP BY d ORDER BY d`,
  // SQLite takes the bare columns from the row with MAX(ts): the latest message, path and release.
  errors: `SELECT message, path, release, stack, SUM(count) AS count, MAX(ts) AS lastSeen FROM client_errors WHERE day >= date('now', '-6 days') GROUP BY hash ORDER BY count DESC, lastSeen DESC LIMIT 20`,
} as const;

export type StatsQuery = keyof typeof STATS_QUERIES;
export type Row = Readonly<Record<string, unknown>>;

export interface DayCount {
  readonly day: string;
  readonly n: number;
}
export interface KeyCount {
  readonly key: string;
  readonly n: number;
}
export interface Campaign {
  readonly source: string;
  readonly medium: string;
  readonly campaign: string;
  readonly n: number;
}
export interface Cohort {
  readonly day: string;
  readonly users: number;
  readonly d1: number;
  readonly d7: number;
}
export interface ClientError {
  readonly message: string;
  readonly path: string | null;
  readonly release: string | null;
  readonly stack: string | null;
  readonly count: number;
  readonly lastSeen: number;
}

export interface Stats {
  readonly generatedAt: string;
  readonly totals: {
    readonly users: number;
    readonly signups30d: number;
    readonly dau: number;
    readonly wau: number;
    readonly mau: number;
    readonly landings30d: number;
    /** Sign-ups over landing views, 30 days; null with no landing views. */
    readonly conversion: number | null;
  };
  /** 30 days each, oldest first, with empty days as zeros. */
  readonly signupsByDay: readonly DayCount[];
  readonly activeByDay: readonly DayCount[];
  readonly landingsByDay: readonly DayCount[];
  readonly referrers: readonly KeyCount[];
  readonly campaigns: readonly Campaign[];
  readonly leagues: readonly KeyCount[];
  readonly routes: readonly KeyCount[];
  readonly devices: readonly KeyCount[];
  readonly countries: readonly KeyCount[];
  readonly retention: {
    readonly cohorts: readonly Cohort[];
    /** Of the cohorts old enough to tell (a day for d1, a week for d7), the share back that day. */
    readonly d1: number | null;
    readonly d7: number | null;
  };
  readonly errors: readonly ClientError[];
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const str = (v: unknown): string => (v == null ? "" : String(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

/** The UTC day `offset` days from `now`. */
export function utcDay(now: number, offset = 0): string {
  return new Date(now + offset * 86_400_000).toISOString().slice(0, 10);
}

function days(rows: readonly Row[] | undefined, now: number): DayCount[] {
  const byDay = new Map((rows ?? []).map((r) => [str(r.day), num(r.n)]));
  return Array.from({ length: 30 }, (_, i) => {
    const day = utcDay(now, i - 29);
    return { day, n: byDay.get(day) ?? 0 };
  });
}

const keys = (rows: readonly Row[] | undefined): KeyCount[] => (rows ?? []).map((r) => ({ key: str(r.key), n: num(r.n) }));
const sum = (list: readonly { n: number }[]) => list.reduce((total, d) => total + d.n, 0);

function rate(cohorts: readonly Cohort[], last: string, pick: (c: Cohort) => number): number | null {
  const eligible = cohorts.filter((c) => c.day <= last);
  const users = eligible.reduce((total, c) => total + c.users, 0);
  return users === 0 ? null : eligible.reduce((total, c) => total + pick(c), 0) / users;
}

/** The queries' rows (by name, as D1 returns them) as the report. */
export function shapeStats(rows: Partial<Record<StatsQuery, readonly Row[]>>, now = Date.now()): Stats {
  const signupsByDay = days(rows.signups, now);
  const landingsByDay = days(rows.landings, now);
  const active = rows.active?.[0] ?? {};
  const cohorts = (rows.retention ?? []).map((r) => ({ day: str(r.day), users: num(r.users), d1: num(r.d1), d7: num(r.d7) }));
  const signups30d = sum(signupsByDay);
  const landings30d = sum(landingsByDay);
  return {
    generatedAt: new Date(now).toISOString(),
    totals: {
      users: num(rows.users?.[0]?.n),
      signups30d,
      dau: num(active.dau),
      wau: num(active.wau),
      mau: num(active.mau),
      landings30d,
      conversion: landings30d === 0 ? null : signups30d / landings30d,
    },
    signupsByDay,
    activeByDay: days(rows.activeByDay, now),
    landingsByDay,
    referrers: keys(rows.referrers),
    campaigns: (rows.campaigns ?? []).map((r) => ({ source: str(r.source), medium: str(r.medium), campaign: str(r.campaign), n: num(r.n) })),
    leagues: keys(rows.leagues),
    routes: keys(rows.routes),
    devices: keys(rows.devices),
    countries: keys(rows.countries),
    retention: {
      cohorts,
      d1: rate(cohorts, utcDay(now, -1), (c) => c.d1),
      d7: rate(cohorts, utcDay(now, -7), (c) => c.d7),
    },
    errors: (rows.errors ?? []).map((r) => ({
      message: str(r.message),
      path: strOrNull(r.path),
      release: strOrNull(r.release),
      stack: strOrNull(r.stack),
      count: num(r.count),
      lastSeen: num(r.lastSeen),
    })),
  };
}
