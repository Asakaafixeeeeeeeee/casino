/* Rendo Mines Live — a shared-board Mines game. Every connected player plays the SAME 5×5 board (6 mines) in a
   3-minute round, and NOTHING is revealed until the round ends.

   Rounds follow the clock (round n runs from n × 3 min to (n + 1) × 3 min after the epoch) and come from the WIN B casino
   balance service, which draws each round's seed, keeps it secret until 0:00 and settles real-money bets
   (backend/src/games/minesLive.ts). This server shows the board, the timer, the live bets and the history, runs the
   simulated DEMO players and the fun-credit balances, and passes real-money players' bets on with their own sign-in.
   The board is ALWAYS the balance service's round: if it can't be reached (asleep on the free plan, restarting) this
   server keeps asking until it answers, so the mines revealed here are exactly the ones the service settles by and
   the ones the admin signal shows. A round is only ever drawn here under LOCAL_ROUND_MS (testing, fun credits only).

   Round loop (runs forever):
     start → the round's number, the seed's SHA-256 hash and the end time; players get only the hash
     during the round → each player picks 1–19 tiles and places one bet; nothing is said about the tiles. A bet can be
                        cancelled until the last 10 seconds.
     every second → timer_tick to everyone
     0:00 → the seed and the mines are published to everyone; every bet is settled: all picked tiles safe → it pays
            bet × the multiplier for that many tiles; any picked tile a mine → the bet is lost. The next round starts.

   Fairness: the multiplier for k tiles is 96.5% ÷ the chance that k tiles are all safe, so every bet returns 96.5% on
   average. Because no result is shown before 0:00, players can't learn the layout from each other mid-round, and the
   hash shown at the start proves the seed (and so the mines) wasn't changed afterwards. */
"use strict";
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { TILES, MINES, MULT, minesFromSeed } = require("./maths");

const PORT = Number(process.env.PORT) || 8790;
const ROUND_MS = 180000;          /* 3 minutes, as on the balance service */
/* LOCAL_ROUND_MS (testing only): shorter rounds drawn here, fun credits only */
const LOCAL_ROUND_MS = Number(process.env.LOCAL_ROUND_MS) || 0;
const BALANCE_API = (process.env.BALANCE_API_URL || "https://asakaa-balance.onrender.com").replace(/\/$/, "");
const LIVE_API = BALANCE_API + "/api/games/volta-mines-live/live";
const BET_CUTOFF_MS = 10000;      /* no new bets in the last 10 seconds */
const MIN_BET = 0.1;
const MAX_BET = 100;
const MAX_WIN = 10000;
const START_BALANCE = 3000;       /* fun credits for a new player */
const HISTORY_ROUNDS = 30;        /* finished rounds kept for the history list */
const MY_BETS = 30;               /* each player's own past bets kept */
/* demo players: simulated bets that fill the live list. They're always marked as simulated to everyone, they bet on
   the same board and settle by the same rules at 0:00, and they never touch any real player's balance or odds. */
const DEMO_PLAYERS = process.env.DEMO_PLAYERS !== "0";
const DEMO_PER_ROUND = [10, 26];  /* how many join each round */

const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- the balance service ---------------- */
/* → { ok, status, data }; status 0 = no answer */
async function api(url, { method = "GET", token, body, timeout = 10000 } = {}) {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout)
    });
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}
const apiError = (r, fallback) => (r.data && (r.data.message || r.data.error)) || fallback;

let round = null;
let lastRound = null;
let ending = false;

/* ---------------- demo players ---------------- */
const DEMO_NAMES = ["Kofi", "Ama", "Kwame", "Esi", "Yaw", "Akua", "Kojo", "Abena", "Kwesi", "Efua", "Nana", "Adwoa", "Fiifi", "Afia",
  "Mensah", "Owusu", "Boateng", "Asante", "Darko", "Ofori", "Tetteh", "Quaye", "Nii", "Naa", "Selorm", "Edem", "Dela", "Mawuli"];
