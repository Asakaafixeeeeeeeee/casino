import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { adjustBalance, AdminError, auditLog, userDetail } from "../src/services/admin.js";
import { clearGameControlsCache } from "../src/games/availability.js";
import { GameError } from "../src/games/catalog.js";
import { cashOutFlightBet, FLIGHT_GAMES, flightMs, nextFlight, placeFlightBet } from "../src/games/flights.js";
import { playRound } from "../src/games/rounds.js";
import { gameDetail, gamesOverview, saveGameControls } from "../src/services/gameAdmin.js";
import { bigWins, publicCatalog } from "../src/games/showcase.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0209999001";
const KO = "volta-knockout";
const knockout = FLIGHT_GAMES[KO]!;
const isGame = (code: string) => (e: unknown) => e instanceof GameError && e.code === code;
const isAdmin = (code: string) => (e: unknown) => e instanceof AdminError && e.code === code;
/** an rng that draws crash point x (see flights.test.ts) */
const drawing = (rtp: number, x: number) => () => 1 - (100 * rtp) / (100 * x + 0.5);
let n = 0;
const key = () => "gm:test-" + ++n;

async function funded(amount = 500) {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", amount, "deposit:seed-gm-" + ++n);
  await env.client.query("COMMIT");
  clearGameControlsCache();
  return env;
}

test("Knockout timing: the betting time and longest round apply to the next round, and a round keeps what it was drawn with", async () => {
  const env = await funded();
  await saveGameControls(env.db, ADMIN, KO, { wait_ms: 12000, max_x: 50 });
  const t0 = Date.now();
  const r1 = await nextFlight(env.db, env.userId, KO, { now: t0, rng: drawing(knockout.rtp, 500) });
  assert.equal(r1.starts_in_ms, 12000, "12 seconds to bet");
  assert.deepEqual([r1.wait_ms, r1.max_x], [12000, 50]);
  /* the draw would have been 500x; the longest round is 50x */
  const bet = await placeFlightBet(env.db, env.userId, KO, { flight_id: r1.flight_id, panel: 0, stake: 2, auto: 40, idempotency_key: key() }, { now: t0 + 1000 });

  /* the admin changes the settings while the round is open: this round keeps its 50x top and 12 s */
  await saveGameControls(env.db, ADMIN, KO, { wait_ms: 4000, max_x: 20 });
  const same = await nextFlight(env.db, env.userId, KO, { now: t0 + 2000 });
  assert.equal(same.flight_id, r1.flight_id);
  assert.deepEqual([same.wait_ms, same.max_x], [12000, 50]);
  const at40 = t0 + 12000 + flightMs(40) + 5;
  const won = await cashOutFlightBet(env.db, env.userId, KO, { bet_id: bet.bet.bet_id, auto: true }, { now: at40 });
  assert.deepEqual([won.bet.status, won.bet.x, won.bet.payout], ["WON", 40, 80], "paid at 40x as the round promised, not cut to the new 20x");

  /* the next round has the new settings */
  const after = t0 + 12000 + flightMs(50) + 10;
  const r2 = await nextFlight(env.db, env.userId, KO, { now: after, rng: drawing(knockout.rtp, 500) });
  assert.notEqual(r2.flight_id, r1.flight_id);
  assert.deepEqual([r2.starts_in_ms, r2.max_x], [4000, 20]);
  assert.equal(r1.crash, undefined, "a round's result is never sent before it's over");
});

