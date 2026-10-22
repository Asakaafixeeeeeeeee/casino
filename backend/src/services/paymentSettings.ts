// src/services/paymentSettings.ts
//
// The admin's Payteller Payment Settings: the deposit switch and Payteller connection state.
// API keys, usernames and passcodes are never sent anywhere from here: only whether they are set.
//
// OFF stops new payments only. Payments already started are still checked with their original provider and credited (the status
// route, the background recheck and an admin's recheck never consult this switch).

import type { Pool } from "pg";
import { loadPaytellerConfig, PaytellerConfigurationError } from "./payteller.js";
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
  await logAction(db, admin, input.enabled ? "payments.on" : "payments.off", "payteller",
    { before: before.payments_enabled, after: input.enabled });
  return getPaymentSettings(db);
}

/** Checks Payteller's authenticated status API using a reference that cannot belong to a real payment. */
export async function pingPayteller(env: NodeJS.ProcessEnv = process.env, timeoutMs = 8000):
  Promise<{ reachable: boolean; http: number | null; ms: number; error: string | null }> {
  const started = Date.now();
  let config;
  try {
    config = loadPaytellerConfig(env);
  } catch (e) {
    if (e instanceof PaytellerConfigurationError) return { reachable: false, http: null, ms: 0, error: "Not configured" };
    throw e;
  }
  try {
    const r = await fetch(`${config.apiBaseUrl}/payments/connection-check-${Date.now()}`, {
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "X-Payteller-Merchant-ID": config.merchantId,
        "X-Payteller-Username": config.username,
        "Cache-Control": "no-cache",
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await r.text().catch(() => "");
    const reachable = r.status === 404 || (r.status >= 200 && r.status < 300);
    return { reachable, http: r.status, ms: Date.now() - started, error: reachable ? null : "Credentials rejected or service unavailable" };
  } catch (e) {
    return {
      reachable: false, http: null, ms: Date.now() - started,
      error: (e as Error).name === "TimeoutError" ? "No answer in time" : "Could not connect",
    };
  }
}

/** The admin page: payment switch, Payteller merchant, credential presence, connection and recent deposits. */
export async function paymentSettingsOverview(db: Db, env: NodeJS.ProcessEnv = process.env, ping = pingPayteller) {
  const settings = await getPaymentSettings(db);
  let configured = true;
  let missing: string[] = [];
  let mode = "live";
  let apiBaseUrl: string | null = null;
  try {
    const config = loadPaytellerConfig(env);
    apiBaseUrl = config.apiBaseUrl;
    mode = "live";
  } catch (e) {
    if (!(e instanceof PaytellerConfigurationError)) throw e;
    configured = false;
    const required: [string, string | undefined][] = [
      ["PAYTELLER_MERCHANT_ID", env.PAYTELLER_MERCHANT_ID],
      ["PAYTELLER_USERNAME", env.PAYTELLER_USERNAME],
      ["PAYTELLER_API_KEY", env.PAYTELLER_API_KEY],
    ];
    missing = required.filter(([, value]) => !value?.trim()).map(([name]) => name);
  }
  const merchantId = env.PAYTELLER_MERCHANT_ID?.trim() || null;
  const isSet = (v: string | undefined) => !!v?.trim();
  const connection = configured ? await ping(env) : { reachable: false, http: null, ms: 0, error: "Not configured" };

  const day = (await db.query<{ confirmed: string; pending: string; failed: string; confirmed_amount: string }>(
    `SELECT count(*) FILTER (WHERE status = 'CONFIRMED') AS confirmed,
            count(*) FILTER (WHERE status = 'PENDING' AND transaction_id IS NOT NULL) AS pending,
            count(*) FILTER (WHERE status = 'FAILED') AS failed,
            coalesce(sum(amount) FILTER (WHERE status = 'CONFIRMED'), 0) AS confirmed_amount
       FROM payment_intents WHERE created_at > now() - interval '24 hours'`)).rows[0]!;
  const last = (await db.query<{ updated_at: Date }>(
    `SELECT updated_at FROM payment_intents WHERE status = 'CONFIRMED' AND gateway = 'payteller' ORDER BY updated_at DESC LIMIT 1`)).rows[0];
  const waiting = (await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM payment_intents WHERE status = 'PENDING' AND transaction_id IS NOT NULL`)).rows[0]!;

  return {
    ...settings,
    off_message: PAYMENTS_OFF_MESSAGE,
    payteller: {
      configured, missing, mode, api_base_url: apiBaseUrl,
      merchant_id: merchantId,
      merchant_id_looks_valid: /^TTM-\d{8}$/.test(merchantId ?? ""),
      secrets: {
        api_username: isSet(env.PAYTELLER_USERNAME),
        api_key: isSet(env.PAYTELLER_API_KEY),
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
