import type { Pool, PoolClient } from "pg";
import { logAction } from "./admin.js";
import { type Affiliate, PartnerError, partnerOf, updatePartner } from "./affiliates.js";
import { ensureWalletAccount } from "./accountLink.js";
import { GAMES, HILO_RTP, ROULETTE_SPOTS } from "../games/catalog.js";
import { minesMultipliers } from "../games/sessionCatalog.js";

/*
 * The partner platform around the commission system (affiliates.ts):
 *   - feature permissions, ON or OFF for every partner and for one partner, checked by the backend on every request
 *   - partners an admin creates directly (a new sign-in account on the accounts service, then a partner)
 *   - the promotional flyer generator's data: templates, admin-approved campaigns, uploaded images, saved flyers
 *   - game tools: the real odds and the results of FINISHED rounds only. Outcomes are drawn by the server with secure
 *     randomness and can't be predicted; nothing here reads a round still in play, a hidden board or a balance.
 */

type Db = Pool | PoolClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => Number(v ?? 0);
const round2 = (x: number) => Math.round(x * 100) / 100;
const text = (v: unknown, max: number) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);

/* ---------------------------------------------------------------- permissions */

export const PERMISSIONS = [
  ["dashboard", "Partner dashboard"],
  ["referral_links", "Referral links"],
  ["promo_codes", "Promo codes"],
  ["referral_stats", "Referral statistics"],
  ["commission_withdrawals", "Commission withdrawals"],
  ["wallet_deposits", "Wallet deposits"],
  ["flyers", "Flyer generator"],
  ["campaigns", "Promotional campaigns"],
  ["tools_mines", "Mines tools"],
  ["tools_aviator", "Aviator tools"],
  ["tools_crash", "Crash tools"],
  ["tools_other", "Other game tools"],
] as const;
export type Permission = (typeof PERMISSIONS)[number][0];
const KEYS = PERMISSIONS.map((p) => p[0]) as readonly string[];
const DEFAULTS: Record<string, boolean> = {
  dashboard: true, referral_links: true, promo_codes: true, referral_stats: true, commission_withdrawals: true,
  wallet_deposits: true, flyers: true, campaigns: true, tools_mines: false, tools_aviator: false, tools_crash: false, tools_other: false,
};

export async function globalPermissions(db: Db): Promise<Record<string, boolean>> {
  const raw = (await db.query(`SELECT permissions FROM partner_settings`)).rows[0]?.permissions ?? {};
  return Object.fromEntries(KEYS.map((k) => [k, typeof raw[k] === "boolean" ? raw[k] : DEFAULTS[k]!]));
}

/** What a partner may use: their own overrides over the global settings. Not an ACTIVE partner: nothing. */
export async function permissionsOf(db: Db, a: Pick<Affiliate, "status"> & { permissions?: unknown }) {
  const global = await globalPermissions(db);
  const own = (a.permissions && typeof a.permissions === "object" ? a.permissions : {}) as Record<string, unknown>;
  const effective = Object.fromEntries(KEYS.map((k) => [k, typeof own[k] === "boolean" ? (own[k] as boolean) : global[k]!]));
  return { effective, global, overrides: Object.fromEntries(KEYS.filter((k) => typeof own[k] === "boolean").map((k) => [k, own[k]])) };
}

/** Throws a 403 the page can explain when a feature is switched off for this partner. */
export async function requirePermission(db: Db, a: Affiliate, key: Permission) {
  const { effective } = await permissionsOf(db, a);
  if (!effective[key]) {
    const label = PERMISSIONS.find((p) => p[0] === key)![1];
    throw new PartnerError("feature_off", `${label} ${key.startsWith("tools_") ? "are" : "is"} switched off for your account. Contact support if you need it.`, 403);
  }
}

