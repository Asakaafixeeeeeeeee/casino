// src/services/balanceService.ts
//
// Single source of truth for any change to a user's money.
//
// Enforcement stack (defence in depth):
//   (1) CHECK (available >= 0) and CHECK (locked >= 0) at the row level.
//   (2) Every DEBIT is a conditional UPDATE ... WHERE available >= :amount,
//       so a withdrawal race is settled by the database, not by application
//       locking — two concurrent withdrawals can only both succeed up to the
//       real available balance.
//   (3) A DEFERRABLE constraint trigger aborts a transaction whose journals do
//       not net to zero per currency, so money can neither be created nor lost.
//   (4) idempotency_key is UNIQUE on the journal: a retried request returns the
//       original result instead of moving money twice.
//
// Accounting convention (a user's balance is a LIABILITY of the house):
//   CREDIT = money enters the holder (balance increases)
//   DEBIT  = money leaves the holder (balance decreases)
//   => sum(CREDIT) - sum(DEBIT) == 0 per journal + currency.
//
// ---------------------------------------------------------------------------
// STAKE LOCKING (place bet / settle bet) is intentionally NOT in this module yet.
// Locking funds into `locked` and releasing them is a same-user reclassification
// (available -> locked) that is net-zero, so it needs its own journal shape.
// It is called out in the README as the next step; the schema and CHECKs
// already support it, the service just does not wire it up yet.
// ---------------------------------------------------------------------------

import type { PoolClient } from "pg";
import { CurrencyError, getCurrency, listCurrencies, minWithdrawal, toDbAmount } from "../money.js";

export type Direction = "DEBIT" | "CREDIT";

export interface BalanceView {
  userId: string;
  country: string;
  primary: BalanceCurrency;
  otherAccounts: BalanceCurrency[];
  loyaltyPoints: { available: string };
}

export interface BalanceCurrency {
  currencyCode: string;
  /** FIAT or CRYPTO (the primary account is always FIAT; points are reported separately). */
  kind?: "FIAT" | "CRYPTO" | "POINTS";
  name: string;
  symbol: string;
  /** Crypto: the chain the asset is held on (e.g. "TRON (TRC-20)"). */
  network?: string | null;
  available: string;
  locked: string;
}

export interface MovementLegInput {
  /** UUID, or null for a system account. */
  userId: string | null;
  currencyCode: string;
  direction: Direction;
  /** Major units (₵ 5.50). Converted to a fixed-precision string for the DB. */
  amountMajor: number;
  /** Required when userId is null. Identifies the platform pot. */
  systemAccount?: string;
}

export interface MovementInput {
  idempotencyKey: string;
  entryType: string; // matches the entry_type enum
  description?: string;
  reason?: string;
  externalRef?: string;
  metadata?: Record<string, unknown>;
  /** Who made the movement: "system" for the platform itself, an admin's number for a manual adjustment. */
  createdBy?: string;
  legs: MovementLegInput[];
}

/** The accounts every player has besides their primary one (in their country's currency): US dollars. */
export const SECONDARY_ACCOUNTS = ["USD"];

/** Platform-side counterparty accounts. One per event type keeps the books clean. */
export const SystemAccount = {
  DepositSource: "gateway-deposit-source", // funds arrive here, then credit the user
  WithdrawalHold: "payment-gateway-hold",   // withdrawal parked here pending payout
  PayoutSent: "gateway-payout-sent",       // paid withdrawals leave the platform through here
  HouseEdge: "house-edge",                 // accumulated margin from settled bets
  House: "house-bankroll",                 // takes real-money stakes and pays wins
  PointsPool: "points-pool",              // liability for points redemption
  AdminAdjustments: "admin-adjustments",   // manual corrections and goodwill credits made by an admin
  FxDesk: "fx-desk",                       // the other side of a player's conversion between their accounts
} as const;

/* --- errors ------------------------------------------------------------- */

export class InsufficientFundsError extends Error {
  constructor(
    public readonly userId: string,
    public readonly currencyCode: string,
    public readonly requestedMajor: number,
    public readonly availableMajor: number
  ) {
    super(
      `User ${userId} has ${availableMajor} ${currencyCode}; needs ${requestedMajor} ${currencyCode}`
    );
    this.name = "InsufficientFundsError";
  }
}

export class IdempotencyError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`Movement already processed for key: ${idempotencyKey}`);
    this.name = "IdempotencyError";
  }
}

