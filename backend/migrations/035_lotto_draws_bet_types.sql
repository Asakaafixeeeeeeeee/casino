-- 035_lotto_draws_bet_types.sql
-- Lotto, part two: named draws an admin creates (with opening, closing and draw times, and a pause switch) next to
-- the daily scheduled draw; Perm and Banker tickets next to Direct ones; payout odds per ticket size set by an
-- admin; a short ticket code players and admins can quote.

-- draws: a name, when betting opens, a pause switch, and whether the daily schedule made it
ALTER TABLE lotto_draws ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'Daily Draw';
ALTER TABLE lotto_draws ADD COLUMN IF NOT EXISTS opens_at TIMESTAMPTZ;
ALTER TABLE lotto_draws ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE lotto_draws ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE lotto_draws ADD COLUMN IF NOT EXISTS created_by TEXT;
-- only the daily draws need one per draw time; an admin's draw may share a time with one
ALTER TABLE lotto_draws DROP CONSTRAINT IF EXISTS lotto_draws_draw_at_key;
CREATE UNIQUE INDEX IF NOT EXISTS lotto_draws_auto_at ON lotto_draws (draw_at) WHERE auto;

-- settings: the daily schedule's switch and name, the payout odds per ticket size (null = worked out from the RTP),
-- which bet types are offered, and the most lines one Perm or Banker ticket may hold
ALTER TABLE lotto_settings ADD COLUMN IF NOT EXISTS daily_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE lotto_settings ADD COLUMN IF NOT EXISTS daily_name TEXT NOT NULL DEFAULT 'Daily Draw';
ALTER TABLE lotto_settings ADD COLUMN IF NOT EXISTS odds JSONB;
ALTER TABLE lotto_settings ADD COLUMN IF NOT EXISTS bet_types JSONB NOT NULL
  DEFAULT '{"direct": [1, 2, 3, 4, 5], "perm": [2, 3], "banker": true}';
ALTER TABLE lotto_settings ADD COLUMN IF NOT EXISTS max_lines INTEGER NOT NULL DEFAULT 120;

-- tickets: Direct (one line of 1-5 numbers), Perm (every line of `size` numbers from the picks) or Banker (the
-- banker number with each partner number, a line of 2 each); `stake` is the ticket's total, `unit_stake` each line's
ALTER TABLE lotto_tickets ADD COLUMN IF NOT EXISTS bet_type TEXT NOT NULL DEFAULT 'DIRECT';
ALTER TABLE lotto_tickets ADD COLUMN IF NOT EXISTS size SMALLINT;
ALTER TABLE lotto_tickets ADD COLUMN IF NOT EXISTS banker SMALLINT;
ALTER TABLE lotto_tickets ADD COLUMN IF NOT EXISTS lines INTEGER NOT NULL DEFAULT 1;
ALTER TABLE lotto_tickets ADD COLUMN IF NOT EXISTS unit_stake NUMERIC(38,18);
ALTER TABLE lotto_tickets ADD COLUMN IF NOT EXISTS winning_lines INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lotto_tickets ADD COLUMN IF NOT EXISTS code TEXT;
UPDATE lotto_tickets SET size = cardinality(picks) WHERE size IS NULL;
UPDATE lotto_tickets SET unit_stake = stake WHERE unit_stake IS NULL;
UPDATE lotto_tickets SET code = 'LT-' || upper(substr(replace(id::text, '-', ''), 1, 10)) WHERE code IS NULL;
UPDATE lotto_tickets SET winning_lines = 1 WHERE status = 'WON' AND winning_lines = 0;
CREATE UNIQUE INDEX IF NOT EXISTS lotto_tickets_code ON lotto_tickets (code);
CREATE INDEX IF NOT EXISTS lotto_tickets_created ON lotto_tickets (created_at DESC);
