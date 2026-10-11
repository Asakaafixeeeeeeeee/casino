-- Partners earn only on losses of REAL DEPOSITED MONEY (the owner's rule, 11 October 2026).
--
-- A player's balance has three parts:
--   withdrawable   winnings: every game payout (stake returned + profit) and a refused withdrawal coming back
--   deposit_funds  real deposited money still in the balance (confirmed deposits only)
--   the rest       other credits: an admin's adjustment, a bonus, a conversion
-- A stake spends deposited money first, then other credits, then winnings (the wallet already spent non-winnings
-- before winnings). How much of each stake came from deposited money is recorded on the stake's ledger leg
-- (ledger_entries.deposit_part); a cancelled or void bet gives that part back to deposit_funds.
--
-- Commission on a settled bet of a referred player:
--   loss  (stake > payout):  + rate% of the deposited-money part of the loss = (stake - payout) * deposit_part / stake
--   win   (payout > stake):  - deduction% of the net winnings (payout - stake)
-- Losses of winnings (or of other credits) never earn commission.

ALTER TABLE user_balances ADD COLUMN IF NOT EXISTS deposit_funds NUMERIC(38,18) NOT NULL DEFAULT 0;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS deposit_part NUMERIC(38,18);

-- Backfill: replay every player's ledger in order with the wallet's rules (withdrawable as in migration 024),
-- recording each debit's deposited-money part and ending with each balance's deposit_funds.
DO $$
DECLARE
  r        RECORD;
  w        NUMERIC := 0;
  d        NUMERIC := 0;
  used     NUMERIC;
  back     NUMERIC;
  cur_user UUID;
  cur_ccy  TEXT;
BEGIN
  FOR r IN
    SELECT e.id, e.user_id, e.currency_code, e.direction, e.amount, e.balance_after, j.entry_type::text AS entry_type,
           j.idempotency_key
      FROM ledger_entries e JOIN ledger_journal j ON j.id = e.journal_id
     WHERE e.user_id IS NOT NULL
     ORDER BY e.user_id, e.currency_code, e.id
  LOOP
    IF cur_user IS DISTINCT FROM r.user_id OR cur_ccy IS DISTINCT FROM r.currency_code THEN
      IF cur_user IS NOT NULL THEN
        UPDATE user_balances SET deposit_funds = GREATEST(LEAST(d, available - withdrawable), 0)
         WHERE user_id = cur_user AND currency_code = cur_ccy;
      END IF;
      cur_user := r.user_id;
      cur_ccy := r.currency_code;
      w := 0;
      d := 0;
    END IF;
    IF r.direction = 'CREDIT' THEN
      IF r.entry_type IN ('BET_SETTLED', 'REVERSAL') THEN w := w + r.amount; END IF;
      IF r.entry_type = 'DEPOSIT' THEN d := d + r.amount; END IF;
      IF r.entry_type = 'BET_VOID' AND r.idempotency_key LIKE 'void:%' THEN
        SELECT e2.deposit_part INTO back FROM ledger_journal j2
          JOIN ledger_entries e2 ON e2.journal_id = j2.id AND e2.user_id = r.user_id AND e2.direction = 'DEBIT'
         WHERE j2.idempotency_key = 'bet:' || substr(r.idempotency_key, 6) LIMIT 1;
        d := d + LEAST(r.amount, coalesce(back, 0));
      END IF;
    ELSIF r.entry_type = 'WITHDRAWAL_REQUEST' THEN
      w := GREATEST(w - r.amount, 0);
      UPDATE ledger_entries SET deposit_part = 0 WHERE id = r.id;
    ELSE
      used := LEAST(r.amount, d);
      d := d - used;
      UPDATE ledger_entries SET deposit_part = used WHERE id = r.id;
      IF r.balance_after IS NOT NULL THEN w := LEAST(w, r.balance_after); END IF;
    END IF;
    IF r.balance_after IS NOT NULL THEN d := GREATEST(LEAST(d, r.balance_after - w), 0); END IF;
  END LOOP;
  IF cur_user IS NOT NULL THEN
    UPDATE user_balances SET deposit_funds = GREATEST(LEAST(d, available - withdrawable), 0)
     WHERE user_id = cur_user AND currency_code = cur_ccy;
  END IF;
END $$;

-- every settled bet, now with the key of its stake's ledger journal (to find the stake's deposited-money part)
CREATE OR REPLACE VIEW settled_bets AS
  SELECT 'round'::text AS source, id AS bet_id, user_id, game, stake, payout, created_at AS settled_at,
         'bet:' || idempotency_key AS stake_key
    FROM game_rounds
  UNION ALL
  SELECT 'session', id, user_id, game, stake, payout, updated_at, 'bet:session:' || id
    FROM game_sessions WHERE status IN ('WON', 'LOST')
  UNION ALL
  SELECT 'flight', b.id, b.user_id, f.game, b.stake, b.payout, b.updated_at, 'bet:flight:' || b.id
    FROM crash_bets b JOIN crash_flights f ON f.id = b.flight_id WHERE b.status IN ('WON', 'LOST')
  UNION ALL
  SELECT 'live', id, user_id, 'volta-mines-live', stake, payout, updated_at, 'bet:live:' || id
    FROM mines_live_bets WHERE status IN ('WON', 'LOST')
  UNION ALL
  SELECT 'sky', id, user_id, 'sky-rush', stake, payout, updated_at, 'bet:sky:' || id
    FROM sky_bets WHERE status IN ('WON', 'LOST');

-- each commission record shows its working: how much of the stake was deposited money, and the eligible loss
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS deposit_stake NUMERIC(38,18);
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS eligible_loss NUMERIC(38,18) NOT NULL DEFAULT 0;
-- 'deposit' (this rule) or 'loss' (a record settled before it, under the earlier all-losses rule; left as paid)
ALTER TABLE partner_commissions ADD COLUMN IF NOT EXISTS rule TEXT NOT NULL DEFAULT 'deposit';

WITH dp AS (
  SELECT c.id, coalesce(e.deposit_part, 0) AS part
    FROM partner_commissions c
    JOIN settled_bets b ON b.source = c.source AND b.bet_id = c.bet_id
    LEFT JOIN ledger_journal j ON j.idempotency_key = b.stake_key
    LEFT JOIN ledger_entries e ON e.journal_id = j.id AND e.user_id = c.player_id AND e.direction = 'DEBIT'
)
UPDATE partner_commissions c
   SET deposit_stake = dp.part,
       eligible_loss = CASE WHEN c.stake > c.payout THEN trunc((c.stake - c.payout) * dp.part / c.stake, 2) ELSE 0 END,
       /* commission not yet settled is worked out again under the deposit rule; settled commission stays as paid */
       amount = CASE WHEN c.settlement_id IS NOT NULL OR c.stake <= c.payout THEN c.amount
                     ELSE trunc(trunc((c.stake - c.payout) * dp.part / c.stake, 2) * c.pct / 100, 2) END,
       rule = CASE WHEN c.settlement_id IS NOT NULL AND c.stake > c.payout THEN 'loss' ELSE 'deposit' END
  FROM dp WHERE dp.id = c.id;
