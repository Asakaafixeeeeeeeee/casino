/* Deposit requests our own checks refuse never reach TheTeller: each is answered with the reason and recorded in
   deposit_rejections (who, how much, when, why), no payment is started and no money moves. A valid request goes on to
   TheTeller; a duplicate of one already sent is refused without a second call. Admin -> Deposits lists them. */
import assert from "node:assert/strict";
import test from "node:test";
import type { Response } from "express";
import { clearMoneyRulesCache } from "../src/services/moneyRules.js";
import { setPaymentsEnabled } from "../src/services/paymentSettings.js";
import { recentDeposits } from "../src/services/risk.js";
import { paymentsRouter } from "../src/routes/payments.js";
import { PaytellerConfigurationError } from "../src/services/payteller.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const PHONE = "0241234195";
type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } };
async function call(router: unknown, path: string, userId: string, body: Record<string, unknown>) {
  const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods.post)!;
  const stack = layer.route!.stack;
  const out: { status: number; body: Record<string, unknown> | undefined; failed: unknown } = { status: 200, body: undefined, failed: undefined };
  const res = { status(s: number) { out.status = s; return res; }, json(b: Record<string, unknown>) { out.body = b; return res; }, setHeader() {} };
  await (stack[stack.length - 1]!.handle as Function)({ user: { id: userId, accountId: "account-1", phone: PHONE, status: "ACTIVE" }, body, query: {} },
    res as unknown as Response, (e: unknown) => { out.failed = e; });
  return out;
}
let n = 0;
const key = () => "deposit:rej-" + ++n + "-" + Date.now();

test("Invalid deposit requests are refused and recorded, and never reach TheTeller", async () => {
  clearMoneyRulesCache();
  const { db, userId } = await setupWalletDb();
  await db.query("UPDATE users SET phone = $1, full_name = 'Ama Mensah' WHERE id = $2", [PHONE, userId]);
  await db.query("UPDATE money_rules SET min_deposit = 135 WHERE id = 1");
  clearMoneyRulesCache();
  const router = paymentsRouter(db);
  const momo = (body: Record<string, unknown>) => call(router, "/teller/momo", userId, { currency: "GHS", network: "MTN", account_number: "233241234195", ...body });
  const card = (body: Record<string, unknown>) => call(router, "/teller/checkout", userId, { currency: "GHS", ...body });

  const cases: [() => ReturnType<typeof call>, number, string][] = [
    [() => momo({ amount: 100, idempotency_key: key() }), 400, "invalid_amount"],               /* under the GHS 135 minimum */
    [() => momo({ amount: "abc", idempotency_key: key() }), 400, "invalid_amount"],
    [() => momo({ amount: 60000, idempotency_key: key() }), 400, "invalid_amount"],              /* over the maximum */
    [() => momo({ amount: 150, idempotency_key: key(), currency: "USD" }), 400, "unsupported_currency"],
    [() => momo({ amount: 150 }), 400, "invalid_idempotency_key"],
    [() => momo({ amount: 150, idempotency_key: key(), account_number: "12345" }), 400, "invalid_account"],
    [() => momo({ amount: 150, idempotency_key: key(), network: "XYZ" }), 400, "invalid_network"],
    [() => momo({ amount: 150, idempotency_key: key() }), 409, "phone_not_confirmed"],
    [() => card({ amount: 10, idempotency_key: key() }), 400, "invalid_amount"],
    [() => card({ amount: 150, idempotency_key: key() }), 409, "phone_not_confirmed"],
    [() => momo({ amount: 150.005, idempotency_key: key() }), 400, "invalid_amount"],
    [() => momo({ amount: true, idempotency_key: key() }), 400, "invalid_amount"],
    [() => momo({ amount: [150], idempotency_key: key() }), 400, "invalid_amount"],
    [() => momo({ amount: 150, idempotency_key: key(), account_number: "abc233241234195" }), 400, "invalid_account"],
    [() => momo({ amount: 150, idempotency_key: key(), account_number: "233291234567" }), 400, "invalid_account"],
    [() => momo({ amount: 150, idempotency_key: "x".repeat(121) }), 400, "invalid_idempotency_key"],
  ];
  for (const [send, status, code] of cases) {
    const r = await send();
    assert.equal(r.failed, undefined, code + ": answered here, never sent on");
    assert.equal(r.status, status, code);
    assert.equal(r.body!.error, code);
  }
  /* nothing was started and nothing moved */
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM payment_intents`)).rows[0].n, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1`, [userId])).rows[0].n, 0);

  /* each one is on record: who, how much, when, why */
  const rows = (await db.query(`SELECT * FROM deposit_rejections ORDER BY id`)).rows;
  assert.equal(rows.length, cases.length);
  assert.deepEqual(rows.map((r) => r.reason_code), cases.map((c) => c[2]));
  assert.equal(rows[0].user_id, userId);
  assert.equal(rows[0].method, "momo");
  assert.equal(Number(rows[0].amount), 100);
  assert.match(rows[0].reason, /GHS 135/);
  assert.equal(rows[0].status, "REJECTED");
  assert.ok(rows[0].created_at);
  assert.equal(rows[1].amount, null);
  assert.equal(rows[1].amount_raw, "abc", "what was sent is kept when it wasn't a number");
  assert.equal(rows[5].payer_phone, "12345");
  assert.equal(rows[8].method, "checkout");

  /* the payments switch off: refused and recorded too */
  await setPaymentsEnabled(db, "0209999001", { enabled: false });
  const off = await momo({ amount: 150, idempotency_key: key() });
  assert.equal(off.status, 503);
  assert.equal((await db.query(`SELECT reason_code FROM deposit_rejections ORDER BY id DESC LIMIT 1`)).rows[0].reason_code, "payments_off");
  await setPaymentsEnabled(db, "0209999001", { enabled: true });

  /* Admin -> Deposits -> "Stopped by our checks" */
  const list = await recentDeposits(db, { status: "rejected" });
  assert.equal(list.deposits.length, cases.length + 1);
  assert.equal(list.deposits[0]!.status, "rejected");
  assert.equal(list.deposits[0]!.name, "Ama Mensah");
  assert.match(String(list.deposits[0]!.note), /temporarily unavailable/);
  assert.equal((await recentDeposits(db, { status: "rejected", q: "nobody here" })).deposits.length, 0);
  assert.equal((await recentDeposits(db, { status: "all" })).deposits.length, 0, "refusals are kept apart from real payment attempts");
});

