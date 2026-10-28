CREATE TABLE IF NOT EXISTS deposit_initiation_blocks (
  account_user_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO deposit_initiation_blocks (account_user_id, reason)
VALUES ('1937', 'Payment incident: repeated gateway requests; deposit initiation held pending investigation')
ON CONFLICT (account_user_id) DO NOTHING;

ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS initiation_context JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Previously allocated references must be reconciled, never dispatched again.
UPDATE payment_intents SET dispatch_started_at = created_at
WHERE transaction_id IS NOT NULL AND dispatch_started_at IS NULL;

CREATE INDEX IF NOT EXISTS payment_intents_dispatch_rate_idx
  ON payment_intents (user_id, dispatch_started_at DESC)
  WHERE dispatch_started_at IS NOT NULL;
