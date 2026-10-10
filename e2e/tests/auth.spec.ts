/* Sessions and access: sign-up, log-out, log-in, password reset, and what the services refuse. */
import { expect, test } from "@playwright/test";
import { ACCOUNTS, API, PASSWORD, login, newPhone, register, sessionToken, settle } from "./helpers";

const me = (request: import("@playwright/test").APIRequestContext, token: string) =>
  request.get(`${ACCOUNTS}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
const balances = (request: import("@playwright/test").APIRequestContext, token?: string) =>
  request.get(`${API}/api/user/balances`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test("sign-up asks for the player's full name and keeps it", async ({ page, request }) => {
  await page.goto("/register.html");
  await page.locator("#country").selectOption("GH");
  await page.locator("#phone").fill(newPhone());
  await page.locator("#pw").fill(PASSWORD);
  await page.locator("#age").fill("1990-05-17");
  await page.locator("#terms").check();
  await page.locator("#regBtn").click();
  await expect(page.locator("#fullNameErr")).toHaveText("Enter your full name.");
  await expect(page.locator("#fullName")).toBeFocused();
  await page.locator("#fullName").fill("Kwame");
  await page.locator("#regBtn").click();
  await expect(page.locator("#fullNameErr")).toHaveText("Enter your first and last name.");
  await page.locator("#fullName").fill("  Kwame   Asante-Boateng ");
  await page.locator("#regBtn").click();
  await page.waitForURL(/index\.html$/);
  const token = await sessionToken(page);
  expect((await (await me(request, token as string)).json()).user.full_name).toBe("Kwame Asante-Boateng");
  /* and the server says the same to anything that skips the form */
  const bare = await request.post(`${ACCOUNTS}/api/register`, { data: { phone: newPhone(), password: PASSWORD, dob: "1990-05-17", country: "GH", currency: "GHS", full_name: "Kwame 4ever" } });
  expect(bare.status()).toBe(400);
  expect((await bare.json()).field).toBe("fullName");
});

test("log-out revokes the session on both services, and log-in issues a fresh one", async ({ page, request }) => {
  const { phone, token } = await register(page);
  expect((await me(request, token)).status()).toBe(200);
  expect((await balances(request, token)).status()).toBe(200);

  await page.goto("/index.html");
  await settle(page);
  await page.locator("[data-logout]").first().click();
  await expect.poll(() => sessionToken(page)).toBeNull();
  /* the old token is dead everywhere, not just forgotten by this browser */
  await expect.poll(async () => (await me(request, token)).status()).toBe(401);
  expect((await balances(request, token)).status()).toBe(401);

  await login(page, phone);
  await page.waitForURL(/index\.html$/);
  const fresh = await sessionToken(page);
  expect(fresh).toBeTruthy();
  expect(fresh).not.toBe(token);
  expect((await balances(request, fresh as string)).status()).toBe(200);
});

test("a wrong password is refused and leaves the player signed out", async ({ page }) => {
  const { phone } = await register(page);
  await page.goto("/index.html");
  await settle(page);
  await page.locator("[data-logout]").first().click();
  await expect.poll(() => sessionToken(page)).toBeNull();

  await login(page, phone, PASSWORD + "-wrong");
  await expect(page.locator("#lpwErr, #formMsg").filter({ hasText: /./ }).first()).toBeVisible();
  expect(await sessionToken(page)).toBeNull();
  await expect(page).toHaveURL(/register\.html/);
});

test("a password reset from another device signs every device out", async ({ page, request, browser }) => {
  const { phone, token } = await register(page);
  const other = await browser.newContext({ baseURL: "http://localhost:8808", viewport: { width: 420, height: 900 } });
  const device = await other.newPage();
  await device.goto("/register.html#forgot");
  await device.locator("#fphone").fill(phone);
  await device.locator("#fdob").fill("1990-05-17");
  await device.locator("#fpw").fill("An0ther-secret!");
  await device.locator("#forgotBtn").click();
  await expect.poll(async () => (await me(request, token)).status()).toBe(401);
  await login(device, phone, "An0ther-secret!");
  await device.waitForURL(/index\.html$/);
  expect(await sessionToken(device)).toBeTruthy();
  await other.close();
});

test("the balance service refuses anonymous, forged and non-admin access", async ({ page, request }) => {
  expect((await balances(request)).status()).toBe(401);
  expect((await balances(request, "not-a-real-token-0123456789")).status()).toBe(401);
  const anonymousWithdraw = await request.post(`${API}/api/user/withdraw`, { data: { amount: 20, idempotency_key: "anon-withdraw-1" } });
  expect(anonymousWithdraw.status()).toBe(401);

  const { token } = await register(page);
  const asPlayer = { headers: { Authorization: `Bearer ${token}` } };
  for (const path of ["/api/admin/overview", "/api/admin/users", "/api/admin/withdrawals", "/api/admin/mines/signals"]) {
    const r = await request.get(API + path, asPlayer);
    expect(r.status(), `${path} is admin-only`).toBe(403);
  }
});
