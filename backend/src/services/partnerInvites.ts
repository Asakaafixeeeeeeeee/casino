import crypto from "node:crypto";
import type { Pool } from "pg";
import { logAction } from "./admin.js";
import { getSettings, PartnerError, partnerOf, setOwnPromo, updatePartner } from "./affiliates.js";
import { openSignInAccount, permissionInput, savePartnerPermissions } from "./partnerPlatform.js";

/*
 * Partner setup links. An admin enters only the partner's phone number, their commission and their feature switches;
 * this makes a secret one-time link the admin sends to the partner. The partner opens it and registers their own
 * account (name, username, password, date of birth), and becomes an active partner with exactly those terms.
 *
 *   - the link's secret (24 random bytes) is never stored: only its SHA-256 hash, so a copy of the database can't be
 *     turned back into working links
 *   - it's for that phone number only: the account it opens gets that number, and a player who already has an
 *     account with it must log in to that account to accept it
 *   - it works once, for 7 days; the admin can cancel it or make a new one (the old one stops working at once)
 */

const DAYS = 7;
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GH_PREFIXES = ["020", "023", "024", "025", "026", "027", "050", "053", "054", "055", "056", "057", "059"];
const hashOf = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const newToken = () => crypto.randomBytes(24).toString("base64url");

interface Invite {
  id: string; phone: string; revshare_pct: string; permissions: Record<string, boolean>; note: string | null; created_by: string;
  created_at: Date; expires_at: Date; used_at: Date | null; used_by: string | null; revoked_at: Date | null;
}

/** A number the way the accounts service stores it: 0241234567 for Ghana, +<code><number> otherwise. */
export function invitePhone(raw: unknown): string {
  const s = String(raw ?? "").replace(/[\s().-]/g, "");
  const gh = /^(?:\+|00)?2330?(\d{9})$/.exec(s);
  const p = gh ? "0" + gh[1] : s.replace(/^00/, "+");
  if (/^0\d{9}$/.test(p) && GH_PREFIXES.includes(p.slice(0, 3))) return p;
  if (/^\+[1-9]\d{7,14}$/.test(p) && DIALS.some(([d]) => p.startsWith("+" + d))) return p;
  throw new PartnerError("invalid_phone", "Enter the partner's mobile number, e.g. 024 123 4567 (or +<country code> for another country)");
}

/* a claim (used_at without used_by) older than this was interrupted: the link works again */
const STALE_CLAIM_MS = 120_000;
/* the country the accounts service files a number under (its sign-up list), from the number's calling code */
const DIALS: [string, string][] = [["971", "AE"], ["233", "GH"], ["234", "NG"], ["254", "KE"], ["20", "EG"], ["27", "ZA"], ["44", "GB"],
  ["49", "DE"], ["33", "FR"], ["34", "ES"], ["39", "IT"], ["91", "IN"], ["55", "BR"], ["81", "JP"], ["61", "AU"], ["1", "US"]];
function countryOfPhone(p: string) {
  if (!p.startsWith("+")) return "GH";
  return (DIALS.find(([d]) => p.startsWith("+" + d)) ?? ["", "GH"])[1];
}

const stateOf = (i: Pick<Invite, "used_at" | "used_by" | "revoked_at" | "expires_at">, now = new Date()) =>
  i.used_by ? "used" : i.used_at && now.getTime() - new Date(i.used_at).getTime() < STALE_CLAIM_MS ? "busy" : i.revoked_at ? "cancelled" : new Date(i.expires_at).getTime() <= now.getTime() ? "expired" : "open";

/* what the admin sees of an invitation (never the secret) */
function adminView(i: Invite & { used_name?: string | null; used_username?: string | null; partner_code?: string | null }) {
  return {
    id: i.id, phone: i.phone, revshare_pct: Number(i.revshare_pct), permissions: i.permissions ?? {}, note: i.note, created_by: i.created_by,
    created_at: i.created_at, expires_at: i.expires_at, used_at: i.used_at, used_by: i.used_by, state: stateOf(i),
    used_name: i.used_name ?? null, used_username: i.used_username ?? null, partner_code: i.partner_code ?? null,
  };
}

