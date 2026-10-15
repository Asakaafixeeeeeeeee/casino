import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { postMovement, SystemAccount } from "../services/balanceService.js";
import { getLimits } from "../services/responsibleGaming.js";
import { GameError } from "./catalog.js";
import { assertGameOpen, assertStakeAllowed } from "./availability.js";

/*
 * WIN B Lotto: 5/90 draws. There is a daily scheduled draw, and an admin can add named draws of their own (with an
 * opening time, a closing time and a draw time). A ticket is one of:
 *   Direct-k  one line of k numbers (1-5); wins when every number on it is drawn
 *   Perm-k    every line of k numbers (2-5) from the 3+ numbers picked; each line that's fully drawn wins
 *   Banker    a banker number with each partner number (a line of 2 each, or "against all" 89 partners); each
 *             line wins when the banker and that partner are both drawn
 * Each line pays its stake × the Direct-k multiplier fixed when the ticket was bought; a ticket's total win is capped
 * at the top win per ticket.
 *
 * Server draws get a random seed when created and derive their numbers at close. Named draws may instead use five
 * admin-selected numbers committed at creation, before betting opens. Both modes publish a fingerprint while betting
 * is open and never allow the result to be edited after creation; the seed is revealed with the result so the
 * commitment can be checked. The admin previews every ticket's result once betting has closed, then publishes with an
 * explicit confirmation: every winning ticket is paid once and the draw is locked. A draw can be cancelled (every
 * ticket refunded in full) only while betting is open; a closed draw nobody published is published automatically a
 * day after its draw time. Real-money ticket sales stay off until an admin switches them on.
 *
 * Odds: P(Direct-k wins) = C(5,k) ÷ C(90,k). The default multiplier is RTP ÷ that chance, rounded down; an admin can
 * set each one, never above the fair figure (1 ÷ chance), so no ticket size is expected to lose the house money.
 */

export const LOTTO_ID = "lotto";
export const LOTTO_NAME = "WIN B Lotto";
export const LOTTO_BALLS = 90;
export const LOTTO_DRAWN = 5;
/** A closed draw nobody published is published this long after its draw time, so no stake is ever left hanging. */
export const LOTTO_AUTO_RELEASE_MS = 24 * 3600e3;
const MAX_PERM_PICKS = 15;

type Db = Pool | PoolClient;
export type BetType = "DIRECT" | "PERM" | "BANKER";

const num = (v: unknown) => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/* ---------------- odds and payouts ---------------- */

export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}
/** The chance a line of k numbers wins. */
export const lottoChance = (k: number) => choose(LOTTO_DRAWN, k) / choose(LOTTO_BALLS, k);

/** Rounds a multiplier down: to 0.1 under 100x, otherwise to 3 significant figures. */
function niceDown(x: number): number {
  if (x < 100) return Math.floor(x * 10 + 1e-9) / 10;
  const p = 10 ** (Math.floor(Math.log10(x)) - 2);
  return Math.floor(x / p + 1e-9) * p;
}
/** The multiplier for each line size, 1 to 5 numbers, at an RTP. */
export function lottoMultipliers(rtp: number): Record<number, number> {
  const out: Record<number, number> = {};
  for (let k = 1; k <= LOTTO_DRAWN; k++) out[k] = niceDown(rtp / lottoChance(k));
  return out;
}

/**
 * The 5 numbers a seed gives for draw `id`: a shuffle of 1-90 driven by HMAC-SHA256(seed, "lotto:<id>:<counter>"),
 * taking 4 bytes at a time with rejection sampling so every number is equally likely. Sorted ascending.
 */
export function lottoNumbersFromSeed(seed: string, id: number): number[] {
  const pool = Array.from({ length: LOTTO_BALLS }, (_, i) => i + 1);
  const picked: number[] = [];
  let counter = 0;
  let buf = Buffer.alloc(0);
  const next = (): number => {
    if (buf.length < 4) {
      buf = Buffer.concat([buf, crypto.createHmac("sha256", seed).update(`lotto:${id}:${counter++}`).digest()]);
    }
    const v = buf.readUInt32BE(0);
    buf = buf.subarray(4);
    return v;
  };
  for (let i = 0; i < LOTTO_DRAWN; i++) {
    const n = pool.length - i;
    const limit = Math.floor(2 ** 32 / n) * n;
    let v = next();
    while (v >= limit) v = next();
    const j = i + (v % n);
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    picked.push(pool[i]!);
  }
  return picked.sort((a, b) => a - b);
}

/* ---------------- tickets: lines and results ---------------- */

export interface Shape { bet_type: BetType; size: number; picks: number[]; banker: number | null; lines: number }

/** How many lines a ticket holds. */
export function linesOf(t: Pick<Shape, "bet_type" | "size" | "picks">): number {
  if (t.bet_type === "PERM") return choose(t.picks.length, t.size);
  if (t.bet_type === "BANKER") return t.picks.length;
  return 1;
}
/** How many of a ticket's lines the drawn numbers win. */
export function winningLines(t: Pick<Shape, "bet_type" | "size" | "picks" | "banker">, drawn: number[]): number {
  const hit = t.picks.filter((n) => drawn.includes(Number(n))).length;
  if (t.bet_type === "PERM") return choose(hit, t.size);
  if (t.bet_type === "BANKER") return t.banker !== null && drawn.includes(Number(t.banker)) ? hit : 0;
  return hit === t.picks.length ? 1 : 0;
}
/** The most lines a ticket could ever win (5 numbers are drawn). */
export function bestLines(t: Pick<Shape, "bet_type" | "size" | "picks">): number {
  if (t.bet_type === "PERM") return choose(Math.min(t.picks.length, LOTTO_DRAWN), t.size);
  if (t.bet_type === "BANKER") return Math.min(t.picks.length, LOTTO_DRAWN - 1);
  return 1;
}
export const betLabel = (t: Pick<Shape, "bet_type" | "size">) =>
  t.bet_type === "PERM" ? `Perm ${t.size}` : t.bet_type === "BANKER" ? "Banker" : `Direct-${t.size}`;

/* ---------------- settings ---------------- */

