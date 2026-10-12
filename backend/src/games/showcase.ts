import type { Pool } from "pg";
import { allGameControls, CATALOG, hiddenCatalog } from "./availability.js";

/*
 * What the game pages may ask about a game's extras, set per game in Admin -> Games:
 *   free play  practice credits with the same odds as real money (on unless an admin turned it off)
 *   showcase   a strip of real big wins on the game page: the highest multipliers players actually won there, read
 *              from the settled bets. Nothing here is made up and nothing touches how a result is drawn.
 */

const lobbyToServer = new Map(Object.entries(CATALOG).map(([serverId, c]) => [c.id, serverId]));

/** The lobby's view: games and studios switched off, and games with free play off or showing big wins (each by its
 *  lobby id and its server id, so any page can find itself). */
export async function publicCatalog(db: Pool) {
  const [hidden, controls] = await Promise.all([hiddenCatalog(db), allGameControls(db)]);
  const lobby = (pick: (c: { free_play: boolean; showcase: boolean }) => boolean) =>
    [...controls.entries()].flatMap(([id, c]) => (CATALOG[id] && pick(c) ? [...new Set([CATALOG[id]!.id, id])] : []));
  return { ...hidden, free_play_off: lobby((c) => !c.free_play), showcase: lobby((c) => c.showcase) };
}

const SHOW_DAYS = 7;
const MIN_X = 2;
const LIMIT = 12;
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; body: unknown }>();

/* "0244123456" -> "024•••••56": enough to feel real, never enough to identify anyone */
const mask = (phone: string | null) => {
  const p = String(phone ?? "");
  return p.length >= 6 ? p.slice(0, 3) + "•".repeat(Math.max(3, p.length - 5)) + p.slice(-2) : "Player";
};

/**
 * A game's (lobby or server id) biggest real wins of the last 7 days, by multiplier (payout / stake, at least 2x). Empty (showcase: false)
 * when the game is unknown or its showcase is off.
 */
export async function bigWins(db: Pool, lobbyId: unknown, now = new Date()) {
  const id = String(lobbyId ?? "");
  const serverId = Object.prototype.hasOwnProperty.call(CATALOG, id) ? id : lobbyToServer.get(id);
  if (!serverId) return { game: id, showcase: false, wins: [] };
  const c = (await allGameControls(db)).get(serverId);
  if (!c?.showcase) return { game: id, showcase: false, wins: [] };
  const hit = cache.get(serverId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body;
  const { rows } = await db.query(
    `SELECT u.phone, b.stake, b.payout, b.settled_at
       FROM settled_bets b JOIN users u ON u.id = b.user_id
      WHERE b.game = $1 AND b.settled_at >= $2 AND b.stake > 0 AND b.payout >= b.stake * $3
      ORDER BY b.payout / b.stake DESC, b.settled_at DESC LIMIT $4`,
    [serverId, new Date(now.getTime() - SHOW_DAYS * 864e5), MIN_X, LIMIT]);
  const body = {
    game: id, showcase: true, days: SHOW_DAYS,
    wins: rows.map((r) => ({
      player: mask(r.phone),
      x: Math.floor((Number(r.payout) / Number(r.stake)) * 100) / 100,
      stake: Math.round(Number(r.stake) * 100) / 100,
      payout: Math.round(Number(r.payout) * 100) / 100,
      at: new Date(r.settled_at).toISOString(),
    })),
  };
  cache.set(serverId, { at: Date.now(), body });
  return body;
}
