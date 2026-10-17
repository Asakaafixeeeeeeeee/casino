import type { Pool } from "pg";
import { logAction } from "./admin.js";
import { notifyPlayer, SUPPORT_PUSH } from "./push.js";

/*
 * Live support chat. Each player has one conversation with the WIN B casino team; a player's message (re)opens it, an
 * admin replies from the dashboard, and either side's read position is the id of the last message they've seen.
 * Players see replies as "WIN B casino Support" — which admin wrote is kept for the dashboard only.
 */

export class SupportError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "SupportError";
  }
}

export const MAX_BODY = 1000;
/* a player can send this many messages in RATE_WINDOW (stops floods without getting in a real conversation's way) */
export const RATE_LIMIT = 30;
const RATE_WINDOW = "10 minutes";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const num = (v: unknown) => Number(v ?? 0);

interface MessageRow { id: string; sender: "player" | "admin"; admin_phone: string | null; body: string; created_at: Date }
const forPlayer = (m: MessageRow) => ({ id: num(m.id), from: m.sender === "admin" ? "support" : "you", body: m.body, at: m.created_at });
const forAdmin = (m: MessageRow) => ({ id: num(m.id), from: m.sender, admin: m.admin_phone, body: m.body, at: m.created_at });

function cleanBody(raw: unknown): string {
  const body = String(raw ?? "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) throw new SupportError("empty", "Type a message first");
  if (body.length > MAX_BODY) throw new SupportError("too_long", `Messages can be up to ${MAX_BODY} characters`);
  return body;
}
const afterId = (v: unknown) => (Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/* ---------------- the player's side ---------------- */

/** The player's conversation (or none yet), messages after `after`, marking the team's replies as seen. */
export async function playerThread(db: Pool, userId: string, input: { after?: unknown } = {}) {
  const t = (await db.query<{ id: string; status: string }>(`SELECT id, status FROM support_threads WHERE user_id = $1`, [userId])).rows[0];
  if (!t) return { thread: null, messages: [] };
  const { rows } = await db.query<MessageRow>(
    `SELECT * FROM support_messages WHERE thread_id = $1 AND id > $2 ORDER BY id DESC LIMIT 100`, [t.id, afterId(input.after)]);
  rows.reverse();
  if (rows.length) {
    await db.query(`UPDATE support_threads SET player_read_id = GREATEST(player_read_id, $2) WHERE id = $1`, [t.id, num(rows.at(-1)!.id)]);
  }
  return { thread: { id: t.id, status: t.status }, messages: rows.map(forPlayer) };
}

/** A player writes to the team: their conversation is created or reopened. */
export async function playerSend(db: Pool, userId: string, input: { body?: unknown }) {
  const body = cleanBody(input.body);
  const recent = await db.query(
    `SELECT count(*) AS n FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
      WHERE t.user_id = $1 AND m.sender = 'player' AND m.created_at > now() - interval '${RATE_WINDOW}'`, [userId]);
  if (num(recent.rows[0].n) >= RATE_LIMIT) {
    throw new SupportError("slow_down", "You've sent a lot of messages — please wait a few minutes for our reply.", 429);
  }
  const t = (await db.query<{ id: string }>(
    `INSERT INTO support_threads (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET status = 'OPEN', last_message_at = now()
     RETURNING id`, [userId])).rows[0]!;
  const m = (await db.query<MessageRow>(
    `INSERT INTO support_messages (thread_id, sender, body) VALUES ($1, 'player', $2) RETURNING *`, [t.id, body])).rows[0]!;
  await db.query(`UPDATE support_threads SET last_message_at = now(), player_read_id = $2 WHERE id = $1`, [t.id, num(m.id)]);
  return { message: forPlayer(m) };
}

/** How many of the team's replies the player hasn't seen (for the dot on the chat button). */
export async function playerUnread(db: Pool, userId: string) {
  const { rows } = await db.query(
    `SELECT count(*) AS n FROM support_messages m JOIN support_threads t ON t.id = m.thread_id
      WHERE t.user_id = $1 AND m.sender = 'admin' AND m.id > t.player_read_id`, [userId]);
  return { unread: num(rows[0].n) };
}

/* ---------------- the team's side ---------------- */

/** Conversations for the inbox: unread ones first, then the most recent. */
export async function adminThreads(db: Pool, input: { status?: unknown } = {}) {
  const status = input.status === "CLOSED" ? "CLOSED" : input.status === "ALL" ? "" : "OPEN";
  const { rows } = await db.query(
    `SELECT t.id, t.status, t.last_message_at, t.created_at, u.id AS user_id, u.username, u.phone,
            (SELECT count(*) FROM support_messages m WHERE m.thread_id = t.id AND m.sender = 'player' AND m.id > t.admin_read_id) AS unread,
            t.needs_human,
            (SELECT row_to_json(x) FROM (SELECT sender, body FROM support_messages m WHERE m.thread_id = t.id ORDER BY id DESC LIMIT 1) x) AS last
       FROM support_threads t JOIN users u ON u.id = t.user_id
      WHERE ($1 = '' OR t.status = $1)
      ORDER BY (SELECT count(*) FROM support_messages m WHERE m.thread_id = t.id AND m.sender = 'player' AND m.id > t.admin_read_id) > 0 DESC,
               t.last_message_at DESC
      LIMIT 200`, [status]);
  return {
    threads: rows.map((t) => ({
      id: t.id, status: t.status, user_id: t.user_id, username: t.username, phone: t.phone, unread: num(t.unread), needs_human: !!t.needs_human,
      last_at: t.last_message_at, preview: t.last ? String(t.last.body).slice(0, 140) : "", last_from: t.last ? t.last.sender : null,
    })),
  };
}

async function threadRow(db: Pool, threadId: unknown) {
  const id = String(threadId ?? "");
  const t = UUID.test(id) ? (await db.query(
    `SELECT t.*, u.username, u.phone, u.status::text AS account_status FROM support_threads t JOIN users u ON u.id = t.user_id
      WHERE t.id = $1`, [id])).rows[0] : undefined;
  if (!t) throw new SupportError("not_found", "That conversation wasn't found", 404);
  return t;
}

/** One conversation, messages after `after`, marking the player's messages as seen by the team. */
export async function adminThread(db: Pool, threadId: unknown, input: { after?: unknown } = {}) {
  const t = await threadRow(db, threadId);
  const { rows } = await db.query<MessageRow>(
    `SELECT * FROM support_messages WHERE thread_id = $1 AND id > $2 ORDER BY id DESC LIMIT 200`, [t.id, afterId(input.after)]);
  rows.reverse();
  if (rows.length) await db.query(`UPDATE support_threads SET admin_read_id = GREATEST(admin_read_id, $2) WHERE id = $1`, [t.id, num(rows.at(-1)!.id)]);
  return {
    thread: { id: t.id, status: t.status, user_id: t.user_id, username: t.username, phone: t.phone, account_status: t.account_status, created_at: t.created_at },
    messages: rows.map(forAdmin),
  };
}

/** An admin replies; the conversation stays (or becomes) open until someone closes it. */
export async function adminReply(db: Pool, admin: string, threadId: unknown, input: { body?: unknown }) {
  const t = await threadRow(db, threadId);
  const body = cleanBody(input.body);
  const m = (await db.query<MessageRow>(
    `INSERT INTO support_messages (thread_id, sender, admin_phone, body) VALUES ($1, 'admin', $2, $3) RETURNING *`,
    [t.id, admin, body])).rows[0]!;
  await db.query(`UPDATE support_threads SET status = 'OPEN', needs_human = false, last_message_at = now(), admin_read_id = GREATEST(admin_read_id, $2) WHERE id = $1`,
    [t.id, num(m.id)]);
  void notifyPlayer(db, t.user_id, SUPPORT_PUSH);
  return { message: forAdmin(m) };
}

/** Closes a solved conversation (a new message from the player reopens it), or reopens one. */
export async function setThreadStatus(db: Pool, admin: string, threadId: unknown, input: { status?: unknown }) {
  const t = await threadRow(db, threadId);
  const status = String(input.status ?? "");
  if (status !== "OPEN" && status !== "CLOSED") throw new SupportError("invalid_status", "Close or reopen the conversation");
  await db.query(`UPDATE support_threads SET status = $2 WHERE id = $1`, [t.id, status]);
  await logAction(db, admin, "support.status", t.user_id, { thread: t.id, status });
  return { status };
}

/** Conversations with messages no admin has seen yet (the Support tab's badge). */
export async function unreadThreads(db: Pool): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*) AS n FROM support_threads t
      WHERE EXISTS (SELECT 1 FROM support_messages m WHERE m.thread_id = t.id AND m.sender = 'player' AND m.id > t.admin_read_id)`);
  return num(rows[0].n);
}
