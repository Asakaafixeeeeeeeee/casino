// src/db.ts
//
// A thin wrapper over `pg`'s Pool. Centralised so tests can swap a PGlite-backed
// client in behind the same interface the routes use, and so the currency
// catalog loader has a handle to run its one-time query against.

import { Pool } from "pg";
import type { PoolClient } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // The accounts API uses public.users; wallet migrations and queries live in
  // an isolated schema in the same Render Postgres database.
  options: "-c search_path=wallet,public",
  // Production-recommended guardrail: don't let the app wait forever when the
  // DB is wedged, so a node pool can shed load instead of queueing forever.
  connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS ?? 5000),
  idleTimeoutMillis: 30000,
  max: Number(process.env.DB_MAX_CLIENTS ?? 20),
});

// An idle connection can fail on its own — the database restarting for maintenance, a network blip. pg reports that
// on the pool, and an unhandled 'error' event would crash the whole service; the pool drops the broken connection
// and opens a fresh one on the next query, so logging it is enough.
pool.on("error", (err) => {
  console.error("[db] idle connection error (it will be replaced):", err.message);
});

export { pool as db, type PoolClient };

// Allow injecting a custom client (used by tests that boot PGlite).
export type DB = {
  connect(): Promise<PoolClient>;
  query: Pool["query"];
};
