-- Sky Rush: one crash round for every player at once. A round's seed is drawn when the round opens and stays secret
-- until the plane has flown away; its SHA-256 hash is public from the start, and the crash point is worked out from
-- the seed, so anyone can check a finished round. Bets are taken only before take-off, and a cash-out is judged at
-- the moment the server receives it.
CREATE TABLE IF NOT EXISTS sky_rounds (
  no         BIGINT PRIMARY KEY,
  seed       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  crash      NUMERIC(12,2) NOT NULL CHECK (crash >= 1),
  starts_at  TIMESTAMPTZ NOT NULL,  -- take-off: betting closes
  ends_at    TIMESTAMPTZ NOT NULL,  -- the crash (rounded up to the millisecond)
  settled    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sky_rounds_due_idx ON sky_rounds(ends_at) WHERE NOT settled;
CREATE INDEX IF NOT EXISTS sky_rounds_start_idx ON sky_rounds(starts_at);

CREATE TABLE IF NOT EXISTS sky_bets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_no        BIGINT NOT NULL REFERENCES sky_rounds(no) ON DELETE RESTRICT,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  panel           SMALLINT NOT NULL CHECK (panel IN (0, 1)),
  stake           NUMERIC(38,18) NOT NULL CHECK (stake > 0),
  auto_target     NUMERIC(12,2),
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'WON', 'LOST', 'CANCELLED')),
  cashed_x        NUMERIC(12,2),
  payout          NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (payout >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- each player has two bet slots per round
CREATE UNIQUE INDEX IF NOT EXISTS sky_bets_one_per_panel ON sky_bets(round_no, user_id, panel) WHERE status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS sky_bets_round_idx ON sky_bets(round_no);
CREATE INDEX IF NOT EXISTS sky_bets_user_idx ON sky_bets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sky_bets_wins_idx ON sky_bets(round_no) WHERE status = 'WON';

-- every real-money bet in one place (the admin dashboard and partner commissions read this): now with Sky Rush
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
    FROM sky_bets WHERE status <> 'CANCELLED';
