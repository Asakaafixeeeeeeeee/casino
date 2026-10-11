import type { Pool, PoolClient } from "pg";
import { postMovement, SystemAccount } from "../services/balanceService.js";
import { getLimits } from "../services/responsibleGaming.js";
import { GameError, secureRandom, type Rng } from "./catalog.js";
import { assertGameOpen } from "./availability.js";

/*
 * Crash-style rounds (Crash, Knockout, Jet). Each player's rounds run on the server's clock: a round opens with a crash
 * point drawn here, takes bets for the game's waitMs, then the multiplier climbs (Crash and Knockout: e^(GROWTH ×
 * seconds); Jet: 0.06x a second) until the crash point.
 * The crash point is never sent while the round is running. A cash-out pays stake × the multiplier at the moment the
 * server receives it; auto cash-outs, the top-prize cap and ColorGo bets depend only on the crash point, so they're
 * settled even if the player has closed the page. The maths is the pages' own (crash.js / knockout.js / volta-jet):
 * P(crash ≥ m) = RTP ÷ m, so every cash-out plan returns the RTP.
 */

export const WAIT_MS = 5000;
export const GROWTH = 0.12;
export const MAX_CRASH = 10000;
/** The most one bet can win (the lobby's "max win"): a bet cashes itself out when it gets there. */
export const MAX_WIN = 250000;

interface Curve {
  /** The multiplier `ms` after take-off. */
  multiplierAt(ms: number): number;
  /** How long after take-off the multiplier reaches x. */
  flightMs(x: number): number;
  /** What a win of stake × x pays, to the cent. */
  payout(stake: number, x: number): number;
}

