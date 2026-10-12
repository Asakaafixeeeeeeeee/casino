/* Withdrawal reviews end to end: a player with winnings requests a withdrawal, an admin approves it, the player is
   shown the star-rating popup (once), submits it; the admin sees it, publishes it, and it then shows on the profile
   page. Also checks the popup can be dismissed without repeating, and that the main admin can self-approve. */
import { expect, test } from "@playwright/test";
import { adminSession, API, fundedPlayer, play, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function withWinnings(request: import("@playwright/test").APIRequestContext, token: string, target = 12) {
  for (let i = 0; i < 60; i++) {
    const avail = await (await request.get(`${API}/api/user/withdraw/available`, { headers: auth(token) })).json();
    if (Number(avail.withdrawable) >= target) return Number(avail.withdrawable);
    await play(request, token, "volta-coin", { stake: 6, choice: { pick: "HEADS" }, idempotency_key: `round:wr-${Date.now()}-${i}` });
  }
  throw new Error("couldn't build winnings");
}

test("withdrawal review: popup, submit, admin publish, shows on profile", async ({ browser, request }) => {
  test.setTimeout(300_000);
  const adminToken = await adminSession(request);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = trackErrors(page);
  const player = await fundedPlayer(page, 100);

  /* build winnings, then request a small withdrawal and have an admin approve it */
  await withWinnings(request, player.token, 14);
  const wd = await (await request.post(`${API}/api/user/withdraw`, { headers: auth(player.token), data: { amount: 10, idempotency_key: "wr-" + Date.now() } })).json();
  expect(wd.id).toBeTruthy();
  const pay = await request.post(`${API}/api/admin/withdrawals/${wd.id}/pay`, { headers: auth(adminToken), data: {} });
  expect(pay.status()).toBe(200);

  /* the player visits any page and is asked to rate the withdrawal */
  await page.goto("/me.html");
  await settle(page);
  await expect(page.locator("#vbReview")).toBeVisible({ timeout: 20_000 });
  await page.locator('#vbReview .vb-star[data-star="5"]').click();
  await page.locator('#vbReview [data-rv="submit"]').click();
  await expect(page.locator("#vbReview")).toHaveCount(0);

  /* it is NOT shown again on the next load */
  await page.reload();
  await settle(page);
  await page.waitForTimeout(2500);
  await expect(page.locator("#vbReview")).toHaveCount(0);

  /* and NOT yet public */
  await expect(page.locator("#meReviews")).toBeHidden();

  /* the admin sees it pending, approves and publishes it */
  const pending = await (await request.get(`${API}/api/admin/reviews?status=pending`, { headers: auth(adminToken) })).json();
  const review = pending.reviews[0];
  expect(review.rating).toBe(5);
  expect((await request.post(`${API}/api/admin/reviews/${review.id}`, { headers: auth(adminToken), data: { action: "approve" } })).status()).toBe(200);
  expect((await request.post(`${API}/api/admin/reviews/${review.id}`, { headers: auth(adminToken), data: { action: "publish" } })).status()).toBe(200);

  /* now it shows on the profile page */
  await page.goto("/me.html");
  await settle(page);
  await expect(page.locator("#meReviews")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#meReviewsList")).toContainText("★");
  await expect(page.locator("#meReviewsList .me-review")).toHaveCount(1);

  expect(errors).toEqual([]);
});

test("withdrawal review popup can be dismissed and does not come back", async ({ browser, request }) => {
  test.setTimeout(240_000);
  const adminToken = await adminSession(request);
  const page = await (await browser.newContext()).newPage();
  const player = await fundedPlayer(page, 100);
  await withWinnings(request, player.token, 14);
  const wd = await (await request.post(`${API}/api/user/withdraw`, { headers: auth(player.token), data: { amount: 10, idempotency_key: "wrd-" + Date.now() } })).json();
  await request.post(`${API}/api/admin/withdrawals/${wd.id}/pay`, { headers: auth(adminToken), data: {} });

  await page.goto("/me.html");
  await settle(page);
  await expect(page.locator("#vbReview")).toBeVisible({ timeout: 20_000 });
  await page.locator('#vbReview [data-rv="close"]').first().click(); /* "Satisfied" */
  await expect(page.locator("#vbReview")).toHaveCount(0);
  await page.reload();
  await settle(page);
  await page.waitForTimeout(2500);
  await expect(page.locator("#vbReview")).toHaveCount(0);
  /* a dismissal is not a review, so nothing reaches the admin */
  const all = await (await request.get(`${API}/api/admin/reviews?status=all`, { headers: auth(adminToken) })).json();
  expect(all.reviews.find((r: { id: string }) => r.id === wd.id)).toBeUndefined();
});
