-- 038_account_control.sql
-- The main admin's Blocked, Banned and Deleted users. A restriction never touches a balance, a bet or a ledger entry:
--   BLOCKED      temporary (optionally until a date): the player can sign in and look, but not bet, deposit or withdraw
--   BANNED       permanent until an admin lifts it: no log-in, nothing at all
--   DEACTIVATED  closed by an admin, restorable
--   DELETED      deleted by an admin: no log-in; every transaction and audit record is kept, so it can be restored
-- Every change is written to account_restrictions (and to admin_actions), with the reason, the admin and the time.

ALTER TABLE users ADD COLUMN IF NOT EXISTS restriction TEXT
  CHECK (restriction IN ('BLOCKED', 'BANNED', 'DEACTIVATED', 'DELETED'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS restriction_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS restricted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS restricted_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_restriction_idx ON users (restriction) WHERE restriction IS NOT NULL;

-- accounts already suspended (Players -> Suspend) show under Blocked users
UPDATE users SET restriction = 'BLOCKED', restricted_at = coalesce(updated_at, now())
 WHERE status = 'SUSPENDED' AND restriction IS NULL;
UPDATE users SET restriction = 'DEACTIVATED', restricted_at = coalesce(updated_at, now())
 WHERE status = 'CLOSED' AND restriction IS NULL;

CREATE TABLE IF NOT EXISTS account_restrictions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id),
  action        TEXT NOT NULL,          -- block, unblock, expire, ban, lift_ban, deactivate, delete, restore
  reason        TEXT,
  until         TIMESTAMPTZ,
  admin         TEXT NOT NULL,
  login_synced  BOOLEAN,                -- whether the accounts server took the log-in change (null: no change needed)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_restrictions_user_idx ON account_restrictions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_restrictions_created_idx ON account_restrictions (created_at DESC);
