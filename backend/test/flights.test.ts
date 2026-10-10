import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { selfExclude } from "../src/services/responsibleGaming.js";
import { GameError, secureRandom } from "../src/games/catalog.js";
import {
  cancelFlightBet, capOf, cashOutFlightBet, colours, crashPoint, FLIGHT_GAMES, flightMs, judge, MAX_CRASH, multiplierAt,
  nextFlight, placeFlightBet, settleDueFlights, WAIT_MS, waitFlight,
} from "../src/games/flights.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const crash = FLIGHT_GAMES["volta-crash"]!;
const knockout = FLIGHT_GAMES["volta-knockout"]!;
const jet = FLIGHT_GAMES["volta-jet"]!;

async function funded(amount = 100) {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", amount, "deposit:seed-flights");
  await env.client.query("COMMIT");
  return env;
}
let keyN = 0;
const key = () => "flight:test-" + ++keyN;
/** an rng that draws crash point x: crashPoint floors 100·RTP ÷ (1 − u), so u = 1 − 100·RTP ÷ (100x + 0.5) */
const drawing = (rtp: number, x: number) => () => 1 - (100 * rtp) / (100 * x + 0.5);

/* ---------------- the maths ---------------- */

test("The crash point reaches m with chance RTP ÷ m, for both games", () => {
  for (const game of [crash, knockout]) {
    const N = 400_000;
    const marks = [1.01, 1.5, 2, 3.33, 10, 100];
    const reached = marks.map(() => 0);
    for (let j = 0; j < N; j++) {
      const x = crashPoint(game.rtp, () => (j + 0.5) / N);
      marks.forEach((m, i) => { if (x >= m) reached[i] = reached[i]! + 1; });
    }
    marks.forEach((m, i) =>
      assert.ok(Math.abs(reached[i]! / N - game.rtp / m) < 2 / N + 1e-9, `${game.id} ${m}x: ${reached[i]! / N} vs ${game.rtp / m}`));
    assert.equal(crashPoint(game.rtp, () => 0.999999999999), MAX_CRASH);
    assert.equal(crashPoint(game.rtp, () => 0), 1);
  }
});

test("ColorGo pays what the Knockout page shows, and each colour returns at most the RTP", () => {
  const c = colours(knockout.rtp);
  assert.deepEqual([c.blue.pay, c.purple.pay, c.red.pay], [1.88, 2.5, 10]);
  const chance = { blue: 1 - knockout.rtp / 2, purple: knockout.rtp / 2 - knockout.rtp / 10, red: knockout.rtp / 10 };
  for (const k of ["blue", "purple", "red"] as const) assert.ok(chance[k] * c[k].pay <= knockout.rtp + 1e-9, k);
  assert.ok(c.blue.test(1) && c.blue.test(1.99) && c.purple.test(2) && c.purple.test(9.99) && c.red.test(10));
});

test("The multiplier climbs on the clock exactly as on the page", () => {
  assert.equal(multiplierAt(0), 1);
  assert.equal(multiplierAt(flightMs(2) - 1), 1.99);
  assert.equal(multiplierAt(flightMs(2) + 1), 2);
  assert.ok(Math.abs(flightMs(2) - 5776) < 1);
});

