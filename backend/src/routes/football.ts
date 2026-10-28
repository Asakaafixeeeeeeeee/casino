import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { customFootballTeamLogo, footballPage } from "../services/football.js";

export function footballRouter(db: Pool): Router {
  const router = Router();
  router.get("/teams/:id/logo", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const logo = await customFootballTeamLogo(db, String(req.params.id));
      if (!logo) { res.status(404).end(); return; }
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.type(logo.contentType).send(logo.bytes);
    } catch (error) {
      next(error);
    }
  });
  router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await footballPage(db));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
