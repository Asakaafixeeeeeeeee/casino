import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { selfExclude } from "../src/services/responsibleGaming.js";
import { GameError, secureRandom } from "../src/games/catalog.js";
import {
  CROSSING_LEVELS, crossing, crossingTable, goal, GOAL_FIELDS, goalMultipliers, mines, minesMultipliers,
} from "../src/games/sessionCatalog.js";
import { cashOutSession, openSession, startSession, stepSession } from "../src/games/sessions.js";
import { setupWalletDb } from "./helpers/walletDb.js";

async function funded(amount = 100) {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", amount, "deposit:seed-sessions");
  await env.client.query("COMMIT");
  return env;
}
let keyN = 0;
const key = () => "session:test-" + ++keyN;

/* ---------------- the maths: every cash-out plan returns the disclosed rate ---------------- */

test("Mines: cashing out after k stars returns 96.5% (to the cent), for every mine count, below the top-prize cap", () => {
  for (let m = 1; m <= 24; m++) {
    const t = minesMultipliers(m);
    let p = 1;
    for (let k = 1; k <= 25 - m; k++) {
      p *= (25 - m - (k - 1)) / (25 - (k - 1));
      if (t[k]! > 100000) continue; // the ₵100,000 round cap (as on the page) trims these extreme cash-outs
      const ret = p * mines.payout(1, t[k]!);
      assert.ok(Math.abs(ret - 0.965) < 0.0101, `m=${m} k=${k}: ${ret}`);
    }
  }
});

test("Crossing: the chance of reaching each lane is exactly 97% ÷ its multiplier, and that's what the draw gives", () => {
  for (const level of Object.keys(CROSSING_LEVELS)) {
    const t = crossingTable(level);
    for (let i = 1; i < t.length; i++) assert.ok(t[i]! > t[i - 1]!, `${level} multipliers rise`);
    const N = 200_000;
    const reached = new Array(t.length).fill(0);
    for (let j = 0; j < N; j++) {
      const { fate } = crossing.deal({ level }, () => (j + 0.5) / N);
      for (let i = 0; i < t.length; i++) if (fate === null || fate > i) reached[i]++;
    }
    t.forEach((m, i) => {
      const chance = reached[i] / N;
      assert.ok(Math.abs(chance - 0.97 / m) < 2 / N + 1e-9, `${level} lane ${i}: ${chance} vs ${0.97 / m}`);
      assert.ok((0.97 / m) * crossing.payout(1, m) <= 0.97 + 1e-9, `${level} lane ${i} never returns more than 97%`);
    });
  }
});

test("Goal: getting past k columns has chance ((r−1)/r)^k and returns at most 97%", () => {
  for (const [key, { cols, rows }] of Object.entries(GOAL_FIELDS)) {
    const t = goalMultipliers(key);
    for (let k = 1; k <= cols; k++) {
      const ret = ((rows - 1) / rows) ** k * goal.payout(1, t[k]!);
      assert.ok(ret <= 0.97 + 1e-9 && ret > 0.96, `${key} k=${k}: ${ret}`);
    }
  }
});

test("Boards are dealt fairly: every tile, lane and row is equally likely", () => {
  const counts = new Array(25).fill(0);
  for (let i = 0; i < 40_000; i++) for (const t of mines.deal({ mines: 5 }, secureRandom).mines) counts[t]++;
  counts.forEach((c, i) => assert.ok(Math.abs(c / 40_000 - 0.2) < 0.015, `tile ${i}: ${c / 40_000}`));
  const rows = new Array(5).fill(0);
  for (let i = 0; i < 40_000; i++) rows[goal.deal({ field: "large" }, secureRandom).bombs[3]!]++;
  rows.forEach((c, r) => assert.ok(Math.abs(c / 40_000 - 0.2) < 0.015, `row ${r}: ${c / 40_000}`));
});

/* ---------------- the engine ---------------- */

test("A Mines round: the stake goes at the start, the board stays secret, a cash-out pays once", async () => {
  const { db, userId, balance } = await funded();
  // fixed deal: rng 0 everywhere puts the mines on tiles 1..3 (Fisher–Yates swaps each tile with tile 0)
  const s = await startSession(db, userId, "volta-mines", { stake: 10, params: { mines: 3 }, idempotency_key: key() }, () => 0);
  assert.equal(s.status, "OPEN");
  assert.equal(s.reveal, undefined, "the mines are never sent while the round is open");
  assert.equal(await balance(), 90);
  const mineTiles = (await db.query("SELECT secret FROM game_sessions WHERE id = $1", [s.session_id])).rows[0].secret.mines;
  const safe = [...Array(25).keys()].filter((i) => !mineTiles.includes(i));

  const a = await stepSession(db, userId, "volta-mines", { session_id: s.session_id, move: safe[0] });
  assert.equal(a.status, "OPEN");
  assert.deepEqual(a.state.picked, [safe[0]]);
  assert.equal(a.multiplier, minesMultipliers(3)[1]);
  const b = await stepSession(db, userId, "volta-mines", { session_id: s.session_id, move: safe[1] });
  assert.equal(b.multiplier, minesMultipliers(3)[2]);

  const paid = await cashOutSession(db, userId, "volta-mines", { session_id: s.session_id });
  assert.equal(paid.status, "WON");
  assert.equal(paid.payout, mines.payout(10, minesMultipliers(3)[2]!));
  assert.deepEqual(paid.reveal, { mines: mineTiles });
  assert.equal(await balance(), Math.round((90 + paid.payout) * 100) / 100);

  const again = await cashOutSession(db, userId, "volta-mines", { session_id: s.session_id });
  assert.equal(again.status, "WON");
  assert.equal(await balance(), Math.round((90 + paid.payout) * 100) / 100, "a second cash-out pays nothing");
});

