/* Money under pressure, through the real stack: double clicks, concurrent requests, bad inputs and refused payments.
   Whatever happens, a balance never goes negative, never changes without a matching record, and agrees with the UI. */
import { expect, test } from "@playwright/test";
import { API, cents, deposit, fundedPlayer, gatewayRequests, play, register, serverBalance, settle } from "./helpers";

test("the same bet sent twice at once is one bet, and neither copy fails", async ({ page, request }) => {
  const { token } = await fundedPlayer(page);
  const body = { stake: 1, choice: { pick: "HEADS" }, idempotency_key: "round:double-click-" + Date.now() };
  const [a, b] = await Promise.all([play(request, token, "volta-coin", body), play(request, token, "volta-coin", body)]);
  expect([a.status, b.status], "a retried request gets the original round back, not an error").toEqual([200, 200]);
  expect(a.body.round_id).toBe(b.body.round_id);
  const payout = Number(a.body.payout);
  expect(await serverBalance(request, token)).toBe(cents(100 - 1 + payout));
});

test("forty bets fired at once can never spend money the player doesn't have", async ({ page, request }) => {
  const { token } = await fundedPlayer(page);
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    play(request, token, "volta-coin", { stake: 5, choice: { pick: i % 2 ? "HEADS" : "TAILS" }, idempotency_key: `round:burst-${Date.now()}-${i}` })));
  const accepted = results.filter((r) => r.status === 200);
  const refused = results.filter((r) => r.status !== 200);
  for (const r of refused) expect(r.status, JSON.stringify(r.body)).toBe(409);
  for (const r of accepted) expect(Number(r.body.balance)).toBeGreaterThanOrEqual(0);
  const final = await serverBalance(request, token);
  const expected = cents(100 - 5 * accepted.length + accepted.reduce((s, r) => s + Number(r.body.payout), 0));
  expect(final).toBe(expected);
  expect(final).toBeGreaterThanOrEqual(0);
});

test("withdrawals fired at once can never take more than the balance", async ({ page, request }) => {
  const { token } = await fundedPlayer(page);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    request.post(`${API}/api/user/withdraw`, { headers: { Authorization: `Bearer ${token}` }, data: { amount: 60, idempotency_key: `withdraw:burst-${Date.now()}-${i}` } })));
  const ok = results.filter((r) => r.status() === 201);
  expect(ok.length, "only one GHS 60 withdrawal fits in GHS 100").toBe(1);
  expect(await serverBalance(request, token)).toBe(40);
});

test("bad stakes are refused and move no money", async ({ page, request }) => {
  const { token } = await fundedPlayer(page);
  for (const stake of [-5, 0, 0.001, "ten", null, 1e9, Number.NaN, [5], { amount: 5 }]) {
    const r = await play(request, token, "volta-coin", { stake, choice: { pick: "HEADS" }, idempotency_key: "round:bad-" + Math.random() });
    expect(r.status, `stake ${JSON.stringify(stake)}`).toBeGreaterThanOrEqual(400);
    expect(r.status, `stake ${JSON.stringify(stake)} is a client error, not a crash`).toBeLessThan(500);
  }
  const overBalance = await play(request, token, "volta-coin", { stake: 150, choice: { pick: "HEADS" }, idempotency_key: "round:over-" + Date.now() });
  expect(overBalance.status).toBe(409);
  const badChoice = await play(request, token, "volta-coin", { stake: 1, choice: { pick: "EDGE" }, idempotency_key: "round:edge-" + Date.now() });
  expect(badChoice.status).toBe(400);
  expect(await serverBalance(request, token)).toBe(100);
});

test("a declined payment credits nothing and tells the player why", async ({ page, request }) => {
  const { token } = await register(page);
  await deposit(page, 100, { from: "024 555 0000" });    /* the gateway stub declines numbers ending 0000 */
  await expect(page.locator("#msg")).toContainText("not approved", { timeout: 30_000 });
  await expect(page.locator("#msg")).toContainText("Insufficient funds");
  expect(await serverBalance(request, token)).toBe(0);
});

test("a stale cached deposit minimum cannot override the GHS 20 page fallback", async ({ page }) => {
  await register(page);
  await page.evaluate(() => localStorage.setItem("vb.minDeposit", JSON.stringify(135)));
  await page.route("**/api/payments/config", (route) => route.fulfill({ status: 503, body: "{}" }));
  await page.goto("/wallet.html");
  await settle(page);
  await page.locator("#depAmount").fill("20");
  await expect(page.locator("#depAmountErr")).toBeEmpty();
  await expect(page.locator("#depSubmit")).toBeEnabled();
});

test("a deposit under the minimum never reaches the gateway", async ({ page, request }) => {
  const { phone } = await register(page);
  await page.goto("/wallet.html");
  await settle(page);
  /* just under the live minimum (Admin -> Betting & withdrawal settings) */
  const min = Number((await (await request.get(`${API}/api/payments/config`)).json()).minDeposit);
  const under = Math.max(1, min - 1);
  await expect(page.locator("#depAmount")).toHaveAttribute("min", String(min));
  await page.locator("#depAmount").fill(String(under));
  await expect(page.locator("#depSubmit")).toBeDisabled();
  const direct = await request.post(`${API}/api/payments/teller/momo`, {
    headers: { Authorization: `Bearer ${await page.evaluate(() => JSON.parse(localStorage.getItem("voltabet.session") || "{}").token)}` },
    data: { amount: under, currency: "GHS", network: "MTN", account_number: "233" + phone.slice(1), idempotency_key: "deposit:under-" + Date.now() },
  });
  expect(direct.status()).toBe(400);
  const sent = (await gatewayRequests(request)).filter((r) => r.body.subscriber_number === "233" + phone.slice(1));
  expect(sent).toHaveLength(0);
});

test("double-clicking Top Up sends one payment prompt", async ({ page, request }) => {
  const { phone, token } = await register(page);
  await page.goto("/wallet.html");
  await settle(page);
  await page.locator("#depAmount").fill("100");
  await page.locator("#depSubmit").dblclick();
  await expect(page.locator("#msg")).toContainText("successful", { timeout: 30_000 });
  const sent = (await gatewayRequests(request)).filter((r) => r.path === "/v1.1/transaction/process" && r.body.subscriber_number === "233" + phone.slice(1));
  expect(sent).toHaveLength(1);
  expect(await serverBalance(request, token)).toBe(100);
});