const DEMO_STAKES = [0.1, 0.1, 0.2, 0.5, 0.5, 1, 1, 1, 2, 2, 5, 5, 10, 10, 20, 50, 100];
const DEMO_TILES = [1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5, 6, 8];
const pickOf = (arr) => arr[crypto.randomInt(arr.length)];
function demoBets(start, end) {
  if (!DEMO_PLAYERS || end - start < BET_CUTOFF_MS * 2) return [];
  const n = DEMO_PER_ROUND[0] + crypto.randomInt(DEMO_PER_ROUND[1] - DEMO_PER_ROUND[0] + 1);
  const used = new Set();
  return Array.from({ length: n }, () => {
    let name;
    do name = pickOf(DEMO_NAMES) + (crypto.randomInt(3) ? String(crypto.randomInt(10, 99)) : ""); while (used.has(name));
    used.add(name);
    const k = pickOf(DEMO_TILES);
    const tiles = [];
    while (tiles.length < k) {
      const t = crypto.randomInt(TILES);
      if (!tiles.includes(t)) tiles.push(t);
    }
    return {
      pub: "demo-" + crypto.randomBytes(4).toString("hex"), name, demo: true,
      stake: pickOf(DEMO_STAKES), picks: tiles, status: "placed", win: 0,
      at: start + crypto.randomInt(Math.max(1, Math.floor((end - start - BET_CUTOFF_MS) * 0.95)))   /* when it shows up */
    };
  });
}

/* the round in play now: the balance service's (real money and fun credits), or, under LOCAL_ROUND_MS only, drawn here */
async function newRound(now) {
  if (!LOCAL_ROUND_MS) {
    /* keep asking until the service answers: a cold start can take a minute, and a round drawn here would show a
       different board from the one the service (and the admin signal) holds */
    for (let tries = 0; ; tries++) {
      const r = await api(LIVE_API + "/round", { timeout: 60000 });
      if (r.ok && r.data.ends_at - Date.now() > 1000) {
        round = {
          id: r.data.no, hash: r.data.hash, seed: null, mines: null, real: true,
          startedAt: r.data.starts_at, endsAt: r.data.ends_at, demo: []
        };
        round.demo = demoBets(Math.max(Date.now(), round.startedAt), round.endsAt);
        console.log(`round ${round.id} (balance service) · ends ${new Date(round.endsAt).toISOString()} · hash ${round.hash.slice(0, 16)}…`);
        return;
      }
      if (r.ok) {
        /* that round is about to end: wait for the next one to start, then ask again */
        await sleep(Math.max(250, r.data.ends_at - Date.now() + 250));
        continue;
      }
      if (tries % 10 === 0) console.error(`balance service unavailable (${r.status}); waiting for it before the next round`);
      await sleep(3000);
    }
  }
  const len = LOCAL_ROUND_MS;
  const id = Math.floor(now / len);
  const seed = crypto.randomBytes(32).toString("hex");
  round = {
    id, seed, hash: crypto.createHash("sha256").update(seed).digest("hex"), mines: new Set(minesFromSeed(seed, id)), real: false,
    startedAt: id * len, endsAt: (id + 1) * len, demo: []
  };
  round.demo = demoBets(now, round.endsAt);
  console.log(`round ${id} (local, fun credits only) · ends ${new Date(round.endsAt).toISOString()}`);
}

/* ---------------- players ---------------- */
/* fun-credit players are kept per browser id; real-money players per WIN B casino sign-in (so every tab is the same
   player). The browser's id and the sign-in are never shown to anyone: other players see a public id derived from
   it (a one-way hash) and a display name. */
