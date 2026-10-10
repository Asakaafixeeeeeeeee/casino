-- The mobile money number a deposit was paid from. Players can pay from any number (withdrawals still only go to
-- their registered one), so the admin can see when a deposit came from someone else's wallet.
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS payer_phone TEXT;
