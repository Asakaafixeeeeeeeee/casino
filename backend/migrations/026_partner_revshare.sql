-- Partners earn a share of the net gaming revenue their players generate (the owner's choice, 11 October 2026),
-- replacing the deposit percentage of migration 021:
--
--   a referred player's settled bet that LOSES (stake > payout):  + revshare% of (stake - payout)
--   a referred player's settled bet that WINS  (payout > stake):  - deduction% of (payout - stake)   (net winnings)
--
-- Every qualifying bet is recorded once in partner_commissions (UNIQUE source + bet id), with the rate in force when
-- it settled, so a later change of rate never touches what's already recorded. Commission is "pending" until its
-- settlement period closes; settling moves the period's net into the partner's commission wallet
-- (partner_wallet_entries). A negative period is carried into the next one or written off, as the admin chooses.
-- Payout requests hold money in that wallet; a rejection releases it. Nothing here changes a player's balance.
--
-- Nothing already recorded is lost: the deposit commission each partner had earned but not been paid becomes an
-- OPENING entry in their wallet, and payout requests still waiting become holds.

-- ---------------------------------------------------------------- settings
CREATE TABLE IF NOT EXISTS partner_settings (
  id                   BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),     -- a single row
  default_revshare_pct NUMERIC(5,2) NOT NULL DEFAULT 40 CHECK (default_revshare_pct BETWEEN 0 AND 90),
  win_deduction_pct    NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (win_deduction_pct BETWEEN 0 AND 100),
  carry_negative       BOOLEAN NOT NULL DEFAULT true,                    -- a negative period reduces the next one
  settlement_period    TEXT NOT NULL DEFAULT 'DAILY' CHECK (settlement_period IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  min_payout           NUMERIC(38,18) NOT NULL DEFAULT 50 CHECK (min_payout > 0),
  max_payout           NUMERIC(38,18) NOT NULL DEFAULT 50000 CHECK (max_payout > 0),
  referral_days        INTEGER NOT NULL DEFAULT 7 CHECK (referral_days BETWEEN 0 AND 365),  -- how new an account must be to be claimed
  links_enabled        BOOLEAN NOT NULL DEFAULT true,                    -- every partner link at once
  promo_codes_enabled  BOOLEAN NOT NULL DEFAULT true,                    -- promo codes at sign-up
  partner_promo_edit   BOOLEAN NOT NULL DEFAULT true,                    -- partners may set their own promo code
  updated_by           TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (max_payout >= min_payout)
);
INSERT INTO partner_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- the win deduction over time, so a change applies only to bets settled from its effective date
CREATE TABLE IF NOT EXISTS partner_deduction_rates (
  id             BIGSERIAL PRIMARY KEY,
  pct            NUMERIC(5,2) NOT NULL CHECK (pct BETWEEN 0 AND 100),
  effective_from TIMESTAMPTZ NOT NULL,
  set_by         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_deduction_rates_eff_idx ON partner_deduction_rates(effective_from DESC);
INSERT INTO partner_deduction_rates (pct, effective_from, set_by)
  SELECT 10, '-infinity', 'migration 026' WHERE NOT EXISTS (SELECT 1 FROM partner_deduction_rates);

-- ---------------------------------------------------------------- partners
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS promo_code TEXT;
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS link_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS payout_details JSONB;            -- the partner's saved payment details
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS promo_request TEXT;              -- a promo code the partner asked for
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS accrue_from TIMESTAMPTZ;         -- set when a disabled partner is reactivated:
                                                                                 -- bets from their disabled time never earn
CREATE UNIQUE INDEX IF NOT EXISTS affiliates_promo_code_idx ON affiliates(promo_code) WHERE promo_code IS NOT NULL;

-- DISABLED: switched off for good (links stop, no further commission); SUSPENDED is a pause
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'affiliates'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE affiliates DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE affiliates ADD CONSTRAINT affiliates_status_check
    CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'DISABLED'));
END $$;

