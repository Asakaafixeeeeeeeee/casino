-- 050_lotto_manual_only.sql
-- Only admin-scheduled (manual) draws are offered. The automatic daily draw is switched off (an admin can switch it
-- back on in Lotto settings), and automatic draws still open with no tickets are withdrawn. Automatic draws that
-- already have tickets are left untouched so their players are settled normally.

UPDATE lotto_settings SET daily_enabled = false WHERE id = 1;

UPDATE lotto_draws SET status = 'CANCELLED'
 WHERE auto AND status = 'OPEN'
   AND NOT EXISTS (SELECT 1 FROM lotto_tickets t WHERE t.draw_id = lotto_draws.id);
