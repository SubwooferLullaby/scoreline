/**
 * Signing in, in the browser: the landing page's buttons and Settings →
 * Account share these. They talk to Better Auth's endpoints on the Worker
 * (worker/auth.ts) directly, with @simplewebauthn/browser for the passkey
 * ceremonies, so the landing's script stays a few kilobytes (no auth client,
 * no React).
 *
 * - `signInWithPasskey`: a discoverable credential (no username to type: the
 *   browser offers the passkeys it has for this site).
 * - `createPasskey`: signed out, a new account with only a passkey; signed
 *   in, another passkey for your account.
 * - `continueWithGoogle`: Better Auth's redirect to Google and back.
 *
 * Every failure is an `AuthError` whose `kind` picks the words people see
 * (`authErrorMessage`), never a raw message.
 */
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";

export type AuthErrorKind = "cancelled" | "unsupported" | "unknown-passkey" | "already-registered" | "rate-limited" | "last-method" | "failed";

export class AuthError extends Error {
  readonly kind: AuthErrorKind;
  constructor(kind: AuthErrorKind, message: string = kind) {
    super(message);
    this.name = "AuthError";
    this.kind = kind;
  }
}

const BASE = "/api/auth";

export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn();
}

async function call<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: init?.method ?? "GET",
      credentials: "same-origin",
      headers: init?.body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new AuthError("failed", "network");
  }
  if (response.ok) return (await response.json().catch(() => null)) as T;
  const body = (await response.json().catch(() => null)) as { code?: string; error?: { message?: string } } | null;
  if (response.status === 429) throw new AuthError("rate-limited");
  if (response.status === 409) throw new AuthError("last-method");
  if (body?.code === "PASSKEY_NOT_FOUND") throw new AuthError("unknown-passkey");
  if (body?.code === "PREVIOUSLY_REGISTERED") throw new AuthError("already-registered");
  throw new AuthError("failed", body?.code ?? String(response.status));
}

/** The browser's own refusals: a cancelled or timed-out prompt, an authenticator that already holds one. */
function ceremonyError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  const name = (error as { name?: string; cause?: { name?: string } } | null)?.cause?.name ?? (error as { name?: string } | null)?.name;
  const code = (error as { code?: string } | null)?.code;
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") return new AuthError("already-registered");
  if (name === "NotAllowedError" || name === "AbortError" || code === "ERROR_CEREMONY_ABORTED") return new AuthError("cancelled");
  return new AuthError("failed", String(name ?? error));
}

/** Signs in with a passkey this device or password manager holds for the site. */
export async function signInWithPasskey(): Promise<void> {
  if (!passkeysSupported()) throw new AuthError("unsupported");
  const optionsJSON = await call<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/passkey/generate-authenticate-options");
  let response;
  try {
    response = await startAuthentication({ optionsJSON });
  } catch (error) {
    throw ceremonyError(error);
  }
  try {
    await call("/passkey/verify-authentication", { method: "POST", body: { response } });
  } catch (error) {
    // The site no longer knows this credential (a deleted account): tell the password manager, where it can listen.
    if (error instanceof AuthError && error.kind === "unknown-passkey") signalUnknown(optionsJSON.rpId, response.id);
    throw error;
  }
}

/**
 * Makes a passkey. Signed out (`signIn: true`): a new account, signed in at
 * once. Signed in: another passkey for this account.
 */
export async function createPasskey({ signIn }: { signIn: boolean }): Promise<void> {
  if (!passkeysSupported()) throw new AuthError("unsupported");
  const optionsJSON = await call<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/passkey/generate-register-options");
  let response;
  try {
    response = await startRegistration({ optionsJSON });
  } catch (error) {
    throw ceremonyError(error);
  }
  await call("/passkey/verify-registration", { method: "POST", body: { response, createSession: signIn } });
}

/** Leaves for Google's consent page; it comes back to `next` (or the landing with `?error=google`). */
export async function continueWithGoogle(next: string): Promise<void> {
  const { url } = await call<{ url: string }>("/sign-in/social", {
    method: "POST",
    body: { provider: "google", callbackURL: next, errorCallbackURL: "/?error=google", newUserCallbackURL: next },
  });
  location.assign(url);
  // The page is leaving for Google: nothing after this should run (no redirect of our own).
  return new Promise<never>(() => {});
}

/** Better Auth's account endpoints for Settings → Account. */
export const passkeyAPI = {
  rename: (id: string, name: string) => call("/passkey/update-passkey", { method: "POST", body: { id, name } }),
  remove: (id: string) => call("/passkey/delete-passkey", { method: "POST", body: { id } }),
  signOut: () => call("/sign-out", { method: "POST", body: {} }),
};

/**
 * WebAuthn's Signal API, where the browser has it: the site no longer
 * accepts this credential, so a password manager can drop it.
 */
export function signalUnknown(rpId: string | undefined, credentialId: string): void {
  const signal = (globalThis.PublicKeyCredential as unknown as { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> } | undefined)?.signalUnknownCredential;
  if (!signal) return;
  void signal.call(globalThis.PublicKeyCredential, { rpId: rpId ?? location.hostname, credentialId }).catch(() => {});
}

/** The words for a failure, in plain sentences (the landing's and Settings' inline errors). */
export function authErrorMessage(error: unknown, action: "sign-in" | "create" | "add" | "google" | "remove" | "rename" | "sign-out" | "delete"): string {
  const kind = error instanceof AuthError ? error.kind : "failed";
  switch (kind) {
    case "unsupported":
      return "This browser can't use passkeys. Try an up-to-date Safari, Chrome, Edge or Firefox.";
    case "cancelled":
      return action === "sign-in"
        ? "No passkey was used. If you don't have one for Scoreline yet, create one below."
        : "No passkey was created.";
    case "unknown-passkey":
      return "That passkey doesn't belong to a Scoreline account anymore. Create a new one below.";
    case "already-registered":
      return "This device already has a passkey for your account.";
    case "rate-limited":
      return "Too many tries. Wait a minute, then try again.";
    case "last-method":
      return "Add another passkey before removing this one: it's your only way to sign in.";
    case "failed":
      return {
        "sign-in": "Couldn't sign you in. Try again in a moment.",
        create: "Couldn't create your account. Try again in a moment.",
        add: "Couldn't add the passkey. Try again in a moment.",
        google: "Couldn't reach Google. Try again in a moment.",
        remove: "Couldn't remove the passkey. Try again in a moment.",
        rename: "Couldn't rename the passkey. Try again in a moment.",
        "sign-out": "Couldn't sign you out. Try again in a moment.",
        delete: "Couldn't delete your account. Try again in a moment.",
      }[action];
  }
}
