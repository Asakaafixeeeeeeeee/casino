import crypto from "node:crypto";
import type { PoolClient } from "pg";

export interface TellerConfig {
  apiBaseUrl: string;
  checkoutBaseUrl: string;
  merchantId: string;
  apiUsername: string;
  apiKey: string;
  /** The float account's passcode; payouts are refused without it. */
  payoutPasscode: string | null;
}

export interface TellerCheckoutResponse {
  status?: string;
  code?: string | number;
  reason?: unknown;
  token?: string;
  checkout_url?: string;
}

export interface TellerStatusResponse {
  code?: string | number;
  status?: string;
  reason?: unknown;
  description?: string;
  transaction_id?: string;
  amount?: string | number;
}

export type Verdict = "approved" | "declined" | null;

export class TellerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TellerConfigurationError";
  }
}

/** A TheTeller call that failed. `declined` is true only for a clear "no"; anything else may still have moved money. */
export class TellerRequestError extends Error {
  constructor(message: string, readonly declined: boolean) {
    super(message);
    this.name = "TellerRequestError";
  }
}

// Hosted checkout runs on its own host, not under the API host.
export function checkoutBaseFor(apiBaseUrl: string): string {
  return /\/\/test\./.test(apiBaseUrl) ? "https://checkout-test.theteller.net" : "https://checkout.theteller.net";
}

// Credentials pasted from chat often keep markup: *bold*, `code`, quotes. None of these can be part of a real value.
export function cleanCredential(raw: string | undefined): string | undefined {
  return raw?.trim().replace(/^[*`"'\s]+|[*`"'\s]+$/g, "");
}

/** Safe-to-publish hints about the configured credentials; never the values themselves. */
export function credentialHints(env: NodeJS.ProcessEnv) {
  const raw = env.TELLER_MERCHANT_ID ?? "";
  const merchantId = cleanCredential(raw) ?? "";
  return {
    merchantIdLooksValid: /^TTM-\d{8}$/.test(merchantId),
    credentialsHadStrayChars: ["TELLER_MERCHANT_ID", "TELLER_API_USERNAME", "TELLER_API_KEY"]
      .some((name) => (env[name] ?? "").trim() !== (cleanCredential(env[name]) ?? "")),
  };
}

export function loadTellerConfig(env: NodeJS.ProcessEnv): TellerConfig {
  const mode = env.TELLER_MODE?.trim().toLowerCase();
  const apiBaseUrl = (
    mode === "test" ? "https://test.theteller.net"
    : mode ? "https://prod.theteller.net"
    : env.TELLER_BASE_URL ?? "https://test.theteller.net"
  ).replace(/\/+$/, "");
  const checkoutBaseUrl = (env.TELLER_CHECKOUT_URL ?? checkoutBaseFor(apiBaseUrl)).replace(/\/+$/, "");
  const merchantId = cleanCredential(env.TELLER_MERCHANT_ID);
  const apiUsername = cleanCredential(env.TELLER_API_USER ?? env.TELLER_API_USERNAME);
  const apiKey = cleanCredential(env.TELLER_API_KEY);

  const missing = [
    ["TELLER_MERCHANT_ID", merchantId],
    ["TELLER_API_USERNAME", apiUsername],
    ["TELLER_API_KEY", apiKey],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) {
    throw new TellerConfigurationError(
      `Teller payment is disabled; missing environment variables: ${missing.join(", ")}`
    );
  }

  return {
    apiBaseUrl,
    checkoutBaseUrl,
    merchantId: merchantId!,
    apiUsername: apiUsername!,
    apiKey: apiKey!, // used exactly as TheTeller issued it, as in the integration guide
    payoutPasscode: cleanCredential(env.TELLER_PASSCODE) || null,
  };
}

/** Cedis -> TheTeller's 12-digit pesewa string (GH₵25.50 -> "000000002550"). */
export function tellerAmountMajor(amountMajor: number): string {
  if (!Number.isFinite(amountMajor) || amountMajor <= 0) {
    throw new Error("Deposit amount must be positive");
  }
  const minor = Math.round(amountMajor * 100);
  if (!Number.isSafeInteger(minor) || minor <= 0) {
    throw new Error("Deposit amount is outside Teller's supported range");
  }
  return String(minor).padStart(12, "0");
}

/** TheTeller transaction ids are 12 digits and unique per transaction. */
export function newTxId(): string {
  return String(crypto.randomInt(0, 1e12)).padStart(12, "0");
}

/** "approved", "declined", or null while TheTeller has not decided. */
export function verdict(data: { code?: unknown; status?: unknown } | null | undefined): Verdict {
  const s = String(data?.status ?? "").toLowerCase();
  if (String(data?.code ?? "") === "000" || s === "approved" || s === "successful") return "approved";
  if (s === "declined" || s === "failed") return "declined";
  return null;
}

/** The amount TheTeller says was paid, in pesewas, or null if it didn't say. Accepts a 12-digit pesewa string or cedis. */
export function paidPesewas(amount: unknown): number | null {
  if (amount === undefined || amount === null || amount === "") return null;
  const raw = String(amount).trim();
  if (/^\d{12}$/.test(raw)) return Number(raw);
  const cedis = Number(raw);
  return Number.isFinite(cedis) ? Math.round(cedis * 100) : null;
}

// TheTeller's reason is a sentence, or an object listing what is wrong with each field.
export function reasonText(r: unknown): string {
  if (r && typeof r === "object") return Object.values(r as Record<string, unknown>).flat().join("; ");
  return String(r ?? "");
}

// Authorization: Basic base64(API_USER:API_KEY), exactly as the integration guide builds it.
const basicAuth = (config: TellerConfig) =>
  "Basic " + Buffer.from(`${config.apiUsername}:${config.apiKey}`).toString("base64");

async function tellerFetch(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  console.log("[teller] %s %s -> %s %s", init.method ?? "GET", new URL(url).pathname, response.status, text.slice(0, 300));
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new TellerRequestError(`Teller returned an invalid response (${response.status})`, false);
    }
  }
  return { status: response.status, body };
}

