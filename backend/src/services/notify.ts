// src/services/notify.ts
//
// Emails the team when a player asks to withdraw. Sent through Resend's HTTPS API (Render's free plan blocks SMTP).
// Settings: RESEND_API_KEY (required to send), WITHDRAWAL_ALERT_EMAIL (who gets it), EMAIL_FROM (the sender).

const ALERT_TO = () => process.env.WITHDRAWAL_ALERT_EMAIL?.trim() || "asakaafixed@gmail.com";
const FROM = () => process.env.EMAIL_FROM?.trim() || "RendoWin <onboarding@resend.dev>";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) throw new Error("RESEND_API_KEY is not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM(),
      to: [to],
      subject,
      text,
      html: `<div style="font:15px/1.6 system-ui,sans-serif">${text.split("\n").map(esc).join("<br>")}</div>`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Fire-and-forget: a failed email is logged and never affects the withdrawal itself. */
export function notifyPendingWithdrawal(amountMajor: number, phone: string): void {
  const text = [
    `Withdrawal Amount: GHS ${amountMajor.toFixed(2)}`,
    `Customer Phone Number: ${phone}`,
    `Withdrawal Status: Pending`,
  ].join("\n");
  sendEmail(ALERT_TO(), "New Pending Withdrawal Request", text)
    .then(() => console.log("[notify] pending withdrawal email sent: GHS %s from %s", amountMajor.toFixed(2), phone))
    .catch((err: unknown) => console.error("[notify] pending withdrawal email failed: %s", (err as Error).message));
}
