import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { selfExclude } from "../src/services/responsibleGaming.js";
import { GameError } from "../src/games/catalog.js";
import {
  cancelLiveBet, currentLiveRound, LIVE_CUTOFF_MS, LIVE_MULT, LIVE_ROUND_MS, liveRound, livePayout, minesFromSeed, myLiveBet,
  placeLiveBet, settleDueLiveRounds,
} from "../src/games/minesLive.js";
import { setupWalletDb } from "./helpers/walletDb.js";

async function funded(amount = 100) {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", amount, "deposit:seed-live");
  await env.client.query("COMMIT");
  return env;
}
let keyN = 0;
const key = () => "live:test-" + ++keyN;
const R = LIVE_ROUND_MS;

/* ---------------- the maths ---------------- */

test("The live server and the balance service draw the same mines and pay the same multipliers", () => {
  const live = createRequire(import.meta.url)("../../mines-live/maths.js") as {
    MULT: number[]; minesFromSeed(seed: string, round: number): number[];
  };
  assert.deepEqual(LIVE_MULT, live.MULT);
  for (let i = 0; i < 300; i++) {
    const seed = crypto.randomBytes(32).toString("hex");
    const no = crypto.randomInt(1, 2 ** 40);
    assert.deepEqual(minesFromSeed(seed, no), live.minesFromSeed(seed, no));
  }
});

test("Every number of tiles returns 96.5%, to the cent", () => {
  let p = 1;
  for (let k = 1; k <= 19; k++) {
    p *= (19 - (k - 1)) / (25 - (k - 1));
    // rounding the multiplier to the cent moves the return by at most half a cent × the chance
    assert.ok(Math.abs(p * LIVE_MULT[k]! - 0.965) <= 0.005 * p + 1e-12, `k=${k}: ${p * LIVE_MULT[k]!}`);
  }
  assert.deepEqual(LIVE_MULT.slice(1, 6), [1.27, 1.69, 2.29, 3.15, 4.41]);
  assert.equal(livePayout(100, 19), 10_000, "a win is capped at GHS 10,000");
});

test("Mines land evenly on every tile", () => {
  const counts = new Array(25).fill(0);
  const N = 20_000;
  for (let i = 0; i < N; i++) for (const t of minesFromSeed(crypto.randomBytes(32).toString("hex"), i)) counts[t]++;
  counts.forEach((c, t) => assert.ok(Math.abs(c / N - 6 / 25) < 0.015, `tile ${t}: ${c / N}`));
});

/* ---------------- the rounds and bets ---------------- */

test("A round follows the clock; its seed stays secret until 0:00, then matches the hash", async () => {
  const { db } = await funded();
  const now = 1000 * R + 5000;
  const a = await currentLiveRound(db, now);
  const b = await currentLiveRound(db, now + 60_000);
  assert.equal(a.no, 1000);
  assert.equal(a.ends_at, 1001 * R);
  assert.equal(a.hash, b.hash, "the same round for everyone");
  assert.equal(a.seed, undefined);
  assert.equal((await liveRound(db, 1000, now)).seed, undefined);
  const after = await liveRound(db, 1000, 1001 * R);
  assert.equal(crypto.createHash("sha256").update(after.seed!).digest("hex"), a.hash);
  assert.deepEqual(after.mine_tiles, minesFromSeed(after.seed!, 1000));
  await assert.rejects(() => liveRound(db, 1002, now), (e: unknown) => e instanceof GameError && e.status === 404, "no peeking ahead");
});