export class BalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BalanceError";
  }
}

/* --- core: one atomic idempotent movement ------------------------------- */

/** Credits that count as withdrawable winnings: game payouts, and a refused withdrawal coming back. */
const WINNINGS_IN = new Set<string>(["BET_SETTLED", "REVERSAL"]);

/**
 * Post one double-entry movement atomically.
 *
 * - Idempotent: a duplicate idempotency_key throws IdempotencyError (the caller
 *   treats that as "already done, return the prior result to the client").
 * - Atomic: every leg is INSERTed + balance updated in the SAME transaction.
 *   The deferred zero-sum trigger runs at COMMIT; one missing leg aborts all.
 * - Safe under concurrency: the balance write for a DEBIT is conditional
 *   (`WHERE available >= amount`), so the DB rejects any overdraft.
 *
 * Returns the journal id.
 */
export async function postMovement(client: PoolClient, m: MovementInput): Promise<string> {
  validateMovement(m);

  // (4) Idempotency guard.
  const seen = await client.query(
    "SELECT id FROM ledger_journal WHERE idempotency_key = $1",
    [m.idempotencyKey]
  );
  if (seen.rowCount) throw new IdempotencyError(m.idempotencyKey);

  // Open the journal header. Two copies of one request at once both pass the check above; the second then
  // collides on the unique key here, and is reported the same way as a later repeat (not as a 500).
  const insertJournal = client.query<{ id: string }>(
    `INSERT INTO ledger_journal
       (idempotency_key, entry_type, description, reason, external_ref, metadata, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      m.idempotencyKey,
      m.entryType,
      m.description ?? null,
      m.reason ?? null,
      m.externalRef ?? null,
      m.metadata ?? {},
      m.createdBy ?? "system",
    ]
  );
  const j = await insertJournal.catch((e: unknown) => {
    if ((e as { code?: string }).code === "23505") throw new IdempotencyError(m.idempotencyKey);
    throw e;
  });
  const journalId = j.rows[0]!.id;

  // Process legs. A DEBIT shrinks a user's available balance; a CREDIT grows it.
  // System legs (userId null) are bookkeeping only — no balance row touched.
  for (const leg of m.legs) {
    const qty = toDbAmount(leg.amountMajor, leg.currencyCode);
    const entry = await client.query<{ id: string }>(
      `INSERT INTO ledger_entries
         (journal_id, user_id, currency_code, direction, amount, system_account)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [journalId, leg.userId, leg.currencyCode, leg.direction, qty, leg.systemAccount ?? null]
    );

    if (leg.userId !== null) {
      // `withdrawable` is the winnings part of `available` (only winnings can be withdrawn). Game payouts and a
      // returned withdrawal add to it; a withdrawal takes from it; any other spend uses deposited money first, so
      // it only shrinks when the balance drops below it.
      const winningsCredit = leg.direction === "CREDIT" && WINNINGS_IN.has(m.entryType);
      const withdrawal = leg.direction === "DEBIT" && m.entryType === "WITHDRAWAL_REQUEST";
      // `deposit_funds` is the real deposited money in the balance (partners earn only on its losses). A deposit adds
      // to it; any spend but a withdrawal uses it first (the part used is recorded on the leg, deposit_part); a
      // cancelled or void bet gives back the part its stake took.
      let depositIn = 0;
      if (leg.direction === "CREDIT" && m.entryType === "DEPOSIT") depositIn = Number(qty);
      if (leg.direction === "CREDIT" && m.entryType === "BET_VOID" && m.idempotencyKey.startsWith("void:")) {
        const stake = await client.query<{ deposit_part: string | null }>(
          `SELECT e.deposit_part FROM ledger_journal j
             JOIN ledger_entries e ON e.journal_id = j.id AND e.user_id = $2 AND e.direction = 'DEBIT'
            WHERE j.idempotency_key = $1 LIMIT 1`,
          ["bet:" + m.idempotencyKey.slice(5), leg.userId]);
        depositIn = Math.min(Number(qty), Number(stake.rows[0]?.deposit_part ?? 0));
      }
      const r = await client.query<{ available: string; deposit_used: string | null }>(
        leg.direction === "CREDIT"
          ? // Money in: upsert the row (created lazily on first credit) and add.
            // Shares the debit query's parameter list: $1 amount, $2 user, $3 currency, $4 winnings/withdrawal,
            // $5 the deposited money coming in.
            `INSERT INTO user_balances (user_id, currency_code, available, withdrawable, deposit_funds)
               VALUES ($2, $3, $1, CASE WHEN $4::boolean THEN $1::numeric ELSE 0 END, $5::numeric)
             ON CONFLICT (user_id, currency_code)
             DO UPDATE SET available = user_balances.available + EXCLUDED.available,
                           withdrawable = user_balances.withdrawable + EXCLUDED.withdrawable,
                           deposit_funds = user_balances.deposit_funds + EXCLUDED.deposit_funds
             RETURNING available, NULL::numeric AS deposit_used`
          : // Money out: atomic overdraft guard. Returns nothing if insufficient (a withdrawal also needs winnings).
            // The CTE reads the row as it was, so the deposited money used is before minus after ($5 is always 0 on a
            // debit; it's named only so both queries take the same parameters).
            `WITH before AS (SELECT deposit_funds FROM user_balances WHERE user_id = $2 AND currency_code = $3 AND $5::numeric = 0)
             UPDATE user_balances
                SET available = available - $1,
                    withdrawable = CASE WHEN $4::boolean THEN withdrawable - $1 ELSE LEAST(withdrawable, available - $1) END,
                    deposit_funds = CASE WHEN $4::boolean THEN deposit_funds ELSE deposit_funds - LEAST($1, deposit_funds) END
               WHERE user_id = $2 AND currency_code = $3 AND available >= $1 AND (NOT $4::boolean OR withdrawable >= $1)
               RETURNING available, (SELECT deposit_funds FROM before) - deposit_funds AS deposit_used`,
        [qty, leg.userId, leg.currencyCode, winningsCredit || withdrawal, depositIn]
      );

      if (leg.direction === "DEBIT" && !r.rowCount) {
        const cur = await client.query<{ available: string }>(
          "SELECT available FROM user_balances WHERE user_id = $1 AND currency_code = $2",
          [leg.userId, leg.currencyCode]
        );
        throw new InsufficientFundsError(
          leg.userId,
          leg.currencyCode,
          leg.amountMajor,
          cur.rowCount ? Number(cur.rows[0]!.available) : 0
        );
      }

      await client.query("UPDATE ledger_entries SET balance_after = $1, deposit_part = $3 WHERE id = $2", [
        r.rows[0]!.available,
        entry.rows[0]!.id,
        leg.direction === "DEBIT" ? r.rows[0]!.deposit_used ?? 0 : null,
      ]);
    }
  }

  return journalId;
}

