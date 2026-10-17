import assert from "node:assert/strict";
import test from "node:test";
import { adminReply, playerSend } from "../src/services/support.js";
import { aiRespondThread, aiSweep, composeReply } from "../src/services/supportAi.js";
import { setupWalletDb } from "./helpers/walletDb.js";

async function chat() {
  const env = await setupWalletDb();
  const thread = async () => (await env.db.query(`SELECT * FROM support_threads WHERE user_id = $1`, [env.userId])).rows[0];
  const messages = async () => (await env.db.query(
    `SELECT sender, admin_phone, body FROM support_messages WHERE thread_id = $1 ORDER BY id`, [(await thread()).id])).rows;
  return { env, thread, messages };
}

test("support AI: answers a safe question once, and never twice", async () => {
  const { env, thread, messages } = await chat();
  await playerSend(env.db, env.userId, { body: "Hello, what is the minimum deposit?" });
  const t = await thread();
  assert.equal(await aiRespondThread(env.db, t.id), "replied");
  assert.equal(await aiRespondThread(env.db, t.id), "skipped");
  assert.equal(await aiSweep(env.db, 0), 0);
  const m = await messages();
  assert.equal(m.length, 2);
  assert.equal(m[1].sender, "admin");
  assert.equal(m[1].admin_phone, "ai-assistant");
  assert.match(m[1].body, /₵/);
  assert.equal((await thread()).status, "OPEN", "never closes a conversation");
});

test("support AI: money complaints are handed to the team and never answered with a payment status", async () => {
  const r = await composeReply((await chat()).env.db, "I deposited 50 and it has not been credited, where is my money");
  assert.equal(r.kind, "handoff");
  assert.equal(r.sensitive, true);
  assert.doesNotMatch(r.body, /successful|credited to|has been paid/i);
});

test("support AI: an old complaint in the backlog is flagged for an admin, not answered", async () => {
  const { env, thread, messages } = await chat();
  await playerSend(env.db, env.userId, { body: "My withdrawal is still pending, I want a refund" });
  await env.db.query(`UPDATE support_messages SET created_at = now() - interval '3 days'`);
  assert.equal(await aiSweep(env.db, 0), 1);
  const t = await thread();
  assert.equal(t.needs_human, true);
  assert.equal((await messages()).length, 1, "no reply was sent");
  assert.equal(await aiSweep(env.db, 0), 0, "and it isn't picked up again");
});

test("support AI: an admin reply stops the assistant, and clears the flag", async () => {
  const { env, thread, messages } = await chat();
  await playerSend(env.db, env.userId, { body: "hello" });
  const t = await thread();
  await adminReply(env.db, "0200000000", t.id, { body: "Hi, an agent here." });
  assert.equal(await aiRespondThread(env.db, t.id), "skipped");
  assert.equal((await messages()).length, 2);
  await playerSend(env.db, env.userId, { body: "I was charged twice" });
  assert.equal(await aiRespondThread(env.db, t.id), "replied", "a new complaint gets the hand-off acknowledgement");
  assert.equal((await thread()).needs_human, true);
  await adminReply(env.db, "0200000000", t.id, { body: "Looking into it." });
  assert.equal((await thread()).needs_human, false);
});

test("support AI: asking to change the deposit number gets the lock explanation", async () => {
  const r = await composeReply((await chat()).env.db, "Can I change my phone number for deposits?");
  assert.equal(r.kind, "answer");
  assert.match(r.body, /can't be changed/);
});
