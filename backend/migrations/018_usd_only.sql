-- The accounts a player holds are their country's currency (the primary account) and US dollars. The crypto assets
-- are retired (is_active = false keeps their rows and any ledger history, and drops them from the live catalog).
UPDATE currencies SET is_active = FALSE WHERE kind = 'CRYPTO';
