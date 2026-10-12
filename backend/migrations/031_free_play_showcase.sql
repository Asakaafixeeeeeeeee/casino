-- Free play and the big-wins showcase (the owner's brief, 12 October 2026): two more per-game switches in Admin -> Games.
--   free_play  the game offers free play: practice credits, no real money, the same odds as real-money play
--              (on by default, which is how the games already worked)
--   showcase   the game page shows a strip of real big wins: the highest multipliers players actually won on it,
--              taken from the settled bets (off by default)
-- Neither switch has anything to do with how a result is drawn.
ALTER TABLE game_settings ADD COLUMN IF NOT EXISTS free_play BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE game_settings ADD COLUMN IF NOT EXISTS showcase BOOLEAN NOT NULL DEFAULT false;
