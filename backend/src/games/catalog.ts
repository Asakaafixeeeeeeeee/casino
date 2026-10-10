import crypto from "node:crypto";
import { olympusMath } from "./olympusMath.js";
import { fruitsMath } from "./fruitsMath.js";

/** A uniform number in [0, 1) from the OS's cryptographic generator. */
export type Rng = () => number;
// randomInt allows at most 2^48 - 1 values; the upper bound is exclusive, so this is uniform on [0, 1)
const SPAN = 2 ** 48 - 1;
export const secureRandom: Rng = () => crypto.randomInt(0, SPAN) / SPAN;

export class GameError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "GameError";
  }
}

export interface GameResult {
  /** What the page animates, and what is stored for audit. */
  outcome: Record<string, unknown>;
  /** What the player gets back, stake included; 0 is a loss. */
  payout: number;
}

export interface GameDef<C> {
  id: string;
  name: string;
  minBet: number;
  /** The most on the table in one round. */
  maxBet: number;
  /** The return to player the page discloses, as a fraction — checked by the tests. */
  rtp: number;
  parseChoice(raw: unknown): C;
  /** For bets spread over several spots, the stake is their sum. */
  stakeOf?(choice: C): number;
  play(choice: C, stake: number, rng: Rng): GameResult;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
const draw = (rng: Rng, n: number) => Math.min(n - 1, Math.floor(rng() * n)); // 0 … n-1

const pick = <T extends string>(raw: unknown, key: string, allowed: readonly T[]): T => {
  return pick_(raw, key, allowed);
};
const pick_ = <T extends string>(raw: unknown, key: string, allowed: readonly T[]): T => {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw new GameError("invalid_choice", `Choose ${allowed.join(" or ")}`);
};

/** { spot: amount } from the page, checked against the spots that exist and the per-spot limits. */
function parseBets(raw: unknown, spots: readonly string[], min: number, maxPerSpot: number, maxSpots: number): Record<string, number> {
  const bets = raw && typeof raw === "object" ? (raw as Record<string, unknown>).bets : undefined;
  if (!bets || typeof bets !== "object") throw new GameError("invalid_choice", "Put chips on the table first");
  const out: Record<string, number> = {};
  for (const [spot, v] of Object.entries(bets as Record<string, unknown>)) {
    if (!spots.includes(spot)) throw new GameError("invalid_choice", `There's no ${spot} spot`);
    const amount = round2(Number(v));
    if (!Number.isFinite(amount) || amount < min || amount > maxPerSpot) {
      throw new GameError("invalid_choice", `Each spot takes GHS ${min} to GHS ${maxPerSpot.toLocaleString("en-GH")}`);
    }
    out[spot] = amount;
  }
  const n = Object.keys(out).length;
  if (!n) throw new GameError("invalid_choice", "Put chips on the table first");
  if (n > maxSpots) throw new GameError("invalid_choice", `Bet on at most ${maxSpots} spots`);
  return out;
}
const sum = (bets: Record<string, number>) => round2(Object.values(bets).reduce((a, b) => a + b, 0));

/* Rendo Bottle (bottle.js): stops at a uniform angle; UP and DOWN each cover 48% and pay 2x, the two MIDDLE
   wedges (±3.6° around 0° and 180°) lose. Return 96%. */
const MIDDLE_HALF = 3.6;
export function bottleOutcomeAt(deg: number): "UP" | "DOWN" | "MIDDLE" {
  const d = ((deg % 360) + 360) % 360;
  if (d < MIDDLE_HALF || d > 360 - MIDDLE_HALF || Math.abs(d - 180) < MIDDLE_HALF) return "MIDDLE";
  return d > 180 ? "UP" : "DOWN";
}
const bottle: GameDef<{ side: "UP" | "DOWN" }> = {
  id: "volta-bottle", name: "Rendo Bottle", minBet: 0.5, maxBet: 50000, rtp: 0.96,
  parseChoice: (raw) => ({ side: pick(raw, "side", ["UP", "DOWN"] as const) }),
  play(choice, stake, rng) {
    const landing = Math.round(rng() * 360 * 1000) / 1000;
    const result = bottleOutcomeAt(landing);
    return { outcome: { landing, result }, payout: result === choice.side ? round2(stake * 2) : 0 };
  },
};

/* Even-Odd (evenodd.js): three fair dice; EVEN or ODD pays 2x, any triple loses. 105/216 win: 97.2%. */
const evenOdd: GameDef<{ pick: "EVEN" | "ODD" }> = {
  id: "even-odd", name: "Even-Odd", minBet: 0.2, maxBet: 15000, rtp: (2 * 105) / 216,
  parseChoice: (raw) => ({ pick: pick(raw, "pick", ["EVEN", "ODD"] as const) }),
  play(choice, stake, rng) {
    const faces = [0, 1, 2].map(() => 1 + draw(rng, 6));
    const total = faces[0]! + faces[1]! + faces[2]!;
    const triple = faces[0] === faces[1] && faces[1] === faces[2];
    const side = total % 2 ? "ODD" : "EVEN";
    return { outcome: { faces, total, triple, side }, payout: !triple && side === choice.pick ? round2(stake * 2) : 0 };
  },
};

/* Rendo Coin (coin.js): heads 48.5%, tails 48.5%, edge 3% (every call loses); a call pays 2x: 97%. */
const coin: GameDef<{ pick: "HEADS" | "TAILS" }> = {
  id: "volta-coin", name: "Flip Da' Coin", minBet: 0.2, maxBet: 50000, rtp: 0.97,
  parseChoice: (raw) => ({ pick: pick(raw, "pick", ["HEADS", "TAILS"] as const) }),
  play(choice, stake, rng) {
    const u = rng();
    const result = u < 0.03 ? "EDGE" : u < 0.515 ? "HEADS" : "TAILS";
    return { outcome: { result }, payout: result === choice.pick ? round2(stake * 2) : 0 };
  },
};

/* Red Black (redblack.js): a card from a full 54-card deck (52 + 2 Jokers that lose); the right colour pays 2x:
   2 × 26/54 = 96.3%. For real money every hand is dealt from a freshly shuffled full deck — a deck that runs down
   through a round could be counted. */
const SUITS = ["H", "D", "S", "C"] as const;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const redBlack: GameDef<{ side: "RED" | "BLACK" }> = {
  id: "red-black", name: "Red Black", minBet: 0.2, maxBet: 15000, rtp: (2 * 26) / 54,
  parseChoice: (raw) => ({ side: pick(raw, "side", ["RED", "BLACK"] as const) }),
  play(choice, stake, rng) {
    const i = draw(rng, 54);
    const card = i >= 52 ? { joker: true } : { rank: RANKS[i % 13]!, suit: SUITS[Math.floor(i / 13)]! };
    const colour = "joker" in card ? "JOKER" : card.suit === "H" || card.suit === "D" ? "RED" : "BLACK";
    return { outcome: { card, colour }, payout: colour === choice.side ? round2(stake * 2) : 0 };
  },
};

/* Hi-Lo (hilo.js): a base card shows; the player calls whether the next card is HIGHER or LOWER (aces high, a tie
   loses). The next card is drawn at random from the other 51 cards of a full deck, and each call pays
   97% ÷ its chance, rounded down to the cent — so every call returns a little under 97% (the exact figure for each
   card is in the rules). The base card is the page's (it deals it); the server prices the call from it, so no claimed
   base card can ever be worth more than another. */
const HILO_RTP_TARGET = 0.97;
const HILO_RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"] as const;   /* low to high */
export function hiloWins(rankIndex: number, pick: "HIGHER" | "LOWER"): number {
  return (pick === "HIGHER" ? HILO_RANKS.length - 1 - rankIndex : rankIndex) * 4;
}
/** The multiplier a call pays: 97% ÷ P(win), down to the cent. 0 when the call can't win (HIGHER on an ace). */
export function hiloMultiplier(rankIndex: number, pick: "HIGHER" | "LOWER"): number {
  const wins = hiloWins(rankIndex, pick);
  return wins ? floor2((HILO_RTP_TARGET * 51) / wins) : 0;
}
/** The average return over every base card and call it can win. */
export const HILO_RTP = (() => {
  let total = 0, n = 0;
  HILO_RANKS.forEach((_, i) => (["HIGHER", "LOWER"] as const).forEach((pick) => {
    const wins = hiloWins(i, pick);
    if (wins) { total += (hiloMultiplier(i, pick) * wins) / 51; n++; }
  }));
  return total / n;
})();
const hilo: GameDef<{ rank: number; suit: (typeof SUITS)[number]; pick: "HIGHER" | "LOWER" }> = {
  id: "volta-hilo", name: "Rendo Hi-Lo", minBet: 0.2, maxBet: 10000, rtp: HILO_RTP,
  parseChoice(raw) {
    const pick = pick_(raw, "pick", ["HIGHER", "LOWER"] as const);
    const base = raw && typeof raw === "object" ? (raw as Record<string, unknown>).base : undefined;
    const rankCode = base && typeof base === "object" ? String((base as Record<string, unknown>).rank) : "";
    const suit = base && typeof base === "object" ? String((base as Record<string, unknown>).suit) : "";
    const rank = (HILO_RANKS as readonly string[]).indexOf(rankCode);
    if (rank < 0 || !(SUITS as readonly string[]).includes(suit)) throw new GameError("invalid_choice", "Deal a card first");
    if (!hiloWins(rank, pick)) throw new GameError("invalid_choice", `${pick === "HIGHER" ? "Higher" : "Lower"} can't win on that card`);
    return { rank, suit: suit as (typeof SUITS)[number], pick };
  },
  play(choice, stake, rng) {
    /* the next card: one of the 51 others, each equally likely */
    const baseIndex = (SUITS as readonly string[]).indexOf(choice.suit) * 13 + choice.rank;
    let i = draw(rng, 51);
    if (i >= baseIndex) i++;
    const next = { rank: HILO_RANKS[i % 13]!, suit: SUITS[Math.floor(i / 13)]! };
    const nextRank = i % 13;
    const won = choice.pick === "HIGHER" ? nextRank > choice.rank : nextRank < choice.rank;
    const mult = hiloMultiplier(choice.rank, choice.pick);
    return { outcome: { base: { rank: HILO_RANKS[choice.rank], suit: choice.suit }, next, won, mult }, payout: won ? floor2(stake * mult) : 0 };
  },
};

/* Magic Ball (magicball.js): one ball under one of three cups; chips on up to two spots; the right spot pays 2.9x:
   2.9/3 = 96.7%. */
const magicBall: GameDef<{ bets: Record<string, number> }> = {
  id: "magic-ball", name: "Magic Ball", minBet: 0.2, maxBet: 20000, rtp: 2.9 / 3,
  parseChoice: (raw) => ({ bets: parseBets(raw, ["1", "2", "3"], 0.2, 10000, 2) }),
  stakeOf: (c) => sum(c.bets),
  play(choice, _stake, rng) {
    const ball = 1 + draw(rng, 3);
    return { outcome: { ball }, payout: floor2((choice.bets[String(ball)] ?? 0) * 2.9) };
  },
};

/* Roulette (roulette.js): 13 pockets, 0–12. Returns per unit staked, stake included: number 12x, column 3x,
   red/black/odd/even/low/high 2x — every bet returns 12/13 = 92.3%. */
const RED = [1, 3, 5, 7, 9, 12];
export const ROULETTE_SPOTS: Record<string, { nums: number[]; x: number }> = {
  ...Object.fromEntries(Array.from({ length: 13 }, (_, n) => ["n" + n, { nums: [n], x: 12 }])),
  c1: { nums: [1, 4, 7, 10], x: 3 },
  c2: { nums: [2, 5, 8, 11], x: 3 },
  c3: { nums: [3, 6, 9, 12], x: 3 },
  red: { nums: RED, x: 2 },
  black: { nums: [2, 4, 6, 8, 10, 11], x: 2 },
  odd: { nums: [1, 3, 5, 7, 9, 11], x: 2 },
  even: { nums: [2, 4, 6, 8, 10, 12], x: 2 },
  low: { nums: [1, 2, 3, 4, 5, 6], x: 2 },
  high: { nums: [7, 8, 9, 10, 11, 12], x: 2 },
};
const roulette: GameDef<{ bets: Record<string, number> }> = {
  id: "roulette", name: "Roulette", minBet: 0.1, maxBet: 2000, rtp: 12 / 13,
  parseChoice: (raw) => ({ bets: parseBets(raw, Object.keys(ROULETTE_SPOTS), 0.1, 2000, Object.keys(ROULETTE_SPOTS).length) }),
  stakeOf: (c) => sum(c.bets),
  play(choice, _stake, rng) {
    const pocket = draw(rng, 13);
    const payout = Object.entries(choice.bets)
      .reduce((a, [spot, amount]) => a + (ROULETTE_SPOTS[spot]!.nums.includes(pocket) ? amount * ROULETTE_SPOTS[spot]!.x : 0), 0);
    return { outcome: { pocket }, payout: round2(payout) };
  },
};

/* Rendo Wings (wings.js): the whole flight is drawn at once. Stretches of 2–3 events (weights below) with a carrier
   after each; 30% chance of going down in the sea on each stretch, and at each carrier reached it lands with chance
   LAND_PER_SHIP. The multiplier is kept in whole cents (bombs halve it, rounding down), capped at ×250; landing pays
   stake × multiplier. These constants make the return exactly 97% (the page shows the sum). */
export const WINGS_EVENTS = [
  { kind: "add", value: 1, weight: 300 },
  { kind: "add", value: 2, weight: 90 },
  { kind: "add", value: 5, weight: 22 },
  { kind: "add", value: 10, weight: 6 },
  { kind: "mul", value: 2, weight: 80 },
  { kind: "mul", value: 3, weight: 20 },
  { kind: "mul", value: 4, weight: 6 },
  { kind: "mul", value: 5, weight: 2 },
  { kind: "rocket", value: 0.5, weight: 474 },
] as const;
export const WINGS = { segment: [2, 3], ships: 6, capCents: 25000, down: 0.3, land: 0.192660060661 };
const wingsTotal = WINGS_EVENTS.reduce((s, e) => s + e.weight, 0);
const wingsApply = (c: number, e: (typeof WINGS_EVENTS)[number]) =>
  Math.min(WINGS.capCents, e.kind === "add" ? c + 100 * e.value : e.kind === "mul" ? c * e.value : Math.floor(c / 2));
/** The same plan as wings.js, with events as indexes into WINGS_EVENTS. */
export function wingsPlan(rng: Rng) {
  const events: number[] = [];
  const steps: number[] = [];
  const ships: number[] = [];
  let c = 100;
  let landed = false;
  for (let k = 0; k < WINGS.ships && !landed; k++) {
    const n = WINGS.segment[draw(rng, WINGS.segment.length)]!;
    for (let i = 0; i < n; i++) {
      let r = rng() * wingsTotal;
      let idx = WINGS_EVENTS.findIndex((e) => (r -= e.weight) < 0);
      if (idx < 0) idx = WINGS_EVENTS.length - 1;
      c = wingsApply(c, WINGS_EVENTS[idx]!);
      events.push(idx);
      steps.push(c / 100);
    }
    ships.push(events.length);
    if (rng() < WINGS.down) return { events, steps, ships, landed: false, landAt: -1, downAt: k, final: c / 100 };
    landed = rng() < WINGS.land;
  }
  return { events, steps, ships, landed, landAt: landed ? ships.length - 1 : -1, downAt: -1, final: c / 100 };
}
const wings: GameDef<Record<string, never>> = {
  id: "volta-wings", name: "Rendo Wings", minBet: 0.1, maxBet: 100, rtp: 0.97,
  parseChoice: () => ({}),
  play(_choice, stake, rng) {
    const plan = wingsPlan(rng);
    return { outcome: plan, payout: plan.landed ? floor2(stake * plan.final) : 0 };
  },
};

/* Rendo Olympus (olympus.js + olympus-math.js): the round is played by the page's own maths file, loaded here. The
   server draws four random words, plays the round from them (base spin, tumbles, free spins) and pays it; the page
   replays the same round from the words. Cost: the bet ×1 (spin), ×1.25 (Ante Bet) or ×100 (Buy Free Spins); wins
   round down to the cent and a round pays at most 15,000 × the bet. */
const OLYMPUS_COST = { spin: 1, ante: 1.25, buy: 100 } as const;
type OlympusKind = keyof typeof OLYMPUS_COST;
function olympusGame(): GameDef<{ kind: OlympusKind; bet: number }> | null {
  const M = olympusMath();
  if (!M) return null;
  return {
    id: "volta-olympus", name: "Rendo Olympus", minBet: 0.2, maxBet: 100 * 100, rtp: M.MEASURED.rtp / 100,
    parseChoice(raw) {
      const kind = pick(raw, "kind", ["spin", "ante", "buy"] as const);
      const bet = round2(Number(raw && typeof raw === "object" ? (raw as Record<string, unknown>).bet : NaN));
      if (!Number.isFinite(bet) || bet < 0.2 || bet > 100) throw new GameError("invalid_choice", "Bet between GHS 0.20 and GHS 100");
      return { kind, bet };
    },
    /* the Ante cost rounds UP to the cent (rounding down discounted it by up to 2.6% at odd bets, lifting its RTP
       above the measured 95.03%); spins and bought features are whole pesewas anyway */
    stakeOf: (c) => (c.kind === "ante" ? Math.ceil(c.bet * OLYMPUS_COST.ante * 100 - 1e-6) / 100 : floor2(c.bet * OLYMPUS_COST[c.kind])),
    play(choice, _stake, rng) {
      const seed = [0, 1, 2, 3].map(() => Math.floor(rng() * 4294967296) >>> 0);
      const r = M.round(M.seeded(seed), choice.kind);
      return {
        outcome: { seed, kind: choice.kind, bet: choice.bet, win: r.win, capped: r.capped, freeSpins: r.free.length },
        payout: floor2(r.win * choice.bet),
      };
    },
  };
}

/* Blaze Fruits (fruits.js + fruits-math.js): a 5×3, 20-line fruit slot played by the page's own maths file, loaded
   here. The server draws four random words, spins from them and pays; the page replays the same spin. The stake is
   the total bet (20 × the line bet); wins round down to the cent and a spin pays at most 2,500 × the total bet. */
const FRUITS_LINES = 20;
function fruitsGame(): GameDef<{ bet: number }> | null {
  const M = fruitsMath();
  if (!M) return null;
  return {
    id: "volta-fruits", name: "Blaze Fruits", minBet: 0.2, maxBet: 100, rtp: M.exactRtp().rtp,
    parseChoice(raw) {
      const bet = round2(Number(raw && typeof raw === "object" ? (raw as Record<string, unknown>).bet : NaN));
      if (!Number.isFinite(bet) || bet < 0.2 || bet > 100) throw new GameError("invalid_choice", "Bet between GHS 0.20 and GHS 100");
      if (Math.round(bet * 100) % FRUITS_LINES !== 0) throw new GameError("invalid_choice", "The bet is 20 lines × a whole number of pesewas");
      return { bet };
    },
    stakeOf: (c) => c.bet,
    play(choice, _stake, rng) {
      const seed = [0, 1, 2, 3].map(() => Math.floor(rng() * 4294967296) >>> 0);
      const r = M.spin(M.seeded(seed));
      const lineBet = choice.bet / FRUITS_LINES;
      return {
        outcome: { seed, bet: choice.bet, grid: r.grid, win: r.win, capped: r.capped },
        payout: floor2(r.win * lineBet),
      };
    },
  };
}

export const GAMES: Record<string, GameDef<never>> = Object.fromEntries(
  [bottle, evenOdd, coin, redBlack, hilo, magicBall, roulette, wings, olympusGame(), fruitsGame()]
    .filter((g): g is GameDef<never> => !!g)
    .map((g) => [g.id, g as unknown as GameDef<never>])
);
