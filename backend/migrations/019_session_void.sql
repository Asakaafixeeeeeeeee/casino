-- A step-game round (Mines, Crossing, Goal) left untouched for a day is settled for the player: cashed out if it has
-- progress, or VOID with the stake returned if no move was made. VOID joins the allowed statuses.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'game_sessions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE game_sessions DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE game_sessions ADD CONSTRAINT game_sessions_status_check CHECK (status IN ('OPEN', 'WON', 'LOST', 'VOID'));
END $$;
