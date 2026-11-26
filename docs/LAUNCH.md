# Public launch of the web app

The owner's brief (2026-11-26): get the web app ready for real users, as a free service you sign in to. Keep it minimal. A single-page landing in plain text, like a design engineer's personal site: straight to the point and factual. Count users and what they do in our own database. No money for now. Ads, and a cheap way to remove them, may come once there are users. Separately, plan to slim the Mac app down and leave the heavy pages to the web.

This file holds the decisions and the checklist. `web/ARCHITECTURE.md` holds how each piece is built.

## Decisions

- **The app is behind sign-in.** Signed out, `/` is the landing page and every other app route sends you there, with the route kept so that you land on it after you sign in. `/privacy` and `/terms` are public. The Worker decides before any HTML is served, so a signed-out visitor never downloads the app bundle. The `/api/*` proxy answers 401 without a session. One flag, `REQUIRE_SIGN_IN`, turns the gate off.
- **Accounts:** [Better Auth](https://better-auth.com) on the Worker, with Cloudflare D1 as its database (`scoreline`, on the owner's personal account only).
  - **Passkeys** work everywhere with no setup: Face ID, Touch ID, Windows Hello, a phone or a password manager. A passkey can create an account on its own, with no email.
  - **Google** is on (2026-11-26). The OAuth client lives in the Google Cloud project "Scoreline" on the owner's Google account, published to production with the basic scopes only (openid, email, profile), so it needs no verification. Its secrets are `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the Worker.
  - **No email sign-in** (owner, 2026-11-26): passkeys and Google are the two ways in. Revisit only if the analytics show many people stalling at the passkey prompt (`sign_in_start` against `sign_up`).
  - Sessions live in an HttpOnly cookie, so each request needs no database read.
  - In Settings → Account you can see who you're signed in as, manage your passkeys, sign out, and delete the account along with its data.
- **Your settings follow your account.** Followed teams, leagues and the rest of the settings sync to D1 on change, last write wins. A new device takes the account's copy. The first sign-in uploads the device's copy.
- **Analytics are first-party only.** No third-party scripts, no ad pixels, and no IP addresses stored.
  - Events go to D1 in batches: page views by route pattern, game opens by league, sign-ups, sign-ins, setting changes and client errors.
  - Landing visits are counted by the Worker, with the referrer host, UTM tags, country and device class.
  - `/admin` shows the numbers to the owner's accounts (`ADMIN_EMAILS` and `ADMIN_USER_IDS`, both secrets). `pnpm stats` prints them from the CLI.
- **The landing page** is one static HTML page served by the Worker, with no framework and no app bundle. It uses system fonts, plain text, a small amount of type hierarchy, and supports light and dark. A tiny script runs the sign-in buttons. The copy is below.
- **Hardening:**
  - security headers on every HTML response (CSP, HSTS, Referrer-Policy, Permissions-Policy, frame-ancestors none)
  - rate limits on the auth endpoints and the proxy
  - `robots.txt` that allows the public pages only
  - Open Graph and Twitter cards
  - a 404 and an error page in the same plain style
- **Domain: `scoreline.fyi`** (owner, 2026-11-26; $5.20 a year at cost on Cloudflare Registrar). With `SITE_URL` set, every other host, workers.dev included, answers a 301 to it, so the site has one origin and passkeys have one relying party.
- **Not now:** ads and payments. Each needs an owner decision. Ads and payments also need data licensing first, because ESPN's terms bar commercial use of its API.

## Landing copy

Keep it this short, and don't add hype.

> **Scoreline**
>
> Live scores, told play by play.
>
> Scoreline follows the games you care about and shows each one as it happens: every pitch, drive and shot in order, on a small animated field, with the score, the timeline and the box score beside it.
>
> Soccer, the NFL and college football, MLB, the NBA and WNBA, Counter-Strike 2 and climbing.
>
> It's free. Sign in to start.
>
> [Get Started] [Continue with Google]
> Your account is a passkey: Face ID, Touch ID, Windows Hello or your password manager. No password, no email.
> Already have an account? Sign In
>
> **What's in it**
> - Every league you follow, live, in one list.
> - A page for every game: the plays in order, an animated view of the field, the timeline, the box score and win probability.
> - Schedules, standings, brackets, and team and player pages.
> - Your teams and settings follow you to every device you sign in on.
> - An alert when your team scores, if you want one.
>
> **How it works**
> Scores come from public sports feeds. A play usually reaches Scoreline within a minute of happening. Each game page runs a short delay so that plays arrive in order and never jump.
>
> [GitHub] · [Privacy] · [Terms]

**The Mac app isn't on the landing page yet.** 1.0.33 crashes on live soccer game pages (`MAC-WEB-SPLIT.md`), and it isn't notarized, so Gatekeeper blocks it for strangers. Add it back after phase 1 of the split ships and it has Developer ID signing.

## Owner steps

1. **Register `scoreline.fyi`** in the Cloudflare dashboard (Domain Registration → Register Domains) on the personal account. The CLI can't: the account has no registrant contact or billing profile yet, and the registrar needs both.
2. **Then move the site:** add `domains: ["scoreline.fyi"]` to `worker` in `web/cloudflare.config.ts`, set `SITE_URL` to `https://scoreline.fyi`, deploy, and change the Google consent screen's home page, privacy and terms links to the new domain. The OAuth client already lists both callback URLs. Passkeys made on workers.dev don't work on the new domain, so anyone with one makes a new account.

## Checklist

- [x] Accounts: D1, Better Auth, passkeys, the gate, Settings → Account, settings sync
- [x] Landing, privacy and terms pages, Open Graph image, robots.txt
- [x] First-party analytics, `/admin`, `pnpm stats`
- [x] Hardening: headers, rate limits, error reporting (client errors go to D1's `client_errors` and show in `/admin`)
- [ ] QA of every page type at 390, 1024 and 1440 in light and dark, on live data
- [x] Mac and web split, planned: [MAC-WEB-SPLIT.md](MAC-WEB-SPLIT.md)
- [x] Deploy, then check production signed out and signed in (passkeys by `landing.spec.ts` against production; Google by hand in the owner's browser)
- [ ] Move to `scoreline.fyi` (Owner steps 1 and 2)
