import type { Pool, PoolClient } from "pg";
import { postMovement, SystemAccount } from "../services/balanceService.js";
import { getLimits } from "../services/responsibleGaming.js";
import { GameError, secureRandom, type Rng } from "./catalog.js";
import { assertGameOpen, assertStakeAllowed } from "./availability.js";
import { SESSION_GAMES, type SessionGame } from "./sessionCatalog.js";

type AnyGame = SessionGame<never, never, never>;
interface Row {
  id: string; user_id: string; game: string; stake: string; params: never; secret: never; progress: never;
  status: "OPEN" | "WON" | "LOST" | "VOID"; payout: string;
}

export interface SessionState {
  session_id: string;
  game: string;
  status: "OPEN" | "WON" | "LOST" | "VOID";
  stake: number;
  /** The public board: picks, column, lane… never the secret while the round is open. */
  state: Record<string, unknown>;
  /** What a cash-out pays now (OPEN), or what was paid (WON). */
  multiplier: number;
  payout: number;
  /** The secret, once the round is over (so the page can show the whole board). */
  reveal?: Record<string, unknown>;
  balance: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function gameOf(gameId: string): AnyGame {
  const g = Object.prototype.hasOwnProperty.call(SESSION_GAMES, gameId) ? SESSION_GAMES[gameId] : undefined;
  if (!g) throw new GameError("unknown_game", "This game can't be played for real money yet", 404);
  return g;
}

async function balanceOf(db: Pool | PoolClient, userId: string): Promise<number> {
  const { rows } = await db.query<{ available: string }>(
    `SELECT available FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId]);
  return Number(rows[0]?.available ?? 0);
}

function stateOf(game: AnyGame, row: Row, balance: number): SessionState {
  const stake = Number(row.stake);
  const over = row.status !== "OPEN";
  return {
    session_id: row.id,
    game: row.game,
    status: row.status,
    stake,
    state: game.view(row.params, row.progress),
    multiplier: row.status === "WON" ? round2(Number(row.payout) / stake) : game.multiplier(row.params, row.progress),
    payout: Number(row.payout),
    ...(over ? { reveal: row.secret as Record<string, unknown> } : {}),
    balance,
  };
}

/** Pays a round once, in the caller's transaction: only an OPEN row becomes WON. */
async function settleWin(client: PoolClient, game: AnyGame, row: Row, progress: never): Promise<Row> {
  const mult = game.multiplier(row.params, progress);
  const payout = game.payout(Number(row.stake), mult);
  const { rows } = await client.query<Row>(
    `UPDATE game_sessions SET status = 'WON', progress = $2, payout = $3, updated_at = now()
      WHERE id = $1 AND status = 'OPEN' RETURNING *`,
    [row.id, JSON.stringify(progress), payout]
  );
  if (!rows[0]) return row;
  if (payout > 0) {
    await postMovement(client, {
      idempotencyKey: `win:session:${row.id}`,
      entryType: "BET_SETTLED",
      description: `${game.name} cash-out`,
      legs: [
        { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: payout },
        { userId: row.user_id, currencyCode: "GHS", direction: "CREDIT", amountMajor: payout },
      ],
    });
  }
  return rows[0];
}

/** Takes the stake and deals the board. One round in progress per game per player; a retried key returns it. */
export async function startSession(
  db: Pool,
  userId: string,
  gameId: string,
  input: { stake?: unknown; params?: unknown; idempotency_key?: unknown },
  rng: Rng = secureRandom
): Promise<SessionState> {
  const game = gameOf(gameId);
  const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
  if (key.length < 8) throw new GameError("invalid_idempotency_key", "A round needs an idempotency_key");

  const prior = (await db.query<Row>(`SELECT * FROM game_sessions WHERE idempotency_key = $1`, [key])).rows[0];
  if (prior) {
    if (prior.user_id !== userId || prior.game !== gameId) throw new GameError("key_reused", "That round key was already used", 409);
    return stateOf(game, prior, await balanceOf(db, userId));
  }

  await assertGameOpen(db, gameId); /* switched off by an admin: no new rounds; one in play can be finished */
  const params = game.parseParams(input.params);
  const stake = round2(Number(input.stake));
  if (!Number.isFinite(stake) || stake < game.minBet || stake > game.maxBet) {
    throw new GameError("invalid_stake", `Bet between GHS ${game.minBet} and GHS ${game.maxBet.toLocaleString("en-GH")}`);
  }
  await assertStakeAllowed(db, gameId, stake, userId);
  if ((await getLimits(db, userId)).excludedUntil) {
    throw new GameError("self_excluded", "You're taking a break, so real-money play is paused until it ends.", 403);
  }
  const open = (await db.query<Row>(`SELECT * FROM game_sessions WHERE user_id = $1 AND game = $2 AND status = 'OPEN'`,
    [userId, gameId])).rows[0];
  if (open) throw new GameError("round_open", "Finish the round you already have open first", 409);

  const secret = game.deal(params as never, rng);
  const progress = game.start(params as never);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Row>(
      `INSERT INTO game_sessions (user_id, game, currency, stake, params, secret, progress, idempotency_key)
       VALUES ($1, $2, 'GHS', $3, $4, $5, $6, $7) RETURNING *`,
      [userId, gameId, stake, JSON.stringify(params), JSON.stringify(secret), JSON.stringify(progress), key]
    );
    const row = rows[0]!;
    await postMovement(client, {
      idempotencyKey: `bet:session:${row.id}`,
      entryType: "BET_PLACED",
      description: `${game.name} stake`,
      legs: [
        { userId, currencyCode: "GHS", direction: "DEBIT", amountMajor: stake },
        { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "CREDIT", amountMajor: stake },
      ],
    });
    await client.query("COMMIT");
    return stateOf(game, row, await balanceOf(client, userId)); /* the held connection, not a second one */
  } catch (e) {
    await client.query("ROLLBACK");
    if (e instanceof Error && e.name === "InsufficientFundsError") {
      throw new GameError("insufficient_funds", "Not enough in your balance for that bet — deposit to keep playing.", 409);
    }
    /* two copies of one start at once: the copy that lost the race gets the round the other one opened; a different
       round already open is the usual "finish it first" */
    if ((e as { code?: string }).code === "23505" || (e instanceof Error && e.name === "IdempotencyError")) {
      const prior = (await db.query<Row>(`SELECT * FROM game_sessions WHERE idempotency_key = $1`, [key])).rows[0];
      if (prior && prior.user_id === userId && prior.game === gameId) return stateOf(game, prior, await balanceOf(db, userId));
      throw new GameError("round_open", "Finish the round you already have open first", 409);
    }
    throw e;
  } finally {
    client.release();
  }
}

/** Locks the player's round for one move or cash-out, so a double tap can't be judged twice. */
async function withRound<T>(
  db: Pool, userId: string, gameId: string, sessionId: unknown,
  fn: (client: PoolClient, game: AnyGame, row: Row) => Promise<T>
): Promise<T> {
  const game = gameOf(gameId);
  /* a malformed id can't be a round (and must not reach the uuid column as a database error) */
  if (!UUID.test(String(sessionId ?? ""))) throw new GameError("not_found", "That round wasn't found", 404);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query<Row>(
      `SELECT * FROM game_sessions WHERE id = $1 AND user_id = $2 AND game = $3 FOR UPDATE`,
      [String(sessionId ?? ""), userId, gameId]
    )).rows[0];
    if (!row) throw new GameError("not_found", "That round wasn't found", 404);
    const out = await fn(client, game, row);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** One move. A bust loses the round; reaching the end or the top prize pays out by itself. */
export async function stepSession(
  db: Pool, userId: string, gameId: string, input: { session_id?: unknown; move?: unknown }
): Promise<SessionState> {
  return withRound(db, userId, gameId, input.session_id, async (client, game, row) => {
    if (row.status !== "OPEN") return stateOf(game, row, await balanceOf(client, userId)); // over: report it again
    const { progress, bust } = game.step(row.params, row.secret, row.progress, input.move);
    let after: Row;
    if (bust) {
      after = (await client.query<Row>(
        `UPDATE game_sessions SET status = 'LOST', progress = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [row.id, JSON.stringify(progress)])).rows[0]!;
    } else {
      const mult = game.multiplier(row.params, progress);
      const topPrize = Number(row.stake) * mult >= game.maxWin;
      if (game.finished(row.params, progress) || topPrize) {
        after = await settleWin(client, game, row, progress);
      } else {
        after = (await client.query<Row>(
          `UPDATE game_sessions SET progress = $2, updated_at = now() WHERE id = $1 RETURNING *`,
          [row.id, JSON.stringify(progress)])).rows[0]!;
      }
    }
    return stateOf(game, after, await balanceOf(client, userId));
  });
}

