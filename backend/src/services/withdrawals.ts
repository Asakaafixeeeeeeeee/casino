import { logAction } from "./admin.js";
import { notifyPendingWithdrawal } from "./notify.js";
import type { Pool, PoolClient } from "pg";
import { completeWithdrawal, refundWithdrawal, withdraw } from "./balanceService.js";
import {
  checkTellerStatus,
  initiatePayout,
  networkForPhone,
  newTxId,
  reasonText,
  TellerConfigurationError,
  TellerRequestError,
  verdict,
  type TellerConfig,
} from "./teller.js";

export class WithdrawalError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "WithdrawalError";
  }
}

export interface WithdrawalRow {
  id: string;
  user_id: string;
  username: string | null;
  amount: string;
  currency: string;
  phone: string;
  status: "REQUESTED" | "PAYING" | "PAID" | "DECLINED";
  transaction_id: string | null;
  gateway_note: string | null;
  decided_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The GHS a player can withdraw: their winnings (deposited money stays for betting), and their whole balance. */
export async function withdrawableOf(client: Pool | PoolClient, userId: string, lock = false): Promise<{ withdrawable: number; balance: number }> {
  const { rows } = await client.query<{ withdrawable: string; available: string }>(
    `SELECT withdrawable, available FROM user_balances WHERE user_id = $1 AND currency_code = 'GHS'${lock ? " FOR UPDATE" : ""}`,
    [userId]
  );
  return { withdrawable: Number(rows[0]?.withdrawable ?? 0), balance: Number(rows[0]?.available ?? 0) };
}

/** A player's request: the money leaves their balance into the hold at once, to be paid to their registered number. */
export async function requestWithdrawal(
  db: Pool,
  user: { id: string; phone: string },
  amountMajor: number,
  idempotencyKey: string
): Promise<{ id: string }> {
  if (!networkForPhone(user.phone)) {
    throw new WithdrawalError("unsupported_number", "Withdrawals go to your registered number, which must be MTN, Telecel or AirtelTigo.");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    /* only winnings can be withdrawn; deposited money stays in the balance until it's used for betting */
    const { withdrawable } = await withdrawableOf(client, user.id, true);
    if (amountMajor > withdrawable) {
      throw new WithdrawalError("winnings_only",
        `Only winnings can be withdrawn. You can withdraw up to GHS ${withdrawable.toFixed(2)}; ` +
        `deposited money stays in your balance for betting.`, 403);
    }
    /* the client's key is namespaced to the player: on its own it shared the ledger's key space with the server's
       settlement keys, so a player could take "win:live:<their bet id>" and stall a whole round's settlement */
    const journalId = await withdraw(client, user.id, "GHS", amountMajor, `withdraw:${user.id}:${idempotencyKey}`, "momo:" + user.phone);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO withdrawals (user_id, journal_id, amount, currency, phone) VALUES ($1, $2, $3, 'GHS', $4) RETURNING id`,
      [user.id, journalId, amountMajor, user.phone]
    );
    await client.query("COMMIT");
    notifyPendingWithdrawal(amountMajor, user.phone); // emailed in the background; never blocks the request
    return rows[0]!;
  } catch (e) {
    await client.query("ROLLBACK");
    /* two copies of one request at once: the second returns the withdrawal the first one made */
    if (e instanceof Error && e.name === "IdempotencyError") {
      const prior = (await db.query<{ id: string }>(
        `SELECT w.id FROM withdrawals w JOIN ledger_journal j ON j.id = w.journal_id WHERE j.idempotency_key = $1 AND w.user_id = $2`,
        [`withdraw:${user.id}:${idempotencyKey}`, user.id])).rows[0];
      if (prior) return prior;
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function listWithdrawals(db: Pool, status?: string): Promise<WithdrawalRow[]> {
  const { rows } = await db.query<WithdrawalRow>(
    `SELECT w.*, u.username FROM withdrawals w JOIN users u ON u.id = w.user_id
      WHERE ($1::text IS NULL OR w.status = $1)
      ORDER BY w.created_at ${status === "REQUESTED" ? "ASC" : "DESC"}
      LIMIT 200`,
    [status ?? null]
  );
  return rows;
}

/**
 * Applies a final outcome once: only a REQUESTED or PAYING row moves, in the same transaction as the ledger.
 * Paid releases the hold to the gateway; declined returns the money to the player.
 */
export async function settleWithdrawal(
  db: Pool,
  id: string,
  outcome: "paid" | "declined",
  note: string | null,
  decidedBy?: string,
  /* which states may be settled: TheTeller's answers settle a PAYING row; an admin's rejection only a REQUESTED one */
  from: readonly ("REQUESTED" | "PAYING")[] = ["REQUESTED", "PAYING"]
): Promise<WithdrawalRow | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<WithdrawalRow>(
      `UPDATE withdrawals
          SET status = $2, gateway_note = COALESCE($3, gateway_note), decided_by = COALESCE($4, decided_by), updated_at = now()
        WHERE id = $1 AND status = ANY($5::text[])
        RETURNING *`,
      [id, outcome === "paid" ? "PAID" : "DECLINED", note, decidedBy ?? null, [...from]]
    );
    const w = rows[0];
    if (w) {
      const amount = Number(w.amount);
      if (outcome === "paid") await completeWithdrawal(client, w.currency, amount, `payout:${w.id}`, w.transaction_id ?? undefined);
      else await refundWithdrawal(client, w.user_id, w.currency, amount, `refund:${w.id}`, `Withdrawal not paid: ${note ?? "declined"}`.slice(0, 500));
    }
    await client.query("COMMIT");
    return w ?? null;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** An admin rejects a request that hasn't been sent: the player gets the money back. */
export async function rejectWithdrawal(db: Pool, id: string, reason: string, admin: string): Promise<WithdrawalRow> {
  const { rows } = await db.query<{ status: string; phone: string }>(`SELECT status, phone FROM withdrawals WHERE id = $1`, [id]);
  if (!rows[0]) throw new WithdrawalError("not_found", "No such withdrawal", 404);
  if (samePhone(rows[0].phone, admin)) throw new WithdrawalError("own_withdrawal", "Another admin has to decide your own withdrawal", 403);
  if (rows[0].status !== "REQUESTED") throw new WithdrawalError("already_decided", "Only a request that hasn't been sent can be rejected", 409);
  /* REQUESTED only: if another admin's Pay claimed it in the meantime (PAYING), this must not refund it as well */
  const settled = await settleWithdrawal(db, id, "declined", reason || "Rejected by an admin", admin, ["REQUESTED"]);
  if (!settled) throw new WithdrawalError("already_decided", "This withdrawal was already decided", 409);
  await logAction(db, admin, "withdrawal.reject", settled.user_id, { withdrawal: id, amount: Number(settled.amount), reason: reason || null });
  return settled;
}

/** The same mobile number, whatever its format (0241234567, +233241234567, 233 24 123 4567). */
const samePhone = (a: string | null | undefined, b: string | null | undefined) => {
  const tail = (p: string | null | undefined) => String(p ?? "").replace(/\D/g, "").slice(-9);
  return tail(a).length === 9 && tail(a) === tail(b);
};

/**
 * An admin approves: the row is claimed atomically (so two clicks can never pay twice), then TheTeller is asked
 * to pay. A clear refusal returns the money; a timeout or server error leaves it PAYING for a status check.
 */
export async function payWithdrawal(
  db: Pool,
  config: TellerConfig,
  id: string,
  admin: string
): Promise<{ status: "PAID" | "DECLINED" | "PAYING"; note: string | null }> {
  // checked before claiming, so a missing passcode leaves the request waiting rather than stuck mid-payout
  if (!config.payoutPasscode) throw new TellerConfigurationError("Payouts are disabled; set TELLER_PASSCODE");
  const owner = (await db.query<{ phone: string }>(`SELECT phone FROM withdrawals WHERE id = $1`, [id])).rows[0];
  if (owner && samePhone(owner.phone, admin)) throw new WithdrawalError("own_withdrawal", "Another admin has to approve your own withdrawal", 403);
  const txId = newTxId();
  const { rows } = await db.query<WithdrawalRow>(
    `UPDATE withdrawals SET status = 'PAYING', transaction_id = $2, decided_by = $3, updated_at = now()
      WHERE id = $1 AND status = 'REQUESTED' RETURNING *`,
    [id, txId, admin]
  );
  const w = rows[0];
  if (!w) throw new WithdrawalError("already_decided", "This withdrawal isn't waiting for approval", 409);
  await logAction(db, admin, "withdrawal.pay", w.user_id, { withdrawal: id, amount: Number(w.amount), transaction: txId });

  const network = networkForPhone(w.phone);
  if (!network) {
    const note = `${w.phone || "No number"} is not a mobile money number`;
    await settleWithdrawal(db, id, "declined", note);
    return { status: "DECLINED", note };
  }
  try {
    await initiatePayout(config, {
      transactionId: txId,
      amountMajor: Number(w.amount),
      phone: w.phone,
      network,
      desc: `RendoWin withdrawal ${txId}`,
    });
    await settleWithdrawal(db, id, "paid", "Paid by TheTeller");
    return { status: "PAID", note: null };
  } catch (err) {
    const note = (err as Error).message || "TheTeller payout failed";
    if (err instanceof TellerRequestError && err.declined) {
      await settleWithdrawal(db, id, "declined", note);
      return { status: "DECLINED", note };
    }
    // may have been paid: keep it PAYING until TheTeller's status says otherwise
    await db.query(`UPDATE withdrawals SET gateway_note = $2, updated_at = now() WHERE id = $1`, [id, note]);
    return { status: "PAYING", note };
  }
}

/** Asks TheTeller about a payout that didn't get a final answer, and settles it once it has one. */
export async function recheckWithdrawal(
  db: Pool,
  config: TellerConfig,
  id: string
): Promise<{ status: string; note: string | null }> {
  const { rows } = await db.query<WithdrawalRow>(`SELECT * FROM withdrawals WHERE id = $1`, [id]);
  const w = rows[0];
  if (!w) throw new WithdrawalError("not_found", "No such withdrawal", 404);
  if (w.status !== "PAYING" || !w.transaction_id) return { status: w.status, note: w.gateway_note };
  let remote;
  try {
    remote = await checkTellerStatus(config, w.transaction_id);
  } catch (err) {
    /* a failed check is never a decline (TheTeller guide): the payout stays PAYING for the next check */
    const note = `Check failed: ${(err as Error).message}`.slice(0, 500);
    await db.query(`UPDATE withdrawals SET gateway_note = $2, updated_at = now() WHERE id = $1`, [id, note]);
    return { status: w.status, note };
  }
  const v = verdict(remote);
  const note = reasonText(remote.reason ?? remote.description) || null;
  if (v === "approved") await settleWithdrawal(db, id, "paid", note ?? "Paid by TheTeller");
  else if (v === "declined") await settleWithdrawal(db, id, "declined", note ?? "Declined by TheTeller");
  else if (note) await db.query(`UPDATE withdrawals SET gateway_note = $2, updated_at = now() WHERE id = $1`, [id, note]);
  const after = await db.query<{ status: string; gateway_note: string | null }>(
    `SELECT status, gateway_note FROM withdrawals WHERE id = $1`, [id]);
  return { status: after.rows[0]!.status, note: after.rows[0]!.gateway_note };
}
