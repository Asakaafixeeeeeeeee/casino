-- One row per withdrawal request: REQUESTED → (admin approves) PAYING → PAID, or → DECLINED (money returned).
CREATE TABLE IF NOT EXISTS withdrawals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  journal_id     UUID NOT NULL UNIQUE REFERENCES ledger_journal(id),
  amount         NUMERIC(38,18) NOT NULL CHECK (amount > 0),
  currency       VARCHAR(10) NOT NULL REFERENCES currencies(code),
  phone          TEXT NOT NULL,              -- the player's registered number, 0XXXXXXXXX
  status         TEXT NOT NULL DEFAULT 'REQUESTED'
                   CHECK (status IN ('REQUESTED', 'PAYING', 'PAID', 'DECLINED')),
  transaction_id TEXT UNIQUE,                -- TheTeller's 12-digit id, set when the payout is sent
  gateway_note   TEXT,
  decided_by     TEXT,                       -- the admin who approved or rejected it
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS withdrawals_status_idx ON withdrawals(status, created_at);
CREATE INDEX IF NOT EXISTS withdrawals_user_idx ON withdrawals(user_id, created_at DESC);

-- Requests made before this table existed, so an admin can pay or refund them.
INSERT INTO withdrawals (user_id, journal_id, amount, currency, phone, status, created_at, updated_at)
SELECT e.user_id, j.id, e.amount, e.currency_code,
       regexp_replace(coalesce(j.external_ref, ''), '^momo:', ''), 'REQUESTED', j.created_at, j.created_at
  FROM ledger_journal j
  JOIN ledger_entries e ON e.journal_id = j.id AND e.direction = 'DEBIT' AND e.user_id IS NOT NULL
 WHERE j.entry_type = 'WITHDRAWAL_REQUEST'
   AND NOT EXISTS (SELECT 1 FROM withdrawals w WHERE w.journal_id = j.id);
