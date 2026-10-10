-- Responsible gambling: deposit limits (rolling 24 h / 7 d / 30 d) and self-exclusion.
-- Lowering or adding a limit applies at once; raising or removing one waits in pending_* for 24 hours.
CREATE TABLE IF NOT EXISTS player_limits (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_deposit    NUMERIC(38,18) CHECK (daily_deposit > 0),
  weekly_deposit   NUMERIC(38,18) CHECK (weekly_deposit > 0),
  monthly_deposit  NUMERIC(38,18) CHECK (monthly_deposit > 0),
  pending          JSONB,          -- {"daily": 500 | null, ...} raises/removals waiting for pending_from
  pending_from     TIMESTAMPTZ,
  excluded_until   TIMESTAMPTZ,    -- self-exclusion: no deposits until then; can only be extended
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