test("Pause stops new rounds and bets on that game only, and resumes by itself at the set time", async () => {
  const env = await funded();
  await saveGameControls(env.db, ADMIN, KO, { paused: true, pause_note: "Checking the game" });
  await assert.rejects(() => nextFlight(env.db, env.userId, KO), isGame("game_paused"));
  const coin = await playRound(env.db, env.userId, "volta-coin", { stake: 1, choice: { pick: "HEADS" }, idempotency_key: key() });
  assert.equal(coin.stake, 1, "other games keep running");
  await saveGameControls(env.db, ADMIN, "volta-coin", { paused: true, paused_until: new Date(Date.now() + 3600e3).toISOString() });
  await assert.rejects(() => playRound(env.db, env.userId, "volta-coin", { stake: 1, choice: { pick: "HEADS" }, idempotency_key: key() }), isGame("game_paused"));
  /* the resume time passes */
  await env.db.query(`UPDATE game_settings SET paused_until = now() - interval '1 second' WHERE game = 'volta-coin'`);
  clearGameControlsCache();
  assert.equal((await playRound(env.db, env.userId, "volta-coin", { stake: 1, choice: { pick: "HEADS" }, idempotency_key: key() })).stake, 1);
  await saveGameControls(env.db, ADMIN, KO, { paused: false });
  assert.ok((await nextFlight(env.db, env.userId, KO)).flight_id, "resumed");
  const listed = (await gamesOverview(env.db)).games.find((g) => g.id === KO)!;
  assert.equal(listed.paused, false);
  await assert.rejects(() => saveGameControls(env.db, ADMIN, KO, { paused: true, paused_until: "2000-01-01T00:00:00Z" }), isAdmin("invalid_resume"));
});

test("Bet limits can only be tightened, and every game checks them", async () => {
  const env = await funded();
  await assert.rejects(() => saveGameControls(env.db, ADMIN, "volta-coin", { min_bet: 0.1 }), isAdmin("invalid_min_bet"));
  await assert.rejects(() => saveGameControls(env.db, ADMIN, "volta-coin", { max_bet: 60000 }), isAdmin("invalid_max_bet"));
  await assert.rejects(() => saveGameControls(env.db, ADMIN, "volta-coin", { min_bet: 10, max_bet: 5 }), isAdmin("invalid_max_bet"));
  await saveGameControls(env.db, ADMIN, "volta-coin", { min_bet: 1, max_bet: 5 });
  await assert.rejects(() => playRound(env.db, env.userId, "volta-coin", { stake: 10, choice: { pick: "HEADS" }, idempotency_key: key() }), isGame("invalid_stake"));
  await assert.rejects(() => playRound(env.db, env.userId, "volta-coin", { stake: 0.5, choice: { pick: "HEADS" }, idempotency_key: key() }), isGame("invalid_stake"));
  assert.equal((await playRound(env.db, env.userId, "volta-coin", { stake: 5, choice: { pick: "HEADS" }, idempotency_key: key() })).stake, 5);
  /* Knockout too, and the page is told the limits */
  await saveGameControls(env.db, ADMIN, KO, { max_bet: 3 });
  const r = await nextFlight(env.db, env.userId, KO);
  assert.deepEqual([r.min_bet, r.max_bet], [knockout.minBet, 3]);
  await assert.rejects(() => placeFlightBet(env.db, env.userId, KO, { flight_id: r.flight_id, panel: 0, stake: 4, idempotency_key: key() }), isGame("invalid_stake"));
  /* clearing a limit goes back to the game's own */
  await saveGameControls(env.db, ADMIN, "volta-coin", { min_bet: null, max_bet: null });
  assert.equal((await playRound(env.db, env.userId, "volta-coin", { stake: 20, choice: { pick: "HEADS" }, idempotency_key: key() })).stake, 20);
});

test("Settings are checked per game and every change is in the audit log", async () => {
  const env = await funded();
  await assert.rejects(() => saveGameControls(env.db, ADMIN, "volta-coin", { wait_ms: 8000 }), isAdmin("not_supported"));
  await assert.rejects(() => saveGameControls(env.db, ADMIN, "volta-jet", { max_x: 5 }), isAdmin("not_supported"), "Jet's track is fixed");
  await assert.rejects(() => saveGameControls(env.db, ADMIN, KO, { wait_ms: 1000 }), isAdmin("invalid_wait"));
  await assert.rejects(() => saveGameControls(env.db, ADMIN, KO, { max_x: 1.5 }), isAdmin("invalid_max_x"));
  await assert.rejects(() => saveGameControls(env.db, ADMIN, "sky-rush", { max_bet: 5 }), isAdmin("not_supported"));
  await assert.rejects(() => saveGameControls(env.db, ADMIN, "nope", {}), isAdmin("not_found"));
  await saveGameControls(env.db, ADMIN, "volta-jet", { wait_ms: 10000 });
  const log = (await auditLog(env.db, { target: "game:volta-jet" })).actions[0]!;
  assert.equal(log.action, "game.controls");
  assert.deepEqual((log.details as { after: Record<string, unknown> }).after, { wait_ms: 10000 });
});

