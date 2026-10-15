// src/services/moneyRules.ts
//
// Admin -> "Betting & withdrawal settings": the site's minimum deposit, and two rules an admin can switch on.
//
//   - Minimum deposit: every deposit route and page uses this live value (GHS 135 by default).
//   - Betting sessions (switched on by migration 041): only session funds — deposited money not yet staked — can be
//     staked (the ledger keeps the winnings part apart in user_balances.withdrawable, and stakes use deposited money
//     first). Winnings can't be staked; they stay withdrawable. A new deposit adds session funds. It only refuses bets:
//     nothing is deducted, deposited money can always be bet, and withdrawals are untouched.
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
  policy_heading: string;
  policy_min_deposit: string;
  policy_betting: string;
  policy_funds: string;
  policy_withdrawal: string;
  policy_min_withdrawal: string;
  policy_notice: string;
  policy_accept: string;
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
  bet_rule_enabled: true,
  bet_rule_days: 30,
  bet_rule_message: "Only deposited funds can be staked. Your session funds: GHS {session}. Your winnings of GHS {winnings} cannot be staked, but they remain yours to withdraw at any time. A qualifying deposit (minimum GHS {min}) activates a new betting session.",
  withdraw_rule_enabled: false,
  withdraw_rule_multiple: 1,
  withdraw_rule_message: "Deposited money has to be played through before it can be withdrawn. GHS {held} of your balance is held until you place GHS {to_bet} more in bets. Your winnings are never held, and nothing is deducted.",
  withdraw_info: "Eligible withdrawal requests are securely reviewed and processed by our dedicated Payments Team, usually within a few minutes during business hours, and paid to the Mobile Money number you registered with. The minimum withdrawal is GHS 20.00. Only winnings can be withdrawn; deposited money stays in your balance as session funds for betting. For further clarification, contact our Customer Support Team.",
  policy_heading: "BEFORE YOU PROCEED WITH YOUR DEPOSIT",
  policy_min_deposit: "The minimum permissible deposit is GHS {min} per transaction, subject to a maximum of GHS {max}.",
  policy_betting: "A qualifying deposit is required to activate a new betting session. Existing account balances do not independently qualify users to initiate additional betting sessions. Any remaining funds retain their applicable account rights.",
  policy_funds: "Your balance is held in two parts. Session funds are your deposited money not yet staked: only session funds can be used to place bets. Winnings are kept separately: they cannot be used to stake, and they remain yours to withdraw at any time (from the minimum withdrawal). No part of your balance is ever deducted or confiscated.",
  policy_withdrawal: "Eligible withdrawal requests are securely reviewed and processed by our dedicated Payments Team in accordance with the platform's withdrawal policy. Approved payments are disbursed to the registered Mobile Money account.",
  policy_min_withdrawal: "GHS 20.00.",
  policy_notice: "Please review the applicable deposit, betting and withdrawal conditions before proceeding. For further clarification, contact our Customer Support Team.",
  policy_accept: "I acknowledge that I have carefully reviewed, understood and accepted the applicable deposit, betting and withdrawal conditions.",
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
    policy_heading: String(r.policy_heading ?? DEFAULT_RULES.policy_heading),
    policy_min_deposit: String(r.policy_min_deposit ?? DEFAULT_RULES.policy_min_deposit),
    policy_betting: String(r.policy_betting ?? DEFAULT_RULES.policy_betting),
    policy_funds: String(r.policy_funds ?? DEFAULT_RULES.policy_funds),
    policy_withdrawal: String(r.policy_withdrawal ?? DEFAULT_RULES.policy_withdrawal),
    policy_min_withdrawal: String(r.policy_min_withdrawal ?? DEFAULT_RULES.policy_min_withdrawal),
    policy_notice: String(r.policy_notice ?? DEFAULT_RULES.policy_notice),
    policy_accept: String(r.policy_accept ?? DEFAULT_RULES.policy_accept),
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

/** Fills {min}, {max}, {days}, {multiple}, {held}, {to_bet} and {winnings} in an admin's message (plain text; pages
 *  escape it). */
