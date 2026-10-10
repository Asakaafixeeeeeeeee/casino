-- =============================================================================
-- 002_seed_currencies.sql — asset registry and country -> currency map
--
-- Idempotent: safe to run on every deploy. Uses ON CONFLICT DO UPDATE so
-- correcting a symbol or a network here does not require a data migration.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Loyalty points. Modelled as an asset so it gets the same ledger, the same
-- scale rules and the same audit trail as money.
-- -----------------------------------------------------------------------------
INSERT INTO currencies (code, kind, name, symbol, decimals, min_withdrawal, is_active) VALUES
  ('VBP', 'POINTS', 'VoltaBet Points', 'VBP',  0, 0, TRUE)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, symbol = EXCLUDED.symbol, decimals = EXCLUDED.decimals;

-- -----------------------------------------------------------------------------
-- Crypto assets.
--
-- decimals is the number of minor units and MUST match the asset's chain:
--   BTC/LTC/DOGE -> 8 (satoshi-style)
--   ETH/USDT/BNB/TRX -> 18 (EVM / TRON)
--   TON           -> 9  (nanoton)
-- Getting this wrong silently rounds user money, so it is worth a test.
--
-- USDT is one row per chain: the same ticker on TRON and on Ethereum are
-- different assets with different networks and different withdrawal paths.
-- -----------------------------------------------------------------------------
INSERT INTO currencies
  (code, kind, name, symbol, decimals, network, is_stablecoin, contract_address, min_withdrawal, is_active)
VALUES
  ('BTC',  'CRYPTO', 'Bitcoin',        '₿',   8, 'Bitcoin',            FALSE, NULL,        0.0001,   TRUE),
  ('ETH',  'CRYPTO', 'Ethereum',       'Ξ',  18, 'Ethereum (ERC-20)',  FALSE, NULL,        0.005,    TRUE),
  ('LTC',  'CRYPTO', 'Litecoin',       'Ł',   8, 'Litecoin',           FALSE, NULL,        0.02,     TRUE),
  ('USDT', 'CRYPTO', 'Tether USD',     '₮',  18, 'TRON (TRC-20)',      TRUE,
           'TR7NHqjeKQxGTCi8q8ZY4JmLcccijToast9',                                  10,       TRUE),
  ('TRX',  'CRYPTO', 'TRON',           'TRX', 6, 'TRON (TRX)',         FALSE, NULL,        10,       TRUE),
  ('TON',  'CRYPTO', 'Toncoin',        'TON', 9, 'TON',                FALSE, NULL,        0.5,      TRUE),
  ('BNB',  'CRYPTO', 'BNB',            'BNB',18, 'BNB Smart Chain',    FALSE,
           '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',                              0.02,     TRUE),
  ('DOGE', 'CRYPTO', 'Dogecoin',       'Ð',   8, 'Dogecoin',           FALSE, NULL,        10,       TRUE)
ON CONFLICT (code) DO UPDATE SET
  name             = EXCLUDED.name,
  symbol           = EXCLUDED.symbol,
  decimals         = EXCLUDED.decimals,
  network          = EXCLUDED.network,
  is_stablecoin    = EXCLUDED.is_stablecoin,
  contract_address = EXCLUDED.contract_address,
  min_withdrawal   = EXCLUDED.min_withdrawal;

-- -----------------------------------------------------------------------------
-- Fiat. ISO 4217 exponents only: JPY/KRW are 0 decimals, most are 2.
--
-- The Ghanaian Cedi (GHS, '₵', 2 dp) is the primary balance currency for users
-- who register with country_code = 'GH'.
-- -----------------------------------------------------------------------------
INSERT INTO currencies (code, kind, name, symbol, decimals, min_withdrawal, is_active) VALUES
  ('GHS', 'FIAT', 'Ghanaian Cedi',    '₵',  2, 10, TRUE),
  ('NGN', 'FIAT', 'Nigerian Naira',   '₦',  2, 10, TRUE),
  ('KES', 'FIAT', 'Kenyan Shilling',  'KSh',2, 10, TRUE),
  ('ZAR', 'FIAT', 'South African Rand','R', 2, 10, TRUE),
  ('EGP', 'FIAT', 'Egyptian Pound',   'E£', 2, 10, TRUE),
  ('USD', 'FIAT', 'US Dollar',        '$',  2, 5,  TRUE),
  ('EUR', 'FIAT', 'Euro',             '€',  2, 5,  TRUE),
  ('GBP', 'FIAT', 'Pound Sterling',   '£',  2, 5,  TRUE),
  ('JPY', 'FIAT', 'Japanese Yen',     '¥',  0, 10, TRUE),   -- zero-decimal currency
  ('INR', 'FIAT', 'Indian Rupee',     '₹',  2, 10, TRUE),
  ('BRL', 'FIAT', 'Brazilian Real',   'R$', 2, 10, TRUE),
  ('AUD', 'FIAT', 'Australian Dollar','A$', 2, 10, TRUE),
  ('CAD', 'FIAT', 'Canadian Dollar',  'C$', 2, 10, TRUE),
  ('AED', 'FIAT', 'UAE Dirham',       'د.إ',2, 10, TRUE),
  -- Recognised but switched off for new deposits (sanctions / maintenance).
  -- A row like this is how a currency is retired without deleting history.
  ('XCD', 'FIAT', 'East Caribbean Dollar','$',2, 0,  FALSE)
