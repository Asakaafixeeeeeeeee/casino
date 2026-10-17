import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { GameError } from "../src/games/catalog.js";
import {
  buyLottoTicket, closeDueLottoDraws, createLottoDraw, hideLottoResult, lottoState, releaseLottoDraw, saveLottoSettings,
} from "../src/games/lotto.js";
import { latestLottoResult, lottoWinners } from "../src/games/lottoWinners.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const NOON = Date.UTC(2027, 0, 10, 12, 0);
const iso = (ms: number) => new Date(ms).toISOString();

test("Lotto: deleting a published result hides it everywhere public but never touches tickets or money", async () => {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 100, "deposit:lotto-hide");
  await env.client.query("COMMIT");
  await saveLottoSettings(env.db, "admin", { real_money: true, licence_confirmed: true }, NOON);
  const draw = await createLottoDraw(env.db, "admin", { name: "Hide me", closes_at: iso(NOON + 3600e3) }, NOON);
  await buyLottoTicket(env.db, env.userId, { picks: [5], stake: 1, draw_id: Number(draw.id), idempotency_key: "lotto:hide-1" }, { now: NOON + 60e3 });

  await assert.rejects(hideLottoResult(env.db, draw.id, "admin"), (e: unknown) => e instanceof GameError && e.code === "not_published");

  const after = NOON + 4 * 3600e3;
  await closeDueLottoDraws(env.db, after);
  await releaseLottoDraw(env.db, draw.id, "admin", after);
  assert.ok((await lottoState(env.db, after)).results.some((r) => r.id === Number(draw.id)), "published results are public");
  assert.ok((await latestLottoResult(env.db)).result);

  const money = async () => (await env.db.query(`SELECT count(*) AS n, coalesce(sum(amount), 0)::text AS s FROM ledger_entries`)).rows[0];
  const tickets = async () => (await env.db.query(`SELECT status, payout, stake FROM lotto_tickets ORDER BY id`)).rows;
  const moneyBefore = await money();
  const ticketsBefore = await tickets();
  const totalsBefore = (await lottoWinners(env.db, after)).totals;

  await hideLottoResult(env.db, draw.id, "admin", "entered by mistake");
  assert.equal((await lottoState(env.db, after)).results.some((r) => r.id === Number(draw.id)), false, "gone from the public results");
  assert.equal((await latestLottoResult(env.db)).result, null, "gone from the winners popup");
  assert.deepEqual(await tickets(), ticketsBefore, "tickets are unchanged");
  assert.deepEqual(await money(), moneyBefore, "ledger is unchanged");
  assert.deepEqual((await lottoWinners(env.db, after)).totals, totalsBefore, "payout history totals are unchanged");
  const row = (await env.db.query(`SELECT status, result_hidden_by FROM lotto_draws WHERE id = $1`, [draw.id])).rows[0];
  assert.equal(row.status, "RELEASED");
  assert.equal(row.result_hidden_by, "admin");
  await assert.rejects(hideLottoResult(env.db, draw.id, "admin"), (e: unknown) => e instanceof GameError && e.code === "already_deleted");
});
