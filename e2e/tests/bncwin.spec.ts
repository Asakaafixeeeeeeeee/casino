/* BNC WIN end to end, through the real page: the lobby lists it with its card; a funded player stakes, presses GO,
   sees the countdown and the race, cashes out once (a second press pays nothing more), the balance on screen matches
   the server, the race shows in the history with its seed, and the page fits a phone. E2E_SHOTS=<folder> saves
   screenshots. */
import { expect, test } from "@playwright/test";
import { API, fundedPlayer, serverBalance, settle, trackErrors } from "./helpers";

const SHOTS = process.env.E2E_SHOTS;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

test("BNC WIN: lobby card, GO, the race runs, CASH OUT pays once, history and balance agree", async ({ page, request }) => {
  test.setTimeout(180_000);
  const errors = trackErrors(page);
  const player = await fundedPlayer(page, 100);

  await page.goto("/games.html?category=Live%20Casino");
  await settle(page);
  const card = page.getByRole("link", { name: "BNC WIN — Live Casino" }).first();
  await expect(card).toBeVisible({ timeout: 20_000 });

  await page.goto("/bncwin.html");
  await settle(page);
  /* the 3D stadium and both athletes load */
  await expect(page.locator("#bnStage")).toHaveAttribute("data-three", "ready", { timeout: 60_000 });
  await expect(page.locator("#bnCommText")).toContainText("Welcome to BNC WIN Racing");
  await expect(page.locator("#bnRules")).toBeHidden();
  await page.locator("#bnStake").fill("20");
  await page.locator("#bnStake").dispatchEvent("change");
  await page.locator("#bnGo").click();
  await expect(page.locator("#bnCash")).toBeVisible({ timeout: 20_000 });
  expect(await serverBalance(request, player.token)).toBeCloseTo(80, 2);
  await expect(page.locator("#bnCount")).toBeVisible();
  await expect(page.locator("#bnHashRow")).toBeVisible();
  /* the race runs: steps come in */
  await expect(page.locator("#bnStatus")).toHaveText(/leads|Neck|off|broke|Red won/i, { timeout: 15_000 });
  /* the commentary follows the race and the broadcast graphics show the money */
  await expect(page.locator("#bnCommText")).not.toContainText("Welcome", { timeout: 15_000 });
  await expect(page.locator("#bnStakeShow")).toHaveText("GHS 20.00");
  await page.waitForTimeout(2500);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/bnc-race-phone.png` });

  const state = await (await request.get(`${API}/api/games/bnc-win/state`, { headers: auth(player.token) })).json();
  if (state.race) {
    const [resp] = await Promise.all([page.waitForResponse((r) => r.url().includes("/bnc-win/race/cashout")), page.locator("#bnCash").click()]);
    expect(resp.status(), await resp.text()).toBe(200);
    await expect(page.locator("#bnResult")).toBeVisible({ timeout: 15_000 });
  } else {
    await expect(page.locator("#bnResult")).toBeVisible({ timeout: 15_000 }); /* red broke away early */
  }
  await expect(page.locator("#bnGo")).toBeVisible();
  const after = await (await request.get(`${API}/api/games/bnc-win/state`, { headers: auth(player.token) })).json();
  expect(after.race).toBeNull();
  const last = after.history[0];
  expect(["CASHED", "BUSTED", "FINISHED"]).toContain(last.status);
  expect(await serverBalance(request, player.token)).toBeCloseTo(80 + last.payout, 2);
  /* a second cash-out pays nothing more */
  const again = await request.post(`${API}/api/games/bnc-win/race/cashout`, { headers: auth(player.token), data: { race_id: last.race_id, idempotency_key: "bnc-again-" + Date.now() } });
  expect(again.status()).toBe(200);
  expect(await serverBalance(request, player.token)).toBeCloseTo(80 + last.payout, 2);
  await expect(page.locator("[data-wallet-balance-num]").first()).toHaveText((80 + last.payout).toFixed(2), { timeout: 15_000 });
  await expect(page.locator("#bnHistory .bn-row")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator("#bnHistory .bn-row code")).toContainText(String(last.seed).slice(0, 16));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/bnc-after-phone.png`, fullPage: true });

  /* the rules dialog explains the maths */
  await page.locator("#bnRulesBtn").click();
  await expect(page.locator("#bnRules")).toContainText("Return to player: 97%");
  await expect(page.locator("#bnRules")).toContainText("stake × 97% × race score");
  expect(errors).toEqual([]);
});

test("BNC WIN looks right on a computer mid-race", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  const errors = trackErrors(page);
  await fundedPlayer(page, 50);
  await page.goto("/bncwin.html");
  await settle(page);
  await expect(page.locator("#bnStage")).toHaveAttribute("data-three", "ready", { timeout: 60_000 });
  await page.locator("#bnGo").click();
  await page.waitForTimeout(6500);
  await expect(page.locator("#bnCam")).toContainText("CAM");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/bnc-race-desktop.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});
