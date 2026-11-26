/**
 * What the Worker reads beyond the generated bindings (.cloudflare/types):
 * the optional Google secrets, which aren't declared in cloudflare.config.ts
 * because a declared secret is required at deploy and Google waits on the
 * owner (docs/LAUNCH.md), and Vite's `import.meta.env`, which the Worker's
 * build replaces (`DEV` is false in every production bundle).
 */
interface Env {
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
}

interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  /** Vite: files matching a pattern, read at build time (development only: worker/devMigrations.ts). */
  glob<T>(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, T>;
}
