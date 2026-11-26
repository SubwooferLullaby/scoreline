/**
 * The signed-in account, for Settings → Account: who you are, your passkeys
 * and which sign-in methods are on (`GET /api/me`, worker/me.ts), and what
 * you can do with them. Passkeys go through Better Auth's own endpoints
 * (src/auth/passkeys.ts); deleting the account is the Worker's own
 * (`POST /api/me/delete`).
 *
 * Leaving (Sign Out, Delete Account) also drops this device's sync record
 * (state/settingsSync.ts) and the service worker's offline shell, so a
 * signed-out visitor never gets the app from the cache (public/sw.js), then
 * goes to the landing. The device keeps its settings.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AuthError, createPasskey, passkeyAPI, signalUnknown } from "../auth/passkeys";
import { forgetSync } from "./settingsSync";

export interface AccountPasskey {
  readonly id: string;
  readonly name: string | null;
  readonly createdAt: number | null;
  readonly credentialID: string;
  readonly backedUp: boolean;
}

export interface Account {
  readonly user: { readonly name: string; readonly email: string | null; readonly image: string | null };
  readonly passkeys: readonly AccountPasskey[];
  /** Linked providers ("google"). */
  readonly providers: readonly string[];
  readonly methods: { readonly passkey: boolean; readonly google: boolean };
}

const KEY = ["account"] as const;

/** The account, or null when nobody is signed in (the gate off, or the end-to-end harness's stand-in). */
async function fetchAccount(): Promise<Account | null> {
  const response = await fetch("/api/me", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as Account;
}

export function useAccount() {
  return useQuery({ queryKey: KEY, queryFn: fetchAccount, staleTime: 30_000, retry: 1 });
}

/** Ways back in besides this passkey: another passkey, or a linked Google account. */
export function signInMethods(account: Account): number {
  return account.passkeys.length + account.providers.filter((p) => p !== "credential").length;
}

async function leave(): Promise<void> {
  forgetSync();
  try {
    await caches.delete("scoreline-shell-v2");
  } catch {
    // No Cache Storage (an insecure origin): nothing kept.
  }
  location.assign("/");
}

export function useAccountActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: KEY });
  return {
    async addPasskey() {
      await createPasskey({ signIn: false });
      await refresh();
    },
    async rename(id: string, name: string) {
      await passkeyAPI.rename(id, name);
      await refresh();
    },
    async remove(passkey: AccountPasskey) {
      await passkeyAPI.remove(passkey.id);
      signalUnknown(location.hostname, passkey.credentialID);
      await refresh();
    },
    async signOut() {
      await passkeyAPI.signOut();
      await leave();
    },
    async deleteAccount(account: Account) {
      const response = await fetch("/api/me/delete", { method: "POST", credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!response.ok) throw new AuthError(response.status === 429 ? "rate-limited" : "failed", String(response.status));
      for (const passkey of account.passkeys) signalUnknown(location.hostname, passkey.credentialID);
      await leave();
    },
  };
}
