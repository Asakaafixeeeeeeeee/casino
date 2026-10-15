// src/services/accountControl.ts
//
// The main admin's Blocked users, Banned users and Deleted users. A restriction changes what an account may do; it
// never changes a balance, a bet, a transaction or an audit record, and a deleted account keeps all of them (so it can
// be restored). Banning, deactivating and deleting also stop log-in on the accounts server (and end its sessions).

import type { Pool } from "pg";
import { isAdmin } from "../middleware/authenticate.js";
import { AdminError, logAction, mustFindUser, searchTerm } from "./admin.js";
import { expireBlocks } from "./blockExpiry.js";

export type Restriction = "BLOCKED" | "BANNED" | "DEACTIVATED" | "DELETED";
export type ListKind = "blocked" | "banned" | "deleted";
const KINDS: Record<ListKind, Restriction[]> = { blocked: ["BLOCKED"], banned: ["BANNED"], deleted: ["DEACTIVATED", "DELETED"] };
const KIND_ACTIONS: Record<ListKind, string[]> = {
  blocked: ["block", "unblock", "expire"], banned: ["ban", "lift_ban"], deleted: ["deactivate", "delete", "restore"],
};
/** The wallet status each restriction means: BLOCKED may still look (SUSPENDED); the rest may do nothing (CLOSED). */
const STATUS: Record<Restriction, "SUSPENDED" | "CLOSED"> = { BLOCKED: "SUSPENDED", BANNED: "CLOSED", DEACTIVATED: "CLOSED", DELETED: "CLOSED" };
const MAX_BLOCK_DAYS = 3650;

const num = (v: unknown) => Number(v ?? 0);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** One kind's list (blocked, banned or deleted), searchable, with the counts of all three and the kind's history. */
export async function restrictedUsers(db: Pool, kind: unknown, q: unknown) {
  const k = (["blocked", "banned", "deleted"].includes(String(kind)) ? String(kind) : "blocked") as ListKind;
  await expireBlocks(db);
  const { text, phone } = searchTerm(q);
  const users = (await db.query(
    `SELECT u.id, u.username, u.full_name, u.phone, u.status::text AS status, u.restriction, u.restriction_reason, u.restricted_at,
            u.restricted_by, u.blocked_until, u.last_login_at, u.created_at, coalesce(b.available, 0) AS balance
       FROM users u LEFT JOIN user_balances b ON b.user_id = u.id AND b.currency_code = 'GHS'
      WHERE u.restriction = ANY($1::text[])
        AND ($2 = '' OR lower(coalesce(u.username, '')) LIKE '%' || $2 || '%' OR lower(coalesce(u.full_name, '')) LIKE '%' || $2 || '%'
             OR ($3 <> '' AND coalesce(u.phone, '') LIKE '%' || $3 || '%'))
      ORDER BY u.restricted_at DESC NULLS LAST LIMIT 200`, [KINDS[k], text, phone])).rows;
  const counts = (await db.query<{ restriction: string; n: string }>(
    `SELECT restriction, count(*) AS n FROM users WHERE restriction IS NOT NULL GROUP BY restriction`)).rows;
  const c = (r: Restriction) => num(counts.find((x) => x.restriction === r)?.n);
  const history = (await db.query(
    `SELECT h.action, h.reason, h.until, h.admin, h.login_synced, h.created_at, u.id AS user_id, u.username, u.full_name, u.phone
       FROM account_restrictions h JOIN users u ON u.id = h.user_id
      WHERE h.action = ANY($1::text[]) ORDER BY h.created_at DESC LIMIT 60`, [KIND_ACTIONS[k]])).rows;
  return {
    kind: k,
    counts: { blocked: c("BLOCKED"), banned: c("BANNED"), deleted: c("DEACTIVATED") + c("DELETED") },
    users: users.map((u) => ({
      id: u.id, username: u.username, full_name: u.full_name, phone: u.phone, status: u.status, restriction: u.restriction,
      reason: u.restriction_reason, since: iso(u.restricted_at), by: u.restricted_by, until: iso(u.blocked_until),
      balance: Math.round(num(u.balance) * 100) / 100, last_seen: iso(u.last_login_at), joined: iso(u.created_at),
    })),
    history: history.map((h) => ({
      action: h.action, reason: h.reason, until: iso(h.until), admin: h.admin, login_synced: h.login_synced, at: iso(h.created_at),
      user_id: h.user_id, name: h.full_name || h.username || "Player", phone: h.phone,
    })),
  };
}

