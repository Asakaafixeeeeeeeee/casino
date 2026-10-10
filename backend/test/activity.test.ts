import assert from "node:assert/strict";
import test from "node:test";
import { deposit, withdraw } from "../src/services/balanceService.js";
import { FeedbackError, listTransactions, saveFeedback } from "../src/services/accountActivity.js";
import { noteIntent, settleIntent } from "../src/services/tellerSettlement.js";
import { setupWalletDb } from "./helpers/walletDb.js";

test("Transaction records list deposits with their outcome and withdrawals as pending, newest first", async () => {
  const { db, client, userId, intentWithTx } = await setupWalletDb();
  await intentWithTx(50, "000000000101");
  await settleIntent(db, "000000000101", "approved", 5000);
  await intentWithTx(10, "000000000102");
  await noteIntent(db, "000000000102", "Access Denied. Merchant not found");
  await settleIntent(db, "000000000102", "declined", null);
  await intentWithTx(20, "000000000103"); // still waiting on TheTeller
  await new Promise((r) => setTimeout(r, 10)); // distinct timestamps: the in-memory clock is coarse
  await client.query("BEGIN");
  await withdraw(client, userId, "GHS", 25, "withdraw:test-1", "momo:0241234194");
  await client.query("COMMIT");

  const list = await listTransactions(db, userId);
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((t) => [t.kind, t.amount, t.status]), [
    ["withdrawal", 25, "pending"],
    ["deposit", 20, "pending"],
    ["deposit", 10, "failed"],
    ["deposit", 50, "success"],
  ]);
  assert.equal(list[0]!.destination, "0241234194");
  assert.deepEqual(list.slice(1).map((t) => t.ref), ["DES000000000103", "DES000000000102", "DES000000000101"],
    "a deposit's reference is DES + its TheTeller number");
  assert.equal(list[2]!.reason, "Access Denied. Merchant not found");
  assert.equal(list[3]!.reason, null);
});

test("Another player's transactions are never listed", async () => {
  const { db, client, userId } = await setupWalletDb();
  const { ensureWalletAccount } = await import("../src/services/accountLink.js");
  const other = await ensureWalletAccount(db, "account-2", "someone");
  await client.query("BEGIN");
  await deposit(client, other, "GHS", 30, "deposit:other-player");
  await client.query("COMMIT");
  assert.deepEqual(await listTransactions(db, userId), []);
});

test("Feedback stores ratings and ideas, and rejects empty or out-of-range input", async () => {
  const { db, userId } = await setupWalletDb();
  await saveFeedback(db, userId, { kind: "rating", rating: 5 });
  await saveFeedback(db, userId, { kind: "idea", message: "  Add a lobby filter for crash games  " });
  const rows = (await db.query("SELECT kind, rating, message FROM feedback ORDER BY created_at")).rows;
  assert.deepEqual(rows, [
    { kind: "rating", rating: 5, message: null },
    { kind: "idea", rating: null, message: "Add a lobby filter for crash games" },
  ]);
  await assert.rejects(() => saveFeedback(db, userId, { kind: "rating", rating: 6 }), FeedbackError);
  await assert.rejects(() => saveFeedback(db, userId, { kind: "idea", message: "   " }), FeedbackError);
  await assert.rejects(() => saveFeedback(db, userId, { kind: "spam" }), FeedbackError);
});

test("Feedback is capped at 20 a day per player", async () => {
  const { db, userId } = await setupWalletDb();
  for (let i = 0; i < 20; i++) await saveFeedback(db, userId, { kind: "rating", rating: 4 });
  await assert.rejects(() => saveFeedback(db, userId, { kind: "rating", rating: 4 }), (e: unknown) =>
    e instanceof FeedbackError && e.status === 429);
});
