import type { Pool } from "pg";
import { CATALOG, clearPlayerRiskCache, playerRisk, type PlayerRisk } from "../games/availability.js";
import { AdminError, logAction, rangeStart } from "./admin.js";
import { minDeposit } from "./moneyRules.js";

/*
 * Risk management and recent deposits for the admin (the owner's brief, 12 October 2026).
 *   - Recent deposits: every deposit attempt (successful, pending, failed), newest first, searchable.
 *   - Players' money: deposits, withdrawals, stakes, winnings and the net, per player, over a period.
 *   - Limits for one player: a deposit tier (smallest and largest deposit) and a maximum bet. Each is told to the
 *     player when it applies; none of them touches a balance, a win already made, or how a result is drawn.
 *   - Alerts: big payouts, big multipliers, players far up in a day, bursts of failed deposits.
 * The site's own minimum deposit (Admin -> Betting & withdrawal settings) is the floor for a player's deposit tier.
 */

const num = (v: unknown) => Number(v ?? 0);
const r2 = (v: unknown) => Math.round(num(v) * 100) / 100;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const nameOf = (r: { full_name?: string | null; username?: string | null }) => r.full_name || r.username || "Player";
const gameName = (serverId: string) => (CATALOG[serverId] ? CATALOG[serverId]!.name : serverId);
/* "0244123456" -> "024•••••56" for the alert cards (the full number stays on the player's own sheet) */
const mask = (p: string | null) => { const s = String(p ?? ""); return s.length >= 6 ? s.slice(0, 3) + "•".repeat(Math.max(3, s.length - 5)) + s.slice(-2) : "Player"; };

/* ---------------- recent deposits (payment_intents) ---------------- */
const STATUS_IN: Record<string, string[]> = {
  all: ["CONFIRMED", "PENDING", "FAILED", "REVERSED"], successful: ["CONFIRMED"], pending: ["PENDING"], failed: ["FAILED", "REVERSED"],
};
const statusLabel = (s: string) => (s === "CONFIRMED" ? "successful" : s === "PENDING" ? "pending" : s === "REVERSED" ? "reversed" : "failed");

/** Deposit attempts, newest first: the status filter (all/successful/pending/failed), a search by name or number, and
 *  `before` for the next page. Each row has the player, the amount, the status, the reference and the paying number. */
const NETWORK_NAME: Record<string, string> = { MTN: "MTN MoMo", VDF: "Telecel Cash", ATL: "AirtelTigo", TGO: "AirtelTigo" };
export async function recentDeposits(db: Pool, input: { status?: unknown; q?: unknown; before?: unknown }, now = new Date()) {
  if (String(input.status) === "rejected") return rejectedDeposits(db, input, now);
  const statuses = STATUS_IN[String(input.status ?? "all")] ?? STATUS_IN.all!;
  const raw = String(input.q ?? "").trim().toLowerCase().replace(/[%_\\]/g, "").slice(0, 60);
  const phone = raw.replace(/\D/g, "");
  const before = input.before ? new Date(String(input.before)) : null;
  const beforeOk = before && !Number.isNaN(before.getTime());
  const midnight = new Date(now); midnight.setUTCHours(0, 0, 0, 0);
  const [list, today] = await Promise.all([
    db.query(
      `SELECT p.id, p.amount, p.currency, p.status, p.transaction_id, p.gateway_note, p.payer_phone, p.network, p.created_at,
              u.username, u.full_name, u.phone
         FROM payment_intents p JOIN users u ON u.id = p.user_id
        WHERE p.status = ANY($1)
          AND ($2 = '' OR lower(coalesce(u.username, '')) LIKE '%' || $2 || '%' OR lower(coalesce(u.full_name, '')) LIKE '%' || $2 || '%'
               OR ($3 <> '' AND coalesce(u.phone, '') LIKE '%' || $3 || '%'))
          AND ($4::timestamptz IS NULL OR p.created_at < $4)
        ORDER BY p.created_at DESC LIMIT 60`,
      [statuses, raw, phone.length >= 3 ? phone : "", beforeOk ? before!.toISOString() : null]),
    /* today's confirmed deposits: how much really arrived and how many */
    db.query(`SELECT coalesce(sum(amount), 0) AS total, count(*) AS n FROM payment_intents WHERE status = 'CONFIRMED' AND created_at >= $1`, [midnight.toISOString()]),
  ]);
  const deposits = list.rows.map((r) => ({
    id: r.id, name: nameOf(r), username: r.username ?? null, phone: r.phone ?? null,
    amount: r2(r.amount), currency: r.currency, status: statusLabel(r.status),
    network: r.network ? (NETWORK_NAME[r.network] ?? r.network) : null,
    reference: r.transaction_id ? "DES" + r.transaction_id : null, note: r.gateway_note ?? null,
    payer: r.payer_phone ?? null, at: iso(r.created_at),
  }));
  return { deposits, today: { total: r2(today.rows[0]?.total), count: num(today.rows[0]?.n) }, next: deposits.length === 60 ? deposits[deposits.length - 1]!.at : null };
}