/** Cash out at the current multiplier. A round that's already over is just reported again. */
export async function cashOutSession(
  db: Pool, userId: string, gameId: string, input: { session_id?: unknown }
): Promise<SessionState> {
  return withRound(db, userId, gameId, input.session_id, async (client, game, row) => {
    if (row.status !== "OPEN") return stateOf(game, row, await balanceOf(client, userId));
    if (!game.canCashOut(row.params, row.progress)) throw new GameError("too_early", "Make at least one move before cashing out", 409);
    const after = await settleWin(client, game, row, row.progress);
    return stateOf(game, after, await balanceOf(client, userId));
  });
}

/** The round in progress, if any — so a player who left or reloaded can carry on. */
export async function openSession(db: Pool, userId: string, gameId: string): Promise<SessionState | null> {
  const game = gameOf(gameId);
  const row = (await db.query<Row>(`SELECT * FROM game_sessions WHERE user_id = $1 AND game = $2 AND status = 'OPEN'`,
    [userId, gameId])).rows[0];
  return row ? stateOf(game, row, await balanceOf(db, userId)) : null;
}

/* ---------------- rounds left open ---------------- */

/** How long a step-game round may sit untouched before it's settled for the player. */
export const ABANDONED_AFTER_MS = 24 * 3600 * 1000;

