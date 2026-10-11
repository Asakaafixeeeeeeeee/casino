import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { logAction } from "./admin.js";

/*
 * The partner (affiliate) programme. A player applies; an admin approves them (or adds them directly) and sets their
 * revenue share. A partner's link carries their code (?ref=CODE) and they may also choose a promo code; a new player
 * who signs up through either is theirs for good (one partner per player, only for accounts opened in the last
 * `referral_days`, never themselves, and a link and a promo code of two different partners is refused).
 *
 * Commission is revenue share, decided per settled bet of a referred player (migration 026):
 *   losing bet  (stake > payout):  + revshare% of (stake - payout)      the partner's rate when the bet settled
 *   winning bet (payout > stake):  - deduction% of (payout - stake)     the deduction in force when the bet settled
 * each truncated to the cent and recorded once (partner_commissions, UNIQUE source + bet). Open, cancelled and void
 * bets never count. Commission is pending until its settlement period (daily, weekly or monthly) closes; settling
 * credits the period's net to the partner's commission wallet, and a negative period is carried forward or written
 * off as the admin chooses. Payout requests hold money in that wallet; an admin approves, pays (recording the
 * payment reference) or rejects (releasing the hold). Commission is never player wallet money.
 */

export class PartnerError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "PartnerError";
  }
}

type Db = Pool | PoolClient;
const num = (v: unknown) => Number(v ?? 0);
const round2 = (x: number) => Math.round(x * 100) / 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["PENDING", "ACTIVE", "SUSPENDED", "REJECTED", "DISABLED"] as const;
/** statuses whose players' bets earn commission (a suspended partner is paused, not cut off) */
const EARNING = `('ACTIVE', 'SUSPENDED')`;

export interface Affiliate {
  user_id: string;
  code: string;
  promo_code: string | null;
  promo_request: string | null;
  status: (typeof STATUSES)[number];
  link_enabled: boolean;
  payout_details: Record<string, unknown> | null;
  channel: string | null;
  note: string | null;
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  accrue_from: Date | null;
}

export interface Settings {
  default_revshare_pct: number;
  win_deduction_pct: number;
  carry_negative: boolean;
  settlement_period: "DAILY" | "WEEKLY" | "MONTHLY";
  min_payout: number;
  max_payout: number;
  referral_days: number;
  links_enabled: boolean;
  promo_codes_enabled: boolean;
  partner_promo_edit: boolean;
  updated_by: string | null;
  updated_at: Date;
}

export const normCode = (code: unknown) => String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
export const normSub = (sub: unknown) => String(sub ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
/* a referred player as a partner sees them: "Pl•••93" */
const mask = (name: string | null) => {
  const s = String(name || "Player");
  return s.length <= 4 ? s[0] + "•••" : s.slice(0, 2) + "•••" + s.slice(-2);
};
/* a referred player's id as a partner sees it: short, stable, and not the internal key */
const publicId = (uuid: string) => "P-" + uuid.replace(/-/g, "").slice(0, 8).toUpperCase();

/* ---------------------------------------------------------------- settings */

export async function getSettings(db: Db): Promise<Settings> {
  const s = (await db.query(`SELECT s.*, (SELECT pct FROM partner_deduction_rates WHERE effective_from <= now()
                                          ORDER BY effective_from DESC, id DESC LIMIT 1) AS ded_now
                               FROM partner_settings s`)).rows[0];
  return {
    default_revshare_pct: num(s.default_revshare_pct),
    win_deduction_pct: num(s.ded_now ?? s.win_deduction_pct),
    carry_negative: s.carry_negative,
    settlement_period: s.settlement_period,
    min_payout: round2(num(s.min_payout)),
    max_payout: round2(num(s.max_payout)),
    referral_days: num(s.referral_days),
    links_enabled: s.links_enabled,
    promo_codes_enabled: s.promo_codes_enabled,
    partner_promo_edit: s.partner_promo_edit,
    updated_by: s.updated_by,
    updated_at: s.updated_at,
  };
}

/* "40", 40, "12.5" -> a number within [min, max] (two decimals), or a PartnerError */
function pctOf(raw: unknown, min: number, max: number, label: string): number {
  const v = typeof raw === "number" || (typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw)) ? round2(Number(raw)) : NaN;
  if (!Number.isFinite(v) || v < min || v > max) throw new PartnerError("invalid_terms", `${label} must be between ${min}% and ${max}%`);
  return v;
}
function amountOf(raw: unknown, label: string): number {
  const v = typeof raw === "number" || (typeof raw === "string" && /^\s*\d+(\.\d+)?\s*$/.test(raw)) ? round2(Number(raw)) : NaN;
  if (!Number.isFinite(v) || v <= 0 || v > 10_000_000) throw new PartnerError("invalid_amount", `Enter a valid ${label}`);
  return v;
}
/* when a rate change takes effect: now, or a later moment. Never the past — that would re-rate settled bets. */
function effectiveFrom(raw: unknown, now: Date): Date {
  if (raw === undefined || raw === null || raw === "") return now;
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) throw new PartnerError("invalid_date", "Enter a valid effective date");
  if (d.getTime() < now.getTime() - 60_000) {
    throw new PartnerError("past_date", "A change can start now or later, never in the past (that would change commission already earned)");
  }
  return d.getTime() < now.getTime() ? now : d;
}

/** An admin changes the programme's settings. A new win deduction applies to bets settled from its effective date. */
export async function saveSettings(db: Pool, admin: string, input: Record<string, unknown>, now = new Date()) {
  const sets: string[] = [];
  const params: unknown[] = [];
  const changes: Record<string, unknown> = {};
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
    changes[col] = v;
  };
  const bool = (k: string) => {
    if (input[k] !== undefined) set(k, input[k] === true || input[k] === "true");
  };
  if (input.default_revshare_pct !== undefined) set("default_revshare_pct", pctOf(input.default_revshare_pct, 0, 90, "The default revenue share"));
  if (input.settlement_period !== undefined) {
    const p = String(input.settlement_period);
    if (!["DAILY", "WEEKLY", "MONTHLY"].includes(p)) throw new PartnerError("invalid_period", "Choose daily, weekly or monthly settlement");
    set("settlement_period", p);
  }
  if (input.min_payout !== undefined) set("min_payout", amountOf(input.min_payout, "minimum payout"));
  if (input.max_payout !== undefined) set("max_payout", amountOf(input.max_payout, "maximum payout"));
  if (input.referral_days !== undefined) {
    const d = Number(input.referral_days);
    if (!Number.isInteger(d) || d < 0 || d > 365) throw new PartnerError("invalid_days", "Enter 0 to 365 days");
    set("referral_days", d);
  }
  ["carry_negative", "links_enabled", "promo_codes_enabled", "partner_promo_edit"].forEach(bool);
  const current = await getSettings(db);
  const min = (changes.min_payout as number | undefined) ?? current.min_payout;
  const max = (changes.max_payout as number | undefined) ?? current.max_payout;
  if (max < min) throw new PartnerError("invalid_amount", "The maximum payout can't be below the minimum");

  let deduction: { pct: number; effective_from: Date } | null = null;
  if (input.win_deduction_pct !== undefined) {
    deduction = { pct: pctOf(input.win_deduction_pct, 0, 100, "The win deduction"), effective_from: effectiveFrom(input.effective_from, now) };
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (sets.length) {
      params.push(admin);
      await client.query(`UPDATE partner_settings SET ${sets.join(", ")}, updated_by = $${params.length}, updated_at = now()`, params);
    }
    if (deduction) {
      await client.query(`INSERT INTO partner_deduction_rates (pct, effective_from, set_by) VALUES ($1, $2, $3)`,
        [deduction.pct, deduction.effective_from, admin]);
      await client.query(`UPDATE partner_settings SET win_deduction_pct = $1, updated_by = $2, updated_at = now()`, [deduction.pct, admin]);
      changes.win_deduction_pct = deduction.pct;
      changes.win_deduction_from = deduction.effective_from.toISOString();
    }
    if (Object.keys(changes).length) await logAction(client, admin, "partner.settings", "partner-settings", changes);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { settings: await getSettings(db), deductionHistory: await deductionHistory(db) };
}

