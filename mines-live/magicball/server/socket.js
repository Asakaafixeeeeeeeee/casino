/* Magic Ball Live — Socket.IO: who's connected, what they're told, what they may ask for.

   Authentication: the handshake carries { playerId } — a random id the browser keeps, so a refresh or a second tab
   is the same player and the same demo wallet. (A real-money sign-in would go in the same place as a token and be
   checked against the accounts server; the structure is here, the demo doesn't need it.) Every event a client sends
   is validated and rate-limited here; nothing a client says about balance, time, state or result is believed.

   On connect a player gets "game:sync": the server time, the current round in its public form, their wallet, their
   bet on this round and the history — enough to draw the table exactly as everyone else sees it, mid-round.
   Then "game:countdown" every second, "game:round" / "game:state" / "game:shuffle" / "game:reveal" as the engine
   moves, and "game:result" with their own bet's outcome.

   More than one server instance: set REDIS_URL and the Socket.IO Redis adapter is attached below, so broadcasts
   reach every instance's players (install @socket.io/redis-adapter and redis). Rounds already agree across
   instances because they follow the clock. */
"use strict";
const C = require("../shared/gameConstants");

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NAME_RE = /^[\p{L}\p{N} ._-]{2,16}$/u;

/** `io` is the Socket.IO namespace the game lives in (the host's server gives it "/magicball"). */
function attach(io, { engine, wallet, db }) {
  /* --- Redis adapter, when there's more than one instance (set on the namespace's server) --- */
  if (process.env.REDIS_URL) {
    try {
      const { createAdapter } = require("@socket.io/redis-adapter");
      const { createClient } = require("redis");
      const pub = createClient({ url: process.env.REDIS_URL });
      const sub = pub.duplicate();
      Promise.all([pub.connect(), sub.connect()]).then(() => { io.server.adapter(createAdapter(pub, sub)); console.log("[socket] Redis adapter on"); });
    } catch (e) {
      console.error("[socket] REDIS_URL set but the adapter isn't installed:", e.message);
    }
  }

  /* --- authentication: a well-formed player id, nothing else --- */
  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    const playerId = String(auth.playerId || "");
    if (!ID_RE.test(playerId)) return next(new Error("missing_player_id"));
    socket.data.userId = playerId;
    socket.data.name = NAME_RE.test(String(auth.name || "")) ? String(auth.name) : "Player " + playerId.slice(0, 4).toUpperCase();
    next();
  });

  /* --- rate limit: at most N actions per player per 10 s --- */
  const hits = new Map();
  function limited(userId, max = 20) {
    const now = Date.now();
    const h = hits.get(userId) || { reset: now + 10000, n: 0 };
    if (h.reset < now) { h.reset = now + 10000; h.n = 0; }
    h.n++;
    hits.set(userId, h);
    return h.n > max;
  }
  setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, 60000).unref();

  const countdown = () => {
    const r = engine.current();
    if (!r) return { serverTime: Date.now(), state: "WAITING", remainingMs: 0 };
    const now = Date.now();
    const state = engine.stateAt(r.startTime, now);
    const until = state === "BETTING" ? r.bettingEnds : state === "SHUFFLING" ? r.shuffleEnd : state === "REVEALING" ? r.resultTime : r.endTime;
    return { roundId: r.roundId, serverTime: now, state, remainingMs: Math.max(0, until - now), nextRoundAt: r.endTime, bettingEnds: r.bettingEnds };
  };
  const players = () => io.sockets.size;

  io.on("connection", async (socket) => {
    const userId = socket.data.userId;
    socket.join("user:" + userId);
    await db.ensureUser(userId, socket.data.name);
    const sync = async () => ({
      serverTime: Date.now(),
      round: engine.current() ? engine.publicRound(engine.current()) : null,
      countdown: countdown(),
      balance: await wallet.balance(userId),
      myBet: await engine.myBet(userId),
      history: engine.history(),
      players: players(),
      me: { id: userId, name: socket.data.name },
      constants: { MIN_BET: C.MIN_BET, MAX_BET: C.MAX_BET, PAYOUT: C.PAYOUT, SPOTS: C.SPOTS, ROUND_MS: C.ROUND_MS, BETTING_MS: C.BETTING_MS, SHUFFLE_MS: C.SHUFFLE_MS }
    });
    socket.emit("game:sync", await sync());
    io.emit("players:count", players());

    const reply = (cb, v) => { if (typeof cb === "function") cb(v); };
    const fail = (cb, e) => { const err = { error: e.code || "error", message: e.message || "Something went wrong." }; socket.emit("game:error", err); reply(cb, err); };

    /* cheap but not free: a sync reads the wallet and the bet, so it has an allowance of its own */
    socket.on("game:sync", async (_a, cb) => {
      if (limited(userId + ":sync", 20)) return fail(cb, { code: "rate_limited", message: "Slow down a little." });
      reply(cb, await sync());
    });
    socket.on("time:ping", (sent, cb) => {
      if (limited(userId + ":ping", 20)) return fail(cb, { code: "rate_limited", message: "Slow down a little." });
      reply(cb, { serverTime: Date.now(), sent: Number(sent) || 0 });
    });

    socket.on("bet:place", async (a, cb) => {
      if (limited(userId)) return fail(cb, { code: "rate_limited", message: "Slow down a little." });
      try {
        const spot = Number(a && a.spot);
        const amount = Number(a && a.amount);
        const out = await engine.placeBet(userId, spot, amount);
        reply(cb, { ok: true, ...out });
        io.to("user:" + userId).emit("bet:mine", { bet: out.bet, balance: out.balance });
        const s = await engine.stats();
        io.emit("game:bets", { roundId: out.bet.roundId, bets: s.bets, wagered: s.wagered });
      } catch (e) { fail(cb, e); }
    });
    socket.on("bet:clear", async (_a, cb) => {
      if (limited(userId)) return fail(cb, { code: "rate_limited", message: "Slow down a little." });
      try {
        const out = await engine.clearBet(userId);
        reply(cb, { ok: true, ...out });
        io.to("user:" + userId).emit("bet:mine", { bet: null, balance: out.balance });
        const s = await engine.stats();
        io.emit("game:bets", { roundId: engine.current().roundId, bets: s.bets, wagered: s.wagered });
      } catch (e) { fail(cb, e); }
    });
    socket.on("wallet:topup", async (_a, cb) => {
      if (limited(userId, 5)) return fail(cb, { code: "rate_limited", message: "Slow down a little." });
      /* only for a player who has run out, and never with a bet waiting (it would wipe that bet's stake) */
      if ((await wallet.balance(userId)) >= C.MIN_BET) return fail(cb, { code: "not_empty", message: "You still have credits to play with." });
      if (await engine.myBet(userId)) return fail(cb, { code: "bet_open", message: "Wait for this round's result first." });
      const balance = await wallet.topUp(userId);
      reply(cb, { ok: true, balance });
      io.to("user:" + userId).emit("wallet", { balance });
    });
    socket.on("player:name", async (a, cb) => {
      const name = String(a && a.name || "").replace(/\s+/g, " ").trim();
      if (!NAME_RE.test(name)) return fail(cb, { code: "invalid_name", message: "Names are 2–16 letters or numbers." });
      socket.data.name = name;
      await db.renameUser(userId, name);
      reply(cb, { ok: true, name });
    });
    socket.on("disconnect", () => io.emit("players:count", players()));
  });

  /* --- the engine's word goes to everyone --- */
  engine.events.on("round", (round) => io.emit("game:round", { ...round, serverTime: Date.now() }));
  engine.events.on("state", (round) => {
    io.emit("game:state", { ...round, serverTime: Date.now() });
    if (round.state === "SHUFFLING") io.emit("game:shuffle", { roundId: round.roundId, shuffleStart: round.shuffleStart, shuffleEnd: round.shuffleEnd, swaps: round.shuffle, serverTime: Date.now() });
  });
  engine.events.on("reveal", (r) => io.emit("game:reveal", { ...r, serverTime: Date.now() }));
  engine.events.on("settled", (s) => io.to("user:" + s.userId).emit("game:result", s));
  setInterval(() => io.emit("game:countdown", countdown()), 1000).unref();

  return { io, players, countdown };
}

module.exports = { attach };
