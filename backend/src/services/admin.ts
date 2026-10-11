import type { Pool, PoolClient } from "pg";
import { IdempotencyError, InsufficientFundsError, postMovement, SystemAccount } from "./balanceService.js";
import { getLimits } from "./responsibleGaming.js";
import { CATALOG, hiddenCatalog, PROVIDERS, setCatalogEnabled } from "../games/availability.js";

/*
 * The admin dashboard's data: headline numbers, players, the money feed, and the actions an admin can take on a
 * player (suspend, KYC, balance correction) or on the catalog. Every action is written to admin_actions with the
 * admin's number, and a balance correction is a normal ledger movement (ADJUSTMENT, with a reason and its author).
 */

export class AdminError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "AdminError";
  }
}

type Db = Pool | PoolClient;
const num = (v: unknown) => Number(v ?? 0);
const round2 = (x: number) => Math.round(x * 100) / 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const gameInfo = (serverId: string) => {
  const c = Object.prototype.hasOwnProperty.call(CATALOG, serverId) ? CATALOG[serverId] : undefined;
  return { game: serverId, id: c?.id ?? serverId, name: c?.name ?? serverId, provider: c?.provider ?? "" };
};

/* a search box term: lower-case text for names, digits (0XXXXXXXXX form) for phone numbers; LIKE wildcards removed */
function searchTerm(raw: unknown): { text: string; phone: string } {
  const text = String(raw ?? "").trim().toLowerCase().replace(/[%_\\]/g, "").slice(0, 60);
  let phone = text.replace(/\D/g, "");
  if (phone.startsWith("233")) phone = "0" + phone.slice(3);
  return { text, phone: phone.length >= 3 ? phone : "" };
}

