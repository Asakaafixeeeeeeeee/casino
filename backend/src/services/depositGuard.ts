/* Deposit safety checks that run on our side before any payment request is sent to TheTeller:
   the registered number (the only one that may pay, confirmed once), a valid Ghanaian mobile money number on a
   supported network. A gateway's real answer is never touched here. */
import type { Pool, PoolClient } from "pg";
import { canonicalTellerSubscriberNumber, networkForPhone, type MomoNetwork } from "./teller.js";
import { activeDepositRestriction } from "./depositRestrictions.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export const PHONE_NOT_CONFIRMED_MESSAGE =
  "Please confirm your registered phone number before depositing. It will be used exclusively for all your deposits.";

export class DepositGuardError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

/** The registered number as 0XXXXXXXXX, or null when it isn't a Ghanaian mobile number. */
export function localNumber(raw: unknown): string | null {
  const subscriber = canonicalTellerSubscriberNumber(raw);
  return subscriber ? "0" + subscriber.slice(3) : null;
}

/** Whether this account has confirmed (or accepted at sign-up) its registered number, and which number is locked. */
export async function lockedNumber(db: Queryable, userId: string): Promise<{ confirmed: boolean; phone: string | null }> {
  const { rows } = await db.query<{ deposit_phone: string | null; deposit_phone_confirmed_at: Date | null }>(
    `SELECT deposit_phone, deposit_phone_confirmed_at FROM users WHERE id = $1`, [userId]);
  const r = rows[0];
  return { confirmed: !!r?.deposit_phone_confirmed_at && !!r.deposit_phone, phone: r?.deposit_phone ?? null };
}

/** The checks on the number itself: a confirmed, locked number that is the registered one, with a supported network.
 *  Returns the digits TheTeller expects and the network the number belongs to. No provider number-lookup service is
 *  integrated, so a number that's well-formed but not active is reported by TheTeller's own answer to the request,
 *  exactly as it comes back. */
export async function checkRegisteredNumber(db: Queryable, userId: string, sessionPhone: string): Promise<{ subscriber: string; local: string; network: MomoNetwork }> {
  const local = localNumber(sessionPhone);
  if (!local) throw new DepositGuardError(400, "invalid_account", "Your registered phone number is not a valid Ghanaian mobile money number, so mobile money deposits aren't available. Contact support.");
  const locked = await lockedNumber(db, userId);
  if (!locked.confirmed) throw new DepositGuardError(409, "phone_not_confirmed", PHONE_NOT_CONFIRMED_MESSAGE);
  if (localNumber(locked.phone) !== local) {
    throw new DepositGuardError(403, "phone_mismatch", "Deposits can only be made from the phone number linked to your account. Contact support.");
  }
  const network = networkForPhone(local);
  if (!network) throw new DepositGuardError(400, "unsupported_network", "Your registered number isn't on a supported mobile money network (MTN, Telecel or AirtelTigo).");
  return { subscriber: "233" + local.slice(1), local, network };
}

/** What the deposit page needs: the registered number, whether it's confirmed, and the wait left. */
export async function depositState(db: Queryable, userId: string, sessionPhone: string) {
  const local = localNumber(sessionPhone);
  const locked = await lockedNumber(db, userId);
  const restriction = await activeDepositRestriction(db, userId);
  return {
    phone: local ?? (sessionPhone || null),
    network: local ? networkForPhone(local) : null,
    confirmed: locked.confirmed,
    retry_after_seconds: restriction?.retry_after_seconds ?? 0,
    available_at: restriction?.expires_at ?? null,
    restriction,
  };
}

/** The one-time "CONFIRM & LOCK NUMBER": saves the registered number against the account. The number shown on the
 *  popup must still be the registered one; a number already confirmed is never changed. */
export async function confirmDepositPhone(db: Queryable, userId: string, sessionPhone: string, shown: unknown): Promise<void> {
  const local = localNumber(sessionPhone);
  if (!local) throw new DepositGuardError(400, "invalid_account", "Your registered phone number isn't a valid Ghanaian mobile money number. Contact support.");
  if (shown !== undefined && localNumber(shown) !== local) {
    throw new DepositGuardError(409, "phone_changed", "The number shown doesn't match your registered number. Please reload the page and try again.");
  }
  await db.query(
    `UPDATE users SET deposit_phone = $2, deposit_phone_confirmed_at = now() WHERE id = $1 AND deposit_phone_confirmed_at IS NULL`,
    [userId, local]);
}
