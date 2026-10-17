import type { Pool } from "pg";
import { maskPhone } from "./feed.js";
import { betLabel, type BetType } from "./lotto.js";

/*
 * The Lotto page's winners: only real winning tickets the server settled in draws whose results were released
 * (status WON in a RELEASED draw), with the amount actually paid. Players are shown by a masked number only, never a
 * name or picture. When nobody has won yet the lists are empty and the page says so; nothing here is ever made up.
 */

const r2 = (n: unknown) => Math.round(Number(n) * 100) / 100;

interface WinRow {
  code: string | null; bet_type: BetType; size: number; picks: number[]; banker: number | null; stake: string; payout: string;
  winning_lines: number | null; phone: string | null; draw_id: string; draw_name: string | null; draw_at: Date; numbers: number[] | null;
}

function winView(r: WinRow) {
  const drawn = (r.numbers ?? []).map(Number);
  const mine = [...(r.banker ? [Number(r.banker)] : []), ...(r.picks ?? []).map(Number)];
  const stake = r2(r.stake);
  const payout = r2(r.payout);
  return {
    player: maskPhone(r.phone),
    payout, stake, x: stake > 0 ? Math.floor((payout / stake) * 10) / 10 : 0,
    bet: betLabel({ bet_type: r.bet_type, size: Number(r.size) }),
    matched: mine.filter((n) => drawn.includes(n)).sort((a, b) => a - b),
    numbers: drawn,
    winning_lines: Number(r.winning_lines ?? 1),
    draw_id: Number(r.draw_id), draw_name: r.draw_name, draw_at: new Date(r.draw_at).toISOString(),
  };
}

const WINS = `SELECT t.code, t.bet_type, t.size, t.picks, t.banker, t.stake, t.payout, t.winning_lines, u.phone,
                     d.id AS draw_id, d.name AS draw_name, d.draw_at, d.numbers
                FROM lotto_tickets t JOIN lotto_draws d ON d.id = t.draw_id JOIN users u ON u.id = t.user_id
               WHERE t.status = 'WON' AND t.payout > 0 AND d.status = 'RELEASED' AND d.result_hidden_at IS NULL`;

/** The biggest wins of the last 90 days, the latest wins, and the all-time count and total paid. */
export async function lottoWinners(db: Pool, now = Date.now()) {
  const since = new Date(now - 90 * 864e5);
  const top = (await db.query<WinRow>(`${WINS} AND d.draw_at >= $1 ORDER BY t.payout DESC, d.draw_at DESC LIMIT 12`, [since])).rows;
  const latest = (await db.query<WinRow>(`${WINS} ORDER BY d.draw_at DESC, t.payout DESC LIMIT 12`)).rows;
  const t = (await db.query<{ winners: string; paid: string; draws: string }>(
    `SELECT count(*) AS winners, coalesce(sum(t.payout), 0) AS paid, count(DISTINCT t.draw_id) AS draws
       FROM lotto_tickets t JOIN lotto_draws d ON d.id = t.draw_id WHERE t.status = 'WON' AND d.status = 'RELEASED'`)).rows[0]!;
  return {
    top: top.map(winView),
    latest: latest.map(winView),
    totals: { winners: Number(t.winners), paid: r2(t.paid), draws: Number(t.draws) },
  };
}

/** The latest published result, for the site-wide congratulations popup: only a draw whose results were released. */
export async function latestLottoResult(db: Pool) {
  const d = (await db.query<{ id: string; name: string | null; numbers: number[] | null; released_at: Date | null; draw_at: Date }>(
    `SELECT id, name, numbers, released_at, draw_at FROM lotto_draws WHERE status = 'RELEASED' AND result_hidden_at IS NULL AND numbers IS NOT NULL
      ORDER BY released_at DESC NULLS LAST, id DESC LIMIT 1`)).rows[0];
  return {
    result: d ? {
      id: Number(d.id), name: d.name || "WIN B Lotto", numbers: d.numbers!.map(Number),
      published_at: new Date(d.released_at ?? d.draw_at).toISOString(), draw_at: new Date(d.draw_at).toISOString(),
    } : null,
  };
}
