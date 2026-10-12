import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { postMovement, SystemAccount } from "../services/balanceService.js";
import { getLimits } from "../services/responsibleGaming.js";
import { GameError } from "./catalog.js";
import { assertGameOpen, assertStakeAllowed } from "./availability.js";

/*
 * Rendo Mines Live with real money. Everyone plays the same 5×5 board (6 mines) in 3-minute rounds that follow the
 * clock: round n runs from n × 180 s to (n + 1) × 180 s after the epoch. The seed is drawn here when a round is first
 * asked for and stays secret until it ends; the mines come from it by the live server's own shuffle (mines-live/
 * maths.js, which a test keeps identical). A bet locks in 1–19 tiles and a stake; at 0:00 it pays stake × the
 * multiplier for that many tiles if every tile is a star. The Mines Live server shows the board, the timer and the
 * crowd and passes real players' bets on with their own sign-in; every money decision is made here.
 */

export const LIVE_ROUND_MS = 180_000;
export const LIVE_CUTOFF_MS = 10_000;   // no bets or cancels in a round's last 10 seconds
export const LIVE_TILES = 25;
export const LIVE_MINES = 6;
export const LIVE_MIN_BET = 0.1;
export const LIVE_MAX_BET = 100;
export const LIVE_MAX_WIN = 10_000;

/** 96.5% ÷ P(k tiles all stars), rounded half up to the cent (exact, with BigInt). */
export const LIVE_MULT: number[] = (() => {
  const m = [1];
  let num = 1n;
  let den = 1n;
  for (let k = 1; k <= LIVE_TILES - LIVE_MINES; k++) {
    num *= BigInt(LIVE_TILES - LIVE_MINES - (k - 1));
    den *= BigInt(LIVE_TILES - (k - 1));
    m[k] = Number((386n * den + 2n * num) / (4n * num)) / 100;
  }
  return m;
})();

/** A deterministic shuffle driven by HMAC-SHA256(seed, "mines:" + round + ":" + counter) — anyone holding the
 *  published seed can re-derive the same mines. */
