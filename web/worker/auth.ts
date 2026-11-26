/**
 * Accounts: Better Auth on D1, mounted at `/api/auth/*` (docs/LAUNCH.md).
 *
 * - Passkeys work with no setup, and a passkey can make an account on its
 *   own: registration needs no session (`requireSession: false`); a new
 *   ceremony resolves a pending user, and only a verified passkey creates
 *   the account ("Scoreline user", no email), so an abandoned sign-up
 *   leaves nothing behind. Signed in, the same endpoints add a passkey to
 *   your account.
 * - Google is on only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are
 *   set (`authMethods`); the landing and Settings hide it otherwise.
 * - Sessions live in an HttpOnly cookie, with the cookie cache on: a signed
 *   copy of the session rides along for 5 minutes, so the gate's check on a
 *   page or an /api call usually needs no D1 read.
 * - No IP addresses are stored (`disableIpTracking`); rate limits are the
 *   Worker's own (AUTH_LIMITER, worker/index.ts), not Better Auth's
 *   per-isolate memory.
 * - The base URL, the passkeys' relying party ID and their origin come from
 *   `SITE_URL`, else from the request's own origin, so a move to a custom
 *   domain is a config change.
 *
 * `getSession(request, env)` is the one way Worker code asks who is signed
 * in (the gate, the proxy's limit, /api/me, analytics).
 */
import { betterAuth } from "better-auth";
import { getAuthenticatorName, passkey } from "@better-auth/passkey";

/** Shown in Settings and to passkey managers. */
export const ACCOUNT_NAME = "Scoreline user";
/** Better Auth requires a unique email; a passkey account's is this reserved, undeliverable placeholder. */
export const PLACEHOLDER_EMAIL_DOMAIN = "passkey.invalid";
const PENDING = "pending:";
/** `scoreline.session_token` (`__Secure-` over https). */
export const COOKIE_PREFIX = "scoreline";
/** Used only by `pnpm dev` when `.dev.vars` has no BETTER_AUTH_SECRET. Never in a production bundle. */
const DEV_SECRET = "scoreline-local-development-secret-do-not-deploy";

export interface SignedInUser {
  readonly id: string;
  readonly name: string;
  /** Null for a passkey account. */
  readonly email: string | null;
  readonly image: string | null;
}

export interface SignedIn {
  readonly user: SignedInUser;
  readonly session: { readonly id: string; readonly expiresAt: Date };
  /** Set-Cookie headers to forward (a refreshed session or cookie cache). Often empty. */
  readonly headers: Headers;
  /** The end-to-end harness's stand-in session (`devSession`): development only. */
  readonly bypass?: true;
}

export interface AuthMethods {
  readonly passkey: true;
  readonly google: boolean;
}

export function authMethods(env: Env): AuthMethods {
  return { passkey: true, google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) };
}

/** The site's origin: `SITE_URL`, else the request's. No trailing slash. */
export function siteOrigin(request: Request, env: Env): string {
  const configured = (env.SITE_URL ?? "").trim();
  if (configured) return new URL(configured).origin;
  return new URL(request.url).origin;
}

export function requireSignIn(env: Env): boolean {
  return (env.REQUIRE_SIGN_IN ?? "on").trim().toLowerCase() !== "off";
}

/** The part of Better Auth the Worker uses (its full inferred type is too large to name). */
export interface Auth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(options: { headers: Headers; returnHeaders: true }): Promise<{
      headers: Headers;
      response: { user: { id: string; name: string; email: string; image?: string | null }; session: { id: string; expiresAt: Date } } | null;
    }>;
    signOut(options: { headers: Headers; returnHeaders: true }): Promise<{ headers: Headers }>;
  };
}

