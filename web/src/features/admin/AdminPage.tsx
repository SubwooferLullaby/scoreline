/**
 * The owner's numbers (`/admin`): Scoreline's own first-party analytics from
 * `GET /api/admin/stats` (worker/analytics.ts, shared/stats.ts). Tiles for
 * the totals, 30-day bars for sign-ups, active users and landing views,
 * ranked lists, the sign-up cohorts' return rates and recent client errors.
 *
 * Linked only from Settings, and only for admins (AdminLink); anyone else
 * who opens the URL sees Admins Only. No chart library: the bars are SVG and
 * CSS, in the design system's forms.
 */
import { useEffect, useState } from "react";
import type { DayCount, KeyCount, Stats } from "../../../shared/stats";
import { Button, EmptyState, ErrorState, FormSection, GroupBox, PageHeader, Skeleton } from "../../design/components";
import { PageBack } from "../../app/PageBack";
import { useDocumentTitle } from "../../app/useDocumentTitle";
import { useNavigate } from "react-router";
import styles from "./AdminPage.module.css";

type Load = { readonly status: "loading" } | { readonly status: "denied" } | { readonly status: "failed" } | { readonly status: "ready"; readonly stats: Stats };

const count = new Intl.NumberFormat();
const percent = (v: number | null) => (v == null ? "–" : `${Math.round(v * 100)}%`);
const dayLabel = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

export function AdminPage() {
  useDocumentTitle("Admin");
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/stats", { signal: controller.signal, headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) return setLoad({ status: "denied" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setLoad({ status: "ready", stats: (await response.json()) as Stats });
      })
      .catch(() => controller.signal.aborted || setLoad({ status: "failed" }));
    return () => controller.abort();
  }, [attempt]);

  return (
    <div className={styles.page}>
      <PageHeader title="Admin" icon="shield" leading={<PageBack />} />
      {load.status === "denied" ? (
        <EmptyState level={1} icon="shield" title="Admins Only" message="This page shows Scoreline's numbers to its owners." actions={<Button onClick={() => navigate("/")}>Back to Scores</Button>} />
      ) : load.status === "failed" ? (
        <ErrorState level={1} subject="Stats" onRetry={() => setAttempt((n) => n + 1)} />
      ) : load.status === "loading" ? (
        <Loading />
      ) : (
        <Report stats={load.stats} />
      )}
    </div>
  );
}

