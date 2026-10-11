/* Rendo Crash — place up to two bets, cash out before the plane flies away.
   Each round: WAITING (5s to bet) → IN_FLIGHT (multiplier climbs to the crash point) → CRASHED (2s hold) → WAITING …
   With free credits the rounds run in the browser. With real money the server runs the player's rounds (backend
   games/flights.ts): it draws the crash point, takes the bets, judges every cash-out on its own clock and pays it,
   and the page learns where a round crashed only once it's over. The other players in the list are simulated. */
(function () {
  "use strict";
  const games = window.VB.allGames || window.VB.games;
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);

  const WAIT_MS = 5000;   // betting window before each round
  const HOLD_MS = 2000;   // "FLEW AWAY!" pause after a crash
  const GROWTH = 0.12;    // multiplier = e^(GROWTH × seconds): 2x after ~5.8s, 10x after ~19s, 100x after ~38s
  const CRUISE_S = 8;     // seconds the plane takes to climb to its cruising spot
  const MAX_CRASH = 10000;
  const MIN_BET = 1;
  const MAX_BET = 1000;
  const FUN_CREDITS = 3000;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* any crash title (listed under Live Casino) can be played here; unknown ids fall back to Rendo Crash */
  const params = new URLSearchParams(location.search);
  const game = games.find((g) => g.id === params.get("game") && g.category === "Live Casino") ||
    games.find((g) => g.id === "crash");
  U.recent.add(game.id);
  document.title = game.name + " — WIN B WIN";
  $("cgTitle").textContent = game.name;
  /* Rendo Crash has its own wordmark; other crash titles show the plane tile and their name */
  if (game.id !== "volta-crash") {
    $("cgWordmark").hidden = true;
    $("cgLogo").hidden = false;
    $("cgTitle").hidden = false;
  }
  $("cgRtp").textContent = game.rtp + "%";
  $("cgRulesRtp").textContent = game.rtp + "%";

  const round2 = (n) => Math.round(n * 100) / 100;
  const money = (n) => n.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const count = (n) => n.toLocaleString("en-GH");
  const xText = (x) => x.toFixed(2) + "x";
  const xClass = (x) => (x < 2 ? "x-blue" : x < 10 ? "x-purple" : "x-pink");
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
    if (listTab === "top") listDirty = true;
  }

  /* ---------------- round state machine ---------------- */
  /* status: idle → pending (bet on the coming round) or queued (bet made mid-round, for the next one)
     → active (in flight) → idle again once cashed out or lost */
  const panels = [0, 1].map((i) => ({
    i, amount: 1, tab: "bet", autoBet: false, autoCash: false, target: 2, status: "idle", bet: null, el: null
  }));

  let state = real() ? "SYNC" : "WAITING";   /* SYNC: asking the server for the next round */
  let phaseStart = performance.now();
  let round = newRound();
  let previous = null;
  let shownX = 1;
  const results = real() ? [] : Array.from({ length: 24 }, crashPoint);
  let listTab = "all";
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
    announce("The plane has taken off.");
  }

  /* pays every simulated player, and every auto cash-out, whose target has been reached */
  function settleUpTo(x) {
    const q = round.queue;
    while (round.next < q.length && q[round.next].target <= x) {
      const b = q[round.next++];
      b.x = b.target;
      b.win = Math.floor(b.stake * b.target * 100 + 1e-6) / 100;   /* down to the cent, as the server pays */
      round.cashed++;
      round.win += b.win;
      if (b.name) listDirty = true;
      recordTop(b);
    }
    panels.forEach((p) => {
      if (p.status !== "active") return;
      /* real money: the server confirms an auto cash-out (only it knows whether the round really got there) */
      if (real()) {
        if (p.bet.autoX && p.bet.autoX <= x) askAuto(p);
      } else if (p.autoCash && p.target <= x) cashOut(p, p.target);
    });
  }

  function crash(at) {
    settleUpTo(round.crash);
    state = "CRASHED";
    phaseStart = at;
    shownX = round.crash;
    const lost = panels.filter((p) => p.status === "active");
    lost.forEach((p) => {
      p.status = "idle";
      p.bet = null;
    });
    results.unshift(round.crash);
    results.length = Math.min(results.length, 30);
    resultsDirty = freshResult = true;
    listDirty = panelsDirty = true;
    announce("Flew away at " + xText(round.crash) + (lost.length ? ". Your bet was lost." : "."));
  }

  /* runs the machine up to `now`, catching up on any phases that passed while the tab was hidden */
  function advance(now) {
    for (;;) {
      if (state === "WAITING" && now - phaseStart >= WAIT_MS) startFlight(phaseStart + WAIT_MS);
      /* real money: the crash shows when the server's answer arrives, so the "flew away" pause starts then */
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
      U.toast(mode !== "fun" && U.moneyInDollars && U.moneyInDollars() > 0
        ? "Your money is in US dollars — switch to cedis from the balance menu at the top to play."
        : mode === "fun" ? "Not enough credits — top up from the menu."
        : "Not enough in your wallet — please deposit from the wallet.", "err");
      return;
    }
    p.bet = { name: "You", hue: 48, stake: p.amount, x: 0, win: 0, mine: true, auto: !!auto };
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
    if (p.status === "pending") round.mine.splice(round.mine.indexOf(p.bet), 1);
    p.status = "idle";
    p.bet = null;
    listDirty = panelsDirty = true;
  }

  function cashOut(p, x) {
    const win = Math.floor(p.bet.stake * x * 100 + 1e-6) / 100;   /* down to the cent, as the server pays */
    move(win);
    showWin(p, x, win);
  }

  function showWin(p, x, win) {
    const b = p.bet;
    b.x = x;
    b.win = win;
    p.status = "idle";
    p.bet = null;
    recordTop(b);
    listDirty = panelsDirty = true;
    p.el.classList.remove("won");
    void p.el.offsetWidth; /* restart the glow */
    p.el.classList.add("won");
    const msg = "You cashed out at " + xText(x) + " and won " + money(win) + " GHS";
    U.toast(msg, "ok");
    announce(msg);
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
  const SERVER = "/api/games/volta-crash/flight/";
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
    p.bet = { name: "You", hue: 48, stake: v.stake, x: 0, win: 0, mine: true, id: v.bet_id, autoX: v.auto_x };
    p.status = "pending";
    round.mine.push(p.bet);
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
      r = await call("bet", { flight_id: flightId, panel: p.i, stake: b.stake, auto: p.autoCash ? p.target : null, idempotency_key: b.key });
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
      U.toast("Too late — it flew away at " + xText(r.data.crash) + ".", "err");
      if (round.mine.includes(b) && !isFinite(round.crash)) round.crash = r.data.crash;
    }
    settleReal(p, r.data.bet, r.data.balance);
  }

  /* the multiplier on screen has passed this bet's auto cash-out: ask the server whether it's come in */
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
    /* wins (auto cash-outs that came in) are shown now; the rest go down with the plane in crash() */
    d.bets.forEach((v) => {
      const p = panels.find((q) => q.bet && q.bet.id === v.bet_id);
      if (p && v.status === "WON") settleReal(p, v, d.balance);
    });
    setRealBalance(d.balance);
    round.crash = d.crash; /* advance() ends the flight there */
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
      [1, 2, 5, 10].map((v) => '<button type="button" data-preset="' + v + '">' + v + "</button>").join("") +
      "</div></div>" +
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
      } else if (step) setAmount(p.amount + Number(step.dataset.step));
      else if (preset) setAmount(Number(preset.dataset.preset));
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
    el.querySelectorAll("[data-step], [data-preset], [data-amount]").forEach((c) => (c.disabled = busy));
    /* a real bet takes its auto cash-out to the server with it, so it's fixed until the bet is over */
    el.querySelectorAll("[data-auto-cash], [data-target]").forEach((c) => (c.disabled = real() && busy));

    /* never overwrite a field while someone is typing in it */
    const amountInput = el.querySelector("[data-amount]");
    const targetInput = el.querySelector("[data-target]");
    if (document.activeElement !== amountInput) amountInput.value = money(p.amount);
    if (document.activeElement !== targetInput) targetInput.value = p.target.toFixed(2);
    el.querySelector("[data-auto-bet]").checked = p.autoBet;
    el.querySelector("[data-auto-cash]").checked = p.autoCash;

    const cta = el.querySelector("[data-cta]");
    cta.disabled = !!(p.bet && p.bet.sending);
    cta.className = "cg-cta" + (p.status === "active" ? " cash" : busy ? " cancel" : "");
    cta.querySelector(".cg-cta-note").textContent = p.status === "queued" ? "Waiting for next round" : "";
    cta.querySelector(".cg-cta-label").textContent = p.status === "active" ? "Cash Out" : busy ? "Cancel" : "Bet";
    cta.querySelector(".cg-cta-amount").textContent =
      p.status === "active" ? money(p.bet.stake * shownX) + " GHS" : busy ? "" : money(p.amount) + " GHS";
  }

  /* ---------------- live bets list ---------------- */
  function rowHtml(b) {
    return '<div class="cg-row' + (b.win ? " won" : "") + (b.mine ? " mine" : "") + '">' +
      '<span class="cg-user"><span class="cg-ava" style="--h:' + b.hue + '" aria-hidden="true">' + b.name.charAt(0) + "</span>" +
      '<span class="cg-name">' + b.name + "</span></span>" +
      '<span class="cg-num">' + money(b.stake) + "</span>" +
      '<span class="cg-xcell">' + (b.x ? pill(b.x) : "") + "</span>" +
      '<span class="cg-num">' + (b.win ? money(b.win) : "") + "</span></div>";
  }

  function renderList() {
    const rows = listTab === "all" ? round.mine.concat(round.shown)
      : listTab === "previous" ? (previous ? previous.mine.concat(previous.shown) : [])
      : top;
    const prev = $("cgPrev");
    prev.hidden = listTab !== "previous" || !previous;
    if (previous) prev.innerHTML = "Round result " + pill(previous.crash);
    $("cgList").innerHTML = rows.length
      ? rows.map(rowHtml).join("")
      : '<p class="cg-empty">' + (listTab === "top" ? "The biggest wins of this session will appear here." : "No bets yet.") + "</p>";
  }

  /* footer: bets cashed out / bets placed this round, and the total paid out so far */
  function paintSummary() {
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
      const text = xText(shownX);
      if (mult.textContent !== text) {
        mult.textContent = text;
        /* the number grows with the multiplier: ×1.35 at 10x, capped at ×1.45 */
        mult.style.setProperty("--s", (1 + Math.min(0.45, Math.log10(shownX) * 0.35)).toFixed(3));
      }
    }
  }

  /* ---------------- canvas: sunburst, flight curve and plane ---------------- */
  const canvas = $("cgCanvas");
  const ctx = canvas.getContext("2d");
  let W = 0;
  let H = 0;

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  /* the plane artwork (assets/img/plane.svg, a 240 × 110 side view) is rasterised once into an offscreen
     canvas at 4×, so each frame is a cheap bitmap draw; the propeller is painted live so it can spin */
  const ART_W = 240;
  const ART_H = 110;
  const TAIL = { x: 14, y: 47.5 }; /* where the flight curve meets the plane */
  const HUB = { x: 208.5, y: 52 }; /* propeller hub, just behind the spinner */
  let planeArt = null;
  const planeImg = new Image();
  planeImg.onload = () => {
    const art = document.createElement("canvas");
    art.width = ART_W * 4;
    art.height = ART_H * 4;
    art.getContext("2d").drawImage(planeImg, 0, 0, art.width, art.height);
    planeArt = art;
  };
  planeImg.src = "assets/img/plane.svg";

  /* from the side a spinning propeller is edge-on: a faint blur disc, plus blades whose visible
     length swings as they turn */
  function drawPropeller(now) {
    const r = 44;
    const disc = ctx.createLinearGradient(0, HUB.y - r, 0, HUB.y + r);
    disc.addColorStop(0, "rgba(210, 216, 228, 0)");
    disc.addColorStop(0.5, "rgba(210, 216, 228, .32)");
    disc.addColorStop(1, "rgba(210, 216, 228, 0)");
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.ellipse(HUB.x, HUB.y, 3.2, r, 0, 0, Math.PI * 2);
    ctx.fill();
    const turn = reduceMotion ? 0.6 : now / 22;
    ctx.strokeStyle = "rgba(30, 32, 38, .8)";
    ctx.lineWidth = 3.4;
    ctx.lineCap = "round";
    [0, Math.PI].forEach((offset) => {
      const reach = Math.cos(turn + offset) * r;
      if (Math.abs(reach) < 8) return; /* blade hidden behind the spinner */
      ctx.beginPath();
      ctx.moveTo(HUB.x, HUB.y + Math.sign(reach) * 7.5);
      ctx.lineTo(HUB.x, HUB.y + reach);
      ctx.stroke();
    });
  }

  function drawPlane(x, y, angle, size, now) {
    if (!planeArt) return;
    const s = size / ART_W;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(s, s);
    ctx.translate(-TAIL.x, -TAIL.y);
    ctx.shadowColor = "rgba(255, 23, 68, .45)";
    ctx.shadowBlur = 18;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(planeArt, 0, 0, ART_W, ART_H);
    ctx.shadowBlur = 0;
    drawPropeller(now);
    ctx.restore();
  }

  /* slowly turning rays and a pink glow from the take-off corner */
  function drawBackdrop(ox, oy, now) {
    const R = Math.hypot(W, H) * 1.15;
    const turn = reduceMotion ? 0 : (now / 1000) * (state === "IN_FLIGHT" ? 0.1 : 0.04);
    const rays = 24;
    const step = (Math.PI * 2) / rays;
    ctx.fillStyle = "rgba(255, 255, 255, .028)";
    ctx.beginPath();
    for (let i = 0; i < rays; i++) {
      const a = turn + i * step;
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + R * Math.cos(a), oy + R * Math.sin(a));
      ctx.lineTo(ox + R * Math.cos(a + step / 2), oy + R * Math.sin(a + step / 2));
      ctx.closePath();
    }
    ctx.fill();
    const glow = ctx.createRadialGradient(ox, oy, 0, ox, oy, R * 0.55);
    glow.addColorStop(0, "rgba(233, 30, 99, .22)");
    glow.addColorStop(1, "rgba(233, 30, 99, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  /* axis lines with dots that scroll while the plane flies, for a sense of speed */
  function drawAxes(ox, oy, now) {
    const t = state === "IN_FLIGHT" && !reduceMotion ? (now - phaseStart) / 1000 : 0;
    ctx.strokeStyle = "rgba(255, 255, 255, .08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox, 0);
    ctx.lineTo(ox, oy);
    ctx.lineTo(W, oy);
    ctx.stroke();
    ctx.fillStyle = "rgba(63, 81, 181, .9)";
    const gx = 48;
    for (let x = ox + gx - ((t * 36) % gx); x < W; x += gx) {
      ctx.beginPath();
      ctx.arc(x, oy + 11, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255, 255, 255, .55)";
    const gy = 36;
    for (let y = oy - gy + ((t * 22) % gy); y > 0; y -= gy) {
      ctx.beginPath();
      ctx.arc(ox - 11, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* where the curve ends t seconds into the flight: the plane climbs to a cruising spot, then hovers */
  function tipAt(t, clock, ox, oy, size) {
    const k = Math.min(1, t / CRUISE_S);
    const e = 1 - (1 - k) * (1 - k); /* ease-out */
    const xMax = W - size - 12;
    const yMin = Math.max(size * 0.5, H * 0.2);
    let x = ox + (xMax - ox) * e;
    let y = oy - (oy - yMin) * Math.pow(e, 1.8);
    if (k === 1 && !reduceMotion) {
      x += Math.sin(clock / 900) * 6;
      y += Math.sin(clock / 650) * 8;
    }
    return { x, y };
  }

  function draw(now) {
    ctx.clearRect(0, 0, W, H);
    const ox = 26;
    const oy = H - 24;
    drawBackdrop(ox, oy, now);
    drawAxes(ox, oy, now);
    if (state === "WAITING" || state === "SYNC") return;

    const size = Math.min(150, Math.max(76, W * 0.2));
    const flying = state === "IN_FLIGHT";
    const t = (flying ? now - phaseStart : flightMs(round.crash)) / 1000;
    const tip = tipAt(t, flying ? now : phaseStart, ox, oy, size); /* frozen at the crash moment */
    const cx = ox + (tip.x - ox) * 0.6; /* control point on the baseline keeps the take-off flat */
    const cy = oy;
    const since = flying ? 0 : now - phaseStart;

    /* the curve: a filled area under a red quadratic line, fading out after a crash */
    const fade = flying ? 1 : Math.max(0, 1 - since / 350);
    if (fade > 0) {
      ctx.globalAlpha = fade;
      const fill = ctx.createLinearGradient(0, tip.y, 0, oy);
      fill.addColorStop(0, "rgba(233, 30, 99, .45)");
      fill.addColorStop(1, "rgba(233, 30, 99, .04)");
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.quadraticCurveTo(cx, cy, tip.x, tip.y);
      ctx.lineTo(tip.x, oy);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.quadraticCurveTo(cx, cy, tip.x, tip.y);
      ctx.strokeStyle = "#ff1744";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* the plane follows the curve's slope; after a crash it climbs off the top-right corner */
    let angle = Math.max(-0.55, Math.min(0, Math.atan2(tip.y - cy, tip.x - cx)));
    let px = tip.x;
    let py = tip.y;
    if (!flying) {
      const k = Math.min(1, since / 700);
      if (k === 1) return;
      px += (W + size * 2 - tip.x) * k * k;
      py -= (tip.y + size * 2) * k * k;
      angle = -0.5;
    } else if (t >= CRUISE_S && !reduceMotion) {
      angle += Math.sin(now / 500) * 0.04;
    }
    drawPlane(px, py, angle, size, now);
  }

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
  function frame(now) {
    advance(now);
    paintStage(now);
    draw(now);
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
