import assert from "node:assert/strict";
import test from "node:test";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { applyPartner, partnerOf, PartnerError, partnerSettings, updatePartner } from "../src/services/affiliates.js";
import { acceptInvite, cancelInvite, createInvite, invitePhone, inviteInfo, listInvites, registerWithInvite, renewInvite } from "../src/services/partnerInvites.js";
import { permissionsOf } from "../src/services/partnerPlatform.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0241112222";
const ENV = { ACCOUNTS_API_URL: "http://accounts.test", ACCOUNTS_INTERNAL_SECRET: "s3cret-0123456789abcd" } as NodeJS.ProcessEnv;
const isErr = (code: string) => (e: unknown) => e instanceof PartnerError && e.code === code;
const DETAILS = { full_name: "Ama Owusu", username: "AmaPromo", password: "Sup3r-secret!", dob: "1992-03-04", email: "ama@example.com" };

/* a stand-in for the accounts service: numbers in `taken` already have an account */
function fakeAccounts(taken: string[] = [], delayMs = 0) {
  const calls: Record<string, unknown>[] = [];
  let id = 7000;
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push(body);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (taken.includes(String(body.phone))) return new Response(JSON.stringify({ error: "This number already has an account", field: "phone" }), { status: 409 });
    return new Response(JSON.stringify({ user: { id: ++id, phone: body.phone, username: body.username, full_name: body.full_name, email: body.email ?? null, country: "GH" } }), { status: 201 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test("Setup link numbers are read like the accounts service stores them", () => {
  assert.equal(invitePhone("024 555 0001"), "0245550001");
  assert.equal(invitePhone("+233 24 555 0001"), "0245550001");
  assert.equal(invitePhone("00233245550001"), "0245550001");
  assert.equal(invitePhone("+44 7700 900123"), "+447700900123");
  assert.throws(() => invitePhone("12345"), isErr("invalid_phone"));
  assert.throws(() => invitePhone("0115550001"), isErr("invalid_phone"), "not a Ghana mobile prefix");
});

test("An admin makes a setup link (number, commission, switches); the partner registers through it once and lands on those terms", async () => {
  const env = await setupWalletDb();
  const fake = fakeAccounts();
  try {
    await assert.rejects(() => createInvite(env.db, ADMIN, { phone: "0245550001", revshare_pct: 95 }), isErr("invalid_rate"));
    const { token, invite } = await createInvite(env.db, ADMIN, { phone: "024 555 0001", revshare_pct: "35", permissions: { tools_mines: true, flyers: false } });
    assert.match(token, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(invite.state, "open");
    const listed = await listInvites(env.db);
    assert.equal(JSON.stringify(listed).includes(token), false, "the secret is never shown again (only its hash is kept)");
    const row = (await env.db.query(`SELECT token_hash FROM partner_invites`)).rows[0];
    assert.notEqual(row.token_hash, token);

    const info = await inviteInfo(env.db, token);
    assert.deepEqual([info.phone, info.phone_masked, info.revshare_pct, info.existing_account], ["0245550001", "024•••0001", 35, false]);
    await assert.rejects(() => inviteInfo(env.db, "x".repeat(32)), isErr("invite_invalid"));

    const out = await registerWithInvite(env.db, token, { ...DETAILS, phone: "0209999999", promo_code: "ama2026" } as Parameters<typeof registerWithInvite>[2], ENV);
    assert.equal(fake.calls[0]!.phone, "0245550001", "the account gets the invited number, whatever else is sent");
    assert.equal(fake.calls[0]!.full_name, "Ama Owusu");
    const a = (await partnerOf(env.db, out.user_id))!;
    assert.deepEqual([a.status, a.promo_code, out.promo_code], ["ACTIVE", "AMA2026", "AMA2026"]);
    assert.equal((await partnerSettings(env.db, a)).rate.pct, 35);
    const perms = await permissionsOf(env.db, a);
    assert.deepEqual([perms.effective.tools_mines, perms.effective.flyers, perms.effective.dashboard], [true, false, true]);

    await assert.rejects(() => inviteInfo(env.db, token), isErr("invite_used"));
    await assert.rejects(() => registerWithInvite(env.db, token, { ...DETAILS, username: "Other1" }, ENV), isErr("invite_used"));
    assert.equal(fake.calls.length, 1, "a used link never opens a second account");
    const used = (await listInvites(env.db)).invites[0]!;
    assert.deepEqual([used.state, used.used_by, used.partner_code], ["used", out.user_id, a.code]);
    await assert.rejects(() => createInvite(env.db, ADMIN, { phone: "0245550001" }), isErr("already_partner"));
  } finally {
    fake.restore();
  }
});

test("A failed registration leaves the link working; a taken promo code is caught before any account is made", async () => {
  const env = await setupWalletDb();
  const fake = fakeAccounts(["0245550002"]);
  try {
    const own = await ensureWalletAccount(env.db, "acct-other", "taker");
    await applyPartner(env.db, own, { channel: "Somebody else's promo channel" });
    await updatePartner(env.db, ADMIN, own, { status: "ACTIVE", promo_code: "TAKEN1" });
    const { token } = await createInvite(env.db, ADMIN, { phone: "0245550003" });
    await assert.rejects(() => registerWithInvite(env.db, token, { ...DETAILS, promo_code: "TAKEN1" }, ENV), isErr("promo_taken"));
    assert.equal(fake.calls.length, 0);
    assert.equal((await inviteInfo(env.db, token)).phone, "0245550003", "still open");

    const b = await createInvite(env.db, ADMIN, { phone: "0245550002" });
    await assert.rejects(() => registerWithInvite(env.db, b.token, DETAILS, ENV), isErr("already_registered"));
    assert.equal((await inviteInfo(env.db, b.token)).phone, "0245550002", "the link still works, to accept with the existing account");
  } finally {
    fake.restore();
  }
});

test("A player who already has the invited number accepts with their own account; any other account is refused", async () => {
  const env = await setupWalletDb();
  const owner = await ensureWalletAccount(env.db, "acct-ama", "ama");
  const stranger = await ensureWalletAccount(env.db, "acct-x", "x");
  /* signing in copies the account's number here (middleware/authenticate.ts) */
  await env.db.query(`UPDATE users SET phone = CASE id WHEN $1::uuid THEN '0245550004' ELSE '0245550099' END WHERE id IN ($1, $2)`, [owner, stranger]);
  const { token } = await createInvite(env.db, ADMIN, { phone: "0245550004", revshare_pct: 25 });
  assert.equal((await inviteInfo(env.db, token)).existing_account, true);
  await assert.rejects(() => acceptInvite(env.db, token, stranger), isErr("wrong_account"));
  const out = await acceptInvite(env.db, token, owner, { promo_code: "AMAWINS" });
  const a = (await partnerOf(env.db, owner))!;
  assert.deepEqual([out.user_id, a.status, a.promo_code], [owner, "ACTIVE", "AMAWINS"]);
  assert.equal((await partnerSettings(env.db, a)).rate.pct, 25);
  await assert.rejects(() => acceptInvite(env.db, token, owner), isErr("invite_used"));
});

test("Links expire, can be cancelled, and a new link replaces the old one at once", async () => {
  const env = await setupWalletDb();
  const fake = fakeAccounts();
  try {
    const first = await createInvite(env.db, ADMIN, { phone: "0245550005" });
    const second = await createInvite(env.db, ADMIN, { phone: "0245550005" });
    await assert.rejects(() => inviteInfo(env.db, first.token), isErr("invite_cancelled"), "a new link for the same number replaces the old one");
    const renewed = await renewInvite(env.db, ADMIN, second.invite.id);
    await assert.rejects(() => inviteInfo(env.db, second.token), isErr("invite_invalid"), "the renewed link's old secret is gone");
    assert.equal((await inviteInfo(env.db, renewed.token)).phone, "0245550005");
    await env.db.query(`UPDATE partner_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`, [second.invite.id]);
    await assert.rejects(() => inviteInfo(env.db, renewed.token), isErr("invite_expired"));
    await assert.rejects(() => registerWithInvite(env.db, renewed.token, DETAILS, ENV), isErr("invite_expired"));
    const again = await renewInvite(env.db, ADMIN, second.invite.id);
    await cancelInvite(env.db, ADMIN, second.invite.id);
    await assert.rejects(() => registerWithInvite(env.db, again.token, DETAILS, ENV), isErr("invite_cancelled"));
    assert.equal(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

test("The same link used twice at once opens one account only", async () => {
  const env = await setupWalletDb();
  const fake = fakeAccounts([], 30);
  try {
    const { token } = await createInvite(env.db, ADMIN, { phone: "0245550006" });
    const results = await Promise.allSettled([
      registerWithInvite(env.db, token, { ...DETAILS, username: "First1" }, ENV),
      registerWithInvite(env.db, token, { ...DETAILS, username: "Second2" }, ENV),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(fake.calls.length, 1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(isErr("invite_busy")(rejected.reason) || isErr("invite_used")(rejected.reason));
  } finally {
    fake.restore();
  }
});
