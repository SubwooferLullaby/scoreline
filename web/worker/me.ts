/**
 * `/api/me`: the signed-in account, for Settings → Account and settings sync
 * (src/state/account.ts, src/state/settingsSync.ts).
 *
 *   GET  /api/me             who you are, your passkeys, which sign-in methods are on
 *   GET  /api/me/settings    the account's settings copy: { user, settings, updatedAt } (null before the first upload)
 *   PUT  /api/me/settings    { settings } → { updatedAt }; a JSON object of at most 64 KB
 *   POST /api/me/delete      deletes the account and everything keyed to it, and signs out
 *
 * All need a real session (the end-to-end harness's stand-in gets 401), and
 * the writes need this site's Origin (no cross-site form can reach them; the
 * session cookie is SameSite=Lax as well). The server checks shape and size;
 * the client runs what it reads through `sanitize` (src/state/settings.ts).
 */
import { getAuth, getSession, siteOrigin, withCookies, cookiesOnly, type SignedIn } from "./auth";
import { jsonResponse, problem } from "./headers";
import { authMethods } from "./auth";

/** The settings store's largest accepted copy, in bytes of JSON. */
export const SETTINGS_LIMIT = 64 * 1024;

export interface MePasskey {
  readonly id: string;
  readonly name: string | null;
  readonly createdAt: number | null;
  readonly credentialID: string;
  readonly backedUp: boolean;
}

/** D1 holds Better Auth's dates as ISO text or epoch numbers: either becomes milliseconds. */
export function epochMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function me(request: Request, env: Env, path: string): Promise<Response> {
  const signedIn = await getSession(request, env);
  if (!signedIn || signedIn.bypass) return problem(401, "Sign in to use Scoreline.");
  const method = request.method;
  if (method !== "GET" && method !== "HEAD" && request.headers.get("Origin") !== siteOrigin(request, env)) {
    return problem(403, "Cross-site requests aren't accepted.");
  }
  let response: Response;
  if (path === "/api/me" && method === "GET") response = await profile(env, signedIn);
  else if (path === "/api/me/settings" && method === "GET") response = await readSettings(env, signedIn);
  else if (path === "/api/me/settings" && method === "PUT") response = await writeSettings(request, env, signedIn);
  else if (path === "/api/me/delete" && method === "POST") return deleteAccount(request, env, signedIn);
  else response = problem(path === "/api/me" || path === "/api/me/settings" || path === "/api/me/delete" ? 405 : 404, "Not found.");
  return withCookies(response, signedIn.headers);
}

async function profile(env: Env, { user }: SignedIn): Promise<Response> {
  const [passkeys, accounts] = await env.DB.batch([
    env.DB.prepare(`select "id", "name", "createdAt", "credentialID", "backedUp" from "passkey" where "userId" = ? order by "createdAt"`).bind(user.id),
    env.DB.prepare(`select "providerId" from "account" where "userId" = ?`).bind(user.id),
  ]);
  const keys: MePasskey[] = (passkeys?.results ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return { id: String(r.id), name: typeof r.name === "string" && r.name ? r.name : null, createdAt: epochMillis(r.createdAt), credentialID: String(r.credentialID), backedUp: Boolean(r.backedUp) };
  });
  const providers = [...new Set((accounts?.results ?? []).map((r) => String((r as Record<string, unknown>).providerId)))];
  return jsonResponse({ user: { name: user.name, email: user.email, image: user.image }, passkeys: keys, providers, methods: authMethods(env) });
}

async function readSettings(env: Env, { user }: SignedIn): Promise<Response> {
  const row = await env.DB.prepare(`select "json", "updated_at" from "user_settings" where "user_id" = ?`).bind(user.id).first<{ json: string; updated_at: number }>();
  if (!row) return jsonResponse({ user: user.id, settings: null, updatedAt: null });
  let settings: unknown = null;
  try {
    settings = JSON.parse(row.json);
  } catch {
    settings = null;
  }
  return jsonResponse({ user: user.id, settings, updatedAt: row.updated_at });
}

