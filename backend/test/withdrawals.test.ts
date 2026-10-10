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

/** A player with ₵100 who has asked to withdraw ₵40. */
async function withRequest() {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 100, "deposit:seed-100");
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

test("Approving pays the registered number from the float, exactly as the guide specifies", async () => {
  const { db, id, balance, row, userId } = await withRequest();
  let result: Awaited<ReturnType<typeof payWithdrawal>> | undefined;
  const sent = await withTeller(json({ code: "000", status: "approved", reason: "Transaction successful" }), async () => {
    result = await payWithdrawal(db, config, id, "0200000001");
  });
  assert.equal(result?.status, "PAID");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, "https://test.theteller.net/v1.1/transaction/process");
  assert.deepEqual(
    { ...sent[0]!.body, transaction_id: "x", desc: "x" },
    {
      account_number: "+233241234194", merchant_id: "TTM-00012020", transaction_id: "x", processing_code: "404000",
      amount: "000000004000", "r-switch": "FLT", desc: "x", account_issuer: "MTN", pass_code: "float-pass",
    }
  );
  assert.equal((await row()).status, "PAID");
  assert.equal(await balance(), 60); // already debited at request time

  // a second approval click does nothing
  await assert.rejects(() => payWithdrawal(db, config, id, "0200000001"), WithdrawalError);
  const list = await listTransactions(db, userId);
  assert.equal(list.find((t) => t.kind === "withdrawal")?.status, "success");
});

test("A clear refusal from TheTeller returns the money with the reason", async () => {
  const { db, id, balance, row, userId } = await withRequest();
  await withTeller(json({ status: "declined", reason: "Insufficient float balance" }), async () => {
    const r = await payWithdrawal(db, config, id, "0200000001");
    assert.equal(r.status, "DECLINED");
  });
  assert.equal(await balance(), 100);
  const w = await row();
  assert.equal(w.status, "DECLINED");
  assert.equal(w.gateway_note, "Insufficient float balance");
  const t = (await listTransactions(db, userId)).find((x) => x.kind === "withdrawal");
  assert.equal(t?.status, "failed");
  assert.equal(t?.reason, "Insufficient float balance");
});

test("A timeout keeps the payout pending — never refunded — until a status check decides", async () => {
  const { db, id, balance, row } = await withRequest();
  await withTeller(async () => { throw new Error("The operation was aborted due to timeout"); }, async () => {
    const r = await payWithdrawal(db, config, id, "0200000001");
    assert.equal(r.status, "PAYING");
  });
  assert.equal((await row()).status, "PAYING");
  assert.equal(await balance(), 60);

  await withTeller(json({ status: "pending" }), async () => {
    assert.equal((await recheckWithdrawal(db, config, id)).status, "PAYING");
  });
  await withTeller(json({ code: "000", status: "approved" }), async () => {
    assert.equal((await recheckWithdrawal(db, config, id)).status, "PAID");
  });
  assert.equal(await balance(), 60);
});

test("Payouts refuse to run without the float passcode", async () => {
  const { db, id, row } = await withRequest();
  const noPass = loadTellerConfig({ TELLER_MERCHANT_ID: "m", TELLER_API_USERNAME: "u", TELLER_API_KEY: "k" });
  const sent = await withTeller(json({ code: "000" }), async () => {
    await assert.rejects(() => payWithdrawal(db, noPass, id, "0200000001"), /TELLER_PASSCODE/);
  });
  assert.equal(sent.length, 0);
  assert.equal((await row()).status, "REQUESTED"); // still waiting; nothing was sent
});

test("Requests made before the withdrawals table existed are picked up by the migration", async () => {
  const env = await setupWalletDb({ stopBefore: "007_withdrawals.sql" });
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 50, "deposit:legacy");
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
