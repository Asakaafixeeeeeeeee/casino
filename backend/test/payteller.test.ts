import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { Request, Response } from "express";
import { paymentsRouter } from "../src/routes/payments.js";
import { acceptRules } from "../src/services/moneyRules.js";
import { setupWalletDb } from "./helpers/walletDb.js";
import {
  checkPaytellerPayment,
  createPaytellerPayment,
  loadPaytellerConfig,
  paytellerAmount,
  paytellerPaidPesewas,
  paytellerVerdict,
  PaytellerConfigurationError,
  PaytellerRequestError,
} from "../src/services/payteller.js";

const ENV = {
  PAYTELLER_MERCHANT_ID: "TTM-00390313",
  PAYTELLER_USERNAME: "merchant-user",
  PAYTELLER_API_KEY: "private-key",
};

async function mockApi(
  handler: (request: { method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }) =>
    { status: number; body: Record<string, unknown> },
) {
  const requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const request = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {},
      };
      requests.push(request);
      const result = handler(request);
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const config = loadPaytellerConfig({ ...ENV, PAYTELLER_API_BASE_URL: base } as NodeJS.ProcessEnv);
  return {
    config,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("Payteller config requires matching production credentials and validates its API URL", () => {
  assert.throws(() => loadPaytellerConfig({}), PaytellerConfigurationError);
  assert.throws(() => loadPaytellerConfig({
    ...ENV, PAYTELLER_MERCHANT_ID: "TTM-123",
  }), /TTM- followed by eight digits/);
  assert.throws(() => loadPaytellerConfig({
    ...ENV, PAYTELLER_API_BASE_URL: "http://example.com/api/v1",
  }), /must use HTTPS/);
  assert.equal(loadPaytellerConfig(ENV as NodeJS.ProcessEnv).apiBaseUrl, "https://paytelller.com/api/v1");
});

test("Payteller creates a GHS checkout with documented auth headers and decimal amount", async () => {
  const api = await mockApi((request) => ({
    status: 201,
    body: {
      id: "payment-id", reference: "DES111100000001", environment: "live", status: "pending",
      currency: "GHS", amount: "12.34", checkout_url: `http://${request.headers.host}/checkout/private`,
    },
  }));
  try {
    const result = await createPaytellerPayment(api.config, {
      amountMajor: 12.34,
      reference: "DES111100000001",
      customerEmail: "account-1@example.com",
      description: "Casino deposit DES111100000001",
    });
    assert.match(result.checkoutUrl, /^http:\/\/127\.0\.0\.1:\d+\/checkout\/private$/);
    assert.equal(api.requests[0]!.method, "POST");
    assert.equal(api.requests[0]!.url, "/api/v1/payments");
    assert.equal(api.requests[0]!.headers.authorization, "Bearer private-key");
    assert.equal(api.requests[0]!.headers["x-payteller-merchant-id"], "TTM-00390313");
    assert.equal(api.requests[0]!.headers["x-payteller-username"], "merchant-user");
    assert.deepEqual(api.requests[0]!.body, {
      amount: "12.34",
      currency: "GHS",
      reference: "DES111100000001",
      customer_email: "account-1@example.com",
      description: "Casino deposit DES111100000001",
    });
  } finally {
    await api.close();
  }
});

test("Payteller retrieves the exact payment reference and status with its authenticated API", async () => {
  const api = await mockApi(() => ({
    status: 200,
    body: {
      id: "payment-id", reference: "DES111100000001", environment: "live",
      status: "successful", currency: "GHS", amount: "12.34",
    },
  }));
  try {
    const payment = await checkPaytellerPayment(api.config, "DES111100000001");
    assert.equal(payment.status, "successful");
    assert.equal(api.requests[0]!.method, "GET");
    assert.equal(api.requests[0]!.url, "/api/v1/payments/DES111100000001");
    assert.equal(paytellerPaidPesewas(payment.amount), 1234);
  } finally {
    await api.close();
  }
});

test("Payteller doesn't treat uncertain gateway errors as declines", async () => {
  const api = await mockApi(() => ({ status: 502, body: { error: "provider uncertain" } }));
  try {
    await assert.rejects(
      createPaytellerPayment(api.config, {
        amountMajor: 10,
        reference: "DES111100000002",
        customerEmail: "account-1@example.com",
        description: "Casino deposit DES111100000002",
      }),
      (error: unknown) => error instanceof PaytellerRequestError && !error.declined,
    );
  } finally {
    await api.close();
  }
});

test("Payteller status mapping only settles explicit successful or failed responses", () => {
  assert.equal(paytellerVerdict("successful"), "approved");
  assert.equal(paytellerVerdict("failed"), "declined");
  assert.equal(paytellerVerdict("processing"), null);
  assert.equal(paytellerVerdict("pending"), null);
  assert.equal(paytellerAmount(0.01), "0.01");
  assert.equal(paytellerPaidPesewas("100.00"), 10000);
  assert.equal(paytellerPaidPesewas("invalid"), null);
});

test("Deposit checkout and status route create and settle through Payteller", async () => {
  const { db, userId, balance } = await setupWalletDb();
  const phone = "0241234567";
  await db.query(
    `UPDATE users SET phone = $2, deposit_phone = $2, deposit_phone_confirmed_at = now() WHERE id = $1`,
    [userId, phone],
  );
  await acceptRules(db, userId);

  const envNames = ["PAYTELLER_API_BASE_URL", "PAYTELLER_MERCHANT_ID", "PAYTELLER_USERNAME", "PAYTELLER_API_KEY"];
  const oldEnv = new Map(envNames.map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries({
    PAYTELLER_API_BASE_URL: "https://paytelller.test/api/v1",
    PAYTELLER_MERCHANT_ID: "TTM-00390313",
    PAYTELLER_USERNAME: "merchant-user",
    PAYTELLER_API_KEY: "private-key",
  })) process.env[name] = value;

  const originalFetch = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const request: { url: string; init?: RequestInit } = { url };
    if (init) request.init = init;
    requests.push(request);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "gateway-payment",
        reference: body.reference,
        environment: "live",
        status: "pending",
        currency: body.currency,
        amount: body.amount,
        checkout_url: "https://paytelller.test/checkout/private",
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    const reference = decodeURIComponent(url.split("/").pop() ?? "");
    return new Response(JSON.stringify({
      id: "gateway-payment",
      reference,
      environment: "live",
      status: "successful",
      currency: "GHS",
      amount: "135.00",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const router = paymentsRouter(db);
    const handlerOf = (method: string, path: string) => {
      const layer = (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }[] })
        .stack.find((item) => item.route?.path === path && item.route.methods[method]);
      assert.ok(layer?.route, `${method} ${path} exists`);
      return layer!.route!.stack.at(-1)!.handle as (req: Request, res: Response, next: (error?: unknown) => void) => Promise<void>;
    };
    const fakeResponse = () => {
      const out: { status: number; body: unknown; headers: Record<string, string> } = { status: 200, body: undefined, headers: {} };
      const res = {
        status(value: number) { out.status = value; return res; },
        json(value: unknown) { out.body = value; return res; },
        setHeader(name: string, value: string) { out.headers[name] = value; },
      };
      return { out, res: res as unknown as Response };
    };

    const checkout = fakeResponse();
    let checkoutError: unknown;
    await handlerOf("post", "/teller/checkout")({
      user: { id: userId, accountId: "account-1", phone, status: "ACTIVE" },
      body: { amount: 135, currency: "GHS", idempotency_key: "payteller-checkout-1" },
    } as unknown as Request, checkout.res, (error) => { checkoutError = error; });
    assert.equal(checkoutError, undefined);
    assert.equal(checkout.out.status, 201);
    const created = checkout.out.body as { transaction_id: string; checkout_url: string };
    assert.equal(created.checkout_url, "https://paytelller.test/checkout/private");
    assert.match(requests[0]!.url, /\/api\/v1\/payments$/);
    const pending = (await db.query<{ gateway: string; status: string }>(
      `SELECT gateway, status FROM payment_intents WHERE transaction_id = $1`, [created.transaction_id])).rows[0];
    assert.deepEqual(pending, { gateway: "payteller", status: "PENDING" });
    assert.equal(await balance(), 0);

    const status = fakeResponse();
    let statusError: unknown;
    await handlerOf("get", "/teller/status/:id")({
      user: { id: userId, accountId: "account-1", phone, status: "ACTIVE" },
      params: { id: created.transaction_id },
    } as unknown as Request, status.res, (error) => { statusError = error; });
    assert.equal(statusError, undefined);
    assert.equal((status.out.body as { status: string }).status, "approved");
    assert.equal(await balance(), 135);
    assert.match(requests[1]!.url, /\/api\/v1\/payments\/DES\d{12}$/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of envNames) {
      const old = oldEnv.get(name);
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    }
  }
});
