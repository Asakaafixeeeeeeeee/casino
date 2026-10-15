import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { buyLottoTicket, currentLottoDraw, lottoNumbersFromSeed, releaseLottoDraw } from "../src/games/lotto.js";
import { lottoWinners } from "../src/games/lottoWinners.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const NOON = Date.UTC(2027, 0, 10, 12, 0);
const DRAW = Date.UTC(2027, 0, 10, 19, 0);
const CLOSE = DRAW - 10 * 60e3;
let keyN = 0;
const key = () => "lotto:winners-" + ++keyN;

test("Lotto winners: only real winning tickets of released draws, with the amount paid and a masked number", async () => {
  const env = await setupWalletDb();
  const kofi = await ensureWalletAccount(env.db, "account-2", "kofi", "0241234567");
  for (const [id, tag] of [[env.userId, "a"], [kofi, "b"]] as const) {
    await env.client.query("BEGIN");
    await deposit(env.client, id, "GHS", 500, "deposit:winners-" + tag);
    await env.client.query("COMMIT");
  }
  await env.db.query(`UPDATE lotto_settings SET real_money = true`);
  await env.db.query(`UPDATE users SET phone = $1 WHERE id = $2`, ["0241234567", kofi]); // set at sign-in in production

  /* nobody has won yet: nothing to show, nothing made up */
  assert.deepEqual(await lottoWinners(env.db, NOON), { top: [], latest: [], totals: { winners: 0, paid: 0, draws: 0 } });

  const draw = (await currentLottoDraw(env.db, NOON))!;
  const numbers = lottoNumbersFromSeed(draw.seed, Number(draw.id));
  const losing = Array.from({ length: 90 }, (_, i) => i + 1).filter((n) => !numbers.includes(n)).slice(0, 2);
  await buyLottoTicket(env.db, kofi, { picks: [numbers[1]!, numbers[4]!], stake: 2, idempotency_key: key() }, { now: NOON });
  await buyLottoTicket(env.db, env.userId, { picks: losing, stake: 5, idempotency_key: key() }, { now: NOON });

  /* drawn but not released: still nothing public */
  assert.equal((await lottoWinners(env.db, CLOSE)).latest.length, 0);

  await releaseLottoDraw(env.db, draw.id, "admin", DRAW);
  const w = await lottoWinners(env.db, DRAW);
  assert.equal(w.latest.length, 1, "the losing ticket is not a winner");
  const win = w.latest[0]!;
  assert.equal(win.player, "024•••••67", "a masked number, never the full number or a name");
  assert.equal(win.payout, 720);
  assert.equal(win.stake, 2);
  assert.equal(win.x, 360);
  assert.equal(win.bet, "Direct-2");
  assert.deepEqual(win.matched, [numbers[1]!, numbers[4]!].sort((a, b) => a - b));
  assert.deepEqual(win.numbers, numbers);
  assert.deepEqual(w.top, w.latest);
  assert.deepEqual(w.totals, { winners: 1, paid: 720, draws: 1 });
  assert.ok(!JSON.stringify(w).includes("0241234567"));
});
