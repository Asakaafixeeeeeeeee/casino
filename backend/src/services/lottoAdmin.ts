// src/services/lottoAdmin.ts
//
// The admin's Lotto Management: the daily schedule, odds, bet types and limits; draws (create, pause, cancel while
// betting is open); ALL LOTTO PLACEMENTS (every ticket with who bought it, filters and totals); PUBLISH LOTTO
// RESULTS (preview a closed draw's server-drawn numbers and every ticket's result, then publish with an explicit
// confirmation — the draw is then locked); and the settlement history. Every change is in the admin audit log.
// Switching lotto on/off for the whole site uses the Games tab's switch (catalog_settings, game id "lotto").

import type { Pool } from "pg";
import { hiddenCatalog } from "../games/availability.js";
import { GameError } from "../games/catalog.js";
import {
  cancelLottoDraw, createLottoDraw, getLottoSettings, lottoAdminDraws, lottoChance, lottoPlacements, pauseLottoDraw,
  lottoResultCommitmentValid, previewLottoDraw, updateLottoDrawTimes, releaseLottoDraw, saveLottoSettings,
} from "../games/lotto.js";
import { AdminError, logAction } from "./admin.js";

const round2 = (n: number) => Math.round(n * 100) / 100;

async function asAdmin<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GameError) throw new AdminError(e.code, e.message, e.status);
    throw e;
  }
}

const settingsView = (s: Awaited<ReturnType<typeof getLottoSettings>>) => ({
  ...s, rtp_pct: round2(s.rtp * 100),
  rtp_by_size: Object.fromEntries([1, 2, 3, 4, 5].map((k) => [k, round2(s.odds[k]! * lottoChance(k) * 100)])),
  fair: Object.fromEntries([1, 2, 3, 4, 5].map((k) => [k, Math.floor(1 / lottoChance(k))])),
});

export async function lottoOverview(db: Pool) {
  const settings = await getLottoSettings(db);
  const hidden = await hiddenCatalog(db);
  const enabled = !hidden.games.includes("lotto") && !hidden.providers.includes("accra");
  const draws = await lottoAdminDraws(db);
  return {
    enabled,
    settings: settingsView(settings),
    multipliers: settings.odds,
    draws,
    settlements: draws.filter((d) => d.status === "RELEASED").map((d) => ({
      id: d.id, name: d.name, draw_at: d.draw_at, numbers: d.numbers, tickets: d.tickets, winners: d.winners, losers: d.losers,
      staked: d.staked, paid: d.paid, profit: round2(d.staked - d.paid), published_by: d.decided_by, published_at: d.released_at,
    })),
  };
}

export const lottoTickets = (db: Pool, query: Record<string, unknown>) => asAdmin(() => lottoPlacements(db, query));
/** The results preview of a closed draw: every ticket's result, nothing paid yet. */
export const lottoPreview = (db: Pool, id: unknown) => asAdmin(() => previewLottoDraw(db, id));

export const saveLottoAdminSettings = (db: Pool, admin: string, input: Record<string, unknown>) => asAdmin(async () => {
  const before = await getLottoSettings(db);
  const after = await saveLottoSettings(db, admin, input);
  const pick = (s: typeof before) => ({
    draw_time: s.draw_time, cutoff_min: s.cutoff_min, daily_enabled: s.daily_enabled, daily_name: s.daily_name, odds: s.odds,
    bet_types: s.bet_types, min_bet: s.min_bet, max_bet: s.max_bet, max_win: s.max_win, max_lines: s.max_lines,
    real_money: s.real_money,
  });
  await logAction(db, admin, "lotto.settings", "game:lotto", { before: pick(before), after: pick(after) });
  return settingsView(after);
});

export const createLotto = (db: Pool, admin: string, input: Record<string, unknown>) => asAdmin(async () => {
  const d = await createLottoDraw(db, admin, input);
  await logAction(db, admin, "lotto.draw_create", `lotto:${d.id}`, {
    name: d.name, opens_at: d.opens_at, closes_at: d.closes_at, draw_at: d.draw_at,
    number_source: d.number_source, commitment: d.hash, ...(d.number_source === "MANUAL" ? { numbers: d.numbers } : {}),
  });
  return { id: Number(d.id), name: d.name };
});

