import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { selfExclude } from "../src/services/responsibleGaming.js";
import { bottleOutcomeAt, GAMES, GameError, HILO_RTP, hiloMultiplier, hiloWins, secureRandom, WINGS, WINGS_EVENTS, wingsPlan, type Rng } from "../src/games/catalog.js";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { playRound } from "../src/games/rounds.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const fixed = (...values: number[]): Rng => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

/** A player with ₵100 in the wallet. */
async function funded() {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 100, "deposit:seed-games");
  await env.client.query("COMMIT");
  return env;
}

/** Sample bets for each game — every bet on every game must return the disclosed RTP. */
const SAMPLES: Record<string, unknown[]> = {
  "volta-bottle": [{ side: "UP" }, { side: "DOWN" }],
  "even-odd": [{ pick: "EVEN" }, { pick: "ODD" }],
  "volta-coin": [{ pick: "HEADS" }, { pick: "TAILS" }],
  "red-black": [{ side: "RED" }, { side: "BLACK" }],
  "magic-ball": [{ bets: { "1": 1 } }, { bets: { "2": 3, "3": 1 } }],
  "volta-wings": [{}],
  "volta-olympus": [{ kind: "spin", bet: 1 }],
  "volta-fruits": [{ bet: 1 }],
  "volta-hilo": [{ base: { rank: "7", suit: "H" }, pick: "HIGHER" }, { base: { rank: "K", suit: "S" }, pick: "LOWER" }],
  roulette: [{ bets: { n0: 1 } }, { bets: { n7: 2 } }, { bets: { c2: 1 } }, { bets: { red: 1 } }, { bets: { odd: 5, n4: 1, c3: 2 } }],
};
const stakeFor = (game: (typeof GAMES)[string], choice: unknown) => (game.stakeOf ? game.stakeOf(choice as never) : 1);

test("Every real-money game has sample bets in these tests", () => {
  for (const id of Object.keys(GAMES)) assert.ok(SAMPLES[id], `add sample bets for ${id}`);
});

test("Exact return to player: every outcome of a single draw, weighted equally, gives the disclosed RTP", () => {
  // even-odd (three dice) and wings (a whole flight) take several draws and have their own exact tests
  for (const game of Object.values(GAMES).filter((g) => !["even-odd", "volta-wings", "volta-olympus", "volta-fruits", "volta-hilo"].includes(g.id))) {
    const N = 360_000; // fine enough that every boundary (angles, 3% edge, 1/54 cards) is hit in proportion
    for (const raw of SAMPLES[game.id]!) {
      const choice = game.parseChoice(raw);
      const stake = stakeFor(game, choice);
      let paid = 0;
      for (let i = 0; i < N; i++) paid += game.play(choice as never, stake, () => (i + 0.5) / N).payout;
      const rtp = paid / (N * stake);
      assert.ok(Math.abs(rtp - game.rtp) < 0.001, `${game.id} ${JSON.stringify(raw)}: ${rtp.toFixed(5)} vs ${game.rtp.toFixed(5)}`);
    }
  }
});

test("The secure generator drives every game sensibly (200,000 random rounds each)", () => {
  for (const game of Object.values(GAMES).filter((g) => g.id !== "volta-olympus" && g.id !== "volta-fruits")) {
    const choice = game.parseChoice(SAMPLES[game.id]![0]);
    const stake = stakeFor(game, choice);
    let paid = 0;
    for (let i = 0; i < 200_000; i++) paid += game.play(choice as never, stake, secureRandom).payout;
    const rtp = paid / (200_000 * stake);
    assert.ok(Math.abs(rtp - game.rtp) < 0.03, `${game.id}: ${rtp.toFixed(4)} vs ${game.rtp.toFixed(4)}`);
  }
});

test("Even-Odd: exactly 105 of the 216 rolls win for each call", () => {
  const evenOdd = GAMES["even-odd"]!;
  for (const pick of ["EVEN", "ODD"]) {
    let wins = 0;
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) for (let c = 0; c < 6; c++) {
      const rng = fixed((a + 0.5) / 6, (b + 0.5) / 6, (c + 0.5) / 6);
      if (evenOdd.play(evenOdd.parseChoice({ pick }) as never, 1, rng).payout > 0) wins++;
    }
    assert.equal(wins, 105, pick);
  }
});