/** Where a reporting range starts. Ghana keeps GMT all year, so "today" starts at midnight UTC. */
export function rangeStart(range: string, now = new Date()): Date {
  if (range === "today") {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  if (range === "7d") return new Date(now.getTime() - 7 * 864e5);
  if (range === "30d") return new Date(now.getTime() - 30 * 864e5);
  return new Date(0);
}

export async function logAction(db: Db, admin: string, action: string, target: string | null, details: Record<string, unknown> = {}) {
  await db.query(`INSERT INTO admin_actions (admin, action, target, details) VALUES ($1, $2, $3, $4)`,
    [admin, action, target, JSON.stringify(details)]);
}

/* credits to players from confirmed deposits (the money that actually arrived), from the ledger */
const DEPOSITS = `SELECT e.user_id, e.amount, e.created_at, j.external_ref FROM ledger_entries e
                    JOIN ledger_journal j ON j.id = e.journal_id
                   WHERE j.entry_type = 'DEPOSIT' AND e.user_id IS NOT NULL AND e.direction = 'CREDIT' AND e.currency_code = 'GHS'`;

/* ---------------- overview ---------------- */

export async function overview(db: Pool, range: string, now = new Date()) {
  const from = rangeStart(range, now);
  const today = rangeStart("today", now);
  const fiveMinAgo = new Date(now.getTime() - 5 * 60e3);
  const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

  const [players, active, playing, dep, ftd, wPaid, wPending, owed, gaming, games, integrity, series] = await Promise.all([
    q(`SELECT count(*) AS total, count(*) FILTER (WHERE created_at >= $1) AS fresh FROM users`, [from]),
    q(`SELECT count(DISTINCT user_id) AS n FROM (
         SELECT user_id FROM all_bets WHERE created_at >= $1
         UNION ALL SELECT user_id FROM (${DEPOSITS}) d WHERE created_at >= $1) a`, [from]),
    q(`SELECT count(DISTINCT user_id) AS n FROM all_bets WHERE created_at >= $1`, [fiveMinAgo]),
    q(`SELECT coalesce(sum(amount), 0) AS amount, count(*) AS n FROM (${DEPOSITS}) d WHERE created_at >= $1`, [from]),
    q(`SELECT count(*) AS n FROM (SELECT user_id, min(created_at) AS first FROM (${DEPOSITS}) d GROUP BY user_id) f
        WHERE first >= $1`, [from]),
    q(`SELECT coalesce(sum(amount), 0) AS amount, count(*) AS n FROM withdrawals WHERE status = 'PAID' AND updated_at >= $1`, [from]),
    q(`SELECT coalesce(sum(amount), 0) AS amount, count(*) AS n FROM withdrawals WHERE status IN ('REQUESTED', 'PAYING')`),
    q(`SELECT coalesce(sum(available), 0) AS amount FROM user_balances WHERE currency_code = 'GHS'`),
    q(`SELECT coalesce(sum(stake) FILTER (WHERE settled), 0) AS stakes, coalesce(sum(payout) FILTER (WHERE settled), 0) AS payouts,
              coalesce(sum(stake) FILTER (WHERE NOT settled), 0) AS in_play, count(*) AS bets
         FROM all_bets WHERE created_at >= $1`, [from]),
    q(`SELECT game, count(*) AS bets, count(DISTINCT user_id) AS players,
              coalesce(sum(stake) FILTER (WHERE settled), 0) AS stakes, coalesce(sum(payout) FILTER (WHERE settled), 0) AS payouts
         FROM all_bets WHERE created_at >= $1 GROUP BY game`, [from]),
    /* deposit credits with no confirmed TheTeller payment behind them — there should never be any */
    q(`SELECT count(*) AS n, coalesce(sum(amount), 0) AS amount FROM (${DEPOSITS}) d
        WHERE NOT EXISTS (SELECT 1 FROM payment_intents p WHERE p.transaction_id = d.external_ref AND p.status = 'CONFIRMED')`),
    q(`WITH days AS (SELECT generate_series($1::timestamptz - interval '13 days', $1::timestamptz, interval '1 day') AS d),
            dep AS (SELECT date_trunc('day', created_at) AS d, sum(amount) AS v FROM (${DEPOSITS}) x
                     WHERE created_at >= $1::timestamptz - interval '13 days' GROUP BY 1),
            bets AS (SELECT date_trunc('day', created_at) AS d,
                            coalesce(sum(stake) FILTER (WHERE settled), 0) - coalesce(sum(payout) FILTER (WHERE settled), 0) AS ggr,
                            count(DISTINCT user_id) AS players
                       FROM all_bets WHERE created_at >= $1::timestamptz - interval '13 days' GROUP BY 1)
       SELECT days.d AS day, coalesce(dep.v, 0) AS deposits, coalesce(bets.ggr, 0) AS ggr, coalesce(bets.players, 0) AS players
         FROM days LEFT JOIN dep ON dep.d = days.d LEFT JOIN bets ON bets.d = days.d ORDER BY days.d`, [today]),
  ]);

  const stakes = num(gaming[0]!.stakes);
  const payouts = num(gaming[0]!.payouts);
  return {
    range,
    from: from.toISOString(),
    players: { total: num(players[0]!.total), new: num(players[0]!.fresh), active: num(active[0]!.n), playingNow: num(playing[0]!.n) },
    money: {
      deposits: round2(num(dep[0]!.amount)), depositCount: num(dep[0]!.n), firstDeposits: num(ftd[0]!.n),
      withdrawalsPaid: round2(num(wPaid[0]!.amount)), withdrawalsPaidCount: num(wPaid[0]!.n),
      withdrawalsPending: round2(num(wPending[0]!.amount)), withdrawalsPendingCount: num(wPending[0]!.n),
      playerBalances: round2(num(owed[0]!.amount)),
    },
    gaming: {
      stakes: round2(stakes), payouts: round2(payouts), ggr: round2(stakes - payouts),
      margin: stakes > 0 ? (stakes - payouts) / stakes : 0, inPlay: round2(num(gaming[0]!.in_play)), bets: num(gaming[0]!.bets),
    },
    integrity: { unbackedDeposits: num(integrity[0]!.n), unbackedAmount: round2(num(integrity[0]!.amount)) },
    games: games.map((g) => ({
      ...gameInfo(g.game), bets: num(g.bets), players: num(g.players), stakes: round2(num(g.stakes)),
      ggr: round2(num(g.stakes) - num(g.payouts)),
    })).sort((a, b) => b.stakes - a.stakes),
    series: series.map((s) => ({
      day: new Date(s.day).toISOString().slice(0, 10), deposits: round2(num(s.deposits)), ggr: round2(num(s.ggr)), players: num(s.players),
    })),
  };
}

/* ---------------- players ---------------- */

export async function searchUsers(db: Pool, input: { q?: unknown; status?: unknown; kyc?: unknown; offset?: unknown }) {
  const { text, phone } = searchTerm(input.q);
  const status = ["ACTIVE", "SUSPENDED", "CLOSED"].includes(String(input.status)) ? String(input.status) : "";
  const kyc = ["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"].includes(String(input.kyc)) ? String(input.kyc) : "";
  const offset = Math.max(0, Math.min(100000, Math.floor(Number(input.offset) || 0)));
  const where = `($1 = '' OR lower(coalesce(u.username, '')) LIKE '%' || $1 || '%' OR lower(coalesce(u.full_name, '')) LIKE '%' || $1 || '%'
                 OR ($2 <> '' AND coalesce(u.phone, '') LIKE '%' || $2 || '%') OR u.id::text = $1)
             AND ($3 = '' OR u.status::text = $3) AND ($4 = '' OR u.kyc_status::text = $4)`;
  const params = [text, phone, status, kyc];
  const [rows, count] = await Promise.all([
    db.query(`SELECT u.id, u.username, u.full_name, u.phone, u.status::text AS status, u.kyc_status::text AS kyc, u.created_at, u.last_login_at,
                     coalesce(b.available, 0) AS balance, a.status AS partner,
                     (SELECT coalesce(sum(e.amount), 0) FROM ledger_entries e JOIN ledger_journal j ON j.id = e.journal_id
                       WHERE e.user_id = u.id AND j.entry_type = 'DEPOSIT' AND e.direction = 'CREDIT') AS deposited
                FROM users u
                LEFT JOIN user_balances b ON b.user_id = u.id AND b.currency_code = 'GHS'
                LEFT JOIN affiliates a ON a.user_id = u.id
               WHERE ${where}
               ORDER BY u.created_at DESC LIMIT 50 OFFSET $5`, [...params, offset]),
    db.query(`SELECT count(*) AS n FROM users u WHERE ${where}`, params),
  ]);
  return {
    total: num(count.rows[0]!.n),
    offset,
    users: rows.rows.map((u) => ({
      id: u.id, username: u.username, full_name: u.full_name, phone: u.phone, status: u.status, kyc: u.kyc, partner: u.partner,
      balance: round2(num(u.balance)), deposited: round2(num(u.deposited)), created_at: u.created_at, last_seen: u.last_login_at,
    })),
  };
}

async function mustFindUser(db: Db, id: unknown): Promise<string> {
  const uid = String(id ?? "");
  if (!UUID.test(uid) || !(await db.query(`SELECT 1 FROM users WHERE id = $1`, [uid])).rowCount) {
    throw new AdminError("not_found", "That player wasn't found", 404);
  }
  return uid;
}

/** Canonical Ghana local form, 0XXXXXXXXX, from whatever an admin types (+233…, 233…, spaces, dashes). */
function localPhone(raw: unknown): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.startsWith("233")) d = "0" + d.slice(3);
  else if (d.length === 9) d = "0" + d; // typed without the leading 0
  return d;
}

