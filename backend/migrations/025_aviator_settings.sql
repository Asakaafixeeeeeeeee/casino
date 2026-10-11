-- Aviator (Sky Rush) settings an admin can change: the published RTP and the bet limits. One row.
CREATE TABLE IF NOT EXISTS sky_settings (
  id         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  rtp        NUMERIC(5,4)  NOT NULL DEFAULT 0.97   CHECK (rtp >= 0.80 AND rtp <= 0.99),
  min_bet    NUMERIC(12,2) NOT NULL DEFAULT 1      CHECK (min_bet >= 0.10),
  max_bet    NUMERIC(12,2) NOT NULL DEFAULT 1000   CHECK (max_bet >= min_bet),
  max_win    NUMERIC(14,2) NOT NULL DEFAULT 250000 CHECK (max_win >= max_bet),
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO sky_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Each round keeps the RTP it was drawn with (public, so a finished round can still be checked after a change), and
-- each bet keeps the maximum win in force when it was placed (a change never alters a bet already in play).
ALTER TABLE sky_rounds ADD COLUMN IF NOT EXISTS rtp NUMERIC(5,4) NOT NULL DEFAULT 0.97;
ALTER TABLE sky_bets ADD COLUMN IF NOT EXISTS max_win NUMERIC(14,2);