export async function deductionHistory(db: Db) {
  const { rows } = await db.query(`SELECT pct, effective_from, set_by, created_at FROM partner_deduction_rates
                                    ORDER BY effective_from DESC, id DESC LIMIT 50`);
  return rows.map((r) => ({ ...r, pct: num(r.pct), effective_from: isFinite(new Date(r.effective_from).getTime()) ? r.effective_from : null }));
}

/* ---------------------------------------------------------------- partners */

export async function partnerOf(db: Db, userId: string): Promise<Affiliate | null> {
  return (await db.query<Affiliate>(`SELECT * FROM affiliates WHERE user_id = $1`, [userId])).rows[0] ?? null;
}

/** The revenue share a partner is on now (and any change scheduled for later). */
export async function rateOf(db: Db, affiliateId: string, at = new Date()) {
  const { rows } = await db.query(
    `SELECT revshare_pct, effective_from, set_by, created_at FROM affiliate_rates WHERE affiliate_id = $1
      ORDER BY effective_from DESC, id DESC`, [affiliateId]);
  const current = rows.find((r) => new Date(r.effective_from).getTime() <= at.getTime()) ?? rows[rows.length - 1];
  const scheduled = rows.filter((r) => new Date(r.effective_from).getTime() > at.getTime()).reverse()[0] ?? null;
  return {
    pct: current ? num(current.revshare_pct) : (await getSettings(db)).default_revshare_pct,
    scheduled: scheduled ? { pct: num(scheduled.revshare_pct), effective_from: scheduled.effective_from } : null,
    history: rows.map((r) => ({ pct: num(r.revshare_pct), effective_from: r.effective_from, set_by: r.set_by, created_at: r.created_at })),
  };
}

const linkLive = (a: Pick<Affiliate, "status" | "link_enabled">) => (a.status === "ACTIVE" || a.status === "PENDING") && a.link_enabled;

export function partnerView(a: Affiliate) {
  return {
    code: a.code, promo_code: a.promo_code, promo_request: a.promo_request, status: a.status, link_enabled: a.link_enabled,
    link_live: linkLive(a), channel: a.channel, created_at: a.created_at, decided_at: a.decided_at,
  };
}

/* "WB" + 6 characters that can't be misread (no 0/O, 1/I), unused as a link code or a promo code */
async function newCode(db: Db): Promise<string> {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    const code = "WB" + Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join("");
    if (!(await db.query(`SELECT 1 FROM affiliates WHERE code = $1 OR promo_code = $1`, [code])).rowCount) return code;
  }
}

async function addRate(db: Db, affiliateId: string, pct: number, from: Date | string, by: string) {
  await db.query(`INSERT INTO affiliate_rates (affiliate_id, revshare_pct, effective_from, set_by) VALUES ($1, $2, $3, $4)`,
    [affiliateId, pct, from, by]);
}

/** A player asks to become a partner. Asking again just returns where the application stands. */
export async function applyPartner(db: Pool, userId: string, input: { channel?: unknown }) {
  const existing = await partnerOf(db, userId);
  if (existing) return partnerView(existing);
  const channel = String(input.channel ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  if (channel.length < 10) {
    throw new PartnerError("channel_needed", "Tell us where you'll promote us (at least 10 characters) — your page, group or site.");
  }
  await db.query(`INSERT INTO affiliates (user_id, code, channel) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
    [userId, await newCode(db), channel]);
  return partnerView((await partnerOf(db, userId))!);
}

/** Who owns a link code or a promo code (and whether it may bring in players right now). */
async function ownerOf(db: Db, column: "code" | "promo_code", raw: unknown) {
  const c = normCode(raw);
  if (c.length < 4) return null;
  return (await db.query<Affiliate>(`SELECT * FROM affiliates WHERE ${column} = $1`, [c])).rows[0] ?? null;
}

/**
 * Which partner a sign-up with this link code and / or promo code belongs to. Both may be given; when they belong to
 * two different partners nothing is assigned and the player is told. A switched-off link or code is "not valid".
 */
export async function resolveReferral(db: Db, input: { code?: unknown; promo?: unknown }) {
  const s = await getSettings(db);
  const code = normCode(input.code);
  const promo = normCode(input.promo);
  let byLink: Affiliate | null = null;
  let byPromo: Affiliate | null = null;
  if (code) {
    byLink = s.links_enabled ? await ownerOf(db, "code", code) : null;
    if (byLink && !linkLive(byLink)) byLink = null;
  }
  if (promo) {
    if (!s.promo_codes_enabled) throw new PartnerError("promo_off", "Promo codes can't be used at the moment.");
    byPromo = (await ownerOf(db, "promo_code", promo)) ?? (await ownerOf(db, "code", promo));
    if (!byPromo || !(byPromo.status === "ACTIVE" || byPromo.status === "PENDING")) {
      throw new PartnerError("unknown_promo", "That promo code isn't valid. Check it, or leave it empty.", 404);
    }
  }
  if (byLink && byPromo && byLink.user_id !== byPromo.user_id) {
    throw new PartnerError("referral_conflict",
      "That promo code belongs to a different partner from the link you came through. Use the promo code from the same partner, or leave it empty.", 409);
  }
  const a = byPromo ?? byLink;
  const via = byLink && byPromo ? "link+promo" : byPromo ? "promo" : "link";
  return a ? { affiliate: a, via } : null;
}

/** A visit through a partner's link (counted per day and campaign tag). Unknown or switched-off codes are ignored. */
export async function recordClick(db: Pool, code: unknown, sub: unknown): Promise<boolean> {
  const s = await getSettings(db);
  const a = s.links_enabled ? await ownerOf(db, "code", code) : null;
  if (!a || !linkLive(a)) return false;
  await db.query(
    `INSERT INTO referral_clicks (affiliate_id, day, sub_id, clicks) VALUES ($1, current_date, $2, 1)
     ON CONFLICT (affiliate_id, day, sub_id) DO UPDATE SET clicks = referral_clicks.clicks + 1`, [a.user_id, normSub(sub)]);
  return true;
}

/** Checks a link code and promo code before sign-up, so a mismatch is shown before the account is opened. */
export async function checkReferral(db: Pool, input: { code?: unknown; promo?: unknown }) {
  const r = await resolveReferral(db, input);
  return { ok: true, partner: r ? { code: r.affiliate.code, promo_code: r.affiliate.promo_code } : null };
}

/** Links a newly opened account to the partner whose link or promo code it came through. */
export async function attributeReferral(
  db: Pool, userId: string, input: { code?: unknown; promo?: unknown; sub_id?: unknown }, now = new Date(),
) {
  if ((await db.query(`SELECT 1 FROM referrals WHERE user_id = $1`, [userId])).rowCount) {
    return { attributed: false, reason: "already_referred" };
  }
  const found = await resolveReferral(db, input);
  if (!found) return { attributed: false, reason: "unknown_code" };
  const a = found.affiliate;
  if (a.user_id === userId) return { attributed: false, reason: "self" };
  const { referral_days } = await getSettings(db);
  const user = (await db.query<{ created_at: Date }>(`SELECT created_at FROM users WHERE id = $1`, [userId])).rows[0];
  if (!user || now.getTime() - new Date(user.created_at).getTime() > referral_days * 864e5) {
    return { attributed: false, reason: "not_new" };
  }
  const { rowCount } = await db.query(
    `INSERT INTO referrals (user_id, affiliate_id, sub_id, via) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO NOTHING`,
    [userId, a.user_id, normSub(input.sub_id) || null, found.via]);
  return rowCount ? { attributed: true, via: found.via } : { attributed: false, reason: "already_referred" };
}

/* ---------------------------------------------------------------- commission: accrual and settlement */

/**
 * Records commission for every settled bet of a referred player that hasn't earned any yet (one partner, or all).
 * Safe to run any number of times at once: the UNIQUE (source, bet_id) keeps each bet to one commission.
 */
export async function accrueCommissions(db: Db, affiliateId?: string): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO partner_commissions (affiliate_id, player_id, source, bet_id, game, stake, payout, ngr, pct, amount, settled_at)
     SELECT x.affiliate_id, x.user_id, x.source, x.bet_id, x.game, x.stake, x.payout, x.stake - x.payout, x.pct,
            CASE WHEN x.stake > x.payout THEN trunc((x.stake - x.payout) * x.pct / 100, 2)
                 WHEN x.payout > x.stake THEN -trunc((x.payout - x.stake) * x.pct / 100, 2)
                 ELSE 0 END,
            x.settled_at
       FROM (
         SELECT r.affiliate_id, b.*,
                CASE WHEN b.payout > b.stake THEN
                  coalesce((SELECT d.pct FROM partner_deduction_rates d WHERE d.effective_from <= b.settled_at
                             ORDER BY d.effective_from DESC, d.id DESC LIMIT 1),
                           (SELECT win_deduction_pct FROM partner_settings))
                ELSE
                  coalesce((SELECT ar.revshare_pct FROM affiliate_rates ar WHERE ar.affiliate_id = r.affiliate_id
                              AND ar.effective_from <= b.settled_at ORDER BY ar.effective_from DESC, ar.id DESC LIMIT 1),
                           (SELECT ar.revshare_pct FROM affiliate_rates ar WHERE ar.affiliate_id = r.affiliate_id
                             ORDER BY ar.effective_from ASC, ar.id ASC LIMIT 1),
                           (SELECT default_revshare_pct FROM partner_settings))
                END AS pct
           FROM referrals r
           JOIN affiliates a ON a.user_id = r.affiliate_id AND a.status IN ${EARNING}
           JOIN settled_bets b ON b.user_id = r.user_id AND b.settled_at >= r.created_at
                              AND (a.accrue_from IS NULL OR b.settled_at >= a.accrue_from)
          WHERE ($1::uuid IS NULL OR r.affiliate_id = $1::uuid)
            AND NOT EXISTS (SELECT 1 FROM partner_commissions c WHERE c.source = b.source AND c.bet_id = b.bet_id)
       ) x
     ON CONFLICT (source, bet_id) DO NOTHING`, [affiliateId ?? null]);
  return rowCount ?? 0;
}

const DAY = 864e5;
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** The settlement period that most recently closed before `now`: [start, end). Days are UTC (Ghana time). */
export function lastClosedPeriod(period: Settings["settlement_period"], now: Date) {
  const today = utcDay(now);
  if (period === "DAILY") return { start: new Date(today.getTime() - DAY), end: today };
  if (period === "WEEKLY") {
    const end = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY); /* this Monday */
    return { start: new Date(end.getTime() - 7 * DAY), end };
  }
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start: new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1)), end };
}

