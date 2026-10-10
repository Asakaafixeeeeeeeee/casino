import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { adjustBalance, auditLog } from "../src/services/admin.js";
import { requestWithdrawal } from "../src/services/withdrawals.js";
import {
  applyPartner, attributeReferral, decidePartnerPayout, listPartnerPayouts, listPartners, MIN_PAYOUT, PartnerError, partnerActivity,
  partnerDetail, partnerOf, partnerPayouts, partnerReferrals, partnerStats, recordClick, requestPayout, updatePartner,
} from "../src/services/affiliates.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0241112222";
let keyN = 0;
const key = () => "aff:test-" + ++keyN;
type Env = Awaited<ReturnType<typeof setupWalletDb>>;

/* a partner (the helper's own player) approved on given terms, and a fresh player of theirs */
async function partnerWithTerms(terms: Record<string, unknown> = {}) {
  const env = await setupWalletDb();
  await applyPartner(env.db, env.userId, { channel: "My football WhatsApp group (2,000 members)" });
  await updatePartner(env.db, ADMIN, env.userId, { status: "ACTIVE", ...terms });
  const a = (await partnerOf(env.db, env.userId))!;
  return { ...env, a, code: a.code };
}
async function player(env: Env, name: string) {
  return ensureWalletAccount(env.db, "acct-" + name, name);
}
async function fund(env: Env, userId: string, amount: number) {
  await env.client.query("BEGIN");
  await deposit(env.client, userId, "GHS", amount, "deposit:" + key());
  await env.client.query("COMMIT");
}
async function bet(env: Env, userId: string, stake: number, payout: number) {
  await env.db.query(
    `INSERT INTO game_rounds (user_id, game, currency, stake, payout, choice, outcome, idempotency_key)
     VALUES ($1, 'volta-coin', 'GHS', $2, $3, '{}', '{}', $4)`, [userId, stake, payout, key()]);
}

test("Applying: a pending application with a code, once; an admin approves it and sets the terms", async () => {
  const { db, userId } = await setupWalletDb();
  await assert.rejects(() => applyPartner(db, userId, { channel: "tiktok" }), PartnerError, "say where you'll promote");
  const p = await applyPartner(db, userId, { channel: "My football WhatsApp group (2,000 members)" });
  assert.equal(p.status, "PENDING");
  assert.match(p.code, /^VB[A-HJ-NP-Z2-9]{6}$/);
  assert.equal((await applyPartner(db, userId, { channel: "Another channel entirely" })).code, p.code, "asking twice changes nothing");
  assert.equal((await listPartners(db, { status: "PENDING" })).partners.length, 1);
  assert.equal(p.deposit_pct, 5, "every partner starts at 5% of deposits");
  for (const bad of [31, -1, "abc", [8], "8%", true]) {
    await assert.rejects(() => updatePartner(db, ADMIN, userId, { deposit_pct: bad }),
      (e: unknown) => e instanceof PartnerError && e.code === "invalid_terms", `rate ${JSON.stringify(bad)}`);
  }
  const ok = await updatePartner(db, ADMIN, userId, { status: "ACTIVE", deposit_pct: "8" });
  assert.deepEqual([ok.status, ok.deposit_pct], ["ACTIVE", 8]);
  assert.ok(!("revshare_pct" in ok) && !("cpa_amount" in ok), "no revenue share or CPA terms any more");
  assert.equal((await auditLog(db, { target: userId })).actions[0]!.action, "partner.update");
});

test("An admin can make any player a partner directly", async () => {
  const env = await setupWalletDb();
  const kofi = await player(env, "kofi");
  const p = await updatePartner(env.db, ADMIN, kofi, { deposit_pct: 7.5 });
  assert.deepEqual([p.status, p.deposit_pct], ["ACTIVE", 7.5]);
});

test("Clicks are counted per campaign tag; a suspended partner's link stops counting", async () => {
  const env = await partnerWithTerms();
  assert.equal(await recordClick(env.db, env.code.toLowerCase(), "fb_march"), true);
  await recordClick(env.db, env.code, "fb_march");
  await recordClick(env.db, env.code, "<script>");
  assert.equal(await recordClick(env.db, "VBNOPE99", ""), false);
  const rows = (await env.db.query(`SELECT sub_id, clicks FROM referral_clicks ORDER BY sub_id`)).rows;
  assert.deepEqual(rows.map((r) => [r.sub_id, r.clicks]), [["fb_march", 2], ["script", 1]]);
  await updatePartner(env.db, ADMIN, env.userId, { status: "SUSPENDED" });
  assert.equal(await recordClick(env.db, env.code, ""), false);
});