export interface FlightGame extends Curve {
  id: string;
  name: string;
  rtp: number;
  minBet: number;
  maxBet: number;
  /** Knockout's ColorGo: bet on the colour the round ends in. */
  colours: boolean;
  /** How long a round takes bets before take-off. */
  waitMs: number;
  /** The highest crash point; a bet still riding when a round gets there is paid at it. */
  maxCrash: number;
  /** The most one bet can win, if not MAX_WIN. */
  maxWin?: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
export const multiplierAt = (ms: number) => Math.max(1, Math.floor(Math.exp((GROWTH * ms) / 1000) * 100) / 100);
export const flightMs = (x: number) => (Math.log(x) / GROWTH) * 1000;
/* a cash-out pays down to the cent: rounding to the nearest cent made 0.10 at 1.05x pay 0.11 (EV over 100%) */
const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
const exponential: Curve = { multiplierAt, flightMs, payout: (stake, x) => floor2(stake * x) };

/* Jet: up 0.001 every 1/60 s (0.06x a second), to three decimals; a win is rounded down to the cent, as on the page */
const JET_STEPS_PER_MS = 0.06;
const linear: Curve = {
  multiplierAt: (ms) => (1000 + Math.floor(Math.max(0, ms) * JET_STEPS_PER_MS)) / 1000,
  flightMs: (x) => Math.round((x - 1) * 1000) / JET_STEPS_PER_MS,
  payout: (stake, x) => Math.floor((Math.round(stake * 100) * Math.round(x * 1000)) / 1000) / 100,
};

export const FLIGHT_GAMES: Record<string, FlightGame> = {
  "volta-crash": { id: "volta-crash", name: "Crash", rtp: 0.9923, minBet: 1, maxBet: 1000, colours: false,
    waitMs: WAIT_MS, maxCrash: MAX_CRASH, ...exponential },
  "volta-knockout": { id: "volta-knockout", name: "Knockout", rtp: 0.97, minBet: 0.1, maxBet: 1000, colours: true,
    waitMs: WAIT_MS, maxCrash: MAX_CRASH, ...exponential },
  "volta-jet": { id: "volta-jet", name: "Jet", rtp: 0.98, minBet: 0.1, maxBet: 1000, colours: false,
    waitMs: 8000, maxCrash: 10.7, ...linear },
};

type Colour = "blue" | "purple" | "red";
type Kind = "classic" | Colour;

/** P(crash ≥ m) = RTP ÷ m up to the top; the draws below 1 are an instant 1.00x crash — that's the house edge. */
export function crashPoint(rtp: number, rng: Rng, max = MAX_CRASH): number {
  return Math.min(max, Math.max(1, Math.floor((100 * rtp) / (1 - rng())) / 100));
}

/** ColorGo: Blue ends below 2x, Purple 2x–9.99x, Red 10x or more; each pays RTP ÷ its chance, rounded down. */
export function colours(rtp: number): Record<Colour, { pay: number; test: (x: number) => boolean }> {
  const pay = (p: number) => Math.floor((100 * rtp) / p + 1e-9) / 100;
  return {
    blue: { pay: pay(1 - rtp / 2), test: (x) => x < 2 },
    purple: { pay: pay(rtp / 2 - rtp / 10), test: (x) => x >= 2 && x < 10 },
    red: { pay: pay(rtp / 10), test: (x) => x >= 10 },
  };
}

/** A bet cashes itself out where it would win the maximum win (MAX_WIN unless the game sets its own), or at the top. */
export const capOf = (stake: number, maxCrash = MAX_CRASH, maxWin = MAX_WIN) =>
  Math.min(maxCrash, Math.floor((maxWin / stake) * 100 + 1e-9) / 100);

export type Verdict = { status: "WON"; x: number } | { status: "LOST" } | { status: "ACTIVE" };

/**
 * Decides a bet at server time `now` (ms). `manual` = the player pressed Cash Out; otherwise only what the crash
 * point already settles (auto cash-out reached, cap reached, colour decided, or the round over) is decided.
 */
export function judge(
  game: FlightGame,
  bet: { stake: number; kind: Kind; auto: number | null },
  flight: { crash: number; startsAt: number },
  now: number,
  manual: boolean
): Verdict {
  const { crash, startsAt } = flight;
  const over = now >= startsAt + game.flightMs(crash);
  if (bet.kind !== "classic") {
    const c = colours(game.rtp)[bet.kind];
    if (bet.kind === "red" && crash >= 10 && now >= startsAt + game.flightMs(10)) return { status: "WON", x: c.pay };
    if (!over) return { status: "ACTIVE" };
    return c.test(crash) ? { status: "WON", x: c.pay } : { status: "LOST" };
  }
  const target = Math.min(bet.auto ?? Infinity, capOf(bet.stake, game.maxCrash, game.maxWin));
  if (target <= crash && now >= startsAt + game.flightMs(target)) return { status: "WON", x: target };
  if (over) return { status: "LOST" };
  if (manual && now >= startsAt) return { status: "WON", x: game.multiplierAt(now - startsAt) };
  return { status: "ACTIVE" };
}

/* ---------------- storage ---------------- */

interface FlightRow { id: string; user_id: string; game: string; crash: string; starts_at: Date | string; settled: boolean }
interface BetRow {
  id: string; flight_id: string; user_id: string; panel: number; stake: string; kind: Kind; auto_target: string | null;
  status: "ACTIVE" | "WON" | "LOST" | "CANCELLED"; cashed_x: string | null; payout: string;
}

export interface BetView {
  bet_id: string;
  flight_id: string;
  panel: number;
  stake: number;
  kind: Kind;
  /** Where the bet cashes itself out: the player's auto cash-out or the top-prize cap, whichever is lower. */
  auto_x: number | null;
  status: BetRow["status"];
  /** The multiplier it was paid at. */
  x: number | null;
  payout: number;
}

export interface FlightView {
  flight_id: string;
  game: string;
  /** Milliseconds until take-off; negative once the round is under way. */
  starts_in_ms: number;
  over: boolean;
  /** Only once the round is over. */
  crash?: number;
  bets: BetView[];
  balance: number;
}

type Db = Pool | PoolClient;
const startOf = (f: FlightRow) => new Date(f.starts_at).getTime();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function gameOf(gameId: string): FlightGame {
  const g = Object.prototype.hasOwnProperty.call(FLIGHT_GAMES, gameId) ? FLIGHT_GAMES[gameId] : undefined;
  if (!g) throw new GameError("unknown_game", "This game can't be played for real money yet", 404);
  return g;
}

async function balanceOf(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ available: string }>(
    `SELECT available FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId]);
  return Number(rows[0]?.available ?? 0);
}

function betView(game: FlightGame, b: BetRow): BetView {
  const stake = Number(b.stake);
  return {
    bet_id: b.id,
    flight_id: b.flight_id,
    panel: b.panel,
    stake,
    kind: b.kind,
    auto_x: b.kind === "classic" ? Math.min(b.auto_target === null ? Infinity : Number(b.auto_target), capOf(stake, game.maxCrash)) : null,
    status: b.status,
    x: b.cashed_x === null ? null : Number(b.cashed_x),
    payout: Number(b.payout),
  };
}

async function flightView(db: Db, f: FlightRow, now: number): Promise<FlightView> {
  const game = gameOf(f.game);
  const crash = Number(f.crash);
  const over = now >= startOf(f) + game.flightMs(crash);
  const bets = (await db.query<BetRow>(
    `SELECT * FROM crash_bets WHERE flight_id = $1 AND status <> 'CANCELLED' ORDER BY panel`, [f.id])).rows;
  return {
    flight_id: f.id,
    game: f.game,
    starts_in_ms: Math.round(startOf(f) - now),
    over,
    ...(over ? { crash } : {}),
    bets: bets.map((b) => betView(game, b)),
    balance: await balanceOf(db, f.user_id),
  };
}

/** Settles one bet as the verdict says, once: only an ACTIVE bet changes, and a win is posted to the ledger. */
async function settleBet(client: PoolClient, game: FlightGame, bet: BetRow, v: Verdict): Promise<BetRow> {
  if (v.status === "ACTIVE") return bet;
  const payout = v.status === "WON" ? game.payout(Number(bet.stake), v.x) : 0;
  const { rows } = await client.query<BetRow>(
    `UPDATE crash_bets SET status = $2, cashed_x = $3, payout = $4, updated_at = now()
      WHERE id = $1 AND status = 'ACTIVE' RETURNING *`,
    [bet.id, v.status, v.status === "WON" ? v.x : null, payout]
  );
  if (!rows[0]) return bet;
  if (payout > 0) {
    await postMovement(client, {
      idempotencyKey: `win:flight:${bet.id}`,
      entryType: "BET_SETTLED",
      description: `${game.name} win`,
      legs: [
        { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: payout },
        { userId: bet.user_id, currencyCode: "GHS", direction: "CREDIT", amountMajor: payout },
      ],
    });
  }
  return rows[0];
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

/** Settles everything a finished round decides: auto cash-outs and colours that came in are paid, the rest lost. */
export async function settleFlight(db: Pool, flightId: string, now = Date.now()): Promise<void> {
  await inTransaction(db, async (client) => {
    const f = (await client.query<FlightRow>(`SELECT * FROM crash_flights WHERE id = $1 FOR UPDATE`, [flightId])).rows[0];
    if (!f || f.settled) return;
    const game = gameOf(f.game);
    if (now < startOf(f) + game.flightMs(Number(f.crash))) return;
    const bets = (await client.query<BetRow>(
      `SELECT * FROM crash_bets WHERE flight_id = $1 AND status = 'ACTIVE' FOR UPDATE`, [f.id])).rows;
    for (const b of bets) {
      const v = judge(game, { stake: Number(b.stake), kind: b.kind, auto: b.auto_target === null ? null : Number(b.auto_target) },
        { crash: Number(f.crash), startsAt: startOf(f) }, now, false);
      await settleBet(client, game, b, v);
    }
    await client.query(`UPDATE crash_flights SET settled = true WHERE id = $1`, [f.id]);
  });
}

/* ---------------- what the routes call ---------------- */

/**
 * The player's round: the one under way (so a reload carries on), or a new one taking bets for the game's waitMs.
 * `history` is the crash points of the player's last rounds.
 */
export async function nextFlight(
  db: Pool, userId: string, gameId: string, opts: { now?: number; rng?: Rng } = {}
): Promise<FlightView & { history: number[] }> {
  const game = gameOf(gameId);
  const now = opts.now ?? Date.now();
  const latest = (await db.query<FlightRow>(
    `SELECT * FROM crash_flights WHERE user_id = $1 AND game = $2 ORDER BY starts_at DESC LIMIT 1`, [userId, gameId])).rows[0];
  let flight = latest;
  if (!latest || now >= startOf(latest) + game.flightMs(Number(latest.crash))) {
    if (latest && !latest.settled) await settleFlight(db, latest.id, now);
    await assertGameOpen(db, gameId); /* switched off by an admin: no new rounds (one in the air still ends) */
    const crash = crashPoint(game.rtp, opts.rng ?? secureRandom, game.maxCrash);
    const startsAt = now + game.waitMs;
    flight = (await db.query<FlightRow>(
      `INSERT INTO crash_flights (user_id, game, crash, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userId, gameId, crash, new Date(startsAt), new Date(Math.ceil(startsAt + game.flightMs(crash)))]
    )).rows[0]!;
  }
  const history = (await db.query<{ crash: string }>(
    `SELECT crash FROM crash_flights WHERE user_id = $1 AND game = $2 AND ends_at <= $3 ORDER BY starts_at DESC LIMIT 30`,
    [userId, gameId, new Date(now)])).rows.map((r) => Number(r.crash));
  return { ...(await flightView(db, flight!, now)), history };
}

