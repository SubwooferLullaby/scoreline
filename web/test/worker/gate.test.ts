/**
 * The gate (worker/gate.ts) and the Worker that serves it (worker/index.ts):
 * every route signed in and signed out, `next` kept on this origin, `/api`
 * closed without a session, and the end-to-end harness's stand-in session
 * impossible outside development.
 */
import { describe, expect, it, vi } from "vitest";
import { APP_SECTIONS, safeNext, signInURL } from "../../shared/routes";
import { DEV_SESSION_COOKIE, devSession, getSession } from "../../worker/auth";
import { decide, type GateRequest } from "../../worker/gate";
import { AUTH_ENDPOINTS, handle } from "../../worker/index";
import { personalize, DEFAULT_ORIGIN } from "../../worker/pages";

const gate = (pathname: string, over: Partial<GateRequest> = {}) =>
  decide({ pathname, search: "", signedIn: false, requireSignIn: true, dev: false, ...over });

describe("the gate's decisions", () => {
  it("signed out: the landing at /, the public pages, a redirect from every app route", () => {
    expect(gate("/")).toEqual({ kind: "landing" });
    expect(gate("/privacy")).toEqual({ kind: "page", page: "privacy" });
    expect(gate("/terms/")).toEqual({ kind: "page", page: "terms" });
    for (const section of APP_SECTIONS) {
      expect(gate(`/${section}/1`, { search: "?tab=box" })).toEqual({ kind: "redirect", location: `/?next=${encodeURIComponent(`/${section}/1?tab=box`)}` });
    }
    expect(gate("/settings")).toEqual({ kind: "redirect", location: "/?next=%2Fsettings" });
  });

  it("signed in: the app on / and every app route, and / follows a safe next", () => {
    const signedIn = { signedIn: true };
    expect(gate("/", signedIn)).toEqual({ kind: "app" });
    for (const section of APP_SECTIONS) expect(gate(`/${section}/x`, signedIn)).toEqual({ kind: "app" });
    expect(gate("/privacy", signedIn)).toEqual({ kind: "page", page: "privacy" });
    expect(gate("/", { ...signedIn, search: "?next=%2Fgame%2F42" })).toEqual({ kind: "redirect", location: "/game/42" });
    expect(gate("/", { ...signedIn, search: "?next=https%3A%2F%2Fevil.example" })).toEqual({ kind: "app" });
    expect(gate("/", { ...signedIn, search: "?next=%2F%2Fevil.example" })).toEqual({ kind: "app" });
  });

  it("with REQUIRE_SIGN_IN off, everyone gets the app", () => {
    expect(gate("/", { requireSignIn: false })).toEqual({ kind: "app" });
    expect(gate("/game/1", { requireSignIn: false })).toEqual({ kind: "app" });
  });

  it("anything else is the plain 404 (development leaves it to Vite)", () => {
    expect(gate("/wp-login.php")).toEqual({ kind: "not-found" });
    expect(gate("/index.html", { signedIn: true })).toEqual({ kind: "not-found" });
    expect(gate("/pages/landing.html")).toEqual({ kind: "not-found" });
    expect(gate("/dev/theater", { signedIn: true })).toEqual({ kind: "not-found" });
    expect(gate("/dev/theater", { signedIn: true, dev: true })).toEqual({ kind: "app" });
    expect(gate("/src/main.tsx", { dev: true })).toEqual({ kind: "pass" });
    expect(gate("/@vite/client", { dev: true })).toEqual({ kind: "pass" });
    expect(gate("/no-such-page", { dev: true })).toEqual({ kind: "not-found" });
  });

});

describe("next", () => {
  it("keeps paths on this origin, with their query and hash", () => {
    expect(safeNext("/game/1")).toBe("/game/1");
    expect(safeNext("/schedule?day=2026-11-26#top")).toBe("/schedule?day=2026-11-26#top");
    expect(safeNext("/")).toBe("/");
  });

  it("refuses other sites and anything a browser could read as one", () => {
    for (const raw of [
      "https://evil.example/",
      "//evil.example",
      "///evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\tevil",
      "/\nevil",
      "javascript:alert(1)",
      "game/1",
      "",
      null,
      undefined,
      `/${"a".repeat(2050)}`,
    ]) {
      expect(safeNext(raw), String(raw)).toBeNull();
    }
  });

  it("never lands on the API", () => {
    expect(safeNext("/api/me")).toBeNull();
    expect(safeNext("/api")).toBeNull();
    expect(safeNext("/apiary")).toBe("/apiary");
  });

  it("builds the landing's link back", () => {
    expect(signInURL("/game/1?x=1")).toBe("/?next=%2Fgame%2F1%3Fx%3D1");
    expect(signInURL("/")).toBe("/");
    expect(signInURL("//evil.example")).toBe("/");
  });
});

describe("the harness's stand-in session", () => {
  const harness = (host: string) => new Request(`http://${host}/game/1`, { headers: { Cookie: `${DEV_SESSION_COOKIE}=1` } });

  it("is off in production builds, whatever the request says", () => {
    expect(devSession(harness("localhost"), false)).toBeNull();
    expect(devSession(harness("127.0.0.1"), false)).toBeNull();
  });

  it("is off on any host but localhost, and without its cookie", () => {
    expect(devSession(harness("scoreline-web.lame-o.workers.dev"), true)).toBeNull();
    expect(devSession(harness("localhost.evil.example"), true)).toBeNull();
    expect(devSession(new Request("http://localhost/game/1"), true)).toBeNull();
    expect(devSession(harness("localhost"), true)?.bypass).toBe(true);
  });

});

