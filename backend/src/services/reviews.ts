import type { Pool } from "pg";
import { AdminError, logAction } from "./admin.js";

/*
 * Withdrawal reviews (the owner's brief, 12 October 2026). After an admin approves a player's withdrawal, the player
 * is asked to rate it (1-5 stars) and leave feedback. The admin moderates: approve, publish or reject. Published
 * reviews show on the profile page (reviewer's username, stars, feedback). A player is asked once per withdrawal; once
 * they review or dismiss it, the popup never returns for that withdrawal.
 */

export class ReviewError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "ReviewError"; }
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const num = (v: unknown) => Number(v ?? 0);

/* ---------------- player side ---------------- */

/** The player's next approved (paid) withdrawal that they haven't reviewed or dismissed yet, or null. */
export async function reviewPrompt(db: Pool, userId: string) {
  const r = (await db.query(
    `SELECT w.id, w.amount, w.updated_at
       FROM withdrawals w LEFT JOIN withdrawal_reviews r ON r.withdrawal_id = w.id
      WHERE w.user_id = $1 AND w.status = 'PAID' AND r.id IS NULL
      ORDER BY w.updated_at DESC LIMIT 1`, [userId])).rows[0];
  return r ? { withdrawal_id: r.id, amount: Math.round(num(r.amount) * 100) / 100, at: iso(r.updated_at) } : null;
}

async function ownPaidWithdrawal(db: Pool, userId: string, withdrawalId: string) {
  const w = (await db.query(`SELECT id, status FROM withdrawals WHERE id = $1 AND user_id = $2`, [withdrawalId, userId])).rows[0];
  if (!w) throw new ReviewError("not_found", "No such withdrawal", 404);
  if (w.status !== "PAID") throw new ReviewError("not_paid", "You can review a withdrawal once it has been approved");
  if ((await db.query(`SELECT 1 FROM withdrawal_reviews WHERE withdrawal_id = $1`, [withdrawalId])).rowCount) {
    throw new ReviewError("already_done", "You've already answered for this withdrawal", 409);
  }
}

/** The player submits a star rating (1-5) and optional feedback. It waits for an admin before it can be published. */
export async function submitReview(db: Pool, userId: string, withdrawalId: string, input: { rating?: unknown; feedback?: unknown }) {
  await ownPaidWithdrawal(db, userId, withdrawalId);
  const rating = Math.round(Number(input.rating));
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ReviewError("invalid_rating", "Choose 1 to 5 stars");
  const feedback = String(input.feedback ?? "").trim().slice(0, 500) || null;
  await db.query(
    `INSERT INTO withdrawal_reviews (withdrawal_id, user_id, rating, feedback, status) VALUES ($1, $2, $3, $4, 'PENDING')`,
    [withdrawalId, userId, rating, feedback]);
  return { status: "submitted" };
}

/** The player closes the popup (Satisfied or Close) without reviewing: recorded so it is never shown again. */
export async function dismissReview(db: Pool, userId: string, withdrawalId: string) {
  await ownPaidWithdrawal(db, userId, withdrawalId);
  await db.query(
    `INSERT INTO withdrawal_reviews (withdrawal_id, user_id, status) VALUES ($1, $2, 'DISMISSED')`,
    [withdrawalId, userId]);
  return { status: "dismissed" };
}

/** Published reviews for the profile page: the reviewer's username, stars and feedback (public). */
export async function publishedReviews(db: Pool) {
  const { rows } = await db.query(
    `SELECT r.rating, r.feedback, r.updated_at, coalesce(u.username, u.full_name, 'Player') AS name
       FROM withdrawal_reviews r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'PUBLISHED' AND r.rating IS NOT NULL
      ORDER BY r.updated_at DESC LIMIT 50`);
  return { reviews: rows.map((r) => ({ name: r.name, rating: num(r.rating), feedback: r.feedback ?? "", at: iso(r.updated_at) })) };
}

/* ---------------- admin side ---------------- */
const ADMIN_STATUS: Record<string, string[]> = {
  pending: ["PENDING"], approved: ["APPROVED"], published: ["PUBLISHED"], rejected: ["REJECTED"], all: ["PENDING", "APPROVED", "PUBLISHED", "REJECTED"],
};

/** Reviews for the admin to moderate (dismissals are never shown — they aren't reviews). */
export async function adminReviews(db: Pool, input: { status?: unknown }) {
  const statuses = ADMIN_STATUS[String(input.status ?? "pending")] ?? ADMIN_STATUS.pending!;
  const { rows } = await db.query(
    `SELECT r.id, r.rating, r.feedback, r.status, r.decided_by, r.created_at, r.updated_at,
            u.username, u.full_name, u.phone, w.amount
       FROM withdrawal_reviews r JOIN users u ON u.id = r.user_id JOIN withdrawals w ON w.id = r.withdrawal_id
      WHERE r.status = ANY($1) AND r.rating IS NOT NULL
      ORDER BY r.created_at DESC LIMIT 100`, [statuses]);
  const counts = (await db.query(
    `SELECT status, count(*) AS n FROM withdrawal_reviews WHERE rating IS NOT NULL GROUP BY status`)).rows
    .reduce((m, r) => ((m[String(r.status).toLowerCase()] = num(r.n)), m), {} as Record<string, number>);
  return {
    counts,
    reviews: rows.map((r) => ({
      id: r.id, name: r.full_name || r.username || "Player", username: r.username ?? null, phone: r.phone ?? null,
      rating: num(r.rating), feedback: r.feedback ?? "", status: String(r.status).toLowerCase(), amount: Math.round(num(r.amount) * 100) / 100,
      decided_by: r.decided_by ?? null, at: iso(r.created_at),
    })),
  };
}

const NEXT: Record<string, string> = { approve: "APPROVED", publish: "PUBLISHED", reject: "REJECTED" };
/** The admin approves, publishes or rejects a review. Publishing makes it public on profiles. */
export async function decideReview(db: Pool, admin: string, id: string, action: unknown) {
  const to = NEXT[String(action)];
  if (!to) throw new AdminError("invalid_action", "Choose approve, publish or reject");
  const r = (await db.query(`UPDATE withdrawal_reviews SET status = $2, decided_by = $3, updated_at = now()
                              WHERE id = $1 AND rating IS NOT NULL RETURNING user_id, status`, [id, to, admin])).rows[0];
  if (!r) throw new AdminError("not_found", "No such review", 404);
  await logAction(db, admin, "review." + String(action), `review:${id}`, { status: to });
  return { status: to.toLowerCase() };
}
