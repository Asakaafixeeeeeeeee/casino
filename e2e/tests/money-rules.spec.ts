/* Admin -> Betting & withdrawal settings, end to end: the admin raises the minimum deposit to GHS 135 and switches the
   betting rule ON (confirmed, saved, in the history); a player deposits without an extra acceptance checkbox;
   a player whose money came from an admin credit (no deposit) is refused a bet with the admin's message, sees it in
   the game, keeps their balance, and is listed under "Affected players". The stack's settings are put back after. */
import { expect, test } from "@playwright/test";
import { adminSession, adminTab, API, register, serverBalance, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const SHOTS = process.env.E2E_SHOTS;

test("betting & withdrawal settings: admin page, simple deposit flow, betting rule", async ({ browser, request }) => {
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
    await panel.locator('input[data-mr="bet_rule_enabled"]').check({ force: true });
    await panel.locator('form[data-form="moneyrules"] button[type="submit"]').click();
    const dialog = a.locator(".me-dialog");
    await expect(dialog).toContainText("Minimum deposit");
    await expect(dialog).toContainText("Betting rule");
    await expect(dialog).toContainText("apply immediately");
    await dialog.locator("[data-yes]").click();
    await expect(a.locator("#msg")).toContainText("settings saved");
    await expect(panel).toContainText("New-deposit betting requirement");
    await expect(panel).toContainText("Deposit page conditions");
    await expect(panel.locator(".mr-card.is-on")).toHaveCount(1);
    await expect(panel.locator('[data-mr-preview="bet"]')).toContainText("Only deposited funds can be staked");
    await expect(a.locator("#mrHistory")).toContainText("Minimum deposit");
    await expect(a.locator("#mrHistory")).toContainText("GHS 135");
    if (SHOTS) await a.screenshot({ path: `${SHOTS}/admin-money-rules.png`, fullPage: true });
    const saved = (await (await request.get(`${API}/api/admin/money-rules`, { headers: auth(adminToken) })).json()).settings;
    expect([saved.min_deposit, saved.bet_rule_enabled]).toEqual([135, true]);

    /* 2. the deposit page has no extra acceptance step; the full terms remain linked. */
    await p.goto("/wallet.html");
    await settle(p);
    await expect(p.locator("#depRulesAccept")).toHaveCount(0);
    await expect(p.locator('.pay-note-extra a[href="terms.html#money-rules"]')).toBeVisible();
    await expect(p.locator(".pay-min").first()).toContainText("135.00");
    await expect(p.locator("#depAmount")).toHaveAttribute("min", "135");
    await p.locator("#depAmount").fill("100");
    await expect(p.locator("#depSubmit")).toBeDisabled();
    await p.locator("#depAmount").fill("135");
    await p.locator("#depSubmit").click();
    await expect(p.locator("#msg")).toContainText("successful", { timeout: 30_000 });
    expect(await serverBalance(request, player.token)).toBe(135);
    /* a qualifying deposit: this player may stake it */
    const ok = await request.post(`${API}/api/games/volta-coin/play`, { headers: auth(player.token),
      data: { stake: 2, choice: { pick: "HEADS" }, idempotency_key: "round:e2e-rules-ok-" + Date.now() } });
    expect(ok.status()).toBe(200);

    /* 3. a player left with only winnings: winnings can't be staked (message, balance untouched), and stay theirs */
    const c = await (await browser.newContext()).newPage();
    const cErrors = trackErrors(c);
    const credited = await register(c);
    let won = 0;
    for (let i = 0; i < 40 && !won; i++) {
      /* GHS 2 of credited (deposited) money staked on a coin: a loss uses it up, a win leaves only winnings */
      const credit = await request.post(`${API}/api/admin/credit`, { headers: auth(adminToken),
        data: { phone: credited.phone, amount: 2, reason: "e2e credit for the betting rule", idempotency_key: "adjust:e2e-rules-" + i + "-" + Date.now() } });
      expect(credit.status(), await credit.text()).toBe(200);
      const play = await request.post(`${API}/api/games/volta-coin/play`, { headers: auth(credited.token),
        data: { stake: 2, choice: { pick: "HEADS" }, idempotency_key: "round:e2e-rules-w-" + i + "-" + Date.now() } });
      expect(play.status(), await play.text()).toBe(200);
      won = await serverBalance(request, credited.token);
    }
    expect(won, "a coin win within 40 tries").toBeGreaterThan(0);
    const bet = await request.post(`${API}/api/games/volta-coin/play`, { headers: auth(credited.token),
      data: { stake: 1, choice: { pick: "HEADS" }, idempotency_key: "round:e2e-rules-no-" + Date.now() } });
    expect(bet.status()).toBe(403);
    const body = await bet.json();
    expect(body.error).toBe("deposit_required");
    expect(body.message).toContain("cannot be staked");
    expect(await serverBalance(request, credited.token)).toBe(won);
    /* in a game: the same message, with a way to the deposit page */
    await c.goto("/hilo.html?mode=real");
    await settle(c);
    await c.locator("[data-pick]:not([disabled])").first().click();
    await c.locator("#hlConfirmYes").click();
    await expect(c.locator("#vbDepositRequired")).toBeVisible();
    await expect(c.locator("#vbDepositRequired")).toContainText("cannot be staked");
    await expect(c.locator('#vbDepositRequired a[href="wallet.html"]')).toBeVisible();
    if (SHOTS) await c.screenshot({ path: `${SHOTS}/game-deposit-required.png` });
    expect(await serverBalance(request, credited.token)).toBe(won);
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
