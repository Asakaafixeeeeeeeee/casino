import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { GameError } from "../src/games/catalog.js";
import { buyLottoTicket, lottoState, saveLottoSettings } from "../src/games/lotto.js";
import { setupWalletDb } from "./helpers/walletDb.js";

/* Real-money Lotto ticket sales are off until an admin switches them on, confirming the licence is in place. */
const NOON = Date.UTC(2027, 0, 10, 12, 0);
const code = (c: string) => (e: unknown) => e instanceof GameError && e.code === c;

test("Lotto: ticket sales are off by default, and opening them needs the licence confirmed", async () => {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 100, "deposit:lotto-sales");
  await env.client.query("COMMIT");
  assert.equal((await lottoState(env.db, NOON)).real_money, false);
  await assert.rejects(buyLottoTicket(env.db, env.userId, { picks: [5], stake: 1, idempotency_key: "lotto:sales-1" }, { now: NOON }), code("sales_closed"));
  await assert.rejects(saveLottoSettings(env.db, "admin", { real_money: true }, NOON), code("licence_required"));
  assert.equal((await saveLottoSettings(env.db, "admin", { real_money: true, licence_confirmed: true }, NOON)).real_money, true);
  const t = await buyLottoTicket(env.db, env.userId, { picks: [5], stake: 1, idempotency_key: "lotto:sales-2" }, { now: NOON });
  assert.equal(t.balance, 99);
  assert.equal((await saveLottoSettings(env.db, "admin", { real_money: false }, NOON)).real_money, false, "switching off needs no confirmation");
});
