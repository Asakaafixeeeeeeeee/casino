import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { postMovement, SystemAccount } from "../services/balanceService.js";
import { getLimits } from "../services/responsibleGaming.js";
import { GameError } from "./catalog.js";
import { assertGameOpen, assertStakeAllowed } from "./availability.js";
import { capOf, judge, MAX_WIN, type FlightGame, type Verdict } from "./flights.js";

/*
 * Sky Rush: one crash round for every player at once. Everybody watching sees the same take-off, the same multiplier
 * and the same crash, and the bets list is the real players' bets in that round.
 *
 * A round opens the moment the one before it has crashed: its seed (32 random bytes) is drawn then, and the crash
 * point is worked out from the seed. The seed's SHA-256 hash is public from the start; the seed itself, the crash
 * point and the crash time are told to nobody until the plane has flown away, after which anyone can check that the
 * seed matches the hash and gives that crash point. Bets are taken for SKY_WAIT_MS after the crash before (betting
 * closes at take-off), and a cash-out pays stake × the multiplier at the moment the server receives it.
 *
 * Odds: P(crash ≥ m) = 97% ÷ m, so every way of cashing out returns 97% of stakes on average; the 3% of draws below
 * 1 are an instant 1.00x crash, which is the house edge.
 */

export const SKY_ID = "sky-rush";
export const SKY_NAME = "Sky Rush";
/** From a crash to the next take-off: the "Place your bet" pause. */
export const SKY_WAIT_MS = 8000;
/** The multiplier is e^(SKY_GROWTH × seconds): 2x after ~7.7 s, 10x after ~25.6 s, 100x after ~51 s. */
export const SKY_GROWTH = 0.09;
export const SKY_RTP = 0.97;
export const SKY_MAX_CRASH = 10000;
/** The longest a wait request is held before it's answered "still flying". */
const MAX_WAIT_MS = 25000;

const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
export const skyMultiplierAt = (ms: number) =>
  Math.max(1, Math.floor(Math.exp((SKY_GROWTH * Math.max(0, ms)) / 1000) * 100) / 100);
export const skyFlightMs = (x: number) => (Math.log(x) / SKY_GROWTH) * 1000;

export const SKY: FlightGame = {
  id: SKY_ID,
  name: SKY_NAME,
  rtp: SKY_RTP,
  minBet: 1,
  maxBet: 1000,
  colours: false,
  waitMs: SKY_WAIT_MS,
  maxCrash: SKY_MAX_CRASH,
  multiplierAt: skyMultiplierAt,
  flightMs: skyFlightMs,
  payout: (stake, x) => floor2(stake * x),
};

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * The crash point a seed gives in round `no`: the first 52 bits of HMAC-SHA256(seed, "sky-rush:<no>") as a uniform
 * u in [0, 1), then floor(97 ÷ (1 − u)) hundredths, at least 1.00x and at most the top. The page repeats this sum
 * with the browser's own crypto to check a finished round.
 */
export function skyCrashFromSeed(seed: string, no: number, rtp = SKY_RTP): number {
  const h = crypto.createHmac("sha256", seed).update(`${SKY_ID}:${no}`).digest("hex");
  return skyCrashFromUniform(parseInt(h.slice(0, 13), 16) / 2 ** 52, rtp);
}

/** u uniform on [0, 1) → a crash point with P(crash ≥ m) = RTP ÷ m (to the cent, capped at the top). */
export const skyCrashFromUniform = (u: number, rtp = SKY_RTP) =>
  Math.min(SKY_MAX_CRASH, Math.max(1, Math.floor((100 * rtp) / (1 - u)) / 100));

/* ---------------- storage ---------------- */

interface RoundRow {
  no: string; seed: string; hash: string; crash: string; starts_at: Date | string; ends_at: Date | string; settled: boolean;
  /** The RTP the round was drawn with. */
  rtp: string;
}
interface BetRow {
  id: string; round_no: string; user_id: string; panel: number; stake: string; auto_target: string | null;
  status: "ACTIVE" | "WON" | "LOST" | "CANCELLED"; cashed_x: string | null; payout: string; idempotency_key: string;
  created_at: Date | string;
  /** The maximum win in force when the bet was placed (null: bets from before it could be changed, so MAX_WIN). */
  max_win: string | null;
}
type Db = Pool | PoolClient;

/* ---------------- settings (admin: published RTP and bet limits) ---------------- */

