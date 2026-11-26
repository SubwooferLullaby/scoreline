/**
 * First-party analytics: the contract between the client's queue
 * (src/state/analytics.ts) and the Worker's ingest (worker/analytics.ts).
 * The event names, the wire format of `POST /api/t`, and its limits.
 * ARCHITECTURE.md § Analytics lists what each event means.
 *
 * No imports: `scripts/stats.mjs` and both TypeScript programs share it.
 */

/** Every event the ingest keeps. Anything else is dropped. */
export const EVENT_NAMES = [
  // Counted by the Worker as it serves the landing page (recordLandingView), or sent by its script.
  "landing_view",
  "sign_in_start",
  // Sent right after auth.
  "sign_up",
  "sign_in",
  // The app, signed in.
  "page_view",
  "game_open",
  "setting_change",
  "follow",
  "unfollow",
  "theme",
  // Goes to client_errors, not events.
  "error",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

/** What a signed-out browser may send. Everything else needs a session. */
export const SIGNED_OUT_EVENTS: readonly EventName[] = ["landing_view", "sign_in_start", "sign_up", "sign_in"];

export const INGEST_PATH = "/api/t";
export const MAX_BATCH = 50;
/** The largest body read; a bigger one is dropped unread. */
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_STACK = 2048;
export const MAX_MESSAGE = 500;

/** One event on the wire. `path` is a route pattern; `message` and `stack` are for `error` only. */
export interface WireEvent {
  readonly name: EventName;
  readonly ts: number;
  readonly path?: string;
  readonly league?: string;
  readonly props?: Readonly<Record<string, string | number | boolean>>;
  readonly message?: string;
  readonly stack?: string;
  /** The first event of a visit: where it came from (a host) and its UTM tags. */
  readonly ref?: string;
  readonly utm?: { readonly source?: string; readonly medium?: string; readonly campaign?: string };
}

/** The body of `POST /api/t`. `anon` and `session` are absent when the browser opts out (GPC, DNT). */
export interface WireBatch {
  readonly anon?: string;
  readonly session?: string;
  readonly release?: string;
  readonly events: readonly WireEvent[];
}
