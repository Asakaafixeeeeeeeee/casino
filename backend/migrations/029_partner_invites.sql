-- Partner setup links (the owner's brief, 11 October 2026): an admin enters only a partner's phone number, commission
-- and feature switches; the system makes a secret one-time link; the partner opens it and registers their own account
-- (name, username, password...). The link is good for that phone number only, once, until it expires.
-- Only a SHA-256 hash of the link's secret is kept: a database copy can't be turned back into working links.
CREATE TABLE IF NOT EXISTS partner_invites (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT NOT NULL UNIQUE,
  phone        TEXT NOT NULL,                    -- stored like the accounts service stores it (0241234567 or +<code>...)
  revshare_pct NUMERIC(5,2) NOT NULL CHECK (revshare_pct >= 0 AND revshare_pct <= 90),
  permissions  JSONB NOT NULL DEFAULT '{}'::jsonb, -- this partner's feature switches (overrides), as on their profile
  note         TEXT,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  used_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   TIMESTAMPTZ
);
-- one open invitation per number at a time
CREATE UNIQUE INDEX IF NOT EXISTS partner_invites_open_phone ON partner_invites (phone) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS partner_invites_created ON partner_invites (created_at DESC);
