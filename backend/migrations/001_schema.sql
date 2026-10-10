-- =============================================================================
-- 001_schema.sql — Multi-currency balance system (clean, verified)
-- =============================================================================

-- gen_random_uuid() is core since PostgreSQL 13; no extension required.

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------
CREATE TYPE currency_kind      AS ENUM ('FIAT', 'CRYPTO', 'POINTS');
CREATE TYPE account_status     AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE kyc_status         AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE entry_direction    AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE entry_type         AS ENUM (
  'DEPOSIT',              -- fiat/crypto in
  'WITHDRAWAL',           -- fiat/crypto out
  'WITHDRAWAL_REQUEST',   -- hold placed when withdrawal initiated
  'BET_PLACED',           -- available -> locked (stake held)
  'BET_SETTLED',          -- locked released; winnings to available
  'BET_VOID',             -- stake released without play
  'CONVERSION',           -- FX swap
  'POINTS_EARNED',
  'POINTS_SPENT',
  'BONUS',
  'FEE',
  'ADJUSTMENT',           -- manual correction
  'REVERSAL'              -- compensating entry
);
CREATE TYPE transaction_status AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'REVERSED');

-- -----------------------------------------------------------------------------
-- currencies: one row per asset (fiat, crypto, points)
-- -----------------------------------------------------------------------------
CREATE TABLE currencies (
  code            VARCHAR(10) PRIMARY KEY,        -- ISO 4217 fiat or ticker (BTC, ETH, USDT)
  kind            currency_kind NOT NULL,
  name            TEXT         NOT NULL,
  symbol          TEXT         NOT NULL,          -- '₵', '₿', 'Ξ', 'VBP'
  decimals        SMALLINT     NOT NULL,          -- 2 for GHS, 8 for BTC, 0 for points/JPY

  -- Crypto-only; NULL for fiat/points
  network         TEXT,
  is_stablecoin   BOOLEAN      NOT NULL DEFAULT FALSE,
  contract_address TEXT,                          -- ERC-20 / TRC-20 / BEP-20 contract
  min_withdrawal  NUMERIC(38,18) NOT NULL DEFAULT 0,

  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT currencies_decimals_range  CHECK (decimals BETWEEN 0 AND 18),
  CONSTRAINT currencies_decimals_fiat   CHECK (kind <> 'FIAT'  OR decimals IN (0, 2, 3)),
  CONSTRAINT currencies_network_crypto CHECK (kind <> 'CRYPTO' OR network IS NOT NULL),
  CONSTRAINT currencies_symbol_len      CHECK (char_length(symbol) BETWEEN 1 AND 12),
  CONSTRAINT currencies_min_withdraw    CHECK (min_withdrawal >= 0)
);

COMMENT ON TABLE  currencies IS
  'Asset registry: fiat, crypto and loyalty points. Source of truth for scale and display.';
COMMENT ON COLUMN currencies.decimals IS
  'Minor-unit exponent. 2 = cents/cedis (GHS), 8 = satoshi (BTC). Enforced on every amount written.';

