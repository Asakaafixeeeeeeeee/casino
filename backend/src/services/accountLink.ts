import type { Pool, PoolClient } from "pg";

/** Every wallet settles in cedis: deposits, games and withdrawals all run in GHS, whatever the player's country.
 *  (The countries table maps each country to a currency for a future multi-currency wallet; the chosen view
 *  currency — USD or GHS — is the account's own setting.) */
export const SETTLEMENT_CURRENCY = "GHS";

/** The country a registration belongs to: the one chosen at sign-up when it's a supported country, else the one
 *  its phone number's dialling code points at (the `countries` table — adding a country is an INSERT there, not a
 *  code change). Numbers without a recognised code fall back to Ghana, where the site is offered. */
export async function countryFromPhone(client: PoolClient, phone: string | undefined, chosen?: string): Promise<{ code: string; currency: string }> {
  const code = String(chosen ?? "").toUpperCase();
  if (/^[A-Z]{2}$/.test(code)) {
    const { rows } = await client.query<{ code: string }>(`SELECT code FROM countries WHERE code = $1 AND is_supported`, [code]);
    if (rows[0]) return { code: rows[0].code, currency: SETTLEMENT_CURRENCY };
  }
  const digits = String(phone ?? "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    const { rows } = await client.query<{ code: string }>(
      `SELECT code FROM countries
        WHERE is_supported AND $1 LIKE phone_prefix || '%'
        ORDER BY length(phone_prefix) DESC LIMIT 1`, [digits]);
    if (rows[0]) return { code: rows[0].code, currency: SETTLEMENT_CURRENCY };
  }
  return { code: "GH", currency: SETTLEMENT_CURRENCY };
}

/**
 * Create or retrieve the wallet identity for an authenticated accounts-api user.
 * The accounts database owns its numeric user ID; the wallet schema owns UUIDs.
 * On first sight the player's country is recorded (the one chosen at sign-up, else from the number's dialling code),
 * the primary account is opened in the settlement currency and the loyalty points balance alongside it.
 */
export async function ensureWalletAccount(
  db: Pool,
  accountUserId: string,
  username?: string,
  phone?: string,
  chosenCountry?: string,
): Promise<string> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Serialize first-login provisioning for this account to avoid duplicate users.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [accountUserId]);

    const linked = await client.query<{ user_id: string }>(
      "SELECT user_id FROM user_accounts WHERE account_user_id = $1",
      [accountUserId],
    );
    if (linked.rowCount) {
      await client.query("COMMIT");
      return linked.rows[0]!.user_id;
    }

    const country = await countryFromPhone(client, phone, chosenCountry);
    const walletUser = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, username, country_code, primary_currency_code)
       VALUES ($1, 'managed-by-accounts-api', $2, $3, $4)
       RETURNING id`,
      [`account-${accountUserId}@wallet.invalid`, username ?? null, country.code, country.currency],
    );
    const walletUserId = walletUser.rows[0]!.id;

    /* the primary (fiat) account and the points balance; crypto sub-balances are opened on their first movement */
    await client.query(
      `INSERT INTO user_balances (user_id, currency_code)
       VALUES ($1, $2), ($1, 'VBP')`,
      [walletUserId, country.currency],
    );
    await client.query(
      "INSERT INTO user_accounts (account_user_id, user_id) VALUES ($1, $2)",
      [accountUserId, walletUserId],
    );
    await client.query("COMMIT");
    return walletUserId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}