import type { Pool } from "pg";
import { getCurrency } from "../money.js";

/*
 * Exchange rates for converting between a player's accounts: their country's currency (GHS) and US dollars. The rate
 * comes from a public exchange-rate feed (open.er-api.com, or whatever FX_USD_GHS_URL points at); every fetch is
 * snapshotted into fx_rates so a short feed outage falls back to the last good rate, and a long one refuses
 * conversions rather than guessing. The executed rate is always written on the conversion's own journal entry.
 */

export const FX_SPREAD = Math.min(0.1, Math.max(0, Number(process.env.FX_SPREAD ?? 0.015)));   // 1.5% each way
export const FX_CACHE_MS = 60_000;          // how long one fetch is reused
export const FX_MAX_AGE_MS = 15 * 60_000;   // older than this and the feed is "unavailable"
export const FX_BASE = "GHS";
/** The currencies that can be converted between, priced in GHS. */
export const FX_CURRENCIES = ["USD"];

export class FxError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "FxError";
  }
}

export interface RateSheet { rates: Record<string, number>; asOf: Date; source: string }

const usdFeedUrl = () => process.env.FX_USD_GHS_URL || "https://open.er-api.com/v6/latest/USD";

let cache: RateSheet | null = null;
let inflight: Promise<RateSheet | null> | null = null;

/** The feed, as { USD: <GHS per US dollar> }, or null when it can't be read. */
async function fetchFeed(): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(usdFeedUrl(), { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = (await res.json()) as { rates?: Record<string, unknown> };
    const v = Number(body?.rates?.[FX_BASE]);
    return Number.isFinite(v) && v > 0 ? { USD: v } : null;
  } catch {
    return null;
  }
}

/** Current prices in GHS: the cache, then the feed (snapshotted into fx_rates), then the last snapshot if recent. */
export async function getRates(db: Pool, now = Date.now()): Promise<RateSheet> {
  if (cache && now - cache.asOf.getTime() < FX_CACHE_MS) return cache;
  if (!inflight) {
    inflight = (async () => {
      const live = await fetchFeed();
      if (live) {
        const asOf = new Date();
        const values = Object.entries(live);
        await db.query(
          `INSERT INTO fx_rates (base_currency, quote_currency, rate, source, as_of)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::numeric[], $4::text[], $5::timestamptz[])
           ON CONFLICT DO NOTHING`,
          [values.map(([c]) => c), values.map(() => FX_BASE), values.map(([, r]) => String(r)), values.map(() => "feed"), values.map(() => asOf)],
        );
        return (cache = { rates: live, asOf, source: "feed" });
      }
      /* the last snapshot per currency, if it's recent enough to price by */
      const { rows } = await db.query<{ base_currency: string; rate: string; as_of: Date }>(
        `SELECT DISTINCT ON (base_currency) base_currency, rate, as_of FROM fx_rates
          WHERE quote_currency = $1 AND source = 'feed' AND as_of > $2
          ORDER BY base_currency, as_of DESC`,
        [FX_BASE, new Date(now - FX_MAX_AGE_MS)],
      );
      if (!rows.length) return null;
      const rates: Record<string, number> = {};
      let oldest = Infinity;
      for (const r of rows) { rates[r.base_currency] = Number(r.rate); oldest = Math.min(oldest, new Date(r.as_of).getTime()); }
      return (cache = { rates, asOf: new Date(oldest), source: "snapshot" });
    })().finally(() => { inflight = null; });
  }
  const sheet = await inflight;
  if (!sheet) throw new FxError("rates_unavailable", "Exchange rates aren't available right now — try again in a few minutes.", 503);
  return sheet;
}

/** Tests and admin tools: forget the cached sheet. */
export function resetRateCache(): void { cache = null; }

export interface Quote {
  from: string;
  to: string;
  amount: number;
  /** What the player receives, rounded down to the currency's precision. */
  receive: number;
  /** receive ÷ amount — the all-in rate the conversion executes at. */
  rate: number;
  /** The feed's mid rate before the spread. */
  mid: number;
  spread: number;
  /** The GHS value of what's being converted (the minimum is GHS 1). */
  valueGhs: number;
  asOf: Date;
  source: string;
}

const MIN_VALUE_GHS = 1;
const floorTo = (n: number, decimals: number) => {
  const f = Math.pow(10, Math.min(decimals, 8));
  return Math.floor(n * f + 1e-9) / f;
};

/** A firm quote: amount of `from` → how much `to`, at the current rate less the spread. */
export async function quoteConversion(db: Pool, from: unknown, to: unknown, amount: unknown): Promise<Quote> {
  const f = String(from ?? "").toUpperCase();
  const t = String(to ?? "").toUpperCase();
  const convertible = (c: string) => c === FX_BASE || FX_CURRENCIES.includes(c);
  if (!convertible(f) || !convertible(t)) throw new FxError("invalid_currency", "Choose two accounts that can be converted.");
  if (f === t) throw new FxError("same_currency", "Choose two different accounts.");
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new FxError("invalid_amount", "Enter an amount to convert.");
  /* to the cent: a finer amount reached the ledger and came back as a 500 */
  if (Math.abs(amt * 100 - Math.round(amt * 100)) > 1e-6) throw new FxError("invalid_amount", "Amounts go to the cent (two decimal places).");
  const sheet = await getRates(db);
  const priceGhs = (c: string) => (c === FX_BASE ? 1 : sheet.rates[c]);
  if (!priceGhs(f) || !priceGhs(t)) throw new FxError("rates_unavailable", "No rate for that currency right now.", 503);
  const valueGhs = amt * priceGhs(f)!;
  if (valueGhs + 1e-9 < MIN_VALUE_GHS) throw new FxError("too_small", `Convert at least ₵ ${MIN_VALUE_GHS.toFixed(2)} worth.`);
  const mid = priceGhs(f)! / priceGhs(t)!;
  const receive = floorTo(amt * mid * (1 - FX_SPREAD), getCurrency(t).decimals);
  if (receive <= 0) throw new FxError("too_small", "That amount is too small to convert.");
  return { from: f, to: t, amount: amt, receive, rate: receive / amt, mid, spread: FX_SPREAD, valueGhs, asOf: sheet.asOf, source: sheet.source };
}
