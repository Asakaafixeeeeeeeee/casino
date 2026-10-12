import type { Pool } from "pg";
import { GameError } from "./catalog.js";

/*
 * Which games and studios are open. The lobby (assets/js/data.js) knows each game by its own id and studio; the
 * engines use their own ids, so CATALOG maps one to the other (a test keeps it in step with data.js). An admin can
 * switch off a game or a whole studio: it leaves the lobby, and the server refuses new real-money bets on it. A round
 * already in play can always be finished, so nobody's stake is stranded.
 */
export const CATALOG: Record<string, { id: string; name: string; provider: string }> = {
  "volta-crash": { id: "crash", name: "Crash", provider: "bonwire" },
  "volta-wings": { id: "wings", name: "Rendo Wings", provider: "bonwire" },
  "volta-jet": { id: "jet", name: "Jet", provider: "bonwire" },
  "sky-rush": { id: "aviator", name: "Aviator", provider: "bonwire" },
  "volta-knockout": { id: "knockout", name: "Knockout", provider: "bonwire" },
  "volta-olympus": { id: "olympus", name: "Olympus", provider: "bonwire" },
  "volta-fruits": { id: "blaze-fruits", name: "Blaze Fruits", provider: "accra" },
  "volta-hilo": { id: "hi-lo", name: "Hi-Lo", provider: "bonwire" },
  /* demo credits only, on its own server; listed so the lobby and the admin catalogue agree */
  "volta-magicball-live": { id: "magic-ball-live", name: "Magic Ball Live", provider: "accra" },
  "volta-bottle": { id: "bottle", name: "Bottle", provider: "accra" },
  "red-black": { id: "red-black", name: "Red Black", provider: "accra" },
  "volta-mines": { id: "mines", name: "Mines", provider: "accra" },
  "magic-ball": { id: "magic-ball", name: "Magic Ball", provider: "accra" },
  "volta-crossing": { id: "crossing", name: "Crossing", provider: "accra" },
  "roulette": { id: "roulette", name: "Roulette", provider: "accra" },
  "even-odd": { id: "even-odd", name: "Even-Odd", provider: "accra" },
  "volta-goal": { id: "goal", name: "Goal", provider: "accra" },
  "volta-coin": { id: "coin", name: "Flip Da' Coin", provider: "accra" },
  "volta-mines-live": { id: "mines-live", name: "Live Mines", provider: "accra" },
};

/** The studios behind the games (data.js providers). */
export const PROVIDERS: Record<string, string> = { bonwire: "Bonwire Labs", accra: "Accra Play" };

export interface Hidden {
  games: string[];      // lobby ids switched off
  providers: string[];  // studio ids switched off
}

/* a few seconds' cache, so a bet doesn't cost an extra query; any change made here clears it at once */
const TTL_MS = 5000;
let cache: { at: number; hidden: Hidden } | null = null;

export async function hiddenCatalog(db: Pool): Promise<Hidden> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.hidden;
  const { rows } = await db.query<{ kind: string; id: string }>(`SELECT kind, id FROM catalog_settings WHERE NOT enabled`);
  const hidden = {
    games: rows.filter((r) => r.kind === "game").map((r) => r.id),
    providers: rows.filter((r) => r.kind === "provider").map((r) => r.id),
  };
  cache = { at: Date.now(), hidden };
  return hidden;
}

/** Switches a lobby game or a studio on or off (ids are checked by the caller). */
export async function setCatalogEnabled(
  db: Pool, kind: "game" | "provider", id: string, enabled: boolean, by: string
): Promise<void> {
  await db.query(
    `INSERT INTO catalog_settings (kind, id, enabled, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (kind, id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [kind, id, enabled, by]);
  cache = null;
}

/** Refuses a new real-money bet on a game that's switched off (on its own or with its studio). */
export async function assertGameOpen(db: Pool, serverGameId: string): Promise<void> {
  const entry = Object.prototype.hasOwnProperty.call(CATALOG, serverGameId) ? CATALOG[serverGameId] : undefined;
  if (!entry) return;
  const hidden = await hiddenCatalog(db);
  if (hidden.games.includes(entry.id) || hidden.providers.includes(entry.provider)) {
    throw new GameError("game_disabled", "This game is temporarily unavailable. Please try another one.", 503);
  }
  await assertNotPaused(db, serverGameId);
}

/* ---------------- per-game controls (game_settings): pause, tighter bet limits, round timing ---------------- */

export interface GameControls {
  paused: boolean;
  paused_until: string | null;
  pause_note: string | null;
  min_bet: number | null;
  max_bet: number | null;
  wait_ms: number | null;
  max_x: number | null;
  updated_by: string | null;
  updated_at: string | null;
}
const NONE: GameControls = { paused: false, paused_until: null, pause_note: null, min_bet: null, max_bet: null, wait_ms: null, max_x: null, updated_by: null, updated_at: null };
let controlsCache: { at: number; byGame: Map<string, GameControls> } | null = null;

/** Every game's controls (a few seconds' cache; a change made here clears it at once). */
export async function allGameControls(db: Pool): Promise<Map<string, GameControls>> {
  if (controlsCache && Date.now() - controlsCache.at < TTL_MS) return controlsCache.byGame;
  const { rows } = await db.query(`SELECT * FROM game_settings`);
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const byGame = new Map(rows.map((r) => [String(r.game), {
    paused: !!r.paused, paused_until: r.paused_until ? new Date(r.paused_until).toISOString() : null, pause_note: r.pause_note ?? null,
    min_bet: n(r.min_bet), max_bet: n(r.max_bet), wait_ms: n(r.wait_ms), max_x: n(r.max_x),
    updated_by: r.updated_by ?? null, updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  } as GameControls]));
  controlsCache = { at: Date.now(), byGame };
  return byGame;
}
export async function gameControls(db: Pool, serverGameId: string): Promise<GameControls> {
  return (await allGameControls(db)).get(serverGameId) ?? NONE;
}
export const clearGameControlsCache = () => { controlsCache = null; };

/** Paused right now: paused, and not past the time it was set to resume. */
export const isPaused = (c: GameControls, now = Date.now()) => c.paused && (!c.paused_until || new Date(c.paused_until).getTime() > now);

/** Refuses a new round or bet while an admin has paused the game. */
export async function assertNotPaused(db: Pool, serverGameId: string): Promise<void> {
  const c = await gameControls(db, serverGameId);
  if (isPaused(c)) {
    const until = c.paused_until ? " It reopens at " + new Date(c.paused_until).toISOString().slice(11, 16) + " GMT." : "";
    throw new GameError("game_paused", "This game is paused for a moment." + until + " Please try again shortly.", 503);
  }
}

/** An admin's tighter bet limits for a game (the game's own limits are checked by the game itself). */
export async function assertStakeAllowed(db: Pool, serverGameId: string, stake: number): Promise<void> {
  const c = await gameControls(db, serverGameId);
  if ((c.min_bet !== null && stake < c.min_bet) || (c.max_bet !== null && stake > c.max_bet)) {
    const lo = (c.min_bet ?? 0).toFixed(2);
    throw new GameError("invalid_stake", c.max_bet !== null
      ? `Bet between GHS ${lo} and GHS ${c.max_bet.toLocaleString("en-GH", { minimumFractionDigits: 2 })} on this game`
      : `The minimum bet on this game is GHS ${lo}`);
  }
}
