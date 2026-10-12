import type { Pool } from "pg";
import { CATALOG } from "./availability.js";

/*
 * Real activity for the public pages, in place of the made-up players they used to show: the bets players really
 * placed and won (settled real-money bets), and how many players are really playing. Players are shown by a masked
 * number only. Nothing here touches a round in play or how any result is drawn.
 */

const lobbyToServer = new Map(Object.entries(CATALOG).map(([serverId, c]) => [c.id, serverId]));
const serverIdOf = (id: string) => (Object.prototype.hasOwnProperty.call(CATALOG, id) ? id : lobbyToServer.get(id));

/** "0244123456" -> "024•••••56": enough to feel real, never enough to identify anyone. */
export const maskPhone = (phone: string | null) => {
  const p = String(phone ?? "");
  return p.length >= 6 ? p.slice(0, 3) + "•".repeat(Math.max(3, p.length - 5)) + p.slice(-2) : "Player";
};

const r2 = (n: unknown) => Math.round(Number(n) * 100) / 100;
const TTL_MS = 5000;
const cache = new Map<string, { at: number; body: unknown }>();
/** Forgets the feeds (tests). */
export const clearFeedCache = () => cache.clear();
async function cached<T>(key: string, make: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.body as T;
  const body = await make();
  cache.set(key, { at: Date.now(), body });
  return body;
}

/* a bet as the pages show it; pick: what was called (a coin side, a card colour) or a ColorGo colour */
function betView(r: Record<string, unknown>) {
  const stake = r2(r.stake);
  const payout = r2(r.payout);
  const choice = (r.choice ?? {}) as Record<string, unknown>;
  const kind = r.kind && r.kind !== "classic" ? String(r.kind) : null;
  return {
    player: maskPhone(r.phone as string | null),
    stake, payout,
    x: payout > 0 ? (r.cashed_x !== null && r.cashed_x !== undefined ? r2(r.cashed_x) : Math.floor((payout / stake) * 100) / 100) : 0,
    pick: (choice.pick ?? choice.side ?? kind ?? null) as string | null,
    at: new Date(r.at as string).toISOString(),
  };
}

/**
 * One game's real activity: players in the last 5 minutes, the latest settled bets (last 24 hours), the biggest wins
 * of the last 7 days, and for one-draw games the latest results (e.g. the coin's last flips).
 */
export async function gameFeed(db: Pool, rawId: unknown, now = new Date()) {
  const id = serverIdOf(String(rawId ?? ""));
  if (!id) return { game: String(rawId ?? ""), playing: 0, recent: [], top: [], results: [] };
  return cached("game:" + id, async () => {
    const day = new Date(now.getTime() - 864e5);
    const week = new Date(now.getTime() - 7 * 864e5);
    const five = new Date(now.getTime() - 5 * 60e3);
    /* the bet's details: a one-draw round's call, a flight bet's cash-out and colour */
    const detail = `LEFT JOIN game_rounds gr ON b.source = 'round' AND gr.id = b.bet_id
                    LEFT JOIN crash_bets cb ON b.source = 'flight' AND cb.id = b.bet_id`;
    const cols = `u.phone, b.stake, b.payout, b.settled_at AS at, gr.choice, cb.cashed_x, cb.kind`;
    const [playing, recent, top, results] = await Promise.all([
      db.query(`SELECT count(DISTINCT user_id) AS n FROM all_bets WHERE game = $1 AND created_at >= $2`, [id, five]),
      db.query(`SELECT ${cols} FROM settled_bets b JOIN users u ON u.id = b.user_id ${detail}
                 WHERE b.game = $1 AND b.settled_at >= $2 ORDER BY b.settled_at DESC LIMIT 30`, [id, day]),
      db.query(`SELECT ${cols} FROM settled_bets b JOIN users u ON u.id = b.user_id ${detail}
                 WHERE b.game = $1 AND b.settled_at >= $2 AND b.payout > b.stake ORDER BY b.payout DESC, b.settled_at DESC LIMIT 20`, [id, week]),
      db.query(`SELECT outcome FROM game_rounds WHERE game = $1 ORDER BY created_at DESC LIMIT 30`, [id]),
    ]);
    return {
      game: CATALOG[id]!.id,
      playing: Number(playing.rows[0]?.n ?? 0),
      recent: recent.rows.map(betView),
      top: top.rows.map(betView),
      results: results.rows.map((r) => r.outcome),
    };
  });
}

/**
 * The whole site: real players per game in the last 15 minutes (lobby ids), and real wins for the home page's
 * winners banner: the biggest of the last 30 days and the latest of the last 7 (each win once; the page shows them in
 * a random order). `big` marks the biggest ones.
 */
export async function siteActivity(db: Pool, now = new Date()) {
  return cached("site", async () => {
    const win = `SELECT b.source, b.bet_id, b.game, u.phone, b.stake, b.payout, b.settled_at AS at
                   FROM settled_bets b JOIN users u ON u.id = b.user_id WHERE b.settled_at >= $1 AND b.payout > b.stake`;
    const [playing, latest, biggest] = await Promise.all([
      db.query(`SELECT game, count(DISTINCT user_id) AS n FROM all_bets WHERE created_at >= $1 GROUP BY game`, [new Date(now.getTime() - 15 * 60e3)]),
      db.query(`${win} ORDER BY b.settled_at DESC LIMIT 12`, [new Date(now.getTime() - 7 * 864e5)]),
      db.query(`${win} ORDER BY b.payout DESC, b.settled_at DESC LIMIT 12`, [new Date(now.getTime() - 30 * 864e5)]),
    ]);
    const bigIds = new Set(biggest.rows.map((r) => r.source + ":" + r.bet_id));
    const seen = new Set<string>();
    const wins = [...biggest.rows, ...latest.rows].filter((r) => {
      const k = r.source + ":" + r.bet_id;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return {
      playing: Object.fromEntries(playing.rows.filter((r) => CATALOG[r.game]).map((r) => [CATALOG[r.game]!.id, Number(r.n)])),
      wins: wins.filter((r) => CATALOG[r.game]).map((r) => ({
        game: CATALOG[r.game]!.id, player: maskPhone(r.phone), stake: r2(r.stake), payout: r2(r.payout), at: new Date(r.at).toISOString(),
        big: bigIds.has(r.source + ":" + r.bet_id),
      })),
    };
  });
}