export interface BetTypes { direct: number[]; perm: number[]; banker: boolean }
export interface LottoSettings {
  draw_time: string; cutoff_min: number; rtp: number; min_bet: number; max_bet: number; max_win: number;
  daily_enabled: boolean; daily_name: string; odds: Record<number, number>; custom_odds: boolean;
  bet_types: BetTypes; max_lines: number; real_money: boolean;
  updated_by: string | null; updated_at: string | null;
}
const DEFAULT_TYPES: BetTypes = { direct: [1, 2, 3, 4, 5], perm: [2, 3], banker: true };

function sizesOf(v: unknown, lo: number): number[] {
  return Array.isArray(v) ? [...new Set(v.map(Number).filter((k) => Number.isInteger(k) && k >= lo && k <= LOTTO_DRAWN))].sort() : [];
}

export async function getLottoSettings(db: Db): Promise<LottoSettings> {
  const r = (await db.query(`SELECT * FROM lotto_settings WHERE id = 1`)).rows[0];
  const rtp = num(r?.rtp ?? 0.9);
  const fromRtp = lottoMultipliers(rtp);
  const stored = r?.odds && typeof r.odds === "object" ? r.odds as Record<string, unknown> : null;
  const odds: Record<number, number> = {};
  for (let k = 1; k <= LOTTO_DRAWN; k++) odds[k] = stored && Number(stored[k]) > 0 ? Number(stored[k]) : fromRtp[k]!;
  const bt = r?.bet_types && typeof r.bet_types === "object" ? r.bet_types as Record<string, unknown> : null;
  return {
    draw_time: r?.draw_time ?? "19:00", cutoff_min: num(r?.cutoff_min ?? 10), rtp,
    min_bet: num(r?.min_bet ?? 1), max_bet: num(r?.max_bet ?? 500), max_win: num(r?.max_win ?? 100000),
    daily_enabled: r?.daily_enabled ?? true, daily_name: r?.daily_name ?? "Daily Draw",
    odds, custom_odds: !!stored,
    bet_types: bt ? { direct: sizesOf(bt.direct, 1), perm: sizesOf(bt.perm, 2), banker: bt.banker === true } : DEFAULT_TYPES,
    max_lines: num(r?.max_lines ?? 120),
    real_money: r?.real_money === true,
    updated_by: r?.updated_by ?? null, updated_at: iso(r?.updated_at),
  };
}

/** The next daily draw time (today's or tomorrow's at draw_time, UTC = Ghana time) whose betting hasn't closed. */
export function nextDrawAt(s: Pick<LottoSettings, "draw_time" | "cutoff_min">, now: number): Date {
  const [h, m] = s.draw_time.split(":").map(Number);
  const d = new Date(now);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m);
  while (at - s.cutoff_min * 60e3 <= now) at += 86400e3;
  return new Date(at);
}

/** Saves the daily schedule, odds, bet types and limits. The daily draw taking bets moves to the new time; tickets
 *  already bought keep the odds they were sold at. */
export async function saveLottoSettings(db: Pool, admin: string, input: Record<string, unknown>, now = Date.now()): Promise<LottoSettings> {
  const cur = await getLottoSettings(db);
  const has = (k: string) => input[k] !== undefined && input[k] !== "" && input[k] !== null;
  const pick = <T>(k: string, f: (v: unknown) => T, d: T): T => (has(k) ? f(input[k]) : d);
  const draw_time = pick("draw_time", (v) => String(v).trim().slice(0, 5), cur.draw_time);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draw_time)) throw new GameError("invalid_time", "Draw time must be HH:MM (24-hour)");
  const cutoff_min = pick("cutoff_min", Number, cur.cutoff_min);
  if (!Number.isInteger(cutoff_min) || cutoff_min < 1 || cutoff_min > 720) throw new GameError("invalid_cutoff", "Betting must close 1 to 720 minutes before the draw");
  let rtp = cur.rtp;
  let odds: Record<number, number> | null = cur.custom_odds ? cur.odds : null;
  if (has("rtp_pct")) {
    const pct = Number(input.rtp_pct);
    if (!Number.isFinite(pct) || pct < 50 || pct > 99) throw new GameError("invalid_rtp", "RTP must be between 50% and 99%");
    if (round2(pct) / 100 !== cur.rtp) { rtp = round2(pct) / 100; odds = null; }
  }
  if (has("odds")) {
    const o = input.odds as Record<string, unknown>;
    if (!o || typeof o !== "object") throw new GameError("invalid_odds", "Odds must be given for Direct-1 to Direct-5");
    const next: Record<number, number> = {};
    for (let k = 1; k <= LOTTO_DRAWN; k++) {
      const m = round2(Number(o[k]));
      const fair = 1 / lottoChance(k);
      if (!Number.isFinite(m) || m <= 1) throw new GameError("invalid_odds", `Direct-${k} must pay more than 1×`);
      if (m > Math.floor(fair)) throw new GameError("invalid_odds", `Direct-${k} can pay at most ${Math.floor(fair).toLocaleString("en-GH")}× (the fair odds, 1 in ${Math.round(fair).toLocaleString("en-GH")})`);
      next[k] = m;
    }
    const derived = lottoMultipliers(rtp);
    odds = [1, 2, 3, 4, 5].every((k) => next[k] === derived[k]) ? null : next;
  }
  let bet_types = cur.bet_types;
  if (has("bet_types")) {
    const b = input.bet_types as Record<string, unknown>;
    bet_types = { direct: sizesOf(b?.direct, 1), perm: sizesOf(b?.perm, 2), banker: b?.banker === true };
    if (!bet_types.direct.length && !bet_types.perm.length && !bet_types.banker) throw new GameError("invalid_bet_types", "Offer at least one bet type");
  }
  const min_bet = round2(pick("min_bet", Number, cur.min_bet));
  const max_bet = round2(pick("max_bet", Number, cur.max_bet));
  const max_win = round2(pick("max_win", Number, cur.max_win));
  const max_lines = pick("max_lines", Number, cur.max_lines);
  if (!(min_bet >= 0.5) || !(max_bet >= min_bet) || max_bet > 100000) throw new GameError("invalid_limits", "Stakes: minimum at least GHS 0.50, maximum not below the minimum");
  if (!(max_win >= max_bet) || max_win > 10_000_000) throw new GameError("invalid_max_win", "The top win must be at least the maximum stake");
  if (!Number.isInteger(max_lines) || max_lines < 1 || max_lines > 1000) throw new GameError("invalid_lines", "Lines per ticket: 1 to 1,000");
  const daily_enabled = has("daily_enabled") ? input.daily_enabled === true || input.daily_enabled === "true" : cur.daily_enabled;
  const daily_name = pick("daily_name", (v) => String(v).trim().slice(0, 60), cur.daily_name) || "Daily Draw";
  let real_money = cur.real_money;
  if (has("real_money")) {
    const on = input.real_money === true || input.real_money === "true";
    /* switching real-money sales on needs the admin to confirm the licensing is in place */
    if (on && !cur.real_money && input.licence_confirmed !== true) {
      throw new GameError("licence_required", "Confirm that the required lotto licence and approvals are in place before opening real-money ticket sales.");
    }
    real_money = on;
  }

  await db.query(
    `UPDATE lotto_settings SET draw_time = $1, cutoff_min = $2, rtp = $3, min_bet = $4, max_bet = $5, max_win = $6,
            odds = $7, bet_types = $8, max_lines = $9, daily_enabled = $10, daily_name = $11,
            real_money = $12, updated_by = $13, updated_at = now() WHERE id = 1`,
    [draw_time, cutoff_min, rtp, min_bet, max_bet, max_win, odds ? JSON.stringify(odds) : null, JSON.stringify(bet_types),
      max_lines, daily_enabled, daily_name, real_money, admin]);
  /* the daily draw taking bets follows the new schedule and name */
  const at = nextDrawAt({ draw_time, cutoff_min }, now);
  try {
    await db.query(
      `UPDATE lotto_draws SET draw_at = $1, closes_at = $2, name = $4 WHERE auto AND status = 'OPEN' AND closes_at > $3`,
      [at, new Date(at.getTime() - cutoff_min * 60e3), new Date(now), daily_name]);
  } catch (e) {
    if ((e as { code?: string }).code !== "23505") throw e;
  }
  return getLottoSettings(db);
}

