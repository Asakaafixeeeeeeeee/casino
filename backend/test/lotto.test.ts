import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { setCatalogEnabled } from "../src/games/availability.js";
import { GameError } from "../src/games/catalog.js";
import {
  buyLottoTicket, cancelLottoDraw, currentLottoDraw, lottoAdminDraws, lottoChance, lottoMultipliers, lottoNumbersFromSeed,
  lottoState, lottoSweep, myLottoTickets, nextDrawAt, releaseLottoDraw, saveLottoSettings, LOTTO_AUTO_RELEASE_MS,
} from "../src/games/lotto.js";
import { setupWalletDb } from "./helpers/walletDb.js";

/* 12:00 Ghana time; the default draw is at 19:00 and betting closes at 18:50 */
const NOON = Date.UTC(2027, 0, 10, 12, 0);
const DRAW = Date.UTC(2027, 0, 10, 19, 0);
const CLOSE = DRAW - 10 * 60e3;
let keyN = 0;
const key = () => "lotto:test-" + ++keyN;
const code = (c: string) => (e: unknown) => e instanceof GameError && e.code === c;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

async function world(amount = 1000) {
  const env = await setupWalletDb();
  const fund = async (userId: string, tag: string) => {
    await env.client.query("BEGIN");
    await deposit(env.client, userId, "GHS", amount, "deposit:lotto-" + tag);
    await env.client.query("COMMIT");
  };
  const kofi = await ensureWalletAccount(env.db, "account-2", "kofi", "0241234567");
  await fund(env.userId, "tester");
  /* ticket sales open (they're off by default) */
  await env.db.query(`UPDATE lotto_settings SET real_money = true`);
  await fund(kofi, "kofi");
  const bal = async (userId: string) => (await env.db.query(
    `SELECT available, withdrawable FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId])).rows[0];
  const balanceOf = async (userId: string) => Number((await bal(userId)).available);
  const withdrawableOf = async (userId: string) => Number((await bal(userId)).withdrawable);
  const drift = async () => (await env.db.query(`SELECT * FROM balance_reconciliation`)).rows.length;
  return { ...env, tester: env.userId, kofi, balanceOf, withdrawableOf, drift };
}

/* ---------------- the maths ---------------- */

test("Lotto: the chances are C(5,k)/C(90,k) and the multipliers are RTP ÷ chance, rounded down", () => {
  assert.ok(Math.abs(lottoChance(1) - 1 / 18) < 1e-12);
  assert.ok(Math.abs(lottoChance(2) - 10 / 4005) < 1e-12);
  assert.ok(Math.abs(lottoChance(5) - 1 / 43949268) < 1e-15);
  const m: Record<number, number> = lottoMultipliers(0.9);
  assert.deepEqual({ ...m }, { 1: 16.2, 2: 360, 3: 10500, 4: 459000, 5: 39500000 });
  for (let k = 1; k <= 5; k++) assert.ok(m[k]! * lottoChance(k) <= 0.9 + 1e-9, `Direct-${k} never returns more than the RTP`);
});

test("Lotto: a seed gives 5 different numbers from 1-90, the same every time, each number equally likely", () => {
  const seed = crypto.randomBytes(32).toString("hex");
  const a = lottoNumbersFromSeed(seed, 7);
  assert.deepEqual(a, lottoNumbersFromSeed(seed, 7));
  assert.equal(a.length, 5);
  assert.equal(new Set(a).size, 5);
  assert.ok(a.every((n) => Number.isInteger(n) && n >= 1 && n <= 90));
  assert.deepEqual(a, [...a].sort((x, y) => x - y));
  const counts = new Array(91).fill(0);
  const N = 18000;
  for (let i = 0; i < N; i++) for (const n of lottoNumbersFromSeed(seed, i)) counts[n]++;
  const expected = (N * 5) / 90;
  for (let n = 1; n <= 90; n++) assert.ok(Math.abs(counts[n] - expected) < expected * 0.15, `${n}: ${counts[n]} vs ${expected}`);
});

test("Lotto: the next draw is today's draw time until betting closes, then tomorrow's", () => {
  assert.equal(nextDrawAt({ draw_time: "19:00", cutoff_min: 10 }, NOON).getTime(), DRAW);
  assert.equal(nextDrawAt({ draw_time: "19:00", cutoff_min: 10 }, CLOSE - 1).getTime(), DRAW);
  assert.equal(nextDrawAt({ draw_time: "19:00", cutoff_min: 10 }, CLOSE).getTime(), DRAW + 86400e3);
});

/* ---------------- tickets, the draw, release ---------------- */

test("Lotto: a ticket takes the stake once, and a winning ticket is paid on release (once) as withdrawable winnings", async () => {
  const w = await world();
  const draw = (await currentLottoDraw(w.db, NOON))!;
  assert.equal(draw.hash, sha256(draw.seed), "the public hash is the seed's");
  /* what the seed will draw — for the test only; the page never sees the seed before release */
  const numbers = lottoNumbersFromSeed(draw.seed, Number(draw.id));
  const losing = Array.from({ length: 90 }, (_, i) => i + 1).filter((n) => !numbers.includes(n)).slice(0, 2);

  const k1 = key();
  const win = await buyLottoTicket(w.db, w.kofi, { picks: [numbers[3], numbers[0]], stake: 2, idempotency_key: k1 }, { now: NOON });
  assert.deepEqual(win.ticket.picks, [numbers[0], numbers[3]].sort((a, b) => a! - b!));
  assert.equal(win.ticket.multiplier, 360);
  assert.equal(win.balance, 998);
  const again = await buyLottoTicket(w.db, w.kofi, { picks: [numbers[3], numbers[0]], stake: 2, idempotency_key: k1 }, { now: NOON });
  assert.equal(again.ticket.id, win.ticket.id, "the same key is the same ticket");
  assert.equal(await w.balanceOf(w.kofi), 998, "charged once");
  await buyLottoTicket(w.db, w.tester, { picks: losing, stake: 5, idempotency_key: key() }, { now: NOON });

  /* bad tickets */
  await assert.rejects(buyLottoTicket(w.db, w.tester, { picks: [1, 1], stake: 1, idempotency_key: key() }, { now: NOON }), code("invalid_picks"));
  await assert.rejects(buyLottoTicket(w.db, w.tester, { picks: [1, 2, 3, 4, 5, 6], stake: 1, idempotency_key: key() }, { now: NOON }), code("invalid_picks"));
  await assert.rejects(buyLottoTicket(w.db, w.tester, { picks: [0], stake: 1, idempotency_key: key() }, { now: NOON }), code("invalid_picks"));
  await assert.rejects(buyLottoTicket(w.db, w.tester, { picks: [91], stake: 1, idempotency_key: key() }, { now: NOON }), code("invalid_picks"));
  await assert.rejects(buyLottoTicket(w.db, w.tester, { picks: [7], stake: 0.2, idempotency_key: key() }, { now: NOON }), code("invalid_stake"));
  await assert.rejects(buyLottoTicket(w.db, w.tester, { picks: [7], stake: 5000, idempotency_key: key() }, { now: NOON }), code("invalid_stake"));
  await assert.rejects(buyLottoTicket(w.db, w.kofi, { picks: [7], stake: 1, idempotency_key: k1 }, { now: NOON }).then(() =>
    buyLottoTicket(w.db, w.tester, { picks: [7], stake: 1, idempotency_key: k1 }, { now: NOON })), code("key_reused"));

  /* the public page never shows the numbers before release, and release is refused while betting is open */
  const open = await lottoState(w.db, NOON);
  assert.equal(open.draw!.status, "OPEN");
  assert.equal((open.draw as { numbers?: number[] }).numbers, undefined);
  await assert.rejects(releaseLottoDraw(w.db, draw.id, "admin", NOON), code("still_open"));
  assert.equal((await lottoAdminDraws(w.db, NOON))[0]!.numbers, null, "nor does the admin's, while betting is open");

  /* betting closes: no more tickets on this draw; the admin now sees the numbers and what release will pay */
  await assert.rejects(buyLottoTicket(w.db, w.tester, { picks: [7], stake: 1, draw_id: draw.id, idempotency_key: key() }, { now: CLOSE }), code("too_late"));
  const closed = (await lottoAdminDraws(w.db, CLOSE)).find((d) => d.id === Number(draw.id))!;
  assert.equal(closed.status, "CLOSED");
  assert.deepEqual(closed.numbers, numbers);
  assert.deepEqual(closed.projected, { winners: 1, payout: 720 });
  assert.equal((await lottoState(w.db, CLOSE)).results[0]!.status, "DRAWING", "players see it as drawing, numbers still hidden");
  await assert.rejects(cancelLottoDraw(w.db, draw.id, "admin", CLOSE), code("too_late"), "no cancelling once the numbers exist");

  const out = await releaseLottoDraw(w.db, draw.id, "admin", DRAW);
  assert.deepEqual(out, { id: Number(draw.id), name: "Daily Draw", numbers, tickets: 2, winners: 1, losers: 1, paid: 720 });
  await assert.rejects(releaseLottoDraw(w.db, draw.id, "admin", DRAW), code("already_decided"), "paid once");
  assert.equal(await w.balanceOf(w.kofi), 998 + 720, "the reused key bought nothing");
  assert.ok(await w.withdrawableOf(w.kofi) >= 720, "the win is withdrawable");

  /* now public, with the seed to check it */
  const pub = (await lottoState(w.db, DRAW)).results.find((d) => d.id === Number(draw.id)) as { numbers?: number[]; seed?: string; hash: string };
  assert.deepEqual(pub.numbers, numbers);
  assert.equal(sha256(pub.seed!), pub.hash);
  const mine = await myLottoTickets(w.db, w.kofi);
  assert.equal(mine.tickets.find((t) => t.id === win.ticket.id)!.status, "WON");
  assert.equal(await w.drift(), 0, "the ledger stays exact");
});

test("Lotto: cancelling a draw while betting is open refunds every ticket in full", async () => {
  const w = await world();
  const draw = (await currentLottoDraw(w.db, NOON))!;
  await buyLottoTicket(w.db, w.kofi, { picks: [1, 2, 3], stake: 10, idempotency_key: key() }, { now: NOON });
  await buyLottoTicket(w.db, w.tester, { picks: [44], stake: 25, idempotency_key: key() }, { now: NOON });
  assert.equal(await w.balanceOf(w.kofi), 990);
  const out = await cancelLottoDraw(w.db, draw.id, "admin", NOON);
  assert.deepEqual(out, { id: Number(draw.id), tickets: 2, refunded: 35 });
  assert.equal(await w.balanceOf(w.kofi), 1000);
  assert.equal(await w.balanceOf(w.tester), 1000);
  await assert.rejects(buyLottoTicket(w.db, w.kofi, { picks: [5], stake: 1, idempotency_key: key() }, { now: NOON }), code("draw_cancelled"));
  await assert.rejects(releaseLottoDraw(w.db, draw.id, "admin", DRAW), code("already_decided"));
  assert.equal(await w.drift(), 0);
});

test("Lotto: a closed draw nobody released is released automatically a day after its draw time", async () => {
  const w = await world();
  const draw = (await currentLottoDraw(w.db, NOON))!;
  const numbers = lottoNumbersFromSeed(draw.seed, Number(draw.id));
  await buyLottoTicket(w.db, w.kofi, { picks: [numbers[2]!], stake: 10, idempotency_key: key() }, { now: NOON });
  await lottoSweep(w.db, DRAW + 3600e3);
  assert.equal((await w.db.query(`SELECT status FROM lotto_draws WHERE id = $1`, [draw.id])).rows[0].status, "CLOSED");
  await lottoSweep(w.db, DRAW + LOTTO_AUTO_RELEASE_MS);
  assert.equal((await w.db.query(`SELECT status FROM lotto_draws WHERE id = $1`, [draw.id])).rows[0].status, "RELEASED");
  assert.equal(await w.balanceOf(w.kofi), 990 + 162);
  assert.equal(await w.drift(), 0);
});

test("Lotto: switched off, no tickets; a new draw time moves the draw taking bets; tickets keep their multiplier", async () => {
  const w = await world();
  await setCatalogEnabled(w.db, "game", "lotto", false, "admin");
  await assert.rejects(buyLottoTicket(w.db, w.kofi, { picks: [5], stake: 1, idempotency_key: key() }, { now: NOON }), code("game_disabled"));
  await setCatalogEnabled(w.db, "game", "lotto", true, "admin");

  const t = await buyLottoTicket(w.db, w.kofi, { picks: [5], stake: 1, idempotency_key: key() }, { now: NOON });
  assert.equal(t.ticket.multiplier, 16.2);
  await saveLottoSettings(w.db, "admin", { draw_time: "21:30", rtp_pct: 80 }, NOON);
  const d = (await currentLottoDraw(w.db, NOON))!;
  assert.equal(new Date(d.draw_at).getTime(), Date.UTC(2027, 0, 10, 21, 30));
  assert.equal(Number(d.id), t.ticket.draw_id, "the same draw, moved");
  const t2 = await buyLottoTicket(w.db, w.kofi, { picks: [6], stake: 1, idempotency_key: key() }, { now: NOON });
  assert.equal(t2.ticket.multiplier, 14.4);
  assert.equal((await myLottoTickets(w.db, w.kofi)).tickets.find((x) => x.id === t.ticket.id)!.multiplier, 16.2);
  await assert.rejects(saveLottoSettings(w.db, "admin", { draw_time: "25:00" }, NOON), code("invalid_time"));
  await assert.rejects(saveLottoSettings(w.db, "admin", { rtp_pct: 120 }, NOON), code("invalid_rtp"));
});
