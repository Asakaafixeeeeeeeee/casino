import type { Pool } from "pg";
import { allGameControls, CATALOG, clearGameControlsCache, gameControls, hiddenCatalog, isPaused, PROVIDERS, type GameControls } from "../games/availability.js";
import { GAMES } from "../games/catalog.js";
import { FLIGHT_GAMES } from "../games/flights.js";
import { LIVE_MAX_BET, LIVE_MIN_BET } from "../games/minesLive.js";
import { SESSION_GAMES } from "../games/sessionCatalog.js";
import { getSkySettings, SKY_ID } from "../games/skyRush.js";
import { AdminError, logAction } from "./admin.js";

/*
 * The admin's Games tab: every game on the site with its own controls and numbers.
 *   controls   on/off (the lobby switch), pause and resume (optionally until a time), tighter bet limits, and for
 *              Knockout, Crash and Jet the betting time before each round and the longest round (top multiplier)
 *   numbers    live activity, betting statistics, history, and players' wins and losses, from the bets themselves
 * What an admin can't do here, on purpose: see a round's result before it's over, or change a result. Every outcome
 * is drawn by the server when the round opens; a setting only applies to rounds that haven't been drawn yet.
 */

const num = (v: unknown) => Number(v ?? 0);
const round2 = (x: number) => Math.round(x * 100) / 100;

type Kind = "instant" | "session" | "flight" | "aviator" | "live" | "demo";
interface Engine { kind: Kind; rtp: number | null; minBet: number | null; maxBet: number | null; waitMs?: number; maxCrash?: number }

/** What each game is and its own limits (the limits an admin can only tighten). */
async function engineOf(db: Pool, serverId: string): Promise<Engine> {
  const has = (o: object) => Object.prototype.hasOwnProperty.call(o, serverId);
  if (has(FLIGHT_GAMES)) {
    const g = FLIGHT_GAMES[serverId]!;
    return { kind: "flight", rtp: g.rtp, minBet: g.minBet, maxBet: g.maxBet, waitMs: g.waitMs, maxCrash: g.maxCrash };
  }
  if (has(GAMES)) {
    const g = GAMES[serverId]!;
    return { kind: "instant", rtp: g.rtp, minBet: g.minBet, maxBet: g.maxBet };
  }
  if (has(SESSION_GAMES)) {
    const g = SESSION_GAMES[serverId]!;
    return { kind: "session", rtp: g.rtp, minBet: g.minBet, maxBet: g.maxBet };
  }
  if (serverId === SKY_ID) {
    const s = await getSkySettings(db);
    return { kind: "aviator", rtp: s.rtp, minBet: s.min_bet, maxBet: s.max_bet };
  }
  if (serverId === "volta-mines-live") return { kind: "live", rtp: null, minBet: LIVE_MIN_BET, maxBet: LIVE_MAX_BET };
  return { kind: "demo", rtp: null, minBet: null, maxBet: null };
}

const KIND_NOTE: Record<Kind, string> = {
  instant: "Each bet is one instant round, drawn when it's placed.",
  session: "Each round is the player's own, played step by step until they cash out or lose.",
  flight: "Each player gets their own rounds: betting time, then the multiplier climbs until the round ends.",
  aviator: "One shared round for everyone. Its RTP and bet limits are in the Aviator tab.",
  live: "One shared 3-minute round for everyone.",
  demo: "Demo credits only, on its own server: no real-money bets to show.",
};

function controlsView(c: GameControls) {
  return { ...c, paused_now: isPaused(c) };
}

