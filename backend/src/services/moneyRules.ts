// src/services/moneyRules.ts
//
// Admin -> "Betting & withdrawal settings": the site's minimum deposit, and two rules an admin can switch on.
//
//   - Minimum deposit: every deposit route and page uses this live value (GHS 135 by default).
//   - Betting eligibility (off by default): a real-money casino bet needs a completed deposit of at least the minimum
//     within the last N days. It only refuses new bets; it never deducts anything and never touches withdrawals.
//   - Withdrawal play-through (off by default): deposited money not yet bet is held from withdrawal:
//       held = min(balance, deposited part of the balance, qualifying deposits,
//                  max(0, multiple x qualifying deposits - stakes since the first qualifying deposit))
//     Qualifying deposits are completed deposits made after the rule was switched on and after the player's most
//     recent paid withdrawal, so it is never retroactive, it resets after a withdrawal, and it can never hold
//     winnings (the hold is capped by the deposited part of the balance). Nothing is ever deducted.
//
// Players accept the current rules (rules_version) before depositing; a material change bumps the version.

import type { Pool, PoolClient } from "pg";
import { AdminError, logAction } from "./admin.js";

type Db = Pool | PoolClient;

/** The largest single deposit (also enforced by the payment routes). */
export const MAX_DEPOSIT = 50000;
export const MESSAGE_MAX = 1000;

export interface MoneyRules {
  min_deposit: number;
  bet_rule_enabled: boolean;
  bet_rule_days: number;
  bet_rule_message: string;
  withdraw_rule_enabled: boolean;
  withdraw_rule_multiple: number;
  withdraw_rule_message: string;
  withdraw_info: string;
  rules_version: number;
  bet_rule_enabled_at: string | null;
  withdraw_rule_enabled_at: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export class MoneyRuleError extends Error {
  constructor(readonly code: string, message: string, readonly status = 403) {
    super(message);
    this.name = "MoneyRuleError";
  }
}

export const DEFAULT_RULES: MoneyRules = {
  min_deposit: 135,
  bet_rule_enabled: false,
  bet_rule_days: 30,
  bet_rule_message: "To place casino bets you need a deposit of at least GHS {min} in the last {days} days. Your balance stays yours: nothing is deducted, you can still see it, and you can still withdraw what is withdrawable.",
  withdraw_rule_enabled: false,
  withdraw_rule_multiple: 1,
  withdraw_rule_message: "Deposited money has to be played through before it can be withdrawn. GHS {held} of your balance is held until you place GHS {to_bet} more in bets. Your winnings are never held, and nothing is deducted.",
  withdraw_info: "Withdrawals are paid to the mobile money number you registered with, after an admin approves them (usually within a few minutes during business hours). The minimum withdrawal is GHS 20. Only winnings can be withdrawn; deposited money stays in your balance for betting. If anything is unclear, contact customer care.",
  rules_version: 1,
  bet_rule_enabled_at: null,
  withdraw_rule_enabled_at: null,
  updated_by: null,
  updated_at: null,
};

const r2 = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
/** "135" or "135.50": how an amount reads inside a message. */
export const amountText = (n: number) => (Number.isInteger(r2(n)) ? String(r2(n)) : r2(n).toFixed(2));

function fromRow(r: Record<string, unknown> | undefined): MoneyRules {
  if (!r) return { ...DEFAULT_RULES };
  return {
    min_deposit: r2(r.min_deposit),
    bet_rule_enabled: r.bet_rule_enabled === true,
    bet_rule_days: Number(r.bet_rule_days),
    bet_rule_message: String(r.bet_rule_message ?? ""),
    withdraw_rule_enabled: r.withdraw_rule_enabled === true,
    withdraw_rule_multiple: r2(r.withdraw_rule_multiple),
    withdraw_rule_message: String(r.withdraw_rule_message ?? ""),
    withdraw_info: String(r.withdraw_info ?? ""),
    rules_version: Number(r.rules_version),
    bet_rule_enabled_at: iso(r.bet_rule_enabled_at),
    withdraw_rule_enabled_at: iso(r.withdraw_rule_enabled_at),
    updated_by: (r.updated_by as string | null) ?? null,
    updated_at: iso(r.updated_at),
  };
}

/* ~10 s cache, so a bet or a deposit doesn't cost an extra query; a save here refreshes it at once */
const TTL_MS = 10_000;
let cache: { at: number; rules: MoneyRules } | null = null;
export const clearMoneyRulesCache = () => { cache = null; };

/** The rules as saved (the defaults when the row is somehow missing). */
export async function getMoneyRules(db: Db, fresh = false): Promise<MoneyRules> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.rules;
  const row = (await db.query(`SELECT * FROM money_rules WHERE id = 1`)).rows[0];
  const rules = fromRow(row);
  cache = { at: Date.now(), rules };
  return rules;
}