test("Hitting a mine loses the round and shows the board", async () => {
  const { db, userId, balance } = await funded();
  const s = await startSession(db, userId, "volta-mines", { stake: 10, params: { mines: 24 }, idempotency_key: key() });
  const mineTiles: number[] = (await db.query("SELECT secret FROM game_sessions WHERE id = $1", [s.session_id])).rows[0].secret.mines;
  const lost = await stepSession(db, userId, "volta-mines", { session_id: s.session_id, move: mineTiles[0] });
  assert.equal(lost.status, "LOST");
  assert.deepEqual(lost.reveal, { mines: mineTiles });
  assert.equal(await balance(), 90);
  // further moves just report the lost round
  assert.equal((await stepSession(db, userId, "volta-mines", { session_id: s.session_id, move: 0 })).status, "LOST");
  assert.equal(await balance(), 90);
});

test("Crossing all the way pays out by itself at the far side", async () => {
  const { db, userId, balance } = await funded();
  const s = await startSession(db, userId, "volta-crossing", { stake: 1, params: { level: "expert" }, idempotency_key: key() },
    () => 0); // u = 0: never hit
  let st = s;
  const lanes = CROSSING_LEVELS.expert!.lanes;
  for (let i = 0; i < lanes && st.status === "OPEN"; i++) st = await stepSession(db, userId, "volta-crossing", { session_id: s.session_id });
  assert.equal(st.status, "WON");
  assert.equal(st.payout, crossing.payout(1, crossingTable("expert")[lanes - 1]!));
  assert.equal(await balance(), Math.round((99 + st.payout) * 100) / 100);
});

test("A round stops by itself at the top prize", async () => {
  const { db, userId, balance } = await funded(20000);
  // 24 mines: one star is 24.13x, so a ₵10,000 stake reaches the ₵100,000 cap on the first star
  const s = await startSession(db, userId, "volta-mines", { stake: 10000, params: { mines: 24 }, idempotency_key: key() });
  const mineTiles: number[] = (await db.query("SELECT secret FROM game_sessions WHERE id = $1", [s.session_id])).rows[0].secret.mines;
  const safe = [...Array(25).keys()].find((i) => !mineTiles.includes(i))!;
  const st = await stepSession(db, userId, "volta-mines", { session_id: s.session_id, move: safe });
  assert.equal(st.status, "WON");
  assert.equal(st.payout, 100000);
  assert.equal(await balance(), 110000);
});

test("One round in progress per game; a retried start returns the same round; it can be resumed", async () => {
  const { db, userId, balance } = await funded();
  const k = key();
  const s = await startSession(db, userId, "volta-goal", { stake: 5, params: { field: "small" }, idempotency_key: k });
  const retried = await startSession(db, userId, "volta-goal", { stake: 5, params: { field: "small" }, idempotency_key: k });
  assert.equal(retried.session_id, s.session_id);
  assert.equal(await balance(), 95, "charged once");
  await assert.rejects(() => startSession(db, userId, "volta-goal", { stake: 5, params: { field: "small" }, idempotency_key: key() }),
    (e: unknown) => e instanceof GameError && e.code === "round_open");
  assert.equal((await openSession(db, userId, "volta-goal"))?.session_id, s.session_id);
  assert.equal(await openSession(db, userId, "volta-mines"), null);
});

test("No cash-out before the first move; no moves in someone else's round", async () => {
  const env = await funded();
  const s = await startSession(env.db, env.userId, "volta-crossing", { stake: 2, params: { level: "easy" }, idempotency_key: key() });
  await assert.rejects(() => cashOutSession(env.db, env.userId, "volta-crossing", { session_id: s.session_id }),
    (e: unknown) => e instanceof GameError && e.code === "too_early");
  const { ensureWalletAccount } = await import("../src/services/accountLink.js");
  const other = await ensureWalletAccount(env.db, "account-2", "other");
  await assert.rejects(() => stepSession(env.db, other, "volta-crossing", { session_id: s.session_id }),
    (e: unknown) => e instanceof GameError && e.status === 404);
  await assert.rejects(() => cashOutSession(env.db, env.userId, "volta-crossing", { session_id: "x" }),
    (e: unknown) => e instanceof GameError && e.status === 404, "a malformed id is a 404, not a database error");
});

test("Bad bets, settings and moves are refused; players on a break can't start", async () => {
  const { db, userId } = await funded();
  const bad = (game: string, body: Record<string, unknown>) =>
    assert.rejects(() => startSession(db, userId, game, { idempotency_key: key(), ...body }), GameError);
  await bad("volta-mines", { stake: 1, params: { mines: 25 } });
  await bad("volta-mines", { stake: 0.01, params: { mines: 3 } });
  await bad("volta-crossing", { stake: 1, params: { level: "insane" } });
  await bad("volta-goal", { stake: 1, params: { field: "huge" } });
  await bad("volta-mines", { stake: 500, params: { mines: 3 } }); // more than the balance
  const s = await startSession(db, userId, "volta-goal", { stake: 1, params: { field: "small" }, idempotency_key: key() });
  await assert.rejects(() => stepSession(db, userId, "volta-goal", { session_id: s.session_id, move: 9 }), GameError);
  await cashOutSession(db, userId, "volta-goal", { session_id: s.session_id }).catch(() => undefined);
  await selfExclude(db, userId, 1);
  await bad("volta-mines", { stake: 1, params: { mines: 3 } });
});
