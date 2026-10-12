-- Deposit network and withdrawal reviews (the owner's brief, 12 October 2026).
-- 1. Which mobile-money network a deposit used, so Recent deposits can show it (null for card/checkout deposits).
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS network TEXT;

-- 2. A player rates their withdrawal after an admin approves it. One review per withdrawal.
--    status: PENDING (submitted, waiting) -> APPROVED (admin ok'd) -> PUBLISHED (shown on profiles), or REJECTED;
--            DISMISSED means the player closed the popup without reviewing, so it is never shown to them again.
CREATE TABLE IF NOT EXISTS withdrawal_reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id UUID NOT NULL UNIQUE REFERENCES withdrawals(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating        SMALLINT CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  feedback      TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'APPROVED', 'PUBLISHED', 'REJECTED', 'DISMISSED')),
  decided_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS withdrawal_reviews_status_idx ON withdrawal_reviews(status, created_at DESC);
