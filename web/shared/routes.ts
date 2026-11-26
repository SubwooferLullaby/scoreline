/**
 * The app's routes as the Worker sees them, and the one rule for where a
 * sign-in may send you next. Shared by the gate (worker/gate.ts), the landing
 * page's script (src/landing/landing.ts) and the app. Pure TypeScript: no
 * DOM, no Workers types.
 *
 * `APP_SECTIONS` is each app route's first path segment (src/app/App.tsx):
 * `/game/123` is the app, `/privacy` is a page of its own, `/wp-login.php`
 * is the plain 404. `test/unit/gate.test.ts` checks the list against the
 * router's routes, so a new page can't be left out of the gate.
 */

/** First path segments of the app's routes (src/app/App.tsx), besides `/` itself. */
export const APP_SECTIONS: readonly string[] = [
  "game",
  "sports",
  "following",
  "settings",
  "schedule",
  "results",
  "standings",
  "rankings",
  "competition",
  "bracket",
  "team",
  "player",
  "admin",
];

/** Development only: the render harnesses (`/dev/theater`, `/dev/odds`). */
export const DEV_SECTIONS: readonly string[] = ["dev"];

/** The public pages, served to anyone in the landing's style. */
export const PUBLIC_PAGES = ["privacy", "terms"] as const;
export type PublicPage = (typeof PUBLIC_PAGES)[number];

/** Whether a path is one of the app's routes (`/`, `/game/123`, `/settings/`). */
export function isAppPath(pathname: string, dev = false): boolean {
  if (pathname === "/") return true;
  const first = pathname.split("/")[1] ?? "";
  return APP_SECTIONS.includes(first) || (dev && DEV_SECTIONS.includes(first));
}

/** `/privacy` → "privacy" (a trailing slash allowed); anything else null. */
export function publicPage(pathname: string): PublicPage | null {
  const name = pathname.replace(/^\/|\/$/g, "");
  return (PUBLIC_PAGES as readonly string[]).includes(name) ? (name as PublicPage) : null;
}

const BASE = "https://scoreline.invalid";

/**
 * Where a sign-in may land you: a path on this origin, never another site
 * (`//evil.example`, `https://…`, `/\evil.example`, which browsers read as
 * `//`), never the API. Returns the path with its query and hash, or null.
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  // Backslashes and control characters: browsers normalize them into other URLs.
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  const path = url.pathname + url.search + url.hash;
  if (path === "/api" || path.startsWith("/api/")) return null;
  return path;
}

/** The landing with the route to come back to: `/?next=%2Fgame%2F123`, or `/` for the root itself. */
export function signInURL(pathAndQuery: string): string {
  const next = safeNext(pathAndQuery);
  return next && next !== "/" ? `/?next=${encodeURIComponent(next)}` : "/";
}
