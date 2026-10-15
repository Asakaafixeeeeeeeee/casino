import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { GameError } from "../src/games/catalog.js";
import {
  buyLottoTicket, choose, createLottoDraw, currentLottoDraw, linesOf, lottoNumbersFromSeed, lottoPlacements, lottoState,
  lottoResultHash, myLottoTickets, pauseLottoDraw, previewLottoDraw, releaseLottoDraw, saveLottoSettings, shapeTicket, winningLines,
} from "../src/games/lotto.js";
import { createLotto as createAdminLotto, lottoKey, lottoOverview, releaseLotto } from "../src/services/lottoAdmin.js";
import { setupWalletDb } from "./helpers/walletDb.js";

/* Lotto, part two: Perm and Banker tickets, the admin's odds and bet types, admin-made draws, ALL LOTTO PLACEMENTS,
   the results preview and publishing with confirmation. 12:00 Ghana time; the daily draw is at 19:00, closing 18:50. */
const NOON = Date.UTC(2027, 0, 10, 12, 0);
const DRAW = Date.UTC(2027, 0, 10, 19, 0);
const CLOSE = DRAW - 10 * 60e3;
let keyN = 0;
const key = () => "lotto:bets-" + ++keyN;
const code = (c: string) => (e: unknown) => (e instanceof GameError || (e instanceof Error && "code" in e)) && (e as { code: string }).code === c;

