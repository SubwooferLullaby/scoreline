/**
 * The page headers (worker/headers.ts): security headers on every HTML
 * response the Worker serves, and a CSP the app runs under. The CSP allows
 * index.html's inline theme script by its hash, so editing that script
 * without updating the hash would let a dark page flash light. The static
 * files' rules stay in public/_headers.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOCKETS, UPSTREAMS } from "../../shared/upstreams";
import { CSP, PAGE_HEADERS, htmlResponse, jsonResponse } from "../../worker/headers";

const root = join(import.meta.dirname, "..", "..");
const headersFile = readFileSync(join(root, "public", "_headers"), "utf8");
const indexHTML = readFileSync(join(root, "index.html"), "utf8");
const pages = ["landing", "privacy", "terms", "404"].map((name) => [name, readFileSync(join(root, "pages", `${name}.html`), "utf8")] as const);

const csp = new Map(
  CSP.split(";")
    .map((d) => d.trim().split(/\s+/))
    .filter((d) => d[0])
    .map(([name, ...values]) => [name!, values]),
);

/** `_headers` as path → header name (lowercased) → value. */
function rules(text: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      out.set(line.trim(), current);
    } else if (current) {
      const i = line.indexOf(":");
      current.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
  }
  return out;
}

describe("the page headers", () => {
  it("sends the security headers on every page", () => {
    for (const kind of ["app", "landing", "page", "not-found"] as const) {
      const headers = htmlResponse("<p>", { kind, dev: false }).headers;
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(headers.get("strict-transport-security")).toMatch(/^max-age=31536000/);
      expect(headers.get("x-frame-options")).toBe("DENY");
      expect(headers.get("permissions-policy")).toContain("publickey-credentials-get=(self)");
      expect(headers.get("content-security-policy")).toBe(CSP);
      expect(headers.get("x-scoreline-page")).toBe(kind);
      // Who is signed in decides the page: no shared cache keeps it.
      expect(headers.get("cache-control")).toBe("private, no-cache");
    }
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
  });

  it("leaves the CSP off in development only (Vite injects inline scripts)", () => {
    const headers = htmlResponse("<p>", { kind: "app", dev: true }).headers;
    expect(headers.get("content-security-policy")).toBeNull();
    expect(headers.get("x-frame-options")).toBe("DENY");
  });

  it("allows index.html's inline scripts by hash, and nothing else inline", () => {
    const inline = [...indexHTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]!).digest("base64")}'`);
    expect(inline.length).toBeGreaterThan(0);
    const scripts = csp.get("script-src") ?? [];
    for (const hash of inline) expect(scripts, "update THEME_SCRIPT_HASH in worker/headers.ts").toContain(hash);
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
  });

  it("serves the public pages with no inline script or style for the CSP to refuse", () => {
    for (const [name, html] of pages) {
      expect([...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)], name).toEqual([]);
      expect(html, name).not.toMatch(/<style|\sstyle="/);
    }
  });

  it("keeps data on the app's own origin (the /api proxy) and images on https", () => {
    expect(csp.get("connect-src")).toEqual(["'self'", ...UPSTREAMS.filter((u) => u.direct).map((u) => `https://${u.host}`), ...SOCKETS]);
    expect(csp.get("img-src")).toEqual(expect.arrayContaining(["'self'", "https:", "data:"]));
  });

  it("marks JSON answers nosniff and uncached", () => {
    const headers = jsonResponse({ ok: true }).headers;
    expect(headers.get("content-type")).toMatch(/^application\/json/);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("gives the static files HSTS and caches hashed bundles for a year", () => {
    const files = rules(headersFile);
    expect(files.get("/*")?.get("strict-transport-security")).toBe(PAGE_HEADERS["Strict-Transport-Security"]);
    expect(files.get("/*")?.get("x-content-type-options")).toBe("nosniff");
    expect(files.get("/assets/*")?.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
