/**
 * The landing page's only script (pages/landing.html): the sign-in buttons.
 * No React and nothing of the app; just the passkey ceremonies
 * (src/auth/passkeys.ts) and the redirect after.
 *
 * - "Sign in with a passkey": the browser offers the passkeys it holds for
 *   this site (a discoverable credential; there's no username to type).
 * - "New here? Create a passkey": a new account with only a passkey.
 * - "Continue with Google": only when the Worker left the button in.
 *
 * Errors show inline, in plain words, in the status line. On success you go
 * to `?next=` (a same-origin path only: shared/routes.ts) or the app.
 */
import { safeNext } from "../../shared/routes";
import { AuthError, authErrorMessage, continueWithGoogle, createPasskey, passkeysSupported, signInWithPasskey } from "../auth/passkeys";

const params = new URLSearchParams(location.search);
const next = safeNext(params.get("next")) ?? "/";
const status = document.querySelector<HTMLElement>("[data-status]");
const buttons = [...document.querySelectorAll<HTMLButtonElement>("button[data-action]")];

function say(message: string | null) {
  if (!status) return;
  status.textContent = message ?? "";
  status.hidden = !message;
}

function busy(button: HTMLButtonElement | null, on: boolean, label?: string) {
  for (const b of buttons) b.disabled = on;
  if (!button) return;
  button.setAttribute("aria-busy", String(on));
  if (on) {
    button.dataset.label = button.textContent ?? "";
    if (label) button.textContent = label;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

async function run(button: HTMLButtonElement, label: string, action: () => Promise<void>, failure: Parameters<typeof authErrorMessage>[1]) {
  say(null);
  busy(button, true, label);
  try {
    await action();
    // Signed in: the page the visitor wanted (the Worker serves the app there now).
    location.replace(next);
  } catch (error) {
    busy(button, false);
    say(authErrorMessage(error, failure));
    if (failure === "sign-in") document.querySelector<HTMLButtonElement>('[data-action="create"]')?.focus();
  }
}

for (const button of buttons) {
  button.addEventListener("click", () => {
    switch (button.dataset.action) {
      case "passkey":
        void run(button, "Signing In…", signInWithPasskey, "sign-in");
        break;
      case "create":
        void run(button, "Creating…", () => createPasskey({ signIn: true }), "create");
        break;
      case "google":
        void run(button, "Opening Google…", () => continueWithGoogle(next), "google");
        break;
    }
  });
}

if (!passkeysSupported()) {
  for (const b of buttons) if (b.dataset.action !== "google") b.disabled = true;
  say(authErrorMessage(new AuthError("unsupported"), "sign-in"));
} else if (params.get("error") === "google") {
  say("Google sign-in didn't finish. Try again, or sign in with a passkey.");
}