ON CONFLICT (code) DO UPDATE SET
  name    = EXCLUDED.name,
  symbol  = EXCLUDED.symbol,
  decimals= EXCLUDED.decimals;

-- -----------------------------------------------------------------------------
-- Countries -> default currency.
--
-- This table IS the country -> ISO currency mapping the spec asks for. The
-- service layer reads it; it never hardcodes a country in application logic.
-- Add a country by inserting a row here.
-- -----------------------------------------------------------------------------
INSERT INTO countries (code, name, default_currency, phone_prefix, is_supported) VALUES
  ('GH', 'Ghana',                 'GHS', '+233', TRUE),
  ('NG', 'Nigeria',               'NGN', '+234', TRUE),
  ('KE', 'Kenya',                 'KES', '+254', TRUE),
  ('ZA', 'South Africa',          'ZAR', '+27',  TRUE),
  ('EG', 'Egypt',                 'EGP', '+20',  TRUE),
  ('US', 'United States',         'USD', '+1',   TRUE),
  ('GB', 'United Kingdom',        'GBP', '+44',  TRUE),
  ('DE', 'Germany',               'EUR', '+49',  TRUE),
  ('FR', 'France',                'EUR', '+33',  TRUE),
  ('ES', 'Spain',                 'EUR', '+34',  TRUE),
  ('IT', 'Italy',                 'EUR', '+39',  TRUE),
  ('JP', 'Japan',                 'JPY', '+81',  TRUE),
  ('IN', 'India',                 'INR', '+91',  TRUE),
  ('BR', 'Brazil',                'BRL', '+55',  TRUE),
  ('AU', 'Australia',             'AUD', '+61',  TRUE),
  ('CA', 'Canada',                'CAD', '+1',   TRUE),
  ('AE', 'United Arab Emirates',  'AED', '+971', TRUE)
ON CONFLICT (code) DO UPDATE SET
  name             = EXCLUDED.name,
  default_currency = EXCLUDED.default_currency,
  phone_prefix     = EXCLUDED.phone_prefix,
  is_supported     = EXCLUDED.is_supported;

-- -----------------------------------------------------------------------------
-- Reference FX rates (illustrative only — never authoritative for settlement).
-- In production these come from a price feed job; the executed rate is always
-- stored on the journal itself.
-- -----------------------------------------------------------------------------
INSERT INTO fx_rates (base_currency, quote_currency, rate, source) VALUES
  ('GHS', 'USD', 0.0630, 'seed'),
  ('NGN', 'USD', 0.00065,'seed'),
  ('KES', 'USD', 0.0077, 'seed'),
  ('ZAR', 'USD', 0.0550, 'seed'),
  ('USD', 'GHS', 15.8730,'seed')
ON CONFLICT (base_currency, quote_currency, as_of) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Sanity check: the numbers that would silently break money if wrong.
-- Fails loudly at migrate time rather than at 3am in production.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  bad TEXT;
BEGIN
  -- Crypto decimals must match the chain's native exponent.
  FOR bad IN
    SELECT format('%s has %s decimals', code, decimals)
      FROM currencies
     WHERE kind = 'CRYPTO'
       AND (code, decimals) NOT IN (
         ('BTC',8), ('ETH',18), ('LTC',8), ('USDT',18),
         ('TRX',6),  ('TON',9),  ('BNB',18), ('DOGE',8)
       )
  LOOP
    RAISE EXCEPTION 'seed data inconsistent: %', bad;
  END LOOP;

  -- Every supported country must point at an active fiat currency.
  SELECT c.code INTO bad
    FROM countries c
    JOIN currencies cur ON cur.code = c.default_currency
   WHERE c.is_supported AND (cur.kind <> 'FIAT' OR NOT cur.is_active);

  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'country % points at a non-fiat or inactive currency', bad;
  END IF;
END $$;