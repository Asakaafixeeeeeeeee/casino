import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { deposit, postMovement, SystemAccount } from "../src/services/balanceService.js";
import { assertStakeAllowed, clearGameControlsCache, clearPlayerRiskCache } from "../src/games/availability.js";
import { GameError } from "../src/games/catalog.js";
import { playRound } from "../src/games/rounds.js";
import { AdminError } from "../src/services/admin.js";
import {
  acceptRules, affectedPlayers, clearMoneyRulesCache, DEFAULT_RULES, getMoneyRules, hasAcceptedRules, moneyRulesHistory,
  moneyRulesOverview, MoneyRuleError, playthroughOf, saveMoneyRules,
} from "../src/services/moneyRules.js";
import { payWithdrawal, requestWithdrawal, withdrawalView, WithdrawalError } from "../src/services/withdrawals.js";
import { paymentsRouter, RULES_NOT_ACCEPTED_MESSAGE } from "../src/routes/payments.js";
import { adminRouter } from "../src/routes/admin.js";
import { TellerConfigurationError } from "../src/services/teller.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0209999001";
const PHONE = "0241234194";
type Env = Awaited<ReturnType<typeof setupWalletDb>>;
const isAdmin = (code: string) => (e: unknown) => e instanceof AdminError && e.code === code;
const isGame = (code: string) => (e: unknown) => e instanceof GameError && e.code === code;
const isWd = (code: string) => (e: unknown) => e instanceof WithdrawalError && e.code === code;
let n = 0;
const key = () => "mr-" + ++n + "-" + Date.now();

/* every test has its own database: forget the previous one's cached rules. Most tests start from the rules as they
   were before migration 041 switched the betting-session rule on (rule off, version 1), so each switch is tested */
async function fresh(asMigrated = false) {
  clearMoneyRulesCache();
  clearGameControlsCache();
  clearPlayerRiskCache();
  const env = await setupWalletDb();
  await env.db.query("UPDATE users SET phone = $1 WHERE id = $2", [PHONE, env.userId]);
  if (!asMigrated) {
    await env.db.query("UPDATE money_rules SET bet_rule_enabled = false, bet_rule_enabled_at = NULL, rules_version = 1, updated_by = NULL WHERE id = 1");
    await env.db.query("DELETE FROM money_rule_changes");
  }
  return env;
}
async function pay(env: Env, amount: number) {
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", amount, "deposit:" + key());
  await env.client.query("COMMIT");
}
async function move(env: Env, type: "BET_PLACED" | "BET_SETTLED", amount: number) {
  await env.client.query("BEGIN");
  await postMovement(env.client, {
    idempotencyKey: (type === "BET_PLACED" ? "bet:" : "win:") + key(),
    entryType: type,
    legs: type === "BET_PLACED"
      ? [{ userId: env.userId, currencyCode: "GHS", direction: "DEBIT", amountMajor: amount },
         { userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "CREDIT", amountMajor: amount }]
      : [{ userId: null, systemAccount: SystemAccount.House, currencyCode: "GHS", direction: "DEBIT", amountMajor: amount },
         { userId: env.userId, currencyCode: "GHS", direction: "CREDIT", amountMajor: amount }],
  });
  await env.client.query("COMMIT");
}

