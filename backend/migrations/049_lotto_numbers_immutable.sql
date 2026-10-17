-- 049_lotto_numbers_immutable.sql
-- Once a draw has its winning numbers (typed by an admin for a manual draw, or drawn by the server at closing) they can
-- never be changed or replaced, by any code path. Setting numbers on a draw that has none yet is still allowed.

CREATE OR REPLACE FUNCTION lotto_numbers_locked() RETURNS trigger AS $$
BEGIN
  IF OLD.numbers IS NOT NULL AND NEW.numbers IS DISTINCT FROM OLD.numbers THEN
    RAISE EXCEPTION 'The winning numbers of draw % are locked and cannot be changed', OLD.id;
  END IF;
  IF OLD.number_source = 'MANUAL' AND NEW.number_source IS DISTINCT FROM OLD.number_source THEN
    RAISE EXCEPTION 'The number method of manual draw % is locked', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lotto_numbers_locked ON lotto_draws;
CREATE TRIGGER lotto_numbers_locked BEFORE UPDATE ON lotto_draws
  FOR EACH ROW EXECUTE FUNCTION lotto_numbers_locked();
