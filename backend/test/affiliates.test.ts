import assert from "node:assert/strict";
import test from "node:test";
import { deposit, postMovement, SystemAccount } from "../src/services/balanceService.js";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { auditLog } from "../src/services/admin.js";
import { requestWithdrawal } from "../src/services/withdrawals.js";
import {
  accrueCommissions, applyPartner, attributeReferral, checkReferral, correctCommission, decidePartnerPayout, getSettings,
  lastClosedPeriod, listPartnerPayouts, partnerCommissions, listPartners, lookupPlayer, PartnerError, partnerDetail, partnerOf, partnerPayouts,
  partnerPreview, partnerReferrals, partnerSettings, partnerStatistics, partnerSummary, partnerWallet, programmeStats, recordClick,
  requestPayout, resolveReferral, saveSettings, savePayoutDetails, setOwnPromo, settleCommissions, updatePartner, walletOf,
} from "../src/services/affiliates.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0241112222";
let keyN = 0;
const key = () => "aff:test-" + ++keyN;
type Env = Awaited<ReturnType<typeof setupWalletDb>> & { code?: string };
const isErr = (code: string) => (e: unknown) => e instanceof PartnerError && e.code === code;

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
/* money moves the way the game engines move it: a confirmed deposit, a stake, a payout (always winnings), a refund */
async function move(env: Env, fn: () => Promise<unknown>) {
  await env.client.query("BEGIN");
  try {
    await fn();
    await env.client.query("COMMIT");
  } catch (e) {
    await env.client.query("ROLLBACK");
    throw e;
  }
}
async function fund(env: Env, userId: string, amount: number) {
  await move(env, () => deposit(env.client, userId, "GHS", amount, "deposit:" + key()));
}
const leg = (userId: string, dir: "DEBIT" | "CREDIT", amountMajor: number) => [
  { userId, currencyCode: "GHS", direction: dir, amountMajor },
  { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: dir === "DEBIT" ? "CREDIT" : "DEBIT", amountMajor },
] as const;
/* a settled one-draw round from the player's own balance (deposit first with `fund`; `bet` deposits the stake itself
   unless told the money is already there) */
