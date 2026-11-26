/**
 * Development only: `pnpm dev` applies `migrations/*.sql` to its local D1 the
 * first time the Worker touches the database, so a fresh checkout signs in
 * with no setup. It records each file in `d1_migrations` as
 * `cf d1 migrations apply` does (same table, same names), so the two never
 * disagree. Imported only behind `import.meta.env.DEV` (worker/auth.ts):
 * production bundles carry none of it, and production migrations are applied
 * by hand (`cf d1 migrations apply <id>`, ARCHITECTURE.md).
 */
const FILES = import.meta.glob<string>("../migrations/*.sql", { query: "?raw", import: "default", eager: true });

/** A migration file's statements: comment lines dropped, split at each `;` that ends a line. */
export function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

let applied: Promise<void> | null = null;

export function migrateLocal(db: D1Database): Promise<void> {
  applied ??= run(db).catch((error: unknown) => {
    applied = null;
    console.log(JSON.stringify({ event: "dev_migrations_failed", error: String(error) }));
  });
  return applied;
}

async function run(db: D1Database): Promise<void> {
  await db.prepare(`create table if not exists d1_migrations (id integer primary key autoincrement, name text unique, applied_at timestamp default current_timestamp not null)`).run();
  const done = new Set((await db.prepare(`select name from d1_migrations`).all<{ name: string }>()).results.map((r) => r.name));
  for (const [path, sql] of Object.entries(FILES).sort(([a], [b]) => a.localeCompare(b))) {
    const name = path.split("/").pop()!;
    if (done.has(name)) continue;
    await db.batch([...statements(sql).map((s) => db.prepare(s)), db.prepare(`insert into d1_migrations (name) values (?)`).bind(name)]);
    console.log(JSON.stringify({ event: "dev_migration_applied", name }));
  }
}
