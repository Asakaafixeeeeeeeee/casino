-- Game management (the owner's brief, 12 October 2026): per-game controls an admin sets from the Games tab.
--   paused        no new rounds or bets while paused (the game stays in the lobby; a round in play still finishes);
--                 with paused_until it resumes by itself at that time
--   min/max bet   tighter limits than the game's own (never looser), checked on every bet
--   wait_ms       Knockout, Crash and Jet: the betting time before each round takes off
--   max_x         Knockout and Crash: the highest multiplier a round can reach (the longest round). Bets still riding
--                 there are paid at it, so every cash-out plan keeps the published RTP.
-- Settings apply to rounds that haven't started yet: each Knockout/Crash/Jet round keeps the settings it was drawn
-- with (crash_flights.config), so nothing changes for a bet already placed.
CREATE TABLE IF NOT EXISTS game_settings (
  game         TEXT PRIMARY KEY,            -- the server's game id (volta-knockout, volta-coin, ...)
  paused       BOOLEAN NOT NULL DEFAULT false,
  paused_until TIMESTAMPTZ,
  pause_note   TEXT,
  min_bet      NUMERIC(12,2),
  max_bet      NUMERIC(12,2),
  wait_ms      INTEGER CHECK (wait_ms IS NULL OR (wait_ms BETWEEN 3000 AND 60000)),
  max_x        NUMERIC(12,2) CHECK (max_x IS NULL OR max_x >= 2),
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE crash_flights ADD COLUMN IF NOT EXISTS config JSONB;
