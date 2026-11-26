/**
 * A game page's URL, with its league when the caller knows it, so the page
 * loads off the scoreboards too ("/game/espn-401908043?league=mlb").
 *
 * Its own module, so the shell (the tab's alerts, rows, profiles) can link a
 * game without pulling in the game page's loaders and parsers.
 */
import { CATALOG, espnPath } from "./leagues";
import type { ScoreEvent } from "./models";

export function gameHref(eventID: string, leagueID?: string | null): string {
  const path = `/game/${encodeURIComponent(eventID)}`;
  return leagueID ? `${path}?league=${encodeURIComponent(leagueID)}` : path;
}

const BY_PATH = new Map(
  CATALOG.flatMap((l) => {
    const path = espnPath(l);
    return path ? [[path, l.id] as const] : [];
  }),
);

/**
 * A row's or tile's link: an ESPN game carries its league, read from its
 * path ("soccer/eng.1"; an unlisted competition by its slug), so a link
 * copied from the address bar opens for anyone without asking every league.
 */
export function eventHref(event: ScoreEvent): string {
  const ref = event.ref;
  if (ref?.kind !== "espn") return gameHref(event.id);
  return gameHref(event.id, BY_PATH.get(ref.path) ?? (ref.path.startsWith("soccer/") ? ref.path.slice("soccer/".length) : null));
}
