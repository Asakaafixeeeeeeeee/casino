-- Live support chat: one conversation per player with the RendoWin team. Read positions are message ids (not
-- times), so "unread" never depends on clock precision.
CREATE TABLE IF NOT EXISTS support_threads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  player_read_id  BIGINT NOT NULL DEFAULT 0,   -- the last message the player has seen
  admin_read_id   BIGINT NOT NULL DEFAULT 0,   -- the last message an admin has seen
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_threads_recent_idx ON support_threads(status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS support_messages (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
  sender      TEXT NOT NULL CHECK (sender IN ('player', 'admin')),
  admin_phone TEXT,                            -- which admin replied (never shown to the player)
  body        TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_messages_thread_idx ON support_messages(thread_id, id);
