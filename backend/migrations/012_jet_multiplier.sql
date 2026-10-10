-- Jet's multiplier climbs in thousandths (0.001 every 1/60 s), so a cash-out can land on 1.234x.
ALTER TABLE crash_bets ALTER COLUMN cashed_x TYPE NUMERIC(12,3);