/* --- intent-revealing wrappers ---------------------------------------- */

/** A deposit: the gateway source is debited, the user is credited. */
export async function deposit(
  client: PoolClient,
  userId: string,
  currencyCode: string,
  amountMajor: number,
  idempotencyKey: string,
  externalRef?: string
): Promise<string> {
  if (amountMajor <= 0) throw new BalanceError("Deposit amount must be positive");
  const qty = toDbAmount(amountMajor, currencyCode);
  const journalId = await postMovement(client, {
    idempotencyKey,
    entryType: "DEPOSIT",
    description: `Deposited ${amountMajor} ${currencyCode}`,
    ...(externalRef === undefined ? {} : { externalRef }),
    legs: [
      { userId: null, systemAccount: SystemAccount.DepositSource, currencyCode, direction: "DEBIT", amountMajor },
      { userId, currencyCode, direction: "CREDIT", amountMajor },
    ],
  });
  // Lifetime deposit total is a reconciliation aid, not the spendable balance.
  await client.query(
    `UPDATE user_balances
        SET total_deposited = total_deposited + $1
     WHERE user_id = $2 AND currency_code = $3`,
    [qty, userId, currencyCode]
  );
  return journalId;
}

/** A withdrawal: the user is debited, funds move to the gateway hold. */
export async function withdraw(
  client: PoolClient,
  userId: string,
  currencyCode: string,
  amountMajor: number,
  idempotencyKey: string,
  externalRef?: string
): Promise<string> {
  const cur = getCurrency(currencyCode);
  if (amountMajor < cur.minWithdrawalMajor) {
    throw new InsufficientFundsError(
      userId,
      currencyCode,
      amountMajor,
      amountMajor - 1 // ensures the error path; will be overwritten by the real balance
    );
  }
  const qty = toDbAmount(amountMajor, currencyCode);
  const journalId = await postMovement(client, {
    idempotencyKey,
    entryType: "WITHDRAWAL_REQUEST",
    description: `Withdrawal of ${amountMajor} ${currencyCode} initiated`,
    ...(externalRef === undefined ? {} : { externalRef }),
    legs: [
      { userId, currencyCode, direction: "DEBIT", amountMajor },
      { userId: null, systemAccount: SystemAccount.WithdrawalHold, currencyCode, direction: "CREDIT", amountMajor },
    ],
  });
  await client.query(
    `UPDATE user_balances
        SET total_withdrawn = total_withdrawn + $1
     WHERE user_id = $2 AND currency_code = $3`,
    [qty, userId, currencyCode]
  );
  return journalId;
}