type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } };
function handlerOf(router: unknown, method: string, path: string) {
  const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} exists`);
  const stack = layer!.route!.stack;
  return stack[stack.length - 1]!.handle as (req: Request, res: Response, next: (e?: unknown) => void) => Promise<void>;
}
async function call(router: unknown, method: string, path: string, userId: string, body: Record<string, unknown> = {}) {
  const out: { status: number; body: Record<string, unknown> | undefined; failed: unknown } = { status: 200, body: undefined, failed: undefined };
  const res = {
    status(s: number) { out.status = s; return res; },
    json(b: Record<string, unknown>) { out.body = b; return res; },
    setHeader() {},
  };
  await handlerOf(router, method, path)({
    user: { id: userId, accountId: "account-1", phone: PHONE, status: "ACTIVE" }, body, query: {},
  } as unknown as Request, res as unknown as Response, (e) => { out.failed = e; });
  return out;
}

/* ---------------- settings ---------------- */

test("As migrated: minimum deposit GHS 135, the betting-session rule on (version 2), the deposit page wording", async () => {
  const { db } = await fresh(true);
  const r = await getMoneyRules(db, true);
  assert.equal(r.min_deposit, 135);
  assert.equal(r.bet_rule_enabled, true);
  assert.ok(r.bet_rule_enabled_at);
  assert.equal(r.withdraw_rule_enabled, false);
  assert.equal(r.withdraw_rule_multiple, 1);
  assert.equal(r.rules_version, 2, "everyone accepts the new conditions before their next deposit");
  for (const k of ["bet_rule_message", "withdraw_rule_message", "withdraw_info", "policy_heading", "policy_min_deposit", "policy_betting",
    "policy_funds", "policy_withdrawal", "policy_min_withdrawal", "policy_notice", "policy_accept"] as const) {
    assert.equal(r[k], DEFAULT_RULES[k], "the migration and the code agree on " + k);
  }
  const p = moneyRulesOverview(db);
  const items = (await p).preview.policy;
  assert.equal(items.heading, "BEFORE YOU PROCEED WITH YOUR DEPOSIT");
  assert.deepEqual(items.items.map((i) => i.label), ["Minimum Deposit", "Betting Eligibility", "Your Funds", "Withdrawal Processing", "Minimum Withdrawal", "Important Notice"]);
  assert.equal(items.items[0]!.text, "The minimum permissible deposit is GHS 135.00 per transaction, subject to a maximum of GHS 50,000.00.");
  assert.equal(items.items[4]!.text, "GHS 20.00.");
  assert.ok(!/admin/i.test(JSON.stringify(items)), "no reference to administrators on the customer page");
  assert.equal(items.accept, "I acknowledge that I have carefully reviewed, understood and accepted the applicable deposit, betting and withdrawal conditions.");
  assert.equal((await moneyRulesHistory(db)).changes.length, 1, "the switch is in the history");
});

test("Settings are validated; a refused save changes nothing and leaves no history", async () => {
  const { db } = await fresh();
  const bad: [Record<string, unknown>, string][] = [
    [{ min_deposit: 0 }, "invalid_min_deposit"], [{ min_deposit: 100001 }, "invalid_min_deposit"],
    [{ min_deposit: 60000 }, "invalid_min_deposit"], [{ min_deposit: "abc" }, "invalid_min_deposit"], [{ min_deposit: "" }, "invalid_min_deposit"],
    [{ bet_rule_days: 0 }, "invalid_bet_rule_days"], [{ bet_rule_days: 366 }, "invalid_bet_rule_days"], [{ bet_rule_days: 1.5 }, "invalid_bet_rule_days"],
    [{ withdraw_rule_multiple: -1 }, "invalid_withdraw_rule_multiple"], [{ withdraw_rule_multiple: 21 }, "invalid_withdraw_rule_multiple"],
    [{ bet_rule_enabled: "true" }, "invalid_bet_rule_enabled"], [{ withdraw_rule_enabled: 1 }, "invalid_withdraw_rule_enabled"],
    [{ bet_rule_message: "   " }, "invalid_bet_rule_message"], [{ withdraw_rule_message: "x".repeat(1001) }, "invalid_withdraw_rule_message"],
    [{ withdraw_info: 42 }, "invalid_withdraw_info"],
  ];
  for (const [input, code] of bad) await assert.rejects(() => saveMoneyRules(db, ADMIN, input), isAdmin(code), JSON.stringify(input));
  const r = await getMoneyRules(db, true);
  assert.equal(r.min_deposit, 135);
  assert.equal(r.rules_version, 1);
  assert.equal((await moneyRulesHistory(db)).changes.length, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM admin_actions WHERE action = 'money_rules.update'`)).rows[0].n, 0);
  /* edges are fine */
  await saveMoneyRules(db, ADMIN, { min_deposit: 1, bet_rule_days: 365, withdraw_rule_multiple: 0, bet_rule_message: "y".repeat(1000) });
  await saveMoneyRules(db, ADMIN, { min_deposit: 50000, bet_rule_days: 1, withdraw_rule_multiple: 20 });
});

