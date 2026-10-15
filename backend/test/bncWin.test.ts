import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { GameError } from "../src/games/catalog.js";
import { BNC, bncPath, bncRace, bncState, cashOutBnc, cashValue, raceEnd, scores, settleDueBnc, startBncRace } from "../src/games/bncWin.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const code = (c: string) => (e: unknown) => e instanceof GameError && e.code === c;
let n = 0;
const key = () => "bnc:test-" + ++n;
const T0 = Date.UTC(2027, 0, 5, 12, 0);
/* a seed whose race has no break-away in the first `upTo` steps (found by search, so the test is deterministic) */
function seedWhere(ok: (path: string[]) => boolean): string {
  for (let i = 0; i < 100000; i++) { const s = "seed-" + i; if (ok(bncPath(s))) return s; }
  throw new Error("no seed");
}

async function player(amount = 1000) {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", amount, "deposit:bnc-seed");
  await env.client.query("COMMIT");
  const ledger = async () => (await env.db.query(`SELECT j.entry_type, e.amount FROM ledger_entries e JOIN ledger_journal j ON j.id = e.journal_id
    WHERE e.user_id = $1 ORDER BY e.id`, [env.userId])).rows.map((r) => [r.entry_type, Number(r.amount)]);
  const drift = async () => (await env.db.query(`SELECT * FROM balance_reconciliation`)).rows.length;
  return { ...env, ledger, drift };
}

test("BNC WIN maths: every step is balanced, so the return is 97% whenever the player cashes out", () => {
  const q = BNC.upChance;
  assert.ok(Math.abs(q * BNC.up + (1 - BNC.bust - q) * BNC.down - 1) < 1e-12, "a step is fair before the 97%");
  /* simulate many races and three cash-out plans: their average return is the RTP (within sampling error) */
  const plans = { finish: (_x: number, k: number) => k === BNC.steps, early: (_x: number, k: number) => k === 6, greedy: (x: number) => x >= 1.6 };
  for (const [name, stop] of Object.entries(plans)) {
    let paid = 0;
    const N = 60000;
    for (let i = 0; i < N; i++) {
      const { xs, bustAt } = scores(bncPath(crypto.randomBytes(8).toString("hex")));
      for (let k = 1; k <= BNC.steps; k++) {
        if (bustAt === k) break;
        if (stop(xs[k]!, k) || k === BNC.steps) { paid += BNC.rtp * xs[k]!; break; }
      }
    }
    assert.ok(Math.abs(paid / N - BNC.rtp) < 0.02, `${name}: returned ${(paid / N).toFixed(4)}`);
  }
});

test("BNC WIN: GO takes the stake once; the same key is the same race; one race at a time", async () => {
  const p = await player();
  const k = key();
  const a = await startBncRace(p.db, p.userId, { stake: 500, idempotency_key: k }, { now: T0 });
  assert.equal(a.balance, 500);
  assert.equal(a.race.status, "ACTIVE");
  assert.equal(a.race.hash, crypto.createHash("sha256").update((await p.db.query(`SELECT seed FROM bnc_races`)).rows[0].seed).digest("hex"));
  assert.equal(a.race.seed, undefined, "the seed stays secret while the race runs");
  const again = await startBncRace(p.db, p.userId, { stake: 500, idempotency_key: k }, { now: T0 + 100 });
  assert.equal(again.race.race_id, a.race.race_id);
  assert.equal(again.balance, 500, "charged once");
  await assert.rejects(startBncRace(p.db, p.userId, { stake: 5, idempotency_key: key() }, { now: T0 + 200 }), code("race_running"));
  await assert.rejects(startBncRace(p.db, p.userId, { stake: 0.5, idempotency_key: key() }, { now: T0 }), code("invalid_stake"));
  await assert.rejects(startBncRace(p.db, p.userId, { stake: 5000, idempotency_key: key() }, { now: T0 }), code("invalid_stake"));
});

