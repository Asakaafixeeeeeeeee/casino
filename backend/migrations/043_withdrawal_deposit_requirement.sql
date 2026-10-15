-- A player who has made a qualifying deposit, placed a casino bet, and won must
-- complete the configured number of qualifying deposits before withdrawing.
-- Deposit and win qualification is derived from the immutable ledger.
ALTER TABLE money_rules
  ADD COLUMN IF NOT EXISTS withdrawal_deposit_rule_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS withdrawal_required_deposits INT NOT NULL DEFAULT 3
    CHECK (withdrawal_required_deposits BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS withdrawal_deposit_message TEXT NOT NULL DEFAULT
    'Withdrawals are locked until you complete {remaining} more qualifying deposit(s) of at least GHS {min}. You have completed {completed} of {required}.',
  ADD COLUMN IF NOT EXISTS policy_deposit_withdrawal TEXT NOT NULL DEFAULT
    'After a qualifying deposit, a casino bet and your first win, you must complete {required} qualifying deposits in total before withdrawing. Each qualifying deposit is at least GHS {min}. Successful qualifying deposits made before your first win count toward the total.';

-- This new requirement is part of the terms players accept before depositing.
UPDATE money_rules
   SET withdrawal_deposit_rule_enabled = true,
       withdrawal_required_deposits = 3,
   policy_accept = 'I Accept Terms & Conditions',
   bet_rule_message = CASE
     WHEN bet_rule_message = 'Only deposited funds can be staked. Your session funds: GHS {session}. Your winnings of GHS {winnings} cannot be staked, but they remain yours to withdraw at any time. A qualifying deposit (minimum GHS {min}) activates a new betting session.'
     THEN 'Only deposited funds can be staked. Your session funds: GHS {session}. Your winnings of GHS {winnings} cannot be staked, but remain yours subject to the applicable withdrawal rules. A qualifying deposit (minimum GHS {min}) activates a new betting session.'
     ELSE bet_rule_message END,
   policy_funds = CASE
     WHEN policy_funds = 'Your balance is held in two parts. Session funds are your deposited money not yet staked: only session funds can be used to place bets. Winnings are kept separately: they cannot be used to stake, and they remain yours to withdraw at any time (from the minimum withdrawal). No part of your balance is ever deducted or confiscated.'
     THEN 'Your balance is held in two parts. Session funds are your deposited money not yet staked: only session funds can be used to place bets. Winnings are kept separately and cannot be used to stake; withdrawals remain subject to the applicable withdrawal conditions. No part of your balance is ever deducted or confiscated.'
     ELSE policy_funds END,
   rules_version = rules_version + 1,
   updated_by = 'migration 043', updated_at = now()
 WHERE id = 1;

INSERT INTO money_rule_changes (admin, changes, rules_version)
SELECT 'migration 043',
       '{"withdrawal_deposit_rule_enabled":{"before":false,"after":true},"withdrawal_required_deposits":{"before":0,"after":3},"note":"withdrawal deposit qualification added to terms"}'::jsonb,
       rules_version
  FROM money_rules
 WHERE id = 1
   AND NOT EXISTS (SELECT 1 FROM money_rule_changes WHERE admin = 'migration 043');