/** Deposit requests our own checks refused before anything reached TheTeller (amount, account, limits, conditions,
 *  number, network, duplicates): who, how much, when, why. Same shape as the deposit list, status "rejected". */
async function rejectedDeposits(db: Pool, input: { q?: unknown; before?: unknown }, now: Date) {
  const raw = String(input.q ?? "").trim().toLowerCase().replace(/[%_\\]/g, "").slice(0, 60);
  const phone = raw.replace(/\D/g, "");
  const before = input.before ? new Date(String(input.before)) : null;
  const beforeOk = before && !Number.isNaN(before.getTime());
  const midnight = new Date(now); midnight.setUTCHours(0, 0, 0, 0);
  const [list, today] = await Promise.all([
    db.query(
      `SELECT r.id, r.method, r.amount, r.amount_raw, r.currency, r.network, r.payer_phone, r.reason_code, r.reason, r.status, r.created_at,
              u.username, u.full_name, u.phone
         FROM deposit_rejections r LEFT JOIN users u ON u.id = r.user_id
        WHERE ($1 = '' OR lower(coalesce(u.username, '')) LIKE '%' || $1 || '%' OR lower(coalesce(u.full_name, '')) LIKE '%' || $1 || '%'
               OR ($2 <> '' AND (coalesce(u.phone, '') LIKE '%' || $2 || '%' OR coalesce(r.payer_phone, '') LIKE '%' || $2 || '%')))
          AND ($3::timestamptz IS NULL OR r.created_at < $3)
        ORDER BY r.created_at DESC, r.id DESC LIMIT 60`,
      [raw, phone.length >= 3 ? phone : "", beforeOk ? before!.toISOString() : null]),
    db.query(`SELECT coalesce(sum(amount), 0) AS total, count(*) AS n FROM payment_intents WHERE status = 'CONFIRMED' AND created_at >= $1`, [midnight.toISOString()]),
  ]);
  const deposits = list.rows.map((r) => ({
    id: "rej-" + r.id, name: nameOf(r), username: r.username ?? null, phone: r.phone ?? null,
    amount: r.amount === null ? null : r2(r.amount), amount_raw: r.amount_raw ?? null, currency: r.currency ?? "GHS", status: "rejected",
    network: r.network ? (NETWORK_NAME[r.network] ?? r.network) : null, reference: null,
    note: r.reason, reason_code: r.reason_code, method: r.method === "momo" ? "Mobile money" : "Card / Paybill",
    payer: r.payer_phone ?? null, at: iso(r.created_at),
  }));
  return { deposits, today: { total: r2(today.rows[0]?.total), count: num(today.rows[0]?.n) }, next: deposits.length === 60 ? deposits[deposits.length - 1]!.at : null };
}

