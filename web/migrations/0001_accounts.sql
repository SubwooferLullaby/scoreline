-- Accounts (worker/auth.ts): Better Auth 1.7's tables for its core and the
-- passkey plugin, as its own migration generator writes them for SQLite
-- (`getMigrations(...).compileMigrations()`), and each account's synced
-- settings (worker/me.ts). Apply with `cf d1 migrations apply <id>` (add
-- `--local` for `pnpm dev`).
--
-- No IP addresses are stored: `session.ipAddress` stays empty
-- (`advanced.ipAddress.disableIpTracking`). A passkey account has no email:
-- `user.email` (required and unique in Better Auth) holds a reserved
-- `@passkey.invalid` placeholder that never leaves the Worker.

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table "passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" integer not null, "transports" text, "createdAt" date, "aaguid" text);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create index "passkey_userId_idx" on "passkey" ("userId");

create index "passkey_credentialID_idx" on "passkey" ("credentialID");

-- One row per account: the app's settings store (src/state/settings.ts) as
-- JSON, at most 64 KB, and when the server last wrote it (milliseconds since
-- the epoch). Deleted with the account (worker/me.ts), explicitly: no foreign
-- key, so a write for an account deleted a moment ago is refused by its query
-- rather than by a constraint error.
create table "user_settings" ("user_id" text not null primary key, "json" text not null, "updated_at" integer not null);
