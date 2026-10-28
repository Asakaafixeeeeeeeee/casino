import type { Pool, PoolClient } from "pg";
import { AdminError, logAction } from "./admin.js";

type Db = Pick<Pool | PoolClient, "query">;

export interface ActiveDepositRestriction {
  id: number;
  started_at: string;
  expires_at: string;
  failed_transaction_id: string | null;
  retry_after_seconds: number;
}

export async function activeDepositRestriction(db: Db, userId: string): Promise<ActiveDepositRestriction | null> {
  const { rows } = await db.query<{
    id: string; started_at: Date; expires_at: Date; transaction_id: string | null; retry_after_seconds: number;
  }>(
    `SELECT r.id, r.started_at, r.expires_at, p.transaction_id,
            greatest(0, ceil(extract(epoch FROM (r.expires_at - now()))))::int AS retry_after_seconds
       FROM deposit_restrictions r
       JOIN payment_intents p ON p.id = r.failed_intent_id
      WHERE r.user_id = $1 AND r.removed_at IS NULL AND r.expires_at > now()
      ORDER BY r.started_at DESC LIMIT 1`,
    [userId]
  );
  const row = rows[0];
  return row ? {
    id: Number(row.id),
    started_at: new Date(row.started_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    failed_transaction_id: row.transaction_id,
    retry_after_seconds: Number(row.retry_after_seconds),
  } : null;
}

export async function recordVerifiedDepositFailure(db: PoolClient, userId: string, intentId: string): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["deposit:" + userId]);
  const setting = await db.query<{ enabled: boolean }>(
    `SELECT enabled FROM deposit_restriction_settings WHERE id = 1`
  );
  if (setting.rows[0]?.enabled === false) return;

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO deposit_restrictions (user_id, failed_intent_id, started_at, expires_at)
     SELECT $1, $2, now(), now() + interval '30 hours'
      WHERE NOT EXISTS (
        SELECT 1 FROM deposit_restrictions
         WHERE user_id = $1 AND removed_at IS NULL AND expires_at > now()
      )
     ON CONFLICT (failed_intent_id) DO NOTHING
     RETURNING id`,
    [userId, intentId]
  );
  if (rows[0]) {
    await db.query(
      `INSERT INTO deposit_restriction_events (restriction_id, user_id, actor, action, details)
       VALUES ($1, $2, 'payment-provider', 'restriction.started', $3::jsonb)`,
      [rows[0].id, userId, JSON.stringify({ failed_intent_id: intentId, duration_hours: 30 })]
    );
  }
}

export async function depositRestrictionState(db: Db, userId: string) {
  const [active, setting] = await Promise.all([
    activeDepositRestriction(db, userId),
    db.query<{ enabled: boolean }>(`SELECT enabled FROM deposit_restriction_settings WHERE id = 1`),
  ]);
  return {
    restriction: active,
    enabled: setting.rows[0]?.enabled !== false,
    retry_after_seconds: active?.retry_after_seconds ?? 0,
  };
}

export async function depositRestrictionOverview(db: Pool, rawQuery?: unknown) {
  const search = String(rawQuery ?? "").trim().replace(/[%_\\]/g, "").slice(0, 80);
  const setting = await db.query<{ enabled: boolean; updated_by: string | null; updated_at: Date }>(
    `SELECT enabled, updated_by, updated_at FROM deposit_restriction_settings WHERE id = 1`
  );
  const restrictions = await db.query(
    `SELECT r.id, r.user_id, u.username, u.phone, p.transaction_id, p.amount, p.gateway_note,
            r.started_at, r.expires_at, r.removed_at, r.removed_by, r.removal_reason,
            greatest(0, ceil(extract(epoch FROM (r.expires_at - now()))))::int AS retry_after_seconds,
            (r.removed_at IS NULL AND r.expires_at > now()) AS active
       FROM deposit_restrictions r
       JOIN users u ON u.id = r.user_id
       JOIN payment_intents p ON p.id = r.failed_intent_id
      WHERE ($1 = '' OR coalesce(u.username, '') ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%'
             OR coalesce(p.transaction_id, '') ILIKE '%' || $1 || '%' OR coalesce(p.gateway_note, '') ILIKE '%' || $1 || '%')
      ORDER BY r.started_at DESC LIMIT 200`,
    [search]
  );
  return { settings: setting.rows[0] ?? { enabled: true, updated_by: null, updated_at: null }, restrictions: restrictions.rows };
}

export async function setDepositRestrictionsEnabled(db: Pool, admin: string, input: Record<string, unknown>) {
  if (typeof input.enabled !== "boolean") {
    throw new AdminError("invalid_switch", "Say whether failed-deposit restrictions are enabled (true or false)", 400);
  }
  const before = (await db.query<{ enabled: boolean }>(
    `SELECT enabled FROM deposit_restriction_settings WHERE id = 1`
  )).rows[0]?.enabled !== false;
  await db.query(
    `INSERT INTO deposit_restriction_settings (id, enabled, updated_by, updated_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [input.enabled, admin]
  );
  await logAction(db, admin, input.enabled ? "deposit_restrictions.on" : "deposit_restrictions.off", "deposit-restrictions",
    { before, after: input.enabled, existing_restrictions: "remain active until expiry or manual removal" });
  await db.query(
    `INSERT INTO deposit_restriction_events (actor, action, details)
     VALUES ($1, $2, $3::jsonb)`,
    [admin, input.enabled ? "settings.enabled" : "settings.disabled",
      JSON.stringify({ before, after: input.enabled, existing_restrictions: "preserved" })]
  );
  return { enabled: input.enabled };
}

export async function removeDepositRestriction(db: Pool, admin: string, id: string, reason: unknown) {
  const note = String(reason ?? "").trim().slice(0, 200);
  if (!note) throw new AdminError("reason_required", "Add a reason before removing this restriction", 400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ user_id: string }>(
      `UPDATE deposit_restrictions SET removed_at = now(), removed_by = $2, removal_reason = $3
        WHERE id = $1 AND removed_at IS NULL AND expires_at > now()
        RETURNING user_id`,
      [id, admin, note]
    );
    const row = updated.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw new AdminError("restriction_not_active", "That restriction is no longer active", 404);
    }
    await client.query(
      `INSERT INTO deposit_restriction_events (restriction_id, user_id, actor, action, details)
       VALUES ($1, $2, $3, 'restriction.removed', $4::jsonb)`,
      [id, row.user_id, admin, JSON.stringify({ reason: note })]
    );
    await client.query("COMMIT");
    await logAction(db, admin, "deposit_restriction.removed", String(row.user_id), { restriction_id: id, reason: note });
    return { removed: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