/* a bet that settles moments before the boundary is given a few minutes to be recorded before the period closes */
const SETTLE_GRACE_MS = 5 * 60_000;

/**
 * Closes the last settlement period for every partner with pending commission from before it: the period's net (plus
 * any negative balance carried in) is credited to the wallet when positive; a negative result is carried forward or
 * written off by the carry-over setting. Each partner's period is settled once (UNIQUE affiliate + period start).
 */
export async function settleCommissions(db: Pool, now = new Date()) {
  const s = await getSettings(db);
  const { start, end } = lastClosedPeriod(s.settlement_period, now);
  if (now.getTime() < end.getTime() + SETTLE_GRACE_MS) return { settled: 0 };
  await accrueCommissions(db);
  const due = (await db.query<{ affiliate_id: string }>(
    `SELECT DISTINCT affiliate_id FROM partner_commissions WHERE settlement_id IS NULL AND settled_at < $1`, [end])).rows;
  let settled = 0;
  for (const { affiliate_id } of due) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT 1 FROM affiliates WHERE user_id = $1 FOR UPDATE`, [affiliate_id]);
      if ((await client.query(`SELECT 1 FROM partner_settlements WHERE affiliate_id = $1 AND period_start = $2`,
        [affiliate_id, ymd(start)])).rowCount) {
        await client.query("ROLLBACK");
        continue;
      }
      const sums = (await client.query(
        `SELECT coalesce(sum(amount) FILTER (WHERE amount > 0), 0) AS pos, coalesce(sum(amount) FILTER (WHERE amount < 0), 0) AS neg,
                count(*) AS n
           FROM partner_commissions WHERE affiliate_id = $1 AND settlement_id IS NULL AND settled_at < $2`, [affiliate_id, end])).rows[0];
      if (!num(sums.n)) {
        await client.query("ROLLBACK");
        continue;
      }
      const last = (await client.query(
        `SELECT carried_out FROM partner_settlements WHERE affiliate_id = $1 ORDER BY period_start DESC LIMIT 1`, [affiliate_id])).rows[0];
      const carriedIn = s.carry_negative ? Math.min(0, num(last?.carried_out)) : 0;
      const net = round2(num(sums.pos) + num(sums.neg) + carriedIn);
      const credited = Math.max(0, net);
      const carriedOut = s.carry_negative ? Math.min(0, net) : 0;
      const { rows: [st] } = await client.query(
        `INSERT INTO partner_settlements (affiliate_id, period, period_start, period_end, positive, negative, carried_in, credited, carried_out)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [affiliate_id, s.settlement_period, ymd(start), ymd(end), num(sums.pos), num(sums.neg), carriedIn, credited, carriedOut]);
      await client.query(`UPDATE partner_commissions SET settlement_id = $3 WHERE affiliate_id = $1 AND settlement_id IS NULL AND settled_at < $2`,
        [affiliate_id, end, st.id]);
      if (credited > 0) {
        await client.query(
          `INSERT INTO partner_wallet_entries (affiliate_id, kind, amount, settlement_id, note, created_by)
           VALUES ($1, 'SETTLEMENT', $2, $3, $4, 'system')`,
          [affiliate_id, credited, st.id, `Commission ${ymd(start)} to ${ymd(new Date(end.getTime() - DAY))}`]);
      }
      await client.query("COMMIT");
      settled++;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return { settled };
}

/** Records new commission every minute and closes settlement periods as they end. */
export function startPartnerSweep(db: Pool, everyMs = 60_000) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await accrueCommissions(db);
      await settleCommissions(db);
    } catch (e) {
      console.error("[partners] sweep failed:", (e as Error).message);
    } finally {
      busy = false;
    }
  };
  setTimeout(tick, 15_000).unref?.();
  return setInterval(tick, everyMs).unref?.();
}

/* ---------------------------------------------------------------- date ranges */

export interface Range { key: string; from: Date | null; to: Date | null; label: string }

/** today, yesterday, 7d, 30d, this_month, last_month, all, or custom (from / to as YYYY-MM-DD, inclusive). UTC days. */
export function parseRange(input: { range?: unknown; from?: unknown; to?: unknown }, now = new Date()): Range {
  const key = String(input.range ?? "30d");
  const today = utcDay(now);
  const tomorrow = new Date(today.getTime() + DAY);
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  switch (key) {
    case "today": return { key, from: today, to: tomorrow, label: "Today" };
    case "yesterday": return { key, from: new Date(today.getTime() - DAY), to: today, label: "Yesterday" };
    case "7d": return { key, from: new Date(today.getTime() - 6 * DAY), to: tomorrow, label: "Last 7 days" };
    case "this_month": return { key, from: month, to: tomorrow, label: "This month" };
    case "last_month": return { key, from: new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)), to: month, label: "Last month" };
    case "all": return { key, from: null, to: null, label: "All time" };
    case "custom": {
      const d = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? new Date(String(v) + "T00:00:00Z") : null);
      const from = d(input.from);
      const to = d(input.to);
      if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) {
        throw new PartnerError("invalid_range", "Choose a start and end date (the end on or after the start)");
      }
      if (to.getTime() - from.getTime() > 3 * 366 * DAY) throw new PartnerError("invalid_range", "Choose at most three years");
      return { key, from, to: new Date(to.getTime() + DAY), label: `${ymd(from)} to ${ymd(to)}` };
    }
    default: return { key: "30d", from: new Date(today.getTime() - 29 * DAY), to: tomorrow, label: "Last 30 days" };
  }
}
const rangeView = (r: Range) => ({ key: r.key, label: r.label, from: r.from ? ymd(r.from) : null, to: r.to ? ymd(new Date(r.to.getTime() - DAY)) : null });