export const updateLottoTimes = (db: Pool, admin: string, id: unknown, input: Record<string, unknown>) => asAdmin(async () => {
  const { before, after } = await updateLottoDrawTimes(db, id, input);
  await logAction(db, admin, "lotto.draw_times", `lotto:${after.id}`, {
    name: after.name,
    before: { opens_at: before.opens_at, closes_at: before.closes_at, draw_at: before.draw_at },
    after: { opens_at: after.opens_at, closes_at: after.closes_at, draw_at: after.draw_at },
  });
  return { id: Number(after.id), opens_at: after.opens_at, closes_at: after.closes_at, draw_at: after.draw_at };
});

export const pauseLotto = (db: Pool, admin: string, id: unknown, input: Record<string, unknown>) => asAdmin(async () => {
  const paused = input.paused === true;
  const d = await pauseLottoDraw(db, id, paused);
  await logAction(db, admin, paused ? "lotto.draw_pause" : "lotto.draw_resume", `lotto:${d.id}`, { name: d.name });
  return { id: Number(d.id), paused: d.paused };
});

/** Publishing needs the admin's explicit confirmation (sent once they've seen the preview). */
export const releaseLotto = (db: Pool, admin: string, id: unknown, input: Record<string, unknown> = {}) => asAdmin(async () => {
  if (input.confirm !== true) throw new AdminError("confirm_required", "Preview the results and confirm before publishing.", 400);
  const out = await releaseLottoDraw(db, id, admin);
  await logAction(db, admin, "lotto.publish", `lotto:${out.id}`, out);
  return out;
});

export const cancelLotto = (db: Pool, admin: string, id: unknown) => asAdmin(async () => {
  const out = await cancelLottoDraw(db, id, admin);
  await logAction(db, admin, "lotto.cancel", `lotto:${out.id}`, out);
  return out;
});

/**
 * The Lotto Key: every draw whose betting has closed, with its committed numbers, proof they match the fingerprint
 * shown to players while betting was open, what publishing will pay, and the draw's audit trail.
 * Opening it is itself recorded (once per draw and admin) as lotto.preview.
 */
export async function lottoKey(db: Pool, admin: string) {
  const draws = await lottoAdminDraws(db);
  const closed = draws.filter((d) => d.status === "CLOSED");
  const pending = [];
  for (const d of closed) {
    const row = (await db.query<{ seed: string; hash: string; numbers: number[] | null; closes_at: Date; number_source: "SERVER" | "MANUAL" }>(
      `SELECT seed, hash, numbers, closes_at, number_source FROM lotto_draws WHERE id = $1`, [d.id])).rows[0]!;
    const stored = (row.numbers ?? []).map(Number);
    const locked = lottoResultCommitmentValid(row.seed, Number(d.id), row.hash, stored, row.number_source);
    const seen = await db.query(`SELECT 1 FROM admin_actions WHERE admin = $1 AND action = 'lotto.preview' AND target = $2`, [admin, `lotto:${d.id}`]);
    if (!seen.rowCount) await logAction(db, admin, "lotto.preview", `lotto:${d.id}`, { numbers: stored, hash: row.hash });
    pending.push({ id: d.id, name: d.name, draw_at: d.draw_at, closed_at: new Date(row.closes_at).toISOString(), numbers: stored, hash: row.hash,
      locked, number_source: row.number_source, tickets: d.tickets, staked: d.staked, projected: d.projected });
  }
  const published = [];
  for (const d of draws.filter((x) => x.status === "RELEASED").slice(0, 10)) {
    const row = (await db.query<{ seed: string; hash: string; numbers: number[] | null; number_source: "SERVER" | "MANUAL" }>(
      `SELECT seed, hash, numbers, number_source FROM lotto_draws WHERE id = $1`, [d.id])).rows[0]!;
    const numbers = (row.numbers ?? []).map(Number);
    const verified = lottoResultCommitmentValid(row.seed, Number(d.id), row.hash, numbers, row.number_source);
    published.push({
      id: d.id, name: d.name, draw_at: d.draw_at, numbers, seed: row.seed, hash: row.hash, verified, number_source: row.number_source,
      winners: d.winners, paid: d.paid, published_by: d.decided_by, published_at: d.released_at,
    });
  }
  const audit = (await db.query<{ admin: string; action: string; target: string; details: unknown; created_at: Date }>(
    `SELECT admin, action, target, details, created_at FROM admin_actions WHERE target LIKE 'lotto:%' ORDER BY created_at DESC LIMIT 40`)).rows;
  return {
    pending,
    published,
    audit: audit.map((a) => ({ admin: a.admin, action: a.action, draw: Number(a.target.slice(6)), at: new Date(a.created_at).toISOString(), details: a.details })),
  };
}
