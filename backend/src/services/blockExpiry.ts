import type { Pool, PoolClient } from "pg";

/** Lifts temporary blocks whose time is up (one player's, or everyone's), and records each in the history. */
export async function expireBlocks(db: Pick<Pool | PoolClient, "query">, userId?: string): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE users SET status = 'ACTIVE', restriction = NULL, restriction_reason = NULL, restricted_at = NULL, restricted_by = NULL,
            blocked_until = NULL, updated_at = now()
      WHERE restriction = 'BLOCKED' AND blocked_until IS NOT NULL AND blocked_until <= now() AND ($1::uuid IS NULL OR id = $1::uuid)
      RETURNING id`, [userId ?? null]);
  for (const r of rows) {
    await db.query(`INSERT INTO account_restrictions (user_id, action, reason, admin) VALUES ($1, 'expire', 'Blocking period ended', 'system')`, [r.id]);
  }
  return rows.length;
}