export function permissionInput(raw: unknown, allowNull: boolean): Record<string, boolean | null> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PartnerError("invalid_permissions", "Send the permissions to change");
  const out: Record<string, boolean | null> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEYS.includes(k)) throw new PartnerError("invalid_permissions", `Unknown permission: ${k}`);
    if (v === true || v === false) out[k] = v;
    else if (allowNull && (v === null || v === "inherit")) out[k] = null;
    else throw new PartnerError("invalid_permissions", `Turn ${k} on or off`);
  }
  return out;
}

/** An admin turns features on or off for every partner. */
export async function saveGlobalPermissions(db: Pool, admin: string, raw: unknown) {
  const changes = permissionInput(raw, false) as Record<string, boolean>;
  const next = { ...(await globalPermissions(db)), ...changes };
  await db.query(`UPDATE partner_settings SET permissions = $1, updated_by = $2, updated_at = now()`, [JSON.stringify(next), admin]);
  await logAction(db, admin, "partner.permissions", "partner-settings", changes);
  return { permissions: next, list: PERMISSIONS.map(([key, label]) => ({ key, label })) };
}

/** An admin turns features on or off for one partner (null: follow the global setting again). */
export async function savePartnerPermissions(db: Pool, admin: string, userId: unknown, raw: unknown) {
  const uid = String(userId ?? "");
  const a = UUID.test(uid) ? await partnerOf(db, uid) : null;
  if (!a) throw new PartnerError("not_found", "That partner wasn't found", 404);
  const changes = permissionInput(raw, true);
  const own = { ...((a as unknown as { permissions?: Record<string, boolean> }).permissions ?? {}) };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete own[k];
    else own[k] = v;
  }
  await db.query(`UPDATE affiliates SET permissions = $2 WHERE user_id = $1`, [uid, JSON.stringify(own)]);
  await logAction(db, admin, "partner.permissions", uid, changes);
  return { ...(await permissionsOf(db, { status: a.status, permissions: own })), list: PERMISSIONS.map(([key, label]) => ({ key, label })) };
}

/* ---------------------------------------------------------------- partners an admin creates */

export interface CreateInput {
  full_name?: unknown; phone?: unknown; email?: unknown; username?: unknown; password?: unknown; dob?: unknown; country?: unknown;
  revshare_pct?: unknown; status?: unknown; code?: unknown; promo_code?: unknown; permissions?: unknown; note?: unknown;
}

function accountsConfig(env: NodeJS.ProcessEnv) {
  const url = env.ACCOUNTS_API_URL;
  const secret = env.ACCOUNTS_INTERNAL_SECRET;
  if (!url || !secret) {
    throw new PartnerError("not_configured", "Creating accounts isn't set up yet: ACCOUNTS_INTERNAL_SECRET must be set on both the accounts and balance services.", 503);
  }
  return { url, secret };
}

/**
 * Opens a sign-in account on the accounts service (checked exactly like a sign-up: name, number, 18+, password) and
 * its wallet here. A number that already has an account is refused with already_registered (409); a taken username
 * or email with <field>_taken.
 */
export async function openSignInAccount(db: Pool, input: CreateInput, env: NodeJS.ProcessEnv = process.env) {
  const { url, secret } = accountsConfig(env);
  const r = await fetch(url.replace(/\/$/, "") + "/api/internal/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": secret },
    body: JSON.stringify({
      full_name: input.full_name, phone: input.phone, email: input.email, username: input.username, password: input.password,
      dob: input.dob, country: input.country ?? "GH", currency: "GHS",
    }),
  }).catch(() => null);
  if (!r) throw new PartnerError("accounts_unavailable", "The accounts service didn't answer. Try again in a minute.", 503);
  const body = (await r.json().catch(() => ({}))) as { user?: { id: string | number; phone: string; username: string; full_name?: string; email?: string | null; country?: string }; error?: string; field?: string };
  if (!r.ok || !body.user) {
    const code = r.status === 409 ? (body.field === "phone" ? "already_registered" : (body.field || "account") + "_taken") : "invalid_" + (body.field || "account");
    throw new PartnerError(code, body.error || "Couldn't create the account", r.status === 409 ? 409 : 400);
  }
  const u = body.user;
  const userId = await ensureWalletAccount(db, String(u.id), u.username, u.phone, u.country);
  await db.query(`UPDATE users SET phone = $2, full_name = $3, contact_email = $4 WHERE id = $1`, [userId, u.phone, u.full_name ?? null, u.email ?? null]);
  return { userId, user: u };
}

