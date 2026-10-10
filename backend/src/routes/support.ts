import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { authenticate, requireUser } from "../middleware/authenticate.js";
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
  r.post("/messages", send((req) => playerSend(db, requireUser(req).id, req.body ?? {})));
  r.get("/unread", send((req) => playerUnread(db, requireUser(req).id)));
  return r;
}
