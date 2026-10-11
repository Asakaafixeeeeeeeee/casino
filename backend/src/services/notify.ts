// src/services/notify.ts
//
// Emails the team when a player asks to withdraw, through a Google Apps Script web app that sends from the
// owner's Gmail (Render's free plan blocks SMTP). The script is in backend/gmail-notify.gs.
// Settings: GMAIL_WEBHOOK_URL (the script's /exec address) and GMAIL_WEBHOOK_SECRET (the same secret as the script).

import type { Pool } from "pg";

async function sendViaGmail(payload: Record<string, string>): Promise<void> {
  const url = process.env.GMAIL_WEBHOOK_URL?.trim();
  const secret = process.env.GMAIL_WEBHOOK_SECRET?.trim();
  if (!url || !secret) throw new Error("GMAIL_WEBHOOK_URL / GMAIL_WEBHOOK_SECRET are not set");
  // Apps Script runs the POST, then redirects to its answer; fetch follows that redirect to read it
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, ...payload }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let body: { ok?: boolean; error?: string } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`Apps Script answered ${res.status} with something other than JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok || !body.ok) throw new Error(`Apps Script refused it: ${body.error ?? res.status}`);
}

/** The player's registered full name (synced from the accounts server on every signed-in request), or null. */
async function registeredName(db: Pool, userId: string): Promise<string | null> {
  const { rows } = await db.query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = $1`, [userId]);
  const name = rows[0]?.full_name?.trim();
  return name ? name : null;
}

/** Fire-and-forget: a failed email is logged and never affects the withdrawal itself. */
export function notifyPendingWithdrawal(db: Pool, userId: string, amountMajor: number, phone: string): void {
  (async () => {
    const payload: Record<string, string> = { type: "pending_withdrawal", amount: amountMajor.toFixed(2), phone };
    const customerName = await registeredName(db, userId).catch((err: unknown) => {
      console.error("[notify] couldn't read the name of user %s: %s", userId, (err as Error).message);
      return null;
    });
    if (customerName) payload.customerName = customerName;
    else console.warn("[notify] user %s (%s) has no registered full name; sending the email without customerName", userId, phone);
    await sendViaGmail(payload);
    console.log("[notify] pending withdrawal email sent: GHS %s from %s (%s)", payload.amount, phone, customerName ?? "no name");
  })().catch((err: unknown) => console.error("[notify] pending withdrawal email failed: %s", (err as Error).message));
}