/** A held withdrawal was paid out by the gateway. The player was debited at request time, so no balance moves. */
export async function completeWithdrawal(
  client: PoolClient,
  currencyCode: string,
  amountMajor: number,
  idempotencyKey: string,
  externalRef?: string
): Promise<string> {
  return postMovement(client, {
    idempotencyKey,
    entryType: "WITHDRAWAL",
    description: `Withdrawal of ${amountMajor} ${currencyCode} paid out`,
    ...(externalRef === undefined ? {} : { externalRef }),
    legs: [
      { userId: null, systemAccount: SystemAccount.WithdrawalHold, currencyCode, direction: "DEBIT", amountMajor },
      { userId: null, systemAccount: SystemAccount.PayoutSent, currencyCode, direction: "CREDIT", amountMajor },
    ],
  });
}

/** A held withdrawal was refused or failed for good: the money goes back to the player. */
export async function refundWithdrawal(
  client: PoolClient,
  userId: string,
  currencyCode: string,
  amountMajor: number,
  idempotencyKey: string,
  reason: string
): Promise<string> {
  const journalId = await postMovement(client, {
    idempotencyKey,
    entryType: "REVERSAL",
    description: `Withdrawal of ${amountMajor} ${currencyCode} returned`,
    reason,
    legs: [
      { userId: null, systemAccount: SystemAccount.WithdrawalHold, currencyCode, direction: "DEBIT", amountMajor },
      { userId, currencyCode, direction: "CREDIT", amountMajor },
    ],
  });
  await client.query(
    `UPDATE user_balances
        SET total_withdrawn = GREATEST(total_withdrawn - $1, 0)
     WHERE user_id = $2 AND currency_code = $3`,
    [toDbAmount(amountMajor, currencyCode), userId, currencyCode]
  );
  return journalId;
}

/** Peer-to-peer transfer: a DEBIT on one user and a CREDIT on the other. */
export async function transfer(
  client: PoolClient,
  fromUserId: string,
  toUserId: string,
  currencyCode: string,
  amountMajor: number,
  idempotencyKey: string
): Promise<string> {
  if (fromUserId === toUserId) throw new BalanceError("Cannot transfer to yourself");
  return postMovement(client, {
    idempotencyKey,
    entryType: "CONVERSION",
    description: `Transfer ${amountMajor} ${currencyCode} to ${toUserId}`,
    legs: [
      { userId: fromUserId, currencyCode, direction: "DEBIT", amountMajor },
      { userId: toUserId, currencyCode, direction: "CREDIT", amountMajor },
    ],
  });
}

/** Credit loyalty points: points pool DEBITs, user CREDITs. Net zero. */
export async function creditPoints(
  client: PoolClient,
  userId: string,
  points: number,
  idempotencyKey: string
): Promise<string> {
  if (!Number.isInteger(points) || points <= 0) throw new BalanceError("Points must be a positive integer");
  return postMovement(client, {
    idempotencyKey,
    entryType: "POINTS_EARNED",
    description: `${points} VBP credited`,
    legs: [
      { userId: null, systemAccount: SystemAccount.PointsPool, currencyCode: "VBP", direction: "DEBIT", amountMajor: points },
      { userId, currencyCode: "VBP", direction: "CREDIT", amountMajor: points },
    ],
  });
}

/* --- reads -------------------------------------------------------------- */

/**
 * Build the balances response for a user. Joins `user_balances` (the cache)
 * with `currencies` (the metadata) and `countries` (the primary-currency lookup
 * that was set at registration).
 *
 * One query, no N+1: the ledger is the source of truth of *what moved*; the
 * cache is the source of truth of *what you can spend right now*.
 */
