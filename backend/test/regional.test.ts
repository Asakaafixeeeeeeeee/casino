import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { auditLog } from "../src/services/admin.js";
import { createPaymentIntent } from "../src/services/teller.js";
import { requestWithdrawal } from "../src/services/withdrawals.js";
import { verifyPassword } from "../src/crypto.js";
import {
  createRegionalAdmin, isWeakPin, listRegionalAdmins, loginRegional, logoutRegional, newPin, regionalFromToken,
  RegionalError, regionalSummary, regionalTransactions, resetRegionalPin, setRegionalStatus, tenPercent,
} from "../src/services/regional.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0209999001";
const code = (c: string) => (e: unknown) => e instanceof RegionalError && e.code === c;
let keyN = 0;
const key = () => "regional:test-" + ++keyN;
const T0 = Date.parse("2026-10-10T12:00:00Z");

/* ---------------- PINs and the 10% figure ---------------- */

test("Regional admin: PINs are six random digits, never an easy one", () => {
  for (let i = 0; i < 3000; i++) {
    const pin = newPin();
    assert.match(pin, /^\d{6}$/);
    assert.equal(isWeakPin(pin), false, pin);
  }
  for (const weak of ["000000", "777777", "123456", "654321", "890123", "121212", "123123", "112233", "12345", "abcdef", "1234567"]) {
    assert.equal(isWeakPin(weak), true, weak);
  }
  for (const fine of ["204918", "730561", "958204"]) assert.equal(isWeakPin(fine), false, fine);
});

test("Regional admin: 10% of a day's revenue, rounded toward zero to the cent", () => {
  assert.equal(tenPercent(125.55), 12.55);
  assert.equal(tenPercent(-32.05), -3.2);
  assert.equal(tenPercent(0.09), 0);
  assert.equal(tenPercent(0), 0);
  assert.equal(tenPercent(1000), 100);
});

/* ---------------- accounts, signing in, locks ---------------- */

test("Regional admin: a full admin makes the account; its PIN is shown once and kept only as a salted hash", async () => {
  const { db } = await setupWalletDb();
  await assert.rejects(() => createRegionalAdmin(db, ADMIN, { username: "a b" }), code("invalid_username"));
  await assert.rejects(() => createRegionalAdmin(db, ADMIN, { username: "kofi", region: "NG" }), code("invalid_region"));
  const made = await createRegionalAdmin(db, ADMIN, { username: "Kofi.GH", name: "Kofi  Mensah" });
  assert.match(made.pin, /^\d{6}$/);
  assert.deepEqual([made.admin.username, made.admin.name, made.admin.region, made.admin.status], ["kofi.gh", "Kofi Mensah", "GH", "ACTIVE"]);
  assert.ok(!JSON.stringify(made.admin).includes(made.pin), "the account's details never carry the PIN");
  const row = (await db.query(`SELECT pin_hash FROM regional_admins WHERE id = $1`, [made.admin.id])).rows[0];
  assert.ok(!row.pin_hash.includes(made.pin), "the stored hash isn't the PIN");
  assert.match(row.pin_hash, /^pbkdf2\$\d+\$/);
  assert.equal(await verifyPassword(made.pin, row.pin_hash), true);
  await assert.rejects(() => createRegionalAdmin(db, ADMIN, { username: "KOFI.gh" }), code("username_taken"));
  assert.equal((await listRegionalAdmins(db)).admins.length, 1);
  assert.equal((await auditLog(db, { target: made.admin.id })).actions[0]!.action, "regional.create");
});