/** An admin makes a setup link: the partner's number, their commission and (optionally) their feature switches. */
export async function createInvite(db: Pool, admin: string, input: { phone?: unknown; revshare_pct?: unknown; permissions?: unknown; note?: unknown }) {
  const phone = invitePhone(input.phone);
  const s = await getSettings(db);
  const rawPct = input.revshare_pct === undefined || input.revshare_pct === null || input.revshare_pct === "" ? s.default_revshare_pct : input.revshare_pct;
  const pct = Number(rawPct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 90 || !/^\d+(\.\d{1,2})?$/.test(String(rawPct).trim())) {
    throw new PartnerError("invalid_rate", "Enter a commission from 0% to 90%");
  }
  const perms = input.permissions === undefined || input.permissions === null ? {} : permissionInput(input.permissions, false);
  const note = String(input.note ?? "").trim().replace(/\s+/g, " ").slice(0, 300) || null;
  /* a number that's already an active (or suspended) partner doesn't need a setup link */
  const existing = (await db.query<{ status: string; code: string }>(
    `SELECT a.status, a.code FROM users u JOIN affiliates a ON a.user_id = u.id WHERE u.phone = $1 LIMIT 1`, [phone])).rows[0];
  if (existing && (existing.status === "ACTIVE" || existing.status === "SUSPENDED")) {
    throw new PartnerError("already_partner", `That number is already a partner (Partner ID ${existing.code}). Open their profile to change their terms.`, 409);
  }
  const token = newToken();
  const client = await db.connect();
  let row: Invite;
  try {
    await client.query("BEGIN");
    /* a new link for the same number replaces the one before it */
    const old = await client.query(`UPDATE partner_invites SET revoked_at = now() WHERE phone = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING id`, [phone]);
    row = (await client.query<Invite>(
      `INSERT INTO partner_invites (token_hash, phone, revshare_pct, permissions, note, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING *`,
      [hashOf(token), phone, pct, JSON.stringify(perms), note, admin, DAYS])).rows[0]!;
    await logAction(client, admin, "partner.invite", row.id, { phone, revshare_pct: pct, permissions: perms, replaced: old.rows.map((x) => x.id) });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { invite: adminView(row), token, existingAccount: !!(await db.query(`SELECT 1 FROM users WHERE phone = $1`, [phone])).rowCount };
}

/** The newest invitations, for the admin's list. */
export async function listInvites(db: Pool) {
  const { rows } = await db.query(
    `SELECT i.*, u.full_name AS used_name, u.username AS used_username, a.code AS partner_code
       FROM partner_invites i LEFT JOIN users u ON u.id = i.used_by LEFT JOIN affiliates a ON a.user_id = i.used_by
      ORDER BY i.created_at DESC LIMIT 200`);
  return { invites: rows.map(adminView), days: DAYS };
}

/** A fresh link for an invitation not used yet (the old link stops working at once), valid for another 7 days. */
export async function renewInvite(db: Pool, admin: string, id: unknown) {
  const iid = String(id ?? "");
  if (!UUID.test(iid)) throw new PartnerError("not_found", "That invitation wasn't found", 404);
  const token = newToken();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const inv = (await client.query<Invite>(`SELECT * FROM partner_invites WHERE id = $1 FOR UPDATE`, [iid])).rows[0];
    if (!inv) throw new PartnerError("not_found", "That invitation wasn't found", 404);
    if (inv.used_by) throw new PartnerError("invite_used", "That invitation has already been used", 409);
    /* only one open link per number: any other one for it is cancelled */
    await client.query(`UPDATE partner_invites SET revoked_at = now() WHERE phone = $1 AND id <> $2 AND used_at IS NULL AND revoked_at IS NULL`, [inv.phone, iid]);
    const row = (await client.query<Invite>(
      `UPDATE partner_invites SET token_hash = $2, revoked_at = NULL, used_at = NULL, expires_at = now() + make_interval(days => $3) WHERE id = $1 RETURNING *`,
      [iid, hashOf(token), DAYS])).rows[0]!;
    await logAction(client, admin, "partner.invite.renew", iid, { phone: inv.phone });
    await client.query("COMMIT");
    return { invite: adminView(row), token };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** An admin cancels an invitation: its link stops working at once. */
export async function cancelInvite(db: Pool, admin: string, id: unknown) {
  const iid = String(id ?? "");
  if (!UUID.test(iid)) throw new PartnerError("not_found", "That invitation wasn't found", 404);
  const { rows: [row] } = await db.query<Invite>(
    `UPDATE partner_invites SET revoked_at = now() WHERE id = $1 AND used_by IS NULL AND revoked_at IS NULL RETURNING *`, [iid]);
  if (!row) throw new PartnerError("not_open", "That invitation isn't open (already used or cancelled)", 409);
  await logAction(db, admin, "partner.invite.cancel", iid, { phone: row.phone });
  return { invite: adminView(row) };
}

/* "024•••4567": enough for the partner to recognise their number, not enough to read it off a shared screen */
const masked = (p: string) => (p.length > 7 ? p.slice(0, p.startsWith("+") ? 4 : 3) + "•••" + p.slice(-4) : p);

function openInviteError(i: Invite | undefined, now = new Date()) {
  if (!i) return new PartnerError("invite_invalid", "This partner setup link isn't valid. Check you copied the whole link, or ask the WIN B casino team for a new one.", 404);
  const st = stateOf(i, now);
  if (st === "busy") return new PartnerError("invite_busy", "This link is being used right now. Try again in a moment.", 409);
  if (st === "used") return new PartnerError("invite_used", "This partner setup link has already been used. Log in with the account you made.", 410);
  if (st === "cancelled") return new PartnerError("invite_cancelled", "This partner setup link was cancelled. Ask the WIN B casino team for a new one.", 410);
  if (st === "expired") return new PartnerError("invite_expired", "This partner setup link has expired. Ask the WIN B casino team for a new one.", 410);
  return null;
}

/** What the setup page shows before the partner registers (public: the secret link is the key). */
export async function inviteInfo(db: Pool, token: unknown) {
  const t = String(token ?? "");
  const inv = TOKEN.test(t) ? (await db.query<Invite>(`SELECT * FROM partner_invites WHERE token_hash = $1`, [hashOf(t)])).rows[0] : undefined;
  const err = openInviteError(inv);
  if (err) throw err;
  const i = inv!;
  return {
    phone: i.phone, phone_masked: masked(i.phone), revshare_pct: Number(i.revshare_pct), expires_at: i.expires_at,
    existing_account: !!(await db.query(`SELECT 1 FROM users WHERE phone = $1`, [i.phone])).rowCount,
  };
}

/* checks a promo code the partner chose before anything is created, so a taken one doesn't leave a half-made account */
async function promoFree(db: Pool, raw: unknown) {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  const code = v.toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(code)) throw new PartnerError("invalid_promo", "Your promo code must be 4 to 16 letters and numbers, no spaces or symbols");
  if ((await db.query(`SELECT 1 FROM affiliates WHERE code = $1 OR promo_code = $1`, [code])).rowCount) {
    throw new PartnerError("promo_taken", "That promo code is already used by another partner — choose another", 409);
  }
  return code;
}

/* the account becomes an active partner on the invitation's terms */
async function makePartner(db: Pool, i: Invite, userId: string) {
  await updatePartner(db, i.created_by, userId, { status: "ACTIVE", revshare_pct: Number(i.revshare_pct), note: i.note ?? "Joined through a partner setup link" });
  await db.query(`UPDATE affiliates SET created_by_admin = $2, channel = 'Partner setup link' WHERE user_id = $1`, [userId, i.created_by]);
  if (i.permissions && Object.keys(i.permissions).length) await savePartnerPermissions(db, i.created_by, userId, i.permissions);
}

/* the promo code chosen at setup: set at once, or sent for approval when partners can't set their own */
async function choosePromo(db: Pool, userId: string, code: string) {
  if (!code) return { promo_code: null, promo_request: null };
  const a = await partnerOf(db, userId);
  try {
    const r = await setOwnPromo(db, a!, { promo_code: code });
    return { promo_code: r.promo_code, promo_request: r.promo_request };
  } catch (e) {
    /* switched off, or taken a moment ago: the partner can choose one later in Settings */
    return { promo_code: null, promo_request: null, promo_error: e instanceof PartnerError ? e.message : "Couldn't save the promo code" };
  }
}

/* claims the invitation in one atomic step before the account is made, so the same link can't be used twice at once;
   if making the account fails, the claim is let go and the link works again */
async function withOpenInvite<T extends { user_id: string }>(db: Pool, token: unknown, fn: (i: Invite) => Promise<T>) {
  const t = String(token ?? "");
  if (!TOKEN.test(t)) throw openInviteError(undefined)!;
  const { rows: [inv] } = await db.query<Invite>(
    `UPDATE partner_invites SET used_at = now() WHERE token_hash = $1 AND (used_at IS NULL OR (used_by IS NULL AND used_at < now() - interval '2 minutes'))
       AND revoked_at IS NULL AND expires_at > now() RETURNING *`,
    [hashOf(t)]);
  if (!inv) throw openInviteError((await db.query<Invite>(`SELECT * FROM partner_invites WHERE token_hash = $1`, [hashOf(t)])).rows[0])
    ?? new PartnerError("invite_busy", "This link is being used right now. Try again in a moment.", 409);
  let out: T;
  try {
    out = await fn(inv);
  } catch (e) {
    await db.query(`UPDATE partner_invites SET used_at = NULL WHERE id = $1 AND used_by IS NULL`, [inv.id]);
    throw e;
  }
  await db.query(`UPDATE partner_invites SET used_by = $2 WHERE id = $1`, [inv.id, out.user_id]);
  await logAction(db, inv.created_by, "partner.invite.used", inv.id, { user_id: out.user_id, phone: inv.phone });
  return out;
}

/**
 * The partner registers through their setup link: their own name, username, password, date of birth (and optionally
 * an email and a promo code). The account gets the invitation's phone number and terms.
 */
export async function registerWithInvite(
  db: Pool, token: unknown,
  input: { full_name?: unknown; username?: unknown; password?: unknown; dob?: unknown; email?: unknown; promo_code?: unknown },
  env: NodeJS.ProcessEnv = process.env,
) {
  return withOpenInvite(db, token, async (i) => {
    const promo = await promoFree(db, input.promo_code);
    let opened;
    try {
      opened = await openSignInAccount(db, {
        full_name: input.full_name, phone: i.phone, username: input.username, password: input.password, dob: input.dob,
        email: input.email, country: countryOfPhone(i.phone),
      }, env);
    } catch (e) {
      if (e instanceof PartnerError && e.code === "already_registered") {
        throw new PartnerError("already_registered", "This number already has a WIN B casino account. Log in with it to accept this invitation.", 409);
      }
      throw e;
    }
    await makePartner(db, i, opened.userId);
    const pr = await choosePromo(db, opened.userId, promo);
    const a = (await partnerOf(db, opened.userId))!;
    return { user_id: opened.userId, username: opened.user.username, phone: opened.user.phone, code: a.code, ...pr, promo_code: a.promo_code };
  });
}

/** A player who already has an account with the invited number logs in and accepts the invitation. */
export async function acceptInvite(db: Pool, token: unknown, userId: string, input: { promo_code?: unknown } = {}) {
  return withOpenInvite(db, token, async (i) => {
    const me = (await db.query<{ phone: string | null }>(`SELECT phone FROM users WHERE id = $1`, [userId])).rows[0];
    let mine = "";
    try { mine = invitePhone(me?.phone); } catch { /* no usable number on this account */ }
    if (mine !== i.phone) {
      throw new PartnerError("wrong_account", `This invitation is for the account with the number ${masked(i.phone)}. Log in with that account to accept it.`, 403);
    }
    const a = await partnerOf(db, userId);
    if (a && (a.status === "ACTIVE" || a.status === "SUSPENDED")) throw new PartnerError("already_partner", "This account is already a partner.", 409);
    const promo = await promoFree(db, input.promo_code);
    await makePartner(db, i, userId);
    const pr = await choosePromo(db, userId, promo);
    const now = (await partnerOf(db, userId))!;
    return { user_id: userId, code: now.code, ...pr, promo_code: now.promo_code };
  });
}
