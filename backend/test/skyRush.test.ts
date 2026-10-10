import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { selfExclude } from "../src/services/responsibleGaming.js";
import { CATALOG, setCatalogEnabled } from "../src/games/availability.js";
import { GameError } from "../src/games/catalog.js";
import {
  cancelSkyBet, cashOutSkyBet, createSkyLive, currentSkyRound, maskName, mySkyBets, placeSkyBet, settleDueSkyRounds,
  settleSkyRound, SKY_MAX_CRASH, SKY_WAIT_MS, skyCrashFromSeed, skyCrashFromUniform, skyFlightMs, skyMultiplierAt,
  skyRoundBets, skyTop,
} from "../src/games/skyRush.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const T0 = 1_800_000_000_000;
let keyN = 0;
const key = () => "sky:test-" + ++keyN;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const code = (c: string) => (e: unknown) => e instanceof GameError && e.code === c;

/** Two funded players: "tester" (the helper's player) and Kofi. */
async function world(amount = 1000) {
  const env = await setupWalletDb();
  const fund = async (userId: string, tag: string) => {
    await env.client.query("BEGIN");
    await deposit(env.client, userId, "GHS", amount, "deposit:sky-" + tag);
    await env.client.query("COMMIT");
  };
  const kofi = await ensureWalletAccount(env.db, "account-2", "kofi", "0241234567");
  await fund(env.userId, "tester");
  await fund(kofi, "kofi");
  const balanceOf = async (userId: string) => Number((await env.db.query(
    `SELECT available FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId])).rows[0].available);
  const drift = async () => (await env.db.query(`SELECT * FROM balance_reconciliation`)).rows.length;
  return { ...env, tester: env.userId, kofi, balanceOf, drift };
}

/** Moves round `no`'s crash point (the seed then no longer matches — only for testing the engine). */
async function setCrash(db: Awaited<ReturnType<typeof world>>["db"], no: number, crash: number) {
  const start = new Date((await db.query(`SELECT starts_at FROM sky_rounds WHERE no = $1`, [no])).rows[0].starts_at).getTime();
  await db.query(`UPDATE sky_rounds SET crash = $2, ends_at = $3 WHERE no = $1`, [no, crash, new Date(Math.ceil(start + skyFlightMs(crash)))]);
  return start;
}

/* ---------------- the maths ---------------- */

test("Sky Rush: the crash point reaches m with chance 97% ÷ m, and every cash-out target returns 97%", () => {
  const N = 400_000;
  const marks = [1.01, 1.37, 2, 3.33, 10, 100];
  const reached = marks.map(() => 0);
  let instant = 0;
  for (let j = 0; j < N; j++) {
    const x = skyCrashFromUniform((j + 0.5) / N);
    if (x === 1) instant++;
    marks.forEach((m, i) => { if (x >= m) reached[i] = reached[i]! + 1; });
  }
  marks.forEach((m, i) => {
    assert.ok(Math.abs(reached[i]! / N - 0.97 / m) < 2 / N + 1e-9, `${m}x: ${reached[i]! / N} vs ${0.97 / m}`);
    assert.ok(Math.abs((reached[i]! / N) * m - 0.97) < (2 * m) / N + 1e-9, `cashing out at ${m}x returns 97%`);
  });
  assert.ok(Math.abs(instant / N - 4 / 101) < 1e-4, "about 4 rounds in 100 end at 1.00x");
  assert.equal(skyCrashFromUniform(0), 1);
  assert.equal(skyCrashFromUniform(0.999999999999), SKY_MAX_CRASH);
});

test("Sky Rush: crash points drawn from random seeds follow the same odds", () => {
  const N = 60_000;
  let over2 = 0;
  let over10 = 0;
  for (let i = 0; i < N; i++) {
    const x = skyCrashFromSeed(crypto.randomBytes(32).toString("hex"), i + 1);
    if (x >= 2) over2++;
    if (x >= 10) over10++;
  }
  assert.ok(Math.abs(over2 / N - 0.485) < 0.01, `P(≥2x) = ${over2 / N}`);
  assert.ok(Math.abs(over10 / N - 0.097) < 0.006, `P(≥10x) = ${over10 / N}`);
});

test("Sky Rush: the multiplier climbs on the clock, e^(0.09 × seconds), to the cent", () => {
  assert.equal(skyMultiplierAt(0), 1);
  assert.equal(skyMultiplierAt(-50), 1);
  assert.equal(skyMultiplierAt(skyFlightMs(2) - 1), 1.99);
  assert.equal(skyMultiplierAt(skyFlightMs(2) + 1), 2);
  assert.equal(skyMultiplierAt(skyFlightMs(10) + 1), 10);
  assert.ok(Math.abs(skyFlightMs(2) - 7701.6) < 1);
});

/* ---------------- rounds ---------------- */

test("Sky Rush: one round for everybody, opened 8 s before take-off, its crash point secret until the crash", async () => {
  const env = await world();
  const r1 = await currentSkyRound(env.db, T0);
  assert.equal(Number(r1.no), 1);
  assert.equal(new Date(r1.starts_at).getTime(), T0 + SKY_WAIT_MS);
  assert.equal(r1.hash, sha256(r1.seed));
  assert.equal(Number(r1.crash), skyCrashFromSeed(r1.seed, 1));
  assert.equal(Number((await currentSkyRound(env.db, T0 + 5000)).no), 1, "everyone asking gets the same round");

  let t = T0;
  const live = createSkyLive(env.db, { clock: () => t, sleep: async (ms) => { t += ms; } });
  const s = await live.state();
  assert.equal(s.round.no, 1);
  assert.equal(s.round.over, false);
  for (const secret of ["crash", "seed", "ends_at"]) assert.ok(!(secret in s.round), `${secret} is not sent before the crash`);
  assert.deepEqual(s.history, []);

  /* the wait request is held until the plane flies away, then carries the crash, the seed and the next round */
  let w;
  do w = await live.wait(1); while (!w.round.over);
  const end = new Date(r1.starts_at).getTime() + skyFlightMs(Number(r1.crash));
  assert.ok(t >= end && t <= end + 10, "answered at the crash");
  assert.equal(w.round.crash, Number(r1.crash));
  assert.equal(w.round.seed, r1.seed);
  assert.equal(w.next!.no, 2);
  assert.equal(w.next!.starts_at, Math.ceil(t) + SKY_WAIT_MS, "the next round takes off 8 s after the crash");
  assert.ok(!("crash" in w.next!));
  const s2 = await live.state();
  assert.equal(s2.round.no, 2);
  assert.deepEqual(s2.history, [{ no: 1, crash: Number(r1.crash) }]);
});

test("Sky Rush: two requests opening a round at once share it", async () => {
  const env = await world();
  const [a, b] = await Promise.all([currentSkyRound(env.db, T0), currentSkyRound(env.db, T0)]);
  assert.equal(a.no, b.no);
  assert.equal(a.hash, b.hash);
  assert.equal((await env.db.query(`SELECT count(*)::int AS n FROM sky_rounds`)).rows[0].n, 1);
});

test("Sky Rush: a finished round can be checked with the browser's own crypto", async () => {
  const env = await world();
  const r = await currentSkyRound(env.db, T0);
  const live = createSkyLive(env.db, { clock: () => T0 + 10 * 60_000 });
  const v = await live.roundInfo(1);
  assert.equal(v.over, true);
  /* what the page does: HMAC-SHA256 keyed with the seed's text, over "sky-rush:<no>" */
  const subtle = crypto.webcrypto.subtle;
  const k = await subtle.importKey("raw", new TextEncoder().encode(v.seed!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await subtle.sign("HMAC", k, new TextEncoder().encode("sky-rush:" + v.no)));
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  const u = parseInt(hex.slice(0, 13), 16) / 2 ** 52;
  assert.equal(Math.min(10000, Math.max(1, Math.floor(97 / (1 - u)) / 100)), Number(r.crash));
  const digest = Buffer.from(await subtle.digest("SHA-256", new TextEncoder().encode(v.seed!))).toString("hex");
  assert.equal(digest, v.hash);
});

/* ---------------- bets ---------------- */

test("Sky Rush: players bet in the same round and see each other's bets, names masked", async () => {
  const env = await world();
  await currentSkyRound(env.db, T0);
  await placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 5, auto: 2, idempotency_key: key() }, { now: T0 });
  await placeSkyBet(env.db, env.kofi, { round_no: 1, panel: 0, stake: 10, idempotency_key: key() }, { now: T0 + 100 });
  await placeSkyBet(env.db, env.kofi, { round_no: "1", panel: "1", stake: "3", idempotency_key: key() }, { now: T0 + 200 });
  assert.equal(await env.balanceOf(env.tester), 995);
  assert.equal(await env.balanceOf(env.kofi), 987);
  const list = await skyRoundBets(env.db, 1, T0 + 300);
  assert.equal(list.count, 3);
  assert.equal(list.players, 2);
  assert.equal(list.cashed, 0);
  assert.deepEqual(list.bets.map((b) => [b.user, b.stake, b.x]), [["k***i", 10, null], ["t***r", 5, null], ["k***i", 3, null]]);
  assert.equal(list.avatars.length, 2);
  assert.ok(!JSON.stringify(list).includes(env.kofi), "no player ids in the public list");
  assert.ok(!JSON.stringify(list).includes("auto"), "nobody else's auto cash-out is shown");
});

test("Sky Rush: bets close at take-off, and malformed bets are refused", async () => {
  const env = await world();
  const r = await currentSkyRound(env.db, T0);
  const start = new Date(r.starts_at).getTime();
  const bet = (input: Record<string, unknown>, now = T0) =>
    placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 5, idempotency_key: key(), ...input }, { now });
  await assert.rejects(() => bet({}, start), code("too_late"));
  await assert.rejects(() => bet({ round_no: 2 }), code("not_found"));
  await assert.rejects(() => bet({ round_no: [1] }), code("not_found"));
  for (const stake of [[5], true, "1e3", 0.5, 1000.01, "abc", null, -5, "5 GHS"]) {
    await assert.rejects(() => bet({ stake }), code("invalid_stake"), `stake ${JSON.stringify(stake)}`);
  }
  await assert.rejects(() => bet({ panel: 2 }), code("invalid_panel"));
  await assert.rejects(() => bet({ panel: [0] }), code("invalid_panel"));
  await assert.rejects(() => bet({ auto: 1 }), code("invalid_auto"));
  await assert.rejects(() => bet({ auto: "x" }), code("invalid_auto"));
  await assert.rejects(() => bet({ auto: 10000.01 }), code("invalid_auto"));
  await assert.rejects(() => bet({ idempotency_key: "short" }), code("invalid_idempotency_key"));
  assert.equal(await env.balanceOf(env.tester), 1000, "nothing was taken");
});

test("Sky Rush: the same key is one bet, and another player can't reuse it", async () => {
  const env = await world();
  await currentSkyRound(env.db, T0);
  const k = key();
  const a = await placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 7, idempotency_key: k }, { now: T0 });
  const b = await placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 7, idempotency_key: k }, { now: T0 + 50 });
  assert.equal(a.bet.bet_id, b.bet.bet_id);
  assert.equal(await env.balanceOf(env.tester), 993, "charged once");
  await assert.rejects(() => placeSkyBet(env.db, env.kofi, { round_no: 1, panel: 0, stake: 7, idempotency_key: k }, { now: T0 }),
    (e: unknown) => e instanceof GameError && e.code === "key_reused" && e.status === 409);
});

test("Sky Rush: two bet slots a round; a cancelled slot can bet again; cancelling ends at take-off", async () => {
  const env = await world();
  const r = await currentSkyRound(env.db, T0);
  const start = new Date(r.starts_at).getTime();
  const first = await placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 5, idempotency_key: key() }, { now: T0 });
  await placeSkyBet(env.db, env.tester, { round_no: 1, panel: 1, stake: 6, idempotency_key: key() }, { now: T0 });
  await assert.rejects(() => placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 5, idempotency_key: key() }, { now: T0 }),
    code("panel_busy"));
  const c = await cancelSkyBet(env.db, env.tester, { bet_id: first.bet.bet_id }, { now: T0 + 1000 });
  assert.equal(c.bet.status, "CANCELLED");
  assert.equal(c.balance, 994);
  const again = await cancelSkyBet(env.db, env.tester, { bet_id: first.bet.bet_id }, { now: T0 + 1100 });
  assert.equal(again.balance, 994, "a second cancel refunds nothing more");
  const third = await placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 2, idempotency_key: key() }, { now: T0 + 1200 });
  await assert.rejects(() => cancelSkyBet(env.db, env.tester, { bet_id: third.bet.bet_id }, { now: start }), code("too_late"));
  assert.equal(await env.drift(), 0);
});

test("Sky Rush: Cash Out pays the multiplier when the server gets it, once; after the crash the bet is lost", async () => {
  const env = await world();
  await currentSkyRound(env.db, T0);
  const a = await placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 5, idempotency_key: key() }, { now: T0 });
  const b = await placeSkyBet(env.db, env.kofi, { round_no: 1, panel: 0, stake: 4, idempotency_key: key() }, { now: T0 });
  const start = await setCrash(env.db, 1, 3);
  await assert.rejects(() => cashOutSkyBet(env.db, env.tester, { bet_id: a.bet.bet_id }, { now: start - 1 }), code("not_started"));
  const at = start + skyFlightMs(2) + 50;
  const won = await cashOutSkyBet(env.db, env.tester, { bet_id: a.bet.bet_id }, { now: at });
  assert.equal(won.bet.status, "WON");
  assert.equal(won.bet.x, skyMultiplierAt(at - start));
  assert.equal(won.bet.payout, Math.floor(5 * won.bet.x! * 100 + 1e-6) / 100);
  assert.equal(won.balance, 995 + won.bet.payout);
  assert.ok(!("crash" in won), "the crash isn't told while the plane flies");
  const twice = await cashOutSkyBet(env.db, env.tester, { bet_id: a.bet.bet_id }, { now: at + 900 });
  assert.equal(twice.balance, won.balance, "paid once");
  const late = await cashOutSkyBet(env.db, env.kofi, { bet_id: b.bet.bet_id }, { now: start + skyFlightMs(3) + 1 });
  assert.equal(late.bet.status, "LOST");
  assert.equal(late.crash, 3);
  assert.equal(late.balance, 996);
  await assert.rejects(() => cashOutSkyBet(env.db, env.kofi, { bet_id: a.bet.bet_id }, { now: at }), code("not_found"),
    "nobody can cash out someone else's bet");
  await assert.rejects(() => cancelSkyBet(env.db, env.kofi, { bet_id: a.bet.bet_id }, { now: T0 }), code("not_found"));
  assert.equal(await env.drift(), 0);
});

test("Sky Rush: an auto cash-out pays its target as soon as it's passed, and loses if the plane goes first", async () => {
  const env = await world();
  await currentSkyRound(env.db, T0);
  const a = await placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 10, auto: 1.5, idempotency_key: key() }, { now: T0 });
  await placeSkyBet(env.db, env.kofi, { round_no: 1, panel: 0, stake: 10, auto: 5, idempotency_key: key() }, { now: T0 });
  const start = await setCrash(env.db, 1, 3);
  const early = await cashOutSkyBet(env.db, env.tester, { bet_id: a.bet.bet_id, auto: true }, { now: start + skyFlightMs(1.4) });
  assert.equal(early.bet.status, "ACTIVE", "not there yet: nothing decided");

  /* everybody sees the auto cash-out the moment the multiplier passes it, and nobody sees Kofi's 5x target */
  const mid = start + skyFlightMs(2);
  const list = await skyRoundBets(env.db, 1, mid);
  assert.deepEqual(list.bets.map((x) => [x.user, x.x, x.win]), [["t***r", 1.5, 15], ["k***i", null, 0]]);
  assert.equal(list.cashed, 1);
  assert.equal(list.total_win, 15);

  const got = await cashOutSkyBet(env.db, env.tester, { bet_id: a.bet.bet_id, auto: true }, { now: mid });
  assert.equal(got.bet.status, "WON");
  assert.equal(got.bet.x, 1.5);
  assert.equal(got.balance, 1005);
  await settleSkyRound(env.db, 1, start + skyFlightMs(3) + 1);
  const mine = await mySkyBets(env.db, env.kofi, 1, start + skyFlightMs(3) + 2);
  assert.equal(mine.bets[0]!.status, "LOST");
  assert.equal(mine.balance, 990);
  const after = await skyRoundBets(env.db, 1, start + skyFlightMs(3) + 2);
  assert.deepEqual(after.bets.map((x) => x.x), [1.5, null]);
});

test("Sky Rush: a finished round is settled once, and the sweep settles rounds everyone left", async () => {
  const env = await world();
  await currentSkyRound(env.db, T0);
  await placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 10, auto: 2, idempotency_key: key() }, { now: T0 });
  await placeSkyBet(env.db, env.kofi, { round_no: 1, panel: 1, stake: 10, idempotency_key: key() }, { now: T0 });
  const start = await setCrash(env.db, 1, 2.5);
  const end = start + skyFlightMs(2.5) + 1;
  assert.equal(await settleDueSkyRounds(env.db, end - 10), 0, "nothing is due before the crash");
  assert.equal(await settleDueSkyRounds(env.db, end), 1);
  await settleSkyRound(env.db, 1, end + 5);
  assert.equal(await env.balanceOf(env.tester), 1010, "the 2x auto cash-out was paid once");
  assert.equal(await env.balanceOf(env.kofi), 990);
  const wins = (await env.db.query(`SELECT count(*)::int AS n FROM ledger_journal WHERE idempotency_key LIKE 'win:sky:%'`)).rows[0].n;
  assert.equal(wins, 1);
  assert.equal((await env.db.query(`SELECT settled FROM sky_rounds WHERE no = 1`)).rows[0].settled, true);
  assert.equal(await env.drift(), 0);
  /* the admin dashboard and partner commissions see the bets */
  const seen = (await env.db.query(`SELECT count(*)::int AS n, sum(stake)::float AS staked FROM all_bets WHERE game = 'sky-rush'`)).rows[0];
  assert.deepEqual([seen.n, seen.staked], [2, 20]);
});

test("Sky Rush: a bet that arrives after its round was settled is refused, stake untouched", async () => {
  const env = await world();
  await currentSkyRound(env.db, T0);
  await env.db.query(`UPDATE sky_rounds SET settled = true WHERE no = 1`);
  await assert.rejects(() => placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 5, idempotency_key: key() }, { now: T0 }),
    code("too_late"));
  assert.equal(await env.balanceOf(env.tester), 1000);
});

test("Sky Rush: the top-prize cap cashes a GHS 1,000 bet out at 250x", async () => {
  const env = await world(1000);
  await currentSkyRound(env.db, T0);
  const a = await placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 1000, idempotency_key: key() }, { now: T0 });
  assert.equal(a.bet.auto_x, 250);
  const start = await setCrash(env.db, 1, 400);
  const got = await cashOutSkyBet(env.db, env.tester, { bet_id: a.bet.bet_id, auto: true }, { now: start + skyFlightMs(250) + 1 });
  assert.deepEqual([got.bet.status, got.bet.x, got.bet.payout], ["WON", 250, 250000]);
});

test("Sky Rush: players taking a break can't bet, and a game an admin switched off takes no bets", async () => {
  const env = await world();
  await currentSkyRound(env.db, T0);
  const lobbyId = CATALOG["sky-rush"]!.id;
  await setCatalogEnabled(env.db, "game", lobbyId, false, "admin-test");
  await assert.rejects(() => placeSkyBet(env.db, env.tester, { round_no: 1, panel: 0, stake: 5, idempotency_key: key() }, { now: T0 }),
    (e: unknown) => e instanceof GameError && e.code === "game_disabled" && e.status === 503);
  await setCatalogEnabled(env.db, "game", lobbyId, true, "admin-test");
  await selfExclude(env.db, env.kofi, 1);
  await assert.rejects(() => placeSkyBet(env.db, env.kofi, { round_no: 1, panel: 0, stake: 5, idempotency_key: key() }, { now: T0 }),
    (e: unknown) => e instanceof GameError && e.status === 403);
});

test("Sky Rush: the live feed's bets list, the player's own results and the leaderboards", async () => {
  const env = await world();
  let t = T0;
  const live = createSkyLive(env.db, { clock: () => t, sleep: async (ms) => { t += ms; } });
  const s = await live.state();
  await placeSkyBet(env.db, env.tester, { round_no: s.round.no, panel: 0, stake: 20, auto: 1.01, idempotency_key: key() }, { now: t });
  await placeSkyBet(env.db, env.kofi, { round_no: s.round.no, panel: 0, stake: 2, auto: 1.01, idempotency_key: key() }, { now: t });
  const crash = Number((await env.db.query(`SELECT crash FROM sky_rounds WHERE no = 1`)).rows[0].crash);
  let w;
  do w = await live.wait(1); while (!w.round.over);
  const mine = await live.mine(env.tester, 1);
  const won = crash >= 1.01;
  assert.equal(mine.bets[0]!.status, won ? "WON" : "LOST");
  assert.equal(mine.balance, won ? 1000 - 20 + 20.2 : 980);
  t += 1000; /* past the list's short cache */
  const list = await live.bets(1);
  assert.equal(list.count, 2);
  assert.equal(list.cashed, won ? 2 : 0);
  const top = await live.top("wins", "day");
  assert.deepEqual(top.wins!.map((x) => x.user), won ? ["t***r", "k***i"] : []);
  const rounds = await live.top("rounds", "day");
  assert.deepEqual(rounds.rounds!.map((r) => r.crash), [crash]);
  await assert.rejects(() => skyTop(env.db, "wins", "forever"), code("invalid_period"));
  await assert.rejects(() => skyTop(env.db, "losses", "day"), code("invalid_board"));
  await assert.rejects(() => live.wait("abc"), code("not_found"));
  await assert.rejects(() => live.bets(99), code("not_found"));
});

test("Sky Rush: names in the bets list show only their first and last character", () => {
  assert.equal(maskName("tester", null), "t***r");
  assert.equal(maskName("Kofi Mensah", "0241234567"), "k***h");
  assert.equal(maskName(null, "0241234567"), "0***7");
  assert.equal(maskName(null, null), "p***r");
  assert.equal(maskName("A", null), "a***");
  assert.equal(maskName("Ama😀", null), "a***😀");
});
