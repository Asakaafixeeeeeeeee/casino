/* An admin switching a game off: only that game leaves the home page; every other game, the sections and the winner
   banner stay, with no errors. (The banner used to name switched-off games and crash the page, emptying it.) */
import { expect, test } from "@playwright/test";
import { adminSession, API, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

test("switching one game off leaves every other game on the home page", async ({ page, request }) => {
  const token = await adminSession(request);
  const errors = trackErrors(page);
  await page.goto("/index.html");
  await settle(page);
  const all = await page.locator("#allGamesGrid > *").count();
  expect(all).toBeGreaterThan(5);
  /* the lobby's first game: the winner banner starts with it */
  const first = await page.evaluate(() => {
    const g = (window as unknown as { VB: { allGames: { id: string; name: string }[] } }).VB.allGames[0]!;
    return { id: g.id, name: g.name };
  });

  const off = await request.post(`${API}/api/admin/catalog/game/${first.id}`, { headers: auth(token), data: { enabled: false } });
  expect(off.status()).toBe(200);
  try {
    /* each page asks the server which games are off and applies the answer from the next page on */
    await page.goto("/index.html");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("vb.catalog.hidden") || "")).toContain(first.id);
    await page.reload();
    await settle(page);
    await expect(page.locator("#allGamesGrid > *")).toHaveCount(all - 1);
    await expect(page.locator(`#allGamesGrid a[href*="game=${first.id}"]`)).toHaveCount(0);
    await expect(page.locator("#sections .game-grid > *").first()).toBeVisible();
    await expect(page.locator("#winner .winner-game")).toBeVisible();
    await expect(page.locator("#winner .winner-game")).not.toHaveText(first.name);
    expect(errors, "no uncaught errors").toEqual([]);
  } finally {
    await request.post(`${API}/api/admin/catalog/game/${first.id}`, { headers: auth(token), data: { enabled: true } });
  }
});
