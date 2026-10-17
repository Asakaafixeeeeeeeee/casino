-- 048_support_ai_push_lotto_hide.sql
-- Additive only: nothing existing is changed or removed.
--  * support_threads: the AI assistant's progress (so a message is never answered twice) and a "needs an admin" flag
--  * push_subscriptions: browsers a player has allowed notifications on
--  * lotto_draws: a published result an admin has taken off the public pages (the draw, its tickets and payouts stay)

ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS ai_handled_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS needs_human BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS needs_human_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);

ALTER TABLE lotto_draws ADD COLUMN IF NOT EXISTS result_hidden_at TIMESTAMPTZ;
ALTER TABLE lotto_draws ADD COLUMN IF NOT EXISTS result_hidden_by TEXT;
ALTER TABLE lotto_draws ADD COLUMN IF NOT EXISTS result_hidden_reason TEXT;
