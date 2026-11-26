/**
 * The gate's route list (shared/routes.ts) against the app's router, and the
 * rule that nothing in the deploy config can open the end-to-end harness's
 * stand-in session (worker/auth.ts `devSession`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_SECTIONS, DEV_SECTIONS, isAppPath } from "../../shared/routes";

const root = join(import.meta.dirname, "..", "..");

describe("the gate's routes", () => {
  it("knows every route the app's router has", () => {
    const app = readFileSync(join(root, "src", "app", "App.tsx"), "utf8");
    const firsts = new Set([...app.matchAll(/path: "([a-z]+)[/":]/g)].map((m) => m[1]!));
    expect(firsts.size).toBeGreaterThan(5);
    for (const first of firsts) expect([...APP_SECTIONS, ...DEV_SECTIONS], `add "${first}" to APP_SECTIONS in shared/routes.ts`).toContain(first);
    for (const section of APP_SECTIONS) expect(firsts, `"${section}" is no longer a route`).toContain(section);
  });

  it("keeps the render harnesses to development", () => {
    expect(isAppPath("/dev/odds")).toBe(false);
    expect(isAppPath("/dev/odds", true)).toBe(true);
  });
});

describe("the harness's stand-in session", () => {
  it("is never something the deploy config can turn on", () => {
    const config = readFileSync(join(root, "cloudflare.config.ts"), "utf8");
    expect(config).not.toMatch(/bypass|dev_session|DEV_SESSION/i);
  });

  it("is checked against the build's mode, which production bundles fix to false", () => {
    const auth = readFileSync(join(root, "worker", "auth.ts"), "utf8");
    expect(auth).toMatch(/export function devSession\(request: Request, dev = import\.meta\.env\.DEV\)/);
    expect(auth).toMatch(/if \(!dev\) return null;/);
  });
});
