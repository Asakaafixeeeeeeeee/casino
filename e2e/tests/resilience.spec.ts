/* When a service is down or slow, the player sees a clear message, nothing crashes, no money moves twice,
   and the page works again once the service is back. */
import { expect, test } from "@playwright/test";
import { ACCOUNTS, API, cents, fundedPlayer, login, register, serverBalance, settle, trackErrors } from "./helpers";

test("a deposit with the balance service down fails with a message, not a crash", async ({ page, request }) => {
  const errors = trackErrors(page);
  const { token } = await register(page);
  await page.goto("/wallet.html");
  await settle(page);
  await page.route(`${API}/api/payments/**`, (r) => r.abort("connectionrefused"));
  await page.locator("#depAmount").fill("100");
  await page.locator("#depSubmit").click();
  await expect(page.locator("#msg")).toContainText("could not start", { timeout: 20_000 });
  await page.unroute(`${API}/api/payments/**`);
  expect(await serverBalance(request, token)).toBe(0);
  expect(errors).toEqual([]);
});

test("a bet with the balance service down is refused cleanly, and the next one works", async ({ page, request }) => {
  const errors = trackErrors(page);
  const { token } = await fundedPlayer(page);
  await page.goto("/hilo.html?mode=real");
  await settle(page);
  await page.route(`${API}/api/games/**`, (r) => r.abort("connectionrefused"));
  await page.locator("[data-pick]:not([disabled])").first().click();
  await page.locator("#hlConfirmYes").click();
  await expect(page.locator(".toast").last()).toBeVisible();
  await expect(page.locator("[data-pick]:not([disabled])").first()).toBeEnabled();
  expect(await serverBalance(request, token)).toBe(100);

  await page.unroute(`${API}/api/games/**`);
  await page.locator("[data-pick]:not([disabled])").first().click();
  await page.locator("#hlConfirmYes").click();
  await expect(page.locator("#hlMsg")).toHaveText(/You Won|Sorry/, { timeout: 20_000 });
  expect(await serverBalance(request, token)).not.toBe(100);
  expect(errors).toEqual([]);
});

test("while a bet is in flight on a slow network the calls stay locked, so it can't be placed twice", async ({ page, request }) => {
  const { token } = await fundedPlayer(page);
  await page.goto("/hilo.html?mode=real");
  await settle(page);
  await page.route(`${API}/api/games/volta-hilo/play`, async (r) => { await new Promise((res) => setTimeout(res, 2500)); await r.continue(); });
  const stake = Number((await page.locator("#hlAmount").innerText()).replace(/[^\d.]/g, ""));
  await page.locator("[data-pick]:not([disabled])").first().click();
  await page.locator("#hlConfirmYes").click();
  await expect(page.locator("[data-pick]:not([disabled])")).toHaveCount(0);
  await expect(page.locator("#hlMsg")).toHaveText(/You Won|Sorry/, { timeout: 20_000 });
  const balance = await serverBalance(request, token);
  const won = /You Won/.test(await page.locator("#hlMsg").innerText());
  expect(won ? balance > 100 - stake : balance === cents(100 - stake)).toBe(true);
});

test("log-in with the accounts server down says so", async ({ page }) => {
  const { phone } = await register(page);
  await page.goto("/index.html");
  await settle(page);
  await page.locator("[data-logout]").first().click();
  await page.route(`${ACCOUNTS}/**`, (r) => r.abort("connectionrefused"));
  await login(page, phone);
  await expect(page.locator("#formMsg, #lphoneErr, #lpwErr").filter({ hasText: /./ }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/register\.html/);
});