-- each partner's revenue share over time (the rate a bet earns is the one in force when it settled)
CREATE TABLE IF NOT EXISTS affiliate_rates (
  id             BIGSERIAL PRIMARY KEY,
  affiliate_id   UUID NOT NULL REFERENCES affiliates(user_id) ON DELETE RESTRICT,
  revshare_pct   NUMERIC(5,2) NOT NULL CHECK (revshare_pct BETWEEN 0 AND 90),
  effective_from TIMESTAMPTZ NOT NULL,
  set_by         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS affiliate_rates_idx ON affiliate_rates(affiliate_id, effective_from DESC);
INSERT INTO affiliate_rates (affiliate_id, revshare_pct, effective_from, set_by)
  SELECT a.user_id, 40, now(), 'migration 026' FROM affiliates a
   WHERE NOT EXISTS (SELECT 1 FROM affiliate_rates r WHERE r.affiliate_id = a.user_id);

-- how a referred player was brought in
ALTER TABLE referrals ADD COLUMN IF NOT EXISTS via TEXT NOT NULL DEFAULT 'link'
  CHECK (via IN ('link', 'promo', 'link+promo', 'admin'));

-- ---------------------------------------------------------------- settlement periods and commissions
CREATE TABLE IF NOT EXISTS partner_settlements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id UUID NOT NULL REFERENCES affiliates(user_id) ON DELETE RESTRICT,
  period       TEXT NOT NULL CHECK (period IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,                 -- exclusive
  positive     NUMERIC(38,18) NOT NULL,       -- commission from losing bets
  negative     NUMERIC(38,18) NOT NULL,       -- deductions from winning bets (<= 0)
  carried_in   NUMERIC(38,18) NOT NULL,       -- a negative balance brought forward (<= 0)
  credited     NUMERIC(38,18) NOT NULL CHECK (credited >= 0),
  carried_out  NUMERIC(38,18) NOT NULL CHECK (carried_out <= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (affiliate_id, period_start)
);
CREATE INDEX IF NOT EXISTS partner_settlements_aff_idx ON partner_settlements(affiliate_id, period_start DESC);

CREATE TABLE IF NOT EXISTS partner_commissions (
  id            BIGSERIAL PRIMARY KEY,
  affiliate_id  UUID NOT NULL REFERENCES affiliates(user_id) ON DELETE RESTRICT,
  player_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source        TEXT NOT NULL,                -- the engine table: round, session, flight, live, sky
  bet_id        UUID NOT NULL,
  game          TEXT NOT NULL,
  stake         NUMERIC(38,18) NOT NULL,
  payout        NUMERIC(38,18) NOT NULL,
  ngr           NUMERIC(38,18) NOT NULL,      -- stake - payout (negative when the player won)
  pct           NUMERIC(5,2) NOT NULL,        -- the revenue share (losing bet) or deduction (winning bet) applied
  amount        NUMERIC(38,18) NOT NULL,      -- the commission: positive, negative or zero
  settled_at    TIMESTAMPTZ NOT NULL,         -- when the bet settled (decides the rate and the period)
  settlement_id UUID REFERENCES partner_settlements(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, bet_id)                     -- one commission per bet, ever
);
CREATE INDEX IF NOT EXISTS partner_commissions_aff_idx ON partner_commissions(affiliate_id, settled_at DESC);
CREATE INDEX IF NOT EXISTS partner_commissions_open_idx ON partner_commissions(affiliate_id) WHERE settlement_id IS NULL;
CREATE INDEX IF NOT EXISTS partner_commissions_player_idx ON partner_commissions(player_id, settled_at DESC);

-- ---------------------------------------------------------------- the commission wallet
CREATE TABLE IF NOT EXISTS partner_wallet_entries (
  id            BIGSERIAL PRIMARY KEY,
  affiliate_id  UUID NOT NULL REFERENCES affiliates(user_id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL CHECK (kind IN ('OPENING', 'SETTLEMENT', 'PAYOUT_HOLD', 'PAYOUT_RELEASE', 'CORRECTION')),
  amount        NUMERIC(38,18) NOT NULL,      -- + into the available balance, - out of it
  settlement_id UUID UNIQUE REFERENCES partner_settlements(id),
  payout_id     UUID REFERENCES affiliate_payouts(id),
  note          TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_wallet_aff_idx ON partner_wallet_entries(affiliate_id, created_at DESC);
-- a payout is held once and released at most once
CREATE UNIQUE INDEX IF NOT EXISTS partner_wallet_payout_once ON partner_wallet_entries(payout_id, kind) WHERE payout_id IS NOT NULL;

-- payout requests: REQUESTED -> APPROVED -> PAID (with the payment reference), or REJECTED (the hold released)
ALTER TABLE affiliate_payouts ADD COLUMN IF NOT EXISTS reference TEXT;
ALTER TABLE affiliate_payouts ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE affiliate_payouts ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'affiliate_payouts'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE affiliate_payouts DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE affiliate_payouts ADD CONSTRAINT affiliate_payouts_status_check
    CHECK (status IN ('REQUESTED', 'APPROVED', 'PAID', 'REJECTED'));
END $$;
DROP INDEX IF EXISTS affiliate_payouts_one_open;
CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payouts_one_open ON affiliate_payouts(affiliate_id) WHERE status IN ('REQUESTED', 'APPROVED');

-- opening balances: the deposit commission each partner earned (migration 021's rule, to the cent) less every payout
-- they asked for; payout requests still waiting become holds, so the available balance is exactly what it was
INSERT INTO partner_wallet_entries (affiliate_id, kind, amount, note, created_by)
SELECT a.user_id, 'OPENING',
       floor(a.deposit_pct / 100 * coalesce(d.deposits, 0) * 100 + 0.000001) / 100
         - coalesce((SELECT sum(p.amount) FROM affiliate_payouts p WHERE p.affiliate_id = a.user_id AND p.status = 'PAID'), 0),
       'Deposit commission earned before revenue share, less payouts already made', 'migration 026'
  FROM affiliates a
  LEFT JOIN LATERAL (
    SELECT sum(e.amount) AS deposits FROM referrals r
      JOIN ledger_entries e ON e.user_id = r.user_id AND e.direction = 'CREDIT' AND e.currency_code = 'GHS'
      JOIN ledger_journal j ON j.id = e.journal_id AND j.entry_type = 'DEPOSIT'
     WHERE r.affiliate_id = a.user_id) d ON true
 WHERE NOT EXISTS (SELECT 1 FROM partner_wallet_entries w WHERE w.affiliate_id = a.user_id AND w.kind = 'OPENING');
INSERT INTO partner_wallet_entries (affiliate_id, kind, amount, payout_id, note, created_by)
SELECT p.affiliate_id, 'PAYOUT_HOLD', -p.amount, p.id, 'Payout request waiting', 'migration 026'
  FROM affiliate_payouts p WHERE p.status = 'REQUESTED'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- every settled bet, with its id and settle time
-- (VOID and CANCELLED bets returned the stake and never count; OPEN / ACTIVE ones aren't settled yet)
CREATE OR REPLACE VIEW settled_bets AS
  SELECT 'round'::text AS source, id AS bet_id, user_id, game, stake, payout, created_at AS settled_at
    FROM game_rounds
  UNION ALL
  SELECT 'session', id, user_id, game, stake, payout, updated_at FROM game_sessions WHERE status IN ('WON', 'LOST')
  UNION ALL
  SELECT 'flight', b.id, b.user_id, f.game, b.stake, b.payout, b.updated_at
    FROM crash_bets b JOIN crash_flights f ON f.id = b.flight_id WHERE b.status IN ('WON', 'LOST')
  UNION ALL
  SELECT 'live', id, user_id, 'volta-mines-live', stake, payout, updated_at FROM mines_live_bets WHERE status IN ('WON', 'LOST')
  UNION ALL
  SELECT 'sky', id, user_id, 'sky-rush', stake, payout, updated_at FROM sky_bets WHERE status IN ('WON', 'LOST');

-- the optional email a player gave the accounts service (kept current at sign-in, for the admin's partner search)
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_email TEXT;
CREATE INDEX IF NOT EXISTS users_contact_email_idx ON users(lower(contact_email));
