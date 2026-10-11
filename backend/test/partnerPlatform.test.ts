import assert from "node:assert/strict";
import test from "node:test";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { auditLog } from "../src/services/admin.js";
import {
  applyPartner, attributeReferral, partnerOf, PartnerError, recordClick, requestPayout, resolveReferral, setOwnPromo, updatePartner,
} from "../src/services/affiliates.js";
import {
  createCampaign, createPartnerAccount, createTemplate, deleteFlyer, deleteTemplate, gameTools, globalPermissions, partnerFlyers,
  permissionsOf, requirePermission, saveFlyer, saveGlobalPermissions, savePartnerPermissions, saveTemplate, toolsList, updateCampaign,
  uploadAsset, assetFile,
} from "../src/services/partnerPlatform.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0241112222";
const isErr = (code: string) => (e: unknown) => e instanceof PartnerError && e.code === code;

async function partner() {
  const env = await setupWalletDb();
  await applyPartner(env.db, env.userId, { channel: "My football WhatsApp group (2,000 members)" });
  await updatePartner(env.db, ADMIN, env.userId, { status: "ACTIVE" });
  return { ...env, a: async () => (await partnerOf(env.db, env.userId))! };
}

test("Permissions: global defaults (game tools off), per-partner overrides, and the backend refuses what's off", async () => {
  const env = await partner();
  const g = await globalPermissions(env.db);
  assert.deepEqual([g.dashboard, g.flyers, g.tools_mines, g.tools_aviator], [true, true, false, false]);
  await assert.rejects(async () => requirePermission(env.db, await env.a(), "tools_mines"), isErr("feature_off"));
  await assert.rejects(async () => gameTools(env.db, await env.a(), "mines"), isErr("feature_off"), "tools are refused, not just hidden");
  await savePartnerPermissions(env.db, ADMIN, env.userId, { tools_mines: true, flyers: false });
  const p = await permissionsOf(env.db, await env.a());
  assert.deepEqual([p.effective.tools_mines, p.effective.flyers, p.effective.dashboard], [true, false, true]);
  await assert.rejects(async () => partnerFlyers(env.db, await env.a()), isErr("feature_off"));
  await savePartnerPermissions(env.db, ADMIN, env.userId, { flyers: null });   // back to the global setting
  assert.equal((await permissionsOf(env.db, await env.a())).effective.flyers, true);
  await saveGlobalPermissions(env.db, ADMIN, { flyers: false });
  assert.equal((await permissionsOf(env.db, await env.a())).effective.flyers, false, "a global switch reaches every partner");
  await assert.rejects(async () => savePartnerPermissions(env.db, ADMIN, env.userId, { nonsense: true }), isErr("invalid_permissions"));
  assert.equal((await auditLog(env.db, { target: env.userId })).actions[0]!.action, "partner.permissions");
});

test("Switching off referral links, promo codes or withdrawals stops them on the server", async () => {
  const env = await partner();
  await setOwnPromo(env.db, await env.a(), { promo_code: "JOHN500" });
  const a = await env.a();
  const p1 = await ensureWalletAccount(env.db, "acct-p1", "p1");
  await savePartnerPermissions(env.db, ADMIN, env.userId, { referral_links: false });
  assert.equal(await recordClick(env.db, a.code, ""), false, "clicks through a switched-off link don't count");
  assert.equal((await attributeReferral(env.db, p1, { code: a.code })).reason, "unknown_code", "nobody joins through it");
  assert.equal((await attributeReferral(env.db, p1, { promo: "JOHN500" })).attributed, true, "the promo code still works");
  await savePartnerPermissions(env.db, ADMIN, env.userId, { promo_codes: false });
  await assert.rejects(async () => resolveReferral(env.db, { promo: "JOHN500" }), isErr("unknown_promo"));
  await assert.rejects(async () => setOwnPromo(env.db, await env.a(), { promo_code: "JOHN600" }), isErr("feature_off"));
  await savePartnerPermissions(env.db, ADMIN, env.userId, { commission_withdrawals: false });
  await assert.rejects(async () => requestPayout(env.db, a, { amount: 60, method: "MOMO", details: { phone: "0241234567", name: "Kwame" } }),
    isErr("feature_off"));
});