interface PlayerByPhone { id: string; username: string | null; full_name: string | null; phone: string | null; balance: number }

/** The one player registered with this mobile number. Throws if none — or more than one — match, so money is
 *  never added to a guessed account. Matches whether the number is stored local (0…) or international (233…). */
async function findUserByPhone(db: Db, phoneRaw: unknown): Promise<PlayerByPhone> {
  const local = localPhone(phoneRaw);
  if (!/^0\d{9}$/.test(local)) throw new AdminError("invalid_phone", "Enter the player's 10-digit mobile number, e.g. 0241234567");
  const intl = "233" + local.slice(1);
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.full_name, u.phone, coalesce(b.available, 0) AS balance
       FROM users u
       LEFT JOIN user_balances b ON b.user_id = u.id AND b.currency_code = 'GHS'
      WHERE regexp_replace(coalesce(u.phone, ''), '[^0-9]', '', 'g') IN ($1, $2)`,
    [local, intl]);
  if (rows.length === 0) throw new AdminError("not_found", "No player is registered with that number", 404);
  if (rows.length > 1) throw new AdminError("ambiguous", "More than one account uses that number — open the player from Players instead", 409);
  const u = rows[0]!;
  return { id: u.id, username: u.username, full_name: u.full_name, phone: u.phone, balance: round2(num(u.balance)) };
}

/** For the "Add money" card: who a number belongs to, and their balance, so an admin can confirm before crediting. */
export async function lookupByPhone(db: Pool, phone: unknown): Promise<PlayerByPhone> {
  return findUserByPhone(db, phone);
}

/** Everything about one player: profile, totals, recent money and bets, and what admins have done. */
export async function userDetail(db: Pool, id: unknown) {
  const uid = await mustFindUser(db, id);
  const q = async (sql: string) => (await db.query(sql, [uid])).rows;
  const [profile, dep, wd, bets, adj, ledger, recentBets, actions, limits] = await Promise.all([
    q(`SELECT u.id, u.username, u.full_name, u.phone, u.status::text AS status, u.kyc_status::text AS kyc, u.created_at, u.last_login_at,
              coalesce(b.available, 0) AS balance,
              a.code AS partner_code, a.status AS partner_status,
              ra.code AS referred_by_code, ru.username AS referred_by
         FROM users u
         LEFT JOIN user_balances b ON b.user_id = u.id AND b.currency_code = 'GHS'
         LEFT JOIN affiliates a ON a.user_id = u.id
         LEFT JOIN referrals r ON r.user_id = u.id
         LEFT JOIN affiliates ra ON ra.user_id = r.affiliate_id
         LEFT JOIN users ru ON ru.id = r.affiliate_id
        WHERE u.id = $1`),
    q(`SELECT coalesce(sum(amount), 0) AS amount, count(*) AS n FROM (${DEPOSITS}) d WHERE user_id = $1`),
    q(`SELECT coalesce(sum(amount) FILTER (WHERE status = 'PAID'), 0) AS paid,
              coalesce(sum(amount) FILTER (WHERE status IN ('REQUESTED', 'PAYING')), 0) AS pending
         FROM withdrawals WHERE user_id = $1`),
    q(`SELECT coalesce(sum(stake) FILTER (WHERE settled), 0) AS stakes, coalesce(sum(payout) FILTER (WHERE settled), 0) AS payouts,
              coalesce(sum(stake) FILTER (WHERE NOT settled), 0) AS in_play, count(*) AS bets,
              min(created_at) AS first_bet, max(created_at) AS last_bet
         FROM all_bets WHERE user_id = $1`),
    q(`SELECT coalesce(sum(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0) AS net
         FROM ledger_entries e JOIN ledger_journal j ON j.id = e.journal_id
        WHERE e.user_id = $1 AND j.entry_type = 'ADJUSTMENT'`),
    q(`SELECT e.id, e.created_at, j.entry_type::text AS type, e.direction::text AS direction, e.amount, e.balance_after,
              j.description, j.reason, j.created_by, p.payer_phone
         FROM ledger_entries e JOIN ledger_journal j ON j.id = e.journal_id
         LEFT JOIN payment_intents p ON j.entry_type = 'DEPOSIT' AND p.transaction_id = j.external_ref
        WHERE e.user_id = $1 AND e.currency_code = 'GHS' ORDER BY e.id DESC LIMIT 25`),
    q(`SELECT game, stake, payout, settled, created_at FROM all_bets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`),
    q(`SELECT admin, action, details, created_at FROM admin_actions WHERE target = $1::text ORDER BY id DESC LIMIT 20`),
    getLimits(db, uid),
  ]);
  const p = profile[0]!;
  const stakes = num(bets[0]!.stakes);
  const payouts = num(bets[0]!.payouts);
  return {
    profile: {
      id: p.id, username: p.username, full_name: p.full_name, phone: p.phone, status: p.status, kyc: p.kyc, created_at: p.created_at, last_seen: p.last_login_at,
      balance: round2(num(p.balance)),
      partner: p.partner_code ? { code: p.partner_code, status: p.partner_status } : null,
      referredBy: p.referred_by_code ? { code: p.referred_by_code, username: p.referred_by } : null,
      excludedUntil: limits.excludedUntil,
    },
    totals: {
      deposited: round2(num(dep[0]!.amount)), deposits: num(dep[0]!.n),
      withdrawn: round2(num(wd[0]!.paid)), withdrawPending: round2(num(wd[0]!.pending)),
      staked: round2(stakes), won: round2(payouts), ggr: round2(stakes - payouts), inPlay: round2(num(bets[0]!.in_play)),
      bets: num(bets[0]!.bets), firstBet: bets[0]!.first_bet, lastBet: bets[0]!.last_bet,
      adjustments: round2(num(adj[0]!.net)),
    },
    transactions: ledger.map((t) => ({
      id: num(t.id), at: t.created_at, type: t.type, direction: t.direction, amount: round2(num(t.amount)),
      balance_after: t.balance_after === null ? null : round2(num(t.balance_after)),
      description: t.description, reason: t.reason, by: t.created_by, payer: t.payer_phone ?? null,
    })),
    bets: recentBets.map((b) => ({
      ...gameInfo(b.game), stake: round2(num(b.stake)), payout: round2(num(b.payout)), settled: b.settled, at: b.created_at,
    })),
    actions: actions.map((a) => ({ admin: a.admin, action: a.action, details: a.details, at: a.created_at })),
  };
}

/** Suspend (no new bets, deposits or withdrawals; open rounds can still be finished) or reactivate a player. */
export async function setUserStatus(db: Pool, admin: string, id: unknown, input: { status?: unknown; reason?: unknown }) {
  const uid = await mustFindUser(db, id);
  const status = String(input.status ?? "");
  if (status !== "ACTIVE" && status !== "SUSPENDED") throw new AdminError("invalid_status", "Choose Active or Suspended");
  const reason = String(input.reason ?? "").trim().slice(0, 200);
  if (status === "SUSPENDED" && reason.length < 4) throw new AdminError("reason_needed", "Say why the account is being suspended");
  await db.query(`UPDATE users SET status = $2::account_status, updated_at = now() WHERE id = $1`, [uid, status]);
  await logAction(db, admin, "user.status", uid, { status, reason });
  return { status };
}

/** Records where a player's identity check stands (the documents themselves are checked outside the platform). */
export async function setUserKyc(db: Pool, admin: string, id: unknown, input: { kyc?: unknown; note?: unknown }) {
  const uid = await mustFindUser(db, id);
  const kyc = String(input.kyc ?? "");
  if (!["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"].includes(kyc)) throw new AdminError("invalid_kyc", "Choose a KYC status");
  const note = String(input.note ?? "").trim().slice(0, 200);
  await db.query(`UPDATE users SET kyc_status = $2::kyc_status, updated_at = now() WHERE id = $1`, [uid, kyc]);
  await logAction(db, admin, "user.kyc", uid, { kyc, note });
  return { kyc };
}

export const MAX_ADJUSTMENT = 50000;

/** A balance correction or goodwill credit: an ADJUSTMENT in the ledger, with the reason and the admin who made it. */
/** Validates a manual adjustment's amount, reason and key. `addOnly` forbids negatives (the by-phone "Add money"). */
function adjustmentInput(input: { amount?: unknown; reason?: unknown; idempotency_key?: unknown }, addOnly = false) {
  const amount = round2(Number(input.amount));
  if (!Number.isFinite(amount) || amount === 0 || (addOnly && amount < 0)) {
    throw new AdminError("invalid_amount", addOnly ? "Enter an amount to add" : "Enter an amount (negative to take money off)");
  }
  if (Math.abs(amount) > MAX_ADJUSTMENT) {
    throw new AdminError("too_large", `Adjustments are limited to GHS ${MAX_ADJUSTMENT.toLocaleString("en-GH")} at a time`);
  }
  const reason = String(input.reason ?? "").trim().slice(0, 200);
  if (reason.length < 8) throw new AdminError("reason_needed", "Give a reason of at least 8 characters — it goes in the ledger");
  const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
  if (key.length < 8) throw new AdminError("invalid_idempotency_key", "An adjustment needs an idempotency_key");
  return { amount, reason, key };
}

/** The one audited money movement behind every manual adjustment: credits (amount > 0) or debits the player
 *  against the AdminAdjustments system account, and records it in admin_actions. Shared by the by-id and by-phone
 *  callers so there is a single, logged path and no second way to mint money. */
async function postAdjustment(db: Pool, admin: string, uid: string, amount: number, reason: string, key: string) {
  /* nobody adjusts their own balance: an admin crediting themselves (and then approving their own withdrawal) could
     mint money alone — another admin has to do it */
  const target = (await db.query<{ phone: string | null }>(`SELECT phone FROM users WHERE id = $1`, [uid])).rows[0];
  const tail = (p: string | null | undefined) => String(p ?? "").replace(/\D/g, "").slice(-9);
  if (target && tail(target.phone).length === 9 && tail(target.phone) === tail(admin)) {
    throw new AdminError("own_account", "Another admin has to adjust your own balance", 403);
  }
  const abs = Math.abs(amount);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await postMovement(client, {
      idempotencyKey: `adjust:${key}`,
      entryType: "ADJUSTMENT",
      description: amount > 0 ? "Balance credited by WIN B casino" : "Balance debited by WIN B casino",
      reason,
      createdBy: admin,
      legs: amount > 0
        ? [
            { userId: null, systemAccount: SystemAccount.AdminAdjustments, currencyCode: "GHS", direction: "DEBIT", amountMajor: abs },
            { userId: uid, currencyCode: "GHS", direction: "CREDIT", amountMajor: abs },
          ]
        : [
            { userId: uid, currencyCode: "GHS", direction: "DEBIT", amountMajor: abs },
            { userId: null, systemAccount: SystemAccount.AdminAdjustments, currencyCode: "GHS", direction: "CREDIT", amountMajor: abs },
          ],
    });
    await logAction(client, admin, "user.adjust", uid, { amount, reason });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    if (e instanceof IdempotencyError) return { balance: await balanceOf(db, uid), replayed: true };
    if (e instanceof InsufficientFundsError) {
      throw new AdminError("insufficient_funds", `That's more than the player's balance (GHS ${e.availableMajor.toFixed(2)})`, 409);
    }
    throw e;
  } finally {
    client.release();
  }
  return { balance: await balanceOf(db, uid) };
}

/** Credit or debit a player found by their player id (from the player's profile sheet). */
export async function adjustBalance(
  db: Pool, admin: string, id: unknown, input: { amount?: unknown; reason?: unknown; idempotency_key?: unknown }
) {
  const uid = await mustFindUser(db, id);
  const { amount, reason, key } = adjustmentInput(input);
  return postAdjustment(db, admin, uid, amount, reason, key);
}

/** Add money to a player found by mobile number (the dashboard's "Add money" card). Add only — never a debit. */
export async function creditByPhone(
  db: Pool, admin: string, input: { phone?: unknown; amount?: unknown; reason?: unknown; idempotency_key?: unknown }
) {
  const player = await findUserByPhone(db, input.phone);
  const { amount, reason, key } = adjustmentInput(input, true);
  const result = await postAdjustment(db, admin, player.id, amount, reason, key);
  return {
    player: { id: player.id, username: player.username, full_name: player.full_name, phone: player.phone },
    added: amount,
    balance: result.balance,
    replayed: "replayed" in result,
  };
}

async function balanceOf(db: Db, uid: string): Promise<number> {
  const { rows } = await db.query(`SELECT available FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [uid]);
  return round2(num(rows[0]?.available));
}

