import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../src/app.js";
import { ensureWalletAccount } from "../src/services/accountLink.js";
import { auditLog } from "../src/services/admin.js";
import {
  adminReply, adminThread, adminThreads, MAX_BODY, playerSend, playerThread, playerUnread, RATE_LIMIT, setThreadStatus,
  SupportError, unreadThreads,
} from "../src/services/support.js";
import { suspendedMayDo } from "../src/middleware/authenticate.js";
import { setupWalletDb } from "./helpers/walletDb.js";

const ADMIN = "0241112222";

test("A conversation: the player writes, the team sees it unread, replies, and the player sees the reply", async () => {
  const { db, userId } = await setupWalletDb();
  assert.deepEqual(await playerThread(db, userId), { thread: null, messages: [] }, "nothing until the player writes");
  const sent = await playerSend(db, userId, { body: "  My deposit of 50 cedis   hasn't shown up  " });
  assert.equal(sent.message.body, "My deposit of 50 cedis hasn't shown up", "spacing tidied");
  assert.equal(sent.message.from, "you");

  assert.equal(await unreadThreads(db), 1);
  const inbox = (await adminThreads(db)).threads;
  assert.deepEqual([inbox.length, inbox[0]!.unread, inbox[0]!.username, inbox[0]!.last_from], [1, 1, "tester", "player"]);
  const open = await adminThread(db, inbox[0]!.id);
  assert.equal(open.messages.length, 1);
  assert.equal(await unreadThreads(db), 0, "opening it marks it seen");

  await adminReply(db, ADMIN, inbox[0]!.id, { body: "Thanks — what's the reference number on your Deposit page?" });
  assert.deepEqual(await playerUnread(db, userId), { unread: 1 });
  const mine = await playerThread(db, userId);
  assert.deepEqual(mine.messages.map((m) => m.from), ["you", "support"]);
  assert.ok(!("admin" in mine.messages[1]!), "players never see which admin replied");
  assert.deepEqual(await playerUnread(db, userId), { unread: 0 }, "reading the thread clears the dot");
  assert.equal((await adminThread(db, inbox[0]!.id)).messages[1]!.admin, ADMIN, "the team does see who replied");
});

test("Polling with `after` returns only what's new", async () => {
  const { db, userId } = await setupWalletDb();
  const a = await playerSend(db, userId, { body: "hello" });
  const tid = (await adminThreads(db)).threads[0]!.id;
  assert.equal((await playerThread(db, userId, { after: a.message.id })).messages.length, 0);
  await adminReply(db, ADMIN, tid, { body: "Hi! How can we help?" });
  const fresh = await playerThread(db, userId, { after: a.message.id });
  assert.deepEqual(fresh.messages.map((m) => m.body), ["Hi! How can we help?"]);
  const last = fresh.messages[0]!.id;
  await playerSend(db, userId, { body: "my withdrawal" });
  assert.deepEqual((await adminThread(db, tid, { after: last })).messages.map((m) => m.body), ["my withdrawal"]);
});

test("Empty, over-long and flooding messages are refused", async () => {
  const { db, userId } = await setupWalletDb();
  await assert.rejects(() => playerSend(db, userId, { body: "   \n  " }), (e: unknown) => e instanceof SupportError && e.code === "empty");
  await assert.rejects(() => playerSend(db, userId, { body: "x".repeat(MAX_BODY + 1) }), (e: unknown) => e instanceof SupportError && e.code === "too_long");
  for (let i = 0; i < RATE_LIMIT; i++) await playerSend(db, userId, { body: "message " + i });
  await assert.rejects(() => playerSend(db, userId, { body: "one more" }), (e: unknown) => e instanceof SupportError && e.status === 429);
  // the team is never rate limited
  const tid = (await adminThreads(db)).threads[0]!.id;
  for (let i = 0; i < RATE_LIMIT + 5; i++) await adminReply(db, ADMIN, tid, { body: "reply " + i });
});

test("Closing a solved conversation; the player writing again reopens it", async () => {
  const { db, userId } = await setupWalletDb();
  await playerSend(db, userId, { body: "How do I withdraw?" });
  const tid = (await adminThreads(db)).threads[0]!.id;
  await setThreadStatus(db, ADMIN, tid, { status: "CLOSED" });
  assert.equal((await adminThreads(db)).threads.length, 0, "the open inbox no longer lists it");
  assert.equal((await adminThreads(db, { status: "CLOSED" })).threads.length, 1);
  assert.equal((await auditLog(db, { target: userId })).actions[0]!.action, "support.status");
  await playerSend(db, userId, { body: "Sorry, one more question" });
  assert.equal((await adminThreads(db)).threads[0]!.status, "OPEN");
  await assert.rejects(() => setThreadStatus(db, ADMIN, tid, { status: "MAYBE" }), SupportError);
  await assert.rejects(() => adminThread(db, "not-a-thread"), (e: unknown) => e instanceof SupportError && e.status === 404);
});

test("Each player only ever sees their own conversation; unread ones lead the inbox", async () => {
  const { db, userId } = await setupWalletDb();
  const other = await ensureWalletAccount(db, "account-2", "kofi");
  await playerSend(db, userId, { body: "mine" });
  await new Promise((r) => setTimeout(r, 20)); // so the second conversation is clearly the newer one
  await playerSend(db, other, { body: "theirs" });
  assert.deepEqual((await playerThread(db, userId)).messages.map((m) => m.body), ["mine"]);
  assert.deepEqual((await playerThread(db, other)).messages.map((m) => m.body), ["theirs"]);
  const [newest, older] = (await adminThreads(db)).threads;
  assert.equal(newest!.username, "kofi", "both unread: the most recent first");
  await adminThread(db, newest!.id); // an admin reads the newer one
  const again = (await adminThreads(db)).threads;
  assert.equal(again[0]!.id, older!.id, "an unread conversation goes above a read one, even an older one");
  assert.deepEqual(again.map((t) => t.unread), [1, 0]);
});

test("A full-length message in Twi or with emoji isn't refused for size before it reaches support", async () => {
  const { db } = await setupWalletDb();
  const server = createApp(db).listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const body = JSON.stringify({ body: "Mepa wo kyɛw, me sika no nnya mmaeɛ? ₵50 🙏\n".repeat(30).slice(0, MAX_BODY) });
    assert.ok(Buffer.byteLength(body) > 1024, "over the 1 KB the rest of the API allows");
    const post = (path: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    // no session here, so getting as far as sign-in (401) means the body was read rather than refused (413)
    assert.equal((await post("/api/support/messages")).status, 401);
    assert.equal((await post("/api/admin/support/x/messages")).status, 401);
    assert.equal((await post("/api/partners/click")).status, 413, "everywhere else keeps the 1 KB limit");
  } finally {
    server.close();
  }
});

test("A suspended player can still write to support", () => {
  assert.ok(suspendedMayDo("POST", "/api/support/messages"));
  assert.ok(!suspendedMayDo("POST", "/api/support/messages/x"));
});
