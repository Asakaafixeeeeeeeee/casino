import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const { Pool } = pg;
const root = dirname(fileURLToPath(import.meta.url));
const migrationFiles = [
  "001_schema.sql",
  "002_seed_currencies.sql",
  "003_payment_intents.sql",
  "004_account_mapping.sql",
  "005_payment_intent_note.sql",
  "006_feedback.sql",
  "007_withdrawals.sql",
  "008_player_limits.sql",
  "009_game_rounds.sql",
  "010_game_sessions.sql",
  "011_crash_flights.sql",
  "012_jet_multiplier.sql",
  "013_mines_live.sql",
  "014_admin_partners.sql",
  "015_deposit_payer.sql",
  "016_support_chat.sql",
  "017_rendowin_points.sql",
  "018_usd_only.sql",
  "019_session_void.sql",
  "020_sky_rush.sql",
  "021_partner_deposit_pct.sql",
  "022_regional_admins.sql",
  "023_user_full_name.sql",
  "024_withdrawable_winnings.sql",
  "025_aviator_settings.sql",
  "026_partner_revshare.sql",
  "027_partner_deposit_funds.sql",
  "028_partner_platform.sql",
  "029_partner_invites.sql",
  "030_game_management.sql",
  "031_free_play_showcase.sql",
  "032_risk_management.sql",
  "033_deposit_network_reviews.sql",
  "034_lotto.sql",
  "035_lotto_draws_bet_types.sql",
  "036_lotto_sales_switch.sql",
  "037_payment_settings.sql",
  "038_account_control.sql",
  "039_bnc_win.sql",
  "040_money_rules.sql",
  "041_betting_sessions.sql",
  "042_deposit_rejections.sql",
  "043_withdrawal_deposit_requirement.sql",
];

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to apply production migrations");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: "-c search_path=wallet,public",
  connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS ?? 10000),
  max: 1,
});

try {
  await pool.query("CREATE SCHEMA IF NOT EXISTS wallet");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for (const name of migrationFiles) {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [name],
    );
    if (rowCount) {
      console.log(`already applied ${name}`);
      continue;
    }

    const sql = await readFile(join(root, "migrations", name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}