const jsonHeaders = (config: TellerConfig) => ({
  "Content-Type": "application/json",
  Authorization: basicAuth(config),
  "Cache-Control": "no-cache",
});

/** 1. Hosted checkout -> TheTeller's payment page URL. */
export async function initiateTellerCheckout(
  config: TellerConfig,
  args: { transactionId: string; amountMajor: number; redirectUrl: string; email: string; desc: string }
): Promise<{ checkoutUrl: string }> {
  const payload = JSON.stringify({
    merchant_id: config.merchantId,
    transaction_id: args.transactionId,
    desc: args.desc,
    amount: tellerAmountMajor(args.amountMajor),
    redirect_url: args.redirectUrl,
    email: args.email,
  });
  const { status, body } = await tellerFetch(
    `${config.checkoutBaseUrl}/initiate`, { method: "POST", headers: jsonHeaders(config), body: payload }, 15000);
  if (status >= 400 || body.status !== "success" || typeof body.checkout_url !== "string") {
    throw new TellerRequestError(reasonText(body.reason) || `TheTeller checkout failed (${status})`, true);
  }
  return { checkoutUrl: body.checkout_url };
}

export type MomoNetwork = "MTN" | "VDF" | "ATL" | "TGO";

/** 2. Direct mobile money prompt. Resolves only after the customer answers, which can take minutes. */
export async function requestMomoPayment(
  config: TellerConfig,
  args: { transactionId: string; amountMajor: number; subscriberNumber: string; network: MomoNetwork; desc: string }
): Promise<TellerStatusResponse> {
  let result: { status: number; body: Record<string, unknown> };
  try {
    const payload = JSON.stringify({
      amount: tellerAmountMajor(args.amountMajor),
      processing_code: "000200",
      transaction_id: args.transactionId,
      desc: args.desc,
      merchant_id: config.merchantId,
      subscriber_number: args.subscriberNumber,
      "r-switch": args.network,
    });
    result = await tellerFetch(
      `${config.apiBaseUrl}/v1.1/transaction/process`, { method: "POST", headers: jsonHeaders(config), body: payload }, 180000);
  } catch (err) {
    if (err instanceof TellerRequestError) throw err;
    throw new TellerRequestError((err as Error).message || "TheTeller did not answer", false); // timeout: may still be paid
  }
  const v = verdict(result.body);
  if (v === "approved") return result.body as TellerStatusResponse;
  const message = reasonText(result.body.reason ?? result.body.description) || `TheTeller payment failed (${result.status})`;
  throw new TellerRequestError(message, v === "declined" || (result.status >= 400 && result.status < 500));
}

