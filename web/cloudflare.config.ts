import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

// Scoreline for the web: the React app as static assets, plus a Worker that
// decides every page (worker/gate.ts: the landing when signed out, the app
// when signed in), runs accounts (Better Auth on D1, worker/auth.ts) and
// proxies and caches the sports feeds (worker/proxy.ts).
//
// No accountId here on purpose: the repo is public, and the account is
// chosen at deploy time.
export default defineConfig({
	worker: {
		name: "scoreline-web",
		compatibilityDate: "2026-10-26",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		env: {
			// The static assets: the app's index.html, the landing and legal pages, the hashed bundles.
			ASSETS: bindings.assets(),
			// Accounts, sessions, passkeys, synced settings and first-party analytics (migrations/). Created by
			// name on the owner's personal account; deploy resolves the name.
			DB: bindings.d1({ name: "scoreline" }),
			// Signs session cookies and the cookie cache. `cf workers secrets update BETTER_AUTH_SECRET`;
			// locally `.dev.vars` (see .dev.vars.example), or a fixed development secret.
			BETTER_AUTH_SECRET: bindings.secret(),
			// "on": the app is behind sign-in (docs/LAUNCH.md). "off": anyone gets the app.
			REQUIRE_SIGN_IN: bindings.text("on"),
			// The site's origin ("https://scoreline.example"). Empty: the request's own
			// origin, so workers.dev and localhost both work. Set it with a custom domain.
			SITE_URL: bindings.text(""),
			// Per session on /api/* (the app polls: generous), and per client on /api/auth/*.
			// Namespace IDs are the account's own numbers for these two limiters.
			API_LIMITER: bindings.rateLimit({ namespace: "7301", simple: { limit: 600, period: 60 } }),
			AUTH_LIMITER: bindings.rateLimit({ namespace: "7302", simple: { limit: 30, period: 60 } }),
			// Who sees /admin: comma-separated emails and user IDs, set as secrets
			// at deploy time (never in the repo). worker/analytics.ts `isAdmin`.
			ADMIN_EMAILS: bindings.secret(),
			ADMIN_USER_IDS: bindings.secret(),
		},
		assets: {
			// Every app route (/game/123, /settings…) gets index.html; React Router takes it from there.
			notFoundHandling: "single-page-application",
			// The Worker asks for pages by their file names (pages/landing.html), never redirected.
			htmlHandling: "none",
			// The Worker runs first for everything but the static files a page loads
			// directly (icons, the manifest, the service worker, the card image, robots.txt),
			// so it decides before any HTML goes out: a signed-out visitor never gets the
			// app's shell. Hashed bundles go through it too, so a file this deploy doesn't
			// have is a 404 rather than index.html under a year's immutable cache.
			runWorkerFirst: [
				"/*",
				"!/icon-*",
				"!/apple-touch-icon.png",
				"!/manifest.webmanifest",
				"!/sw.js",
				"!/og.png",
				"!/robots.txt",
			],
		},
		// Workers Caching sits in front of the proxy only. The default entrypoint
		// is the gate and must run on every request (a cached answer would skip
		// the session check), so it stays uncached; it hands allowed /api/*
		// requests to the `Proxy` entrypoint (worker/index.ts) through
		// ctx.exports, whose cache collapses bursts of identical polls and works on
		// workers.dev, where the Cache API inside the proxy is a no-op. The
		// proxy's CDN-Cache-Control sets each response's lifetime.
		exports: {
			Proxy: exports.worker({ cache: { enabled: true } }),
		},
		observability: {
			enabled: true,
			logs: { enabled: true, invocationLogs: true },
			traces: { enabled: true, headSamplingRate: 0.1 },
		},
	},
});