/**
 * Creates a partner who has never registered: their sign-in account on the accounts service (the same one players
 * use, so they log in on the normal page), their wallet, and their partner account with its link and promo code.
 * The accounts service checks the details (name, number, 18+, password) exactly as at sign-up.
 */
export async function createPartnerAccount(db: Pool, admin: string, input: CreateInput, env: NodeJS.ProcessEnv = process.env) {
  accountsConfig(env);
  const status = input.status === undefined ? "ACTIVE" : String(input.status);
  if (!["ACTIVE", "SUSPENDED"].includes(status)) throw new PartnerError("invalid_status", "A new partner starts active or suspended");
  /* the partner's own choices are checked before the account is opened, so a taken code doesn't leave a stray account */
  for (const [field, label] of [["code", "Partner ID"], ["promo_code", "promo code"]] as const) {
    const v = String(input[field] ?? "").trim();
    if (!v) continue;
    const c = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/^[A-Z0-9]{4,16}$/.test(c) || c !== v.toUpperCase()) throw new PartnerError("invalid_" + field, `The ${label} must be 4 to 16 letters and numbers`);
    if ((await db.query(`SELECT 1 FROM affiliates WHERE code = $1 OR promo_code = $1`, [c])).rowCount) {
      throw new PartnerError(field + "_taken", `That ${label} is already used by another partner`, 409);
    }
  }
  /* a number that already has an account: the admin can make that player a partner instead */
  const { userId, user: u } = await openSignInAccount(db, input, env);
  await updatePartner(db, admin, userId, {
    status, ...(input.revshare_pct !== undefined && input.revshare_pct !== "" ? { revshare_pct: input.revshare_pct } : {}),
    ...(String(input.promo_code ?? "").trim() ? { promo_code: input.promo_code } : {}), note: input.note ?? "Created by an admin",
  });
  if (String(input.code ?? "").trim()) {
    await db.query(`UPDATE affiliates SET code = $2 WHERE user_id = $1`, [userId, String(input.code).toUpperCase()]);
  }
  await db.query(`UPDATE affiliates SET created_by_admin = $2, channel = 'Created by an admin' WHERE user_id = $1`, [userId, admin]);
  if (input.permissions !== undefined && input.permissions !== null) await savePartnerPermissions(db, admin, userId, input.permissions);
  await logAction(db, admin, "partner.create", userId, { phone: u.phone, username: u.username });
  const a = (await partnerOf(db, userId))!;
  return { user_id: userId, phone: u.phone, username: u.username, full_name: u.full_name ?? null, email: u.email ?? null, code: a.code, promo_code: a.promo_code, status: a.status };
}

/* ---------------------------------------------------------------- flyers: assets */

const MIME = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;
const MAX_ASSET = 2_000_000;