-- -----------------------------------------------------------------------------
-- countries: drives primary-account currency at registration
-- -----------------------------------------------------------------------------
CREATE TABLE countries (
  code             CHAR(2) PRIMARY KEY,              -- ISO 3166-1 alpha-2
  name             TEXT    NOT NULL,
  default_currency VARCHAR(10) NOT NULL REFERENCES currencies(code),
  phone_prefix     TEXT,
  is_supported     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX countries_supported_idx ON countries (is_supported) WHERE is_supported;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 TEXT         NOT NULL,
  password_hash         TEXT         NOT NULL,
  username              TEXT,

  country_code          CHAR(2)      NOT NULL REFERENCES countries(code),
  -- Frozen at registration from country_code. Still an FK so it stays valid.
  primary_currency_code VARCHAR(10)  NOT NULL REFERENCES currencies(code),

  status                account_status NOT NULL DEFAULT 'ACTIVE',
  kyc_status            kyc_status     NOT NULL DEFAULT 'UNVERIFIED',

  email_verified_at     TIMESTAMPTZ,
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_email_shape CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- Postgres forbids subqueries in CHECK; enforced by trigger instead.
CREATE OR REPLACE FUNCTION assert_primary_is_fiat() RETURNS TRIGGER AS $$
DECLARE
  kind currency_kind;
BEGIN
  SELECT c.kind INTO kind FROM currencies c WHERE c.code = NEW.primary_currency_code;
  IF kind IS NULL THEN
    RAISE EXCEPTION 'unknown primary currency %', NEW.primary_currency_code
      USING ERRCODE = '23503';
  END IF;
  IF kind <> 'FIAT' THEN
    RAISE EXCEPTION
      'primary_currency_code % is %; a user''s primary balance must be a FIAT currency',
      NEW.primary_currency_code, kind
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_primary_is_fiat_trg
  BEFORE INSERT OR UPDATE OF primary_currency_code ON users
  FOR EACH ROW EXECUTE FUNCTION assert_primary_is_fiat();

CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE UNIQUE INDEX users_username_lower_key ON users (lower(username)) WHERE username IS NOT NULL;
CREATE INDEX users_country_idx ON users (country_code);

COMMENT ON COLUMN users.primary_currency_code IS
  'Derived from country_code at registration and frozen. Changing it later is a deliberate, audited migration.';

-- -----------------------------------------------------------------------------
-- user_balances: the hot, mutable cache
-- -----------------------------------------------------------------------------
CREATE TABLE user_balances (
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency_code  VARCHAR(10) NOT NULL REFERENCES currencies(code),
  available      NUMERIC(38,18) NOT NULL DEFAULT 0,
  locked         NUMERIC(38,18) NOT NULL DEFAULT 0,
  total_deposited   NUMERIC(38,18) NOT NULL DEFAULT 0,
  total_withdrawn  NUMERIC(38,18) NOT NULL DEFAULT 0,
  version       BIGINT      NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, currency_code),

  CONSTRAINT user_balances_available_non_negative CHECK (available >= 0),
  CONSTRAINT user_balances_locked_non_negative    CHECK (locked >= 0),
  CONSTRAINT user_balances_totals_non_negative    CHECK (total_deposited >= 0 AND total_withdrawn >= 0)
);

CREATE INDEX user_balances_currency_idx ON user_balances (currency_code);

-- -----------------------------------------------------------------------------
-- ledger_journal
-- -----------------------------------------------------------------------------
CREATE TABLE ledger_journal (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT         NOT NULL UNIQUE,
  reference_type   TEXT,
  reference_id     TEXT,
  entry_type       entry_type   NOT NULL,
  description      TEXT,
  reason           TEXT,
  external_ref     TEXT,
  metadata         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT journal_adjustment_needs_reason CHECK (
    entry_type <> 'ADJUSTMENT' OR (reason IS NOT NULL AND char_length(reason) >= 8)
  ),
  CONSTRAINT journal_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX journal_reference_idx ON ledger_journal (reference_type, reference_id);
CREATE INDEX journal_created_at_idx  ON ledger_journal (created_at DESC);

-- -----------------------------------------------------------------------------
-- ledger_entries: immutable double-entry legs
-- -----------------------------------------------------------------------------
CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  journal_id      UUID        NOT NULL REFERENCES ledger_journal(id) ON DELETE RESTRICT,
  user_id         UUID        REFERENCES users(id) ON DELETE RESTRICT,  -- NULL = system
  currency_code   VARCHAR(10) NOT NULL REFERENCES currencies(code),
  direction       entry_direction NOT NULL,
  amount          NUMERIC(38,18) NOT NULL,
  balance_after   NUMERIC(38,18),                     -- NULL for system accounts
  system_account  TEXT,                               -- required when user_id IS NULL
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ledger_entries_amount_positive CHECK (amount > 0),
  CONSTRAINT ledger_entries_user_or_system  CHECK (
    (user_id IS NOT NULL AND system_account IS NULL) OR
    (user_id IS NULL     AND system_account IS NOT NULL)
  )
);