/* ---------------------------------------------------------------- what a partner (or an admin) sees */

/** The commission wallet: available balance and everything that makes it up. */
export async function walletOf(db: Db, affiliateId: string) {
  const [w, p, c, carry] = await Promise.all([
    db.query(`SELECT coalesce(sum(amount), 0) AS available,
                     coalesce(sum(amount) FILTER (WHERE kind IN ('OPENING', 'SETTLEMENT')), 0) AS credited,
                     coalesce(sum(amount) FILTER (WHERE kind = 'CORRECTION'), 0) AS corrections,
                     coalesce(sum(amount) FILTER (WHERE kind = 'OPENING'), 0) AS opening
                FROM partner_wallet_entries WHERE affiliate_id = $1`, [affiliateId]),
    db.query(`SELECT coalesce(sum(amount) FILTER (WHERE status = 'PAID'), 0) AS withdrawn,
                     coalesce(sum(amount) FILTER (WHERE status IN ('REQUESTED', 'APPROVED')), 0) AS pending_withdrawals
                FROM affiliate_payouts WHERE affiliate_id = $1`, [affiliateId]),
    db.query(`SELECT coalesce(sum(amount), 0) AS lifetime,
                     coalesce(sum(amount) FILTER (WHERE amount > 0), 0) AS earned,
                     coalesce(sum(amount) FILTER (WHERE amount < 0), 0) AS negative,
                     coalesce(sum(amount) FILTER (WHERE settlement_id IS NULL), 0) AS pending
                FROM partner_commissions WHERE affiliate_id = $1`, [affiliateId]),
    db.query(`SELECT carried_out FROM partner_settlements WHERE affiliate_id = $1 ORDER BY period_start DESC LIMIT 1`, [affiliateId]),
  ]);
  const s = await getSettings(db);
  return {
    available: round2(num(w.rows[0].available)),
    /* commission from bets (positive, plus any deposit commission brought over from before revenue share),
       deductions from wins (negative), and the bets' net, lifetime */
    totalEarned: round2(num(c.rows[0].earned) + num(w.rows[0].opening)),
    opening: round2(num(w.rows[0].opening)),
    negativeAdjustments: round2(num(c.rows[0].negative)),
    lifetimeNet: round2(num(c.rows[0].lifetime)),
    /* commission recorded but whose period hasn't closed yet */
    pending: round2(num(c.rows[0].pending)),
    carriedNegative: s.carry_negative ? round2(Math.min(0, num(carry.rows[0]?.carried_out))) : 0,
    credited: round2(num(w.rows[0].credited)),
    corrections: round2(num(w.rows[0].corrections)),
    withdrawn: round2(num(p.rows[0].withdrawn)),
    pendingWithdrawals: round2(num(p.rows[0].pending_withdrawals)),
    minPayout: s.min_payout,
    maxPayout: s.max_payout,
    settlementPeriod: s.settlement_period,
  };
}

const sumIn = (from: Date | null, to: Date | null) =>
  `coalesce(sum(amount) FILTER (WHERE ${from ? `settled_at >= '${from.toISOString()}'` : "true"} AND ${to ? `settled_at < '${to.toISOString()}'` : "true"}), 0)`;

/** The dashboard: referrals, active players, revenue share by period, and the wallet. */
export async function partnerSummary(db: Pool, a: Affiliate, now = new Date()) {
  await accrueCommissions(db, a.user_id);
  const today = utcDay(now);
  const week = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY);
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const yesterday = new Date(today.getTime() - DAY);
  const [refs, active, shares, clicks] = await Promise.all([
    db.query(`SELECT count(*) AS total, count(*) FILTER (WHERE created_at >= $2) AS last30 FROM referrals WHERE affiliate_id = $1`,
      [a.user_id, new Date(today.getTime() - 29 * DAY)]),
    db.query(`SELECT count(DISTINCT player_id) AS n FROM partner_commissions WHERE affiliate_id = $1 AND settled_at >= $2`,
      [a.user_id, new Date(today.getTime() - 29 * DAY)]),
    db.query(`SELECT ${sumIn(today, null)} AS today, ${sumIn(yesterday, today)} AS yesterday, ${sumIn(week, null)} AS week,
                     ${sumIn(month, null)} AS month, ${sumIn(null, null)} AS lifetime
                FROM partner_commissions WHERE affiliate_id = $1`, [a.user_id]),
    db.query(`SELECT coalesce(sum(clicks), 0) AS total FROM referral_clicks WHERE affiliate_id = $1`, [a.user_id]),
  ]);
  const sh = shares.rows[0];
  return {
    partner: partnerView(a),
    rate: await rateOf(db, a.user_id, now),
    totalReferrals: num(refs.rows[0].total),
    referrals30: num(refs.rows[0].last30),
    activePlayers: num(active.rows[0].n),
    clicks: num(clicks.rows[0].total),
    revenueShare: {
      today: round2(num(sh.today)), yesterday: round2(num(sh.yesterday)), week: round2(num(sh.week)),
      month: round2(num(sh.month)), lifetime: round2(num(sh.lifetime)),
    },
    wallet: await walletOf(db, a.user_id),
  };
}

/** The partner's referred players with their play in the range. Never names, numbers or payment details. */
export async function partnerReferrals(
  db: Pool, a: Affiliate, input: { range?: unknown; from?: unknown; to?: unknown } = {}, now = new Date(), forAdmin = false,
) {
  await accrueCommissions(db, a.user_id);
  const r = parseRange(input, now);
  const { rows } = await db.query(
    `SELECT rf.user_id, rf.created_at, rf.via, rf.sub_id, u.username, u.full_name, u.phone,
            coalesce(sum(c.stake), 0) AS stakes, coalesce(sum(c.payout), 0) AS payouts, coalesce(sum(c.ngr), 0) AS ngr,
            coalesce(sum(c.amount), 0) AS commission,
            (SELECT max(settled_at) FROM partner_commissions c2 WHERE c2.player_id = rf.user_id AND c2.affiliate_id = rf.affiliate_id) AS last_activity
       FROM referrals rf
       JOIN users u ON u.id = rf.user_id
       LEFT JOIN partner_commissions c ON c.player_id = rf.user_id AND c.affiliate_id = rf.affiliate_id
            AND ($2::timestamptz IS NULL OR c.settled_at >= $2) AND ($3::timestamptz IS NULL OR c.settled_at < $3)
      WHERE rf.affiliate_id = $1
      GROUP BY rf.user_id, rf.created_at, rf.via, rf.sub_id, u.username, u.full_name, u.phone, rf.affiliate_id
      ORDER BY rf.created_at DESC LIMIT 1000`, [a.user_id, r.from, r.to]);
  const referrals = rows.map((x) => ({
    id: publicId(x.user_id), player: mask(x.username), joined: x.created_at, via: x.via, sub_id: x.sub_id,
    stakes: round2(num(x.stakes)), payouts: round2(num(x.payouts)), ngr: round2(num(x.ngr)), commission: round2(num(x.commission)),
    last_activity: x.last_activity,
    /* only the admin sees who the player is */
    ...(forAdmin ? { user_id: x.user_id, username: x.username, full_name: x.full_name, phone: x.phone } : {}),
  }));
  const total = (k: "stakes" | "payouts" | "ngr" | "commission") => round2(referrals.reduce((s, x) => s + x[k], 0));
  return {
    range: rangeView(r), referrals,
    totals: { players: referrals.length, stakes: total("stakes"), payouts: total("payouts"), ngr: total("ngr"), commission: total("commission") },
  };
}