test("Roulette pays every covering spot and nothing else", async () => {
  const roulette = GAMES.roulette!;
  const choice = roulette.parseChoice({ bets: { n7: 2, red: 5, c1: 1, even: 3 } });
  const atPocket = (n: number) => roulette.play(choice as never, 11, () => (n + 0.5) / 13);
  assert.equal(atPocket(7).payout, 2 * 12 + 5 * 2 + 1 * 3); // 7 is red, column 1, odd
  assert.equal(atPocket(4).payout, 1 * 3 + 3 * 2);          // 4 is black, column 1, even
  assert.equal(atPocket(0).payout, 0);                      // zero loses every outside bet
});

test("Multi-spot bets: the stake is the chips' sum, and limits are enforced", async () => {
  const { db, userId, balance } = await funded();
  const r = await playRound(db, userId, "magic-ball", { stake: 4, choice: { bets: { "1": 3, "3": 1 } }, idempotency_key: "round:mb-1" },
    () => 0.1); // ball under cup 1
  assert.equal(r.stake, 4);
  assert.equal(r.payout, 8.7);
  assert.equal(await balance(), 104.7);
  const bad = (body: Record<string, unknown>) =>
    assert.rejects(() => playRound(db, userId, "magic-ball", { idempotency_key: "round:mb-" + Math.random(), ...body }), GameError);
  await bad({ stake: 5, choice: { bets: { "1": 3, "3": 1 } } });                // total doesn't match the chips
  await bad({ choice: { bets: { "1": 1, "2": 1, "3": 1 } } });                   // three spots
  await bad({ choice: { bets: { "4": 1 } } });                                   // no such spot
  await bad({ choice: { bets: { "1": 0.1 } } });                                 // under the per-spot minimum
  await assert.rejects(() => playRound(db, userId, "roulette",
    { choice: { bets: { n1: 1500, n2: 600 } }, idempotency_key: "round:rl-max" }), GameError); // over 2000 a round
});

test("Bottle: the MIDDLE line loses for both calls", () => {
  assert.equal(bottleOutcomeAt(0), "MIDDLE");
  assert.equal(bottleOutcomeAt(181), "MIDDLE");
  assert.equal(bottleOutcomeAt(270), "UP");
  assert.equal(bottleOutcomeAt(90), "DOWN");
});

test("A winning round debits the stake and credits the win, in the ledger and the round log", async () => {
  const { db, userId, balance } = await funded();
  const r = await playRound(db, userId, "volta-bottle", { stake: 10, choice: { side: "UP" }, idempotency_key: "round:win-1" }, fixed(0.75));
  assert.equal(r.outcome.result, "UP");
  assert.equal(r.payout, 20);
  assert.equal(r.balance, 110);
  assert.equal(await balance(), 110);
  const row = (await db.query("SELECT stake, payout, choice, outcome FROM game_rounds")).rows[0];
  assert.equal(Number(row.stake), 10);
  assert.equal(Number(row.payout), 20);
  assert.deepEqual(row.choice, { side: "UP" });
});

test("A losing round keeps the stake and pays nothing", async () => {
  const { db, userId, balance } = await funded();
  const r = await playRound(db, userId, "even-odd", { stake: 25.5, choice: { pick: "EVEN" }, idempotency_key: "round:lose-1" },
    fixed(0.01, 0.01, 0.01)); // 1-1-1: a triple
  assert.equal(r.outcome.triple, true);
  assert.equal(r.payout, 0);
  assert.equal(await balance(), 74.5);
});

test("The same round key never plays or charges twice", async () => {
  const { db, userId, balance } = await funded();
  const body = { stake: 10, choice: { side: "DOWN" }, idempotency_key: "round:replay-1" };
  const first = await playRound(db, userId, "volta-bottle", body, fixed(0.25));
  const again = await playRound(db, userId, "volta-bottle", body, fixed(0.75));
  assert.equal(again.replayed, true);
  assert.equal(again.round_id, first.round_id);
  assert.deepEqual(again.outcome, first.outcome);
  assert.equal(await balance(), 110);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM game_rounds")).rows[0].n), 1);
});