test("Judging a bet: manual cash-outs, auto cash-outs, the top-prize cap and colours", () => {
  const f = { crash: 3, startsAt: 0 };
  const classic = (auto: number | null, stake = 10) => ({ stake, kind: "classic" as const, auto });
  const t = (x: number) => flightMs(x);
  // manual: the multiplier at the moment it arrives, while the round lasts; nothing once it's over
  assert.deepEqual(judge(crash, classic(null), f, t(2) + 1, true), { status: "WON", x: 2 });
  assert.deepEqual(judge(crash, classic(null), f, t(3), true), { status: "LOST" });
  assert.deepEqual(judge(crash, classic(null), f, t(2.5), false), { status: "ACTIVE" }, "nothing is decided early");
  // auto: paid at the target if the round got there, even when asked late or after the end
  assert.deepEqual(judge(crash, classic(2), f, t(2.5), true), { status: "WON", x: 2 });
  assert.deepEqual(judge(crash, classic(2), f, t(50), false), { status: "WON", x: 2 });
  assert.deepEqual(judge(crash, classic(3), f, t(3), false), { status: "WON", x: 3 }, "a target equal to the crash wins");
  assert.deepEqual(judge(crash, classic(3.01), f, t(3), false), { status: "LOST" });
  assert.deepEqual(judge(crash, classic(2), f, t(1.5), true), { status: "WON", x: 1.5 }, "pressed before the target");
  // the cap: GHS 1,000 cashes itself out at 250x (= GHS 250,000)
  assert.equal(capOf(1000), 250);
  assert.deepEqual(judge(crash, classic(null, 1000), { crash: 400, startsAt: 0 }, t(260), false), { status: "WON", x: 250 });
  // colours: decided at the knockout; red as soon as 10x is passed
  const colour = (kind: "blue" | "purple" | "red") => ({ stake: 1, kind, auto: null });
  assert.deepEqual(judge(knockout, colour("blue"), { crash: 1.5, startsAt: 0 }, t(1.5), false), { status: "WON", x: 1.88 });
  assert.deepEqual(judge(knockout, colour("purple"), { crash: 1.5, startsAt: 0 }, t(1.5), false), { status: "LOST" });
  assert.deepEqual(judge(knockout, colour("purple"), { crash: 5, startsAt: 0 }, t(4), false), { status: "ACTIVE" });
  assert.deepEqual(judge(knockout, colour("red"), { crash: 40, startsAt: 0 }, t(10), false), { status: "WON", x: 10 });
  assert.deepEqual(judge(knockout, colour("red"), { crash: 9.99, startsAt: 0 }, t(9.99), false), { status: "LOST" });
});

test("A 2x auto cash-out over a million secure rounds returns about the RTP", () => {
  for (const game of [crash, knockout]) {
    let paid = 0;
    const N = 1_000_000;
    for (let i = 0; i < N; i++) if (crashPoint(game.rtp, secureRandom) >= 2) paid += 2;
    assert.ok(Math.abs(paid / N - game.rtp) < 0.006, `${game.id}: ${paid / N}`);
  }
});

/* ---------------- the engine, on a clock we control ---------------- */

test("A round: bet before take-off, cash out mid-flight at the server's multiplier, paid once", async () => {
  const { db, userId, balance } = await funded();
  const T0 = 1_000_000;
  const f = await nextFlight(db, userId, "volta-crash", { now: T0, rng: drawing(crash.rtp, 5) });
  assert.equal(f.starts_in_ms, WAIT_MS);
  assert.equal(f.over, false);
  assert.equal(f.crash, undefined, "the crash point stays secret");
  const { bet, balance: after } = await placeFlightBet(db, userId, "volta-crash",
    { flight_id: f.flight_id, panel: 0, stake: 10, idempotency_key: key() }, { now: T0 + 1000 });
  assert.equal(after, 90);
  assert.equal(bet.status, "ACTIVE");

  const start = T0 + WAIT_MS;
  const paid = await cashOutFlightBet(db, userId, "volta-crash", { bet_id: bet.bet_id }, { now: start + flightMs(2.5) + 1 });
  assert.equal(paid.bet.status, "WON");
  assert.equal(paid.bet.x, 2.5);
  assert.equal(paid.bet.payout, 25);
  assert.equal(paid.crash, undefined, "still flying: the crash point isn't told");
  assert.equal(await balance(), 115);
  const again = await cashOutFlightBet(db, userId, "volta-crash", { bet_id: bet.bet_id }, { now: start + flightMs(4) });
  assert.equal(again.bet.payout, 25);
  assert.equal(await balance(), 115, "a second press pays nothing");

  // while it's going, next returns the same round (a reload carries on); after the crash a new one opens
  assert.equal((await nextFlight(db, userId, "volta-crash", { now: start + 100 })).flight_id, f.flight_id);
  const n = await nextFlight(db, userId, "volta-crash", { now: start + flightMs(5) + 1 });
  assert.notEqual(n.flight_id, f.flight_id);
  assert.deepEqual(n.history, [5]);
});