/** Every game: on/off, paused, its limits, and today's and live numbers. */
export async function gamesOverview(db: Pool, now = new Date()) {
  const hidden = await hiddenCatalog(db);
  const controls = await allGameControls(db);
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const [today, live] = await Promise.all([
    db.query(`SELECT game, count(*) AS bets, count(DISTINCT user_id) AS players, coalesce(sum(stake), 0) AS staked, coalesce(sum(payout), 0) AS paid
                FROM settled_bets WHERE settled_at >= $1 GROUP BY game`, [midnight]),
    db.query(`SELECT game, count(*) FILTER (WHERE NOT settled) AS in_play, count(DISTINCT user_id) AS players
                FROM all_bets WHERE created_at >= $1 OR NOT settled GROUP BY game`, [new Date(now.getTime() - 5 * 60e3)]),
  ]);
  const t = new Map(today.rows.map((r) => [String(r.game), r]));
  const l = new Map(live.rows.map((r) => [String(r.game), r]));
  const games = await Promise.all(Object.entries(CATALOG).map(async ([serverId, c]) => {
    const e = await engineOf(db, serverId);
    const s = t.get(serverId);
    const lv = l.get(serverId);
    const ctl = controls.get(serverId);
    const staked = num(s?.staked);
    const paid = num(s?.paid);
    return {
      id: serverId, lobby_id: c.id, name: c.name, studio: PROVIDERS[c.provider] ?? c.provider, kind: e.kind,
      enabled: !hidden.games.includes(c.id), studio_enabled: !hidden.providers.includes(c.provider),
      paused: ctl ? isPaused(ctl) : false, paused_until: ctl?.paused_until ?? null,
      rtp: e.rtp === null ? null : round2(e.rtp * 100),
      today: { bets: num(s?.bets), players: num(s?.players), staked: round2(staked), paid: round2(paid), ggr: round2(staked - paid) },
      live: { in_play: num(lv?.in_play), players: num(lv?.players) },
    };
  }));
  return { games, server_now: now.getTime() };
}

const known = (serverId: unknown) => {
  const id = String(serverId ?? "");
  if (!Object.prototype.hasOwnProperty.call(CATALOG, id)) throw new AdminError("not_found", "No such game", 404);
  return id;
};

