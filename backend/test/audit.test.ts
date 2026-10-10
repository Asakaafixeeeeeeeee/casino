/* Regressions for the money and game bugs found in the pre-launch audit. Each test fails on the code as it was. */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { setupWalletDb } from "./helpers/walletDb.js";
import { deposit } from "../src/services/balanceService.js";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { requestWithdrawal, rejectWithdrawal, payWithdrawal, recheckWithdrawal, settleWithdrawal, WithdrawalError } from "../src/services/withdrawals.js";
import { adjustBalance, creditByPhone } from "../src/services/admin.js";
import { checkTellerStatus, createPaymentIntent, loadTellerConfig, TellerRequestError } from "../src/services/teller.js";
import { quoteConversion } from "../src/services/fxRates.js";
import { GAMES, GameError } from "../src/games/catalog.js";
import { playRound } from "../src/games/rounds.js";
import { mines as minesGame, minesMultipliers } from "../src/games/sessionCatalog.js";
import { FLIGHT_GAMES } from "../src/games/flights.js";
import { livePayout, LIVE_MULT, LIVE_ROUND_MS, currentLiveRound, minesFromSeed, placeLiveBet, settleDueLiveRounds } from "../src/games/minesLive.js";
import { cashOutSession, settleAbandonedSessions, startSession, stepSession, ABANDONED_AFTER_MS } from "../src/games/sessions.js";

const key = () => "k-" + Math.random().toString(36).slice(2, 12);

/** A player with GHS 100 and the registered number 0241234567 (MTN). */
async function funded(amount = 100) {
  const env = await setupWalletDb();
  await env.db.query(`UPDATE users SET phone = '0241234567' WHERE id = $1`, [env.userId]);
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", amount, "deposit:audit-" + key());
  await env.client.query("COMMIT");
  return env;
}
const balanceOf = async (db: Awaited<ReturnType<typeof setupWalletDb>>["db"], uid: string) =>
  Number((await db.query(`SELECT available FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [uid])).rows[0].available);

/** A stand-in for TheTeller: answers every request with `code` and `body`, and records what it was asked. */
async function gateway(code: number, body: Record<string, unknown>) {
  const seen: { method: string; url: string }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "" });
    req.resume();
    req.on("end", () => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = loadTellerConfig({ TELLER_BASE_URL: base, TELLER_CHECKOUT_URL: base, TELLER_MERCHANT_ID: "TTM-00000001",
    TELLER_API_USERNAME: "user", TELLER_API_KEY: "key", TELLER_PASSCODE: "pass" } as NodeJS.ProcessEnv);
  return { config, seen, close: () => server.close() };
}

/* ---------------- withdrawals ---------------- */

test("A withdrawal's key is the player's own: it can't take the ledger key a round's settlement needs", async () => {
  const { db, userId } = await funded();
  const user = { id: userId, phone: "0241234567" };
  const first = await requestWithdrawal(db, user, 20, "win:live:00000000-0000-0000-0000-000000000001");
  const keys = (await db.query(`SELECT idempotency_key FROM ledger_journal WHERE entry_type = 'WITHDRAWAL_REQUEST'`)).rows.map((r) => r.idempotency_key);
  assert.deepEqual(keys, [`withdraw:${userId}:win:live:00000000-0000-0000-0000-000000000001`]);
  /* the same key again is the same withdrawal, returned again — not a second one, and not an error */
  const again = await requestWithdrawal(db, user, 20, "win:live:00000000-0000-0000-0000-000000000001");
  assert.equal(again.id, first.id);
  assert.equal(await balanceOf(db, userId), 80);
});

test("An admin's rejection can't refund a withdrawal another admin's Pay has already sent", async () => {
  const { db, userId } = await funded();
  const w = await requestWithdrawal(db, { id: userId, phone: "0241234567" }, 40, key());
  /* Pay claims it first (as it does, atomically) … */
  await db.query(`UPDATE withdrawals SET status = 'PAYING', transaction_id = '000000000001' WHERE id = $1`, [w.id]);
  /* … so a rejection racing it must not decline (and refund) the PAYING row */
  assert.equal(await settleWithdrawal(db, w.id, "declined", "Rejected by an admin", "0209999001", ["REQUESTED"]), null);
  await assert.rejects(rejectWithdrawal(db, w.id, "too late", "0209999001"), (e: unknown) => e instanceof WithdrawalError && e.code === "already_decided");
  assert.equal(await balanceOf(db, userId), 60, "not refunded");
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM ledger_journal WHERE idempotency_key = $1`, [`refund:${w.id}`])).rows[0].n, 0);
});

