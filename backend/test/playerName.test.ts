/* The player's full name: the accounts server owns it (asked for at sign-up); signing in here copies it onto the
   wallet's user, for the admin and Ghana admin pages. Driven over real HTTP with a stub accounts server. */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { setupWalletDb } from "./helpers/walletDb.js";
import { createApp } from "../src/app.js";
import * as shared from "../src/db.js";
import { searchUsers, userDetail } from "../src/services/admin.js";

test("Signing in copies the player's full name from the accounts server, keeps it current, and admins can find them by it", async () => {
  const env = await setupWalletDb();
  (shared.db as unknown as { query: unknown }).query = env.db.query.bind(env.db);
  (shared.db as unknown as { connect: unknown }).connect = env.db.connect.bind(env.db);
  /* what the accounts server says about the token's player; each step below changes it */
  let account: Record<string, unknown> = { id: 9001, username: "Player123456", phone: "0249001122", full_name: "Ama Owusu" };
  const accounts = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ user: account }));
  });
  await new Promise<void>((r) => accounts.listen(0, "127.0.0.1", r));
  process.env.ACCOUNTS_API_URL = `http://127.0.0.1:${(accounts.address() as AddressInfo).port}`;
  const app = createApp(env.db).listen(0, "127.0.0.1");
  await new Promise<void>((r) => app.once("listening", () => r()));
  const signIn = async () => {
    const r = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/api/user/balances`, { headers: { Authorization: "Bearer token-9001-0123456789" } });
    assert.equal(r.status, 200);
  };
  const stored = async () => (await env.db.query(`SELECT full_name FROM users WHERE username = 'Player123456'`)).rows[0]?.full_name ?? null;
  try {
    await signIn();
    assert.equal(await stored(), "Ama Owusu", "the first sign-in opens the wallet with the name");

    account = { ...account, full_name: "Ama Owusu-Mensah" };
    await signIn();
    assert.equal(await stored(), "Ama Owusu-Mensah", "a changed name is copied at once");

    account = { ...account, full_name: null };
    await signIn();
    assert.equal(await stored(), "Ama Owusu-Mensah", "an answer without a name never wipes the one kept");

    const found = await searchUsers(env.db, { q: "owusu" });
    assert.deepEqual(found.users.map((u) => [u.username, u.full_name]), [["Player123456", "Ama Owusu-Mensah"]]);
    assert.equal((await userDetail(env.db, found.users[0]!.id)).profile.full_name, "Ama Owusu-Mensah");
  } finally {
    app.close();
    accounts.close();
  }
});
