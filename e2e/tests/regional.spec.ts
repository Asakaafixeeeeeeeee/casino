/* The Ghana Regional Admin: made by a full admin on the admin page (PIN shown once), signs in on regional.html with a
   username and 6-digit PIN, and sees Ghana players' payments and revenue only. Its sign-in opens nothing else, and a
   player's or full admin's sign-in opens nothing of its. */
import { expect, test } from "@playwright/test";
import { ACCOUNTS, adminSession, adminTab, API, deposit, newPhone, PASSWORD, register, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

test("a Ghana admin sees only Ghana's payments and revenue, and their sign-in opens nothing else", async ({ browser, page, request }) => {
  test.setTimeout(240_000);

  /* a Ghana player deposits GHS 100 through the gateway */
  const ghana = await register(page);
  const ghanaUsername = await page.evaluate(() => JSON.parse(localStorage.getItem("voltabet.session") || "{}").name as string);
  expect(ghanaUsername, "a new player has a username").toMatch(/^\w{4,16}$/);
  await deposit(page, 100);
  await expect(page.locator("#msg")).toContainText("successful", { timeout: 30_000 });
  const ghanaDeposits = await (await request.get(`${API}/api/payments/teller/deposits`, { headers: auth(ghana.token) })).json();
  const ghanaRef = ghanaDeposits.deposits[0].reference as string;
  expect(ghanaRef).toMatch(/^DES\d{12}$/);

  /* a Nigerian player deposits GHS 150 (paid from a Ghanaian wallet) */
  const ng = await request.post(`${ACCOUNTS}/api/register`, {
    data: { country: "NG", phone: "80" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"), password: PASSWORD, dob: "1991-02-03", currency: "GHS", full_name: "Chidi Okafor" },
  });
  expect(ng.status()).toBe(201);
  const ngToken = (await ng.json()).token as string;
  const ngPay = await request.post(`${API}/api/payments/teller/momo`, {
    headers: auth(ngToken),
    data: { amount: 150, currency: "GHS", network: "MTN", account_number: "233" + newPhone().slice(1), idempotency_key: "rg-ng-" + Date.now() },
  });
  expect(ngPay.status()).toBe(202);
  const ngRef = (await ngPay.json()).reference as string;

  /* the full admin makes the Ghana admin on the admin page; the PIN shows once */
  const adminCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const admin = await adminCtx.newPage();
  const adminToken = await adminSession(request, admin);
  await admin.goto("/admin.html");
  await settle(admin);
  await adminTab(admin, "regional");
  const username = "gh" + Date.now().toString(36);
  await admin.locator("#rgNewUser").fill(username);
  await admin.locator("#rgNewName").fill("Kofi Mensah");
  await admin.locator('form[data-form="regional"] button[type=submit]').click();
  const pinBox = admin.locator('.adm-sheet [aria-label="PIN"]');
  await expect(pinBox).toHaveText(/^\d{6}$/);
  const pin = (await pinBox.textContent())!.trim();
  await admin.screenshot({ path: test.info().outputPath("admin-pin-once.png") });
  await admin.locator(".adm-sheet [data-close]").click();
  await expect(admin.locator('[data-panel="regional"]')).toContainText(username);
  await admin.screenshot({ path: test.info().outputPath("admin-ghana-admins.png"), fullPage: true });

  /* the Ghana admin signs in with the PIN: three revenue figures and Ghana's payments only */
  const rgCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const rg = await rgCtx.newPage();
  const errors = trackErrors(rg);
  await rg.goto("/regional.html");
  await rg.locator("#rgUser").fill(username);
  await rg.locator("#rgPin").fill(pin === "204918" ? "730561" : "204918");
  await rg.locator("#rgSubmit").click();
  await expect(rg.locator("#rgMsg")).toContainText("Wrong username or PIN");
  await rg.locator("#rgPin").fill(pin);
  await rg.locator("#rgSubmit").click();
  await expect(rg.locator("#rgDash")).toBeVisible();
  await expect(rg.locator("#rgWho")).toContainText("Kofi Mensah");
  await expect(rg.locator("#rgKpis .adm-kpi")).toHaveCount(3);
  await expect(rg.locator("#rgKpis")).toContainText("Ghana revenue · all time");
  await expect(rg.locator("#rgKpis")).toContainText("10% of today's revenue");
  await expect(rg.locator("#rgRows")).toContainText(ghanaRef);
  await expect(rg.locator("#rgRows")).not.toContainText(ngRef);
  await expect(rg.locator("#rgRows tr", { hasText: ghanaRef })).toContainText("Successful");
  await expect(rg.locator("#rgRows tr", { hasText: ghanaRef })).toContainText("MTN MoMo");
  /* every row names its player (the full name from sign-up, with their username under it), under the columns asked for */
  await expect(rg.locator(".rg-table thead th")).toHaveText(["User name", "User ID", "Amount", "Payment method", "Transaction ID", "Timestamp", "Status"]);
  await expect(rg.locator("#rgRows tr", { hasText: ghanaRef }).locator('[data-label="User name"] b')).toHaveText(ghana.fullName);
  await expect(rg.locator("#rgRows tr", { hasText: ghanaRef }).locator('[data-label="User name"]')).toContainText(ghanaUsername);
  await rg.screenshot({ path: test.info().outputPath("ghana-dashboard.png"), fullPage: true });
  await rg.locator('#rgStatus [data-v="failed"]').click();
  await expect(rg.locator("#rgRows")).not.toContainText(ghanaRef);
  await rg.locator('#rgStatus [data-v="successful"]').click();
  await expect(rg.locator("#rgRows")).toContainText(ghanaRef);

  /* the same, straight from the API */
  const rgToken = await rg.evaluate(() => JSON.parse(sessionStorage.getItem("rendowin.regional.session") || "{}").token as string);
  const list = await (await request.get(`${API}/api/regional/transactions?status=all`, { headers: auth(rgToken) })).json();
  const refs = list.transactions.map((t: { transaction_id: string }) => t.transaction_id);
  expect(refs).toContain(ghanaRef);
  expect(refs).not.toContain(ngRef);
  const mine = list.transactions.find((t: { transaction_id: string }) => t.transaction_id === ghanaRef);
  expect([mine.user.full_name, mine.user.username]).toEqual([ghana.fullName, ghanaUsername]);
  await expect(rg.locator("#rgRows tr", { hasText: ghanaRef }).locator('[data-label="User ID"]')).toHaveText(mine.user.id);
  /* the table fits a phone (as cards) and a computer screen */
  for (const width of [375, 1366]) {
    await rg.setViewportSize({ width, height: 860 });
    const sideways = await rg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways, `the dashboard fits a ${width}px screen`).toBeLessThanOrEqual(1);
    await rg.screenshot({ path: test.info().outputPath(`ghana-dashboard-${width}.png`), fullPage: true });
  }
  await rg.setViewportSize({ width: 420, height: 900 });
  const summary = await (await request.get(`${API}/api/regional/summary`, { headers: auth(rgToken) })).json();
  expect(summary.region).toBe("GH");
  expect(Object.keys(summary.revenue).sort()).toEqual(["all_time", "bets_today", "today", "today_10pct"]);

  /* its sign-in opens nothing outside the regional API; nobody else's opens the regional API */
  for (const path of ["/api/admin/overview", "/api/admin/users", "/api/admin/regional-admins", "/api/user/balances"]) {
    const r = await request.get(API + path, { headers: auth(rgToken) });
    expect([401, 403], `${path} with a Ghana admin's sign-in`).toContain(r.status());
  }
  for (const token of [ghana.token, adminToken, ""]) {
    const r = await request.get(`${API}/api/regional/summary`, { headers: token ? auth(token) : {} });
    expect(r.status(), "the regional API refuses any other sign-in").toBe(401);
  }

  /* signing out ends it; so does the full admin switching the account off */
  await rg.locator("#rgLogout").click();
  await expect(rg.locator("#rgLogin")).toBeVisible();
  expect((await request.get(`${API}/api/regional/summary`, { headers: auth(rgToken) })).status()).toBe(401);
  const again = await request.post(`${API}/api/regional/login`, { data: { username, pin } });
  expect(again.status()).toBe(200);
  const token2 = (await again.json()).token as string;
  const admins = await (await request.get(`${API}/api/admin/regional-admins`, { headers: auth(adminToken) })).json();
  const me = admins.admins.find((a: { username: string }) => a.username === username);
  expect((await request.post(`${API}/api/admin/regional-admins/${me.id}/status`, { headers: auth(adminToken), data: { status: "DISABLED" } })).status()).toBe(200);
  expect((await request.get(`${API}/api/regional/summary`, { headers: auth(token2) })).status()).toBe(401);
  expect(errors).toEqual([]);
});
