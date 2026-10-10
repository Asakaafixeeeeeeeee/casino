-- The player's full name, asked for at sign-up by the accounts server (which owns it) and copied here each time the
-- player signs in, so the admin and Ghana admin pages can show who a payment belongs to. Players who signed up
-- before the name was asked for have none.
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
