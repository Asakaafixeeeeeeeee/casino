-- Named draws may use an admin-selected result only when it is committed before betting opens.
ALTER TABLE lotto_draws ADD COLUMN IF NOT EXISTS number_source TEXT NOT NULL DEFAULT 'SERVER'
  CHECK (number_source IN ('SERVER', 'MANUAL'));