function createAuth(env: Env, origin: string, dev: boolean): Auth {
  const secret = env.BETTER_AUTH_SECRET || (dev ? DEV_SECRET : "");
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  const google = authMethods(env).google ? { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, prompt: "select_account" as const } : null;
  return betterAuth({
    appName: "Scoreline",
    baseURL: origin,
    basePath: "/api/auth",
    secret,
    database: env.DB,
    trustedOrigins: [origin],
    telemetry: { enabled: false },
    // The Worker's AUTH_LIMITER does this across isolates (worker/index.ts).
    rateLimit: { enabled: false },
    session: {
      expiresIn: 60 * 60 * 24 * 60,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    user: { deleteUser: { enabled: false } },
    account: { accountLinking: { enabled: false } },
    advanced: {
      // The migrations are the schema (migrations/); checking it costs a D1 read in every new isolate.
      // Development keeps the check, so a missing migration fails loudly.
      database: { validateSchema: dev },
      cookiePrefix: COOKIE_PREFIX,
      ipAddress: { disableIpTracking: true },
    },
    socialProviders: google ? { google } : {},
    plugins: [
      passkey({
        rpID: new URL(origin).hostname,
        rpName: "Scoreline",
        origin,
        // Accounts have no username, so every passkey must be discoverable: the browser offers it unasked.
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
        registration: {
          requireSession: false,
          // A passkey-first sign-up: nobody yet. The account is made once the passkey verifies.
          resolveUser: () => ({ id: `${PENDING}${crypto.randomUUID()}`, name: ACCOUNT_NAME, displayName: ACCOUNT_NAME }),
          afterVerification: async ({ ctx, user, verification }) => {
            const name = getAuthenticatorName(verification.registrationInfo?.aaguid) ?? "Passkey";
            if (!user.id.startsWith(PENDING)) return { name };
            const created = await ctx.context.internalAdapter.createUser({
              name: ACCOUNT_NAME,
              email: `${crypto.randomUUID()}@${PLACEHOLDER_EMAIL_DOMAIN}`,
              emailVerified: false,
            }, { method: "passkey" });
            return { userId: created.id, name };
          },
        },
      }),
    ],
  });
}

// One instance per isolate and origin (an isolate serves one deploy's env).
const instances = new WeakMap<Env, Map<string, Auth>>();

export function getAuth(env: Env, request: Request, dev = import.meta.env.DEV): Auth {
  const origin = siteOrigin(request, env);
  let byOrigin = instances.get(env);
  if (!byOrigin) instances.set(env, (byOrigin = new Map()));
  let auth = byOrigin.get(origin);
  if (!auth) byOrigin.set(origin, (auth = createAuth(env, origin, dev)));
  return auth;
}

/** The cookie the end-to-end harness sets (playwright.config.ts) for `devSession`. */
export const DEV_SESSION_COOKIE = "scoreline_dev_session";

/**
 * Development only: the end-to-end harness's stand-in session, so the
 * existing Playwright specs run signed in without a passkey ceremony each.
 * It holds only when all three are true: the Worker was built for
 * development (`import.meta.env.DEV`, false in every production bundle, so
 * this returns before reading anything), the request is to localhost, and it
 * carries the harness's cookie. It opens the gate and the proxy; it is never
 * an account (/api/me answers 401, and nothing is written for it).
 */
export function devSession(request: Request, dev = import.meta.env.DEV): SignedIn | null {
  if (!dev) return null;
  const host = new URL(request.url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") return null;
  if (!readCookie(request, DEV_SESSION_COOKIE)) return null;
  return {
    user: { id: "dev-harness", name: ACCOUNT_NAME, email: null, image: null },
    session: { id: "dev-harness", expiresAt: new Date(Date.now() + 3_600_000) },
    headers: new Headers(),
    bypass: true,
  };
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Whether the request carries a session cookie at all (no cookie: signed out, without starting Better Auth). */
export function hasSessionCookie(request: Request): boolean {
  const header = request.headers.get("Cookie") ?? "";
  return header.includes(`${COOKIE_PREFIX}.session_token=`);
}

/**
 * Who is signed in, or null. Reads the cookie cache when it's fresh (no D1
 * read), else the session row; a refreshed session or cache comes back in
 * `headers` for the response to forward. A failure reads as signed out.
 */
export async function getSession(request: Request, env: Env): Promise<SignedIn | null> {
  const bypass = devSession(request);
  if (bypass) return bypass;
  if (!hasSessionCookie(request)) return null;
  try {
    const { headers, response } = await getAuth(env, request).api.getSession({ headers: request.headers, returnHeaders: true });
    if (!response) return null;
    const { user, session } = response;
    return {
      user: {
        id: user.id,
        name: user.name || ACCOUNT_NAME,
        email: user.email && !user.email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`) ? user.email : null,
        image: user.image ?? null,
      },
      session: { id: session.id, expiresAt: new Date(session.expiresAt) },
      headers: cookiesOnly(headers),
    };
  } catch (error) {
    console.log(JSON.stringify({ event: "session_check_failed", error: String(error) }));
    return null;
  }
}

/** Only the Set-Cookie lines of a header set. */
export function cookiesOnly(headers: Headers | null | undefined): Headers {
  const out = new Headers();
  for (const cookie of headers?.getSetCookie() ?? []) out.append("Set-Cookie", cookie);
  return out;
}

/** A response with extra Set-Cookie lines appended (a response from fetch has immutable headers). */
export function withCookies(response: Response, cookies: Headers | null | undefined): Response {
  const lines = cookies?.getSetCookie() ?? [];
  if (lines.length === 0) return response;
  const out = new Response(response.body, response);
  for (const line of lines) out.headers.append("Set-Cookie", line);
  return out;
}
