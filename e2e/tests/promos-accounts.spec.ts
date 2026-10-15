/* Account control, the Lotto Key, the results popup and the promotion schedule, end to end.
   1. Blocked / Banned / Deleted users: the admin blocks a player for a period (no deposit), bans them (signed out, log-in
      refused), lifts the ban after review, deletes with a typed confirmation (log-in refused, balance kept) and restores.
   2. Lotto Key: the admin moves the draw so betting closes, sees the locked numbers, presses PUBLISH RESULT; a player
      with the site open gets the CONGRATULATIONS popup with those numbers and a STAKE LOTTO link.
   3. Promotions: on a fake clock, the popups come at 5 min, +1 h, +2 min, +5 min, +1 h, +3 min and then again, Lotto on
      every other one; never on a game page; mute stops them. Set E2E_SHOTS=<folder> for screenshots. */
import { expect, test, type Page } from "@playwright/test";
import { ACCOUNTS, adminSession, adminTab, API, PASSWORD, register, serverBalance, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const SHOTS = process.env.E2E_SHOTS;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
/* this spec wants the popups (automated browsers don't get them otherwise) */
const wantPopups = (page: Page) => page.addInitScript(() => localStorage.setItem("winb.promos.test", "1"));

async function act(a: Page, kind: string, phone: string, action: string, fill: Record<string, string> = {}) {
  await adminTab(a, kind);
  const find = a.locator(`[data-ac-find="${kind}"]`);
  await find.fill(phone);
  await a.locator(`#acFound_${kind} [data-ac-act="${action}"]`).first().click();
  for (const [id, v] of Object.entries(fill)) {
    const el = a.locator(`#acf_${id}`);
    if ((await el.evaluate((e) => e.tagName)) === "SELECT") await el.selectOption(v);
    else await el.fill(v);
  }
  await a.locator(".me-dialog [data-yes]").click();
  await expect(a.locator("#msg")).toContainText(phone.length ? "" : "", { timeout: 20_000 });
}

test("blocked, banned and deleted users: every action through the admin screens, with the effect on the player", async ({ browser, request }) => {
  test.setTimeout(240_000);
  const adminToken = await adminSession(request);
  const pCtx = await browser.newContext();
  const p = await pCtx.newPage();
  const player = await register(p);
  const a = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const aErrors = trackErrors(a);
  await adminSession(request, a);
  await a.goto("/admin.html");
  await settle(a);
  const login = () => request.post(`${ACCOUNTS}/api/login`, { data: { phone: player.phone, password: PASSWORD } });

  /* block for 3 days: still signs in, but no deposit */
  await act(a, "blocked", player.phone, "block", { reason: "Checking a disputed payment", period: "3d" });
  const blockedRow = a.locator('[data-panel="blocked"] tbody tr', { hasText: player.phone });
  await expect(blockedRow).toContainText("Checking a disputed payment");
  await expect(blockedRow).toContainText("Until");
  if (SHOTS) await a.screenshot({ path: `${SHOTS}/admin-blocked.png`, fullPage: true });
  const dep = await request.post(`${API}/api/payments/teller/momo`, { headers: auth(player.token),
    data: { amount: 20, currency: "GHS", network: "MTN", account_number: "233" + player.phone.slice(1), idempotency_key: "deposit:blocked-" + Date.now() } });
  expect(dep.status()).toBe(403);
  expect((await dep.json()).message).toMatch(/blocked until/);
  expect((await login()).status(), "a blocked player can still sign in").toBe(200);
  await blockedRow.locator('[data-ac-act="unblock"]').click();
  await a.locator(".me-dialog [data-yes]").click();
  await expect(blockedRow).toHaveCount(0);

  /* ban: signed out at once, log-in refused */
  await act(a, "banned", player.phone, "ban", { reason: "Fraudulent chargebacks" });
  const bannedRow = a.locator('[data-panel="banned"] tbody tr', { hasText: player.phone });
  await expect(bannedRow).toContainText("Fraudulent chargebacks");
  if (SHOTS) await a.screenshot({ path: `${SHOTS}/admin-banned.png`, fullPage: true });
  expect((await request.get(`${API}/api/user/balances`, { headers: auth(player.token) })).status()).not.toBe(200);
  const refused = await login();
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error).toMatch(/banned/);
  await p.goto("/me.html");
  await expect.poll(() => p.evaluate(() => localStorage.getItem("voltabet.session") || sessionStorage.getItem("voltabet.session")), { timeout: 20_000 }).toBeNull();
  /* lift after review */
  await bannedRow.locator('[data-ac-act="lift_ban"]').click();
  await a.locator("#acf_reason").fill("Reviewed the bank statements: genuine");
  await a.locator(".me-dialog [data-yes]").click();
  await expect(bannedRow).toHaveCount(0);
  expect((await login()).status()).toBe(200);
  await expect(a.locator('[data-panel="banned"]')).toContainText("Ban lifted");

  /* delete: typed confirmation; records and balance kept; restore */
  await adminTab(a, "deleted");
  await a.locator('[data-ac-find="deleted"]').fill(player.phone);
  await a.locator('#acFound_deleted [data-ac-act="delete"]').first().click();
  await expect(a.locator(".me-dialog")).toContainText("Warning");
  await a.locator("#acf_reason").fill("Duplicate account");
  await a.locator("#acf_confirm").fill("delete");
  await a.locator(".me-dialog [data-yes]").click();
  await expect(a.locator(".me-dialog .adm-ask-err")).toContainText("DELETE");
  await a.locator("#acf_confirm").fill("DELETE");
  await a.locator(".me-dialog [data-yes]").click();
  const deletedRow = a.locator('[data-panel="deleted"] tbody tr', { hasText: player.phone });
  await expect(deletedRow).toContainText("Deleted");
  if (SHOTS) await a.screenshot({ path: `${SHOTS}/admin-deleted.png`, fullPage: true });
  expect((await login()).status()).toBe(403);
  await deletedRow.locator('[data-ac-act="restore"]').click();
  await a.locator(".me-dialog [data-yes]").click();
  await expect(deletedRow).toHaveCount(0);
  const back = await login();
  expect(back.status()).toBe(200);
  expect(await serverBalance(request, (await back.json()).token)).toBe(0);
  /* an admin can't be banned */
  const admins = await request.get(`${API}/api/admin/users?q=0209999001`, { headers: auth(adminToken) });
  const adminId = (await admins.json()).users[0].id;
  expect((await request.post(`${API}/api/admin/users/${adminId}/control`, { headers: auth(adminToken), data: { action: "ban", reason: "test test" } })).status()).toBe(409);
  expect(aErrors).toEqual([]);
});

