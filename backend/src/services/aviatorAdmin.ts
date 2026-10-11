// src/services/aviatorAdmin.ts
//
// The admin's Aviator (Sky Rush) tab: a live monitor of rounds and bets, and the published RTP and bet limits.
// The crash point of a round still in play is never sent here; it shows only once the plane has flown away.
// Pausing uses the Games tab's switch (catalog_settings, game id "aviator").

import type { Pool } from "pg";
import { hiddenCatalog } from "../games/availability.js";
import { GameError } from "../games/catalog.js";
import { getSkySettings, saveSkySettings } from "../games/skyRush.js";
import { AdminError, logAction } from "./admin.js";

const num = (v: unknown) => Number(v ?? 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

export async function aviatorOverview(db: Pool, now = Date.now()) {
  const settings = await getSkySettings(db);
  const hidden = await hiddenCatalog(db);
  const enabled = !hidden.games.includes("aviator") && !hidden.providers.includes("bonwire");

  const cur = (await db.query<{ no: string; hash: string; starts_at: Date; ends_at: Date; crash: string; rtp: string }>(
    `SELECT no, hash, starts_at, ends_at, crash, rtp FROM sky_rounds ORDER BY no DESC LIMIT 1`)).rows[0];
  let round: Record<string, unknown> | null = null;
  if (cur) {
    const startsAt = new Date(cur.starts_at).getTime();
    const endsAt = new Date(cur.ends_at).getTime();
    const phase = now < startsAt ? "betting" : now < endsAt ? "flying" : "ended";
    const bets = (await db.query<{
      full_name: string | null; username: string | null; phone: string | null; stake: string; auto_target: string | null;
      status: string; cashed_x: string | null; payout: string; created_at: Date;
    }>(
      `SELECT u.full_name, u.username, u.phone, b.stake, b.auto_target, b.status, b.cashed_x, b.payout, b.created_at
         FROM sky_bets b JOIN users u ON u.id = b.user_id
        WHERE b.round_no = $1 AND b.status <> 'CANCELLED' ORDER BY b.stake DESC, b.created_at LIMIT 200`, [cur.no])).rows;
    round = {
      no: num(cur.no), hash: cur.hash, phase, rtp: num(cur.rtp), starts_at: startsAt,
      ...(phase === "ended" ? { crash: num(cur.crash), ends_at: endsAt } : {}),
      staked: round2(bets.reduce((t, b) => t + num(b.stake), 0)),
      players: new Set(bets.map((b) => b.phone ?? b.username)).size,
      bets: bets.map((b) => ({
        name: b.full_name || b.username || "Player", phone: b.phone, stake: num(b.stake),
        auto: b.auto_target === null ? null : num(b.auto_target), status: b.status,
        x: b.cashed_x === null ? null : num(b.cashed_x), payout: num(b.payout),
      })),
    };
  }

  const recent = (await db.query<{ no: string; crash: string; rtp: string; ends_at: Date; bets: string; players: string; staked: string; paid: string }>(
    `SELECT r.no, r.crash, r.rtp, r.ends_at,
            count(b.id) FILTER (WHERE b.status <> 'CANCELLED')                     AS bets,
            count(DISTINCT b.user_id) FILTER (WHERE b.status <> 'CANCELLED')       AS players,
            coalesce(sum(b.stake) FILTER (WHERE b.status <> 'CANCELLED'), 0)       AS staked,
            coalesce(sum(b.payout) FILTER (WHERE b.status = 'WON'), 0)             AS paid
       FROM sky_rounds r LEFT JOIN sky_bets b ON b.round_no = r.no
      WHERE r.ends_at <= $1
      GROUP BY r.no ORDER BY r.no DESC LIMIT 25`, [new Date(now)])).rows.map((r) => ({
    no: num(r.no), crash: num(r.crash), rtp: num(r.rtp), at: new Date(r.ends_at).getTime(), bets: num(r.bets),
    players: num(r.players), staked: round2(num(r.staked)), paid: round2(num(r.paid)), profit: round2(num(r.staked) - num(r.paid)),
  }));

  /* settled bets only (an active bet's outcome isn't known yet); Ghana time is UTC */
  const totals = async (since: Date) => {
    const t = (await db.query<{ rounds: string; bets: string; players: string; staked: string; paid: string }>(
      `SELECT count(DISTINCT b.round_no) AS rounds, count(*) AS bets, count(DISTINCT b.user_id) AS players,
              coalesce(sum(b.stake), 0) AS staked, coalesce(sum(b.payout), 0) AS paid
         FROM sky_bets b JOIN sky_rounds r ON r.no = b.round_no
        WHERE b.status IN ('WON', 'LOST') AND r.starts_at >= $1`, [since])).rows[0]!;
    const staked = num(t.staked);
    const paid = num(t.paid);
    return { rounds: num(t.rounds), bets: num(t.bets), players: num(t.players), staked: round2(staked), paid: round2(paid),
      profit: round2(staked - paid), actual_rtp: staked > 0 ? round2((paid / staked) * 100) : null };
  };
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);

  return {
    server_now: now,
    enabled,
    settings: { ...settings, rtp_pct: round2(settings.rtp * 100) },
    round,
    recent,
    today: await totals(midnight),
    week: await totals(new Date(now - 7 * 864e5)),
  };
}

export async function saveAviatorSettings(db: Pool, admin: string, input: Record<string, unknown>) {
  try {
    const before = await getSkySettings(db);
    const after = await saveSkySettings(db, admin, input);
    await logAction(db, admin, "aviator.settings", "game:aviator", {
      before: { rtp: before.rtp, min_bet: before.min_bet, max_bet: before.max_bet, max_win: before.max_win },
      after: { rtp: after.rtp, min_bet: after.min_bet, max_bet: after.max_bet, max_win: after.max_win },
    });
    return { ...after, rtp_pct: round2(after.rtp * 100) };
  } catch (e) {
    if (e instanceof GameError) throw new AdminError(e.code, e.message, e.status);
    throw e;
  }
}
