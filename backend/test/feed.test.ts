import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { clearGameControlsCache } from "../src/games/availability.js";
import { clearFeedCache, gameFeed, siteActivity } from "../src/games/feed.js";
import { cashOutFlightBet, FLIGHT_GAMES, flightMs, nextFlight, placeFlightBet } from "../src/games/flights.js";
import { playRound } from "../src/games/rounds.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const KO = "volta-knockout";
const knockout = FLIGHT_GAMES[KO]!;
/** an rng that draws crash point x (see flights.test.ts) */
const drawing = (rtp: number, x: number) => () => 1 - (100 * rtp) / (100 * x + 0.5);

test("The public feed shows only real settled bets: masked players, real calls and multipliers, real results and players", async () => {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 200, "deposit:seed-feed");
  await env.client.query("COMMIT");
  await env.db.query("UPDATE users SET phone = '0551234567' WHERE id = $1", [env.userId]);
  clearGameControlsCache();

  /* nobody has played: nothing at all, no made-up players */
  const empty = await gameFeed(env.db, "coin");
  assert.deepEqual([empty.playing, empty.recent, empty.top, empty.results], [0, [], [], []]);

  /* four real coin flips */
  const flips = [];
  for (let i = 0; i < 4; i++) {
    flips.push(await playRound(env.db, env.userId, "volta-coin", { stake: 2, choice: { pick: i % 2 ? "TAILS" : "HEADS" }, idempotency_key: "round:feed-" + i }));
  }
  /* a real Knockout bet cashed out at 12x */
  const t0 = Date.now() - 60_000;
  const r = await nextFlight(env.db, env.userId, KO, { now: t0, rng: drawing(knockout.rtp, 50) });
  const bet = await placeFlightBet(env.db, env.userId, KO, { flight_id: r.flight_id, panel: 0, stake: 3, auto: 12, idempotency_key: "gm:feed-ko" }, { now: t0 + 500 });
  await cashOutFlightBet(env.db, env.userId, KO, { bet_id: bet.bet.bet_id, auto: true }, { now: t0 + knockout.waitMs + flightMs(12) + 5 });

  clearFeedCache(); /* the feeds are kept 5 seconds */
  const coin = await gameFeed(env.db, "volta-coin");
  assert.equal(coin.game, "coin");
  assert.equal(coin.playing, 1, "one real player in the last 5 minutes");
  assert.equal(coin.recent.length, 4);
  assert.ok(coin.recent.every((b) => b.player === "055•••••67" && b.stake === 2), "masked number, real stakes");
  assert.deepEqual(coin.recent.map((b) => b.pick).reverse(), ["HEADS", "TAILS", "HEADS", "TAILS"], "what each player called");
  assert.deepEqual(coin.recent.map((b) => b.payout).reverse(), flips.map((f) => f.payout), "what each bet really paid");
  assert.equal(coin.top.length, flips.filter((f) => f.payout > f.stake).length, "only real wins are top wins");
  assert.deepEqual(coin.results.map((o) => (o as { result: string }).result).reverse(), flips.map((f) => (f.outcome as { result: string }).result), "the real flips");

  const ko = await gameFeed(env.db, "knockout");
  assert.deepEqual([ko.recent.length, ko.recent[0]!.x, ko.recent[0]!.payout], [1, 12, 36]);
  assert.equal(ko.top[0]!.x, 12);
  assert.deepEqual(ko.results, [], "a flight game's rounds belong to each player; no shared results");

  const site = await siteActivity(env.db);
  assert.deepEqual(site.playing, { coin: 1, knockout: 1 }, "lobby ids, real players");
  assert.ok(site.wins.length >= 1 && site.wins.every((w) => w.payout > w.stake && w.player === "055•••••67"));
  assert.ok(site.wins.some((w) => w.game === "knockout" && w.payout === 36));
  /* the banner's wins: each real win once, the biggest marked */
  assert.equal(new Set(site.wins.map((w) => w.at + w.payout + w.game)).size, site.wins.length, "no win twice");
  assert.equal(site.wins.find((w) => w.payout === 36)!.big, true, "the 36 GHS Knockout win is one of the biggest");
  assert.equal(site.wins.length, 1 + flips.filter((f) => f.payout > f.stake).length, "every real win, nothing else");

  /* an unknown game: empty, never an error */
  assert.deepEqual((await gameFeed(env.db, "nope")).recent, []);
});
