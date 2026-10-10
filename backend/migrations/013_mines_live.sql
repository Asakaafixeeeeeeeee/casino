-- Volta Mines Live: one shared 5×5 board (6 mines) every 3 minutes, the same for everyone. Round n runs from
-- n × 180 s to (n + 1) × 180 s after the epoch. Its seed is drawn when the round is first asked for and kept secret until
-- the end; only the seed's SHA-256 hash is public before that, so anyone can check afterwards that it wasn't changed.
CREATE TABLE IF NOT EXISTS mines_live_rounds (
  no         BIGINT PRIMARY KEY,
  seed       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  settled    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mines_live_rounds_due_idx ON mines_live_rounds(ends_at) WHERE NOT settled;

-- real-money bets: the tiles and stake are locked in together; the result comes at the end of the round
CREATE TABLE IF NOT EXISTS mines_live_bets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_no        BIGINT NOT NULL REFERENCES mines_live_rounds(no) ON DELETE RESTRICT,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  stake           NUMERIC(38,18) NOT NULL CHECK (stake > 0),
  picks           JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'WON', 'LOST', 'VOID')),
  payout          NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (payout >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one bet per player per round
CREATE UNIQUE INDEX IF NOT EXISTS mines_live_one_bet ON mines_live_bets(round_no, user_id) WHERE status <> 'VOID';
CREATE INDEX IF NOT EXISTS mines_live_bets_round_idx ON mines_live_bets(round_no);