async function play(env: Env, userId: string, stake: number, payout: number, at?: Date) {
  const k = key();
  await move(env, async () => {
    await postMovement(env.client, { idempotencyKey: "bet:" + k, entryType: "BET_PLACED", legs: [...leg(userId, "DEBIT", stake)] });
    if (payout > 0) await postMovement(env.client, { idempotencyKey: "win:" + k, entryType: "BET_SETTLED", legs: [...leg(userId, "CREDIT", payout)] });
  });
  const { rows } = await env.db.query(
    `INSERT INTO game_rounds (user_id, game, currency, stake, payout, choice, outcome, idempotency_key, created_at)
     VALUES ($1, 'volta-coin', 'GHS', $2, $3, '{}', '{}', $4, coalesce($5::timestamptz, now())) RETURNING id`,
    [userId, stake, payout, k, at ?? null]);
  return rows[0].id as string;
}
/* a bet staked from freshly deposited money */
async function bet(env: Env, userId: string, stake: number, payout: number, at?: Date) {
  await fund(env, userId, stake);
  return play(env, userId, stake, payout, at);
}
/* a step-game round in a given state (OPEN, WON, LOST, VOID), staked from freshly deposited money */
async function session(env: Env, userId: string, stake: number, payout: number, status: string) {
  await fund(env, userId, stake);
  const { rows } = await env.db.query(
    `INSERT INTO game_sessions (user_id, game, currency, stake, params, secret, progress, status, payout, idempotency_key)
     VALUES ($1, 'volta-mines', 'GHS', $2, '{}', '{}', '{}', $3, $4, $5) RETURNING id`, [userId, stake, status, payout, key()]);
  const id = rows[0].id;
  await move(env, async () => {
    await postMovement(env.client, { idempotencyKey: "bet:session:" + id, entryType: "BET_PLACED", legs: [...leg(userId, "DEBIT", stake)] });
    if (status === "VOID") await postMovement(env.client, { idempotencyKey: "void:session:" + id, entryType: "BET_VOID", legs: [...leg(userId, "CREDIT", stake)] });
    else if (payout > 0) await postMovement(env.client, { idempotencyKey: "win:session:" + id, entryType: "BET_SETTLED", legs: [...leg(userId, "CREDIT", payout)] });
  });
}
const balanceRow = async (env: Env, userId: string) => {
  const r = (await env.db.query(`SELECT available, withdrawable, deposit_funds FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId])).rows[0];
  return { available: Number(r.available), winnings: Number(r.withdrawable), deposits: Number(r.deposit_funds) };
};
async function referred(env: Env, name: string) {
  const id = await player(env, name);
  assert.equal((await attributeReferral(env.db, id, { code: env.code! })).attributed, true);
  /* bets only count from the moment the player was referred */
  await env.db.query(`UPDATE referrals SET created_at = now() - interval '40 days' WHERE user_id = $1`, [id]);
  return id;
}
const fresh = async (env: Env) => (await partnerOf(env.db, env.userId))!;

test("Applying: a pending application with a code; an admin approves it on the default revenue share", async () => {
  const { db, userId } = await setupWalletDb();
  await assert.rejects(() => applyPartner(db, userId, { channel: "tiktok" }), isErr("channel_needed"));
  const p = await applyPartner(db, userId, { channel: "My football WhatsApp group (2,000 members)" });
  assert.equal(p.status, "PENDING");
  assert.match(p.code, /^WB[A-HJ-NP-Z2-9]{6}$/);
  assert.equal((await applyPartner(db, userId, { channel: "Another channel entirely" })).code, p.code, "asking twice changes nothing");
  assert.equal((await listPartners(db, { status: "PENDING" })).partners.length, 1);
  for (const bad of [91, -1, "abc", [8], "8%", true]) {
    await assert.rejects(() => updatePartner(db, ADMIN, userId, { revshare_pct: bad }), isErr("invalid_terms"), `rate ${JSON.stringify(bad)}`);
  }
  const ok = await updatePartner(db, ADMIN, userId, { status: "ACTIVE" });
  assert.equal(ok.status, "ACTIVE");
  const a = (await partnerOf(db, userId))!;
  assert.equal((await partnerSettings(db, a)).rate.pct, 40, "the default revenue share is 40%");
  assert.equal((await auditLog(db, { target: userId })).actions[0]!.action, "partner.update");
});

test("Add partner: an admin finds a registered player by phone, username or email and makes them a partner", async () => {
  const env = await setupWalletDb();
  const kofi = await player(env, "kofi");
  await env.db.query(`UPDATE users SET phone = '0551234567', contact_email = 'kofi@example.com', full_name = 'Kofi Mensah' WHERE id = $1`, [kofi]);
  for (const q of ["0551234567", "+233 55 123 4567", "KOFI", "Kofi@Example.com"]) {
    assert.equal((await lookupPlayer(env.db, { q })).players[0]!.user_id, kofi, q);
  }
  await assert.rejects(() => lookupPlayer(env.db, { q: "nobody@example.com" }), isErr("not_found"));
  const p = await updatePartner(env.db, ADMIN, kofi, { revshare_pct: 50 });
  assert.equal(p.status, "ACTIVE");
  const [row] = (await listPartners(env.db, { status: "ACTIVE" })).partners;
  assert.deepEqual([row!.full_name, row!.email, row!.phone, row!.revshare_pct, row!.partner_id], ["Kofi Mensah", "kofi@example.com", "0551234567", 50, p.code]);
});

test("Clicks are counted per campaign tag; a suspended partner's or switched-off link stops counting", async () => {
  const env = await partnerWithTerms();
  assert.equal(await recordClick(env.db, env.code.toLowerCase(), "fb_march"), true);
  await recordClick(env.db, env.code, "fb_march");
  await recordClick(env.db, env.code, "<script>");
  assert.equal(await recordClick(env.db, "WBNOPE99", ""), false);
  const rows = (await env.db.query(`SELECT sub_id, clicks FROM referral_clicks ORDER BY sub_id`)).rows;
  assert.deepEqual(rows.map((r) => [r.sub_id, r.clicks]), [["fb_march", 2], ["script", 1]]);
  await updatePartner(env.db, ADMIN, env.userId, { link_enabled: false });
  assert.equal(await recordClick(env.db, env.code, ""), false, "link switched off");
  await updatePartner(env.db, ADMIN, env.userId, { link_enabled: true, status: "SUSPENDED" });
  assert.equal(await recordClick(env.db, env.code, ""), false, "partner suspended");
});

test("Referrals: a new account through the link is the partner's for good; nobody else, never themselves", async () => {
  const env = await partnerWithTerms();
  const ama = await player(env, "ama");
  assert.deepEqual(await attributeReferral(env.db, ama, { code: env.code, sub_id: "ig" }), { attributed: true, via: "link" });
  assert.deepEqual(await attributeReferral(env.db, ama, { code: env.code }), { attributed: false, reason: "already_referred" });
  // another partner can't take her
  const other = await player(env, "other");
  const o = await updatePartner(env.db, ADMIN, other, {});
  assert.deepEqual(await attributeReferral(env.db, ama, { code: o.code }), { attributed: false, reason: "already_referred" });
  assert.equal((await attributeReferral(env.db, env.userId, { code: env.code })).reason, "self");
  const yaw = await player(env, "yaw");
  assert.equal((await attributeReferral(env.db, yaw, { code: "WBNOPE99" })).reason, "unknown_code");
  await env.db.query(`UPDATE users SET created_at = now() - interval '10 days' WHERE id = $1`, [yaw]);
  assert.equal((await attributeReferral(env.db, yaw, { code: env.code })).reason, "not_new", "an existing player can't be claimed");
  const long = await player(env, "Player482193");
  await attributeReferral(env.db, long, { code: env.code });
  const refs = (await partnerReferrals(env.db, env.a, { range: "all" })).referrals;
  assert.deepEqual(refs.map((r) => [r.player, r.sub_id]), [["Pl•••93", null], ["a•••", "ig"]], "names are masked; short ones more so");
  assert.match(refs[0]!.id, /^P-[0-9A-F]{8}$/);
  assert.ok(!JSON.stringify(refs).includes("phone"), "no phone numbers");
});

test("Promo codes: unique across partners, usable at sign-up alone or with the same partner's link; a mismatch is refused", async () => {
  const env = await partnerWithTerms();
  const bob = await player(env, "bob");
  const b = await updatePartner(env.db, ADMIN, bob, {});
  const mine = await setOwnPromo(env.db, env.a, { promo_code: "ajababa" });
  assert.equal(mine.promo_code, "AJABABA");
  const bobA = (await partnerOf(env.db, bob))!;
  await assert.rejects(() => setOwnPromo(env.db, bobA, { promo_code: "AJABABA" }), isErr("promo_taken"));
  await assert.rejects(() => setOwnPromo(env.db, bobA, { promo_code: env.code }), isErr("promo_taken"),
    "a promo code can't be another partner's link code");
  await assert.rejects(() => setOwnPromo(env.db, env.a, { promo_code: "a b" }), isErr("invalid_promo"));
  await assert.rejects(() => updatePartner(env.db, ADMIN, bob, { promo_code: "AJABABA" }), isErr("promo_taken"), "admins can't duplicate either");

  // promo alone, link alone, both from the same partner
  assert.equal((await checkReferral(env.db, { promo: "ajababa" })).partner!.code, env.code);
  const p1 = await player(env, "p1");
  assert.deepEqual(await attributeReferral(env.db, p1, { promo: "AJABABA" }), { attributed: true, via: "promo" });
  const p2 = await player(env, "p2");
  assert.deepEqual(await attributeReferral(env.db, p2, { code: env.code, promo: "AJABABA" }), { attributed: true, via: "link+promo" });
  // link of one partner, promo of another: refused, nobody assigned
  const p3 = await player(env, "p3");
  await assert.rejects(() => checkReferral(env.db, { code: b.code, promo: "AJABABA" }), isErr("referral_conflict"));
  await assert.rejects(() => attributeReferral(env.db, p3, { code: b.code, promo: "AJABABA" }), isErr("referral_conflict"));
  assert.equal((await env.db.query(`SELECT 1 FROM referrals WHERE user_id = $1`, [p3])).rowCount, 0);
  await assert.rejects(() => resolveReferral(env.db, { promo: "NOSUCHCODE" }), isErr("unknown_promo"));

  // partners can only request a change when the admin turns self-service off; the admin approves it
  await saveSettings(env.db, ADMIN, { partner_promo_edit: false });
  const req = await setOwnPromo(env.db, (await fresh(env)), { promo_code: "AJA2026" });
  assert.deepEqual([req.requested, req.promo_code, req.promo_request], [true, "AJABABA", "AJA2026"]);
  await updatePartner(env.db, ADMIN, env.userId, { approve_promo_request: true });
  assert.deepEqual([(await fresh(env)).promo_code, (await fresh(env)).promo_request], ["AJA2026", null]);
});

test("Revenue share: losing bets earn the partner's % of the loss; winning bets deduct 10% of the player's NET winnings", async () => {
  const env = await partnerWithTerms({ revshare_pct: 40 });
  const ama = await referred(env, "ama");
  await bet(env, ama, 200, 0);    // loses 200: +80 at 40%
  await bet(env, ama, 100, 200);  // wins 100 net: -10
  await bet(env, ama, 300, 600);  // wins 300 net: -30
  await bet(env, ama, 500, 1000); // wins 500 net: -50
  await bet(env, ama, 10, 10);    // breaks even: 0
  await bet(env, ama, 7.77, 1.11); // loses 6.66: +2.66 (40% truncated to the cent)
  assert.equal(await accrueCommissions(env.db), 6);
  assert.equal(await accrueCommissions(env.db), 0, "each bet earns once, however often it runs");
  const rows = (await env.db.query(`SELECT stake, payout, ngr, pct, amount FROM partner_commissions ORDER BY stake`)).rows
    .map((r) => [Number(r.stake), Number(r.payout), Number(r.ngr), Number(r.pct), Number(r.amount)]);
  assert.deepEqual(rows, [
    [7.77, 1.11, 6.66, 40, 2.66], [10, 10, 0, 40, 0], [100, 200, -100, 10, -10], [200, 0, 200, 40, 80], [300, 600, -300, 10, -30],
    [500, 1000, -500, 10, -50],
  ]);
  const s = await partnerSummary(env.db, await fresh(env));
  assert.equal(s.revenueShare.today, -7.34);
  assert.deepEqual([s.wallet.totalEarned, s.wallet.negativeAdjustments, s.wallet.pending, s.wallet.available], [82.66, -90, -7.34, 0]);

  // another partner on 60%: 100 lost earns 60
  const env2 = await partnerWithTerms({ revshare_pct: 60 });
  const yaw = await referred(env2, "yaw");
  await bet(env2, yaw, 100, 0);
  await accrueCommissions(env2.db);
  assert.equal((await walletOf(env2.db, env2.userId)).pending, 60);
});

test("Open, void and cancelled bets never earn; bets from before the referral don't count", async () => {
  const env = await partnerWithTerms({ revshare_pct: 50 });
  const ama = await player(env, "ama");
  await bet(env, ama, 100, 0, new Date(Date.now() - 3600_000)); // before she was referred
  await attributeReferral(env.db, ama, { code: env.code });
  await session(env, ama, 50, 0, "OPEN");
  await session(env, ama, 50, 50, "VOID");
  await session(env, ama, 20, 0, "LOST");
  await session(env, ama, 20, 50, "WON");
  await accrueCommissions(env.db);
  const rows = (await env.db.query(`SELECT source, amount FROM partner_commissions ORDER BY id`)).rows;
  assert.deepEqual(rows.map((r) => [r.source, Number(r.amount)]).sort(), [["session", -3], ["session", 10]]);
});

test("A new rate applies from its effective date only: commission already recorded never changes", async () => {
  const env = await partnerWithTerms({ revshare_pct: 40 });
  const ama = await referred(env, "ama");
  await bet(env, ama, 100, 0, new Date(Date.now() - 2 * 3600_000));
  await accrueCommissions(env.db);
  await assert.rejects(() => updatePartner(env.db, ADMIN, env.userId, { revshare_pct: 50, effective_from: "2020-01-01" }), isErr("past_date"));
  await updatePartner(env.db, ADMIN, env.userId, { revshare_pct: 50 });
  await bet(env, ama, 100, 0);
  // a bet that settled before the change but is recorded after it still gets the old rate
  await bet(env, ama, 10, 0, new Date(Date.now() - 3600_000));
  await accrueCommissions(env.db);
  const amounts = (await env.db.query(`SELECT amount FROM partner_commissions ORDER BY settled_at`)).rows.map((r) => Number(r.amount));
  assert.deepEqual(amounts, [40, 4, 50]);
  // a later change is scheduled, not applied
  const later = new Date(Date.now() + 86400_000).toISOString();
  await updatePartner(env.db, ADMIN, env.userId, { revshare_pct: 35, effective_from: later });
  const rate = (await partnerSettings(env.db, await fresh(env))).rate;
  assert.deepEqual([rate.pct, rate.scheduled!.pct], [50, 35]);
  // the win deduction works the same way
  await saveSettings(env.db, ADMIN, { win_deduction_pct: 20 });
  await bet(env, ama, 100, 200);
  await accrueCommissions(env.db);
  assert.equal(Number((await env.db.query(`SELECT amount FROM partner_commissions ORDER BY id DESC LIMIT 1`)).rows[0].amount), -20);
});

test("Settlement: a closed day's net goes to the wallet; a negative day is carried forward (or written off)", async () => {
  const env = await partnerWithTerms({ revshare_pct: 40 });
  const ama = await referred(env, "ama");
  const day = (d: string, h = 12) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00Z`);
  await bet(env, ama, 100, 0, day("2026-10-01"));     // +40
  await bet(env, ama, 100, 600, day("2026-10-02"));   // -50
  await bet(env, ama, 100, 0, day("2026-10-03"));     // +40
  await accrueCommissions(env.db);
  assert.deepEqual(lastClosedPeriod("DAILY", day("2026-10-02", 1)), { start: day("2026-10-01", 0), end: day("2026-10-02", 0) });
  assert.equal((await settleCommissions(env.db, new Date(day("2026-10-02", 0).getTime() + 60_000))).settled, 0, "waits a few minutes");
  await settleCommissions(env.db, day("2026-10-02", 1));
  await settleCommissions(env.db, day("2026-10-02", 2));
  assert.equal((await walletOf(env.db, env.userId)).available, 40, "settled once");
  await settleCommissions(env.db, day("2026-10-03", 1));
  let w = await walletOf(env.db, env.userId);
  assert.deepEqual([w.available, w.carriedNegative, w.pending], [40, -50, 40]);
  await settleCommissions(env.db, day("2026-10-04", 1));
  w = await walletOf(env.db, env.userId);
  assert.deepEqual([w.available, w.carriedNegative, w.pending], [40, -10, 0], "the -50 ate the next day's 40");

  // with carry-over off, a negative period is written off
  const env2 = await partnerWithTerms({ revshare_pct: 40 });
  await saveSettings(env2.db, ADMIN, { carry_negative: false });
  const yaw = await referred(env2, "yaw");
  await bet(env2, yaw, 100, 600, day("2026-10-02"));
  await bet(env2, yaw, 100, 0, day("2026-10-03"));
  await accrueCommissions(env2.db);
  await settleCommissions(env2.db, day("2026-10-03", 1));
  await settleCommissions(env2.db, day("2026-10-04", 1));
  assert.equal((await walletOf(env2.db, env2.userId)).available, 40);

  // monthly settlement waits for the month to end
  assert.deepEqual(lastClosedPeriod("MONTHLY", day("2026-10-15")), { start: day("2026-09-01", 0), end: day("2026-10-01", 0) });
  assert.deepEqual(lastClosedPeriod("WEEKLY", day("2026-10-11")), { start: day("2026-09-28", 0), end: day("2026-10-05", 0) });
});