test("An admin creates a partner who never registered: account on the accounts service, wallet, partner, link and promo", async () => {
  const env = await setupWalletDb();
  const calls: { url: string; body: Record<string, unknown>; secret: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), secret: String((init.headers as Record<string, string>)["X-Internal-Secret"]) });
    const body = calls.at(-1)!.body;
    if (body.phone === "0240000009") return new Response(JSON.stringify({ error: "This number already has an account", field: "phone" }), { status: 409 });
    return new Response(JSON.stringify({ user: { id: 9001, phone: body.phone, username: body.username, full_name: body.full_name, email: body.email, country: "GH" } }), { status: 201 });
  }) as typeof fetch;
  const envVars = { ACCOUNTS_API_URL: "http://accounts.test", ACCOUNTS_INTERNAL_SECRET: "s3cret-0123456789abcd" } as NodeJS.ProcessEnv;
  try {
    await assert.rejects(async () => createPartnerAccount(env.db, ADMIN, {}, {} as NodeJS.ProcessEnv), isErr("not_configured"));
    const out = await createPartnerAccount(env.db, ADMIN, {
      full_name: "John Mensah", phone: "0245550001", email: "john@example.com", username: "JohnPartner", password: "Sup3r-secret!",
      dob: "1990-01-01", revshare_pct: 35, code: "JOHN2026", promo_code: "JOHN500", permissions: { tools_mines: true },
    }, envVars);
    assert.equal(calls[0]!.url, "http://accounts.test/api/internal/accounts");
    assert.equal(calls[0]!.secret, "s3cret-0123456789abcd");
    assert.deepEqual([out.code, out.promo_code, out.status, out.full_name], ["JOHN2026", "JOHN500", "ACTIVE", "John Mensah"]);
    const a = (await partnerOf(env.db, out.user_id))!;
    assert.equal(a.created_by_admin, ADMIN);
    assert.equal((await permissionsOf(env.db, a)).effective.tools_mines, true);
    const u = (await env.db.query(`SELECT phone, full_name, contact_email FROM users WHERE id = $1`, [out.user_id])).rows[0];
    assert.deepEqual([u.phone, u.full_name, u.contact_email], ["0245550001", "John Mensah", "john@example.com"]);
    /* anyone joining through the new link is this partner's */
    const p = await ensureWalletAccount(env.db, "acct-joiner", "joiner");
    assert.equal((await attributeReferral(env.db, p, { code: "JOHN2026" })).attributed, true);
    assert.equal((await env.db.query(`SELECT affiliate_id FROM referrals WHERE user_id = $1`, [p])).rows[0].affiliate_id, out.user_id);
    /* a taken Partner ID is refused before an account is opened */
    const n = calls.length;
    await assert.rejects(async () => createPartnerAccount(env.db, ADMIN, { phone: "0245550002", code: "JOHN2026" }, envVars), isErr("code_taken"));
    assert.equal(calls.length, n, "no stray account");
    await assert.rejects(async () => createPartnerAccount(env.db, ADMIN, { phone: "0240000009", password: "x" }, envVars), isErr("already_registered"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Flyers: admin templates and campaigns; partners get enabled templates, live campaigns (if allowed), their own codes", async () => {
  const env = await partner();
  await setOwnPromo(env.db, await env.a(), { promo_code: "JOHN500" });
  let f = await partnerFlyers(env.db, await env.a());
  assert.equal(f.templates.length, 17, "20 built-in designs, the 3 sports ones off until there's a sportsbook");
  assert.deepEqual([f.partner.promo_code, f.partner.link_live], ["JOHN500", true]);
  assert.equal(f.campaigns.length, 0);
  await saveTemplate(env.db, ADMIN, "vip", { enabled: false });
  const c = (await createCampaign(env.db, ADMIN, { title: "October welcome", headline: "Welcome to WIN B", offer: "100% first deposit bonus up to GHS 200", terms: "18+. T&Cs apply." })).campaign;
  await createCampaign(env.db, ADMIN, { title: "Paused one", headline: "Not live", active: false });
  await assert.rejects(async () => createCampaign(env.db, ADMIN, { title: "x" }), isErr("invalid_campaign"));
  f = await partnerFlyers(env.db, await env.a());
  assert.equal(f.templates.length, 16);
  assert.deepEqual(f.campaigns.map((x) => x.offer), ["100% first deposit bonus up to GHS 200"], "only active campaigns");
  /* the admin changes the wording: new flyers use it */
  await updateCampaign(env.db, ADMIN, c.id, { offer: "50% first deposit bonus up to GHS 100" });
  assert.equal((await partnerFlyers(env.db, await env.a())).campaigns[0]!.offer, "50% first deposit bonus up to GHS 100");
  await savePartnerPermissions(env.db, ADMIN, env.userId, { campaigns: false });
  assert.equal((await partnerFlyers(env.db, await env.a())).campaigns.length, 0, "no campaigns when switched off");
  /* custom templates */
  const t = (await createTemplate(env.db, ADMIN, { name: "Gold rush", config: { layout: "jackpot", primary: "#ffc83d", headline: "Big games" } })).template;
  await assert.rejects(async () => createTemplate(env.db, ADMIN, { name: "Bad", config: { layout: "nope" } }), isErr("invalid_template"));
  await assert.rejects(async () => saveTemplate(env.db, ADMIN, "welcome", { config: { layout: "vip" } }), isErr("builtin"));
  await assert.rejects(async () => deleteTemplate(env.db, ADMIN, "welcome"), isErr("builtin"));
  /* saving flyers */
  const saved = (await saveFlyer(env.db, await env.a(), { template_id: t.id, size: "story", title: "My story" })).flyer;
  await assert.rejects(async () => saveFlyer(env.db, await env.a(), { template_id: "vip", size: "story" }), isErr("invalid_template"), "a switched-off template");
  await assert.rejects(async () => saveFlyer(env.db, await env.a(), { template_id: t.id, size: "giant" }), isErr("invalid_size"));
  assert.equal((await partnerFlyers(env.db, await env.a())).saved.length, 1);
  const other = await ensureWalletAccount(env.db, "acct-other", "other");
  await updatePartner(env.db, ADMIN, other, {});
  await assert.rejects(async () => deleteFlyer(env.db, (await partnerOf(env.db, other))!, saved.id), isErr("not_found"), "another partner can't touch it");
  await deleteTemplate(env.db, ADMIN, t.id);
  assert.equal((await partnerFlyers(env.db, await env.a())).saved.length, 0);
});

test("Uploaded images: real PNG/JPG/WebP only, up to 2 MB, served back as stored", async () => {
  const env = await setupWalletDb();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
  const { asset } = await uploadAsset(env.db, ADMIN, { name: "hero", data: "data:image/png;base64," + png.toString("base64") });
  const f = (await assetFile(env.db, asset.id))!;
  assert.equal(f.mime, "image/png");
  assert.deepEqual(Buffer.from(f.data), png);
  await assert.rejects(async () => uploadAsset(env.db, ADMIN, { data: "data:image/jpeg;base64," + png.toString("base64") }), isErr("invalid_image"), "not what it claims");
  await assert.rejects(async () => uploadAsset(env.db, ADMIN, { data: "data:text/html;base64,PGgxPg==" }), isErr("invalid_image"));
});

test("Game tools: real odds and finished rounds only — never a round still in play", async () => {
  const env = await partner();
  await savePartnerPermissions(env.db, ADMIN, env.userId, { tools_mines: true, tools_aviator: true, tools_crash: true, tools_other: true });
  const list = await toolsList(env.db, await env.a());
  assert.ok(list.tools.every((t) => t.enabled));
  const mines = await gameTools(env.db, await env.a(), "mines") as { odds: { mines: number; picks: { picks: number; chance: number; multiplier: number }[] }[]; limitations: string };
  const three = mines.odds.find((o) => o.mines === 3)!.picks.find((p) => p.picks === 1)!;
  assert.deepEqual([three.chance, three.multiplier], [88, 1.1], "22/25 safe, 0.965 / 0.88 = 1.10");
  assert.match(mines.limitations, /nobody .* can see or predict it in advance/);
  /* Aviator: a finished round shows; one still flying doesn't */
  await env.db.query(`INSERT INTO sky_rounds (no, seed, hash, crash, starts_at, ends_at, settled) VALUES
    (1, 's1', 'h1', 2.5, now() - interval '2 minutes', now() - interval '1 minute', true),
    (2, 's2', 'h2', 9.99, now() - interval '10 seconds', now() + interval '1 minute', false)`);
  const av = await gameTools(env.db, await env.a(), "aviator") as { history: { round: number; crash: number }[] };
  assert.deepEqual(av.history.map((h) => [h.round, h.crash]), [[1, 2.5]]);
  const other = await gameTools(env.db, await env.a(), "other") as { roulette: { chance: number }[] };
  assert.ok(other.roulette.length > 0);
  await assert.rejects(async () => gameTools(env.db, await env.a(), "secret-board"), isErr("not_found"));
});