export function fillMessage(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(min|max|days|multiple|held|to_bet|winnings|session)\}/g, (all, key: string) =>
    values[key] === undefined ? all : typeof values[key] === "number" ? amountText(values[key] as number) : String(values[key]));
}

const money2 = (n: number) => r2(n).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const betRuleMessage = (r: MoneyRules, winnings = 0, session = 0) =>
  fillMessage(r.bet_rule_message, { min: money2(r.min_deposit), days: String(r.bet_rule_days), winnings: money2(winnings), session: money2(session) });

/** The deposit page's "Before you proceed" box: every line as the admin wrote it, with the amounts filled in. */
export function policyOf(r: MoneyRules) {
  const v = { min: money2(r.min_deposit), max: money2(MAX_DEPOSIT) };
  const items = [
    { label: "Minimum Deposit", text: fillMessage(r.policy_min_deposit, v) },
    ...(r.bet_rule_enabled ? [
      { label: "Betting Eligibility", text: fillMessage(r.policy_betting, v) },
      { label: "Your Funds", text: fillMessage(r.policy_funds, v) },
    ] : []),
    { label: "Withdrawal Processing", text: fillMessage(r.policy_withdrawal, v) },
    { label: "Minimum Withdrawal", text: fillMessage(r.policy_min_withdrawal, v) },
    { label: "Important Notice", text: fillMessage(r.policy_notice, v) },
  ];
  return { heading: r.policy_heading, items, accept: r.policy_accept };
}