test("Regional admin: the right PIN signs in for 12 hours; wrong ones and unknown names get the same answer", async () => {
  const { db } = await setupWalletDb();
  const { admin, pin } = await createRegionalAdmin(db, ADMIN, { username: "ama.gh" });
  const wrongPin = pin === "204918" ? "730561" : "204918";
  await assert.rejects(() => loginRegional(db, { username: "ama.gh", pin: wrongPin }, { now: T0 }), code("bad_login"));
  await assert.rejects(() => loginRegional(db, { username: "nobody", pin }, { now: T0 }), code("bad_login"));
  await assert.rejects(() => loginRegional(db, { username: "ama.gh", pin: "12ab56" }, { now: T0 }), code("bad_login"));
  const s = await loginRegional(db, { username: " AMA.GH ", pin }, { now: T0, ip: "203.0.113.9" });
  assert.match(s.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(s.expires_at, new Date(T0 + 12 * 3600e3).toISOString());
  assert.equal(s.admin.failed_attempts, 0, "a good sign-in clears the wrong tries");
  const stored = (await db.query(`SELECT token_hash FROM regional_admin_sessions`)).rows;
  assert.deepEqual(stored.map((r) => r.token_hash), [crypto.createHash("sha256").update(s.token).digest("hex")], "only the token's hash is kept");
  assert.deepEqual(await regionalFromToken(db, s.token, T0 + 3600e3), { id: admin.id, username: "ama.gh", name: null, region: "GH" });
  assert.equal(await regionalFromToken(db, s.token, T0 + 12 * 3600e3 + 1), null, "a sign-in ends after 12 hours");
  assert.equal(await regionalFromToken(db, "x".repeat(43), T0), null);
  await logoutRegional(db, s.token);
  assert.equal(await regionalFromToken(db, s.token, T0), null, "signing out ends it");
});

test("Regional admin: 5 wrong PINs lock the account for 15 minutes, 10 for 24 hours; a full admin can unlock it", async () => {
  const { db } = await setupWalletDb();
  const { admin, pin } = await createRegionalAdmin(db, ADMIN, { username: "yaw.gh" });
  const wrongPin = pin === "204918" ? "730561" : "204918";
  const tryPin = (p: string, now: number) => loginRegional(db, { username: "yaw.gh", pin: p }, { now });
  for (let i = 0; i < 5; i++) await assert.rejects(() => tryPin(wrongPin, T0), code("bad_login"));
  await assert.rejects(() => tryPin(pin, T0 + 60_000), code("locked"), "even the right PIN waits out the lock");
  const back = await tryPin(pin, T0 + 16 * 60_000);
  assert.ok(back.token, "after 15 minutes the right PIN works again");

  /* ten wrong in a row: from then on each wrong PIN locks for a day */
  let t = T0 + 20 * 60_000;
  for (let i = 1; i <= 10; i++) {
    await assert.rejects(() => tryPin(wrongPin, t), code("bad_login"));
    t += i % 5 === 0 ? 16 * 60_000 : 1000; // wait out each 15-minute lock
  }
  await assert.rejects(() => tryPin(pin, t + 23 * 3600e3), code("locked"));
  const list = (await listRegionalAdmins(db)).admins;
  assert.ok(list[0]!.locked_until, "the admin page shows the lock");
  assert.equal((await auditLog(db, { target: admin.id })).actions.filter((a) => a.action === "regional.locked").length, 3);
  await setRegionalStatus(db, ADMIN, admin.id, { status: "ACTIVE" });
  assert.ok((await tryPin(pin, t)).token, "a full admin's unlock lets the right PIN in at once");
});

test("Regional admin: switching an account off ends its sign-ins; a new PIN replaces the old one everywhere", async () => {
  const { db } = await setupWalletDb();
  const { admin, pin } = await createRegionalAdmin(db, ADMIN, { username: "esi.gh" });
  const s = await loginRegional(db, { username: "esi.gh", pin }, { now: T0 });
  await setRegionalStatus(db, ADMIN, admin.id, { status: "DISABLED" });
  assert.equal(await regionalFromToken(db, s.token, T0), null);
  await assert.rejects(() => loginRegional(db, { username: "esi.gh", pin }, { now: T0 }), code("disabled"));
  const wrongPin = pin === "204918" ? "730561" : "204918";
  await assert.rejects(() => loginRegional(db, { username: "esi.gh", pin: wrongPin }, { now: T0 }), code("bad_login"),
    "a wrong PIN doesn't learn the account is off");
  await assert.rejects(() => setRegionalStatus(db, ADMIN, admin.id, { status: "PAUSED" }), code("invalid_status"));
  await setRegionalStatus(db, ADMIN, admin.id, { status: "ACTIVE" });
  const s2 = await loginRegional(db, { username: "esi.gh", pin }, { now: T0 });
  const reset = await resetRegionalPin(db, ADMIN, admin.id);
  assert.notEqual(reset.pin, pin);
  assert.equal(await regionalFromToken(db, s2.token, T0), null, "a PIN reset ends every sign-in");
  await assert.rejects(() => loginRegional(db, { username: "esi.gh", pin }, { now: T0 }), code("bad_login"));
  assert.ok((await loginRegional(db, { username: "esi.gh", pin: reset.pin }, { now: T0 })).token);
  await assert.rejects(() => resetRegionalPin(db, ADMIN, "not-an-id"), code("not_found"));
});

/* ---------------- Ghana's money only ---------------- */

async function ghanaAndNigeria() {
  const env = await setupWalletDb();
  const { db, client } = env;
  const ama = await ensureWalletAccount(db, "acct-ama", "ama", "0241234567", "GH");
  const kojo = await ensureWalletAccount(db, "acct-kojo", "kojo", "0201234567", "GH");
  const chidi = await ensureWalletAccount(db, "acct-chidi", "chidi", "+2348012345678", "NG");
  /* signing in records the number and full name (authenticate → touchUser); these players never sign in here, so set
     them the same way. Kojo signed up before names were asked for. */
  for (const [id, phone, name] of [[ama, "0241234567", "Ama Owusu"], [kojo, "0201234567", null], [chidi, "+2348012345678", "Chidi Okafor"]]) {
    await db.query(`UPDATE users SET phone = $2, full_name = $3 WHERE id = $1`, [id, phone, name]);
  }
  assert.deepEqual((await db.query(`SELECT country_code FROM users WHERE id = ANY($1) ORDER BY username`, [[ama, chidi, kojo]])).rows
    .map((r) => r.country_code), ["GH", "NG", "GH"]);
  let tx = 100000000000;
  const intent = async (userId: string, amount: number, status: string, payer: string | null, hosted = false, at?: Date) => {
    const i = await createPaymentIntent(client, userId, amount, "GHS", "deposit:" + key(), "https://site/wallet.html");
    const txId = String(++tx);
    await db.query(`UPDATE payment_intents SET transaction_id = $2, status = $3, payer_phone = $4, checkout_url = $5,
                      created_at = coalesce($6, created_at) WHERE id = $1`,
      [i.id, txId, status, payer, hosted ? "https://checkout.theteller.net/x" : null, at ?? null]);
    if (status === "CONFIRMED") {
      await client.query("BEGIN");
      await deposit(client, userId, "GHS", amount, "teller:" + txId, txId);
      await client.query("COMMIT");
    }
    return txId;
  };
  const bet = (userId: string, stake: number, payout: number, at: Date) => db.query(
    `INSERT INTO game_rounds (user_id, game, currency, stake, payout, choice, outcome, idempotency_key, created_at)
     VALUES ($1, 'volta-coin', 'GHS', $2, $3, '{}', '{}', $4, $5)`, [userId, stake, payout, key(), at]);
  return { ...env, ama, kojo, chidi, intent, bet };
}

test("Regional admin: revenue, the 10% figure and the payment counts come from Ghana's players only", async () => {
  const w = await ghanaAndNigeria();
  const now = new Date();
  const yesterday = new Date(now.getTime() - 26 * 3600e3);
  await w.intent(w.ama, 300, "CONFIRMED", "0241234567");
  await w.intent(w.ama, 20, "PENDING", "0241234567");
  await w.intent(w.kojo, 10, "FAILED", "0201234567");
  await w.intent(w.chidi, 5000, "CONFIRMED", null, true);
  await w.bet(w.ama, 100, 20, yesterday);   // +80 yesterday
  await w.bet(w.ama, 50, 0, now);           // +50 today
  await w.bet(w.kojo, 10, 25.55, now);      // −15.55 today
  await w.bet(w.chidi, 4000, 0, now);       // Nigeria: never counted
  const wd = await requestWithdrawal(w.db, { id: w.ama, phone: "0241234567" }, 40, key());
  await w.db.query(`UPDATE withdrawals SET status = 'PAID', transaction_id = '555000000001' WHERE id = $1`, [wd.id]);

  const s = await regionalSummary(w.db, "GH", now);
  assert.deepEqual([s.region, s.region_name, s.currency], ["GH", "Ghana", "GHS"]);
  assert.deepEqual(s.revenue, { all_time: 114.45, today: 34.45, today_10pct: 3.44, bets_today: 2 });
  assert.deepEqual(s.payments, { successful: 2, pending: 1, failed: 1 });
  assert.ok(!JSON.stringify(s).includes("5000") && !JSON.stringify(s).includes("4000"), "nothing of Nigeria's in it");
  await assert.rejects(() => regionalSummary(w.db, "NG", now), code("invalid_region"));
});

test("Regional admin: Ghana's deposits and withdrawals, with status, method and the reference TheTeller shows", async () => {
  const w = await ghanaAndNigeria();
  const t1 = await w.intent(w.ama, 300, "CONFIRMED", "0241234567");
  await new Promise((r) => setTimeout(r, 15));
  await w.intent(w.kojo, 120, "PENDING", null, true);
  await new Promise((r) => setTimeout(r, 15));
  await w.intent(w.kojo, 10, "FAILED", "0201234567");
  await w.db.query(`UPDATE payment_intents SET gateway_note = 'Can not process request' WHERE user_id = $1 AND status = 'FAILED'`, [w.kojo]);
  await w.intent(w.chidi, 5000, "CONFIRMED", null, true);
  await new Promise((r) => setTimeout(r, 15));
  const wd = await requestWithdrawal(w.db, { id: w.ama, phone: "0241234567" }, 40, key());

  const all = await regionalTransactions(w.db, "GH", {});
  assert.deepEqual(all.counts, { all: 4, successful: 1, pending: 2, failed: 1 });
  assert.deepEqual(all.transactions.map((t) => [t.kind, t.amount, t.status, t.method]), [
    ["withdrawal", 40, "pending", "Payout to MTN MoMo"],
    ["deposit", 10, "failed", "Mobile money · Telecel Cash"],
    ["deposit", 120, "pending", "TheTeller payment page"],
    ["deposit", 300, "successful", "Mobile money · MTN MoMo"],
  ]);
  const ama300 = all.transactions[3]!;
  assert.equal(ama300.transaction_id, "DES" + t1, "the reference TheTeller shows");
  assert.deepEqual(ama300.user, { id: w.ama, username: "ama", full_name: "Ama Owusu", phone: "0241234567" });
  assert.equal(all.transactions[1]!.user.full_name, null, "a player from before names were asked for has none");
  assert.equal(all.transactions[0]!.transaction_id, "W-" + wd.id.slice(0, 8).toUpperCase());
  assert.equal(all.transactions[1]!.note, "Can not process request");
  assert.equal(ama300.note, null);
  assert.ok(!JSON.stringify(all).includes(w.chidi) && !JSON.stringify(all).includes("chidi"), "no Nigerian player anywhere");

  const failed = await regionalTransactions(w.db, "GH", { status: "failed" });
  assert.deepEqual(failed.transactions.map((t) => t.amount), [10]);
  const deposits = await regionalTransactions(w.db, "GH", { kind: "deposit", status: "pending" });
  assert.deepEqual([deposits.transactions.map((t) => t.amount), deposits.counts], [[120], { all: 3, successful: 1, pending: 1, failed: 1 }]);
  const odd = await regionalTransactions(w.db, "GH", { status: "' OR 1=1 --", kind: ["deposit", "withdrawal"], before: "yesterday" });
  assert.equal(odd.transactions.length, 4, "anything unexpected is ignored, never passed into the query");

  /* pages of 2 run on without repeating or skipping a row */
  const p1 = await regionalTransactions(w.db, "GH", {}, 2);
  assert.ok(p1.next);
  const p2 = await regionalTransactions(w.db, "GH", { before: p1.next! }, 2);
  assert.deepEqual([...p1.transactions, ...p2.transactions].map((t) => t.transaction_id), all.transactions.map((t) => t.transaction_id));
});
