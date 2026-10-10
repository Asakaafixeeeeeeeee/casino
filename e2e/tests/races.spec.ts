/* Concurrency on the real stack (real Postgres, real row locks): the money races found in the audit, replayed over
   HTTP. Each test ends by checking the ledger in SQL: no negative balance, every journal balanced, cache = ledger. */
import { expect, test } from "@playwright/test";
import { adminSession, API, expectLedgerSound, fundedPlayer, play, realPostgres, register, serverBalance, sql } from "./helpers";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

test.beforeAll(() => {
  expect(realPostgres(), "the race tests need the real-Postgres stack (unset E2E_DB)").toBe(true);
});

test("bets, a withdrawal and a conversion fired together never overdraw, and the ledger stays exact", async ({ page, request }) => {
  const { token } = await fundedPlayer(page);
  const jobs = [
    ...Array.from({ length: 25 }, (_, i) => play(request, token, "volta-coin", { stake: 3, choice: { pick: i % 2 ? "HEADS" : "TAILS" }, idempotency_key: `round:mix-${Date.now()}-${i}` })),
    request.post(`${API}/api/user/withdraw`, { headers: auth(token), data: { amount: 50, idempotency_key: "withdraw:mix-" + Date.now() } }).then((r) => ({ status: r.status(), body: {} })),
    request.post(`${API}/api/user/convert`, { headers: auth(token), data: { from: "GHS", to: "USD", amount: 30, idempotency_key: "convert:mix-" + Date.now() } }).then((r) => ({ status: r.status(), body: {} })),
  ];
  const results = await Promise.all(jobs);
  for (const r of results) expect([200, 201, 409], JSON.stringify(r)).toContain(r.status);
  expect(await serverBalance(request, token)).toBeGreaterThanOrEqual(0);
  await expectLedgerSound();
});

test("the same withdrawal key sent five times at once is one withdrawal", async ({ page, request }) => {
  const { token } = await fundedPlayer(page);
  const key = "withdraw:same-" + Date.now();
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    request.post(`${API}/api/user/withdraw`, { headers: auth(token), data: { amount: 30, idempotency_key: key } })));
  expect(results.map((r) => r.status()), "every copy gets the withdrawal back, none an error").toEqual([201, 201, 201, 201, 201]);
  const ids = new Set(await Promise.all(results.map(async (r) => (await r.json()).id)));
  expect(ids.size, "one withdrawal").toBe(1);
  expect(await serverBalance(request, token), "charged once").toBe(70);
  await expectLedgerSound();
});

test("deposits started at once can't slip past a daily deposit limit", async ({ page, request }) => {
  const { phone, token } = await register(page);
  const set = await request.post(`${API}/api/user/limits`, { headers: auth(token), data: { daily: 200, idempotency_key: "limits-" + Date.now() } });
  expect(set.status()).toBe(200);
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    request.post(`${API}/api/payments/teller/momo`, { headers: auth(token),
      data: { amount: 200, currency: "GHS", network: "MTN", account_number: "233" + phone.slice(1), idempotency_key: `deposit:limit-${Date.now()}-${i}` } })));
  const started = results.filter((r) => r.status() === 202);
  expect(started.length, "only one GHS 200 deposit fits a GHS 200 daily limit").toBe(1);
  for (const r of results.filter((x) => x.status() !== 202)) expect(r.status()).toBe(409);
  await expect.poll(() => serverBalance(request, token), { timeout: 15_000 }).toBe(200);
  await expectLedgerSound();
});

test("an admin's Pay and Reject on the same withdrawal at once: it's either paid or refunded, never both", async ({ page, request }) => {
  const { token } = await fundedPlayer(page);
  const w = await request.post(`${API}/api/user/withdraw`, { headers: auth(token), data: { amount: 40, idempotency_key: "withdraw:race-" + Date.now() } });
  expect(w.status()).toBe(201);
  const { id } = await w.json();

  /* the admin's number is in ADMIN_PHONES (playwright.config.ts) */
  const adminToken = await adminSession(request);
  const [pay, reject] = await Promise.all([
    request.post(`${API}/api/admin/withdrawals/${id}/pay`, { headers: auth(adminToken), data: { idempotency_key: "pay-" + id } }),
    request.post(`${API}/api/admin/withdrawals/${id}/reject`, { headers: auth(adminToken), data: { reason: "race test reject", idempotency_key: "rej-" + id } }),
  ]);
  const [row] = await sql<{ status: string }>(`SELECT status FROM withdrawals WHERE id = $1`, [id]);
  const balance = await serverBalance(request, token);
  if (row!.status === "PAID") expect(balance, `paid (pay ${pay.status()}, reject ${reject.status()}): no refund as well`).toBe(60);
  else expect([row!.status, balance], `refunded (pay ${pay.status()}, reject ${reject.status()}): never paid out`).toEqual(["DECLINED", 100]);
  const journals = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM ledger_journal WHERE idempotency_key IN ($1, $2)`, [`payout:${id}`, `refund:${id}`]);
  expect(journals[0]!.n, "exactly one of payout / refund").toBe(1);
  await expectLedgerSound();
});