/* ---------------- players' money (deposits, withdrawals, staked, won, net) ---------------- */
/** Each player's money over a period: what they deposited, withdrew (paid), staked and won, and the net to the house
 *  (staked minus won). Searchable; biggest net winners first so the ones to watch are on top. */
export async function playerMoney(db: Pool, input: { q?: unknown; range?: unknown }, now = new Date()) {
  const raw = String(input.q ?? "").trim().toLowerCase().replace(/[%_\\]/g, "").slice(0, 60);
  const phone = raw.replace(/\D/g, "");
  const range = ["today", "7d", "30d", "all"].includes(String(input.range)) ? String(input.range) : "30d";
  const from = range === "all" ? new Date(0) : rangeStart(range === "today" ? "today" : range, now);
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.full_name, u.phone,
            coalesce(d.deposited, 0) AS deposited, coalesce(w.withdrawn, 0) AS withdrawn,
            coalesce(b.staked, 0) AS staked, coalesce(b.won, 0) AS won, coalesce(b.bets, 0) AS bets
       FROM users u
       LEFT JOIN (SELECT user_id, sum(amount) AS deposited FROM payment_intents WHERE status = 'CONFIRMED' AND created_at >= $2 GROUP BY user_id) d ON d.user_id = u.id
       LEFT JOIN (SELECT user_id, sum(amount) AS withdrawn FROM withdrawals WHERE status = 'PAID' AND updated_at >= $2 GROUP BY user_id) w ON w.user_id = u.id
       LEFT JOIN (SELECT user_id, sum(stake) AS staked, sum(payout) AS won, count(*) AS bets FROM settled_bets WHERE settled_at >= $2 GROUP BY user_id) b ON b.user_id = u.id
      WHERE ($1 = '' OR lower(coalesce(u.username, '')) LIKE '%' || $1 || '%' OR lower(coalesce(u.full_name, '')) LIKE '%' || $1 || '%'
             OR ($3 <> '' AND coalesce(u.phone, '') LIKE '%' || $3 || '%') OR u.id::text = $1)
        AND (d.deposited IS NOT NULL OR w.withdrawn IS NOT NULL OR b.bets IS NOT NULL)
      ORDER BY (coalesce(b.won, 0) - coalesce(b.staked, 0)) DESC LIMIT 60`,
    [raw, from.toISOString(), phone.length >= 3 ? phone : ""]);
  return {
    range,
    players: rows.map((r) => ({
      id: r.id, name: nameOf(r), phone: r.phone ?? null,
      deposited: r2(r.deposited), withdrawn: r2(r.withdrawn), staked: r2(r.staked), won: r2(r.won),
      bets: num(r.bets),
      playerNet: r2(num(r.won) - num(r.staked)),                 /* the player's profit (+) or loss (-) on bets */
      houseNet: r2(num(r.staked) - num(r.won)),                  /* what the house kept */
    })),
  };
}

/* ---------------- risk settings and alerts ---------------- */
export interface RiskSettings { big_payout: number; big_multiplier: number; daily_net_win: number; failed_deposits: number; updated_by: string | null; updated_at: string | null }

export async function getRiskSettings(db: Pool): Promise<RiskSettings> {
  const r = (await db.query(`SELECT * FROM risk_settings WHERE id = 1`)).rows[0];
  return {
    big_payout: r ? num(r.big_payout) : 1000, big_multiplier: r ? num(r.big_multiplier) : 100,
    daily_net_win: r ? num(r.daily_net_win) : 5000, failed_deposits: r ? num(r.failed_deposits) : 5,
    updated_by: r?.updated_by ?? null, updated_at: iso(r?.updated_at),
  };
}

/** The risk dashboard: the alert thresholds, and what currently trips them. */
export async function riskOverview(db: Pool, now = new Date()) {
  const s = await getRiskSettings(db);
  const day = new Date(now.getTime() - 864e5).toISOString();
  const hour = new Date(now.getTime() - 36e5).toISOString();
  const [payouts, winners, failed] = await Promise.all([
    /* one bet in the last 24h paying a lot, or at a big multiplier */
    db.query(
      `SELECT b.game, b.stake, b.payout, b.settled_at, u.phone,
              CASE WHEN b.stake > 0 THEN b.payout / b.stake ELSE 0 END AS x
         FROM settled_bets b JOIN users u ON u.id = b.user_id
        WHERE b.settled_at >= $1 AND (b.payout >= $2 OR (b.stake > 0 AND b.payout / b.stake >= $3))
        ORDER BY b.payout DESC LIMIT 25`, [day, s.big_payout, s.big_multiplier]),
    /* a player a long way up over the last 24h */
    db.query(
      `SELECT u.id, u.phone, u.full_name, u.username, sum(b.payout) - sum(b.stake) AS net, count(*) AS bets
         FROM settled_bets b JOIN users u ON u.id = b.user_id
        WHERE b.settled_at >= $1 GROUP BY u.id, u.phone, u.full_name, u.username
       HAVING sum(b.payout) - sum(b.stake) >= $2 ORDER BY net DESC LIMIT 25`, [day, s.daily_net_win]),
    /* a burst of failed deposits by one player in the last hour */
    db.query(
      `SELECT u.id, u.phone, u.full_name, u.username, count(*) AS fails, sum(p.amount) AS amount
         FROM payment_intents p JOIN users u ON u.id = p.user_id
        WHERE p.status IN ('FAILED', 'REVERSED') AND p.created_at >= $1 GROUP BY u.id, u.phone, u.full_name, u.username
       HAVING count(*) >= $2 ORDER BY fails DESC LIMIT 25`, [hour, s.failed_deposits]),
  ]);
  return {
    settings: s,
    alerts: {
      payouts: payouts.rows.map((r) => ({ game: gameName(r.game), player: mask(r.phone), stake: r2(r.stake), payout: r2(r.payout), x: Math.floor(num(r.x) * 100) / 100, at: iso(r.settled_at) })),
      winners: winners.rows.map((r) => ({ user_id: r.id, name: nameOf(r), player: mask(r.phone), net: r2(r.net), bets: num(r.bets) })),
      failedDeposits: failed.rows.map((r) => ({ user_id: r.id, name: nameOf(r), player: mask(r.phone), fails: num(r.fails), amount: r2(r.amount) })),
    },
  };
}

export async function saveRiskSettings(db: Pool, admin: string, input: Record<string, unknown>) {
  const cur = await getRiskSettings(db);
  const field = (key: keyof RiskSettings, label: string, min: number) => {
    const v = input[key];
    if (v === undefined) return cur[key] as number;
    const n = Math.round(Number(v) * 100) / 100;
    if (!Number.isFinite(n) || n < min) throw new AdminError("invalid_" + key, `Enter a valid ${label} (at least ${min})`);
    return n;
  };
  const next = {
    big_payout: field("big_payout", "payout alert", 1),
    big_multiplier: field("big_multiplier", "multiplier alert", 2),
    daily_net_win: field("daily_net_win", "daily win alert", 1),
    failed_deposits: Math.round(Number(input.failed_deposits ?? cur.failed_deposits)),
  };
  if (!Number.isFinite(next.failed_deposits) || next.failed_deposits < 2) throw new AdminError("invalid_failed_deposits", "Enter a valid failed-deposit count (at least 2)");
  await db.query(
    `UPDATE risk_settings SET big_payout = $1, big_multiplier = $2, daily_net_win = $3, failed_deposits = $4, updated_by = $5, updated_at = now() WHERE id = 1`,
    [next.big_payout, next.big_multiplier, next.daily_net_win, next.failed_deposits, admin]);
  await logAction(db, admin, "risk.settings", null, { after: next });
  return { settings: await getRiskSettings(db) };
}

/* ---------------- one player's limits (player_risk) ---------------- */
async function findPlayer(db: Pool, id: unknown) {
  const r = (await db.query(`SELECT id, username, full_name, phone FROM users WHERE id = $1`, [String(id ?? "")])).rows[0];
  if (!r) throw new AdminError("not_found", "That player wasn't found", 404);
  return r;
}
const riskView = (p: PlayerRisk) => ({ min_deposit: p.min_deposit, max_deposit: p.max_deposit, max_bet: p.max_bet, note: p.note, updated_by: p.updated_by, updated_at: p.updated_at });

export async function getPlayerRisk(db: Pool, id: unknown) {
  const u = await findPlayer(db, id);
  return { user: { id: u.id, name: nameOf(u), phone: u.phone ?? null }, risk: riskView(await playerRisk(db, u.id)) };
}

/** Sets or clears a player's deposit tier and maximum bet. An empty field clears that limit. */
export async function savePlayerRisk(db: Pool, admin: string, id: unknown, input: Record<string, unknown>) {
  const u = await findPlayer(db, id);
  const cur = await playerRisk(db, u.id);
  const money = (key: string, label: string, floor: number) => {
    const v = input[key];
    if (v === undefined) return (cur as unknown as Record<string, number | null>)[key] ?? null;
    if (v === null || v === "") return null;
    const n = Math.round(Number(v) * 100) / 100;
    if (!Number.isFinite(n) || n < floor) throw new AdminError("invalid_" + key, `Enter a valid ${label} (at least GHS ${floor})`);
    return n;
  };
  const siteMin = await minDeposit(db);
  const min_deposit = money("min_deposit", "minimum deposit", siteMin);
  const max_deposit = money("max_deposit", "maximum deposit", siteMin);
  const max_bet = money("max_bet", "maximum bet", 0.1);
  if (min_deposit !== null && max_deposit !== null && min_deposit > max_deposit) {
    throw new AdminError("invalid_max_deposit", "The maximum deposit must be at least the minimum deposit");
  }
  const note = input.note === undefined ? cur.note : (String(input.note ?? "").trim().slice(0, 160) || null);
  await db.query(
    `INSERT INTO player_risk (user_id, min_deposit, max_deposit, max_bet, note, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id) DO UPDATE SET min_deposit = EXCLUDED.min_deposit, max_deposit = EXCLUDED.max_deposit,
       max_bet = EXCLUDED.max_bet, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [u.id, min_deposit, max_deposit, max_bet, note, admin]);
  clearPlayerRiskCache(u.id);
  await logAction(db, admin, "risk.player", `user:${u.id}`, { after: { min_deposit, max_deposit, max_bet, note } });
  return { user: { id: u.id, name: nameOf(u), phone: u.phone ?? null }, risk: riskView(await playerRisk(db, u.id)) };
}

/** Every player who has a limit set, for the Risk management list. */
export async function playersWithLimits(db: Pool) {
  const { rows } = await db.query(
    `SELECT r.user_id, r.min_deposit, r.max_deposit, r.max_bet, r.note, r.updated_by, r.updated_at,
            u.username, u.full_name, u.phone, a.status AS partner
       FROM player_risk r JOIN users u ON u.id = r.user_id LEFT JOIN affiliates a ON a.user_id = u.id
      WHERE r.min_deposit IS NOT NULL OR r.max_deposit IS NOT NULL OR r.max_bet IS NOT NULL
      ORDER BY r.updated_at DESC LIMIT 200`);
  return {
    players: rows.map((r) => ({
      id: r.user_id, name: nameOf(r), phone: r.phone ?? null, type: r.partner ? "partner" : "player",
      min_deposit: r.min_deposit === null ? null : r2(r.min_deposit),
      max_deposit: r.max_deposit === null ? null : r2(r.max_deposit),
      max_bet: r.max_bet === null ? null : r2(r.max_bet),
      note: r.note ?? null, updated_by: r.updated_by ?? null, updated_at: iso(r.updated_at),
    })),
  };
}
