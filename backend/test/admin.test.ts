import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { deposit } from "../src/services/balanceService.js";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { settleIntent } from "../src/services/tellerSettlement.js";
import {
  AdminError, adjustBalance, auditLog, catalogAdmin, creditByPhone, lookupByPhone, overview, searchUsers, setCatalog,
  setUserKyc, setUserStatus, transactions, userDetail,
} from "../src/services/admin.js";
import { CATALOG, hiddenCatalog, PROVIDERS } from "../src/games/availability.js";
import { GAMES, GameError } from "../src/games/catalog.js";
import { SESSION_GAMES } from "../src/games/sessionCatalog.js";
import { FLIGHT_GAMES, placeFlightBet, nextFlight } from "../src/games/flights.js";
import { SKY_ID } from "../src/games/skyRush.js";
import { LOTTO_ID } from "../src/games/lotto.js";
import { playRound } from "../src/games/rounds.js";
import { cashOutSession, openSession, startSession, stepSession } from "../src/games/sessions.js";
import { suspendedMayDo } from "../src/middleware/authenticate.js";
import { listAdminMinesSignals } from "../src/services/minesSignal.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0241112222";
let keyN = 0;
const key = () => "admin:test-" + ++keyN;

async function funded(amount = 100) {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", amount, "deposit:seed-admin");
  await env.client.query("COMMIT");
  return env;
}
/* a settled one-draw bet straight into game_rounds (for the reporting numbers) */
async function bet(db: Awaited<ReturnType<typeof setupWalletDb>>["db"], userId: string, game: string, stake: number, payout: number) {
  await db.query(
    `INSERT INTO game_rounds (user_id, game, currency, stake, payout, choice, outcome, idempotency_key)
     VALUES ($1, $2, 'GHS', $3, $4, '{}', '{}', $5)`, [userId, game, stake, payout, key()]);
}

/* ---------------- the catalog stays in step with the lobby ---------------- */

test("Every server game maps to a lobby game with the same name and studio", async () => {
  const sandbox: { window: { VB?: { games: { id: string; name: string; providerId: string }[] } }; document: unknown } =
    { window: {}, document: { addEventListener() {} } };
  vm.runInNewContext(await readFile(new URL("../../assets/js/data.js", import.meta.url), "utf8"), sandbox);
  const lobby = sandbox.window.VB!.games;
  const serverGames = [...Object.keys(GAMES), ...Object.keys(SESSION_GAMES), ...Object.keys(FLIGHT_GAMES), "volta-mines-live", "volta-magicball-live", SKY_ID, LOTTO_ID];
  assert.deepEqual(serverGames.sort(), Object.keys(CATALOG).sort(), "every server game has a catalog entry");
  for (const [serverId, c] of Object.entries(CATALOG)) {
    const g = lobby.find((x) => x.id === c.id);
    assert.ok(g, `${serverId} → lobby game ${c.id}`);
    assert.equal(g!.name, c.name, serverId);
    assert.equal(g!.providerId, c.provider, serverId);
    assert.ok(PROVIDERS[c.provider], c.provider);
  }
  assert.equal(new Set(Object.values(CATALOG).map((c) => c.id)).size, lobby.length, "and every lobby game is a server game");
});

/* ---------------- active Mines signals ---------------- */

test("Mines signals expose active hidden coordinates only to the admin projection", async () => {
  const { db, userId } = await funded(100);
  await startSession(db, userId, "volta-mines", {
    stake: 1,
    params: { mines: 3 },
    idempotency_key: key(),
  });
  const signal = (await listAdminMinesSignals(db)).find((item) => item.source === "standard")!;
  assert.equal(signal.game, "volta-mines");
  assert.equal(signal.playerId, userId);
  assert.equal(signal.username, "tester");
  assert.equal(signal.stake, 1);
  assert.equal(signal.totalMines, 3);
  assert.equal(signal.currentCashoutMultiplier, 1);
  assert.equal(signal.status, "OPEN");
  assert.equal(signal.minePositions.length, 3);
  assert.ok(signal.minePositions.every((position) => Number.isInteger(position) && position >= 0 && position < 25));
  assert.equal(new Set(signal.minePositions).size, 3);
  const playerState = await openSession(db, userId, "volta-mines");
  assert.ok(playerState);
  assert.equal("reveal" in playerState, false, "player state never receives the secret");
  assert.equal("minePositions" in playerState.state, false, "player state never receives mine coordinates");
});

