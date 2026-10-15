import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { postMovement, SystemAccount } from "../services/balanceService.js";
import { getLimits } from "../services/responsibleGaming.js";
import { GameError } from "./catalog.js";
import { assertGameOpen, assertStakeAllowed, gameControls } from "./availability.js";

/*
 * BNC WIN: a race between the player's green runner and the red runner. Each player's race is their own and runs on
 * the server's clock: a 3-second countdown, then 60 steps of half a second (30 seconds).
 *
 * The whole race is drawn the moment the player presses GO, from a secret seed (its SHA-256 fingerprint is shown at
 * once; the seed itself is shown when the race ends, so anyone can check it). Each step is drawn from the seed alone —
 * never from the stake, the player or when they cash out:
 *   - green surges:   race score × 1.08   (chance Q = 52.8667 %)
 *   - red surges:     race score × 0.93   (chance 46.1333 %)
 *   - red breaks away: the race is lost   (chance P = 1 %)
 * The race score starts at 1. The cash-out value is stake × 97 % × race score (rounded down to the pesewa). The steps
 * are balanced (Q × 1.08 + (1 − P − Q) × 0.93 = 1), so whenever a player cashes out — or lets the race finish, which
 * pays the value at the line — the expected return is 97 % of the stake. A race that reaches the top win cashes itself
 * out there. The runners' positions on the page only show the race score: green leads while it's above 1.
 */

export const BNC_ID = "bnc-win";
export const BNC = {
  name: "BNC WIN",
  rtp: 0.97,
  up: 1.08,
  down: 0.93,
  bust: 0.01,
  /** chance of a green surge, so that each step is fair before the house edge */
  get upChance() { return (1 - (1 - this.bust) * this.down) / (this.up - this.down); },
  steps: 60,
  stepMs: 500,
  startMs: 3000,
  minBet: 1,
  maxBet: 1000,
  maxWin: 50000,
};

type Step = "U" | "D" | "B";
export type RaceStatus = "ACTIVE" | "CASHED" | "FINISHED" | "BUSTED";

const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
const round2 = (n: number) => Math.round(n * 100) / 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Step k (0-based) from the seed: HMAC-SHA256(seed, "step:k") read as a number in [0, 1). */
export function bncPath(seed: string, steps = BNC.steps): Step[] {
  const out: Step[] = [];
  const q = BNC.upChance;
  for (let k = 0; k < steps; k++) {
    const h = crypto.createHmac("sha256", seed).update("step:" + k).digest();
    const r = h.readUIntBE(0, 6) / 2 ** 48;
    out.push(r < BNC.bust ? "B" : r < BNC.bust + q ? "U" : "D");
  }
  return out;
}

/** The race score after each step (index 0 = before the first step), up to the step where red breaks away. */
export function scores(path: Step[]): { xs: number[]; bustAt: number | null } {
  const xs = [1];
  for (let k = 0; k < path.length; k++) {
    if (path[k] === "B") return { xs, bustAt: k + 1 };
    xs.push(xs[k]! * (path[k] === "U" ? BNC.up : BNC.down));
  }
  return { xs, bustAt: null };
}

export const cashValue = (stake: number, x: number, maxWin = BNC.maxWin) => Math.min(maxWin, floor2(stake * BNC.rtp * x));

/** Where the race ends by itself: red breaking away (lost), the top win (paid there), or the finish line (paid). */
export function raceEnd(path: Step[], stake: number, maxWin = BNC.maxWin): { step: number; status: "BUSTED" | "FINISHED"; x: number } {
  const { xs, bustAt } = scores(path);
  const last = bustAt ?? BNC.steps;
  for (let k = 1; k < xs.length && k <= last; k++) {
    if (bustAt !== null && k === bustAt) break;
    if (stake * BNC.rtp * xs[k]! >= maxWin) return { step: k, status: "FINISHED", x: xs[k]! };
  }
  if (bustAt !== null) return { step: bustAt, status: "BUSTED", x: 0 };
  return { step: BNC.steps, status: "FINISHED", x: xs[BNC.steps]! };
}

/* ---------------- storage ---------------- */

