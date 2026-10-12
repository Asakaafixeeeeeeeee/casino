/* Rendo Knockout — a boxing crash game: place up to two bets, the multiplier climbs while two boxers trade punches,
   cash out before the knockout. Forked from Rendo Crash's engine (crash.js); the same mock "server" state machine:
     WAITING (5s to bet) → IN_FLIGHT (the fight: multiplier climbs to the knockout point) → CRASHED (2s hold) → …
   Two ways to bet on each panel:
     Classic — cash out any time before the knockout (P(fight lasts to m) = RTP ÷ m).
     ColorGo — call the colour of the round: Blue (KO below 2x), Purple (2x–9.99x) or Red (10x or more). Each pays
       RTP ÷ its chance, rounded down, so it returns at most the RTP too.
   With free credits the rounds run in the browser. With real money the server runs the player's rounds (backend
   games/flights.ts): it draws the knockout point, takes the bets, judges every cash-out on its own clock and pays it,
   and the page learns where a round ended only once it's over. The other players in the list are simulated. The
   fight is drawn by knockout-art.js. */
(function () {
  "use strict";
  const games = window.VB.allGames || window.VB.games;
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);

  let WAIT_MS = 5000;   // betting window before each round
  const HOLD_MS = 2000;   // "FLEW AWAY!" pause after a crash
  const GROWTH = 0.12;    // multiplier = e^(GROWTH × seconds): 2x after ~5.8s, 10x after ~19s, 100x after ~38s
  const CRUISE_S = 8;     // seconds the plane takes to climb to its cruising spot
  let MAX_CRASH = 10000;
  let MIN_BET = 0.1;
  let MAX_BET = 1000;
  const FUN_CREDITS = 3000;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const params = new URLSearchParams(location.search);
  const game = games.find((g) => g.id === "knockout");
  U.recent.add(game.id);
  $("cgRtp").textContent = game.rtp + "%";
  $("cgRulesRtp").textContent = game.rtp + "%";

  const round2 = (n) => Math.round(n * 100) / 100;
  const money = (n) => n.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const count = (n) => n.toLocaleString("en-GH");
  const xText = (x) => x.toFixed(2) + "x";
  const xClass = (x) => (x < 2 ? "x-blue" : x < 10 ? "x-purple" : "x-pink");

  /* ColorGo: the three colours a round can end in, and what each pays (RTP ÷ chance, rounded down to the cent).
     P(KO ≥ m) = RTP ÷ m, so P(blue) = 1 − RTP/2, P(purple) = RTP/2 − RTP/10, P(red) = RTP/10. */
  const RTP = game.rtp / 100;
  const COLORS = {
    blue: { name: "Blue", range: "below 2x", p: 1 - RTP / 2, test: (x) => x < 2 },
    purple: { name: "Purple", range: "2x – 9.99x", p: RTP / 2 - RTP / 10, test: (x) => x >= 2 && x < 10 },
    red: { name: "Red", range: "10x or more", p: RTP / 10, test: (x) => x >= 10 }
  };
  Object.values(COLORS).forEach((c) => (c.pay = Math.floor((100 * RTP) / c.p + 1e-9) / 100));
  const colorOf = (x) => (x < 2 ? "blue" : x < 10 ? "purple" : "red");
  let betMode = "classic";   /* the mode bar under the ring: new bets are Classic or ColorGo */
  $("koPays").textContent = Object.values(COLORS).map((c) => c.name + " " + c.pay.toFixed(2) + "x").join(" · ");
  const pill = (x, extra) => '<span class="cg-pill ' + xClass(x) + (extra || "") + '">' + xText(x) + "</span>";
  const announce = (msg) => ($("cgLive").textContent = msg);

  /* ---------------- maths ---------------- */
  /* P(crash ≥ m) = RTP ÷ m, so every cash-out strategy returns the title's RTP on average.
     The house edge is the (100 − RTP)% of draws that fall below 1 and are clamped to an instant 1.00x crash. */
  function crashPoint() {
    const rtp = game.rtp / 100;
    return Math.min(MAX_CRASH, Math.max(1, Math.floor((100 * rtp) / (1 - Math.random())) / 100));
  }
  const multiplierAt = (ms) => Math.floor(Math.exp((GROWTH * ms) / 1000) * 100) / 100;
  const flightMs = (x) => (Math.log(x) / GROWTH) * 1000;

  /* ---------------- balance: free credits, or real money run by the server ---------------- */
  const signedIn = !!U.session.get();
  let mode = signedIn && params.get("mode") === "real" ? "real" : "fun";
  /* the admin's per-game switches: free play can be off (Credits goes away), and real big wins can show */
  U.freePlay.enforce("volta-knockout", { mode, canReal: signedIn });
  U.showcase.mount("volta-knockout");
  const real = () => mode === "real";
  document.querySelectorAll('[data-mode="real"]').forEach((b) => (b.hidden = !signedIn));
  if (!signedIn) {
    const modes = document.querySelector(".cg-modes");
    const label = modes && modes.previousElementSibling;
    if (modes) modes.style.display = "none";
    if (label && label.classList.contains("cg-menu-label")) label.style.display = "none";
  }
  let fun = FUN_CREDITS;
  const balance = () => (mode === "real" ? U.wallet.balance() : fun);

  /* free credits only: real money moves on the server, and its answers carry the new balance */
  function move(delta) {
    fun = round2(fun + delta);
    paintBalance();
  }
  function setRealBalance(b) {
    if (typeof b === "number") U.wallet.setBalance(b);
    paintBalance();
  }

  function paintBalance() {
    $("cgBalance").textContent = money(balance());
    $("cgFun").textContent = mode === "fun" ? "Credits" : "Wallet";
    $("cgFun").classList.toggle("is-fun", mode === "fun");
    $("cgTopUp").hidden = mode !== "fun";
    document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  }

  /* ---------------- simulated players ---------------- */
  const LETTERS = "abcdefghijklmnoprstuvwyz";
  const fakeName = () => LETTERS[Math.floor(Math.random() * LETTERS.length)] + "***" + Math.floor(Math.random() * 10);
  const randomHue = () => Math.floor(Math.random() * 360);
  const STAKES = [1, 1, 2, 2, 3, 5, 5, 5, 10, 10, 10, 15, 20, 20, 25, 50, 50, 100, 100, 200, 500];

  function botStake() {
    const s = STAKES[Math.floor(Math.random() * STAKES.length)];
    /* a quarter of players type an amount instead of tapping a preset */
    return Math.random() < 0.25 ? Math.max(1, round2(s * (0.5 + Math.random()))) : s;
  }
  /* cash-out targets: ~30% leave by 1.3x, ~60% by 2x, ~90% by 6x, and a few ride it far */
  const botTarget = () => Math.min(1000, Math.max(1.01, round2(Math.pow(1 - Math.random(), -0.75))));

  let roundNo = 0;
  function newRound() {
    const total = 2500 + Math.floor(Math.random() * 5500);
    const bots = [];
    for (let i = 0; i < total; i++) bots.push({ stake: botStake(), target: botTarget(), x: 0, win: 0 });
    /* 30 random players get a name and a row in the list (biggest stakes first) — a sample looks like a
       real crowd, where the top 30 stakes of thousands would all be near-identical big bets */
    const picked = new Set();
    while (picked.size < 30) picked.add(Math.floor(Math.random() * total));
    const shown = Array.from(picked, (i) => bots[i]).sort((a, b) => b.stake - a.stake);
    shown.forEach((b) => {
      b.name = fakeName();
      b.hue = randomHue();
      if (Math.random() < 0.2) {
        b.color = ["blue", "blue", "purple", "purple", "red"][Math.floor(Math.random() * 5)];
        b.target = Infinity;   /* a colour bet doesn't cash out; it's settled at the knockout */
      }
    });
    return {
      no: ++roundNo,
      crash: real() ? Infinity : crashPoint(),   /* real money: unknown until the server says the round is over */
      flightId: null,
      total,
      shown,
      queue: bots.sort((a, b) => a.target - b.target), /* cash-out order */
      next: 0,
      cashed: 0,
      win: 0,
      mine: [] /* this player's bets */
    };
  }

  /* biggest wins of the session, for the Top tab */
  const top = [];
  function recordTop(b) {
    if (top.length >= 20 && b.win <= top[top.length - 1].win) return;
    if (!b.name) {
      b.name = fakeName();
      b.hue = randomHue();
    }
    top.push(b);
    top.sort((a, c) => c.win - a.win);
    top.length = Math.min(top.length, 20);
    if (listTab === "stats") listDirty = true;
  }

  /* ---------------- round state machine ---------------- */
  /* status: idle → pending (bet on the coming round) or queued (bet made mid-round, for the next one)
     → active (in flight) → idle again once cashed out or lost */
  const panels = [0, 1].map((i) => ({
    i, amount: 1, tab: "bet", autoBet: false, autoCash: false, target: 2, status: "idle", bet: null, el: null, color: i ? "purple" : "blue"
  }));

  let state = real() ? "SYNC" : "WAITING";   /* SYNC: asking the server for the next round */
  let phaseStart = performance.now();
  let round = newRound();
  let previous = null;
  let shownX = 1;
  const results = real() ? [] : Array.from({ length: 24 }, crashPoint);
  let listTab = "all";
  const myBets = [];   /* this session's own bets, newest first, for My Bets */
  let listDirty = true;
  let panelsDirty = true;
  let resultsDirty = true;
  let freshResult = false;

  function startWaiting(at, flightId) {
    state = "WAITING";
    phaseStart = at;
    previous = round;
    round = newRound();
    round.flightId = flightId || null;
    shownX = 1;
    panels.forEach((p) => {
      if (p.status === "queued") {
        p.status = "pending";
        round.mine.push(p.bet);
        if (real()) sendBet(p);
      } else if (p.status === "idle" && p.autoBet) {
        placeBet(p, true);
      }
    });
    listDirty = panelsDirty = true;
    announce("Place your bets. The next round starts in 5 seconds.");
  }

  function startFlight(at) {
    state = "IN_FLIGHT";
    phaseStart = at;
    panels.forEach((p) => {
      if (p.status === "pending") p.status = "active";
    });
    panelsDirty = true;
    announce("Round start! The fight is on.");
    sound.bell(1);
  }

  /* pays every simulated player, and every auto cash-out, whose target has been reached */
  function settleUpTo(x) {
    const q = round.queue;
    while (round.next < q.length && q[round.next].target <= x) {
      const b = q[round.next++];
      b.x = b.target;
      b.win = round2(b.stake * b.target);
      round.cashed++;
      round.win += b.win;
      if (b.name) listDirty = true;
      recordTop(b);
    }
    panels.forEach((p) => {
      if (p.status !== "active") return;
      /* real money: the server confirms an auto cash-out or an early Red (only it knows whether the round got there) */
      if (real()) {
        if ((p.bet.color === "red" && x >= 10) || (p.bet.autoX && p.bet.autoX <= x)) askAuto(p);
      } else if (p.bet.color) {
        if (p.bet.color === "red" && x >= 10) settleColor(p, true);
      } else if (p.autoCash && p.target <= x) cashOut(p, p.target);
    });
  }

  function crash(at) {
    settleUpTo(round.crash);
    state = "CRASHED";
    phaseStart = at;
    shownX = round.crash;
    /* colour bets settle on the knockout's colour */
    panels.forEach((p) => {
      if (!real() && p.status === "active" && p.bet.color) settleColor(p, COLORS[p.bet.color].test(round.crash));
    });
    round.shown.forEach((b) => {
      if (b.color && COLORS[b.color].test(round.crash)) {
        b.x = COLORS[b.color].pay;
        b.win = round2(b.stake * b.x);
      }
    });
    const lost = panels.filter((p) => p.status === "active");
    lost.forEach((p) => {
      p.bet.x = 0;
      p.status = "idle";
      p.bet = null;
    });
    sound.ko();
    results.unshift(round.crash);
    results.length = Math.min(results.length, 30);
    resultsDirty = freshResult = true;
    listDirty = panelsDirty = true;
    announce("Knockout at " + xText(round.crash) + (lost.length ? ". Your bet was lost." : "."));
  }

  /* runs the machine up to `now`, catching up on any phases that passed while the tab was hidden */
  function advance(now) {
    for (;;) {
      if (state === "WAITING" && now - phaseStart >= WAIT_MS) startFlight(phaseStart + WAIT_MS);
      /* real money: the knockout shows when the server's answer arrives, so the pause after it starts then */
      else if (state === "IN_FLIGHT" && now - phaseStart >= flightMs(round.crash)) {
        crash(real() ? Math.max(phaseStart + flightMs(round.crash), now - 100) : phaseStart + flightMs(round.crash));
      } else if (state === "CRASHED" && now - phaseStart >= HOLD_MS) {
        if (real()) state = "SYNC";
        else startWaiting(phaseStart + HOLD_MS);
      } else break;
    }
    if (state === "SYNC") nextRealRound(now);
    if (state === "IN_FLIGHT") {
      shownX = Math.min(round.crash, multiplierAt(now - phaseStart));
      settleUpTo(shownX);
    }
  }

  /* ---------------- player bets ---------------- */
  function placeBet(p, auto) {
    if (p.amount > balance()) {
      if (auto) p.autoBet = false;
      panelsDirty = true;
      U.toast(mode === "fun"
        ? "Not enough credits — top up from the menu."
        : "Not enough in your wallet — please deposit from the wallet.", "err");
      return;
    }
    p.bet = { name: "You", hue: 48, stake: p.amount, x: 0, win: 0, mine: true, color: betMode === "colorgo" ? p.color : null, auto: !!auto };
    myBets.unshift(p.bet);
    myBets.length = Math.min(myBets.length, 50);
    if (real()) {
      /* the stake goes when the server takes the bet; one made mid-round waits for the next round */
      if (state === "WAITING" && round.flightId) {
        p.status = "pending";
        round.mine.push(p.bet);
        sendBet(p);
      } else {
        p.status = "queued";
      }
      listDirty = panelsDirty = true;
      return;
    }
    move(-p.amount);
    if (state === "WAITING") {
      p.status = "pending";
      round.mine.push(p.bet);
    } else {
      p.status = "queued"; /* a round is already under way */
    }
    listDirty = panelsDirty = true;
  }

  function cancelBet(p) {
    if (real()) {
      cancelReal(p);
      return;
    }
    move(p.bet.stake);
    myBets.splice(myBets.indexOf(p.bet), 1);
    if (p.status === "pending") round.mine.splice(round.mine.indexOf(p.bet), 1);
    p.status = "idle";
    p.bet = null;
    listDirty = panelsDirty = true;
  }

  function cashOut(p, x) {
    const win = round2(p.bet.stake * x);
    move(win);
    showWin(p, x, win);
  }

  /* a win: the bet's row, the session's top list and the celebration */
  function showWin(p, x, win) {
    const b = p.bet;
    b.x = x;
    b.win = win;
    p.status = "idle";
    p.bet = null;
    recordTop(b);
    listDirty = panelsDirty = true;
    celebrate(p, b);
  }

  /* a ColorGo bet: paid at its colour's rate if the round ends in that colour */
  function settleColor(p, won) {
    const b = p.bet;
    p.status = "idle";
    p.bet = null;
    listDirty = panelsDirty = true;
    if (!won) {
      b.x = 0;
      return;
    }
    b.x = COLORS[b.color].pay;
    b.win = round2(b.stake * b.x);
    move(b.win);
    recordTop(b);
    celebrate(p, b);
  }

  /* the gold banner over the ring, a glow on the panel, coins */
  let bannerTimer = 0;
  function celebrate(p, b) {
    p.el.classList.remove("won");
    void p.el.offsetWidth; /* restart the glow */
    p.el.classList.add("won");
    const banner = $("koBanner");
    banner.innerHTML = "YOU WON <b>GHS " + money(b.win) + "</b> <span>" + (b.color ? COLORS[b.color].name + " " : "") + xText(b.x) + "</span>";
    banner.hidden = false;
    banner.classList.remove("show");
    void banner.offsetWidth;
    banner.classList.add("show");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => (banner.hidden = true), 2600);
    sound.coins();
    announce("You won " + money(b.win) + " GHS at " + xText(b.x) + ".");
  }

  function press(p) {
    const before = p.status;
    advance(performance.now()); /* a click that lands after the crash moment must not win */
    if (p.status !== before) {
      panelsDirty = true; /* the round moved on under the click — just show the new state */
      return;
    }
    if (p.bet && p.bet.sending) return; /* this bet's last request is still on its way */
    if (before === "active") {
      if (real()) cashOutReal(p);
      else cashOut(p, shownX);
    } else if (before === "idle") placeBet(p, false);
    else cancelBet(p);
    paintPanel(p);
  }

  /* ---------------- real money: the server runs the rounds ---------------- */
  const SERVER = "/api/games/volta-knockout/flight/";
  const call = (path, body) => U.paymentApi(SERVER + path, body ? { body } : { timeout: 40000 });
  const errorText = (r) => (r.data && (r.data.message || r.data.error)) || "Couldn't reach the game server. Try again.";
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let syncing = false;
  let syncAfter = 0;
  let syncWarned = false;

  /* the next round, or the one under way (after a reload) */
  async function nextRealRound(now) {
    if (syncing || now < syncAfter) return;
    syncing = true;
    const r = await call("next", {});
    syncing = false;
    if (!r.ok) {
      syncAfter = performance.now() + 3000;
      if (!syncWarned) U.toast(r.status === 401 ? "Your session has ended. Sign in again to play for real money." : errorText(r), "err");
      syncWarned = true;
      return;
    }
    syncWarned = false;
    const d = r.data;
    /* the round's own betting time and top multiplier, and the bet limits now (an admin can change them) */
    if (d.wait_ms > 0) WAIT_MS = d.wait_ms;
    if (d.max_x > 1) MAX_CRASH = d.max_x;
    if (d.min_bet > 0) MIN_BET = d.min_bet;
    if (d.max_bet > 0) MAX_BET = d.max_bet;
    results.splice(0, results.length, ...d.history);
    resultsDirty = true;
    /* a round already in the air starts its flight on the next frame, from the right moment */
    startWaiting(performance.now() + d.starts_in_ms - WAIT_MS, d.flight_id);
    d.bets.forEach(restoreBet);
    setRealBalance(d.balance);
    watch(d.flight_id);
  }

  /* a bet this round already has on the server (the page was reloaded) */
  function restoreBet(v) {
    const p = panels[v.panel];
    if (!p || v.status !== "ACTIVE" || p.status !== "idle") return;
    p.bet = { name: "You", hue: 48, stake: v.stake, x: 0, win: 0, mine: true, id: v.bet_id, autoX: v.auto_x,
      color: v.kind === "classic" ? null : v.kind };
    p.status = "pending";
    round.mine.push(p.bet);
    myBets.unshift(p.bet);
    listDirty = panelsDirty = true;
  }

  async function sendBet(p) {
    const b = p.bet;
    const flightId = round.flightId;
    b.key = b.key || "flight:" + crypto.randomUUID();
    b.sending = true;
    panelsDirty = true;
    let r;
    for (let tries = 0; tries < 3; tries++) {
      r = await call("bet", { flight_id: flightId, panel: p.i, stake: b.stake, kind: b.color || "classic",
        auto: !b.color && p.autoCash ? p.target : null, idempotency_key: b.key });
      if (r.status !== 0) break; /* only a lost connection is tried again, with the same key */
      await sleep(700);
    }
    b.sending = false;
    listDirty = panelsDirty = true;
    if (p.bet !== b) return;
    if (r.ok) {
      b.id = r.data.bet.bet_id;
      b.autoX = r.data.bet.auto_x;
      setRealBalance(r.data.balance);
      return;
    }
    const i = round.mine.indexOf(b);
    if (i >= 0) round.mine.splice(i, 1);
    if (r.data && r.data.error === "too_late") {
      b.key = null; /* the round took off before the bet arrived: it goes on the next one */
      p.status = "queued";
      return;
    }
    p.status = "idle";
    p.bet = null;
    if (myBets.includes(b)) myBets.splice(myBets.indexOf(b), 1);
    if (b.auto) p.autoBet = false;
    U.toast(errorText(r), "err");
    U.refreshBalance().then(paintBalance);
  }

  async function cancelReal(p) {
    const b = p.bet;
    if (p.status === "queued") { /* not on the server yet */
      p.status = "idle";
      p.bet = null;
      listDirty = panelsDirty = true;
      return;
    }
    b.sending = true;
    panelsDirty = true;
    const r = await call("cancel", { bet_id: b.id });
    b.sending = false;
    listDirty = panelsDirty = true;
    if (!r.ok || r.data.bet.status !== "CANCELLED") {
      U.toast(errorText(r), "err");
      return;
    }
    const i = round.mine.indexOf(b);
    if (i >= 0) round.mine.splice(i, 1);
    if (myBets.includes(b)) myBets.splice(myBets.indexOf(b), 1);
    if (p.bet === b) {
      p.status = "idle";
      p.bet = null;
    }
    setRealBalance(r.data.balance);
  }

  async function cashOutReal(p) {
    const b = p.bet;
    b.sending = true;
    panelsDirty = true;
    const r = await call("cashout", { bet_id: b.id });
    b.sending = false;
    panelsDirty = true;
    if (!r.ok) {
      U.toast(errorText(r), "err");
      return;
    }
    if (r.data.bet.status === "LOST" && r.data.crash) {
      U.toast("Too late — knockout at " + xText(r.data.crash) + ".", "err");
      if (round.mine.includes(b) && !isFinite(round.crash)) round.crash = r.data.crash;
    }
    settleReal(p, r.data.bet, r.data.balance);
  }

  /* the multiplier on screen has passed this bet's auto cash-out (or 10x, for Red): ask the server whether it's come in */
  async function askAuto(p) {
    const b = p.bet;
    if (b.sending || b.askAt > performance.now()) return;
    b.sending = true;
    const r = await call("cashout", { bet_id: b.id, auto: true });
    b.sending = false;
    if (r.ok) settleReal(p, r.data.bet, r.data.balance);
    if (p.bet === b) b.askAt = performance.now() + 400; /* not there yet on the server's clock: ask again shortly */
  }

  /* the server's word on one bet */
  function settleReal(p, v, balance) {
    const b = p.bet;
    if (!b || b.id !== v.bet_id) return;
    setRealBalance(balance);
    if (v.status === "WON") showWin(p, v.x, v.payout);
    else if (v.status === "LOST") {
      b.x = 0;
      p.status = "idle";
      p.bet = null;
      listDirty = panelsDirty = true;
    }
  }

  /* the long poll: answered when the round is over, with the crash point and every bet's result */
  let watching = null;
  async function watch(id) {
    if (watching === id) return;
    watching = id;
    while (watching === id && round.flightId === id) {
      const r = await call(id + "/wait");
      if (round.flightId !== id) break;
      if (r.ok && r.data.over) {
        reveal(r.data);
        break;
      }
      if (!r.ok) await sleep(1500);
    }
    if (watching === id) watching = null;
  }

  function reveal(d) {
    /* wins (auto cash-outs and colours that came in) are shown now; the rest go down at the knockout in crash() */
    d.bets.forEach((v) => {
      const p = panels.find((q) => q.bet && q.bet.id === v.bet_id);
      if (p && v.status === "WON") settleReal(p, v, d.balance);
    });
    setRealBalance(d.balance);
    round.crash = d.crash; /* advance() ends the fight there */
  }

  /* ---------------- bet panels ---------------- */
  const clampAmount = (v) => Math.min(MAX_BET, Math.max(MIN_BET, round2(v)));
  const clampTarget = (v) => Math.min(MAX_CRASH, Math.max(1.01, round2(v)));
  const parse = (s) => Number(String(s).replace(/[^\d.]/g, ""));

  function buildPanel(p) {
    const el = document.createElement("section");
    el.className = "cg-panel";
    el.setAttribute("aria-label", "Bet " + (p.i + 1));
    el.innerHTML =
      '<div class="cg-switch">' +
      '<button type="button" data-tab="bet">Bet</button><button type="button" data-tab="auto">Auto</button></div>' +
      '<div class="cg-panel-body">' +
      '<div class="cg-amount">' +
      '<div class="cg-stepper">' +
      '<button type="button" data-step="-1" aria-label="Lower bet ' + (p.i + 1) + '">−</button>' +
      '<input type="text" inputmode="decimal" autocomplete="off" aria-label="Bet ' + (p.i + 1) + ' amount in GHS" data-amount>' +
      '<button type="button" data-step="1" aria-label="Raise bet ' + (p.i + 1) + '">+</button></div>' +
      '<div class="cg-presets">' +
      '<button type="button" data-quick="half">1/2</button><button type="button" data-quick="double">2x</button><button type="button" data-quick="all">All In</button>' +
      "</div></div>" +
      '<div class="ko-colors" role="radiogroup" aria-label="ColorGo colour for bet ' + (p.i + 1) + '">' +
      Object.keys(COLORS).map((k) => '<button type="button" role="radio" class="ko-c ko-' + k + '" data-color="' + k + '"><b>' +
        COLORS[k].name + "</b><span>" + COLORS[k].range + "</span><em>" + COLORS[k].pay.toFixed(2) + "x</em></button>").join("") +
      "</div>" +
      '<button class="cg-cta" type="button" data-cta>' +
      '<span class="cg-cta-note"></span> <span class="cg-cta-label">Bet</span> <span class="cg-cta-amount"></span></button>' +
      "</div>" +
      '<div class="cg-auto" hidden>' +
      '<label class="cg-toggle"><input type="checkbox" data-auto-bet><span class="cg-knob" aria-hidden="true"></span>Auto bet</label>' +
      '<div class="cg-autocash">' +
      '<label class="cg-toggle"><input type="checkbox" data-auto-cash><span class="cg-knob" aria-hidden="true"></span>Auto cash out</label>' +
      '<span class="cg-target"><input type="text" inputmode="decimal" autocomplete="off" aria-label="Auto cash out multiplier for bet ' +
      (p.i + 1) + '" data-target><span aria-hidden="true">x</span></span>' +
      "</div></div>";
    p.el = el;

    const amountInput = el.querySelector("[data-amount]");
    const targetInput = el.querySelector("[data-target]");
    const setAmount = (v) => {
      p.amount = clampAmount(v);
      panelsDirty = true;
      paintPanel(p);
    };

    el.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-tab]");
      const step = e.target.closest("[data-step]");
      const preset = e.target.closest("[data-preset]");
      if (tab) {
        p.tab = tab.dataset.tab;
        /* leaving Auto switches automation off, so nothing keeps betting out of sight */
        if (p.tab === "bet") p.autoBet = p.autoCash = false;
        paintPanel(p);
      } else if (step) setAmount(p.amount + Number(step.dataset.step) * (p.amount < 1 || (p.amount <= 1 && step.dataset.step < 0) ? 0.1 : 1));
      else if (preset) setAmount(Number(preset.dataset.preset));
      else if (e.target.closest("[data-quick]")) {
        const q = e.target.closest("[data-quick]").dataset.quick;
        setAmount(q === "half" ? p.amount / 2 : q === "double" ? p.amount * 2 : Math.min(MAX_BET, Math.floor(balance() * 100) / 100));
      } else if (e.target.closest("[data-color]") && p.status === "idle") {
        p.color = e.target.closest("[data-color]").dataset.color;
        paintPanel(p);
      }
      else if (e.target.closest("[data-cta]")) press(p);
    });
    amountInput.addEventListener("change", () => setAmount(parse(amountInput.value) || MIN_BET));
    targetInput.addEventListener("change", () => {
      p.target = clampTarget(parse(targetInput.value) || 2);
      paintPanel(p);
    });
    [amountInput, targetInput].forEach((input) =>
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); })
    );
    el.querySelector("[data-auto-bet]").addEventListener("change", (e) => {
      p.autoBet = e.target.checked;
      if (p.autoBet && state === "WAITING" && p.status === "idle") placeBet(p, true);
      paintPanel(p);
    });
    el.querySelector("[data-auto-cash]").addEventListener("change", (e) => {
      p.autoCash = e.target.checked;
    });
    return el;
  }

  function paintPanel(p) {
    const el = p.el;
    const busy = p.status !== "idle";
    el.classList.toggle("armed", p.status === "pending" || p.status === "queued");
    el.classList.toggle("live", p.status === "active");
    el.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === p.tab)));
    el.querySelector(".cg-auto").hidden = p.tab !== "auto";
    el.querySelectorAll("[data-step], [data-preset], [data-quick], [data-amount], [data-color]").forEach((c) => (c.disabled = busy));
    /* a real bet takes its auto cash-out to the server with it, so it's fixed until the bet is over */
    el.querySelectorAll("[data-auto-cash], [data-target]").forEach((c) => (c.disabled = real() && busy));
    const colorGo = p.bet ? !!p.bet.color : betMode === "colorgo";
    el.classList.toggle("is-color", colorGo);
    el.querySelector(".ko-colors").hidden = !colorGo;
    el.querySelectorAll("[data-color]").forEach((c) => c.setAttribute("aria-checked", String(c.dataset.color === (p.bet && p.bet.color ? p.bet.color : p.color))));

    /* never overwrite a field while someone is typing in it */
    const amountInput = el.querySelector("[data-amount]");
    const targetInput = el.querySelector("[data-target]");
    if (document.activeElement !== amountInput) amountInput.value = money(p.amount);
    if (document.activeElement !== targetInput) targetInput.value = p.target.toFixed(2);
    el.querySelector("[data-auto-bet]").checked = p.autoBet;
    el.querySelector("[data-auto-cash]").checked = p.autoCash;

    const cta = el.querySelector("[data-cta]");
    const colorBet = p.status === "active" && p.bet.color;
    cta.className = "cg-cta" + (colorBet ? " ko-wait" : p.status === "active" ? " cash" : busy ? " cancel" : "");
    cta.disabled = !!colorBet || !!(p.bet && p.bet.sending);
    cta.querySelector(".cg-cta-note").textContent = p.status === "queued" ? "Waiting for next round" : colorBet ? "In play — " + COLORS[p.bet.color].name : "";
    cta.querySelector(".cg-cta-label").textContent = colorBet ? "Settles at the knockout" : p.status === "active" ? "Cash Out" : busy ? "Cancel" : colorGo ? "Bet " + COLORS[p.color].name : "Bet";
    cta.querySelector(".cg-cta-amount").textContent =
      colorBet ? "" : p.status === "active" ? money(p.bet.stake * shownX) + " GHS" : busy ? "" : money(p.amount) + " GHS";
  }

  /* ---------------- live bets list ---------------- */
  function rowHtml(b) {
    return '<div class="cg-row' + (b.win ? " won" : "") + (b.mine ? " mine" : "") + '">' +
      '<span class="cg-user"><span class="cg-ava" style="--h:' + b.hue + '" aria-hidden="true">' + b.name.charAt(0) + "</span>" +
      '<span class="cg-name">' + b.name + "</span>" +
      (b.color ? '<span class="ko-tag ko-' + b.color + '">ColorGo ' + COLORS[b.color].pay.toFixed(2) + "x</span>" : "") + "</span>" +
      '<span class="cg-num">' + money(b.stake) + "</span>" +
      '<span class="cg-xcell">' + (b.x ? pill(b.x) : "") + "</span>" +
      '<span class="cg-num">' + (b.win ? money(b.win) : "") + "</span></div>";
  }

  function renderList() {
    $("cgPrev").hidden = true;
    if (listTab === "stats") return renderStats();
    const rows = listTab === "all" ? round.mine.concat(round.shown) : myBets;
    $("cgList").innerHTML = rows.length
      ? rows.map(rowHtml).join("")
      : '<p class="cg-empty">' + (listTab === "my" ? "Your bets this session will appear here." : "No bets yet.") + "</p>";
  }

  /* Stats: how the recent rounds ended, by colour, and the biggest wins of the session */
  function renderStats() {
    const n = results.length;
    const c = { blue: 0, purple: 0, red: 0 };
    results.forEach((x) => c[colorOf(x)]++);
    const best = results.reduce((a, b) => Math.max(a, b), 0);
    $("cgList").innerHTML =
      '<div class="ko-stats">' +
      Object.keys(COLORS).map((k) => '<div class="ko-stat ko-' + k + '"><b>' + Math.round((c[k] / n) * 100) + "%</b><span>" + COLORS[k].name + " · " +
        COLORS[k].range + "</span><em>expected " + Math.round(COLORS[k].p * 100) + "%</em></div>").join("") +
      '<p class="ko-stat-note">Last ' + n + " rounds · highest " + xText(best) + ". Each round is independent — past results don't change the next one.</p></div>" +
      '<h3 class="ko-sub">Biggest wins this session</h3>' +
      (top.length ? top.map(rowHtml).join("") : '<p class="cg-empty">The biggest wins of this session will appear here.</p>');
  }

  /* footer: bets cashed out / bets placed this round, and the total paid out so far */
  function paintSummary() {
    const total = round.total + round.mine.length;
    const left = state !== "WAITING" ? total - round.cashed - round.mine.filter((b) => b.win).length : total;
    $("koTotal").textContent = count(total);
    $("koLeft").textContent = count(left);
    const won = round.mine.filter((b) => b.win).length;
    const myWin = round.mine.reduce((s, b) => s + b.win, 0);
    $("cgCount").textContent = count(round.cashed + won) + "/" + count(round.total + round.mine.length) + " Bets";
    $("cgTotal").textContent = money(round.win + myWin);
  }

  document.querySelector(".cg-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-list]");
    if (!b) return;
    listTab = b.dataset.list;
    document.querySelectorAll("[data-list]").forEach((t) => t.setAttribute("aria-selected", String(t === b)));
    listDirty = true;
  });

  /* ---------------- results ribbon ---------------- */
  function renderResults() {
    $("cgHistory").innerHTML = results.map((x, i) => pill(x, i === 0 && freshResult ? " new" : "")).join("");
    freshResult = false;
  }

  /* ---------------- stage overlays ---------------- */
  const stage = $("cgStage");
  const mult = $("cgMult");
  const waitTime = $("cgWaitTime");
  const waitBar = $("cgWaitBar");
  let paintedState = "";

  function paintStage(now) {
    if (paintedState !== state) {
      paintedState = state;
      stage.classList.toggle("crashed", state === "CRASHED");
      $("cgWait").hidden = state !== "WAITING" && state !== "SYNC";
      $("cgFlew").hidden = state !== "CRASHED";
      $("koStart").hidden = state !== "IN_FLIGHT";
      mult.hidden = state === "WAITING" || state === "SYNC";
    }
    if (state === "SYNC") {
      waitBar.style.transform = "scaleX(0)";
      if (waitTime.textContent !== "Getting the next round…") waitTime.textContent = "Getting the next round…";
    } else if (state === "WAITING") {
      const left = Math.max(0, WAIT_MS - (now - phaseStart));
      waitBar.style.transform = "scaleX(" + (left / WAIT_MS).toFixed(3) + ")";
      const text = "Next round in " + (left / 1000).toFixed(1) + "s";
      if (waitTime.textContent !== text) waitTime.textContent = text;
    } else {
      if (state === "IN_FLIGHT" && !$("koStart").hidden && now - phaseStart > 1400) $("koStart").hidden = true;
      if (state === "CRASHED") $("cgFlew").textContent = "Round End! " + xText(round.crash);
      const text = xText(shownX);
      if (mult.textContent !== text) {
        mult.textContent = text;
        /* the number grows with the multiplier: ×1.35 at 10x, capped at ×1.45 */
        mult.style.setProperty("--s", (1 + Math.min(0.45, Math.log10(shownX) * 0.35)).toFixed(3));
      }
    }
  }

  /* ---------------- the fight (knockout-art.js) and its sounds ---------------- */
  let audio = null;
  const unlock = () => {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
    } catch (e) {
      audio = null;
    }
  };
  document.addEventListener("pointerdown", unlock, { once: true });
  function noise(at, dur, type, f0, f1, vol, q) {
    const t = audio.currentTime + at;
    const len = Math.floor(audio.sampleRate * dur);
    const buf = audio.createBuffer(1, len, audio.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = audio.createBufferSource();
    src.buffer = buf;
    const f = audio.createBiquadFilter();
    f.type = type;
    f.Q.value = q || 1;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = audio.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(audio.destination);
    src.start(t);
  }
  function tone(at, f, dur, vol, type) {
    const t = audio.currentTime + at;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type || "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  const sound = {
    /* a glove landing: a low body thud with a leather slap */
    punch(power) {
      if (!audio) return;
      tone(0, 90 + power * 40, 0.18, 0.35 + power * 0.3);
      noise(0, 0.07, "bandpass", 1600, 700, 0.25 + power * 0.3, 1.5);
    },
    /* the ring bell: one ring to start, three for the knockout */
    bell(n) {
      if (!audio) return;
      for (let k = 0; k < n; k++) [1, 2.76, 5.4].forEach((m, j) => tone(k * 0.32, 880 * m, 1.2 - j * 0.3, 0.12 / (j + 1)));
    },
    ko() {
      if (!audio) return;
      this.bell(3);
      noise(0.1, 1.8, "bandpass", 700, 900, 0.3, 0.5);   /* the crowd */
    },
    coins() {
      if (!audio) return;
      for (let k = 0; k < 8; k++) tone(k * 0.05, 2600 + Math.random() * 1600, 0.15, 0.06, "triangle");
    }
  };
  const art = window.VBKnockoutArt.create($("cgCanvas"), { reduceMotion, onPunch: (p) => sound.punch(p) });

  /* ---------------- header: menu, chat, rules ---------------- */
  const menu = $("cgMenu");
  const menuBtn = $("cgMenuBtn");
  const setMenu = (open) => {
    menu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", String(open));
  };
  menuBtn.addEventListener("click", () => setMenu(menu.hidden));
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) setMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      setMenu(false);
      menuBtn.focus();
    }
  });
  menu.addEventListener("click", (e) => {
    const m = e.target.closest("[data-mode]");
    if (!m || m.dataset.mode === mode || (m.dataset.mode === "real" && !signedIn)) return;
    if (panels.some((p) => p.status !== "idle")) {
      U.toast("Cash out or cancel your bets before switching.", "err");
      return;
    }
    /* each mode runs its own rounds (the browser's, or the server's), so switching starts the page afresh */
    params.set("mode", m.dataset.mode);
    location.replace(location.pathname + "?" + params.toString());
  });
  $("cgTopUp").addEventListener("click", () => {
    fun = Math.max(fun, FUN_CREDITS);
    paintBalance();
    setMenu(false);
    U.toast("Credits topped up to " + money(fun) + " GHS", "ok");
  });
  $("cgRulesBtn").addEventListener("click", () => {
    setMenu(false);
    $("cgRules").showModal();
  });
  $("cgChat").addEventListener("click", () => U.openChat());
  window.addEventListener("storage", paintBalance); /* the wallet may change in another tab */
  document.addEventListener("vb:balance", paintBalance);

  /* simulated "players online" count that drifts every couple of seconds */
  let online = 3200 + Math.floor(Math.random() * 600);
  const paintOnline = () => ($("cgOnline").textContent = count(online));
  setInterval(() => {
    online = Math.min(4200, Math.max(2800, online + Math.round((Math.random() - 0.5) * 120)));
    paintOnline();
  }, 2000);

  /* ---------------- frame loop ---------------- */
  let paintedCashed = -1;
  let artState = "WAITING"; /* while the next real round is being fetched, the ring stays as it was */
  function frame(now) {
    advance(now);
    paintStage(now);
    if (state !== "SYNC") artState = state;
    art.draw(now, { state: artState, x: shownX, ms: now - phaseStart });
    if (resultsDirty) {
      renderResults();
      resultsDirty = false;
    }
    if (listDirty) {
      renderList();
      listDirty = false;
      paintedCashed = -1;
    }
    if (round.cashed !== paintedCashed) {
      paintSummary();
      paintedCashed = round.cashed;
    }
    if (panelsDirty) {
      panels.forEach(paintPanel);
      panelsDirty = false;
    } else {
      /* only the live cash-out amounts change every frame */
      panels.forEach((p) => {
        if (p.status === "active") p.el.querySelector(".cg-cta-amount").textContent = money(p.bet.stake * shownX) + " GHS";
      });
    }
    requestAnimationFrame(frame);
  }

  /* the mode bar under the ring: Classic (cash out) or ColorGo (call the colour) for the next bets */
  $("koModes").addEventListener("click", (e) => {
    const m = e.target.closest("[data-betmode]");
    if (!m) return;
    betMode = m.dataset.betmode;
    $("koModes").querySelectorAll("[data-betmode]").forEach((b) => b.setAttribute("aria-pressed", String(b === m)));
    panelsDirty = true;
    announce(betMode === "colorgo" ? "ColorGo: pick Blue, Purple or Red on a panel, then bet." : "Classic: bet, then cash out before the knockout.");
  });

  $("cgPanels").append(...panels.map(buildPanel));
  paintBalance();
  paintOnline();
  if (real()) {
    U.refreshBalance().then(() => {
      paintBalance();
      if (balance() < MIN_BET) U.toast("Your wallet is empty — deposit to play for real money.", "err");
    });
  }
  requestAnimationFrame(frame);
})();
