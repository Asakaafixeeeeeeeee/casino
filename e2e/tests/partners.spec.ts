/* Partners earn revenue share: a share of what their referred players lose, less a deduction on players' net winnings.
   A player who arrives through a partner's link (and may type the partner's promo code) is the partner's; their real
   bets earn commission that the partner portal and the admin's partner pages show from the database. The admin runs
   the programme: approvals, rates, corrections, payouts, and a read-only view of each partner's dashboard. */
import { expect, test, type Page } from "@playwright/test";
import { adminSession, adminTab, amountIn, API, cents, deposit, newPhone, play, register, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** A money amount as the site shows it, negatives with a real minus sign (−). */
const signed = (text: string | null) => amountIn((text || "").replace(/−/g, "-"));

/** The number in a KPI tile, found by its label. */
const kpi = (page: Page, label: string) =>
  page.locator(".adm-kpi", { has: page.locator("span", { hasText: new RegExp("^" + label + "$") }) }).first().locator("strong");

/** Registers through the sign-up form with an optional promo code and email; returns null when the form refuses. */
async function registerWith(page: Page, promo: string, email = "") {
  await page.goto("/register.html");
  await page.locator("#fullName").fill("Akosua Darko");
  await page.locator("#country").selectOption("GH");
  await page.locator("#phone").fill(newPhone());
  if (email) await page.locator("#email").fill(email);
  await page.locator("#pw").fill("Sup3r-secret!");
  await page.locator("#age").fill("1990-05-17");
  await page.locator("#currency").selectOption("GHS");
  await page.locator("#promo").fill(promo);
  await page.locator("#terms").check();
  await page.locator("#regBtn").click();
}

/** What a settled coin round earns the partner: rate% of a loss, minus deduction% of net winnings, to the cent. */
const commissionOf = (stake: number, payout: number, rate: number, deduction: number) =>
  stake > payout ? Math.trunc((stake - payout) * rate + 1e-9) / 100 : payout > stake ? -Math.trunc((payout - stake) * deduction + 1e-9) / 100 : 0;

test("revenue share: link + promo code sign-up, commission from real bets, partner portal, admin control and payouts", async ({ browser, page, request }) => {
  test.setTimeout(300_000);
  const adminCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const admin = { page: await adminCtx.newPage(), token: "" };
  admin.token = await adminSession(request, admin.page);
  const errors = trackErrors(page);
  const stamp = String(Date.now()).slice(-6);

  /* two partners apply; the admin approves them at 40% (A) and the default (B) */
  const partner = await register(page);
  const applied = await request.post(`${API}/api/partners/apply`, { headers: auth(partner.token), data: { channel: "My football WhatsApp group (2,000 members)" } });
  expect(applied.status()).toBe(200);
  const { code } = (await applied.json()).partner;
  const pending = await (await request.get(`${API}/api/admin/partners?status=PENDING`, { headers: auth(admin.token) })).json();
  const row = pending.partners.find((p: { code: string }) => p.code === code);
  expect((await request.post(`${API}/api/admin/partners/${row.user_id}`, { headers: auth(admin.token), data: { status: "ACTIVE", revshare_pct: 40 } })).status()).toBe(200);
  const promoA = "AJA" + stamp;
  expect((await request.post(`${API}/api/partners/settings/promo`, { headers: auth(partner.token), data: { promo_code: promoA } })).status()).toBe(200);

  const otherCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const other = await register(await otherCtx.newPage());
  await request.post(`${API}/api/partners/apply`, { headers: auth(other.token), data: { channel: "Instagram page about Ghana football" } });
  const otherRow = (await (await request.get(`${API}/api/admin/partners?status=PENDING`, { headers: auth(admin.token) })).json()).partners
    .find((p: { phone: string }) => p.phone === other.phone);
  await request.post(`${API}/api/admin/partners/${otherRow.user_id}`, { headers: auth(admin.token), data: { status: "ACTIVE" } });
  const promoB = "BOB" + stamp;
  expect((await request.post(`${API}/api/partners/settings/promo`, { headers: auth(other.token), data: { promo_code: promoB } })).status()).toBe(200);
  /* promo codes are unique */
  expect((await request.post(`${API}/api/partners/settings/promo`, { headers: auth(other.token), data: { promo_code: promoA } })).status()).toBe(409);

  /* a visitor through A's link who types B's promo code is stopped before an account is opened */
  const mixCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const mix = await mixCtx.newPage();
  await mix.goto(`/index.html?ref=${code}`);
  await settle(mix);
  await registerWith(mix, promoB);
  await expect(mix.locator("#promoErr")).toContainText("different partner");
  await expect(mix).toHaveURL(/register\.html/);

  /* a player opens A's link, browses another page, then signs up with A's promo code and an email */
  const playerCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const player = await playerCtx.newPage();
  await player.goto(`/index.html?ref=${code}&sub=whatsapp`);
  await settle(player);
  await player.goto("/games.html");
  await settle(player);
  await registerWith(player, promoA.toLowerCase(), `akosua${stamp}@example.com`);
  await player.waitForURL(/index\.html$/);
  const playerToken = await player.evaluate(() => JSON.parse(localStorage.getItem("voltabet.session") || sessionStorage.getItem("voltabet.session") || "{}").token);
  await expect.poll(async () => (await (await request.get(`${API}/api/partners/referrals?range=all`, { headers: auth(partner.token) })).json()).referrals.length,
    { timeout: 20_000 }).toBe(1);
  const detail0 = await (await request.get(`${API}/api/admin/partners/${row.user_id}`, { headers: auth(admin.token) })).json();
  expect(detail0.referrals[0].via).toBe("link+promo");
  expect(detail0.referrals[0].full_name).toBe("Akosua Darko");

  /* they deposit and play real coin rounds: every settled round earns (or costs) A commission */
  await deposit(player, 100);
  await expect(player.locator("#msg")).toContainText("successful", { timeout: 30_000 });
  let expected = 0;
  for (let i = 0; i < 6; i++) {
    const r = await play(request, playerToken, "volta-coin", { stake: 10, choice: { pick: i % 2 ? "HEADS" : "TAILS" }, idempotency_key: `round:aff-${stamp}-${i}` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expected = cents(expected + commissionOf(10, Number(r.body.payout), 40, 10));
  }
  await expect.poll(async () => (await (await request.get(`${API}/api/partners/summary`, { headers: auth(partner.token) })).json()).revenueShare.lifetime,
    { timeout: 20_000 }).toBe(expected);
  const stats = await (await request.get(`${API}/api/partners/statistics?range=today`, { headers: auth(partner.token) })).json();
  expect([stats.totals.stakes, stats.totals.earnings]).toEqual([60, expected]);
  /* B never sees A's player */
  expect((await (await request.get(`${API}/api/partners/referrals?range=all`, { headers: auth(other.token) })).json()).referrals.length).toBe(0);

  /* the partner portal shows it */
  await page.goto("/partners.html");
  await settle(page);
  await expect(kpi(page, "Total referrals")).toHaveText("1");
  await expect.poll(async () => signed(await kpi(page, "Lifetime").textContent()), { timeout: 20_000 }).toBe(expected);
  await expect(page.locator("body")).toContainText("40%");
  await page.locator('[data-tab="referrals"]').click();
  await expect(page.locator("table")).toContainText("P-");
  await expect(page.locator("body")).not.toContainText("Akosua", { timeout: 2_000 });
  await page.locator('[data-tab="statistics"]').click();
  await expect(page.locator("svg").first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("partner-portal.png"), fullPage: true });

  /* the admin: the partner in the Active list, their profile, and the read-only dashboard preview */
  const a = admin.page;
  await a.goto("/admin.html");
  await settle(a);
  await adminTab(a, "partners");
  await a.locator('[data-chips="pview"] [data-v="ACTIVE"]').click();
  const listRow = a.locator(".adm-prow", { hasText: code });
  await expect(listRow).toContainText(promoA);
  await listRow.locator("[data-partner]").click();
  const sheet = a.locator(".adm-sheet");
  await expect(sheet).toContainText("Akosua Darko");
  await expect(sheet.locator(`a[href*="partners.html?preview=${row.user_id}"]`)).toBeVisible();
  await a.screenshot({ path: test.info().outputPath("admin-partner.png"), fullPage: false });
  await a.goto(`/partners.html?preview=${row.user_id}`);
  await settle(a);
  await expect(a.locator(".prt-preview")).toContainText("Admin preview");
  await expect.poll(async () => signed(await kpi(a, "Lifetime").textContent()), { timeout: 20_000 }).toBe(expected);

  /* wallet: a verified correction, a payout held at once, a rejection returns it, a payment needs its reference */
  expect((await request.post(`${API}/api/admin/partners/${row.user_id}/correction`, { headers: auth(admin.token),
    data: { amount: "100.00", reason: "e2e opening credit for payouts" } })).status()).toBe(200);
  const before = (await (await request.get(`${API}/api/partners/wallet`, { headers: auth(partner.token) })).json()).wallet.available;
  const momo = { phone: partner.phone, name: "Kwame Mensah" };
  const req1 = await request.post(`${API}/api/partners/payouts`, { headers: auth(partner.token), data: { amount: 60, method: "MOMO", details: momo } });
  expect(req1.status()).toBe(200);
  expect((await (await request.get(`${API}/api/partners/wallet`, { headers: auth(partner.token) })).json()).wallet.available).toBe(cents(before - 60));
  expect((await request.post(`${API}/api/partners/payouts`, { headers: auth(partner.token), data: { amount: 50, method: "MOMO", details: momo } })).status()).toBe(409);
  const id1 = (await req1.json()).id;
  expect((await request.post(`${API}/api/admin/partner-payouts/${id1}`, { headers: auth(admin.token), data: { action: "reject", note: "Name doesn't match" } })).status()).toBe(200);
  expect((await (await request.get(`${API}/api/partners/wallet`, { headers: auth(partner.token) })).json()).wallet.available).toBe(before);
  const id2 = (await (await request.post(`${API}/api/partners/payouts`, { headers: auth(partner.token), data: { amount: 50, method: "MOMO", details: momo } })).json()).id;
  expect((await request.post(`${API}/api/admin/partner-payouts/${id2}`, { headers: auth(admin.token), data: { action: "approve" } })).status()).toBe(200);
  expect((await request.post(`${API}/api/admin/partner-payouts/${id2}`, { headers: auth(admin.token), data: { action: "pay" } })).status()).toBe(400);
  expect((await request.post(`${API}/api/admin/partner-payouts/${id2}`, { headers: auth(admin.token), data: { action: "pay", reference: "MOMO-77812" } })).status()).toBe(200);
  const w = (await (await request.get(`${API}/api/partners/wallet`, { headers: auth(partner.token) })).json()).wallet;
  expect([w.withdrawn, w.available]).toEqual([50, cents(before - 50)]);
  expect(errors, "no uncaught errors on the partner page").toEqual([]);
});

test("the installed app icon: manifest and Apple touch icons on every page", async ({ page, request }) => {
  const m = await (await request.get("/manifest.webmanifest")).json();
  expect([m.name, m.display]).toEqual(["WIN B casino", "standalone"]);
  for (const icon of m.icons) expect((await request.get("/" + icon.src)).status(), icon.src).toBe(200);
  expect((await request.get("/apple-touch-icon.png")).status()).toBe(200);
  for (const path of ["/index.html", "/register.html", "/partners.html", "/admin.html", "/mines.html"]) {
    await page.goto(path);
    await expect(page.locator('link[rel="apple-touch-icon"]').first()).toHaveAttribute("href", /apple-touch-icon-180\.png$/);
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "WIN B casino");
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "assets/img/winb-mark.svg");
  }
});

