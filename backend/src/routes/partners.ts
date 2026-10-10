import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { authenticate, requireUser } from "../middleware/authenticate.js";
import {
  type Affiliate, applyPartner, attributeReferral, PartnerError, partnerActivity, partnerOf, partnerPayouts, partnerReferrals, partnerStats,
  partnerView, recordClick, requestPayout,
} from "../services/affiliates.js";

/*
 * The partner portal's API. Access:
 *   anyone           POST /click                  a visit through a partner link (counted, never trusted for money)
 *   signed in        GET /me, POST /apply         where your partner application stands; apply
 *                    POST /attribute              link a newly opened account to the partner who sent it
 *   ACTIVE partners  GET /stats, /referrals, /activity, /payouts, POST /payouts
 * An admin approves partners and pays commission from the admin dashboard (routes/admin.ts).
 */

/* clicks are public, so each address gets a modest allowance (they're counted, never paid) */
const CLICKS_PER_MINUTE = 30;
const seen = new Map<string, { count: number; resetAt: number }>();
function clickAllowed(req: Request): boolean {
  /* the client's address: Cloudflare's CF-Connecting-IP can't be forged through it; X-Forwarded-For's first entry
     can (Render appends the real address after whatever the client sent) */
  const cf = String(req.headers["cf-connecting-ip"] ?? "").trim();
  const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const ip = /^[0-9a-fA-F:.]{3,45}$/.test(cf) ? cf : hops[hops.length - 1] || req.socket.remoteAddress || "";
  const now = Date.now();
  const s = seen.get(ip);
  if (!s || now > s.resetAt) {
    if (seen.size > 10000) seen.clear();
    seen.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  return ++s.count <= CLICKS_PER_MINUTE;
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

  /* RBAC: only an approved (ACTIVE) partner gets past this */
  const partnerOnly = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const a = await partnerOf(db, requireUser(req).id);
      if (!a || a.status !== "ACTIVE") {
        res.status(403).json({ error: "not_a_partner", message: "This is for approved RendoWin partners." });
        return;
      }
      (req as Request & { partner: Affiliate }).partner = a;
      next();
    } catch (e) {
      next(e);
    }
  };
  const partner = (req: Request) => (req as Request & { partner: Affiliate }).partner;

  r.post("/click", async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (clickAllowed(req)) await recordClick(db, req.body?.code, req.body?.sub);
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  r.get("/me", authenticate, send(async (req) => {
    const a = await partnerOf(db, requireUser(req).id);
    return { partner: a ? partnerView(a) : null };
  }));
  r.post("/apply", authenticate, send(async (req) => ({ partner: await applyPartner(db, requireUser(req).id, req.body ?? {}) })));
  r.post("/attribute", authenticate, send((req) => attributeReferral(db, requireUser(req).id, req.body ?? {})));

  r.get("/stats", authenticate, partnerOnly, send((req) => partnerStats(db, partner(req))));
  r.get("/referrals", authenticate, partnerOnly, send((req) => partnerReferrals(db, partner(req))));
  r.get("/activity", authenticate, partnerOnly, send((req) => partnerActivity(db, partner(req))));
  r.get("/payouts", authenticate, partnerOnly, send((req) => partnerPayouts(db, partner(req).user_id)));
  r.post("/payouts", authenticate, partnerOnly, send((req) => requestPayout(db, partner(req), req.body ?? {})));

  return r;
}