/** An admin uploads a promotional image (as a data: URL, PNG, JPG or WebP, up to 2 MB). */
export async function uploadAsset(db: Pool, admin: string, input: { name?: unknown; data?: unknown }) {
  const m = MIME.exec(String(input.data ?? ""));
  if (!m) throw new PartnerError("invalid_image", "Upload a PNG, JPG or WebP image");
  const bytes = Buffer.from(m[2]!, "base64");
  if (!bytes.length || bytes.length > MAX_ASSET) throw new PartnerError("invalid_image", "Images can be up to 2 MB");
  const sig = bytes.subarray(0, 12).toString("hex");
  const real = sig.startsWith("89504e47") ? "image/png" : sig.startsWith("ffd8ff") ? "image/jpeg" : sig.startsWith("52494646") && sig.slice(16, 24) === "57454250" ? "image/webp" : "";
  if (real !== m[1]) throw new PartnerError("invalid_image", "That file isn't the image it says it is");
  const name = text(input.name, 80) || "image";
  const { rows: [row] } = await db.query(
    `INSERT INTO flyer_assets (name, mime, data, size, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, mime, size, created_at`,
    [name, real, bytes, bytes.length, admin]);
  await logAction(db, admin, "flyer.asset", row.id, { name, size: bytes.length });
  return { asset: row };
}

export async function deleteAsset(db: Pool, admin: string, id: unknown) {
  const aid = String(id ?? "");
  if (!UUID.test(aid)) throw new PartnerError("not_found", "That image wasn't found", 404);
  const { rowCount } = await db.query(`DELETE FROM flyer_assets WHERE id = $1`, [aid]);
  if (!rowCount) throw new PartnerError("not_found", "That image wasn't found", 404);
  await logAction(db, admin, "flyer.asset.delete", aid, {});
  return { ok: true };
}

/** An uploaded image, for flyers (public: promotional images only). */
export async function assetFile(db: Pool, id: unknown) {
  const aid = String(id ?? "");
  if (!UUID.test(aid)) return null;
  return (await db.query<{ mime: string; data: Buffer }>(`SELECT mime, data FROM flyer_assets WHERE id = $1`, [aid])).rows[0] ?? null;
}

/* ---------------------------------------------------------------- flyers: templates and campaigns */

const LAYOUTS = ["welcome", "casino", "live", "aviator", "mines", "slots", "register", "mobile", "weekend", "vip", "new-player",
  "jackpot", "referral", "general", "special", "partner-ad", "premium", "sports", "football", "basketball"];
const COLOR = /^#[0-9a-f]{6}$/i;

function templateConfig(raw: unknown) {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const layout = String(c.layout ?? "general");
  if (!LAYOUTS.includes(layout)) throw new PartnerError("invalid_template", "Choose a design to base it on");
  const out: Record<string, unknown> = { layout };
  for (const k of ["primary", "accent", "background"]) {
    if (c[k] !== undefined && c[k] !== "") {
      if (!COLOR.test(String(c[k]))) throw new PartnerError("invalid_template", "Colours look like #ffc83d");
      out[k] = String(c[k]).toLowerCase();
    }
  }
  if (c.asset_id) {
    if (!UUID.test(String(c.asset_id))) throw new PartnerError("invalid_template", "Choose an uploaded image");
    out.asset_id = String(c.asset_id);
  }
  for (const [k, max] of [["headline", 60], ["tagline", 120], ["cta", 24]] as const) if (c[k] !== undefined) out[k] = text(c[k], max) || undefined;
  return out;
}

export async function adminFlyers(db: Pool) {
  const [templates, campaigns, assets] = await Promise.all([
    db.query(`SELECT * FROM flyer_templates ORDER BY sort, name`),
    db.query(`SELECT * FROM flyer_campaigns ORDER BY active DESC, updated_at DESC`),
    db.query(`SELECT id, name, mime, size, created_at, created_by FROM flyer_assets ORDER BY created_at DESC`),
  ]);
  return { templates: templates.rows, campaigns: campaigns.rows, assets: assets.rows, layouts: LAYOUTS };
}