test("Nobody approves, rejects or credits their own money; withdrawal decisions are audit-logged", async () => {
  const { db, userId } = await funded();
  const own = await requestWithdrawal(db, { id: userId, phone: "0241234567" }, 30, key());
  const gw = await gateway(200, { status: "approved", code: "000", reason: "ok" });
  try {
    /* the admin's number is the player's own, in another format */
    await assert.rejects(payWithdrawal(db, gw.config, own.id, "+233 24 123 4567"), (e: unknown) => e instanceof WithdrawalError && e.code === "own_withdrawal");
    await assert.rejects(rejectWithdrawal(db, own.id, "mine", "233241234567"), (e: unknown) => e instanceof WithdrawalError && e.code === "own_withdrawal");
    await assert.rejects(adjustBalance(db, "0241234567", userId, { amount: 500, reason: "my own goodwill", idempotency_key: key() }), /your own balance/);
    await assert.rejects(creditByPhone(db, "+233241234567", { phone: "0241234567", amount: 500, reason: "my own goodwill", idempotency_key: key() }), /your own balance/);
    assert.equal(await balanceOf(db, userId), 70);
    assert.equal(gw.seen.length, 0, "no payout was sent");

    /* another admin decides it, and the decision is logged */
    const paid = await payWithdrawal(db, gw.config, own.id, "0209999001");
    assert.equal(paid.status, "PAID");
    const other = await requestWithdrawal(db, { id: userId, phone: "0241234567" }, 10, key());
    await rejectWithdrawal(db, other.id, "Duplicate request", "0209999001");
    const log = (await db.query(`SELECT action FROM admin_actions WHERE admin = '0209999001' ORDER BY id`)).rows.map((r) => r.action);
    assert.deepEqual(log, ["withdrawal.pay", "withdrawal.reject"]);
  } finally {
    gw.close();
  }
});

test("A status check answered with a 4xx is no answer: a payout stays PAYING, never refunded on a guess", async () => {
  const { db, userId } = await funded();
  const gw = await gateway(404, { status: "failed", reason: "Transaction not found" });
  try {
    await assert.rejects(checkTellerStatus(gw.config, "000000000009"), (e: unknown) => e instanceof TellerRequestError);
    const w = await requestWithdrawal(db, { id: userId, phone: "0241234567" }, 40, key());
    await db.query(`UPDATE withdrawals SET status = 'PAYING', transaction_id = '000000000009' WHERE id = $1`, [w.id]);
    const r = await recheckWithdrawal(db, gw.config, w.id);
    assert.equal(r.status, "PAYING");
    assert.match(r.note ?? "", /Check failed/);
    assert.equal(await balanceOf(db, userId), 60, "not refunded");
  } finally {
    gw.close();
  }
});

/* ---------------- deposits ---------------- */

test("A payment key belongs to one player: another player's key never returns their checkout", async () => {
  const { db, client, userId } = await funded();
  const other = await ensureWalletAccount(db, "audit-other", "other");
  await createPaymentIntent(client, userId, 100, "GHS", "deposit:shared-key", "https://site/wallet.html");
  await assert.rejects(createPaymentIntent(client, other, 100, "GHS", "deposit:shared-key", "https://site/wallet.html"),
    (e: unknown) => e instanceof TellerRequestError);
  /* the owner's retry still gets its own intent back */
  const again = await createPaymentIntent(client, userId, 100, "GHS", "deposit:shared-key", "https://site/wallet.html");
  assert.equal(again.status, "PENDING");
});