export interface SkySettings { rtp: number; min_bet: number; max_bet: number; max_win: number; updated_by: string | null; updated_at: string | null }
const SKY_DEFAULTS: SkySettings = { rtp: SKY_RTP, min_bet: 1, max_bet: 1000, max_win: MAX_WIN, updated_by: null, updated_at: null };
let settingsCache: { at: number; value: SkySettings } | null = null;

/** The settings in force (a few seconds' cache; a change made here clears it at once). */
export async function getSkySettings(db: Db): Promise<SkySettings> {
  if (settingsCache && Date.now() - settingsCache.at < 3000) return settingsCache.value;
  const row = (await db.query<{ rtp: string; min_bet: string; max_bet: string; max_win: string; updated_by: string | null; updated_at: Date | null }>(
    `SELECT rtp, min_bet, max_bet, max_win, updated_by, updated_at FROM sky_settings WHERE id = 1`)).rows[0];
  const value: SkySettings = row
    ? { rtp: Number(row.rtp), min_bet: Number(row.min_bet), max_bet: Number(row.max_bet), max_win: Number(row.max_win),
        updated_by: row.updated_by, updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null }
    : SKY_DEFAULTS;
  settingsCache = { at: Date.now(), value };
  return value;
}

/** Saves new settings (checked here). They apply from the next round that opens and the next bet placed; a round
 *  already drawn and bets already placed keep what they had. The RTP comes in as a percentage (97). */
export async function saveSkySettings(
  db: Pool, by: string, input: { rtp?: unknown; min_bet?: unknown; max_bet?: unknown; max_win?: unknown }
): Promise<SkySettings> {
  const cur = await getSkySettings(db);
  const pick = (v: unknown, fallback: number) => (v === undefined || v === null || v === "" ? fallback : numeric(v));
  const rtpPct = Math.round(pick(input.rtp, cur.rtp * 100) * 100) / 100;
  const minBet = Math.round(pick(input.min_bet, cur.min_bet) * 100) / 100;
  const maxBet = Math.round(pick(input.max_bet, cur.max_bet) * 100) / 100;
  const maxWin = Math.round(pick(input.max_win, cur.max_win) * 100) / 100;
  if (!Number.isFinite(rtpPct) || rtpPct < 80 || rtpPct > 99) throw new GameError("invalid_rtp", "RTP must be between 80% and 99%");
  if (!Number.isFinite(minBet) || minBet < 0.1) throw new GameError("invalid_min_bet", "Minimum bet must be at least GHS 0.10");
  if (!Number.isFinite(maxBet) || maxBet < minBet || maxBet > 1_000_000) {
    throw new GameError("invalid_max_bet", "Maximum bet must be at least the minimum bet (and at most GHS 1,000,000)");
  }
  if (!Number.isFinite(maxWin) || maxWin < maxBet || maxWin > 100_000_000) {
    throw new GameError("invalid_max_win", "Maximum win must be at least the maximum bet (and at most GHS 100,000,000)");
  }
  await db.query(
    `UPDATE sky_settings SET rtp = $1, min_bet = $2, max_bet = $3, max_win = $4, updated_by = $5, updated_at = now() WHERE id = 1`,
    [rtpPct / 100, minBet, maxBet, maxWin, by]);
  settingsCache = null;
  return getSkySettings(db);
}

const startOf = (r: RoundRow) => new Date(r.starts_at).getTime();
/** The exact crash moment (ends_at is the same, rounded up to the millisecond, for the database's own queries). */
const endOf = (r: RoundRow) => startOf(r) + skyFlightMs(Number(r.crash));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A number sent as a number or as plain digits — never an array, a boolean or "1e3". */
const numeric = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
const roundNo = (v: unknown): number => {
  const n = numeric(v);
  return Number.isSafeInteger(n) && n > 0 ? n : NaN;
};

export interface SkyRoundView {
  no: number;
  /** SHA-256 of the round's seed, published before take-off. */
  hash: string;
  /** Take-off (ms since the epoch); betting closes then. */
  starts_at: number;
  /** The RTP the crash point was drawn with (P(crash ≥ m) = rtp ÷ m); public, for checking the round. */
  rtp: number;
  over: boolean;
  /** Only once the plane has flown away. */
  crash?: number;
  seed?: string;
  ends_at?: number;
}

export interface SkyBetView {
  bet_id: string;
  round_no: number;
  panel: number;
  stake: number;
  /** Where the bet cashes itself out: the player's auto cash-out or the top-prize cap, whichever is lower. */
  auto_x: number;
  status: BetRow["status"];
  /** The multiplier it was paid at. */
  x: number | null;
  payout: number;
}