test("Payouts: held at once, within the limits, never more than available; approved, paid with a reference, or rejected", async () => {
  const env = await partnerWithTerms({ revshare_pct: 50 });
  const ama = await referred(env, "ama");
  await bet(env, ama, 300, 0, new Date(Date.now() - 3 * 86400_000)); // +150
  await settleCommissions(env.db);
  assert.equal((await walletOf(env.db, env.userId)).available, 150);
  const momo = { phone: "024 123 4567", name: "Kwame Mensah" };
  await assert.rejects(() => requestPayout(env.db, env.a, { amount: 49, method: "MOMO", details: momo }), isErr("invalid_amount"));
  await assert.rejects(() => requestPayout(env.db, env.a, { amount: 200, method: "MOMO", details: momo }), isErr("too_much"));
  await saveSettings(env.db, ADMIN, { max_payout: 120 });
  await assert.rejects(() => requestPayout(env.db, env.a, { amount: 130, method: "MOMO", details: momo }), isErr("invalid_amount"));
  await assert.rejects(() => requestPayout(env.db, env.a, { amount: 60, method: "MOMO", details: { phone: "12345", name: "K" } }), PartnerError);
  await env.db.query(`UPDATE users SET phone = '0241234567' WHERE id = $1`, [env.userId]);
  const first = await requestPayout(env.db, env.a, { amount: 100, method: "MOMO", details: momo });
  assert.equal((await partnerPayouts(env.db, env.userId)).payouts[0]!.details.phone, "0241234567");
  await assert.rejects(() => requestPayout(env.db, env.a, { amount: 50, method: "MOMO", details: momo }), isErr("request_open"));
  let w = await walletOf(env.db, env.userId);
  assert.deepEqual([w.available, w.pendingWithdrawals], [50, 100], "the request is held straight away");

  assert.equal((await listPartnerPayouts(env.db, {})).payouts.length, 1);
  await assert.rejects(() => decidePartnerPayout(env.db, "0241234567", first.id, { action: "approve" }), PartnerError,
    "nobody approves their own payout (the partner's number is the helper's)");
  await env.db.query(`UPDATE users SET phone = '0209998877' WHERE id = $1`, [env.userId]);
  await decidePartnerPayout(env.db, ADMIN, first.id, { action: "approve" });
  await assert.rejects(() => decidePartnerPayout(env.db, ADMIN, first.id, { action: "pay" }), isErr("reference_needed"));
  await decidePartnerPayout(env.db, ADMIN, first.id, { action: "pay", reference: "MoMo ref 8812773" });
  await assert.rejects(() => decidePartnerPayout(env.db, ADMIN, first.id, { action: "reject", note: "oops" }), isErr("already_decided"));
  w = await walletOf(env.db, env.userId);
  assert.deepEqual([w.available, w.withdrawn, w.pendingWithdrawals], [50, 100, 0]);

  const bank = await requestPayout(env.db, env.a, {
    amount: 50, method: "BANK", details: { bank: "GCB Bank", account_number: "1234 5678 9012", account_name: "Kwame Mensah" },
  });
  assert.equal((await walletOf(env.db, env.userId)).available, 0);
  await decidePartnerPayout(env.db, ADMIN, bank.id, { action: "reject", note: "Account name doesn't match" });
  assert.equal((await walletOf(env.db, env.userId)).available, 50, "a rejected request returns the held money");
  const d = await partnerDetail(env.db, env.userId);
  assert.deepEqual(d.payouts.map((p) => p.status), ["REJECTED", "PAID"]);
  assert.equal(d.payouts[1]!.reference, "MoMo ref 8812773");
});

