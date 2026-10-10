/* A refresh or a closed tab mid-game never loses a stake or settles a round twice. */
import { expect, test } from "@playwright/test";
import { amountIn, cents, fundedPlayer, serverBalance, settle } from "./helpers";

test("a Mines round survives a reload: the stake stays in play and the round carries on", async ({ page, request }) => {
  const { token } = await fundedPlayer(page);
  await page.goto("/mines.html?mode=real");
  await settle(page);
  await page.locator("#mnMines").selectOption("1");
  const go = page.locator("#mnGo");
  await go.click();
  await expect(go).toHaveAttribute("data-state", "cash");
  const afterStake = await serverBalance(request, token);
  const stake = cents(100 - afterStake);
  expect(stake).toBeGreaterThan(0);

  await page.reload();
  await settle(page);
  await expect(page.getByText("Your round in progress is back")).toBeVisible();
  await expect(go).toHaveAttribute("data-state", "cash");
  expect(await serverBalance(request, token), "the reload didn't refund or take the stake again").toBe(afterStake);

  /* open a tile: with one mine, a star 24 times in 25 */
  await page.locator("#mnBoard .mn-tile").nth(12).click();
  await expect.poll(async () => (await go.getAttribute("class"))?.includes("is-ready") || (await go.getAttribute("data-state")) === "bet").toBe(true);
  if ((await go.getAttribute("data-state")) === "cash") {
    await go.click();
    await expect(go).toHaveAttribute("data-state", "bet", { timeout: 15_000 });
  }
  const final = await serverBalance(request, token);
  await expect(page.locator("#mnBalance")).toHaveText(final.toLocaleString("en-GH", { minimumFractionDigits: 2 }));
  expect(final === afterStake || final > afterStake, "a bust keeps the stake; a cash-out pays more than it").toBe(true);
});

test("a Hi-Lo bet is settled once even when the page reloads mid-flip", async ({ page, request }) => {
  const { token } = await fundedPlayer(page);
  await page.goto("/hilo.html?mode=real");
  await settle(page);
  const stake = amountIn(await page.locator("#hlAmount").innerText());
  const played = page.waitForResponse((r) => r.url().includes("/api/games/volta-hilo/play"));
  await page.locator("[data-pick]:not([disabled])").first().click();
  await page.locator("#hlConfirmYes").click();
  const round = await (await played).json();
  await page.reload();                                  /* before the card has finished turning */
  await settle(page);
  const expected = cents(100 - stake + Number(round.payout));
  expect(await serverBalance(request, token)).toBe(expected);
  await expect(page.locator("#hlBalance")).toHaveText(expected.toFixed(2));
});
