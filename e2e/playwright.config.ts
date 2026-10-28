/* End-to-end suite for RendoWin. One shared stack per run, all on this machine:
     site             http://localhost:8808  (the repository root, served as files)
     accounts server  http://localhost:8792  (accounts-api/server.js on an in-memory PGlite)
     balance service  http://localhost:8781  (backend/src/server.ts on a real throwaway Postgres, production migrations)
     payment gateway  http://127.0.0.1:8796  (stack/teller-stub.mjs: approves, declines or stalls by number)
   The browser is the Google Chrome installed on the machine (channel "chrome"); nothing is downloaded. */
import { defineConfig } from "@playwright/test";

const GATEWAY = "http://127.0.0.1:8796";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,                     /* one shared stack and one set of per-IP rate limits */
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://localhost:8808",
    channel: "chrome",
    headless: true,
    viewport: { width: 420, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node stack/teller-stub.mjs",
      url: `${GATEWAY}/health`,
      env: { PORT: "8796" },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node ../accounts-api/server.js",
      url: "http://localhost:8792/health",
      /* the whole suite signs in from one address: past the usual 40 a run's last sign-ups were refused. The limit
         itself is tested in accounts-api/test. */
      env: { PORT: "8792", PGLITE_DIR: "memory://", DATABASE_URL: "", SIGNIN_RATE_LIMIT: "1000", ACCOUNTS_INTERNAL_SECRET: "e2e-internal-secret-0123456789" },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "node --import tsx ../e2e/stack/backend.mts",
      cwd: "../backend",
      url: "http://localhost:8781/_health",
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },   /* lets the throwaway Postgres stop cleanly */
      env: {
        PORT: "8781",
        ACCOUNTS_API_URL: "http://localhost:8792",
        PUBLIC_URL: "http://localhost:8808",
        SITE_URL: "http://localhost:8808",
        PAYMENT_TEST_MODE: "true",
        PAYTELLER_API_BASE_URL: `${GATEWAY}/api/v1`,
        PAYTELLER_MERCHANT_ID: "TTM-00000001",
        PAYTELLER_USERNAME: "e2e-user",
        PAYTELLER_API_KEY: "e2e-key",
        TELLER_BASE_URL: GATEWAY,
        TELLER_CHECKOUT_URL: GATEWAY,                 /* never the real gateway from a test */
        TELLER_MERCHANT_ID: "TTM-00000001",
        TELLER_API_USERNAME: "e2e-user",
        TELLER_API_KEY: "e2e-key",
        TELLER_PASSCODE: "e2e-passcode",
        FX_USD_GHS_URL: `${GATEWAY}/fx`,
        ADMIN_PHONES: "0209999001",
        ACCOUNTS_INTERNAL_SECRET: "e2e-internal-secret-0123456789",
        DATABASE_URL: "",
      },
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: "node stack/static.mjs",
      url: "http://localhost:8808/index.html",
      env: { PORT: "8808" },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
