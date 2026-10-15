/* Game management through the admin's real screens: every game as a card, Knockout's control sheet (betting time and
   longest round, which the next round really uses), pause and resume (the server refuses new rounds meanwhile), bet
   limits that the server enforces, live bets and players' wins and losses, and a promotional reward given from a
   player's profile with its record. Settings are put back at the end so other tests see the games as they were. */
import { expect, test } from "@playwright/test";
import { adminSession, adminTab, API, fundedPlayer, play, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

test("admin game management: Knockout timing, pause and resume, bet limits, live bets, player rewards", async ({ browser, request }) => {
  test.setTimeout(300_000);
  const adminCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const a = await adminCtx.newPage();
  const errors = trackErrors(a);
  const adminToken = await adminSession(request, a);
  const reset = (game: string, body: Record<string, unknown>) =>
    request.post(`${API}/api/admin/game-control/${game}`, { headers: auth(adminToken), data: body });

  /* a funded player who plays Flip Da' Coin, so the game has bets to show */
  const pCtx = await browser.newContext({ baseURL: "http://localhost:8808" });
  const p = await pCtx.newPage();
  const player = await fundedPlayer(p, 100);
  for (let i = 0; i < 3; i++) {
    expect((await play(request, player.token, "volta-coin", { stake: 2, choice: { pick: "HEADS" }, idempotency_key: `round:gm-${Date.now()}-${i}` })).status).toBe(200);
  }

  try {
    /* 1. the Games tab: a card per game */
    await a.goto("/admin.html");
    await settle(a);
    await adminTab(a, "games");
    await expect(a.locator(".agm-card")).toHaveCount(21);
    await expect(a.locator(".agm-card", { hasText: "Knockout" })).toBeVisible();

    /* 2. Knockout: 12 seconds to bet, rounds of at most 50x */
    await a.locator(".agm-card", { hasText: "Knockout" }).locator("[data-game-open]").click();
    const sheet = a.locator(".adm-sheet");
    await expect(sheet).toContainText("Round timing");
    await sheet.locator("#gmWait").fill("12");
    await sheet.locator("#gmMaxX").fill("50");
    await expect(sheet.locator("#gmMaxXHint")).toContainText("33 s");
    await sheet.locator('form[data-gf="controls"] button[type=submit]').click();
    await a.locator(".me-dialog-card [data-yes]").click();
    await expect(a.locator("#msg")).toContainText("controls saved");
    await expect.poll(async () => (await (await request.get(`${API}/api/admin/game-control/volta-knockout`, { headers: auth(adminToken) })).json()).controls.wait_ms).toBe(12000);
    const round = await (await request.post(`${API}/api/games/volta-knockout/flight/next`, { headers: auth(player.token), data: {} })).json();
    expect([round.wait_ms, round.max_x]).toEqual([12000, 50]);
    expect(round.starts_in_ms).toBeGreaterThan(10000);
    expect(round.crash, "the result of a round in play is never sent").toBeUndefined();
    /* the admin sees that round live, without its result */
    await sheet.locator('[data-gm="refresh"]').click();
    await expect(sheet.locator("#gmLive")).toContainText("Betting");
    await expect(sheet.locator("#gmLive")).not.toContainText(/\d+\.\d\dx/);

    /* 3. pause: the server refuses new rounds; resume opens them again */
    await sheet.locator('[data-gm="pause"]').click();
    await a.locator("#gmNote").fill("E2E check");
    await a.locator(".me-dialog-card [data-yes]").click();
    await expect(sheet.locator(".agm-paused")).toContainText("Paused");
    await expect(sheet.locator(".agm-paused")).toContainText("E2E check");
    /* the round already open keeps going; the next one is refused while paused */
    const coinPaused = await reset("volta-coin", { paused: true });
    expect(coinPaused.status()).toBe(200);
    const refused = await play(request, player.token, "volta-coin", { stake: 2, choice: { pick: "HEADS" }, idempotency_key: `round:gm-paused-${Date.now()}` });
    expect([refused.status, refused.body.error]).toEqual([503, "game_paused"]);
    await reset("volta-coin", { paused: false });
    await sheet.locator('[data-gm="resume"]').click();
    await expect(sheet.locator(".agm-paused")).toHaveCount(0);
    await sheet.locator(".me-sheet-close, [data-close]").first().click().catch(() => {});

    /* 4. bet limits on Flip Da' Coin: the server enforces them */
    await a.goto("/admin.html#games");
    await settle(a);
    await adminTab(a, "games");
    await a.locator(".agm-card", { hasText: "Flip Da' Coin" }).locator("[data-game-open]").click();
    const coin = a.locator(".adm-sheet");
    await expect(coin).toContainText("Bet limits");
    await expect(coin.locator("#gmWait")).toHaveCount(0);
    await coin.locator("#gmMax").fill("5");
    await coin.locator('form[data-gf="controls"] button[type=submit]').click();
    await a.locator(".me-dialog-card [data-yes]").click();
    await expect.poll(async () => (await play(request, player.token, "volta-coin", { stake: 10, choice: { pick: "HEADS" }, idempotency_key: `round:gm-max-${Date.now()}` })).status).toBe(400);

    /* 5. live bets and players: the player's bets are listed; their profile has wins and losses by game; a reward */
    await expect(coin.locator("#gmLive")).toContainText(player.phone);
    await expect(coin).toContainText("Biggest");
    await coin.locator("#gmLive [data-user]").first().click();
    const prof = a.locator(".adm-sheet").last();
    await expect(prof).toContainText("Wins and losses by game");
    await expect(prof).toContainText("Flip Da' Coin");
    const before = (await (await request.get(`${API}/api/admin/users/${await prof.locator(".adm-id").textContent()}`, { headers: auth(adminToken) })).json()).profile.balance;
    await prof.locator("#adjKind").selectOption("PROMO");
    await prof.locator("#adjAmt").fill("15");
    await prof.locator("#adjWhy").fill("Weekend promotion winner");
    await prof.locator('form[data-act="adjust"] button[type=submit]').click();
    await a.locator(".me-dialog-card [data-yes]").click();
    await expect(prof).toContainText("Promotional reward from WIN B casino");
    await expect(prof).toContainText("Weekend promotion winner");
    const after = (await (await request.get(`${API}/api/admin/users/${await prof.locator(".adm-id").textContent()}`, { headers: auth(adminToken) })).json()).profile.balance;
    expect(Math.round((after - before) * 100) / 100).toBe(15);
    expect(errors, "no uncaught errors on the admin page").toEqual([]);
  } finally {
    await reset("volta-knockout", { paused: false, wait_ms: null, max_x: null });
    await reset("volta-coin", { paused: false, min_bet: null, max_bet: null });
  }
});