/** An admin changes a template: on or off, its name, category, order, and (custom ones) its design. */
export async function saveTemplate(db: Pool, admin: string, id: unknown, input: Record<string, unknown>) {
  const tid = String(id ?? "");
  const t = (await db.query(`SELECT * FROM flyer_templates WHERE id = $1`, [tid])).rows[0];
  if (!t) throw new PartnerError("not_found", "That template wasn't found", 404);
  const sets: string[] = [];
  const params: unknown[] = [tid];
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (input.enabled !== undefined) set("enabled", input.enabled === true || input.enabled === "true");
  if (input.name !== undefined) set("name", text(input.name, 60) || t.name);
  if (input.category !== undefined) set("category", text(input.category, 30) || t.category);
  if (input.sort !== undefined && Number.isInteger(Number(input.sort))) set("sort", Number(input.sort));
  if (input.config !== undefined) {
    if (t.builtin) throw new PartnerError("builtin", "Built-in designs can't be redrawn — add a custom template based on one");
    set("config", JSON.stringify(templateConfig(input.config)));
  }
  if (!sets.length) return { template: t };
  params.push(admin);
  const { rows: [row] } = await db.query(
    `UPDATE flyer_templates SET ${sets.join(", ")}, updated_by = $${params.length}, updated_at = now() WHERE id = $1 RETURNING *`, params);
  await logAction(db, admin, "flyer.template", tid, input);
  return { template: row };
}

/** An admin adds a template: a built-in design with their own colours, background image and wording. */
export async function createTemplate(db: Pool, admin: string, input: Record<string, unknown>) {
  const name = text(input.name, 60);
  if (name.length < 3) throw new PartnerError("invalid_template", "Give the template a name");
  const config = templateConfig(input.config);
  const id = "custom-" + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const { rows: [row] } = await db.query(
    `INSERT INTO flyer_templates (id, name, category, builtin, enabled, sort, config, updated_by)
     VALUES ($1, $2, $3, false, true, 50, $4, $5) RETURNING *`, [id, name, text(input.category, 30) || "Custom", JSON.stringify(config), admin]);
  await logAction(db, admin, "flyer.template.create", id, { name });
  return { template: row };
}

/** Removes a custom template (built-in ones are switched off instead). */
export async function deleteTemplate(db: Pool, admin: string, id: unknown) {
  const tid = String(id ?? "");
  const t = (await db.query(`SELECT builtin FROM flyer_templates WHERE id = $1`, [tid])).rows[0];
  if (!t) throw new PartnerError("not_found", "That template wasn't found", 404);
  if (t.builtin) throw new PartnerError("builtin", "Built-in designs can be switched off, not removed");
  await db.query(`DELETE FROM flyer_templates WHERE id = $1`, [tid]);
  await logAction(db, admin, "flyer.template.delete", tid, {});
  return { ok: true };
}

function campaignInput(input: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  const req = (k: string, max: number, label: string) => {
    if (input[k] === undefined && partial) return;
    const v = text(input[k], max);
    if (v.length < 3) throw new PartnerError("invalid_campaign", `Enter the ${label}`);
    out[k] = v;
  };
  req("title", 80, "campaign name");
  req("headline", 60, "headline");
  for (const [k, max] of [["offer", 80], ["body", 160], ["terms", 200]] as const) if (input[k] !== undefined) out[k] = text(input[k], max) || null;
  if (input.cta !== undefined) out.cta = text(input.cta, 24) || "Join now";
  if (input.active !== undefined) out.active = input.active === true || input.active === "true";
  if (input.asset_id !== undefined) {
    if (input.asset_id && !UUID.test(String(input.asset_id))) throw new PartnerError("invalid_campaign", "Choose an uploaded image");
    out.asset_id = input.asset_id || null;
  }
  if (input.template_ids !== undefined) {
    const ids = Array.isArray(input.template_ids) ? input.template_ids.map(String).filter((s) => /^[a-z0-9-]{2,40}$/.test(s)) : [];
    out.template_ids = ids.length ? ids : null;
  }
  for (const k of ["starts_at", "ends_at"]) {
    if (input[k] === undefined) continue;
    if (!input[k]) { out[k] = null; continue; }
    const d = new Date(String(input[k]));
    if (Number.isNaN(d.getTime())) throw new PartnerError("invalid_campaign", "Enter valid dates");
    out[k] = d.toISOString();
  }
  return out;
}

