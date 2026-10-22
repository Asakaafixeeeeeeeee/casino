import type { Pool } from "pg";
import { logAction } from "./admin.js";
import { checkTellerStatus, depositReference, paidPesewas, reasonText, verdict, type TellerConfig } from "./teller.js";
import {
  checkPaytellerPayment, paytellerPaidPesewas, paytellerVerdict, type PaytellerConfig,
} from "./payteller.js";
import { noteIntent, reopenFailedIntent, settleIntent } from "./tellerSettlement.js";

/*
 * The admin's view of deposits TheTeller hasn't settled, and a "recheck" for one of them (TheTeller guide: "give
 * admins a recheck button for a single transaction"). A recheck settles exactly the way the player's own status check
 * does — once, at most once credited — so a delayed deposit is never paid twice by an admin adding it by hand.
 */

export class DepositError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "DepositError";
  }
}

export interface WaitingDeposit {
  transaction_id: string;
  gateway: "teller" | "payteller";
  /** "DES" + the transaction id: what TheTeller shows as the payment's description */
  reference: string;
  amount: number;
  status: "PENDING" | "FAILED";
  note: string | null;
  payer: string | null;
  created_at: Date;
  username: string | null;
  phone: string | null;
}

const isPaytellerConfig = (config: TellerConfig | PaytellerConfig): config is PaytellerConfig =>
  "username" in config;

/** Deposits still waiting for TheTeller, and those declined in the last day (a late approval can still arrive). */
export async function waitingDeposits(db: Pool): Promise<WaitingDeposit[]> {
  const { rows } = await db.query<Omit<WaitingDeposit, "amount" | "reference"> & { amount: string }>(
    `SELECT p.transaction_id, p.gateway, p.amount, p.status, p.gateway_note AS note, p.payer_phone AS payer, p.created_at, u.username, u.phone
       FROM payment_intents p JOIN users u ON u.id = p.user_id
      WHERE p.transaction_id IS NOT NULL
        AND (p.status = 'PENDING' OR (p.status = 'FAILED' AND p.updated_at > now() - interval '24 hours'))
      ORDER BY p.created_at DESC LIMIT 100`);
  return rows.map((r) => ({ ...r, amount: Number(r.amount), reference: depositReference(r.transaction_id) }));
}

/** Asks the original gateway about one deposit and settles it: approved credits once, declined fails it, no answer waits. */
export async function recheckDeposit(db: Pool, config: TellerConfig | PaytellerConfig, transactionId: string, admin: string) {
  const local = (await db.query<{ user_id: string; status: string; gateway: "teller" | "payteller" }>(
    `SELECT user_id, status, gateway FROM payment_intents WHERE transaction_id = $1`, [transactionId])).rows[0];
  if (!local) throw new DepositError("not_found", "No deposit with that TheTeller reference", 404);
  if (local.gateway === "payteller" && !isPaytellerConfig(config)) {
    throw new DepositError("provider_mismatch", "Payteller credentials are required to recheck this deposit", 503);
  }
  if (local.gateway === "teller" && isPaytellerConfig(config)) {
    throw new DepositError("provider_mismatch", "TheTeller credentials are required to recheck this deposit", 503);
  }
  if (local.status === "CONFIRMED") return { status: "approved" as const, note: "Already credited" };
  let v: "approved" | "declined" | null = null;
  let paid: number | null = null;
  let note: string | null = null;
  try {
    if (local.gateway === "payteller") {
      if (!isPaytellerConfig(config)) throw new Error("Payteller configuration was not selected");
      const remote = await checkPaytellerPayment(config, depositReference(transactionId));
      v = paytellerVerdict(remote.status);
      paid = paytellerPaidPesewas(remote.amount);
      note = typeof remote.error === "string" ? remote.error : null;
    } else {
      if (isPaytellerConfig(config)) throw new Error("TheTeller configuration was not selected");
      const remote = await checkTellerStatus(config, transactionId);
      v = verdict(remote);
      paid = paidPesewas(remote.amount);
      note = reasonText(remote.reason ?? remote.description) || null;
    }
  } catch (e) {
    /* A failed check is never a decline. */
    const note = `Check failed: ${(e as Error).message}`.slice(0, 300);
    await noteIntent(db, transactionId, note);
    return { status: "pending" as const, note };
  }
  if (v === "approved" && local.status === "FAILED") await reopenFailedIntent(db, transactionId);
  if (v) await settleIntent(db, transactionId, v, paid, note ?? undefined);
  else if (note) await noteIntent(db, transactionId, note);
  await logAction(db, admin, "deposit.recheck", local.user_id, { transaction: transactionId, verdict: v ?? "pending" });
  return { status: (v ?? "pending") as "approved" | "declined" | "pending", note };
}
