import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { clearGameControlsCache, clearPlayerRiskCache, assertStakeAllowed } from "../src/games/availability.js";
import { checkDeposit, LimitError } from "../src/services/responsibleGaming.js";
import { GameError } from "../src/games/catalog.js";
import { playRound } from "../src/games/rounds.js";
import { AdminError } from "../src/services/admin.js";
import { getPlayerRisk, playerMoney, playersWithLimits, recentDeposits, riskOverview, savePlayerRisk, saveRiskSettings } from "../src/services/risk.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0209999001";
const isAdmin = (code: string) => (e: unknown) => e instanceof AdminError && e.code === code;
const isLimit = (code: string) => (e: unknown) => e instanceof LimitError && e.code === code;
const isGame = (code: string) => (e: unknown) => e instanceof GameError && e.code === code;
let n = 0;

async function funded(amount = 500) {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", amount, "deposit:seed-risk-" + ++n);
  await env.client.query("COMMIT");
  await env.db.query("UPDATE users SET phone = '0551234567' WHERE id = $1", [env.userId]);
  clearGameControlsCache();
  clearPlayerRiskCache();
  return env;
}

test("Recent deposits: every attempt with its status, filterable and searchable", async () => {
  const env = await funded();
  await env.intentWithTx(20, "100000000001"); /* PENDING */
  await env.intentWithTx(100, "100000000002");
  await env.db.query(`UPDATE payment_intents SET status = 'CONFIRMED' WHERE transaction_id = '100000000002'`);
  await env.intentWithTx(50, "100000000003");
  await env.db.query(`UPDATE payment_intents SET status = 'FAILED', gateway_note = 'Insufficient funds' WHERE transaction_id = '100000000003'`);

  const all = await recentDeposits(env.db, {});
  assert.equal(all.deposits.length, 3);
  assert.deepEqual(all.deposits.map((d) => [d.amount, d.status]).sort((a, b) => (a[0] as number) - (b[0] as number)), [[20, "pending"], [50, "failed"], [100, "successful"]]);
  assert.equal(all.deposits[0]!.reference, "DES100000000003", "newest first, with its reference");
  assert.equal(all.deposits.find((d) => d.status === "failed")!.note, "Insufficient funds");

  assert.deepEqual((await recentDeposits(env.db, { status: "successful" })).deposits.map((d) => d.amount), [100]);
  assert.deepEqual((await recentDeposits(env.db, { status: "failed" })).deposits.map((d) => d.amount), [50]);
  assert.equal((await recentDeposits(env.db, { q: "0551234567" })).deposits.length, 3, "search by number");
  assert.equal((await recentDeposits(env.db, { q: "0000000" })).deposits.length, 0);
});

test("Players' money: deposits, withdrawals, staked, won and the net per player", async () => {
  const env = await funded();
  await env.intentWithTx(100, "200000000001");
  await env.db.query(`UPDATE payment_intents SET status = 'CONFIRMED' WHERE transaction_id = '200000000001'`);
  for (let i = 0; i < 5; i++) await playRound(env.db, env.userId, "volta-coin", { stake: 4, choice: { pick: "HEADS" }, idempotency_key: "round:money-" + i });

  const m = await playerMoney(env.db, { range: "30d" });
  const me = m.players.find((p) => p.phone === "0551234567")!;
  assert.ok(me, "the player is listed because they have money activity");
  assert.equal(me.deposited, 100);
  assert.equal(me.staked, 20, "5 bets of 4");
  assert.equal(me.houseNet, 20 - me.won, "house net = staked - won");
  assert.equal(me.playerNet, me.won - 20);
});

test("Per-player limits: a deposit tier and a maximum bet, enforced and reversible, never touching balances", async () => {
  const env = await funded();
  const uid = env.userId;
  /* nothing set: no limit trips */
  await savePlayerRisk(env.db, ADMIN, uid, { min_deposit: 150, max_deposit: 500, max_bet: 10 });
  const got = await getPlayerRisk(env.db, uid);
  assert.deepEqual([got.risk.min_deposit, got.risk.max_deposit, got.risk.max_bet], [150, 500, 10]);

  /* deposits below the tier or above the cap are refused with the limit named */
  await assert.rejects(() => checkDeposit(env.db, uid, 140), isLimit("below_min_deposit"));
  await assert.rejects(() => checkDeposit(env.db, uid, 600), isLimit("above_max_deposit"));
  await checkDeposit(env.db, uid, 200); /* within the tier: fine */

  /* a bet over the player's max is refused; at or under is fine */
  await assert.rejects(() => assertStakeAllowed(env.db, "volta-coin", 25, uid), isGame("invalid_stake"));
  await assertStakeAllowed(env.db, "volta-coin", 10, uid);
  /* a real bet of 50 is refused end to end, and the balance is untouched */
  const before = await env.balance();
  await assert.rejects(() => playRound(env.db, uid, "volta-coin", { stake: 50, choice: { pick: "HEADS" }, idempotency_key: "round:cap" }), isGame("invalid_stake"));
  assert.equal(await env.balance(), before, "a refused bet never moves money");

  /* validation and the limits list */
  await assert.rejects(() => savePlayerRisk(env.db, ADMIN, uid, { min_deposit: 1 }), isAdmin("invalid_min_deposit"), "below the site's minimum deposit (GHS 135)");
  await assert.rejects(() => savePlayerRisk(env.db, ADMIN, uid, { min_deposit: 600, max_deposit: 200 }), isAdmin("invalid_max_deposit"));
  assert.equal((await playersWithLimits(env.db)).players.length, 1);

  /* clearing a limit removes it, and the player can deposit and bet freely again */
  await savePlayerRisk(env.db, ADMIN, uid, { min_deposit: null, max_deposit: null, max_bet: null });
  await checkDeposit(env.db, uid, 20);
  await assertStakeAllowed(env.db, "volta-coin", 25, uid);
  assert.equal((await playersWithLimits(env.db)).players.length, 0, "no limit left, not listed");
});

test("Risk alerts: big payouts, big winners and failed-deposit bursts, by the saved thresholds", async () => {
  const env = await funded(5000);
  /* a big win: stake 2, win 200 (100x) */
  await env.db.query(
    `INSERT INTO game_rounds (user_id, game, currency, stake, payout, choice, outcome, idempotency_key)
     VALUES ($1, 'volta-coin', 'GHS', 2, 200, '{}', '{}', 'bet:alert-win')`, [env.userId]);
  /* three failed deposits in the last hour */
  for (let i = 0; i < 3; i++) {
    await env.intentWithTx(30, "30000000000" + i);
    await env.db.query(`UPDATE payment_intents SET status = 'FAILED' WHERE transaction_id = '30000000000${i}'`);
  }
  await saveRiskSettings(env.db, ADMIN, { big_payout: 100, big_multiplier: 50, daily_net_win: 100, failed_deposits: 3 });

  const o = await riskOverview(env.db);
  assert.deepEqual([o.settings.big_payout, o.settings.failed_deposits], [100, 3]);
  assert.ok(o.alerts.payouts.some((p) => p.payout === 200 && p.x === 100), "the 100x win is flagged");
  assert.match(o.alerts.payouts[0]!.player, /•/, "the number is masked on the alert");
  assert.ok(o.alerts.winners.some((w) => w.net >= 100), "a player up over the day is flagged");
  assert.ok(o.alerts.failedDeposits.some((f) => f.fails >= 3), "the failed-deposit burst is flagged");

  await assert.rejects(() => saveRiskSettings(env.db, ADMIN, { failed_deposits: 1 }), isAdmin("invalid_failed_deposits"));
});
