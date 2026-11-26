/**
 * The gate: what a page request gets, decided before any HTML goes out
 * (docs/LAUNCH.md). Pure, so every case is a unit test
 * (test/worker/gate.test.ts); worker/index.ts serves the decision.
 *
 * Signed out (with `REQUIRE_SIGN_IN` on):
 * - `/` is the landing page; `/privacy` and `/terms` are public;
 * - any other app route sends you to `/?next=<path>`, so you land on it once
 *   you sign in (same-origin paths only: shared/routes.ts `safeNext`);
 * - `/api/*` answers 401 (worker/index.ts).
 *
 * Signed in: `/` and every app route are the app's index.html; `/?next=…`
 * goes straight to that route. Anything that isn't an app route or a page is
 * the plain 404, except in development, where the asset layer (Vite) has the
 * modules a page loads.
 */
import { isAppPath, publicPage, safeNext, signInURL, type PublicPage } from "../shared/routes";

export type GateDecision =
  | { readonly kind: "app" }
  | { readonly kind: "landing" }
  | { readonly kind: "page"; readonly page: PublicPage }
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "pass" };

export interface GateRequest {
  readonly pathname: string;
  /** With its `?`, or empty. */
  readonly search: string;
  readonly signedIn: boolean;
  readonly requireSignIn: boolean;
  readonly dev: boolean;
}

export function decide({ pathname, search, signedIn, requireSignIn, dev }: GateRequest): GateDecision {
  const page = publicPage(pathname);
  if (page) return { kind: "page", page };
  if (isAppPath(pathname, dev)) {
    if (signedIn) {
      // Signed in elsewhere (another tab) and back on the landing's link: go where it pointed.
      const next = pathname === "/" ? safeNext(new URLSearchParams(search).get("next")) : null;
      return next && next !== "/" ? { kind: "redirect", location: next } : { kind: "app" };
    }
    if (!requireSignIn) return { kind: "app" };
    return pathname === "/" ? { kind: "landing" } : { kind: "redirect", location: signInURL(pathname + search) };
  }
  return dev && isDevModule(pathname) ? { kind: "pass" } : { kind: "not-found" };
}

/**
 * Development only: what Vite's dev server serves itself (its client, the
 * source modules, the pages' sources, files with an extension). Anything
 * else is a page, and a page that isn't the app's is the 404, as in production.
 */
function isDevModule(pathname: string): boolean {
  return /^\/(?:@|src\/|node_modules\/|pages\/|shared\/|__)/.test(pathname) || /\.[a-z0-9]+$/i.test(pathname);
}

/** Whether the decision needs to know who is signed in (public pages and 404s don't). */
export function needsSession(pathname: string, dev: boolean): boolean {
  return isAppPath(pathname, dev);
}
