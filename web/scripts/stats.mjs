// The owner's numbers from the command line: the same queries as /admin
// (shared/stats.ts) against the deployed D1 database, through the `cf` CLI,
// printed as a compact text report.
//
//     CLOUDFLARE_ACCOUNT_ID=<id> pnpm stats
//     CLOUDFLARE_ACCOUNT_ID=<id> pnpm stats --json    # the report as JSON, as /api/admin/stats answers
//     SCORELINE_D1_ID=<local id> pnpm stats --local [--persist-to <dir>]   # a local simulation instead
//
// The database is the one named "scoreline" (cloudflare.config.ts), found
// with `cf d1 list`; SCORELINE_D1_ID skips the lookup. The account comes from
// CLOUDFLARE_ACCOUNT_ID and is never written here. Reads only: the
// statements are the SELECTs in shared/stats.ts, sent as one batch with
// `cf d1 raw` (which, unlike `query`, also runs against a local simulation).
import { execFileSync } from "node:child_process";
import { STATS_QUERIES, shapeStats } from "../shared/stats.ts";

const DATABASE = "scoreline";
const args = process.argv.slice(2);
const local = args.includes("--local");
const persist = args.includes("--persist-to") ? ["--persist-to", args[args.indexOf("--persist-to") + 1]] : [];

if (!local && !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error("Set CLOUDFLARE_ACCOUNT_ID to the account Scoreline deploys to.");
  process.exit(1);
}
if (local && !process.env.SCORELINE_D1_ID) {
  console.error("Set SCORELINE_D1_ID to the local database's ID.");
  process.exit(1);
}

/** Runs `cf` and parses its JSON answer. */
function cf(cfArgs) {
  const out = execFileSync("cf", [...cfArgs, ...(local ? ["--local", ...persist] : [])], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

/** A raw result set ({ columns, rows }) as row objects. */
const objects = (set) => (set?.results?.rows ?? []).map((row) => Object.fromEntries(set.results.columns.map((column, i) => [column, row[i]])));

/** The API's `result` whether or not the CLI unwrapped it. */
const result = (answer) => (answer && typeof answer === "object" && "result" in answer ? answer.result : answer);

function databaseID() {
  if (process.env.SCORELINE_D1_ID) return process.env.SCORELINE_D1_ID;
  const list = result(cf(["d1", "list", "--name", DATABASE]));
  const match = (Array.isArray(list) ? list : []).find((db) => db.name === DATABASE);
  if (!match) {
    console.error(`No D1 database named "${DATABASE}" in this account.`);
    process.exit(1);
  }
  return match.uuid ?? match.id;
}

const names = Object.keys(STATS_QUERIES);
// One request: a batch, one result set per statement, in order.
const answers = result(cf(["d1", "raw", databaseID(), "--batch", JSON.stringify(names.map((name) => ({ sql: STATS_QUERIES[name] })))]));
const sets = Array.isArray(answers) ? answers : [answers];
const stats = shapeStats(Object.fromEntries(names.map((name, i) => [name, objects(sets[i])])));

if (args.includes("--json")) {
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

// MARK: - The report

const n = (v) => new Intl.NumberFormat("en-US").format(v);
const pct = (v) => (v == null ? "–" : `${Math.round(v * 100)}%`);
const BLOCKS = " ▁▂▃▄▅▆▇█";
const spark = (days) => {
  const max = Math.max(1, ...days.map((d) => d.n));
  return days.map((d) => BLOCKS[d.n === 0 ? 0 : Math.max(1, Math.round((d.n / max) * 8))]).join("");
};
const total = (days) => days.reduce((sum, d) => sum + d.n, 0);
const ranked = (title, rows) => {
  if (rows.length === 0) return;
  console.log(`\n${title}`);
  const width = Math.max(...rows.map((r) => r.key.length));
  for (const r of rows) console.log(`  ${r.key.padEnd(width)}  ${n(r.n).padStart(6)}`);
};

const { totals, retention } = stats;
console.log(`Scoreline · ${stats.generatedAt.slice(0, 16).replace("T", " ")} UTC · 30 days\n`);
console.log(`Users ${n(totals.users)}   Sign-ups ${n(totals.signups30d)}   DAU ${n(totals.dau)}   WAU ${n(totals.wau)}   MAU ${n(totals.mau)}`);
console.log(`Landing views ${n(totals.landings30d)}   Conversion ${pct(totals.conversion)}   Day 1 return ${pct(retention.d1)}   Day 7 return ${pct(retention.d7)}\n`);
for (const [label, days] of [["Sign-ups", stats.signupsByDay], ["Active", stats.activeByDay], ["Landings", stats.landingsByDay]]) {
  console.log(`${label.padEnd(9)} ${spark(days)}  ${n(total(days))}`);
}
ranked("Referrers", stats.referrers);
ranked("Campaigns (source · medium · campaign)", stats.campaigns.map((c) => ({ key: [c.source, c.medium, c.campaign].filter(Boolean).join(" · "), n: c.n })));
ranked("Leagues by game opens", stats.leagues);
ranked("Pages", stats.routes);
ranked("Devices", stats.devices);
ranked("Countries", stats.countries);
if (stats.errors.length > 0) {
  console.log("\nClient errors, 7 days");
  for (const e of stats.errors.slice(0, 10)) console.log(`  ${n(e.count).padStart(5)}  ${e.message.slice(0, 90)}${e.path ? `  (${e.path})` : ""}`);
}