/** A bet on a round that hasn't taken off yet. The stake is taken now; the same key returns the same bet. */
export async function placeFlightBet(
  db: Pool, userId: string, gameId: string,
  input: { flight_id?: unknown; panel?: unknown; stake?: unknown; kind?: unknown; auto?: unknown; idempotency_key?: unknown },
  opts: { now?: number } = {}
): Promise<{ bet: BetView; balance: number }> {
  const game = gameOf(gameId);
  const now = opts.now ?? Date.now();
  const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
  if (key.length < 8) throw new GameError("invalid_idempotency_key", "A bet needs an idempotency_key");
  const prior = (await db.query<BetRow & { game: string }>(
    `SELECT b.*, f.game FROM crash_bets b JOIN crash_flights f ON f.id = b.flight_id WHERE b.idempotency_key = $1`, [key])).rows[0];
  if (prior) {
    if (prior.user_id !== userId || prior.game !== gameId) throw new GameError("key_reused", "That bet key was already used", 409);
    return { bet: betView(game, prior), balance: await balanceOf(db, userId) };
  }

  await assertGameOpen(db, gameId);
  const flightId = String(input.flight_id ?? "");
  const f = UUID.test(flightId) ? (await db.query<FlightRow>(
    `SELECT * FROM crash_flights WHERE id = $1 AND user_id = $2 AND game = $3`, [flightId, userId, gameId])).rows[0] : undefined;
  if (!f) throw new GameError("not_found", "That round wasn't found", 404);
  if (now >= startOf(f)) throw new GameError("too_late", "This round has already started — your bet goes on the next one.", 409);

  const panel = Number(input.panel);
  if (panel !== 0 && panel !== 1) throw new GameError("invalid_panel", "Choose bet 1 or bet 2");
  const kind = (input.kind ?? "classic") as Kind;
  if (!(kind === "classic" || (game.colours && (kind === "blue" || kind === "purple" || kind === "red")))) {
    throw new GameError("invalid_kind", "That kind of bet isn't offered here");
  }
  const stake = round2(Number(input.stake));
  if (!Number.isFinite(stake) || stake < game.minBet || stake > game.maxBet) {
    throw new GameError("invalid_stake", `Bet between GHS ${game.minBet} and GHS ${game.maxBet.toLocaleString("en-GH")}`);
  }
  let auto: number | null = null;
  if (input.auto !== undefined && input.auto !== null) {
    auto = round2(Number(input.auto));
    if (kind !== "classic" || !Number.isFinite(auto) || auto < 1.01 || auto > MAX_CRASH) {
      throw new GameError("invalid_auto", `Auto cash-out between 1.01x and ${MAX_CRASH}x`);
    }
  }
  if ((await getLimits(db, userId)).excludedUntil) {
    throw new GameError("self_excluded", "You're taking a break, so real-money play is paused until it ends.", 403);
  }

  try {
    return await inTransaction(db, async (client) => {
      /* the flight row, shared-locked: a bet that commits after the flight was settled (a stalled request) would sit
         ACTIVE forever with its stake taken; settlement holds this row FOR UPDATE, so the two can't interleave */
      const live = (await client.query<{ settled: boolean }>(`SELECT settled FROM crash_flights WHERE id = $1 FOR SHARE`, [f.id])).rows[0];
      if (!live || live.settled) throw new GameError("too_late", "That flight is over — your bet goes on the next one.", 409);
      const bet = (await client.query<BetRow>(
        `INSERT INTO crash_bets (flight_id, user_id, panel, stake, kind, auto_target, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [f.id, userId, panel, stake, kind, auto, key])).rows[0]!;
      await postMovement(client, {
        idempotencyKey: `bet:flight:${bet.id}`,
        entryType: "BET_PLACED",
        description: `${game.name} bet`,
        legs: [
          { userId, currencyCode: "GHS", direction: "DEBIT", amountMajor: stake },
          { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "CREDIT", amountMajor: stake },
        ],
      });
      return { bet: betView(game, bet), balance: await balanceOf(client, userId) };
    });
  } catch (e) {
    if (e instanceof Error && e.name === "InsufficientFundsError") {
      throw new GameError("insufficient_funds", "Not enough in your balance for that bet — deposit to keep playing.", 409);
    }
    if ((e as { code?: string }).code === "23505") throw new GameError("panel_busy", "That bet is already in this round", 409);
    throw e;
  }
}

/** Locks one of the player's bets (and reads its round) for a cancel or cash-out, so a double tap is judged once. */
async function withBet<T>(
  db: Pool, userId: string, gameId: string, betId: unknown,
  fn: (client: PoolClient, game: FlightGame, bet: BetRow, flight: FlightRow) => Promise<T>
): Promise<T> {
  const game = gameOf(gameId);
  const id = String(betId ?? "");
  if (!UUID.test(id)) throw new GameError("not_found", "That bet wasn't found", 404);
  return inTransaction(db, async (client) => {
    const bet = (await client.query<BetRow>(`SELECT * FROM crash_bets WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, userId])).rows[0];
    const flight = bet && (await client.query<FlightRow>(
      `SELECT * FROM crash_flights WHERE id = $1 AND game = $2`, [bet.flight_id, gameId])).rows[0];
    if (!bet || !flight) throw new GameError("not_found", "That bet wasn't found", 404);
    return fn(client, game, bet, flight);
  });
}

