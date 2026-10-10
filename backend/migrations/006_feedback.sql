-- Ratings and ideas players send from the Me page.
CREATE TABLE IF NOT EXISTS feedback (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('rating', 'idea')),
  rating     SMALLINT CHECK (rating BETWEEN 1 AND 5),
  message    TEXT CHECK (char_length(message) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT feedback_has_content CHECK (
    (kind = 'rating' AND rating IS NOT NULL) OR
    (kind = 'idea' AND message IS NOT NULL AND char_length(btrim(message)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS feedback_user_idx ON feedback(user_id, created_at DESC);