function roundView(r: RoundRow, now: number): SkyRoundView {
  const over = now >= endOf(r);
  return {
    no: Number(r.no),
    hash: r.hash,
    starts_at: startOf(r),
    rtp: Number(r.rtp ?? SKY_RTP),
    over,
    ...(over ? { crash: Number(r.crash), seed: r.seed, ends_at: Math.ceil(endOf(r)) } : {}),
  };
}

const maxWinOf = (b: BetRow) => (b.max_win === null || b.max_win === undefined ? MAX_WIN : Number(b.max_win));
const autoOf = (b: BetRow) =>
  Math.min(b.auto_target === null ? Infinity : Number(b.auto_target), capOf(Number(b.stake), SKY_MAX_CRASH, maxWinOf(b)));

function betView(b: BetRow): SkyBetView {
  return {
    bet_id: b.id,
    round_no: Number(b.round_no),
    panel: b.panel,
    stake: Number(b.stake),
    auto_x: autoOf(b),
    status: b.status,
    x: b.cashed_x === null ? null : Number(b.cashed_x),
    payout: Number(b.payout),
  };
}

const verdictOf = (b: BetRow, r: RoundRow, now: number, manual: boolean) =>
  judge({ ...SKY, maxWin: maxWinOf(b) }, { stake: Number(b.stake), kind: "classic", auto: b.auto_target === null ? null : Number(b.auto_target) },
    { crash: Number(r.crash), startsAt: startOf(r) }, now, manual);