/** The live minimum deposit, in GHS. */
export const minDeposit = async (db: Db) => (await getMoneyRules(db)).min_deposit;

/** Fills {min}, {days}, {multiple}, {held} and {to_bet} in an admin's message (plain text; pages escape it). */
export function fillMessage(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(min|days|multiple|held|to_bet)\}/g, (all, key: string) =>
    values[key] === undefined ? all : typeof values[key] === "number" ? amountText(values[key] as number) : String(values[key]));
}

export const betRuleMessage = (r: MoneyRules) =>
  fillMessage(r.bet_rule_message, { min: r.min_deposit, days: String(r.bet_rule_days) });

/** What every page may know: the minimum deposit and both rules as players see them. */
export function publicRules(r: MoneyRules) {
  return {
    min_deposit: r.min_deposit,
    max_deposit: MAX_DEPOSIT,
    rules_version: r.rules_version,
    bet_rule: { enabled: r.bet_rule_enabled, days: r.bet_rule_days, message: betRuleMessage(r) },
    withdraw_rule: {
      enabled: r.withdraw_rule_enabled, multiple: r.withdraw_rule_multiple,
      /* the template with the amounts still to fill per player */
      message: fillMessage(r.withdraw_rule_message, { min: r.min_deposit, days: String(r.bet_rule_days), multiple: r.withdraw_rule_multiple }),
    },
    withdraw_info: r.withdraw_info,
  };
}

/* ---------------- deposits as the ledger saw them ---------------- */
/* completed deposits: the money that actually arrived (a short payment counts for what was paid) */
const DEPOSIT_CREDITS = `SELECT e.user_id, e.amount, e.created_at FROM ledger_entries e JOIN ledger_journal j ON j.id = e.journal_id
                          WHERE j.entry_type = 'DEPOSIT' AND e.direction = 'CREDIT' AND e.user_id IS NOT NULL AND e.currency_code = 'GHS'`;

/** Whether a player may place a real-money bet under the betting rule (always true while it's off). */
export async function betEligibility(db: Db, userId: string): Promise<{ eligible: boolean; rules: MoneyRules }> {
  const rules = await getMoneyRules(db);
  if (!rules.bet_rule_enabled) return { eligible: true, rules };
  const { rows } = await db.query(
    `SELECT 1 FROM (${DEPOSIT_CREDITS}) d WHERE d.user_id = $1 AND d.amount >= $2
        AND d.created_at > now() - make_interval(days => $3::int) LIMIT 1`,
    [userId, rules.min_deposit, rules.bet_rule_days]);
  return { eligible: rows.length > 0, rules };
}

/** Refuses a real-money bet the betting rule doesn't allow: 403 deposit_required with the admin's message. Nothing
 *  is taken; the balance stays as it is and can still be withdrawn as usual. */
export async function assertBetEligible(db: Db, userId: string): Promise<void> {
  const { eligible, rules } = await betEligibility(db, userId);
  if (!eligible) throw new MoneyRuleError("deposit_required", betRuleMessage(rules), 403);
}

/* ---------------- withdrawal play-through ---------------- */
export interface Playthrough {
  enabled: boolean;
  multiple: number;
  balance: number;
  winnings: number;          // the winnings part of the balance (never held)
  deposits: number;          // qualifying deposits
  staked: number;            // stakes placed since the first qualifying deposit (cancelled bets given back)
  held: number;
  to_bet: number;            // stakes still needed before nothing is held
  withdrawable_by_rule: number; // balance - held
  first_at: string | null;
  last_deposit_at: string | null;
  last_deposit: number | null;
}