test("A bet bigger than the balance is refused with nothing recorded", async () => {
  const { db, userId, balance } = await funded();
  await assert.rejects(
    () => playRound(db, userId, "volta-bottle", { stake: 150, choice: { side: "UP" }, idempotency_key: "round:broke-1" }, fixed(0.75)),
    (e: unknown) => e instanceof GameError && e.code === "insufficient_funds");
  assert.equal(await balance(), 100);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM game_rounds")).rows[0].n), 0);
});

test("Players on a break can't play for real money", async () => {
  const { db, userId } = await funded();
  await selfExclude(db, userId, 1);
  await assert.rejects(
    () => playRound(db, userId, "volta-bottle", { stake: 1, choice: { side: "UP" }, idempotency_key: "round:break-1" }),
    (e: unknown) => e instanceof GameError && e.status === 403);
});

test("Bad stakes, choices and games are refused", async () => {
  const { db, userId } = await funded();
  const bad = (game: string, body: Record<string, unknown>) =>
    assert.rejects(() => playRound(db, userId, game, { idempotency_key: "round:bad-" + Math.random(), ...body }), GameError);
  await bad("volta-bottle", { stake: 0.1, choice: { side: "UP" } });      // under the minimum
  await bad("volta-bottle", { stake: 60000, choice: { side: "UP" } });    // over the table max
  await bad("volta-bottle", { stake: 1, choice: { side: "MIDDLE" } });    // not a call you can make
  await bad("even-odd", { stake: 1, choice: { side: "UP" } });            // wrong game's choice
  await bad("crash", { stake: 1, choice: {} });                           // not a server game (yet)
});

test("A round key used by another player can't be replayed into their round", async () => {
  const env = await funded();
  await playRound(env.db, env.userId, "volta-bottle", { stake: 5, choice: { side: "UP" }, idempotency_key: "round:mine-1" }, fixed(0.75));
  const { ensureWalletAccount } = await import("../src/services/accountLink.js");
  const other = await ensureWalletAccount(env.db, "account-2", "other");
  await assert.rejects(
    () => playRound(env.db, other, "volta-bottle", { stake: 5, choice: { side: "UP" }, idempotency_key: "round:mine-1" }),
    (e: unknown) => e instanceof GameError && e.code === "key_reused");
});

test("Wings: summing every reachable multiplier (in cents) gives exactly a 97% return", () => {
  const total = WINGS_EVENTS.reduce((a, e) => a + e.weight, 0);
  const apply = (c: number, e: (typeof WINGS_EVENTS)[number]) =>
    Math.min(WINGS.capCents, e.kind === "add" ? c + 100 * e.value : e.kind === "mul" ? c * e.value : Math.floor(c / 2));
  let dist = new Map<number, number>([[100, 1]]); // multiplier in cents → probability of still flying there
  let ret = 0;
  for (let k = 0; k < WINGS.ships; k++) {
    let afterStretch = new Map<number, number>();
    for (const n of WINGS.segment) {
      let d = new Map(dist);
      for (let i = 0; i < n; i++) {
        const next = new Map<number, number>();
        for (const [c, p] of d) for (const e of WINGS_EVENTS) {
          const c2 = apply(c, e);
          next.set(c2, (next.get(c2) ?? 0) + (p * e.weight) / total);
        }
        d = next;
      }
      for (const [c, p] of d) afterStretch.set(c, (afterStretch.get(c) ?? 0) + p / WINGS.segment.length);
    }
    const carry = new Map<number, number>();
    for (const [c, p] of afterStretch) {
      const reach = p * (1 - WINGS.down);
      ret += reach * WINGS.land * (c / 100);
      carry.set(c, reach * (1 - WINGS.land));
    }
    dist = carry;
  }
  assert.ok(Math.abs(ret - 0.97) < 1e-9, `exact return ${ret}`);
});

