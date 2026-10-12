/* Risk management and recent deposits through the admin's real screens: a deposit attempt shows in Recent deposits
   with its status and is searchable; the Risk tab saves alert thresholds and lists players' money; a per-player
   maximum bet set from a player's profile is enforced by the server, and clearing it restores normal play. Limits
   are put back at the end. */
import { expect, test } from "@playwright/test";
import { adminSession, adminTab, API, deposit, fundedPlayer, play, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

test("admin risk management and recent deposits", async ({ browser, request }) => {
  test.setTimeout(300_000);
  const adminToken = await adminSession(request);
  const adminCtx = await browser.newContext();
  const a = await adminCtx.newPage();
  const errors = trackErrors(a);
  await adminSession(request, a);

  /* a funded player (a real confirmed deposit) who has placed a few bets */
  const pCtx = await browser.newContext();
  const p = await pCtx.newPage();
  const player = await fundedPlayer(p, 100);
  for (let i = 0; i < 3; i++) {
    expect((await play(request, player.token, "volta-coin", { stake: 2, choice: { pick: "HEADS" }, idempotency_key: `round:risk-${Date.now()}-${i}` })).status).toBe(200);
  }

  try {
    /* 1. Recent deposits: the player's confirmed deposit is listed, searchable, and separate from withdrawals */
    await a.goto("/admin.html");
    await settle(a);
    await adminTab(a, "deposits");
    /* scope to this player's own deposit row (other tests have deposits in the list too) */
    await a.locator("#dpQ").fill(player.phone);
    await expect(a.locator("#dpList tr", { hasText: player.phone })).toHaveCount(1);
    await expect(a.locator("#dpList tr", { hasText: player.phone }).locator(".adm-pill")).toContainText("successful");
    await a.locator('[data-chips="dstatus"] [data-v="failed"]').click();
    await expect(a.locator("#dpList")).toContainText("No deposits match");
    await a.locator('[data-chips="dstatus"] [data-v="all"]').click();
    await a.locator("#dpQ").fill("0000000000");
    await expect(a.locator("#dpList")).toContainText("No deposits match");

    /* 2. Risk: save an alert threshold, and see the player in Players' money */
    await adminTab(a, "risk");
    await expect(a.locator("#rsPayout")).toBeVisible();
    await a.locator("#rsPayout").fill("250");
    await a.locator('form[data-act="risk-settings"] button[type=submit]').click();
    await expect(a.locator("#msg")).toContainText("Alert settings saved");
    await expect.poll(async () => (await (await request.get(`${API}/api/admin/risk`, { headers: auth(adminToken) })).json()).settings.big_payout).toBe(250);
    await expect(a.locator('[data-panel="risk"]')).toContainText("Players' money");
    await expect(a.locator('[data-panel="risk"]')).toContainText(player.phone);

    /* 3. a per-player maximum bet, set from the player's profile, is enforced by the server */
    await a.locator('[data-panel="risk"] .adm-rowlink', { hasText: player.phone }).first().click();
    const sheet = a.locator(".adm-sheet");
    await expect(sheet).toContainText("Deposit and bet limits");
    await sheet.locator("#rkMaxBet").fill("5");
    await sheet.locator('form[data-act="limits"] button[type=submit]').click();
    await expect(a.locator("#msg")).toContainText("Limits saved");
    await expect.poll(async () => (await play(request, player.token, "volta-coin", { stake: 10, choice: { pick: "HEADS" }, idempotency_key: `round:risk-cap-${Date.now()}` })).status).toBe(400);
    /* a bet within the limit still works */
    expect((await play(request, player.token, "volta-coin", { stake: 5, choice: { pick: "HEADS" }, idempotency_key: `round:risk-ok-${Date.now()}` })).status).toBe(200);
    expect(errors, "no uncaught errors on the admin page").toEqual([]);

    /* the player now appears in the server's "players with limits" list, with the max bet that was set */
    const limited = (await (await request.get(`${API}/api/admin/risk/limits`, { headers: auth(adminToken) })).json()).players;
    const mine = limited.find((x: { phone: string }) => x.phone === player.phone);
    expect(mine?.max_bet).toBe(5);
  } finally {
    const uid = (await (await request.get(`${API}/api/admin/risk/players?q=${player.phone}`, { headers: auth(adminToken) })).json()).players[0]?.id;
    if (uid) await request.post(`${API}/api/admin/risk/player/${uid}`, { headers: auth(adminToken), data: { min_deposit: null, max_deposit: null, max_bet: null } });
  }
});