/** One game in full: its controls, live activity, statistics, history and players' wins and losses. */
export async function gameDetail(db: Pool, serverId: unknown, now = new Date()) {
  const id = known(serverId);
  const c = CATALOG[id]!;
  const e = await engineOf(db, id);
  const hidden = await hiddenCatalog(db);
  const ctl = await gameControls(db, id);
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);

  const totals = async (since: Date) => {
    const r = (await db.query(
      `SELECT count(*) AS bets, count(DISTINCT user_id) AS players, coalesce(sum(stake), 0) AS staked, coalesce(sum(payout), 0) AS paid,
              coalesce(max(payout), 0) AS top_win, count(*) FILTER (WHERE payout > stake) AS wins
         FROM settled_bets WHERE game = $1 AND settled_at >= $2`, [id, since])).rows[0]!;
    const staked = num(r.staked);
    const paid = num(r.paid);
    return {
      bets: num(r.bets), players: num(r.players), staked: round2(staked), paid: round2(paid), ggr: round2(staked - paid),
      actual_rtp: staked > 0 ? round2((paid / staked) * 100) : null, top_win: round2(num(r.top_win)),
      win_rate: num(r.bets) ? round2((100 * num(r.wins)) / num(r.bets)) : null,
    };
  };
  const [today, week, month] = await Promise.all([totals(midnight), totals(new Date(now.getTime() - 7 * 864e5)), totals(new Date(now.getTime() - 30 * 864e5))]);

  /* the last 14 days, a bar per day (UTC) */
  const daily = (await db.query(
    `SELECT to_char(date_trunc('day', settled_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*) AS bets,
            coalesce(sum(stake), 0) AS staked, coalesce(sum(payout), 0) AS paid
       FROM settled_bets WHERE game = $1 AND settled_at >= $2 GROUP BY 1 ORDER BY 1`,
    [id, new Date(now.getTime() - 14 * 864e5)])).rows.map((r) => ({ day: r.day, bets: num(r.bets), staked: round2(num(r.staked)), ggr: round2(num(r.staked) - num(r.paid)) }));

  /* live: bets still in play, and the last few minutes */
  const inPlay = (await db.query(
    `SELECT count(*) AS bets, count(DISTINCT user_id) AS players, coalesce(sum(stake), 0) AS staked FROM all_bets WHERE game = $1 AND NOT settled`, [id])).rows[0]!;
  const active5 = (await db.query(
    `SELECT count(DISTINCT user_id) AS players, count(*) AS bets FROM all_bets WHERE game = $1 AND created_at >= $2`, [id, new Date(now.getTime() - 5 * 60e3)])).rows[0]!;
  const recent = (await db.query(
    `SELECT b.user_id, u.username, u.full_name, u.phone, b.stake, b.payout, b.settled, b.created_at
       FROM all_bets b JOIN users u ON u.id = b.user_id WHERE b.game = $1 ORDER BY b.created_at DESC LIMIT 60`, [id])).rows
    .map((r) => ({
      user_id: r.user_id, name: r.full_name || r.username || "Player", phone: r.phone, stake: round2(num(r.stake)),
      payout: r.settled ? round2(num(r.payout)) : null, settled: !!r.settled, at: r.created_at,
    }));

  /* players' wins and losses on this game, last 30 days (net = what they were paid minus what they staked) */
  const players = (await db.query(
    `SELECT b.user_id, u.username, u.full_name, u.phone, count(*) AS bets, sum(b.stake) AS staked, sum(b.payout) AS paid,
            sum(b.payout) - sum(b.stake) AS net, max(b.settled_at) AS last_bet
       FROM settled_bets b JOIN users u ON u.id = b.user_id
      WHERE b.game = $1 AND b.settled_at >= $2 GROUP BY b.user_id, u.username, u.full_name, u.phone`,
    [id, new Date(now.getTime() - 30 * 864e5)])).rows.map((r) => ({
      user_id: r.user_id, name: r.full_name || r.username || "Player", phone: r.phone, bets: num(r.bets),
      staked: round2(num(r.staked)), paid: round2(num(r.paid)), net: round2(num(r.net)), last_bet: r.last_bet,
    }));
  const winners = players.filter((p) => p.net > 0).sort((a, b) => b.net - a.net).slice(0, 10);
  const losers = players.filter((p) => p.net < 0).sort((a, b) => a.net - b.net).slice(0, 10);

  /* Knockout, Crash, Jet: rounds in play (never their result) and finished rounds with their multipliers */
  let rounds = null;
  if (e.kind === "flight") {
    const n = new Date(now);
    const open = (await db.query(
      `SELECT f.id, f.starts_at, u.username, u.full_name, u.phone, f.user_id,
              coalesce(sum(b.stake) FILTER (WHERE b.status <> 'CANCELLED'), 0) AS staked,
              count(b.id) FILTER (WHERE b.status <> 'CANCELLED') AS bets,
              count(b.id) FILTER (WHERE b.status = 'ACTIVE') AS riding
         FROM crash_flights f JOIN users u ON u.id = f.user_id LEFT JOIN crash_bets b ON b.flight_id = f.id
        WHERE f.game = $1 AND f.ends_at > $2 GROUP BY f.id, u.username, u.full_name, u.phone ORDER BY f.starts_at DESC LIMIT 50`, [id, n])).rows
      .map((r) => ({
        player: r.full_name || r.username || "Player", phone: r.phone, user_id: r.user_id,
        phase: new Date(r.starts_at).getTime() > now.getTime() ? "betting" : "in play",
        starts_in_ms: new Date(r.starts_at).getTime() - now.getTime(), bets: num(r.bets), riding: num(r.riding), staked: round2(num(r.staked)),
      }));
    const finished = (await db.query(
      `SELECT f.crash, f.ends_at, u.username, u.full_name, coalesce(sum(b.stake) FILTER (WHERE b.status IN ('WON', 'LOST')), 0) AS staked,
              coalesce(sum(b.payout) FILTER (WHERE b.status = 'WON'), 0) AS paid, count(b.id) FILTER (WHERE b.status IN ('WON', 'LOST')) AS bets,
              max(b.cashed_x) AS best_x
         FROM crash_flights f JOIN users u ON u.id = f.user_id JOIN crash_bets b ON b.flight_id = f.id
        WHERE f.game = $1 AND f.ends_at <= $2 GROUP BY f.id, u.username, u.full_name ORDER BY f.ends_at DESC LIMIT 40`, [id, n])).rows
      .map((r) => ({
        crash: num(r.crash), at: r.ends_at, player: r.full_name || r.username || "Player", bets: num(r.bets),
        staked: round2(num(r.staked)), paid: round2(num(r.paid)), best_x: r.best_x === null ? null : num(r.best_x),
      }));
    const dist = (await db.query(
      `SELECT count(*) AS rounds, percentile_cont(0.5) WITHIN GROUP (ORDER BY crash) AS median, max(crash) AS highest,
              count(*) FILTER (WHERE crash >= 2) AS x2, count(*) FILTER (WHERE crash >= 10) AS x10
         FROM crash_flights f WHERE f.game = $1 AND f.ends_at <= $2 AND f.ends_at >= $3
          AND EXISTS (SELECT 1 FROM crash_bets b WHERE b.flight_id = f.id)`, [id, n, new Date(now.getTime() - 7 * 864e5)])).rows[0]!;
    const r = num(dist.rounds);
    rounds = {
      open, finished,
      week: { rounds: r, median: dist.median === null ? null : round2(num(dist.median)), highest: dist.highest === null ? null : num(dist.highest),
        at_least_2x: r ? round2((100 * num(dist.x2)) / r) : null, at_least_10x: r ? round2((100 * num(dist.x10)) / r) : null },
    };
  }

  return {
    server_now: now.getTime(),
    game: {
      id, lobby_id: c.id, name: c.name, studio: PROVIDERS[c.provider] ?? c.provider, studio_id: c.provider, kind: e.kind, note: KIND_NOTE[e.kind],
      enabled: !hidden.games.includes(c.id), studio_enabled: !hidden.providers.includes(c.provider),
      rtp: e.rtp === null ? null : round2(e.rtp * 100), min_bet: e.minBet, max_bet: e.maxBet,
      ...(e.kind === "flight" ? { wait_ms: e.waitMs, max_x: e.maxCrash, max_x_settable: (e.maxCrash ?? 0) > 100 } : {}),
    },
    controls: controlsView(ctl),
    stats: { today, week, month, daily },
    live: { in_play: { bets: num(inPlay.bets), players: num(inPlay.players), staked: round2(num(inPlay.staked)) },
      last5: { players: num(active5.players), bets: num(active5.bets) }, recent },
    players: { winners, losers },
    rounds,
  };
}

