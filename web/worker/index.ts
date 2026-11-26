/**
 * The Worker. It runs first for every request but the static files a page
 * loads directly (cloudflare.config.ts: `assets.runWorkerFirst`), so it
 * decides before any HTML goes out:
 *
 * - `/api/auth/*`: Better Auth (worker/auth.ts), behind AUTH_LIMITER per
 *   client, and only the endpoints the landing and Settings use.
 * - `/api/me*`: the signed-in account and its synced settings (worker/me.ts).
 * - `/api/t` and `/api/admin/stats`: the analytics ingest and the owner's
 *   numbers (worker/analytics.ts). The ingest takes signed-out events too
 *   (the landing's); the stats are for admins only.
 * - `/api/*`: the proxy (worker/proxy.ts), for a session only (401 JSON
 *   without one, while `REQUIRE_SIGN_IN` is on), behind API_LIMITER per
 *   session, through the cached `Proxy` entrypoint.
 * - `/assets/*`: the hashed bundles, or a 404 (never index.html).
 * - Another host than `SITE_URL`'s: a 301 there (`elsewhere`).
 * - Pages: the gate (worker/gate.ts) picks the landing, the app's shell, a
 *   public page, a redirect to the landing or the plain 404 (worker/pages.ts).
 *   A landing served to a visitor is counted (`recordLandingView`).
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { INGEST_PATH } from "../shared/analytics";
import { safeNext } from "../shared/routes";
import { API_PREFIX } from "../shared/upstreams";
import { adminStats, ingest, recordLandingView, type CurrentUser } from "./analytics";
import { getAuth, getSession, isLocalhost, requireSignIn, withCookies, type SignedIn } from "./auth";
import { decide, needsSession } from "./gate";
import { problem } from "./headers";
import { guardPasskeyRemoval, me } from "./me";
import { appShell, staticPage } from "./pages";
import { proxy } from "./proxy";

/** The Better Auth endpoints the landing and Settings → Account use; the rest of its API isn't exposed. */
export const AUTH_ENDPOINTS: ReadonlySet<string> = new Set([
  "/get-session",
  "/sign-out",
  "/sign-in/social",
  "/callback/google",
  "/error",
  "/list-accounts",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/generate-authenticate-options",
  "/passkey/verify-authentication",
  "/passkey/list-user-passkeys",
  "/passkey/update-passkey",
  "/passkey/delete-passkey",
]);

/** Session reads are frequent and cheap; everything else counts against the client's auth limit. */
const UNLIMITED_AUTH = new Set(["/get-session"]);

/** Who is asking, for the analytics: the session's user (the end-to-end harness's stand-in too, which exists only under `pnpm dev`). */
async function currentUser(request: Request, env: Env): Promise<CurrentUser> {
  const signedIn = await getSession(request, env);
  return signedIn ? { id: signedIn.user.id, email: signedIn.user.email, emailVerified: signedIn.user.emailVerified } : null;
}

/**
 * A hashed bundle, or a 404. The asset layer answers a file it doesn't have
 * (a page from the deploy before asking for its chunks, or the one after) with
 * the app's index.html, and `/assets/*` carries a year's immutable cache: the
 * browser and the service worker would keep that HTML as the script for good.
 */
async function asset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (!response.ok || (response.headers.get("Content-Type") ?? "").includes("text/html")) return problem(404, "Not found.");
  if (response.headers.has("Cache-Control")) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(response.body, { status: response.status, headers });
}

/** The client's key for the auth limit: Cloudflare's connecting address, used only as a counter's key and never stored. */
function clientKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "local";
}

async function limited(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  try {
    return !(await limiter.limit({ key })).success;
  } catch {
    // A limiter that can't answer never takes the site down.
    return false;
  }
}

const TOO_MANY = () => problem(429, "Too many requests. Try again in a minute.", { "Retry-After": "60" });