test("Each save is audited (history + admin log); material changes bump the version, wording doesn't", async () => {
  const { db } = await fresh();
  /* wording only: no new version */
  const w = await saveMoneyRules(db, ADMIN, { bet_rule_message: "Deposit GHS {min} within {days} days to bet." });
  assert.deepEqual(w.changed, ["bet_rule_message"]);
  assert.equal(w.version_bumped, false);
  assert.equal(w.settings.rules_version, 1);
  assert.equal(w.settings.updated_by, ADMIN);

  /* nothing changed: nothing written */
  const same = await saveMoneyRules(db, ADMIN, { bet_rule_message: "Deposit GHS {min} within {days} days to bet." });
  assert.deepEqual(same.changed, []);

  /* material: min deposit and a switch */
  const m = await saveMoneyRules(db, ADMIN, { min_deposit: 150, bet_rule_enabled: true });
  assert.equal(m.version_bumped, true);
  assert.equal(m.settings.rules_version, 2);
  assert.ok(m.settings.bet_rule_enabled_at, "switching on records when");
  assert.equal(m.settings.withdraw_rule_enabled_at, null);
  for (const input of [{ bet_rule_days: 14 }, { withdraw_rule_enabled: true }, { withdraw_rule_multiple: 2 }]) {
    const before = (await getMoneyRules(db, true)).rules_version;
    assert.equal((await saveMoneyRules(db, ADMIN, input)).settings.rules_version, before + 1, JSON.stringify(input));
  }
  assert.equal((await saveMoneyRules(db, ADMIN, { withdraw_info: "Ask customer care." })).settings.rules_version, 5, "withdraw info is wording");

  const h = (await moneyRulesHistory(db)).changes;
  assert.equal(h.length, 6);
  assert.equal(h[0]!.admin, ADMIN);
  assert.deepEqual(h[0]!.changes.withdraw_info.after, "Ask customer care.");
  const material = h.find((c) => c.changes.min_deposit)!;
  assert.deepEqual(material.changes.min_deposit, { before: 135, after: 150 });
  assert.deepEqual(material.changes.bet_rule_enabled, { before: false, after: true });
  assert.deepEqual(material.changes.rules_version, { before: 1, after: 2 });
  const log = (await db.query(`SELECT admin, target, details FROM admin_actions WHERE action = 'money_rules.update' ORDER BY id`)).rows;
  assert.equal(log.length, 6);
  assert.equal(log[1].admin, ADMIN);
  const details = typeof log[1].details === "string" ? JSON.parse(log[1].details) : log[1].details;
  assert.deepEqual(details.changes.min_deposit, { before: 135, after: 150 });
  const o = await moneyRulesOverview(db);
  assert.equal(o.preview.bet_rule.message, "Deposit GHS 150.00 within 14 days to bet.", "players read the message with the values filled in");
  /* the conditions players accept are material; the heading isn't */
  const v = (await getMoneyRules(db, true)).rules_version;
  assert.equal((await saveMoneyRules(db, ADMIN, { policy_heading: "BEFORE YOU DEPOSIT" })).settings.rules_version, v);
  assert.equal((await saveMoneyRules(db, ADMIN, { policy_betting: "New betting conditions." })).settings.rules_version, v + 1);
  await assert.rejects(() => saveMoneyRules(db, ADMIN, { policy_accept: " " }), isAdmin("invalid_policy_accept"));
});

test("Only admins reach the settings: the routes sit behind the admin router's guard", () => {
  const routes = (adminRouter({} as never) as unknown as { stack: Layer[] }).stack;
  const guard = routes.findIndex((l) => !l.route);
  for (const [path, m] of [["/money-rules", "get"], ["/money-rules", "post"], ["/money-rules/affected", "get"], ["/money-rules/history", "get"]] as const) {
    const i = routes.findIndex((l) => l.route?.path === path && l.route.methods[m]);
    assert.ok(guard >= 0 && i > guard, `${m} ${path} is behind authenticate + requireAdmin`);
  }
});

/* ---------------- minimum deposit and acceptance ---------------- */

