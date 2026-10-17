import assert from "node:assert/strict";
import test from "node:test";
import { closeDueLottoDraws, createLottoDraw, lottoAdminDraws, releaseLottoDraw } from "../src/games/lotto.js";
import { lottoKey } from "../src/services/lottoAdmin.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const NOON = Date.UTC(2027, 0, 10, 12, 0);
const iso = (ms: number) => new Date(ms).toISOString();

test("Lotto: a manual draw keeps exactly the numbers typed, is labelled apart from the automatic draw, and they can't change", async () => {
  const env = await setupWalletDb();
  const manual = await createLottoDraw(env.db, "admin", { name: "Manual special", closes_at: iso(NOON + 3600e3), manual_numbers: [81, 4, 53, 18, 27] }, NOON);
  assert.deepEqual(manual.numbers?.map(Number), [4, 18, 27, 53, 81]);
  assert.equal(manual.number_source, "MANUAL");

  const open = (await lottoAdminDraws(env.db, NOON + 60e3)).find((d) => d.id === Number(manual.id))!;
  assert.deepEqual(open.numbers, null, "the draws list still hides numbers while betting is open");
  const openHist = (await lottoKey(env.db, "admin")).history.find((x) => x.id === Number(manual.id))!;
  assert.deepEqual(openHist.numbers, [4, 18, 27, 53, 81], "the admin's history shows the numbers they entered");
  const auto = (await lottoAdminDraws(env.db, NOON + 60e3)).find((d) => d.auto)!;
  assert.equal(auto.numbers, null, "automatic numbers stay secret while betting is open");

  await assert.rejects(env.db.query(`UPDATE lotto_draws SET numbers = '{12,19,40,51,68}' WHERE id = $1`, [manual.id]), /locked/);
  await assert.rejects(env.db.query(`UPDATE lotto_draws SET number_source = 'SERVER' WHERE id = $1`, [manual.id]), /locked/);

  const after = NOON + 25 * 3600e3;
  await closeDueLottoDraws(env.db, after);
  const key = await lottoKey(env.db, "admin");
  const p = key.pending.find((x) => x.id === Number(manual.id))!;
  assert.deepEqual(p.numbers, [4, 18, 27, 53, 81]);
  assert.equal(p.auto, false);
  assert.equal(p.locked, true);
  const other = key.pending.find((x) => x.auto);
  if (other) assert.notDeepEqual(other.numbers, p.numbers);
  const h = key.history.find((x) => x.id === Number(manual.id))!;
  assert.equal(h.number_source, "MANUAL");
  assert.ok(h.created_at && h.draw_at);

  await releaseLottoDraw(env.db, manual.id, "admin", after);
  const row = (await env.db.query(`SELECT numbers, status FROM lotto_draws WHERE id = $1`, [manual.id])).rows[0];
  assert.deepEqual(row.numbers.map(Number), [4, 18, 27, 53, 81]);
  assert.equal(row.status, "RELEASED");
});