test("A game's page: live rounds without their result, finished rounds, statistics and players' wins and losses", async () => {
  const env = await funded();
  const t0 = Date.now() - 120_000;
  /* a finished round with a win at 2x, and a lost one */
  const r1 = await nextFlight(env.db, env.userId, KO, { now: t0, rng: drawing(knockout.rtp, 3) });
  const b1 = await placeFlightBet(env.db, env.userId, KO, { flight_id: r1.flight_id, panel: 0, stake: 10, auto: 2, idempotency_key: key() }, { now: t0 + 100 });
  await cashOutFlightBet(env.db, env.userId, KO, { bet_id: b1.bet.bet_id, auto: true }, { now: t0 + 5000 + flightMs(3) + 10 });
  const t1 = t0 + 5000 + flightMs(3) + 20;
  const r2 = await nextFlight(env.db, env.userId, KO, { now: t1, rng: drawing(knockout.rtp, 1.5) });
  const b2 = await placeFlightBet(env.db, env.userId, KO, { flight_id: r2.flight_id, panel: 0, stake: 4, auto: 2, idempotency_key: key() }, { now: t1 + 100 });
  await cashOutFlightBet(env.db, env.userId, KO, { bet_id: b2.bet.bet_id, auto: true }, { now: t1 + 5000 + flightMs(1.5) + 10 });
  /* and one in play right now */
  const live = await nextFlight(env.db, env.userId, KO, { rng: drawing(knockout.rtp, 7) });
  await placeFlightBet(env.db, env.userId, KO, { flight_id: live.flight_id, panel: 0, stake: 1, idempotency_key: key() });

  const d = await gameDetail(env.db, KO);
  assert.equal(d.game.name, "Knockout");
  assert.equal(d.rounds!.open.length, 1);
  assert.equal(d.rounds!.open[0]!.phase, "betting");
  assert.equal(JSON.stringify(d.rounds!.open).includes("crash"), false, "no result for a round in play");
  assert.deepEqual(d.rounds!.finished.map((f) => f.crash).sort(), [1.5, 3]);
  assert.deepEqual([d.stats.today.bets, d.stats.today.staked, d.stats.today.paid, d.stats.today.ggr], [2, 14, 20, -6]);
  assert.equal(d.live.in_play.bets, 1);
  assert.equal(d.players.winners[0]!.net, 6, "won 20 on 14 staked");
  assert.equal(d.live.recent.length, 3);
});

