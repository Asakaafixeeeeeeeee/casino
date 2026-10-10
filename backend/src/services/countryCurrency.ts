// src/services/countryCurrency.ts
//
// Pure lookup service: "what is the default currency for this country?"
// Driven entirely by the `countries` and `currencies` tables — never hardcoded.
// Adding a country at registration is an INSERT into `countries`, no code change.

import type { PoolClient } from "pg";
import type { CurrencyInfo } from "../money.js";
import { getCurrency } from "../money.js";

export interface CountryInfo {
  code: string;            // ISO 3166-1 alpha-2, e.g. "GH"
  name: string;            // "Ghana"
  currencyCode: string;    // ISO 4217 / ticker, e.g. "GHS"
  currency: CurrencyInfo;  // full metadata incl. symbol & decimals
}

/**
 * Resolve a country code to its default fiat currency.
 * Throws a clear error for unsupported or unknown countries so registration
 * fails closed instead of silently defaulting.
 */
export async function countryCurrency(client: PoolClient, countryCode: string): Promise<CountryInfo> {
  if (!countryCode || countryCode.length !== 2) {
    throw new Error("country code must be a 2-letter ISO 3166-1 code");
  }

  const r = await client.query<{
    code: string;
    name: string;
    currency_code: string;
    supported: boolean;
  }>(
    `SELECT c.code, c.name, c.default_currency AS currency_code, c.is_supported AS supported
       FROM countries c
      WHERE c.code = $1`,
    [countryCode.toUpperCase()]
  );

  if (!r.rowCount) {
    throw new Error(`Unsupported country code: ${countryCode}`);
  }
  const row = r.rows[0]!;
  if (!row.supported) {
    throw new Error(`Country ${countryCode} is not available for registration`);
  }

  const cur = getCurrency(row.currency_code);

  return {
    code: row.code,
    name: row.name,
    currencyCode: row.currency_code,
    currency: cur,
  };
}

/** All supported countries and their primary currency, for a registration form. */
export async function listSupportedCountries(client: PoolClient): Promise<CountryInfo[]> {
  const r = await client.query<{
    code: string;
    name: string;
    currency_code: string;
  }>(
    `SELECT c.code, c.name, c.default_currency AS currency_code
       FROM countries c
      WHERE c.is_supported
      ORDER BY c.name`
  );
  return r.rows.map((row) => {
    const cur = getCurrency(row.currency_code);
    return {
      code: row.code,
      name: row.name,
      currencyCode: row.currency_code,
      currency: cur,
    };
  });
}
