/* Deposit number lock: every check runs on the server before the gateway is contacted, and a
   payment that passes them still goes to the gateway, whose answer is recorded as it comes. */
import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import { acceptRules, clearMoneyRulesCache } from "../src/services/moneyRules.js";
import { paymentsRouter } from "../src/routes/payments.js";
import { settleIntent } from "../src/services/tellerSettlement.js";
import { localNumber } from "../src/services/depositGuard.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const PHONE = "0241234195";
type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } };
async function call(router: unknown, method: "get" | "post", path: string, userId: string, body: Record<string, unknown> = {}, phone = PHONE) {
  const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method])!;
  const stack = layer.route!.stack;
  const out: { status: number; body: Record<string, unknown> | undefined; failed: unknown } = { status: 200, body: undefined, failed: undefined };
  const res = { status(s: number) { out.status = s; return res; }, json(b: Record<string, unknown>) { out.body = b; return res; }, setHeader() {} };
  await (stack[stack.length - 1]!.handle as Function)({ user: { id: userId, accountId: "account-1", phone, status: "ACTIVE" }, body, query: {} },
    res as unknown as Response, (e: unknown) => { out.failed = e; });
  return out;
}
let n = 0;
const key = () => "deposit:lock-" + ++n + "-" + Date.now();
const TELLER = {
  TELLER_MERCHANT_ID: "TTM-00000001", TELLER_API_USERNAME: "user", TELLER_API_KEY: "key", TELLER_MODE: "test",
  PAYTELLER_MERCHANT_ID: "TTM-00000001", PAYTELLER_USERNAME: "user", PAYTELLER_API_KEY: "key",
};
async function withTeller<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  Object.assign(process.env, TELLER);
  try { return await fn(); } finally {
    for (const k of Object.keys(TELLER)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const momo = (router: unknown, userId: string, body: Record<string, unknown> = {}, phone = PHONE) =>
  call(router, "post", "/teller/momo", userId, { currency: "GHS", amount: 150, idempotency_key: key(), ...body }, phone);
const reasons = async (db: { query: Function }) => (await db.query(`SELECT reason_code FROM deposit_rejections ORDER BY id`)).rows.map((r: { reason_code: string }) => r.reason_code);

test("An unconfirmed number can't deposit; confirming locks the registered number once", async () => {
  clearMoneyRulesCache();
  const { db, userId } = await setupWalletDb();
  const router = paymentsRouter(db);
  await acceptRules(db, userId);

  const s0 = await call(router, "get", "/deposit-status", userId);
  assert.deepEqual([s0.body!.phone, s0.body!.confirmed, s0.body!.network, s0.body!.retry_after_seconds], [PHONE, false, "MTN", 0]);

  const blocked = await momo(router, userId);
  assert.equal(blocked.failed, undefined);
  assert.deepEqual([blocked.status, blocked.body!.error], [409, "phone_not_confirmed"]);
  const card = await call(router, "post", "/teller/checkout", userId, { currency: "GHS", amount: 150, idempotency_key: key() });
  assert.deepEqual([card.status, card.body!.error], [409, "phone_not_confirmed"]);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM payment_intents`)).rows[0].n, 0);

  /* the popup showed a number that isn't the registered one: nothing is saved */
  const stale = await call(router, "post", "/confirm-phone", userId, { phone: "0551234567" });
  assert.deepEqual([stale.status, stale.body!.error], [409, "phone_changed"]);
  assert.equal((await call(router, "get", "/deposit-status", userId)).body!.confirmed, false);

  const ok = await call(router, "post", "/confirm-phone", userId, { phone: "024 123 4195" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body!.confirmed, true);
  const row = (await db.query(`SELECT deposit_phone, deposit_phone_confirmed_at FROM users WHERE id = $1`, [userId])).rows[0];
  assert.equal(row.deposit_phone, PHONE);
  assert.ok(row.deposit_phone_confirmed_at);

  /* confirming again changes nothing */
  const first = String(row.deposit_phone_confirmed_at);
  await call(router, "post", "/confirm-phone", userId, { phone: PHONE });
  assert.equal(String((await db.query(`SELECT deposit_phone_confirmed_at FROM users WHERE id = $1`, [userId])).rows[0].deposit_phone_confirmed_at), first);
});

test("Only the registered number may pay; the network comes from it", async () => {
  clearMoneyRulesCache();
  const { db, userId } = await setupWalletDb();
  const router = paymentsRouter(db);
  await acceptRules(db, userId);
  await call(router, "post", "/confirm-phone", userId, {});
  await withTeller(async () => {
    const other = await momo(router, userId, { account_number: "233551234567", network: "MTN" });
    assert.deepEqual([other.status, other.body!.error], [403, "phone_not_registered"]);
    const junk = await momo(router, userId, { account_number: "12345" });
    assert.deepEqual([other.failed, junk.status, junk.body!.error], [undefined, 400, "invalid_account"]);

    /* a session whose number isn't a Ghanaian mobile number, or is on no supported network, never reaches the gateway */
    const intl = await momo(router, userId, {}, "+14155550100");
    assert.deepEqual([intl.status, intl.body!.error], [400, "invalid_account"]);
    await db.query(`UPDATE users SET deposit_phone = '0211234567' WHERE id = $1`, [userId]);
    const moved = await momo(router, userId);
    assert.deepEqual([moved.status, moved.body!.error], [403, "phone_mismatch"]);
  });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM payment_intents`)).rows[0].n, 0, "nothing was sent to the gateway");
  assert.deepEqual(await reasons(db), ["phone_not_registered", "invalid_account", "invalid_account", "phone_mismatch"]);
  assert.equal(localNumber("+233241234195"), PHONE);
  assert.equal(localNumber("0301234567"), null);
});

