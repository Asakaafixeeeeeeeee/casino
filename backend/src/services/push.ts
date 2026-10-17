import webpush from "web-push";
import type { Pool } from "pg";

/*
 * Browser push notifications (Web Push). They are only sent when VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set on
 * the server; without them everything here quietly does nothing and the in-site notification still works.
 * Generate a pair once with:  npx web-push generate-vapid-keys
 */
let ready: boolean | null = null;
function configured(): boolean {
  if (ready !== null) return ready;
  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!pub || !priv) return (ready = false);
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:support@winbwin.com", pub, priv);
    ready = true;
  } catch (e) {
    console.error("[push] VAPID keys are not valid:", (e as Error).message);
    ready = false;
  }
  return ready;
}

export const pushPublicKey = () => (configured() ? process.env.VAPID_PUBLIC_KEY!.trim() : null);

export async function savePushSubscription(db: Pool, userId: string, sub: unknown) {
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = typeof s?.endpoint === "string" ? s.endpoint : "";
  const p256dh = typeof s?.keys?.p256dh === "string" ? s.keys.p256dh : "";
  const auth = typeof s?.keys?.auth === "string" ? s.keys.auth : "";
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) {
    throw Object.assign(new Error("That notification subscription isn't valid"), { code: "invalid_subscription" });
  }
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4`, [userId, endpoint, p256dh, auth]);
}

export async function removePushSubscription(db: Pool, userId: string, endpoint: unknown) {
  if (typeof endpoint !== "string") return;
  await db.query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
}

/** A push to every browser the player allowed; dead subscriptions are removed. Never throws. */
export async function notifyPlayer(db: Pool, userId: string, payload: { title: string; body: string; url: string; tag?: string }) {
  if (!configured()) return;
  try {
    const { rows } = await db.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, [userId]);
    await Promise.all(rows.map(async (r) => {
      try {
        await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, JSON.stringify(payload), { TTL: 86400 });
        await db.query(`UPDATE push_subscriptions SET last_ok_at = now() WHERE id = $1`, [r.id]);
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await db.query(`DELETE FROM push_subscriptions WHERE id = $1`, [r.id]);
      }
    }));
  } catch (e) {
    console.error("[push] failed:", (e as Error).message);
  }
}

export const SUPPORT_PUSH = {
  title: "WIN B Casino 🔔",
  body: "You have received a new message from WIN B Support. Tap to view your conversation.",
  url: "/support.html?chat=1",
  tag: "support-reply",
};