async function world(amount = 1000) {
  const env = await setupWalletDb();
  const fund = async (userId: string, tag: string) => {
    await env.client.query("BEGIN");
    await deposit(env.client, userId, "GHS", amount, "deposit:lottob-" + tag);
    await env.client.query("COMMIT");
  };
  const kofi = await ensureWalletAccount(env.db, "account-2", "kofi", "0241234567");
  await env.db.query(`UPDATE users SET phone = '0241234567' WHERE id = $1`, [kofi]);
  await fund(env.userId, "tester");
  /* ticket sales open (they're off by default) */
  await env.db.query(`UPDATE lotto_settings SET real_money = true`);
  await fund(kofi, "kofi");
  const balanceOf = async (userId: string) => Number((await env.db.query(
    `SELECT available FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId])).rows[0].available);
  const drift = async () => (await env.db.query(`SELECT * FROM balance_reconciliation`)).rows.length;
  return { ...env, tester: env.userId, kofi, balanceOf, drift };
}

test("Lotto: lines and winning lines for Direct, Perm and Banker", () => {
  const drawn = [3, 17, 45, 60, 88];
  assert.equal(choose(5, 2), 10);
  assert.equal(linesOf({ bet_type: "PERM", size: 2, picks: [3, 17, 45, 50] }), 6);
  assert.equal(winningLines({ bet_type: "PERM", size: 2, picks: [3, 17, 45, 50], banker: null }, drawn), 3, "3 drawn: C(3,2) lines");
  assert.equal(winningLines({ bet_type: "PERM", size: 3, picks: [3, 17, 50, 51], banker: null }, drawn), 0);
  assert.equal(winningLines({ bet_type: "BANKER", size: 2, picks: [17, 45, 50], banker: 3 }, drawn), 2);
  assert.equal(winningLines({ bet_type: "BANKER", size: 2, picks: [17, 45, 50], banker: 4 }, drawn), 0, "banker not drawn: nothing wins");
  assert.equal(winningLines({ bet_type: "DIRECT", size: 2, picks: [3, 50], banker: null }, drawn), 0);
  assert.equal(winningLines({ bet_type: "DIRECT", size: 2, picks: [3, 88], banker: null }, drawn), 1);
  const s = { bet_types: { direct: [1, 2, 3], perm: [2], banker: true }, max_lines: 50 };
  assert.throws(() => shapeTicket({ bet_type: "DIRECT", picks: [1, 2, 3, 4] }, s), code("bet_type_off"));
  assert.throws(() => shapeTicket({ bet_type: "PERM", size: 3, picks: [1, 2, 3, 4] }, s), code("bet_type_off"));
  assert.throws(() => shapeTicket({ bet_type: "PERM", size: 2, picks: [1, 2] }, s), code("invalid_picks"));
  assert.throws(() => shapeTicket({ bet_type: "PERM", size: 2, picks: Array.from({ length: 11 }, (_, i) => i + 1) }, s), code("too_many_lines"));
  assert.throws(() => shapeTicket({ bet_type: "BANKER", banker: 5, picks: [5, 6] }, s), code("invalid_picks"));
  assert.throws(() => shapeTicket({ bet_type: "BANKER", banker: 5, against_all: true }, s), code("too_many_lines"));
  assert.equal(shapeTicket({ bet_type: "BANKER", banker: 5, against_all: true }, { ...s, max_lines: 89 }).lines, 89);
});

test("Lotto: Perm and Banker tickets take stake × lines once; preview pays nothing; publishing needs confirmation and pays each winning line once", async () => {
  const w = await world();
  const draw = (await currentLottoDraw(w.db, NOON))!;
  const n = lottoNumbersFromSeed(draw.seed, Number(draw.id));
  const miss = Array.from({ length: 90 }, (_, i) => i + 1).filter((x) => !n.includes(x));
  /* Perm 2 from 3 drawn numbers and 1 not: 6 lines at GHS 2 = 12; 3 winning lines × 2 × 360 */
  const perm = await buyLottoTicket(w.db, w.kofi, { bet_type: "PERM", size: 2, picks: [n[0], n[1], n[2], miss[0]], stake: 2, idempotency_key: key() }, { now: NOON });
  assert.equal(perm.ticket.lines, 6);
  assert.equal(perm.ticket.stake, 12);
  assert.equal(perm.ticket.bet, "Perm 2");
  assert.match(perm.ticket.code, /^LT-[0-9A-F]{10}$/);
  assert.equal(await w.balanceOf(w.kofi), 988);
  /* Banker on a drawn number with 2 drawn partners and 1 not: 3 lines at GHS 1; 2 winning lines × 1 × 360 */
  const bank = await buyLottoTicket(w.db, w.tester, { bet_type: "BANKER", banker: n[4], picks: [n[1], n[3], miss[1]], stake: 1, idempotency_key: key() }, { now: NOON });
  assert.equal(bank.ticket.stake, 3);
  assert.equal(bank.ticket.potential, 3 * 360, "the most it can win: all 3 lines");
  await assert.rejects(buyLottoTicket(w.db, w.tester, { bet_type: "PERM", size: 2, picks: [1, 2, 3], stake: 400, idempotency_key: key() }, { now: NOON }),
    code("invalid_stake"), "3 lines × 400 is over the ticket maximum");

  const pv = await previewLottoDraw(w.db, draw.id, CLOSE);
  assert.deepEqual(pv.numbers, n);
  assert.deepEqual(pv.totals, { tickets: 2, staked: 15, winners: 2, losers: 0, payout: 3 * 2 * 360 + 2 * 360 });
  assert.equal((await w.db.query(`SELECT count(*)::int AS c FROM lotto_tickets WHERE status <> 'ACTIVE'`)).rows[0].c, 0, "a preview pays nothing");

  await assert.rejects(releaseLotto(w.db, "admin", draw.id, {}), code("confirm_required"));
  const out = await releaseLotto(w.db, "admin", draw.id, { confirm: true });
  assert.equal(out.paid, 2160 + 720);
  await assert.rejects(releaseLottoDraw(w.db, draw.id, "admin", DRAW), code("already_decided"), "published results are locked");
  assert.equal(await w.balanceOf(w.kofi), 988 + 2160);
  assert.equal(await w.balanceOf(w.tester), 997 + 720);
  const mine = await myLottoTickets(w.db, w.kofi, "won");
  assert.equal(mine.tickets[0]!.winning_lines, 3);
  assert.deepEqual(mine.summary, { tickets: 1, pending: 0, won: 1, won_total: 2160 });
  const ov = await lottoOverview(w.db);
  const st = ov.settlements.find((x) => x.id === Number(draw.id))!;
  assert.equal(st.paid, 2880);
  assert.equal(st.published_by, "admin");
  const log = (await w.db.query(`SELECT action FROM admin_actions WHERE action = 'lotto.publish'`)).rows;
  assert.equal(log.length, 1, "publishing is in the audit log");
  assert.equal(await w.drift(), 0, "the ledger stays exact");
});

test("Lotto: admin odds are capped at the fair odds; bet types can be switched off", async () => {
  const w = await world();
  await assert.rejects(saveLottoSettings(w.db, "admin", { odds: { 1: 19, 2: 300, 3: 9000, 4: 400000, 5: 30000000 } }, NOON), code("invalid_odds"));
  const s = await saveLottoSettings(w.db, "admin",
    { odds: { 1: 15, 2: 300, 3: 9000, 4: 400000, 5: 30000000 }, bet_types: { direct: [1, 2], perm: [], banker: false } }, NOON);
  assert.equal(s.odds[1], 15);
  assert.equal(s.custom_odds, true);
  const t = await buyLottoTicket(w.db, w.kofi, { picks: [9], stake: 1, idempotency_key: key() }, { now: NOON });
  assert.equal(t.ticket.multiplier, 15);
  await assert.rejects(buyLottoTicket(w.db, w.kofi, { picks: [1, 2, 3], stake: 1, idempotency_key: key() }, { now: NOON }), code("bet_type_off"));
  await assert.rejects(buyLottoTicket(w.db, w.kofi, { bet_type: "BANKER", banker: 1, picks: [2], stake: 1, idempotency_key: key() }, { now: NOON }), code("bet_type_off"));
});

test("Lotto: an admin's own draw opens and closes on time, can be paused, and its tickets show in ALL LOTTO PLACEMENTS", async () => {
  const w = await world();
  const d = await createLottoDraw(w.db, "admin", {
    name: "Friday Mega", opens_at: new Date(NOON + 3600e3).toISOString(), closes_at: new Date(NOON + 5 * 3600e3).toISOString(),
    draw_at: new Date(NOON + 6 * 3600e3).toISOString() }, NOON);
  await assert.rejects(createLottoDraw(w.db, "admin", { name: "Bad", closes_at: new Date(NOON - 1).toISOString() }, NOON), code("invalid_times"));
  await assert.rejects(buyLottoTicket(w.db, w.kofi, { picks: [5], stake: 1, draw_id: d.id, idempotency_key: key() }, { now: NOON }), code("not_open_yet"));
  const later = NOON + 2 * 3600e3;
  assert.ok((await lottoState(w.db, later)).draws.some((x) => x.id === Number(d.id) && x.name === "Friday Mega"));
  await pauseLottoDraw(w.db, d.id, true);
  await assert.rejects(buyLottoTicket(w.db, w.kofi, { picks: [5], stake: 1, draw_id: d.id, idempotency_key: key() }, { now: later }), code("draw_paused"));
  await pauseLottoDraw(w.db, d.id, false);
  const t = await buyLottoTicket(w.db, w.kofi, { picks: [5, 6], stake: 4, draw_id: d.id, idempotency_key: key() }, { now: later });
  await buyLottoTicket(w.db, w.tester, { picks: [7], stake: 2, idempotency_key: key() }, { now: later });
  const all = await lottoPlacements(w.db, { draw: d.id }, later);
  assert.equal(all.tickets.length, 1);
  assert.equal(all.tickets[0]!.code, t.ticket.code);
  assert.equal(all.tickets[0]!.draw_name, "Friday Mega");
  assert.equal(all.tickets[0]!.phone, "0241234567");
  assert.deepEqual(all.tickets[0]!.picks, [5, 6]);
  assert.deepEqual(all.totals, { tickets: 1, stakes: 4, potential: 4 * 360, won: 0, lost: 0, pending: 1, paid: 0 });
  assert.equal((await lottoPlacements(w.db, { q: "kofi" }, later)).tickets.length, 1, "search by player");
  assert.equal((await lottoPlacements(w.db, { q: t.ticket.code.toLowerCase() }, later)).tickets.length, 1, "search by ticket code");
  const activeFirst = await lottoPlacements(w.db, { status: "ACTIVE", page: 1, page_size: 1 }, later);
  const activeSecond = await lottoPlacements(w.db, { status: "ACTIVE", page: 2, page_size: 1 }, later);
  assert.equal(activeFirst.totals.pending, 2);
  assert.equal(activeFirst.totals.stakes, 6);
  assert.equal(activeFirst.totals.potential, 4 * 360 + 2 * 16.2);
  assert.equal(activeFirst.tickets.length, 1);
  assert.equal(activeSecond.tickets.length, 1);
  assert.notEqual(activeFirst.tickets[0]!.code, activeSecond.tickets[0]!.code);
  assert.equal((await lottoPlacements(w.db, { period: "today" })).totals.tickets, 2, "tickets are stamped with the real time");
  assert.equal((await lottoPlacements(w.db, { period: "yesterday" })).totals.tickets, 0);
  await assert.rejects(previewLottoDraw(w.db, d.id, NOON + 4 * 3600e3), code("still_open"));
  await assert.rejects(buyLottoTicket(w.db, w.kofi, { picks: [5], stake: 1, draw_id: d.id, idempotency_key: key() }, { now: NOON + 5 * 3600e3 }), code("too_late"));
  assert.equal((await previewLottoDraw(w.db, d.id, NOON + 5 * 3600e3)).numbers.length, 5);
});

test("Lotto: manual numbers are committed before betting opens, hidden until release, and immutable through settlement", async () => {
  const w = await world();
  const base = Date.now();
  const closesAt = base + 4 * 3600e3;
  const drawAt = closesAt + 10 * 60e3;
  await assert.rejects(createLottoDraw(w.db, "admin", {
    name: "Bad manual draw", closes_at: new Date(closesAt).toISOString(), manual_numbers: [1, 1, 3, 4, 5],
  }, NOON), code("invalid_picks"));

  const selected = [4, 18, 27, 53, 81];
  const created = await createAdminLotto(w.db, "admin", {
    name: "Precommitted draw", opens_at: new Date(base + 60_000).toISOString(),
    closes_at: new Date(closesAt).toISOString(), draw_at: new Date(drawAt).toISOString(), manual_numbers: selected,
  });
  const d = (await w.db.query(`SELECT * FROM lotto_draws WHERE id = $1`, [created.id])).rows[0]!;
  assert.equal(d.number_source, "MANUAL");
  assert.deepEqual(d.numbers, selected);
  assert.equal(d.hash, lottoResultHash(d.seed, Number(d.id), selected, "MANUAL"));
  const audit = (await w.db.query(`SELECT details FROM admin_actions WHERE action = 'lotto.draw_create' AND target = $1`, [`lotto:${d.id}`])).rows[0]!.details;
  assert.deepEqual(audit.numbers, selected, "the chosen numbers and commitment are audited at creation");
  assert.equal(audit.commitment, d.hash);

  const publicState = await lottoState(w.db, base + 60_000);
  const publicDraw = publicState.draws.find((x) => x.id === Number(d.id))!;
  assert.equal(publicDraw.hash, d.hash);
  assert.equal(publicDraw.number_source, "MANUAL", "players can see that the result is preselected");
  assert.equal("numbers" in publicDraw, false, "manual picks remain hidden while betting is open");
  assert.equal("seed" in publicDraw, false);

  await buyLottoTicket(w.db, w.kofi, { picks: selected, stake: 1, draw_id: d.id, idempotency_key: key() }, { now: base + 60_000 });
  const preview = await previewLottoDraw(w.db, d.id, closesAt);
  assert.deepEqual(preview.numbers, selected, "closing preserves the precommitted result");
  assert.equal(preview.totals.winners, 1);
  await w.db.query(`UPDATE lotto_draws SET numbers = $2 WHERE id = $1`, [d.id, [1, 2, 3, 4, 5]]);
  assert.equal((await lottoKey(w.db, "admin")).pending.find((x) => x.id === Number(d.id))!.locked, false);
  await assert.rejects(releaseLottoDraw(w.db, d.id, "admin", drawAt), code("invalid_result_commitment"));
  await w.db.query(`UPDATE lotto_draws SET numbers = $2 WHERE id = $1`, [d.id, selected]);
  const out = await releaseLottoDraw(w.db, d.id, "admin", drawAt);
  assert.deepEqual(out.numbers, selected, "publication cannot replace the committed result");
  const publicResult = (await lottoState(w.db, drawAt)).results.find((x) => x.id === Number(d.id))!;
  assert.deepEqual(publicResult.numbers, selected);
  assert.equal(publicResult.number_source, "MANUAL");
  assert.equal(lottoResultHash(publicResult.seed!, Number(d.id), publicResult.numbers!, "MANUAL"), d.hash);
});
