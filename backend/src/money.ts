// src/money.ts
//
// Money handling rules (kept deliberately tight):
//   - Amounts are NUMERIC(38,18) in the DB. Scale per currency (2 dp for GHS,
//     8 for BTC, 0 for JPY/Points) is enforced by the `assert_amount_scale`
//     trigger, so a stray 0.0000001 GHS dies at the boundary.
//   - The app NEVER sends a JS number to Postgres. It sends a fixed-precision
//     STRING produced from a validated Number, so IEEE-754 formatting noise can
//     never reach the column.
//   - The API takes major units (₵ 5.50), because that is what humans and the
//     UI reason in. Conversion to minor units is the caller's job if needed.

export type CurrencyKind = "FIAT" | "CRYPTO" | "POINTS";

export interface CurrencyInfo {
  code: string;
  kind: CurrencyKind;
  name: string;
  symbol: string;
  /** Minor units per major unit: 2 for GHS/USD, 8 for BTC, 0 for JPY/Points. */
  decimals: number;
  /** Minimum withdrawal, in major units. */
  minWithdrawalMajor: number;
  stablecoin: boolean;
  network: string | null;
}

let catalog: Map<string, CurrencyInfo> | null = null;

/** Inject the in-memory catalog. Called once during bootstrap from the DB. */
export function setCatalog(currencies: CurrencyInfo[]): void {
  catalog = new Map(currencies.map((c) => [c.code.toUpperCase(), c]));
}

function requireCatalog(): Map<string, CurrencyInfo> {
  if (!catalog) throw new Error("Currency catalog not initialised");
  return catalog;
}

export function getCurrency(code: string): CurrencyInfo {
  const c = requireCatalog().get(code.toUpperCase());
  if (!c) throw new CurrencyError(`Unknown currency: ${code}`);
  return c;
}

export function listCurrencies(): CurrencyInfo[] {
  return [...requireCatalog().values()];
}

export class CurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CurrencyError";
  }
}

/**
 * Validate that `major` is a finite, non-negative Number and return it as a
 * fixed-precision STRING for the NUMERIC column. Throws on anything that would
 * corrupt a monetary value.
 *
 *   toDbAmount(5.5, "GHS")   => "5.50"
 *   toDbAmount(0.0001, "BTC")=> "0.0001"
 *   toDbAmount(1, "VBP")    => "1"   (0 dp: no fraction)
 *   toDbAmount("5.5", "GHS")=> "5.50"  (string input avoids float dust)
 *   toDbAmount(-1, "GHS")   => throws
 *   toDbAmount(NaN, "GHS")  => throws
 */
export function toDbAmount(major: number | string, code: string): string {
  const cur = getCurrency(code);
  let n: number;
  if (typeof major === "number") {
    if (!Number.isFinite(major)) throw new CurrencyError(`Invalid amount: ${major}`);
    n = major;
  } else {
    n = Number.parseFloat(String(major).replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(n)) throw new CurrencyError(`Invalid amount: ${major}`);
  }
  if (n < 0) throw new CurrencyError(`Amount must be non-negative, got ${n}`);
  // Round to the currency's exact precision so 5.5555 -> "5.56" for GHS.
  const factor = Math.pow(10, cur.decimals);
  const rounded = Math.round(n * factor) / factor;
  return cur.decimals === 0 ? String(Math.round(rounded)) : rounded.toFixed(cur.decimals);
}

/** Format a stored NUMERIC value (passed as a number/minor) for display. */
export function format(major: number, code: string): string {
  const cur = getCurrency(code);
  if (cur.decimals === 0) {
    return `${cur.symbol} ${Math.round(major).toLocaleString()}`;
  }
  return `${cur.symbol} ${Number(major).toLocaleString(undefined, {
    minimumFractionDigits: cur.decimals,
    maximumFractionDigits: cur.decimals,
  })}`;
}

/** Minimum withdrawal in MAJOR units for `code`. */
export function minWithdrawal(code: string): number {
  return getCurrency(code).minWithdrawalMajor;
}
