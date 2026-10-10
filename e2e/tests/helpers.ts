/* Shared helpers for the end-to-end suite: players, sessions, balances and the payment gateway stub. */
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const API = "http://localhost:8781";        /* the balance service */
export const ACCOUNTS = "http://localhost:8792";   /* the accounts server */
export const GATEWAY = "http://127.0.0.1:8796";    /* the payment gateway stub */
export const PASSWORD = "Sup3r-secret!";

/** A fresh Ghanaian MTN number (024…) the gateway stub approves: never ending 0000 (declined) or 9999 (stalls). */
export function newPhone(): string {
  for (;;) {
    const tail = String(Math.floor(Math.random() * 1e7)).padStart(7, "0");
    if (!tail.endsWith("0000") && !tail.endsWith("9999")) return "024" + tail;
  }
}

/** Waits out a splash screen (the site's or a game's) so clicks land on the page. */
export async function settle(page: Page) {
  await page.waitForFunction(() => !document.documentElement.classList.contains("vb-splashing"), null, { timeout: 15_000 });
}

/** A believable full name for a new test player. */
export function newFullName(): string {
  const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)]!;
  return pick(["Ama", "Kofi", "Akosua", "Kwame", "Abena", "Yaw", "Efua", "Kojo"]) + " " +
    pick(["Mensah", "Owusu", "Boateng", "Asante", "Agyeman", "Appiah", "Darko", "Ofori"]);
}

/** Registers through the sign-up form and returns the player's number, full name and session token. */
export async function register(page: Page, opts: { phone?: string; currency?: "GHS" | "USD"; fullName?: string } = {}) {
  const phone = opts.phone ?? newPhone();
  const fullName = opts.fullName ?? newFullName();
  await page.goto("/register.html");
  await page.locator("#fullName").fill(fullName);
  await page.locator("#country").selectOption("GH");
  await page.locator("#phone").fill(phone);
  await page.locator("#pw").fill(PASSWORD);
  await page.locator("#age").fill("1990-05-17");
  await page.locator("#currency").selectOption(opts.currency ?? "GHS");
  await page.locator("#terms").check();
  await page.locator("#regBtn").click();
  await page.waitForURL(/index\.html$/);
  const token = await sessionToken(page);
  expect(token, "the sign-up form leaves the player signed in").toBeTruthy();
  return { phone, fullName, token: token as string };
}

/** The test admin: this number is in ADMIN_PHONES (playwright.config.ts). */
export const ADMIN_PHONE = "0209999001";

/** Signs the test admin in through the accounts server, registering the number the first time any test needs it —
 *  quick either way, so tests can run in any order. Given a page, that page is signed in as the admin too. */
export async function adminSession(request: APIRequestContext, page?: Page): Promise<string> {
  let r = await request.post(`${ACCOUNTS}/api/login`, { data: { phone: ADMIN_PHONE, password: PASSWORD, remember: true } });
  if (r.status() === 404) {
    r = await request.post(`${ACCOUNTS}/api/register`, {
      data: { phone: ADMIN_PHONE, password: PASSWORD, dob: "1990-05-17", country: "GH", currency: "GHS", full_name: "Test Admin" },
    });
  }
  expect(r.ok(), `the admin signs in (HTTP ${r.status()})`).toBe(true);
  const { token, user } = await r.json();
  if (page) {
    await page.goto("/terms.html");
    await page.evaluate((s) => localStorage.setItem("voltabet.session", JSON.stringify(s)),
      { phone: user.phone, name: user.username, token, currency: user.currency });
  }
  return token as string;
}

/** Opens a section of the admin page, once the page has let the admin in. On a phone the sections sit in a menu
 *  behind the menu button; on a computer they're a sidebar. */
export async function adminTab(page: Page, tab: string) {
  await page.locator("body.adm-ready").waitFor();
  const menu = page.locator("#admMenuBtn");
  if (await menu.isVisible()) await menu.click();
  await page.locator(`#admTabs [data-tab="${tab}"]`).click();
}

