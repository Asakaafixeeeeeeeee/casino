import assert from "node:assert/strict";
import test from "node:test";
import { deposit, postMovement, SystemAccount } from "../src/services/balanceService.js";
import { requestWithdrawal, withdrawableOf, WithdrawalError } from "../src/services/withdrawals.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const PHONE = "0241234194";
type Env = Awaited<ReturnType<typeof setupWalletDb>>;

async function move(env: Env, key: string, type: "BET_PLACED" | "BET_SETTLED", amount: number) {
  await env.client.query("BEGIN");
  await postMovement(env.client, {
    idempotencyKey: key,
    entryType: type,
    legs: type === "BET_PLACED"
      ? [{ userId: env.userId, currencyCode: "GHS", direction: "DEBIT", amountMajor: amount },
         { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "CREDIT", amountMajor: amount }]
      : [{ userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: amount },
         { userId: env.userId, currencyCode: "GHS", direction: "CREDIT", amountMajor: amount }],
  });
  await env.client.query("COMMIT");
}

test("Only winnings can be withdrawn: deposit 100, stake 20, win 50 → 50 withdrawable of 130", async () => {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 100, "deposit:winnings-1");
  await env.client.query("COMMIT");
  assert.deepEqual(await withdrawableOf(env.db, env.userId), { withdrawable: 0, balance: 100 });

  await move(env, "bet:winnings-1", "BET_PLACED", 20);
  await move(env, "win:winnings-1", "BET_SETTLED", 50);
  assert.deepEqual(await withdrawableOf(env.db, env.userId), { withdrawable: 50, balance: 130 });

  await assert.rejects(() => requestWithdrawal(env.db, { id: env.userId, phone: PHONE }, 60, "wd-too-much"),
    (e: unknown) => e instanceof WithdrawalError && e.code === "winnings_only");
  await requestWithdrawal(env.db, { id: env.userId, phone: PHONE }, 50, "wd-ok");
  assert.deepEqual(await withdrawableOf(env.db, env.userId), { withdrawable: 0, balance: 80 });
});

test("Stakes use deposited money first; winnings are only spent once it runs out", async () => {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 500, "deposit:winnings-2");
  await env.client.query("COMMIT");
  await move(env, "bet:winnings-2a", "BET_PLACED", 400);
  await move(env, "win:winnings-2", "BET_SETTLED", 6000);
  assert.deepEqual(await withdrawableOf(env.db, env.userId), { withdrawable: 6000, balance: 6100 });
  /* the 100 left from the deposit goes first, then 50 comes out of the winnings */
  await move(env, "bet:winnings-2b", "BET_PLACED", 150);
  assert.deepEqual(await withdrawableOf(env.db, env.userId), { withdrawable: 5950, balance: 5950 });
});
