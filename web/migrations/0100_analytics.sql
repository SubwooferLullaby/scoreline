-- First-party analytics (worker/analytics.ts, ARCHITECTURE.md § Analytics).
-- Numbered 0100 so it sorts after the accounts migrations (Better Auth's tables).
--
-- No IP addresses and no user agents are stored: country comes from
-- Cloudflare's edge, device is a class (phone, tablet, desktop), and the
-- referrer is its host only.

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,           -- epoch ms
  day TEXT NOT NULL,             -- YYYY-MM-DD, UTC
  user_id TEXT,                  -- signed in, and not opted out (GPC, DNT)
  anon_id TEXT,                  -- a random id in the browser's localStorage, never a cookie
  session_id TEXT,               -- one tab's visit
  name TEXT NOT NULL,            -- an allowlisted event name (shared/analytics.ts)
  path TEXT,                     -- the route pattern ("/game/:id"), never a raw URL
  league TEXT,
  props TEXT,                    -- small JSON
  country TEXT,
  device TEXT,                   -- phone | tablet | desktop
  referrer_host TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT
);

CREATE INDEX IF NOT EXISTS events_day ON events (day);
CREATE INDEX IF NOT EXISTS events_name_day ON events (name, day);
CREATE INDEX IF NOT EXISTS events_user_day ON events (user_id, day);

-- Client errors, one row per error per day: the same message at the same top
-- stack frame counts up instead of adding rows.
CREATE TABLE IF NOT EXISTS client_errors (
  day TEXT NOT NULL,
  hash TEXT NOT NULL,            -- SHA-256 of the message and the stack's top frame (hex, 16 chars)
  ts INTEGER NOT NULL,           -- last seen, epoch ms
  user_id TEXT,                  -- the last to see it (null when signed out or opted out)
  message TEXT NOT NULL,
  stack TEXT,                    -- at most 2 KB
  path TEXT,
  release TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (day, hash)
);

CREATE INDEX IF NOT EXISTS client_errors_ts ON client_errors (ts);