test("Only an active partner can request payouts or change their promo code; a suspended one can still look", async () => {
  const env = await partnerWithTerms();
  await updatePartner(env.db, ADMIN, env.userId, { status: "SUSPENDED" });
  const a = await fresh(env);
  await assert.rejects(() => requestPayout(env.db, a, { amount: 60, method: "MOMO", details: { phone: "0241234567", name: "Kwame" } }),
    (e: unknown) => e instanceof PartnerError && e.status === 403);
  await assert.rejects(() => setOwnPromo(env.db, a, { promo_code: "KWAME1" }), (e: unknown) => e instanceof PartnerError && e.status === 403);
  assert.equal((await partnerSummary(env.db, a)).partner.status, "SUSPENDED");
});

test("A disabled partner earns nothing; reactivated, they earn again from that moment only", async () => {
  const env = await partnerWithTerms({ revshare_pct: 50 });
  const ama = await referred(env, "ama");
  await updatePartner(env.db, ADMIN, env.userId, { status: "DISABLED" });
  await bet(env, ama, 100, 0, new Date(Date.now() - 60_000));
  await accrueCommissions(env.db);
  assert.equal((await env.db.query(`SELECT count(*) AS n FROM partner_commissions`)).rows[0].n, 0);
  await updatePartner(env.db, ADMIN, env.userId, { status: "ACTIVE" });
  await bet(env, ama, 10, 0);
  await accrueCommissions(env.db);
  assert.deepEqual((await env.db.query(`SELECT amount FROM partner_commissions`)).rows.map((r) => Number(r.amount)), [5]);
});

