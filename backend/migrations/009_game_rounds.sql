-- Every real-money round the server played: what was staked, what was chosen, what the server drew, what it paid.
CREATE TABLE IF NOT EXISTS game_rounds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  game            TEXT NOT NULL,
  currency        VARCHAR(10) NOT NULL REFERENCES currencies(code),
  stake           NUMERIC(38,18) NOT NULL CHECK (stake > 0),
  payout          NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (payout >= 0),
  choice          JSONB NOT NULL,
  outcome         JSONB NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS game_rounds_user_idx ON game_rounds(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS game_rounds_game_idx ON game_rounds(game, created_at DESC);