test("Deposits: below the live minimum is refused with it; at the minimum only after the rules are accepted", async () => {
  const env = await fresh();
  const router = paymentsRouter(env.db);
  for (const path of ["/teller/checkout", "/teller/momo"]) {
    const low = await call(router, "post", path, env.userId, { amount: 134, currency: "GHS", idempotency_key: "deposit:" + key(), account_number: "233241234194", network: "MTN" });
    assert.equal(low.status, 400, path);
    assert.equal(low.body!.error, "invalid_amount");
    assert.match(String(low.body!.message), /GHS 135/);
    /* at the minimum, not accepted yet */
    const notYet = await call(router, "post", path, env.userId, { amount: 135, currency: "GHS", idempotency_key: "deposit:" + key(), account_number: "233241234194", network: "MTN" });
    assert.equal(notYet.status, 409, path);
    assert.deepEqual(notYet.body, { error: "rules_not_accepted", message: RULES_NOT_ACCEPTED_MESSAGE, rules_version: 1 });
  }
  assert.equal((await env.db.query(`SELECT count(*)::int AS n FROM payment_intents`)).rows[0].n, 0, "nothing was started");

  /* the rules box: not accepted, then accepted */
  const before = await call(router, "get", "/rules", env.userId);
  assert.equal(before.body!.accepted, false);
  const acc = await call(router, "post", "/accept-rules", env.userId, { rules_version: 1, idempotency_key: "accept:" + key() });
  assert.equal(acc.status, 200);
  assert.equal(acc.body!.rules_version, 1);
  assert.equal((await call(router, "get", "/rules", env.userId)).body!.accepted, true);

  /* accepted: the amount and acceptance checks pass (this test has no TheTeller account, so it stops there) */
  const ok = await call(router, "post", "/teller/checkout", env.userId, { amount: 135, currency: "GHS", idempotency_key: "deposit:" + key() });
  assert.ok(ok.failed instanceof TellerConfigurationError, "past the minimum and the rules, on to TheTeller");

  /* a material change: accept again; a page still showing the old version is told the rules changed */
  await saveMoneyRules(env.db, ADMIN, { min_deposit: 200 });
  assert.equal(await hasAcceptedRules(env.db, env.userId), false);
  const again = await call(router, "post", "/teller/checkout", env.userId, { amount: 200, currency: "GHS", idempotency_key: "deposit:" + key() });
  assert.equal(again.status, 409);
  assert.equal(again.body!.rules_version, 2);
  const stale = await call(router, "post", "/accept-rules", env.userId, { rules_version: 1, idempotency_key: "accept:" + key() });
  assert.equal(stale.status, 409);
  assert.equal(stale.body!.error, "rules_changed");
  await assert.rejects(() => acceptRules(env.db, env.userId, 1), (e: unknown) => e instanceof MoneyRuleError && e.code === "rules_changed");
  await acceptRules(env.db, env.userId, 2);
  assert.equal(await hasAcceptedRules(env.db, env.userId), true);
  /* the new minimum is the one enforced */
  const under = await call(router, "post", "/teller/checkout", env.userId, { amount: 150, currency: "GHS", idempotency_key: "deposit:" + key() });
  assert.equal(under.status, 400);
  assert.match(String(under.body!.message), /GHS 200/);
  /* a wording change doesn't ask again */
  await saveMoneyRules(env.db, ADMIN, { withdraw_info: "New wording only." });
  assert.equal(await hasAcceptedRules(env.db, env.userId), true);
});

test("The payment config tells pages the live minimum and the rules", async () => {
  const env = await fresh();
  await saveMoneyRules(env.db, ADMIN, { min_deposit: 140, bet_rule_enabled: true, bet_rule_days: 7, withdraw_rule_enabled: true, withdraw_rule_multiple: 1.5 });
  const c = await call(paymentsRouter(env.db), "get", "/config", env.userId);
  const body = c.body as { minDeposit: number; maxDeposit: number; rules: ReturnType<typeof Object> };
  assert.equal(body.minDeposit, 140);
  assert.equal(body.maxDeposit, 50000);
  const rules = (c.body as { rules: { rules_version: number; bet_rule: { enabled: boolean; kind: string; message: string }; policy: { items: { label: string; text: string }[] }; withdraw_rule: { enabled: boolean; multiple: number }; withdraw_info: string } }).rules;
  assert.equal(rules.rules_version, 2);
  assert.deepEqual([rules.bet_rule.enabled, rules.bet_rule.kind], [true, "session"]);
  assert.match(rules.bet_rule.message, /minimum GHS 140\.00/);
  assert.match(rules.policy.items[0]!.text, /GHS 140\.00 per transaction/);
  assert.deepEqual([rules.withdraw_rule.enabled, rules.withdraw_rule.multiple], [true, 1.5]);
  assert.ok(rules.withdraw_info.length > 20);
});