test("Corrections: an admin fixes a verified error with a reason; it's in the wallet history and the audit log", async () => {
  const env = await partnerWithTerms();
  await assert.rejects(() => correctCommission(env.db, ADMIN, env.userId, { amount: "12.5", reason: "short" }), isErr("reason_needed"));
  await assert.rejects(() => correctCommission(env.db, ADMIN, env.userId, { amount: "abc", reason: "missing bets from 3 Oct" }), isErr("invalid_amount"));
  await correctCommission(env.db, ADMIN, env.userId, { amount: "12.50", reason: "missing bets from 3 Oct" });
  await correctCommission(env.db, ADMIN, env.userId, { amount: "-2.50", reason: "duplicate player account" });
  const w = await partnerWallet(env.db, await fresh(env));
  assert.deepEqual([w.wallet.available, w.wallet.corrections, w.entries.length], [10, 10, 2]);
  assert.equal((await auditLog(env.db, { target: env.userId })).actions[0]!.action, "partner.correction");
});

test("Statistics: by day for the range, with stakes, payouts, NGR, commission, deductions and the chart series", async () => {
  const env = await partnerWithTerms({ revshare_pct: 40 });
  const ama = await referred(env, "ama");
  const yaw = await referred(env, "yaw");
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400_000);
  await bet(env, ama, 100, 0, yesterday);
  await bet(env, yaw, 50, 150);
  await bet(env, ama, 20, 0);
  const st = await partnerStatistics(env.db, await fresh(env), { range: "7d" }, now);
  assert.equal(st.series.length, 7);
  const [y, t] = st.series.slice(-2);
  assert.deepEqual([y!.stakes, y!.payouts, y!.ngr, y!.commission, y!.negative, y!.earnings, y!.activePlayers], [100, 0, 100, 40, 0, 40, 1]);
  assert.deepEqual([t!.stakes, t!.payouts, t!.ngr, t!.commission, t!.negative, t!.earnings, t!.activePlayers], [70, 150, -80, 8, -10, -2, 2]);
  assert.deepEqual([st.totals.earnings, st.totals.activePlayers], [38, 2]);
  const today = await partnerStatistics(env.db, await fresh(env), { range: "today" }, now);
  assert.equal(today.series.length, 1);
  await assert.rejects(() => partnerStatistics(env.db, env.a, { range: "custom", from: "2026-10-05", to: "2026-10-01" }), isErr("invalid_range"));
  const refs = await partnerReferrals(env.db, await fresh(env), { range: "today" }, now);
  assert.deepEqual(refs.totals, { players: 2, stakes: 70, payouts: 150, ngr: -80, commission: -2 });
  const sum = await partnerSummary(env.db, await fresh(env), now);
  assert.deepEqual([sum.totalReferrals, sum.activePlayers, sum.revenueShare.yesterday, sum.revenueShare.today, sum.revenueShare.lifetime],
    [2, 2, 40, -2, 38]);
  // the admin sees the same through a read-only preview, and the programme totals
  assert.deepEqual((await partnerPreview(env.db, env.userId, "summary", {}) as typeof sum).revenueShare, sum.revenueShare);
  assert.equal((await programmeStats(env.db, { range: "all" })).totals.net, 38);
  const d = await partnerDetail(env.db, env.userId);
  assert.deepEqual([d.lifetime.stakes, d.lifetime.ngr, d.lifetime.net, d.daily.length, d.monthly.length], [170, 20, 38, 30, 12]);
});