/** The body's settings, or why not: a JSON object (not an array), at most 64 KB. */
export function parseSettingsBody(text: string): { ok: true; json: string } | { ok: false; status: number; message: string } {
  if (new TextEncoder().encode(text).byteLength > SETTINGS_LIMIT + 64) return { ok: false, status: 413, message: "Settings are limited to 64 KB." };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, message: "Expected JSON." };
  }
  const settings = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).settings : undefined;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { ok: false, status: 400, message: "Expected { settings: { … } }." };
  const json = JSON.stringify(settings);
  if (new TextEncoder().encode(json).byteLength > SETTINGS_LIMIT) return { ok: false, status: 413, message: "Settings are limited to 64 KB." };
  return { ok: true, json };
}

async function writeSettings(request: Request, env: Env, { user }: SignedIn): Promise<Response> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (length > SETTINGS_LIMIT + 64) return problem(413, "Settings are limited to 64 KB.");
  const parsed = parseSettingsBody(await request.text());
  if (!parsed.ok) return problem(parsed.status, parsed.message);
  const updatedAt = Date.now();
  // Only for an account that still exists (a session cached on another device can outlive a deletion by minutes).
  const result = await env.DB.prepare(
    `insert into "user_settings" ("user_id", "json", "updated_at") select ?1, ?2, ?3 where exists (select 1 from "user" where "id" = ?1)
     on conflict ("user_id") do update set "json" = excluded."json", "updated_at" = excluded."updated_at"`,
  )
    .bind(user.id, parsed.json, updatedAt)
    .run();
  if (!result.meta.changes) return problem(401, "Sign in to use Scoreline.");
  return jsonResponse({ updatedAt });
}

/** The account and everything keyed to it: analytics events (when that table exists), settings, passkeys, linked accounts, sessions. */
export function deletionStatements(env: Env, userID: string, withEvents: boolean): D1PreparedStatement[] {
  return [
    ...(withEvents ? [env.DB.prepare(`delete from "events" where "user_id" = ?`).bind(userID)] : []),
    env.DB.prepare(`delete from "user_settings" where "user_id" = ?`).bind(userID),
    env.DB.prepare(`delete from "passkey" where "userId" = ?`).bind(userID),
    env.DB.prepare(`delete from "account" where "userId" = ?`).bind(userID),
    env.DB.prepare(`delete from "session" where "userId" = ?`).bind(userID),
    env.DB.prepare(`delete from "user" where "id" = ?`).bind(userID),
  ];
}

async function deleteAccount(request: Request, env: Env, { user }: SignedIn): Promise<Response> {
  // Sign out first: it removes this session and gives the headers that clear the cookies.
  let cleared = new Headers();
  try {
    const { headers } = await getAuth(env, request).api.signOut({ headers: request.headers, returnHeaders: true });
    cleared = cookiesOnly(headers);
  } catch (error) {
    console.log(JSON.stringify({ event: "delete_sign_out_failed", error: String(error) }));
  }
  const events = await env.DB.prepare(`select 1 from "sqlite_master" where "type" = 'table' and "name" = 'events'`).first();
  await env.DB.batch(deletionStatements(env, user.id, events != null));
  console.log(JSON.stringify({ event: "account_deleted" }));
  return withCookies(jsonResponse({ deleted: true }), cleared);
}

/**
 * Removing a passkey must leave a way back in: the guard in front of Better
 * Auth's delete-passkey (worker/index.ts). Null to let it through, else the
 * refusal.
 */
export async function guardPasskeyRemoval(request: Request, env: Env): Promise<Response | null> {
  const signedIn = await getSession(request, env);
  if (!signedIn || signedIn.bypass) return problem(401, "Sign in to use Scoreline.");
  const [passkeys, accounts] = await env.DB.batch<{ n: number }>([
    env.DB.prepare(`select count(*) as "n" from "passkey" where "userId" = ?`).bind(signedIn.user.id),
    env.DB.prepare(`select count(*) as "n" from "account" where "userId" = ? and "providerId" != 'credential'`).bind(signedIn.user.id),
  ]);
  const methods = Number(passkeys?.results[0]?.n ?? 0) + Number(accounts?.results[0]?.n ?? 0);
  return methods <= 1 ? problem(409, "Add another passkey before removing this one: it's your only way to sign in.") : null;
}
