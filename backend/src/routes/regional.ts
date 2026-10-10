import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import {
  loginRegional, logoutRegional, REGIONS, regionalFromToken, RegionalError, regionalSummary, regionalTransactions,
  type RegionalSession,
} from "../services/regional.js";

/*
 * The regional admin's API (/api/regional). Signing in takes a username and a 6-digit PIN and returns a token of its
 * own: it is not a player's or a full admin's sign-in, the accounts server doesn't know it, so it opens nothing outside
 * these routes. Every data route below runs behind `signedIn` and is answered for the signed-in admin's region only —
 * the region comes from their account, never from the request.
 */

/* per network address: at most 10 sign-in attempts in 10 minutes (on top of the account's own lock after wrong PINs) */
const WINDOW_MS = 10 * 60_000;
const PER_WINDOW = 10;
const attempts = new Map<string, { n: number; resetAt: number }>();

/** The caller's address: Cloudflare's header when it's there, else the hop the platform's proxy added last. */
export function clientIp(req: Request): string {
  const cf = String(req.headers["cf-connecting-ip"] ?? "").trim();
  if (/^[0-9a-fA-F:.]{3,45}$/.test(cf)) return cf;
  const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - 1] || req.socket.remoteAddress || "";
}

export function allowLoginAttempt(ip: string, now = Date.now()): boolean {
  const a = attempts.get(ip);
  if (!a || now > a.resetAt) {
    if (attempts.size > 10_000) attempts.clear();
    attempts.set(ip, { n: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  a.n++;
  return a.n <= PER_WINDOW;
}

const tokenOf = (req: Request) => /^Bearer\s+([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
const sessionOf = (req: Request) => (req as Request & { regional: RegionalSession }).regional;

export function regionalRouter(db: Pool): Router {
  const r = Router();

  const send = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await fn(req));
    } catch (e) {
      if (e instanceof RegionalError) {
        res.status(e.status).json({ error: e.code, message: e.message });
        return;
      }
      next(e);
    }
  };

  /* only a current regional sign-in gets past here; a player's or full admin's token is unknown to it */
  const signedIn = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const s = await regionalFromToken(db, tokenOf(req));
      if (!s) {
        res.setHeader("Cache-Control", "no-store");
        res.status(401).json({ error: "unauthenticated", message: "Please sign in again." });
        return;
      }
      (req as Request & { regional: RegionalSession }).regional = s;
      next();
    } catch (e) {
      next(e);
    }
  };

  r.post("/login", (req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req);
    if (!allowLoginAttempt(ip)) {
      res.status(429).json({ error: "too_many_attempts", message: "Too many sign-in attempts from here. Wait 10 minutes and try again." });
      return;
    }
    return send((rq) => loginRegional(db, rq.body ?? {}, { ip }))(req, res, next);
  });
  r.post("/logout", signedIn, send((req) => logoutRegional(db, tokenOf(req))));
  r.get("/me", signedIn, send(async (req) => {
    const s = sessionOf(req);
    return { admin: { username: s.username, name: s.name, region: s.region, region_name: REGIONS[s.region]?.name ?? s.region } };
  }));
  r.get("/summary", signedIn, send((req) => regionalSummary(db, sessionOf(req).region)));
  r.get("/transactions", signedIn, send((req) => regionalTransactions(db, sessionOf(req).region, {
    status: req.query.status, kind: req.query.kind, before: req.query.before,
  })));

  return r;
}
