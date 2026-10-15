-- Remember which accounts existed when the withdrawal deposit requirement was
-- introduced, so those players can see its terms and progress on the withdraw page.
CREATE TABLE IF NOT EXISTS withdrawal_deposit_notice_users (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO withdrawal_deposit_notice_users (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;
