import type { Pool, PoolClient } from "pg";
import { postMovement, SystemAccount } from "../services/balanceService.js";
import { getLimits } from "../services/responsibleGaming.js";
import { GAMES, GameError, secureRandom, type Rng } from "./catalog.js";
import { assertGameOpen, assertStakeAllowed } from "./availability.js";

export interface RoundResult {
  round_id: string;
  game: string;
  stake: number;
  payout: number;
  outcome: Record<string, unknown>;
  balance: number;
  replayed?: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const stakeValue = (v: unknown): number =>
  typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;

/**
 * Plays one real-money round. The outcome is drawn here, never in the browser. The stake and any win are posted
 * to the ledger and the round recorded in one transaction, so a round either fully happened or didn't at all.
 * The same idempotency key returns the round already played instead of playing again.
 */
export async function playRound(
  db: Pool,
  userId: string,
  gameId: string,
  input: { stake?: unknown; choice?: unknown; idempotency_key?: unknown },
  rng: Rng = secureRandom
): Promise<RoundResult> {
  const game = Object.prototype.hasOwnProperty.call(GAMES, gameId) ? GAMES[gameId] : undefined;
  if (!game) throw new GameError("unknown_game", "This game can't be played for real money yet", 404);
  const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
  if (key.length < 8) throw new GameError("invalid_idempotency_key", "A round needs an idempotency_key");

  const prior = await db.query<{ id: string; user_id: string; game: string; stake: string; payout: string; outcome: Record<string, unknown> }>(
    `SELECT id, user_id, game, stake, payout, outcome FROM game_rounds WHERE idempotency_key = $1`, [key]);
  if (prior.rows[0]) {
    const r = prior.rows[0];
    if (r.user_id !== userId || r.game !== gameId) throw new GameError("key_reused", "That round key was already used", 409);
    return { round_id: r.id, game: r.game, stake: Number(r.stake), payout: Number(r.payout), outcome: r.outcome,
      balance: await balanceOf(db, userId), replayed: true };
  }

  await assertGameOpen(db, gameId); /* switched off by an admin: no new rounds */
  const choice = game.parseChoice(input.choice);
  // a bet spread over spots costs their sum; the page's total must agree with it
  /* a stake is a number or a numeric string: Number() quietly turned [5] into 5 and true into 1 */
  const sent = input.stake === undefined ? undefined : stakeValue(input.stake);
  if (sent !== undefined && Number.isNaN(sent)) throw new GameError("invalid_stake", "The stake must be a number");
  const stake = game.stakeOf ? round2(game.stakeOf(choice as never)) : round2(sent ?? NaN);
  if (game.stakeOf && sent !== undefined && Math.abs(round2(sent) - stake) > 0.001) {
    throw new GameError("invalid_stake", "The stake doesn't match the chips on the table");
  }
  if (!Number.isFinite(stake) || stake < game.minBet || stake > game.maxBet) {
    throw new GameError("invalid_stake", `Bet between GHS ${game.minBet} and GHS ${game.maxBet.toLocaleString("en-GH")}`);
  }
  await assertStakeAllowed(db, gameId, stake, userId);

  const limits = await getLimits(db, userId);
  if (limits.excludedUntil) {
    throw new GameError("self_excluded", "You're taking a break, so real-money play is paused until it ends.", 403);
  }

  const result = game.play(choice as never, stake, rng);
  const payout = round2(result.payout);

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await postMovement(client, {
      idempotencyKey: `bet:${key}`,
      entryType: "BET_PLACED",
      description: `${game.name} stake`,
      legs: [
        { userId, currencyCode: "GHS", direction: "DEBIT", amountMajor: stake },
        { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "CREDIT", amountMajor: stake },
      ],
    });
    if (payout > 0) {
      await postMovement(client, {
        idempotencyKey: `win:${key}`,
        entryType: "BET_SETTLED",
        description: `${game.name} win`,
        legs: [
          { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: payout },
          { userId, currencyCode: "GHS", direction: "CREDIT", amountMajor: payout },
        ],
      });
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO game_rounds (user_id, game, currency, stake, payout, choice, outcome, idempotency_key)
       VALUES ($1, $2, 'GHS', $3, $4, $5, $6, $7) RETURNING id`,
      [userId, gameId, stake, payout, JSON.stringify(choice), JSON.stringify(result.outcome), key]
    );
    await client.query("COMMIT");
    /* read on the connection already held: asking the pool for a second one here could exhaust it under load */
    return { round_id: rows[0]!.id, game: gameId, stake, payout, outcome: result.outcome, balance: await balanceOf(client, userId) };
  } catch (e) {
    await client.query("ROLLBACK");
    if (e instanceof Error && e.name === "InsufficientFundsError") {
      throw new GameError("insufficient_funds", "Not enough in your balance for that bet — deposit to keep playing.", 409);
    }
    /* two copies of one bet at once (a double click, a retried request): the copy that lost the race gets the
       round the other one played, never an error that invites a second bet */
    if (e instanceof Error && (e.name === "IdempotencyError" || (e as { code?: string }).code === "23505")) {
      const r = (await db.query<{ id: string; user_id: string; game: string; stake: string; payout: string; outcome: Record<string, unknown> }>(
        `SELECT id, user_id, game, stake, payout, outcome FROM game_rounds WHERE idempotency_key = $1`, [key])).rows[0];
      if (r && r.user_id === userId && r.game === gameId) {
        return { round_id: r.id, game: r.game, stake: Number(r.stake), payout: Number(r.payout), outcome: r.outcome,
          balance: await balanceOf(db, userId), replayed: true };
      }
      throw new GameError("key_reused", "That round key was already used", 409);
    }
    throw e;
  } finally {
    client.release();
  }
}

async function balanceOf(db: Pool | PoolClient, userId: string): Promise<number> {
  const { rows } = await db.query<{ available: string }>(
    `SELECT available FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId]);
  return Number(rows[0]?.available ?? 0);
}