type BetAnswer = { bet: BetView; balance: number; crash?: number };
async function answer(client: PoolClient, bet: BetRow, flight: FlightRow, now: number): Promise<BetAnswer> {
  const game = gameOf(flight.game);
  const crash = Number(flight.crash);
  const over = now >= startOf(flight) + game.flightMs(crash);
  return { bet: betView(game, bet), balance: await balanceOf(client, bet.user_id), ...(over ? { crash } : {}) };
}

/** Takes a bet back before take-off and returns the stake. */
export async function cancelFlightBet(
  db: Pool, userId: string, gameId: string, input: { bet_id?: unknown }, opts: { now?: number } = {}
): Promise<BetAnswer> {
  const now = opts.now ?? Date.now();
  return withBet(db, userId, gameId, input.bet_id, async (client, game, bet, flight) => {
    if (bet.status !== "ACTIVE") return answer(client, bet, flight, now);
    if (now >= startOf(flight)) throw new GameError("too_late", "The round has started — cash out instead.", 409);
    const after = (await client.query<BetRow>(
      `UPDATE crash_bets SET status = 'CANCELLED', updated_at = now() WHERE id = $1 RETURNING *`, [bet.id])).rows[0]!;
    await postMovement(client, {
      idempotencyKey: `void:flight:${bet.id}`,
      entryType: "BET_VOID",
      description: `${game.name} bet cancelled`,
      legs: [
        { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: Number(bet.stake) },
        { userId, currencyCode: "GHS", direction: "CREDIT", amountMajor: Number(bet.stake) },
      ],
    });
    return answer(client, after, flight, now);
  });
}

