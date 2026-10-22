import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";
import { loadCurrencyCatalog } from "../../src/bootstrap.js";
import { ensureWalletAccount } from "../../src/services/accountLink.js";
import { getUserBalances } from "../../src/services/balanceService.js";
import { createPaymentIntent } from "../../src/services/teller.js";

const MIGRATIONS = [
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
  "044_existing_withdrawal_rule_notice.sql",
  "045_remove_unused_withdrawal_notice_cohort.sql",
  "046_lotto_precommitted_manual_numbers.sql",
  "047_deposit_phone_lock.sql",
  "048_support_ai_push_lotto_hide.sql",
  "049_lotto_numbers_immutable.sql",
  "050_lotto_manual_only.sql",
  "051_payment_gateway.sql",
];

// The production code takes a pg Pool; PGlite is one in-process Postgres connection.
function poolFrom(pg: PGlite): Pool {
  const query = async (text: string, params?: unknown[]) => {
    const r = await pg.query(text, params as never[]);
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows || 0 };
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

/** A fresh wallet database with the production migrations applied (all, or those before `stopBefore`) and one player. */
export async function setupWalletDb(opts: { stopBefore?: string } = {}) {
  const pg = new PGlite();
  const runMigration = async (name: string) =>
    pg.exec(await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
  for (const name of MIGRATIONS) {
    if (name === opts.stopBefore) break;
    await runMigration(name);
  }
  const db = poolFrom(pg);
  const client = (await db.connect()) as PoolClient;
  await loadCurrencyCatalog(client);
  const userId = await ensureWalletAccount(db, "account-1", "tester");
  const intentWithTx = async (amount: number, txId: string) => {
    const intent = await createPaymentIntent(client, userId, amount, "GHS", `deposit:${txId}`, "https://site/wallet.html");
    await db.query("UPDATE payment_intents SET transaction_id = $1 WHERE id = $2", [txId, intent.id]);
  };
  const balance = async () => Number((await getUserBalances(client, userId)).primary.available);
  const intent = async (txId: string) =>
    (await db.query("SELECT status, gateway_note FROM payment_intents WHERE transaction_id = $1", [txId])).rows[0];
  return { db, client, userId, intentWithTx, balance, intent, runMigration };
}