async function balanceOf(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ available: string }>(
    `SELECT available FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId]);
  return Number(rows[0]?.available ?? 0);
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

async function latestRound(db: Db): Promise<RoundRow | undefined> {
  return (await db.query<RoundRow>(`SELECT * FROM sky_rounds ORDER BY no DESC LIMIT 1`)).rows[0];
}

async function roundByNo(db: Db, no: number): Promise<RoundRow | undefined> {
  return (await db.query<RoundRow>(`SELECT * FROM sky_rounds WHERE no = $1`, [no])).rows[0];
}

/**
 * The round taking bets or in the air. Once the latest round has crashed the next one opens, with its seed drawn
 * now: it takes off SKY_WAIT_MS after the crash (or after now, if nobody was around). Two requests opening the same
 * round at once both end up with the one that was stored first.
 */
export async function currentSkyRound(db: Pool, now = Date.now()): Promise<RoundRow> {
  const latest = await latestRound(db);
  if (latest && now < endOf(latest)) return latest;
  const no = latest ? Number(latest.no) + 1 : 1;
  const seed = crypto.randomBytes(32).toString("hex");
  /* the published RTP in force now, stored with the round so the round can still be checked after a change */
  const { rtp } = await getSkySettings(db);
  const crash = skyCrashFromSeed(seed, no, rtp);
  const startsAt = Math.ceil(Math.max(latest ? endOf(latest) : 0, now)) + SKY_WAIT_MS;
  await db.query(
    `INSERT INTO sky_rounds (no, seed, hash, crash, starts_at, ends_at, rtp) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (no) DO NOTHING`,
    [no, seed, sha256(seed), crash, new Date(startsAt), new Date(Math.ceil(startsAt + skyFlightMs(crash))), rtp]);
  return (await roundByNo(db, no))!;
}

/** Settles one bet as the verdict says, once: only an ACTIVE bet changes, and a win is paid from the ledger. */
async function settleBet(client: PoolClient, bet: BetRow, v: Verdict): Promise<BetRow> {
  if (v.status === "ACTIVE") return bet;
  const payout = v.status === "WON" ? SKY.payout(Number(bet.stake), v.x) : 0;
  const { rows } = await client.query<BetRow>(
    `UPDATE sky_bets SET status = $2, cashed_x = $3, payout = $4, updated_at = now()
      WHERE id = $1 AND status = 'ACTIVE' RETURNING *`,
    [bet.id, v.status, v.status === "WON" ? v.x : null, payout]);
  if (!rows[0]) return bet;
  if (payout > 0) {
    await postMovement(client, {
      idempotencyKey: `win:sky:${bet.id}`,
      entryType: "BET_SETTLED",
      description: `${SKY_NAME} win`,
      legs: [
        { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: payout },
        { userId: bet.user_id, currencyCode: "GHS", direction: "CREDIT", amountMajor: payout },
      ],
    });
  }
  return rows[0];
}

/** Settles a finished round once: auto cash-outs (and capped bets) that came in are paid, every other bet is lost. */
export async function settleSkyRound(db: Pool, no: number, now = Date.now()): Promise<void> {
  await inTransaction(db, async (client) => {
    const r = (await client.query<RoundRow>(`SELECT * FROM sky_rounds WHERE no = $1 FOR UPDATE`, [no])).rows[0];
    if (!r || r.settled || now < endOf(r)) return;
    const bets = (await client.query<BetRow>(
      `SELECT * FROM sky_bets WHERE round_no = $1 AND status = 'ACTIVE' FOR UPDATE`, [no])).rows;
    for (const b of bets) await settleBet(client, b, verdictOf(b, r, now, false));
    await client.query(`UPDATE sky_rounds SET settled = true WHERE no = $1`, [no]);
  });
}

/* ---------------- what a player does ---------------- */

/** A bet on a round that hasn't taken off yet. The stake is taken now; the same key returns the same bet. */
export async function placeSkyBet(
  db: Pool, userId: string,
  input: { round_no?: unknown; panel?: unknown; stake?: unknown; auto?: unknown; idempotency_key?: unknown },
  opts: { now?: number } = {}
): Promise<{ bet: SkyBetView; balance: number }> {
  const now = opts.now ?? Date.now();
  const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
  if (key.length < 8 || key.length > 120) throw new GameError("invalid_idempotency_key", "A bet needs an idempotency_key");
  const replay = async (): Promise<{ bet: SkyBetView; balance: number } | null> => {
    const prior = (await db.query<BetRow>(`SELECT * FROM sky_bets WHERE idempotency_key = $1`, [key])).rows[0];
    if (!prior) return null;
    if (prior.user_id !== userId) throw new GameError("key_reused", "That bet key was already used", 409);
    return { bet: betView(prior), balance: await balanceOf(db, userId) };
  };
  const prior = await replay();
  if (prior) return prior;

  await assertGameOpen(db, SKY_ID);
  const no = roundNo(input.round_no);
  const r = Number.isNaN(no) ? undefined : await roundByNo(db, no);
  if (!r) throw new GameError("not_found", "That round wasn't found", 404);
  if (now >= startOf(r)) throw new GameError("too_late", "The plane has taken off — your bet goes on the next round.", 409);

  const panel = numeric(input.panel);
  if (panel !== 0 && panel !== 1) throw new GameError("invalid_panel", "Choose bet 1 or bet 2");
  const stake = Math.round(numeric(input.stake) * 100) / 100;
  const limits = await getSkySettings(db);
  if (!Number.isFinite(stake) || stake < limits.min_bet || stake > limits.max_bet) {
    throw new GameError("invalid_stake", `Bet between GHS ${limits.min_bet.toFixed(2)} and GHS ${limits.max_bet.toLocaleString("en-GH")}`);
  }
  await assertStakeAllowed(db, SKY_ID, stake, userId);
  let auto: number | null = null;
  if (input.auto !== undefined && input.auto !== null) {
    auto = Math.round(numeric(input.auto) * 100) / 100;
    if (!Number.isFinite(auto) || auto < 1.01 || auto > SKY_MAX_CRASH) {
      throw new GameError("invalid_auto", `Auto cash-out between 1.01x and ${SKY_MAX_CRASH.toLocaleString("en-GH")}x`);
    }
  }
  if ((await getLimits(db, userId)).excludedUntil) {
    throw new GameError("self_excluded", "You're taking a break, so real-money play is paused until it ends.", 403);
  }

  try {
    return await inTransaction(db, async (client) => {
      /* the round row, shared-locked: a bet that commits after the round was settled (a stalled request) would sit
         ACTIVE forever with its stake taken; settlement holds this row FOR UPDATE, so the two can't interleave */
      const live = (await client.query<{ settled: boolean }>(`SELECT settled FROM sky_rounds WHERE no = $1 FOR SHARE`, [no])).rows[0];
      if (!live || live.settled) throw new GameError("too_late", "That round is over — your bet goes on the next one.", 409);
      const bet = (await client.query<BetRow>(
        `INSERT INTO sky_bets (round_no, user_id, panel, stake, auto_target, idempotency_key, max_win)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [no, userId, panel, stake, auto, key, limits.max_win])).rows[0]!;
      await postMovement(client, {
        idempotencyKey: `bet:sky:${bet.id}`,
        entryType: "BET_PLACED",
        description: `${SKY_NAME} bet`,
        legs: [
          { userId, currencyCode: "GHS", direction: "DEBIT", amountMajor: stake },
          { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "CREDIT", amountMajor: stake },
        ],
      });
      return { bet: betView(bet), balance: await balanceOf(client, userId) };
    });
  } catch (e) {
    if (e instanceof Error && e.name === "InsufficientFundsError") {
      throw new GameError("insufficient_funds", "Not enough in your balance for that bet — deposit to keep playing.", 409);
    }
    if ((e as { code?: string }).code === "23505" || (e instanceof Error && e.name === "IdempotencyError")) {
      /* the same bet sent twice at once: the copy that lost the race gets the one that won it */
      const again = await replay();
      if (again) return again;
      throw new GameError("panel_busy", "That bet is already in this round", 409);
    }
    throw e;
  }
}