test("Mines signals include active Mines Live bets without exposing their seeds", async () => {
  const { db, userId } = await funded(100);
  const now = Date.now();
  const roundNo = Math.floor(now / 180_000);
  await db.query(
    `INSERT INTO mines_live_rounds (no, seed, hash, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [roundNo, "live-signal-test-seed", "hash", new Date(now - 10_000), new Date(now + 170_000)],
  );
  await db.query(
    `INSERT INTO mines_live_bets (round_no, user_id, stake, picks, idempotency_key)
     VALUES ($1, $2, $3, $4, $5)`,
    [roundNo, userId, 1, [0, 1], "live-signal-test"],
  );

  const signal = (await listAdminMinesSignals(db)).find((item) => item.source === "live")!;
  assert.equal(signal.game, "volta-mines-live");
  assert.equal(signal.playerId, userId);
  assert.equal(signal.totalMines, 6);
  assert.equal(signal.pickedPositions.length, 2);
  assert.equal(signal.minePositions.length, 6);
  assert.equal(new Set(signal.minePositions).size, 6);
  assert.ok(signal.minePositions.every((position) => position >= 0 && position < 25));
  assert.equal(signal.source, "live");

  const minesBeforeStake = [...signal.minePositions].sort((a, b) => a - b);
  await db.query(
    `UPDATE mines_live_bets SET picks = $1 WHERE round_no = $2 AND user_id = $3`,
    [[2, 3], roundNo, userId],
  );
  const minesAfterStake = (await listAdminMinesSignals(db)).find((item) => item.source === "live")!.minePositions;
  assert.deepEqual(minesAfterStake, minesBeforeStake, "a stake must not change the shared mine positions");
});

test("Mines signals show an active Mines Live round before anyone bets", async () => {
  const { db } = await funded(100);
  const now = Date.now();
  const roundNo = Math.floor(now / 180_000);
  await db.query(
    `INSERT INTO mines_live_rounds (no, seed, hash, starts_at, ends_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [roundNo, "live-empty-round-seed", "hash", new Date(now - 10_000), new Date(now + 170_000), new Date(now)],
  );

  const signals = (await listAdminMinesSignals(db)).filter((item) => item.game === "volta-mines-live");
  const signal = signals[0]!;
  assert.equal(signal.username, "No bets yet");
  assert.equal(signal.stake, 0);
  assert.equal(signal.pickedPositions.length, 0);
  assert.equal(signal.minePositions.length, 6);
  assert.equal(signal.hasBet, false);
  assert.equal(signal.phase, "live");
  assert.equal(signal.roundNo, roundNo);
  assert.equal(signals.length, 2, "the next round is drawn ahead and shown too");
  const next = signals[1]!;
  assert.equal(next.phase, "next");
  assert.equal(next.roundNo, roundNo + 1);
  assert.ok(next.startsAt! > now);
  assert.equal(next.minePositions.length, 6);
  const again = (await listAdminMinesSignals(db)).filter((item) => item.game === "volta-mines-live")[1]!;
  assert.deepEqual(again.minePositions, next.minePositions, "the next round's board is fixed once it's shown");
});

/* ---------------- add money by phone ---------------- */

test("Add money by phone: finds the one player, credits through the audited path, add-only and logged", async () => {
  const { db, userId } = await setupWalletDb();
  await db.query(`UPDATE users SET phone = $1 WHERE id = $2`, ["0241234567", userId]);

  // a number in international form, with spaces, still resolves to the same player
  const found = await lookupByPhone(db, "+233 24 123 4567");
  assert.equal(found.id, userId);
  assert.equal(found.username, "tester");
  assert.equal(found.balance, 0);

  const res = await creditByPhone(db, ADMIN, { phone: "0241234567", amount: 50, reason: "Manual top-up test", idempotency_key: key() });
  assert.equal(res.added, 50);
  assert.equal(res.balance, 50);
  assert.equal(res.player.id, userId);

  // it lands in the ledger as an adjustment and in admin_actions
  const log = (await auditLog(db, { target: userId })).actions[0]!;
  assert.equal(log.action, "user.adjust");
  assert.equal(log.admin, ADMIN);

  // the same idempotency key doesn't credit twice
  const replay = await creditByPhone(db, ADMIN, { phone: "0241234567", amount: 50, reason: "Manual top-up test", idempotency_key: "admin:fixed-key" });
  const again = await creditByPhone(db, ADMIN, { phone: "0241234567", amount: 50, reason: "Manual top-up test", idempotency_key: "admin:fixed-key" });
  assert.equal(replay.balance, again.balance, "a retried key returns the same balance, not a second credit");

  // refused: unknown number, a debit (add only), a short reason, a malformed number
  await assert.rejects(() => creditByPhone(db, ADMIN, { phone: "0209999999", amount: 10, reason: "no such player here", idempotency_key: key() }),
    (e: unknown) => e instanceof AdminError && e.status === 404);
  await assert.rejects(() => creditByPhone(db, ADMIN, { phone: "0241234567", amount: -10, reason: "should be add only", idempotency_key: key() }),
    (e: unknown) => e instanceof AdminError && e.code === "invalid_amount");
  await assert.rejects(() => creditByPhone(db, ADMIN, { phone: "0241234567", amount: 10, reason: "short", idempotency_key: key() }),
    (e: unknown) => e instanceof AdminError && e.code === "reason_needed");
  await assert.rejects(() => lookupByPhone(db, "12345"),
    (e: unknown) => e instanceof AdminError && e.code === "invalid_phone");
});

test("Add money by phone refuses when two accounts share a number", async () => {
  const { db, userId } = await setupWalletDb();
  const other = await ensureWalletAccount(db, "account-dupe", "kofi");
  await db.query(`UPDATE users SET phone = $1 WHERE id IN ($2, $3)`, ["0241234567", userId, other]);
  await assert.rejects(() => lookupByPhone(db, "0241234567"),
    (e: unknown) => e instanceof AdminError && e.code === "ambiguous");
});

/* ---------------- the dashboard's numbers ---------------- */

test("Overview: players, money, revenue — and deposits with no confirmed payment behind them are flagged", async () => {
  const env = await funded(100); // a direct ledger credit: no TheTeller payment behind it
  const { db, userId } = env;
  // a real deposit: a TheTeller payment confirmed through the normal path
  await env.intentWithTx(50, "111122223333");
  await settleIntent(db, "111122223333", "approved", 5000);
  await bet(db, userId, "volta-coin", 10, 0);
  await bet(db, userId, "volta-coin", 10, 19.6);
  await bet(db, userId, "volta-crash", 5, 0);
  const o = await overview(db, "all");
  assert.equal(o.players.total, 1);
  assert.equal(o.players.active, 1);
  assert.equal(o.players.playingNow, 1);
  assert.equal(o.money.deposits, 150);
  assert.equal(o.money.depositCount, 2);
  assert.equal(o.money.firstDeposits, 1);
  assert.equal(o.money.playerBalances, 150, "the balances table, untouched by the inserted bets");
  assert.equal(o.gaming.stakes, 25);
  assert.equal(o.gaming.ggr, 5.4);
  assert.equal(o.gaming.bets, 3);
  assert.deepEqual(o.integrity, { unbackedDeposits: 1, unbackedAmount: 100 }, "only the direct credit is flagged");
  const coin = o.games.find((g) => g.game === "volta-coin")!;
  assert.deepEqual([coin.name, coin.provider, coin.bets, coin.stakes, coin.ggr], ["Flip Da' Coin", "accra", 2, 20, 0.4]);
  assert.equal(o.series.length, 14);
  assert.equal(o.series.at(-1)!.deposits, 150);
});

/* ---------------- players ---------------- */

test("Players: search by name or number, and a profile with lifetime totals", async () => {
  const { db, userId } = await funded(80);
  await db.query(`UPDATE users SET phone = '0241234567' WHERE id = $1`, [userId]);
  const other = await ensureWalletAccount(db, "account-2", "kofi99");
  await db.query(`UPDATE users SET phone = '0209876543' WHERE id = $1`, [other]);
  assert.deepEqual((await searchUsers(db, { q: "TEST" })).users.map((u) => u.username), ["tester"]);
  assert.deepEqual((await searchUsers(db, { q: "+233 20 987" })).users.map((u) => u.username), ["kofi99"]);
  assert.equal((await searchUsers(db, {})).total, 2);
  assert.equal((await searchUsers(db, { q: "50%" })).total, 0, "LIKE wildcards are just text");
  await bet(db, userId, "volta-mines", 4, 10);
  const d = await userDetail(db, userId);
  assert.equal(d.profile.username, "tester");
  assert.equal(d.profile.balance, 80);
  assert.equal(d.totals.deposited, 80);
  assert.deepEqual([d.totals.staked, d.totals.won, d.totals.ggr], [4, 10, -6]);
  assert.equal(d.bets[0]!.name, "Mines");
  assert.equal(d.transactions[0]!.type, "DEPOSIT");
  await assert.rejects(() => userDetail(db, "nope"), (e: unknown) => e instanceof AdminError && e.status === 404);
});

test("Suspend, reactivate and set KYC — each recorded with the admin who did it", async () => {
  const { db, userId } = await funded();
  await assert.rejects(() => setUserStatus(db, ADMIN, userId, { status: "SUSPENDED" }), AdminError, "a reason is needed");
  await setUserStatus(db, ADMIN, userId, { status: "SUSPENDED", reason: "chargeback fraud" });
  assert.equal((await userDetail(db, userId)).profile.status, "SUSPENDED");
  assert.equal((await searchUsers(db, { status: "SUSPENDED" })).total, 1);
  await setUserStatus(db, ADMIN, userId, { status: "ACTIVE" });
  await setUserKyc(db, ADMIN, userId, { kyc: "VERIFIED", note: "Ghana Card checked" });
  const d = await userDetail(db, userId);
  assert.equal(d.profile.kyc, "VERIFIED");
  assert.deepEqual(d.actions.map((a) => a.action), ["user.kyc", "user.status", "user.status"]);
  assert.ok(d.actions.every((a) => a.admin === ADMIN));
  assert.equal((await auditLog(db, { target: userId })).actions.length, 3);
});

test("A suspended account can look and finish a round in play, but not bet, deposit or withdraw", () => {
  for (const ok of [["GET", "/api/user/balances"], ["POST", "/api/games/volta-mines/cashout"], ["POST", "/api/games/volta-mines/step"],
    ["POST", "/api/games/volta-crash/flight/cancel"], ["POST", "/api/games/volta-mines-live/live/cancel"], ["POST", "/api/user/self-exclusion"],
    ["POST", "/api/user/limits?x=1"], ["GET", "/api/games/volta-crash/flight/abc/wait"]]) {
    assert.ok(suspendedMayDo(ok[0]!, ok[1]!), ok.join(" "));
  }
  for (const no of [["POST", "/api/games/volta-coin/play"], ["POST", "/api/games/volta-mines/start"], ["POST", "/api/games/volta-crash/flight/bet"],
    ["POST", "/api/games/volta-crash/flight/next"], ["POST", "/api/user/withdraw"], ["POST", "/api/payments/teller/momo"],
    ["POST", "/api/partners/apply"], ["POST", "/api/user/withdraw?cashout"]]) {
    assert.ok(!suspendedMayDo(no[0]!, no[1]!), no.join(" "));
  }
});

test("Balance corrections: credited or taken off through the ledger, with a reason and the admin's number", async () => {
  const { db, userId, balance } = await funded(50);
  await assert.rejects(() => adjustBalance(db, ADMIN, userId, { amount: 10, reason: "short", idempotency_key: key() }), AdminError);
  await assert.rejects(() => adjustBalance(db, ADMIN, userId, { amount: 0, reason: "goodwill credit", idempotency_key: key() }), AdminError);
  await assert.rejects(() => adjustBalance(db, ADMIN, userId, { amount: 60000, reason: "goodwill credit", idempotency_key: key() }), AdminError);
  const k = key();
  assert.equal((await adjustBalance(db, ADMIN, userId, { amount: 12.5, reason: "Goodwill for a delayed payout", idempotency_key: k })).balance, 62.5);
  const again = await adjustBalance(db, ADMIN, userId, { amount: 12.5, reason: "Goodwill for a delayed payout", idempotency_key: k });
  assert.equal(again.replayed, true);
  assert.equal(await balance(), 62.5, "a double click credits once");
  assert.equal((await adjustBalance(db, ADMIN, userId, { amount: -2.5, reason: "Duplicate bonus taken back", idempotency_key: key() })).balance, 60);
  await assert.rejects(() => adjustBalance(db, ADMIN, userId, { amount: -500, reason: "Duplicate bonus taken back", idempotency_key: key() }),
    (e: unknown) => e instanceof AdminError && e.code === "insufficient_funds");
  const j = (await db.query(`SELECT reason, created_by FROM ledger_journal WHERE entry_type = 'ADJUSTMENT' ORDER BY created_at`)).rows;
  assert.deepEqual(j.map((x) => x.created_by), [ADMIN, ADMIN]);
  assert.equal(j[0].reason, "Goodwill for a delayed payout");
  assert.equal((await userDetail(db, userId)).totals.adjustments, 10);
});

test("The money feed: newest first, by type, and only what's new since the last poll", async () => {
  const { db, userId } = await funded(30);
  await adjustBalance(db, ADMIN, userId, { amount: 5, reason: "Goodwill credit test", idempotency_key: key() });
  const all = (await transactions(db, {})).transactions;
  assert.deepEqual(all.map((t) => t.type), ["ADJUSTMENT", "DEPOSIT"]);
  assert.deepEqual((await transactions(db, { type: "deposits" })).transactions.map((t) => t.amount), [30]);
  assert.equal((await transactions(db, { type: "adjustments" })).transactions[0]!.by, ADMIN);
  assert.equal((await transactions(db, { after: all[0]!.id })).transactions.length, 0);
  await adjustBalance(db, ADMIN, userId, { amount: 1, reason: "Second goodwill credit", idempotency_key: key() });
  assert.equal((await transactions(db, { after: all[0]!.id })).transactions.length, 1);
  assert.equal((await transactions(db, { q: "nobody" })).transactions.length, 0);
});

/* ---------------- games and studios ---------------- */

test("Switching a game or a studio off stops new real-money bets; switching it on brings them back", async () => {
  const { db, userId } = await funded(100);
  await assert.rejects(() => setCatalog(db, ADMIN, "game", "nope", { enabled: false }), AdminError);
  await setCatalog(db, ADMIN, "game", "coin", { enabled: false });
  assert.deepEqual(await hiddenCatalog(db), { games: ["coin"], providers: [] });
  await assert.rejects(() => playRound(db, userId, "volta-coin", { stake: 1, choice: { pick: "HEADS" }, idempotency_key: key() }),
    (e: unknown) => e instanceof GameError && e.code === "game_disabled" && e.status === 503);
  await playRound(db, userId, "even-odd", { stake: 1, choice: { pick: "EVEN" }, idempotency_key: key() }); // others carry on

  await setCatalog(db, ADMIN, "provider", "bonwire", { enabled: false });
  const f = { ...await catalogAdmin(db, "30d") };
  assert.equal(f.providers.find((p) => p.id === "bonwire")!.enabled, false);
  assert.equal(f.games.find((g) => g.id === "crash")!.studioEnabled, false);
  await assert.rejects(() => nextFlight(db, userId, "volta-crash"), (e: unknown) => e instanceof GameError && e.code === "game_disabled");

  await setCatalog(db, ADMIN, "game", "coin", { enabled: true });
  await setCatalog(db, ADMIN, "provider", "bonwire", { enabled: true });
  await playRound(db, userId, "volta-coin", { stake: 1, choice: { pick: "HEADS" }, idempotency_key: key() });
  const fl = await nextFlight(db, userId, "volta-crash", { now: Date.now() });
  await placeFlightBet(db, userId, "volta-crash", { flight_id: fl.flight_id, panel: 0, stake: 1, idempotency_key: key() });
  assert.equal((await auditLog(db, {})).actions.filter((a) => a.action === "catalog.toggle").length, 4);
});

test("A round already in play can be finished after its game is switched off", async () => {
  const { db, userId } = await funded(100);
  const s = await startSession(db, userId, "volta-mines", { stake: 10, params: { mines: 3 }, idempotency_key: key() });
  const mines: number[] = (await db.query("SELECT secret FROM game_sessions WHERE id = $1", [s.session_id])).rows[0].secret.mines;
  await setCatalog(db, ADMIN, "game", "mines", { enabled: false });
  await assert.rejects(() => startSession(db, userId, "volta-mines", { stake: 1, params: { mines: 3 }, idempotency_key: key() }), GameError);
  const safe = [...Array(25).keys()].find((t) => !mines.includes(t))!;
  await stepSession(db, userId, "volta-mines", { session_id: s.session_id, move: safe });
  assert.equal((await cashOutSession(db, userId, "volta-mines", { session_id: s.session_id })).status, "WON");
});

test("Deposits show the number that paid, so one from someone else's wallet stands out", async () => {
  const env = await setupWalletDb();
  await env.db.query(`UPDATE users SET phone = '0241234567' WHERE id = $1`, [env.userId]);
  await env.intentWithTx(25, "222233334444");
  await env.db.query(`UPDATE payment_intents SET payer_phone = '0551112222' WHERE transaction_id = '222233334444'`);
  await settleIntent(env.db, "222233334444", "approved", 2500);
  const feed = (await transactions(env.db, { type: "deposits" })).transactions;
  assert.deepEqual([feed[0]!.payer, feed[0]!.phone], ["0551112222", "0241234567"]);
  assert.equal((await userDetail(env.db, env.userId)).transactions[0]!.payer, "0551112222");
});