async function auth(request: Request, env: Env, path: string): Promise<Response> {
  const endpoint = path.slice("/api/auth".length);
  if (!AUTH_ENDPOINTS.has(endpoint)) return problem(404, "Not found.");
  if (!UNLIMITED_AUTH.has(endpoint) && (await limited(env.AUTH_LIMITER, `auth:${clientKey(request)}`))) return TOO_MANY();
  if (endpoint === "/passkey/delete-passkey" && request.method === "POST") {
    const refusal = await guardPasskeyRemoval(request, env);
    if (refusal) return refusal;
  }
  try {
    return await getAuth(env, request).handler(request);
  } catch (error) {
    console.log(JSON.stringify({ event: "auth_failed", endpoint, error: String(error) }));
    return problem(500, "Sign-in isn't working right now.");
  }
}

async function api(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const signedIn: SignedIn | null = await getSession(request, env);
  if (!signedIn && requireSignIn(env)) return problem(401, "Sign in to use Scoreline.");
  if (signedIn && !signedIn.bypass && (await limited(env.API_LIMITER, `api:${signedIn.user.id}`))) return TOO_MANY();
  // The proxy needs no cookies: a clean request, so the cache keys on the URL alone.
  const forwarded = new Request(url.href, { method: request.method, headers: { Accept: request.headers.get("Accept") ?? "*/*" } });
  const response = ctx.exports?.Proxy ? await ctx.exports.Proxy.fetch(forwarded) : await proxy(forwarded, url, ctx);
  return withCookies(response, signedIn?.headers);
}

async function page(request: Request, env: Env, ctx: ExecutionContext, url: URL, dev: boolean): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return problem(405, "Only GET and HEAD.", { Allow: "GET, HEAD" });
  const signedIn = needsSession(url.pathname, dev) ? await getSession(request, env) : null;
  const decision = decide({ pathname: url.pathname, search: url.search, signedIn: signedIn != null, requireSignIn: requireSignIn(env), dev });
  const cookies = signedIn?.headers;
  switch (decision.kind) {
    case "app":
      return appShell(env, request, dev, cookies);
    case "landing":
      if (request.method === "GET") recordLandingView(request, env, ctx);
      return staticPage(env, request, "landing", dev);
    case "page":
      return staticPage(env, request, decision.page, dev, cookies);
    case "redirect": {
      const location = safeNext(decision.location) ?? "/";
      const headers = new Headers(cookies);
      headers.set("Location", location);
      headers.set("Cache-Control", "no-store");
      return new Response(null, { status: 302, headers });
    }
    case "pass":
      return env.ASSETS.fetch(request);
    case "not-found":
      return staticPage(env, request, "not-found", dev);
  }
}

/** The cached side of the proxy: Workers Caching sits in front of this entrypoint only (cloudflare.config.ts). */
export class Proxy extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return proxy(request, new URL(request.url), this.ctx);
  }
}

/**
 * With `SITE_URL` set, every other host (workers.dev) sends you there, path
 * and all: passkeys belong to one origin, so the site has one address.
 * Localhost is exempt, so development and the e2e specs run as they are.
 */
export function elsewhere(url: URL, env: Env): string | null {
  const configured = (env.SITE_URL ?? "").trim();
  if (!configured) return null;
  const site = new URL(configured);
  if (url.origin === site.origin || isLocalhost(url.hostname)) return null;
  return `${site.origin}${url.pathname}${url.search}`;
}

/** Every request. `dev` is the build's (`import.meta.env.DEV`); tests pass their own. */
export async function handle(request: Request, env: Env, ctx: ExecutionContext, dev: boolean): Promise<Response> {
  const url = new URL(request.url);
  const moved = elsewhere(url, env);
  if (moved) return Response.redirect(moved, 301);
  const path = url.pathname;
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return auth(request, env, path);
  if (path === "/api/me" || path.startsWith("/api/me/")) return me(request, env, path);
  if (path === INGEST_PATH) return ingest(request, env, ctx, await currentUser(request, env));
  if (path === "/api/admin/stats") return adminStats(request, env, await currentUser(request, env));
  if (path.startsWith(API_PREFIX)) return api(request, env, ctx, url);
  if (path.startsWith("/assets/")) return asset(request, env);
  return page(request, env, ctx, url, dev);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // `pnpm dev`: the local D1 gets the migrations on first use (never in a production bundle).
    if (import.meta.env.DEV) await (await import("./devMigrations")).migrateLocal(env.DB);
    return handle(request, env, ctx, import.meta.env.DEV);
  },
} satisfies ExportedHandler<Env>;