/** What every page may know: the minimum deposit and both rules as players see them. */
export function publicRules(r: MoneyRules) {
  return {
    min_deposit: r.min_deposit,
    max_deposit: MAX_DEPOSIT,
    rules_version: r.rules_version,
    bet_rule: { enabled: r.bet_rule_enabled, kind: "session", message: betRuleMessage(r) },
    policy: policyOf(r),
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

/** A player's balance in its two parts: session funds (deposited money not yet played) and winnings. */
export async function fundsOf(db: Db, userId: string): Promise<{ balance: number; session: number; winnings: number }> {
  const b = (await db.query<{ available: string; withdrawable: string }>(
    `SELECT available, withdrawable FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId])).rows[0];
  const balance = r2(b?.available), winnings = Math.min(balance, r2(b?.withdrawable));
  return { balance, session: Math.max(0, r2(balance - winnings)), winnings };
}

/** Whether a player may place a real-money bet of `stake`: while the session rule is on, only from session funds
 *  (deposited money not yet staked) — winnings can't be staked. Always true while the rule is off. */
export async function betEligibility(db: Db, userId: string, stake = 0.01): Promise<{ eligible: boolean; rules: MoneyRules; winnings: number; session: number }> {
  const rules = await getMoneyRules(db);
  if (!rules.bet_rule_enabled) return { eligible: true, rules, winnings: 0, session: 0 };
  const f = await fundsOf(db, userId);
  /* a malformed stake, or one bigger than the whole balance, is left to the game's own checks (which say so) */
  if (typeof stake !== "number" || !Number.isFinite(stake) || stake <= 0 || stake > f.balance + 1e-9) return { eligible: true, rules, winnings: f.winnings, session: f.session };
  return { eligible: f.session >= 0.01 && f.session + 1e-9 >= stake, rules, winnings: f.winnings, session: f.session };
}

/** Refuses a real-money bet the betting rule doesn't allow: 403 deposit_required with the admin's message. Nothing
 *  is taken; the balance stays as it is and can still be withdrawn as usual. */
export async function assertBetEligible(db: Db, userId: string, stake?: number): Promise<void> {
  const { eligible, rules, winnings, session } = await betEligibility(db, userId, stake);
  if (!eligible) throw new MoneyRuleError("deposit_required", betRuleMessage(rules, winnings, session), 403);
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
const POLICY = ["policy_heading", "policy_min_deposit", "policy_betting", "policy_funds", "policy_withdrawal",
  "policy_min_withdrawal", "policy_notice", "policy_accept"] as const;
const FIELDS = ["min_deposit", "bet_rule_enabled", "bet_rule_days", "bet_rule_message", "withdraw_rule_enabled",
  "withdraw_rule_multiple", "withdraw_rule_message", "withdraw_info", ...POLICY] as const;
type Field = typeof FIELDS[number];
/* a change to one of these is material: players accept the rules again (the policy wording is what they accept) */
const MATERIAL: readonly Field[] = ["min_deposit", "bet_rule_enabled", "bet_rule_days", "withdraw_rule_enabled", "withdraw_rule_multiple",
  "policy_min_deposit", "policy_betting", "policy_funds", "policy_withdrawal", "policy_min_withdrawal", "policy_accept"];

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
  const POLICY_LABEL: Record<typeof POLICY[number], string> = {
    policy_heading: "the heading", policy_min_deposit: "the minimum deposit text", policy_betting: "the betting eligibility text",
    policy_funds: "the funds text", policy_withdrawal: "the withdrawal processing text", policy_min_withdrawal: "the minimum withdrawal text",
    policy_notice: "the important notice", policy_accept: "the acceptance checkbox text",
  };
  for (const k of POLICY) next[k] = text(k, POLICY_LABEL[k]);
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
              policy_heading = $11, policy_min_deposit = $12, policy_betting = $13, policy_funds = $14, policy_withdrawal = $15,
              policy_min_withdrawal = $16, policy_notice = $17, policy_accept = $18,
              bet_rule_enabled_at = CASE WHEN $2 AND NOT bet_rule_enabled THEN now() ELSE bet_rule_enabled_at END,
              withdraw_rule_enabled_at = CASE WHEN $5 AND NOT withdraw_rule_enabled THEN now() ELSE withdraw_rule_enabled_at END,
              updated_by = $10, updated_at = now()
        WHERE id = 1`,
      [next.min_deposit, next.bet_rule_enabled, next.bet_rule_days, next.bet_rule_message, next.withdraw_rule_enabled,
        next.withdraw_rule_multiple, next.withdraw_rule_message, next.withdraw_info, version, admin,
        ...POLICY.map((k) => next[k])]);
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
 *   - betting: players with money in their balance but no session funds left (only winnings): they need a new deposit
 *     to bet, and their winnings stay withdrawable (listed as "would need one" while the rule is off);
 *   - withdrawal: players with an amount held by the play-through rule (only while it's on). */
export async function affectedPlayers(db: Pool, input: { q?: unknown } = {}) {
  const rules = await getMoneyRules(db, true);
  const raw = String(input.q ?? "").trim().toLowerCase().replace(/[%_\\]/g, "").slice(0, 60);
  const phone = raw.replace(/\D/g, "");
  const match = `($1 = '' OR lower(coalesce(u.username, '')) LIKE '%' || $1 || '%' OR lower(coalesce(u.full_name, '')) LIKE '%' || $1 || '%'
                 OR ($2 <> '' AND coalesce(u.phone, '') LIKE '%' || $2 || '%'))`;
  const betRows = (await db.query(
    `SELECT u.id, u.username, u.full_name, u.phone, b.available, b.withdrawable, ld.amount AS last_amount, ld.created_at AS last_at
       FROM user_balances b JOIN users u ON u.id = b.user_id
       LEFT JOIN LATERAL (SELECT d.amount, d.created_at FROM (${DEPOSIT_CREDITS}) d WHERE d.user_id = u.id ORDER BY d.created_at DESC LIMIT 1) ld ON true
      WHERE b.currency_code = 'GHS' AND b.available > 0 AND b.available - b.withdrawable < 0.01 AND ${match}
      ORDER BY b.available DESC LIMIT 100`,
    [raw, phone.length >= 3 ? phone : ""])).rows;

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
        id: r.user_id ?? r.id, name: nameOf(r), phone: r.phone ?? null, balance: r2(r.available), winnings: r2(r.withdrawable),
        last_deposit: r.last_amount == null ? null : r2(r.last_amount), last_deposit_at: iso(r.last_at),
      })),
    },
    withdraw_rule: { enabled: rules.withdraw_rule_enabled, multiple: rules.withdraw_rule_multiple, players: held },
  };
}
