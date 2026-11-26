import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The client (React, in src/) builds to static assets; the Cloudflare plugin
// builds the Worker (worker/) from cloudflare.config.ts and runs it in workerd
// during `cf dev`, so /api/* behaves locally as it does deployed.
//
// Five pages: the app (index.html), and the landing, privacy, terms and 404
// pages (pages/), plain HTML with one small stylesheet and, on the landing,
// one small script. The Worker serves each (worker/pages.ts).
export default defineConfig({
	plugins: [react(), cloudflare()],
	environments: {
		client: {
			build: {
				rolldownOptions: {
					input: {
						index: "index.html",
						landing: "pages/landing.html",
						privacy: "pages/privacy.html",
						terms: "pages/terms.html",
						notFound: "pages/404.html",
					},
				},
			},
		},
	},
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
