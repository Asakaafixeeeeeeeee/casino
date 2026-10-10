/* Partners earn a set percentage of every deposit their players make (no revenue share, no CPA). A player who signs
   up through a partner's link deposits through the payment gateway; the partner page and the admin's partner page then
   show that player's money and the partner's commission, and a new rate set by an admin applies at once. */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { adminSession, adminTab, amountIn, API, deposit, register, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** The number in a KPI tile, found by its label. */
const kpi = (page: Page, label: string) =>
  page.locator(".adm-kpi", { has: page.locator("span", { hasText: new RegExp("^" + label + "$") }) }).locator("strong");
const mini = (root: Locator, label: string) =>
  root.locator(".adm-mini", { has: root.page().locator("span", { hasText: new RegExp("^" + label + "$") }) }).locator("b");

test("a partner earns their % of every deposit, and the partner and admin pages show their players' money", async ({ browser, page, request }) => {
  test.setTimeout(240_000);
  const adminCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const admin = { page: await adminCtx.newPage(), token: "" };
  admin.token = await adminSession(request, admin.page);
  const errors = trackErrors(page);

  /* the partner applies; the admin approves them at 10% of deposits */
  const partner = await register(page);
  const applied = await request.post(`${API}/api/partners/apply`, {
    headers: auth(partner.token), data: { channel: "My football WhatsApp group (2,000 members)" },
  });
  expect(applied.status()).toBe(200);
  const { code, deposit_pct } = (await applied.json()).partner;
  expect(deposit_pct, "every partner starts at 5%").toBe(5);
  const pending = await (await request.get(`${API}/api/admin/partners?status=PENDING`, { headers: auth(admin.token) })).json();
  const row = pending.partners.find((p: { code: string }) => p.code === code);
  const approved = await request.post(`${API}/api/admin/partners/${row.user_id}`, {
    headers: auth(admin.token), data: { status: "ACTIVE", deposit_pct: 10 },
  });
  expect(approved.status()).toBe(200);

  /* a new player opens the partner's link, signs up and deposits GHS 100 */
  const playerCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const player = await playerCtx.newPage();
  await player.goto(`/index.html?ref=${code}&sub=whatsapp`);
  await settle(player);
  await register(player);
  await expect.poll(async () => (await (await request.get(`${API}/api/partners/referrals`, { headers: auth(partner.token) })).json()).referrals.length,
    { timeout: 20_000 }).toBe(1);
  await deposit(player, 100);
  await expect(player.locator("#msg")).toContainText("successful", { timeout: 30_000 });

  /* the partner sees the deposit and 10% of it */
  await page.goto("/partners.html");
  await settle(page);
  await expect(page.locator(".prt-terms")).toHaveText("You earn 10% of every deposit your players make");
  await expect.poll(async () => amountIn(await kpi(page, "Earned").textContent() || ""), { timeout: 20_000 }).toBe(10);
  expect(amountIn(await kpi(page, "Deposits").textContent() || "")).toBe(100);
  expect(amountIn(await kpi(page, "Available").textContent() || "")).toBe(10);
  await expect(page.locator(".prt-feed")).toContainText("you earn");
  await expect(page.locator("#prtPlayers tbody tr").first()).toContainText("whatsapp");
  await expect(page.locator("body")).not.toContainText(/RevShare|net revenue|CPA/i);
  await page.screenshot({ path: test.info().outputPath("partner-page.png"), fullPage: true });

  /* the admin sees the partner's rate and money, and raises the rate to 20% */
  const a = admin.page;
  await a.goto("/admin.html");
  await settle(a);
  await adminTab(a, "partners");
  await a.locator('[data-chips="pview"] [data-v="ACTIVE"]').click();
  const listRow = a.locator("[data-partner]", { hasText: code });
  await expect(listRow).toContainText("10% of every deposit");
  await expect(listRow).toContainText(/deposits [^·]*100\.00/);
  await expect(listRow).toContainText(/earned [^·]*10\.00/);
  await listRow.click();
  const sheet = a.locator(".adm-sheet");
  await expect(sheet).toContainText("Their players' money");
  expect(amountIn(await mini(sheet, "Deposits").textContent() || "")).toBe(100);
  expect(amountIn(await mini(sheet, "Earned").textContent() || "")).toBe(10);
  await expect(sheet).not.toContainText(/RevShare|net revenue|CPA/i);
  await a.screenshot({ path: test.info().outputPath("admin-partner.png"), fullPage: false });
  await sheet.locator("#tPct").fill("20");
  await sheet.locator("form[data-form=terms] button[type=submit]").click();
  await expect.poll(async () => amountIn(await mini(sheet, "Earned").textContent() || ""), { timeout: 15_000 }).toBe(20);

  /* the new rate shows on the partner's page too */
  await page.reload();
  await settle(page);
  await expect(page.locator(".prt-terms")).toHaveText("You earn 20% of every deposit your players make");
  await expect.poll(async () => amountIn(await kpi(page, "Earned").textContent() || ""), { timeout: 20_000 }).toBe(20);
  expect(errors, "no uncaught errors on the partner page").toEqual([]);
});
