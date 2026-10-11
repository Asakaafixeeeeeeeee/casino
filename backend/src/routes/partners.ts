import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { authenticate, requireUser } from "../middleware/authenticate.js";
import {
  type Affiliate, applyPartner, attributeReferral, checkReferral, PartnerError, partnerCommissions, partnerOf, partnerPayouts, partnerReferrals,
  partnerSettings, partnerStatistics, partnerSummary, partnerView, partnerWallet, recordClick, requestPayout, savePayoutDetails,
  setOwnPromo,
} from "../services/affiliates.js";
import {
  assetFile, deleteFlyer, gameTools, PERMISSIONS, type Permission, partnerFlyers, permissionsOf, requirePermission, saveFlyer, toolsList,
} from "../services/partnerPlatform.js";
import { acceptInvite, inviteInfo, registerWithInvite } from "../services/partnerInvites.js";

/*
 * The partner portal's API. Access:
 *   anyone           POST /click                  a visit through a partner link (counted, never trusted for money)
 *                    GET  /check                  is this link code / promo code valid (and the same partner)? before sign-up
 *   setup link       POST /invite/info, /invite/register   a partner opens their secret setup link and registers
 *                    POST /invite/accept (signed in)     ...or accepts it with the account that already has that number
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
  /* a feature the admin switched off is refused here, whatever the page shows */
  const feature = (key: Permission) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await requirePermission(db, partner(req), key);
      next();
    } catch (e) {
      if (e instanceof PartnerError) { res.status(e.status).json({ error: e.code, message: e.message }); return; }
      next(e);
    }
  };
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

  /* partner setup links: the secret is sent in the body (never in a URL the server logs) */
  const invite = (fn: (req: Request) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    if (!allowed(req, "invite")) {
      res.status(429).json({ error: "too_many", message: "Too many tries — wait a minute." });
      return;
    }
    send(fn)(req, res, next);
  };
  r.post("/invite/info", invite((req) => inviteInfo(db, req.body?.token)));
  r.post("/invite/register", invite((req) => registerWithInvite(db, req.body?.token, req.body ?? {})));
  r.post("/invite/accept", authenticate, invite((req) => acceptInvite(db, req.body?.token, requireUser(req).id, req.body ?? {})));

  r.get("/me", authenticate, send(async (req) => {
    const a = await partnerOf(db, requireUser(req).id);
    if (!a) return { partner: null };
    const perms = await permissionsOf(db, a);
    return { partner: partnerView(a, perms.global), permissions: perms.effective, features: PERMISSIONS.map(([key, label]) => ({ key, label })) };
  }));
  /* an uploaded promotional image (public: flyers draw it into a canvas on the partner's page) */
  r.get("/assets/:id", async (req, res, next) => {
    try {
      const f = await assetFile(db, req.params.id);
      if (!f) { res.status(404).end(); return; }
      res.setHeader("Content-Type", f.mime);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.end(f.data);
    } catch (e) {
      next(e);
    }
  });
  r.post("/apply", authenticate, send(async (req) => ({ partner: await applyPartner(db, requireUser(req).id, req.body ?? {}) })));
  r.post("/attribute", authenticate, send((req) => attributeReferral(db, requireUser(req).id, req.body ?? {})));

  const board = feature("dashboard");
  r.get("/summary", ...look, board, send((req) => partnerSummary(db, partner(req))));
  r.get("/stats", ...look, board, send((req) => partnerSummary(db, partner(req))));
  r.get("/referrals", ...look, board, feature("referral_stats"), send((req) => partnerReferrals(db, partner(req), q(req))));
  r.get("/statistics", ...look, board, feature("referral_stats"), send((req) => partnerStatistics(db, partner(req), q(req))));
  r.get("/wallet", ...look, board, send((req) => partnerWallet(db, partner(req))));
  r.get("/settings", ...look, send((req) => partnerSettings(db, partner(req))));
  r.get("/commissions", ...look, board, send((req) => partnerCommissions(db, partner(req), q(req))));
  r.get("/payouts", ...look, send((req) => partnerPayouts(db, partner(req).user_id)));

  r.post("/payouts", ...act, feature("commission_withdrawals"), send((req) => requestPayout(db, partner(req), req.body ?? {})));
  r.post("/settings/promo", ...act, feature("promo_codes"), send((req) => setOwnPromo(db, partner(req), req.body ?? {})));
  r.post("/settings/payout-details", ...act, send((req) => savePayoutDetails(db, partner(req), req.body ?? {})));

  /* the flyer generator: templates, live campaigns, the partner's codes; flyers they saved */
  /* flyers and game tools are for ACTIVE partners only (a suspended partner keeps read access to their figures) */
  r.get("/flyers", ...act, send((req) => partnerFlyers(db, partner(req))));
  r.post("/flyers/saved", ...act, send((req) => saveFlyer(db, partner(req), req.body ?? {})));
  r.post("/flyers/saved/:id/delete", ...act, send((req) => deleteFlyer(db, partner(req), req.params.id)));

  /* game tools: the real odds and finished rounds only, for the games the admin switched on */
  r.get("/tools", ...act, send((req) => toolsList(db, partner(req))));
  r.get("/tools/:game", ...act, send((req) => gameTools(db, partner(req), String(req.params.game))));

  return r;
}
