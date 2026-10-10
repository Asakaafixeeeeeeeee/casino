-- Regional admins (the Ghana Regional Admin): staff who sign in with a username and a 6-digit PIN and see only their
-- region's players, payments and revenue. They are not players and not full admins: their sign-ins live here, apart
-- from the accounts server's sessions, so their token opens nothing but the regional dashboard's API.
CREATE TABLE IF NOT EXISTS regional_admins (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username        TEXT NOT NULL,
  name            TEXT,
  region          CHAR(2) NOT NULL DEFAULT 'GH' CHECK (region IN ('GH')),
  pin_hash        TEXT NOT NULL,              -- PBKDF2-SHA256 with a per-PIN salt (src/crypto.ts); the PIN itself is never kept
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login_at   TIMESTAMPTZ,
  pin_set_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT NOT NULL,              -- the full admin who made the account
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS regional_admins_username_key ON regional_admins (lower(username));

-- A signed-in regional admin: only the SHA-256 of the token is stored, and every sign-in expires.
CREATE TABLE IF NOT EXISTS regional_admin_sessions (
  token_hash  TEXT PRIMARY KEY,
  admin_id    UUID NOT NULL REFERENCES regional_admins(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS regional_admin_sessions_admin_idx ON regional_admin_sessions (admin_id);
CREATE INDEX IF NOT EXISTS regional_admin_sessions_expiry_idx ON regional_admin_sessions (expires_at);

-- the dashboard's lists filter on the player's country
CREATE INDEX IF NOT EXISTS withdrawals_created_idx ON withdrawals (created_at DESC);
CREATE INDEX IF NOT EXISTS payment_intents_created_idx ON payment_intents (created_at DESC);
