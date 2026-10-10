/* Magic Ball Live's engine with the clock under test control (node:test mock timers): rounds follow the clock, the
   hidden spot is the same for everyone and secret until the reveal, bets close on the server's time, and every bet is
   settled once against the round's one result. */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../shared/gameConstants");
const database = require("../server/database");
const { createWallet } = require("../server/wallet");
const { createEngine } = require("../server/gameEngine");

const ROUND = 9_000_000;                       /* a round number, so its start time is ROUND × ROUND_MS */
const start = ROUND * C.ROUND_MS;

async function table(at) {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: at });
  const db = await database.open();
  const wallet = createWallet(db);
  const engine = createEngine(db, wallet);
  await engine.start();
  return { db, wallet, engine };
}
const run = async (ms) => { mock.timers.tick(ms); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

test("Everyone gets the same round, its hidden spot withheld until the cups lift", async (t) => {
  t.after(() => mock.timers.reset());
  const { engine } = await table(start + 10_000);
  const r = engine.current();
  assert.equal(r.roundId, "ROUND-" + ROUND);
  assert.equal(r.startTime, start);
  assert.equal(r.endTime, start + C.ROUND_MS);
  const before = engine.publicRound(r, start + 10_000);
  assert.equal(before.state, "BETTING");
  assert.equal("hiddenPosition" in before, false);
  assert.equal("seed" in before, false);
  assert.match(before.seedHash, /^[0-9a-f]{64}$/);
  const after = engine.publicRound(r, r.revealTime + 1);
  assert.ok([1, 2, 3].includes(after.hiddenPosition));
  assert.equal(after.hiddenPosition, r.hiddenPosition, "the same spot for every caller");
  engine.stop();
});

test("Bets are checked on the server's clock: closed at the cutoff, one per player, cleared for a refund", async (t) => {
  t.after(() => mock.timers.reset());
  const { engine, wallet } = await table(start + 5_000);
  await assert.rejects(engine.placeBet("p1-aaaaaaaa", 4, 10), /Spot 1, 2 or 3/);
  await assert.rejects(engine.placeBet("p1-aaaaaaaa", 1, 0.5), /credits/);
  await assert.rejects(engine.placeBet("p1-aaaaaaaa", 1, C.MAX_BET + 1), /credits/);
  await engine.placeBet("p1-aaaaaaaa", 2, 100);
  await assert.rejects(engine.placeBet("p1-aaaaaaaa", 3, 10), /already have a bet/);
  assert.equal(await wallet.balance("p1-aaaaaaaa"), C.START_BALANCE - 100);
  await engine.clearBet("p1-aaaaaaaa");
  assert.equal(await wallet.balance("p1-aaaaaaaa"), C.START_BALANCE);
  mock.timers.setTime(start + C.BETTING_MS - 200);   /* the last half-second before betting closes */
  await assert.rejects(engine.placeBet("p1-aaaaaaaa", 1, 10), /closed/);
  mock.timers.setTime(start + C.BETTING_MS + 1000);
  await assert.rejects(engine.placeBet("p1-aaaaaaaa", 1, 10), /closed/);
  engine.stop();
});

test("At the reveal every bet is judged against the one hidden spot, winners paid 2.9x once", async (t) => {
  t.after(() => mock.timers.reset());
  const { engine, wallet, db } = await table(start + 1_000);
  const players = ["s1-aaaaaaaa", "s2-bbbbbbbb", "s3-cccccccc"];
  for (const [i, p] of players.entries()) await engine.placeBet(p, i + 1, 100);   /* one player on each spot */
  const hidden = engine.current().hiddenPosition;
  mock.timers.setTime(start + C.BETTING_MS + C.SHUFFLE_MS + 10);
  await run(300);                                   /* the engine's tick notices the reveal and settles */
  for (const [i, p] of players.entries()) {
    const want = i + 1 === hidden ? C.START_BALANCE - 100 + 100 * C.PAYOUT : C.START_BALANCE - 100;
    assert.equal(await wallet.balance(p), Math.round(want * 100) / 100, `spot ${i + 1} (ball under ${hidden})`);
  }
  const bets = await db.listBets("ROUND-" + ROUND);
  assert.deepEqual(bets.map((b) => b.result).sort(), ["LOSE", "LOSE", "WIN"]);
  await run(1000);                                  /* later ticks don't pay again */
  for (const [i, p] of players.entries()) {
    const want = i + 1 === hidden ? C.START_BALANCE - 100 + 100 * C.PAYOUT : C.START_BALANCE - 100;
    assert.equal(await wallet.balance(p), Math.round(want * 100) / 100, "paid once");
  }
  assert.equal(engine.history()[0].hiddenPosition, hidden);
  engine.stop();
});