test("Wings: a million server flights return 97% (±1.5%)", () => {
  let paid = 0;
  const N = 1_000_000;
  for (let i = 0; i < N; i++) {
    const p = wingsPlan(secureRandom);
    if (p.landed) paid += p.final;
  }
  assert.ok(Math.abs(paid / N - 0.97) < 0.015, `measured ${(paid / N).toFixed(4)}`);
});

test("Wings: the server plans exactly the flight the page's own wings.js would, for the same random draws", async () => {
  // load the page's planner in a sandbox (it publishes window.VBWings before touching the page)
  const code = await readFile(new URL("../../assets/js/wings.js", import.meta.url), "utf8");
  const sandbox: Record<string, unknown> = {
    window: { VBWingsArt: {}, VBUtil: {} },
    document: { getElementById: () => { throw new Error("no page here"); } },
    Math, Number, Array, Object, String,
  };
  (sandbox.window as Record<string, unknown>).window = sandbox.window;
  try { vm.runInNewContext(code.replace(/^\(function \(\) \{/m, "(function () { const window = this.window;"), sandbox); } catch { /* stops at the page */ }
  const client = (sandbox.window as { VBWings?: { plan: (r: () => number) => Record<string, unknown>; EVENTS: { label: string }[] } }).VBWings;
  assert.ok(client, "wings.js published its planner");
  const seeded = (seed: number) => () => { // mulberry32
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let s = 1; s <= 20_000; s++) {
    const a = client.plan(seeded(s)) as { events: { label: string }[]; steps: number[]; ships: number[]; landed: boolean; landAt: number; downAt: number; final: number };
    const b = wingsPlan(seeded(s));
    const plain = (x: unknown) => JSON.parse(JSON.stringify(x)); // the sandbox's arrays come from another realm
    assert.deepEqual(
      plain({ events: b.events.map((i: number): string => client.EVENTS[i]!.label), steps: b.steps, ships: b.ships, landed: b.landed, landAt: b.landAt, downAt: b.downAt, final: b.final }),
      plain({ events: a.events.map((e) => e.label), steps: a.steps, ships: a.ships, landed: a.landed, landAt: a.landAt, downAt: a.downAt, final: a.final }),
      `seed ${s}`);
  }
});

test("Olympus: the server plays the page's own maths file, and the page can replay every round from its seed", async () => {
  const { olympusMath } = await import("../src/games/olympusMath.js");
  const M = olympusMath();
  assert.ok(M, "olympus-math.js loads on the server");
  assert.ok(GAMES["volta-olympus"], "Olympus is a real-money game");
  const { db, userId, balance } = await funded();
  let expected = 100;
  for (const [i, kind] of (["spin", "ante", "spin", "ante", "spin"] as const).entries()) {
    const r = await playRound(db, userId, "volta-olympus", { choice: { kind, bet: 2 }, idempotency_key: "round:ol-" + i });
    const cost = kind === "ante" ? 2.5 : 2;
    assert.equal(r.stake, cost);
    const replay = M!.round(M!.seeded(r.outcome.seed as number[]), kind);   // what the page does
    assert.equal(r.payout, Math.floor(replay.win * 2 * 100 + 1e-6) / 100);
    expected = Math.round((expected - cost + r.payout) * 100) / 100;
  }
  assert.equal(await balance(), expected);
});

test("Olympus: the server's copy of the maths is byte-for-byte the page's file", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../../assets/js/olympus-math.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../shared/olympus-math.cjs", import.meta.url), "utf8");
  assert.ok(page === server, "copy assets/js/olympus-math.js to backend/shared/olympus-math.cjs");
});

test("Olympus: Buy Free Spins costs 100 × the bet, and bad bets are refused", async () => {
  const olympus = GAMES["volta-olympus"]!;
  assert.equal(olympus.stakeOf!(olympus.parseChoice({ kind: "buy", bet: 0.5 }) as never), 50);
  assert.equal(olympus.stakeOf!(olympus.parseChoice({ kind: "ante", bet: 1.1 }) as never), 1.38); // 1.375, UP to the cent
  assert.equal(olympus.stakeOf!(olympus.parseChoice({ kind: "ante", bet: 0.23 }) as never), 0.29); // 0.2875 → never a discount
  assert.equal(olympus.stakeOf!(olympus.parseChoice({ kind: "ante", bet: 2 }) as never), 2.5);
  assert.throws(() => olympus.parseChoice({ kind: "spin", bet: 150 }), GameError);
  assert.throws(() => olympus.parseChoice({ kind: "bonus", bet: 1 }), GameError);
});

test("Olympus: a million seeded server spins return about the disclosed RTP", () => {
  const olympus = GAMES["volta-olympus"]!;
  const choice = olympus.parseChoice({ kind: "spin", bet: 1 });
  let paid = 0;
  const N = 1_000_000;
  for (let i = 0; i < N; i++) paid += olympus.play(choice as never, 1, secureRandom).payout;
  assert.ok(Math.abs(paid / N - olympus.rtp) < 0.03, `measured ${(paid / N).toFixed(4)} vs ${olympus.rtp}`);
});

/* ---------------- Blaze Fruits: the 5×3, 20-line fruit slot ---------------- */

test("Blaze Fruits: the server spins the page's own maths file, and the page can replay every spin from its seed", async () => {
  const { fruitsMath } = await import("../src/games/fruitsMath.js");
  const M = fruitsMath();
  assert.ok(M, "fruits-math.js loads on the server");
  assert.ok(GAMES["volta-fruits"], "Blaze Fruits is a real-money game");
  const { db, userId, balance } = await funded();
  let expected = 100;
  for (let i = 0; i < 6; i++) {
    const r = await playRound(db, userId, "volta-fruits", { choice: { bet: 2 }, idempotency_key: "round:fr-" + i });
    assert.equal(r.stake, 2);
    const replay: { grid: number[][]; win: number } = M!.spin(M!.seeded(r.outcome.seed as number[]));   // what the page does
    assert.deepEqual(r.outcome.grid, replay.grid);
    assert.equal(r.payout, Math.floor(replay.win * (2 / 20) * 100 + 1e-6) / 100);
    expected = Math.round((expected - 2 + r.payout) * 100) / 100;
  }
  assert.equal(await balance(), expected);
});

test("Blaze Fruits: the server's copy of the maths is byte-for-byte the page's file, and the disclosed RTP is the exact one", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(new URL("../../assets/js/fruits-math.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../shared/fruits-math.cjs", import.meta.url), "utf8");
  assert.ok(page === server, "copy assets/js/fruits-math.js to backend/shared/fruits-math.cjs");
  const { fruitsMath } = await import("../src/games/fruitsMath.js");
  const M = fruitsMath()!;
  const exact = M.exactRtp().rtp;
  assert.ok(Math.abs(exact - M.RTP / 100) < 0.0005, `RTP constant ${M.RTP} vs exact ${(exact * 100).toFixed(3)}`);
  assert.equal(GAMES["volta-fruits"]!.rtp, exact);
});