/** Logs in through the log-in form. */
export async function login(page: Page, phone: string, password = PASSWORD) {
  await page.goto("/register.html#login");
  await page.locator("#lphone").fill(phone);
  await page.locator("#lpw").fill(password);
  await page.locator("#loginBtn").click();
}

/** The session token the site stored, or null when signed out. */
export async function sessionToken(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    try {
      const raw = sessionStorage.getItem("voltabet.session") || localStorage.getItem("voltabet.session");
      const s = raw ? JSON.parse(raw) : null;
      return (s && s.token) || null;
    } catch { return null; }
  });
}

/** The player's cedi balance as the balance service holds it. */
export async function serverBalance(request: APIRequestContext, token: string): Promise<number> {
  const r = await request.get(`${API}/api/user/balances`, { headers: { Authorization: `Bearer ${token}` } });
  expect(r.status(), "balances answer for a signed-in player").toBe(200);
  return Number((await r.json()).primary.available);
}

/** Every request the payment gateway stub has seen. */
export async function gatewayRequests(request: APIRequestContext): Promise<{ method: string; path: string; body: Record<string, unknown> }[]> {
  return (await request.get(`${GATEWAY}/requests`)).json();
}

/** Deposits through the wallet page and waits for the page's verdict ("ok", "error" or "info"). */
export async function deposit(page: Page, amount: number, opts: { from?: string } = {}) {
  await page.goto("/wallet.html");
  await settle(page);
  if (opts.from) await page.locator("#depPhone").fill(opts.from);
  await page.locator("#depAmount").fill(String(amount));
  await expect(page.locator("#depSubmit")).toBeEnabled();
  await page.locator("#depSubmit").click();
}

/** A money amount from text such as "GHS 1,234.50" or "₵0.35". */
export const amountIn = (text: string) => Number((text.match(/-?[\d,]+(?:\.\d+)?/) || ["0"])[0].replace(/,/g, ""));
export const cents = (n: number) => Math.round(n * 100) / 100;

/** Collects uncaught exceptions on the page, so a test can require there were none. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** One real-money play on the balance service, straight to the API. */
export async function play(request: APIRequestContext, token: string, game: string, body: Record<string, unknown>) {
  const r = await request.post(`${API}/api/games/${game}/play`, { headers: { Authorization: `Bearer ${token}` }, data: body });
  return { status: r.status(), body: await r.json().catch(() => ({})) };
}

/** A funded player, made through the real sign-up form and a real (stubbed-gateway) deposit. */
export async function fundedPlayer(page: Page, amount = 100) {
  const player = await register(page);
  await deposit(page, amount);
  await expect(page.locator("#msg")).toContainText("successful", { timeout: 30_000 });
  return player;
}

/* ---------------- the database, for invariants (real Postgres stack only) ---------------- */
const dbUrl = () => {
  try { return readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".stack", "db-url"), "utf8").trim(); }
  catch { return ""; }
};
/** True when the balance service runs on real Postgres (the default): race tests then mean what they say. */
export const realPostgres = () => dbUrl().startsWith("postgres");

/** A query against the balance service's database (the wallet schema). */
export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl(), options: "-c search_path=wallet,public" });
  await client.connect();
  try { return (await client.query(text, params)).rows as T[]; } finally { await client.end(); }
}

/** The ledger's promises, checked in SQL: no balance below zero, every journal nets to zero in each currency,
 *  and every cached balance equals the sum of its ledger entries. */
export async function expectLedgerSound() {
  if (!realPostgres()) return;
  expect(await sql(`SELECT user_id, currency_code, available FROM user_balances WHERE available < 0 OR locked < 0`), "no negative balance").toEqual([]);
  expect(await sql(`SELECT journal_id, currency_code FROM ledger_entries GROUP BY journal_id, currency_code
                     HAVING sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) <> 0`), "every journal nets to zero").toEqual([]);
  expect(await sql(`SELECT * FROM balance_reconciliation`), "cached balances match the ledger").toEqual([]);
}