/** Statistics by day (or by month for ranges over ~four months) and the chart series, from recorded commission. */
export async function partnerStatistics(db: Pool, a: Affiliate, input: { range?: unknown; from?: unknown; to?: unknown } = {}, now = new Date()) {
  await accrueCommissions(db, a.user_id);
  const r = parseRange(input, now);
  /* "all time" starts at the partner's first referral (or their approval) */
  const first = (await db.query(`SELECT least((SELECT min(created_at) FROM referrals WHERE affiliate_id = $1), $2::timestamptz) AS d`,
    [a.user_id, a.created_at])).rows[0].d as Date;
  const from = r.from ?? utcDay(new Date(first));
  const to = r.to ?? new Date(utcDay(now).getTime() + DAY);
  const unit = to.getTime() - from.getTime() > 124 * DAY ? "month" : "day";
  const { rows } = await db.query(
    `WITH b AS (SELECT generate_series(date_trunc('${unit}', $2::timestamptz AT TIME ZONE 'UTC'),
                                       ($3::timestamptz AT TIME ZONE 'UTC') - interval '1 second', interval '1 ${unit}') AS t)
     SELECT to_char(b.t, 'YYYY-MM-DD') AS bucket,
            coalesce(c.stakes, 0) AS stakes, coalesce(c.payouts, 0) AS payouts, coalesce(c.ngr, 0) AS ngr,
            coalesce(c.positive, 0) AS positive, coalesce(c.negative, 0) AS negative, coalesce(c.net, 0) AS net,
            coalesce(c.players, 0) AS players,
            (SELECT count(*) FROM referrals rf WHERE rf.affiliate_id = $1 AND date_trunc('${unit}', rf.created_at AT TIME ZONE 'UTC') = b.t) AS signups,
            (SELECT count(*) FROM referrals rf WHERE rf.affiliate_id = $1 AND rf.created_at AT TIME ZONE 'UTC' < b.t + interval '1 ${unit}') AS total_referrals
       FROM b
       LEFT JOIN (
         SELECT date_trunc('${unit}', settled_at AT TIME ZONE 'UTC') AS t, sum(stake) AS stakes, sum(payout) AS payouts, sum(ngr) AS ngr,
                sum(amount) FILTER (WHERE amount > 0) AS positive, sum(amount) FILTER (WHERE amount < 0) AS negative, sum(amount) AS net,
                count(DISTINCT player_id) AS players
           FROM partner_commissions WHERE affiliate_id = $1 AND settled_at >= $2 AND settled_at < $3
          GROUP BY 1) c ON c.t = b.t
      ORDER BY b.t`, [a.user_id, from, to]);
  const series = rows.map((x) => ({
    date: String(x.bucket).slice(0, unit === "month" ? 7 : 10),
    stakes: round2(num(x.stakes)), payouts: round2(num(x.payouts)), ngr: round2(num(x.ngr)),
    commission: round2(num(x.positive)), negative: round2(num(x.negative)), earnings: round2(num(x.net)),
    activePlayers: num(x.players), signups: num(x.signups), totalReferrals: num(x.total_referrals),
  }));
  const total = (k: "stakes" | "payouts" | "ngr" | "commission" | "negative" | "earnings" | "signups") =>
    round2(series.reduce((s, x) => s + x[k], 0));
  const players = (await db.query(
    `SELECT count(DISTINCT player_id) AS n FROM partner_commissions WHERE affiliate_id = $1 AND settled_at >= $2 AND settled_at < $3`,
    [a.user_id, from, to])).rows[0].n;
  return {
    range: rangeView(r), unit, series,
    totals: {
      stakes: total("stakes"), payouts: total("payouts"), ngr: total("ngr"), commission: total("commission"),
      negative: total("negative"), earnings: total("earnings"), signups: total("signups"), activePlayers: num(players),
    },
  };
}

export async function partnerPayouts(db: Db, affiliateId: string) {
  const { rows } = await db.query(
    `SELECT id, amount, method, details, status, note, reference, created_at, approved_at, decided_at FROM affiliate_payouts
      WHERE affiliate_id = $1 ORDER BY created_at DESC LIMIT 100`, [affiliateId]);
  return { payouts: rows.map((p) => ({ ...p, amount: round2(num(p.amount)) })) };
}

/** The wallet page: balances, payouts and the wallet's history. */
export async function partnerWallet(db: Pool, a: Affiliate) {
  await accrueCommissions(db, a.user_id);
  const [wallet, payouts, entries, settlements] = await Promise.all([
    walletOf(db, a.user_id),
    partnerPayouts(db, a.user_id),
    db.query(`SELECT kind, amount, note, created_at FROM partner_wallet_entries WHERE affiliate_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`,
      [a.user_id]),
    db.query(`SELECT period, period_start, period_end, positive, negative, carried_in, credited, carried_out, created_at
                FROM partner_settlements WHERE affiliate_id = $1 ORDER BY period_start DESC LIMIT 100`, [a.user_id]),
  ]);
  return {
    wallet, payouts: payouts.payouts, payoutDetails: a.payout_details,
    entries: entries.rows.map((e) => ({ ...e, amount: round2(num(e.amount)) })),
    settlements: settlements.rows.map((s) => ({
      ...s, positive: round2(num(s.positive)), negative: round2(num(s.negative)), carried_in: round2(num(s.carried_in)),
      credited: round2(num(s.credited)), carried_out: round2(num(s.carried_out)),
    })),
  };
}

/** The settings page: account details (from the player's account), the partner's terms, link and promo code. */
export async function partnerSettings(db: Pool, a: Affiliate) {
  const u = (await db.query(`SELECT username, full_name, phone, contact_email FROM users WHERE id = $1`, [a.user_id])).rows[0] ?? {};
  const s = await getSettings(db);
  return {
    account: {
      full_name: u.full_name ?? null, username: u.username ?? null, phone: u.phone ?? null, email: u.contact_email ?? null,
      partner_id: a.code, registered: a.created_at, status: a.status,
    },
    partner: partnerView(a),
    rate: await rateOf(db, a.user_id),
    winDeductionPct: s.win_deduction_pct,
    settlementPeriod: s.settlement_period,
    promoEditable: s.partner_promo_edit && s.promo_codes_enabled,
    promoCodesEnabled: s.promo_codes_enabled,
    payoutDetails: a.payout_details,
  };
}