test("Too late is too late: a cash-out after the crash loses, a bet after take-off is refused", async () => {
  const { db, userId, balance } = await funded();
  const T0 = 2_000_000;
  const f = await nextFlight(db, userId, "volta-crash", { now: T0, rng: drawing(crash.rtp, 1.8) });
  const { bet } = await placeFlightBet(db, userId, "volta-crash",
    { flight_id: f.flight_id, panel: 1, stake: 5, idempotency_key: key() }, { now: T0 });
  await assert.rejects(() => placeFlightBet(db, userId, "volta-crash",
    { flight_id: f.flight_id, panel: 0, stake: 5, idempotency_key: key() }, { now: T0 + WAIT_MS }),
    (e: unknown) => e instanceof GameError && e.code === "too_late");
  const lost = await cashOutFlightBet(db, userId, "volta-crash", { bet_id: bet.bet_id }, { now: T0 + WAIT_MS + flightMs(1.8) });
  assert.equal(lost.bet.status, "LOST");
  assert.equal(lost.crash, 1.8, "once it's over the page is told where it crashed");
  assert.equal(await balance(), 95);
});

test("Cancelling before take-off returns the stake; after take-off it can't be cancelled", async () => {
  const { db, userId, balance } = await funded();
  const T0 = 3_000_000;
  const f = await nextFlight(db, userId, "volta-knockout", { now: T0, rng: drawing(knockout.rtp, 3) });
  const a = await placeFlightBet(db, userId, "volta-knockout", { flight_id: f.flight_id, panel: 0, stake: 4, idempotency_key: key() }, { now: T0 });
  const b = await placeFlightBet(db, userId, "volta-knockout", { flight_id: f.flight_id, panel: 1, stake: 6, idempotency_key: key() }, { now: T0 });
  assert.equal(await balance(), 90);
  const back = await cancelFlightBet(db, userId, "volta-knockout", { bet_id: a.bet.bet_id }, { now: T0 + 4000 });
  assert.equal(back.bet.status, "CANCELLED");
  assert.equal(back.balance, 94);
  await cancelFlightBet(db, userId, "volta-knockout", { bet_id: a.bet.bet_id }, { now: T0 + 4100 });
  assert.equal(await balance(), 94, "refunded once");
  await assert.rejects(() => cancelFlightBet(db, userId, "volta-knockout", { bet_id: b.bet.bet_id }, { now: T0 + WAIT_MS }),
    (e: unknown) => e instanceof GameError && e.code === "too_late");
  // the slot is free again after a cancel
  const again = await placeFlightBet(db, userId, "volta-knockout", { flight_id: f.flight_id, panel: 0, stake: 1, idempotency_key: key() }, { now: T0 + 4200 });
  assert.equal(again.bet.status, "ACTIVE");
});

test("Waiting for the end settles auto cash-outs and colours, even for a player who left", async () => {
  const { db, userId, balance } = await funded();
  let clock = 4_000_000;
  const f = await nextFlight(db, userId, "volta-knockout", { now: clock, rng: drawing(knockout.rtp, 12.5) });
  const bet = (panel: number, extra: Record<string, unknown>) =>
    placeFlightBet(db, userId, "volta-knockout", { flight_id: f.flight_id, panel, stake: 10, idempotency_key: key(), ...extra }, { now: clock });
  await bet(0, { auto: 3 });       // 3x comes in: 30
  await bet(1, { kind: "red" });   // ends at 12.5x: red pays 10x = 100
  assert.equal(await balance(), 80);

  // the long poll: held until the end, then the crash point and every result
  const sleep = async (ms: number) => { clock += ms; };
  const early = await waitFlight(db, userId, "volta-knockout", f.flight_id, { clock: () => clock, sleep, maxWaitMs: 10_000 });
  assert.equal(early.over, false);
  assert.equal(early.crash, undefined);
  const done = await waitFlight(db, userId, "volta-knockout", f.flight_id, { clock: () => clock, sleep });
  assert.equal(done.over, true);
  assert.equal(done.crash, 12.5);
  assert.deepEqual(done.bets.map((b) => [b.status, b.x, b.payout]), [["WON", 3, 30], ["WON", 10, 100]]);
  assert.equal(done.balance, 210);

  // a player who closed the page: the sweep settles their round
  const g = await nextFlight(db, userId, "volta-crash", { now: clock, rng: drawing(crash.rtp, 2.2) });
  await placeFlightBet(db, userId, "volta-crash", { flight_id: g.flight_id, panel: 0, stake: 10, auto: 2, idempotency_key: key() }, { now: clock });
  await placeFlightBet(db, userId, "volta-crash", { flight_id: g.flight_id, panel: 1, stake: 10, idempotency_key: key() }, { now: clock });
  assert.equal(await settleDueFlights(db, clock + WAIT_MS + 1000), 0, "nothing due before the end");
  assert.equal(await settleDueFlights(db, clock + WAIT_MS + flightMs(2.2) + 5), 1);
  assert.equal(await balance(), 210 - 20 + 20, "the auto cash-out at 2x paid 20; the manual bet was lost");
});