test("Payment details are saved for the partner; settings show their terms but nothing lets them change their rate", async () => {
  const env = await partnerWithTerms({ revshare_pct: 45 });
  await savePayoutDetails(env.db, env.a, { method: "MOMO", details: { phone: "0551234567", name: "Kwame Mensah" } });
  const s = await partnerSettings(env.db, await fresh(env));
  assert.deepEqual(s.payoutDetails, { method: "MOMO", phone: "0551234567", name: "Kwame Mensah" });
  assert.deepEqual([s.rate.pct, s.winDeductionPct, s.account.partner_id], [45, 10, env.code]);
  const settings = await getSettings(env.db);
  assert.deepEqual([settings.settlement_period, settings.carry_negative, settings.min_payout], ["DAILY", true, 50]);
  await assert.rejects(() => saveSettings(env.db, ADMIN, { min_payout: 500, max_payout: 100 }), isErr("invalid_amount"));
});

test("Migration 026 keeps every partner's unpaid deposit commission as an opening balance, and waiting requests as holds", async () => {
  const env = await setupWalletDb({ stopBefore: "026_partner_revshare.sql" });
  const { db } = env;
  /* the new wallet code (used below to move money) writes these columns; on Render the migration adds them before it runs */
  await db.query("ALTER TABLE user_balances ADD COLUMN IF NOT EXISTS deposit_funds NUMERIC(38,18) NOT NULL DEFAULT 0");
  await db.query("ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS deposit_part NUMERIC(38,18)");
  await db.query(`INSERT INTO affiliates (user_id, code, status, deposit_pct) VALUES ($1, 'VBOLD123', 'ACTIVE', 10)`, [env.userId]);
  const ama = await ensureWalletAccount(db, "acct-ama", "ama");
  await db.query(`INSERT INTO referrals (user_id, affiliate_id) VALUES ($1, $2)`, [ama, env.userId]);
  await env.client.query("BEGIN");
  await deposit(env.client, ama, "GHS", 1000, "deposit:" + key()); // 10% = 100 earned
  await env.client.query("COMMIT");
  await db.query(`INSERT INTO affiliate_payouts (affiliate_id, amount, method, status) VALUES ($1, 30, 'MOMO', 'PAID'), ($1, 20, 'MOMO', 'REQUESTED')`,
    [env.userId]);
  await env.runMigration("026_partner_revshare.sql");
  await env.runMigration("027_partner_deposit_funds.sql");
  const w = await walletOf(db, env.userId);
  assert.deepEqual([w.available, w.withdrawn, w.pendingWithdrawals], [50, 30, 20], "100 earned - 30 paid - 20 waiting");
  const reqId = (await db.query(`SELECT id FROM affiliate_payouts WHERE status = 'REQUESTED'`)).rows[0].id;
  await decidePartnerPayout(db, ADMIN, reqId, { action: "reject", note: "test rejection" });
  assert.equal((await walletOf(db, env.userId)).available, 70);
});

