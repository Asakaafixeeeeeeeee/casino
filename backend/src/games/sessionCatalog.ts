import { GameError, type Rng } from "./catalog.js";

/** A game played over several moves: the server deals a secret board and judges every move against it. */
export interface SessionGame<P, S, G> {
  id: string;
  name: string;
  minBet: number;
  maxBet: number;
  /** The most one round can pay. */
  maxWin: number;
  rtp: number;
  parseParams(raw: unknown): P;
  /** The secret, drawn when the bet is placed. */
  deal(params: P, rng: Rng): S;
  start(params: P): G;
  /** One move; bust = the round is lost. Throws GameError for a move that isn't allowed. */
  step(params: P, secret: S, progress: G, move: unknown): { progress: G; bust: boolean };
  /** The multiplier a cash-out pays now (1 before any safe move). */
  multiplier(params: P, progress: G): number;
  canCashOut(params: P, progress: G): boolean;
  /** Reached the end of the board: pays out by itself. */
  finished(params: P, progress: G): boolean;
  payout(stake: number, multiplier: number): number;
  /** What the page may see while the round is open (never the secret). */
  view(params: P, progress: G): Record<string, unknown>;
}

const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
const draw = (rng: Rng, n: number) => Math.min(n - 1, Math.floor(rng() * n));
const field = (raw: unknown, key: string) => (raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined);

/* ---------------- Rendo Mines (mines.js) ----------------
   5×5 tiles, 1–24 mines. After k stars with m mines the multiplier is 96.5% ÷ P(k stars in a row), with
   P = ∏ (25−m−i)/(25−i), rounded to the cent (half up) with exact integers; payouts round to the cent. */
const TILES = 25;
const mineTables = new Map<number, number[]>();
export function minesMultipliers(m: number): number[] {
  const cached = mineTables.get(m);
  if (cached) return cached;
  const t = [1];
  let num = 1n;
  let den = 1n;
  for (let k = 1; k <= TILES - m; k++) {
    num *= BigInt(TILES - m - (k - 1));
    den *= BigInt(TILES - (k - 1));
    t[k] = Number((386n * den + 2n * num) / (4n * num)) / 100; // 0.965 ÷ (num/den), round half up
  }
  mineTables.set(m, t);
  return t;
}
export const mines: SessionGame<{ mines: number }, { mines: number[] }, { picked: number[] }> = {
  id: "volta-mines", name: "Rendo Mines", minBet: 0.1, maxBet: 10000, maxWin: 100000, rtp: 0.965,
  parseParams(raw) {
    const m = Number(field(raw, "mines"));
    if (!Number.isInteger(m) || m < 1 || m > 24) throw new GameError("invalid_params", "Choose 1 to 24 mines");
    return { mines: m };
  },
  deal(params, rng) {
    const order = Array.from({ length: TILES }, (_, i) => i);
    for (let i = TILES - 1; i > 0; i--) {
      const k = draw(rng, i + 1);
      [order[i], order[k]] = [order[k]!, order[i]!];
    }
    return { mines: order.slice(0, params.mines).sort((a, b) => a - b) };
  },
  start: () => ({ picked: [] }),
  step(_params, secret, progress, move) {
    const i = Number(move);
    if (!Number.isInteger(i) || i < 0 || i >= TILES) throw new GameError("invalid_move", "Pick a tile on the board");
    if (progress.picked.includes(i)) return { progress, bust: false }; // already open: nothing changes
    if (secret.mines.includes(i)) return { progress: { picked: [...progress.picked, i] }, bust: true };
    return { progress: { picked: [...progress.picked, i] }, bust: false };
  },
  multiplier: (params, p) => minesMultipliers(params.mines)[p.picked.length] ?? 1,
  canCashOut: (_params, p) => p.picked.length > 0,
  finished: (params, p) => p.picked.length === TILES - params.mines,
  /* down to the cent, like every payout: rounding to the nearest cent made 0.10 × 1.05 pay 0.11 (EV over 100%) */
  payout: (stake, mult) => Math.min(100000, floor2(stake * mult)),
  view: (params, p) => ({ mines: params.mines, picked: p.picked }),
};

/* ---------------- Rendo Crossing (crossing.js) ----------------
   The risk of lane n is a + b·n + c·n²; the multiplier after lane n is 97% ÷ P(alive), rounded to the cent and kept
   rising. One uniform draw u decides the round: she's hit on the first lane where u ≥ 97% ÷ multiplier. Payouts
   round down to the cent. */
