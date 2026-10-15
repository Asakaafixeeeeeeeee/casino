-- 037_payment_settings.sql
-- The main admin's TheTeller switch: while it's off, nobody can start a new deposit anywhere on the site. Payments
-- already started keep being checked with TheTeller and credited as usual (status checks, the background recheck and
-- an admin's recheck never look at it). One row; it stays as set until an admin changes it.
CREATE TABLE IF NOT EXISTS payment_settings (
  id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  payments_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_by       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO payment_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
