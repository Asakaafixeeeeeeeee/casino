import assert from "node:assert/strict";
import test from "node:test";
import { setupWalletDb } from "./helpers/walletDb.js";
import { countryFromPhone, ensureWalletAccount } from "../src/services/accountLink.js";
import { getUserBalances } from "../src/services/balanceService.js";

/* ---------------- the multi-currency account: primary fiat, "other accounts" and points ---------------- */

test("A new player's primary account is in their country's currency, with a US dollar account at zero and points", async () => {
  const { db, client } = await setupWalletDb();
  const ghana = await ensureWalletAccount(db, "acct-gh", "ama", "+233241234567");
  const view = await getUserBalances(client, ghana);
  assert.equal(view.country, "GH");
  assert.deepEqual([view.primary.currencyCode, view.primary.symbol, view.primary.name], ["GHS", "₵", "Ghanaian Cedi"]);
  assert.equal(Number(view.primary.available), 0);
  assert.deepEqual(view.otherAccounts.map((a) => a.currencyCode), ["USD"], "the dollar account, and no retired crypto assets");
  assert.deepEqual([view.otherAccounts[0]!.kind, view.otherAccounts[0]!.symbol, view.otherAccounts[0]!.name], ["FIAT", "$", "US Dollar"]);
  assert.ok(view.otherAccounts.every((a) => Number(a.available) === 0 && Number(a.locked) === 0));
  assert.equal(Number(view.loyaltyPoints.available), 0);
  const points = await db.query("SELECT name FROM currencies WHERE code = 'VBP'");
  assert.equal(points.rows[0].name, "RendoWin Points");
});

test("The country is the one chosen at sign-up, else the phone's dialling code; every wallet settles in cedis", async () => {
  const { db, client } = await setupWalletDb();
  assert.deepEqual(await countryFromPhone(client, "+2348012345678"), { code: "NG", currency: "GHS" });
  assert.deepEqual(await countryFromPhone(client, "+233501234567"), { code: "GH", currency: "GHS" });
  assert.deepEqual(await countryFromPhone(client, "+9991234"), { code: "GH", currency: "GHS" });
  assert.deepEqual(await countryFromPhone(client, undefined), { code: "GH", currency: "GHS" });
  assert.deepEqual(await countryFromPhone(client, "+2348012345678", "KE"), { code: "KE", currency: "GHS" }, "the chosen country wins");
  assert.deepEqual(await countryFromPhone(client, "+2348012345678", "XX"), { code: "NG", currency: "GHS" }, "an unknown choice falls back to the number");

  const nigeria = await ensureWalletAccount(db, "acct-ng", "chidi", "+2348012345678", "NG");
  const view = await getUserBalances(client, nigeria);
  assert.equal(view.country, "NG");
  assert.equal(view.primary.currencyCode, "GHS");
  assert.equal(view.primary.symbol, "₵");
  /* the same account again is the same wallet, whatever number it logs in with later */
  assert.equal(await ensureWalletAccount(db, "acct-ng", "chidi", "+233200000000"), nigeria);
});