test("the whole flow on screen: apply, admin approves, dashboard opens, link tracks a sign-up, commission recorded; rejects stay out", async ({ browser, page, request }) => {
  test.setTimeout(300_000);
  const adminCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const a = await adminCtx.newPage();
  const adminToken = await adminSession(request, a);
  const errors = trackErrors(page);

  /* 1. a player applies on the partner page */
  const partner = await register(page);
  await page.goto("/partners.html");
  await settle(page);
  await page.locator("#apChannel").fill("My football WhatsApp group (2,000 members)");
  await page.locator("#apAgree").check();
  await page.locator("#applyForm button[type=submit]").click();
  await expect(page.locator("#prtView")).toContainText("Application received");
  /* pending: no dashboard, and the partner API refuses */
  expect((await request.get(`${API}/api/partners/summary`, { headers: auth(partner.token) })).status()).toBe(403);
  await page.reload();
  await settle(page);
  await expect(page.locator("#prtView")).toContainText("Application received");
  await expect(page.locator('[data-tab="dashboard"]')).toHaveCount(0);

  /* 2. the admin sees it under Partners → Applications and approves it */
  await a.goto("/admin.html");
  await settle(a);
  await adminTab(a, "partners");
  const app = a.locator(".adm-prow", { hasText: partner.phone });
  await expect(app).toBeVisible();
  await app.locator('[data-pact="ACTIVE"]').click();
  await a.locator(".me-dialog [data-yes]").click();
  await expect(a.locator("#msg")).toContainText("/?ref=");

  /* 3. the partner's dashboard opens straight away — same account, no new registration */
  await page.reload();
  await settle(page);
  await expect(page.locator('[data-tab="dashboard"]')).toBeVisible();
  const link = await page.locator("#lnk").inputValue();
  expect(link).toMatch(/\/\?ref=WB[A-Z0-9]{6}$/);
  const code = link.split("ref=")[1]!;
  await expect(page.locator(".prt-idrow")).toContainText(code);
  await expect(page.locator(".prt-idrow")).toContainText("Active");
  await expect(page.locator(".prt-idrow")).toContainText("40%");
  await expect(kpi(page, "Total referrals")).toHaveText("0");
  await expect(page.locator("body")).toContainText("No one has registered through your link yet");

  /* 4. someone opens the link, looks around, registers: they're the partner's */
  const visitorCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const visitor = await visitorCtx.newPage();
  await visitor.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await settle(visitor);
  await visitor.goto("/promotions.html");
  const player = await register(visitor);
  await expect.poll(async () => (await (await request.get(`${API}/api/partners/referrals?range=all`, { headers: auth(partner.token) })).json()).referrals.length,
    { timeout: 20_000 }).toBe(1);

  /* 5. they play: the commission history and totals fill in from the database */
  await deposit(visitor, 100);
  await expect(visitor.locator("#msg")).toContainText("successful", { timeout: 30_000 });
  let expected = 0;
  let earned = 0;
  for (let i = 0; i < 3; i++) {
    const r = await play(request, player.token, "volta-coin", { stake: 5, choice: { pick: "HEADS" }, idempotency_key: `round:flow-${Date.now()}-${i}` });
    expect(r.status).toBe(200);
    const c = commissionOf(5, Number(r.body.payout), 40, 10);
    expected = cents(expected + c);
    if (c > 0) earned = cents(earned + c);
  }
  await page.reload();
  await settle(page);
  await expect(kpi(page, "Total referrals")).toHaveText("1");
  await expect(page.locator("#prtSignups tbody tr")).toHaveCount(1);
  await expect(page.locator("#prtSignups")).toContainText("Referral link");
  await expect(page.locator("#prtCommissions tbody tr")).toHaveCount(3);
  await expect.poll(async () => signed(await kpi(page, "Lifetime").textContent())).toBe(expected);
  expect(amountIn(await kpi(page, "Total commission earned").textContent() || "")).toBe(earned);
  await expect(page.locator("body")).toContainText("No payout requests yet");
  await expect(page.locator("body")).not.toContainText(player.fullName);
  await page.screenshot({ path: test.info().outputPath("partner-dashboard.png"), fullPage: true });

  /* 6. the admin adds a partner directly: they get a referral link at once */
  const directCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const directPage = await directCtx.newPage();
  const direct = await register(directPage);
  await a.locator("[data-add-partner]").click();
  await a.locator("#paQ").fill(direct.phone);
  await a.locator('form[data-form="plookup"] button[type=submit]').click();
  await a.locator("[data-make]").click();
  await a.locator(".me-dialog [data-yes]").click();
  await expect(a.locator("#msg")).toContainText("/?ref=");
  await directPage.goto("/partners.html");
  await settle(directPage);
  await expect(directPage.locator("#lnk")).toHaveValue(/\/\?ref=WB[A-Z0-9]{6}$/);
  expect(await directPage.locator("#lnk").inputValue()).not.toBe(link);

  /* 7. a rejected applicant never gets in */
  const rejCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const rejPage = await rejCtx.newPage();
  const rej = await register(rejPage);
  await request.post(`${API}/api/partners/apply`, { headers: auth(rej.token), data: { channel: "A page I haven't made yet, honestly" } });
  await a.goto("/admin.html");
  await settle(a);
  await adminTab(a, "partners");
  await a.locator('[data-chips="pview"] [data-v="PENDING"]').click();
  const rejRow = a.locator(".adm-prow", { hasText: rej.phone });
  await rejRow.locator('[data-pact="REJECTED"]').click();
  await a.locator(".me-dialog [data-yes]").click();
  await expect(a.locator("#msg")).toContainText("rejected");
  expect((await request.get(`${API}/api/partners/summary`, { headers: auth(rej.token) })).status()).toBe(403);
  await rejPage.goto("/partners.html");
  await settle(rejPage);
  await expect(rejPage.locator("#prtView")).toContainText("Not approved");
  await expect(rejPage.locator('[data-tab="dashboard"]')).toHaveCount(0);
  expect(adminToken).toBeTruthy();
  expect(errors, "no uncaught errors on the partner page").toEqual([]);
});

test("the new name: WIN B WIN in the tab, WIN B casino on the pages, no RendoWin left", async ({ page }) => {
  for (const path of ["/index.html", "/register.html", "/partners.html", "/admin.html", "/me.html", "/terms.html", "/games.html"]) {
    await page.goto(path);
    await expect(page).toHaveTitle(/WIN B WIN/);
    await page.waitForTimeout(300);
    expect(await page.locator("body").innerText(), path).not.toMatch(/RendoWin/i);
  }
  await page.goto("/index.html");
  await settle(page);
  await expect(page.locator(".brand-word").first()).toHaveAttribute("src", "assets/img/winb-wordmark.svg");
  await expect(page.locator(".brand-mark").first()).toHaveAttribute("src", "assets/img/winb-mark.svg");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "assets/img/winb-mark.svg");
  await expect(page.locator("footer")).toContainText("WIN B casino");
});
