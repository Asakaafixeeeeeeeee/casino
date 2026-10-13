-- 034_lotto.sql
-- WIN B Lotto: a 5/90 draw on a daily schedule. Players buy tickets (1 to 5 numbers from 1-90) until betting closes;
-- the server then draws 5 numbers from the draw's seed (its SHA-256 hash is public from the moment the draw opens,
-- so the numbers can't be changed afterwards). An admin sees the numbers once betting has closed and releases the
-- results, which pays every winning ticket; or cancels the draw, which refunds every ticket in full.

CREATE TABLE IF NOT EXISTS lotto_settings (
  id          SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  draw_time   TEXT NOT NULL DEFAULT '19:00',          -- HH:MM, Ghana time (UTC)
  cutoff_min  INTEGER NOT NULL DEFAULT 10 CHECK (cutoff_min BETWEEN 1 AND 720),
  rtp         NUMERIC(5,4) NOT NULL DEFAULT 0.90 CHECK (rtp > 0 AND rtp <= 1),
  min_bet     NUMERIC(12,2) NOT NULL DEFAULT 1,
  max_bet     NUMERIC(12,2) NOT NULL DEFAULT 500,
  max_win     NUMERIC(14,2) NOT NULL DEFAULT 100000,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO lotto_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS lotto_draws (
  id           BIGSERIAL PRIMARY KEY,
  draw_at      TIMESTAMPTZ NOT NULL UNIQUE,
  closes_at    TIMESTAMPTZ NOT NULL,
  seed         TEXT NOT NULL,
  hash         TEXT NOT NULL,
  numbers      SMALLINT[],                              -- set when betting closes
  status       TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'RELEASED', 'CANCELLED')),
  decided_by   TEXT,
  released_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lotto_draws_status ON lotto_draws (status, draw_at);

CREATE TABLE IF NOT EXISTS lotto_tickets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draw_id          BIGINT NOT NULL REFERENCES lotto_draws(id),
  user_id          UUID NOT NULL REFERENCES users(id),
  picks            SMALLINT[] NOT NULL,
  stake            NUMERIC(38,18) NOT NULL CHECK (stake > 0),
  multiplier       NUMERIC(14,2) NOT NULL,              -- fixed when the ticket is bought
  max_win          NUMERIC(14,2) NOT NULL,
  payout           NUMERIC(38,18) NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'WON', 'LOST', 'REFUNDED')),
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lotto_tickets_draw ON lotto_tickets (draw_id, status);
CREATE INDEX IF NOT EXISTS lotto_tickets_user ON lotto_tickets (user_id, created_at DESC);

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
    FROM mines_live_bets WHERE status <> 'VOID'
  UNION ALL
  SELECT user_id, 'sky-rush', stake, payout, status IN ('WON', 'LOST'), created_at
    FROM sky_bets WHERE status <> 'CANCELLED'
  UNION ALL
  SELECT user_id, 'lotto', stake, payout, status IN ('WON', 'LOST'), created_at
    FROM lotto_tickets WHERE status <> 'REFUNDED';