interface RaceRow {
  id: string; user_id: string; stake: string; seed: string; hash: string; path: string; starts_at: Date | string;
  ends_at: Date | string; status: RaceStatus; cashed_step: number | null; cashed_x: string | null; payout: string;
  max_win: string; created_at: Date | string;
}
type Db = Pool | PoolClient;
const startOf = (r: RaceRow) => new Date(r.starts_at).getTime();
/** Steps completed by `now`. */
const stepAt = (r: RaceRow, now: number) => Math.max(0, Math.min(BNC.steps, Math.floor((now - startOf(r)) / BNC.stepMs)));

async function balanceOf(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query<{ available: string }>(`SELECT available FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'`, [userId]);
  return Number(rows[0]?.available ?? 0);
}

export interface RaceView {
  race_id: string; status: RaceStatus; stake: number; hash: string; seed?: string;
  starts_in_ms: number; step_ms: number; steps: number;
  /** the race score after each step that has happened (never a step still to come) */
  xs: number[];
  step: number; x: number; value: number;
  ended_step?: number; payout: number; balance?: number; server_now: string;
}

function view(r: RaceRow, now: number): RaceView {
  const path = r.path.split("") as Step[];
  const { xs } = scores(path);
  const stake = Number(r.stake);
  const over = r.status !== "ACTIVE";
  const end = raceEnd(path, stake, Number(r.max_win));
  /* how far the page may see: up to now while the race runs, up to where it ended once it's over */
  const shown = over ? (r.status === "CASHED" ? r.cashed_step! : end.step) : Math.min(stepAt(r, now), end.step);
  const revealed = xs.slice(0, Math.min(shown, xs.length - 1) + 1);
  const x = r.status === "CASHED" ? Number(r.cashed_x) : r.status === "BUSTED" ? 0 : revealed[revealed.length - 1]!;
  return {
    race_id: r.id, status: r.status, stake, hash: r.hash, ...(over ? { seed: r.seed } : {}),
    starts_in_ms: Math.round(startOf(r) - now), step_ms: BNC.stepMs, steps: BNC.steps,
    xs: revealed.map((v) => Math.round(v * 1e6) / 1e6),
    step: shown, x: Math.round(x * 1e6) / 1e6,
    value: r.status === "BUSTED" ? 0 : over ? Number(r.payout) : cashValue(stake, x, Number(r.max_win)),
    ...(over ? { ended_step: r.status === "CASHED" ? r.cashed_step! : end.step } : {}),
    payout: Number(r.payout), server_now: new Date(now).toISOString(),
  };
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

/** Ends an ACTIVE race once, as `status` with `payout`; a payout is posted to the ledger exactly once. */
async function finish(client: PoolClient, r: RaceRow, status: Exclude<RaceStatus, "ACTIVE">, step: number, x: number, payout: number): Promise<RaceRow> {
  const { rows } = await client.query<RaceRow>(
    `UPDATE bnc_races SET status = $2, cashed_step = $3, cashed_x = $4, payout = $5, updated_at = now()
      WHERE id = $1 AND status = 'ACTIVE' RETURNING *`, [r.id, status, step, status === "BUSTED" ? null : x, payout]);
  if (!rows[0]) return r;
  if (payout > 0) {
    await postMovement(client, {
      idempotencyKey: `win:bnc:${r.id}`,
      entryType: "BET_SETTLED",
      description: `${BNC.name} ${status === "CASHED" ? "cash-out" : "win"}`,
      legs: [
        { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: payout },
        { userId: r.user_id, currencyCode: "GHS", direction: "CREDIT", amountMajor: payout },
      ],
    });
  }
  return rows[0];
}

/** Settles a race the clock has decided (red broke away, top win, or the finish line); a race still running is left. */
async function settleIfOver(client: PoolClient, r: RaceRow, now: number): Promise<RaceRow> {
  if (r.status !== "ACTIVE") return r;
  const path = r.path.split("") as Step[];
  const stake = Number(r.stake);
  const end = raceEnd(path, stake, Number(r.max_win));
  if (stepAt(r, now) < end.step) return r;
  return finish(client, r, end.status, end.step, end.x, end.status === "BUSTED" ? 0 : cashValue(stake, end.x, Number(r.max_win)));
}

async function lockRace(client: PoolClient, userId: string, raceId: unknown): Promise<RaceRow> {
  const id = String(raceId ?? "");
  const r = UUID.test(id) ? (await client.query<RaceRow>(`SELECT * FROM bnc_races WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, userId])).rows[0] : undefined;
  if (!r) throw new GameError("not_found", "That race wasn't found", 404);
  return r;
}

/* ---------------- what the routes call ---------------- */

/** The page: the player's race in progress (a reload carries on), the last races, and the game's limits and odds. */
export async function bncState(db: Pool, userId: string, now = Date.now()) {
  const active = (await db.query<RaceRow>(`SELECT * FROM bnc_races WHERE user_id = $1 AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`, [userId])).rows[0];
  let race: RaceView | null = null;
  if (active) {
    const r = await inTransaction(db, async (c) => settleIfOver(c, (await c.query<RaceRow>(`SELECT * FROM bnc_races WHERE id = $1 FOR UPDATE`, [active.id])).rows[0]!, now));
    race = view(r, now);
  }
  const ctl = await gameControls(db, BNC_ID);
  const history = (await db.query<RaceRow>(
    `SELECT * FROM bnc_races WHERE user_id = $1 AND status <> 'ACTIVE' ORDER BY created_at DESC LIMIT 20`, [userId])).rows
    .map((r) => ({ race_id: r.id, status: r.status, stake: Number(r.stake), payout: Number(r.payout),
      x: r.cashed_x === null ? null : Number(r.cashed_x), step: r.cashed_step, at: new Date(r.created_at).toISOString(), hash: r.hash, seed: r.seed }));
  return {
    race, history, balance: await balanceOf(db, userId), ...publicRules(),
    min_bet: Math.max(BNC.minBet, ctl.min_bet ?? 0), max_bet: Math.min(BNC.maxBet, ctl.max_bet ?? Infinity),
  };
}

/** The disclosed rules and odds (no sign-in needed). */
export function publicRules() {
  return {
    rtp: BNC.rtp, up: BNC.up, down: BNC.down, bust: BNC.bust, up_chance: Math.round(BNC.upChance * 1e6) / 1e6,
    down_chance: Math.round((1 - BNC.bust - BNC.upChance) * 1e6) / 1e6,
    steps: BNC.steps, step_ms: BNC.stepMs, start_ms: BNC.startMs, max_win: BNC.maxWin, min_bet: BNC.minBet, max_bet: BNC.maxBet,
  };
}

/** GO: takes the stake once and draws the whole race. The same key returns the same race. One race at a time. */
export async function startBncRace(db: Pool, userId: string, input: { stake?: unknown; idempotency_key?: unknown }, opts: { now?: number; seed?: string } = {}) {
  const now = opts.now ?? Date.now();
  const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
  if (key.length < 8) throw new GameError("invalid_idempotency_key", "A race needs an idempotency_key");
  const prior = (await db.query<RaceRow>(`SELECT * FROM bnc_races WHERE idempotency_key = $1`, [key])).rows[0];
  if (prior) {
    if (prior.user_id !== userId) throw new GameError("key_reused", "That key was already used", 409);
    return { race: view(prior, now), balance: await balanceOf(db, userId) };
  }
  await assertGameOpen(db, BNC_ID);
  const ctl = await gameControls(db, BNC_ID);
  const min = Math.max(BNC.minBet, ctl.min_bet ?? 0), max = Math.min(BNC.maxBet, ctl.max_bet ?? Infinity);
  const stake = round2(Number(input.stake));
  if (!Number.isFinite(stake) || stake < min || stake > max) {
    throw new GameError("invalid_stake", `Stake between GHS ${min.toFixed(2)} and GHS ${max.toLocaleString("en-GH", { minimumFractionDigits: 2 })}`);
  }
  await assertStakeAllowed(db, BNC_ID, stake, userId);
  if ((await getLimits(db, userId)).excludedUntil) throw new GameError("self_excluded", "You're taking a break, so real-money play is paused until it ends.", 403);

  const seed = opts.seed ?? crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(seed).digest("hex");
  const path = bncPath(seed);
  const end = raceEnd(path, stake);
  const startsAt = now + BNC.startMs;
  try {
    return await inTransaction(db, async (client) => {
      /* a finished race of this player's still marked ACTIVE (they left) is settled first */
      const open = (await client.query<RaceRow>(`SELECT * FROM bnc_races WHERE user_id = $1 AND status = 'ACTIVE' FOR UPDATE`, [userId])).rows;
      for (const o of open) {
        const after = await settleIfOver(client, o, now);
        if (after.status === "ACTIVE") throw new GameError("race_running", "Your race is still running — cash out or wait for the finish.", 409);
      }
      const r = (await client.query<RaceRow>(
        `INSERT INTO bnc_races (user_id, stake, seed, hash, path, starts_at, ends_at, max_win, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [userId, stake, seed, hash, path.join(""), new Date(startsAt), new Date(startsAt + end.step * BNC.stepMs), BNC.maxWin, key])).rows[0]!;
      await postMovement(client, {
        idempotencyKey: `bet:bnc:${r.id}`,
        entryType: "BET_PLACED",
        description: `${BNC.name} stake`,
        legs: [
          { userId, currencyCode: "GHS", direction: "DEBIT", amountMajor: stake },
          { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "CREDIT", amountMajor: stake },
        ],
      });
      return { race: view(r, now), balance: await balanceOf(client, userId) };
    });
  } catch (e) {
    if (e instanceof Error && e.name === "InsufficientFundsError") {
      throw new GameError("insufficient_funds", "Not enough in your balance for that stake — deposit to keep playing.", 409);
    }
    if ((e as { code?: string }).code === "23505") throw new GameError("race_running", "Your race is still running — cash out or wait for the finish.", 409);
    throw e;
  }
}