const players = new Map();   /* key → { pub, name, real, token, balance, bet, mine:[past bets], sockets:Set, busy } */
function player(key, extra) {
  if (!players.has(key)) {
    const pub = crypto.createHash("sha256").update("pub:" + key).digest("hex").slice(0, 10);
    players.set(key, { pub, name: "Player " + pub.slice(0, 4).toUpperCase(), balance: START_BALANCE, bet: null, mine: [], sockets: new Set(), ...extra });
  }
  return players.get(key);
}
/* a display name: letters, digits, spaces and . _ - only, 2–16 characters */
function setName(p, name) {
  if (typeof name !== "string") return { error: "Names need 2–16 letters or numbers." };
  const clean = String(name || "").replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16);
  if (clean.length < 2) return { error: "Names need 2–16 letters or numbers." };
  p.name = clean;
  broadcastBets();
  return { ok: true, name: clean };
}

/* ---------------- what everyone sees: this round's bets, and the history ---------------- */
const history = [];          /* finished rounds, newest first */
/* this round's bets: who, how much, how many tiles — never which tiles. After 0:00, how each one ended. */
function liveBets(roundId) {
  const list = [];
  players.forEach((p) => {
    const b = p.bet && p.bet.roundId === roundId ? p.bet : null;
    if (b) list.push({ pub: p.pub, name: p.name, stake: b.stake, tiles: b.picks.length, mult: MULT[b.picks.length], status: b.status, win: b.win || 0, at: b.at });
  });
  const r = round && roundId === round.id ? round : lastRound && lastRound.id === roundId ? lastRound : null;
  if (r) r.demo.forEach((d) => {
    if (d.at <= Date.now() || d.status !== "placed")
      list.push({ pub: d.pub, name: d.name, demo: true, stake: d.stake, tiles: d.picks.length, mult: MULT[d.picks.length], status: d.status, win: d.win, at: d.at });
  });
  return list.sort((a, b) => b.stake - a.stake || a.at - b.at);
}
/* coalesced: a burst of bets, cancels or renames sends one list to everyone, not one per action (a single client
   renaming in a loop used to make the server send every player ~3,000 lists a second) */
let betsTimer = null;
const broadcastBets = () => {
  if (!io || !round || betsTimer) return;
  betsTimer = setTimeout(() => {
    betsTimer = null;
    if (io && round) io.emit("bets", { roundId: round.id, bets: liveBets(round.id) });
  }, 250);
};

/* each player gets a modest allowance of actions (bet, cancel, rename): RATE_MAX per RATE_WINDOW_MS */
const RATE_MAX = 12;
const RATE_WINDOW_MS = 5000;
function limited(p) {
  const now = Date.now();
  if (!p.rate || p.rate.reset < now) p.rate = { n: 0, reset: now + RATE_WINDOW_MS };
  return ++p.rate.n > RATE_MAX;
}
const betIn = (p) => (p.bet && round && p.bet.roundId === round.id ? p.bet : null);

/* what one player may see of the current round */
function view(p) {
  const b = betIn(p);
  const v = {
    round: { id: round.id, hash: round.hash, endsAt: round.endsAt, serverNow: Date.now(), mines: MINES, betCutoffMs: BET_CUTOFF_MS, real: round.real },
    real: !!p.real,
    balance: round2(p.balance),
    mult: MULT,
    bet: null,
    me: { pub: p.pub, name: p.name },
    myBets: p.mine
  };
  /* a bet: what was picked and what it would pay — never whether those tiles are safe, until the round ends */
  if (b) v.bet = { stake: b.stake, picks: b.picks, status: b.status, mult: MULT[b.picks.length], potential: payout(b) };
  return v;
}
const send = (p, ev, data) => p.sockets.forEach((s) => s.emit(ev, data));

/* ---------------- the game's actions, all checked here (and, for real money, by the balance service) ---------------- */
/* down to the cent, as the balance service pays */
const floor2 = (n) => Math.floor(n * 100 + 1e-6) / 100;
const payout = (b) => Math.min(MAX_WIN, floor2(b.stake * MULT[b.picks.length]));