/**
 * Cash Out pressed (`auto` false): pays the multiplier at `now`, if the round is still going. With `auto` true the
 * page is only asking whether its auto cash-out (or colour) has come in yet; nothing is decided early.
 */
export async function cashOutFlightBet(
  db: Pool, userId: string, gameId: string, input: { bet_id?: unknown; auto?: unknown }, opts: { now?: number } = {}
): Promise<BetAnswer> {
  const now = opts.now ?? Date.now();
  const manual = input.auto !== true;
  return withBet(db, userId, gameId, input.bet_id, async (client, game, bet, flight) => {
    if (bet.status !== "ACTIVE") return answer(client, bet, flight, now);
    if (manual && now < startOf(flight)) throw new GameError("not_started", "The round hasn't started — you can cancel instead.", 409);
    if (manual && bet.kind !== "classic") throw new GameError("colour_bet", "Colour bets are settled at the knockout.", 409);
    const v = judge(game, { stake: Number(bet.stake), kind: bet.kind, auto: bet.auto_target === null ? null : Number(bet.auto_target) },
      { crash: Number(flight.crash), startsAt: startOf(flight) }, now, manual);
    return answer(client, await settleBet(client, game, bet, v), flight, now);
  });
}

/**
 * Holds the request until the round ends (or `maxWaitMs`), then reports it. Once it's over this settles the round,
 * so the answer carries the crash point, every bet's result and the balance.
 */
