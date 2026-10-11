/* The partner platform, end to end through the real screens: an admin creates a partner who never registered, the
   partner logs in (with their username) and lands on their dashboard, their link brings in a player, they deposit
   into their own wallet, the admin's feature switches are enforced by the server, game tools show real odds only,
   the flyer generator prints the partner's own promo code and a QR code of their own link, and a suspended
   partner loses the restricted features. */
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import { adminSession, adminTab, API, deposit, newPhone, register, settle, trackErrors } from "./helpers";

const require = createRequire(import.meta.url);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

test("admin creates a partner from scratch → login → dashboard, referrals, wallet, permissions, tools, flyers, suspension", async ({ browser, request }) => {
  test.setTimeout(360_000);
  const adminCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const a = await adminCtx.newPage();
  const adminToken = await adminSession(request, a);
  const stamp = String(Date.now()).slice(-6);
  const code = "JN" + stamp;
  const promo = "JOHN" + stamp;
  const username = "John" + stamp;
  const phone = newPhone();
  const password = "Partner-pass-" + stamp;

  /* 1. the admin creates the partner: no player account exists for this number */
  await a.goto("/admin.html");
  await settle(a);
  await adminTab(a, "partners");
  await a.locator("[data-add-partner]").click();
  const form = a.locator('form[data-form="pcreate"]');
  await form.locator("#pcName").fill("John Mensah");
  await form.locator("#pcPhone").fill(phone);
  await form.locator("#pcDob").fill("1990-04-12");
  await form.locator("#pcEmail").fill(`john${stamp}@example.com`);
  await form.locator("#pcUser").fill(username);
  await form.locator("#pcPass").fill(password);
  await form.locator("#pcPct").fill("30");
  await form.locator("#pcCode").fill(code);
  await form.locator("#pcPromo").fill(promo);
  await form.locator("button[type=submit]").click();
  const summary = a.locator("[data-pc-summary]");
  await expect(summary).toContainText(`/?ref=${code}`);
  await expect(summary).toContainText(promo);
  await expect(summary.locator(".adm-pc-pass")).toContainText(password);

  /* 2. the partner logs in on the normal page with their username, and lands on their partner dashboard */
  const pCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const p = await pCtx.newPage();
  const errors = trackErrors(p);
  await p.goto("/register.html#login");
  await p.locator("#lphone").fill(username);
  await p.locator("#lpw").fill(password);
  await p.locator("#loginBtn").click();
  await p.waitForURL(/partners\.html/, { timeout: 30_000 });
  await settle(p);
  await expect(p.locator('[data-tab="dashboard"]')).toBeVisible();
  await expect(p.locator("#lnk")).toHaveValue(new RegExp(`/\\?ref=${code}$`));
  await expect(p.locator(".prt-idrow")).toContainText(promo);
  await expect(p.locator(".prt-idrow")).toContainText("30%");
  const token = await p.evaluate(() => JSON.parse(localStorage.getItem("voltabet.session") || sessionStorage.getItem("voltabet.session") || "{}").token);

  /* 3. a visitor through the link registers: they're this partner's */
  const vCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const v = await vCtx.newPage();
  await v.goto(`/?ref=${code}`);
  await settle(v);
  await register(v);
  await expect.poll(async () => (await (await request.get(`${API}/api/partners/referrals?range=all`, { headers: auth(token) })).json()).referrals.length,
    { timeout: 20_000 }).toBe(1);

  /* 4. the partner deposits into their own wallet; the Wallet tab shows it as successful */
  await deposit(p, 50);
  await expect(p.locator("#msg")).toContainText("successful", { timeout: 30_000 });
  await p.goto("/partners.html#wallet");
  await settle(p);
  await expect(p.locator("#prtTx")).toContainText(/Success/i);
  await expect(p.locator("body")).toContainText("Commission and deposited money are kept apart");

  /* 5. feature switches: switched off for this partner, the server refuses it and the tab disappears */
  const me = (await (await request.get(`${API}/api/admin/partners?status=ACTIVE&q=${code}`, { headers: auth(adminToken) })).json()).partners[0];
  const setPerm = async (perms: Record<string, boolean | null>) => expect((await request.post(`${API}/api/admin/partners/${me.user_id}/permissions`,
    { headers: auth(adminToken), data: { permissions: perms } })).status()).toBe(200);
  await setPerm({ flyers: false });
  const off = await request.get(`${API}/api/partners/flyers`, { headers: auth(token) });
  expect([off.status(), (await off.json()).error]).toEqual([403, "feature_off"]);
  /* the Promo materials tab keeps the ready-made banners; the flyer generator inside it is refused */
  await p.goto("/partners.html#promo");
  await settle(p);
  await expect(p.locator("#prtView")).toContainText(/switched off/i);
  await expect(p.locator(".fly-preview canvas")).toHaveCount(0);
  await setPerm({ flyers: null });

  /* 6. game tools: only what the admin switched on; real odds and finished rounds, with the limits spelled out */
  expect((await request.get(`${API}/api/partners/tools/mines`, { headers: auth(token) })).status()).toBe(403);
  await setPerm({ tools_mines: true });
  expect((await request.get(`${API}/api/partners/tools/aviator`, { headers: auth(token) })).status()).toBe(403);
  await p.goto("/partners.html?fresh=tools#tools");
  await settle(p);
  await expect(p.locator("#prtView")).toContainText("Mines Predictor");
  await expect(p.locator("#prtView")).toContainText(/can see or predict it in advance/);

  /* 7. flyers: the partner's own promo code, and a QR code that opens their own link; download works */
  await p.goto("/partners.html?fresh=promo#promo");
  await settle(p);
  const canvas = p.locator(".fly-preview canvas.fly-canvas");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect(p.locator("#prtView")).toContainText(promo);
  await p.waitForTimeout(1500);
  await p.addScriptTag({ path: require.resolve("jsqr/dist/jsQR.js") });
  const decoded = await p.evaluate(() => {
    const c = document.querySelector(".fly-preview canvas.fly-canvas") as HTMLCanvasElement;
    const img = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    const r = (window as unknown as { jsQR: (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null }).jsQR(img.data, c.width, c.height);
    return r && r.data;
  });
  expect(decoded).toBe(`http://localhost:8808/?ref=${code}&promo=${promo}`);
  const [dl] = await Promise.all([p.waitForEvent("download"), p.locator('[data-act="png"]').first().click()]);
  expect(dl.suggestedFilename()).toMatch(/^winb-.+\.png$/);
  const flyerData = await (await request.get(`${API}/api/partners/flyers`, { headers: auth(token) })).json();
  expect([flyerData.partner.code, flyerData.partner.promo_code]).toEqual([code, promo]);
  expect(flyerData.templates.length).toBeGreaterThanOrEqual(17);

  /* 8. suspended: figures stay readable, restricted features are refused by the server */
  expect((await request.post(`${API}/api/admin/partners/${me.user_id}`, { headers: auth(adminToken), data: { status: "SUSPENDED" } })).status()).toBe(200);
  expect((await request.get(`${API}/api/partners/summary`, { headers: auth(token) })).status()).toBe(200);
  for (const path of ["/flyers", "/tools/mines"]) {
    expect((await request.get(`${API}/api/partners${path}`, { headers: auth(token) })).status(), path).toBe(403);
  }
  expect((await request.post(`${API}/api/partners/payouts`, { headers: auth(token), data: { amount: 60, method: "MOMO", details: { phone, name: "John" } } })).status()).toBe(403);
  expect((await request.post(`${API}/api/partners/settings/promo`, { headers: auth(token), data: { promo_code: "NEWCODE1" } })).status()).toBe(403);
  await p.goto("/partners.html");
  await settle(p);
  await expect(p.locator(".prt-notice")).toContainText("suspended");
  expect(errors, "no uncaught errors on the partner pages").toEqual([]);
});