/* ---------------- payouts round down ---------------- */

test("Payouts round down to the cent, so no stake and stopping point returns more than the disclosed RTP", () => {
  /* Mines: 0.10 on 2 mines cashed out after one star (1.05x) paid 0.11 — 101.2% */
  assert.equal(minesGame.payout(0.1, minesMultipliers(2)[1]!), 0.1);
  for (let m = 1; m <= 24; m++) {
    const table = minesMultipliers(m);
    for (let k = 1; k <= 25 - m; k++) {
      let p = 1;
      for (let i = 0; i < k; i++) p *= (25 - m - i) / (25 - i);
      for (let cents = 10; cents <= 200; cents++) {
        const stake = cents / 100;
        const ev = (p * minesGame.payout(stake, table[k]!)) / stake;
        assert.ok(ev <= 0.97 + 1e-9, `Mines ${m} mines, ${k} stars, stake ${stake}: EV ${(ev * 100).toFixed(3)}%`);
      }
    }
  }
  /* Knockout / Crash: an auto cash-out at x wins with probability rtp ÷ x */
  for (const id of ["volta-knockout", "volta-crash"] as const) {
    const g = FLIGHT_GAMES[id]!;
    for (let tx = 101; tx <= 300; tx++) {
      for (let cents = Math.round(g.minBet * 100); cents <= Math.round(g.minBet * 100) + 100; cents++) {
        const stake = cents / 100;
        const ev = ((g.rtp / (tx / 100)) * g.payout(stake, tx / 100)) / stake;
        assert.ok(ev <= g.rtp + 1e-9, `${id} stake ${stake} at ${tx / 100}x: EV ${(ev * 100).toFixed(3)}%`);
      }
    }
  }
  /* Live Mines and Magic Ball */
  for (let tiles = 1; tiles < LIVE_MULT.length; tiles++) assert.equal(livePayout(0.15, tiles), Math.min(10_000, Math.floor(0.15 * LIVE_MULT[tiles]! * 100 + 1e-6) / 100));
  const ball = GAMES["magic-ball"]!;
  const r = ball.play({ bets: { "1": 0.15 } } as never, 0.15, () => 0);   /* the ball under cup 1 */
  assert.equal(r.payout, 0.43, "0.15 × 2.9 = 0.435 pays 0.43, not 0.44");
});

/* ---------------- inputs ---------------- */

test("Built-in object names are not games, levels or fields: refused before any stake is taken", async () => {
  const { db, userId } = await funded();
  await assert.rejects(startSession(db, userId, "volta-goal", { stake: 5, params: { field: "constructor" }, idempotency_key: key() }),
    (e: unknown) => e instanceof GameError && e.code === "invalid_params");
  await assert.rejects(startSession(db, userId, "volta-crossing", { stake: 5, params: { level: "toString" }, idempotency_key: key() }),
    (e: unknown) => e instanceof GameError && e.code === "invalid_params");
  await assert.rejects(playRound(db, userId, "constructor", { stake: 1, choice: {}, idempotency_key: key() }),
    (e: unknown) => e instanceof GameError && e.code === "unknown_game");
  await assert.rejects(startSession(db, userId, "__proto__", { stake: 1, params: {}, idempotency_key: key() }), (e: unknown) => e instanceof GameError);
  assert.equal(await balanceOf(db, userId), 100);
  /* and a normal Goal round still starts */
  await startSession(db, userId, "volta-goal", { stake: 5, params: { field: "small" }, idempotency_key: key() });
  assert.equal(await balanceOf(db, userId), 95);
});

