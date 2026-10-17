/* TheTeller Payment Settings and the redesigned Lotto page, end to end.
   1. The main admin's payments switch: the admin page shows the merchant id and the connection with every secret
      hidden; OFF stops every new payment (the wallet shows the notice, the server refuses), a payment started before
      is still verified and credited, the switch survives a reload, and ON brings deposits back. Players can't flip it.
   2. The Lotto page: the welcome slides slide by themselves and by the arrows, the board and slip use the 3D balls,
      the winners section shows exactly the real wins the server reports (and a clearly labelled promotion), the
      security section is there, and the page fits a phone with no sideways scroll. Set E2E_SHOTS=<folder> to save
      screenshots. */
import { expect, test } from "@playwright/test";
import { acceptRules, adminSession, adminTab, API, GATEWAY, register, serverBalance, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const OFF = "Payments are temporarily unavailable. Please try again later.";
const SHOTS = process.env.E2E_SHOTS;

test("payments switch: OFF stops new payments everywhere, a started payment is still credited, ON again", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const adminToken = await adminSession(request);
  const p = await (await browser.newContext()).newPage();
  const errors = trackErrors(p);
  const player = await register(p);
  const a = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const aErrors = trackErrors(a);
  await adminSession(request, a);

  try {
    /* a card payment started while payments are ON; the customer pays on the checkout page later */
    await acceptRules(request, player.token);
    const started = await request.post(`${API}/api/payments/teller/checkout`, {
      headers: auth(player.token), data: { amount: 25, currency: "GHS", idempotency_key: "deposit:e2e-switch-" + Date.now() } });
    expect(started.status()).toBe(201);
    const tx = (await started.json()).transaction_id as string;

    /* the admin's page: merchant id, connection, secrets hidden */
    await a.goto("/admin.html");
    await settle(a);
    await adminTab(a, "payments");
    const panel = a.locator('[data-panel="payments"]');
    await expect(a.locator("#admTitle")).toHaveText("TheTeller Payment Settings");
    await expect(panel).toContainText("Payments are ON");
    await expect(panel).toContainText("TTM-00000001");
    await expect(panel).toContainText("Connected");
    await expect(panel.locator(".adm-tp-secret")).toHaveCount(3);
    const apiBody = await (await request.get(`${API}/api/admin/payment-settings`, { headers: auth(adminToken) })).text();
    for (const secret of ["e2e-key", "e2e-user", "e2e-passcode"]) {
      expect(await panel.innerHTML()).not.toContain(secret);
      expect(apiBody).not.toContain(secret);
    }
    if (SHOTS) await a.screenshot({ path: `${SHOTS}/admin-payments-on.png`, fullPage: true });

    /* only an admin can switch it */
    expect((await request.post(`${API}/api/admin/payment-settings`, { headers: auth(player.token), data: { enabled: false } })).status()).toBe(403);

    /* OFF */
    await panel.locator(".adm-switch").click();
    await a.locator(".me-dialog [data-yes]").click();
    await expect(a.locator("#msg")).toContainText("OFF");
    await expect(panel).toContainText("Payments are OFF");
    await expect(panel).toContainText(OFF);
    await expect(a.locator('[data-badge="payments"]')).toBeVisible();
    if (SHOTS) await a.screenshot({ path: `${SHOTS}/admin-payments-off.png`, fullPage: true });

    /* the wallet: a valid amount still makes Top Up Now tappable, and tapping explains that payments are unavailable
       instead of starting one; the server refuses one anyway */
    await p.goto("/wallet.html");
    await settle(p);
    await p.locator("#depAmount").fill("50");
    await expect(p.locator("#depSubmit")).toBeEnabled();
    await p.locator("#depSubmit").click();
    await expect(p.locator(".dep-modal")).toContainText("PAYMENT SERVICE UNAVAILABLE");
    await p.locator(".dep-modal button", { hasText: "OK" }).click();
    await expect(p.locator(".dep-modal")).toHaveCount(0);
    await p.locator('[data-paytab="card"]').click();
    await p.locator("#cdAmount").fill("50");
    await p.locator("#cdSubmit").click();
    await expect(p.locator(".dep-modal")).toContainText("PAYMENT SERVICE UNAVAILABLE");
    await p.locator(".dep-modal button", { hasText: "OK" }).click();
    await p.locator('[data-paytab="momo"]').click();
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/wallet-payments-off.png` });
    for (const [path, extra] of [["momo", { account_number: "233241234567", network: "MTN" }], ["checkout", {}]] as const) {
      const r = await request.post(`${API}/api/payments/teller/${path}`, {
        headers: auth(player.token), data: { amount: 20, currency: "GHS", idempotency_key: `deposit:e2e-off-${path}-${Date.now()}`, ...extra } });
      expect(r.status(), path).toBe(503);
      expect(await r.json()).toEqual({ error: "payments_off", message: OFF });
    }
    expect((await (await request.get(`${API}/api/payments/config`)).json()).paymentsOn).toBe(false);

    /* the payment started before still gets verified and credited */
    await request.post(`${GATEWAY}/approve/${tx}`);
    const status = await (await request.get(`${API}/api/payments/teller/status/${tx}`, { headers: auth(player.token) })).json();
    expect(status.status).toBe("approved");
    expect(await serverBalance(request, player.token)).toBeCloseTo(25, 2);

    /* it stays OFF until changed */
    await a.reload();
    await settle(a);
    await adminTab(a, "payments");
    await expect(panel).toContainText("Payments are OFF");

    /* ON again: deposits work */
    await panel.locator(".adm-switch").click();
    await a.locator(".me-dialog [data-yes]").click();
    await expect(panel).toContainText("Payments are ON");
    await expect(a.locator('[data-badge="payments"]')).toBeHidden();
    await p.reload();
    await settle(p);
    await p.locator("#depAmount").fill("50");
    await expect(p.locator("#depSubmit")).toBeEnabled();
    await expect(p.locator("#msg")).not.toContainText(OFF);
  } finally {
    await request.post(`${API}/api/admin/payment-settings`, { headers: auth(adminToken), data: { enabled: true } });
  }
  expect(errors).toEqual([]);
  expect(aErrors).toEqual([]);
});

test("lotto page: welcome slides, 3D balls, verified winners only, security section, fits a phone", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const winners = await (await request.get(`${API}/api/games/lotto/winners`)).json();

  for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["phone", { width: 375, height: 812 }]] as const) {
    const page = await (await browser.newContext({ viewport })).newPage();
    const errors = trackErrors(page);
    await page.goto("/lotto.html");
    await settle(page);

    /* the slides: one showing at a time, real figures filled in, moving by themselves */
    const active = page.locator("#ltHero .lt-slide.is-active");
    await expect(active).toHaveCount(1);
    await expect(page.locator('[data-fill="mult5"]').first()).toContainText("×", { timeout: 20_000 });
    const first = await active.innerText();
    await expect.poll(async () => page.locator("#ltHero .lt-slide.is-active").innerText(), { timeout: 15_000 }).not.toBe(first);
    if (name === "desktop") {
      const before = await active.innerText();
      await page.locator("#ltHero .lt-next").click();
      await expect.poll(async () => page.locator("#ltHero .lt-slide.is-active").innerText()).not.toBe(before);
    }

    /* the board and the slip: 3D balls with the number on a white disc, coloured by number band */
    await expect(page.locator("#ltBoard .lt-num > i")).toHaveCount(90);
    await page.locator('#ltBoard [data-n="7"]').click();
    await page.locator('#ltBoard [data-n="42"]').click();
    await expect(page.locator('#ltBoard [data-n="7"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#ltPicked .lt-ball.lt-c0 > i")).toHaveText("7");
    await expect(page.locator("#ltPicked .lt-ball.lt-c4 > i")).toHaveText("42");

    /* winners: exactly the real wins the server reports, plus one promotion card that says so */
    const realCards = page.locator("#ltWinTrack .lt-win-card:not(.is-promo):not(.is-empty)");
    await expect(page.locator("#ltWinTrack .lt-win-card.is-promo")).toHaveCount(1);
    await expect(page.locator("#ltWinTrack .lt-win-card.is-promo")).toContainText("Promotion");
    await expect(realCards).toHaveCount(winners.top.length);
    if (!winners.top.length) await expect(page.locator("#ltWinTrack")).toContainText("No winners yet");

    /* account security */
    await expect(page.locator(".lt-secure-grid article")).toHaveCount(6);
    await expect(page.locator("#ltSecTitle")).toBeVisible();

    /* nothing wider than the screen */
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, name + ": no sideways scroll").toBeLessThanOrEqual(0);
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/lotto-${name}-top.png` });
      await page.screenshot({ path: `${SHOTS}/lotto-${name}-full.png`, fullPage: true });
    }
    expect(errors, name).toEqual([]);
    await page.context().close();
  }
});
