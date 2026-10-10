/* Magic Ball Live — mounted into an existing Express app and Socket.IO server under a base path (the Live Mines
   service hosts it at /magicball), or stood up on its own by server.js. The game is identical either way: one
   engine on the server clock, sockets in the "/magicball" namespace, the page and its files under the base path. */
"use strict";
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const C = require("../shared/gameConstants");
const database = require("./database");
const { createWallet } = require("./wallet");
const { createEngine } = require("./gameEngine");
const socket = require("./socket");

async function mount({ app, io, base = "" }) {
  const DEV = process.env.DEV_INDICATOR === "1";
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
  const db = await database.open();
  const wallet = createWallet(db);
  const engine = createEngine(db, wallet);
  const r = express.Router();
  r.use(express.json({ limit: "10kb" }));
  r.use(express.static(path.join(__dirname, "..", "client"), { etag: false, cacheControl: false, setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));
  r.use("/shared", express.static(path.join(__dirname, "..", "shared")));
  r.get("/health", (_req, res) => res.json({ ok: true, db: db.kind, round: engine.current() && engine.current().roundId }));
  r.get("/api/config", (_req, res) => res.json({ dev: DEV, minBet: C.MIN_BET, maxBet: C.MAX_BET, payout: C.PAYOUT }));
  const admin = (req, res, next) => {
    if (!ADMIN_TOKEN) return res.status(404).json({ error: "admin_disabled", message: "Set ADMIN_TOKEN to enable the dashboard." });
    /* compared in constant time (as fixed-length hashes), so the token can't be guessed a character at a time */
    const given = crypto.createHash("sha256").update(String(req.headers["x-admin-token"] || req.query.token || "")).digest();
    const want = crypto.createHash("sha256").update(ADMIN_TOKEN).digest();
    if (!crypto.timingSafeEqual(given, want)) return res.status(401).json({ error: "unauthorized" });
    next();
  };
  const live = socket.attach(io.of("/magicball"), { engine, wallet, db });
  r.get("/api/admin", admin, async (_req, res) => {
    const cur = engine.current();
    const now = Date.now();
    const pub = cur ? engine.publicRound(cur, now) : null;
    res.json({ serverTime: now, round: pub && { ...pub, hiddenPosition: pub.hiddenPosition ?? null }, countdown: live.countdown(), players: live.players(), stats: await engine.stats(), history: engine.history(), db: db.kind });
  });
  app.use(base || "/", r);
  await engine.start();
  console.log(`Magic Ball Live mounted at ${base || "/"} (${db.kind}${DEV ? ", dev indicator on" : ""})`);
  return { engine, wallet, db };
}

module.exports = { mount };
