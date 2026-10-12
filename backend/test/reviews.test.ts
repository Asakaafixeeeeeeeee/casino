import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { payWithdrawal, requestWithdrawal } from "../src/services/withdrawals.js";
import { adminReviews, decideReview, dismissReview, publishedReviews, ReviewError, reviewPrompt, submitReview } from "../src/services/reviews.js";
import { auditLog, AdminError } from "../src/services/admin.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0209999001";
const PHONE = "0241234567";
const isReview = (code: string) => (e: unknown) => e instanceof ReviewError && e.code === code;
let n = 0;

async function paidWithdrawal(amount = 50) {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 200, "deposit:seed-rev-" + ++n);
  await env.client.query("COMMIT");
  await env.db.query("UPDATE users SET phone = $1 WHERE id = $2", [PHONE, env.userId]);
  await env.db.query("UPDATE user_balances SET withdrawable = 200 WHERE user_id = $1 AND currency_code = 'GHS'", [env.userId]);
  const w = await requestWithdrawal(env.db, { id: env.userId, phone: PHONE }, amount, "wd:rev-" + n);
  await payWithdrawal(env.db, w.id, ADMIN);   /* approved by another admin */
  return { env, withdrawalId: w.id };
}

test("The main admin can approve their own withdrawal, and it is recorded as a self-approval", async () => {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 200, "deposit:self");
  await env.client.query("COMMIT");
  await env.db.query("UPDATE users SET phone = $1 WHERE id = $2", [ADMIN, env.userId]);
  await env.db.query("UPDATE user_balances SET withdrawable = 200 WHERE user_id = $1 AND currency_code = 'GHS'", [env.userId]);
  const w = await requestWithdrawal(env.db, { id: env.userId, phone: ADMIN }, 40, "wd:self");
  const paid = await payWithdrawal(env.db, w.id, ADMIN);
  assert.equal(paid.status, "PAID");
  assert.match(paid.note, /Self-approved by the main admin/);
  const log = await auditLog(env.db, { target: env.userId });
  assert.ok(log.actions.some((a) => a.action === "withdrawal.self_approve" && a.details?.self_approved === true), "the self-approval is in the audit log");
});

test("Withdrawal reviews: the player is prompted once, submits stars and feedback, and the admin publishes it", async () => {
  const { env, withdrawalId } = await paidWithdrawal();
  /* the player is prompted for this paid withdrawal */
  const prompt = await reviewPrompt(env.db, env.userId);
  assert.equal(prompt?.withdrawal_id, withdrawalId);
  assert.equal(prompt?.amount, 50);

  /* bad ratings are refused */
  await assert.rejects(() => submitReview(env.db, env.userId, withdrawalId, { rating: 6 }), isReview("invalid_rating"));
  await submitReview(env.db, env.userId, withdrawalId, { rating: 5, feedback: "Fast payout, thank you!" });
  /* once answered, never prompted again, and a second answer is refused */
  assert.equal(await reviewPrompt(env.db, env.userId), null);
  await assert.rejects(() => submitReview(env.db, env.userId, withdrawalId, { rating: 4 }), isReview("already_done"));

  /* the admin sees it pending; it isn't public until published */
  const pending = await adminReviews(env.db, { status: "pending" });
  assert.equal(pending.reviews.length, 1);
  assert.deepEqual([pending.reviews[0]!.rating, pending.reviews[0]!.feedback], [5, "Fast payout, thank you!"]);
  assert.equal((await publishedReviews(env.db)).reviews.length, 0, "not public before publishing");

  const id = pending.reviews[0]!.id;
  await decideReview(env.db, ADMIN, id, "approve");
  await decideReview(env.db, ADMIN, id, "publish");
  const published = await publishedReviews(env.db);
  assert.equal(published.reviews.length, 1);
  assert.deepEqual([published.reviews[0]!.rating, published.reviews[0]!.feedback], [5, "Fast payout, thank you!"]);
  assert.ok(published.reviews[0]!.name, "the reviewer's name shows");
  await assert.rejects(() => decideReview(env.db, ADMIN, id, "sideways"), (e) => e instanceof AdminError && e.code === "invalid_action");
});

test("A dismissed withdrawal is never prompted again and never reaches the admin", async () => {
  const { env, withdrawalId } = await paidWithdrawal(30);
  assert.equal((await reviewPrompt(env.db, env.userId))?.withdrawal_id, withdrawalId);
  await dismissReview(env.db, env.userId, withdrawalId);
  assert.equal(await reviewPrompt(env.db, env.userId), null, "no repeat prompt after dismissing");
  assert.equal((await adminReviews(env.db, { status: "all" })).reviews.length, 0, "a dismissal is not a review");
  await assert.rejects(() => dismissReview(env.db, env.userId, withdrawalId), isReview("already_done"));
});
