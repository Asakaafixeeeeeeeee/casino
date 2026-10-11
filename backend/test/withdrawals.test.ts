import assert from "node:assert/strict";
import test from "node:test";
import { isAdmin } from "../src/middleware/authenticate.js";
import { listTransactions } from "../src/services/accountActivity.js";
import { deposit, withdraw } from "../src/services/balanceService.js";
import { loadTellerConfig } from "../src/services/teller.js";
import {
  payWithdrawal,
  recheckWithdrawal,
  rejectWithdrawal,
  requestWithdrawal,
  WithdrawalError,
} from "../src/services/withdrawals.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const PHONE = "0241234194";
const config = loadTellerConfig({
  TELLER_BASE_URL: "https://test.theteller.net",
  TELLER_MERCHANT_ID: "TTM-00012020",
  TELLER_API_USERNAME: "user",
  TELLER_API_KEY: "key",
  TELLER_PASSCODE: "float-pass",
});

/** A player with ₵100 of winnings (only winnings can be withdrawn) who has asked to withdraw ₵40. */
async function withRequest() {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 100, "deposit:seed-100");
  await env.client.query("UPDATE user_balances SET withdrawable = available WHERE user_id = $1", [env.userId]);
  await env.client.query("COMMIT");
  const { id } = await requestWithdrawal(env.db, { id: env.userId, phone: PHONE }, 40, "withdraw:test-40");
  const row = async () => (await env.db.query("SELECT * FROM withdrawals WHERE id = $1", [id])).rows[0];
  return { ...env, id, row };
}

/** Swaps global fetch for TheTeller's answer while `fn` runs, recording what was sent. */
async function withTeller(answer: () => Promise<Response>, fn: () => Promise<void>) {
  const real = globalThis.fetch;
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return answer();
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return sent;
}
const json = (body: unknown, status = 200) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("A withdrawal request takes the money off the balance at once and waits for approval", async () => {
  const { balance, row } = await withRequest();
  assert.equal(await balance(), 60);
  const w = await row();
  assert.equal(w.status, "REQUESTED");
  assert.equal(w.phone, PHONE);
});

test("Withdrawals only go to a mobile money number", async () => {
  const { db, userId } = await setupWalletDb();
  await assert.rejects(() => requestWithdrawal(db, { id: userId, phone: "0231234567" }, 20, "withdraw:glo"), WithdrawalError);
});

test("Rejecting a request returns the money, and can't happen twice", async () => {
  const { db, id, balance, row } = await withRequest();
  await rejectWithdrawal(db, id, "Name doesn't match", "0200000001");
  assert.equal(await balance(), 100);
  assert.equal((await row()).status, "DECLINED");
  await assert.rejects(() => rejectWithdrawal(db, id, "again", "0200000001"), WithdrawalError);
  assert.equal(await balance(), 100);
});

test("Approving only marks it approved: nothing is sent to TheTeller and no balance changes", async () => {
  const { db, id, balance, row, userId } = await withRequest();
  let result: Awaited<ReturnType<typeof payWithdrawal>> | undefined;
  const sent = await withTeller(json({ code: "000", status: "approved" }), async () => {
    result = await payWithdrawal(db, id, "0200000001");
  });
  assert.equal(result?.status, "PAID");
  assert.equal(sent.length, 0, "withdrawals are paid by hand: no gateway call");
  assert.equal((await row()).status, "PAID");
  assert.equal(await balance(), 60); // already debited at request time; approving adds nothing back

  // a second approval click does nothing, and a rejection can't refund it afterwards
  await assert.rejects(() => payWithdrawal(db, id, "0200000001"), WithdrawalError);
  await assert.rejects(() => rejectWithdrawal(db, id, "too late", "0200000001"), WithdrawalError);
  assert.equal(await balance(), 60);
  const list = await listTransactions(db, userId);
  assert.equal(list.find((t) => t.kind === "withdrawal")?.status, "success");
});

test("A rejected request can't be approved afterwards; the money stays returned to the player", async () => {
  const { db, id, balance, row } = await withRequest();
  await rejectWithdrawal(db, id, "Wrong number", "0200000001");
  await assert.rejects(() => payWithdrawal(db, id, "0200000001"), WithdrawalError);
  assert.equal((await row()).status, "DECLINED");
  assert.equal(await balance(), 100);
});

test("An older payout left PAYING is still settled by a status check, never refunded on a timeout", async () => {
  const { db, id, balance } = await withRequest();
  await db.query(`UPDATE withdrawals SET status = 'PAYING', transaction_id = '000000000077' WHERE id = $1`, [id]);
  assert.equal(await balance(), 60);

  await withTeller(json({ status: "pending" }), async () => {
    assert.equal((await recheckWithdrawal(db, config, id)).status, "PAYING");
  });
  await withTeller(json({ code: "000", status: "approved" }), async () => {
    assert.equal((await recheckWithdrawal(db, config, id)).status, "PAID");
  });
  assert.equal(await balance(), 60);
});

test("Requests made before the withdrawals table existed are picked up by the migration", async () => {
  const env = await setupWalletDb({ stopBefore: "007_withdrawals.sql" });
  /* today's ledger code needs the winnings column, which this deliberately old schema doesn't have yet */
  await env.db.query("ALTER TABLE user_balances ADD COLUMN IF NOT EXISTS withdrawable NUMERIC(38,18) NOT NULL DEFAULT 0");
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 50, "deposit:legacy");
  await env.client.query("UPDATE user_balances SET withdrawable = available WHERE user_id = $1", [env.userId]);
  await withdraw(env.client, env.userId, "GHS", 25, "withdraw:legacy", "momo:0551234567");
  await env.client.query("COMMIT");
  await env.runMigration("007_withdrawals.sql");
  const rows = (await env.db.query("SELECT phone, status, amount FROM withdrawals")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, "0551234567");
  assert.equal(rows[0].status, "REQUESTED");
  assert.equal(Number(rows[0].amount), 25);
});

test("Admins are matched on their registered number, whatever format ADMIN_PHONES uses", () => {
  const env = { ADMIN_PHONES: "+233 24 123 4194, 0200000001" };
  assert.equal(isAdmin({ id: "u", accountId: "1", phone: "0241234194" }, env), true);
  assert.equal(isAdmin({ id: "u", accountId: "1", phone: "0200000001" }, env), true);
  assert.equal(isAdmin({ id: "u", accountId: "1", phone: "0551234567" }, env), false);
  assert.equal(isAdmin({ id: "u", accountId: "1", phone: "" }, env), false);
  assert.equal(isAdmin({ id: "u", accountId: "1", phone: "0241234194" }, {}), false);
});
