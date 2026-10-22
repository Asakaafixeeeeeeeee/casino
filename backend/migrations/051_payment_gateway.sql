ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS gateway TEXT NOT NULL DEFAULT 'teller';

ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_gateway CHECK (gateway IN ('teller', 'payteller'));
