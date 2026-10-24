// src/middleware/authenticate.ts
//
// The accounts service owns bearer-token issuance. This middleware validates a
// token through a private server-to-server endpoint and only forwards the
// user record required by the balance and payment services.

import type { NextFunction, Request, Response } from "express";
import { db } from "../db.js";
import { ensureWalletAccount } from "../services/accountLink.js";
import { expireBlocks } from "../services/blockExpiry.js";

export interface SessionUser {
  id: string;
  accountId: string;
  /** The registered mobile number, 0XXXXXXXXX — withdrawals are only ever paid here. */
  phone: string;
  /** ACTIVE, or SUSPENDED / CLOSED by an admin (set by authenticate). */
  status?: string;
}

/* what a suspended player may still do: finish a round already in play, look after themselves, and write to support */
const STILL_ALLOWED = /\/(cashout|step|cancel|feedback|limits|self-exclusion)$|^\/api\/support\/messages$/;

/** Whether a suspended (or closed) account may make this request: reading anything, finishing a round already in
 *  play (cash out, step, cancel), feedback, setting limits or taking a break, and messaging support (to appeal).
 *  Never a new bet, deposit or withdrawal. */
export function suspendedMayDo(method: string, url: string): boolean {
  return method === "GET" || STILL_ALLOWED.test(url.split("?")[0]!);
}

/** Keeps the player's number, full name, optional email and "last seen" current for the admin pages (at most every 5 minutes, or
 *  as soon as the number or name changes), and returns the account's status. */
async function touchUser(userId: string, phone: string, fullName: string, email: string):
  Promise<{ status: string; restriction: string | null; until: Date | null }> {
  await db.query(
    `UPDATE users SET phone = COALESCE(NULLIF($2, ''), phone), full_name = COALESCE(NULLIF($3, ''), full_name),
            contact_email = NULLIF($4, ''), last_login_at = now()
      WHERE id = $1 AND (last_login_at IS NULL OR last_login_at < now() - interval '5 minutes'
                         OR ($2 <> '' AND phone IS DISTINCT FROM $2)
                         OR ($3 <> '' AND full_name IS DISTINCT FROM $3)
                         OR contact_email IS DISTINCT FROM NULLIF($4, ''))`,
    [userId, phone, fullName, email]);
  /* a temporary block whose time is up ends here */
  await expireBlocks(db, userId);
  const { rows } = await db.query<{ status: string; restriction: string | null; blocked_until: Date | null }>(
    `SELECT status::text AS status, restriction, blocked_until FROM users WHERE id = $1`, [userId]);
  return { status: rows[0]?.status ?? "ACTIVE", restriction: rows[0]?.restriction ?? null, until: rows[0]?.blocked_until ?? null };
}

/** Banned, deactivated or deleted by the main admin: nothing at all is allowed (the accounts server refuses log-in too). */
function closedError(restriction: string | null) {
  return restriction === "BANNED"
    ? Object.assign(new Error("This account has been banned. Contact customer care if you think this is a mistake."), { status: 403, name: "account_banned" })
    : Object.assign(new Error("This account has been closed. Contact customer care if you think this is a mistake."), { status: 403, name: "account_closed" });
}

interface SessionVerifyResponse {
  user?: { id: string | number; username?: string; phone?: string; country?: string; full_name?: string | null; email?: string | null; deposit_terms_accepted_at?: string | null };
}

