-- 040_money_rules.sql
-- Admin -> Betting & withdrawal settings: the site's minimum deposit, the betting eligibility rule and the withdrawal
-- play-through rule, with the wording players see. One row; every save is kept in money_rule_changes and the admin log.
-- Neither rule ever deducts money: the betting rule only refuses new real-money bets, and the play-through rule only
-- holds deposited money not yet bet (never winnings, never anything deposited before the rule was switched on).
-- rules_version goes up when a material setting changes; players accept the current version before depositing.
CREATE TABLE IF NOT EXISTS money_rules (
  id                       SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  min_deposit              NUMERIC(12,2) NOT NULL DEFAULT 135 CHECK (min_deposit >= 1 AND min_deposit <= 100000),
  bet_rule_enabled         BOOLEAN NOT NULL DEFAULT false,
  bet_rule_days            INT NOT NULL DEFAULT 30 CHECK (bet_rule_days BETWEEN 1 AND 365),
  bet_rule_message         TEXT NOT NULL DEFAULT 'To place casino bets you need a deposit of at least GHS {min} in the last {days} days. Your balance stays yours: nothing is deducted, you can still see it, and you can still withdraw what is withdrawable.',
  withdraw_rule_enabled    BOOLEAN NOT NULL DEFAULT false,
  withdraw_rule_multiple   NUMERIC(6,2) NOT NULL DEFAULT 1 CHECK (withdraw_rule_multiple >= 0 AND withdraw_rule_multiple <= 20),
  withdraw_rule_message    TEXT NOT NULL DEFAULT 'Deposited money has to be played through before it can be withdrawn. GHS {held} of your balance is held until you place GHS {to_bet} more in bets. Your winnings are never held, and nothing is deducted.',
  withdraw_info            TEXT NOT NULL DEFAULT 'Withdrawals are paid to the mobile money number you registered with, after an admin approves them (usually within a few minutes during business hours). The minimum withdrawal is GHS 20. Only winnings can be withdrawn; deposited money stays in your balance for betting. If anything is unclear, contact customer care.',
  rules_version            INT NOT NULL DEFAULT 1,
  bet_rule_enabled_at      TIMESTAMPTZ,
  withdraw_rule_enabled_at TIMESTAMPTZ,
  updated_by               TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO money_rules (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Every save: who, when, and each changed setting's value before and after.
CREATE TABLE IF NOT EXISTS money_rule_changes (
  id          BIGSERIAL PRIMARY KEY,
  admin       TEXT NOT NULL,
  changes     JSONB NOT NULL,
  rules_version INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS money_rule_changes_created_idx ON money_rule_changes (created_at DESC);

-- A player's acceptance of one version of the rules (asked for before a deposit).
CREATE TABLE IF NOT EXISTS money_rules_acceptance (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rules_version INT NOT NULL,
  accepted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, rules_version)
);