test("The page's auto check is answered without giving the round away", async () => {
  const { db, userId } = await funded();
  const T0 = 5_000_000;
  const f = await nextFlight(db, userId, "volta-crash", { now: T0, rng: drawing(crash.rtp, 1.5) });
  const { bet } = await placeFlightBet(db, userId, "volta-crash",
    { flight_id: f.flight_id, panel: 0, stake: 10, auto: 2, idempotency_key: key() }, { now: T0 });
  const asked = await cashOutFlightBet(db, userId, "volta-crash", { bet_id: bet.bet_id, auto: true }, { now: T0 + WAIT_MS + flightMs(1.3) });
  assert.equal(asked.bet.status, "ACTIVE", "an auto check is never a cash-out");
  assert.equal(asked.crash, undefined);
});

test("Bad bets are refused; a retried bet is taken once; players on a break can't bet", async () => {
  const { db, userId, balance } = await funded();
  const T0 = 6_000_000;
  const f = await nextFlight(db, userId, "volta-crash", { now: T0 });
  const bad = (body: Record<string, unknown>) => assert.rejects(() =>
    placeFlightBet(db, userId, "volta-crash", { flight_id: f.flight_id, panel: 0, stake: 5, idempotency_key: key(), ...body }, { now: T0 }), GameError);
  await bad({ stake: 0.5 });              // Crash starts at GHS 1
  await bad({ stake: 1001 });
  await bad({ panel: 2 });
  await bad({ kind: "red" });             // colours are Knockout's
  await bad({ auto: 1 });
  await bad({ stake: 500 });              // more than the balance
  await bad({ flight_id: "not-a-round" });
  const k = key();
  const one = await placeFlightBet(db, userId, "volta-crash", { flight_id: f.flight_id, panel: 0, stake: 5, idempotency_key: k }, { now: T0 });
  const two = await placeFlightBet(db, userId, "volta-crash", { flight_id: f.flight_id, panel: 0, stake: 5, idempotency_key: k }, { now: T0 });
  assert.equal(one.bet.bet_id, two.bet.bet_id);
  assert.equal(await balance(), 95);
  await assert.rejects(() => placeFlightBet(db, userId, "volta-crash", { flight_id: f.flight_id, panel: 0, stake: 5, idempotency_key: key() }, { now: T0 }),
    (e: unknown) => e instanceof GameError && e.code === "panel_busy");
  await selfExclude(db, userId, 1);
  await assert.rejects(() => placeFlightBet(db, userId, "volta-crash", { flight_id: f.flight_id, panel: 1, stake: 5, idempotency_key: key() }, { now: T0 }),
    (e: unknown) => e instanceof GameError && e.status === 403);
});

test("Nobody can touch someone else's round or bet", async () => {
  const env = await funded();
  const T0 = 7_000_000;
  const f = await nextFlight(env.db, env.userId, "volta-crash", { now: T0 });
  const { bet } = await placeFlightBet(env.db, env.userId, "volta-crash", { flight_id: f.flight_id, panel: 0, stake: 5, idempotency_key: key() }, { now: T0 });
  const { ensureWalletAccount } = await import("../src/services/accountLink.js");
  const other = await ensureWalletAccount(env.db, "account-2", "other");
  await assert.rejects(() => cashOutFlightBet(env.db, other, "volta-crash", { bet_id: bet.bet_id }, { now: T0 + WAIT_MS + 10 }),
    (e: unknown) => e instanceof GameError && e.status === 404);
  await assert.rejects(() => waitFlight(env.db, other, "volta-crash", f.flight_id), (e: unknown) => e instanceof GameError && e.status === 404);
  await assert.rejects(() => cashOutFlightBet(env.db, env.userId, "volta-knockout", { bet_id: bet.bet_id }, { now: T0 + WAIT_MS + 10 }),
    (e: unknown) => e instanceof GameError && e.status === 404, "a Crash bet isn't a Knockout bet");
});

