import assert from "node:assert/strict";
import test from "node:test";
import { deposit } from "../src/services/balanceService.js";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { AdminError, setUserStatus } from "../src/services/admin.js";
import { accountRestriction, controlAccount, restrictedUsers } from "../src/services/accountControl.js";
import { expireBlocks } from "../src/services/blockExpiry.js";
import { buyLottoTicket, currentLottoDraw, lottoNumbersFromSeed, releaseLottoDraw } from "../src/games/lotto.js";
import { latestLottoResult } from "../src/games/lottoWinners.js";
import { lottoKey } from "../src/services/lottoAdmin.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0241112222";
const ENV = { ADMIN_PHONES: ADMIN } as NodeJS.ProcessEnv; // no accounts server here: the log-in change reports login_synced false
const code = (c: string) => (e: unknown) => e instanceof AdminError && e.code === c;

async function world() {
  const env = await setupWalletDb();
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 80, "deposit:control-seed");
  await env.client.query("COMMIT");
  await env.db.query(`UPDATE users SET phone = '0245556666' WHERE id = $1`, [env.userId]);
  const user = async () => (await env.db.query(`SELECT status::text AS status, restriction, restriction_reason, blocked_until FROM users WHERE id = $1`, [env.userId])).rows[0];
  const ledger = async () => (await env.db.query(`SELECT count(*)::int AS n FROM ledger_entries WHERE user_id = $1`, [env.userId])).rows[0].n;
  return { ...env, user, ledger };
}

test("Block: needs a reason, can be temporary, shows under Blocked users, and ends by itself", async () => {
  const w = await world();
  await assert.rejects(controlAccount(w.db, ADMIN, w.userId, { action: "block" }, ENV), code("reason_needed"));
  await assert.rejects(controlAccount(w.db, ADMIN, w.userId, { action: "block", reason: "Chargeback check", until: "2000-01-01" }, ENV), code("invalid_until"));
  const out = await controlAccount(w.db, ADMIN, w.userId, { action: "block", reason: "Chargeback check", hours: 2 }, ENV);
  assert.equal(out.status, "SUSPENDED");
  assert.ok(out.until && new Date(out.until).getTime() > Date.now());
  const list = await restrictedUsers(w.db, "blocked", "");
  assert.equal(list.users.length, 1);
  assert.equal(list.users[0]!.reason, "Chargeback check");
  assert.equal(list.users[0]!.phone, "0245556666");
  assert.equal(list.counts.blocked, 1);
  /* the period ends: unblocked by itself, recorded */
  await w.db.query(`UPDATE users SET blocked_until = now() - interval '1 minute' WHERE id = $1`, [w.userId]);
  assert.equal(await expireBlocks(w.db), 1);
  assert.equal((await w.user()).status, "ACTIVE");
  assert.deepEqual((await accountRestriction(w.db, w.userId)).history.map((h) => h.action), ["expire", "block"]);
});

test("Ban: permanent until lifted with a review note; admins can't be banned; the Players page can't undo it", async () => {
  const w = await world();
  await assert.rejects(controlAccount(w.db, ADMIN, w.userId, { action: "ban", reason: "" }, ENV), code("reason_needed"));
  const out = await controlAccount(w.db, ADMIN, w.userId, { action: "ban", reason: "Fraudulent deposits" }, ENV);
  assert.deepEqual([out.restriction, out.status, out.login_synced], ["BANNED", "CLOSED", false]);
  await assert.rejects(setUserStatus(w.db, ADMIN, w.userId, { status: "ACTIVE" }), code("not_allowed"));
  assert.equal((await restrictedUsers(w.db, "banned", "fraud")).users.length, 0, "search is by player, not reason");
  assert.equal((await restrictedUsers(w.db, "banned", "0245")).users.length, 1);
  await assert.rejects(controlAccount(w.db, ADMIN, w.userId, { action: "lift_ban" }, ENV), code("reason_needed"));
  await controlAccount(w.db, ADMIN, w.userId, { action: "lift_ban", reason: "Reviewed: documents fine" }, ENV);
  assert.equal((await w.user()).status, "ACTIVE");
  /* an admin account */
  await w.db.query(`UPDATE users SET phone = $2 WHERE id = $1`, [w.userId, ADMIN]);
  await assert.rejects(controlAccount(w.db, ADMIN, w.userId, { action: "ban", reason: "test test" }, ENV), code("not_allowed"));
});

