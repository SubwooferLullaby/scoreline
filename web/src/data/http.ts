/**
 * Every network read goes through `getJSON`: it maps the upstream URL onto
 * the `/api/*` proxy (shared/upstreams.ts), or straight to a `direct` host,
 * checks the status, and parses.
 * Providers take a `Fetcher` so tests can replay fixtures without a network.
 *
 *     const board = await fetcher("https://site.api.espn.com/apis/site/v2/sports/nfl/scoreboard", { signal });
 */
import { signInURL } from "../../shared/routes";
import { clientRequest } from "../../shared/upstreams";

export type Fetcher = (upstreamURL: string, init?: { signal?: AbortSignal }) => Promise<unknown>;

/** A non-2xx answer from the proxy (an upstream error, or a path off the allowlist). */
export class HTTPError extends Error {
  readonly status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HTTPError";
    this.status = status;
  }
}

let leaving = false;

/**
 * The Worker's proxy answers 401 once the session is gone (signed out in
 * another tab, expired, the account deleted): back to the landing, which
 * returns here after signing in (shared/routes.ts `signInURL`). Only for the
 * app's own `/api`, never a direct upstream's answer.
 */
export function noteUnauthorized(response: Response, href: string): void {
  if (response.status !== 401 || !href.startsWith("/") || leaving || typeof location === "undefined") return;
  leaving = true;
  location.assign(signInURL(location.pathname + location.search));
}

/** Development only: a stand-in for the network (the `?demo` harness, src/data/demo.ts). */
let override: Fetcher | null = null;
export function setFetcherOverride(fetcher: Fetcher | null): void {
  override = fetcher;
}

/** The app's fetcher: through the proxy, JSON, throws on failure. */
export const getJSON: Fetcher = async (upstreamURL, init) => {
  if (override) return override(upstreamURL, init);
  const { href, cache } = clientRequest(upstreamURL);
  const response = await fetch(href, { signal: init?.signal, cache, headers: { Accept: "application/json" } });
  noteUnauthorized(response, href);
  if (!response.ok) throw new HTTPError(response.status, upstreamURL);
  return response.json() as Promise<unknown>;
};

export type TextFetcher = (upstreamURL: string, init?: { signal?: AbortSignal }) => Promise<string>;

/**
 * The app's fetcher for upstreams that answer in text, not JSON: World
 * Climbing's YouTube pages, decapi.me's Twitch status. Through the proxy;
 * throws on failure. Under the demo harness, whatever the stand-in answers
 * as a string (anything else is no answer).
 */
export const getText: TextFetcher = async (upstreamURL, init) => {
  if (override) {
    const answer = await override(upstreamURL, init);
    if (typeof answer !== "string") throw new HTTPError(404, upstreamURL);
    return answer;
  }
  const { href, cache } = clientRequest(upstreamURL);
  const response = await fetch(href, { signal: init?.signal, cache });
  noteUnauthorized(response, href);
  if (!response.ok) throw new HTTPError(response.status, upstreamURL);
  return response.text();
};

/** Resolves a path that may be relative ("/api/v1/events/1") against a base. */
export function resolveURL(path: string, base: string): string {
  return new URL(path, base).href;
}