/* ---------------- draws ---------------- */

export interface DrawRow {
  id: string; name: string; draw_at: Date; opens_at: Date | null; closes_at: Date; seed: string; hash: string;
  numbers: number[] | null; number_source: "SERVER" | "MANUAL"; status: "OPEN" | "CLOSED" | "RELEASED" | "CANCELLED"; paused: boolean; auto: boolean;
  decided_by: string | null; created_by: string | null; released_at: Date | null; created_at: Date;
}
interface TicketRow {
  id: string; code: string; draw_id: string; user_id: string; bet_type: BetType; size: number; banker: number | null;
  picks: number[]; lines: number; unit_stake: string; stake: string; multiplier: string; max_win: string; payout: string;
  winning_lines: number; status: "ACTIVE" | "WON" | "LOST" | "REFUNDED"; created_at: Date;
}

async function inTransaction<T>(db: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const newSeed = () => crypto.randomBytes(32).toString("hex");
export const lottoResultHash = (seed: string, id: number, numbers: number[], source: "SERVER" | "MANUAL") =>
  sha256(source === "MANUAL" ? `${seed}:lotto-manual:${id}:${numbers.join(",")}` : seed);
export function lottoResultCommitmentValid(
  seed: string, id: number, hash: string, numbers: number[], source: "SERVER" | "MANUAL",
): boolean {
  const expected = source === "MANUAL" ? numbers : lottoNumbersFromSeed(seed, id);
  return lottoResultHash(seed, id, expected, source) === hash
    && numbers.length === expected.length && numbers.every((n, i) => n === expected[i]);
}

/** The daily draw taking bets now, opened (with its seed drawn) the first time anyone asks; null when the daily
 *  schedule is switched off. */
export async function currentLottoDraw(db: Pool, now = Date.now()): Promise<DrawRow | null> {
  const s = await getLottoSettings(db);
  if (!s.daily_enabled) return null;
  const at = nextDrawAt(s, now);
  const seed = newSeed();
  await db.query(
    `INSERT INTO lotto_draws (name, draw_at, closes_at, seed, hash, auto) VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (draw_at) WHERE auto DO NOTHING`,
    [s.daily_name, at, new Date(at.getTime() - s.cutoff_min * 60e3), seed, sha256(seed)]);
  return (await db.query<DrawRow>(`SELECT * FROM lotto_draws WHERE auto AND draw_at = $1`, [at])).rows[0]!;
}

/** Draws taking bets now (open, not paused, past their opening time, before their closing time). */
async function openDraws(db: Pool, now: number): Promise<DrawRow[]> {
  await currentLottoDraw(db, now);
  return (await db.query<DrawRow>(
    `SELECT * FROM lotto_draws WHERE status = 'OPEN' AND closes_at > $1 AND (opens_at IS NULL OR opens_at <= $1)
      ORDER BY closes_at, id`, [new Date(now)])).rows;
}

/** An admin's own draw: a name, when betting opens and closes, and the draw time. */
export async function createLottoDraw(db: Pool, admin: string, input: Record<string, unknown>, now = Date.now()): Promise<DrawRow> {
  const name = String(input.name ?? "").trim().slice(0, 60);
  if (name.length < 2) throw new GameError("invalid_name", "Give the draw a name");
  const t = (k: string) => {
    const v = input[k];
    const d = v === undefined || v === null || v === "" ? NaN : new Date(String(v)).getTime();
    return d;
  };
  const opens = Number.isNaN(t("opens_at")) ? now : t("opens_at");
  const closes = t("closes_at");
  const drawAt = Number.isNaN(t("draw_at")) ? closes : t("draw_at");
  const manualInput = input.manual_numbers;
  const manualNumbers = manualInput === undefined || manualInput === null || manualInput === ""
    ? null
    : (Array.isArray(manualInput) ? manualInput : String(manualInput).split(",")).map(Number);
  if (manualNumbers && (manualNumbers.length !== LOTTO_DRAWN
    || manualNumbers.some((n) => !Number.isInteger(n) || n < 1 || n > LOTTO_BALLS)
    || new Set(manualNumbers).size !== LOTTO_DRAWN)) {
    throw new GameError("invalid_picks", "Manual results must be exactly 5 different whole numbers from 1 to 90.");
  }
  if (manualNumbers) manualNumbers.sort((a, b) => a - b);
  if (Number.isNaN(closes)) throw new GameError("invalid_times", "Set when betting closes");
  if (closes <= now) throw new GameError("invalid_times", "Betting must close in the future");
  if (opens >= closes) throw new GameError("invalid_times", "Betting must open before it closes");
  if (drawAt < closes) throw new GameError("invalid_times", "The draw time can't be before betting closes");
  if (closes - now > 60 * 86400e3) throw new GameError("invalid_times", "Draws can be set up to 60 days ahead");
  const seed = newSeed();
  const source = manualNumbers ? "MANUAL" : "SERVER";
  return inTransaction(db, async (client) => {
    const d = (await client.query<DrawRow>(
      `INSERT INTO lotto_draws (name, opens_at, closes_at, draw_at, seed, hash, auto, created_by, number_source, numbers)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9) RETURNING *`,
      [name, new Date(opens), new Date(closes), new Date(drawAt), seed, sha256(seed), admin, source, manualNumbers])).rows[0]!;
    const hash = lottoResultHash(seed, Number(d.id), manualNumbers ?? [], source);
    return (await client.query<DrawRow>(`UPDATE lotto_draws SET hash = $2 WHERE id = $1 RETURNING *`, [d.id, hash])).rows[0]!;
  });
}

/** Stops (or restarts) new tickets on one draw; tickets already bought stay in it. */
export async function pauseLottoDraw(db: Pool, id: unknown, paused: boolean): Promise<DrawRow> {
  const drawId = Number(id);
  const d = (await db.query<DrawRow>(
    `UPDATE lotto_draws SET paused = $2 WHERE id = $1 AND status = 'OPEN' RETURNING *`, [Number.isInteger(drawId) ? drawId : 0, paused])).rows[0];
  if (!d) throw new GameError("not_open", "Only a draw that's still taking bets can be paused or resumed", 409);
  return d;
}

/** Closes betting on every draw past its cut-off, preserving precommitted numbers or drawing from the server seed. */
export async function closeDueLottoDraws(db: Pool, now = Date.now()): Promise<number> {
  const due = (await db.query<DrawRow>(
    `SELECT * FROM lotto_draws WHERE status = 'OPEN' AND closes_at <= $1 ORDER BY id`, [new Date(now)])).rows;
  for (const d of due) {
    await db.query(
      `UPDATE lotto_draws SET status = 'CLOSED',
         numbers = CASE WHEN number_source = 'SERVER' THEN $2 ELSE numbers END
       WHERE id = $1 AND status = 'OPEN'`,
      [d.id, lottoNumbersFromSeed(d.seed, Number(d.id))]);
  }
  return due.length;
}

const shapeOf = (t: TicketRow): Shape => ({
  bet_type: (t.bet_type ?? "DIRECT") as BetType, size: Number(t.size ?? t.picks.length), picks: t.picks.map(Number),
  banker: t.banker === null || t.banker === undefined ? null : Number(t.banker), lines: Number(t.lines ?? 1),
});
const unitOf = (t: TicketRow) => num(t.unit_stake ?? t.stake);
function resultOf(t: TicketRow, drawn: number[]) {
  const lines = winningLines(shapeOf(t), drawn);
  const payout = lines > 0 ? Math.min(round2(unitOf(t) * num(t.multiplier) * lines), num(t.max_win)) : 0;
  return { lines, payout };
}

function drawIdOf(id: unknown): number {
  const drawId = Number(id);
  if (!Number.isInteger(drawId) || drawId < 1) throw new GameError("not_found", "That draw wasn't found", 404);
  return drawId;
}

/** Fixed winning numbers for a closed draw: precommitted numbers, or the server seed's result. */
const winningNumbersOf = (d: DrawRow): number[] => (d.numbers ?? lottoNumbersFromSeed(d.seed, Number(d.id))).map(Number);

function assertPublishable(d: DrawRow | undefined): asserts d is DrawRow {
  if (!d) throw new GameError("not_found", "That draw wasn't found", 404);
  if (d.status === "OPEN") throw new GameError("still_open", "Betting is still open on this draw — its committed result is available after it closes.", 409);
  if (d.status === "RELEASED") throw new GameError("already_decided", "These results are already published and locked.", 409);
  if (d.status === "CANCELLED") throw new GameError("already_decided", "This draw was cancelled and every ticket refunded.", 409);
}

/** Every ticket's result in a draw, before anything is paid: what publishing will do (a published draw shows what
 *  was paid). */
export async function previewLottoDraw(db: Pool, id: unknown, now = Date.now()) {
  await closeDueLottoDraws(db, now);
  const drawId = drawIdOf(id);
  const d = (await db.query<DrawRow>(`SELECT * FROM lotto_draws WHERE id = $1`, [drawId])).rows[0];
  if (!d) throw new GameError("not_found", "That draw wasn't found", 404);
  const published = d.status === "RELEASED";
  if (!published) assertPublishable(d);
  const numbers = published ? (d.numbers ?? []).map(Number) : winningNumbersOf(d);
  const rows = (await db.query<TicketRow & { username: string | null; full_name: string | null; phone: string | null }>(
    `SELECT t.*, u.username, u.full_name, u.phone FROM lotto_tickets t JOIN users u ON u.id = t.user_id
      WHERE t.draw_id = $1 AND t.status <> 'REFUNDED' ORDER BY t.created_at`, [drawId])).rows;
  const tickets = rows.map((t) => {
    const r = published ? { lines: Number(t.winning_lines), payout: num(t.payout) } : resultOf(t, numbers);
    return { ...ticketView(t), name: t.full_name || t.username || "Player", username: t.username ?? null, phone: t.phone ?? null,
      winning_lines: r.lines, result_payout: r.payout };
  });
  const winners = tickets.filter((t) => t.result_payout > 0);
  return {
    draw: adminDrawView(d), numbers, published,
    tickets, totals: {
      tickets: tickets.length, staked: round2(tickets.reduce((a, t) => a + t.stake, 0)),
      winners: winners.length, losers: tickets.length - winners.length,
      payout: round2(winners.reduce((a, t) => a + t.result_payout, 0)),
    },
  };
}

/** Publishes a closed draw's committed results: pays every winning ticket once, marks the rest
 *  lost, and locks the draw. */
export async function releaseLottoDraw(db: Pool, id: unknown, by: string, now = Date.now()) {
  await closeDueLottoDraws(db, now);
  const drawId = drawIdOf(id);
  return inTransaction(db, async (client) => {
    const d = (await client.query<DrawRow>(`SELECT * FROM lotto_draws WHERE id = $1 FOR UPDATE`, [drawId])).rows[0];
    assertPublishable(d);
    const numbers = winningNumbersOf(d);
    if (!lottoResultCommitmentValid(d.seed, drawId, d.hash, numbers, d.number_source ?? "SERVER")) {
      throw new GameError("invalid_result_commitment", "The draw result does not match its published commitment and cannot be released.", 409);
    }
    const tickets = (await client.query<TicketRow>(
      `SELECT * FROM lotto_tickets WHERE draw_id = $1 AND status = 'ACTIVE' FOR UPDATE`, [drawId])).rows;
    let winners = 0;
    let paid = 0;
    for (const t of tickets) {
      const r = resultOf(t, numbers);
      await client.query(`UPDATE lotto_tickets SET status = $2, payout = $3, winning_lines = $4, updated_at = now() WHERE id = $1 AND status = 'ACTIVE'`,
        [t.id, r.payout > 0 ? "WON" : "LOST", r.payout, r.lines]);
      if (r.payout > 0) {
        winners++;
        paid = round2(paid + r.payout);
        /* keyed by the ticket, so a ticket can never be paid twice */
        await postMovement(client, {
          idempotencyKey: `win:lotto:${t.id}`,
          entryType: "BET_SETTLED",
          description: `${LOTTO_NAME} win — ticket ${t.code ?? t.id}`,
          legs: [
            { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: r.payout },
            { userId: t.user_id, currencyCode: "GHS", direction: "CREDIT", amountMajor: r.payout },
          ],
        });
      }
    }
    await client.query(
      `UPDATE lotto_draws SET status = 'RELEASED', numbers = $3, released_at = now(), decided_by = $2 WHERE id = $1`, [drawId, by, numbers]);
    return { id: drawId, name: d.name, numbers, tickets: tickets.length, winners, losers: tickets.length - winners, paid };
  });
}

/** Cancels a draw while betting is still open (before anyone knows the numbers): every ticket is refunded in full.
 *  Once closed its numbers exist, so cancelling could be used to dodge a payout. */
export async function cancelLottoDraw(db: Pool, id: unknown, by: string, now = Date.now()) {
  await closeDueLottoDraws(db, now);
  const drawId = drawIdOf(id);
  return inTransaction(db, async (client) => {
    const d = (await client.query<DrawRow>(`SELECT * FROM lotto_draws WHERE id = $1 FOR UPDATE`, [drawId])).rows[0];
    if (!d) throw new GameError("not_found", "That draw wasn't found", 404);
    if (d.status === "RELEASED" || d.status === "CANCELLED") {
      throw new GameError("already_decided", `This draw is already ${d.status === "RELEASED" ? "published" : "cancelled"}.`, 409);
    }
    if (d.status === "CLOSED") {
      throw new GameError("too_late", "Betting has closed and the result is locked, so this draw can only be published now.", 409);
    }
    const tickets = (await client.query<TicketRow>(
      `SELECT * FROM lotto_tickets WHERE draw_id = $1 AND status = 'ACTIVE' FOR UPDATE`, [drawId])).rows;
    let refunded = 0;
    for (const t of tickets) {
      await client.query(`UPDATE lotto_tickets SET status = 'REFUNDED', updated_at = now() WHERE id = $1`, [t.id]);
      refunded = round2(refunded + num(t.stake));
      await postMovement(client, {
        idempotencyKey: `void:lotto:${t.id}`,
        entryType: "BET_VOID",
        description: `${LOTTO_NAME} draw cancelled — ticket ${t.code ?? t.id} refunded`,
        legs: [
          { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: num(t.stake) },
          { userId: t.user_id, currencyCode: "GHS", direction: "CREDIT", amountMajor: num(t.stake) },
        ],
      });
    }
    await client.query(`UPDATE lotto_draws SET status = 'CANCELLED', decided_by = $2 WHERE id = $1`, [drawId, by]);
    return { id: drawId, tickets: tickets.length, refunded };
  });
}

/** Closes due draws, publishes any closed draw nobody published within a day of its draw time, and keeps the daily
 *  draw open. */
export async function lottoSweep(db: Pool, now = Date.now()): Promise<void> {
  await closeDueLottoDraws(db, now);
  const stale = (await db.query<{ id: string }>(
    `SELECT id FROM lotto_draws WHERE status = 'CLOSED' AND draw_at <= $1 ORDER BY id`,
    [new Date(now - LOTTO_AUTO_RELEASE_MS)])).rows;
  for (const { id } of stale) {
    try {
      await releaseLottoDraw(db, id, "auto-release", now);
    } catch (e) {
      console.error(`[lotto] draw ${id} failed to auto-publish: ${(e as Error).message}`);
    }
  }
  await currentLottoDraw(db, now);
}

export function startLottoSweep(db: Pool): void {
  const run = () => lottoSweep(db).catch((e) => console.error("[lotto] sweep failed:", (e as Error).message));
  setInterval(run, 30_000).unref();
  void run();
}

/* ---------------- views ---------------- */

export interface LottoTicketView {
  id: string; code: string; draw_id: number; bet_type: BetType; bet: string; size: number; banker: number | null;
  picks: number[]; lines: number; unit_stake: number; stake: number; multiplier: number; potential: number;
  payout: number; winning_lines: number; status: string; created_at: string;
}
function ticketView(t: TicketRow): LottoTicketView {
  const s = shapeOf(t);
  return {
    id: t.id, code: t.code ?? t.id.slice(0, 8), draw_id: Number(t.draw_id), bet_type: s.bet_type, bet: betLabel(s), size: s.size,
    banker: s.banker, picks: s.picks, lines: s.lines, unit_stake: unitOf(t), stake: num(t.stake), multiplier: num(t.multiplier),
    potential: Math.min(round2(unitOf(t) * num(t.multiplier) * bestLines(s)), num(t.max_win)),
    payout: num(t.payout), winning_lines: Number(t.winning_lines ?? 0), status: t.status, created_at: iso(t.created_at)!,
  };
}

/** The public draw: numbers and seed only once its results are published. */
const drawView = (d: DrawRow) => ({
  id: Number(d.id), name: d.name, draw_at: iso(d.draw_at), opens_at: iso(d.opens_at), closes_at: iso(d.closes_at),
  status: d.status === "CLOSED" ? "DRAWING" : d.status, paused: d.paused, hash: d.hash, number_source: d.number_source ?? "SERVER",
  ...(d.status === "RELEASED" ? {
    numbers: (d.numbers ?? []).map(Number), seed: d.seed, published_at: iso(d.released_at),
  } : {}),
});
/** The admin's draw: numbers once betting has closed (never while it's open). */
const adminDrawView = (d: DrawRow) => ({
  id: Number(d.id), name: d.name, draw_at: iso(d.draw_at), opens_at: iso(d.opens_at), closes_at: iso(d.closes_at),
  status: d.status, paused: d.paused, auto: d.auto, hash: d.hash, number_source: d.number_source ?? "SERVER",
  created_by: d.created_by ?? null,
  numbers: d.status === "OPEN" || !d.numbers ? null : d.numbers.map(Number),
  ...(d.status === "RELEASED" ? { seed: d.seed } : {}),
  decided_by: d.decided_by ?? null, released_at: iso(d.released_at),
});

/** The lotto page: draws taking bets, the odds, bet types and limits, and the latest results. */
export async function lottoState(db: Pool, now = Date.now()) {
  await closeDueLottoDraws(db, now);
  const s = await getLottoSettings(db);
  const open = await openDraws(db, now);
  const upcoming = (await db.query<DrawRow>(
    `SELECT * FROM lotto_draws WHERE status = 'OPEN' AND opens_at > $1 ORDER BY opens_at LIMIT 5`, [new Date(now)])).rows;
  const results = (await db.query<DrawRow>(
    `SELECT * FROM lotto_draws WHERE status IN ('RELEASED', 'CLOSED', 'CANCELLED') ORDER BY draw_at DESC, id DESC LIMIT 12`)).rows;
  const rtpOf = (k: number) => round2(s.odds[k]! * lottoChance(k) * 100);
  return {
    now: new Date(now).toISOString(),
    draw: open[0] ? drawView(open[0]) : null,
    draws: open.map(drawView),
    upcoming: upcoming.map(drawView),
    multipliers: s.odds,
    rtp: Math.max(...[1, 2, 3, 4, 5].map(rtpOf)) / 100,
    rtp_by_size: Object.fromEntries([1, 2, 3, 4, 5].map((k) => [k, rtpOf(k)])),
    bet_types: s.bet_types, max_lines: s.max_lines, real_money: s.real_money,
    min_bet: s.min_bet, max_bet: s.max_bet, max_win: s.max_win, draw_time: s.draw_time, cutoff_min: s.cutoff_min,
    results: results.map(drawView),
  };
}

/** The player's own tickets, newest first: pending (waiting for the draw), completed, or won. */
export async function myLottoTickets(db: Pool, userId: string, filter: unknown = "all") {
  const f = String(filter ?? "all");
  const where = f === "pending" ? `AND t.status = 'ACTIVE'` : f === "completed" ? `AND t.status <> 'ACTIVE'` : f === "won" ? `AND t.status = 'WON'` : "";
  const rows = (await db.query<TicketRow & { draw_at: Date; draw_name: string; draw_status: string; numbers: number[] | null }>(
    `SELECT t.*, d.draw_at, d.name AS draw_name, d.status AS draw_status, d.numbers FROM lotto_tickets t JOIN lotto_draws d ON d.id = t.draw_id
      WHERE t.user_id = $1 ${where} ORDER BY t.created_at DESC LIMIT 100`, [userId])).rows;
  const sums = (await db.query(
    `SELECT count(*) FILTER (WHERE status = 'WON') AS won, coalesce(sum(payout) FILTER (WHERE status = 'WON'), 0) AS won_total,
            count(*) FILTER (WHERE status = 'ACTIVE') AS pending, count(*) AS tickets
       FROM lotto_tickets WHERE user_id = $1`, [userId])).rows[0];
  return {
    tickets: rows.map((t) => ({
      ...ticketView(t), draw_at: iso(t.draw_at), draw_name: t.draw_name,
      draw_status: t.draw_status === "CLOSED" ? "DRAWING" : t.draw_status,
      ...(t.draw_status === "RELEASED" ? { numbers: (t.numbers ?? []).map(Number) } : {}),
    })),
    summary: { tickets: num(sums.tickets), pending: num(sums.pending), won: num(sums.won), won_total: num(sums.won_total) },
  };
}

async function balanceOf(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ available: string }>(
    `SELECT available FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId]);
  return num(rows[0]?.available);
}

function parseNumbers(v: unknown): number[] {
  const raw = Array.isArray(v) ? v : [];
  const out = raw.map(Number);
  if (out.some((n) => !Number.isInteger(n) || n < 1 || n > LOTTO_BALLS) || new Set(out).size !== out.length) {
    throw new GameError("invalid_picks", `Numbers must be different, from 1 to ${LOTTO_BALLS}`);
  }
  return out.sort((a, b) => a - b);
}

/** Checks a ticket against the bet types on offer and works out its lines. */
export function shapeTicket(input: { bet_type?: unknown; size?: unknown; picks?: unknown; banker?: unknown; against_all?: unknown },
  s: Pick<LottoSettings, "bet_types" | "max_lines">): Shape {
  const type = String(input.bet_type ?? "DIRECT").toUpperCase() as BetType;
  if (type === "DIRECT") {
    const picks = parseNumbers(input.picks);
    if (picks.length < 1 || picks.length > LOTTO_DRAWN) throw new GameError("invalid_picks", `Direct: pick 1 to ${LOTTO_DRAWN} numbers`);
    if (!s.bet_types.direct.includes(picks.length)) throw new GameError("bet_type_off", `Direct-${picks.length} isn't offered right now`);
    return { bet_type: type, size: picks.length, picks, banker: null, lines: 1 };
  }
  if (type === "PERM") {
    const size = Number(input.size);
    if (!s.bet_types.perm.includes(size)) throw new GameError("bet_type_off", `Perm ${Number.isFinite(size) ? size : ""} isn't offered right now`.replace("  ", " "));
    const picks = parseNumbers(input.picks);
    if (picks.length <= size || picks.length > MAX_PERM_PICKS) throw new GameError("invalid_picks", `Perm ${size}: pick ${size + 1} to ${MAX_PERM_PICKS} numbers`);
    const lines = choose(picks.length, size);
    if (lines > s.max_lines) throw new GameError("too_many_lines", `That's ${lines} lines — the most on one ticket is ${s.max_lines}. Pick fewer numbers.`);
    return { bet_type: type, size, picks, banker: null, lines };
  }
  if (type === "BANKER") {
    if (!s.bet_types.banker) throw new GameError("bet_type_off", "Banker isn't offered right now");
    const banker = Number(input.banker);
    if (!Number.isInteger(banker) || banker < 1 || banker > LOTTO_BALLS) throw new GameError("invalid_banker", "Choose your banker number, 1 to 90");
    const picks = input.against_all === true
      ? Array.from({ length: LOTTO_BALLS }, (_, i) => i + 1).filter((n) => n !== banker)
      : parseNumbers(input.picks);
    if (picks.includes(banker)) throw new GameError("invalid_picks", "The banker can't also be a partner number");
    if (picks.length < 1) throw new GameError("invalid_picks", "Pick at least one partner number, or play against all");
    if (picks.length > s.max_lines) throw new GameError("too_many_lines", `That's ${picks.length} lines — the most on one ticket is ${s.max_lines}.`);
    return { bet_type: type, size: 2, picks, banker, lines: picks.length };
  }
  throw new GameError("invalid_bet_type", "Choose Direct, Perm or Banker");
}

