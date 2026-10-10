import type { Pool } from "pg";
import { depositReference } from "./teller.js";

export interface TransactionView {
  kind: "deposit" | "withdrawal";
  ref: string;
  amount: number;
  status: "success" | "pending" | "failed";
  reason: string | null;
  destination: string | null;
  created_at: Date;
}

/** Deposits and withdrawals with their outcome, newest first. A withdrawal is pending until it's paid or returned. */
export async function listTransactions(db: Pool, userId: string, limit = 100): Promise<TransactionView[]> {
  const { rows } = await db.query<{
    kind: "deposit" | "withdrawal"; ref: string; amount: string; status: string;
    note: string | null; destination: string | null; created_at: Date;
  }>(
    `SELECT 'deposit' AS kind, transaction_id AS ref, amount, status, gateway_note AS note,
            NULL::text AS destination, created_at
       FROM payment_intents
      WHERE user_id = $1 AND transaction_id IS NOT NULL
     UNION ALL
     SELECT 'withdrawal', j.id::text, e.amount,
            CASE w.status WHEN 'PAID' THEN 'CONFIRMED' WHEN 'DECLINED' THEN 'FAILED' ELSE 'PENDING' END,
            w.gateway_note, j.external_ref, j.created_at
       FROM ledger_journal j
       JOIN ledger_entries e ON e.journal_id = j.id
       LEFT JOIN withdrawals w ON w.journal_id = j.id
      WHERE e.user_id = $1 AND j.entry_type = 'WITHDRAWAL_REQUEST' AND e.direction = 'DEBIT'
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  const status = (s: string): TransactionView["status"] =>
    s === "CONFIRMED" ? "success" : s === "PENDING" ? "pending" : "failed";
  return rows.map((t) => ({
    kind: t.kind,
    ref: t.kind === "deposit" ? depositReference(t.ref) : t.ref,
    amount: Number(t.amount),
    status: status(t.status),
    reason: t.kind === "deposit" ? (t.status !== "CONFIRMED" ? t.note : null) : (t.status === "FAILED" ? t.note : null),
    destination: t.destination ? t.destination.replace(/^momo:/, "") : null,
    created_at: t.created_at,
  }));
}

export class FeedbackError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "FeedbackError";
  }
}

/** Stores a star rating or an idea. At most 20 per player per day. */
export async function saveFeedback(
  db: Pool,
  userId: string,
  input: { kind?: unknown; rating?: unknown; message?: unknown }
): Promise<void> {
  const text = typeof input.message === "string" ? input.message.trim().slice(0, 500) : "";
  const stars = Number(input.rating);
  if (input.kind !== "rating" && input.kind !== "idea") throw new FeedbackError("invalid_kind", "kind must be rating or idea");
  if (input.kind === "rating" && !(Number.isInteger(stars) && stars >= 1 && stars <= 5)) {
    throw new FeedbackError("invalid_rating", "Choose 1 to 5 stars");
  }
  if (input.kind === "idea" && !text) throw new FeedbackError("empty_message", "Write your idea first");

  const recent = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM feedback WHERE user_id = $1 AND created_at > now() - interval '1 day'`,
    [userId]
  );
  if (Number(recent.rows[0]?.n ?? 0) >= 20) throw new FeedbackError("too_many", "Thanks — that's plenty for today", 429);

  await db.query(
    `INSERT INTO feedback (user_id, kind, rating, message) VALUES ($1, $2, $3, $4)`,
    [userId, input.kind, input.kind === "rating" ? stars : null, text || null]
  );
}
