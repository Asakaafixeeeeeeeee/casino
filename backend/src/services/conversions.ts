import type { Pool } from "pg";
import { getUserBalances, postMovement, SystemAccount } from "./balanceService.js";
import { FxError, quoteConversion, type Quote } from "./fxRates.js";
import { toDbAmount } from "../money.js";

/*
 * Converting between a player's own accounts (the primary GHS account and the crypto sub-balances). One journal:
 * the player gives up `amount` of one asset to the FX desk and takes `receive` of the other from it, so every
 * currency nets to zero and the desk's book shows exactly what the house holds against the crypto balances.
 */

export interface ConversionResult {
  journalId: string;
  quote: Quote;
  balances: Awaited<ReturnType<typeof getUserBalances>>;
}

export async function convert(
  db: Pool,
  userId: string,
  input: { from?: unknown; to?: unknown; amount?: unknown; idempotency_key?: unknown },
  retried = false,
): Promise<ConversionResult> {
  const key = typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : "";
  if (key.length < 8) throw new FxError("invalid_idempotency_key", "A conversion needs an idempotency_key");
  const idempotencyKey = `convert:${userId}:${key}`;
  /* the same key again (a retried request) is the conversion already made, at the rate it was made at */
  const prior = (await db.query<{ id: string; metadata: Record<string, unknown> }>(
    `SELECT id, metadata FROM ledger_journal WHERE idempotency_key = $1`, [idempotencyKey])).rows[0];
  if (prior) {
    const client = await db.connect();
    try {
      const m = prior.metadata;
      return { journalId: prior.id, balances: await getUserBalances(client, userId), quote: {
        from: String(m.from), to: String(m.to), amount: Number(m.amount), receive: Number(m.receive), rate: Number(m.rate), mid: Number(m.mid),
        spread: Number(m.spread), valueGhs: Number(m.value_ghs), asOf: new Date(String(m.rates_as_of)), source: String(m.rates_source) } };
    } finally {
      client.release();
    }
  }
  const quote = await quoteConversion(db, input.from, input.to, input.amount);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const journalId = await postMovement(client, {
      idempotencyKey,
      entryType: "CONVERSION",
      description: `Convert ${toDbAmount(quote.amount, quote.from)} ${quote.from} to ${toDbAmount(quote.receive, quote.to)} ${quote.to}`,
      metadata: { from: quote.from, to: quote.to, amount: quote.amount, receive: quote.receive, rate: quote.rate, mid: quote.mid, spread: quote.spread,
        value_ghs: quote.valueGhs, rates_as_of: quote.asOf.toISOString(), rates_source: quote.source },
      createdBy: "system",
      legs: [
        { userId, currencyCode: quote.from, direction: "DEBIT", amountMajor: quote.amount },
        { userId: null, systemAccount: SystemAccount.FxDesk, currencyCode: quote.from, direction: "CREDIT", amountMajor: quote.amount },
        { userId: null, systemAccount: SystemAccount.FxDesk, currencyCode: quote.to, direction: "DEBIT", amountMajor: quote.receive },
        { userId, currencyCode: quote.to, direction: "CREDIT", amountMajor: quote.receive },
      ],
    });
    const balances = await getUserBalances(client, userId);
    await client.query("COMMIT");
    return { journalId, quote, balances };
  } catch (e) {
    await client.query("ROLLBACK");
    if (e instanceof Error && e.name === "InsufficientFundsError") {
      throw new FxError("insufficient_funds", "That's more than you have in that account.", 409);
    }
    /* two copies of one conversion at once: the second returns the first (now committed) */
    if (e instanceof Error && e.name === "IdempotencyError" && !retried) return convert(db, userId, input, true);
    throw e;
  } finally {
    client.release();
  }
}
