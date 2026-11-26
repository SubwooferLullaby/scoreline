import { execSync } from "node:child_process";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

/** The build's version for client error reports: `git describe` ("v1.0.33-12-gabc1234"), else the package's. */
function release(): string {
	try {
		return execSync("git describe --tags --always", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	} catch {
		return (pkg as { version?: string }).version ?? "unknown";
	}
}

// The client (React, in src/) builds to static assets; the Cloudflare plugin
// builds the Worker (worker/) from cloudflare.config.ts and runs it in workerd
// during `cf dev`, so /api/* behaves locally as it does deployed.
export default defineConfig({
	plugins: [react(), cloudflare()],
	define: { __RELEASE__: JSON.stringify(release()) },
	build: {
		// Routes are split by React Router's `lazy`. Libraries go in their own
		// long-lived chunks, so an app update doesn't re-download React.
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [
						{ name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
						{ name: "router", test: /node_modules[\\/]react-router[\\/]/ },
						// The query client only: the persister (state/persist.ts) loads with the pages that keep data on disk.
						{ name: "query", test: /node_modules[\\/]@tanstack[\\/](query-core|react-query)[\\/]/ },
					],
				},
			},
		},
	},
});
