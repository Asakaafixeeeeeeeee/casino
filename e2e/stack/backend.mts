/* The balance service for the end-to-end suite, run the way production runs it: src/server.ts (currency catalog,
   API, payment recheck, flight / Live Mines / abandoned-round sweeps) after migrate-production.mjs, on a REAL
   throwaway Postgres (embedded-postgres), so concurrency tests exercise real transactions and row locks.
   E2E_DB=pglite uses the unit tests' in-memory PGlite instead (one shared connection: no real concurrency).
   Started by playwright.config.ts with the working directory set to backend/. Writes the database URL to
   e2e/.stack/db-url so tests can check ledger invariants straight in SQL. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stackDir = path.join(here, "..", ".stack");
mkdirSync(stackDir, { recursive: true });

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

if (process.env.E2E_DB === "pglite") {
  const { setupWalletDb } = await import("../../backend/test/helpers/walletDb.ts");
  const { createApp } = await import("../../backend/src/app.ts");
  const shared = await import("../../backend/src/db.ts");
  const env = await setupWalletDb();
  (shared.db as unknown as { query: unknown }).query = env.db.query.bind(env.db);
  (shared.db as unknown as { connect: unknown }).connect = env.db.connect.bind(env.db);
  writeFileSync(path.join(stackDir, "db-url"), "pglite");
  const port = Number(process.env.PORT || 8781);
  createApp(env.db).listen(port, () => console.log(`[e2e] balance service (PGlite) on http://localhost:${port}`));
} else {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dir = mkdtempSync(path.join(os.tmpdir(), "rw-e2e-pg-"));
  const port = await freePort();
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "e2e", port, persistent: false, onLog: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("rendowin");
  const stop = async () => {
    try { await pg.stop(); } catch { /* already down */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.env.DATABASE_URL = `postgres://postgres:e2e@127.0.0.1:${port}/rendowin`;
  writeFileSync(path.join(stackDir, "db-url"), process.env.DATABASE_URL);
  console.log(`[e2e] Postgres on 127.0.0.1:${port}; applying migrations`);
  await import("../../backend/migrate-production.mjs");
  await import("../../backend/src/server.ts");
}