/** One player's restriction and history, for the player's page. */
export async function accountRestriction(db: Pool, id: unknown) {
  const uid = await mustFindUser(db, id);
  await expireBlocks(db, uid);
  const u = (await db.query(
    `SELECT restriction, restriction_reason, restricted_at, restricted_by, blocked_until FROM users WHERE id = $1`, [uid])).rows[0]!;
  const history = (await db.query(
    `SELECT action, reason, until, admin, login_synced, created_at FROM account_restrictions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [uid])).rows;
  return {
    restriction: u.restriction, reason: u.restriction_reason, since: iso(u.restricted_at), by: u.restricted_by, until: iso(u.blocked_until),
    history: history.map((h) => ({ action: h.action, reason: h.reason, until: iso(h.until), admin: h.admin, login_synced: h.login_synced, at: iso(h.created_at) })),
  };
}

/** Tells the accounts server whether this account may log in (ACTIVE) or not (BANNED, DELETED). False if it couldn't. */
async function syncLogin(db: Pool, uid: string, access: "ACTIVE" | "BANNED" | "DELETED", env: NodeJS.ProcessEnv): Promise<boolean> {
  const url = env.ACCOUNTS_API_URL;
  const secret = env.ACCOUNTS_INTERNAL_SECRET;
  const account = (await db.query<{ account_user_id: string }>(`SELECT account_user_id FROM user_accounts WHERE user_id = $1`, [uid])).rows[0];
  if (!url || !secret || !account) return false;
  const r = await fetch(url.replace(/\/$/, "") + "/api/internal/access", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Internal-Secret": secret },
    body: JSON.stringify({ account_id: account.account_user_id, access }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  return !!r && r.ok;
}

function untilOf(input: Record<string, unknown>, now: number): Date | null {
  if (input.until !== undefined && input.until !== null && input.until !== "") {
    const d = new Date(String(input.until));
    if (Number.isNaN(d.getTime())) throw new AdminError("invalid_until", "That end date isn't a date");
    if (d.getTime() <= now) throw new AdminError("invalid_until", "The blocking period must end in the future");
    if (d.getTime() > now + MAX_BLOCK_DAYS * 864e5) throw new AdminError("invalid_until", "Block for at most 10 years, or ban the account instead");
    return d;
  }
  const days = Number(input.days ?? 0);
  const hours = Number(input.hours ?? 0);
  if (!Number.isFinite(days) || !Number.isFinite(hours) || days < 0 || hours < 0) throw new AdminError("invalid_until", "Give the blocking period in days and hours");
  const ms = (days * 24 + hours) * 3600e3;
  if (ms === 0) return null; /* until an admin unblocks */
  if (ms > MAX_BLOCK_DAYS * 864e5) throw new AdminError("invalid_until", "Block for at most 10 years, or ban the account instead");
  return new Date(now + ms);
}

/**
 * block (reason; a period or an end date, or none = until unblocked), unblock, ban (reason), lift_ban (review note),
 * deactivate (reason), delete (reason and confirm: "DELETE"), restore. Admin accounts can't be restricted.
 */
export async function controlAccount(db: Pool, admin: string, id: unknown, input: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const uid = await mustFindUser(db, id);
  await expireBlocks(db, uid);
  const u = (await db.query<{ phone: string | null; restriction: Restriction | null }>(
    `SELECT phone, restriction FROM users WHERE id = $1`, [uid])).rows[0]!;
  const action = String(input.action ?? "");
  const reason = String(input.reason ?? "").trim().slice(0, 300);
  const needReason = (what: string) => { if (reason.length < 4) throw new AdminError("reason_needed", `Write the reason for ${what} (at least 4 characters)`); };
  const refuse = (msg: string) => { throw new AdminError("not_allowed", msg, 409); };
  if (u.phone && isAdmin({ id: uid, accountId: "", phone: u.phone }, env)) refuse("Admin accounts can't be blocked, banned or deleted.");

  let next: Restriction | null;
  let until: Date | null = null;
  let access: "ACTIVE" | "BANNED" | "DELETED" | null = null;
  switch (action) {
    case "block":
      needReason("blocking");
      if (u.restriction && u.restriction !== "BLOCKED") refuse(`This account is ${u.restriction.toLowerCase()}. Restore it or lift the ban first.`);
      until = untilOf(input, now);
      next = "BLOCKED";
      break;
    case "unblock":
      if (u.restriction !== "BLOCKED") refuse("This account isn't blocked.");
      next = null;
      break;
    case "ban":
      needReason("the ban");
      if (u.restriction === "BANNED") refuse("This account is already banned.");
      if (u.restriction === "DELETED") refuse("This account is deleted. Restore it first.");
      next = "BANNED";
      access = "BANNED";
      break;
    case "lift_ban":
      needReason("lifting the ban (your review)");
      if (u.restriction !== "BANNED") refuse("This account isn't banned.");
      next = null;
      access = "ACTIVE";
      break;
    case "deactivate":
      needReason("deactivating");
      if (u.restriction === "BANNED" || u.restriction === "DELETED" || u.restriction === "DEACTIVATED") refuse(`This account is already ${u.restriction.toLowerCase()}.`);
      next = "DEACTIVATED";
      access = "DELETED";
      break;
    case "delete":
      needReason("deleting");
      if (input.confirm !== "DELETE") throw new AdminError("confirm_needed", "Type DELETE to confirm the deletion");
      if (u.restriction === "DELETED") refuse("This account is already deleted.");
      next = "DELETED";
      access = "DELETED";
      break;
    case "restore":
      if (u.restriction !== "DELETED" && u.restriction !== "DEACTIVATED") refuse("Only a deactivated or deleted account can be restored.");
      next = null;
      access = "ACTIVE";
      break;
    default:
      throw new AdminError("invalid_action", "Choose block, unblock, ban, lift_ban, deactivate, delete or restore");
  }

  await db.query(
    `UPDATE users SET status = $2::account_status, restriction = $3, restriction_reason = $4, restricted_at = $5, restricted_by = $6,
            blocked_until = $7, updated_at = now() WHERE id = $1`,
    [uid, next ? STATUS[next] : "ACTIVE", next, next ? reason || null : null, next ? new Date(now) : null, next ? admin : null, until]);
  const loginSynced = access ? await syncLogin(db, uid, access, env) : null;
  await db.query(
    `INSERT INTO account_restrictions (user_id, action, reason, until, admin, login_synced) VALUES ($1, $2, $3, $4, $5, $6)`,
    [uid, action, reason || null, until, admin, loginSynced]);
  await logAction(db, admin, "account." + action, uid, { reason, until: iso(until), login_synced: loginSynced });
  return { restriction: next, status: next ? STATUS[next] : "ACTIVE", until: iso(until), login_synced: loginSynced };
}