test("A successful deposit does not impose a wait before the next checkout", async () => {
  clearMoneyRulesCache();
  const { db, userId } = await setupWalletDb();
  const router = paymentsRouter(db);
  await acceptRules(db, userId);
  await call(router, "post", "/confirm-phone", userId, {});
  await db.query(`INSERT INTO payment_intents (user_id, amount, currency, idempotency_key, status, transaction_id, redirect_url)
                  VALUES ($1, 150, 'GHS', 'deposit:first', 'PENDING', '000000000201', 'http://localhost/wallet.html')`, [userId]);
  const settled = await settleIntent(db, "000000000201", "approved", 15000);
  assert.equal(settled!.status, "CONFIRMED");

  const st = await call(router, "get", "/deposit-status", userId); /* a refresh, or a new login, asks the server */
  assert.equal(st.body!.retry_after_seconds, 0);
  assert.equal(st.body!.available_at, null);

  const saved = { ...process.env };
  Object.assign(process.env, {
    PAYTELLER_MERCHANT_ID: "TTM-00000001", PAYTELLER_USERNAME: "user",
    PAYTELLER_API_KEY: "key", PAYTELLER_API_BASE_URL: "https://paytelller.test/api/v1",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      ...body, environment: "live", status: "pending",
      checkout_url: "https://paytelller.test/checkout/test",
    }), { status: 201 });
  };
  try {
    for (const send of [() => momo(router, userId), () => call(router, "post", "/teller/checkout", userId, { currency: "GHS", amount: 150, idempotency_key: key() })]) {
      const r = await send();
      assert.equal(r.failed, undefined);
      assert.equal(r.status, 201);
      const txId = String(r.body!.transaction_id);
      await settleIntent(db, txId, "approved", 15000);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of ["PAYTELLER_MERCHANT_ID", "PAYTELLER_USERNAME", "PAYTELLER_API_KEY", "PAYTELLER_API_BASE_URL"]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM payment_intents`)).rows[0].n, 3);
});

test("Only one payment may wait for approval at a time, and failed or declined payments start no wait", async () => {
  clearMoneyRulesCache();
  const { db, userId } = await setupWalletDb();
  const router = paymentsRouter(db);
  await acceptRules(db, userId);
  await call(router, "post", "/confirm-phone", userId, {});
  await db.query(`INSERT INTO payment_intents (user_id, amount, currency, idempotency_key, status, transaction_id, redirect_url)
                  VALUES ($1, 150, 'GHS', 'deposit:p1', 'PENDING', '000000000301', 'http://localhost/wallet.html'),
                         ($1, 150, 'GHS', 'deposit:p2', 'FAILED', '000000000302', 'http://localhost/wallet.html')`, [userId]);
  await withTeller(async () => {
    const r = await momo(router, userId);
    assert.deepEqual([r.status, r.body!.error], [429, "too_many_pending"]);
  });
  await settleIntent(db, "000000000301", "declined", null, "Declined by customer");
});
