import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { logAction } from "./admin.js";

/*
 * The partner (affiliate) programme. A player applies; an admin approves them and sets their rate. A partner's link
 * carries their code; a new player who signs up through it is theirs for good (one partner per player, only for
 * accounts opened in the last 7 days, never themselves). Commission:
 *
 *   deposit_pct% of every deposit their players make: confirmed mobile money payments only (an admin's manual credit
 *   is an ADJUSTMENT, not a DEPOSIT, and earns nothing). Withdrawals, bets and wins don't change it.
 *
 * Partners and admins also see all of their players' money: deposits, withdrawals paid out, bets and wins.
 * Commission isn't wallet money: a partner asks for a payout, and an admin pays it outside the platform (mobile money,
 * bank or crypto) and records the reference, or rejects it with a reason.
 */

export class PartnerError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "PartnerError";
  }
}

export const MIN_PAYOUT = 50;
export const NEW_ACCOUNT_DAYS = 7;
type Db = Pool | PoolClient;
const num = (v: unknown) => Number(v ?? 0);
const floor2 = (x: number) => Math.floor(x * 100 + 1e-6) / 100;
const round2 = (x: number) => Math.round(x * 100) / 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Affiliate {
  user_id: string;
  code: string;
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "REJECTED";
  deposit_pct: string;
  channel: string | null;
  note: string | null;
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
}

export const normCode = (code: unknown) => String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
export const normSub = (sub: unknown) => String(sub ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
/* a referred player as a partner sees them: "Pl•••93" */
const mask = (name: string | null) => {
  const s = String(name || "Player");
  return s.length <= 4 ? s[0] + "•••" : s.slice(0, 2) + "•••" + s.slice(-2);
};

export const MAX_DEPOSIT_PCT = 30;

export function terms(a: Pick<Affiliate, "deposit_pct">) {
  return { deposit_pct: num(a.deposit_pct), min_payout: MIN_PAYOUT };
}

/** What a partner earns on `deposits`: their percentage, down to the cent. */
export const commissionOn = (pct: number, deposits: number) => floor2((pct / 100) * deposits);

export function partnerView(a: Affiliate) {
  return { code: a.code, status: a.status, ...terms(a), channel: a.channel, created_at: a.created_at, decided_at: a.decided_at };
}

export async function partnerOf(db: Db, userId: string): Promise<Affiliate | null> {
  return (await db.query<Affiliate>(`SELECT * FROM affiliates WHERE user_id = $1`, [userId])).rows[0] ?? null;
}

/* "VB" + 6 characters that can't be misread (no 0/O, 1/I) */
async function newCode(db: Db): Promise<string> {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    const code = "VB" + Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join("");
    if (!(await db.query(`SELECT 1 FROM affiliates WHERE code = $1`, [code])).rowCount) return code;
  }
}

