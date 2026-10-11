/* Partner setup links through the real screens: the admin's Invitations list (new link, cancel), what the setup page
   says for a cancelled or broken link, and a player who already has the invited number accepting with their own
   account. The happy path (register through the link) is in partner-platform.spec.ts. */
import { expect, test } from "@playwright/test";
import { adminSession, adminTab, API, PASSWORD, register, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

test("invitations: cancel and renew from the admin list; an existing player accepts with their own account", async ({ browser, request }) => {
  test.setTimeout(240_000);
  const adminCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const a = await adminCtx.newPage();
  const adminToken = await adminSession(request, a);

  /* a player who registered on their own, with a number the admin then invites */
  const pCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const p = await pCtx.newPage();
  const errors = trackErrors(p);
  const player = await register(p);

  const made = await request.post(`${API}/api/admin/partner-invites`, { headers: auth(adminToken), data: { phone: player.phone, revshare_pct: 25 } });
  expect(made.status()).toBe(200);
  const first = (await made.json()).token as string;

  /* the admin finds it under Invitations and cancels it: the link says so */
  await a.goto("/admin.html");
  await settle(a);
  await adminTab(a, "partners");
  await a.locator('.apt-nav [data-psec="invites"]').click();
  const card = a.locator(".apt-inv", { hasText: player.phone }).first();
  await expect(card).toContainText("Open");
  await card.locator("[data-inv-cancel]").click();
  await a.locator(".me-dialog-card [data-yes]").click();
  await expect(a.locator(".apt-inv", { hasText: player.phone }).first()).toContainText("Cancelled");
  await p.goto("/partner-setup.html?n=1#" + first);
  await expect(p.locator("#psView")).toContainText("This link was cancelled");

  /* a broken link, and no link at all */
  await p.goto("/partner-setup.html?n=2#" + "x".repeat(32));
  await expect(p.locator("#psView")).toContainText("Link not valid");
  await p.goto("/partner-setup.html?fresh=1");
  await expect(p.locator("#psView")).toContainText("Partner setup link needed");

  /* "New link" makes a fresh one; the admin copies it from the sheet */
  await a.locator(".apt-inv", { hasText: player.phone }).first().locator("[data-inv-renew]").click();
  await a.locator(".me-dialog-card [data-yes]").click();
  const fresh = await a.locator("#piLink").inputValue();
  expect(fresh).toMatch(/partner-setup\.html#[A-Za-z0-9_-]{32}$/);

  /* the player (signed in already) opens it: the page offers to accept with their account */
  await p.goto(fresh);
  await settle(p);
  await expect(p.locator("#psView")).toContainText("already has a WIN B casino account");
  await expect(p.locator("#psView")).toContainText("25%");
  await p.locator("#psPromo").fill("ACC" + String(Date.now()).slice(-6));
  await p.locator("#psBtn").click();
  await p.waitForURL(/partners\.html/, { timeout: 30_000 });
  await settle(p);
  await expect(p.locator('[data-tab="dashboard"]')).toBeVisible();
  await expect(p.locator(".prt-idrow")).toContainText("25%");
  const me = await (await request.get(`${API}/api/partners/me`, { headers: auth(player.token) })).json();
  expect(me.partner.status).toBe("ACTIVE");

  /* someone else's account can't accept an invitation for this number */
  const other = await browser.newContext({ baseURL: "http://localhost:8808" });
  const o = await other.newPage();
  const stranger = await register(o);
  const inv2 = await request.post(`${API}/api/admin/partner-invites`, { headers: auth(adminToken), data: { phone: stranger.phone } });
  const t2 = (await inv2.json()).token as string;
  const wrong = await request.post(`${API}/api/partners/invite/accept`, { headers: auth(player.token), data: { token: t2 } });
  expect([wrong.status(), (await wrong.json()).error]).toEqual([403, "wrong_account"]);
  /* and an active partner's number isn't invited twice */
  const dup = await request.post(`${API}/api/admin/partner-invites`, { headers: auth(adminToken), data: { phone: player.phone } });
  expect([dup.status(), (await dup.json()).error]).toEqual([409, "already_partner"]);

  /* the setup page also logs a signed-out player in with their password */
  await o.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await o.goto("/partner-setup.html#" + t2);
  await settle(o);
  await expect(o.locator("#psLogin")).toHaveValue(stranger.phone);
  await o.locator("#psLpw").fill(PASSWORD);
  await o.locator("#psBtn").click();
  await o.waitForURL(/partners\.html/, { timeout: 30_000 });
  expect(errors, "no uncaught errors on the setup page").toEqual([]);
});
