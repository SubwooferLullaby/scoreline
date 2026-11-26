#!/usr/bin/env node
/**
 * The link card (Open Graph and Twitter): public/og.png, 1200 × 630, drawn
 * in the landing page's style (pages/page.css) and photographed with
 * Playwright's Chromium. The app's icon sits beside the name.
 *
 *     node scripts/make-og.mjs        # writes public/og.png (keep it under 150 KB)
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "og.png");
const icon = readFileSync(join(ROOT, "public", "icon-512.png")).toString("base64");

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1200px; height: 630px; }
  body {
    display: flex; flex-direction: column; justify-content: center;
    box-sizing: border-box; padding: 0 120px;
    background: #fdfdfc; color: #1a1a19;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "Ubuntu Sans", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .name { display: flex; align-items: center; gap: 28px; }
  img { width: 112px; height: 112px; margin-left: -10px; }
  h1 { margin: 0; font-size: 96px; font-weight: 600; letter-spacing: -0.035em; }
  p { margin: 30px 0 0; font-size: 44px; color: #6f6e69; letter-spacing: -0.015em; }
  .sports { margin-top: 56px; font-size: 26px; color: #9a9893; letter-spacing: 0; }
</style></head><body>
  <div class="name"><img src="data:image/png;base64,${icon}" alt=""><h1>Scoreline</h1></div>
  <p>Live scores, told play by play.</p>
  <p class="sports">Soccer · NFL · College Football · MLB · NBA · WNBA · CS2 · Climbing</p>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.screenshot({ path: OUT, type: "png" });
} finally {
  await browser.close();
}
const kb = statSync(OUT).size / 1024;
console.log(`public/og.png: ${kb.toFixed(1)} KB`);
if (kb > 150) process.exitCode = 1;
