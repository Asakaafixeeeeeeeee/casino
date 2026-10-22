import type { Pool } from "pg";
import { getLottoSettings } from "../games/lotto.js";
import { getMoneyRules, MAX_DEPOSIT } from "./moneyRules.js";
import { notifyPlayer, SUPPORT_PUSH } from "./push.js";

/*
 * The WIN B Support assistant. It answers common questions from the site's real settings (minimum deposit, Lotto
 * stakes and closing time, the deposit rules) and hands anything it can't answer, or that is about someone's money
 * or account, to the human team. It never states a balance, a payment status or a transaction result: it has no
 * way to look those up for the player, so it never claims to know them.
 *
 * It only ever adds a reply. It never closes a conversation, and a message is answered at most once: the thread's
 * ai_handled_id is claimed atomically before anything is written, so a sweep and a live reply can't both answer.
 */

export const AI_SENDER = "ai-assistant";
const FOOTER = "\n\n— WIN B Support Assistant (automated). Type “agent” any time and our team will take over.";
const cedis = (n: number) => "₵" + n.toLocaleString("en-GH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const accra = (d: Date) => d.toLocaleString("en-GB", { timeZone: "Africa/Accra", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) + " (Ghana time)";

export type Reply = { kind: "answer" | "handoff"; sensitive: boolean; body: string };

const HANDOFF = "Thanks for contacting WIN B Support. I've passed your message to our support team and they will review it and reply in this chat. " +
  "If it's about a payment, please include the amount, the date and the reference shown on your deposit or withdrawal. " +
  "I can't see or confirm payment statuses or balances from here, so I won't guess.";

/* money, account or complaint topics: a person has to look at these, the assistant never answers them itself */
const SENSITIVE = new RegExp([
  "scam", "fraud", "steal", "stole", "cheat", "robbed", "hack", "lawyer", "police", "report(ing)? (you|this)", "refund", "chargeback",
  "deduct", "debit", "charged", "complain", "unfair", "rigged", "disappear",
  "(not|never|didn.?t|did not|haven.?t|have not|yet to) (been )?(credit|receiv|reflect|show|arriv|get|got|paid|come)",
  "(deposit|payment|momo|money|withdraw\\w*|winnings?|funds?|balance) (is |was |has |have |are )?(still |not |never |missing|pending|gone|stuck|wrong|zero)",
  "where is my", "wrong (amount|balance)", "(account|number|withdrawal|payout) (is |was |has been )?(blocked|banned|suspended|locked|frozen|closed|deleted)",
  "locked out", "can.?t (log ?in|login|withdraw|access)", "cannot (log ?in|login|withdraw|access)",
].join("|"), "i");

const WANTS_HUMAN = /\b(agent|human|real person|someone|operator|representative|customer care|talk to|speak to|call me)\b/i;

interface Rule { re: RegExp; run: (db: Pool) => Promise<string> | string }

const rules: Rule[] = [
  { re: /(change|update|edit|different|another|new|add|switch)\b.{0,25}\b(phone|number|momo|sim)|(phone|number|momo)\b.{0,25}\b(change|update|different|another|switch)|other number/i,
    run: () => "For your security, deposits can only be made from the one phone number you registered with. That number is permanently linked to your account and can't be changed. If you need to use a different number, you can register a new account with it, following our account registration rules." },
  { re: /(minimum|min\b|least|lowest).{0,20}(deposit|top ?up)|(deposit|top ?up).{0,25}(minimum|min\b|limit|how much|maximum|max\b)|how much.{0,20}deposit/i,
    run: async (db) => { const r = await getMoneyRules(db); return `Deposits start from ${cedis(r.min_deposit)} and go up to ${cedis(MAX_DEPOSIT)} per transaction.`; } },
  { re: /(wait|waiting|cooldown|10 ?min|ten ?min|countdown|temporarily unavailable|another deposit)/i,
    run: () => "There is no waiting period after a successful deposit. Only one payment may be pending at a time; confirm its outcome before starting another. Your deposit limits still apply." },
  { re: /deposit|top ?up|fund(ing)? (my )?(account|wallet)|add money|momo|mobile money|pay in|theteller/i,
    run: async (db) => { const r = await getMoneyRules(db); return `To deposit, open the Deposit page, enter ${cedis(r.min_deposit)} or more and tap Top Up Now. Complete Payteller checkout using your registered Mobile Money number. Your wallet is credited once payment is verified. There is no waiting period after a successful deposit; deposit limits and pending-payment protection still apply.`; } },
  { re: /withdraw|cash ?out|payout|pay ?out|send my (money|winnings)/i,
    run: () => "Withdrawals are paid to your registered Mobile Money number from the Withdraw page. Requests show as pending in your Transaction records until they have been processed. The exact rules and minimum are shown on the Withdraw page." },
  { re: /(lotto|lottery|5\/90|draw).{0,40}(clos|end|deadline|cut ?off|when|time|countdown)|(clos|end|when).{0,30}(lotto|draw)|what time.{0,20}draw/i,
    run: async (db) => {
      const { rows } = await db.query<{ name: string; closes_at: Date }>(
        `SELECT name, closes_at FROM lotto_draws WHERE status = 'OPEN' AND NOT paused AND closes_at > now() AND (opens_at IS NULL OR opens_at <= now()) ORDER BY closes_at LIMIT 3`);
      if (!rows.length) return "No Lotto draw is taking bets right now. The Lotto page lists the next draw and its countdown as soon as it opens.";
      return "Betting closes on the Lotto page countdown. Right now: " + rows.map((d) => `${d.name || "WIN B Lotto"} closes ${accra(new Date(d.closes_at))}`).join("; ") + ". No new tickets can be bought after the closing time.";
    } },
  { re: /(lotto|lottery).{0,30}(result|winning number|numbers)|(result|winning number).{0,30}(lotto|draw)|who won/i,
    run: () => "Winning numbers are published on the Lotto page under Recent results once a draw has been completed and released. The 5 winning numbers are drawn from 1 to 90." },
  { re: /(lotto|lottery).{0,30}(how|play|work|rule|bet|ticket|win|payout|odds|stake|perm|banker|direct)|how.{0,20}(play|win).{0,20}(lotto|lottery)|\b(perm|banker|direct)\b/i,
    run: async (db) => {
      const s = await getLottoSettings(db);
      return `WIN B Lotto is a 5/90 draw: 5 winning numbers are drawn from 1 to 90. Pick your numbers, choose a bet type (Direct, Perm or Banker), set your stake and confirm to get a ticket. Stakes are ${cedis(s.min_bet)} to ${cedis(s.max_bet)} per ticket. Winning tickets are paid to your balance automatically after the results are published. The Lotto page lists the payout for each bet.`;
    } },
  { re: /\blotto\b|lottery/i,
    run: () => "WIN B Lotto is a 5/90 draw. You can see the current draw, its closing countdown, the bet types and recent results on the Lotto page. Ask me how to play, when betting closes or about results and I'll help." },
  { re: /(forgot|reset|lost|change).{0,20}password|password.{0,20}(forgot|reset|lost|change)/i,
    run: () => "Use “Forgot password” on the log-in page to set a new password. Never share your password, a MoMo PIN or an OTP with anyone. WIN B Casino will never ask for them." },
  { re: /(how|where).{0,25}(register|sign ?up|create).{0,20}account|open an account|new account|register/i,
    run: () => "To create an account, open the Register page, enter your full name, your Mobile Money number, date of birth and a password, accept the terms and the deposit phone number rule, and submit. You must be 18 or older. The number you register with becomes your only deposit number." },
  { re: /bonus|promo|cashback|cash back|reward|free spin/i,
    run: () => "Our current offers and what is coming soon are listed on the Promotions page. I can't promise a bonus that isn't shown there." },
  { re: /addict|stop gambling|self.?exclu|responsib|gambling problem|too much/i,
    run: () => "Please play responsibly and only with money you can afford to lose. If gambling is becoming a problem, tell us in this chat and our team will help you set limits or take a break." },
  { re: /\b(hi|hello|hey|good (morning|afternoon|evening))\b/i,
    run: () => "Hello, and welcome to WIN B Support. I can help with deposits, withdrawals, Lotto and your account. What would you like to know?" },
  { re: /thank|thanks|ok(ay)?\b|great|nice one/i,
    run: () => "You're welcome. If you need anything else, just send a message here." },
];

/** What the assistant would say for this message, or a hand-off when it shouldn't answer itself. */
export async function composeReply(db: Pool, text: string): Promise<Reply> {
  const t = text.slice(0, 2000);
  if (SENSITIVE.test(t)) return { kind: "handoff", sensitive: true, body: HANDOFF };
  if (WANTS_HUMAN.test(t)) {
    return { kind: "handoff", sensitive: false, body: "Of course. I've asked a member of our support team to take over this conversation, and they will reply here." };
  }
  for (const rule of rules) {
    if (rule.re.test(t)) return { kind: "answer", sensitive: false, body: (await rule.run(db)) + FOOTER };
  }
  return { kind: "handoff", sensitive: false, body: HANDOFF };
}

const AI_COOLDOWN_NOTE = "Sorry for the delay in getting back to you. ";

/**
 * Answers a conversation's unanswered player messages, once. `quiet` (a backlog message nobody answered for a long
 * time) never gets a hand-off message for complaints or unknown questions: those are only flagged for the team.
 * Returns what it did.
 */
export async function aiRespondThread(db: Pool, threadId: string, opts: { quiet?: boolean } = {}): Promise<"replied" | "flagged" | "skipped"> {
  const t = (await db.query<{ id: string; user_id: string; needs_human: boolean; needs_human_at: Date | null }>(
    `SELECT id, user_id, needs_human, needs_human_at FROM support_threads WHERE id = $1`, [threadId])).rows[0];
  if (!t) return "skipped";
  const lastAdmin = Number((await db.query(`SELECT coalesce(max(id), 0) AS n FROM support_messages WHERE thread_id = $1 AND sender = 'admin'`, [t.id])).rows[0].n);
  const pending = (await db.query<{ id: string; body: string; created_at: Date }>(
    `SELECT id, body, created_at FROM support_messages WHERE thread_id = $1 AND sender = 'player' AND id > $2 ORDER BY id`, [t.id, lastAdmin])).rows;
  if (!pending.length) return "skipped";
  if (t.needs_human) return "skipped"; /* a person is already on it: don't talk over them */
  const lastId = Number(pending.at(-1)!.id);
  const claimed = await db.query(`UPDATE support_threads SET ai_handled_id = $2 WHERE id = $1 AND ai_handled_id < $2 RETURNING id`, [t.id, lastId]);
  if (!claimed.rowCount) return "skipped";

  const reply = await composeReply(db, pending.map((m) => m.body).join("\n"));
  const flag = () => db.query(`UPDATE support_threads SET needs_human = true, needs_human_at = now() WHERE id = $1`, [t.id]);
  if (reply.kind === "handoff" && opts.quiet) {
    await flag();
    return "flagged";
  }
  const stale = Date.now() - new Date(pending[0]!.created_at).getTime() > 24 * 3600e3;
  const body = (stale ? AI_COOLDOWN_NOTE : "") + reply.body;
  /* only if no admin got there first */
  const inserted = await db.query(
    `INSERT INTO support_messages (thread_id, sender, admin_phone, body)
     SELECT $1, 'admin', $2, $3 WHERE NOT EXISTS (SELECT 1 FROM support_messages WHERE thread_id = $1 AND sender = 'admin' AND id > $4)
     RETURNING id`, [t.id, AI_SENDER, body.slice(0, 1000), lastId]);
  if (!inserted.rowCount) return "skipped";
  await db.query(`UPDATE support_threads SET last_message_at = now() WHERE id = $1`, [t.id]);
  if (reply.kind === "handoff") await flag();
  void notifyPlayer(db, t.user_id, SUPPORT_PUSH);
  return "replied";
}

/** Backlog and missed live replies: every open conversation whose last word is the player's, older than `graceMs`. */
export async function aiSweep(db: Pool, graceMs = 20_000, limit = 25): Promise<number> {
  const { rows } = await db.query<{ id: string; age_ms: string }>(
    `SELECT t.id, extract(epoch FROM (now() - (SELECT max(created_at) FROM support_messages m WHERE m.thread_id = t.id AND m.sender = 'player'))) * 1000 AS age_ms
       FROM support_threads t
      WHERE NOT t.needs_human
        AND EXISTS (SELECT 1 FROM support_messages p WHERE p.thread_id = t.id AND p.sender = 'player'
                       AND p.id > t.ai_handled_id AND p.id > coalesce((SELECT max(a.id) FROM support_messages a WHERE a.thread_id = t.id AND a.sender = 'admin'), 0))
      ORDER BY t.last_message_at LIMIT $1`, [limit]);
  let done = 0;
  for (const r of rows) {
    const age = Number(r.age_ms);
    if (age < graceMs) continue;
    try {
      if ((await aiRespondThread(db, r.id, { quiet: age > 10 * 60_000 })) !== "skipped") done++;
    } catch (e) {
      console.error(`[support-ai] thread ${r.id}: ${(e as Error).message}`);
    }
  }
  return done;
}

export function startSupportAiSweep(db: Pool): void {
  if (process.env.SUPPORT_AI === "off") return;
  const run = () => aiSweep(db).catch((e) => console.error("[support-ai] sweep failed:", (e as Error).message));
  setInterval(run, 60_000).unref();
  setTimeout(run, 15_000).unref();
}
