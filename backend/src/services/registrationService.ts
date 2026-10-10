// src/services/registrationService.ts
//
// Wires the country -> currency mapping into account creation.
//
// This is the moment where "registered from Ghana" becomes "primary balance
// in GHS": the country is resolved to its default currency and that currency is
// frozen onto the user row. Freezing (rather than re-deriving on read) means a
// future change to the countries table never silently re-labels a user's money.

import type { PoolClient } from "pg";
import { hashPassword } from "../crypto.js";
import { countryCurrency } from "./countryCurrency.js";

export interface RegisterInput {
  email: string;
  password: string;
  username?: string;
  /** ISO 3166-1 alpha-2, e.g. "GH". */
  countryCode: string;
}

export interface RegisterResult {
  userId: string;
  email: string;
  username: string | null;
  country: string;
  /** Primary fiat currency, e.g. "GHS". */
  primaryCurrency: string;
  /** Symbol + decimals, ready for the UI label. */
  currencySymbol: string;
  currencyDecimals: number;
}

/**
 * Register a new user. Runs entirely in the caller's transaction so that a
 * failure to create the initial empty balances rolls the user insert back too.
 */
export async function registerUser(
  client: PoolClient,
  input: RegisterInput
): Promise<RegisterResult> {
  const { email, password, username, countryCode } = input;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Invalid email");
  }
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  // (1) Resolve country -> default currency BEFORE inserting the row.
  const info = await countryCurrency(client, countryCode);

  // (2) Hash the password. Uses Node's crypto.pbkdf2 (built-in; no native deps
  // for the install). Production-grade hashing (argon2id / bcrypt) can swap in
  // by replacing the one function in src/crypto.ts.
  const passwordHash = await hashPassword(password);

  // (3) Insert. The trigger assert_primary_is_fiat() guarantees the chosen
  // currency is a real FIAT row before the row can exist.
  const inserted = await client.query<{
    id: string; email: string; username: string | null; primary: string;
  }>(
    `INSERT INTO users (email, password_hash, username, country_code, primary_currency_code)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, username, primary_currency_code AS primary`,
    [email.toLowerCase(), passwordHash, username ?? null, info.code, info.currencyCode]
  );
  const u = inserted.rows[0]!;

  // (4) Seed empty balance rows for the primary currency and for loyalty
  // points. Doing this inside the same transaction means a concurrent reader
  // never sees the user exist without their balance rows.
  await client.query(
    `INSERT INTO user_balances (user_id, currency_code, available, locked, total_deposited, total_withdrawn)
     VALUES
       ($1, $2, 0, 0, 0, 0),
       ($1, 'VBP', 0, 0, 0, 0)
     ON CONFLICT DO NOTHING`,
    [u.id, u.primary]
  );

  return {
    userId: u.id,
    email: u.email,
    username: u.username,
    country: info.code,
    primaryCurrency: u.primary,
    currencySymbol: info.currency.symbol,
    currencyDecimals: info.currency.decimals,
  };
}