test("Lotto Key: locked numbers after betting closes, PUBLISH RESULT, and the congratulations popup for players online", async ({ browser, request }) => {
  test.setTimeout(360_000);
  const adminToken = await adminSession(request);
  const before = (await (await request.get(`${API}/api/admin/lotto`, { headers: auth(adminToken) })).json()).settings;
  try {
    /* the draw taking bets closes about a minute from now */
    expect((await request.post(`${API}/api/admin/lotto/settings`, { headers: auth(adminToken),
      data: { draw_time: hhmm(Date.now() + 3 * 60e3), cutoff_min: 1 } })).status()).toBe(200);
    const open = (await (await request.get(`${API}/api/admin/lotto`, { headers: auth(adminToken) })).json()).draws.find((d: { status: string }) => d.status === "OPEN");
    expect(open.numbers, "nobody sees numbers while betting is open").toBeNull();
    await expect.poll(async () => (await (await request.get(`${API}/api/admin/lotto/key`, { headers: auth(adminToken) })).json()).pending
      .some((d: { id: number }) => d.id === open.id), { timeout: 240_000, intervals: [5_000] }).toBe(true);

    /* a player already on the site */
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await wantPopups(p);
    const pErrors = trackErrors(p);
    await p.goto("/index.html");
    await settle(p);
    await p.waitForTimeout(4000); /* the popup only follows a publication */

    const a = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await adminSession(request, a);
    await a.goto("/admin.html");
    await settle(a);
    await adminTab(a, "lotto");
    const key = a.locator("#ltaKey .lta-key-draw", { hasText: "Draw #" + open.id });
    await expect(key.locator(".lta-key-ball")).toHaveCount(5);
    await expect(key).toContainText("Numbers locked");
    const numbers = (await key.locator(".lta-key-ball").allInnerTexts()).map(Number);
    if (SHOTS) await a.screenshot({ path: `${SHOTS}/admin-lotto-key.png`, fullPage: true });
    expect((await (await request.get(`${API}/api/games/lotto/latest-result`)).json()).result?.id ?? 0).not.toBe(open.id);
    await key.locator(".lta-publish").click();
    await a.locator(".me-dialog [data-yes]").click();
    await expect(a.locator("#msg")).toContainText("released", { timeout: 20_000 });
    await expect(a.locator("#ltaKey")).toContainText("Published");

    /* the player sees it within about 30 seconds */
    const pop = p.locator(".wbc-wrap");
    await expect(pop).toBeVisible({ timeout: 45_000 });
    await expect(pop.locator(".wbc-title")).toContainText("CONGRATULATIONS");
    await expect(pop.locator(".wbc-ball")).toHaveCount(5);
    expect((await pop.locator(".wbc-ball").allInnerTexts()).map(Number)).toEqual(numbers);
    await expect(pop.locator(".wbc-stake")).toHaveText("STAKE LOTTO");
    await p.waitForTimeout(1600);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/congrats-phone.png` });
    await pop.locator(".wbc-stake").click();
    await expect(p).toHaveURL(/lotto\.html/);
    /* once per draw */
    await p.goto("/index.html");
    await p.waitForTimeout(5000);
    await expect(p.locator(".wbc-wrap")).toHaveCount(0);
    expect(pErrors).toEqual([]);
  } finally {
    await request.post(`${API}/api/admin/lotto/settings`, { headers: auth(adminToken), data: { draw_time: before.draw_time, cutoff_min: before.cutoff_min } });
  }
});

test("promotions follow the schedule (5 min, 1 h, 2 min, 5 min, 1 h, 3 min, again), Lotto most often, never during play, and can be muted", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  const errors = trackErrors(page);
  await wantPopups(page);
  await page.clock.install();
  await page.goto("/index.html");
  await settle(page);
  const promo = page.locator(".wbp-card");
  const shown: string[] = [];
  type S = { step: number; nextAt: number; last?: { at: number } };
  const st = () => page.evaluate(() => ({ s: (window as unknown as { WinBPromos: { state(): unknown } }).WinBPromos.state(), now: Date.now() })) as Promise<{ s: S; now: number }>;
  const first = await st();
  let prevAt = first.s.nextAt - 5 * 60e3; /* the visitor arrived */
  const next = async (minutes: number) => {
    const { s, now } = await st();
    expect(s.nextAt - prevAt, `the gap before this popup is ${minutes} min`).toBe(minutes * 60e3);
    await page.clock.runFor(Math.max(0, s.nextAt - now - 15e3));
    await expect(promo, `nothing before ${minutes} min`).toHaveCount(0);
    await page.clock.runFor(25e3);
    await expect(promo).toBeVisible();
    await expect(promo.locator("img")).toBeVisible();
    await expect(promo.locator(".wbp-cta")).toHaveAttribute("href", /\.html$/);
    shown.push((await promo.getAttribute("data-game"))!);
    prevAt = (await st()).s.last!.at;
    if (SHOTS && shown.length <= 2) await page.screenshot({ path: `${SHOTS}/promo-${shown.length}.png` });
    await promo.locator("[data-wbp-close]").click();
    await expect(promo).toHaveCount(0);
  };
  for (const gap of [5, 60, 2, 5, 60, 3, 5]) await next(gap);
  expect(shown.filter((g) => g === "lotto").length, shown.join(",")).toBe(4);
  expect([shown[0], shown[2], shown[4], shown[6]]).toEqual(["lotto", "lotto", "lotto", "lotto"]);
  expect(new Set([shown[1], shown[3], shown[5]]).size, "other games take turns").toBe(3);

  /* a game page never shows one, even when it's due; the next page does */
  await page.evaluate(() => { /* make the next one overdue */
    const s = JSON.parse(localStorage.getItem("winb.promos.v1")!);
    localStorage.setItem("winb.promos.v1", JSON.stringify({ ...s, nextAt: Date.now() - 1000 }));
  });
  await page.goto("/aviator.html");
  await page.clock.runFor(40e3);
  await expect(promo).toHaveCount(0);
  await page.goto("/games.html");
  await page.clock.runFor(30e3);
  await expect(promo).toBeVisible();

  /* phone layout, then mute */
  await page.setViewportSize({ width: 375, height: 760 });
  await page.waitForTimeout(900); /* the card settles into its phone place */
  const box = await promo.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/promo-phone.png` });
  await promo.locator("[data-wbp-mute]").click();
  await page.clock.runFor(3 * 3600e3);
  await expect(promo).toHaveCount(0);
  expect(errors).toEqual([]);
});
