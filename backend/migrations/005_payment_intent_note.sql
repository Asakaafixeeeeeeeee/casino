-- The last message TheTeller gave about a payment (decline reason, auth error, …), shown to the payer and to support.
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS gateway_note TEXT;