function checkBet(p, stake, picks) {
  if (!(stake >= MIN_BET && stake <= MAX_BET)) return `Bets are GHS ${MIN_BET.toFixed(2)} – ${MAX_BET.toFixed(2)}.`;
  if (!Array.isArray(picks) || !picks.length) return "Choose at least one tile.";
  const set = new Set(picks);
  if (set.size !== picks.length || picks.some((t) => !Number.isInteger(t) || t < 0 || t >= TILES)) return "Those tiles don't look right.";
  if (picks.length > TILES - MINES) return `At most ${TILES - MINES} tiles.`;
  if (betIn(p)) return "You've already bet this round — wait for the next one.";
  if (ending || round.endsAt - Date.now() < BET_CUTOFF_MS) return "This round is about to end — bet in the next one.";
  if (stake > p.balance + 1e-9) return p.real ? "Not enough in your balance for that bet — deposit to keep playing." : "Not enough fun credits.";
  return null;
}

/* a bet: the stake and the tiles, locked in together. Results only come at the end of the round. */
async function placeBet(p, stake, picks) {
  stake = round2(Number(stake));
  const problem = checkBet(p, stake, picks);
  if (problem) return { error: problem };
  if (p.real) {
    if (!round.real) return { error: "Real-money bets are paused this round — try the next one." };
    const roundId = round.id;
    const key = "live:" + crypto.randomUUID();
    let r;
    for (let tries = 0; tries < 2; tries++) {
      r = await api(LIVE_API + "/bet", { method: "POST", token: p.token, body: { round_no: roundId, picks, stake, idempotency_key: key } });
      if (r.status !== 0) break;   /* only a lost connection is tried again, with the same key */
      await sleep(500);
    }
    if (!r.ok) return { error: apiError(r, "Couldn't place the bet — try again.") };
    p.balance = r.data.balance;
    p.bet = { roundId, stake, picks: picks.slice(), status: "placed", win: 0, at: Date.now(), betId: r.data.bet.bet_id };
  } else {
    p.balance = round2(p.balance - stake);
    p.bet = { roundId: round.id, stake, picks: picks.slice(), status: "placed", win: 0, at: Date.now() };
  }
  broadcastBets();
  return { ok: true };
}

/* take a bet back (and its stake) while bets are still open */
async function cancelBet(p) {
  const b = betIn(p);
  if (!b || b.status !== "placed") return { error: "No bet to cancel." };
  if (ending || round.endsAt - Date.now() < BET_CUTOFF_MS) return { error: "Too late to cancel — the round is about to end." };
  if (p.real) {
    const r = await api(LIVE_API + "/cancel", { method: "POST", token: p.token, body: { bet_id: b.betId } });
    if (!r.ok) return { error: apiError(r, "Couldn't cancel the bet — try again.") };
    p.balance = r.data.balance;
  } else {
    p.balance = round2(p.balance + b.stake);
  }
  p.bet = null;
  broadcastBets();
  return { ok: true };
}

/* the seed and mines of a finished round from the balance service (which settles its real-money bets then). The seed
   was fixed when the round started, so this keeps asking (up to about two minutes) rather than showing nothing. */
async function reveal(done) {
  const until = Date.now() + 120000;
  for (let tries = 0; ; tries++) {
    const r = await api(LIVE_API + "/round/" + done.id, { timeout: 30000 });
    if (r.ok && r.data.seed) return { seed: r.data.seed, mines: new Set(r.data.mine_tiles) };
    if (Date.now() > until || r.status === 404) return null;
    await sleep(1500);
  }
}

