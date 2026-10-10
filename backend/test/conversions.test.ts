import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { setupWalletDb } from "./helpers/walletDb.js";
import { deposit, getUserBalances } from "../src/services/balanceService.js";
import { convert } from "../src/services/conversions.js";
import { FX_SPREAD, getRates, quoteConversion, resetRateCache } from "../src/services/fxRates.js";

/* a stand-in exchange-rate feed: the dollar at ₵ 12.50 — and it can be switched off */
let feedUp = true;
const feed = http.createServer((_req, res) => {
  if (!feedUp) { res.statusCode = 503; return res.end(); }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ result: "success", rates: { GHS: 12.5, EUR: 0.9 } }));
});
await new Promise<void>((r) => feed.listen(0, r));
process.env.FX_USD_GHS_URL = `http://127.0.0.1:${(feed.address() as { port: number }).port}/`;
test.after(() => feed.close());

async function funded(amount = 100) {
  resetRateCache();
  feedUp = true;
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", amount, "deposit:seed-fx");
  await env.client.query("COMMIT");
  return env;
}
const bal = (v: Awaited<ReturnType<typeof getUserBalances>>, code: string) =>
  Number(code === "GHS" ? v.primary.available : v.otherAccounts.find((a) => a.currencyCode === code)!.available);

test("A quote converts cedis to dollars at the feed's rate less the spread, to the cent", async () => {
  const { db } = await funded();
  const q = await quoteConversion(db, "GHS", "USD", 125);
  assert.equal(q.mid, 1 / 12.5);
  assert.equal(q.receive, Math.floor(10 * (1 - FX_SPREAD) * 100) / 100);
  assert.ok(q.receive < 10);
  const back = await quoteConversion(db, "USD", "GHS", 10);
  assert.equal(back.receive, Math.floor(125 * (1 - FX_SPREAD) * 100) / 100);
  assert.equal(back.valueGhs, 125);
});

test("Tiny, same-account, points and unknown conversions are refused", async () => {
  const { db } = await funded();
  await assert.rejects(quoteConversion(db, "GHS", "USD", 0.5), /at least ₵ 1\.00/);
  await assert.rejects(quoteConversion(db, "GHS", "GHS", 5), /two different/);
  await assert.rejects(quoteConversion(db, "GHS", "VBP", 5), /can be converted/);
  await assert.rejects(quoteConversion(db, "GHS", "BTC", 5), /can be converted/);
  await assert.rejects(quoteConversion(db, "GHS", "USD", "lots"), /Enter an amount/);
});

test("A conversion moves money between the player's own accounts and nets to zero against the FX desk", async () => {
  const { db, client, userId } = await funded(100);
  const out = await convert(db, userId, { from: "GHS", to: "USD", amount: 62.5, idempotency_key: "conv-0001" });
  assert.equal(bal(out.balances, "GHS"), 37.5);
  assert.equal(bal(out.balances, "USD"), out.quote.receive);
  /* and back again: the spread is paid both ways, so a little less than ₵ 62.50 returns */
  const back = await convert(db, userId, { from: "USD", to: "GHS", amount: out.quote.receive, idempotency_key: "conv-0002" });
  assert.equal(bal(back.balances, "USD"), 0);
  assert.ok(bal(back.balances, "GHS") > 37.5 + 62.5 * (1 - FX_SPREAD) ** 2 - 0.2 && bal(back.balances, "GHS") < 100);
  /* the desk's book: it holds what the player gave up and is short what it handed out */
  const desk = (await db.query(
    `SELECT currency_code, SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) AS net
       FROM ledger_entries WHERE system_account = 'fx-desk' GROUP BY currency_code ORDER BY currency_code`)).rows;
  assert.equal(Number(desk.find((d) => d.currency_code === "USD")!.net), 0);
  assert.ok(Number(desk.find((d) => d.currency_code === "GHS")!.net) > 0, "the spread stays with the house");
  const journal = (await db.query(`SELECT entry_type, metadata FROM ledger_journal WHERE id = $1`, [out.journalId])).rows[0];
  assert.equal(journal.entry_type, "CONVERSION");
  assert.equal(journal.metadata.rate, out.quote.rate);
  assert.equal(journal.metadata.rates_source, "feed");
  /* the same key again is the same conversion, not a second one */
  const again = await convert(db, userId, { from: "GHS", to: "USD", amount: 62.5, idempotency_key: "conv-0001" });
  assert.equal(again.journalId, out.journalId);
  assert.equal(bal(await getUserBalances(client, userId), "USD"), 0);
});

test("You can't convert more than you hold, and a short feed outage uses the last snapshot while a long one refuses", async () => {
  const { db, userId } = await funded(10);
  await assert.rejects(convert(db, userId, { from: "GHS", to: "USD", amount: 50, idempotency_key: "conv-over-1" }), /more than you have/);
  await getRates(db);                        /* snapshot taken */
  feedUp = false;
  resetRateCache();
  const q = await quoteConversion(db, "GHS", "USD", 10);
  assert.equal(q.source, "snapshot");
  assert.equal(q.mid, 1 / 12.5);
  resetRateCache();
  await db.query(`UPDATE fx_rates SET as_of = now() - interval '1 hour' WHERE source = 'feed'`);
  await assert.rejects(quoteConversion(db, "GHS", "USD", 10), /aren't available/);
});