/* ---------------- Jet: a straight climb to a 10.70x top ---------------- */

test("Jet climbs 0.001 every 1/60 s and pays wins rounded down to the cent, as its page does", () => {
  assert.equal(jet.multiplierAt(0), 1);
  assert.equal(jet.multiplierAt(1000), 1.06);
  assert.equal(jet.multiplierAt(16_666), 1.999);
  assert.equal(jet.multiplierAt(16_667), 2);
  assert.equal(jet.flightMs(2), 1000 / 0.06);
  assert.equal(jet.payout(10, 1.234), 12.34);
  assert.equal(jet.payout(0.37, 1.999), 0.73, "0.7396 rounds down");
  // the page: Math.floor(cents × (1000 + steps) / 1000)
  for (const [cents, steps] of [[37, 999], [1234, 1], [100000, 9700], [10, 5]] as const) {
    assert.equal(jet.payout(cents / 100, (1000 + steps) / 1000), Math.floor((cents * (1000 + steps)) / 1000) / 100);
  }
});

test("Jet's crash point reaches m with chance 98% ÷ m, tops out at 10.70x, and the top pays bets still flying", () => {
  const N = 400_000;
  const marks = [1.01, 2, 5, 10.7];
  const reached = marks.map(() => 0);
  let top = 0;
  for (let j = 0; j < N; j++) {
    const x = crashPoint(jet.rtp, () => (j + 0.5) / N, jet.maxCrash);
    assert.ok(x <= 10.7);
    if (x === 10.7) top++;
    marks.forEach((m, i) => { if (x >= m) reached[i] = reached[i]! + 1; });
  }
  marks.forEach((m, i) => assert.ok(Math.abs(reached[i]! / N - jet.rtp / m) < 2 / N + 1e-9, `${m}x: ${reached[i]! / N}`));
  assert.ok(Math.abs(top / N - jet.rtp / 10.7) < 2 / N + 1e-9);
  // riding to the top is paid at the top: 10.7 × P(reach 10.7) = the RTP
  assert.deepEqual(judge(jet, { stake: 1, kind: "classic", auto: null }, { crash: 10.7, startsAt: 0 }, jet.flightMs(10.7), false),
    { status: "WON", x: 10.7 });
  assert.deepEqual(judge(jet, { stake: 1, kind: "classic", auto: null }, { crash: 10.69, startsAt: 0 }, jet.flightMs(10.69), false),
    { status: "LOST" });
  assert.deepEqual(judge(jet, { stake: 1, kind: "classic", auto: null }, { crash: 3, startsAt: 0 }, 20_000, true),
    { status: "WON", x: 2.2 });
});

test("A Jet round: an 8-second betting window, a cash-out at three decimals, paid to the cent", async () => {
  const { db, userId, balance } = await funded();
  const T0 = 8_000_000;
  const f = await nextFlight(db, userId, "volta-jet", { now: T0, rng: drawing(jet.rtp, 4) });
  assert.equal(f.starts_in_ms, 8000);
  const { bet } = await placeFlightBet(db, userId, "volta-jet",
    { flight_id: f.flight_id, panel: 0, stake: 0.37, idempotency_key: key() }, { now: T0 + 7000 });
  const paid = await cashOutFlightBet(db, userId, "volta-jet", { bet_id: bet.bet_id }, { now: T0 + 8000 + 16_666 });
  assert.equal(paid.bet.x, 1.999);
  assert.equal(paid.bet.payout, 0.73);
  assert.equal(await balance(), Math.round((100 - 0.37 + 0.73) * 100) / 100);
});