test("BNC WIN: the page only ever sees the steps that have happened", async () => {
  const p = await player();
  const seed = seedWhere((s) => !s.slice(0, 20).includes("B"));
  const { race } = await startBncRace(p.db, p.userId, { stake: 10, idempotency_key: key() }, { now: T0, seed });
  const at = (ms: number) => bncRace(p.db, p.userId, race.race_id, T0 + BNC.startMs + ms);
  assert.equal((await at(-1000)).race.xs.length, 1, "nothing before the start");
  const mid = (await at(7 * BNC.stepMs + 100)).race;
  assert.equal(mid.step, 7);
  assert.equal(mid.xs.length, 8);
  assert.deepEqual(mid.xs.map((x) => Math.round(x * 1e6)), scores(bncPath(seed)).xs.slice(0, 8).map((x) => Math.round(x * 1e6)));
  assert.equal(mid.value, cashValue(10, scores(bncPath(seed)).xs[7]!));
});

test("BNC WIN: CASH OUT pays the value when the server receives it, exactly once", async () => {
  const p = await player();
  const seed = seedWhere((s) => !s.slice(0, 20).includes("B"));
  const { race } = await startBncRace(p.db, p.userId, { stake: 500, idempotency_key: key() }, { now: T0, seed });
  await assert.rejects(cashOutBnc(p.db, p.userId, { race_id: race.race_id }, T0 + 1000), code("not_started"));
  const when = T0 + BNC.startMs + 10 * BNC.stepMs + 250;
  const x10 = scores(bncPath(seed)).xs[10]!;
  const out = await cashOutBnc(p.db, p.userId, { race_id: race.race_id }, when);
  assert.equal(out.race.status, "CASHED");
  assert.equal(out.race.payout, cashValue(500, x10));
  assert.equal(out.race.seed, seed, "the seed is shown once it's over");
  const twice = await cashOutBnc(p.db, p.userId, { race_id: race.race_id }, when + 2000);
  assert.equal(twice.race.payout, out.race.payout);
  assert.equal(twice.balance, out.balance, "paid once");
  assert.equal(out.balance, Math.round((500 + out.race.payout) * 100) / 100);
  const wins = (await p.ledger()).filter(([t]) => t === "BET_SETTLED");
  assert.equal(wins.length, 1);
  assert.equal(await p.drift(), 0);
  /* someone else's race */
  await assert.rejects(cashOutBnc(p.db, "00000000-0000-0000-0000-000000000000", { race_id: race.race_id }, when), code("not_found"));
});

test("BNC WIN: red breaking away ends the race and the stake is lost; a race left alone is settled at the end", async () => {
  const p = await player();
  const bustSeed = seedWhere((s) => s.indexOf("B") >= 3 && s.indexOf("B") < 30);
  const bustAt = bncPath(bustSeed).indexOf("B") + 1;
  const a = await startBncRace(p.db, p.userId, { stake: 100, idempotency_key: key() }, { now: T0, seed: bustSeed });
  const late = await cashOutBnc(p.db, p.userId, { race_id: a.race.race_id }, T0 + BNC.startMs + bustAt * BNC.stepMs + 10);
  assert.equal(late.race.status, "BUSTED", "too late: red broke away first");
  assert.equal(late.race.payout, 0);
  assert.equal(late.balance, 900);

  /* a race nobody watches is paid at the finish by the sweep */
  const finSeed = seedWhere((s) => !s.includes("B"));
  const end = raceEnd(bncPath(finSeed), 50);
  const b = await startBncRace(p.db, p.userId, { stake: 50, idempotency_key: key() }, { now: T0 + 60000, seed: finSeed });
  assert.equal(await settleDueBnc(p.db, T0 + 60000 + BNC.startMs + 10 * BNC.stepMs), 0, "not over yet");
  assert.equal(await settleDueBnc(p.db, T0 + 60000 + BNC.startMs + BNC.steps * BNC.stepMs + 5), 1);
  const st = await bncState(p.db, p.userId, T0 + 200000);
  assert.equal(st.race, null);
  assert.equal(st.history[0]!.race_id, b.race.race_id);
  assert.equal(st.history[0]!.status, "FINISHED");
  assert.equal(st.history[0]!.payout, cashValue(50, end.x));
  assert.equal(await p.drift(), 0);
});
