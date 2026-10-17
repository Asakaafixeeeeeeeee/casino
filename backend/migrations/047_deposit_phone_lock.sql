-- 047_deposit_phone_lock.sql
-- Deposits are made only from the one number an account registered with. An existing player confirms it once
-- (deposit_phone_confirmed_at is set, deposit_phone is the number locked, 0XXXXXXXXX); a new player accepts the rule
-- at sign-up and is marked confirmed from the accounts service's record of that acceptance. Nothing here changes a
-- balance, a deposit or any payment record.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deposit_phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deposit_phone_confirmed_at TIMESTAMPTZ;

-- When a deposit was confirmed, for the 10-minute wait between successful deposits. Older rows have none: the wait
-- falls back to updated_at for them.
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS payment_intents_confirmed_idx ON payment_intents (user_id, created_at DESC) WHERE status = 'CONFIRMED';
