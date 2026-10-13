-- 036_lotto_sales_switch.sql
-- Lotto, part three: real-money ticket sales stay off until an admin switches them on (confirming the required
-- licence and approvals are in place). Players can see the Lotto page meanwhile but can't buy a ticket.

ALTER TABLE lotto_settings ADD COLUMN IF NOT EXISTS real_money BOOLEAN NOT NULL DEFAULT false;
