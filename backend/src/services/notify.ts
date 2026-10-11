// src/services/notify.ts
//
// Emails the team when a player asks to withdraw, through a Google Apps Script web app that sends from the
// owner's Gmail (Render's free plan blocks SMTP). The script is in backend/gmail-notify.gs.
// Settings: GMAIL_WEBHOOK_URL (the script's /exec address) and GMAIL_WEBHOOK_SECRET (the same secret as the script).

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

/** Fire-and-forget: a failed email is logged and never affects the withdrawal itself. */
export function notifyPendingWithdrawal(amountMajor: number, phone: string): void {
  sendViaGmail({ type: "pending_withdrawal", amount: amountMajor.toFixed(2), phone })
    .then(() => console.log("[notify] pending withdrawal email sent: GHS %s from %s", amountMajor.toFixed(2), phone))
    .catch((err: unknown) => console.error("[notify] pending withdrawal email failed: %s", (err as Error).message));
}