test("Referrals: a new account through the link is the partner's for good; nobody else, never themselves", async () => {
  const env = await partnerWithTerms();
  const ama = await player(env, "ama");
  assert.deepEqual(await attributeReferral(env.db, ama, { code: env.code, sub_id: "ig" }), { attributed: true });
  assert.deepEqual(await attributeReferral(env.db, ama, { code: env.code }), { attributed: false, reason: "already_referred" });
  assert.equal((await attributeReferral(env.db, env.userId, { code: env.code })).reason, "self");
  const yaw = await player(env, "yaw");
  assert.equal((await attributeReferral(env.db, yaw, { code: "VBNOPE99" })).reason, "unknown_code");
  await env.db.query(`UPDATE users SET created_at = now() - interval '10 days' WHERE id = $1`, [yaw]);
  assert.equal((await attributeReferral(env.db, yaw, { code: env.code })).reason, "not_new", "an existing player can't be claimed");
  const long = await player(env, "Player482193");
  await attributeReferral(env.db, long, { code: env.code });
  const refs = (await partnerReferrals(env.db, env.a)).referrals;
  assert.deepEqual(refs.map((r) => [r.player, r.sub_id]), [["Pl•••93", null], ["a•••", "ig"]], "names are masked; short ones more so");
});

test("Commission: the partner's % of every deposit their players make; bets, wins and withdrawals don't change it", async () => {
  const env = await partnerWithTerms({ deposit_pct: 10 });
  const [ama, yaw, esi] = [await player(env, "ama"), await player(env, "yaw"), await player(env, "esi")];
  for (const p of [ama, yaw, esi]) await attributeReferral(env.db, p, { code: env.code });
  await fund(env, ama, 50);
  await fund(env, yaw, 25.55);
  await bet(env, ama, 100, 20); // ama loses 80
  await bet(env, yaw, 10, 30);  // yaw wins 20
  const s = await partnerStats(env.db, env.a);
  assert.deepEqual([s.signups.total, s.depositors, s.activePlayers, s.deposits], [3, 2, 2, 75.55]);
  assert.deepEqual(s.money, { deposits: 75.55, deposits30: 75.55, withdrawals: 0, stakes: 110, wins: 50 });
  assert.deepEqual(s.commission, { pct: 10, earned: 7.55, paid: 0, pending: 0, available: 7.55 }, "10% of 75.55, down to the cent");

  // a big win, a withdrawal paid out and an admin's manual credit leave the commission alone
  await bet(env, esi, 10, 200);
  const w = await requestWithdrawal(env.db, { id: ama, phone: "0241234567" }, 20, key());
  await env.db.query(`UPDATE withdrawals SET status = 'PAID' WHERE id = $1`, [w.id]);
  await adjustBalance(env.db, ADMIN, esi, { amount: 500, reason: "goodwill credit", idempotency_key: key() });
  const after = await partnerStats(env.db, env.a);
  assert.deepEqual(after.money, { deposits: 75.55, deposits30: 75.55, withdrawals: 20, stakes: 120, wins: 250 });
  assert.equal(after.commission.earned, 7.55);

  // a new rate applies to every deposit so far
  await updatePartner(env.db, ADMIN, env.userId, { deposit_pct: 20 });
  const a = (await partnerOf(env.db, env.userId))!;
  assert.equal((await partnerStats(env.db, a)).commission.earned, 15.11);
  assert.equal(after.series.length, 30);
  assert.equal(after.series.at(-1)!.signups, 3);

  // the admin's list carries every partner's money too
  const [row] = (await listPartners(env.db, { status: "ACTIVE" })).partners;
  assert.deepEqual([row!.deposit_pct, row!.deposits, row!.earned, row!.available, row!.signups], [20, 75.55, 15.11, 15.11, 3]);
});