/* a promo code: 4–16 letters and numbers, unused by any other partner as a promo code or link code */
async function claimPromo(db: Db, affiliateId: string, raw: unknown): Promise<string> {
  const code = normCode(raw);
  if (!/^[A-Z0-9]{4,16}$/.test(code) || String(raw ?? "").replace(/[\s]/g, "").length > 16) {
    throw new PartnerError("invalid_promo", "Use 4 to 16 letters and numbers, no spaces or symbols");
  }
  if (/^(ADMIN|SUPPORT|RENDOWIN|WINB|WINBCASINO|TEST|DEMO|FREE|BONUS)$/.test(code)) {
    throw new PartnerError("promo_taken", "That promo code isn't available — choose another");
  }
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('partner-codes'))`);
  const taken = await db.query(`SELECT 1 FROM affiliates WHERE user_id <> $1 AND (promo_code = $2 OR code = $2)`, [affiliateId, code]);
  if (taken.rowCount) throw new PartnerError("promo_taken", "That promo code is already used by another partner — choose another", 409);
  return code;
}

/** A partner sets their own promo code (when the admin allows it); otherwise their choice is saved as a request. */
export async function setOwnPromo(db: Pool, a: Affiliate, input: { promo_code?: unknown }) {
  if (a.status !== "ACTIVE") throw new PartnerError("not_active", "Your partner account isn't active", 403);
  const s = await getSettings(db);
  if (!s.promo_codes_enabled) throw new PartnerError("promo_off", "Promo codes are switched off at the moment");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const code = await claimPromo(client, a.user_id, input.promo_code);
    if (s.partner_promo_edit) {
      await client.query(`UPDATE affiliates SET promo_code = $2, promo_request = NULL WHERE user_id = $1`, [a.user_id, code]);
    } else {
      await client.query(`UPDATE affiliates SET promo_request = $2 WHERE user_id = $1`, [a.user_id, code]);
    }
    await client.query("COMMIT");
    return { promo_code: s.partner_promo_edit ? code : a.promo_code, promo_request: s.partner_promo_edit ? null : code, requested: !s.partner_promo_edit };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
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
    const phone = String(d.phone ?? "").replace(/[\s-]/g, "").replace(/^(?:\+|00)?233/, "0");
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
const METHODS = ["MOMO", "BANK", "CRYPTO"];

/** A partner saves the details they want commission paid to. */
export async function savePayoutDetails(db: Pool, a: Affiliate, input: { method?: unknown; details?: unknown }) {
  const method = String(input.method ?? "");
  if (!METHODS.includes(method)) throw new PartnerError("invalid_method", "Choose how you'd like to be paid");
  const saved = { method, ...payoutDetails(method, input.details) };
  await db.query(`UPDATE affiliates SET payout_details = $2 WHERE user_id = $1`, [a.user_id, JSON.stringify(saved)]);
  return { payoutDetails: saved };
}

/**
 * A partner asks for commission. Up to the available balance and within the admin's minimum and maximum; one request
 * open at a time. The amount is held in the wallet straight away, so it can't be asked for twice.
 */
export async function requestPayout(db: Pool, a: Affiliate, input: { amount?: unknown; method?: unknown; details?: unknown }) {
  const s = await getSettings(db);
  const amount = Math.floor(Number(input.amount) * 100 + 1e-6) / 100;
  if (!Number.isFinite(amount) || amount < s.min_payout) throw new PartnerError("invalid_amount", `The minimum payout is GHS ${s.min_payout.toFixed(2)}`);
  if (amount > s.max_payout) throw new PartnerError("invalid_amount", `The maximum payout is GHS ${s.max_payout.toFixed(2)}`);
  const method = String(input.method ?? "");
  if (!METHODS.includes(method)) throw new PartnerError("invalid_method", "Choose how you'd like to be paid");
  const details = payoutDetails(method, input.details);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const fresh = (await client.query<Affiliate>(`SELECT * FROM affiliates WHERE user_id = $1 FOR UPDATE`, [a.user_id])).rows[0];
    if (!fresh || fresh.status !== "ACTIVE") throw new PartnerError("not_active", "Your partner account isn't active", 403);
    if ((await client.query(`SELECT 1 FROM affiliate_payouts WHERE affiliate_id = $1 AND status IN ('REQUESTED', 'APPROVED')`, [a.user_id])).rowCount) {
      throw new PartnerError("request_open", "You already have a payout request waiting — we'll deal with it soon.", 409);
    }
    const available = round2(num((await client.query(`SELECT coalesce(sum(amount), 0) AS b FROM partner_wallet_entries WHERE affiliate_id = $1`,
      [a.user_id])).rows[0].b));
    if (amount > available) throw new PartnerError("too_much", `You can ask for up to GHS ${Math.max(0, available).toFixed(2)}`, 409);
    const { rows: [p] } = await client.query(
      `INSERT INTO affiliate_payouts (affiliate_id, amount, method, details) VALUES ($1, $2, $3, $4) RETURNING id`,
      [a.user_id, amount, method, JSON.stringify(details)]);
    await client.query(
      `INSERT INTO partner_wallet_entries (affiliate_id, kind, amount, payout_id, note, created_by) VALUES ($1, 'PAYOUT_HOLD', $2, $3, 'Payout requested', 'partner')`,
      [a.user_id, -amount, p.id]);
    await client.query("COMMIT");
    return { id: p.id as string, amount, method, status: "REQUESTED" };
  } catch (e) {
    await client.query("ROLLBACK");
    if ((e as { code?: string }).code === "23505") {
      throw new PartnerError("request_open", "You already have a payout request waiting — we'll deal with it soon.", 409);
    }
    throw e;
  } finally {
    client.release();
  }
}

/* ---------------------------------------------------------------- admin side */

const LIST_SQL = `
  SELECT a.*, u.username, u.phone, u.full_name, u.contact_email,
         (SELECT count(*) FROM referrals r WHERE r.affiliate_id = a.user_id) AS referrals,
         (SELECT coalesce(sum(amount), 0) FROM partner_wallet_entries w WHERE w.affiliate_id = a.user_id) AS available,
         (SELECT coalesce(sum(amount), 0) FROM partner_commissions c WHERE c.affiliate_id = a.user_id) AS lifetime,
         (SELECT coalesce(sum(amount), 0) FROM partner_commissions c WHERE c.affiliate_id = a.user_id AND c.settlement_id IS NULL) AS pending,
         (SELECT coalesce(sum(amount), 0) FROM partner_wallet_entries w WHERE w.affiliate_id = a.user_id AND w.kind = 'OPENING') AS opening,
         (SELECT coalesce(sum(amount) FILTER (WHERE status = 'PAID'), 0) FROM affiliate_payouts p WHERE p.affiliate_id = a.user_id) AS withdrawn,
         (SELECT count(*) FROM affiliate_payouts p WHERE p.affiliate_id = a.user_id AND p.status IN ('REQUESTED', 'APPROVED')) AS open_payouts,
         (SELECT revshare_pct FROM affiliate_rates ar WHERE ar.affiliate_id = a.user_id AND ar.effective_from <= now()
           ORDER BY ar.effective_from DESC, ar.id DESC LIMIT 1) AS revshare_pct
    FROM affiliates a JOIN users u ON u.id = a.user_id`;

function adminRow(p: Record<string, any>) {
  return {
    user_id: p.user_id, username: p.username, full_name: p.full_name, phone: p.phone, email: p.contact_email,
    ...partnerView(p as Affiliate), partner_id: p.code, note: p.note, decided_by: p.decided_by,
    revshare_pct: p.revshare_pct === null ? null : num(p.revshare_pct),
    referrals: num(p.referrals),
    /* the deposit commission brought over (OPENING) counts as earnings too */
    totalEarnings: round2(num(p.lifetime) + num(p.opening)),
    available: round2(num(p.available)), pending: round2(num(p.pending)), withdrawn: round2(num(p.withdrawn)),
    payoutWaiting: num(p.open_payouts) > 0,
  };
}

export async function listPartners(db: Pool, input: { status?: unknown; q?: unknown }) {
  await accrueCommissions(db);
  const status = (STATUSES as readonly string[]).includes(String(input.status)) ? String(input.status) : "";
  const q = String(input.q ?? "").trim().toLowerCase().slice(0, 60);
  const { rows } = await db.query(
    `${LIST_SQL}
      WHERE ($1 = '' OR a.status = $1)
        AND ($2 = '' OR lower(u.username) LIKE '%' || $2 || '%' OR u.phone LIKE '%' || $2 || '%' OR lower(a.code) LIKE '%' || $2 || '%'
             OR lower(coalesce(a.promo_code, '')) LIKE '%' || $2 || '%' OR lower(coalesce(u.full_name, '')) LIKE '%' || $2 || '%'
             OR lower(coalesce(u.contact_email, '')) LIKE '%' || $2 || '%')
      ORDER BY (a.status = 'PENDING') DESC, a.created_at DESC LIMIT 300`, [status, q]);
  return { partners: rows.map(adminRow) };
}

/** Finds a registered player by phone number, username or email, for "Add partner". */
export async function lookupPlayer(db: Pool, input: { q?: unknown }) {
  const raw = String(input.q ?? "").trim().slice(0, 120);
  if (raw.length < 3) throw new PartnerError("query_short", "Enter a phone number, username or email");
  const phone = raw.replace(/[\s-]/g, "").replace(/^(?:\+|00)?233/, "0");
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.full_name, u.phone, u.contact_email, u.created_at, u.status::text AS status, a.status AS partner_status
       FROM users u LEFT JOIN affiliates a ON a.user_id = u.id
      WHERE u.phone = $1 OR u.phone = $2 OR lower(u.username) = lower($1) OR lower(u.contact_email) = lower($1)
      LIMIT 5`, [raw, phone]);
  if (!rows.length) throw new PartnerError("not_found", "No registered player found for that phone number, username or email", 404);
  return {
    players: rows.map((u) => ({
      user_id: u.id, username: u.username, full_name: u.full_name, phone: u.phone, email: u.contact_email,
      joined: u.created_at, status: u.status, partner_status: u.partner_status,
    })),
  };
}

