/**
 * Pending-withdrawal emails for RendoWin, sent from your own Gmail.
 * Paste into script.google.com (signed in as asakaafixed@gmail.com) and deploy as a Web app:
 *   Execute as: Me    Who has access: Anyone
 * Put the same secret in Render as GMAIL_WEBHOOK_SECRET. Never commit the real secret to git.
 */
const SECRET = "PASTE_THE_SECRET_HERE";
const SEND_TO = "asakaafixed@gmail.com";

function doPost(e) {
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    // only your server knows the secret; anything else is refused and nothing is sent
    if (!SECRET || SECRET === "PASTE_THE_SECRET_HERE" || data.secret !== SECRET) return reply({ ok: false, error: "unauthorized" });
    if (data.type !== "pending_withdrawal") return reply({ ok: false, error: "unknown type" });

    const amount = String(data.amount || "");
    const phone = String(data.phone || "");
    // only well-formed values get into the email
    if (!/^\d{1,9}(\.\d{1,2})?$/.test(amount)) return reply({ ok: false, error: "bad amount" });
    if (!/^\+?\d{9,15}$/.test(phone)) return reply({ ok: false, error: "bad phone" });

    MailApp.sendEmail({
      to: SEND_TO,
      subject: "New Pending Withdrawal Request",
      body:
        "Withdrawal Amount: GHS " + amount + "\n" +
        "Customer Phone Number: " + phone + "\n" +
        "Withdrawal Status: Pending",
    });
    return reply({ ok: true });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Run this once from the editor to give the script permission to send email (and get a test email). */
function testEmail() {
  MailApp.sendEmail(SEND_TO, "New Pending Withdrawal Request", "Withdrawal Amount: GHS 0.00\nCustomer Phone Number: 0000000000\nWithdrawal Status: Pending (TEST)");
}
