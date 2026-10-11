import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { authenticate, requireUser } from "../middleware/authenticate.js";
import {
  type Affiliate, applyPartner, attributeReferral, checkReferral, PartnerError, partnerCommissions, partnerOf, partnerPayouts, partnerReferrals,
  partnerSettings, partnerStatistics, partnerSummary, partnerView, partnerWallet, recordClick, requestPayout, savePayoutDetails,
  setOwnPromo,
} from "../services/affiliates.js";

/*
 * The partner portal's API. Access:
 *   anyone           POST /click                  a visit through a partner link (counted, never trusted for money)
 *                    GET  /check                  is this link code / promo code valid (and the same partner)? before sign-up
 *   signed in        GET /me, POST /apply         where your partner application stands; apply
 *                    POST /attribute              link a newly opened account to the partner who sent it (link or promo code)
 *   partners         GET /summary, /referrals, /statistics, /wallet, /settings, /commissions, /payouts   (ACTIVE or SUSPENDED: read only)
 *   ACTIVE partners  POST /payouts, /settings/promo, /settings/payout-details
 * Each partner only ever sees their own data. An admin runs the programme from the admin dashboard (routes/admin.ts).
 */

/* clicks and code checks are public, so each address gets a modest allowance */
const PER_MINUTE = 30;
const seen = new Map<string, { count: number; resetAt: number }>();
function allowed(req: Request, bucket: string): boolean {
  /* the client's address: Cloudflare's CF-Connecting-IP can't be forged through it; X-Forwarded-For's first entry
     can (Render appends the real address after whatever the client sent) */
  const cf = String(req.headers["cf-connecting-ip"] ?? "").trim();
  const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const ip = bucket + ":" + (/^[0-9a-fA-F:.]{3,45}$/.test(cf) ? cf : hops[hops.length - 1] || req.socket.remoteAddress || "");
  const now = Date.now();
  const s = seen.get(ip);
  if (!s || now > s.resetAt) {
    if (seen.size > 10000) seen.clear();
    seen.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  return ++s.count <= PER_MINUTE;
}

export function partnersRouter(db: Pool): Router {
  const r = Router();

  const send = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await fn(req));
    } catch (e) {
      if (e instanceof PartnerError) {
        res.status(e.status).json({ error: e.code, message: e.message });
        return;
      }
      next(e);
    }
  };

  /* RBAC: an approved partner's own account only. Suspended partners may still look; only ACTIVE ones may act. */
  const partnerOnly = (mayAct: boolean) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const a = await partnerOf(db, requireUser(req).id);
      const ok = a && (a.status === "ACTIVE" || (!mayAct && a.status === "SUSPENDED"));
      if (!ok) {
        res.status(403).json({
          error: a?.status === "SUSPENDED" ? "partner_suspended" : "not_a_partner",
          message: a?.status === "SUSPENDED" ? "Your partner account is suspended. Contact support." : "This is for approved partners.",
        });
        return;
      }
      (req as Request & { partner: Affiliate }).partner = a!;
      next();
    } catch (e) {
      next(e);
    }
  };
  const look = [authenticate, partnerOnly(false)];
  const act = [authenticate, partnerOnly(true)];
  const partner = (req: Request) => (req as Request & { partner: Affiliate }).partner;
  const q = (req: Request) => req.query as Record<string, unknown>;

  r.post("/click", async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (allowed(req, "click")) await recordClick(db, req.body?.code, req.body?.sub);
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });
  r.get("/check", (req, res, next) => {
    if (!allowed(req, "check")) {
      res.status(429).json({ error: "too_many", message: "Too many checks — wait a minute." });
      return;
    }
    send(() => checkReferral(db, { code: req.query.code, promo: req.query.promo }))(req, res, next);
  });

  r.get("/me", authenticate, send(async (req) => {
    const a = await partnerOf(db, requireUser(req).id);
    return { partner: a ? partnerView(a) : null };
  }));
  r.post("/apply", authenticate, send(async (req) => ({ partner: await applyPartner(db, requireUser(req).id, req.body ?? {}) })));
  r.post("/attribute", authenticate, send((req) => attributeReferral(db, requireUser(req).id, req.body ?? {})));

  r.get("/summary", ...look, send((req) => partnerSummary(db, partner(req))));
  r.get("/stats", ...look, send((req) => partnerSummary(db, partner(req))));
  r.get("/referrals", ...look, send((req) => partnerReferrals(db, partner(req), q(req))));
  r.get("/statistics", ...look, send((req) => partnerStatistics(db, partner(req), q(req))));
  r.get("/wallet", ...look, send((req) => partnerWallet(db, partner(req))));
  r.get("/settings", ...look, send((req) => partnerSettings(db, partner(req))));
  r.get("/commissions", ...look, send((req) => partnerCommissions(db, partner(req), q(req))));
  r.get("/payouts", ...look, send((req) => partnerPayouts(db, partner(req).user_id)));

  r.post("/payouts", ...act, send((req) => requestPayout(db, partner(req), req.body ?? {})));
  r.post("/settings/promo", ...act, send((req) => setOwnPromo(db, partner(req), req.body ?? {})));
  r.post("/settings/payout-details", ...act, send((req) => savePayoutDetails(db, partner(req), req.body ?? {})));

  return r;
}