test("A valid request goes on to TheTeller; a duplicate of one already sent is refused without a second call", async () => {
  clearMoneyRulesCache();
  const { db, userId } = await setupWalletDb();
  const router = paymentsRouter(db);
  await db.query(`UPDATE users SET deposit_phone = $2, deposit_phone_confirmed_at = now() WHERE id = $1`, [userId, PHONE]);
  /* valid: it passes every check and goes to TheTeller (not configured in tests, so it stops right there) */
  const ok = await call(router, "/teller/checkout", userId, { amount: 150, currency: "GHS", idempotency_key: key() });
  assert.ok(ok.failed instanceof PaytellerConfigurationError, "a valid request reaches the gateway step");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM deposit_rejections`)).rows[0].n, 0, "a valid request isn't recorded as refused");

  /* a payment already completed under this key: the same key again is refused, not sent twice */
  const env = { ...process.env };
  Object.assign(process.env, { PAYTELLER_MERCHANT_ID: "TTM-00000001", PAYTELLER_USERNAME: "user", PAYTELLER_API_KEY: "key" });
  try {
    const k = key();
    await db.query(`INSERT INTO payment_intents (user_id, amount, currency, idempotency_key, status, transaction_id, redirect_url, gateway)
                    VALUES ($1, 150, 'GHS', $2, 'CONFIRMED', '000000000123', 'http://localhost/wallet.html', 'payteller')`, [userId, k]);
    const dup = await call(router, "/teller/checkout", userId, { amount: 150, currency: "GHS", idempotency_key: k });
    assert.equal(dup.failed, undefined);
    assert.equal(dup.status, 409);
    assert.equal(dup.body!.error, "already_processed");
    assert.equal((await db.query(`SELECT reason_code FROM deposit_rejections`)).rows[0].reason_code, "already_processed");
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM payment_intents`)).rows[0].n, 1, "no second payment was started");
  } finally {
    for (const k of ["PAYTELLER_MERCHANT_ID", "PAYTELLER_USERNAME", "PAYTELLER_API_KEY"]) {
      if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
    }
  }
});

test("Gateway not set up: a valid Mobile Money deposit gets a plain 'unavailable' answer and nothing is started", async () => {
  clearMoneyRulesCache();
  const { db, userId } = await setupWalletDb();
  await db.query(`UPDATE users SET phone = $2, deposit_phone = $2, deposit_phone_confirmed_at = now() WHERE id = $1`, [userId, PHONE]);
  const r = await call(paymentsRouter(db), "/teller/momo", userId,
    { amount: 150, currency: "GHS", network: "MTN", account_number: "233241234195", idempotency_key: key() });
  assert.ok(r.failed instanceof PaytellerConfigurationError, "Payteller credentials are missing in tests");

  /* the app's error handler turns it into a plain notice without naming any server settings */
  const { createApp } = await import("../src/app.js");
  const app = createApp(db) as unknown as { _router: { stack: { handle: Function }[] } };
  const layers = app._router.stack;
  const handler = layers[layers.length - 1]!.handle;
  const out: { status: number; body?: Record<string, unknown> } = { status: 200 };
  const res = { status(s: number) { out.status = s; return res; }, json(b: Record<string, unknown>) { out.body = b; return res; } };
  const logged = console.error;
  console.error = () => {};
  try { handler(r.failed, {}, res, () => {}); } finally { console.error = logged; }
  assert.equal(out.status, 503);
  assert.equal(out.body!.error, "payments_unavailable");
  assert.match(String(out.body!.message), /currently being configured/);
  assert.doesNotMatch(String(out.body!.message), /PAYTELLER_|TELLER_/);

  /* no payment, no money moved */
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM payment_intents`)).rows[0].n, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1`, [userId])).rows[0].n, 0);
});

test("The registered number stays enforced: a deposit from any other number is refused", async () => {
  clearMoneyRulesCache();
  const { db, userId } = await setupWalletDb();
  await db.query(`UPDATE users SET phone = $2 WHERE id = $1`, [userId, PHONE]);
  const r = await call(paymentsRouter(db), "/teller/momo", userId,
    { amount: 150, currency: "GHS", network: "MTN", account_number: "233249999999", idempotency_key: key() });
  assert.equal(r.status, 403);
  assert.equal(r.body!.error, "phone_not_registered");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM payment_intents`)).rows[0].n, 0);
});
