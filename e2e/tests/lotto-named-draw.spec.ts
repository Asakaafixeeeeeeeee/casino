/* WIN B Lotto named draws end to end, on phone-sized screens: the admin fills the "Schedule a named draw" form with
   Fill Example, enters the five manual winning numbers one per box (bad and repeated numbers are refused there), sets
   betting to close in a couple of minutes, confirms, and sees the draw created with its Draw ID. The live Lotto page
   shows that draw first, with its own times and countdown, without the numbers; a player buys a ticket on it; betting
   closes on the page by itself; at the draw time the result is published automatically, the winning ticket is paid,
   and the results list shows a compact card with the Draw ID (the seed and fingerprint folded under "Verify this
   draw"). A draw scheduled to open later shows "Betting opens in". Everything created here is cleaned up. */
import { expect, test, type Page } from "@playwright/test";
import { adminSession, adminTab, API, register, serverBalance, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const SHOTS = process.env.E2E_SHOTS;
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const pad = (n: number) => String(n).padStart(2, "0");
/* the admin form's Ghana-time (GMT) formats */
const gDate = (ms: number) => { const d = new Date(ms); return pad(d.getUTCDate()) + "/" + pad(d.getUTCMonth() + 1) + "/" + d.getUTCFullYear(); };
const gTime = (ms: number) => { const d = new Date(ms); const h = d.getUTCHours(); return ((h % 12) || 12) + ":" + pad(d.getUTCMinutes()) + " " + (h < 12 ? "AM" : "PM"); };
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("lotto: admin schedules a manual named draw on a phone; players see it live; it closes and publishes itself", async ({ browser, request }) => {
  test.setTimeout(480_000);
  const adminToken = await adminSession(request);
  const before = (await (await request.get(`${API}/api/admin/lotto`, { headers: auth(adminToken) })).json()).settings;
  const made: number[] = [];

  const aCtx = await browser.newContext(PHONE);
  const a = await aCtx.newPage();
  const aErrors = trackErrors(a);
  const pCtx = await browser.newContext(PHONE);
  const p = await pCtx.newPage();
  const pErrors = trackErrors(p);
  /* funded with the admin's "Add money" (this spec is about Lotto, not the deposit flow) */
  const player = await register(p);
  expect((await request.post(`${API}/api/admin/credit`, { headers: auth(adminToken),
    data: { phone: player.phone, amount: 100, reason: "E2E lotto test funds", kind: "CORRECTION", idempotency_key: "e2e-fund-" + player.phone } })).status()).toBe(200);

  try {
    expect((await request.post(`${API}/api/admin/lotto/settings`, { headers: auth(adminToken), data: { real_money: true, licence_confirmed: true } })).status()).toBe(200);

    await adminSession(request, a);
    await a.goto("/admin.html");
    await settle(a);
    await adminTab(a, "lotto");
    const form = a.locator('form[data-form="lotto-draw"]');
    await expect(form).toBeVisible({ timeout: 30_000 });

    /* Fill Example: a manual draw with valid future times and 4 | 18 | 27 | 53 | 81 — nothing is created by it */
    const drawsBefore = (await (await request.get(`${API}/api/admin/lotto`, { headers: auth(adminToken) })).json()).draws.length;
    await a.locator("[data-lt-example]").click();
    await expect(a.locator("#ltaNewName")).toHaveValue("Saturday Special Lotto");
    await expect(form.locator('input[name="ltaDrawMode"][value="MANUAL"]')).toBeChecked();
    for (const [i, n] of ["4", "18", "27", "53", "81"].entries()) await expect(a.locator("#ltaNum" + (i + 1))).toHaveValue(n);
    for (const id of ["ltaNewStartDate", "ltaNewStartTime", "ltaNewEndDate", "ltaNewEndTime", "ltaNewDrawDate", "ltaNewDrawTime"]) {
      await expect(a.locator("#" + id)).not.toHaveValue("");
    }
    await expect(form.locator('button[type="submit"]')).toHaveText("Create and lock manual draw");
    if (SHOTS) await a.locator(".lta-create").screenshot({ path: `${SHOTS}/admin-lotto-named-draw.png` });
    expect((await (await request.get(`${API}/api/admin/lotto`, { headers: auth(adminToken) })).json()).draws.length, "Fill Example creates nothing").toBe(drawsBefore);
    await expect(a.locator("#ltaNum1")).toHaveAttribute("inputmode", "numeric");
    expect(await noSideScroll(a), "the admin form fits a phone").toBe(true);

    /* Example Mode: off empties what the example filled; on fills it again */
    await a.locator(".lta-switch").click();
    await expect(a.locator("#ltaExampleState")).toHaveText("ON");
    await a.locator(".lta-switch").click();
    await expect(a.locator("#ltaExampleState")).toHaveText("OFF");
    await expect(a.locator("#ltaNewName")).toHaveValue("");
    await expect(a.locator("#ltaNum1")).toHaveValue("");
    await a.locator("[data-lt-example]").click();

    /* the five boxes: digits only, a repeat and an out-of-range number are refused with a clear message */
    await a.locator("#ltaNum2").fill("4");
    await expect(a.locator("#ltaNumErr")).toContainText("already used");
    await expect(a.locator("#ltaNum2")).toHaveClass(/is-bad/);
    await a.locator("#ltaNum2").fill("95");
    await expect(a.locator("#ltaNumErr")).toContainText("from 1 to 90");
    await a.locator("#ltaNum2").fill("x7");
    await expect(a.locator("#ltaNum2"), "letters are dropped").toHaveValue("7");
    await a.locator("#ltaNum2").fill("");
    await a.locator("#ltaNum2").pressSequentially("18");
    await expect(a.locator("#ltaNum2")).toHaveValue("18");
    await expect(a.locator("#ltaNum3"), "two digits move on to the next box").toBeFocused();
    await expect(a.locator("#ltaNumErr")).toBeHidden();
    await a.locator("#ltaNum5").fill("");
    await form.locator('button[type="submit"]').click();
    await expect(a.locator(".lta-form-msg")).toContainText("Enter a number in box 5");
    await expect(a.locator(".me-dialog")).toHaveCount(0);
    await a.locator("#ltaNum5").fill("81");

    /* this draw's times: betting open now, closing in ~2-3 minutes, the draw a minute later (Ghana time) */
    const closes = Math.ceil((Date.now() + 150e3) / 60e3) * 60e3;
    const drawAt = closes + 60e3;
    const name = "E2E Special " + Date.now().toString(36);
    await a.locator("#ltaNewName").fill(name);
    await a.locator("#ltaNewStartDate").fill("");
    await a.locator("#ltaNewStartTime").fill("");
    await a.locator("#ltaNewEndDate").fill(gDate(closes));
    await a.locator("#ltaNewEndTime").fill(gTime(closes));
    await a.locator("#ltaNewDrawDate").fill(gDate(drawAt));
    await a.locator("#ltaNewDrawTime").fill(gTime(drawAt));

    /* confirm: a summary of everything, then Create and lock */
    await form.locator('button[type="submit"]').click();
    const confirm = a.locator(".me-dialog");
    await expect(confirm).toContainText("Create and lock this manual draw?");
    await expect(confirm).toContainText(name);
    await expect(confirm.locator(".lta-ball")).toHaveText(["4", "18", "27", "53", "81"]);
    if (SHOTS) await a.screenshot({ path: `${SHOTS}/admin-lotto-confirm.png` });
    await confirm.locator("[data-yes]").click();
    const done = a.locator(".me-dialog", { hasText: "Draw created" });
    await expect(done).toBeVisible({ timeout: 20_000 });
    const code = (await done.locator("dd").nth(1).textContent())!.trim();
    expect(code).toMatch(/^WBL-\d{8}-\d+$/);
    await expect(done.locator("[data-no]")).toHaveCount(0);
    await done.locator("[data-yes]").click();
    await expect(a.locator(".lta-form-msg.is-ok")).toContainText(code);

    const draws = (await (await request.get(`${API}/api/admin/lotto`, { headers: auth(adminToken) })).json()).draws;
    const draw = draws.find((d: { name: string }) => d.name === name);
    made.push(draw.id);
    expect(draw.draw_code).toBe(code);
    expect(draw.number_source).toBe("MANUAL");
    expect(draw.status).toBe("OPEN");
    expect(draw.numbers, "locked numbers stay hidden while betting is open, even from the admin list").toBeNull();
    expect(new Date(draw.closes_at).getTime()).toBe(closes);
    expect(new Date(draw.draw_at).getTime()).toBe(drawAt);
    await expect(a.locator(`#ltaDraws tr[data-lt-row="${draw.id}"]`)).toContainText(code);

    /* the live page: this named draw first, its times in GMT, a countdown, and no numbers anywhere */
    const state = await (await request.get(`${API}/api/games/lotto/state`)).json();
    const live = state.draws.find((d: { id: number }) => d.id === draw.id);
    expect(live && !("numbers" in live) && !("seed" in live), "players can't see the numbers before the draw").toBe(true);
    await p.goto("/lotto.html");
    await settle(p);
    await expect(p.locator("#ltDrawTitle")).toHaveText(name, { timeout: 20_000 });
    await expect(p.locator("#ltStatus")).toHaveText("Betting open");
    await expect(p.locator("#ltDrawWhen")).toContainText("Betting closes");
    await expect(p.locator("#ltDrawWhen")).not.toContainText("GMT GMT");
    await expect(p.locator("#ltCountLabel")).toHaveText("Betting closes in");
    const c1 = await p.locator("#ltCount").textContent();
    await p.waitForTimeout(2_100);
    expect(await p.locator("#ltCount").textContent(), "the countdown runs by itself").not.toBe(c1);
    await expect(p.locator("#ltDrawTabs")).toBeVisible();
    if (SHOTS) await p.locator(".lt-draw").screenshot({ path: `${SHOTS}/lotto-live-named-draw.png` });

    /* a winning Direct-2 ticket on this draw */
    await p.locator('#ltBoard [data-n="4"]').click();
    await p.locator('#ltBoard [data-n="18"]').click();
    await p.locator("#ltStake").fill("2");
    await p.locator("#ltStake").dispatchEvent("change");
    await p.locator("#ltBuy").click();
    await p.locator("#ltConfirmBuy").click();
    await expect(p.locator("#ltIssued")).toBeVisible({ timeout: 20_000 });
    await p.locator("#ltIssued button").click();
    expect(await serverBalance(request, player.token)).toBeCloseTo(98, 2);
    const ticket = (await (await request.get(`${API}/api/games/lotto/tickets`, { headers: auth(player.token) })).json()).tickets[0];
    expect(ticket.draw_id).toBe(draw.id);

    /* a draw that opens later: shown with "Opens …" and its own countdown to opening */
    const later = await request.post(`${API}/api/admin/lotto/draws`, { headers: auth(adminToken), data: {
      name: "E2E Later " + Date.now().toString(36), opens_at: new Date(Date.now() + 3 * 3600e3).toISOString(),
      closes_at: new Date(Date.now() + 5 * 3600e3).toISOString(), idempotency_key: "e2e-later-" + Date.now() } });
    expect(later.status()).toBe(200);
    const laterId = (await later.json()).id;
    made.push(laterId);
    await expect.poll(async () => { await p.reload(); await settle(p); return p.locator(`#ltDrawTabs [data-draw="${laterId}"]`).count(); },
      { timeout: 30_000 }).toBe(1);
    await expect(p.locator(`#ltDrawTabs [data-draw="${laterId}"]`)).toContainText("Opens");
    await p.locator(`#ltDrawTabs [data-draw="${laterId}"]`).click();
    await expect(p.locator("#ltStatus")).toHaveText("Opens soon");
    await expect(p.locator("#ltCountLabel")).toHaveText("Betting opens in");
    await expect(p.locator("#ltBuy")).toBeDisabled();
    await p.locator(`#ltDrawTabs [data-draw="${draw.id}"]`).click();

    /* betting closes on the page without a refresh */
    await expect(p.locator(".toast-host"), "the player is told betting closed").toContainText("Betting on " + name + " has closed", { timeout: 240_000 });
    await expect(p.locator(`#ltDrawTabs [data-draw="${draw.id}"]`), "the closed draw leaves the draws taking bets").toHaveCount(0, { timeout: 20_000 });
    await expect(p.locator("#ltDrawTitle")).not.toHaveText(name);
    await expect.poll(async () => (await request.post(`${API}/api/games/lotto/ticket`, { headers: auth(player.token),
      data: { picks: [7], stake: 1, draw_id: draw.id, idempotency_key: "e2e-late-" + Date.now() } })).status(), { timeout: 30_000 }).toBe(409);

    /* the draw time: published automatically, the winner paid */
    await expect.poll(async () => (await (await request.get(`${API}/api/admin/lotto`, { headers: auth(adminToken) })).json())
      .draws.find((d: { id: number }) => d.id === draw.id).status, { timeout: 180_000, intervals: [5_000] }).toBe("RELEASED");
    const won = (await (await request.get(`${API}/api/games/lotto/tickets`, { headers: auth(player.token) })).json()).tickets
      .find((t: { draw_id: number }) => t.draw_id === draw.id);
    expect(won.status).toBe("WON");
    expect(await serverBalance(request, player.token)).toBeCloseTo(98 + won.payout, 2);

    /* the results: a compact card with the Draw ID; the proof only under "Verify this draw" */
    await p.reload();
    await settle(p);
    await p.locator('[data-lt-tab="results"]').click();
    const card = p.locator("#ltResults .lt-result", { hasText: code });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator(".lt-result-head")).toContainText(name);
    await expect(card.locator(".lt-ball")).toHaveText(["4", "18", "27", "53", "81"]);
    await expect(card.locator(".lt-result-meta")).toContainText("GMT");
    await expect(card.locator(".lt-draw-id")).toHaveText("Draw ID " + code);
    await expect(card.locator(".lt-verify code").first()).toBeHidden();
    if (SHOTS) await p.locator("#ltResults").screenshot({ path: `${SHOTS}/lotto-results.png` });
    await card.locator(".lt-verify summary").click();
    if (SHOTS) await card.screenshot({ path: `${SHOTS}/lotto-result-verify.png` });
    await expect(card.locator(".lt-verify code").first()).toHaveText(/^[0-9a-f]{64}$/);
    expect(await noSideScroll(p), "the results fit a phone").toBe(true);
    await expect(p.locator("#ltMine .lt-ticket.won").first()).toBeAttached();

    expect(aErrors).toEqual([]);
    expect(pErrors).toEqual([]);
  } finally {
    for (const id of made) await request.post(`${API}/api/admin/lotto/draws/${id}/cancel`, { headers: auth(adminToken), data: { idempotency_key: "e2e-c-" + id + Date.now() } });
    await request.post(`${API}/api/admin/lotto/settings`, { headers: auth(adminToken), data: { real_money: before.real_money } });
  }
});
