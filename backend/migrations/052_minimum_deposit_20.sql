ALTER TABLE money_rules ALTER COLUMN min_deposit SET DEFAULT 20;

WITH previous AS (
  SELECT min_deposit, rules_version FROM money_rules WHERE id = 1 AND min_deposit <> 20
), updated AS (
  UPDATE money_rules
     SET min_deposit = 20, rules_version = rules_version + 1,
         updated_by = 'migration 052', updated_at = now()
   WHERE id = 1 AND min_deposit <> 20
   RETURNING rules_version
)
INSERT INTO money_rule_changes (admin, changes, rules_version)
SELECT 'migration 052',
       jsonb_build_object(
         'min_deposit', jsonb_build_object('before', previous.min_deposit, 'after', 20),
         'rules_version', jsonb_build_object('before', previous.rules_version, 'after', updated.rules_version)
       ),
       updated.rules_version
  FROM previous CROSS JOIN updated;