test("Delete: needs a typed confirmation, keeps the balance and every record, and can be restored", async () => {
  const w = await world();
  const before = await w.ledger();
  await controlAccount(w.db, ADMIN, w.userId, { action: "deactivate", reason: "Asked to close" }, ENV);
  assert.equal((await restrictedUsers(w.db, "deleted", "")).users[0]!.restriction, "DEACTIVATED");
  await assert.rejects(controlAccount(w.db, ADMIN, w.userId, { action: "delete", reason: "Duplicate account" }, ENV), code("confirm_needed"));
  await controlAccount(w.db, ADMIN, w.userId, { action: "delete", reason: "Duplicate account", confirm: "DELETE" }, ENV);
  const listed = (await restrictedUsers(w.db, "deleted", "")).users[0]!;
  assert.equal(listed.restriction, "DELETED");
  assert.equal(listed.balance, 80, "the money is still there");
  assert.equal(await w.ledger(), before, "no record removed");
  await controlAccount(w.db, ADMIN, w.userId, { action: "restore" }, ENV);
  assert.equal((await w.user()).status, "ACTIVE");
  assert.equal((await w.user()).restriction, null);
  const audit = (await w.db.query(`SELECT action FROM admin_actions WHERE target = $1 ORDER BY id`, [w.userId])).rows.map((r) => r.action);
  assert.deepEqual(audit, ["account.deactivate", "account.delete", "account.restore"]);
});

test("Players -> Suspend is a block with no end date, and Activate lifts it", async () => {
  const w = await world();
  await setUserStatus(w.db, ADMIN, w.userId, { status: "SUSPENDED", reason: "Under review" });
  assert.equal((await restrictedUsers(w.db, "blocked", "")).users[0]!.until, null);
  await setUserStatus(w.db, ADMIN, w.userId, { status: "ACTIVE" });
  assert.equal((await w.user()).restriction, null);
});

test("Lotto Key: closed draws show the locked numbers the seed gives, and opening it is audited; the latest result is public only once published", async () => {
  const env = await setupWalletDb();
  const NOON = Date.UTC(2027, 0, 10, 12, 0), DRAW = Date.UTC(2027, 0, 10, 19, 0);
  await env.client.query("BEGIN");
  await deposit(env.client, env.userId, "GHS", 100, "deposit:key-seed");
  await env.client.query("COMMIT");
  await env.db.query(`UPDATE lotto_settings SET real_money = true`);
  const draw = (await currentLottoDraw(env.db, NOON))!;
  await buyLottoTicket(env.db, env.userId, { picks: [1, 2], stake: 1, idempotency_key: "lotto:key-1" }, { now: NOON });
  assert.equal((await latestLottoResult(env.db)).result, null);
  /* after the close (the key reads "now", so move the draw into the past) */
  await env.db.query(`UPDATE lotto_draws SET closes_at = now() - interval '2 minutes', draw_at = now() - interval '1 minute', opens_at = now() - interval '1 day' WHERE id = $1`, [draw.id]);
  const key = await lottoKey(env.db, ADMIN);
  const k = key.pending.find((d) => d.id === Number(draw.id))!;
  assert.deepEqual(k.numbers, lottoNumbersFromSeed(draw.seed, Number(draw.id)));
  assert.equal(k.locked, true);
  await lottoKey(env.db, ADMIN);
  assert.equal((await env.db.query(`SELECT count(*)::int AS n FROM admin_actions WHERE action = 'lotto.preview'`)).rows[0].n, 1, "recorded once");
  assert.equal((await latestLottoResult(env.db)).result, null, "not public before publishing");
  await releaseLottoDraw(env.db, draw.id, ADMIN, DRAW + 864e5);
  const pub = (await latestLottoResult(env.db)).result!;
  assert.equal(pub.id, Number(draw.id));
  assert.deepEqual(pub.numbers, k.numbers);
});
