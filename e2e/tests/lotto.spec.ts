/* WIN B Lotto end to end, through the real screens: with ticket sales opened by the admin, a funded player picks
   numbers, reviews and confirms a ticket (stake taken once, ticket code issued and listed); a Perm ticket costs stake
   × lines; the admin moves the draw so betting closes a minute from now, sees the server-drawn numbers only after it
   closes, releases the results, and the player's tickets show Won or Lost with the drawn numbers. The draw schedule
   and ticket sales are put back at the end. */
import { expect, test } from "@playwright/test";
import { adminSession, adminTab, API, register, serverBalance, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

test("lotto: sales closed by default; buy Direct and Perm tickets, betting closes, admin releases, tickets settled", async ({ browser, request }) => {
  test.setTimeout(360_000);
  const adminToken = await adminSession(request);
  const before = (await (await request.get(`${API}/api/admin/lotto`, { headers: auth(adminToken) })).json()).settings;

  const pCtx = await browser.newContext();
  const p = await pCtx.newPage();
  const errors = trackErrors(p);
  /* funded with the admin's "Add money" (this spec is about Lotto, not the deposit flow) */
  const player = await register(p);
  expect((await request.post(`${API}/api/admin/credit`, { headers: auth(adminToken),
    data: { phone: player.phone, amount: 100, reason: "E2E lotto test funds", kind: "CORRECTION", idempotency_key: "e2e-fund-" + player.phone } })).status()).toBe(200);

  try {
    /* sales are closed until the admin opens them (confirming the licence) */
    await request.post(`${API}/api/admin/lotto/settings`, { headers: auth(adminToken), data: { real_money: false } });
    await p.goto("/lotto.html");
    await settle(p);
    await expect(p.locator("#ltSalesClosed")).toBeVisible({ timeout: 20_000 });
    await expect(p.locator("#ltBuy")).toHaveText("Ticket sales open soon");
    expect((await request.post(`${API}/api/admin/lotto/settings`, { headers: auth(adminToken), data: { real_money: true } })).status()).toBe(400);
    expect((await request.post(`${API}/api/admin/lotto/settings`, { headers: auth(adminToken), data: { real_money: true, licence_confirmed: true } })).status()).toBe(200);

    /* the page: draw, countdown, payouts, fingerprint */
    await p.reload();
    await settle(p);
    await expect(p.locator("#ltStatus")).toHaveText("Betting open", { timeout: 20_000 });
    await expect(p.locator("#ltSalesClosed")).toBeHidden();
    await expect(p.locator("#ltPayouts tr")).toHaveCount(5);
    await expect(p.locator("#ltCount")).toHaveText(/\d\d:\d\d:\d\d$/);
    await expect(p.locator("#ltHashRow")).toBeVisible();

    /* Direct-2: pick two numbers, stake 5, review, confirm */
    await p.locator('#ltBoard [data-n="7"]').click();
    await p.locator('#ltBoard [data-n="42"]').click();
    await expect(p.locator("#ltType")).toHaveText("Direct-2");
    await p.locator("#ltStake").fill("5");
    await p.locator("#ltStake").dispatchEvent("change");
    await p.locator("#ltBuy").click();
    await expect(p.locator("#ltConfirm")).toBeVisible();
    await p.locator("#ltConfirmBuy").click();
    await expect(p.locator("#ltIssued")).toBeVisible({ timeout: 20_000 });
    await expect(p.locator("#ltIssued .lt-ticket-code")).toHaveText(/^LT-[0-9A-F]{10}$/);
    await p.locator("#ltIssued button").click();
    await expect(p.locator("#ltMine .lt-ticket")).toHaveCount(1, { timeout: 20_000 });
    expect(await serverBalance(request, player.token)).toBeCloseTo(95, 2);

    /* Perm 2 from 3 numbers: 3 lines × 1 = 3 */
    await p.locator('#ltTypes [data-type="PERM"]').click();
    for (const n of [10, 20, 30]) await p.locator(`#ltBoard [data-n="${n}"]`).click();
    await expect(p.locator("#ltLines")).toHaveText("3");
    await p.locator("#ltStake").fill("1");
    await p.locator("#ltStake").dispatchEvent("change");
    await expect(p.locator("#ltCost")).toHaveText("GHS 3.00");
    await p.locator("#ltBuy").click();
    await p.locator("#ltConfirmBuy").click();
    await expect(p.locator("#ltIssued")).toBeVisible({ timeout: 20_000 });
    await p.locator("#ltIssued button").click();
    await expect(p.locator("#ltMine .lt-ticket")).toHaveCount(2, { timeout: 20_000 });
    expect(await serverBalance(request, player.token)).toBeCloseTo(92, 2);

    /* the admin moves today's draw so betting closes within ~2 minutes */
    const set = await request.post(`${API}/api/admin/lotto/settings`, {
      headers: auth(adminToken), data: { draw_time: hhmm(Date.now() + 3 * 60e3), cutoff_min: 1 } });
    expect(set.status()).toBe(200);
    const mine = (await (await request.get(`${API}/api/games/lotto/tickets`, { headers: auth(player.token) })).json()).tickets;
    let draws = (await (await request.get(`${API}/api/admin/lotto`, { headers: auth(adminToken) })).json()).draws;
    let draw = draws.find((d: { id: number }) => d.id === mine[0].draw_id);
    expect(draw.status).toBe("OPEN");
    expect(draw.numbers, "nobody sees the numbers while betting is open").toBeNull();

    /* once betting has closed: numbers shown, Release results */
    const a = await (await browser.newContext()).newPage();
    const aErrors = trackErrors(a);
    await adminSession(request, a);
    await expect.poll(async () => {
      draws = (await (await request.get(`${API}/api/admin/lotto`, { headers: auth(adminToken) })).json()).draws;
      draw = draws.find((d: { id: number }) => d.id === mine[0].draw_id);
      return draw.status;
    }, { timeout: 200_000, intervals: [5_000] }).toBe("CLOSED");
    expect(draw.numbers).toHaveLength(5);
    expect((await request.post(`${API}/api/admin/lotto/draws/${draw.id}/release`, { headers: auth(adminToken), data: {} })).status(), "publishing needs confirmation").toBe(400);

    await a.goto("/admin.html");
    await settle(a);
    await adminTab(a, "lotto");
    const row = a.locator("#ltaDraws tr", { hasText: "#" + draw.id });
    await expect(row.locator(".lta-ball")).toHaveCount(5);
    await row.locator("[data-lt-tickets]").click();
    await expect(a.locator("#ltaTickets tbody tr")).toHaveCount(2);
    await expect(a.locator("#ltaTickets")).toContainText("Perm 2");
    await row.locator("[data-lt-release]").click();
    await a.locator(".me-dialog [data-yes]").click();
    await expect(a.locator("#msg")).toContainText("released", { timeout: 20_000 });
    await expect(row.locator(".adm-pill")).toContainText("Results released");

    /* the player sees the results */
    const n: number[] = draw.numbers;
    const directWon = [7, 42].every((x) => n.includes(x));
    const permLines = [10, 20, 30].filter((x) => n.includes(x)).length;
    const permWinLines = permLines >= 2 ? (permLines === 3 ? 3 : 1) : 0;
    await p.reload();
    await settle(p);
    await expect(p.locator("#ltMine .lt-ticket .lt-ball.is-drawn, #ltMine .lt-ticket .lt-ball.is-miss")).toHaveCount(5, { timeout: 20_000 });
    await p.locator('[data-lt-tab="results"]').click();
    await expect(p.locator("#ltResults .lt-row").first().locator(".lt-ball.is-drawn")).toHaveCount(5);
    const mult = mine.find((t: { bet: string }) => t.bet === "Direct-2").multiplier;
    expect(await serverBalance(request, player.token)).toBeCloseTo(92 + (directWon ? 5 * mult : 0) + permWinLines * 1 * mult, 2);
    expect(errors).toEqual([]);
    expect(aErrors).toEqual([]);
  } finally {
    await request.post(`${API}/api/admin/lotto/settings`, {
      headers: auth(adminToken), data: { draw_time: before.draw_time, cutoff_min: before.cutoff_min, real_money: false } });
  }
});
