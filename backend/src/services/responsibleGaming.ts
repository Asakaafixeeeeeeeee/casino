import type { Pool, PoolClient } from "pg";

export type Period = "daily" | "weekly" | "monthly";
export const PERIODS: readonly Period[] = ["daily", "weekly", "monthly"];
/** Raising or removing a limit waits this long, so it can't be undone in the heat of the moment. */
export const COOL_OFF_HOURS = 24;
/** The break lengths a player can choose, in days. */
export const BREAK_DAYS = [1, 7, 30, 180] as const;
const MAX_LIMIT = 1_000_000;

export class LimitError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "LimitError";
  }
}

type Amounts = Record<Period, number | null>;
export interface LimitsView {
  limits: Amounts;
  pending: Partial<Amounts> | null;
  pendingFrom: Date | null;
  used: Record<Period, number>;
  excludedUntil: Date | null;
}

const ghs = (n: number) => "₵" + n.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ") + " GMT";

/** Raises and removals whose cool-off has passed become the active limits. */
async function applyDue(db: Pool | PoolClient, userId: string): Promise<void> {
  await db.query(
    `UPDATE player_limits SET
        daily_deposit   = CASE WHEN pending ? 'daily'   THEN (pending->>'daily')::numeric   ELSE daily_deposit END,
        weekly_deposit  = CASE WHEN pending ? 'weekly'  THEN (pending->>'weekly')::numeric  ELSE weekly_deposit END,
        monthly_deposit = CASE WHEN pending ? 'monthly' THEN (pending->>'monthly')::numeric ELSE monthly_deposit END,
        pending = NULL, pending_from = NULL, updated_at = now()
      WHERE user_id = $1 AND pending IS NOT NULL AND pending_from <= now()`,
    [userId]
  );
}

export async function getLimits(db: Pool | PoolClient, userId: string): Promise<LimitsView> {
  await applyDue(db, userId);
  const row = (await db.query<{
    daily_deposit: string | null; weekly_deposit: string | null; monthly_deposit: string | null;
    pending: Partial<Amounts> | null; pending_from: Date | null; excluded_until: Date | null;
  }>(`SELECT * FROM player_limits WHERE user_id = $1`, [userId])).rows[0];
  // money in flight counts too, so several deposits started at once can't slip past a limit
  const used = (await db.query<{ daily: string; weekly: string; monthly: string }>(
    `SELECT coalesce(sum(amount) FILTER (WHERE created_at > now() - interval '1 day'), 0)   AS daily,
            coalesce(sum(amount) FILTER (WHERE created_at > now() - interval '7 days'), 0)  AS weekly,
            coalesce(sum(amount) FILTER (WHERE created_at > now() - interval '30 days'), 0) AS monthly
       FROM payment_intents
      WHERE user_id = $1 AND status IN ('CONFIRMED', 'PENDING')`,
    [userId]
  )).rows[0]!;
  const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  const excluded = row?.excluded_until && new Date(row.excluded_until) > new Date() ? new Date(row.excluded_until) : null;
  return {
    limits: { daily: num(row?.daily_deposit), weekly: num(row?.weekly_deposit), monthly: num(row?.monthly_deposit) },
    pending: row?.pending ?? null,
    pendingFrom: row?.pending_from ? new Date(row.pending_from) : null,
    used: { daily: Number(used.daily), weekly: Number(used.weekly), monthly: Number(used.monthly) },
    excludedUntil: excluded,
  };
}

/** Lowering or adding a limit applies now; raising or removing one waits COOL_OFF_HOURS. */
export async function setLimits(db: Pool, userId: string, input: Partial<Record<Period, unknown>>): Promise<LimitsView> {
  const wanted: Partial<Amounts> = {};
  for (const p of PERIODS) {
    if (!(p in input)) continue;
    const v = input[p];
    if (v === null || v === "" || v === undefined) {
      wanted[p] = null;
      continue;
    }
    const n = Math.round(Number(v) * 100) / 100;
    if (!Number.isFinite(n) || n < 1 || n > MAX_LIMIT) {
      throw new LimitError("invalid_limit", `Set the ${p} limit between ₵1 and ${ghs(MAX_LIMIT)}, or leave it empty for none`);
    }
    wanted[p] = n;
  }

  const now = await getLimits(db, userId);
  const active = { ...now.limits };
  const pending: Partial<Amounts> = { ...(now.pending ?? {}) };
  let startCoolOff = false;
  for (const p of PERIODS) {
    if (!(p in wanted)) continue;
    const want = wanted[p] ?? null;
    const current = active[p];
    if (want === current) {
      delete pending[p];
    } else if (want !== null && (current === null || want < current)) {
      active[p] = want; // stricter: at once
      delete pending[p];
    } else {
      pending[p] = want; // looser: after the cool-off
      startCoolOff = true;
    }
  }
  const hasPending = Object.keys(pending).length > 0;
  await db.query(
    `INSERT INTO player_limits (user_id, daily_deposit, weekly_deposit, monthly_deposit, pending, pending_from)
     VALUES ($1, $2, $3, $4, $5::jsonb, CASE WHEN $5::jsonb IS NULL THEN NULL
                                              WHEN $6 THEN now() + make_interval(hours => ${COOL_OFF_HOURS}) END)
     ON CONFLICT (user_id) DO UPDATE SET
       daily_deposit = EXCLUDED.daily_deposit, weekly_deposit = EXCLUDED.weekly_deposit,
       monthly_deposit = EXCLUDED.monthly_deposit, pending = EXCLUDED.pending,
       pending_from = CASE WHEN EXCLUDED.pending IS NULL THEN NULL
                           WHEN $6 THEN now() + make_interval(hours => ${COOL_OFF_HOURS})
                           ELSE player_limits.pending_from END,
       updated_at = now()`,
    [userId, active.daily, active.weekly, active.monthly, hasPending ? JSON.stringify(pending) : null, startCoolOff]
  );
  return getLimits(db, userId);
}

/** A break can be started or made longer, never shortened. */
export async function selfExclude(db: Pool, userId: string, days: unknown): Promise<LimitsView> {
  const d = Number(days);
  if (!(BREAK_DAYS as readonly number[]).includes(d)) {
    throw new LimitError("invalid_break", "Choose a break of 1, 7, 30 or 180 days");
  }
  await db.query(
    `INSERT INTO player_limits (user_id, excluded_until) VALUES ($1, now() + make_interval(days => $2::int))
     ON CONFLICT (user_id) DO UPDATE SET
       excluded_until = GREATEST(coalesce(player_limits.excluded_until, now()), now() + make_interval(days => $2::int)),
       updated_at = now()`,
    [userId, d]
  );
  return getLimits(db, userId);
}

/** Throws a LimitError if this deposit is blocked by a break or would go over a limit. */
export async function checkDeposit(db: Pool | PoolClient, userId: string, amountMajor: number): Promise<void> {
  const v = await getLimits(db, userId);
  if (v.excludedUntil) {
    throw new LimitError("self_excluded", `You're taking a break until ${when(v.excludedUntil)}. Deposits are paused until then.`, 403);
  }
  for (const p of PERIODS) {
    const limit = v.limits[p];
    if (limit === null) continue;
    if (v.used[p] + amountMajor > limit + 1e-9) {
      const left = Math.max(0, Math.round((limit - v.used[p]) * 100) / 100);
      throw new LimitError(
        "limit_reached",
        `That's over your ${p} deposit limit of ${ghs(limit)}. ` +
          (left > 0 ? `You can deposit up to ${ghs(left)} more for now.` : `You've reached it for now.`),
        409
      );
    }
  }
}
