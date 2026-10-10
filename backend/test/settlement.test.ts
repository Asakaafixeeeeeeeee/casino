import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { noteIntent, settleIntent } from "../src/services/tellerSettlement.js";
import { setupWalletDb as setup } from "./helpers/walletDb.js";

test("An approved deposit credits the wallet exactly once", async () => {
  const { db, intentWithTx, balance, intent } = await setup();
  await intentWithTx(10, "944595952543");

  const first = await settleIntent(db, "944595952543", "approved", 1000);
  assert.equal(first?.status, "CONFIRMED");
  assert.equal(first?.creditedMajor, 10);
  assert.equal(await balance(), 10);

  // TheTeller's answer arriving again (status poll, background recheck) changes nothing.
  assert.equal(await settleIntent(db, "944595952543", "approved", 1000), null);
  assert.equal(await balance(), 10);
  assert.equal((await intent("944595952543")).status, "CONFIRMED");
});

test("A declined deposit credits nothing and keeps TheTeller's reason", async () => {
  const { db, intentWithTx, balance, intent } = await setup();
  await intentWithTx(10, "000000000002");
  await noteIntent(db, "000000000002", "Access Denied. Merchant not found");
  await settleIntent(db, "000000000002", "declined", null, "Transaction declined");
  assert.equal(await balance(), 0);
  const row = await intent("000000000002");
  assert.equal(row.status, "FAILED");
  assert.equal(row.gateway_note, "Access Denied. Merchant not found / Transaction declined");
});

test("A short payment is credited for what was actually paid", async () => {
  const { db, intentWithTx, balance } = await setup();
  await intentWithTx(20, "000000000003");
  const result = await settleIntent(db, "000000000003", "approved", 1500);
  assert.equal(result?.creditedMajor, 15);
  assert.equal(await balance(), 15);
});

test("A missing amount from TheTeller credits the amount the player asked for", async () => {
  const { db, intentWithTx, balance } = await setup();
  await intentWithTx(25.5, "000000000004");
  await settleIntent(db, "000000000004", "approved", null);
  assert.equal(await balance(), 25.5);
});

test("The ledger takes pesewas but refuses fractions of a pesewa", async () => {
  const { client, userId, balance } = await setup();
  await client.query("BEGIN");
  await deposit(client, userId, "GHS", 12.5, "deposit:pesewas-ok");
  await client.query("COMMIT");
  assert.equal(await balance(), 12.5);
  await client.query("BEGIN");
  await assert.rejects(() => deposit(client, userId, "GHS", 10.005, "deposit:sub-pesewa"), /minor units/);
  await client.query("ROLLBACK");
  assert.equal(await balance(), 12.5);
});