/** Everything about one partner for the admin: account, terms, wallet, statistics, referrals, payouts and history. */
export async function partnerDetail(db: Pool, userId: unknown, now = new Date()) {
  const uid = String(userId ?? "");
  const a = UUID.test(uid) ? await partnerOf(db, uid) : null;
  if (!a) throw new PartnerError("not_found", "That partner wasn't found", 404);
  await accrueCommissions(db, uid);
  const row = (await db.query(`${LIST_SQL} WHERE a.user_id = $1`, [uid])).rows[0]!;
  const lifetime = (await db.query(
    `SELECT coalesce(sum(stake), 0) AS stakes, coalesce(sum(payout), 0) AS payouts, coalesce(sum(ngr), 0) AS ngr,
            coalesce(sum(amount) FILTER (WHERE amount > 0), 0) AS commission, coalesce(sum(amount) FILTER (WHERE amount < 0), 0) AS negative,
            coalesce(sum(amount), 0) AS net
       FROM partner_commissions WHERE affiliate_id = $1`, [uid])).rows[0];
  const [wallet, daily, monthly, referrals, audit] = await Promise.all([
    partnerWallet(db, a),
    partnerStatistics(db, a, { range: "30d" }, now),
    partnerStatistics(db, a, { range: "custom", from: ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1))), to: ymd(now) }, now),
    partnerReferrals(db, a, { range: "all" }, now, true),
    db.query(`SELECT admin, action, details, created_at FROM admin_actions WHERE target = $1 ORDER BY created_at DESC LIMIT 100`, [uid]),
  ]);
  return {
    partner: { ...adminRow(row), accrue_from: a.accrue_from, payout_details: a.payout_details, channel: a.channel },
    rate: await rateOf(db, uid, now),
    lifetime: {
      stakes: round2(num(lifetime.stakes)), payouts: round2(num(lifetime.payouts)), ngr: round2(num(lifetime.ngr)),
      commission: round2(num(lifetime.commission)), negative: round2(num(lifetime.negative)), net: round2(num(lifetime.net)),
    },
    wallet: wallet.wallet,
    payouts: (await db.query(`SELECT id, amount, method, details, status, note, reference, created_at, approved_at, approved_by, decided_at, decided_by
                                FROM affiliate_payouts WHERE affiliate_id = $1 ORDER BY created_at DESC LIMIT 100`, [uid])).rows
      .map((p) => ({ ...p, amount: round2(num(p.amount)) })),
    entries: wallet.entries, settlements: wallet.settlements,
    daily: daily.series, monthly: monthly.series,
    referrals: referrals.referrals,
    audit: audit.rows,
  };
}

/** The partner's own views, read-only, for an admin's "View partner dashboard" (no password needed). */
export async function partnerPreview(db: Pool, userId: unknown, view: string, input: Record<string, unknown>) {
  const uid = String(userId ?? "");
  const a = UUID.test(uid) ? await partnerOf(db, uid) : null;
  if (!a) throw new PartnerError("not_found", "That partner wasn't found", 404);
  if (view === "summary") return partnerSummary(db, a);
  if (view === "referrals") return partnerReferrals(db, a, input);
  if (view === "statistics") return partnerStatistics(db, a, input);
  if (view === "wallet") return partnerWallet(db, a);
  if (view === "settings") return partnerSettings(db, a);
  if (view === "me") return { partner: partnerView(a) };
  throw new PartnerError("not_found", "Unknown view", 404);
}

/**
 * An admin changes a partner: status (approve, reject, suspend, reactivate, disable), revenue share (from now or a
 * later date), promo code, link on/off, a new link code, a note. Making a player a partner directly works too.
 * Every change is written to the audit log.
 */
export async function updatePartner(
  db: Pool, admin: string, userId: unknown,
  input: {
    status?: unknown; revshare_pct?: unknown; effective_from?: unknown; note?: unknown; promo_code?: unknown;
    link_enabled?: unknown; regenerate_code?: unknown; approve_promo_request?: unknown;
  },
  now = new Date(),
) {
  const uid = String(userId ?? "");
  if (!UUID.test(uid) || !(await db.query(`SELECT 1 FROM users WHERE id = $1`, [uid])).rowCount) {
    throw new PartnerError("not_found", "That player wasn't found", 404);
  }
  const s = await getSettings(db);
  const client = await db.connect();
  const changes: Record<string, unknown> = {};
  try {
    await client.query("BEGIN");
    let a = (await client.query<Affiliate>(`SELECT * FROM affiliates WHERE user_id = $1 FOR UPDATE`, [uid])).rows[0];
    if (!a) {
      await client.query(`INSERT INTO affiliates (user_id, code, channel) VALUES ($1, $2, 'Added by an admin')`, [uid, await newCode(client)]);
      a = (await client.query<Affiliate>(`SELECT * FROM affiliates WHERE user_id = $1 FOR UPDATE`, [uid])).rows[0]!;
      changes.created = true;
      if (input.status === undefined) input = { ...input, status: "ACTIVE" };
    }
    const sets: string[] = [];
    const params: unknown[] = [uid];
    const set = (col: string, value: unknown, log = true) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
      if (log) changes[col] = value;
    };
    if (input.status !== undefined) {
      const st = String(input.status);
      if (!(STATUSES as readonly string[]).includes(st)) throw new PartnerError("invalid_status", "Choose a partner status");
      if (st !== a.status) {
        set("status", st);
        sets.push("decided_at = now()");
        set("decided_by", admin, false);
        /* coming back from DISABLED: bets made while disabled never earn */
        if (a.status === "DISABLED" && st === "ACTIVE") set("accrue_from", now);
      }
    }
    /* every partner starts on the default revenue share when first approved */
    const hasRate = (await client.query(`SELECT 1 FROM affiliate_rates WHERE affiliate_id = $1`, [uid])).rowCount;
    if (input.revshare_pct !== undefined) {
      const pct = pctOf(input.revshare_pct, 0, 90, "The revenue share");
      const from = hasRate ? effectiveFrom(input.effective_from, now) : now;
      await addRate(client, uid, pct, from, admin);
      changes.revshare_pct = pct;
      changes.effective_from = from.toISOString();
    } else if (!hasRate && (input.status === "ACTIVE" || a.status === "ACTIVE")) {
      await addRate(client, uid, s.default_revshare_pct, now, admin);
      changes.revshare_pct = s.default_revshare_pct;
    }
    if (input.promo_code !== undefined) {
      const raw = String(input.promo_code ?? "").trim();
      set("promo_code", raw ? await claimPromo(client, uid, raw) : null);
      sets.push("promo_request = NULL");
    } else if (input.approve_promo_request !== undefined && a.promo_request) {
      if (input.approve_promo_request === true || input.approve_promo_request === "true") {
        set("promo_code", await claimPromo(client, uid, a.promo_request));
      } else changes.promo_request_declined = a.promo_request;
      sets.push("promo_request = NULL");
    }
    if (input.link_enabled !== undefined) set("link_enabled", input.link_enabled === true || input.link_enabled === "true");
    if (input.regenerate_code === true || input.regenerate_code === "true") {
      const code = await newCode(client);
      set("code", code);
      changes.old_code = a.code;
    }
    if (input.note !== undefined) set("note", String(input.note).trim().slice(0, 300) || null);
    if (sets.length) await client.query(`UPDATE affiliates SET ${sets.join(", ")} WHERE user_id = $1`, params);
    if (Object.keys(changes).length) await logAction(client, admin, "partner.update", uid, changes);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    if ((e as { code?: string }).code === "23505") throw new PartnerError("promo_taken", "That code is already used by another partner", 409);
    throw e;
  } finally {
    client.release();
  }
  return partnerView((await partnerOf(db, uid))!);
}