/* ---------------- commission only on losses of real deposited money ---------------- */

test("Example 1: a player deposits 500, stakes 200 of it and loses: the partner earns 20% of 200 = 40", async () => {
  const env = await partnerWithTerms({ revshare_pct: 20 });
  const ama = await referred(env, "ama");
  await fund(env, ama, 500);
  await play(env, ama, 200, 0);
  assert.deepEqual(await balanceRow(env, ama), { available: 300, winnings: 0, deposits: 300 });
  await accrueCommissions(env.db);
  const [c] = (await partnerCommissions(env.db, await fresh(env))).commissions;
  assert.deepEqual([c!.stake, c!.depositStake, c!.eligibleLoss, c!.pct, c!.amount, c!.kind], [200, 200, 200, 20, 40, "commission"]);
  const w = await walletOf(env.db, env.userId);
  assert.deepEqual([w.eligibleLosses, w.totalEarned, w.pending], [200, 40, 40]);
});

test("Example 2: a player stakes 300 of their deposit and wins 1,000: no commission, the partner is deducted 10% = 100", async () => {
  const env = await partnerWithTerms({ revshare_pct: 20 });
  const ama = await referred(env, "ama");
  await fund(env, ama, 500);
  await play(env, ama, 300, 1300); // 1,000 net winnings
  assert.deepEqual(await balanceRow(env, ama), { available: 1500, winnings: 1300, deposits: 200 }, "the whole payout is winnings");
  await accrueCommissions(env.db);
  const [c] = (await partnerCommissions(env.db, await fresh(env))).commissions;
  assert.deepEqual([c!.depositStake, c!.eligibleLoss, c!.pct, c!.amount, c!.kind], [300, 0, 10, -100, "deduction"]);
  const w = await walletOf(env.db, env.userId);
  assert.deepEqual([w.totalEarned, w.negativeAdjustments, w.pending], [0, -100, -100]);
});

test("Example 3: losing money that came from winnings earns the partner nothing", async () => {
  const env = await partnerWithTerms({ revshare_pct: 20 });
  const ama = await referred(env, "ama");
  await fund(env, ama, 500);
  await play(env, ama, 300, 1300);          // example 2: deposits left 200, winnings 1,300
  await play(env, ama, 200, 0);             // the remaining deposit, lost: +40
  assert.deepEqual(await balanceRow(env, ama), { available: 1300, winnings: 1300, deposits: 0 });
  await play(env, ama, 1000, 0);            // 1,000 of winnings, lost: nothing
  await accrueCommissions(env.db);
  const rows = (await partnerCommissions(env.db, await fresh(env))).commissions;
  const lost = rows.find((c) => c.stake === 1000)!;
  assert.deepEqual([lost.depositStake, lost.eligibleLoss, lost.amount, lost.kind], [0, 0, 0, "not_eligible"]);
  const w = await walletOf(env.db, env.userId);
  assert.deepEqual([w.eligibleLosses, w.totalEarned, w.negativeAdjustments, w.lifetimeNet], [200, 40, -100, -60]);
});

test("A stake of deposits and winnings together: only the deposited share of the loss counts", async () => {
  const env = await partnerWithTerms({ revshare_pct: 50 });
  const ama = await referred(env, "ama");
  await fund(env, ama, 100);
  await play(env, ama, 100, 150);           // all deposit, wins 50 net: -5; now winnings 150, deposits 0
  await fund(env, ama, 60);                 // deposits 60, winnings 150
  await play(env, ama, 100, 40);            // 60 deposit + 40 winnings, loses 60: eligible 60 x 60/100 = 36, at 50% = 18
  await accrueCommissions(env.db);
  const c = (await partnerCommissions(env.db, await fresh(env))).commissions.find((x) => x.payout === 40)!;
  assert.deepEqual([c.depositStake, c.eligibleLoss, c.amount], [60, 36, 18]);
});

test("Admin credits and refunded stakes: an admin's credit isn't deposited money; a void bet gives its deposit back", async () => {
  const env = await partnerWithTerms({ revshare_pct: 50 });
  const ama = await referred(env, "ama");
  /* an admin's credit is spent like deposits but never earns commission */
  await move(env, () => postMovement(env.client, { idempotencyKey: "adjust:" + key(), entryType: "ADJUSTMENT", reason: "goodwill credit for testing",
    legs: [...leg(ama, "CREDIT", 100)] }));
  await play(env, ama, 100, 0);
  /* a void step-game round returns its deposited stake as deposited money */
  await session(env, ama, 40, 0, "VOID");
  assert.deepEqual(await balanceRow(env, ama), { available: 40, winnings: 0, deposits: 40 });
  await play(env, ama, 40, 0);              // the refunded deposit, lost: +20
  await accrueCommissions(env.db);
  const rows = (await partnerCommissions(env.db, await fresh(env))).commissions;
  assert.deepEqual(rows.map((c) => [c.stake, c.eligibleLoss, c.amount]).sort(), [[100, 0, 0], [40, 40, 20]].sort());
  assert.equal(rows.length, 2, "the void round itself never counts");
});