/** The race as it stands: only the steps that have happened; settles it if the clock has ended it. */
export async function bncRace(db: Pool, userId: string, raceId: unknown, now = Date.now()) {
  return inTransaction(db, async (client) => {
    const r = await settleIfOver(client, await lockRace(client, userId, raceId), now);
    return { race: view(r, now), balance: await balanceOf(client, userId) };
  });
}

/** CASH OUT: pays the value at the moment the server receives it, once. A race already decided returns its result. */
export async function cashOutBnc(db: Pool, userId: string, input: { race_id?: unknown }, now = Date.now()) {
  return inTransaction(db, async (client) => {
    let r = await settleIfOver(client, await lockRace(client, userId, input.race_id), now);
    if (r.status === "ACTIVE") {
      if (now < startOf(r)) throw new GameError("not_started", "The race hasn't started yet.", 409);
      const k = stepAt(r, now);
      const x = scores(r.path.split("") as Step[]).xs[k]!;
      r = await finish(client, r, "CASHED", k, x, cashValue(Number(r.stake), x, Number(r.max_win)));
    }
    return { race: view(r, now), balance: await balanceOf(client, userId) };
  });
}

/** Settles races whose players left before the end (they're paid at the finish, or lost if red broke away). */
export async function settleDueBnc(db: Pool, now = Date.now()): Promise<number> {
  const due = (await db.query<{ id: string }>(
    `SELECT id FROM bnc_races WHERE status = 'ACTIVE' AND ends_at <= $1 ORDER BY ends_at LIMIT 200`, [new Date(now)])).rows;
  for (const { id } of due) {
    try {
      await inTransaction(db, async (c) => {
        const r = (await c.query<RaceRow>(`SELECT * FROM bnc_races WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (r) await settleIfOver(c, r, now);
      });
    } catch (e) {
      console.error(`[bnc] race ${id} failed to settle: ${(e as Error).message}`);
    }
  }
  return due.length;
}

export function startBncSweep(db: Pool): void {
  const run = () => settleDueBnc(db).catch((e) => console.error("[bnc] sweep failed:", (e as Error).message));
  setInterval(run, 20_000).unref();
  void run();
}
