/**
 * "/": on a phone, the scores themselves; beside the sidebar, the quiet
 * "no game selected" pane (Mail's "No Message Selected"). While games are
 * live, it offers the first few, in the list's order, a click from open.
 */
import { Link } from "react-router";
import { EmptyState } from "../design/components";
import type { ScoreEvent } from "../data/models";
import { eventHref } from "../data/gameHref";
import { useScoreboard } from "../state/scores";
import { ScoresPage } from "../features/scores/ScoresPage";
import { screenedLine } from "../features/scores/ScoresList";
import { useSplit } from "./layout";
import styles from "./IndexRoute.module.css";

/** How many live games the pane offers. */
const OFFERED = 3;

export function IndexRoute() {
  const split = useSplit();
  if (!split) return <ScoresPage variant="page" />;
  return <NoGameSelected />;
}

function NoGameSelected() {
  // The sidebar's list polls; this reads the same queries.
  const { sections } = useScoreboard({ poll: false });
  const seen = new Set<string>();
  const live: ScoreEvent[] = [];
  for (const section of sections) {
    for (const e of section.events) {
      if (e.state !== "live" || seen.has(e.id)) continue;
      seen.add(e.id);
      live.push(e);
    }
  }
  const offered = live.slice(0, OFFERED);
  return (
    <div className={styles.none}>
      <EmptyState
        level={1}
        icon="sportscourt"
        title="No Game Selected"
        message="Pick a game from the list. Use ↑ and ↓ to move through the games and Return to open one."
        note={
          offered.length > 0 ? (
            <nav className={styles.live} aria-label="Live now">
              <h2 className={styles.liveTitle}>Live now</h2>
              <ul>
                {offered.map((e) => (
                  <li key={e.id}>
                    <Link to={eventHref(e)} state={{ from: "Scores" }} className={styles.game}>
                      <span className={styles.dot} aria-hidden="true" />
                      <span className="tabular">{screenedLine(e)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null
        }
      />
    </div>
  );
}
