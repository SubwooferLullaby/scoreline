import { defineConfig, devices } from "@playwright/test";

/**
 * The smoke test (test/e2e): the app in headless Chromium at phone, tablet
 * and desktop widths, light and dark, with screenshots saved for review.
 * It runs against `pnpm dev` (the real Worker proxy and live feeds), or an
 * already running server at SCORELINE_URL.
 *
 *     pnpm test:e2e
 *     SCORELINE_SCREENSHOTS=/some/dir pnpm test:e2e
 *
 * The app is behind sign-in (worker/gate.ts). On localhost the specs carry
 * the development build's stand-in session cookie (worker/auth.ts
 * `devSession`), so they open the app directly; a production build ignores
 * it. test/e2e/landing.spec.ts drops it and signs in for real, with a
 * virtual passkey.
 */
const url = process.env.SCORELINE_URL ?? "http://localhost:5173";
const host = new URL(url).hostname;
const local = host === "localhost" || host === "127.0.0.1";

export default defineConfig({
  testDir: "test/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: url,
    ...devices["Desktop Chrome"],
    headless: true,
    storageState: {
      cookies: local ? [{ name: "scoreline_dev_session", value: "1", domain: host, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }] : [],
      origins: [],
    },
  },
  webServer: process.env.SCORELINE_URL
    ? undefined
    : {
        command: "pnpm dev",
        url,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
