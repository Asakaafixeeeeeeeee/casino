import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { authenticate, requireUser } from "../middleware/authenticate.js";
import { GAMES, GameError } from "../games/catalog.js";
import { bigWins, publicCatalog } from "../games/showcase.js";
import { playRound } from "../games/rounds.js";
import { SESSION_GAMES } from "../games/sessionCatalog.js";
import { cashOutSession, openSession, startSession, stepSession } from "../games/sessions.js";
import { cancelFlightBet, cashOutFlightBet, FLIGHT_GAMES, nextFlight, placeFlightBet, waitFlight } from "../games/flights.js";
import {
  cancelLiveBet, currentLiveRound, LIVE_MAX_BET, LIVE_MIN_BET, liveRound, myLiveBet, placeLiveBet,
} from "../games/minesLive.js";
import { cancelSkyBet, cashOutSkyBet, createSkyLive, placeSkyBet, SKY, SKY_ID } from "../games/skyRush.js";

/** Real-money play: the server draws every outcome and settles it in the ledger. */
export function gamesRouter(db: Pool): Router {
  const r = Router();

  /* which games can be played for real money, with their bet limits */
  r.get("/", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      games: [
        ...Object.values(GAMES).map((g) => ({ id: g.id, name: g.name, type: "round", minBet: g.minBet, maxBet: g.maxBet })),
        ...Object.values(SESSION_GAMES).map((g) => ({ id: g.id, name: g.name, type: "steps", minBet: g.minBet, maxBet: g.maxBet })),
        ...Object.values(FLIGHT_GAMES).map((g) => ({ id: g.id, name: g.name, type: "flight", minBet: g.minBet, maxBet: g.maxBet })),
        { id: "volta-mines-live", name: "Live Mines", type: "live", minBet: LIVE_MIN_BET, maxBet: LIVE_MAX_BET },
        { id: SKY_ID, name: SKY.name, type: "live-crash", minBet: SKY.minBet, maxBet: SKY.maxBet },
      ],
    });
  });

  /* games and studios an admin has switched off, so the lobby can leave them out, and each game's free play and
     big-wins switches (public) */
  r.get("/visibility", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await publicCatalog(db));
    } catch (e) {
      next(e);
    }
  });

  /* a game's real big wins of the last 7 days, when its showcase is on (public; players' numbers are masked) */
  r.get("/big-wins/:game", async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await bigWins(db, req.params.game));
    } catch (e) {
      next(e);
    }
  });

  /* wraps a handler: GameErrors become their status and message */
  const handle = (fn: (req: Request, userId: string, game: string) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const user = requireUser(req);
        res.setHeader("Cache-Control", "no-store");
        res.json(await fn(req, user.id, String(req.params.game)));
      } catch (e) {
        if (e instanceof GameError) {
          res.status(e.status).json({ error: e.code, message: e.message });
          return;
        }
        next(e);
      }
    };

  /* one-draw games */
  r.post("/:game/play", authenticate, handle((req, userId, game) => playRound(db, userId, game, req.body ?? {})));

  /* step-by-step games: start → step … → cash out (or bust); open = the round in progress, if any */
  r.get("/:game/open", authenticate, handle(async (_req, userId, game) => ({ session: await openSession(db, userId, game) })));
  r.post("/:game/start", authenticate, handle((req, userId, game) => startSession(db, userId, game, req.body ?? {})));
  r.post("/:game/step", authenticate, handle((req, userId, game) => stepSession(db, userId, game, req.body ?? {})));
  r.post("/:game/cashout", authenticate, handle((req, userId, game) => cashOutSession(db, userId, game, req.body ?? {})));

  /* crash-style games: next round → bet / cancel before take-off → cash out; wait = held until the round ends.
     Bets and cash-outs are timed from when the request arrives, before the sign-in check. */
  const arrived = (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { arrivedAt?: number }).arrivedAt = Date.now();
    next();
  };
  const at = (req: Request) => ({ now: (req as Request & { arrivedAt?: number }).arrivedAt ?? Date.now() });
  r.post("/:game/flight/next", arrived, authenticate, handle((req, userId, game) => nextFlight(db, userId, game, at(req))));
  r.post("/:game/flight/bet", arrived, authenticate, handle((req, userId, game) => placeFlightBet(db, userId, game, req.body ?? {}, at(req))));
  r.post("/:game/flight/cancel", arrived, authenticate, handle((req, userId, game) => cancelFlightBet(db, userId, game, req.body ?? {}, at(req))));
  r.post("/:game/flight/cashout", arrived, authenticate, handle((req, userId, game) => cashOutFlightBet(db, userId, game, req.body ?? {}, at(req))));
  r.get("/:game/flight/:id/wait", authenticate, handle((req, userId, game) => waitFlight(db, userId, game, req.params.id)));

  /* Mines Live: one shared board every 3 minutes. A round's hash, and once it's over its seed and mines, are public;
     bets need the player's sign-in. */
  const open = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await fn(req));
    } catch (e) {
      if (e instanceof GameError) {
        res.status(e.status).json({ error: e.code, message: e.message });
        return;
      }
      next(e);
    }
  };
  r.get("/volta-mines-live/live/round", open(() => currentLiveRound(db)));
  r.get("/volta-mines-live/live/round/:no", open((req) => liveRound(db, req.params.no)));
  r.post("/volta-mines-live/live/bet", arrived, authenticate, handle((req, userId) => placeLiveBet(db, userId, req.body ?? {}, at(req))));
  r.post("/volta-mines-live/live/cancel", arrived, authenticate, handle((req, userId) => cancelLiveBet(db, userId, req.body ?? {}, at(req))));
  r.get("/volta-mines-live/live/mine/:no", authenticate, handle((req, userId) => myLiveBet(db, userId, req.params.no)));

  /* Sky Rush: one crash round for everybody. The round (its hash, take-off time and, once it's over, the crash and the
     seed), the bets list and the leaderboards are public; betting needs the player's sign-in. */
  const sky = createSkyLive(db);
  r.get(`/${SKY_ID}/live/state`, open(() => sky.state()));
  r.get(`/${SKY_ID}/live/round/:no/wait`, open((req) => sky.wait(req.params.no)));
  r.get(`/${SKY_ID}/live/round/:no`, open((req) => sky.roundInfo(req.params.no)));
  r.get(`/${SKY_ID}/live/bets/:no`, open((req) => sky.bets(req.params.no)));
  r.get(`/${SKY_ID}/live/top`, open((req) => sky.top(String(req.query.by ?? "wins"), String(req.query.period ?? "day"))));
  r.get(`/${SKY_ID}/live/mine/:no`, authenticate, handle((req, userId) => sky.mine(userId, req.params.no)));
  r.post(`/${SKY_ID}/live/bet`, arrived, authenticate, handle((req, userId) => placeSkyBet(db, userId, req.body ?? {}, at(req))));
  r.post(`/${SKY_ID}/live/cancel`, arrived, authenticate, handle((req, userId) => cancelSkyBet(db, userId, req.body ?? {}, at(req))));
  r.post(`/${SKY_ID}/live/cashout`, arrived, authenticate, handle((req, userId) => cashOutSkyBet(db, userId, req.body ?? {}, at(req))));

  return r;
}
