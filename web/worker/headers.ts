/**
 * The headers every HTML response carries: the app's shell, the landing, the
 * legal pages and the 404. The Worker serves all of them (worker/gate.ts), so
 * this is the one place the page policy lives; `public/_headers` only covers
 * the static files the asset layer serves itself (icons, the manifest, the
 * service worker).
 *
 * The Content-Security-Policy fits what the app loads, with no violations:
 *
 * - scripts from the origin, plus index.html's inline theme script by its
 *   hash (`test/unit/headers.test.ts` fails if one changes without the other);
 * - styles from the origin (React sets inline styles through the CSSOM, which
 *   the policy allows);
 * - data from the origin (`/api`), the upstreams the browser fetches itself
 *   (`direct` in shared/upstreams.ts: ESPN's core and web APIs, which answer
 *   Workers 403, and Polymarket's REST) and Polymarket's market socket;
 * - images over https (logos, crests and photos load from their CDNs), data:
 *   and blob: (the favicon's score is drawn on a canvas);
 * - no frames, no plugins, no other site framing these pages.
 *
 * In development the policy is left off: Vite's dev server injects inline
 * scripts (the React refresh preamble). `pnpm preview` serves the built pages
 * with it.
 */
import { SOCKETS, UPSTREAMS } from "../shared/upstreams";

/** index.html's inline theme script (before first paint), by its sha256. */
export const THEME_SCRIPT_HASH = "'sha256-xP+w9z/DXpuc4zcg5e+XrkuBk40lCIseUUlmMyhaoiQ='";

export const CSP = [
  "default-src 'self'",
  `script-src 'self' ${THEME_SCRIPT_HASH}`,
  "style-src 'self'",
  "img-src 'self' data: blob: https:",
  ["connect-src 'self'", ...UPSTREAMS.filter((u) => u.direct).map((u) => `https://${u.host}`), ...SOCKETS].join(" "),
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/**
 * An HTML response with the page headers. Pages depend on who is signed in,
 * so no shared cache may keep them, and the browser asks again each time.
 * `kind` tells the service worker (public/sw.js) which page this is: only
 * "app" may become its offline shell.
 */
export function htmlResponse(
  body: BodyInit | null,
  init: { status?: number; kind: "app" | "landing" | "page" | "not-found"; dev: boolean; headers?: HeadersInit },
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "private, no-cache");
  headers.set("Vary", "Cookie");
  headers.set("X-Scoreline-Page", init.kind);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) headers.set(name, value);
  if (!init.dev) headers.set("Content-Security-Policy", CSP);
  return new Response(body, { status: init.status ?? 200, headers });
}

/** A JSON answer from the Worker itself (the gate, accounts): never cached, never a page. */
export function jsonResponse(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  return new Response(JSON.stringify(body), { status, headers });
}

/** `{ error: { status, message } }`, the proxy's shape. */
export function problem(status: number, message: string, extra: HeadersInit = {}): Response {
  return jsonResponse({ error: { status, message } }, status, extra);
}