export function minesFromSeed(seed: string, roundNo: number): number[] {
  const order = Array.from({ length: LIVE_TILES }, (_, i) => i);
  let counter = 0;
  let pool: number[] = [];
  const nextInt = (n: number) => {
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      if (pool.length < 4) pool = pool.concat([...crypto.createHmac("sha256", seed).update("mines:" + roundNo + ":" + counter++).digest()]);
      const v = ((pool[0]! << 24) | (pool[1]! << 16) | (pool[2]! << 8) | pool[3]!) >>> 0;
      pool = pool.slice(4);
      if (v < limit) return v % n;
    }
  };
  for (let i = LIVE_TILES - 1; i > 0; i--) {
    const j = nextInt(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order.slice(0, LIVE_MINES).sort((a, b) => a - b);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const liveRoundAt = (now: number) => Math.floor(now / LIVE_ROUND_MS);
const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
/* down to the cent, like every payout */
export const livePayout = (stake: number, tiles: number) => Math.min(LIVE_MAX_WIN, floor2(stake * LIVE_MULT[tiles]!));

interface RoundRow { no: string; seed: string; hash: string; starts_at: Date | string; ends_at: Date | string; settled: boolean }
interface BetRow {
  id: string; round_no: string; user_id: string; stake: string; picks: number[];
  status: "OPEN" | "WON" | "LOST" | "VOID"; payout: string;
}
type Db = Pool | PoolClient;
const endOf = (r: RoundRow) => new Date(r.ends_at).getTime();

export interface LiveRoundView {
  no: number;
  hash: string;
  starts_at: number;
  ends_at: number;
  server_now: number;
  mines: number;
  cutoff_ms: number;
  mult: number[];
  /** Once the round is over: the seed and the mines it gives. */
  seed?: string;
  mine_tiles?: number[];
}

export interface LiveBetView {
  bet_id: string;
  round_no: number;
  stake: number;
  picks: number[];
  mult: number;
  status: BetRow["status"];
  win: number;
  /** Once settled: the picked tiles that were mines. */
  hit?: number[];
}

function roundView(r: RoundRow, now: number): LiveRoundView {
  const over = now >= endOf(r);
  const no = Number(r.no);
  return {
    no,
    hash: r.hash,
    starts_at: new Date(r.starts_at).getTime(),
    ends_at: endOf(r),
    server_now: now,
    mines: LIVE_MINES,
    cutoff_ms: LIVE_CUTOFF_MS,
    mult: LIVE_MULT,
    ...(over ? { seed: r.seed, mine_tiles: minesFromSeed(r.seed, no) } : {}),
  };
}

function betView(b: BetRow, round?: RoundRow): LiveBetView {
  const picks = b.picks.map(Number);
  const settled = b.status === "WON" || b.status === "LOST";
  const mines = settled && round ? minesFromSeed(round.seed, Number(round.no)) : null;
  return {
    bet_id: b.id,
    round_no: Number(b.round_no),
    stake: Number(b.stake),
    picks,
    mult: LIVE_MULT[picks.length]!,
    status: b.status,
    win: Number(b.payout),
    ...(mines ? { hit: picks.filter((t) => mines.includes(t)) } : {}),
  };
}

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

/** The round in play and the one after it, both drawn (so the admin signal can show the next board before its
 *  countdown starts; the seed stays secret from players until the round ends). */
export async function ensureUpcomingLiveRounds(db: Pool, now = Date.now()): Promise<void> {
  const no = liveRoundAt(now);
  await ensureRound(db, no);
  await ensureRound(db, no + 1);
}

/** Round n, with its seed drawn the first time anyone asks for it. */
async function ensureRound(db: Db, no: number): Promise<RoundRow> {
  const seed = crypto.randomBytes(32).toString("hex");
  await db.query(
    `INSERT INTO mines_live_rounds (no, seed, hash, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (no) DO NOTHING`,
    [no, seed, sha256(seed), new Date(no * LIVE_ROUND_MS), new Date((no + 1) * LIVE_ROUND_MS)]);
  return (await db.query<RoundRow>(`SELECT * FROM mines_live_rounds WHERE no = $1`, [no])).rows[0]!;
}

/** Settles a finished round once: every open bet wins (all its tiles stars) or loses. */
export async function settleLiveRound(db: Pool, no: number, now = Date.now()): Promise<void> {
  await inTransaction(db, async (client) => {
    const r = (await client.query<RoundRow>(`SELECT * FROM mines_live_rounds WHERE no = $1 FOR UPDATE`, [no])).rows[0];
    if (!r || r.settled || now < endOf(r)) return;
    const mines = minesFromSeed(r.seed, no);
    const bets = (await client.query<BetRow>(
      `SELECT * FROM mines_live_bets WHERE round_no = $1 AND status = 'OPEN' FOR UPDATE`, [no])).rows;
    for (const b of bets) {
      const picks = b.picks.map(Number);
      const won = !picks.some((t) => mines.includes(t));
      const payout = won ? livePayout(Number(b.stake), picks.length) : 0;
      await client.query(`UPDATE mines_live_bets SET status = $2, payout = $3, updated_at = now() WHERE id = $1`,
        [b.id, won ? "WON" : "LOST", payout]);
      if (payout > 0) {
        await postMovement(client, {
          idempotencyKey: `win:live:${b.id}`,
          entryType: "BET_SETTLED",
          description: "Live Mines win",
          legs: [
            { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: payout },
            { userId: b.user_id, currencyCode: "GHS", direction: "CREDIT", amountMajor: payout },
          ],
        });
      }
    }
    await client.query(`UPDATE mines_live_rounds SET settled = true WHERE no = $1`, [no]);
  });
}

/* ---------------- what the routes call ---------------- */

/** The round in play now: its number, the seed's hash and when it ends (never the seed). */
export async function currentLiveRound(db: Pool, now = Date.now()): Promise<LiveRoundView> {
  return roundView(await ensureRound(db, liveRoundAt(now)), now);
}

/** Any round up to now; once it's over this settles it and includes the seed and the mines. */
export async function liveRound(db: Pool, no: unknown, now = Date.now()): Promise<LiveRoundView> {
  const n = Number(no);
  const current = liveRoundAt(now);
  if (!Number.isSafeInteger(n) || n > current) throw new GameError("not_found", "That round hasn't started", 404);
  const r = n === current ? await ensureRound(db, n)
    : (await db.query<RoundRow>(`SELECT * FROM mines_live_rounds WHERE no = $1`, [n])).rows[0];
  if (!r) throw new GameError("not_found", "Nobody played that round", 404);
  if (now >= endOf(r) && !r.settled) await settleLiveRound(db, n, now);
  return roundView(r, now);
}

/** A real-money bet on the current round: the stake goes now, the result comes at 0:00. */
export async function placeLiveBet(
  db: Pool, userId: string,
  input: { round_no?: unknown; picks?: unknown; stake?: unknown; idempotency_key?: unknown },
  opts: { now?: number } = {}
): Promise<{ bet: LiveBetView; balance: number }> {
  const now = opts.now ?? Date.now();
  const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
  if (key.length < 8) throw new GameError("invalid_idempotency_key", "A bet needs an idempotency_key");
  const prior = (await db.query<BetRow>(`SELECT * FROM mines_live_bets WHERE idempotency_key = $1`, [key])).rows[0];
  if (prior) {
    if (prior.user_id !== userId) throw new GameError("key_reused", "That bet key was already used", 409);
    return { bet: betView(prior), balance: await balanceOf(db, userId) };
  }

  await assertGameOpen(db, "volta-mines-live");
  const no = liveRoundAt(now);
  if (Number(input.round_no) !== no) throw new GameError("round_over", "That round is over — bet on the current one.", 409);
  if ((no + 1) * LIVE_ROUND_MS - now < LIVE_CUTOFF_MS) {
    throw new GameError("too_late", "This round is about to end — bet in the next one.", 409);
  }
  const picks = input.picks;
  if (!Array.isArray(picks) || !picks.length) throw new GameError("invalid_picks", "Choose at least one tile.");
  if (new Set(picks).size !== picks.length || picks.some((t) => !Number.isInteger(t) || t < 0 || t >= LIVE_TILES)) {
    throw new GameError("invalid_picks", "Those tiles don't look right.");
  }
  if (picks.length > LIVE_TILES - LIVE_MINES) throw new GameError("invalid_picks", `At most ${LIVE_TILES - LIVE_MINES} tiles.`);
  const stake = round2(Number(input.stake));
  if (!Number.isFinite(stake) || stake < LIVE_MIN_BET || stake > LIVE_MAX_BET) {
    throw new GameError("invalid_stake", `Bets are GHS ${LIVE_MIN_BET.toFixed(2)} – ${LIVE_MAX_BET.toFixed(2)}.`);
  }
  await assertStakeAllowed(db, "volta-mines-live", stake, userId);
  if ((await getLimits(db, userId)).excludedUntil) {
    throw new GameError("self_excluded", "You're taking a break, so real-money play is paused until it ends.", 403);
  }
  await ensureRound(db, no);

  try {
    return await inTransaction(db, async (client) => {
      /* the round row, shared-locked: a bet that commits after the round was settled (a stalled request) would stay
         OPEN forever with its stake taken; settlement holds this row FOR UPDATE, so the two can't interleave */
      const live = (await client.query<{ settled: boolean }>(`SELECT settled FROM mines_live_rounds WHERE no = $1 FOR SHARE`, [no])).rows[0];
      if (!live || live.settled) throw new GameError("too_late", "This round is over — bet in the next one.", 409);
      const bet = (await client.query<BetRow>(
        `INSERT INTO mines_live_bets (round_no, user_id, stake, picks, idempotency_key) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [no, userId, stake, JSON.stringify(picks), key])).rows[0]!;
      await postMovement(client, {
        idempotencyKey: `bet:live:${bet.id}`,
        entryType: "BET_PLACED",
        description: "Live Mines bet",
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
    if ((e as { code?: string }).code === "23505") {
      throw new GameError("already_bet", "You've already bet this round — wait for the next one.", 409);
    }
    throw e;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Takes a bet back, with its stake, until the round's last 10 seconds. */
export async function cancelLiveBet(
  db: Pool, userId: string, input: { bet_id?: unknown }, opts: { now?: number } = {}
): Promise<{ bet: LiveBetView; balance: number }> {
  const now = opts.now ?? Date.now();
  const id = String(input.bet_id ?? "");
  if (!UUID.test(id)) throw new GameError("not_found", "That bet wasn't found", 404);
  return inTransaction(db, async (client) => {
    const b = (await client.query<BetRow>(`SELECT * FROM mines_live_bets WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, userId])).rows[0];
    if (!b) throw new GameError("not_found", "That bet wasn't found", 404);
    if (b.status !== "OPEN") return { bet: betView(b), balance: await balanceOf(client, userId) };
    if ((Number(b.round_no) + 1) * LIVE_ROUND_MS - now < LIVE_CUTOFF_MS) {
      throw new GameError("too_late", "Too late to cancel — the round is about to end.", 409);
    }
    const after = (await client.query<BetRow>(
      `UPDATE mines_live_bets SET status = 'VOID', updated_at = now() WHERE id = $1 RETURNING *`, [id])).rows[0]!;
    await postMovement(client, {
      idempotencyKey: `void:live:${id}`,
      entryType: "BET_VOID",
      description: "Live Mines bet cancelled",
      legs: [
        { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: Number(b.stake) },
        { userId, currencyCode: "GHS", direction: "CREDIT", amountMajor: Number(b.stake) },
      ],
    });
    return { bet: betView(after), balance: await balanceOf(client, userId) };
  });
}

/** The player's bet in a round (settling the round first if it's over), and their balance. */
export async function myLiveBet(
  db: Pool, userId: string, roundNo: unknown, now = Date.now()
): Promise<{ bet: LiveBetView | null; balance: number }> {
  const no = Number(roundNo);
  if (!Number.isSafeInteger(no)) throw new GameError("not_found", "That round wasn't found", 404);
  const r = (await db.query<RoundRow>(`SELECT * FROM mines_live_rounds WHERE no = $1`, [no])).rows[0];
  if (r && now >= endOf(r) && !r.settled) await settleLiveRound(db, no, now);
  const b = (await db.query<BetRow>(
    `SELECT * FROM mines_live_bets WHERE round_no = $1 AND user_id = $2 AND status <> 'VOID'`, [no, userId])).rows[0];
  return { bet: b ? betView(b, r) : null, balance: await balanceOf(db, userId) };
}

/** Settles finished rounds nobody asked about (the live server was asleep or restarting), and clears out old empty rounds. */
export async function settleDueLiveRounds(db: Pool, now = Date.now()): Promise<number> {
  const due = (await db.query<{ no: string }>(
    `SELECT no FROM mines_live_rounds WHERE NOT settled AND ends_at <= $1 ORDER BY no LIMIT 50`, [new Date(now)])).rows;
  /* one round that fails to settle must not hold up every round after it */
  for (const { no } of due) {
    try {
      await settleLiveRound(db, Number(no), now);
    } catch (e) {
      console.error(`[mines-live] round ${no} failed to settle: ${(e as Error).message}`);
    }
  }
  await db.query(
    `DELETE FROM mines_live_rounds r WHERE r.ends_at < $1 AND NOT EXISTS (SELECT 1 FROM mines_live_bets b WHERE b.round_no = r.no)`,
    [new Date(now - 7 * 24 * 3600e3)]);
  return due.length;
}

export function startLiveSweep(db: Pool): void {
  const run = () => settleDueLiveRounds(db).catch((e) => console.error("[mines-live] sweep failed:", (e as Error).message));
  setInterval(run, 30_000).unref();
  void run();
}
