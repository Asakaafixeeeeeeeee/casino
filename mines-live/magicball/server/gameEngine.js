/* Magic Ball Live — the game engine. One table for everyone, run by the server clock.

   Rounds follow the clock: round n runs from n × ROUND_MS to (n + 1) × ROUND_MS after the epoch, so every server
   instance and every player agrees on which round is on without anyone being told. Inside a round the state is a
   pure function of the time: BETTING, then SHUFFLING, REVEALING and RESULT (see shared/gameConstants.js).

   When a round is first needed the engine draws its secret: a 32-byte seed from crypto.randomBytes; the hidden
   position is HMAC-SHA256(seed, "ball:" + roundNo) mod 3 + 1, and the shuffle's swaps come from the same seed. The
   seed's SHA-256 hash is published when the round starts and the seed itself at the reveal, so anyone can check the
   position wasn't changed after bets were placed. Nothing about a round is ever drawn with Math.random(), on a
   client, or more than once.

   The engine ticks a few times a second, notices state changes, settles every bet against the one hidden position
   at the reveal and keeps the finished rounds for the history. It emits: "round" (a new round), "state" (a state
   change, with the public round), "reveal" (the seed and position), "settled" (each player's result). */
"use strict";
const crypto = require("crypto");
const EventEmitter = require("events");
const C = require("../shared/gameConstants");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const roundNoAt = (now) => Math.floor(now / C.ROUND_MS);
const roundIdOf = (no) => "ROUND-" + no;

/** The state a round is in at `now`, from its start time alone. */
function stateAt(startTime, now) {
  const t = now - startTime;
  if (t < 0) return "WAITING";
  if (t < C.BETTING_MS) return "BETTING";
  if (t < C.BETTING_MS + C.SHUFFLE_MS) return "SHUFFLING";
  if (t < C.BETTING_MS + C.SHUFFLE_MS + C.REVEAL_MS) return "REVEALING";
  if (t < C.ROUND_MS) return "RESULT";
  return "ENDED";
}

/** The shuffle: SHUFFLE_SWAPS swaps of two of the three cups, each [a, b, ms], from the seed — identical everywhere. */
function shuffleFromSeed(seed, no) {
  const bytes = crypto.createHmac("sha256", seed).update("shuffle:" + no).digest();
  const swaps = [];
  /* about 7 s of the 9 s window: brisk in the middle, settling at the end */
  const pace = [900, 800, 700, 620, 600, 680, 800, 950];
  for (let i = 0; i < C.SHUFFLE_SWAPS; i++) {
    const a = bytes[i * 2] % 3;
    const b = (a + 1 + (bytes[i * 2 + 1] % 2)) % 3;
    swaps.push([a, b, pace[i % pace.length]]);
  }
  return swaps;
}

