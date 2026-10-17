import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { GameError } from "../src/games/catalog.js";
import { buyLottoTicket, createLottoDraw, saveLottoSettings, updateLottoDrawTimes } from "../src/games/lotto.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const NOON = Date.UTC(2027, 0, 10, 12, 0);
const code = (c: string) => (e: unknown) => e instanceof GameError && e.code === c;
const iso = (ms: number) => new Date(ms).toISOString();

test("Lotto: an admin can move a draw's closing time before it closes, and betting stops at that time", async () => {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 100, "deposit:lotto-times");
  await env.client.query("COMMIT");
  await saveLottoSettings(env.db, "admin", { real_money: true, licence_confirmed: true }, NOON);

  const draw = await createLottoDraw(env.db, "admin", { name: "Evening draw", closes_at: iso(NOON + 3600e3) }, NOON);
  const buy = (n: number, at: number) => buyLottoTicket(env.db, env.userId, { picks: [5], stake: 1, draw_id: Number(draw.id), idempotency_key: `lotto:times-${n}` }, { now: at });
  await buy(1, NOON + 60e3);

  const moved = await updateLottoDrawTimes(env.db, draw.id, { closes_at: iso(NOON + 2 * 3600e3) }, NOON);
  assert.equal(new Date(moved.after.closes_at).getTime(), NOON + 2 * 3600e3);
  assert.ok(new Date(moved.after.draw_at).getTime() >= NOON + 2 * 3600e3, "the draw never falls before betting closes");
  await buy(2, NOON + 3600e3 + 60e3);
  await assert.rejects(updateLottoDrawTimes(env.db, draw.id, { closes_at: iso(NOON - 1) }, NOON), code("invalid_times"));
  await assert.rejects(buy(3, NOON + 2 * 3600e3 + 1), (e: unknown) => e instanceof GameError, "no bets after the closing time");
  await assert.rejects(updateLottoDrawTimes(env.db, draw.id, { closes_at: iso(NOON + 3 * 3600e3) }, NOON + 2 * 3600e3 + 1), code("not_open"));
});
