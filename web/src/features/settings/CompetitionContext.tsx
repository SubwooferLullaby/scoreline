import { Link } from "react-router";
import type { ScoreEvent } from "../../data/models";
import { competitionLine, competitionPath, type MatchCompetition } from "../../data/soccerCompetition";
import styles from "./Settings.module.css";

/** The link over a game's hero: where it was played, and the way to it (null when there's none). The hero leaves out a caption it repeats. */
export function competitionLink(event: ScoreEvent, competition: MatchCompetition | null): { href: string; name: string; note: string | null } | null {
  const ref = event.ref;
  const ring = event.content.kind === "match" ? [event.content.top.id, event.content.bottom.id].map((id) => id?.split("-").pop() ?? null) : [];
  const href = competition ? competitionPath(competition.slug, competition.year, ring)
    : ref?.kind === "counterStrike" && ref.tournament ? `/bracket/cs2/${encodeURIComponent(ref.tournament)}?name=${encodeURIComponent(event.caption ?? "Tournament")}`
    : ref?.kind === "climbing" ? "/schedule/climbing" : null;
  const name = competition ? competitionLine(competition) : ref?.kind === "climbing" ? ref.eventName : event.caption;
  return href && name ? { href, name, note: competition?.note ?? null } : null;
}

/** Where a match was played, and the way to it: the competition's name from its summary, never a provider's slug. */
export function CompetitionContext({ event, competition }: { event: ScoreEvent; competition: MatchCompetition | null }) {
  const link = competitionLink(event, competition);
  if (!link) return null;
  return <div className={styles.competitionContext}><Link to={link.href}>{link.name}</Link>{link.note ? <span>{link.note}</span> : null}</div>;
}