test("A bet: stake taken at once, paid at 0:00 if every tile is a star — or lost on a mine", async () => {
  const { db, userId, balance } = await funded();
  const now = 2000 * R + 1000;
  await currentLiveRound(db, now);
  const seed = (await db.query("SELECT seed FROM mines_live_rounds WHERE no = 2000")).rows[0].seed as string;
  const mines = minesFromSeed(seed, 2000);
  const safe = [...Array(25).keys()].filter((t) => !mines.includes(t));
  const placed = await placeLiveBet(db, userId, { round_no: 2000, picks: safe.slice(0, 3), stake: 10, idempotency_key: key() }, { now });
  assert.equal(placed.balance, 90);
  assert.equal(placed.bet.status, "OPEN");
  assert.equal((await myLiveBet(db, userId, 2000, now)).bet!.status, "OPEN", "no result before 0:00");

  const done = await myLiveBet(db, userId, 2000, 2001 * R);
  assert.equal(done.bet!.status, "WON");
  assert.equal(done.bet!.win, livePayout(10, 3));
  assert.deepEqual(done.bet!.hit, []);
  assert.equal(await balance(), Math.round((90 + livePayout(10, 3)) * 100) / 100);
  await myLiveBet(db, userId, 2000, 2001 * R + 10);
  assert.equal(await balance(), Math.round((90 + livePayout(10, 3)) * 100) / 100, "paid once");

  // the next round: a bet with a mine in it loses
  const now2 = 2001 * R + 1000;
  await currentLiveRound(db, now2);
  const seed2 = (await db.query("SELECT seed FROM mines_live_rounds WHERE no = 2001")).rows[0].seed as string;
  const mine = minesFromSeed(seed2, 2001)[0]!;
  const before = await balance();
  await placeLiveBet(db, userId, { round_no: 2001, picks: [mine], stake: 5, idempotency_key: key() }, { now: now2 });
  assert.equal(await settleDueLiveRounds(db, 2002 * R), 1, "the sweep settles a round nobody asked about");
  const lost = await myLiveBet(db, userId, 2001, 2002 * R);
  assert.equal(lost.bet!.status, "LOST");
  assert.deepEqual(lost.bet!.hit, [mine]);
  assert.equal(await balance(), Math.round((before - 5) * 100) / 100);
});

test("One bet a round; cancel for the stake back until the last 10 seconds; nothing after", async () => {
  const { db, userId, balance } = await funded();
  const now = 3000 * R + 1000;
  const k = key();
  const a = await placeLiveBet(db, userId, { round_no: 3000, picks: [4, 9], stake: 2, idempotency_key: k }, { now });
  const again = await placeLiveBet(db, userId, { round_no: 3000, picks: [4, 9], stake: 2, idempotency_key: k }, { now });
  assert.equal(again.bet.bet_id, a.bet.bet_id, "a retried bet is the same bet");
  await assert.rejects(() => placeLiveBet(db, userId, { round_no: 3000, picks: [1], stake: 1, idempotency_key: key() }, { now }),
    (e: unknown) => e instanceof GameError && e.code === "already_bet");
  const back = await cancelLiveBet(db, userId, { bet_id: a.bet.bet_id }, { now: now + 1000 });
  assert.equal(back.bet.status, "VOID");
  assert.equal(await balance(), 100);
  // after a cancel a new bet is allowed
  const b = await placeLiveBet(db, userId, { round_no: 3000, picks: [1], stake: 1, idempotency_key: key() }, { now: now + 2000 });
  const late = 3001 * R - LIVE_CUTOFF_MS + 1;
  await assert.rejects(() => cancelLiveBet(db, userId, { bet_id: b.bet.bet_id }, { now: late }),
    (e: unknown) => e instanceof GameError && e.code === "too_late");
  await assert.rejects(() => placeLiveBet(db, userId, { round_no: 3000, picks: [2], stake: 1, idempotency_key: key() }, { now: late }),
    GameError);
});

test("Bad bets, old rounds and players on a break are refused", async () => {
  const { db, userId } = await funded();
  const now = 4000 * R + 1000;
  const bad = (body: Record<string, unknown>) =>
    assert.rejects(() => placeLiveBet(db, userId, { round_no: 4000, picks: [1, 2], stake: 1, idempotency_key: key(), ...body }, { now }), GameError);
  await bad({ round_no: 3999 });
  await bad({ picks: [] });
  await bad({ picks: [1, 1] });
  await bad({ picks: [25] });
  await bad({ picks: [...Array(20).keys()] });
  await bad({ stake: 0.05 });
  await bad({ stake: 101 });
  await bad({ stake: 500 }); // over the limit, and over the balance
  await selfExclude(db, userId, 1);
  await assert.rejects(() => placeLiveBet(db, userId, { round_no: 4000, picks: [1], stake: 1, idempotency_key: key() }, { now }),
    (e: unknown) => e instanceof GameError && e.status === 403);
});
