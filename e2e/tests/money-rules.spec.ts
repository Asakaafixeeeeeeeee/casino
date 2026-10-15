/* Admin -> Betting & withdrawal settings, end to end: the admin raises the minimum deposit to GHS 135 and switches the
   betting rule ON (confirmed, saved, in the history); a player's deposit page shows "Before you deposit" with the live
   minimum and the rule, refuses to deposit until the rules are accepted, then collapses to a summary and deposits;
   a player whose money came from an admin credit (no deposit) is refused a bet with the admin's message, sees it in
   the game, keeps their balance, and is listed under "Affected players". The stack's settings are put back after. */
import { expect, test } from "@playwright/test";
import { adminSession, adminTab, API, register, serverBalance, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const SHOTS = process.env.E2E_SHOTS;

test("betting & withdrawal settings: admin page, deposit disclosure and acceptance, betting rule", async ({ browser, request }) => {
  test.setTimeout(300_000);
  const adminToken = await adminSession(request);
  const before = (await (await request.get(`${API}/api/admin/money-rules`, { headers: auth(adminToken) })).json()).settings;
  const a = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const aErrors = trackErrors(a);
  await adminSession(request, a);
  const p = await (await browser.newContext()).newPage();
  const pErrors = trackErrors(p);

  try {
    /* only admins */
    const player = await register(p);
    expect((await request.get(`${API}/api/admin/money-rules`, { headers: auth(player.token) })).status()).toBe(403);
    expect((await request.post(`${API}/api/admin/money-rules`, { headers: auth(player.token), data: { min_deposit: 1 } })).status()).toBe(403);

    /* 1. the admin page: min deposit 135, betting rule ON, saved after a confirmation that lists the changes */
    await a.goto("/admin.html");
    await settle(a);
    await adminTab(a, "moneyrules");
    await expect(a.locator("#admTitle")).toHaveText("Betting & withdrawal settings");
    const panel = a.locator('[data-panel="moneyrules"]');
    await expect(panel.locator("#mrMin")).toBeVisible();
    await panel.locator("#mrMin").fill("135");
    await panel.locator("#mrDays").fill("30");
    await panel.locator('input[data-mr="bet_rule_enabled"]').check({ force: true });
    await panel.locator('form[data-form="moneyrules"] button[type="submit"]').click();
    const dialog = a.locator(".me-dialog");
    await expect(dialog).toContainText("Minimum deposit");
    await expect(dialog).toContainText("Betting rule");
    await expect(dialog).toContainText("accept the updated rules");
    await dialog.locator("[data-yes]").click();
    await expect(a.locator("#msg")).toContainText("settings saved");
    await expect(panel).toContainText("Betting eligibility rule");
    await expect(panel.locator(".mr-card.is-on")).toHaveCount(1);
    await expect(panel.locator('[data-mr-preview="bet"]')).toContainText("at least GHS 135 in the last 30 days");
    await expect(a.locator("#mrHistory")).toContainText("Minimum deposit");
    await expect(a.locator("#mrHistory")).toContainText("GHS 135");
    if (SHOTS) await a.screenshot({ path: `${SHOTS}/admin-money-rules.png`, fullPage: true });
    const saved = (await (await request.get(`${API}/api/admin/money-rules`, { headers: auth(adminToken) })).json()).settings;
    expect([saved.min_deposit, saved.bet_rule_enabled]).toEqual([135, true]);

    /* 2. the deposit page: the box with the live minimum and the rule; no deposit until accepted */
    await p.goto("/wallet.html");
    await settle(p);
    const box = p.locator("#depRules");
    await expect(box).toBeVisible();
    await expect(box).toContainText("Before you deposit");
    await expect(box).toContainText("GHS 135.00");
    await expect(box).toContainText("at least GHS 135 in the last 30 days");
    await expect(p.locator(".pay-min").first()).toContainText("135.00");
    await expect(p.locator("#depAmount")).toHaveAttribute("min", "135");
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/wallet-rules-box.png`, fullPage: true });
    await p.locator("#depAmount").fill("100");
    await expect(p.locator("#depSubmit")).toBeDisabled();
    await p.locator("#depAmount").fill("135");
    await p.locator("#depSubmit").click();
    await expect(p.locator("#depRulesErr")).toContainText("tick the box");
    /* the server refuses it too */
    const refused = await request.post(`${API}/api/payments/teller/momo`, { headers: auth(player.token),
      data: { amount: 135, currency: "GHS", network: "MTN", account_number: "233" + player.phone.slice(1), idempotency_key: "deposit:e2e-rules-" + Date.now() } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toBe("rules_not_accepted");
    await p.locator("#depRulesAccept").check();
    await expect(p.locator("#depRulesSummary")).toBeVisible();
    await expect(p.locator("#depRulesSummary")).toContainText("Rules accepted");
    await expect(box).toBeHidden();
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/wallet-rules-accepted.png` });
    await p.locator("#depSubmit").click();
    await expect(p.locator("#msg")).toContainText("successful", { timeout: 30_000 });
    expect(await serverBalance(request, player.token)).toBe(135);
    /* a qualifying deposit: this player may bet */
    const ok = await request.post(`${API}/api/games/volta-coin/play`, { headers: auth(player.token),
      data: { stake: 2, choice: { pick: "HEADS" }, idempotency_key: "round:e2e-rules-ok-" + Date.now() } });
    expect(ok.status()).toBe(200);
    /* the box stays collapsed on the next visit */
    await p.reload();
    await settle(p);
    await expect(p.locator("#depRulesSummary")).toBeVisible();

    /* 3. money from an admin credit, no deposit: bets refused with the message, balance untouched */
    const c = await (await browser.newContext()).newPage();
    const cErrors = trackErrors(c);
    const credited = await register(c);
    const credit = await request.post(`${API}/api/admin/credit`, { headers: auth(adminToken),
      data: { phone: credited.phone, amount: 30, reason: "e2e credit for the betting rule", idempotency_key: "adjust:e2e-rules-" + Date.now() } });
    expect(credit.status(), await credit.text()).toBe(200);
    const bet = await request.post(`${API}/api/games/volta-coin/play`, { headers: auth(credited.token),
      data: { stake: 2, choice: { pick: "HEADS" }, idempotency_key: "round:e2e-rules-no-" + Date.now() } });
    expect(bet.status()).toBe(403);
    const body = await bet.json();
    expect(body.error).toBe("deposit_required");
    expect(body.message).toContain("at least GHS 135 in the last 30 days");
    expect(await serverBalance(request, credited.token)).toBe(30);
    /* in a game: the same message, with a way to the deposit page */
    await c.goto("/hilo.html?mode=real");
    await settle(c);
    await c.locator("[data-pick]:not([disabled])").first().click();
    await c.locator("#hlConfirmYes").click();
    await expect(c.locator("#vbDepositRequired")).toBeVisible();
    await expect(c.locator("#vbDepositRequired")).toContainText("at least GHS 135 in the last 30 days");
    await expect(c.locator('#vbDepositRequired a[href="wallet.html"]')).toBeVisible();
    if (SHOTS) await c.screenshot({ path: `${SHOTS}/game-deposit-required.png` });
    expect(await serverBalance(request, credited.token)).toBe(30);
    expect(cErrors).toEqual([]);

    /* 4. the admin sees that player under "Affected players" */
    await a.reload();
    await settle(a);
    await adminTab(a, "moneyrules");
    await a.locator("#mrQ").fill(credited.phone);
    await expect(a.locator("#mrAffected")).toContainText(credited.phone);
    await expect(a.locator("#mrAffected")).toContainText("Can't bet right now");

    /* 5. on a phone the section is in the menu and fits the screen */
    const m = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    const mErrors = trackErrors(m);
    await adminSession(request, m);
    await m.goto("/admin.html#moneyrules");
    await settle(m);
    await expect(m.locator("#mrMin")).toBeVisible();
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "no sideways scroll on a phone").toBeLessThanOrEqual(1);
    if (SHOTS) await m.screenshot({ path: `${SHOTS}/admin-money-rules-phone.png`, fullPage: true });
    expect(mErrors).toEqual([]);
  } finally {
    /* the stack's settings as they were (min deposit back to the stack's value, betting rule off) */
    await request.post(`${API}/api/admin/money-rules`, { headers: auth(adminToken),
      data: { min_deposit: before.min_deposit, bet_rule_enabled: before.bet_rule_enabled, bet_rule_days: before.bet_rule_days } });
  }
  expect(aErrors).toEqual([]);
  expect(pErrors).toEqual([]);
});
