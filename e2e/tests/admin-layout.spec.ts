/* The admin page, arranged: its sections sit in a grouped menu (a sidebar on a computer, a menu that slides in on a
   phone), each opens under its own title, nothing is wider than the screen, and the players' bottom bar stays away.
   "Add money to a player" opens in a sheet from the Overview's title and credits the player once confirmed. */
import { expect, test } from "@playwright/test";
import { ACCOUNTS, adminSession, adminTab, newPhone, PASSWORD, serverBalance, settle, trackErrors } from "./helpers";

const SECTIONS: [string, string][] = [
  ["overview", "Overview"], ["players", "Players"], ["money", "Money"], ["withdrawals", "Withdrawals"], ["games", "Games"],
  ["mines", "Mines Signal"], ["partners", "Partners"], ["regional", "Ghana admins"], ["support", "Support"],
];

for (const vp of [{ name: "phone", width: 375, height: 812 }, { name: "desktop", width: 1366, height: 860 }]) {
  test(`every admin section opens from the menu at ${vp.name} width`, async ({ browser, request }) => {
    test.setTimeout(120_000);
    const phone = vp.name === "phone";
    const ctx = await browser.newContext({ baseURL: "http://localhost:8808", viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const errors = trackErrors(page);
    await adminSession(request, page);
    await page.goto("/admin.html");
    await settle(page);
    await page.locator("body.adm-ready").waitFor();
    await expect(page.locator(".bottom-nav")).toBeHidden();
    await expect(page.locator("#admMenuBtn")).toBeVisible({ visible: phone });
    await expect(page.locator("#admTabs"), phone ? "the menu waits behind its button" : "the sidebar is always there").toBeVisible({ visible: !phone });

    for (const [tab, title] of SECTIONS) {
      await adminTab(page, tab);
      await expect(page.locator("#admTitle")).toHaveText(title);
      await expect(page.locator(`[data-panel="${tab}"]`)).toBeVisible();
      await expect(page.locator(`#admTabs [data-tab="${tab}"]`)).toHaveAttribute("aria-current", "page");
      if (phone) await expect(page.locator("#admTabs"), "the menu closes once a section is chosen").toBeHidden();
      await page.waitForTimeout(400);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways, `${title} is no wider than the screen`).toBeLessThanOrEqual(1);
    }

    await adminTab(page, "overview");
    await expect(page.locator("#ovAttn")).toContainText("Needs your attention");
    await page.screenshot({ path: test.info().outputPath(`admin-${vp.name}.png`), fullPage: true });
    if (phone) {
      await page.locator("#admMenuBtn").click();
      await expect(page.locator("#admTabs")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("admin-phone-menu.png") });
      await page.keyboard.press("Escape");
      await expect(page.locator("#admTabs")).toBeHidden();
    }
    expect(errors).toEqual([]);
    await ctx.close();
  });
}

test("Add money opens in a sheet: a wrong number is told there, a right one is credited once", async ({ browser, request }) => {
  test.setTimeout(120_000);
  /* a player the balance service has seen */
  const number = newPhone();
  const reg = await request.post(`${ACCOUNTS}/api/register`, { data: { phone: number, password: PASSWORD, dob: "1992-04-05", country: "GH", currency: "GHS", full_name: "Efua Darko" } });
  expect(reg.status()).toBe(201);
  const player = (await reg.json()).token as string;
  const balance = () => serverBalance(request, player);
  expect(await balance()).toBe(0);

  const ctx = await browser.newContext({ baseURL: "http://localhost:8808", viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  const errors = trackErrors(page);
  await adminSession(request, page);
  await page.goto("/admin.html");
  await settle(page);
  await adminTab(page, "overview");
  await page.locator("#admActions [data-credit]").click();
  const sheet = page.locator(".adm-sheet");
  await expect(sheet.locator("#crPhone")).toBeFocused();

  /* nobody has this number: the sheet says so and stays open */
  let unknown = newPhone();
  while (unknown === number) unknown = newPhone();
  await sheet.locator("#crPhone").fill(unknown);
  await sheet.locator("#crAmt").fill("7");
  await sheet.locator("#crWhy").fill("Layout test goodwill credit");
  await sheet.locator("button[type=submit]").click();
  await expect(sheet.locator(".adm-sheet-msg")).toContainText("No player is registered with that number");

  /* the right number: confirm, and the money arrives once */
  await sheet.locator("#crPhone").fill(number);
  await sheet.locator("button[type=submit]").click();
  await expect(page.locator(".me-dialog"), "the confirmation names the player").toContainText("Efua Darko");
  await page.locator(".me-dialog [data-yes]").click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator("#msg")).toContainText("Added");
  expect(await balance()).toBe(7);
  expect(errors).toEqual([]);
  await ctx.close();
});
