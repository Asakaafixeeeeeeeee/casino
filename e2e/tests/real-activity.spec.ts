/* Game feeds, lobby player counts and home-banner player wins reflect real settled bets only. */
import { expect, test } from "@playwright/test";
import { API, fundedPlayer, play, settle, trackErrors } from "./helpers";

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const masked = (phone: string) => phone.slice(0, 3) + "•".repeat(phone.length - 5) + phone.slice(-2);

test("home banner shows top prizes without inventing player wins", async ({ page }) => {
  await page.route(`${API}/api/games/activity`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ playing: {}, wins: [] })
  }));

  await page.goto("/index.html");
  await settle(page);
  await expect(page.locator("#winner")).toBeVisible();
  const line = page.locator("#winner .winner-line");
  await expect(line).toContainText("Win up to");
  await expect(page.locator("#winner")).not.toContainText("DEMO");
  await expect(page.locator("#winner")).not.toContainText("SAMPLE");
  await expect(page.locator("#winner")).not.toContainText("Sample player");
});

test("game feeds show real activity and the home page preserves real wins", async ({ browser, request }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errors = trackErrors(p);
  const player = await fundedPlayer(p, 200);

  /* real coin flips: some won, some lost */
  const flips: { payout: number; pick: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const pick = i % 2 ? "TAILS" : "HEADS";
    const r = await play(request, player.token, "volta-coin", { stake: 3, choice: { pick }, idempotency_key: `round:real-${Date.now()}-${i}` });
    expect(r.status).toBe(200);
    flips.push({ payout: r.body.payout, pick });
  }
  const wins = flips.filter((f) => f.payout > 0).length;
  /* a real Knockout bet: the next round, cashed out at once at 1.01x if the round lasts that long */
  const round = await (await request.post(`${API}/api/games/volta-knockout/flight/next`, { headers: auth(player.token), data: {} })).json();
  const bet = await request.post(`${API}/api/games/volta-knockout/flight/bet`, {
    headers: auth(player.token), data: { flight_id: round.flight_id, panel: 0, stake: 2, auto: 1.01, idempotency_key: "real-ko-" + Date.now() } });
  expect(bet.status()).toBe(200);

  /* the feed is kept 5 seconds; other tests' players may be in it too, so count this player's */
  const me = masked(player.phone);
  const mine = (list: { player: string }[]) => list.filter((b) => b.player === me).length;
  await expect.poll(async () => mine((await (await request.get(`${API}/api/games/feed/coin`)).json()).recent), { timeout: 15_000 }).toBe(12);
  const feed = await (await request.get(`${API}/api/games/feed/coin`)).json();
  expect(mine(feed.top)).toBe(wins);
  expect(feed.recent.every((b: { player: string }) => /^\d{3}•+\d{2}$/.test(b.player)), "every player masked").toBe(true);

  /* the coin page: All Bets lists exactly these bets (masked), Top Wins only the real wins */
  await p.goto("/coin.html?mode=real");
  await settle(p);
  const rows = p.locator("#fcRows .fc-row");
  await expect(rows).toHaveCount(feed.recent.length);
  await expect(rows.filter({ hasText: me })).toHaveCount(12);
  await expect(p.locator("#fcRows")).not.toContainText(player.phone);
  await p.locator('.fc-tabs [data-tab="top"]').click();
  await expect(p.locator("#fcRows .fc-row")).toHaveCount(feed.top.length);
  await expect(p.locator("#fcRows .fc-row").filter({ hasText: me })).toHaveCount(wins);
  /* the results ribbon is the real flips (12, newest first, as many as the ribbon shows) */
  await expect(p.locator("#fcHistory li")).toHaveCount(9);

  /* Knockout: the players count is the real one (this player), and no made-up crowd */
  await p.goto("/knockout.html?mode=real");
  await settle(p);
  await expect(p.locator("#cgOnline")).not.toHaveText("0");
  await expect.poll(async () => (await (await request.get(`${API}/api/games/feed/knockout`)).json()).recent.length, { timeout: 60_000, intervals: [3000] }).toBeGreaterThan(0);
  await p.reload();
  await settle(p);
  await expect(p.locator("#cgList .cg-row").first()).toContainText(masked(player.phone));
  const koFeed = await (await request.get(`${API}/api/games/feed/knockout`)).json();
  await expect(p.locator("#cgList .cg-row")).toHaveCount(koFeed.recent.length);

  /* Crash: exactly the real bets the server has (none, unless another test bet on it) — no made-up crowd */
  const crashFeed = await (await request.get(`${API}/api/games/feed/crash`)).json();
  await p.goto("/crash.html");
  await settle(p);
  await expect(p.locator("#cgOnline")).toHaveText(String(crashFeed.playing));
  await expect(p.locator("#cgList .cg-row")).toHaveCount(crashFeed.recent.length);
  if (!crashFeed.recent.length) await expect(p.locator("#cgList")).toContainText("No real-money bets on Crash today yet.");

  /* the lobby: "playing now" only on games really played */
  await p.goto("/games.html");
  await settle(p);
  await p.goto("/games.html");
  await settle(p);
  const site = await (await request.get(`${API}/api/games/activity`)).json();
  expect(site.playing.coin).toBeGreaterThanOrEqual(1);
  await expect(p.locator('.game-card:has(a[href="game.html?game=coin"]) .players').first()).toHaveText(String(site.playing.coin));
  if (!site.playing.crash) await expect(p.locator('.game-card:has(a[href="game.html?game=crash"]) .players')).toHaveCount(0);

  /* the home page: the winners banner names this player's real win, masked */
  await p.goto("/index.html");
  await settle(p);
  if (wins) {
    await expect(p.locator("#winner")).toBeVisible();
    await expect(p.locator("#winner .winner-line")).toContainText(masked(player.phone));
  }
  expect(errors).toEqual([]);
});
