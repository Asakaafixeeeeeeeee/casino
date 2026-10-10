/* The critical path, end to end through the real site, accounts server and balance service:
   sign up → deposit (payment gateway approves) → place a real-money bet → win or lose → every balance agrees. */
import { expect, test } from "@playwright/test";
import { amountIn, cents, deposit, gatewayRequests, register, serverBalance, settle, trackErrors } from "./helpers";

test("sign up, deposit GHS 100, bet on Hi-Lo, and the page, the header and the server agree on the balance", async ({ page, request }) => {
  const errors = trackErrors(page);

  /* 1. sign up */
  const { phone, token } = await register(page, { currency: "GHS" });
  expect(await serverBalance(request, token)).toBe(0);

  /* 2. deposit: the balance service asks the gateway for exactly GHS 100.00 from the player's number */
  await deposit(page, 100);
  await expect(page.locator("#msg")).toContainText("Deposit of", { timeout: 30_000 });
  await expect(page.locator("#msg")).toContainText("successful");
  expect(await serverBalance(request, token)).toBe(100);
  const sent = (await gatewayRequests(request)).filter((r) => r.path === "/v1.1/transaction/process" && r.body.subscriber_number === "233" + phone.slice(1));
  expect(sent, "one payment prompt for one deposit").toHaveLength(1);
  expect(sent[0]!.body.amount).toBe("000000010000");
  /* the deposit's reference, DES + TheTeller's 12-digit number, is what TheTeller is sent to show, and what the
     deposit history shows */
  const txId = String(sent[0]!.body.transaction_id);
  expect(txId).toMatch(/^\d{12}$/);
  expect(sent[0]!.body.desc).toBe("DES" + txId);
  await expect(page.locator("#depHistory")).toContainText("ref DES" + txId);
  await page.goto("/index.html");
  await settle(page);
  await expect(page.locator("[data-account-balance]").first()).toContainText("100.00");

  /* 3. a real-money bet: the default stake (GHS 0.20) on whichever call can win */
  await page.goto("/hilo.html?mode=real");
  await settle(page);
  await expect(page.locator("#hlBalLabel")).toHaveText(/wallet/i);
  await expect(page.locator("#hlBalance")).toHaveText("100.00");
  const stake = amountIn(await page.locator("#hlAmount").innerText());
  expect(stake).toBe(0.2);
  await page.locator("[data-pick]:not([disabled])").first().click();
  await expect(page.locator("#hlConfirm")).toBeVisible();
  await page.locator("#hlConfirmYes").click();

  /* 4. win or lose */
  const msg = page.locator("#hlMsg");
  await expect(msg).toHaveText(/You Won|Sorry/, { timeout: 20_000 });
  const won = /You Won/.test(await msg.innerText());
  const payout = won ? amountIn(await msg.innerText()) : 0;
  if (won) expect(payout).toBeGreaterThan(stake);

  /* 5. one source of truth: the server, the game page and the site header show the same balance */
  const expected = cents(100 - stake + payout);
  await expect.poll(() => serverBalance(request, token)).toBe(expected);
  await expect(page.locator("#hlBalance")).toHaveText(expected.toFixed(2));
  await page.goto("/me.html");
  await settle(page);
  await expect(page.locator("[data-wallet-balance-num]").first()).toHaveText(expected.toLocaleString("en-GH", { minimumFractionDigits: 2 }));

  /* 6. the records show the deposit */
  const tx = await request.get("http://localhost:8781/api/user/transactions", { headers: { Authorization: `Bearer ${token}` } });
  const deposits = ((await tx.json()).transactions as { kind: string; amount: string | number; status: string }[]).filter((t) => t.kind === "deposit");
  expect(deposits.some((d) => Number(d.amount) === 100)).toBe(true);

  expect(errors, "no uncaught errors on any page").toEqual([]);
});

test("a withdrawal request holds the money at once and shows in the records", async ({ page, request }) => {
  const { token } = await register(page, { currency: "GHS" });
  await deposit(page, 100);
  await expect(page.locator("#msg")).toContainText("successful", { timeout: 30_000 });

  await page.goto("/withdraw.html");
  await settle(page);
  await page.locator("#wdAmount").fill("40");
  await expect(page.locator("#wdSubmit")).toBeEnabled();
  await page.locator("#wdSubmit").click();
  await expect(page.locator("#msg")).toContainText("requested", { timeout: 15_000 });
  expect(await serverBalance(request, token)).toBe(60);

  const tx = await request.get("http://localhost:8781/api/user/transactions", { headers: { Authorization: `Bearer ${token}` } });
  const list = (await tx.json()).transactions as { kind: string; amount: string | number; status: string }[];
  expect(list.some((t) => t.kind === "withdrawal" && Number(t.amount) === 40)).toBe(true);
});
