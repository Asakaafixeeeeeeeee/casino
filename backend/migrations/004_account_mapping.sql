CREATE TABLE IF NOT EXISTS user_accounts (
  account_user_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_accounts_user_id_idx
  ON user_accounts(user_id);

COMMENT ON TABLE user_accounts IS
  'Maps the accounts-service identity to the balance-service UUID without relying on email.';