/** Locks one of the player's bets (and reads its round) for a cancel or cash-out, so a double tap is judged once. */
async function withBet<T>(
  db: Pool, userId: string, betId: unknown, fn: (client: PoolClient, bet: BetRow, round: RoundRow) => Promise<T>
): Promise<T> {
  const id = String(betId ?? "");
  if (!UUID.test(id)) throw new GameError("not_found", "That bet wasn't found", 404);
  return inTransaction(db, async (client) => {
    const bet = (await client.query<BetRow>(`SELECT * FROM sky_bets WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, userId])).rows[0];
    const round = bet && (await roundByNo(client, Number(bet.round_no)));
    if (!bet || !round) throw new GameError("not_found", "That bet wasn't found", 404);
    return fn(client, bet, round);
  });
}

export type SkyBetAnswer = { bet: SkyBetView; balance: number; crash?: number };
async function answer(client: PoolClient, bet: BetRow, round: RoundRow, now: number): Promise<SkyBetAnswer> {
  const over = now >= endOf(round);
  return { bet: betView(bet), balance: await balanceOf(client, bet.user_id), ...(over ? { crash: Number(round.crash) } : {}) };
}

/** Takes a bet back before take-off and returns the stake. */
export async function cancelSkyBet(
  db: Pool, userId: string, input: { bet_id?: unknown }, opts: { now?: number } = {}
): Promise<SkyBetAnswer> {
  const now = opts.now ?? Date.now();
  return withBet(db, userId, input.bet_id, async (client, bet, round) => {
    if (bet.status !== "ACTIVE") return answer(client, bet, round, now);
    if (now >= startOf(round)) throw new GameError("too_late", "The plane has taken off — cash out instead.", 409);
    const after = (await client.query<BetRow>(
      `UPDATE sky_bets SET status = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING *`, [bet.id])).rows[0]!;
    await postMovement(client, {
      idempotencyKey: `void:sky:${bet.id}`,
      entryType: "BET_VOID",
      description: `${SKY_NAME} bet cancelled`,
      legs: [
        { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: Number(bet.stake) },
        { userId, currencyCode: "GHS", direction: "CREDIT", amountMajor: Number(bet.stake) },
      ],
    });
    return answer(client, after, round, now);
  });
}

/**
 * Cash Out pressed (`auto` not true): pays the multiplier at `now`, if the plane is still flying. With `auto` true the
 * page is only asking whether its auto cash-out has come in yet; nothing is decided early.
 */
export async function cashOutSkyBet(
  db: Pool, userId: string, input: { bet_id?: unknown; auto?: unknown }, opts: { now?: number } = {}
): Promise<SkyBetAnswer> {
  const now = opts.now ?? Date.now();
  const manual = input.auto !== true;
  return withBet(db, userId, input.bet_id, async (client, bet, round) => {
    if (bet.status !== "ACTIVE") return answer(client, bet, round, now);
    if (manual && now < startOf(round)) throw new GameError("not_started", "The plane hasn't taken off — you can cancel instead.", 409);
    return answer(client, await settleBet(client, bet, verdictOf(bet, round, now, manual)), round, now);
  });
}

/* ---------------- what everyone sees ---------------- */

export interface SkyPublicBet {
  /** The player's name, masked: first and last character. */
  user: string;
  /** Which of the page's avatars the player gets (stable per player). */
  avatar: number;
  stake: number;
  /** Set once the bet has cashed out. */
  x: number | null;
  win: number;
}

export interface SkyBetsView {
  no: number;
  /** Bets in the round, players behind them, and how many of the bets have cashed out. */
  count: number;
  players: number;
  cashed: number;
  total_win: number;
  /** The biggest players' avatars, for the little crowd on the stage. */
  avatars: number[];
  /** The biggest bets (up to 100), cashed-out ones carrying their multiplier and win. */
  bets: SkyPublicBet[];
}

export const SKY_AVATARS = 24;
export function maskName(username: string | null | undefined, phone: string | null | undefined): string {
  const chars = [...String(username || phone || "player").replace(/\s+/g, "")];
  const first = chars[0] ?? "p";
  return (chars.length < 2 ? first + "***" : first + "***" + chars[chars.length - 1]).toLowerCase();
}
const avatarOf = (userId: string) => parseInt(sha256("sky-avatar:" + userId).slice(0, 8), 16) % SKY_AVATARS;

/**
 * Everybody's bets in a round. An auto cash-out shows as cashed out as soon as the multiplier has passed it on the
 * server's clock (it can't lose any more), so the list says nothing about the crash before it happens.
 */
export async function skyRoundBets(db: Db, no: number, now = Date.now()): Promise<SkyBetsView> {
  const r = await roundByNo(db, no);
  if (!r) throw new GameError("not_found", "That round wasn't found", 404);
  const rows = (await db.query<BetRow & { username: string | null; phone: string | null }>(
    `SELECT b.*, u.username, u.phone FROM sky_bets b JOIN users u ON u.id = b.user_id
      WHERE b.round_no = $1 AND b.status <> 'CANCELLED'`, [no])).rows;
  const shown = rows.map((b) => {
    let x = b.cashed_x === null ? null : Number(b.cashed_x);
    let win = Number(b.payout);
    if (b.status === "ACTIVE") {
      const v = verdictOf(b, r, now, false);
      if (v.status === "WON") {
        x = v.x;
        win = SKY.payout(Number(b.stake), v.x);
      }
    }
    return { userId: b.user_id, row: { user: maskName(b.username, b.phone), avatar: avatarOf(b.user_id), stake: Number(b.stake), x, win } };
  });
  shown.sort((a, b) => b.row.stake - a.row.stake || (b.row.win - a.row.win));
  const players = new Set(shown.map((s) => s.userId));
  const avatars: number[] = [];
  const seen = new Set<string>();
  for (const s of shown) {
    if (avatars.length >= 3) break;
    if (seen.has(s.userId)) continue;
    seen.add(s.userId);
    avatars.push(s.row.avatar);
  }
  return {
    no,
    count: shown.length,
    players: players.size,
    cashed: shown.filter((s) => s.row.x !== null).length,
    total_win: Math.round(shown.reduce((t, s) => t + s.row.win, 0) * 100) / 100,
    avatars,
    bets: shown.slice(0, 100).map((s) => s.row),
  };
}

export interface SkyTopEntry {
  user: string;
  avatar: number;
  stake: number;
  x: number;
  win: number;
  round_no: number;
  round_crash: number;
  at: number;
}
export interface SkyTopRound { no: number; crash: number; at: number; hash: string; seed: string }

const PERIOD_MS: Record<string, number> = { day: 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };

/** The leaderboards: the biggest wins or cash-out multipliers, or the highest rounds, over the last day/month/year. */
export async function skyTop(
  db: Db, by: string, period: string, now = Date.now()
): Promise<{ by: string; period: string; wins?: SkyTopEntry[]; rounds?: SkyTopRound[] }> {
  if (!Object.prototype.hasOwnProperty.call(PERIOD_MS, period)) throw new GameError("invalid_period", "Choose day, month or year");
  const since = new Date(now - PERIOD_MS[period]!);
  if (by === "rounds") {
    const rows = (await db.query<RoundRow>(
      `SELECT * FROM sky_rounds WHERE starts_at >= $2 AND ends_at <= $1 ORDER BY crash DESC, no DESC LIMIT 20`,
      [new Date(now), since])).rows.filter((r) => now >= endOf(r));
    return { by, period, rounds: rows.map((r) => ({ no: Number(r.no), crash: Number(r.crash), at: Math.ceil(endOf(r)), hash: r.hash, seed: r.seed })) };
  }
  if (by !== "wins" && by !== "multipliers") throw new GameError("invalid_board", "Choose wins, multipliers or rounds");
  const rows = (await db.query<BetRow & { username: string | null; phone: string | null; crash: string; starts_at: Date | string }>(
    `SELECT b.*, u.username, u.phone, r.crash, r.starts_at FROM sky_bets b
       JOIN users u ON u.id = b.user_id JOIN sky_rounds r ON r.no = b.round_no
      WHERE b.status = 'WON' AND r.starts_at >= $1
      ORDER BY ${by === "wins" ? "b.payout DESC, b.cashed_x DESC" : "b.cashed_x DESC, b.payout DESC"} LIMIT 20`, [since])).rows;
  return {
    by, period,
    wins: rows.map((b) => ({
      user: maskName(b.username, b.phone), avatar: avatarOf(b.user_id), stake: Number(b.stake), x: Number(b.cashed_x),
      win: Number(b.payout), round_no: Number(b.round_no), round_crash: Number(b.crash),
      at: new Date(b.starts_at).getTime(),
    })),
  };
}

/** The player's bets in a round (settling it first if it's over), and their balance. */
export async function mySkyBets(
  db: Pool, userId: string, no: unknown, now = Date.now()
): Promise<{ bets: SkyBetView[]; balance: number; round: SkyRoundView; avatar: number }> {
  const n = roundNo(no);
  const r = Number.isNaN(n) ? undefined : await roundByNo(db, n);
  if (!r) throw new GameError("not_found", "That round wasn't found", 404);
  if (now >= endOf(r) && !r.settled) await settleSkyRound(db, n, now);
  const bets = (await db.query<BetRow>(
    `SELECT * FROM sky_bets WHERE round_no = $1 AND user_id = $2 AND status <> 'CANCELLED' ORDER BY panel`, [n, userId])).rows;
  return { bets: bets.map(betView), balance: await balanceOf(db, userId), round: roundView(r, now), avatar: avatarOf(userId) };
}

/** Settles rounds whose players left before the end; clears out rounds older than a year that nobody bet on (rounds
 *  only run while someone has the game open, and the year's leaderboard needs them). */
export async function settleDueSkyRounds(db: Pool, now = Date.now()): Promise<number> {
  await db.query(
    `UPDATE sky_rounds r SET settled = true
      WHERE NOT r.settled AND r.ends_at <= $1
        AND NOT EXISTS (SELECT 1 FROM sky_bets b WHERE b.round_no = r.no AND b.status = 'ACTIVE')`, [new Date(now)]);
  const due = (await db.query<{ no: string }>(
    `SELECT no FROM sky_rounds WHERE NOT settled AND ends_at <= $1 ORDER BY no LIMIT 100`, [new Date(now)])).rows;
  /* one round that fails to settle must not hold up the rest */
  for (const { no } of due) {
    try {
      await settleSkyRound(db, Number(no), now);
    } catch (e) {
      console.error(`[sky-rush] round ${no} failed to settle: ${(e as Error).message}`);
    }
  }
  await db.query(
    `DELETE FROM sky_rounds r WHERE r.ends_at < $1 AND r.no < (SELECT max(no) - 100 FROM sky_rounds)
        AND NOT EXISTS (SELECT 1 FROM sky_bets b WHERE b.round_no = r.no)`, [new Date(now - 366 * 86400e3)]);
  return due.length;
}

export function startSkySweep(db: Pool): void {
  const run = () => settleDueSkyRounds(db).catch((e) => console.error("[sky-rush] sweep failed:", (e as Error).message));
  setInterval(run, 15_000).unref();
  void run();
}

/* ---------------- the live feed, for the routes ---------------- */

export interface SkyState {
  server_now: number;
  round: SkyRoundView;
  /** Finished rounds, newest first. */
  history: { no: number; crash: number }[];
  rules: { wait_ms: number; growth: number; rtp: number; min_bet: number; max_bet: number; max_crash: number; max_win: number };
}

/** The rules the page shows and plays by: the fixed curve, and the admin's published RTP and limits. */
async function rules(db: Db): Promise<SkyState["rules"]> {
  const s = await getSkySettings(db);
  return { wait_ms: SKY_WAIT_MS, growth: SKY_GROWTH, rtp: s.rtp, min_bet: s.min_bet, max_bet: s.max_bet, max_crash: SKY_MAX_CRASH, max_win: s.max_win };
}

/**
 * What the routes serve, with short caches in front of the database: every page asks for the same round, so one
 * query answers them all. A wait request is held until the plane flies away and then also carries the next round.
 */
export function createSkyLive(db: Pool, opts: { clock?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let current: RoundRow | null = null;
  let opening: Promise<RoundRow> | null = null;
  const recent = new Map<number, RoundRow>();
  const settling = new Map<number, Promise<void>>();
  let history: { below: number; rows: { no: number; crash: number }[] } | null = null;
  const betsCache = new Map<number, { at: number; view: Promise<SkyBetsView> }>();
  const topCache = new Map<string, { at: number; view: Promise<Awaited<ReturnType<typeof skyTop>>> }>();

  const remember = (r: RoundRow) => {
    recent.set(Number(r.no), r);
    if (recent.size > 60) recent.delete(recent.keys().next().value as number);
    return r;
  };

  async function round(): Promise<RoundRow> {
    if (current && clock() < endOf(current)) return current;
    if (!opening) {
      opening = currentSkyRound(db, clock()).then(remember).finally(() => { opening = null; });
    }
    current = await opening;
    return current;
  }

  async function byNo(no: unknown): Promise<RoundRow> {
    const n = roundNo(no);
    if (Number.isNaN(n)) throw new GameError("not_found", "That round wasn't found", 404);
    const known = recent.get(n);
    if (known) return known;
    const r = await roundByNo(db, n);
    if (!r) throw new GameError("not_found", "That round wasn't found", 404);
    return remember(r);
  }

  function settle(r: RoundRow, now: number): Promise<void> {
    const n = Number(r.no);
    if (r.settled) return Promise.resolve();
    let p = settling.get(n);
    if (!p) {
      p = settleSkyRound(db, n, now).then(() => { r.settled = true; })
        .catch((e) => { console.error(`[sky-rush] round ${n} failed to settle: ${(e as Error).message}`); })
        .finally(() => { settling.delete(n); });
      settling.set(n, p);
    }
    return p;
  }

  async function finished(below: number): Promise<{ no: number; crash: number }[]> {
    if (history && history.below === below) return history.rows;
    const rows = (await db.query<{ no: string; crash: string }>(
      `SELECT no, crash FROM sky_rounds WHERE no < $1 ORDER BY no DESC LIMIT 40`, [below])).rows
      .map((r) => ({ no: Number(r.no), crash: Number(r.crash) }));
    history = { below, rows };
    return rows;
  }

  return {
    async state(): Promise<SkyState> {
      const r = await round();
      const now = clock();
      return { server_now: now, round: roundView(r, now), history: await finished(Number(r.no)), rules: await rules(db) };
    },

    /** Held until round `no` is over (or MAX_WAIT_MS); once it is, the answer carries the crash and the next round. */
    async wait(no: unknown): Promise<{ server_now: number; round: SkyRoundView; next?: SkyRoundView }> {
      const r = await byNo(no);
      const left = endOf(r) - clock();
      if (left > 0) await sleep(Math.min(left + 5, MAX_WAIT_MS));
      const now = clock();
      if (now < endOf(r)) return { server_now: now, round: roundView(r, now) };
      void settle(r, now);
      const next = await round();
      return { server_now: clock(), round: roundView(r, now), next: roundView(next, clock()) };
    },

    /** One finished (or current) round's public facts, for checking it. */
    async roundInfo(no: unknown): Promise<SkyRoundView> {
      return roundView(await byNo(no), clock());
    },

    async bets(no: unknown): Promise<SkyBetsView & { server_now: number }> {
      const r = await byNo(no);
      const n = Number(r.no);
      const now = clock();
      const hit = betsCache.get(n);
      if (hit && now - hit.at < 700) return { ...(await hit.view), server_now: clock() };
      if (now >= endOf(r) && !r.settled) await settle(r, now);
      const view = skyRoundBets(db, n, now);
      betsCache.set(n, { at: now, view });
      view.catch(() => betsCache.delete(n));
      if (betsCache.size > 20) betsCache.delete(betsCache.keys().next().value as number);
      return { ...(await view), server_now: clock() };
    },

    async top(by: string, period: string) {
      const k = by + ":" + period;
      const now = clock();
      const hit = topCache.get(k);
      if (hit && now - hit.at < 30_000) return hit.view;
      const view = skyTop(db, by, period, now);
      topCache.set(k, { at: now, view });
      view.catch(() => topCache.delete(k));
      return view;
    },

    async mine(userId: string, no: unknown) {
      const r = await byNo(no);
      const now = clock();
      if (now >= endOf(r) && !r.settled) await settle(r, now);
      return mySkyBets(db, userId, r.no, now);
    },
  };
}
