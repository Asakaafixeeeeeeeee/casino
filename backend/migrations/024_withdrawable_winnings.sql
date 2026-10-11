-- Only winnings can be withdrawn; deposited money stays in the balance for betting.
-- `withdrawable` is the winnings part of `available`: game payouts add to it, a withdrawal takes from it (and a
-- refused one gives it back), and any other spend (stakes, conversions) uses the deposit part first, so it only
-- shrinks when the balance drops below it.
ALTER TABLE user_balances ADD COLUMN IF NOT EXISTS withdrawable NUMERIC(38,18) NOT NULL DEFAULT 0;

-- Backfill: replay each player's ledger in order with the same rules.
DO $$
DECLARE
  r        RECORD;
  w        NUMERIC := 0;
  cur_user UUID;
  cur_ccy  TEXT;
BEGIN
  FOR r IN
    SELECT e.user_id, e.currency_code, e.direction, e.amount, e.balance_after, j.entry_type::text AS entry_type
      FROM ledger_entries e JOIN ledger_journal j ON j.id = e.journal_id
     WHERE e.user_id IS NOT NULL
     ORDER BY e.user_id, e.currency_code, e.id
  LOOP
    IF cur_user IS DISTINCT FROM r.user_id OR cur_ccy IS DISTINCT FROM r.currency_code THEN
      IF cur_user IS NOT NULL THEN
        UPDATE user_balances SET withdrawable = GREATEST(LEAST(w, available), 0)
         WHERE user_id = cur_user AND currency_code = cur_ccy;
      END IF;
      cur_user := r.user_id;
      cur_ccy := r.currency_code;
      w := 0;
    END IF;
    IF r.direction = 'CREDIT' THEN
      IF r.entry_type IN ('BET_SETTLED', 'REVERSAL') THEN w := w + r.amount; END IF;
    ELSIF r.entry_type = 'WITHDRAWAL_REQUEST' THEN
      w := GREATEST(w - r.amount, 0);
    ELSIF r.balance_after IS NOT NULL THEN
      w := LEAST(w, r.balance_after);
    END IF;
  END LOOP;
  IF cur_user IS NOT NULL THEN
    UPDATE user_balances SET withdrawable = GREATEST(LEAST(w, available), 0)
     WHERE user_id = cur_user AND currency_code = cur_ccy;
  END IF;
END $$;
