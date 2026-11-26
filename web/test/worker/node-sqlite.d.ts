// The Worker's program has no Node types; the D1 stand-in (d1.ts) uses these
// two Node modules, so they're declared here as far as it needs them.
declare module "node:sqlite" {
  interface StatementSync {
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): unknown;
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}

declare module "node:fs" {
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
