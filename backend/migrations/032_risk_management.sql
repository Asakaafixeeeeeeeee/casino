-- Risk management (the owner's brief, 12 October 2026): limits an admin sets for one player, and the thresholds for
-- the risk alerts. Every limit is told to the player when it applies (a deposit or bet outside it is refused with the
-- limit in the message). Nothing here touches a player's balance, their winnings or how any result is drawn.
--   min_deposit  the smallest deposit this player can make (a deposit tier, e.g. GHS 100), never below the site's GHS 5
--   max_deposit  the largest single deposit for this player
--   max_bet      the largest stake for this player on any game
CREATE TABLE IF NOT EXISTS player_risk (
  user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  min_deposit  NUMERIC(12,2) CHECK (min_deposit IS NULL OR min_deposit > 0),
  max_deposit  NUMERIC(12,2) CHECK (max_deposit IS NULL OR max_deposit > 0),
  max_bet      NUMERIC(12,2) CHECK (max_bet IS NULL OR max_bet > 0),
  note         TEXT,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one row: when a payout, a multiplier, a player's day or failed deposits are worth an alert
CREATE TABLE IF NOT EXISTS risk_settings (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  big_payout      NUMERIC(12,2) NOT NULL DEFAULT 1000,  -- a single bet paying this much or more (GHS)
  big_multiplier  NUMERIC(12,2) NOT NULL DEFAULT 100,   -- a single bet paying this many times its stake or more
  daily_net_win   NUMERIC(12,2) NOT NULL DEFAULT 5000,  -- a player up this much in 24 hours (paid minus staked)
  failed_deposits INT NOT NULL DEFAULT 5,               -- this many failed deposits by one player in an hour
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO risk_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
