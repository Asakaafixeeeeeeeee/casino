import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import { paymentsRouter } from "../src/routes/payments.js";
import { acceptRules } from "../src/services/moneyRules.js";
import { settleIntent } from "../src/services/tellerSettlement.js";
import { assertSafePaymentNetwork } from "../src/services/paymentNetworkSafety.js";
import { createPaytellerPayment, loadPaytellerConfig } from "../src/services/payteller.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const phone = "0241234567";
async function ready() {
  const env = await setupWalletDb();
  await env.db.query(`UPDATE users SET phone = $2, deposit_phone = $2, deposit_phone_confirmed_at = now() WHERE id = $1`, [env.userId, phone]);
  await acceptRules(env.db, env.userId);
  return env;
}

async function call(db: Pool, userId: string, key: string, options: { path?: string; amount?: number; txId?: string } = {}) {
  const router = paymentsRouter(db);
  const path = options.path ?? "/teller/checkout";
  const method = options.txId ? "get" : "post";
  const layers = (router as unknown as {
    stack: { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: Request, res: Response, next: NextFunction) => Promise<void> }[] } }[];
  }).stack;
  const handler = layers.find((layer) => layer.route?.path === path && layer.route.methods[method])!.route!.stack.at(-1)!.handle;
  const out = { status: 200, body: {} as Record<string, unknown>, headers: {} as Record<string, string> };
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: Record<string, unknown>) { out.body = body; return res; },
    setHeader(name: string, value: string) { out.headers[name] = value; return res; },
  } as unknown as Response;
  await handler({
    user: { id: userId, accountId: "account-1", phone, status: "ACTIVE" },
    body: { amount: options.amount ?? 150, currency: "GHS", idempotency_key: key, network: "MTN", account_number: "233241234567" },
    params: { id: options.txId }, ip: "127.0.0.1",
    headers: { "user-agent": "offline-regression", origin: "https://site.test" },
  } as unknown as Request, res, (error) => { if (error) throw error; });
  return out;
}

async function mocked(run: (requests: { method: string; body: Record<string, unknown> }[], mode: { status: number }) => Promise<void>) {
  const values = {
    PAYTELLER_API_BASE_URL: "https://gateway.test/api/v1", PAYTELLER_MERCHANT_ID: "TTM-00000001",
    PAYTELLER_USERNAME: "offline-user", PAYTELLER_API_KEY: "offline-key",
  };
  const saved = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  const originalFetch = globalThis.fetch;
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  const mode = { status: 201 };
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ method: init?.method ?? "GET", body });
    const reference = body.reference ?? String(input).split("/").at(-1);
    return new Response(JSON.stringify(mode.status >= 400 ? { error: "Mocked creation failure" } : {
      reference, status: init?.method === "POST" ? "pending" : "successful",
      currency: "GHS", environment: "live", amount: "150.00", checkout_url: "https://gateway.test/checkout/private",
    }), { status: mode.status });
  };
  try { await run(requests, mode); }
  finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