export async function waitFlight(
  db: Pool, userId: string, gameId: string, flightId: unknown,
  opts: { clock?: () => number; sleep?: (ms: number) => Promise<void>; maxWaitMs?: number } = {}
): Promise<FlightView> {
  const game = gameOf(gameId);
  const clock = opts.clock ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const id = String(flightId ?? "");
  const f = UUID.test(id) ? (await db.query<FlightRow>(
    `SELECT * FROM crash_flights WHERE id = $1 AND user_id = $2 AND game = $3`, [id, userId, gameId])).rows[0] : undefined;
  if (!f) throw new GameError("not_found", "That round wasn't found", 404);
  const endsAt = startOf(f) + game.flightMs(Number(f.crash));
  const left = endsAt - clock();
  if (left > 0) await sleep(Math.min(left + 5, opts.maxWaitMs ?? 25000));
  const now = clock();
  if (now >= endsAt) await settleFlight(db, f.id, now);
  return flightView(db, f, now);
}

/** Settles rounds whose players left before the end, and clears out old rounds nobody bet on. */
export async function settleDueFlights(db: Pool, now = Date.now()): Promise<number> {
  await db.query(
    `UPDATE crash_flights f SET settled = true
      WHERE NOT f.settled AND f.ends_at <= $1
        AND NOT EXISTS (SELECT 1 FROM crash_bets b WHERE b.flight_id = f.id AND b.status = 'ACTIVE')`, [new Date(now)]);
  const due = (await db.query<{ id: string }>(
    `SELECT id FROM crash_flights WHERE NOT settled AND ends_at <= $1 ORDER BY ends_at LIMIT 200`, [new Date(now)])).rows;
  /* one flight that fails to settle must not hold up every flight after it */
  for (const { id } of due) {
    try {
      await settleFlight(db, id, now);
    } catch (e) {
      console.error(`[flights] flight ${id} failed to settle: ${(e as Error).message}`);
    }
  }
  await db.query(
    `DELETE FROM crash_flights f WHERE f.ends_at < $1
        AND NOT EXISTS (SELECT 1 FROM crash_bets b WHERE b.flight_id = f.id)`, [new Date(now - 24 * 3600e3)]);
  return due.length;
}

export function startFlightSweep(db: Pool): void {
  const run = () => settleDueFlights(db).catch((e) => console.error("[flights] sweep failed:", (e as Error).message));
  setInterval(run, 30_000).unref();
  void run();
}