/* ---------------- betting eligibility ---------------- */

test("Bet rule OFF: any funded player bets as before", async () => {
  const env = await fresh();
  await pay(env, 50);
  await assertStakeAllowed(env.db, "volta-coin", 5, env.userId);
  const r = await playRound(env.db, env.userId, "volta-coin", { stake: 5, choice: { pick: "HEADS" }, idempotency_key: "round:" + key() });
  assert.equal(r.stake, 5);
});

test("Bet rule ON: only deposited funds can be staked, never winnings; nothing is deducted; winnings stay withdrawable", async () => {
  const env = await fresh();
  const router = paymentsRouter(env.db);
  await pay(env, 100);
  await move(env, "BET_PLACED", 100);    /* the deposit is fully staked... */
  await move(env, "BET_SETTLED", 40);    /* ...and 40 won: only winnings left */
  await saveMoneyRules(env.db, ADMIN, { bet_rule_enabled: true });
  const before = await env.balance();
  assert.deepEqual((await call(router, "get", "/rules", env.userId)).body!.funds, { balance: 40, session: 0, winnings: 40 });

  /* every game passes the same check before its stake is taken: winnings can't be staked */
  await assert.rejects(() => assertStakeAllowed(env.db, "volta-coin", 5, env.userId), (e: unknown) =>
    isGame("deposit_required")(e) && (e as GameError).status === 403 &&
    (e as GameError).message === "Only deposited funds can be staked. Your session funds: GHS 0.00. Your winnings of GHS 40.00 cannot be staked, but they remain yours to withdraw at any time. A qualifying deposit (minimum GHS 135.00) activates a new betting session.");
  await assert.rejects(() => playRound(env.db, env.userId, "volta-coin", { stake: 5, choice: { pick: "HEADS" }, idempotency_key: "round:" + key() }), isGame("deposit_required"));
  assert.equal(await env.balance(), before, "a refused bet never touches the balance");

  /* the player shows up as needing a new deposit */
  const aff = await affectedPlayers(env.db);
  assert.equal(aff.bet_rule.players.length, 1);
  assert.deepEqual([aff.bet_rule.players[0]!.balance, (aff.bet_rule.players[0] as { winnings: number }).winnings], [40, 40]);

  /* a new deposit: session funds to stake, up to their amount only */
  await pay(env, 135);
  assert.deepEqual((await call(router, "get", "/rules", env.userId)).body!.funds, { balance: 175, session: 135, winnings: 40 });
  await assert.rejects(() => assertStakeAllowed(env.db, "volta-coin", 150, env.userId), isGame("deposit_required"), "a stake reaching into winnings is refused");
  await assertStakeAllowed(env.db, "volta-coin", 135, env.userId);
  const r = await playRound(env.db, env.userId, "volta-coin", { stake: 5, choice: { pick: "HEADS" }, idempotency_key: "round:" + key() });
  assert.equal(r.stake, 5);
  assert.equal((await affectedPlayers(env.db)).bet_rule.players.length, 0);
  /* stakes always use the deposited money first, so the winnings are untouched and withdrawable */
  const view = await withdrawalView(env.db, env.userId);
  assert.ok(view.withdrawable >= 40, "the 40 of winnings are still withdrawable");
  await requestWithdrawal(env.db, { id: env.userId, phone: PHONE }, 40, "wd-" + key());

  /* switched off: the whole balance can be staked again */
  await saveMoneyRules(env.db, ADMIN, { bet_rule_enabled: false });
  await assertStakeAllowed(env.db, "volta-coin", 5, env.userId);
});

/* ---------------- withdrawal play-through ---------------- */

