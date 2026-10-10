import type { Pool } from "pg";
import { minesMultipliers } from "../games/sessionCatalog.js";
import { LIVE_MULT, LIVE_MINES, minesFromSeed, ensureUpcomingLiveRounds } from "../games/minesLive.js";

export interface AdminMinesSignal {
  sessionId: string;
  playerId: string;
  username: string;
  game: string;
  stake: number;
  totalMines: number;
  currentCashoutMultiplier: number;
  status: "OPEN";
  pickedPositions: number[];
  minePositions: number[];
  updatedAt: Date;
  source: "standard" | "live";
  hasBet?: boolean;
  /** Live rounds: which round, when its countdown starts and ends, and whether it's in play yet. */
  roundNo?: number;
  startsAt?: number;
  endsAt?: number;
  phase?: "live" | "next";
}

interface SessionRow {
  id: string;
  user_id: string;
  game: string;
  stake: string;
  params: { mines: number };
  secret: { mines: number[] };
  progress: { picked: number[] };
  status: "OPEN";
  updated_at: Date;
  username: string;
}

interface LiveBetRow {
  id: string | null;
  round_no: string;
  user_id: string | null;
  stake: string | null;
  picks: number[] | null;
  status: "OPEN" | null;
  updated_at: Date | null;
  username: string | null;
  seed: string;
  starts_at: Date;
  ends_at: Date;
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => Number.isInteger(item)) : [];
}

/** Admin-only projection: the same database secret used by the player engine, never exposed through player APIs. */
export async function listAdminMinesSignals(db: Pool): Promise<AdminMinesSignal[]> {
  const { rows } = await db.query<SessionRow>(
    `SELECT s.id, s.user_id, u.username, s.game, s.stake, s.params, s.secret, s.progress, s.status, s.updated_at
     FROM game_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.game = 'volta-mines' AND s.status = 'OPEN'
     ORDER BY s.updated_at DESC, s.id`,
  );

  const standard = rows.map((row) => {
    const picked = numberArray(row.progress.picked);
    const minePositions = numberArray(row.secret.mines).sort((a, b) => a - b);
    const multiplier = minesMultipliers(row.params.mines)[picked.length] ?? 1;
    return {
      sessionId: row.id,
      playerId: row.user_id,
      username: row.username,
      game: row.game,
      stake: Number(row.stake),
      totalMines: row.params.mines,
      currentCashoutMultiplier: multiplier,
      status: row.status,
      pickedPositions: picked,
      minePositions,
      updatedAt: row.updated_at,
      source: "standard" as const,
    };
  });

  /* the round in play and the next one, so the next board is on the admin page before its countdown starts */
  await ensureUpcomingLiveRounds(db);
  const { rows: liveRows } = await db.query<LiveBetRow>(
    `SELECT b.id, r.no AS round_no, b.user_id, u.username, b.stake, b.picks, b.status, b.updated_at,
            r.seed, r.starts_at, r.ends_at
     FROM mines_live_rounds r
     LEFT JOIN mines_live_bets b ON b.round_no = r.no AND b.status = 'OPEN'
     LEFT JOIN users u ON u.id = b.user_id
     WHERE r.ends_at > now() AND r.starts_at < now() + interval '3 minutes'
     ORDER BY r.no, COALESCE(b.updated_at, r.created_at) DESC, b.id`,
  );

  const now = Date.now();
  const live = liveRows.map((row) => {
    const picked = numberArray(row.picks);
    const minePositions = minesFromSeed(row.seed, Number(row.round_no));
    const hasBet = Boolean(row.id);
    const startsAt = new Date(row.starts_at).getTime();
    const endsAt = new Date(row.ends_at).getTime();
    return {
      sessionId: row.id ?? `round-${row.round_no}`,
      playerId: row.user_id ?? `round-${row.round_no}`,
      username: row.username ?? "No bets yet",
      game: "volta-mines-live",
      stake: Number(row.stake ?? 0),
      totalMines: LIVE_MINES,
      currentCashoutMultiplier: LIVE_MULT[picked.length] ?? 1,
      status: row.status ?? "OPEN",
      pickedPositions: picked,
      minePositions,
      updatedAt: row.updated_at ?? new Date(startsAt),
      source: "live" as const,
      hasBet,
      roundNo: Number(row.round_no),
      startsAt,
      endsAt,
      phase: startsAt <= now ? ("live" as const) : ("next" as const),
    };
  });

  /* live rounds first (the one in play, then the next), then players' own Mines rounds, newest first */
  return [...live, ...standard.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())];
}
