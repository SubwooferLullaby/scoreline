/**
 * Settings sync: the settings store (state/settings.ts) follows the account
 * to every device it signs in on (docs/LAUNCH.md). localStorage stays the
 * working copy; the account's copy lives in D1 behind `/api/me/settings`
 * (worker/me.ts), last write wins.
 *
 * - **On start, signed in:** read the account's copy. None yet (a first
 *   sign-in): upload this device's. A copy written since this device last
 *   synced, or this device never synced with this account: adopt it, unless
 *   this device changed something after that copy was written.
 * - **Local changes** (this tab's, `subscribeLocalChanges`) are sent 2 s
 *   after the last one, and at once when the page is hidden or closed
 *   (`keepalive`, so it survives the page).
 * - Signed out, or the end-to-end harness's stand-in session: the read
 *   answers 401 and nothing syncs.
 *
 * What this device knows about the sync is kept beside the settings, under
 * its own key (`scoreline.settings.sync.v1`), so `scoreline.settings.v1` and
 * the before-paint theme reader are untouched:
 *
 * - `user`: the account it last synced with;
 * - `syncedAt`: the server's `updatedAt` of the copy it last adopted or sent;
 * - `changedAt`: when this device last changed a setting that isn't sent
 *   yet (its own clock), or null.
 *
 * `planSync` is the rule, pure, and tested (test/unit/settingsSync.test.ts).
 */
import { adoptSettings, getSettings, sanitize, subscribeLocalChanges } from "./settings";

export const SYNC_KEY = "scoreline.settings.sync.v1";
export const SYNC_DELAY_MS = 2_000;
const ENDPOINT = "/api/me/settings";

export interface SyncMeta {
  readonly user: string | null;
  readonly syncedAt: number | null;
  readonly changedAt: number | null;
}

export interface ServerCopy {
  readonly user: string;
  /** Null before the account's first upload. */
  readonly settings: unknown;
  readonly updatedAt: number | null;
}

export type SyncPlan = "adopt" | "upload" | "none";

const EMPTY: SyncMeta = { user: null, syncedAt: null, changedAt: null };

/** What to do with the account's copy on start. */
export function planSync(meta: SyncMeta, server: ServerCopy): SyncPlan {
  // A first sign-in: the account has nothing yet, so it takes this device's.
  if (server.settings == null || server.updatedAt == null) return "upload";
  // A new device, or another account than this device last synced with: the account's copy wins.
  if (meta.user !== server.user) return "adopt";
  const pending = meta.changedAt != null;
  if (server.updatedAt > (meta.syncedAt ?? 0)) {
    // Written elsewhere since: last write wins.
    return pending && meta.changedAt! > server.updatedAt ? "upload" : "adopt";
  }
  return pending ? "upload" : "none";
}

/** The meta after a successful upload of the change stamped `sent`: a newer change stays pending. */
export function afterUpload(meta: SyncMeta, user: string, updatedAt: number, sent: number | null): SyncMeta {
  return { user, syncedAt: updatedAt, changedAt: meta.changedAt != null && sent != null && meta.changedAt > sent ? meta.changedAt : null };
}

export function readMeta(): SyncMeta {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(SYNC_KEY) ?? "null") as Partial<SyncMeta> | null;
    if (!raw || typeof raw !== "object") return EMPTY;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { user: typeof raw.user === "string" ? raw.user : null, syncedAt: num(raw.syncedAt), changedAt: num(raw.changedAt) };
  } catch {
    return EMPTY;
  }
}

function writeMeta(meta: SyncMeta): void {
  try {
    globalThis.localStorage?.setItem(SYNC_KEY, JSON.stringify(meta));
  } catch {
    // Storage blocked: the sync still runs for this session.
  }
}

/** Sign Out and Delete Account: this device no longer syncs with that account (its settings stay). */
export function forgetSync(): void {
  try {
    globalThis.localStorage?.removeItem(SYNC_KEY);
  } catch {
    // Nothing stored.
  }
  stop();
}

let started = false;
let user: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;

function stop() {
  user = null;
  if (timer) clearTimeout(timer);
  timer = null;
  unsubscribe?.();
  unsubscribe = null;
}

async function upload({ keepalive = false } = {}): Promise<void> {
  if (!user) return;
  const meta = readMeta();
  const sent = meta.changedAt;
  const body = JSON.stringify({ settings: getSettings() });
  try {
    const response = await fetch(ENDPOINT, {
      method: "PUT",
      credentials: "same-origin",
      keepalive: keepalive && body.length < 60_000,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });
    if (response.status === 401) return stop();
    if (!response.ok) return;
    const { updatedAt } = (await response.json()) as { updatedAt: number };
    if (user) writeMeta(afterUpload(readMeta(), user, updatedAt, sent));
  } catch {
    // Offline: the change stays pending and goes with the next one, or the next start.
  }
}

function schedule() {
  if (!user) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void upload();
  }, SYNC_DELAY_MS);
}

function flush() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
  void upload({ keepalive: true });
}

/** Starts syncing once per page (src/main.tsx, after load). */
export function startSettingsSync(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  // Changes made before the account's copy arrives still count as pending.
  unsubscribe = subscribeLocalChanges(() => {
    writeMeta({ ...readMeta(), changedAt: Date.now() });
    schedule();
  });
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  void begin();
}

async function begin(): Promise<void> {
  let server: ServerCopy;
  try {
    const response = await fetch(ENDPOINT, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) return stop();
    server = (await response.json()) as ServerCopy;
  } catch {
    return stop();
  }
  if (!unsubscribe) return;
  const meta = readMeta();
  const plan = planSync(meta, server);
  user = server.user;
  if (plan === "adopt") {
    adoptSettings(sanitize(server.settings));
    writeMeta({ user: server.user, syncedAt: server.updatedAt, changedAt: null });
  } else if (plan === "upload") {
    if (meta.changedAt == null) writeMeta({ ...meta, user: server.user, changedAt: Date.now() });
    await upload();
  } else {
    writeMeta({ ...meta, user: server.user });
  }
}
