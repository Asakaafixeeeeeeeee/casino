CREATE TABLE IF NOT EXISTS deposit_restriction_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO deposit_restriction_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS deposit_restrictions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  failed_intent_id UUID NOT NULL UNIQUE REFERENCES payment_intents(id) ON DELETE RESTRICT,
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  removed_at TIMESTAMPTZ,
  removed_by TEXT,
  removal_reason TEXT,
  CHECK (expires_at = started_at + interval '30 hours')
);
CREATE INDEX IF NOT EXISTS deposit_restrictions_user_expiry_idx
  ON deposit_restrictions (user_id, expires_at DESC) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS deposit_restriction_events (
  id BIGSERIAL PRIMARY KEY,
  restriction_id BIGINT REFERENCES deposit_restrictions(id) ON DELETE RESTRICT,
  user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deposit_restriction_events_created_idx
  ON deposit_restriction_events (created_at DESC);