interface PtRow { user_id: string; available: string | null; winnings: string | null; deposits: string; staked: string; first_at: Date | null; last_at: Date | null; last_amount: string | null }

/* qualifying deposits (after the rule went on, after the player's last paid withdrawal) and the stakes since the
   first of them, per player; $1 = since when the rule is on, $2 = one player or NULL for all */
const PLAYTHROUGH_SQL = `
  WITH lastw AS (SELECT user_id, max(updated_at) AS at FROM withdrawals WHERE status = 'PAID' AND ($2::uuid IS NULL OR user_id = $2::uuid) GROUP BY user_id),
  dep AS (
    SELECT d.user_id, sum(d.amount) AS deposits, min(d.created_at) AS first_at, max(d.created_at) AS last_at,
           (array_agg(d.amount ORDER BY d.created_at DESC))[1] AS last_amount
      FROM (${DEPOSIT_CREDITS}) d LEFT JOIN lastw w ON w.user_id = d.user_id
     WHERE d.created_at >= $1 AND (w.at IS NULL OR d.created_at > w.at) AND ($2::uuid IS NULL OR d.user_id = $2::uuid)
     GROUP BY d.user_id),
  stk AS (
    SELECT dep.user_id,
           coalesce(sum(CASE WHEN j.entry_type = 'BET_PLACED' AND e.direction = 'DEBIT' THEN e.amount
                             WHEN j.entry_type = 'BET_VOID' AND e.direction = 'CREDIT' THEN -e.amount ELSE 0 END), 0) AS staked
      FROM dep JOIN ledger_entries e ON e.user_id = dep.user_id AND e.currency_code = 'GHS' AND e.created_at >= dep.first_at
      JOIN ledger_journal j ON j.id = e.journal_id AND j.entry_type IN ('BET_PLACED', 'BET_VOID')
     GROUP BY dep.user_id)
  SELECT dep.user_id, b.available, b.withdrawable AS winnings, dep.deposits, coalesce(stk.staked, 0) AS staked,
         dep.first_at, dep.last_at, dep.last_amount
    FROM dep LEFT JOIN stk ON stk.user_id = dep.user_id
    LEFT JOIN user_balances b ON b.user_id = dep.user_id AND b.currency_code = 'GHS'`;

function holdOf(rules: MoneyRules, balance: number, winnings: number, row: PtRow | undefined): Playthrough {
  const deposits = r2(row?.deposits);
  const staked = Math.max(0, r2(row?.staked));
  const multiple = rules.withdraw_rule_multiple;
  const toBet = rules.withdraw_rule_enabled ? Math.max(0, r2(multiple * deposits - staked)) : 0;
  /* winnings are never held: at most the deposited part of the balance, and never more than was deposited */
  const depositPart = Math.max(0, r2(balance - winnings));
  const held = rules.withdraw_rule_enabled ? Math.max(0, r2(Math.min(balance, depositPart, deposits, toBet))) : 0;
  return {
    enabled: rules.withdraw_rule_enabled, multiple, balance, winnings, deposits, staked, held,
    to_bet: held > 0 ? toBet : 0,
    withdrawable_by_rule: Math.max(0, r2(balance - held)),
    first_at: iso(row?.first_at), last_deposit_at: iso(row?.last_at), last_deposit: row?.last_amount == null ? null : r2(row.last_amount),
  };
}