/** An admin changes a game's controls. Every change is checked, logged, and applies from the next round or bet. */
export async function saveGameControls(db: Pool, admin: string, serverId: unknown, input: Record<string, unknown>, now = new Date()) {
  const id = known(serverId);
  const e = await engineOf(db, id);
  const cur = await gameControls(db, id);
  const next: GameControls = { ...cur };
  const money = (v: unknown, label: string) => {
    if (v === null || v === "") return null;
    const n = Math.round(Number(v) * 100) / 100;
    if (!Number.isFinite(n) || n <= 0) throw new AdminError("invalid_" + label, `Enter a valid ${label.replace("_", " ")}`);
    return n;
  };

  if (input.paused !== undefined) {
    if (typeof input.paused !== "boolean") throw new AdminError("invalid_paused", "Say whether the game is paused");
    if (e.kind === "demo") throw new AdminError("not_supported", "This demo game can only be switched on or off");
    next.paused = input.paused;
    if (!input.paused) { next.paused_until = null; next.pause_note = null; }
  }
  if (input.paused_until !== undefined) {
    if (input.paused_until === null || input.paused_until === "") next.paused_until = null;
    else {
      const d = new Date(String(input.paused_until));
      if (Number.isNaN(d.getTime()) || d.getTime() <= now.getTime()) throw new AdminError("invalid_resume", "Choose a resume time in the future");
      if (d.getTime() > now.getTime() + 30 * 864e5) throw new AdminError("invalid_resume", "Choose a resume time within 30 days");
      next.paused_until = d.toISOString();
    }
  }
  if (input.pause_note !== undefined) next.pause_note = String(input.pause_note ?? "").trim().slice(0, 120) || null;

  if (input.min_bet !== undefined || input.max_bet !== undefined) {
    if (e.kind === "aviator" || e.kind === "demo") throw new AdminError("not_supported", e.kind === "aviator" ? "Aviator's bet limits are set in the Aviator tab" : "This demo game has no real-money limits");
    if (input.min_bet !== undefined) next.min_bet = money(input.min_bet, "min_bet");
    if (input.max_bet !== undefined) next.max_bet = money(input.max_bet, "max_bet");
    if (next.min_bet !== null && next.min_bet < e.minBet!) throw new AdminError("invalid_min_bet", `The minimum bet can't be below the game's own GHS ${e.minBet!.toFixed(2)}`);
    if (next.max_bet !== null && next.max_bet > e.maxBet!) throw new AdminError("invalid_max_bet", `The maximum bet can't be above the game's own GHS ${e.maxBet!.toLocaleString("en-GH")}`);
    if ((next.min_bet ?? e.minBet!) > (next.max_bet ?? e.maxBet!)) throw new AdminError("invalid_max_bet", "The maximum bet must be at least the minimum bet");
    /* the game's own limit is the same as no setting */
    if (next.min_bet === e.minBet) next.min_bet = null;
    if (next.max_bet === e.maxBet) next.max_bet = null;
  }
  if (input.wait_ms !== undefined) {
    if (e.kind !== "flight") throw new AdminError("not_supported", "Betting time can be set for Knockout, Crash and Jet");
    if (input.wait_ms === null || input.wait_ms === "") next.wait_ms = null;
    else {
      const ms = Math.round(Number(input.wait_ms));
      if (!Number.isFinite(ms) || ms < 3000 || ms > 60000) throw new AdminError("invalid_wait", "The betting time must be 3 to 60 seconds");
      next.wait_ms = ms === e.waitMs ? null : ms;
    }
  }
  if (input.max_x !== undefined) {
    if (e.kind !== "flight" || (e.maxCrash ?? 0) <= 100) throw new AdminError("not_supported", "The longest round can be set for Knockout and Crash");
    if (input.max_x === null || input.max_x === "") next.max_x = null;
    else {
      const x = Math.round(Number(input.max_x) * 100) / 100;
      if (!Number.isFinite(x) || x < 2 || x > e.maxCrash!) throw new AdminError("invalid_max_x", `The top multiplier must be 2x to ${e.maxCrash!.toLocaleString("en-GH")}x`);
      next.max_x = x === e.maxCrash ? null : x;
    }
  }

  await db.query(
    `INSERT INTO game_settings (game, paused, paused_until, pause_note, min_bet, max_bet, wait_ms, max_x, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (game) DO UPDATE SET paused = EXCLUDED.paused, paused_until = EXCLUDED.paused_until, pause_note = EXCLUDED.pause_note,
       min_bet = EXCLUDED.min_bet, max_bet = EXCLUDED.max_bet, wait_ms = EXCLUDED.wait_ms, max_x = EXCLUDED.max_x,
       updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [id, next.paused, next.paused_until, next.pause_note, next.min_bet, next.max_bet, next.wait_ms, next.max_x, admin]);
  clearGameControlsCache();
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => k !== "updated_by" && k !== "updated_at" && (cur as unknown as Record<string, unknown>)[k] !== v));
  await logAction(db, admin, "game.controls", `game:${id}`, { before: Object.fromEntries(Object.keys(changed).map((k) => [k, (cur as unknown as Record<string, unknown>)[k]])), after: changed });
  return { controls: controlsView(await gameControls(db, id)) };
}
