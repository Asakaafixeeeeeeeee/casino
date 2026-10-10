-- Admin dashboard and partner programme.

-- the player's registered number and last activity, kept current as they sign in (admin search and "last seen")
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
CREATE INDEX IF NOT EXISTS users_phone_idx ON users(phone);
CREATE INDEX IF NOT EXISTS users_username_lower_idx ON users(lower(username));
CREATE INDEX IF NOT EXISTS users_created_idx ON users(created_at DESC);

-- every action an admin takes, for the audit trail
CREATE TABLE IF NOT EXISTS admin_actions (
  id         BIGSERIAL PRIMARY KEY,
  admin      TEXT NOT NULL,            -- the admin's registered number
  action     TEXT NOT NULL,            -- user.status, user.kyc, user.adjust, catalog.toggle, partner.update, partner.payout
  target     TEXT,                     -- the user, game, studio, partner or payout it was about
  details    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_actions_target_idx ON admin_actions(target, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_actions_created_idx ON admin_actions(created_at DESC);

-- games and studios an admin has switched off (no row = on)
CREATE TABLE IF NOT EXISTS catalog_settings (
  kind       TEXT NOT NULL CHECK (kind IN ('game', 'provider')),
  id         TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, id)
);

-- every real-money bet in one place, from each engine's own table. settled = its result is in (an open Mines round
-- or a flight still in the air has taken the stake but not decided the payout yet).
CREATE OR REPLACE VIEW all_bets AS
  SELECT user_id, game, stake, payout, true AS settled, created_at FROM game_rounds
  UNION ALL
  SELECT user_id, game, stake, payout, status <> 'OPEN', created_at FROM game_sessions
  UNION ALL
  SELECT b.user_id, f.game, b.stake, b.payout, b.status IN ('WON', 'LOST'), b.created_at
    FROM crash_bets b JOIN crash_flights f ON f.id = b.flight_id
   WHERE b.status <> 'CANCELLED'
  UNION ALL
  SELECT user_id, 'volta-mines-live', stake, payout, status IN ('WON', 'LOST'), created_at
    FROM mines_live_bets WHERE status <> 'VOID';

-- partners: players an admin has approved to refer others, with their commission terms
CREATE TABLE IF NOT EXISTS affiliates (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  code            TEXT NOT NULL UNIQUE,       -- the code in their referral links
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED')),
  revshare_pct    NUMERIC(5,2) NOT NULL DEFAULT 25 CHECK (revshare_pct >= 0 AND revshare_pct <= 60),
  cpa_amount      NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (cpa_amount >= 0),
  cpa_min_deposit NUMERIC(38,18) NOT NULL DEFAULT 20 CHECK (cpa_min_deposit >= 0),
  channel         TEXT,                       -- where they said they'd promote (their application)
  note            TEXT,                       -- an admin's note
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ,
  decided_by      TEXT
);

-- who brought each referred player: one partner per player, for good
CREATE TABLE IF NOT EXISTS referrals (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  affiliate_id UUID NOT NULL REFERENCES affiliates(user_id) ON DELETE RESTRICT,
  sub_id       TEXT,                          -- the partner's campaign tag, if the link had one
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id <> affiliate_id)
);
CREATE INDEX IF NOT EXISTS referrals_affiliate_idx ON referrals(affiliate_id, created_at DESC);

-- referral link visits, counted per partner, day and campaign tag
CREATE TABLE IF NOT EXISTS referral_clicks (
  affiliate_id UUID NOT NULL REFERENCES affiliates(user_id) ON DELETE CASCADE,
  day          DATE NOT NULL,
  sub_id       TEXT NOT NULL DEFAULT '',
  clicks       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (affiliate_id, day, sub_id)
);

-- commission payouts: requested by the partner, then paid (outside the platform) or rejected by an admin
CREATE TABLE IF NOT EXISTS affiliate_payouts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id UUID NOT NULL REFERENCES affiliates(user_id) ON DELETE RESTRICT,
  amount       NUMERIC(38,18) NOT NULL CHECK (amount > 0),
  method       TEXT NOT NULL CHECK (method IN ('MOMO', 'BANK', 'CRYPTO')),
  details      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'PAID', 'REJECTED')),
  note         TEXT,                          -- the payment reference, or why it was rejected
  decided_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ
);
-- one open request at a time per partner
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payouts_one_open ON affiliate_payouts(affiliate_id) WHERE status = 'REQUESTED';