/* ---------------- the money feed ---------------- */

/* the ledger's entry types behind each filter (fixed strings, never user input) */
const FEED_TYPES: Record<string, string[]> = {
  deposits: ["DEPOSIT"],
  withdrawals: ["WITHDRAWAL_REQUEST", "REVERSAL"],
  bets: ["BET_PLACED", "BET_VOID"],
  wins: ["BET_SETTLED"],
  adjustments: ["ADJUSTMENT"],
};

/** Every movement on players' balances, newest first. `after` returns only what's new since the last poll. */
export async function transactions(db: Pool, input: { type?: unknown; q?: unknown; after?: unknown; before?: unknown }) {
  const types = FEED_TYPES[String(input.type)] ?? [];
  const { text, phone } = searchTerm(input.q);
  const after = Number.isSafeInteger(Number(input.after)) && Number(input.after) > 0 ? Number(input.after) : null;
  const before = Number.isSafeInteger(Number(input.before)) && Number(input.before) > 0 ? Number(input.before) : null;
  const typeSql = types.length ? `AND j.entry_type::text IN (${types.map((t) => `'${t}'`).join(", ")})` : "";
  const { rows } = await db.query(
    `SELECT e.id, e.created_at, e.user_id, u.username, u.full_name, u.phone, j.entry_type::text AS type, e.direction::text AS direction,
            e.amount, e.balance_after, j.description, j.reason, j.created_by, p.payer_phone
       FROM ledger_entries e
       JOIN ledger_journal j ON j.id = e.journal_id
       JOIN users u ON u.id = e.user_id
       LEFT JOIN payment_intents p ON j.entry_type = 'DEPOSIT' AND p.transaction_id = j.external_ref
      WHERE e.user_id IS NOT NULL AND e.currency_code = 'GHS' ${typeSql}
        AND ($1::bigint IS NULL OR e.id > $1) AND ($2::bigint IS NULL OR e.id < $2)
        AND ($3 = '' OR lower(coalesce(u.username, '')) LIKE '%' || $3 || '%' OR lower(coalesce(u.full_name, '')) LIKE '%' || $3 || '%'
             OR ($4 <> '' AND coalesce(u.phone, '') LIKE '%' || $4 || '%'))
      ORDER BY e.id DESC LIMIT 60`,
    [after, before, text, phone]);
  return {
    transactions: rows.map((t) => ({
      id: num(t.id), at: t.created_at, user_id: t.user_id, username: t.username, full_name: t.full_name, phone: t.phone, type: t.type,
      direction: t.direction, amount: round2(num(t.amount)),
      balance_after: t.balance_after === null ? null : round2(num(t.balance_after)),
      description: t.description, reason: t.reason, by: t.created_by, payer: t.payer_phone ?? null,
    })),
  };
}