test("Payouts: one request at a time, at least the minimum, never more than available; paid or rejected by an admin", async () => {
  const env = await partnerWithTerms({ deposit_pct: 30 });
  const ama = await player(env, "ama");
  await attributeReferral(env.db, ama, { code: env.code });
  await fund(env, ama, 500); // 30% of 500: 150 commission
  const momo = { phone: "024 123 4567", name: "Kwame Mensah" };
  await assert.rejects(() => requestPayout(env.db, env.a, { amount: MIN_PAYOUT - 1, method: "MOMO", details: momo }), PartnerError);
  await assert.rejects(() => requestPayout(env.db, env.a, { amount: 200, method: "MOMO", details: momo }),
    (e: unknown) => e instanceof PartnerError && e.code === "too_much");
  await assert.rejects(() => requestPayout(env.db, env.a, { amount: 60, method: "MOMO", details: { phone: "12345", name: "K" } }), PartnerError);
  await assert.rejects(() => requestPayout(env.db, env.a, { amount: 60, method: "CRYPTO", details: { asset: "USDT", network: "BTC", address: "x" } }),
    PartnerError);
  const first = await requestPayout(env.db, env.a, { amount: 100, method: "MOMO", details: momo });
  assert.equal((await partnerPayouts(env.db, env.userId)).payouts[0]!.details.phone, "0241234567");
  await assert.rejects(() => requestPayout(env.db, env.a, { amount: 50, method: "MOMO", details: momo }),
    (e: unknown) => e instanceof PartnerError && e.code === "request_open");
  assert.deepEqual((await partnerStats(env.db, env.a)).commission, { pct: 30, earned: 150, paid: 0, pending: 100, available: 50 });

  assert.equal((await listPartnerPayouts(env.db, {})).payouts.length, 1);
  await assert.rejects(() => decidePartnerPayout(env.db, ADMIN, first.id, { action: "pay" }), PartnerError, "a reference is needed");
  await decidePartnerPayout(env.db, ADMIN, first.id, { action: "pay", note: "MoMo ref 8812773" });
  await assert.rejects(() => decidePartnerPayout(env.db, ADMIN, first.id, { action: "reject", note: "oops" }),
    (e: unknown) => e instanceof PartnerError && e.code === "already_decided");
  assert.deepEqual((await partnerStats(env.db, env.a)).commission.available, 50);

  const bank = await requestPayout(env.db, env.a, {
    amount: 50, method: "BANK", details: { bank: "GCB Bank", account_number: "1234 5678 9012", account_name: "Kwame Mensah" },
  });
  await decidePartnerPayout(env.db, ADMIN, bank.id, { action: "reject", note: "Account name doesn't match" });
  assert.equal((await partnerStats(env.db, env.a)).commission.available, 50, "a rejected request frees the money again");
  const d = await partnerDetail(env.db, env.userId);
  assert.deepEqual(d.payouts.map((p) => p.status), ["REJECTED", "PAID"]);
});

test("Only an active partner can request payouts", async () => {
  const env = await partnerWithTerms({ deposit_pct: 30 });
  await updatePartner(env.db, ADMIN, env.userId, { status: "SUSPENDED" });
  const a = (await partnerOf(env.db, env.userId))!;
  await assert.rejects(() => requestPayout(env.db, a, { amount: 60, method: "MOMO", details: { phone: "0241234567", name: "Kwame" } }),
    (e: unknown) => e instanceof PartnerError && e.status === 403);
});

test("A link shared while the partner waits for approval still counts, and shows once they're approved", async () => {
  const env = await setupWalletDb();
  await applyPartner(env.db, env.userId, { channel: "My football WhatsApp group (2,000 members)" });
  const code = (await partnerOf(env.db, env.userId))!.code;
  assert.equal((await partnerOf(env.db, env.userId))!.status, "PENDING");
  assert.equal(await recordClick(env.db, code, "early"), true);
  const ama = await player(env, "ama");
  assert.deepEqual(await attributeReferral(env.db, ama, { code, sub_id: "early" }), { attributed: true });
  await fund(env, ama, 30);
  await updatePartner(env.db, ADMIN, env.userId, { status: "ACTIVE" });
  const s = await partnerStats(env.db, (await partnerOf(env.db, env.userId))!);
  assert.deepEqual([s.clicks.total, s.signups.total, s.depositors, s.deposits], [1, 1, 1, 30]);
  // a rejected partner's link credits nobody
  await updatePartner(env.db, ADMIN, env.userId, { status: "REJECTED" });
  const yaw = await player(env, "yaw");
  assert.equal((await attributeReferral(env.db, yaw, { code })).reason, "unknown_code");
});

test("A partner sees each player's deposits, what each earned them, and a feed of sign-ups and deposits as they happen", async () => {
  const env = await partnerWithTerms({ deposit_pct: 10 });
  const ama = await player(env, "Player482193");
  await attributeReferral(env.db, ama, { code: env.code, sub_id: "fb" });
  await new Promise((r) => setTimeout(r, 20));
  await fund(env, ama, 15);
  await new Promise((r) => setTimeout(r, 20));
  await fund(env, ama, 10);
  const [p] = (await partnerReferrals(env.db, env.a)).referrals;
  assert.deepEqual([p!.player, p!.deposits, p!.commission, !!p!.first_deposit_at], ["Pl•••93", 25, 2.5, true]);
  const feed = (await partnerActivity(env.db, env.a)).activity;
  assert.deepEqual(feed.map((x) => [x.kind, x.amount, x.commission, x.player]),
    [["deposit", 10, 1, "Pl•••93"], ["deposit", 15, 1.5, "Pl•••93"], ["signup", null, null, "Pl•••93"]]);
});
