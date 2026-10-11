// src/app.ts
//
// Express application wiring. Error handling is centralised so money errors
// turn into the right HTTP status instead of leaking a stack trace to the UI.

import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import type { Pool } from "pg";
import { balancesRouter } from "./routes/balances.js";
import { paymentsRouter } from "./routes/payments.js";
import { adminRouter } from "./routes/admin.js";
import { gamesRouter } from "./routes/games.js";
import { partnersRouter } from "./routes/partners.js";
import { supportRouter } from "./routes/support.js";
import { authenticate } from "./middleware/authenticate.js";

// Minimal error shape used below.
interface HttpError extends Error {
  status?: number;
}

export function createApp(db: Pool): express.Express {
  const app = express();

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*")
    .split(",").map((s) => s.trim()).filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (allowedOrigins.includes("*")) {
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });

  // Support chat messages run to 1,000 characters, which as JSON in UTF-8 (₵, ɛ, ɔ, emoji, line breaks) can pass
  // 1 KB; those paths get a parser of their own, and the 1 KB one below skips a body that's already been read.
  app.use(["/api/support", "/api/admin/support"], express.json({ limit: "8kb" }));
  // promotional images an admin uploads (as data: URLs, up to 2 MB of image), and the partner forms and campaigns
  app.use("/api/admin/flyer-assets", express.json({ limit: "3mb" }));
  app.use(["/api/admin/partners", "/api/admin/partner-permissions", "/api/admin/flyer-templates", "/api/admin/flyer-campaigns",
    "/api/partners/flyers"], express.json({ limit: "8kb" }));
  app.use(express.json({ limit: "1kb" })); // we never take bulk bodies here
  // helmet sets X-Content-Type-Options, frame-ancestors, HSTS, etc.
  app.use(helmet());

// Idempotency: every POST must carry a key. The balance service rejects
// duplicates via the UNIQUE journal constraint; this just enforces the
// contract at the edge for a clear 400 instead of a 409.
  app.use("/api/user/", (req, _res, next) => {
    if (req.method === "POST" && !(req.body?.idempotency_key)) {
      const err: HttpError = new Error("missing idempotency_key");
      err.status = 400;
      next(err);
      return;
    }
    next();
  });
  app.use("/api/payments/", (req, _res, next) => {
    if (req.method === "POST" && !(req.body?.idempotency_key)) {
      const err: HttpError = new Error("missing idempotency_key");
      err.status = 400;
      next(err);
      return;
    }
    next();
  });

  app.use("/api/user", authenticate, balancesRouter(db));
  app.use("/api/payments", paymentsRouter(db));
  app.use("/api/admin", adminRouter(db));
  app.use("/api/games", gamesRouter(db));
  app.use("/api/partners", partnersRouter(db));
  app.use("/api/support", supportRouter(db));

  // A health check that also proves the DB connection still works.
  app.get("/_health", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ status: "ok" });
    } catch (e) {
      res.status(503).json({ status: "degraded" });
    }
  });

  // --- Centralised error handler -------------------------------------------
  app.use((err: HttpError, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    const code =
      err.name === "InsufficientFundsError"
        ? 409
        : err.name === "IdempotencyError"
        ? 409
        : err.name === "CurrencyError"
        ? 400
        : err.name === "TellerConfigurationError"
        ? 503
        : status;

    // Never leak internal details past the error name/message boundary.
    res.status(code).json({
      error: err.name ?? "Error",
      message: err.message,
    });
  });

  return app;
}
