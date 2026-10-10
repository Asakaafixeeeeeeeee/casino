// src/bootstrap.ts
//
// The currency catalog is read ONCE at process start from the DB and held in
// memory for the life of the process. Rationale:
//   - Currencies are config data; they change rarely.
//   - Reading them per-request would cost one query per money operation.
//   - A reload endpoint is available for when a deploy activates a new asset.
//
// The catalog is what makes `money.ts` work in-process; until it is loaded,
// every money helper throws, so there is no code path that runs on a stale/empty table.

import type { PoolClient } from "pg";
import type { CurrencyInfo } from "./money.js";
import { setCatalog } from "./money.js";

export async function loadCurrencyCatalog(client: PoolClient): Promise<CurrencyInfo[]> {
  const r = await client.query<{
    code: string;
    kind: string;
    name: string;
    symbol: string;
    decimals: number;
    min_withdrawal: string;
    is_stablecoin: boolean;
    network: string | null;
  }>(
    `SELECT code, kind, name, symbol, decimals, min_withdrawal, is_stablecoin, network
       FROM currencies
      WHERE is_active
      ORDER BY kind, code`
  );

  const catalog: CurrencyInfo[] = r.rows.map((c) => ({
    code: c.code,
    kind: c.kind as CurrencyInfo["kind"],
    name: c.name,
    symbol: c.symbol,
    decimals: Number(c.decimals),
    minWithdrawalMajor: Number(c.min_withdrawal),
    stablecoin: Boolean(c.is_stablecoin),
    network: c.network,
  }));

  setCatalog(catalog);
  return catalog;
}

export async function reloadCatalog(client: PoolClient): Promise<void> {
  await loadCurrencyCatalog(client);
}
