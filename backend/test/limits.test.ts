import assert from "node:assert/strict";
import test from "node:test";
import { checkDeposit, getLimits, LimitError, selfExclude, setLimits } from "../src/services/responsibleGaming.js";
import { settleIntent } from "../src/services/tellerSettlement.js";
import { setupWalletDb } from "./helpers/walletDb.js";

/** Pretend the 24-hour cool-off is over. */
const skipCoolOff = (db: import("pg").Pool, userId: string) =>
  db.query(`UPDATE player_limits SET pending_from = now() - interval '1 minute' WHERE user_id = $1`, [userId]);

const blocked = (code: string) => (e: unknown) => e instanceof LimitError && e.code === code;

test("A new limit applies at once and blocks deposits over it, saying how much is left", async () => {
  const { db, userId, intentWithTx } = await setupWalletDb();
  await setLimits(db, userId, { daily: 100 });
  await intentWithTx(70, "000000000201");
  await settleIntent(db, "000000000201", "approved", 7000);

  await checkDeposit(db, userId, 30); // exactly up to the limit is fine
  await assert.rejects(() => checkDeposit(db, userId, 31), (e: unknown) =>
    blocked("limit_reached")(e) && /up to ₵30\.00 more/.test((e as Error).message));
});

test("Money still in flight counts towards a limit; failed deposits don't", async () => {
  const { db, userId, intentWithTx } = await setupWalletDb();
  await setLimits(db, userId, { weekly: 50 });
  await intentWithTx(40, "000000000202"); // pending at TheTeller
  await intentWithTx(40, "000000000203");
  await settleIntent(db, "000000000203", "declined", null);
  const v = await getLimits(db, userId);
  assert.equal(v.used.weekly, 40);
  await assert.rejects(() => checkDeposit(db, userId, 11), blocked("limit_reached"));
  await checkDeposit(db, userId, 10);
});

test("Raising a limit waits 24 hours; the old limit holds until then", async () => {
  const { db, userId } = await setupWalletDb();
  await setLimits(db, userId, { daily: 100 });
  const v = await setLimits(db, userId, { daily: 500 });
  assert.equal(v.limits.daily, 100);
  assert.deepEqual(v.pending, { daily: 500 });
  assert.ok(v.pendingFrom && v.pendingFrom.getTime() > Date.now() + 23 * 3600e3);
  await assert.rejects(() => checkDeposit(db, userId, 200), blocked("limit_reached"));

  await skipCoolOff(db, userId);
  const after = await getLimits(db, userId);
  assert.equal(after.limits.daily, 500);
  assert.equal(after.pending, null);
  await checkDeposit(db, userId, 200);
});

test("Removing a limit also waits 24 hours", async () => {
  const { db, userId } = await setupWalletDb();
  await setLimits(db, userId, { monthly: 300 });
  const v = await setLimits(db, userId, { monthly: null });
  assert.equal(v.limits.monthly, 300);
  assert.deepEqual(v.pending, { monthly: null });
  await skipCoolOff(db, userId);
  assert.equal((await getLimits(db, userId)).limits.monthly, null);
});

test("Lowering a limit while a raise is waiting applies at once and cancels the raise", async () => {
  const { db, userId } = await setupWalletDb();
  await setLimits(db, userId, { daily: 100 });
  await setLimits(db, userId, { daily: 1000 });
  const v = await setLimits(db, userId, { daily: 50 });
  assert.equal(v.limits.daily, 50);
  assert.equal(v.pending, null);
});

test("Limits per period are independent", async () => {
  const { db, userId } = await setupWalletDb();
  const v = await setLimits(db, userId, { daily: 20, weekly: 100, monthly: 300 });
  assert.deepEqual(v.limits, { daily: 20, weekly: 100, monthly: 300 });
  const raised = await setLimits(db, userId, { weekly: 200, daily: 10 });
  assert.deepEqual(raised.limits, { daily: 10, weekly: 100, monthly: 300 });
  assert.deepEqual(raised.pending, { weekly: 200 });
});

test("A break blocks deposits and can't be shortened", async () => {
  const { db, userId } = await setupWalletDb();
  const v = await selfExclude(db, userId, 7);
  assert.ok(v.excludedUntil && v.excludedUntil.getTime() > Date.now() + 6.9 * 86400e3);
  await assert.rejects(() => checkDeposit(db, userId, 10), (e: unknown) =>
    blocked("self_excluded")(e) && (e as LimitError).status === 403);
  const shorter = await selfExclude(db, userId, 1);
  assert.equal(shorter.excludedUntil?.getTime(), v.excludedUntil.getTime());
  const longer = await selfExclude(db, userId, 30);
  assert.ok(longer.excludedUntil!.getTime() > v.excludedUntil.getTime());
});

test("Bad limit and break values are refused", async () => {
  const { db, userId } = await setupWalletDb();
  await assert.rejects(() => setLimits(db, userId, { daily: 0 }), blocked("invalid_limit"));
  await assert.rejects(() => setLimits(db, userId, { weekly: "lots" }), blocked("invalid_limit"));
  await assert.rejects(() => selfExclude(db, userId, 3), blocked("invalid_break"));
  await checkDeposit(db, userId, 50_000); // no limits set: nothing blocks
});