/** 4. Status of a transaction we started. Uses the Merchant-Id header, not Basic auth. */
export async function checkTellerStatus(config: TellerConfig, transactionId: string): Promise<TellerStatusResponse> {
  const { status, body } = await tellerFetch(
    `${config.apiBaseUrl}/v1.1/users/transactions/${encodeURIComponent(transactionId)}/status`,
    { headers: { "Content-Type": "application/json", "Cache-Control": "no-cache", "Merchant-Id": config.merchantId } },
    15000
  );
  /* any non-2xx answer is "no answer" (TheTeller guide: a failed check is never a decline); before, a 4xx body
     reading {"status":"failed"} declined a deposit or refunded a payout that may have been paid */
  if (status < 200 || status >= 300) throw new TellerRequestError(`TheTeller status failed (${status})`, false);
  return body as TellerStatusResponse;
}

/** A deposit's reference: "DES" + its 12-digit TheTeller transaction id (TheTeller only takes digits there). The same
 *  reference is sent as the payment's description, so TheTeller's page, the prompt and its dashboard show it too. */
export const depositReference = (transactionId: string) => "DES" + transactionId;

/** TheTeller's network code for a Ghanaian mobile number (0XXXXXXXXX), or null if it isn't a mobile money network. */
export function networkForPhone(phone: string): MomoNetwork | null {
  const prefix = phone.slice(0, 3);
  if (["024", "025", "053", "054", "055", "059"].includes(prefix)) return "MTN";
  if (["020", "050"].includes(prefix)) return "VDF";
  if (["026", "027", "056", "057"].includes(prefix)) return "ATL";
  return null;
}

/** 3. Payout from the float account to a mobile money wallet (guide: processing code 404000, r-switch FLT). */
export async function initiatePayout(
  config: TellerConfig,
  args: { transactionId: string; amountMajor: number; phone: string; network: MomoNetwork; desc: string }
): Promise<TellerStatusResponse> {
  if (!config.payoutPasscode) throw new TellerConfigurationError("Payouts are disabled; set TELLER_PASSCODE");
  const payload = JSON.stringify({
    account_number: "+233" + args.phone.replace(/^0/, ""),
    merchant_id: config.merchantId,
    transaction_id: args.transactionId,
    processing_code: "404000",
    amount: tellerAmountMajor(args.amountMajor),
    "r-switch": "FLT",
    desc: args.desc,
    account_issuer: args.network,
    pass_code: config.payoutPasscode,
  });
  let result: { status: number; body: Record<string, unknown> };
  try {
    result = await tellerFetch(`${config.apiBaseUrl}/v1.1/transaction/process`,
      { method: "POST", headers: jsonHeaders(config), body: payload }, 15000);
  } catch (err) {
    if (err instanceof TellerRequestError) throw err;
    throw new TellerRequestError((err as Error).message || "TheTeller did not answer", false); // may have paid
  }
  const v = verdict(result.body);
  if (v === "approved") return result.body as TellerStatusResponse;
  const message = reasonText(result.body.reason ?? result.body.description) || `TheTeller payout failed (${result.status})`;
  // a 4xx, an explicit decline, or TheTeller refusing the request itself ("Access Denied") means nothing was paid
  const refused = v === "declined" || (result.status >= 400 && result.status < 500) || /access denied/i.test(message);
  throw new TellerRequestError(message, refused);
}

/** Returns the existing intent for this idempotency key, or creates a new PENDING one. */
export async function createPaymentIntent(
  client: PoolClient,
  userId: string,
  amountMajor: number,
  currency: string,
  idempotencyKey: string,
  redirectUrl: string
): Promise<{ id: string; transactionId: string | null; checkoutUrl: string | null; status: string }> {
  const existing = await client.query<{ id: string; user_id: string; transaction_id: string | null; checkout_url: string | null; status: string }>(
    `SELECT id, user_id, transaction_id, checkout_url, status FROM payment_intents WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  if (existing.rowCount) {
    const current = existing.rows[0]!;
    /* another player's key: never hand back their checkout page or transaction */
    if (current.user_id !== userId) throw new TellerRequestError("That payment key was already used", true);
    return { id: current.id, transactionId: current.transaction_id, checkoutUrl: current.checkout_url, status: current.status };
  }
  const result = await client.query<{ id: string }>(
    `INSERT INTO payment_intents (user_id, amount, currency, idempotency_key, redirect_url, status)
     VALUES ($1, $2, $3, $4, $5, 'PENDING') RETURNING id`,
    [userId, amountMajor, currency, idempotencyKey, redirectUrl]
  );
  return { id: result.rows[0]!.id, transactionId: null, checkoutUrl: null, status: "PENDING" };
}