test("Incident hold blocks both initiation paths for account 1937, but permits status reconciliation and other customers", async () => {
  const { db, userId, balance } = await ready();
  await mocked(async (requests) => {
    await db.query(`UPDATE user_accounts SET account_user_id = '1937' WHERE user_id = $1`, [userId]);
    for (const path of ["/teller/checkout", "/teller/momo"]) {
      const blocked = await call(db, userId, "held:" + path, { path });
      assert.deepEqual([blocked.status, blocked.body.error], [403, "deposit_investigation_hold"]);
    }
    assert.equal(requests.length, 0);
    await db.query(`UPDATE user_accounts SET account_user_id = 'account-1' WHERE user_id = $1`, [userId]);
    const allowed = await call(db, userId, "normal");
    assert.equal(allowed.status, 201);
    await db.query(`UPDATE user_accounts SET account_user_id = '1937' WHERE user_id = $1`, [userId]);
    for (let i = 0; i < 2; i++) {
      const status = await call(db, userId, "", { path: "/teller/status/:id", txId: String(allowed.body.transaction_id) });
      assert.equal(status.body.status, "approved");
    }
    assert.equal(await balance(), 150, "existing payment credited exactly once while held");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM payment_intents`)).rows[0].n, 1);
  });
});

test("Saved checkout replay never dispatches again; keys bind amount and dispatch records contain request context", async () => {
  const { db, userId } = await ready();
  await mocked(async (requests) => {
    assert.equal((await call(db, userId, "same-key")).status, 201);
    assert.equal((await call(db, userId, "same-key")).status, 200);
    assert.equal((await call(db, userId, "same-key", { amount: 151 })).status, 409);
    assert.equal(requests.length, 1);
    const row = (await db.query(`SELECT dispatch_started_at, initiation_context FROM payment_intents WHERE idempotency_key = 'same-key'`)).rows[0];
    assert.ok(row.dispatch_started_at);
    assert.equal(row.initiation_context.user_agent, "offline-regression");
    assert.equal(row.initiation_context.ip, "127.0.0.1");
    assert.equal(row.initiation_context.account_id, "account-1");
  });
});

test("Uncertain creation is sent once across router restart; fresh and old keys cannot bypass verified failure restriction", async () => {
  const { db, userId } = await ready();
  await mocked(async (requests, mode) => {
    mode.status = 502;
    assert.equal((await call(db, userId, "uncertain")).body.error, "payment_pending");
    assert.equal((await call(db, userId, "uncertain")).status, 409);
    assert.equal(requests.length, 1);
    await db.query(`INSERT INTO payment_intents (user_id, amount, currency, idempotency_key, status, redirect_url, gateway)
      VALUES ($1, 150, 'GHS', 'old-unsent', 'PENDING', 'https://site.test', 'payteller')`, [userId]);
    const tx = (await db.query(`SELECT transaction_id FROM payment_intents WHERE idempotency_key = 'uncertain'`)).rows[0].transaction_id;
    await settleIntent(db, tx, "declined", null, "Authenticated final provider failure");
    for (const key of ["new", "old-unsent"]) {
      const blocked = await call(db, userId, key);
      assert.deepEqual([blocked.status, blocked.body.error], [429, "deposit_restricted"]);
    }
    assert.equal(requests.length, 1);
  });
});

test("Creation errors receive a five-minute cooldown, minute dispatch limit persists, and no false 30-hour restriction is created", async () => {
  const { db, userId } = await ready();
  await mocked(async (requests, mode) => {
    mode.status = 400;
    const first = await call(db, userId, "failure-1");
    assert.equal(first.status, 502);
    await db.query(`UPDATE payment_intents SET dispatch_started_at = now() - interval '2 minutes' WHERE idempotency_key = 'failure-1'`);
    const cooldown = await call(db, userId, "failure-2");
    assert.deepEqual([cooldown.status, cooldown.body.error], [429, "deposit_rate_limited"]);
    assert.equal(cooldown.headers["Retry-After"], "300");
    assert.equal(requests.length, 1);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM deposit_restrictions`)).rows[0].n, 0);
    await db.query(`UPDATE payment_intents SET dispatch_started_at = now() - interval '6 minutes' WHERE idempotency_key = 'failure-1'`);
    mode.status = 201;
    const second = await call(db, userId, "failure-2");
    assert.equal(second.status, 201, "unsent rate-limited key remains usable after cooldown");
    await settleIntent(db, String(second.body.transaction_id), "approved", 15000);
    const minute = await call(db, userId, "minute-limit");
    assert.deepEqual([minute.status, minute.body.error], [429, "deposit_rate_limited"]);
    assert.equal(minute.headers["Retry-After"], "60");
    assert.equal(requests.length, 2);
  });
});

test("Hourly and daily dispatch caps count successful and failed requests alike", async () => {
  const { db, userId } = await ready();
  await mocked(async (requests) => {
    await db.query(`INSERT INTO payment_intents (user_id, amount, currency, idempotency_key, status, redirect_url, gateway, dispatch_started_at)
      SELECT $1, 150, 'GHS', 'seed-' || n, 'CONFIRMED', 'https://site.test', 'payteller', now() - interval '2 minutes'
      FROM generate_series(1, 5) n`, [userId]);
    const hour = await call(db, userId, "hour");
    assert.deepEqual([hour.status, hour.body.error, hour.headers["Retry-After"]], [429, "deposit_rate_limited", "3600"]);
    await db.query(`UPDATE payment_intents SET dispatch_started_at = now() - interval '2 hours' WHERE dispatch_started_at IS NOT NULL`);
    await db.query(`INSERT INTO payment_intents (user_id, amount, currency, idempotency_key, status, redirect_url, gateway, dispatch_started_at)
      SELECT $1, 150, 'GHS', 'seed-' || n, 'FAILED', 'https://site.test', 'payteller', now() - interval '2 hours'
      FROM generate_series(6, 15) n`, [userId]);
    const day = await call(db, userId, "day");
    assert.deepEqual([day.status, day.body.error, day.headers["Retry-After"]], [429, "deposit_rate_limited", "86400"]);
    assert.equal(requests.length, 0);
  });
});

test("Automated tests reject real gateway destinations even with NODE_ENV=production and valid inherited credentials", async () => {
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const originalFetch = globalThis.fetch;
  let contacted = false;
  globalThis.fetch = async () => { contacted = true; throw new Error("Must not fetch"); };
  try {
    assert.doesNotThrow(() => assertSafePaymentNetwork("http://127.0.0.1:8796/api/v1"));
    await assert.rejects(createPaytellerPayment(loadPaytellerConfig({
      PAYTELLER_MERCHANT_ID: "TTM-00000001", PAYTELLER_USERNAME: "inherited", PAYTELLER_API_KEY: "inherited",
    }), { amountMajor: 500, reference: "DES111100000001", customerEmail: "offline@example.test", description: "Must never dispatch" }),
    /External payment traffic is disabled/);
    assert.equal(contacted, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old;
  }
});
