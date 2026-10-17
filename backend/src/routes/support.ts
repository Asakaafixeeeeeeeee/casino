import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { authenticate, requireUser } from "../middleware/authenticate.js";
import { aiSweep } from "../services/supportAi.js";
import { pushPublicKey, removePushSubscription, savePushSubscription } from "../services/push.js";
import { playerSend, playerThread, playerUnread, SupportError } from "../services/support.js";

/** A signed-in player's side of the live support chat (the team answers from /api/admin/support). */
export function supportRouter(db: Pool): Router {
  const r = Router();
  r.use(authenticate);
  const send = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await fn(req));
    } catch (e) {
      if (e instanceof SupportError) {
        res.status(e.status).json({ error: e.code, message: e.message });
        return;
      }
      next(e);
    }
  };
  r.get("/thread", send((req) => playerThread(db, requireUser(req).id, req.query as Record<string, unknown>)));
  r.post("/messages", send(async (req) => {
    const out = await playerSend(db, requireUser(req).id, req.body ?? {});
    /* the assistant answers a moment later, off the request; the sweep catches it if this process restarts */
    if (process.env.SUPPORT_AI !== "off") setTimeout(() => { void aiSweep(db, 1000).catch(() => undefined); }, 1500).unref();
    return out;
  }));
  r.get("/push-key", send(async () => ({ key: pushPublicKey() })));
  r.post("/push-subscribe", send(async (req) => {
    const ok = await savePushSubscription(db, requireUser(req).id, req.body ?? {});
    return { ok };
  }));
  r.post("/push-unsubscribe", send(async (req) => {
    await removePushSubscription(db, requireUser(req).id, String(req.body?.endpoint ?? ""));
    return { ok: true };
  }));
  r.get("/unread", send((req) => playerUnread(db, requireUser(req).id)));
  return r;
}