test("Blaze Fruits: lines pay left to right with the wild Seven, scatters pay anywhere, and bad bets are refused", async () => {
  const { fruitsMath } = await import("../src/games/fruitsMath.js");
  const M = fruitsMath()! as unknown as {
    evaluate(grid: number[][]): { lines: { line: number; symbol: number; count: number; pay: number }[]; scatterPay: number; total: number; capped: boolean };
    lineWin(syms: number[]): { pay: number; count: number; symbol: number };
  };
  /* symbols: 0 seven (wild), 1 melon, 2 grapes, 3 plum, 4 orange, 5 lemon, 6 cherry, 7 star */
  assert.deepEqual(M.lineWin([6, 6, 6, 1, 2]), { pay: 3, count: 3, symbol: 6 });
  assert.deepEqual(M.lineWin([0, 6, 6, 6, 6]), { pay: 60, count: 5, symbol: 6 }, "a wild completes the run");
  assert.deepEqual(M.lineWin([0, 0, 0, 6, 6]), { pay: 60, count: 5, symbol: 6 }, "three wilds then cherries read as five cherries (60) over three sevens (50)");
  assert.deepEqual(M.lineWin([0, 0, 0, 0, 6]), { pay: 250, count: 4, symbol: 0 }, "four sevens beat five cherries");
  assert.deepEqual(M.lineWin([1, 6, 6, 6, 6]), { pay: 0, count: 0, symbol: -1 }, "runs start from reel 1");
  assert.deepEqual(M.lineWin([7, 7, 7, 7, 7]), { pay: 0, count: 0, symbol: -1 }, "stars don't pay on a line");
  const grid = [[7, 3, 3], [7, 3, 3], [7, 3, 3], [4, 4, 4], [5, 5, 5]];   /* top row: three stars; middle & bottom: plums */
  const e = M.evaluate(grid);
  assert.equal(e.scatterPay, 2 * 20, "three stars pay 2× the total bet");
  assert.ok(e.lines.some((l) => l.line === 0 && l.symbol === 3 && l.count === 3 && l.pay === 8), "the middle line pays three plums");
  const allSevens = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  assert.equal(M.evaluate(allSevens).total, 2500 * 20, "every line pays its top: 2,500 × the total bet");
  const fruits = GAMES["volta-fruits"]!;
  assert.throws(() => fruits.parseChoice({ bet: 0.1 }), GameError);
  assert.throws(() => fruits.parseChoice({ bet: 0.3 }), GameError, "0.30 isn't 20 × whole pesewas");
  assert.equal(fruits.stakeOf!(fruits.parseChoice({ bet: 0.2 }) as never), 0.2);
  assert.equal(fruits.stakeOf!(fruits.parseChoice({ bet: 100 }) as never), 100);
});