test("A stake is a number: arrays, booleans and objects are refused, not coerced", async () => {
  const { db, userId } = await funded();
  for (const stake of [[5], true, { amount: 5 }, "5 cedis", "", null]) {
    await assert.rejects(playRound(db, userId, "volta-coin", { stake, choice: { pick: "HEADS" }, idempotency_key: key() }),
      (e: unknown) => e instanceof GameError && e.code === "invalid_stake", JSON.stringify(stake));
  }
  const ok = await playRound(db, userId, "volta-coin", { stake: "5", choice: { pick: "HEADS" }, idempotency_key: key() });
  assert.equal(ok.stake, 5, "a numeric string is still fine");
});

test("Conversions to a fraction of a cent are refused cleanly, not a 500", async () => {
  const { db } = await funded();
  await assert.rejects(quoteConversion(db, "GHS", "USD", 10.005), (e: unknown) => (e as { code?: string }).code === "invalid_amount");
});

/* ---------------- rounds left behind ---------------- */

test("Step-game rounds left open for a day are settled: cashed out with progress, refunded without a move", async () => {
  const { db, userId } = await funded();
  /* a Mines round with one star */
  const a = await startSession(db, userId, "volta-mines", { stake: 10, params: { mines: 3 }, idempotency_key: key() });
  const secret = (await db.query(`SELECT secret FROM game_sessions WHERE id = $1`, [a.session_id])).rows[0].secret as { mines: number[] };
  const safe = [...Array(25).keys()].find((t) => !secret.mines.includes(t))!;
  await stepSession(db, userId, "volta-mines", { session_id: a.session_id, move: safe });
  const won = minesGame.payout(10, minesMultipliers(3)[1]!);
  /* a Crossing round with no move, and a Goal round opened an hour ago */
  const b = await startSession(db, userId, "volta-crossing", { stake: 5, params: { level: "easy" }, idempotency_key: key() });
  const c = await startSession(db, userId, "volta-goal", { stake: 2, params: { field: "small" }, idempotency_key: key() });
  assert.equal(await balanceOf(db, userId), 83);
  await db.query(`UPDATE game_sessions SET updated_at = now() - make_interval(secs => $2) WHERE id = ANY($1::uuid[])`,
    [[a.session_id, b.session_id], ABANDONED_AFTER_MS / 1000 + 60]);
  await db.query(`UPDATE game_sessions SET updated_at = now() - interval '1 hour' WHERE id = $1`, [c.session_id]);

  assert.equal(await settleAbandonedSessions(db), 2);
  const status = async (id: string) => (await db.query(`SELECT status, payout FROM game_sessions WHERE id = $1`, [id])).rows[0];
  assert.equal((await status(a.session_id)).status, "WON");
  assert.equal(Number((await status(a.session_id)).payout), won);
  assert.equal((await status(b.session_id)).status, "VOID");
  assert.equal((await status(c.session_id)).status, "OPEN", "a recent round is left alone");
  assert.equal(await balanceOf(db, userId), Math.round((83 + won + 5) * 100) / 100);
  /* settled once: a second sweep, or the player's own late cash-out, changes nothing */
  assert.equal(await settleAbandonedSessions(db), 0);
  await cashOutSession(db, userId, "volta-mines", { session_id: a.session_id });
  assert.equal(await balanceOf(db, userId), Math.round((83 + won + 5) * 100) / 100);
});

test("Live Mines: a bet can't land in a round that has already been settled", async () => {
  const { db, userId } = await funded();
  const R = LIVE_ROUND_MS;
  const now = 3000 * R + 1000;
  await currentLiveRound(db, now);
  await db.query(`UPDATE mines_live_rounds SET settled = true WHERE no = 3000`);
  await assert.rejects(placeLiveBet(db, userId, { round_no: 3000, picks: [0], stake: 1, idempotency_key: key() }, { now }),
    (e: unknown) => e instanceof GameError && e.code === "too_late");
  assert.equal(await balanceOf(db, userId), 100);
});