test("Play-through: the formula, never retroactive, winnings never held", async () => {
  const env = await fresh();
  await pay(env, 200);                    /* before the rule: never held */
  await saveMoneyRules(env.db, ADMIN, { withdraw_rule_enabled: true, withdraw_rule_multiple: 1 });
  let p = await playthroughOf(env.db, env.userId);
  assert.equal(p.held, 0, "deposits made before the rule went on aren't held");

  await pay(env, 150);                    /* qualifying */
  p = await playthroughOf(env.db, env.userId);
  assert.deepEqual([p.balance, p.deposits, p.staked, p.held, p.to_bet], [350, 150, 0, 150, 150]);

  await move(env, "BET_PLACED", 40);
  p = await playthroughOf(env.db, env.userId);
  assert.deepEqual([p.balance, p.staked, p.held, p.to_bet], [310, 40, 110, 110], "held = 1 x 150 - 40 staked");

  await move(env, "BET_SETTLED", 80);     /* a win */
  p = await playthroughOf(env.db, env.userId);
  assert.deepEqual([p.balance, p.winnings, p.held, p.withdrawable_by_rule], [390, 80, 110, 280]);

  /* the winnings are withdrawable in full while money is held */
  const view = await withdrawalView(env.db, env.userId);
  assert.deepEqual([view.withdrawable, view.held, view.to_bet], [80, 110, 110]);
  assert.match(String(view.playthrough.message), /GHS 110 of your balance is held until you place GHS 110 more in bets/);
  await requestWithdrawal(env.db, { id: env.userId, phone: PHONE }, 80, "wd-" + key());
  assert.equal(await env.balance(), 310, "nothing else was deducted");

  /* over balance - held: refused with the admin's message (here: 310 balance, 110 held, so at most 200; 250 asked) */
  await assert.rejects(() => requestWithdrawal(env.db, { id: env.userId, phone: PHONE }, 250, "wd-" + key()), (e: unknown) =>
    isWd("playthrough_required")(e) && /GHS 110 of your balance is held until you place GHS 110 more/.test((e as Error).message));
  assert.equal(await env.balance(), 310, "a refused request deducts nothing");

  /* the affected list shows the held amount */
  const aff = await affectedPlayers(env.db);
  assert.equal(aff.withdraw_rule.players.length, 1);
  assert.deepEqual(aff.withdraw_rule.players[0], {
    id: env.userId, name: "tester", phone: PHONE, balance: 310, held: 110, to_bet: 110, deposits: 150, staked: 40,
    last_deposit: 150, last_deposit_at: (aff.withdraw_rule.players[0] as { last_deposit_at: string }).last_deposit_at,
  });

  /* playing it through releases the hold */
  await move(env, "BET_PLACED", 110);
  p = await playthroughOf(env.db, env.userId);
  assert.equal(p.held, 0);
  assert.equal(p.to_bet, 0);
});

test("Play-through can't hold winnings even when the deposit was mostly lost (multiple 2)", async () => {
  const env = await fresh();
  await saveMoneyRules(env.db, ADMIN, { withdraw_rule_enabled: true, withdraw_rule_multiple: 2 });
  await pay(env, 150);
  await move(env, "BET_PLACED", 140);     /* lost */
  await move(env, "BET_PLACED", 10);
  await move(env, "BET_SETTLED", 50);     /* won */
  const p = await playthroughOf(env.db, env.userId);
  assert.deepEqual([p.balance, p.winnings, p.held], [50, 50, 0], "150 still to bet by the multiple, but none of the 50 is deposited money");
  await requestWithdrawal(env.db, { id: env.userId, phone: PHONE }, 50, "wd-" + key());
  assert.equal(await env.balance(), 0);
});

test("Play-through resets after a paid withdrawal, and is off by default", async () => {
  const env = await fresh();
  await pay(env, 150);
  assert.equal((await playthroughOf(env.db, env.userId)).held, 0, "off by default: nothing held");
  await saveMoneyRules(env.db, ADMIN, { withdraw_rule_enabled: true });
  await pay(env, 150);
  await move(env, "BET_SETTLED", 30);
  assert.equal((await playthroughOf(env.db, env.userId)).held, 150);
  const w = await requestWithdrawal(env.db, { id: env.userId, phone: PHONE }, 30, "wd-" + key());
  await payWithdrawal(env.db, w.id, ADMIN);
  assert.equal((await playthroughOf(env.db, env.userId)).held, 0, "deposits before the last paid withdrawal no longer count");
  await pay(env, 140);
  const p = await playthroughOf(env.db, env.userId);
  assert.deepEqual([p.deposits, p.held], [140, 140], "a new deposit after it does");
  /* switching the rule off releases everything at once */
  await saveMoneyRules(env.db, ADMIN, { withdraw_rule_enabled: false });
  assert.equal((await playthroughOf(env.db, env.userId)).held, 0);
  assert.equal((await affectedPlayers(env.db)).withdraw_rule.players.length, 0);
});
