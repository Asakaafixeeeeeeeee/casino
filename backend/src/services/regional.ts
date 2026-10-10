import crypto from "node:crypto";
import type { Pool } from "pg";
import { hashPassword, verifyPassword } from "../crypto.js";
import { logAction, rangeStart } from "./admin.js";
import { depositReference, networkForPhone } from "./teller.js";

/*
 * Regional admins: staff accounts that see one region's data and nothing else (Ghana is the only region for now).
 *
 * Signing in: a username and a 6-digit PIN. The PIN is generated here and shown once to the full admin who made or
 * reset the account; only a salted PBKDF2-SHA256 hash is kept (src/crypto.ts). Six digits are only a million codes,
 * so guessing is cut off hard: every 5th wrong PIN in a row locks the account for 15 minutes, and from the 10th each
 * wrong PIN locks it for 24 hours (a full admin can unlock it at once); the login route also limits attempts per
 * network address. A sign-in is a random token, stored only as its SHA-256, that lasts 12 hours; a PIN reset or a
 * switch-off ends every sign-in at once.
 *
 * Data: every query filters on the player's registered country (users.country_code). Nothing here returns site-wide
 * totals, other regions' players, or settings.
 */

export class RegionalError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "RegionalError";
  }
}

export const REGIONS: Record<string, { name: string; currency: string }> = { GH: { name: "Ghana", currency: "GHS" } };
export const SESSION_HOURS = 12;
export const SOFT_LOCK = { every: 5, minutes: 15 };
export const HARD_LOCK = { from: 10, hours: 24 };

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const num = (v: unknown) => Number(v ?? 0);
const round2 = (x: number) => Math.round(x * 100) / 100;
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{3,23}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PINs nobody should have: one digit six times, a straight run either way, or a short pattern repeated. */
export function isWeakPin(pin: string): boolean {
  if (!/^\d{6}$/.test(pin)) return true;
  const d = [...pin].map(Number);
  const up = d.every((v, i) => i === 0 || v === (d[i - 1]! + 1) % 10);
  const down = d.every((v, i) => i === 0 || v === (d[i - 1]! + 9) % 10);
  return up || down || /^(\d)\1{5}$/.test(pin) || /^(\d\d)\1\1$/.test(pin) || /^(\d{3})\1$/.test(pin) || /^(\d)\1(\d)\2(\d)\3$/.test(pin);
}

/** A random 6-digit PIN that isn't one of the weak ones. */
export function newPin(): string {
  for (;;) {
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    if (!isWeakPin(pin)) return pin;
  }
}

/** 10% of an amount, rounded toward zero to the cent (a day the players won shows as a negative share). */
export const tenPercent = (x: number) => (Math.sign(x) * Math.floor(Math.abs(x) * 10 + 1e-6)) / 100 || 0;

interface AdminRow {
  id: string; username: string; name: string | null; region: string; pin_hash: string; status: "ACTIVE" | "DISABLED";
  failed_attempts: number; locked_until: Date | null; last_login_at: Date | null; pin_set_at: Date; created_by: string;
  created_at: Date;
}

export interface RegionalAdminView {
  id: string;
  username: string;
  name: string | null;
  region: string;
  region_name: string;
  status: "ACTIVE" | "DISABLED";
  /** Set while wrong PINs have the account locked. */
  locked_until: string | null;
  failed_attempts: number;
  last_login_at: string | null;
  pin_set_at: string;
  created_by: string;
  created_at: string;
}

function view(a: AdminRow, now = Date.now()): RegionalAdminView {
  const locked = a.locked_until && new Date(a.locked_until).getTime() > now ? new Date(a.locked_until).toISOString() : null;
  return {
    id: a.id, username: a.username, name: a.name, region: a.region, region_name: REGIONS[a.region]?.name ?? a.region,
    status: a.status, locked_until: locked, failed_attempts: a.failed_attempts,
    last_login_at: a.last_login_at ? new Date(a.last_login_at).toISOString() : null,
    pin_set_at: new Date(a.pin_set_at).toISOString(), created_by: a.created_by, created_at: new Date(a.created_at).toISOString(),
  };
}

async function adminById(db: Pool, id: unknown): Promise<AdminRow> {
  const sid = String(id ?? "");
  const a = UUID.test(sid) ? (await db.query<AdminRow>(`SELECT * FROM regional_admins WHERE id = $1`, [sid])).rows[0] : undefined;
  if (!a) throw new RegionalError("not_found", "That regional admin wasn't found", 404);
  return a;
}

/* ---------------- full admins manage the accounts ---------------- */

export async function listRegionalAdmins(db: Pool): Promise<{ admins: RegionalAdminView[] }> {
  const { rows } = await db.query<AdminRow>(`SELECT * FROM regional_admins ORDER BY created_at DESC`);
  return { admins: rows.map((a) => view(a)) };
}

