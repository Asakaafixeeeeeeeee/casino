/* Aviator: one live crash round for everybody. Visitors and players watch the same round; a real-money bet shows
   (masked) in everyone's bets list; cash-outs are judged and paid by the balance service; the same bet sent twice is
   one bet; finished rounds check out in the browser. */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { API, expectLedgerSound, fundedPlayer, serverBalance, settle, trackErrors } from "./helpers";

const SKY = `${API}/api/games/sky-rush/live`;

interface State { server_now: number; round: { no: number; hash: string; starts_at: number; over: boolean } }
const state = async (request: APIRequestContext): Promise<State> => (await request.get(`${SKY}/state`)).json();

/** Waits until a round is taking bets with at least `ms` to go, and returns it. */
async function bettingRound(request: APIRequestContext, ms = 3000): Promise<State["round"]> {
  for (let i = 0; i < 300; i++) {
    const s = await state(request);
    if (s.round.starts_at - s.server_now > ms) return s.round;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("no round took bets");
}

async function openGame(page: Page, mode: "fun" | "real" = "fun") {
  await page.goto(`/aviator.html?game=aviator&mode=${mode}`);
  await settle(page);
}
const cta = (page: Page, panel = 0) => page.locator(".sr-panel").nth(panel).locator("[data-cta]");
const ctaLabel = (page: Page, panel = 0) => cta(page, panel).locator(".sr-cta-label");

test.describe("Aviator", () => {
  test.setTimeout(240_000);

  test("a visitor watches a live round: waiting, take-off, the multiplier climbing, and the crash in the history", async ({ page }) => {
    const errors = trackErrors(page);
    await openGame(page);
    await expect(page.locator("#srBalance")).toHaveText("3,000.00");
    /* a moment when the plane is in the air (not the "flew away" pause) */
    await page.waitForFunction(() => !document.getElementById("srMult")!.hidden && document.getElementById("srFlew")!.hidden,
      null, { timeout: 120_000 });
    const latest = () => page.evaluate(() => (document.querySelector("#srHistory .sr-hx") as HTMLElement | null)?.dataset.round ?? null);
    const before = await latest();
    /* the plane flies away within this time unless it climbs past ~6,000x */
    await expect(page.locator("#srFlew")).toBeVisible({ timeout: 110_000 });
    await expect.poll(latest, { timeout: 10_000 }).not.toBe(before);
    await expect(page.locator("#srMult")).toHaveText(/^\d+\.\d\dx$/);
    await expect(page.locator("#srWait")).toBeVisible({ timeout: 10_000 });
    expect(errors).toEqual([]);
  });

  test("free credits ride the live round: bet, cash out or lose, and a bet made mid-flight waits for the next round", async ({ page }) => {
    const errors = trackErrors(page);
    await openGame(page);
    await expect(page.locator("#srWait")).toBeVisible({ timeout: 120_000 });
    await cta(page).click();
    await expect(ctaLabel(page)).toHaveText("Cancel");
    await expect(page.locator("#srBalance")).toHaveText("2,999.00");
    /* the bet is listed as the player's own */
    await expect(page.locator("#srList .sr-row.mine")).toHaveCount(1);
    await expect(ctaLabel(page)).toHaveText(/Cash Out|Bet/, { timeout: 30_000 });
    if ((await ctaLabel(page).textContent()) === "Cash Out") {
      await cta(page).click();
      await expect(ctaLabel(page)).toHaveText("Bet");
    }
    /* a bet made while the plane flies is held for the next round */
    await expect(page.locator("#srMult")).toBeVisible({ timeout: 120_000 });
    await cta(page, 1).click();
    const note = page.locator(".sr-panel").nth(1).locator(".sr-cta-note");
    if ((await ctaLabel(page, 1).textContent()) === "Cancel") {
      await expect(note).toHaveText(/Waiting for next round|^$/);
    }
    /* it flies with the next round (Cash Out), or is already lost if that round flew away at 1.00x */
    await expect(ctaLabel(page, 1)).not.toHaveText("Cancel", { timeout: 130_000 });
    await expect(ctaLabel(page, 1)).toHaveText(/Cash Out|Bet/);
    expect(errors).toEqual([]);
  });

  test("two players share the round: a real bet shows in the other's list, masked, and a cash-out is paid by the server", async ({ page, browser, request }) => {
    const player = await fundedPlayer(page, 100);
    const viewer = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();
    await openGame(viewer);
    await openGame(page, "real");
    await expect(page.locator("#srDemo")).toBeHidden();
    await expect(page.locator("#srBalance")).toHaveText("100.00");

    /* bet 5 on a round that's taking bets */
    await expect(page.locator("#srWait")).toBeVisible({ timeout: 120_000 });
    const round = await bettingRound(request, 2500);
    await page.locator(".sr-panel").first().locator("[data-quick='5']").click();
    await cta(page).click();
    await expect(ctaLabel(page)).toHaveText("Cancel");
    await expect.poll(() => serverBalance(request, player.token)).toBe(95);

    /* the visitor sees it: one bet in the round, a masked name, 5.00 */
    await expect(viewer.locator("#srList .sr-row")).toHaveCount(1, { timeout: 10_000 });
    const row = viewer.locator("#srList .sr-row").first();
    await expect(row.locator(".sr-name")).toHaveText(/^p\*\*\*\d$/);
    await expect(row.locator(".sr-num").first()).toHaveText("5.00");
    await expect(viewer.locator("#srSumCount")).toHaveText("1");
    /* and both pages show the same round */
    await expect.poll(async () => (await viewer.locator("#srFairHash").textContent()) === (await page.locator("#srFairHash").textContent())).toBe(true);

    /* cash out the moment the plane is up (about 1 round in 25 flies away at 1.00x: the bet is then lost) */
    await expect(ctaLabel(page)).toHaveText(/Cash Out|Bet/, { timeout: 30_000 });
    if ((await ctaLabel(page).textContent()) === "Cash Out") await cta(page).click();
    await expect(ctaLabel(page)).toHaveText("Bet", { timeout: 120_000 });

    /* the server's record of the bet, once the round is over */
    let mine: { bets: { status: string; payout: number; x: number | null; stake: number }[]; balance: number } | null = null;
    await expect.poll(async () => {
      const r = await request.get(`${SKY}/mine/${round.no}`, { headers: { Authorization: `Bearer ${player.token}` } });
      mine = r.ok() ? await r.json() : null;
      return mine && mine.bets.length === 1 && mine.bets[0]!.status !== "ACTIVE";
    }, { timeout: 120_000 }).toBe(true);
    const b = mine!.bets[0]!;
    expect(b.stake).toBe(5);
    expect(["WON", "LOST"]).toContain(b.status);
    const balance = await serverBalance(request, player.token);
    expect(balance).toBeCloseTo(95 + b.payout, 2);
    if (b.status === "WON") expect(b.payout).toBeCloseTo(Math.floor(5 * b.x! * 100 + 1e-6) / 100, 2);
    await expect(page.locator("#srBalance")).toHaveText(balance.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    await expectLedgerSound();
  });

  test("the same bet sent twice at once is one bet; a second bet on the same slot is refused; taking off closes betting", async ({ page, request }) => {
    const player = await fundedPlayer(page, 100);
    const auth = { Authorization: `Bearer ${player.token}` };
    const round = await bettingRound(request, 3000);
    const body = { round_no: round.no, panel: 0, stake: 3, idempotency_key: "sky:e2e-" + Date.now() };
    const [a, b] = await Promise.all([1, 2].map(() => request.post(`${SKY}/bet`, { headers: auth, data: body })));
    expect([a.status(), b.status()]).toEqual([200, 200]);
    expect((await a.json()).bet.bet_id).toBe((await b.json()).bet.bet_id);
    const other = await request.post(`${SKY}/bet`, { headers: auth, data: { ...body, idempotency_key: "sky:e2e-other-" + Date.now() } });
    expect(other.status()).toBe(409);
    expect((await other.json()).error).toBe("panel_busy");
    expect(await serverBalance(request, player.token)).toBe(97);

    /* both slots at once with different keys: both are taken, each once */
    const [c, d] = await Promise.all([
      request.post(`${SKY}/bet`, { headers: auth, data: { round_no: round.no, panel: 1, stake: 2, idempotency_key: "sky:e2e-c-" + Date.now() } }),
      request.post(`${SKY}/bet`, { headers: auth, data: { round_no: round.no, panel: 1, stake: 2, idempotency_key: "sky:e2e-d-" + Date.now() } }),
    ]);
    expect([c.status(), d.status()].sort()).toEqual([200, 409]);
    expect(await serverBalance(request, player.token)).toBe(95);

    /* after take-off the round takes no bets */
    const s = await state(request);
    await new Promise((r) => setTimeout(r, Math.max(0, round.starts_at - s.server_now + 300)));
    const late = await request.post(`${SKY}/bet`, { headers: auth, data: { round_no: round.no, panel: 1, stake: 1, idempotency_key: "sky:e2e-late-" + Date.now() } });
    expect(late.status()).toBe(409);
    expect((await late.json()).error).toMatch(/too_late|panel_busy/);
    await expectLedgerSound();
  });

  test("a finished round checks out in the browser: the seed matches its fingerprint and gives the crash point", async ({ page }) => {
    await openGame(page);
    await expect(page.locator("#srHistory .sr-hx").first()).toBeVisible({ timeout: 130_000 });
    await page.locator("#srHistory .sr-hx").first().click();
    await expect(page.locator("#srRound")).toBeVisible();
    await expect(page.locator("#srRoundCheck")).toHaveText(/^✓ Checked in your browser/, { timeout: 15_000 });
    await expect(page.locator("#srRoundSeed")).toHaveText(/^[0-9a-f]{64}$/);
  });

  test("nobody learns the crash early: the round's public answers carry no crash point, seed or end time before it ends", async ({ request }) => {
    const s = await state(request);
    expect(s.round.over).toBe(false);
    for (const k of ["crash", "seed", "ends_at"]) expect(Object.keys(s.round)).not.toContain(k);
    const info = await (await request.get(`${SKY}/round/${s.round.no}`)).json();
    for (const k of ["crash", "seed", "ends_at"]) expect(Object.keys(info)).not.toContain(k);
    const bets = await (await request.get(`${SKY}/bets/${s.round.no}`)).json();
    expect(JSON.stringify(bets)).not.toMatch(/"crash"|"seed"|auto/);
  });
});