describe("the landing's per-request edits", () => {
  const html = `<a href="${DEFAULT_ORIGIN}/">x</a><!-- google --><button>Continue with Google</button><!-- /google -->`;

  it("cuts the Google button when Google isn't configured", () => {
    expect(personalize(html, { google: false, origin: DEFAULT_ORIGIN })).not.toContain("Google");
    expect(personalize(html, { google: true, origin: DEFAULT_ORIGIN })).toContain("Continue with Google");
  });

  it("names the site's own origin", () => {
    expect(personalize(html, { google: false, origin: "https://scoreline.example" })).toContain('href="https://scoreline.example/"');
  });
});

/** The Worker with its bindings stubbed: the asset layer answers by path, the proxy entrypoint records calls. */
function harness({ requireSignIn = "on" } = {}) {
  const assets = vi.fn(async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/index.html") return new Response("<!doctype html><title>app</title>", { headers: { "Content-Type": "text/html" } });
    if (path.startsWith("/pages/")) return new Response(`<!doctype html><title>${path}</title><!-- google --><b>Google</b><!-- /google -->`, { headers: { "Content-Type": "text/html" } });
    if (path === "/assets/app.js") return new Response("export {}", { headers: { "Content-Type": "text/javascript" } });
    return new Response("<!doctype html><title>app</title>", { headers: { "Content-Type": "text/html" } });
  });
  const proxied = vi.fn(async (request: Request) => Response.json({ proxied: new URL(request.url).pathname, cookie: request.headers.get("Cookie") }));
  const limit = vi.fn(async () => ({ success: true }));
  const env = {
    ASSETS: { fetch: assets },
    REQUIRE_SIGN_IN: requireSignIn,
    SITE_URL: "",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    API_LIMITER: { limit },
    AUTH_LIMITER: { limit },
  } as unknown as Env;
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {}, exports: { Proxy: { fetch: proxied } } } as unknown as ExecutionContext;
  const call = (path: string, init: RequestInit & { host?: string; signedIn?: boolean } = {}) => {
    const headers = new Headers(init.headers);
    if (init.signedIn) headers.set("Cookie", `${DEV_SESSION_COOKIE}=1`);
    return handle(new Request(`http://${init.host ?? "localhost"}${path}`, { ...init, headers }), env, ctx, false);
  };
  return { call, assets, proxied, limit };
}

describe("the Worker", () => {
  it("signed out: the landing, the public pages, redirects, 401s and 404s", async () => {
    const { call, proxied } = harness();
    const landing = await call("/");
    expect(landing.status).toBe(200);
    expect(landing.headers.get("x-scoreline-page")).toBe("landing");
    expect(landing.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await landing.text()).not.toContain("Google");

    expect((await call("/terms")).headers.get("x-scoreline-page")).toBe("page");

    const redirect = await call("/game/7?tab=plays");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/?next=%2Fgame%2F7%3Ftab%3Dplays");

    const api = await call("/api/site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: { status: 401, message: "Sign in to use Scoreline." } });
    expect(proxied).not.toHaveBeenCalled();

    expect((await call("/api/me")).status).toBe(401);
    expect((await call("/api/me/settings", { method: "PUT", body: "{}" })).status).toBe(401);

    const missing = await call("/wp-login.php");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-scoreline-page")).toBe("not-found");
    expect((await call("/", { method: "POST" })).status).toBe(405);
  });

  it("signed in: the app's shell on every app route, and the proxy through its cached entrypoint", async () => {
    const { call, proxied, limit } = harness();
    for (const path of ["/", "/game/7", "/settings", "/team/1"]) {
      const response = await call(path, { signedIn: true });
      expect(response.status, path).toBe(200);
      expect(response.headers.get("x-scoreline-page"), path).toBe("app");
    }
    const next = await call("/?next=%2Fgame%2F7", { signedIn: true });
    expect(next.status).toBe(302);
    expect(next.headers.get("location")).toBe("/game/7");

    const api = await call("/api/site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", { signedIn: true, headers: { Accept: "application/json" } });
    expect(api.status).toBe(200);
    // The cached entrypoint never sees the cookie: the cache keys on the URL alone.
    expect(await api.json()).toEqual({ proxied: "/api/site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", cookie: null });
    expect(proxied).toHaveBeenCalledOnce();
    // The stand-in isn't a session to limit.
    expect(limit).not.toHaveBeenCalled();
  });

  it("the stand-in opens nothing for an account (/api/me) and nothing off localhost", async () => {
    const { call } = harness();
    expect((await call("/api/me", { signedIn: true })).status).toBe(401);
    expect((await call("/game/7", { signedIn: true, host: "scoreline.example" })).status).toBe(302);
  });

  it("with REQUIRE_SIGN_IN off, the app and the proxy are open", async () => {
    const { call } = harness({ requireSignIn: "off" });
    expect((await call("/")).headers.get("x-scoreline-page")).toBe("app");
    expect((await call("/api/site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard")).status).toBe(200);
  });

  it("keeps the bundles' 404 rule: a missing chunk is a 404, never index.html", async () => {
    const { call } = harness();
    expect((await call("/assets/app.js")).status).toBe(200);
    const missing = await call("/assets/gone-1234.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toMatch(/json/);
  });

  it("exposes only the auth endpoints the pages use, behind the auth limit", async () => {
    const { call, limit } = harness();
    expect(AUTH_ENDPOINTS.has("/delete-user")).toBe(false);
    expect((await call("/api/auth/delete-user", { method: "POST" })).status).toBe(404);
    expect((await call("/api/auth/sign-up/email", { method: "POST" })).status).toBe(404);
    limit.mockResolvedValueOnce({ success: false });
    const limited = await call("/api/auth/passkey/generate-authenticate-options");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("reads no session from a request without its cookie", async () => {
    const env = {} as Env;
    expect(await getSession(new Request("https://scoreline.example/"), env)).toBeNull();
  });
});