const CROSSING_RTP = 0.97;
export const CROSSING_LEVELS: Record<string, { lanes: number; a: number; b: number; c: number }> = {
  easy: { lanes: 24, a: 0.04, b: 0.002, c: 0.0004 },
  medium: { lanes: 22, a: 0.1565, b: 0.002, c: 0.0012 },
  hard: { lanes: 20, a: 0.24, b: 0.006, c: 0.0012 },
  expert: { lanes: 15, a: 0.38, b: 0.01, c: 0.0015 },
};
const crossingTables = new Map<string, number[]>();
export function crossingTable(level: string): number[] {
  const cached = crossingTables.get(level);
  if (cached) return cached;
  const L = CROSSING_LEVELS[level]!;
  const out: number[] = [];
  let alive = 1;
  let prev = 0;
  for (let n = 0; n < L.lanes; n++) {
    alive *= 1 - (L.a + L.b * n + L.c * n * n);
    let m = Math.round((CROSSING_RTP / alive) * 100) / 100;
    if (m <= prev) m = Math.round((prev + 0.01) * 100) / 100;
    out.push(m);
    prev = m;
  }
  crossingTables.set(level, out);
  return out;
}
export const crossing: SessionGame<{ level: string }, { fate: number | null }, { at: number }> = {
  id: "volta-crossing", name: "Rendo Crossing", minBet: 0.1, maxBet: 10000, maxWin: 100000, rtp: CROSSING_RTP,
  parseParams(raw) {
    const level = String(field(raw, "level") ?? "");
    /* own keys only: "constructor" or "toString" passed the plain lookup, took the stake and broke the round */
    if (!Object.prototype.hasOwnProperty.call(CROSSING_LEVELS, level)) throw new GameError("invalid_params", "Choose easy, medium, hard or expert");
    return { level };
  },
  deal(params, rng) {
    const u = rng();
    const t = crossingTable(params.level);
    const fate = t.findIndex((m) => u >= CROSSING_RTP / m);
    return { fate: fate < 0 ? null : fate }; // null: she gets all the way across
  },
  start: () => ({ at: -1 }),
  step(params, secret, progress) {
    const next = progress.at + 1;
    if (next >= CROSSING_LEVELS[params.level]!.lanes) throw new GameError("invalid_move", "She's already across");
    if (secret.fate === next) return { progress: { at: next }, bust: true };
    return { progress: { at: next }, bust: false };
  },
  multiplier: (params, p) => (p.at < 0 ? 1 : crossingTable(params.level)[p.at]!),
  canCashOut: (_params, p) => p.at >= 0,
  finished: (params, p) => p.at === CROSSING_LEVELS[params.level]!.lanes - 1,
  payout: (stake, mult) => Math.min(100000, floor2(stake * mult)),
  view: (params, p) => ({ level: params.level, at: p.at }),
};

/* ---------------- Rendo Goal (goal.js) ----------------
   One bomb per column at a uniform row. After k balls with r rows the multiplier is 0.97 × (r/(r−1))^k rounded
   down to the cent (exact integers); payouts round down to the cent. */
export const GOAL_FIELDS: Record<string, { cols: number; rows: number }> = {
  small: { cols: 4, rows: 3 },
  medium: { cols: 5, rows: 4 },
  large: { cols: 7, rows: 5 },
};
const goalTables = new Map<string, number[]>();
export function goalMultipliers(key: string): number[] {
  const cached = goalTables.get(key);
  if (cached) return cached;
  const r = BigInt(GOAL_FIELDS[key]!.rows);
  const t = [1];
  for (let k = 1; k <= GOAL_FIELDS[key]!.cols; k++) t[k] = Number((97n * r ** BigInt(k)) / (r - 1n) ** BigInt(k)) / 100;
  goalTables.set(key, t);
  return t;
}
export const goal: SessionGame<{ field: string }, { bombs: number[] }, { col: number; picks: number[] }> = {
  id: "volta-goal", name: "Rendo Goal", minBet: 0.1, maxBet: 10000, maxWin: 100000, rtp: 0.97,
  parseParams(raw) {
    const f = String(field(raw, "field") ?? "");
    if (!Object.prototype.hasOwnProperty.call(GOAL_FIELDS, f)) throw new GameError("invalid_params", "Choose small, medium or large");
    return { field: f };
  },
  deal(params, rng) {
    const { cols, rows } = GOAL_FIELDS[params.field]!;
    return { bombs: Array.from({ length: cols }, () => draw(rng, rows)) };
  },
  start: () => ({ col: 0, picks: [] }),
  step(params, secret, progress, move) {
    const { cols, rows } = GOAL_FIELDS[params.field]!;
    const row = Number(move);
    if (progress.col >= cols) throw new GameError("invalid_move", "That was the last column");
    if (!Number.isInteger(row) || row < 0 || row >= rows) throw new GameError("invalid_move", "Pick a tile in the glowing column");
    const picks = [...progress.picks, row];
    if (secret.bombs[progress.col] === row) return { progress: { col: progress.col, picks }, bust: true };
    return { progress: { col: progress.col + 1, picks }, bust: false };
  },
  multiplier: (params, p) => goalMultipliers(params.field)[p.col] ?? 1,
  canCashOut: (_params, p) => p.col > 0,
  finished: (params, p) => p.col === GOAL_FIELDS[params.field]!.cols,
  payout: (stake, mult) => Math.min(100000, floor2(stake * mult)),
  view: (params, p) => ({ field: params.field, col: p.col, picks: p.picks }),
};

export const SESSION_GAMES: Record<string, SessionGame<never, never, never>> = Object.fromEntries(
  [mines, crossing, goal].map((g) => [g.id, g as unknown as SessionGame<never, never, never>])
);
