-- Step-by-step rounds (Mines, Crossing, Goal): the stake is taken at the start, the board is dealt and kept here
-- (never sent to the page while the round is open), and each move or cash-out is decided against it.
CREATE TABLE IF NOT EXISTS game_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  game            TEXT NOT NULL,
  currency        VARCHAR(10) NOT NULL REFERENCES currencies(code),
  stake           NUMERIC(38,18) NOT NULL CHECK (stake > 0),
  params          JSONB NOT NULL,
  secret          JSONB NOT NULL,
  progress        JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'WON', 'LOST')),
  payout          NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (payout >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one round in progress per game per player
CREATE UNIQUE INDEX IF NOT EXISTS game_sessions_one_open ON game_sessions(user_id, game) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS game_sessions_user_idx ON game_sessions(user_id, created_at DESC);