/** Makes a regional admin and returns their PIN — the only time it's ever shown. */
export async function createRegionalAdmin(
  db: Pool, admin: string, input: { username?: unknown; name?: unknown; region?: unknown }
): Promise<{ admin: RegionalAdminView; pin: string }> {
  const username = String(input.username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new RegionalError("invalid_username", "Use 4–24 letters, numbers, dots, dashes or underscores, starting with a letter or number.");
  }
  const name = String(input.name ?? "").trim().replace(/\s+/g, " ").slice(0, 60) || null;
  const region = String(input.region ?? "GH").toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(REGIONS, region)) throw new RegionalError("invalid_region", "Ghana is the only region for now.");
  const pin = newPin();
  try {
    const { rows } = await db.query<AdminRow>(
      `INSERT INTO regional_admins (username, name, region, pin_hash, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [username, name, region, await hashPassword(pin), admin]);
    await logAction(db, admin, "regional.create", rows[0]!.id, { username, region });
    return { admin: view(rows[0]!), pin };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new RegionalError("username_taken", "That username is already used.", 409);
    throw e;
  }
}

/** A new PIN (shown once); the old one stops working and every sign-in ends. Also unlocks the account. */
export async function resetRegionalPin(db: Pool, admin: string, id: unknown): Promise<{ admin: RegionalAdminView; pin: string }> {
  const a = await adminById(db, id);
  const pin = newPin();
  const { rows } = await db.query<AdminRow>(
    `UPDATE regional_admins SET pin_hash = $2, pin_set_at = now(), failed_attempts = 0, locked_until = NULL WHERE id = $1 RETURNING *`,
    [a.id, await hashPassword(pin)]);
  await db.query(`DELETE FROM regional_admin_sessions WHERE admin_id = $1`, [a.id]);
  await logAction(db, admin, "regional.reset_pin", a.id, { username: a.username });
  return { admin: view(rows[0]!), pin };
}

/** Switches an account off (ending every sign-in) or back on; switching on also clears a lock from wrong PINs. */
export async function setRegionalStatus(db: Pool, admin: string, id: unknown, input: { status?: unknown }): Promise<RegionalAdminView> {
  const a = await adminById(db, id);
  const status = String(input.status ?? "");
  if (status !== "ACTIVE" && status !== "DISABLED") throw new RegionalError("invalid_status", "Switch it on (ACTIVE) or off (DISABLED)");
  const { rows } = await db.query<AdminRow>(
    `UPDATE regional_admins SET status = $2,
            failed_attempts = CASE WHEN $2 = 'ACTIVE' THEN 0 ELSE failed_attempts END,
            locked_until = CASE WHEN $2 = 'ACTIVE' THEN NULL ELSE locked_until END
      WHERE id = $1 RETURNING *`, [a.id, status]);
  if (status === "DISABLED") await db.query(`DELETE FROM regional_admin_sessions WHERE admin_id = $1`, [a.id]);
  await logAction(db, admin, "regional.status", a.id, { username: a.username, status });
  return view(rows[0]!);
}

/* ---------------- signing in ---------------- */

/* a username that doesn't exist still costs one PIN check, so the answer takes the same time either way */
let dummyHash: Promise<string> | null = null;

export interface RegionalSession { id: string; username: string; name: string | null; region: string }

export async function loginRegional(
  db: Pool, input: { username?: unknown; pin?: unknown }, meta: { ip?: string; now?: number } = {}
): Promise<{ token: string; expires_at: string; admin: RegionalAdminView }> {
  const now = meta.now ?? Date.now();
  const username = String(input.username ?? "").trim().toLowerCase();
  const pin = String(input.pin ?? "").trim();
  const wrong = () => new RegionalError("bad_login", "Wrong username or PIN.", 401);
  const a = USERNAME_RE.test(username)
    ? (await db.query<AdminRow>(`SELECT * FROM regional_admins WHERE lower(username) = $1`, [username])).rows[0]
    : undefined;
  if (!a) {
    dummyHash ??= hashPassword(newPin());
    await verifyPassword(/^\d{6}$/.test(pin) ? pin : "000000", await dummyHash);
    throw wrong();
  }
  const lockedFor = a.locked_until ? new Date(a.locked_until).getTime() - now : 0;
  if (lockedFor > 0) {
    const minutes = Math.ceil(lockedFor / 60_000);
    throw new RegionalError("locked",
      `Too many wrong PINs. Try again in ${minutes >= 120 ? Math.ceil(minutes / 60) + " hours" : minutes + " minutes"}, or ask an admin to unlock the account.`, 429);
  }
  const ok = /^\d{6}$/.test(pin) && (await verifyPassword(pin, a.pin_hash));
  if (!ok) {
    const fails = a.failed_attempts + 1;
    const lockMs = fails >= HARD_LOCK.from ? HARD_LOCK.hours * 3600e3 : fails % SOFT_LOCK.every === 0 ? SOFT_LOCK.minutes * 60e3 : 0;
    await db.query(`UPDATE regional_admins SET failed_attempts = $2, locked_until = $3 WHERE id = $1`,
      [a.id, fails, lockMs ? new Date(now + lockMs) : a.locked_until]);
    if (lockMs) await logAction(db, "regional:" + a.username, "regional.locked", a.id, { failed_attempts: fails, ip: meta.ip ?? null });
    throw wrong();
  }
  /* a switched-off account is only told so after the right PIN, so guessing reveals nothing about it */
  if (a.status !== "ACTIVE") throw new RegionalError("disabled", "This account is switched off. Ask an admin.", 403);

  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(now + SESSION_HOURS * 3600e3);
  await db.query(`UPDATE regional_admins SET failed_attempts = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1`, [a.id, new Date(now)]);
  await db.query(`INSERT INTO regional_admin_sessions (token_hash, admin_id, expires_at, ip) VALUES ($1, $2, $3, $4)`,
    [sha256(token), a.id, expires, meta.ip ?? null]);
  await db.query(`DELETE FROM regional_admin_sessions WHERE expires_at < $1`, [new Date(now)]);
  await logAction(db, "regional:" + a.username, "regional.login", a.id, { ip: meta.ip ?? null });
  return { token, expires_at: expires.toISOString(), admin: view({ ...a, failed_attempts: 0, locked_until: null, last_login_at: new Date(now) }, now) };
}

/** The regional admin a token belongs to, while the sign-in is current and the account switched on; else null. */
export async function regionalFromToken(db: Pool, token: string, now = Date.now()): Promise<RegionalSession | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const { rows } = await db.query<RegionalSession>(
    `SELECT a.id, a.username, a.name, a.region FROM regional_admin_sessions s JOIN regional_admins a ON a.id = s.admin_id
      WHERE s.token_hash = $1 AND s.expires_at > $2 AND a.status = 'ACTIVE'`, [sha256(token), new Date(now)]);
  return rows[0] ?? null;
}

export async function logoutRegional(db: Pool, token: string): Promise<{ ok: true }> {
  await db.query(`DELETE FROM regional_admin_sessions WHERE token_hash = $1`, [sha256(token)]);
  return { ok: true };
}

/* ---------------- the region's money ---------------- */

/* deposits that reached TheTeller and withdrawals, by players registered in region $1, with one status each */
const PAYMENTS = `
  SELECT 'deposit' AS kind, p.id::text AS id, p.transaction_id, p.amount, p.status AS raw_status,
         CASE p.status WHEN 'CONFIRMED' THEN 'successful' WHEN 'PENDING' THEN 'pending' ELSE 'failed' END AS status,
         p.created_at, p.payer_phone AS pay_phone, (p.checkout_url IS NOT NULL) AS hosted, p.gateway_note AS note,
         u.id AS user_id, u.username, u.full_name, u.phone
    FROM payment_intents p JOIN users u ON u.id = p.user_id
   WHERE u.country_code = $1 AND p.transaction_id IS NOT NULL
  UNION ALL
  SELECT 'withdrawal', w.id::text, w.transaction_id, w.amount, w.status,
         CASE w.status WHEN 'PAID' THEN 'successful' WHEN 'DECLINED' THEN 'failed' ELSE 'pending' END,
         w.created_at, w.phone, false, w.gateway_note,
         u.id, u.username, u.full_name, u.phone
    FROM withdrawals w JOIN users u ON u.id = w.user_id
   WHERE u.country_code = $1`;

const NETWORK_NAME: Record<string, string> = { MTN: "MTN MoMo", VDF: "Telecel Cash", ATL: "AirtelTigo Money", TGO: "AirtelTigo Money" };

function methodOf(kind: string, payPhone: string | null, hosted: boolean): string {
  const net = payPhone ? networkForPhone(payPhone) : null;
  const network = net ? NETWORK_NAME[net] : null;
  if (kind === "withdrawal") return "Payout to " + (network ?? "mobile money");
  if (network) return "Mobile money · " + network;
  return hosted ? "TheTeller payment page" : "Mobile money";
}

export interface RegionalPayment {
  kind: "deposit" | "withdrawal";
  /** What both TheTeller and the site show: DES + the 12-digit number for a deposit; a payout's TheTeller number. */
  transaction_id: string;
  amount: number;
  status: "successful" | "pending" | "failed";
  /** The record's own status (CONFIRMED, PENDING, FAILED, REVERSED; REQUESTED, PAYING, PAID, DECLINED). */
  raw_status: string;
  at: string;
  method: string;
  note: string | null;
  /** full_name: given at sign-up (players from before it was asked for have none) */
  user: { id: string; username: string | null; full_name: string | null; phone: string | null };
}

const STATUSES = ["successful", "pending", "failed"] as const;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const KINDS = ["deposit", "withdrawal"] as const;

/** The region's revenue (bets − wins, the casino's take) all-time and today, 10% of today's, and the payment counts. */
export async function regionalSummary(db: Pool, region: string, now = new Date()) {
  const r = REGIONS[region];
  if (!r) throw new RegionalError("invalid_region", "Unknown region", 400);
  const today = rangeStart("today", now);
  const [rev, counts] = await Promise.all([
    db.query(
      `SELECT coalesce(sum(b.stake) FILTER (WHERE b.settled), 0) - coalesce(sum(b.payout) FILTER (WHERE b.settled), 0) AS all_time,
              coalesce(sum(b.stake) FILTER (WHERE b.settled AND b.created_at >= $2), 0)
                - coalesce(sum(b.payout) FILTER (WHERE b.settled AND b.created_at >= $2), 0) AS today,
              count(*) FILTER (WHERE b.created_at >= $2) AS bets_today
         FROM all_bets b JOIN users u ON u.id = b.user_id WHERE u.country_code = $1`, [region, today]),
    db.query(`SELECT status, count(*) AS n FROM (${PAYMENTS}) t GROUP BY status`, [region]),
  ]);
  const allTime = round2(num(rev.rows[0]!.all_time));
  const todayRevenue = round2(num(rev.rows[0]!.today));
  const c = Object.fromEntries(counts.rows.map((x) => [x.status, num(x.n)]));
  return {
    region, region_name: r.name, currency: r.currency, as_of: now.toISOString(), day_starts: today.toISOString(),
    revenue: { all_time: allTime, today: todayRevenue, today_10pct: tenPercent(todayRevenue), bets_today: num(rev.rows[0]!.bets_today) },
    payments: { successful: c.successful ?? 0, pending: c.pending ?? 0, failed: c.failed ?? 0 },
  };
}

/** The region's deposits and withdrawals, newest first, 50 at a time; `before` (the last row's time) pages back. */
export async function regionalTransactions(
  db: Pool, region: string, input: { status?: unknown; kind?: unknown; before?: unknown }, limit = 50
): Promise<{ transactions: RegionalPayment[]; counts: Record<"all" | (typeof STATUSES)[number], number>; next: string | null }> {
  if (!REGIONS[region]) throw new RegionalError("invalid_region", "Unknown region", 400);
  const status = (STATUSES as readonly string[]).includes(String(input.status)) ? String(input.status) : "all";
  const kind = (KINDS as readonly string[]).includes(String(input.kind)) ? String(input.kind) : "all";
  /* the page marker is the database's own timestamp text (to the microsecond), so no row at a page edge is skipped */
  const before = typeof input.before === "string" && TIMESTAMP_RE.test(input.before) ? input.before : null;
  const [list, counts] = await Promise.all([
    db.query(
      `SELECT t.*, t.created_at::text AS cursor FROM (${PAYMENTS}) t
        WHERE ($2 = 'all' OR t.status = $2) AND ($3 = 'all' OR t.kind = $3) AND ($4::timestamptz IS NULL OR t.created_at < $4::timestamptz)
        ORDER BY t.created_at DESC, t.id DESC LIMIT $5`, [region, status, kind, before, limit]),
    db.query(`SELECT status, count(*) AS n FROM (${PAYMENTS}) t WHERE ($2 = 'all' OR t.kind = $2) GROUP BY status`, [region, kind]),
  ]);
  const c = Object.fromEntries(counts.rows.map((x) => [x.status, num(x.n)]));
  const rows = list.rows;
  return {
    transactions: rows.map((t) => ({
      kind: t.kind,
      transaction_id: t.kind === "deposit" ? depositReference(t.transaction_id) : t.transaction_id || "W-" + String(t.id).slice(0, 8).toUpperCase(),
      amount: round2(num(t.amount)),
      status: t.status,
      raw_status: t.raw_status,
      at: new Date(t.created_at).toISOString(),
      method: methodOf(t.kind, t.pay_phone, t.hosted),
      note: t.status === "successful" ? null : t.note,
      user: { id: t.user_id, username: t.username, full_name: t.full_name, phone: t.phone },
    })),
    counts: {
      all: (c.successful ?? 0) + (c.pending ?? 0) + (c.failed ?? 0),
      successful: c.successful ?? 0, pending: c.pending ?? 0, failed: c.failed ?? 0,
    },
    next: rows.length === limit ? String(rows[rows.length - 1]!.cursor) : null,
  };
}