/* the end of a round: settle every bet, publish the seed and mines, start the next */
async function endRound(now) {
  ending = true;
  const done = round;
  if (done.real) {
    const got = await reveal(done);
    if (got) Object.assign(done, got);
  }
  if (!done.mines) {
    /* the balance service didn't answer: fun bets are handed back; real bets are settled there all the same */
    console.error(`round ${done.id}: no seed from the balance service`);
    io.emit("round_end", { roundId: done.id, unavailable: true });
    players.forEach((p) => {
      const b = p.bet && p.bet.roundId === done.id ? p.bet : null;
      if (!b || b.status !== "placed") return;
      if (!p.real) p.balance = round2(p.balance + b.stake);
      b.status = "void";
      send(p, "settled", { roundId: done.id, status: "void", picks: b.picks, stake: b.stake, balance: round2(p.balance),
        note: p.real ? "Results are delayed — your bet will be settled in your wallet shortly." : "Results weren't available — your stake is back." });
    });
    done.demo = [];
  } else {
    const mines = [...done.mines];
    io.emit("round_end", { roundId: done.id, seed: done.seed, hash: done.hash, mines });
    await Promise.all([...players.values()].map(async (p) => {
      const b = p.bet && p.bet.roundId === done.id ? p.bet : null;
      if (!b || b.status !== "placed") return;
      let hit = b.picks.filter((t) => done.mines.has(t));
      if (p.real) {
        /* the balance service's word on the bet, and the balance after it */
        const r = await api(LIVE_API + "/mine/" + done.id, { token: p.token });
        if (r.ok && r.data.bet) {
          hit = r.data.bet.hit || hit;
          b.status = r.data.bet.status === "WON" ? "won" : "lost";
          b.win = r.data.bet.win;
          p.balance = r.data.balance;
        } else {
          b.status = hit.length ? "lost" : "won";
          b.win = hit.length ? 0 : payout(b);
          /* the balance service settles the bet all the same: show its balance, not the one from before the win */
          const bal = await api(BALANCE_API + "/api/user/balances", { token: p.token });
          if (bal.ok && bal.data.primary) p.balance = Number(bal.data.primary.available) || 0;
        }
      } else {
        b.status = hit.length ? "lost" : "won";
        b.win = hit.length ? 0 : payout(b);
        p.balance = round2(p.balance + b.win);
      }
      p.mine.unshift({ roundId: done.id, picks: b.picks, stake: b.stake, mult: MULT[b.picks.length], status: b.status, win: b.win, hit, endedAt: now });
      p.mine.length = Math.min(p.mine.length, MY_BETS);
      send(p, "settled", { roundId: done.id, status: b.status, picks: b.picks, hit, mines, stake: b.stake, mult: MULT[b.picks.length], win: b.win, balance: round2(p.balance) });
    }));
    done.demo.forEach((d) => {
      if (d.at > now) return d.status = "absent";   /* it never showed up this round */
      const lost = d.picks.some((t) => done.mines.has(t));
      d.status = lost ? "lost" : "won";
      d.win = lost ? 0 : Math.min(MAX_WIN, floor2(d.stake * MULT[d.picks.length]));
    });
    done.demo = done.demo.filter((d) => d.status !== "absent");
  }
  lastRound = done;
  /* the finished round's bets, with how each ended, go to everyone; then the round joins the history */
  const bets = liveBets(done.id);
  io.emit("bets", { roundId: done.id, bets, final: true });
  if (done.mines) {
    const mines = [...done.mines];
    history.unshift({
      roundId: done.id, endedAt: now, mines, seed: done.seed, hash: done.hash,
      players: bets.length, demo: bets.filter((b) => b.demo).length, staked: round2(bets.reduce((a, b) => a + b.stake, 0)), paid: round2(bets.reduce((a, b) => a + b.win, 0)),
      winners: bets.filter((b) => b.status === "won").length, top: bets.filter((b) => b.win > 0).sort((a, b) => b.win - a.win)[0] || null
    });
    history.length = Math.min(history.length, HISTORY_ROUNDS);
    io.emit("history", history);
    console.log(`round ${done.id} ended · mines ${mines.join(",")} · seed ${done.seed.slice(0, 16)}…`);
  }
  await newRound(Date.now());
  ending = false;
  players.forEach((p) => send(p, "state", view(p)));
}

