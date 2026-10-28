import type { Pool } from "pg";
import { deposit } from "./balanceService.js";
import { recordVerifiedDepositFailure } from "./depositRestrictions.js";

export interface Settlement {
  userId: string;
  status: "CONFIRMED" | "FAILED";
  creditedMajor: number;
}

/**
 * Applies TheTeller's final answer to a deposit intent. Only the first final answer counts:
 * the update matches PENDING rows only, and the credit happens in the same DB transaction.
 * Returns null when the intent was already settled.
 */
export async function settleIntent(
  db: Pool,
  transactionId: string,
  outcome: "approved" | "declined",
  paidMinor: number | null,
  note?: string
): Promise<Settlement | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; user_id: string; currency: string; amount: string }>(
      `UPDATE payment_intents
          SET status = $2, external_ref = $1, gateway_note = left(CASE
            WHEN NULLIF($3::text, '') IS NULL THEN gateway_note
            WHEN gateway_note IS NULL OR gateway_note = '' THEN $3::text
            WHEN position($3::text in gateway_note) > 0 THEN gateway_note
            ELSE gateway_note || ' / ' || $3::text END, 500),
              confirmed_at = CASE WHEN $2::text = 'CONFIRMED' THEN now() ELSE confirmed_at END,
              updated_at = now()
        WHERE transaction_id = $1 AND status = 'PENDING'
        RETURNING id, user_id, currency, amount`,
      [transactionId, outcome === "approved" ? "CONFIRMED" : "FAILED", note ?? null]
    );
    const intent = rows[0];
    if (!intent) {
      await client.query("COMMIT");
      return null;
    }

    let creditedMinor = 0;
    if (outcome === "approved") {
      const expectedMinor = Math.round(Number(intent.amount) * 100);
      // A payment that came in short is credited for what was actually paid, never in full.
      creditedMinor = paidMinor !== null && paidMinor < expectedMinor ? paidMinor : expectedMinor;
      if (creditedMinor < expectedMinor) {
        console.warn(`[teller] ${transactionId} paid short: expected ${expectedMinor}, paid ${creditedMinor} pesewas`);
      }
      if (creditedMinor > 0) {
        await deposit(client, intent.user_id, intent.currency, creditedMinor / 100, `teller:${transactionId}`, transactionId);
      }
      const lifted = await client.query<{ id: string }>(
        `UPDATE deposit_restrictions SET removed_at = now(), removed_by = 'payment-provider',
                removal_reason = 'Provider later confirmed this deposit'
          WHERE failed_intent_id = $1 AND removed_at IS NULL AND expires_at > now()
          RETURNING id`,
        [intent.id]
      );
      for (const restriction of lifted.rows) {
        await client.query(
          `INSERT INTO deposit_restriction_events (restriction_id, user_id, actor, action, details)
           VALUES ($1, $2, 'payment-provider', 'restriction.cleared_after_reconciliation', $3::jsonb)`,
          [restriction.id, intent.user_id, JSON.stringify({ transaction_id: transactionId })]
        );
      }
    } else {
      await recordVerifiedDepositFailure(client, intent.user_id, intent.id);
    }
    await client.query("COMMIT");
    return {
      userId: intent.user_id,
      status: outcome === "approved" ? "CONFIRMED" : "FAILED",
      creditedMajor: creditedMinor / 100,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Keeps TheTeller's latest message on an intent without settling it. */
export async function noteIntent(db: Pool, transactionId: string, note: string): Promise<void> {
  if (!note) return;
  await db.query(`UPDATE payment_intents SET gateway_note = left(CASE
            WHEN NULLIF($2::text, '') IS NULL THEN gateway_note
            WHEN gateway_note IS NULL OR gateway_note = '' THEN $2::text
            WHEN position($2::text in gateway_note) > 0 THEN gateway_note
            ELSE gateway_note || ' / ' || $2::text END, 500), updated_at = now() WHERE transaction_id = $1`, [transactionId, note]);
}

/** A deposit marked failed that TheTeller later approves goes back to pending so it can be settled once. */
export async function reopenFailedIntent(db: Pool, transactionId: string): Promise<void> {
  await db.query(
    `UPDATE payment_intents SET status = 'PENDING', updated_at = now()
      WHERE transaction_id = $1 AND status = 'FAILED'`,
    [transactionId]
  );
}
