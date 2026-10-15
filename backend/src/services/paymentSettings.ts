// src/services/paymentSettings.ts
//
// The main admin's "TheTeller Payment Settings": the ON/OFF switch for new payments, and what the admin may see of
// the TheTeller connection (the merchant id, the mode, whether each secret is set, and whether TheTeller answers).
// API keys, usernames and passcodes are never sent anywhere from here: only whether they are set.
//
// OFF stops new payments only. Payments already started are still checked with TheTeller and credited (the status
// route, the background recheck and an admin's recheck never consult this switch).

import type { Pool } from "pg";
import { cleanCredential, credentialHints, loadTellerConfig, newTxId, TellerConfigurationError } from "./teller.js";
import { AdminError, logAction } from "./admin.js";

type Db = Pool;

export const PAYMENTS_OFF_MESSAGE = "Payments are temporarily unavailable. Please try again later.";

export interface PaymentSettings { payments_enabled: boolean; updated_by: string | null; updated_at: string | null }

/** The switch as saved; ON when the row is somehow missing, which is how the site worked before the switch existed. */
export async function getPaymentSettings(db: Db): Promise<PaymentSettings> {
  const row = (await db.query<{ payments_enabled: boolean; updated_by: string | null; updated_at: Date | null }>(
    `SELECT payments_enabled, updated_by, updated_at FROM payment_settings WHERE id = 1`)).rows[0];
  return {
    payments_enabled: row ? row.payments_enabled !== false : true,
    updated_by: row?.updated_by ?? null,
    updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export const paymentsEnabled = async (db: Db) => (await getPaymentSettings(db)).payments_enabled;

/** Saves the switch (kept until an admin changes it) and writes it to the admin log. */
export async function setPaymentsEnabled(db: Db, admin: string, input: Record<string, unknown>): Promise<PaymentSettings> {
  if (typeof input.enabled !== "boolean") throw new AdminError("invalid_switch", "Say whether payments are on (true) or off (false)", 400);
  const before = await getPaymentSettings(db);
  await db.query(
    `INSERT INTO payment_settings (id, payments_enabled, updated_by, updated_at) VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET payments_enabled = EXCLUDED.payments_enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [input.enabled, admin]);
  await logAction(db, admin, input.enabled ? "payments.on" : "payments.off", "teller",
    { before: before.payments_enabled, after: input.enabled });
  return getPaymentSettings(db);
}

/** Whether TheTeller's API answers at all: a status request for a transaction id nobody used (it needs the merchant
 *  id only, never the API key). Any HTTP answer means the server is reachable; it does not prove the API key. */
export async function pingTeller(env: NodeJS.ProcessEnv = process.env, timeoutMs = 8000):
  Promise<{ reachable: boolean; http: number | null; ms: number; error: string | null }> {
  const started = Date.now();
  let config;
  try {
    config = loadTellerConfig(env);
  } catch (e) {
    if (e instanceof TellerConfigurationError) return { reachable: false, http: null, ms: 0, error: "Not configured" };
    throw e;
  }
  try {
    const r = await fetch(`${config.apiBaseUrl}/v1.1/users/transactions/${newTxId()}/status`, {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "Merchant-Id": config.merchantId },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await r.text().catch(() => "");
    return { reachable: true, http: r.status, ms: Date.now() - started, error: null };
  } catch (e) {
    return { reachable: false, http: null, ms: Date.now() - started, error: (e as Error).name === "TimeoutError" ? "No answer in time" : "Could not connect" };
  }
}

/** The admin page: the switch, the merchant id, the mode, which secrets are set (never their values), the connection
 *  and the last day's deposits. `ping` is injectable for tests. */
export async function paymentSettingsOverview(db: Db, env: NodeJS.ProcessEnv = process.env, ping = pingTeller) {
  const settings = await getPaymentSettings(db);
  let configured = true;
  let missing: string[] = [];
  let mode = "live";
  let apiBaseUrl: string | null = null;
  try {
    const config = loadTellerConfig(env);
    apiBaseUrl = config.apiBaseUrl;
    mode = /\/\/test\./.test(config.apiBaseUrl) ? "test" : "live";
  } catch (e) {
    if (!(e instanceof TellerConfigurationError)) throw e;
    configured = false;
    missing = ["TELLER_MERCHANT_ID", "TELLER_API_USERNAME", "TELLER_API_KEY"].filter((name) =>
      !cleanCredential(name === "TELLER_API_USERNAME" ? env.TELLER_API_USER ?? env.TELLER_API_USERNAME : env[name]));
  }
  const merchantId = cleanCredential(env.TELLER_MERCHANT_ID) || null;
  const isSet = (v: string | undefined) => !!cleanCredential(v);
  const connection = configured ? await ping(env) : { reachable: false, http: null, ms: 0, error: "Not configured" };

  const day = (await db.query<{ confirmed: string; pending: string; failed: string; confirmed_amount: string }>(
    `SELECT count(*) FILTER (WHERE status = 'CONFIRMED') AS confirmed,
            count(*) FILTER (WHERE status = 'PENDING' AND transaction_id IS NOT NULL) AS pending,
            count(*) FILTER (WHERE status = 'FAILED') AS failed,
            coalesce(sum(amount) FILTER (WHERE status = 'CONFIRMED'), 0) AS confirmed_amount
       FROM payment_intents WHERE created_at > now() - interval '24 hours'`)).rows[0]!;
  const last = (await db.query<{ updated_at: Date }>(
    `SELECT updated_at FROM payment_intents WHERE status = 'CONFIRMED' ORDER BY updated_at DESC LIMIT 1`)).rows[0];
  const waiting = (await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM payment_intents WHERE status = 'PENDING' AND transaction_id IS NOT NULL`)).rows[0]!;

  return {
    ...settings,
    off_message: PAYMENTS_OFF_MESSAGE,
    teller: {
      configured, missing, mode, api_base_url: apiBaseUrl,
      merchant_id: merchantId,
      merchant_id_looks_valid: credentialHints(env).merchantIdLooksValid,
      /* only whether each secret is set; the values never leave the server */
      secrets: {
        api_username: isSet(env.TELLER_API_USER ?? env.TELLER_API_USERNAME),
        api_key: isSet(env.TELLER_API_KEY),
        payout_passcode: isSet(env.TELLER_PASSCODE),
      },
    },
    connection: {
      status: !configured ? "not_configured" : connection.reachable ? "connected" : "unreachable",
      ...connection,
      checked_at: new Date().toISOString(),
      last_confirmed_at: last ? new Date(last.updated_at).toISOString() : null,
    },
    last_24h: {
      confirmed: Number(day.confirmed), pending: Number(day.pending), failed: Number(day.failed),
      confirmed_amount: Math.round(Number(day.confirmed_amount) * 100) / 100,
    },
    waiting_to_settle: Number(waiting.n),
  };
}