function Loading() {
  return (
    <div className={styles.column} aria-busy="true">
      <div className={styles.tiles}>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className={styles.tile}>
            <Skeleton width={48} height={8} />
            <Skeleton width={36} height={18} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Report({ stats }: { readonly stats: Stats }) {
  const { totals, retention } = stats;
  return (
    <div className={`${styles.column} ${styles.entrance}`}>
      <div className={styles.tiles}>
        <Tile label="Users" value={count.format(totals.users)} />
        <Tile label="Sign-Ups" value={count.format(totals.signups30d)} note="30 days" />
        <Tile label="Daily Active" value={count.format(totals.dau)} note="Today" />
        <Tile label="Weekly Active" value={count.format(totals.wau)} note="7 days" />
        <Tile label="Monthly Active" value={count.format(totals.mau)} note="30 days" />
        <Tile label="Landing Views" value={count.format(totals.landings30d)} note="30 days" />
        <Tile label="Conversion" value={percent(totals.conversion)} note="Landing to sign-up" />
        <Tile label="Day 1 Return" value={percent(retention.d1)} note="Sign-up cohorts" />
        <Tile label="Day 7 Return" value={percent(retention.d7)} note="Sign-up cohorts" />
      </div>

      <FormSection title="Sign-Ups" icon="person">
        <Bars days={stats.signupsByDay} label="Sign-ups" />
      </FormSection>
      <FormSection title="Active Users" icon="sparkles">
        <Bars days={stats.activeByDay} label="Active users" />
      </FormSection>
      <FormSection title="Landing Views" icon="compass">
        <Bars days={stats.landingsByDay} label="Landing views" />
      </FormSection>

      <div className={styles.lists}>
        <Ranked title="Top Referrers" icon="external" rows={stats.referrers} empty="No referrers yet" />
        <Ranked
          title="Campaigns"
          icon="flag"
          rows={stats.campaigns.map((c) => ({ key: [c.source, c.medium, c.campaign].filter(Boolean).join(" · ") || "(none)", n: c.n }))}
          empty="No UTM campaigns yet"
        />
        <Ranked title="Leagues by Game Opens" icon="sportscourt" rows={stats.leagues} empty="No games opened yet" />
        <Ranked title="Top Pages" icon="list" rows={stats.routes} empty="No page views yet" mono />
        <Ranked title="Devices" icon="display" rows={stats.devices.map((d) => ({ key: d.key.charAt(0).toUpperCase() + d.key.slice(1), n: d.n }))} empty="No visits yet" />
        <Ranked title="Countries" icon="flag" rows={stats.countries} empty="No visits yet" />
      </div>

      <FormSection title="Retention" icon="calendar" caption="Of each day's sign-ups, how many came back the next day and a week later.">
        {retention.cohorts.length === 0 ? (
          <p className={styles.hint}>No sign-ups in the last five weeks</p>
        ) : (
          <GroupBox>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Signed Up</th>
                  <th scope="col">Users</th>
                  <th scope="col">Day 1</th>
                  <th scope="col">Day 7</th>
                </tr>
              </thead>
              <tbody>
                {[...retention.cohorts].reverse().map((c) => (
                  <tr key={c.day}>
                    <th scope="row">{dayLabel(c.day)}</th>
                    <td>{count.format(c.users)}</td>
                    <td>{percent(c.d1 / c.users)}</td>
                    <td>{percent(c.d7 / c.users)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GroupBox>
        )}
      </FormSection>

      <FormSection title="Client Errors" icon="warning" caption="The last 7 days, by count. The same message at the same frame counts once per occurrence.">
        {stats.errors.length === 0 ? (
          <p className={styles.hint}>No errors reported</p>
        ) : (
          <GroupBox>
            {stats.errors.map((e, i) => (
              <details key={i} className={styles.error}>
                <summary>
                  <span className={styles.errorCount}>{count.format(e.count)}</span>
                  <span className={styles.errorMessage}>{e.message}</span>
                </summary>
                <p className={styles.errorMeta}>
                  {[e.path, e.release, `last ${new Date(e.lastSeen).toLocaleString()}`].filter(Boolean).join(" · ")}
                </p>
                {e.stack ? <pre className={styles.stack}>{e.stack}</pre> : null}
              </details>
            ))}
          </GroupBox>
        )}
      </FormSection>

      <p className={styles.footnote}>Updated {new Date(stats.generatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}. Days are UTC.</p>
    </div>
  );
}

function Tile({ label, value, note }: { readonly label: string; readonly value: string; readonly note?: string }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {note ? <span className={styles.tileNote}>{note}</span> : null}
    </div>
  );
}

/** Thirty days as bars, oldest at the left; each bar says its day and count on hover. */
function Bars({ days, label }: { readonly days: readonly DayCount[]; readonly label: string }) {
  const max = Math.max(1, ...days.map((d) => d.n));
  const total = days.reduce((sum, d) => sum + d.n, 0);
  const peak = days.reduce((best, d) => (d.n > best.n ? d : best), days[0] ?? { day: "", n: 0 });
  const width = 300;
  const height = 64;
  const slot = width / Math.max(days.length, 1);
  const spoken = total === 0 ? `${label}: none in 30 days` : `${label}: ${count.format(total)} in 30 days, most on ${dayLabel(peak.day)} (${count.format(peak.n)})`;
  return (
    <GroupBox>
      <div className={styles.chart}>
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={spoken} className={styles.bars}>
          <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} className={styles.baseline} />
          {days.map((d, i) => {
            const h = d.n === 0 ? 0 : Math.max(2, (d.n / max) * (height - 4));
            return (
              <rect key={d.day} x={i * slot + slot * 0.15} width={slot * 0.7} y={height - h} height={h} rx={1} className={styles.bar}>
                <title>{`${dayLabel(d.day)}: ${count.format(d.n)}`}</title>
              </rect>
            );
          })}
        </svg>
        <div className={styles.axis} aria-hidden="true">
          <span>{days[0] ? dayLabel(days[0].day) : ""}</span>
          <span>Peak {count.format(max === 1 && total === 0 ? 0 : max)}</span>
          <span>Today</span>
        </div>
      </div>
    </GroupBox>
  );
}

/** A ranked list with each row's share as a bar behind its count. */
function Ranked({ title, icon, rows, empty, mono = false }: { readonly title: string; readonly icon: Parameters<typeof FormSection>[0]["icon"]; readonly rows: readonly KeyCount[]; readonly empty: string; readonly mono?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <FormSection title={title} icon={icon}>
      {rows.length === 0 ? (
        <p className={styles.hint}>{empty}</p>
      ) : (
        <GroupBox label={title}>
          {rows.map((r) => (
            <div key={r.key} className={styles.rankRow}>
              <span className={styles.rankFill} style={{ inlineSize: `${(r.n / max) * 100}%` }} aria-hidden="true" />
              <span className={mono ? `${styles.rankKey} ${styles.mono}` : styles.rankKey}>{r.key}</span>
              <span className={styles.rankCount}>{count.format(r.n)}</span>
            </div>
          ))}
        </GroupBox>
      )}
    </FormSection>
  );
}
