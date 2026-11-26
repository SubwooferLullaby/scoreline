/**
 * The pages a click is likely to open, loaded ahead of it, and no more. The
 * list's first paint loads the list alone (index.html's chunks); then a cold
 * load fetched every followed sport's game page and the settings page at
 * idle (75 files, 1.4 MB under the list), most of them never opened, and on
 * a fast link while the list's own scoreboards were still on their way.
 *
 * Now, once the list has its rows and the browser is idle, the game page
 * loads (its shared sections and data layer, so a game opens at once) with
 * the pages of the games live now; never on a frugal connection. A sport's
 * page otherwise loads as its row is pointed at, lit by the keys or touched
 * (pointerenter comes before the press), and Settings as its button is.
 * Every load here is a dynamic import, so none of it joins the list's own
 * chunks (`test/unit/bundleSplit.test.ts`), and each is idempotent.
 */
import type { ScoreEvent } from "../data/models";
import { frugal } from "../state/frugal";

/** Runs `warm` once the browser is idle (at most `timeout` ms on), unless the connection is frugal; returns its cancel. */
export function onIdle(warm: () => void, timeout = 3000): () => void {
  if (frugal()) return () => {};
  const idle = window.requestIdleCallback?.(warm, { timeout });
  const timer = idle == null ? window.setTimeout(warm, 1500) : undefined;
  return () => {
    if (idle != null) window.cancelIdleCallback?.(idle);
    if (timer != null) window.clearTimeout(timer);
  };
}

/** The game page, and a game's menu (so the first right-click opens it at once). */
export function warmGamePage(): void {
  void import("../features/game/GamePage").catch(() => {});
  void import("../features/scores/GameMenuContent").catch(() => {});
}

/** These games' pages: the game page and each one's sport. */
export function warmGames(events: readonly ScoreEvent[]): void {
  if (events.length === 0) return;
  void import("../features/game/GamePage").catch(() => {});
  void import("../features/game/sportPages").then((m) => m.warmEventPages(events.map((e) => e.ref))).catch(() => {});
}

/** The settings page, as its button is pointed at or focused. */
export function warmSettings(): void {
  void import("../features/settings/SettingsPage").catch(() => {});
}
