-- 039_bnc_win.sql
-- BNC WIN (backend games/bncWin.ts): each race is the player's own. The whole race (path: one letter per half-second
-- step, U = green surges, D = red surges, B = red breaks away) is drawn from the seed when the player presses GO; the
-- seed's SHA-256 (hash) is shown at once and the seed when the race ends. One race at a time per player.

CREATE TABLE IF NOT EXISTS bnc_races (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  stake            NUMERIC(38,18) NOT NULL CHECK (stake > 0),
  seed             TEXT NOT NULL,
  hash             TEXT NOT NULL,
  path             TEXT NOT NULL,
  starts_at        TIMESTAMPTZ NOT NULL,
  ends_at          TIMESTAMPTZ NOT NULL,                 -- when the race ends by itself (finish, top win or red breaking away)
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CASHED', 'FINISHED', 'BUSTED')),
  cashed_step      SMALLINT,
  cashed_x         NUMERIC(20,10),
  payout           NUMERIC(38,18) NOT NULL DEFAULT 0,
  max_win          NUMERIC(14,2) NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bnc_races_user_idx ON bnc_races (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS bnc_races_one_active ON bnc_races (user_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS bnc_races_due_idx ON bnc_races (ends_at) WHERE status = 'ACTIVE';

-- every bet, for the reports (as in 034, plus BNC WIN)
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
    FROM lotto_tickets WHERE status <> 'REFUNDED'
  UNION ALL
  SELECT user_id, 'bnc-win', stake, payout, status <> 'ACTIVE', created_at
    FROM bnc_races;

-- settled bets, for the feeds and partner commission (as in 027, plus BNC WIN)
CREATE OR REPLACE VIEW settled_bets AS
  SELECT 'round'::text AS source, id AS bet_id, user_id, game, stake, payout, created_at AS settled_at,
         'bet:' || idempotency_key AS stake_key
    FROM game_rounds
  UNION ALL
  SELECT 'session', id, user_id, game, stake, payout, updated_at, 'bet:session:' || id
    FROM game_sessions WHERE status IN ('WON', 'LOST')
  UNION ALL
  SELECT 'flight', b.id, b.user_id, f.game, b.stake, b.payout, b.updated_at, 'bet:flight:' || b.id
    FROM crash_bets b JOIN crash_flights f ON f.id = b.flight_id WHERE b.status IN ('WON', 'LOST')
  UNION ALL
  SELECT 'live', id, user_id, 'volta-mines-live', stake, payout, updated_at, 'bet:live:' || id
    FROM mines_live_bets WHERE status IN ('WON', 'LOST')
  UNION ALL
  SELECT 'sky', id, user_id, 'sky-rush', stake, payout, updated_at, 'bet:sky:' || id
    FROM sky_bets WHERE status IN ('WON', 'LOST')
  UNION ALL
  SELECT 'race', id, user_id, 'bnc-win', stake, payout, updated_at, 'bet:bnc:' || id
    FROM bnc_races WHERE status <> 'ACTIVE';
