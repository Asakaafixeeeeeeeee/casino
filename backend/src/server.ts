// src/server.ts
// Entrypoint. Bootstraps the pool, seeds the in-memory currency catalog, then
// listens. Separated from app.ts so `createApp` is unit-testable without a port.

import { db } from "./db.js";
import { loadCurrencyCatalog } from "./bootstrap.js";
import { createApp } from "./app.js";
import { startPendingRecheck } from "./routes/payments.js";
import { startFlightSweep } from "./games/flights.js";
import { startLiveSweep } from "./games/minesLive.js";
import { startSessionSweep } from "./games/sessions.js";
import { startSkySweep } from "./games/skyRush.js";
import { startKeepWarm } from "./keepWarm.js";

const PORT = Number(process.env.PORT ?? 8781);

async function main(): Promise<void> {
  // Catalog first; money.ts throws until it is loaded, so nothing can run cold.
  const client = await db.connect();
  try {
    const catalog = await loadCurrencyCatalog(client);
    console.log(`loaded ${catalog.length} active assets`);
  } finally {
    client.release();
  }

  const app = createApp(db);
  app.listen(PORT, () => console.log(`balance service on :${PORT}`));
  startPendingRecheck(db);
  startFlightSweep(db);
  startLiveSweep(db);
  startSessionSweep(db);
  startSkySweep(db);
  startKeepWarm();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