/** Takes the stake back for a round that was never played (no move made): VOID, refunded once. */
async function voidRound(client: PoolClient, game: AnyGame, row: Row): Promise<void> {
  const { rows } = await client.query<Row>(
    `UPDATE game_sessions SET status = 'VOID', updated_at = now() WHERE id = $1 AND status = 'OPEN' RETURNING *`, [row.id]);
  if (!rows[0]) return;
  await postMovement(client, {
    idempotencyKey: `void:session:${row.id}`,
    entryType: "BET_VOID",
    description: `${game.name} round voided: no move was made`,
    legs: [
      { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: Number(row.stake) },
      { userId: row.user_id, currencyCode: "GHS", direction: "CREDIT", amountMajor: Number(row.stake) },
    ],
  });
}

/** Rounds untouched for ABANDONED_AFTER_MS: one with progress is cashed out at its current multiplier, one without a
 *  move is voided and its stake returned. Closing the browser (or never coming back) loses nothing that was won. */
export async function settleAbandonedSessions(db: Pool, now = Date.now()): Promise<number> {
  const { rows } = await db.query<{ id: string; user_id: string; game: string }>(
    `SELECT id, user_id, game FROM game_sessions WHERE status = 'OPEN' AND updated_at < $1 ORDER BY updated_at LIMIT 50`,
    [new Date(now - ABANDONED_AFTER_MS)]);
  let settled = 0;
  for (const r of rows) {
    try {
      await withRound(db, r.user_id, r.game, r.id, async (client, game, row) => {
        if (row.status !== "OPEN") return;
        if (game.canCashOut(row.params, row.progress)) await settleWin(client, game, row, row.progress);
        else await voidRound(client, game, row);
      });
      settled++;
    } catch (e) {
      console.error(`[sessions] round ${r.id} could not be settled: ${(e as Error).message}`);
    }
  }
  return settled;
}

export function startSessionSweep(db: Pool): void {
  const run = () => settleAbandonedSessions(db).catch((e) => console.error("[sessions] sweep failed:", (e as Error).message));
  setInterval(run, 10 * 60 * 1000).unref();
  void run();
}
