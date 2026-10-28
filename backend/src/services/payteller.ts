import { assertSafePaymentNetwork } from "./paymentNetworkSafety.js";

export interface PaytellerConfig {
  apiBaseUrl: string;
  merchantId: string;
  username: string;
  apiKey: string;
}

export interface PaytellerPayment {
  id?: string;
  reference?: string;
  status?: string;
  amount?: string | number;
  checkout_url?: string;
  error?: string;
}

export class PaytellerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaytellerConfigurationError";
  }
}

export class PaytellerRequestError extends Error {
  constructor(message: string, readonly declined: boolean) {
    super(message);
    this.name = "PaytellerRequestError";
  }
}

export function loadPaytellerConfig(env: NodeJS.ProcessEnv = process.env): PaytellerConfig {
  const apiBaseUrl = (env.PAYTELLER_API_BASE_URL ?? "https://paytelller.com/api/v1").trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    throw new PaytellerConfigurationError("PAYTELLER_API_BASE_URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new PaytellerConfigurationError("PAYTELLER_API_BASE_URL must use HTTPS");
  }
  if (!url.pathname.replace(/\/+$/, "").endsWith("/api/v1")) {
    throw new PaytellerConfigurationError("PAYTELLER_API_BASE_URL must end in /api/v1");
  }

  const merchantId = env.PAYTELLER_MERCHANT_ID?.trim();
  const username = env.PAYTELLER_USERNAME?.trim();
  const apiKey = env.PAYTELLER_API_KEY?.trim();
  const missing = [
    ["PAYTELLER_MERCHANT_ID", merchantId],
    ["PAYTELLER_USERNAME", username],
    ["PAYTELLER_API_KEY", apiKey],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new PaytellerConfigurationError(`Payteller payment is disabled; missing environment variables: ${missing.join(", ")}`);
  }
  if (!/^TTM-\d{8}$/.test(merchantId!)) {
    throw new PaytellerConfigurationError("PAYTELLER_MERCHANT_ID must be TTM- followed by eight digits");
  }
  if (env === process.env) {
    try { assertSafePaymentNetwork(apiBaseUrl); }
    catch (error) { throw new PaytellerConfigurationError((error as Error).message); }
  }

  return {
    apiBaseUrl,
    merchantId: merchantId!,
    username: username!,
    apiKey: apiKey!,
  };
}

function authHeaders(config: PaytellerConfig) {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    "X-Payteller-Merchant-ID": config.merchantId,
    "X-Payteller-Username": config.username,
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
  };
}

async function paytellerFetch(
  config: PaytellerConfig,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  assertSafePaymentNetwork(config.apiBaseUrl);
  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      ...init,
      headers: { ...authHeaders(config), ...init.headers },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new PaytellerRequestError((error as Error).name === "TimeoutError"
      ? "Payteller did not answer in time; the payment may still have been created"
      : "Could not connect to Payteller; the payment outcome is uncertain", false);
  }

  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid response");
      body = parsed as Record<string, unknown>;
    } catch {
      throw new PaytellerRequestError(`Payteller returned an invalid response (${response.status})`, false);
    }
  }
  return { status: response.status, body };
}

function responseError(body: Record<string, unknown>, status: number): string {
  return typeof body.error === "string" && body.error.trim()
    ? body.error.slice(0, 300)
    : `Payteller request failed (${status})`;
}

export function paytellerAmount(amountMajor: number): string {
  if (!Number.isFinite(amountMajor) || amountMajor <= 0) throw new Error("Payment amount must be positive");
  const minor = Math.round(amountMajor * 100);
  if (!Number.isSafeInteger(minor) || Math.abs(amountMajor - minor / 100) > Number.EPSILON * Math.max(1, Math.abs(amountMajor)) * 4) {
    throw new Error("Payment amount must have at most two decimal places");
  }
  return (minor / 100).toFixed(2);
}

export async function createPaytellerPayment(
  config: PaytellerConfig,
  args: { amountMajor: number; reference: string; customerEmail: string; description: string; returnUrl?: string },
): Promise<{ checkoutUrl: string; payment: PaytellerPayment }> {
  if (!/^[A-Za-z0-9_-]{3,100}$/.test(args.reference)) {
    throw new PaytellerRequestError("Payteller reference must contain 3-100 letters, digits, underscores or hyphens", true);
  }
  const { status, body } = await paytellerFetch(config, "/payments", {
    method: "POST",
    body: JSON.stringify({
      amount: paytellerAmount(args.amountMajor),
      currency: "GHS",
      reference: args.reference,
      customer_email: args.customerEmail,
      description: args.description,
      ...(args.returnUrl ? { return_url: args.returnUrl } : {}),
    }),
  });
  if (status < 200 || status >= 300) {
    throw new PaytellerRequestError(responseError(body, status),
      status >= 400 && status < 500 && ![408, 409, 429].includes(status));
  }
  if (typeof body.checkout_url !== "string" || !["pending", "processing"].includes(String(body.status))
    || body.reference !== args.reference || body.currency !== "GHS" || body.environment !== "live"
    || paytellerPaidPesewas(body.amount) !== Math.round(args.amountMajor * 100)) {
    throw new PaytellerRequestError("Payteller did not return a valid checkout session", false);
  }
  let checkout: URL;
  try {
    checkout = new URL(body.checkout_url);
  } catch {
    throw new PaytellerRequestError("Payteller returned an invalid checkout URL", false);
  }
  const localCheckout = ["localhost", "127.0.0.1", "::1"].includes(checkout.hostname);
  if (checkout.origin !== new URL(config.apiBaseUrl).origin || (checkout.protocol !== "https:" && !localCheckout)) {
    throw new PaytellerRequestError("Payteller returned an unexpected checkout origin", false);
  }
  return { checkoutUrl: checkout.href, payment: body as PaytellerPayment };
}

export async function checkPaytellerPayment(config: PaytellerConfig, reference: string): Promise<PaytellerPayment> {
  const { status, body } = await paytellerFetch(config, `/payments/${encodeURIComponent(reference)}`);
  if (status < 200 || status >= 300) {
    throw new PaytellerRequestError(responseError(body, status), false);
  }
  if (body.reference !== reference || body.currency !== "GHS" || body.environment !== "live") {
    throw new PaytellerRequestError("Payteller returned payment details that do not match this live deposit", false);
  }
  return body as PaytellerPayment;
}

export function paytellerVerdict(status: unknown): "approved" | "declined" | null {
  const value = String(status ?? "").toLowerCase();
  if (value === "successful") return "approved";
  if (value === "failed") return "declined";
  return null;
}

export function paytellerPaidPesewas(amount: unknown): number | null {
  if (amount === undefined || amount === null || amount === "") return null;
  const raw = String(amount).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const major = Number(raw);
  return Number.isFinite(major) ? Math.round(major * 100) : null;
}