/* ---------------- Hi-Lo ---------------- */

test("Hi-Lo: every call pays 97% ÷ its chance (down to the cent), exactly, over the 51 cards it can draw", () => {
  const hilo = GAMES["volta-hilo"]!;
  const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  let sum = 0, n = 0;
  for (const [i, rank] of RANKS.entries()) {
    for (const pick of ["HIGHER", "LOWER"] as const) {
      const wins = hiloWins(i, pick);
      if (!wins) {
        assert.throws(() => hilo.parseChoice({ base: { rank, suit: "D" }, pick }), GameError, `${pick} on ${rank} can't win`);
        continue;
      }
      const choice = hilo.parseChoice({ base: { rank, suit: "D" }, pick });
      let paid = 0, won = 0;
      const seen = new Set<string>();
      for (let k = 0; k < 51; k++) {
        const r = hilo.play(choice as never, 1, () => (k + 0.5) / 51);
        const o = r.outcome as { next: { rank: string; suit: string }; won: boolean; mult: number };
        seen.add(o.next.rank + o.next.suit);
        assert.notEqual(o.next.rank + o.next.suit, rank + "D", "the base card is never drawn again");
        paid += r.payout;
        if (o.won) won++;
      }
      assert.equal(seen.size, 51, "each of the other 51 cards comes up once");
      assert.equal(won, wins);
      const mult = hiloMultiplier(i, pick);
      assert.ok(Math.abs(paid - mult * wins) < 1e-6, `${pick} on ${rank} paid ${paid}`);
      const rtp = paid / 51;
      assert.ok(rtp <= 0.97 + 1e-9 && rtp > 0.955, `${pick} on ${rank}: ${(rtp * 100).toFixed(2)}%`);
      sum += rtp; n++;
    }
  }
  assert.ok(Math.abs(sum / n - HILO_RTP) < 1e-9, "the disclosed RTP is the average over every call");
  assert.equal(hiloMultiplier(5, "HIGHER"), 1.76);   // 7: 28 of 51 higher → 0.97 × 51 ÷ 28 = 1.7668
  assert.equal(hiloMultiplier(5, "LOWER"), 2.47);    // 7: 20 of 51 lower → 2.4735
  assert.equal(hiloMultiplier(11, "HIGHER"), 12.36); // K: only the four aces → 12.3675
  assert.throws(() => hilo.parseChoice({ base: { rank: "1", suit: "H" }, pick: "HIGHER" }), GameError);
  assert.throws(() => hilo.parseChoice({ base: { rank: "7", suit: "X" }, pick: "HIGHER" }), GameError);
});
