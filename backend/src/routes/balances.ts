// src/routes/balances.ts
//
// GET /api/user/balances
//
// Returns the user's full balance view:
//   - primary:   the fiat balance in the currency frozen at registration
//   - otherAccounts:  every crypto (and any extra fiat) sub-balance
//   - loyaltyPoints:  the [AppName] Points balance
//
// The numbers come from `user_balances`, a cache of the ledger. Balances are
// written by the balance service inside the same transaction as the ledger
// entry, so a read here always reflects committed money within its isolation
// level. The response is read-only and never blocks. Money only enters through a
// TheTeller deposit confirmed server-side (routes/payments.ts) and only leaves
// through an admin-approved withdrawal; there is deliberately no endpoint that
// credits a balance directly or moves money between players.

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { Pool } from "pg";
import { getUserBalances } from "../services/balanceService.js";
import { requireUser } from "../middleware/authenticate.js";
import { FeedbackError, listTransactions, saveFeedback } from "../services/accountActivity.js";
import { requestWithdrawal, winRequirement, WIN_MULTIPLE, WithdrawalError } from "../services/withdrawals.js";
import { getLimits, LimitError, selfExclude, setLimits } from "../services/responsibleGaming.js";
import { convert } from "../services/conversions.js";
import { FxError, quoteConversion } from "../services/fxRates.js";

export function balancesRouter(db: Pool): Router {
  const r = Router();

  /* ------------------------------------------------------------------- */
  /* GET /api/user/balances                                              */
  /* ------------------------------------------------------------------- */
  r.get("/balances", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const client = await db.connect();
      try {
        const view = await getUserBalances(client, user.id);
        res.json({
          // Echo the country + symbol together so the UI can label the primary
          // balance without a second round-trip.
          country: {
            code: view.country,
            currency: {
              code: view.primary.currencyCode,
              symbol: view.primary.symbol,
              name: view.primary.name,
            },
          },
          primary: view.primary,
          otherAccounts: view.otherAccounts,
          loyaltyPoints: view.loyaltyPoints,
        });
      } finally {
        client.release();
      }
    } catch (e) {
      next(e);
    }
  });

  /* ------------------------------------------------------------------- */
  /* POST /api/user/withdraw                                             */
  /* Body: { amount, idempotency_key }. Paid only to the registered      */
  /* number, after an admin approves it.                                 */
  /* ------------------------------------------------------------------- */
  /* GET /api/user/withdraw/requirement: how far the player's winnings are from WIN_MULTIPLE x their deposits */
  r.get("/withdraw/requirement", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      res.setHeader("Cache-Control", "no-store");
      res.json({ multiple: WIN_MULTIPLE, ...(await winRequirement(db, user.id)) });
    } catch (e) {
      next(e);
    }
  });

  r.post("/withdraw", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const { amount, idempotency_key } = req.body as { amount?: unknown; idempotency_key?: unknown };
      const amt = Math.round(Number(amount) * 100) / 100;
      if (!Number.isFinite(amt) || amt <= 0) {
        res.status(400).json({ error: "invalid_amount", message: "Enter an amount" });
        return;
      }
      const w = await requestWithdrawal(db, user, amt, String(idempotency_key));
      res.status(201).json({ status: "requested", id: w.id, amount: amt, phone: user.phone });
    } catch (e) {
      if (e instanceof WithdrawalError) {
        res.status(e.status).json({ error: e.code, message: e.message });
        return;
      }
      if (e instanceof Error && e.name === "InsufficientFundsError") {
        res.status(409).json({ error: "insufficient_funds", message: "That's more than your balance (or below the minimum withdrawal)." });
        return;
      }
      next(e);
    }
  });

  /* ------------------------------------------------------------------- */
  /* Converting between the player's own accounts (GHS <-> crypto).      */
  /* GET  /api/user/convert/quote?from=GHS&to=BTC&amount=50               */
  /* POST /api/user/convert  { from, to, amount, idempotency_key }        */
  /* Money stays with the same player; the FX desk is the counterparty.  */
  /* ------------------------------------------------------------------- */
  const fxErr = (e: unknown, res: Response) => {
    if (e instanceof FxError) {
      res.status(e.status).json({ error: e.code, message: e.message });
      return true;
    }
    return false;
  };
  r.get("/convert/quote", async (req: Request, res: Response, next: NextFunction) => {
    try {
      requireUser(req);
      res.setHeader("Cache-Control", "no-store");
      res.json(await quoteConversion(db, req.query.from, req.query.to, req.query.amount));
    } catch (e) {
      if (!fxErr(e, res)) next(e);
    }
  });
  r.post("/convert", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const out = await convert(db, user.id, (req.body ?? {}) as Record<string, unknown>);
      res.status(201).json({ status: "converted", journal_id: out.journalId, quote: out.quote, primary: out.balances.primary, otherAccounts: out.balances.otherAccounts, loyaltyPoints: out.balances.loyaltyPoints });
    } catch (e) {
      if (!fxErr(e, res)) next(e);
    }
  });

  /* Responsible gambling: deposit limits and breaks */
  const limitErr = (e: unknown, res: Response) => {
    if (e instanceof LimitError) {
      res.status(e.status).json({ error: e.code, message: e.message });
      return true;
    }
    return false;
  };
  r.get("/limits", async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await getLimits(db, requireUser(req).id));
    } catch (e) {
      next(e);
    }
  });
  r.post("/limits", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(await setLimits(db, requireUser(req).id, Object.fromEntries(
        (["daily", "weekly", "monthly"] as const).filter((p) => p in body).map((p) => [p, body[p]]))));
    } catch (e) {
      if (!limitErr(e, res)) next(e);
    }
  });
  r.post("/self-exclusion", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const view = await selfExclude(db, user.id, (req.body as { days?: unknown })?.days);
      console.log("[limits] %s started a break until %s", user.id, view.excludedUntil?.toISOString());
      res.json(view);
    } catch (e) {
      if (!limitErr(e, res)) next(e);
    }
  });

  /* GET /api/user/transactions — deposits and withdrawal requests, newest first */
  r.get("/transactions", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      res.setHeader("Cache-Control", "no-store");
      res.json({ transactions: await listTransactions(db, user.id) });
    } catch (e) {
      next(e);
    }
  });

  /* POST /api/user/feedback — { kind: "rating" | "idea", rating?, message?, idempotency_key } */
  r.post("/feedback", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      await saveFeedback(db, user.id, req.body ?? {});
      res.status(201).json({ status: "received" });
    } catch (e) {
      if (e instanceof FeedbackError) {
        res.status(e.status).json({ error: e.code, message: e.message });
        return;
      }
      next(e);
    }
  });

  return r;
}