/* ---------------- server ---------------- */
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/verify/:seed/:roundId", (req, res) => {
  /* re-derive a finished round's mines from its seed — the same code the server used */
  const { seed, roundId } = req.params;
  if (!/^[0-9a-f]{64}$/.test(seed)) return res.status(400).json({ error: "bad seed" });
  res.json({ hash: crypto.createHash("sha256").update(seed).digest("hex"), mines: minesFromSeed(seed, Number(roundId)) });
});
const server = http.createServer(app);
const io = new Server(server);
/* Magic Ball Live shares this server: its page at /magicball/, its sockets in the "/magicball" namespace */
require("./magicball/server/mount").mount({ app, io, base: "/magicball" }).catch((e) => console.error("[magicball] failed to start:", e.message));
let started = null;   /* the first round, before anyone is let in */

io.on("connection", async (socket) => {
  await started;
  const auth = socket.handshake.auth || {};
  let p;
  if (auth.mode === "real") {
    /* a WIN B casino sign-in: the balance service says whose it is and what's in the wallet */
    const token = String(auth.token || "");
    const r = /^[A-Za-z0-9_-]{16,200}$/.test(token) ? await api(BALANCE_API + "/api/user/balances", { token }) : { ok: false, status: 401 };
    if (!r.ok || !r.data.primary) {
      socket.emit("fatal", r.status === 401 ? "Your WIN B casino session has ended — sign in again to play for real money."
        : "Couldn't reach your wallet — try again in a moment.");
      return socket.disconnect(true);
    }
    const key = "real:" + crypto.createHash("sha256").update(token).digest("hex").slice(0, 32);
    p = player(key, { real: true });
    p.token = token;
    p.balance = Number(r.data.primary.available) || 0;
  } else {
    const id = String(auth.playerId || "").slice(0, 64);
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      socket.emit("fatal", "Missing player id.");
      return socket.disconnect(true);
    }
    p = player(id);
  }
  p.sockets.add(socket);
  socket.emit("state", view(p));   /* a mid-round join gets the live round and the timer at once */
  socket.emit("bets", { roundId: round.id, bets: liveBets(round.id) });
  socket.emit("history", history);

  /* every action replies to its caller and refreshes all of that player's open tabs; one at a time per player */
  const handle = (fn) => async (arg, reply) => {
    let r;
    if (limited(p)) r = { error: "Slow down a little — too many actions at once." };
    else if (p.busy) r = { error: "One moment — your last action is still going through." };
    else {
      p.busy = true;
      try {
        r = await fn(arg);
      } catch (e) {
        console.error("[live] action failed:", e);
        r = { error: "Something went wrong — try again." };
      } finally {
        p.busy = false;
      }
    }
    if (typeof reply === "function") reply(r);
    if (!r.error) send(p, "state", view(p));
  };
  socket.on("bet", handle((a) => placeBet(p, a && a.stake, a && a.picks)));
  socket.on("cancel", handle(() => cancelBet(p)));
  socket.on("set_name", handle(async (a) => setName(p, a && a.name)));
  socket.on("disconnect", () => {
    p.sockets.delete(socket);
    if (!p.sockets.size) p.leftAt = Date.now();
  });
});

/* players who left are forgotten after a while (the map used to grow with every browser id ever seen): nobody
   connected, gone for PRUNE_AFTER_MS, and no bet waiting in the round in play */
const PRUNE_AFTER_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [key, p] of players) {
    const waiting = p.bet && round && p.bet.roundId === round.id && p.bet.status === "placed";
    if (!p.sockets.size && !waiting && p.leftAt && now - p.leftAt > PRUNE_AFTER_MS) players.delete(key);
  }
}, 5 * 60 * 1000).unref();

started = newRound(Date.now());
setInterval(() => {
  if (!round || ending) return;
  const now = Date.now();
  if (now >= round.endsAt) {
    endRound(now).catch((e) => {
      console.error("ending the round failed:", e);
      ending = false;
    });
    return;
  }
  if (round.demo.some((d) => d.at <= now && d.at > now - 1000)) broadcastBets();   /* demo players arriving */
  io.emit("timer_tick", { roundId: round.id, remainingMs: Math.max(0, round.endsAt - now), serverNow: now });
}, 1000);

server.listen(PORT, () => console.log(`Live Mines on http://localhost:${PORT}`));
module.exports = { minesFromSeed, MULT };