function createEngine(db, wallet) {
  const ev = new EventEmitter();
  const rounds = new Map();      /* roundId → round (the current one and the last few) */
  const history = [];            /* finished rounds, newest first, public form */
  let current = null;
  let timer = null;

  /** The full record of round n, drawing its secret the first time it's asked for. */
  async function ensureRound(no) {
    const id = roundIdOf(no);
    if (rounds.has(id)) return rounds.get(id);
    const seed = crypto.randomBytes(32).toString("hex");
    const hidden = (crypto.createHmac("sha256", seed).update("ball:" + no).digest()[0] % C.SPOTS) + 1;
    const r = {
      roundId: id, no,
      startTime: no * C.ROUND_MS,
      endTime: (no + 1) * C.ROUND_MS,
      bettingEnds: no * C.ROUND_MS + C.BETTING_MS,
      shuffleStart: no * C.ROUND_MS + C.BETTING_MS,
      shuffleEnd: no * C.ROUND_MS + C.BETTING_MS + C.SHUFFLE_MS,
      revealTime: no * C.ROUND_MS + C.BETTING_MS + C.SHUFFLE_MS,
      resultTime: no * C.ROUND_MS + C.BETTING_MS + C.SHUFFLE_MS + C.REVEAL_MS,
      createdAt: Date.now(),
      state: "WAITING",
      hiddenPosition: hidden,
      seed, seedHash: sha256(seed),
      shuffle: shuffleFromSeed(seed, no),
      settled: false
    };
    rounds.set(id, r);
    for (const k of [...rounds.keys()]) if (rounds.size > 5 && k !== id) rounds.delete(k);
    await db.saveRound({ round_id: id, start_time: new Date(r.startTime), end_time: new Date(r.endTime), state: "BETTING",
      hidden_position: hidden, seed, seed_hash: r.seedHash, created_at: new Date(r.createdAt) });
    return r;
  }

  /** What players may see of a round: the secret only once the cups have lifted. */
  function publicRound(r, now = Date.now()) {
    const state = stateAt(r.startTime, now);
    const revealed = state === "REVEALING" || state === "RESULT" || state === "ENDED";
    return {
      roundId: r.roundId, no: r.no, state,
      startTime: r.startTime, endTime: r.endTime, bettingEnds: r.bettingEnds,
      shuffleStart: r.shuffleStart, shuffleEnd: r.shuffleEnd, revealTime: r.revealTime, resultTime: r.resultTime,
      seedHash: r.seedHash, shuffle: r.shuffle,
      ...(revealed ? { hiddenPosition: r.hiddenPosition, seed: r.seed } : {})
    };
  }

  /** Every bet on the round, judged against its one hidden position; paid once. */
  async function settle(r) {
    if (r.settled) return;
    r.settled = true;
    const bets = await db.listBets(r.roundId);
    for (const b of bets) {
      const won = Number(b.spot) === r.hiddenPosition;
      const payout = won ? wallet.round2(Number(b.amount) * C.PAYOUT) : 0;
      await db.settleBet(b.id, won ? "WIN" : "LOSE", payout);
      if (payout > 0) await wallet.credit(b.user_id, payout);
      ev.emit("settled", { userId: b.user_id, roundId: r.roundId, spot: Number(b.spot), amount: Number(b.amount), won, payout, hiddenPosition: r.hiddenPosition, balance: await wallet.balance(b.user_id) });
    }
    await db.updateRound(r.roundId, { state: "RESULT", result_time: new Date(r.revealTime) });
    history.unshift({ roundId: r.roundId, no: r.no, hiddenPosition: r.hiddenPosition, seed: r.seed, seedHash: r.seedHash, endTime: r.endTime, bets: bets.length, wagered: bets.reduce((a, b) => a + Number(b.amount), 0) });
    history.length = Math.min(history.length, C.HISTORY);
    console.log(`[engine] ${r.roundId} revealed: spot ${r.hiddenPosition} · ${bets.length} bets`);
  }

  /** The tick: follows the clock, moves rounds along, tells everyone. */
  async function tick() {
    const now = Date.now();
    const no = roundNoAt(now);
    const r = await ensureRound(no);
    if (current !== r) {
      current = r;
      ev.emit("round", publicRound(r, now));
    }
    const state = stateAt(r.startTime, now);
    if (state !== r.state) {
      r.state = state;
      if (state === "REVEALING") {
        await settle(r);
        ev.emit("reveal", { roundId: r.roundId, hiddenPosition: r.hiddenPosition, seed: r.seed, seedHash: r.seedHash, revealTime: r.revealTime });
      }
      ev.emit("state", publicRound(r, now));
    }
  }

  async function start() {
    /* the history: what the store remembers (after a restart, or on a second instance) */
    for (const row of await db.history(C.HISTORY)) {
      history.push({ roundId: row.round_id, no: Number(row.round_id.replace("ROUND-", "")), hiddenPosition: Number(row.hidden_position), seed: row.seed, seedHash: row.seed_hash, endTime: new Date(row.end_time).getTime() });
    }
    await tick();
    timer = setInterval(() => tick().catch((e) => console.error("[engine] tick failed:", e.message)), 250);
    timer.unref();
  }
  function stop() { clearInterval(timer); }

  /** A player's bet: checked here against the server clock, never the page's. */
  async function placeBet(userId, spot, amount) {
    const now = Date.now();
    const r = current;
    if (!r) throw Object.assign(new Error("The table is opening — try again in a moment."), { code: "no_round" });
    if (stateAt(r.startTime, now) !== "BETTING") throw Object.assign(new Error("Betting is closed for this round — the next one starts soon."), { code: "betting_closed" });
    if (r.bettingEnds - now < 500) throw Object.assign(new Error("Too late — betting just closed."), { code: "betting_closed" });
    if (!Number.isInteger(spot) || spot < 1 || spot > C.SPOTS) throw Object.assign(new Error("Choose Spot 1, 2 or 3."), { code: "invalid_spot" });
    amount = wallet.round2(Number(amount));
    if (!Number.isFinite(amount) || amount < C.MIN_BET || amount > C.MAX_BET) throw Object.assign(new Error(`Bets are ${C.MIN_BET} to ${C.MAX_BET} credits.`), { code: "invalid_amount" });
    if (await db.getBet(r.roundId, userId)) throw Object.assign(new Error("You already have a bet on this round — clear it to change it."), { code: "duplicate_bet" });
    await wallet.debit(userId, amount);
    const bet = await db.saveBet({ round_id: r.roundId, user_id: userId, spot, amount });
    if (!bet) { await wallet.credit(userId, amount); throw Object.assign(new Error("You already have a bet on this round."), { code: "duplicate_bet" }); }
    return { bet: { roundId: r.roundId, spot, amount }, balance: await wallet.balance(userId) };
  }
  /** Takes a bet back (and its stake) while betting is open. */
  async function clearBet(userId) {
    const now = Date.now();
    const r = current;
    if (!r || stateAt(r.startTime, now) !== "BETTING" || r.bettingEnds - now < 500) throw Object.assign(new Error("Betting is closed — the bet stands."), { code: "betting_closed" });
    const b = await db.deleteBet(r.roundId, userId);
    if (!b) throw Object.assign(new Error("No bet to clear."), { code: "no_bet" });
    return { balance: await wallet.credit(userId, Number(b.amount)) };
  }
  async function myBet(userId) {
    if (!current) return null;
    const b = await db.getBet(current.roundId, userId);
    return b ? { roundId: current.roundId, spot: Number(b.spot), amount: Number(b.amount), result: b.result || null, payout: Number(b.payout) || 0 } : null;
  }

  return {
    events: ev, start, stop, placeBet, clearBet, myBet, publicRound, stateAt,
    current: () => current,
    history: () => history,
    stats: async () => (current ? db.stats(current.roundId) : { bets: 0, wagered: 0 })
  };
}

module.exports = { createEngine, stateAt, roundNoAt, roundIdOf, shuffleFromSeed };