export async function createCampaign(db: Pool, admin: string, input: Record<string, unknown>) {
  const c = campaignInput(input, false);
  const cols = Object.keys(c);
  const { rows: [row] } = await db.query(
    `INSERT INTO flyer_campaigns (${cols.join(", ")}, created_by, updated_by) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")}, $${cols.length + 1}, $${cols.length + 1}) RETURNING *`,
    [...cols.map((k) => c[k]), admin]);
  await logAction(db, admin, "flyer.campaign.create", row.id, c);
  return { campaign: row };
}

export async function updateCampaign(db: Pool, admin: string, id: unknown, input: Record<string, unknown>) {
  const cid = String(id ?? "");
  if (!UUID.test(cid)) throw new PartnerError("not_found", "That campaign wasn't found", 404);
  if (input.delete === true) {
    const { rowCount } = await db.query(`DELETE FROM flyer_campaigns WHERE id = $1`, [cid]);
    if (!rowCount) throw new PartnerError("not_found", "That campaign wasn't found", 404);
    await logAction(db, admin, "flyer.campaign.delete", cid, {});
    return { ok: true };
  }
  const c = campaignInput(input, true);
  const cols = Object.keys(c);
  if (!cols.length) throw new PartnerError("invalid_campaign", "Nothing to change");
  const { rows: [row] } = await db.query(
    `UPDATE flyer_campaigns SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_by = $${cols.length + 2}, updated_at = now()
      WHERE id = $1 RETURNING *`, [cid, ...cols.map((k) => c[k]), admin]);
  if (!row) throw new PartnerError("not_found", "That campaign wasn't found", 404);
  await logAction(db, admin, "flyer.campaign", cid, c);
  return { campaign: row };
}

/** What a partner's flyer generator needs: enabled templates, live campaigns (if allowed), their code and promo code. */
export async function partnerFlyers(db: Pool, a: Affiliate) {
  await requirePermission(db, a, "flyers");
  const { effective } = await permissionsOf(db, a);
  const [templates, campaigns, saved] = await Promise.all([
    db.query(`SELECT id, name, category, builtin, config FROM flyer_templates WHERE enabled ORDER BY sort, name`),
    effective.campaigns
      ? db.query(`SELECT id, title, headline, offer, body, cta, terms, asset_id, template_ids FROM flyer_campaigns
                   WHERE active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
                   ORDER BY updated_at DESC`)
      : Promise.resolve({ rows: [] }),
    db.query(`SELECT f.id, f.template_id, f.campaign_id, f.size, f.title, f.created_at FROM partner_flyers f
               JOIN flyer_templates t ON t.id = f.template_id AND t.enabled
              WHERE f.affiliate_id = $1 ORDER BY f.created_at DESC LIMIT 100`, [a.user_id]),
  ]);
  return {
    partner: {
      code: a.code,
      promo_code: effective.promo_codes ? a.promo_code : null,
      link_live: effective.referral_links && a.link_enabled && a.status === "ACTIVE",
    },
    templates: templates.rows, campaigns: campaigns.rows, saved: saved.rows,
    sizes: [
      { id: "story", w: 1080, h: 1920, label: "WhatsApp Status · Instagram Story" },
      { id: "post", w: 1080, h: 1080, label: "Instagram post · WhatsApp · Telegram" },
      { id: "portrait", w: 1080, h: 1350, label: "Instagram / Facebook portrait" },
      { id: "facebook", w: 1200, h: 630, label: "Facebook · Telegram link post" },
      { id: "banner", w: 1200, h: 1500, label: "General advertisement (print-friendly)" },
    ],
  };
}