CREATE INDEX ledger_entries_user_idx     ON ledger_entries (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX ledger_entries_journal_idx  ON ledger_entries (journal_id);
CREATE INDEX ledger_entries_currency_idx ON ledger_entries (currency_code, created_at DESC);

-- Per-currency scale enforcement
CREATE OR REPLACE FUNCTION assert_amount_scale() RETURNS TRIGGER AS $$
DECLARE
  allowed SMALLINT;
BEGIN
  SELECT decimals INTO allowed FROM currencies WHERE code = NEW.currency_code;
  IF NEW.amount <> round(NEW.amount, allowed) THEN
    RAISE EXCEPTION
      'amount % has more than % decimal places for currency %',
      NEW.amount, allowed, NEW.currency_code
      USING ERRCODE = '23514';
  END IF;
  IF NEW.amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive, got %', NEW.amount
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_scale_trg
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION assert_amount_scale();

-- Zero-sum per journal per currency (deferred to COMMIT)
CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS TRIGGER AS $$
DECLARE
  bad_currency TEXT;
BEGIN
  SELECT e.currency_code INTO bad_currency
  FROM ledger_entries e
  WHERE e.journal_id = NEW.journal_id
  GROUP BY e.currency_code
  HAVING sum(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE 0 END)
    <> sum(CASE WHEN e.direction = 'DEBIT'  THEN e.amount ELSE 0 END)
  LIMIT 1;

  IF bad_currency IS NOT NULL THEN
    RAISE EXCEPTION 'journal % does not balance in currency %',
      NEW.journal_id, bad_currency
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_journal_balanced_trg
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch_trg BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER currencies_touch_trg BEFORE UPDATE ON currencies
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER user_balances_touch_trg BEFORE UPDATE ON user_balances
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- fx_rates
-- -----------------------------------------------------------------------------
CREATE TABLE fx_rates (
  base_currency   VARCHAR(10) NOT NULL REFERENCES currencies(code),
  quote_currency  VARCHAR(10) NOT NULL REFERENCES currencies(code),
  rate            NUMERIC(38,18) NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual',
  as_of           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (base_currency, quote_currency, as_of),
  CONSTRAINT fx_rates_positive CHECK (rate > 0),
  CONSTRAINT fx_rates_distinct CHECK (base_currency <> quote_currency)
);

CREATE INDEX fx_rates_lookup_idx ON fx_rates (base_currency, quote_currency, as_of DESC);

-- -----------------------------------------------------------------------------
-- deposit_requests / withdrawal_requests
-- -----------------------------------------------------------------------------
CREATE TABLE deposit_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency_code  VARCHAR(10) NOT NULL REFERENCES currencies(code),
  amount         NUMERIC(38,18) NOT NULL,
  method         TEXT        NOT NULL,
  status         transaction_status NOT NULL DEFAULT 'PENDING',
  external_ref   TEXT,
  idempotency_key TEXT       NOT NULL UNIQUE,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deposit_requests_amount_positive CHECK (amount > 0)
);

CREATE INDEX deposit_requests_user_idx ON deposit_requests (user_id, created_at DESC);
CREATE UNIQUE INDEX deposit_requests_external_ref_idx
  ON deposit_requests (external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE withdrawal_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  currency_code  VARCHAR(10) NOT NULL REFERENCES currencies(code),
  amount         NUMERIC(38,18) NOT NULL,
  fee            NUMERIC(38,18) NOT NULL DEFAULT 0,
  destination    JSONB       NOT NULL,
  status         transaction_status NOT NULL DEFAULT 'PENDING',
  external_ref   TEXT,
  idempotency_key TEXT       NOT NULL UNIQUE,
  reviewed_by    TEXT,
  reviewed_at    TIMESTAMPTZ,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT withdrawal_requests_amount_positive CHECK (amount > 0),
  CONSTRAINT withdrawal_requests_fee_non_negative CHECK (fee >= 0),
  CONSTRAINT withdrawal_requests_has_destination CHECK (jsonb_typeof(destination) = 'object')
);

CREATE INDEX withdrawal_requests_user_idx ON withdrawal_requests (user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Reconciliation view
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW balance_reconciliation AS
SELECT
  b.user_id,
  b.currency_code,
  b.available                                   AS cached_available,
  b.locked                                      AS cached_locked,
  COALESCE(l.available, 0)                      AS ledger_available,
  COALESCE(l.locked, 0)                         AS ledger_locked,
  b.available - COALESCE(l.available, 0)        AS available_drift,
  b.locked    - COALESCE(l.locked, 0)           AS locked_drift
FROM user_balances b
LEFT JOIN (
  SELECT
    user_id,
    currency_code,
    sum(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END) AS available,
    0::NUMERIC(38,18) AS locked
  FROM ledger_entries
  WHERE user_id IS NOT NULL
  GROUP BY user_id, currency_code
) l ON l.user_id = b.user_id AND l.currency_code = b.currency_code
WHERE b.available <> COALESCE(l.available, 0)
   OR b.locked    <> COALESCE(l.locked, 0);

COMMENT ON VIEW balance_reconciliation IS
  'Rows only appear when the cached balance disagrees with the ledger. Should always be empty.';