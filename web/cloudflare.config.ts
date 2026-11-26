import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

// Scoreline for the web: the React app as static assets, plus an `/api/*`
// Worker that proxies and caches the sports feeds (worker/proxy.ts).
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
			// The static assets, for the Worker's `/assets/*` pass (worker/index.ts).
			ASSETS: bindings.assets(),
			// The app's database: accounts (Better Auth) and first-party analytics
			// (migrations/). Bound by name; the account is chosen at deploy time.
			DB: bindings.d1({ name: "scoreline" }),
			// Who sees /admin: comma-separated emails and user IDs, set as secrets
			// at deploy time (never in the repo). worker/analytics.ts `isAdmin`.
			ADMIN_EMAILS: bindings.secret(),
			ADMIN_USER_IDS: bindings.secret(),
		},
		assets: {
			// Every app route (/game/123, /settings…) gets index.html; React Router takes it from there.
			notFoundHandling: "single-page-application",
			// The proxy runs before the asset layer for its own paths. Hashed
			// bundles go through the Worker too, so a file this deploy doesn't
			// have is a 404 rather than index.html under a year's immutable cache.
			runWorkerFirst: ["/api/*", "/assets/*"],
		},
		// Workers Caching in front of the proxy: collapses bursts of identical
		// polls and works on workers.dev, where the Cache API inside the proxy is
		// a no-op. The proxy's CDN-Cache-Control sets each response's lifetime.
		cache: { enabled: true },
		observability: {
			enabled: true,
			logs: { enabled: true, invocationLogs: true },
			traces: { enabled: true, headSamplingRate: 0.1 },
		},
	},
});
