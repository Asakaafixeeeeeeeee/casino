-- 041_betting_sessions.sql
-- The betting rule becomes "betting sessions": only deposited money not yet staked (session funds) can be staked; a
-- qualifying deposit activates a new session. Winnings can't be staked: they are kept apart and are always
-- withdrawable (from GHS 20). Nothing is ever deducted, and deposited money can always be bet.
--
-- Every line of the "Before you proceed with your deposit" box is now an admin-editable text. The rule is switched on
-- (as the owner asked), and the version goes up so every player reads and accepts the new wording before depositing.
ALTER TABLE money_rules
  ADD COLUMN IF NOT EXISTS policy_heading        TEXT NOT NULL DEFAULT 'BEFORE YOU PROCEED WITH YOUR DEPOSIT',
  ADD COLUMN IF NOT EXISTS policy_min_deposit    TEXT NOT NULL DEFAULT 'The minimum permissible deposit is GHS {min} per transaction, subject to a maximum of GHS {max}.',
  ADD COLUMN IF NOT EXISTS policy_betting        TEXT NOT NULL DEFAULT 'A qualifying deposit is required to activate a new betting session. Existing account balances do not independently qualify users to initiate additional betting sessions. Any remaining funds retain their applicable account rights.',
  ADD COLUMN IF NOT EXISTS policy_funds          TEXT NOT NULL DEFAULT 'Your balance is held in two parts. Session funds are your deposited money not yet staked: only session funds can be used to place bets. Winnings are kept separately: they cannot be used to stake, and they remain yours to withdraw at any time (from the minimum withdrawal). No part of your balance is ever deducted or confiscated.',
  ADD COLUMN IF NOT EXISTS policy_withdrawal     TEXT NOT NULL DEFAULT 'Eligible withdrawal requests are securely reviewed and processed by our dedicated Payments Team in accordance with the platform''s withdrawal policy. Approved payments are disbursed to the registered Mobile Money account.',
  ADD COLUMN IF NOT EXISTS policy_min_withdrawal TEXT NOT NULL DEFAULT 'GHS 20.00.',
  ADD COLUMN IF NOT EXISTS policy_notice         TEXT NOT NULL DEFAULT 'Please review the applicable deposit, betting and withdrawal conditions before proceeding. For further clarification, contact our Customer Support Team.',
  ADD COLUMN IF NOT EXISTS policy_accept         TEXT NOT NULL DEFAULT 'I acknowledge that I have carefully reviewed, understood and accepted the applicable deposit, betting and withdrawal conditions.';

/* the message a player sees when a bet is refused because their session has ended */
UPDATE money_rules
   SET bet_rule_message = 'Only deposited funds can be staked. Your session funds: GHS {session}. Your winnings of GHS {winnings} cannot be staked, but they remain yours to withdraw at any time. A qualifying deposit (minimum GHS {min}) activates a new betting session.'
 WHERE bet_rule_message LIKE 'To place casino bets you need a deposit of at least GHS {min} in the last {days} days.%';

/* no reference to administrators on the customer pages: withdrawals are handled by the Payments Team */
UPDATE money_rules
   SET withdraw_info = 'Eligible withdrawal requests are securely reviewed and processed by our dedicated Payments Team, usually within a few minutes during business hours, and paid to the Mobile Money number you registered with. The minimum withdrawal is GHS 20.00. Only winnings can be withdrawn; deposited money stays in your balance as session funds for betting. For further clarification, contact our Customer Support Team.'
 WHERE withdraw_info LIKE 'Withdrawals are paid to the mobile money number you registered with, after an admin approves them%';

/* switch the session rule on and ask every player to accept the new conditions before their next deposit */
UPDATE money_rules
   SET bet_rule_enabled = true,
       bet_rule_enabled_at = coalesce(bet_rule_enabled_at, now()),
       rules_version = rules_version + 1,
       updated_by = 'migration 041', updated_at = now()
 WHERE id = 1 AND NOT bet_rule_enabled;

INSERT INTO money_rule_changes (admin, changes, rules_version)
SELECT 'migration 041', '{"bet_rule_enabled":{"before":false,"after":true},"note":"betting sessions and the new deposit-page wording"}'::jsonb, rules_version
  FROM money_rules WHERE id = 1 AND updated_by = 'migration 041'
   AND NOT EXISTS (SELECT 1 FROM money_rule_changes WHERE admin = 'migration 041');