export async function getUserBalances(client: PoolClient, userId: string): Promise<BalanceView> {
  const user = await client.query<{ country: string; primary: string }>(
    `SELECT country_code AS country, primary_currency_code AS primary
       FROM users WHERE id = $1`,
    [userId]
  );
  if (!user.rowCount) throw new BalanceError(`Unknown user: ${userId}`);
  const userRow = user.rows[0]!;
  const primaryCode = userRow.primary;
  const country = userRow.country;
  const pc = getCurrency(primaryCode);

  const rows = await client.query<{
    currency_code: string;
    available: string;
    locked: string;
  }>(
    `SELECT currency_code, available, locked FROM user_balances WHERE user_id = $1
     ORDER BY currency_code`,
    [userId]
  );

  const byCode = new Map(rows.rows.map((r) => [r.currency_code, r]));
  const primaryRow = byCode.get(primaryCode) ?? { available: "0", locked: "0" };

  // "Other accounts" = the US dollar account (listed at zero until it has a balance row), plus any other currency
  // the user actually holds something in. The catalog only holds active currencies, so a retired one drops out here.
  const other: BalanceCurrency[] = [];
  for (const c of listCurrencies()) {
    if (c.code === primaryCode || c.kind === "POINTS") continue;
    const r = byCode.get(c.code);
    if (!r && !SECONDARY_ACCOUNTS.includes(c.code)) continue;
    if (r && !SECONDARY_ACCOUNTS.includes(c.code) && Number(r.available) === 0 && Number(r.locked) === 0) continue;
    other.push({
      currencyCode: c.code,
      kind: c.kind,
      name: c.name,
      symbol: c.symbol,
      network: c.network,
      available: r?.available ?? "0",
      locked: r?.locked ?? "0",
    });
  }

  const rank = (code: string) => (SECONDARY_ACCOUNTS.includes(code) ? SECONDARY_ACCOUNTS.indexOf(code) : SECONDARY_ACCOUNTS.length + code.charCodeAt(0));
  other.sort((a, b) => rank(a.currencyCode) - rank(b.currencyCode));

  const pts = byCode.get("VBP") ?? { available: "0", locked: "0" };

  return {
    userId,
    country,
    primary: {
      currencyCode: pc.code,
      symbol: pc.symbol,
      name: pc.name,
      available: primaryRow.available,
      locked: primaryRow.locked,
    },
    otherAccounts: other,
    loyaltyPoints: { available: pts.available },
  };
}

/* --- validation --------------------------------------------------------- */

function validateMovement(m: MovementInput): void {
  if (!m.idempotencyKey || m.idempotencyKey.length < 8) {
    throw new BalanceError("idempotencyKey must be at least 8 characters");
  }
  if (m.legs.length < 2) throw new BalanceError("A movement needs at least 2 legs");

  const sums = new Map<string, { credit: number; debit: number }>();
  for (const leg of m.legs) {
    if (!leg.userId && !leg.systemAccount) {
      throw new BalanceError("Every leg is either a user or a system account");
    }
    if (leg.userId && leg.systemAccount) {
      throw new BalanceError("A leg cannot be both a user and a system account");
    }
    const cur = getCurrency(leg.currencyCode);
    // Amounts are major units (₵ 25.50) and must fit the currency's minor unit (pesewas for GHS).
    // The tolerance absorbs float noise such as 0.1 + 0.2.
    const scaled = leg.amountMajor * 10 ** cur.decimals;
    if (cur.kind !== "CRYPTO" && Math.abs(scaled - Math.round(scaled)) > 1e-6) {
      throw new BalanceError(
        `Amount for ${leg.currencyCode} must be a whole number of minor units (at most ${cur.decimals} decimal places)`
      );
    }
    if (leg.amountMajor <= 0) throw new BalanceError("Leg amounts must be positive");

    const s = sums.get(leg.currencyCode) ?? { credit: 0, debit: 0 };
    if (leg.direction === "CREDIT") s.credit += leg.amountMajor;
    else s.debit += leg.amountMajor;
    sums.set(leg.currencyCode, s);
  }

  // Fail fast before hitting the DB with an unbalanced journal.
  for (const [code, s] of sums) {
    if (s.credit !== s.debit) {
      throw new BalanceError(
        `Unbalanced movement for ${code}: credits ${s.credit} != debits ${s.debit}`
      );
    }
  }
}

export { toDbAmount, minWithdrawal as getMinWithdrawal, CurrencyError };
