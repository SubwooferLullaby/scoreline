/**
 * The Worker. Static assets (the React app) are served before it runs; it
 * sees `/api/*`, which it hands to the proxy, and the hashed bundles under
 * `/assets/*` (cloudflare.config.ts: `assets.runWorkerFirst`). Anything else
 * that reaches it is a 404: the asset layer already answered every app route
 * with index.html.
 *
 * Two `/api` paths are the app's own, ahead of the proxy: the analytics
 * ingest (`/api/t`) and the owner's numbers (`/api/admin/stats`), both in
 * worker/analytics.ts.
 */
import { INGEST_PATH } from "../shared/analytics";
import { API_PREFIX } from "../shared/upstreams";
import { adminStats, ingest, type CurrentUser } from "./analytics";
import { proxy } from "./proxy";

/**
 * The signed-in user. Until accounts land (worker/auth.ts' `getSession`),
 * nobody is: the ingest keeps only signed-out events and the stats answer 401.
 */
async function currentUser(_request: Request, _env: Env): Promise<CurrentUser> {
  return null;
}

const notFound = () =>
  Response.json({ error: { status: 404, message: "Not found." } }, { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

/**
 * A hashed bundle, or a 404. The asset layer answers a file it doesn't have
 * (a page from the deploy before asking for its chunks, or the one after) with
 * the app's index.html, and `/assets/*` carries a year's immutable cache: the
 * browser and the service worker would keep that HTML as the script for good.
 */
async function asset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  if (!response.ok || (response.headers.get("Content-Type") ?? "").includes("text/html")) return notFound();
  if (response.headers.has("Cache-Control")) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === INGEST_PATH) return ingest(request, env, ctx, await currentUser(request, env));
    if (url.pathname === "/api/admin/stats") return adminStats(request, env, await currentUser(request, env));
    if (url.pathname.startsWith(API_PREFIX)) return proxy(request, url, ctx);
    if (url.pathname.startsWith("/assets/")) return asset(request, env);
    return notFound();
  },
} satisfies ExportedHandler<Env>;