/** A player asks to become a partner. Asking again just returns where the application stands. */
export async function applyPartner(db: Pool, userId: string, input: { channel?: unknown }) {
  const existing = await partnerOf(db, userId);
  if (existing) return partnerView(existing);
  const channel = String(input.channel ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  if (channel.length < 10) {
    throw new PartnerError("channel_needed", "Tell us where you'll promote RendoWin (at least 10 characters) — your page, group or site.");
  }
  await db.query(`INSERT INTO affiliates (user_id, code, channel) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
    [userId, await newCode(db), channel]);
  return partnerView((await partnerOf(db, userId))!);
}

/* a partner's link works from the moment they apply (so nothing shared while they wait is lost); a suspended or
   rejected partner's link stops counting */
const LINK_LIVE = `status IN ('ACTIVE', 'PENDING')`;

/** A visit through a partner's link (counted per day and campaign tag). Unknown or switched-off codes are ignored. */
export async function recordClick(db: Pool, code: unknown, sub: unknown): Promise<boolean> {
  const c = normCode(code);
  if (c.length < 4) return false;
  const a = (await db.query<{ user_id: string }>(`SELECT user_id FROM affiliates WHERE code = $1 AND ${LINK_LIVE}`, [c])).rows[0];
  if (!a) return false;
  await db.query(
    `INSERT INTO referral_clicks (affiliate_id, day, sub_id, clicks) VALUES ($1, current_date, $2, 1)
     ON CONFLICT (affiliate_id, day, sub_id) DO UPDATE SET clicks = referral_clicks.clicks + 1`, [a.user_id, normSub(sub)]);
  return true;
}

/** Links a newly opened account to the partner whose link it came through. */
export async function attributeReferral(db: Pool, userId: string, input: { code?: unknown; sub_id?: unknown }, now = new Date()) {
  if ((await db.query(`SELECT 1 FROM referrals WHERE user_id = $1`, [userId])).rowCount) {
    return { attributed: false, reason: "already_referred" };
  }
  const a = (await db.query<Affiliate>(`SELECT * FROM affiliates WHERE code = $1 AND ${LINK_LIVE}`, [normCode(input.code)])).rows[0];
  if (!a) return { attributed: false, reason: "unknown_code" };
  if (a.user_id === userId) return { attributed: false, reason: "self" };
  const user = (await db.query<{ created_at: Date }>(`SELECT created_at FROM users WHERE id = $1`, [userId])).rows[0];
  if (!user || now.getTime() - new Date(user.created_at).getTime() > NEW_ACCOUNT_DAYS * 864e5) {
    return { attributed: false, reason: "not_new" };
  }
  await db.query(`INSERT INTO referrals (user_id, affiliate_id, sub_id) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
    [userId, a.user_id, normSub(input.sub_id) || null]);
  return { attributed: true };
}

/* each referred player's confirmed deposits, from the ledger */
const REFERRED_DEPOSITS = `
  SELECT r.user_id, r.sub_id, r.created_at, coalesce(sum(e.amount), 0) AS deposited,
         coalesce(sum(e.amount) FILTER (WHERE e.created_at >= now() - interval '30 days'), 0) AS deposited30,
         min(e.created_at) AS first_deposit_at
    FROM referrals r
    LEFT JOIN ledger_entries e ON e.user_id = r.user_id AND e.direction = 'CREDIT' AND e.currency_code = 'GHS'
         AND EXISTS (SELECT 1 FROM ledger_journal j WHERE j.id = e.journal_id AND j.entry_type = 'DEPOSIT')
   WHERE r.affiliate_id = $1
   GROUP BY r.user_id, r.sub_id, r.created_at`;

/** A partner's numbers: traffic, sign-ups, their players' money, and commission (earned, paid, waiting, available). */
export async function partnerStats(db: Pool, a: Affiliate) {
  const id = a.user_id;
  const q = async (sql: string) => (await db.query(sql, [id])).rows;
  const [clicks, signups, active, deps, play, withdrawn, payouts, series] = await Promise.all([
    q(`SELECT coalesce(sum(clicks), 0) AS total, coalesce(sum(clicks) FILTER (WHERE day >= current_date - 29), 0) AS last30
         FROM referral_clicks WHERE affiliate_id = $1`),
    q(`SELECT count(*) AS total, count(*) FILTER (WHERE created_at >= now() - interval '30 days') AS last30
         FROM referrals WHERE affiliate_id = $1`),
    q(`SELECT count(DISTINCT b.user_id) AS n FROM all_bets b JOIN referrals r ON r.user_id = b.user_id
        WHERE r.affiliate_id = $1 AND b.created_at >= now() - interval '30 days'`),
    q(REFERRED_DEPOSITS),
    q(`SELECT coalesce(sum(b.stake) FILTER (WHERE b.settled), 0) AS stakes, coalesce(sum(b.payout) FILTER (WHERE b.settled), 0) AS wins
         FROM all_bets b JOIN referrals r ON r.user_id = b.user_id WHERE r.affiliate_id = $1`),
    q(`SELECT coalesce(sum(w.amount), 0) AS paid_out
         FROM withdrawals w JOIN referrals r ON r.user_id = w.user_id WHERE r.affiliate_id = $1 AND w.status = 'PAID'`),
    q(`SELECT coalesce(sum(amount) FILTER (WHERE status = 'PAID'), 0) AS paid,
              coalesce(sum(amount) FILTER (WHERE status = 'REQUESTED'), 0) AS pending
         FROM affiliate_payouts WHERE affiliate_id = $1`),
    q(`WITH days AS (SELECT generate_series(current_date - 29, current_date, interval '1 day')::date AS d)
       SELECT days.d AS day,
              coalesce((SELECT sum(c.clicks) FROM referral_clicks c WHERE c.affiliate_id = $1 AND c.day = days.d), 0) AS clicks,
              (SELECT count(*) FROM referrals r WHERE r.affiliate_id = $1 AND r.created_at::date = days.d) AS signups
         FROM days ORDER BY days.d`),
  ]);
  const t = terms(a);
  const deposited = deps.map((d) => num(d.deposited));
  const deposits = round2(deposited.reduce((s, d) => s + d, 0));
  const earned = commissionOn(t.deposit_pct, deposits);
  const paid = round2(num(payouts[0]!.paid));
  const pending = round2(num(payouts[0]!.pending));
  return {
    terms: t,
    clicks: { total: num(clicks[0]!.total), last30: num(clicks[0]!.last30) },
    signups: { total: num(signups[0]!.total), last30: num(signups[0]!.last30) },
    activePlayers: num(active[0]!.n),
    depositors: deposited.filter((d) => d > 0).length,
    deposits,
    /* all of their players' money */
    money: {
      deposits,
      deposits30: round2(deps.reduce((s, d) => s + num(d.deposited30), 0)),
      withdrawals: round2(num(withdrawn[0]!.paid_out)),
      stakes: round2(num(play[0]!.stakes)),
      wins: round2(num(play[0]!.wins)),
    },
    commission: { pct: t.deposit_pct, earned, paid, pending, available: Math.max(0, floor2(earned - paid - pending)) },
    series: series.map((s) => ({ day: new Date(s.day).toISOString().slice(0, 10), clicks: num(s.clicks), signups: num(s.signups) })),
  };
}

/** A partner's players, as the partner may see them: masked names, what each has deposited (and earned the partner)
 *  and whether they still play. */
export async function partnerReferrals(db: Pool, a: Affiliate) {
  const pct = num(a.deposit_pct);
  const { rows } = await db.query(
    `SELECT d.*, u.username,
            EXISTS (SELECT 1 FROM all_bets b WHERE b.user_id = d.user_id AND b.created_at >= now() - interval '30 days') AS active
       FROM (${REFERRED_DEPOSITS}) d JOIN users u ON u.id = d.user_id
      ORDER BY d.created_at DESC LIMIT 200`, [a.user_id]);
  return {
    referrals: rows.map((r) => ({
      player: mask(r.username), joined: r.created_at, sub_id: r.sub_id, deposited: num(r.deposited) > 0,
      deposits: round2(num(r.deposited)), first_deposit_at: r.first_deposit_at,
      commission: commissionOn(pct, round2(num(r.deposited))), active: r.active,
    })),
  };
}

/** The latest sign-ups and confirmed deposits by a partner's players, newest first (names masked). */
export async function partnerActivity(db: Pool, a: Affiliate) {
  const { rows } = await db.query(
    `SELECT * FROM (
       SELECT 'signup' AS kind, r.created_at AS at, u.username, NULL::numeric AS amount, r.sub_id
         FROM referrals r JOIN users u ON u.id = r.user_id WHERE r.affiliate_id = $1
       UNION ALL
       SELECT 'deposit', e.created_at, u.username, e.amount, r.sub_id
         FROM referrals r
         JOIN users u ON u.id = r.user_id
         JOIN ledger_entries e ON e.user_id = r.user_id AND e.direction = 'CREDIT' AND e.currency_code = 'GHS'
         JOIN ledger_journal j ON j.id = e.journal_id AND j.entry_type = 'DEPOSIT'
        WHERE r.affiliate_id = $1
     ) x ORDER BY at DESC LIMIT 30`, [a.user_id]);
  const pct = num(a.deposit_pct);
  return {
    activity: rows.map((r) => ({
      kind: r.kind, at: r.at, player: mask(r.username), sub_id: r.sub_id, amount: r.amount === null ? null : round2(num(r.amount)),
      commission: r.amount === null ? null : commissionOn(pct, round2(num(r.amount))),
    })),
  };
}

export async function partnerPayouts(db: Db, affiliateId: string) {
  const { rows } = await db.query(
    `SELECT id, amount, method, details, status, note, created_at, decided_at FROM affiliate_payouts
      WHERE affiliate_id = $1 ORDER BY created_at DESC LIMIT 100`, [affiliateId]);
  return { payouts: rows.map((p) => ({ ...p, amount: round2(num(p.amount)) })) };
}

/* how each payout method is paid: the details an admin needs to send the money */
function payoutDetails(method: string, raw: unknown): Record<string, string> {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (k: string, min: number, max: number, label: string) => {
    const v = String(d[k] ?? "").trim().replace(/\s+/g, " ");
    if (v.length < min || v.length > max) throw new PartnerError("invalid_details", `Enter the ${label}`);
    return v;
  };
  if (method === "MOMO") {
    let phone = String(d.phone ?? "").replace(/[\s-]/g, "").replace(/^(?:\+|00)?233/, "0");
    if (!/^0[25]\d{8}$/.test(phone)) throw new PartnerError("invalid_details", "Enter a Ghanaian mobile money number");
    return { phone, name: text("name", 2, 60, "name on the mobile money account") };
  }
  if (method === "BANK") {
    const account = String(d.account_number ?? "").replace(/\s/g, "");
    if (!/^\d{6,20}$/.test(account)) throw new PartnerError("invalid_details", "Enter the bank account number");
    return { bank: text("bank", 2, 60, "bank name"), account_number: account, account_name: text("account_name", 2, 60, "account name") };
  }
  const asset = String(d.asset ?? "");
  const network = String(d.network ?? "");
  const ok = (asset === "USDT" && ["TRC20", "ERC20", "BEP20"].includes(network)) || (asset === "BTC" && network === "BTC");
  if (!ok) throw new PartnerError("invalid_details", "Choose USDT (TRC20, ERC20 or BEP20) or BTC");
  const address = String(d.address ?? "").trim();
  if (!/^[A-Za-z0-9]{25,100}$/.test(address)) throw new PartnerError("invalid_details", "Enter the wallet address");
  return { asset, network, address };
}

/** A partner asks for their commission. One request at a time, up to what's available. */
export async function requestPayout(db: Pool, a: Affiliate, input: { amount?: unknown; method?: unknown; details?: unknown }) {
  if (a.status !== "ACTIVE") throw new PartnerError("not_active", "Your partner account isn't active", 403);
  const amount = floor2(Number(input.amount));
  if (!Number.isFinite(amount) || amount < MIN_PAYOUT) {
    throw new PartnerError("invalid_amount", `The minimum payout is GHS ${MIN_PAYOUT}`);
  }
  const method = String(input.method ?? "");
  if (!["MOMO", "BANK", "CRYPTO"].includes(method)) throw new PartnerError("invalid_method", "Choose how you'd like to be paid");
  const details = payoutDetails(method, input.details);
  const { commission } = await partnerStats(db, a);
  if (amount > commission.available) {
    throw new PartnerError("too_much", `You can ask for up to GHS ${commission.available.toFixed(2)}`, 409);
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO affiliate_payouts (affiliate_id, amount, method, details) VALUES ($1, $2, $3, $4) RETURNING id`,
      [a.user_id, amount, method, JSON.stringify(details)]);
    return { id: rows[0]!.id as string, amount, method, status: "REQUESTED" };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      throw new PartnerError("request_open", "You already have a payout request waiting — we'll deal with it soon.", 409);
    }
    throw e;
  }
}

/* ---------------- admin side ---------------- */

export async function listPartners(db: Pool, input: { status?: unknown }) {
  const status = ["PENDING", "ACTIVE", "SUSPENDED", "REJECTED"].includes(String(input.status)) ? String(input.status) : "";
  const { rows } = await db.query(
    `SELECT a.*, u.username, u.phone, (SELECT count(*) FROM referrals r WHERE r.affiliate_id = a.user_id) AS signups,
            (SELECT coalesce(sum(e.amount), 0) FROM referrals r
               JOIN ledger_entries e ON e.user_id = r.user_id AND e.direction = 'CREDIT' AND e.currency_code = 'GHS'
               JOIN ledger_journal j ON j.id = e.journal_id AND j.entry_type = 'DEPOSIT'
              WHERE r.affiliate_id = a.user_id) AS deposits,
            (SELECT coalesce(sum(amount) FILTER (WHERE status = 'PAID'), 0) FROM affiliate_payouts p WHERE p.affiliate_id = a.user_id) AS paid,
            (SELECT coalesce(sum(amount) FILTER (WHERE status = 'REQUESTED'), 0) FROM affiliate_payouts p WHERE p.affiliate_id = a.user_id) AS pending
       FROM affiliates a JOIN users u ON u.id = a.user_id
      WHERE ($1 = '' OR a.status = $1)
      ORDER BY (a.status = 'PENDING') DESC, a.created_at DESC LIMIT 200`, [status]);
  return {
    partners: rows.map((p) => {
      const deposits = round2(num(p.deposits));
      const earned = commissionOn(num(p.deposit_pct), deposits);
      const paid = round2(num(p.paid));
      const pending = round2(num(p.pending));
      return {
        user_id: p.user_id, username: p.username, phone: p.phone, ...partnerView(p as Affiliate), note: p.note,
        signups: num(p.signups), payoutWaiting: pending > 0, decided_by: p.decided_by,
        deposits, earned, paid, pending, available: Math.max(0, floor2(earned - paid - pending)),
      };
    }),
  };
}

export async function partnerDetail(db: Pool, userId: unknown) {
  const uid = String(userId ?? "");
  const a = UUID.test(uid) ? await partnerOf(db, uid) : null;
  if (!a) throw new PartnerError("not_found", "That partner wasn't found", 404);
  const user = (await db.query(`SELECT username, phone FROM users WHERE id = $1`, [uid])).rows[0];
  return {
    partner: { user_id: uid, username: user?.username, phone: user?.phone, ...partnerView(a), note: a.note, decided_by: a.decided_by },
    stats: await partnerStats(db, a),
    referrals: (await partnerReferrals(db, a)).referrals,
    payouts: (await partnerPayouts(db, uid)).payouts,
  };
}

/** Approves, suspends or rejects a partner, or changes their terms. Making a player a partner directly works too. */
export async function updatePartner(
  db: Pool, admin: string, userId: unknown,
  input: { status?: unknown; deposit_pct?: unknown; note?: unknown }
) {
  const uid = String(userId ?? "");
  if (!UUID.test(uid) || !(await db.query(`SELECT 1 FROM users WHERE id = $1`, [uid])).rowCount) {
    throw new PartnerError("not_found", "That player wasn't found", 404);
  }
  let a = await partnerOf(db, uid);
  if (!a) {
    await db.query(`INSERT INTO affiliates (user_id, code, channel) VALUES ($1, $2, 'Added by an admin') ON CONFLICT (user_id) DO NOTHING`,
      [uid, await newCode(db)]);
    a = (await partnerOf(db, uid))!;
    if (input.status === undefined) input = { ...input, status: "ACTIVE" };
  }
  const changes: Record<string, unknown> = {};
  const sets: string[] = [];
  const params: unknown[] = [uid];
  const set = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
    changes[col] = value;
  };
  if (input.status !== undefined) {
    const s = String(input.status);
    if (!["PENDING", "ACTIVE", "SUSPENDED", "REJECTED"].includes(s)) throw new PartnerError("invalid_status", "Choose a partner status");
    if (s !== a.status) {
      set("status", s);
      sets.push("decided_at = now()");
      set("decided_by", admin);
    }
  }
  if (input.deposit_pct !== undefined) {
    const raw = input.deposit_pct;
    const v = typeof raw === "number" || (typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw)) ? round2(Number(raw)) : NaN;
    if (!Number.isFinite(v) || v < 0 || v > MAX_DEPOSIT_PCT) {
      throw new PartnerError("invalid_terms", `The commission must be between 0% and ${MAX_DEPOSIT_PCT}% of deposits`);
    }
    set("deposit_pct", v);
  }
  if (input.note !== undefined) set("note", String(input.note).trim().slice(0, 300) || null);
  if (sets.length) {
    await db.query(`UPDATE affiliates SET ${sets.join(", ")} WHERE user_id = $1`, params);
    await logAction(db, admin, "partner.update", uid, changes);
  }
  return partnerView((await partnerOf(db, uid))!);
}

export async function listPartnerPayouts(db: Pool, input: { status?: unknown }) {
  const status = ["REQUESTED", "PAID", "REJECTED"].includes(String(input.status)) ? String(input.status) : "REQUESTED";
  const { rows } = await db.query(
    `SELECT p.*, a.code, u.username, u.phone FROM affiliate_payouts p
       JOIN affiliates a ON a.user_id = p.affiliate_id JOIN users u ON u.id = p.affiliate_id
      WHERE p.status = $1 ORDER BY p.created_at DESC LIMIT 200`, [status]);
  return { payouts: rows.map((p) => ({ ...p, amount: round2(num(p.amount)) })) };
}

/** An admin records that a commission payout was sent (with the payment reference) or rejects it (with a reason). */
export async function decidePartnerPayout(db: Pool, admin: string, payoutId: unknown, input: { action?: unknown; note?: unknown }) {
  const id = String(payoutId ?? "");
  if (!UUID.test(id)) throw new PartnerError("not_found", "That payout wasn't found", 404);
  const action = String(input.action ?? "");
  if (action !== "pay" && action !== "reject") throw new PartnerError("invalid_action", "Mark it paid or reject it");
  const note = String(input.note ?? "").trim().slice(0, 200);
  if (note.length < 3) {
    throw new PartnerError("note_needed", action === "pay" ? "Enter the payment reference" : "Say why it's being rejected");
  }
  const { rows } = await db.query(
    `UPDATE affiliate_payouts SET status = $2, note = $3, decided_by = $4, decided_at = now()
      WHERE id = $1 AND status = 'REQUESTED' RETURNING *`, [id, action === "pay" ? "PAID" : "REJECTED", note, admin]);
  if (!rows[0]) throw new PartnerError("already_decided", "That payout was already dealt with", 409);
  await logAction(db, admin, "partner.payout", rows[0].affiliate_id, { payout: id, action, amount: round2(num(rows[0].amount)), note });
  return { ...rows[0], amount: round2(num(rows[0].amount)) };
}
