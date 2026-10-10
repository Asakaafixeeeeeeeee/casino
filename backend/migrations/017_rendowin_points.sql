-- The loyalty points balance follows the site's name. The code (VBP) is kept: it's referenced by ledger history, the
-- user_balances primary key and the points pool, and renaming a currency code is never worth the risk.
UPDATE currencies SET name = 'RendoWin Points' WHERE code = 'VBP';
