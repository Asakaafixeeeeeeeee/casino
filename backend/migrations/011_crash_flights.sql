-- Crash-style rounds (Crash, Knockout): each player's rounds run on the server's clock. The crash point is drawn when
-- the round opens and is never sent to the page until the round is over; bets are taken only before take-off, and a
-- cash-out is judged at the moment the server receives it.
CREATE TABLE IF NOT EXISTS crash_flights (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  game       TEXT NOT NULL,
  crash      NUMERIC(12,2) NOT NULL CHECK (crash >= 1),
  starts_at  TIMESTAMPTZ NOT NULL,  -- take-off
  ends_at    TIMESTAMPTZ NOT NULL,  -- the crash (rounded up to the millisecond)
  settled    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crash_flights_user_idx ON crash_flights(user_id, game, starts_at DESC);
CREATE INDEX IF NOT EXISTS crash_flights_due_idx ON crash_flights(ends_at) WHERE NOT settled;

CREATE TABLE IF NOT EXISTS crash_bets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flight_id       UUID NOT NULL REFERENCES crash_flights(id) ON DELETE RESTRICT,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  panel           SMALLINT NOT NULL CHECK (panel IN (0, 1)),
  stake           NUMERIC(38,18) NOT NULL CHECK (stake > 0),
  kind            TEXT NOT NULL CHECK (kind IN ('classic', 'blue', 'purple', 'red')),
  auto_target     NUMERIC(12,2),
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'WON', 'LOST', 'CANCELLED')),
  cashed_x        NUMERIC(12,2),
  payout          NUMERIC(38,18) NOT NULL DEFAULT 0 CHECK (payout >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one bet per bet slot per round
CREATE UNIQUE INDEX IF NOT EXISTS crash_bets_one_per_panel ON crash_bets(flight_id, panel) WHERE status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS crash_bets_flight_idx ON crash_bets(flight_id);