test("Rewards and bonuses: recorded with their kind, who gave them and why; only corrections take money off", async () => {
  const env = await funded(10);
  await assert.rejects(() => adjustBalance(env.db, ADMIN, env.userId, { amount: -5, reason: "Taking back a promo", kind: "PROMO", idempotency_key: key() }), isAdmin("invalid_kind"));
  await assert.rejects(() => adjustBalance(env.db, ADMIN, env.userId, { amount: 5, reason: "Weekend reward", kind: "JACKPOT", idempotency_key: key() }), isAdmin("invalid_kind"));
  await adjustBalance(env.db, ADMIN, env.userId, { amount: 20, reason: "Weekend promotion winner", kind: "PROMO", idempotency_key: key() });
  await adjustBalance(env.db, ADMIN, env.userId, { amount: 5, reason: "Loyalty bonus for October", kind: "BONUS", idempotency_key: key() });
  await adjustBalance(env.db, ADMIN, env.userId, { amount: -2, reason: "Duplicate credit corrected", kind: "CORRECTION", idempotency_key: key() });
  await playRound(env.db, env.userId, "volta-coin", { stake: 1, choice: { pick: "HEADS" }, idempotency_key: key() });
  const u = await userDetail(env.db, env.userId);
  assert.deepEqual(u.rewards.map((r) => [r.amount, r.description, r.by]), [
    [-2, "Balance debited by WIN B casino", ADMIN],
    [5, "Bonus from WIN B casino", ADMIN],
    [20, "Promotional reward from WIN B casino", ADMIN],
  ]);
  assert.equal(u.rewards[2]!.reason, "Weekend promotion winner");
  assert.equal(u.profile.balance, 33 + u.games[0]!.net, "10 + 20 + 5 − 2, plus the coin result");
  assert.equal(u.games[0]!.name, "Flip Da' Coin");
  const log = (await auditLog(env.db, { target: env.userId })).actions.find((a) => (a.details as { kind?: string }).kind === "PROMO");
  assert.ok(log, "the audit log records the kind");
});

test("Free play and big-wins switches: saved per game, public, and the showcase lists only real wins", async () => {
  const env = await funded();
  /* defaults: free play on everywhere, no showcase */
  let pub = await publicCatalog(env.db);
  assert.deepEqual([pub.free_play_off, pub.showcase], [[], []]);
  assert.deepEqual(await bigWins(env.db, "knockout"), { game: "knockout", showcase: false, wins: [] });

  /* a real 40x Knockout win and a lost coin flip */
  const t0 = Date.now() - 60_000;
  const r = await nextFlight(env.db, env.userId, KO, { now: t0, rng: drawing(knockout.rtp, 100) });
  const bet = await placeFlightBet(env.db, env.userId, KO, { flight_id: r.flight_id, panel: 0, stake: 2, auto: 40, idempotency_key: key() }, { now: t0 + 500 });
  await cashOutFlightBet(env.db, env.userId, KO, { bet_id: bet.bet.bet_id, auto: true }, { now: t0 + knockout.waitMs + flightMs(40) + 5 });

  await env.db.query("UPDATE users SET phone = '0244123456' WHERE id = $1", [env.userId]);
  await saveGameControls(env.db, ADMIN, KO, { showcase: true });
  await saveGameControls(env.db, ADMIN, "volta-coin", { free_play: false });
  pub = await publicCatalog(env.db);
  assert.deepEqual([pub.free_play_off, pub.showcase], [["coin", "volta-coin"], ["knockout", "volta-knockout"]], "lobby and server ids, so the pages can read them");
  const shown = await bigWins(env.db, "knockout") as { showcase: boolean; wins: { player: string; x: number; payout: number }[] };
  assert.equal(shown.showcase, true);
  assert.equal(shown.wins.length, 1);
  assert.deepEqual([shown.wins[0]!.x, shown.wins[0]!.payout], [40, 80], "exactly what the player won");
  assert.equal(shown.wins[0]!.player, "024•••••56", "the number is masked");
  assert.equal((await bigWins(env.db, "coin") as { showcase: boolean }).showcase, false, "the coin's showcase is off");

  /* the overview carries both switches; turning them back is logged */
  const o = await gamesOverview(env.db);
  const ko = o.games.find((g) => g.id === KO)!;
  const coin = o.games.find((g) => g.id === "volta-coin")!;
  assert.deepEqual([ko.showcase, ko.free_play, coin.free_play], [true, true, false]);
  await saveGameControls(env.db, ADMIN, "volta-coin", { free_play: true });
  await assert.rejects(() => saveGameControls(env.db, ADMIN, KO, { showcase: "yes" }), isAdmin("invalid_showcase"));
  const log = await auditLog(env.db, { target: "game:volta-coin" });
  assert.deepEqual(log.actions.map((a) => [a.action, a.details?.after?.free_play]), [["game.controls", true], ["game.controls", false]]);
  assert.deepEqual((await publicCatalog(env.db)).free_play_off, []);
});
