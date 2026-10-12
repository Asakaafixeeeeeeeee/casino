/* Free play and the big-wins strip, per game, through the admin's real screens: each game card's two switches save at
   once and stay saved after a refresh; with free play off every game page drops its Credits choice (a signed-out
   visitor is asked to sign in, a signed-in player moves to the wallet) and the game's info page has no "Try free";
   with the strip on, a game page shows the real wins players had on it. Switches are put back at the end. */
import { expect, test } from "@playwright/test";
import { adminSession, adminTab, API, fundedPlayer, play, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/* every game page on the site, by its server id */
const PAGES: [string, string][] = [
  ["volta-coin", "/coin.html"], ["volta-bottle", "/bottle.html"], ["red-black", "/redblack.html"], ["volta-mines", "/mines.html"],
  ["magic-ball", "/magicball.html"], ["volta-crossing", "/crossing.html"], ["roulette", "/roulette.html"], ["even-odd", "/evenodd.html"],
  ["volta-goal", "/goal.html"], ["volta-hilo", "/hilo.html"], ["volta-fruits", "/fruits.html"], ["volta-olympus", "/olympus.html"],
  ["volta-wings", "/wings.html"], ["volta-crash", "/crash.html"], ["volta-knockout", "/knockout.html"], ["sky-rush", "/aviator.html"],
  ["volta-jet", "/volta-jet/index.html"],
];

test("free play and big-wins switches: saved per game, and every game page follows them", async ({ browser, request }) => {
  test.setTimeout(420_000);
  const adminToken = await adminSession(request);
  const save = (game: string, body: Record<string, unknown>) =>
    request.post(`${API}/api/admin/game-control/${game}`, { headers: auth(adminToken), data: body });

  try {
    /* 1. the admin switches Flip Da' Coin's free play off and its big-wins strip on, from the game card */
    const aCtx = await browser.newContext();
    const a = await aCtx.newPage();
    const errors = trackErrors(a);
    await adminSession(request, a);
    await a.goto("/admin.html");
    await settle(a);
    await adminTab(a, "games");
    const card = a.locator(".agm-card", { hasText: "Flip Da' Coin" });
    await expect(card.locator('[data-gflag="free_play"]')).toBeChecked();
    await expect(card.locator('[data-gflag="showcase"]')).not.toBeChecked();
    await card.locator('.agm-flag:has([data-gflag="free_play"]) .adm-switch').click();
    await expect(a.locator("#msg")).toContainText("Free play is now off for Flip Da' Coin");
    await card.locator('.agm-flag:has([data-gflag="showcase"]) .adm-switch').click();
    await expect(a.locator("#msg")).toContainText("big-wins strip is now on for Flip Da' Coin");
    /* still that way after a refresh */
    await a.reload();
    await settle(a);
    await adminTab(a, "games");
    const again = a.locator(".agm-card", { hasText: "Flip Da' Coin" });
    await expect(again.locator('[data-gflag="free_play"]')).not.toBeChecked();
    await expect(again.locator('[data-gflag="showcase"]')).toBeChecked();
    /* games whose page can't show the strip say so instead of offering a switch */
    await expect(a.locator(".agm-card", { hasText: "Jet" }).locator('[data-gflag="showcase"]')).toHaveCount(0);
    await expect(a.locator(".agm-card", { hasText: "Magic Ball Live" }).locator('[data-gflag="free_play"]')).toHaveCount(0);
    expect(errors).toEqual([]);

    /* 2. a signed-out visitor on the coin page is asked to sign in; the info page has no "Try free" */
    const vCtx = await browser.newContext();
    const v = await vCtx.newPage();
    await v.goto("/coin.html");
    await expect(v.locator("#vbFreeGate")).toBeVisible();
    await expect(v.locator("#vbFreeGate")).toContainText("Sign in to play");
    await v.goto("/game.html?game=coin");
    await expect(v.locator("#playReal")).toBeVisible();
    await expect(v.locator("#playDemo")).toBeHidden();
    await expect(v.locator("#info")).toContainText("Not available on this game");
    /* another game is untouched */
    await v.goto("/bottle.html");
    await settle(v);
    await expect(v.locator("#vbFreeGate")).toHaveCount(0);

    /* 3. a signed-in player moves to the wallet: no Credits choice; a real 2x win shows in the strip */
    const pCtx = await browser.newContext();
    const p = await pCtx.newPage();
    const player = await fundedPlayer(p, 100);
    let won = false;
    for (let i = 0; i < 30 && !won; i++) {
      const r = await play(request, player.token, "volta-coin", { stake: 1, choice: { pick: "HEADS" }, idempotency_key: `round:fps-${Date.now()}-${i}` });
      won = r.body.payout > 0;
    }
    expect(won, "a real winning flip").toBe(true);
    /* the strip's list is kept for up to 30 seconds (the visitor above already asked for it) */
    await expect.poll(async () => (await (await request.get(`${API}/api/games/big-wins/coin`)).json()).wins.length, { timeout: 40_000, intervals: [2000] }).toBeGreaterThan(0);
    await p.goto("/coin.html");
    await expect(p).toHaveURL(/mode=real/);
    await settle(p);
    await expect(p.locator("#fcBalLabel")).toHaveText("Wallet");
    await p.locator("#fcMenuBtn").click();
    await expect(p.locator('#fcMenu [data-mode="fun"]')).toBeHidden();
    await expect(p.locator("#vbBigWins")).toBeVisible();
    await expect(p.locator("#vbBigWins")).toContainText("2.00x");
    await expect(p.locator("#vbBigWins")).not.toContainText(player.phone);

    /* 4. free play off on every game: each page drops free play for a visitor */
    for (const [id] of PAGES) expect((await save(id, { free_play: false })).status(), id).toBe(200);
    for (const [id, page] of PAGES) {
      await v.goto(page);
      if (id === "volta-jet") await expect(v.locator(".free-gate"), id).toBeVisible();
      else await expect(v.locator("#vbFreeGate"), id).toBeVisible();
    }
    /* and back on: free play as before */
    for (const [id] of PAGES) await save(id, { free_play: true });
    for (const [id, page] of PAGES) {
      await v.goto(page);
      await v.waitForTimeout(800);
      await expect(v.locator("#vbFreeGate, .free-gate"), id).toHaveCount(0);
    }
  } finally {
    for (const [id] of PAGES) await save(id, { free_play: true, ...(id === "volta-jet" ? {} : { showcase: false }) });
  }
});