/** One player's play-through: how much of the balance is held, and how much more must be bet. */
export async function playthroughOf(db: Db, userId: string, rules?: MoneyRules): Promise<Playthrough> {
  const r = rules ?? (await getMoneyRules(db));
  const bal = (await db.query<{ available: string; withdrawable: string }>(
    `SELECT available, withdrawable FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId])).rows[0];
  const balance = r2(bal?.available), winnings = r2(bal?.withdrawable);
  if (!r.withdraw_rule_enabled || !r.withdraw_rule_enabled_at) return holdOf({ ...r, withdraw_rule_enabled: false }, balance, winnings, undefined);
  const row = (await db.query<PtRow>(PLAYTHROUGH_SQL, [r.withdraw_rule_enabled_at, userId])).rows[0];
  return holdOf(r, balance, winnings, row);
}

export const playthroughMessage = (r: MoneyRules, p: Playthrough) =>
  fillMessage(r.withdraw_rule_message, { min: r.min_deposit, days: String(r.bet_rule_days), multiple: r.withdraw_rule_multiple, held: p.held, to_bet: p.to_bet });

/* ---------------- acceptance before depositing ---------------- */
export async function hasAcceptedRules(db: Db, userId: string, version?: number): Promise<boolean> {
  const v = version ?? (await getMoneyRules(db)).rules_version;
  return (await db.query(`SELECT 1 FROM money_rules_acceptance WHERE user_id = $1 AND rules_version = $2`, [userId, v])).rows.length > 0;
}

/** Records that a player accepted the current rules. A page showing an older version is told the rules changed. */
export async function acceptRules(db: Db, userId: string, shownVersion?: unknown): Promise<{ rules_version: number; accepted_at: string }> {
  const rules = await getMoneyRules(db, true);
  if (shownVersion !== undefined && shownVersion !== null && Number(shownVersion) !== rules.rules_version) {
    throw new MoneyRuleError("rules_changed", "The rules were just updated. Please read them again before accepting.", 409);
  }
  await db.query(
    `INSERT INTO money_rules_acceptance (user_id, rules_version) VALUES ($1, $2) ON CONFLICT (user_id, rules_version) DO NOTHING`,
    [userId, rules.rules_version]);
  const row = (await db.query<{ accepted_at: Date }>(
    `SELECT accepted_at FROM money_rules_acceptance WHERE user_id = $1 AND rules_version = $2`, [userId, rules.rules_version])).rows[0];
  return { rules_version: rules.rules_version, accepted_at: iso(row?.accepted_at) ?? new Date().toISOString() };
}

/* ---------------- the admin's settings ---------------- */
const FIELDS = ["min_deposit", "bet_rule_enabled", "bet_rule_days", "bet_rule_message", "withdraw_rule_enabled",
  "withdraw_rule_multiple", "withdraw_rule_message", "withdraw_info"] as const;
type Field = typeof FIELDS[number];
/* a change to one of these is material: players accept the rules again */
const MATERIAL: readonly Field[] = ["min_deposit", "bet_rule_enabled", "bet_rule_days", "withdraw_rule_enabled", "withdraw_rule_multiple"];

function readInput(cur: MoneyRules, input: Record<string, unknown>) {
  const next = {} as Record<Field, unknown>;
  const has = (k: Field) => input[k] !== undefined;
  const num = (k: Field, label: string, lo: number, hi: number, int = false) => {
    if (!has(k)) return cur[k];
    const raw = input[k];
    const n = typeof raw === "string" && raw.trim() === "" ? NaN : Number(raw);
    if (typeof raw === "boolean" || raw === null || !Number.isFinite(n) || n < lo || n > hi || (int && !Number.isInteger(n))) {
      throw new AdminError("invalid_" + k, `Enter ${label} between ${lo.toLocaleString("en-GH")} and ${hi.toLocaleString("en-GH")}${int ? " (whole number)" : ""}`);
    }
    return int ? n : r2(n);
  };
  const bool = (k: Field, label: string) => {
    if (!has(k)) return cur[k];
    if (typeof input[k] !== "boolean") throw new AdminError("invalid_" + k, `Say whether ${label} is on (true) or off (false)`);
    return input[k];
  };
  const text = (k: Field, label: string) => {
    if (!has(k)) return cur[k];
    if (typeof input[k] !== "string") throw new AdminError("invalid_" + k, `Write ${label} as text`);
    /* plain text: control characters other than line breaks are dropped; pages escape it when they show it */
    const t = (input[k] as string).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
    if (!t) throw new AdminError("invalid_" + k, `${label.charAt(0).toUpperCase() + label.slice(1)} can't be empty`);
    if (t.length > MESSAGE_MAX) throw new AdminError("invalid_" + k, `Keep ${label} to ${MESSAGE_MAX} characters (it has ${t.length})`);
    return t;
  };
  next.min_deposit = num("min_deposit", "a minimum deposit (GHS)", 1, 100000);
  if ((next.min_deposit as number) > MAX_DEPOSIT) {
    throw new AdminError("invalid_min_deposit", `The minimum deposit can't be above the largest single deposit (GHS ${MAX_DEPOSIT.toLocaleString("en-GH")}), or nobody could deposit`);
  }
  next.bet_rule_enabled = bool("bet_rule_enabled", "the betting rule");
  next.bet_rule_days = num("bet_rule_days", "the number of days", 1, 365, true);
  next.bet_rule_message = text("bet_rule_message", "the betting rule message");
  next.withdraw_rule_enabled = bool("withdraw_rule_enabled", "the withdrawal rule");
  next.withdraw_rule_multiple = num("withdraw_rule_multiple", "a play-through multiple", 0, 20);
  next.withdraw_rule_message = text("withdraw_rule_message", "the withdrawal rule message");
  next.withdraw_info = text("withdraw_info", "the withdrawal information");
  return next;
}

/** Saves an admin's changes in one transaction: the settings row, a history entry and the admin log. A material change
 *  (the minimum deposit, either switch, the days or the multiple) bumps rules_version so players accept again. */
export async function saveMoneyRules(db: Pool, admin: string, input: Record<string, unknown>) {
  const client = await db.connect();
  let changed: Field[] = [];
  try {
    await client.query("BEGIN");
    const cur = fromRow((await client.query(`SELECT * FROM money_rules WHERE id = 1 FOR UPDATE`)).rows[0]);
    const next = readInput(cur, input ?? {});
    changed = FIELDS.filter((k) => next[k] !== cur[k]);
    if (!changed.length) {
      await client.query("COMMIT");
      return { changed: [], version_bumped: false, settings: await getMoneyRules(db, true) };
    }
    const bump = changed.some((k) => MATERIAL.includes(k));
    const version = cur.rules_version + (bump ? 1 : 0);
    await client.query(
      `INSERT INTO money_rules (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    await client.query(
      `UPDATE money_rules SET min_deposit = $1, bet_rule_enabled = $2, bet_rule_days = $3, bet_rule_message = $4,
              withdraw_rule_enabled = $5, withdraw_rule_multiple = $6, withdraw_rule_message = $7, withdraw_info = $8,
              rules_version = $9,
              bet_rule_enabled_at = CASE WHEN $2 AND NOT bet_rule_enabled THEN now() ELSE bet_rule_enabled_at END,
              withdraw_rule_enabled_at = CASE WHEN $5 AND NOT withdraw_rule_enabled THEN now() ELSE withdraw_rule_enabled_at END,
              updated_by = $10, updated_at = now()
        WHERE id = 1`,
      [next.min_deposit, next.bet_rule_enabled, next.bet_rule_days, next.bet_rule_message, next.withdraw_rule_enabled,
        next.withdraw_rule_multiple, next.withdraw_rule_message, next.withdraw_info, version, admin]);
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    for (const k of changed) changes[k] = { before: cur[k], after: next[k] };
    if (bump) changes.rules_version = { before: cur.rules_version, after: version };
    await client.query(`INSERT INTO money_rule_changes (admin, changes, rules_version) VALUES ($1, $2, $3)`,
      [admin, JSON.stringify(changes), version]);
    await logAction(client, admin, "money_rules.update", "money_rules", { changes });
    await client.query("COMMIT");
    clearMoneyRulesCache();
    return { changed, version_bumped: bump, settings: await getMoneyRules(db, true) };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** The admin page: the settings, as saved, and how players will read the messages. */
export async function moneyRulesOverview(db: Pool) {
  const settings = await getMoneyRules(db, true);
  const accepted = (await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM money_rules_acceptance WHERE rules_version = $1`, [settings.rules_version])).rows[0];
  return {
    settings,
    preview: publicRules(settings),
    accepted_current: Number(accepted?.n ?? 0),
    limits: { min_deposit: [1, MAX_DEPOSIT], bet_rule_days: [1, 365], withdraw_rule_multiple: [0, 20], message_max: MESSAGE_MAX },
  };
}

/** Change history, newest first. */
export async function moneyRulesHistory(db: Pool) {
  const { rows } = await db.query(`SELECT id, admin, changes, rules_version, created_at FROM money_rule_changes ORDER BY created_at DESC, id DESC LIMIT 100`);
  return {
    changes: rows.map((r) => ({
      id: Number(r.id), admin: r.admin, rules_version: Number(r.rules_version), at: iso(r.created_at),
      changes: typeof r.changes === "string" ? JSON.parse(r.changes) : r.changes,
    })),
  };
}

const nameOf = (r: { full_name?: string | null; username?: string | null }) => r.full_name || r.username || "Player";

/** Players each rule affects right now (up to 100 each, searchable by name or number):
 *   - betting: players with money in their balance and no qualifying deposit in the window (blocked from betting
 *     while the rule is on; listed as "would be blocked" while it's off);
 *   - withdrawal: players with an amount held by the play-through rule (only while it's on). */
export async function affectedPlayers(db: Pool, input: { q?: unknown } = {}) {
  const rules = await getMoneyRules(db, true);
  const raw = String(input.q ?? "").trim().toLowerCase().replace(/[%_\\]/g, "").slice(0, 60);
  const phone = raw.replace(/\D/g, "");
  const match = `($1 = '' OR lower(coalesce(u.username, '')) LIKE '%' || $1 || '%' OR lower(coalesce(u.full_name, '')) LIKE '%' || $1 || '%'
                 OR ($2 <> '' AND coalesce(u.phone, '') LIKE '%' || $2 || '%'))`;
  const betRows = (await db.query(
    `SELECT u.id, u.username, u.full_name, u.phone, b.available, ld.amount AS last_amount, ld.created_at AS last_at
       FROM user_balances b JOIN users u ON u.id = b.user_id
       LEFT JOIN LATERAL (SELECT d.amount, d.created_at FROM (${DEPOSIT_CREDITS}) d WHERE d.user_id = u.id ORDER BY d.created_at DESC LIMIT 1) ld ON true
      WHERE b.currency_code = 'GHS' AND b.available > 0 AND ${match}
        AND NOT EXISTS (SELECT 1 FROM (${DEPOSIT_CREDITS}) q WHERE q.user_id = u.id AND q.amount >= $3
                          AND q.created_at > now() - make_interval(days => $4::int))
      ORDER BY b.available DESC LIMIT 100`,
    [raw, phone.length >= 3 ? phone : "", rules.min_deposit, rules.bet_rule_days])).rows;

  let held: unknown[] = [];
  if (rules.withdraw_rule_enabled && rules.withdraw_rule_enabled_at) {
    const pts = (await db.query<PtRow & { username: string | null; full_name: string | null; phone: string | null }>(
      `SELECT p.*, u.username, u.full_name, u.phone FROM (${PLAYTHROUGH_SQL}) p JOIN users u ON u.id = p.user_id WHERE ${match.replace(/\$1/g, "$3").replace(/\$2/g, "$4")}`,
      [rules.withdraw_rule_enabled_at, null, raw, phone.length >= 3 ? phone : ""])).rows;
    held = pts.map((row) => ({ row, p: holdOf(rules, r2(row.available), r2(row.winnings), row) }))
      .filter((x) => x.p.held > 0)
      .sort((a, b) => b.p.held - a.p.held)
      .slice(0, 100)
      .map(({ row, p }) => ({
        id: row.user_id, name: nameOf(row), phone: row.phone ?? null, balance: p.balance, held: p.held, to_bet: p.to_bet,
        deposits: p.deposits, staked: p.staked, last_deposit: p.last_deposit, last_deposit_at: p.last_deposit_at,
      }));
  }
  return {
    bet_rule: {
      enabled: rules.bet_rule_enabled, min_deposit: rules.min_deposit, days: rules.bet_rule_days,
      players: betRows.map((r) => ({
        id: r.user_id ?? r.id, name: nameOf(r), phone: r.phone ?? null, balance: r2(r.available),
        last_deposit: r.last_amount == null ? null : r2(r.last_amount), last_deposit_at: iso(r.last_at),
      })),
    },
    withdraw_rule: { enabled: rules.withdraw_rule_enabled, multiple: rules.withdraw_rule_multiple, players: held },
  };
}
