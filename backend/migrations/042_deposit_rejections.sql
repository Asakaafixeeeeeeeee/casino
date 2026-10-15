-- 042_deposit_rejections.sql
-- Deposit requests our own checks refused before anything was sent to TheTeller (PaySwitch): the amount, the payments
-- switch, the player's account and limits, the accepted conditions, the mobile money number and network, duplicates.
-- They never reach the gateway and no money moves; each one is kept here with who, how much, when, why and the outcome,
-- so failed attempts stay auditable. Declines from TheTeller itself stay on payment_intents (status FAILED, with the
-- gateway's note).
CREATE TABLE IF NOT EXISTS deposit_rejections (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  method          TEXT NOT NULL,              -- 'momo' (PIN prompt) or 'checkout' (card and Paybill, TheTeller's page)
  amount          NUMERIC(14,2),              -- the amount asked for, when it was a number
  amount_raw      TEXT,                       -- what was sent, when it wasn't
  currency        TEXT,
  network         TEXT,
  payer_phone     TEXT,
  idempotency_key TEXT,
  reason_code     TEXT NOT NULL,
  reason          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'REJECTED',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deposit_rejections_created_idx ON deposit_rejections (created_at DESC);
CREATE INDEX IF NOT EXISTS deposit_rejections_user_idx ON deposit_rejections (user_id, created_at DESC);
