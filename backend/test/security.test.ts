/* Security regressions found in the pre-launch audit, driven over real HTTP where the bug only shows up on the wire. */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { setupWalletDb } from "./helpers/walletDb.js";
import { createApp } from "../src/app.js";
import * as shared from "../src/db.js";
import { deposit } from "../src/services/balanceService.js";
import { ensureWalletAccount } from "../src/services/accountLink.js";

/** The balance service on an ephemeral port, with a stub accounts server that says every token is player 501. */
async function stack() {
  const env = await setupWalletDb();
  (shared.db as unknown as { query: unknown }).query = env.db.query.bind(env.db);
  (shared.db as unknown as { connect: unknown }).connect = env.db.connect.bind(env.db);
  const accounts = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ user: { id: 501, username: "suspect", phone: "0241112233" } }));
  });
  await new Promise<void>((r) => accounts.listen(0, "127.0.0.1", r));
  process.env.ACCOUNTS_API_URL = `http://127.0.0.1:${(accounts.address() as AddressInfo).port}`;
  const userId = await ensureWalletAccount(env.db, "501", "suspect", "0241112233");
  await env.client.query("BEGIN");
  await deposit(env.client, userId, "GHS", 100, "deposit:security-seed");
  await env.client.query("COMMIT");
  const app = createApp(env.db).listen(0, "127.0.0.1");
  await new Promise<void>((r) => app.once("listening", () => r()));
  const port = (app.address() as AddressInfo).port;
  /* a raw request line, exactly as a hand-rolled client can send it (browsers never send a #fragment) */
  const raw = (method: string, target: string, body?: unknown) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const s = net.connect(port, "127.0.0.1", () => s.write(
      `${method} ${target} HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer token-for-501-0123456789\r\n` +
      (payload ? `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n` : "") + `Connection: close\r\n\r\n${payload}`));
    let out = "";
    s.on("data", (d) => (out += d));
    s.on("error", reject);
    s.on("end", () => {
      const [head, ...rest] = out.split("\r\n\r\n");
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(rest.join("\r\n\r\n")); } catch { /* not JSON */ }
      resolve({ status: Number(head!.split(" ")[1]), body: parsed });
    });
  });
  const balance = async () => Number((await env.db.query(
    `SELECT available FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId])).rows[0].available);
  const close = () => { app.close(); accounts.close(); };
  return { env, userId, raw, balance, close };
}

test("A suspended account can't bet, convert or withdraw by hiding a #fragment on the request line", async () => {
  const { env, userId, raw, balance, close } = await stack();
  try {
    await env.db.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [userId]);
    const key = () => "k-" + Math.random().toString(36).slice(2, 12);
    const attempts: [string, unknown][] = [
      ["/api/user/withdraw", { amount: 25, idempotency_key: key() }],
      ["/api/user/withdraw#/cashout", { amount: 25, idempotency_key: key() }],
      ["/api/user/withdraw#x/self-exclusion", { amount: 25, idempotency_key: key() }],
      ["/api/user/convert#/step", { from: "GHS", to: "USD", amount: 20, idempotency_key: key() }],
      ["/api/games/volta-coin/play#/cancel", { stake: 5, choice: { pick: "HEADS" }, idempotency_key: key() }],
      ["/api/games/volta-coin/play?x=/cashout", { stake: 5, choice: { pick: "HEADS" }, idempotency_key: key() }],
    ];
    for (const [target, body] of attempts) {
      const r = await raw("POST", target, body);
      assert.equal(r.status, 403, `${target} → ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "account_suspended");
    }
    assert.equal(await balance(), 100, "no money moved");
    /* what a suspended player may still do */
    assert.equal((await raw("GET", "/api/user/balances")).status, 200);
    assert.equal((await raw("POST", "/api/user/limits", { daily: 50, idempotency_key: key() })).status, 200);
  } finally {
    close();
  }
});