test("Live Mines: one round that fails to settle doesn't stop the sweep settling the rounds after it", async () => {
  const { db, userId } = await funded();
  const R = LIVE_ROUND_MS;
  const placed: string[] = [];
  for (const no of [4000, 4001]) {
    const now = no * R + 1000;
    await currentLiveRound(db, now);
    const seed = (await db.query(`SELECT seed FROM mines_live_rounds WHERE no = $1`, [no])).rows[0].seed as string;
    const safe = [...Array(25).keys()].filter((t) => !minesFromSeed(seed, no).includes(t));
    const bet = await placeLiveBet(db, userId, { round_no: no, picks: safe.slice(0, 2), stake: 1, idempotency_key: key() }, { now });
    placed.push(bet.bet.bet_id);
  }
  /* round 4000's win key is already taken (the old withdrawal-key collision did exactly this) */
  await db.query(`INSERT INTO ledger_journal (idempotency_key, entry_type, description) VALUES ($1, 'ADJUSTMENT', 'collision')`,
    [`win:live:${placed[0]}`]).catch(async () => {
    await db.query(`INSERT INTO ledger_journal (idempotency_key, entry_type, description, reason) VALUES ($1, 'ADJUSTMENT', 'collision', 'audit test collision')`, [`win:live:${placed[0]}`]);
  });
  await settleDueLiveRounds(db, 4002 * R + 1);
  const rounds = (await db.query(`SELECT no::int AS no, settled FROM mines_live_rounds WHERE no IN (4000, 4001) ORDER BY no`)).rows;
  assert.deepEqual(rounds.map((r) => [r.no, r.settled]), [[4000, false], [4001, true]]);
  void userId;
});

/* ---------------- an admin's recheck of a delayed deposit ---------------- */

test("An admin's recheck credits a delayed deposit once, and leaves an unanswered one waiting", async () => {
  const { recheckDeposit, waitingDeposits } = await import("../src/services/depositRecheck.js");
  const { db, client, userId } = await setupWalletDb();   /* an empty wallet */
  for (const tx of ["000000000101", "000000000102"]) {
    const intent = await createPaymentIntent(client, userId, 150, "GHS", "deposit:" + tx, "https://site/wallet.html");
    await db.query(`UPDATE payment_intents SET transaction_id = $1 WHERE id = $2`, [tx, intent.id]);
  }
  assert.deepEqual((await waitingDeposits(db)).map((d) => d.transaction_id).sort(), ["000000000101", "000000000102"]);
  assert.deepEqual((await waitingDeposits(db)).map((d) => d.reference).sort(), ["DES000000000101", "DES000000000102"]);

  const approved = await gateway(200, { status: "approved", code: "000", amount: "000000015000", reason: "Successful" });
  try {
    assert.equal((await recheckDeposit(db, approved.config, "000000000101", "0209999001")).status, "approved");
    assert.equal(await balanceOf(db, userId), 150);
    assert.equal((await recheckDeposit(db, approved.config, "000000000101", "0209999001")).note, "Already credited");
    assert.equal(await balanceOf(db, userId), 150, "credited once");
  } finally {
    approved.close();
  }
  const silent = await gateway(503, {});
  try {
    assert.equal((await recheckDeposit(db, silent.config, "000000000102", "0209999001")).status, "pending");
    assert.equal(await balanceOf(db, userId), 150);
    assert.deepEqual((await waitingDeposits(db)).map((d) => d.transaction_id), ["000000000102"]);
  } finally {
    silent.close();
  }
  const log = (await db.query(`SELECT action, details->>'verdict' AS verdict FROM admin_actions ORDER BY id`)).rows;
  assert.deepEqual(log.map((r) => [r.action, r.verdict]), [["deposit.recheck", "approved"]]);
});
