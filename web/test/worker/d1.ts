/**
 * D1 in a test: the parts of `D1Database` the analytics use (prepare, bind,
 * all, run, first, batch), over Node's in-memory SQLite, with the real
 * migrations applied. SQLite is what D1 runs, so the SQL is checked as
 * written. Better Auth's `user` table is created as its migration makes it
 * on SQLite (dates as ISO strings).
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const USER_TABLE = `CREATE TABLE "user" ("id" text NOT NULL PRIMARY KEY, "name" text NOT NULL, "email" text NOT NULL UNIQUE, "emailVerified" integer NOT NULL, "image" text, "createdAt" date NOT NULL, "updatedAt" date NOT NULL)`;

class Statement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: readonly unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, params);
  }
  rows(): Record<string, unknown>[] {
    return this.db.prepare(this.sql).all(...this.params).map((row) => ({ ...row }));
  }
  async all() {
    return { results: this.rows(), success: true, meta: {} };
  }
  async run() {
    return this.all();
  }
  async first() {
    return this.rows()[0] ?? null;
  }
}

export interface TestD1 {
  readonly db: D1Database;
  readonly sqlite: DatabaseSync;
  /** Every row of a table. */
  rows(table: string): Record<string, unknown>[];
  addUser(id: string, email: string, createdAt: Date): void;
}

export function testD1(): TestD1 {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(USER_TABLE);
  sqlite.exec(readFileSync(new URL("../../migrations/0100_analytics.sql", (import.meta as { url: string }).url), "utf8"));
  const db = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    // D1 runs a batch as one transaction.
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) => ({ results: s.rows(), success: true, meta: {} }));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return {
    db,
    sqlite,
    rows: (table) => sqlite.prepare(`SELECT * FROM ${table}`).all().map((row) => ({ ...row })),
    addUser(id, email, createdAt) {
      const at = createdAt.toISOString();
      sqlite.prepare(`INSERT INTO "user" VALUES (?, ?, ?, 1, NULL, ?, ?)`).run(id, id, email, at, at);
    },
  };
}
