#!/usr/bin/env node
/**
 * The link card (Open Graph and Twitter): public/og.png, 1200 × 630, drawn
 * in the landing page's style (pages/page.css, pages/landing.css) and
 * photographed with Playwright's Chromium. The name and the headline on the
 * left; on the right the landing's own screenshot of a live game page
 * (public/landing/game-light.webp), in its browser frame, running off the
 * card's edge. Inter comes from Google Fonts while it draws, so the card
 * looks the same from any machine.
 *
 *     node scripts/make-og.mjs        # writes public/og.png (keep it under 400 KB)
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "og.png");
const icon = readFileSync(join(ROOT, "public", "icon-512.png")).toString("base64");
const shot = readFileSync(join(ROOT, "public", "landing", "game-light.webp")).toString("base64");

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&display=block">
<style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body {
    position: relative;
    background:
      radial-gradient(70% 80% at 85% 10%, rgb(56 110 220 / 0.10), transparent 70%),
      #fdfdfc;
    color: #1b1b1a;
    font-family: "Inter", sans-serif;
    font-feature-settings: "cv11";
    -webkit-font-smoothing: antialiased;
  }
  .copy { position: absolute; left: 64px; top: 0; bottom: 0; width: 400px; display: flex; flex-direction: column; justify-content: center; }
  .name { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 600; letter-spacing: -0.02em; }
  .name img { width: 52px; height: 52px; border-radius: 12px; box-shadow: 0 0 0 1px rgb(0 0 0 / 0.08); }
  h1 { margin: 36px 0 0; font-size: 56px; line-height: 1.04; font-weight: 650; letter-spacing: -0.04em; text-wrap: balance; }
  p { margin: 22px 0 0; font-size: 23px; line-height: 1.4; color: #646461; letter-spacing: -0.01em; }
  .live { display: inline-flex; align-items: center; gap: 10px; margin-top: 34px; padding: 7px 16px 7px 13px; border: 1px solid #e7e6e3; border-radius: 999px; background: #fdfdfc; color: #646461; font-size: 19px; font-weight: 500; align-self: flex-start; }
  .live i { width: 9px; height: 9px; border-radius: 50%; background: #e5484d; box-shadow: 0 0 0 5px rgb(229 72 77 / 0.15); }
  .frame {
    position: absolute; left: 500px; top: 72px; width: 780px;
    border-radius: 16px; overflow: hidden; background: #fdfdfc;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.08), 0 2px 4px rgb(0 0 0 / 0.04), 0 24px 48px -12px rgb(0 0 0 / 0.16), 0 48px 96px -32px rgb(0 0 0 / 0.2);
  }
  .chrome { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border-bottom: 1px solid rgb(0 0 0 / 0.08); background: #f3f2ef; }
  .chrome span { width: 12px; height: 12px; border-radius: 50%; background: #dddcd8; }
  .chrome b { margin-left: 150px; padding: 3px 56px; border-radius: 7px; background: #fdfdfc; color: #646461; font-size: 14px; font-weight: 500; }
  /* The game page, not the list (the screenshot's first 580 of 2000 px), out to the touchdown banner's end. */
  .view { height: 560px; overflow: hidden; }
  .view img { display: block; width: 1060px; margin-left: -307px; }
</style></head><body>
  <div class="copy">
    <div class="name"><img src="data:image/png;base64,${icon}" alt="">Scoreline</div>
    <h1>Live scores, told play by play.</h1>
    <p>Every snap, pitch and shot, replayed on a small animated field.</p>
    <span class="live"><i></i>Free, on the web</span>
  </div>
  <div class="frame">
    <div class="chrome"><span></span><span></span><span></span><b>scoreline.fyi</b></div>
    <div class="view"><img src="data:image/webp;base64,${shot}" alt=""></div>
  </div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  if (!(await page.evaluate(() => document.fonts.check('650 64px "Inter"')))) throw new Error("Inter didn't load: the card would draw in a fallback font.");
  await page.screenshot({ path: OUT, type: "png" });
} finally {
  await browser.close();
}
const kb = statSync(OUT).size / 1024;
console.log(`public/og.png: ${kb.toFixed(1)} KB`);
if (kb > 400) process.exitCode = 1;
