CREATE TABLE IF NOT EXISTS payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount NUMERIC(38,18) NOT NULL,
  currency VARCHAR(10) NOT NULL REFERENCES currencies(code),
  idempotency_key TEXT NOT NULL UNIQUE,
  transaction_id TEXT,
  checkout_url TEXT,
  redirect_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  external_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_intents_amount_positive CHECK (amount > 0),
  CONSTRAINT payment_intents_status CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'REVERSED'))
);

CREATE UNIQUE INDEX payment_intents_transaction_id_idx
  ON payment_intents(transaction_id)
  WHERE transaction_id IS NOT NULL;

CREATE INDEX payment_intents_user_idx ON payment_intents(user_id, created_at DESC);