export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const authorization = req.headers.authorization;
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!match) {
    next(Object.assign(new Error("Unauthenticated"), { status: 401 }));
    return;
  }

  const accountsUrl = process.env.ACCOUNTS_API_URL;
  if (!accountsUrl) {
    next(Object.assign(new Error("Account verification is not configured"), { status: 503 }));
    return;
  }

  try {
    const response = await fetch(`${accountsUrl.replace(/\/$/, "")}/api/session/verify`, {
      headers: { Authorization: `Bearer ${match[1]}` },
    });
    if (!response.ok) {
      if (response.status === 401) {
        next(Object.assign(new Error("Invalid or expired session"), { status: 401 }));
        return;
      }
      console.error("[accounts/session/verify] returned HTTP %s", response.status);
      next(Object.assign(new Error("Account service unavailable"), { status: 503 }));
      return;
    }
    const body = await response.json() as SessionVerifyResponse;
    const user = body.user;
    const accountId = user?.id;
    if (accountId === undefined || accountId === null || accountId === "") {
      next(Object.assign(new Error("Invalid account session"), { status: 401 }));
      return;
    }
    const phone = String(user?.phone ?? "");
    const fullName = String(user?.full_name ?? "").slice(0, 120);
    const balanceUserId = await ensureWalletAccount(db, String(accountId), user?.username, phone, user?.country);
    const email = /^[^@s]{1,64}@[^@s]{1,190}.[^@s]{2,}$/.test(String(user?.email ?? "")) ? String(user!.email).toLowerCase() : "";
    const { status, restriction, until } = await touchUser(balanceUserId, phone, fullName, email);
    /* a player who accepted the deposit-number rule at sign-up has their registered number locked from the start */
    const acceptedAt = user?.deposit_terms_accepted_at ? new Date(user.deposit_terms_accepted_at) : null;
    if (acceptedAt && !Number.isNaN(acceptedAt.getTime()) && /^(?:\+|00)?(?:233|0)\d{9}$/.test(phone.replace(/[\s-]/g, ""))) {
      await db.query(
        `UPDATE users SET deposit_phone = $2, deposit_phone_confirmed_at = $3 WHERE id = $1 AND deposit_phone_confirmed_at IS NULL`,
        [balanceUserId, "0" + phone.replace(/[\s-]/g, "").slice(-9), acceptedAt.toISOString()]);
    }
    if (status === "CLOSED") {
      next(closedError(restriction));
      return;
    }
    (req as Request & { user: SessionUser }).user = { id: balanceUserId, accountId: String(accountId), phone, status };
    /* a suspended account can look, and finish what it started, but not bet, deposit or withdraw. The path tested is
       the one Express routed (mount + route path, no query or #fragment): testing originalUrl let a raw client send
       POST /api/user/withdraw#/cashout, which routes to /withdraw but looked like a cash-out to the gate. */
    if (status !== "ACTIVE" && !suspendedMayDo(req.method, (req.baseUrl || "") + (req.path || ""))) {
      const when = until ? " until " + new Date(until).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " GMT" : "";
      next(Object.assign(new Error(`Your account is blocked${when}. Contact support if you think this is a mistake.`),
        { status: 403, name: "account_suspended" }));
      return;
    }
    next();
  } catch (error) {
    console.error("[accounts/session/verify] request failed: %s", (error as Error).message);
    next(Object.assign(new Error("Account service unavailable"), { status: 503 }));
  }
}

/** Admins are the accounts whose registered numbers are listed in ADMIN_PHONES (comma-separated). */
export function isAdmin(user: SessionUser, env: NodeJS.ProcessEnv = process.env): boolean {
  const local = (p: string) => p.replace(/[\s-]/g, "").replace(/^(?:\+|00)?233/, "0");
  const admins = (env.ADMIN_PHONES ?? "").split(",").map((p) => local(p.trim())).filter((p) => /^0\d{9}$/.test(p));
  return !!user.phone && admins.includes(local(user.phone));
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: SessionUser }).user;
  if (!user || !isAdmin(user)) {
    next(Object.assign(new Error("Admins only"), { status: 403 }));
    return;
  }
  next();
}

export function requireUser(req: Request): SessionUser {
  const user = (req as Request & { user?: SessionUser }).user;
  if (!user) {
    throw Object.assign(new Error("Unauthenticated"), { status: 401 });
  }
  return user;
}
