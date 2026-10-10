-- Partners earn a set percentage of every deposit their players make (the owner's choice, 8 October 2026), instead of a
-- share of net revenue plus CPA. Every partner starts at 5%; an admin sets each partner's rate, from 0% to 30%.
-- The old revshare_pct / cpa_* columns stay but are no longer used, so nothing already recorded is lost.
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS deposit_pct NUMERIC(5,2) NOT NULL DEFAULT 5
  CONSTRAINT affiliates_deposit_pct_range CHECK (deposit_pct >= 0 AND deposit_pct <= 30);