export async function saveFlyer(db: Pool, a: Affiliate, input: { template_id?: unknown; campaign_id?: unknown; size?: unknown; title?: unknown }) {
  await requirePermission(db, a, "flyers");
  const t = (await db.query(`SELECT id FROM flyer_templates WHERE id = $1 AND enabled`, [String(input.template_id ?? "")])).rows[0];
  if (!t) throw new PartnerError("invalid_template", "Choose a template");
  let campaign: string | null = null;
  if (input.campaign_id) {
    await requirePermission(db, a, "campaigns");
    const c = (await db.query(`SELECT id FROM flyer_campaigns WHERE id = $1 AND active`, [String(input.campaign_id)])).rows[0];
    if (!c || !UUID.test(String(input.campaign_id))) throw new PartnerError("invalid_campaign", "That campaign isn't running");
    campaign = c.id;
  }
  const size = String(input.size ?? "");
  if (!["story", "post", "portrait", "facebook", "banner"].includes(size)) throw new PartnerError("invalid_size", "Choose a size");
  const n = num((await db.query(`SELECT count(*) AS n FROM partner_flyers WHERE affiliate_id = $1`, [a.user_id])).rows[0].n);
  if (n >= 100) throw new PartnerError("too_many", "You've saved 100 flyers — delete some first", 409);
  const { rows: [row] } = await db.query(
    `INSERT INTO partner_flyers (affiliate_id, template_id, campaign_id, size, title) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [a.user_id, t.id, campaign, size, text(input.title, 60) || null]);
  return { flyer: row };
}

export async function deleteFlyer(db: Pool, a: Affiliate, id: unknown) {
  const fid = String(id ?? "");
  if (!UUID.test(fid)) throw new PartnerError("not_found", "That flyer wasn't found", 404);
  const { rowCount } = await db.query(`DELETE FROM partner_flyers WHERE id = $1 AND affiliate_id = $2`, [fid, a.user_id]);
  if (!rowCount) throw new PartnerError("not_found", "That flyer wasn't found", 404);
  return { ok: true };
}

/* ---------------------------------------------------------------- game tools: real odds and finished rounds only */

export const TOOL_GAMES = {
  mines: "tools_mines", aviator: "tools_aviator", crash: "tools_crash", other: "tools_other",
} as const;
const LIMITS =
  "Every result is drawn by the server with secure randomness when the round is played, and nobody — partners, players or our staff — can see or predict it in advance. These are the game's real odds and the results of rounds that have already finished; past results don't change what happens next.";

const probAtLeast = (rtp: number, x: number) => Math.min(1, rtp / x);
const stats = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  const share = (x: number) => round2((100 * xs.filter((v) => v >= x).length) / xs.length);
  return { rounds: xs.length, median: at(0.5), p90: at(0.9), highest: s[s.length - 1], atLeast2x: share(2), atLeast5x: share(5), atLeast10x: share(10) };
};

/** One game's tools for a partner allowed to see them. Never a round in play, a hidden board or anyone's balance. */
export async function gameTools(db: Pool, a: Affiliate, game: string) {
  const key = (TOOL_GAMES as Record<string, Permission>)[game];
  if (!key) throw new PartnerError("not_found", "No tools for that game", 404);
  await requirePermission(db, a, key);
  if (game === "mines") {
    const table = [1, 3, 5, 10, 20].map((m) => {
      const mult = minesMultipliers(m);
      const picks = [1, 2, 3, 5, 8, 10].filter((k) => k <= 25 - m).map((k) => {
        let p = 1;
        for (let i = 0; i < k; i++) p *= (25 - m - i) / (25 - i);
        return { picks: k, chance: round2(p * 100), multiplier: mult[k] };
      });
      return { mines: m, picks };
    });
    /* finished Mines rounds in the last 30 days, all players together: how many safe picks before cashing out or a mine */
    const { rows } = await db.query(
      `SELECT status, (params->>'mines')::int AS mines, jsonb_array_length(progress->'picked') AS picks, count(*) AS n
         FROM game_sessions WHERE game = 'volta-mines' AND status IN ('WON', 'LOST') AND updated_at >= now() - interval '30 days'
        GROUP BY 1, 2, 3 ORDER BY 2, 3`);
    const finished = rows.map((r) => ({ result: r.status === "WON" ? "cashed out" : "hit a mine", mines: num(r.mines), picks: num(r.picks), rounds: num(r.n) }));
    return { game, title: "Mines", rtp: 96.5, limitations: LIMITS, odds: table, finished,
      note: "The chance of k safe picks in a row with m mines is (25−m)/25 × (24−m)/24 × … The multiplier pays 96.5% of the fair price." };
  }
  if (game === "aviator") {
    const rtp = num((await db.query(`SELECT rtp FROM sky_settings WHERE id = 1`)).rows[0]?.rtp ?? 0.97);
    const { rows } = await db.query(`SELECT no, crash::float AS crash, ends_at FROM sky_rounds WHERE settled AND ends_at < now() ORDER BY no DESC LIMIT 200`);
    return { game, title: "Aviator", rtp: round2(rtp * 100), limitations: LIMITS,
      odds: [1.5, 2, 3, 5, 10, 20, 50, 100].map((x) => ({ target: x, chance: round2(probAtLeast(rtp, x) * 100) })),
      history: rows.slice(0, 50).map((r) => ({ round: num(r.no), crash: num(r.crash), at: r.ends_at })),
      stats: stats(rows.map((r) => num(r.crash))),
      note: "The chance a round reaches a multiplier x is about RTP ÷ x. Each round's seed hash is published before it starts, so it can be checked afterwards." };
  }
  if (game === "crash") {
    const { rows } = await db.query(
      `SELECT game, crash::float AS crash FROM crash_flights WHERE settled AND ends_at < now() AND game IN ('volta-crash', 'volta-knockout')
        ORDER BY ends_at DESC LIMIT 1000`);
    const rtps: Record<string, number> = { "volta-crash": 0.9923, "volta-knockout": 0.97 };
    return { game, title: "Crash", limitations: LIMITS,
      games: Object.entries(rtps).map(([id, rtp]) => ({
        id, name: id === "volta-crash" ? "Crash" : "Knockout", rtp: round2(rtp * 100),
        odds: [1.5, 2, 3, 5, 10, 20, 50].map((x) => ({ target: x, chance: round2(probAtLeast(rtp, x) * 100) })),
        stats: stats(rows.filter((r) => r.game === id).map((r) => num(r.crash))),
      })),
      note: "Every player's flight is drawn on its own; these are finished flights of all players together, with no names." };
  }
  /* other: each one-draw game's published return and its main odds */
  /* WIN B roulette has 13 pockets (0–12); a spot pays x per unit staked, stake included */
  const names: Record<string, string> = { n7: "A single number", c1: "A column", red: "Red", odd: "Odd", low: "1–6" };
  const roulette = Object.entries(names).map(([spot, label]) => {
    const v = ROULETTE_SPOTS[spot]!;
    return { spot: label, numbers: v.nums.length, pays: v.x, chance: round2((v.nums.length / 13) * 100) };
  });
  return { game, title: "Other games", limitations: LIMITS,
    games: Object.values(GAMES).map((g) => ({ id: g.id, name: g.name, rtp: round2(g.rtp * 100), minBet: g.minBet, maxBet: g.maxBet })),
    roulette, hiloRtp: round2(HILO_RTP * 100),
    note: "RTP is what a game pays back over a very large number of rounds; any single round can win or lose." };
}

export async function toolsList(db: Pool, a: Affiliate) {
  const { effective } = await permissionsOf(db, a);
  return { tools: Object.entries(TOOL_GAMES).map(([id, key]) => ({ id, enabled: !!effective[key] })), limitations: LIMITS };
}