test("A withdrawal takes winnings only and leaves deposited money (and its eligibility) alone", async () => {
  const env = await partnerWithTerms({ revshare_pct: 50 });
  const ama = await referred(env, "ama");
  await fund(env, ama, 100);
  await play(env, ama, 50, 150);            // deposits 50, winnings 150
  await requestWithdrawal(env.db, { id: ama, phone: "0241234567" }, 100, key());
  assert.deepEqual(await balanceRow(env, ama), { available: 100, winnings: 50, deposits: 50 });
});

test("The admin sees every commission record with the player behind it and its working", async () => {
  const env = await partnerWithTerms({ revshare_pct: 20 });
  const ama = await referred(env, "ama");
  await env.db.query(`UPDATE users SET full_name = 'Ama Mensah', phone = '0551112222' WHERE id = $1`, [ama]);
  await fund(env, ama, 500);
  await play(env, ama, 200, 0);
  await play(env, ama, 100, 500);
  const d = await partnerDetail(env.db, env.userId);
  assert.equal(d.commissions.length, 2);
  for (const c of d.commissions) assert.deepEqual([c.full_name, c.phone, c.user_id], ["Ama Mensah", "0551112222", ama]);
  assert.deepEqual([d.lifetime.deposits, d.lifetime.eligibleLosses, d.lifetime.commission, d.lifetime.negative], [500, 200, 40, -40]);
  const s = await partnerSummary(env.db, await fresh(env));
  assert.deepEqual(s.deposits, { total: 500, players: 1 });
  const mine = (await partnerCommissions(env.db, await fresh(env))).commissions[0]!;
  assert.ok(!("full_name" in mine) && !("phone" in mine), "the partner never sees who the player is");
});

test("Migration 027 works out each past stake's deposited part and re-rates unsettled commission", async () => {
  const env = await setupWalletDb({ stopBefore: "027_partner_deposit_funds.sql" });
  const { db } = env;
  /* the new wallet code (used below to move money) writes these columns; on Render the migration adds them before it runs */
  await db.query("ALTER TABLE user_balances ADD COLUMN IF NOT EXISTS deposit_funds NUMERIC(38,18) NOT NULL DEFAULT 0");
  await db.query("ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS deposit_part NUMERIC(38,18)");
  await applyPartner(db, env.userId, { channel: "My football WhatsApp group (2,000 members)" });
  await updatePartner(db, ADMIN, env.userId, { status: "ACTIVE", revshare_pct: 20 });
  const ama = await ensureWalletAccount(db, "acct-ama", "ama");
  await attributeReferral(db, ama, { code: (await partnerOf(db, env.userId))!.code });
  await db.query(`UPDATE referrals SET created_at = now() - interval '1 day'`);
  /* the old way: deposit 500, win 1,000 net on a 300 stake, then lose 1,000 (200 deposit left + 800 winnings) */
  const k1 = key(), k2 = key();
  await move(env, async () => {
    await deposit(env.client, ama, "GHS", 500, "deposit:" + key());
    await postMovement(env.client, { idempotencyKey: "bet:" + k1, entryType: "BET_PLACED", legs: [...leg(ama, "DEBIT", 300)] });
    await postMovement(env.client, { idempotencyKey: "win:" + k1, entryType: "BET_SETTLED", legs: [...leg(ama, "CREDIT", 1300)] });
    await postMovement(env.client, { idempotencyKey: "bet:" + k2, entryType: "BET_PLACED", legs: [...leg(ama, "DEBIT", 1000)] });
  });
  for (const [k, stake, payout] of [[k1, 300, 1300], [k2, 1000, 0]] as const) {
    await db.query(`INSERT INTO game_rounds (user_id, game, currency, stake, payout, choice, outcome, idempotency_key)
                    VALUES ($1, 'volta-coin', 'GHS', $2, $3, '{}', '{}', $4)`, [ama, stake, payout, k]);
  }
  await db.query(`INSERT INTO partner_commissions (affiliate_id, player_id, source, bet_id, game, stake, payout, ngr, pct, amount, settled_at)
                  SELECT $1, user_id, 'round', id, game, stake, payout, stake - payout, CASE WHEN payout > stake THEN 10 ELSE 20 END,
                         CASE WHEN payout > stake THEN -trunc((payout - stake) * 0.1, 2) ELSE trunc((stake - payout) * 0.2, 2) END, created_at
                    FROM game_rounds`, [env.userId]);   // what the old rule recorded: -100 and +200
  await env.runMigration("027_partner_deposit_funds.sql");
  const rows = (await db.query(`SELECT stake, deposit_stake, eligible_loss, amount FROM partner_commissions ORDER BY stake`)).rows
    .map((r) => [Number(r.stake), Number(r.deposit_stake), Number(r.eligible_loss), Number(r.amount)]);
  assert.deepEqual(rows, [[300, 300, 0, -100], [1000, 200, 200, 40]], "only the 200 of deposited money in the 1,000 earns");
  const b = (await db.query(`SELECT available, withdrawable, deposit_funds FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [ama])).rows[0];
  assert.deepEqual([Number(b.available), Number(b.withdrawable), Number(b.deposit_funds)], [500, 500, 0]);
});