/** An admin corrects a partner's commission wallet (a verified error), with the reason. Positive or negative. */
export async function correctCommission(db: Pool, admin: string, userId: unknown, input: { amount?: unknown; reason?: unknown }) {
  const uid = String(userId ?? "");
  const a = UUID.test(uid) ? await partnerOf(db, uid) : null;
  if (!a) throw new PartnerError("not_found", "That partner wasn't found", 404);
  const raw = String(input.amount ?? "").trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw) || Number(raw) === 0 || Math.abs(Number(raw)) > 1_000_000) {
    throw new PartnerError("invalid_amount", "Enter an amount like 25.00 or -25.00");
  }
  const reason = String(input.reason ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
  if (reason.length < 8) throw new PartnerError("reason_needed", "Explain the correction (at least 8 characters)");
  const amount = round2(Number(raw));
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT 1 FROM affiliates WHERE user_id = $1 FOR UPDATE`, [uid]);
    await client.query(
      `INSERT INTO partner_wallet_entries (affiliate_id, kind, amount, note, created_by) VALUES ($1, 'CORRECTION', $2, $3, $4)`,
      [uid, amount, reason, admin]);
    await logAction(client, admin, "partner.correction", uid, { amount, reason });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { wallet: await walletOf(db, uid) };
}

export async function listPartnerPayouts(db: Pool, input: { status?: unknown }) {
  const status = ["REQUESTED", "APPROVED", "PAID", "REJECTED", "OPEN"].includes(String(input.status)) ? String(input.status) : "OPEN";
  const { rows } = await db.query(
    `SELECT p.*, a.code, a.promo_code, u.username, u.phone, u.full_name,
            (SELECT coalesce(sum(amount), 0) FROM partner_wallet_entries w WHERE w.affiliate_id = p.affiliate_id) AS available
       FROM affiliate_payouts p
       JOIN affiliates a ON a.user_id = p.affiliate_id JOIN users u ON u.id = p.affiliate_id
      WHERE ($1 = 'OPEN' AND p.status IN ('REQUESTED', 'APPROVED')) OR p.status = $1
      ORDER BY p.created_at DESC LIMIT 300`, [status]);
  return { payouts: rows.map((p) => ({ ...p, amount: round2(num(p.amount)), available: round2(num(p.available)) })) };
}

/**
 * An admin works a payout request: approve it (checked, about to be paid), mark it paid (only with the payment
 * reference — never without confirmation of the payment), or reject it with a reason (the held amount goes back to
 * the partner's available balance). An admin can't decide their own payout.
 */
export async function decidePartnerPayout(db: Pool, admin: string, payoutId: unknown, input: { action?: unknown; note?: unknown; reference?: unknown }) {
  const id = String(payoutId ?? "");
  if (!UUID.test(id)) throw new PartnerError("not_found", "That payout wasn't found", 404);
  const action = String(input.action ?? "");
  if (!["approve", "pay", "reject"].includes(action)) throw new PartnerError("invalid_action", "Approve, mark paid or reject");
  const note = String(input.note ?? "").trim().slice(0, 200);
  const reference = String(input.reference ?? (action === "pay" ? input.note : "") ?? "").trim().slice(0, 120);
  if (action === "pay" && reference.length < 3) throw new PartnerError("reference_needed", "Enter the payment reference from the transfer");
  if (action === "reject" && note.length < 3) throw new PartnerError("note_needed", "Say why it's being rejected");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const p = (await client.query(
      `SELECT p.*, u.phone FROM affiliate_payouts p JOIN users u ON u.id = p.affiliate_id WHERE p.id = $1 FOR UPDATE OF p`, [id])).rows[0];
    if (!p) throw new PartnerError("not_found", "That payout wasn't found", 404);
    const local = (x: string) => String(x ?? "").replace(/[\s-]/g, "").replace(/^(?:\+|00)?233/, "0");
    if (p.phone && local(p.phone) === local(admin)) throw new PartnerError("own_payout", "Another admin must decide your own payout", 403);
    const open = p.status === "REQUESTED" || p.status === "APPROVED";
    if (!open || (action === "approve" && p.status !== "REQUESTED")) throw new PartnerError("already_decided", "That payout was already dealt with", 409);
    let row;
    if (action === "approve") {
      row = (await client.query(
        `UPDATE affiliate_payouts SET status = 'APPROVED', approved_by = $2, approved_at = now(), note = coalesce(nullif($3, ''), note)
          WHERE id = $1 RETURNING *`, [id, admin, note])).rows[0];
    } else if (action === "pay") {
      row = (await client.query(
        `UPDATE affiliate_payouts SET status = 'PAID', reference = $2, note = $2, decided_by = $3, decided_at = now()
          WHERE id = $1 RETURNING *`, [id, reference, admin])).rows[0];
    } else {
      row = (await client.query(
        `UPDATE affiliate_payouts SET status = 'REJECTED', note = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *`,
        [id, note, admin])).rows[0];
      /* the hold goes back (once — the unique index refuses a second release) */
      const held = (await client.query(`SELECT amount FROM partner_wallet_entries WHERE payout_id = $1 AND kind = 'PAYOUT_HOLD'`, [id])).rows[0];
      if (held) {
        await client.query(
          `INSERT INTO partner_wallet_entries (affiliate_id, kind, amount, payout_id, note, created_by)
           VALUES ($1, 'PAYOUT_RELEASE', $2, $3, $4, $5)`, [p.affiliate_id, -num(held.amount), id, "Payout rejected: " + note, admin]);
      }
    }
    await logAction(client, admin, "partner.payout", p.affiliate_id, { payout: id, action, amount: round2(num(p.amount)), note, reference: reference || undefined });
    await client.query("COMMIT");
    return { ...row, amount: round2(num(row.amount)) };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** The programme at a glance for the admin's Statistics tab. */
export async function programmeStats(db: Pool, input: { range?: unknown; from?: unknown; to?: unknown }, now = new Date()) {
  await accrueCommissions(db);
  const r = parseRange(input, now);
  const [tot, partners, top] = await Promise.all([
    db.query(`SELECT coalesce(sum(stake), 0) AS stakes, coalesce(sum(payout), 0) AS payouts, coalesce(sum(ngr), 0) AS ngr,
                     coalesce(sum(amount) FILTER (WHERE amount > 0), 0) AS commission, coalesce(sum(amount) FILTER (WHERE amount < 0), 0) AS negative,
                     coalesce(sum(amount), 0) AS net, count(DISTINCT player_id) AS players
                FROM partner_commissions WHERE ($1::timestamptz IS NULL OR settled_at >= $1) AND ($2::timestamptz IS NULL OR settled_at < $2)`,
      [r.from, r.to]),
    db.query(`SELECT count(*) FILTER (WHERE status = 'ACTIVE') AS active, count(*) FILTER (WHERE status = 'PENDING') AS pending,
                     count(*) FILTER (WHERE status IN ('SUSPENDED', 'DISABLED')) AS paused,
                     (SELECT count(*) FROM referrals WHERE ($1::timestamptz IS NULL OR created_at >= $1) AND ($2::timestamptz IS NULL OR created_at < $2)) AS signups,
                     (SELECT coalesce(sum(amount), 0) FROM partner_wallet_entries) AS owed,
                     (SELECT coalesce(sum(amount), 0) FROM affiliate_payouts WHERE status = 'PAID') AS paid
                FROM affiliates`, [r.from, r.to]),
    db.query(`SELECT a.user_id, a.code, u.username, u.full_name, coalesce(sum(c.ngr), 0) AS ngr, coalesce(sum(c.amount), 0) AS net,
                     count(DISTINCT c.player_id) AS players
                FROM partner_commissions c JOIN affiliates a ON a.user_id = c.affiliate_id JOIN users u ON u.id = a.user_id
               WHERE ($1::timestamptz IS NULL OR c.settled_at >= $1) AND ($2::timestamptz IS NULL OR c.settled_at < $2)
               GROUP BY a.user_id, a.code, u.username, u.full_name ORDER BY sum(c.amount) DESC LIMIT 20`, [r.from, r.to]),
  ]);
  const t = tot.rows[0];
  const p = partners.rows[0];
  return {
    range: rangeView(r),
    totals: {
      stakes: round2(num(t.stakes)), payouts: round2(num(t.payouts)), ngr: round2(num(t.ngr)), commission: round2(num(t.commission)),
      negative: round2(num(t.negative)), net: round2(num(t.net)), activePlayers: num(t.players), signups: num(p.signups),
    },
    partners: { active: num(p.active), pending: num(p.pending), paused: num(p.paused), owed: round2(num(p.owed)), paid: round2(num(p.paid)) },
    top: top.rows.map((x) => ({ user_id: x.user_id, code: x.code, username: x.username, full_name: x.full_name,
      ngr: round2(num(x.ngr)), net: round2(num(x.net)), players: num(x.players) })),
  };
}
