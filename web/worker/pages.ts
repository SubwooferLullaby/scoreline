/**
 * The pages the gate serves (worker/gate.ts), read from the static assets
 * and sent with the page headers (worker/headers.ts):
 *
 * - the app's index.html (React takes the route from there);
 * - the landing, privacy, terms and 404 pages: static HTML built by Vite
 *   from `pages/` (vite.config.ts), no React and no app bundle. Two things
 *   are filled in per request: the Google button is cut when Google isn't
 *   configured (between `<!-- google -->` and `<!-- /google -->`), and the
 *   canonical and card URLs name the site's origin (`SITE_URL`) when it
 *   isn't the default host they're written with.
 */
import { authMethods, siteOrigin } from "./auth";
import { htmlResponse } from "./headers";

/** The origin the pages' canonical, Open Graph and Twitter URLs are written with. */
export const DEFAULT_ORIGIN = "https://scoreline-web.lame-o.workers.dev";

export type StaticPage = "landing" | "privacy" | "terms" | "not-found";

const FILES: Readonly<Record<StaticPage, string>> = {
  landing: "/pages/landing.html",
  privacy: "/pages/privacy.html",
  terms: "/pages/terms.html",
  "not-found": "/pages/404.html",
};

const GOOGLE = /<!--\s*google\s*-->[\s\S]*?<!--\s*\/google\s*-->/g;

/** The per-request edits: no Google button without Google; the site's own origin in absolute URLs. */
export function personalize(html: string, { google, origin }: { google: boolean; origin: string }): string {
  let out = google ? html : html.replace(GOOGLE, "");
  if (origin !== DEFAULT_ORIGIN) out = out.split(DEFAULT_ORIGIN).join(origin);
  return out;
}

async function readAsset(env: Env, request: Request, path: string): Promise<Response> {
  return env.ASSETS.fetch(new Request(new URL(path, request.url), { headers: { Accept: "text/html" } }));
}

export async function staticPage(env: Env, request: Request, page: StaticPage, dev: boolean, extra?: HeadersInit): Promise<Response> {
  const asset = await readAsset(env, request, FILES[page]);
  if (!asset.ok) {
    await asset.body?.cancel();
    console.log(JSON.stringify({ event: "page_missing", page, status: asset.status }));
    return htmlResponse("<!doctype html><title>Scoreline</title><p>Scoreline is unavailable right now.</p>", { status: 503, kind: "not-found", dev });
  }
  const html = personalize(await asset.text(), { google: authMethods(env).google, origin: siteOrigin(request, env) });
  const status = page === "not-found" ? 404 : 200;
  return htmlResponse(request.method === "HEAD" ? null : html, { status, kind: page === "landing" ? "landing" : page === "not-found" ? "not-found" : "page", dev, headers: extra });
}

/** The app's shell, for every app route; React Router reads the path. */
export async function appShell(env: Env, request: Request, dev: boolean, extra?: HeadersInit): Promise<Response> {
  const asset = await readAsset(env, request, "/index.html");
  if (!asset.ok) {
    await asset.body?.cancel();
    return htmlResponse("<!doctype html><title>Scoreline</title><p>Scoreline is unavailable right now.</p>", { status: 503, kind: "not-found", dev });
  }
  return htmlResponse(request.method === "HEAD" ? null : asset.body, { kind: "app", dev, headers: extra });
}
