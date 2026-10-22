import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { paymentsRouter } from "../src/routes/payments.js";
import { adminRouter } from "../src/routes/admin.js";
import { settleIntent } from "../src/services/tellerSettlement.js";
import {
  getPaymentSettings, PAYMENTS_OFF_MESSAGE, paymentSettingsOverview, paymentsEnabled, setPaymentsEnabled,
} from "../src/services/paymentSettings.js";
import { AdminError } from "../src/services/admin.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0241112222";
const ENV = {
  PAYTELLER_MERCHANT_ID: "TTM-00012020", PAYTELLER_USERNAME: "secret-user-name",
  PAYTELLER_API_KEY: "super-secret-api-key",
};
const reachable = async () => ({ reachable: true, http: 200, ms: 42, error: null });

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } };
/** A route's own handler (after authenticate), so it can be called with a signed-in user already set. */
function handlerOf(router: unknown, method: string, path: string) {
  const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} exists`);
  const stack = layer!.route!.stack;
  return stack[stack.length - 1]!.handle as (req: Request, res: Response, next: (e?: unknown) => void) => Promise<void>;
}
function fakeRes() {
  const out: { status: number; body: unknown; headers: Record<string, string> } = { status: 200, body: undefined, headers: {} };
  const res = {
    status(n: number) { out.status = n; return res; },
    json(b: unknown) { out.body = b; return res; },
    setHeader(k: string, v: string) { out.headers[k] = v; },
  };
  return { res: res as unknown as Response, out };
}

test("Payments are ON by default, and the switch is saved until an admin changes it", async () => {
  const { db } = await setupWalletDb();
  assert.equal(await paymentsEnabled(db), true);
  const off = await setPaymentsEnabled(db, ADMIN, { enabled: false });
  assert.equal(off.payments_enabled, false);
  assert.equal(off.updated_by, ADMIN);
  /* read again from the database: it stays off */
  assert.equal((await getPaymentSettings(db)).payments_enabled, false);
  assert.equal(await paymentsEnabled(db), false);
  await setPaymentsEnabled(db, ADMIN, { enabled: true });
  assert.equal(await paymentsEnabled(db), true);
  const log = (await db.query(`SELECT action FROM admin_actions WHERE target = 'payteller' ORDER BY id`)).rows.map((r) => r.action);
  assert.deepEqual(log, ["payments.off", "payments.on"]);
});

test("The switch only takes a clear on or off", async () => {
  const { db } = await setupWalletDb();
  for (const enabled of [undefined, "false", 0, 1, null]) {
    await assert.rejects(setPaymentsEnabled(db, ADMIN, { enabled }), AdminError);
  }
  assert.equal(await paymentsEnabled(db), true);
});

test("The admin overview shows the merchant id and whether secrets are set, never the secrets", async () => {
  const { db } = await setupWalletDb();
  const o = await paymentSettingsOverview(db, ENV, reachable);
  assert.equal(o.payments_enabled, true);
  assert.equal(o.payteller.merchant_id, "TTM-00012020");
  assert.equal(o.payteller.merchant_id_looks_valid, true);
  assert.equal(o.payteller.mode, "live");
  assert.deepEqual(o.payteller.secrets, { api_username: true, api_key: true });
  assert.equal(o.connection.status, "connected");
  assert.equal(o.off_message, PAYMENTS_OFF_MESSAGE);
  const json = JSON.stringify(o);
  for (const secret of ["secret-user-name", "super-secret-api-key"]) assert.ok(!json.includes(secret), secret + " never sent");
});

test("The overview names what's missing when Payteller isn't configured, without trying to connect", async () => {
  const { db } = await setupWalletDb();
  let pinged = false;
  const o = await paymentSettingsOverview(db, { PAYTELLER_MERCHANT_ID: "TTM-00012020" }, async () => { pinged = true; return reachable(); });
  assert.equal(pinged, false);
  assert.equal(o.payteller.configured, false);
  assert.deepEqual(o.payteller.missing, ["PAYTELLER_USERNAME", "PAYTELLER_API_KEY"]);
  assert.equal(o.connection.status, "not_configured");
});

test("OFF: no new payment can start (mobile money or checkout), with the notice players see", async () => {
  const { db, userId } = await setupWalletDb();
  await setPaymentsEnabled(db, ADMIN, { enabled: false });
  const router = paymentsRouter(db);
  for (const path of ["/teller/momo", "/teller/checkout"]) {
    const { res, out } = fakeRes();
    let failed: unknown;
    await handlerOf(router, "post", path)({
      user: { id: userId, accountId: "account-1", phone: "0241234567", status: "ACTIVE" },
      body: { amount: 20, currency: "GHS", idempotency_key: "deposit:off-" + path, account_number: "233241234567", network: "MTN" },
    } as unknown as Request, res, (e) => { failed = e; });
    assert.equal(failed, undefined);
    assert.equal(out.status, 503, path);
    assert.deepEqual(out.body, { error: "payments_off", message: PAYMENTS_OFF_MESSAGE });
  }
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM payment_intents`)).rows[0].n, 0, "nothing was started");
});

test("OFF: a payment already started is still verified and credited", async () => {
  const env = await setupWalletDb();
  await env.intentWithTx(25, "000000000777");
  await setPaymentsEnabled(env.db, ADMIN, { enabled: false });
  await settleIntent(env.db, "000000000777", "approved", 2500);
  assert.equal((await env.intent("000000000777")).status, "CONFIRMED");
  assert.equal(await env.balance(), 25);
});

test("The site's payment config tells pages whether payments are on", async () => {
  const { db } = await setupWalletDb();
  const config = handlerOf(paymentsRouter(db), "get", "/config");
  const read = async () => {
    const { res, out } = fakeRes();
    await config({} as Request, res, (e) => { throw e; });
    return out.body as { paymentsOn: boolean; message?: string };
  };
  assert.equal((await read()).paymentsOn, true);
  await setPaymentsEnabled(db, ADMIN, { enabled: false });
  const off = await read();
  assert.equal(off.paymentsOn, false);
  assert.equal(off.message, PAYMENTS_OFF_MESSAGE);
});

test("Only admins reach the switch: it lives behind the admin router's guard", () => {
  const routes = (adminRouter({} as never) as unknown as { stack: Layer[] }).stack;
  const guardIndex = routes.findIndex((l) => !l.route);
  const switchIndex = routes.findIndex((l) => l.route?.path === "/payment-settings" && l.route.methods.post);
  assert.ok(guardIndex >= 0 && switchIndex > guardIndex, "authenticate + requireAdmin run before the switch");
});