/** The audit log: what admins have done, newest first. */
export async function auditLog(db: Pool, input: { target?: unknown }) {
  const target = String(input.target ?? "").slice(0, 80);
  const { rows } = await db.query(
    `SELECT id, admin, action, target, details, created_at FROM admin_actions
      WHERE ($1 = '' OR target = $1) ORDER BY id DESC LIMIT 100`, [target]);
  return { actions: rows.map((a) => ({ ...a, id: num(a.id) })) };
}

/* ---------------- games and studios ---------------- */

/** Every game with its switch and its numbers for the range; every studio with its switch. */
export async function catalogAdmin(db: Pool, range: string, now = new Date()) {
  const hidden = await hiddenCatalog(db);
  const from = rangeStart(range, now);
  const { rows } = await db.query(
    `SELECT game, count(*) AS bets, count(DISTINCT user_id) AS players,
            coalesce(sum(stake) FILTER (WHERE settled), 0) AS stakes, coalesce(sum(payout) FILTER (WHERE settled), 0) AS payouts
       FROM all_bets WHERE created_at >= $1 GROUP BY game`, [from]);
  const stats = new Map(rows.map((r) => [r.game as string, r]));
  return {
    range,
    providers: Object.entries(PROVIDERS).map(([id, name]) => ({ id, name, enabled: !hidden.providers.includes(id) })),
    games: Object.entries(CATALOG).map(([serverId, c]) => {
      const s = stats.get(serverId);
      return {
        ...gameInfo(serverId), enabled: !hidden.games.includes(c.id),
        studioEnabled: !hidden.providers.includes(c.provider),
        bets: num(s?.bets), players: num(s?.players), stakes: round2(num(s?.stakes)),
        ggr: round2(num(s?.stakes) - num(s?.payouts)),
      };
    }),
  };
}

export async function setCatalog(db: Pool, admin: string, kind: unknown, id: unknown, input: { enabled?: unknown }) {
  const k = String(kind);
  const target = String(id);
  if (k === "game" ? !Object.values(CATALOG).some((c) => c.id === target) : k === "provider" ? !(target in PROVIDERS) : true) {
    throw new AdminError("not_found", "No such game or studio", 404);
  }
  if (typeof input.enabled !== "boolean") throw new AdminError("invalid_enabled", "Say whether it's on or off");
  await setCatalogEnabled(db, k as "game" | "provider", target, input.enabled, admin);
  await logAction(db, admin, "catalog.toggle", `${k}:${target}`, { enabled: input.enabled });
  return { kind: k, id: target, enabled: input.enabled };
}