/** Buys a ticket on a draw taking bets. The whole stake is taken now, once; the same key returns the same ticket. */
export async function buyLottoTicket(
  db: Pool, userId: string,
  input: { picks?: unknown; stake?: unknown; draw_id?: unknown; bet_type?: unknown; size?: unknown; banker?: unknown; against_all?: unknown; idempotency_key?: unknown },
  opts: { now?: number } = {}
): Promise<{ ticket: LottoTicketView; balance: number }> {
  const now = opts.now ?? Date.now();
  const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
  if (key.length < 8 || key.length > 120) throw new GameError("invalid_idempotency_key", "A ticket needs an idempotency_key");
  const replay = async () => {
    const prior = (await db.query<TicketRow>(`SELECT * FROM lotto_tickets WHERE idempotency_key = $1`, [key])).rows[0];
    if (!prior) return null;
    if (prior.user_id !== userId) throw new GameError("key_reused", "That ticket key was already used", 409);
    return { ticket: ticketView(prior), balance: await balanceOf(db, userId) };
  };
  const prior = await replay();
  if (prior) return prior;

  await assertGameOpen(db, LOTTO_ID);
  const s = await getLottoSettings(db);
  if (!s.real_money) throw new GameError("sales_closed", "Lotto ticket sales aren't open yet. Check back soon.", 503);
  const shape = shapeTicket(input, s);
  const unit = Math.round(Number(input.stake) * 100) / 100;
  if (!Number.isFinite(unit) || unit < s.min_bet) {
    throw new GameError("invalid_stake", `The stake per line is at least GHS ${s.min_bet.toFixed(2)}`);
  }
  const stake = round2(unit * shape.lines);
  if (stake > s.max_bet) {
    throw new GameError("invalid_stake", `This ticket costs GHS ${stake.toLocaleString("en-GH", { minimumFractionDigits: 2 })} — the most on one ticket is GHS ${s.max_bet.toLocaleString("en-GH")}`);
  }
  await assertStakeAllowed(db, LOTTO_ID, stake, userId);
  if ((await getLimits(db, userId)).excludedUntil) {
    throw new GameError("self_excluded", "You're taking a break, so real-money play is paused until it ends.", 403);
  }
  await closeDueLottoDraws(db, now);
  let draw: DrawRow | undefined;
  if (input.draw_id !== undefined && input.draw_id !== null && input.draw_id !== "") {
    draw = (await db.query<DrawRow>(`SELECT * FROM lotto_draws WHERE id = $1`, [drawIdOf(input.draw_id)])).rows[0];
    if (!draw) throw new GameError("not_found", "That draw wasn't found", 404);
  } else {
    draw = (await currentLottoDraw(db, now)) ?? (await openDraws(db, now))[0];
    if (!draw) throw new GameError("no_draw", "There's no draw taking bets right now. Check back soon.", 409);
  }
  if (draw.status === "CANCELLED") throw new GameError("draw_cancelled", "This draw was cancelled. Check back for the next one.", 409);
  if (draw.status !== "OPEN" || now >= new Date(draw.closes_at).getTime()) {
    throw new GameError("too_late", "Betting on that draw has closed — your ticket can go on the next draw.", 409);
  }
  if (draw.opens_at && now < new Date(draw.opens_at).getTime()) throw new GameError("not_open_yet", "Betting on this draw hasn't opened yet.", 409);
  if (draw.paused) throw new GameError("draw_paused", "Betting on this draw is paused for now.", 409);
  const multiplier = s.odds[shape.size]!;
  const id = crypto.randomUUID();
  const code = "LT-" + id.replace(/-/g, "").slice(0, 10).toUpperCase();

  try {
    return await inTransaction(db, async (client) => {
      /* the draw row, shared-locked, so a ticket can't commit after betting closed */
      const live = (await client.query<{ status: string; closes_at: Date; paused: boolean }>(
        `SELECT status, closes_at, paused FROM lotto_draws WHERE id = $1 FOR SHARE`, [draw!.id])).rows[0];
      if (!live || live.status !== "OPEN" || live.paused || now >= new Date(live.closes_at).getTime()) {
        throw new GameError("too_late", "Betting on this draw has just closed — try the next draw.", 409);
      }
      const t = (await client.query<TicketRow>(
        `INSERT INTO lotto_tickets (id, code, draw_id, user_id, bet_type, size, banker, picks, lines, unit_stake, stake, multiplier, max_win, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [id, code, draw!.id, userId, shape.bet_type, shape.size, shape.banker, shape.picks, shape.lines, unit, stake, multiplier, s.max_win, key])).rows[0]!;
      await postMovement(client, {
        idempotencyKey: `bet:lotto:${t.id}`,
        entryType: "BET_PLACED",
        description: `${LOTTO_NAME} ticket ${code} (${betLabel(shape)})`,
        legs: [
          { userId, currencyCode: "GHS", direction: "DEBIT", amountMajor: stake },
          { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "CREDIT", amountMajor: stake },
        ],
      });
      return { ticket: ticketView(t), balance: await balanceOf(client, userId) };
    });
  } catch (e) {
    if (e instanceof Error && e.name === "InsufficientFundsError") {
      throw new GameError("insufficient_funds", "Not enough in your balance for that ticket — deposit to keep playing.", 409);
    }
    if ((e as { code?: string }).code === "23505" || (e instanceof Error && e.name === "IdempotencyError")) {
      const again = await replay();
      if (again) return again;
    }
    throw e;
  }
}

/* ---------------- the admin's view ---------------- */

/** Draws with their totals, newest first. */
export async function lottoAdminDraws(db: Pool, now = Date.now()) {
  await closeDueLottoDraws(db, now);
  await currentLottoDraw(db, now);
  const rows = (await db.query(
    `SELECT d.*, count(t.id) FILTER (WHERE t.status <> 'REFUNDED') AS tickets,
            coalesce(sum(t.stake) FILTER (WHERE t.status <> 'REFUNDED'), 0) AS staked,
            coalesce(sum(t.payout), 0) AS paid,
            count(t.id) FILTER (WHERE t.status = 'WON') AS winners,
            count(t.id) FILTER (WHERE t.status = 'LOST') AS losers,
            count(t.id) FILTER (WHERE t.status = 'REFUNDED') AS refunded
       FROM lotto_draws d LEFT JOIN lotto_tickets t ON t.draw_id = d.id
      GROUP BY d.id ORDER BY d.draw_at DESC, d.id DESC LIMIT 60`)).rows;
  const out = [];
  for (const d of rows) {
    let projected: { winners: number; payout: number } | null = null;
    if (d.status === "CLOSED" && d.numbers) {
      /* what publishing will pay, so the admin knows before pressing the button */
      const numbers = (d.numbers ?? []).map(Number);
      const ts = (await db.query<TicketRow>(`SELECT * FROM lotto_tickets WHERE draw_id = $1 AND status = 'ACTIVE'`, [d.id])).rows;
      let w = 0, p = 0;
      for (const t of ts) { const r = resultOf(t, numbers); if (r.payout > 0) { w++; p = round2(p + r.payout); } }
      projected = { winners: w, payout: p };
    }
    out.push({
      ...adminDrawView(d as DrawRow),
      tickets: num(d.tickets), staked: num(d.staked), paid: num(d.paid), winners: num(d.winners), losers: num(d.losers),
      refunded: num(d.refunded), projected,
    });
  }
  return out;
}

/** ALL LOTTO PLACEMENTS: every ticket, with who bought it, filtered by period, draw, player and status, with totals. */
export async function lottoPlacements(db: Pool, q: Record<string, unknown>, now = Date.now()) {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace("$?", "$" + args.length)); };
  const day = new Date(now);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const period = String(q.period ?? "all");
  if (period === "today") add("t.created_at >= $?", new Date(midnight));
  else if (period === "yesterday") { add("t.created_at >= $?", new Date(midnight - 86400e3)); add("t.created_at < $?", new Date(midnight)); }
  else if (period === "week") add("t.created_at >= $?", new Date(midnight - ((day.getUTCDay() + 6) % 7) * 86400e3));
  else if (period === "month") add("t.created_at >= $?", new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)));
  if (q.draw !== undefined && q.draw !== "" && q.draw !== "all") add("t.draw_id = $?", drawIdOf(q.draw));
  const status = String(q.status ?? "all").toUpperCase();
  if (["ACTIVE", "WON", "LOST", "REFUNDED"].includes(status)) add("t.status = $?", status);
  const term = String(q.q ?? "").trim().slice(0, 60);
  if (term) {
    args.push("%" + term.toLowerCase() + "%");
    const p = "$" + args.length;
    where.push(`(lower(coalesce(u.username, '')) LIKE ${p} OR lower(coalesce(u.full_name, '')) LIKE ${p} OR coalesce(u.phone, '') LIKE ${p} OR lower(coalesce(t.code, '')) LIKE ${p})`);
  }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const pageSizeRaw = Number(q.page_size ?? 100);
  const pageSize = Number.isInteger(pageSizeRaw) ? Math.max(1, Math.min(100, pageSizeRaw)) : 100;
  const pageRaw = Number(q.page ?? 1);
  const page = Number.isInteger(pageRaw) ? Math.max(1, Math.min(1_000_000, pageRaw)) : 1;
  const offset = (page - 1) * pageSize;
  const from = `FROM lotto_tickets t JOIN users u ON u.id = t.user_id JOIN lotto_draws d ON d.id = t.draw_id ${w}`;
  const rows = (await db.query<TicketRow & { username: string | null; full_name: string | null; phone: string | null; draw_name: string; draw_at: Date; draw_status: string }>(
    `SELECT t.*, u.username, u.full_name, u.phone, d.name AS draw_name, d.draw_at, d.status AS draw_status ${from}
      ORDER BY t.created_at DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, pageSize, offset])).rows;
  const all = (await db.query<TicketRow>(`SELECT t.* ${from}`, args)).rows;
  const views = all.map(ticketView);
  return {
    tickets: rows.map((t) => ({
      ...ticketView(t), user_id: t.user_id, username: t.username ?? null, name: t.full_name || t.username || "Player", phone: t.phone ?? null,
      draw_name: t.draw_name, draw_at: iso(t.draw_at), draw_status: t.draw_status,
    })),
    totals: {
      tickets: views.length,
      stakes: round2(views.filter((t) => t.status !== "REFUNDED").reduce((a, t) => a + t.stake, 0)),
      potential: round2(views.filter((t) => t.status === "ACTIVE").reduce((a, t) => a + t.potential, 0)),
      won: views.filter((t) => t.status === "WON").length,
      lost: views.filter((t) => t.status === "LOST").length,
      pending: views.filter((t) => t.status === "ACTIVE").length,
      paid: round2(views.reduce((a, t) => a + t.payout, 0)),
    },
    shown: rows.length,
    page,
    page_size: pageSize,
    pages: Math.max(1, Math.ceil(views.length / pageSize)),
  };
}
