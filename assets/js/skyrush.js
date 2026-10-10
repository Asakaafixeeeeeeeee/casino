/* Sky Rush — one live crash round for everyone (backend games/skyRush.ts).
   The server opens a round the moment the last plane flew away and takes bets for 8 seconds; then the plane takes off
   and the multiplier climbs, e^(0.09 × seconds). This page learns where a round ends only when it happens (a wait
   request the server holds until the crash), so nothing here can know it early.
   Free credits ride the same live rounds with bets kept in this browser; with the wallet the server takes each bet,
   judges every cash-out on its own clock and pays it. The bets list is the real players' bets, names masked. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const games = window.VB.allGames || window.VB.games;
  const game = games.find((g) => g.id === "sky-rush") || { id: "sky-rush", name: "Sky Rush", rtp: 97 };
  const $ = (id) => document.getElementById(id);
  U.recent.add(game.id);

  const API = "/api/games/sky-rush/live/";
  const GROWTH = 0.09;        // multiplier = e^(GROWTH × seconds)
  const FLEW_MS = 3000;       // "FLEW AWAY!" stays up this long, then the waiting screen
  const CRUISE_S = 5;         // seconds the plane takes to climb to its cruising spot
  const MIN_BET = 1;
  const MAX_BET = 1000;
  const MAX_CRASH = 10000;
  const FUN_CREDITS = 3000;
  const QUICK = [1, 5, 10, 50];
  let MAX_WIN = 250000;

  const multiplierAt = (ms) => Math.max(1, Math.floor(Math.exp((GROWTH * Math.max(0, ms)) / 1000) * 100) / 100);
  const flightMs = (x) => (Math.log(x) / GROWTH) * 1000;
  const capOf = (stake) => Math.min(MAX_CRASH, Math.floor((MAX_WIN / stake) * 100 + 1e-9) / 100);
  const floor2 = (n) => Math.floor(n * 100 + 1e-6) / 100;
  const round2 = (n) => Math.round(n * 100) / 100;
  const money = (n) => (Number(n) || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const count = (n) => (Number(n) || 0).toLocaleString("en-GH");
  const xText = (x) => Number(x).toFixed(2) + "x";
  const xClass = (x) => (x < 2 ? "x-blue" : x < 10 ? "x-purple" : "x-pink");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const announce = (msg) => ($("srLive").textContent = msg);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("rendowin.sky." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("rendowin.sky." + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
  };

  /* ---------------- avatars: drawn here, picked per player by the server (0–23) ---------------- */
  const AVA_BG = [["#7b5cff", "#4b2bd1"], ["#ff6b6b", "#c23a3a"], ["#2ec4b6", "#14857a"], ["#ff9f1c", "#c46c00"], ["#3a86ff", "#1c55c4"],
    ["#b14aed", "#7a1fb3"], ["#06d6a0", "#03936d"], ["#ef476f", "#b3204a"], ["#118ab2", "#0a5a75"], ["#f4a261", "#b8682b"],
    ["#9b5de5", "#6331a8"], ["#00bbf9", "#0079a8"]];
  const SKIN = ["#f6d1b1", "#e8b48f", "#c68863", "#9b6743", "#6b4630"];
  const HAIR = ["#1d1d1f", "#3b2a20", "#6b4423", "#a0522d", "#d9a441", "#2b2b2b", "#7a7a7a"];
  const SHIRT = ["#264653", "#e76f51", "#2a9d8f", "#e9c46a", "#5e60ce", "#ef233c", "#3d405b", "#06d6a0", "#f1faee"];
  const HAIRDO = [
    "M11 16c0-7 3.6-10.5 9-10.5S29 9 29 16c-1.8-3.4-5-4.6-9-4.6S12.8 12.6 11 16z",
    "M10 18c0-8 4-12 10-12s10 4 10 12v7c-1-5-2-8.6-3.2-9.8C24.6 17 22.2 17.6 20 17.6s-4.6-.6-6.8-2.4C12 16.4 11 20 10 25z",
    "M12.4 12.6c1-4.2 4-6.4 7.6-6.4s6.6 2.2 7.6 6.4c-2.8-1.2-5-1.6-7.6-1.6s-4.8.4-7.6 1.6z",
    "M10.6 16.6c-.4-6.6 3.6-11 9.4-11s9.8 4.4 9.4 11c-1-1.4-2.6-2.2-4-2.4-.4-2.6-2.6-4.2-5.4-4.2s-5 1.6-5.4 4.2c-1.4.2-3 1-4 2.4z"
  ];
  const avaCache = new Map();
  function avatar(i) {
    i = ((Math.floor(Number(i) || 0) % 24) + 24) % 24;
    if (avaCache.has(i)) return avaCache.get(i);
    const bg = AVA_BG[i % AVA_BG.length];
    const skin = SKIN[(i * 7 + 3) % SKIN.length];
    const hair = HAIR[(i * 5 + 1) % HAIR.length];
    const shirt = SHIRT[(i * 3 + 2) % SHIRT.length];
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'>" +
      "<defs><linearGradient id='b' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='" + bg[0] + "'/><stop offset='1' stop-color='" + bg[1] + "'/></linearGradient>" +
      "<radialGradient id='f' cx='.4' cy='.35' r='.7'><stop offset='0' stop-color='#fff' stop-opacity='.25'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient></defs>" +
      "<rect width='40' height='40' fill='url(#b)'/>" +
      "<path d='M4 40c1.6-8 8-12.4 16-12.4S34.4 32 36 40z' fill='" + shirt + "'/>" +
      "<path d='M16.6 24h6.8v5.4c-1 1.4-2.2 2-3.4 2s-2.4-.6-3.4-2z' fill='" + skin + "'/>" +
      "<ellipse cx='20' cy='17.6' rx='8.2' ry='9.2' fill='" + skin + "'/>" +
      "<ellipse cx='20' cy='17.6' rx='8.2' ry='9.2' fill='url(#f)'/>" +
      "<path d='" + HAIRDO[i % HAIRDO.length] + "' fill='" + hair + "'/>" +
      "<circle cx='16.8' cy='18.4' r='1' fill='#2a1d14'/><circle cx='23.2' cy='18.4' r='1' fill='#2a1d14'/>" +
      "<path d='M17.6 22.4c1.4 1.1 3.4 1.1 4.8 0' fill='none' stroke='#7a3b2a' stroke-width='1' stroke-linecap='round'/></svg>";
    const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    avaCache.set(i, url);
    return url;
  }
  const avaImg = (i) => '<img src="' + avatar(i) + '" alt="" width="26" height="26">';
  /* the purple one until the server says which is the player's */
  let myAvatar = store.get("avatar", 0);
  function paintMe() {
    $("srMeAva").src = avatar(myAvatar);
    $("srMenuAva").src = avatar(myAvatar);
  }

  /* ---------------- money: free credits, or the wallet run by the server ---------------- */
  const params = new URLSearchParams(location.search);
  const session = U.session.get();
  const signedIn = !!session;
  let mode = signedIn && params.get("mode") === "real" ? "real" : "fun";
  const real = () => mode === "real";
  let fun = FUN_CREDITS;
  const balance = () => (real() ? U.wallet.balance() : fun);
  function move(delta) {
    fun = round2(fun + delta);
    paintBalance();
  }
  function setRealBalance(b) {
    if (typeof b === "number" && isFinite(b)) U.wallet.setBalance(b);
    paintBalance();
  }
  function paintBalance() {
    $("srBalance").textContent = money(balance());
    $("srTopUp").hidden = real();
    document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  }
  if (!signedIn) $("srModes").hidden = true;

  /* ---------------- the server's clock ---------------- */
  let offset = 0;           // server time − Date.now()
  let bestRtt = Infinity;
  let synced = false;
  const sNow = () => Date.now() + offset;
  async function call(path, opts) {
    const t0 = Date.now();
    const r = await U.paymentApi(API + path, Object.assign({ timeout: 15000 }, opts || {}));
    const t1 = Date.now();
    const rtt = t1 - t0;
    /* a quick answer pins the clock; a held one (the wait request) says nothing about it */
    if (r.ok && r.data && typeof r.data.server_now === "number" && rtt < 3000 && (!synced || rtt <= bestRtt + 40)) {
      offset = r.data.server_now - (t0 + t1) / 2;
      bestRtt = Math.min(bestRtt, rtt);
      synced = true;
    }
    return r;
  }
  const errorText = (r) => (r && r.data && (r.data.message || r.data.error)) || "Couldn't reach the game server. Try again.";

  /* ---------------- the round ---------------- */
  /* phase: loading → betting (until take-off) → flying (until the server says it's over) → flown ("FLEW AWAY!")
     → betting on the next round … */
  let phase = "loading";
  let round = null;         // { no, hash, starts_at, crash?, seed? }
  let nextRound = null;     // the round after a crash, while "FLEW AWAY!" is up
  let flownAt = 0;          // Date.now() of the crash on this page
  let flownT = 0;           // seconds the flight lasted
  let shownX = 1;
  let history = [];
  let previous = null;      // { no, crash, list }
  let animate = store.get("anim", true) && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* the round taking bets right now, if any */
  const bettingRound = () => (phase === "betting" ? round : phase === "flown" ? nextRound : null);

  async function loadState() {
    for (let tries = 0; ; tries++) {
      const r = await call("state");
      if (r.ok) return r.data;
      if (tries === 1) setWaitTitle("CONNECTING…");
      await sleep(Math.min(5000, 800 * (tries + 1)));
    }
  }

  function setWaitTitle(t) {
    const el = $("srWaitTitle");
    if (el.textContent !== t) el.textContent = t;
  }

  async function start() {
    const d = await loadState();
    if (d.rules && d.rules.max_win) {
      MAX_WIN = d.rules.max_win;
      document.querySelectorAll("[data-max-win]").forEach((el) => (el.textContent = "GHS " + money(MAX_WIN)));
    }
    history = d.history || [];
    renderHistory(false);
    enterRound(d.round);
    if (real()) await restoreMine(d.round.no);
  }

  function enterRound(r) {
    round = { no: r.no, hash: r.hash, starts_at: r.starts_at };
    nextRound = null;
    phase = sNow() >= r.starts_at ? "flying" : "betting";
    shownX = 1;
    paintedPhase = "";
    $("srFairHash").textContent = r.hash;
    if (phase === "flying") takeOff(false);
    else openBetting();
    listRound = r.no;
    refreshBets(true);
  }

  /* betting opens on `round`: bets made mid-flight go on now, and auto bets place themselves */
  function openBetting() {
    panels.forEach((p) => {
      if (p.status === "queued") {
        p.status = "pending";
        p.bet.roundNo = round.no;
        if (real()) sendBet(p);
      } else if (p.status === "idle" && p.autoBet) placeBet(p, true);
    });
    panelsDirty = listDirty = true;
    announce("Place your bets. The plane takes off in " + Math.max(0, Math.round((round.starts_at - sNow()) / 1000)) + " seconds.");
  }

  function takeOff(sound) {
    phase = "flying";
    panels.forEach((p) => {
      if (p.status === "pending" && p.bet.roundNo === round.no && (!real() || p.bet.id)) p.status = "active";
    });
    panelsDirty = listDirty = true;
    if (sound) sfx.takeoff();
    watch(round.no);
    announce("The plane has taken off.");
  }

  /* the wait request: answered when the plane flies away (or after 25 s, when it's asked again) */
  let watching = 0;
  async function watch(no) {
    if (watching === no) return;
    watching = no;
    let fails = 0;
    while (watching === no && round && round.no === no && phase === "flying") {
      const r = await call("round/" + no + "/wait", { timeout: 40000 });
      if (!round || round.no !== no || phase !== "flying") break;
      if (r.ok && r.data.round && r.data.round.over) {
        crashed(r.data.round, r.data.next);
        break;
      }
      if (!r.ok) {
        fails++;
        if (fails >= 3) setWaitTitle("RECONNECTING…");
        await sleep(Math.min(4000, 700 * fails));
      } else fails = 0;
    }
    if (watching === no) watching = 0;
  }

  function crashed(v, next) {
    round.crash = v.crash;
    round.seed = v.seed;
    flownT = flightMs(v.crash) / 1000;
    shownX = v.crash;
    phase = "flown";
    flownAt = Date.now();
    nextRound = next || null;
    history.unshift({ no: v.no, crash: v.crash });
    history.length = Math.min(history.length, 60);
    renderHistory(true);
    settleFun(v);
    if (real()) settleMine(v.no);
    previous = { no: v.no, crash: v.crash, list: lastList && lastList.no === v.no ? lastList : null };
    fetchPrevious(v.no);
    if (nextRound) {
      $("srFairHash").textContent = nextRound.hash;
      openBettingOn(nextRound);
    }
    sfx.crash();
    panelsDirty = listDirty = true;
    announce("Flew away at " + xText(v.crash) + ".");
  }

  /* while "FLEW AWAY!" is up the next round already takes bets */
  function openBettingOn(r) {
    panels.forEach((p) => {
      if (p.status === "queued") {
        p.status = "pending";
        p.bet.roundNo = r.no;
        if (real()) sendBet(p);
      } else if (p.status === "idle" && p.autoBet) placeBet(p, true);
    });
  }

  /* runs every frame */
  function advance() {
    const now = sNow();
    if (phase === "betting" && now >= round.starts_at) takeOff(true);
    if (phase === "flying") {
      shownX = multiplierAt(now - round.starts_at);
      autoUpTo(shownX);
      if (Math.floor(shownX) !== lastClimb) {
        lastClimb = Math.floor(shownX);
        sfx.climb(shownX);
      }
    }
    if (phase === "flown" && Date.now() - flownAt >= FLEW_MS) {
      if (nextRound && sNow() - nextRound.starts_at > 4000) {
        catchUp(); /* this page fell behind (a hidden tab): jump to the round in play */
      } else if (nextRound) {
        const r = nextRound;
        round = { no: r.no, hash: r.hash, starts_at: r.starts_at };
        nextRound = null;
        phase = sNow() >= r.starts_at ? "flying" : "betting";
        shownX = 1;
        listRound = r.no;
        lastList = null;
        refreshBets(true);
        /* auto bets whose last bet was only settled after the crash join now */
        if (phase === "betting") panels.forEach((p) => { if (p.status === "idle" && p.autoBet) placeBet(p, true); });
        if (phase === "flying") takeOff(true);
        panelsDirty = listDirty = true;
      } else if (Date.now() - flownAt >= FLEW_MS + 4000) {
        /* the answer had no next round (it couldn't be opened just then): ask for the state */
        resync();
      }
    }
  }
  let lastClimb = 1;

  /* back from another app or tab: straight to the round in play; bets left on rounds that ended meanwhile are
     settled from the server's answer */
  let catching = false;
  async function catchUp() {
    if (catching) return;
    catching = true;
    if (phase === "flown") flownAt = Date.now() - FLEW_MS;
    const d = await loadState();
    catching = false;
    history = d.history || history;
    renderHistory(false);
    const stale = panels.filter((p) => p.bet && p.bet.roundNo && p.bet.roundNo < d.round.no);
    enterRound(d.round);
    stale.forEach(resolveOld);
  }

  async function resolveOld(p) {
    const b = p.bet;
    if (real()) {
      if (b.id) settleMine(b.roundNo);
      return;
    }
    const r = await call("round/" + b.roundNo);
    if (!r.ok || !r.data.over || p.bet !== b) return;
    /* the bet rode that round while the page was away: its auto cash-out paid if the plane got there */
    if (b.autoX <= r.data.crash) {
      cashOutFun(p, b.autoX);
      funCashed = funCashed.filter((c) => c.bet !== b);
    } else {
      p.status = "idle";
      p.bet = null;
      panelsDirty = listDirty = true;
    }
  }

  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 5000 && round) catchUp();
  });

  let resyncing = false;
  async function resync() {
    if (resyncing) return;
    resyncing = true;
    flownAt = Date.now() - FLEW_MS; /* keep the waiting screen up meanwhile */
    const d = await loadState();
    resyncing = false;
    if (phase !== "flown") return;
    history = d.history || history;
    renderHistory(false);
    nextRound = d.round;
    openBettingOn(d.round);
  }

  /* ---------------- bets ---------------- */
  /* status: idle → pending (on the round taking bets) or queued (made mid-flight, for the next round)
     → active (in the air) → idle again once cashed out or lost */
  const panels = [0, 1].map((i) => ({
    i, amount: store.get("amount" + i, 1), tab: "bet", autoBet: false, autoCash: false, target: store.get("target" + i, 2),
    status: "idle", bet: null, el: null
  }));
  let showSecond = store.get("second", true);
  let panelsDirty = true;

  function placeBet(p, auto) {
    if (p.amount > balance()) {
      if (auto) p.autoBet = false;
      panelsDirty = true;
      U.toast(real() && U.moneyInDollars && U.moneyInDollars() > 0
        ? "Your money is in US dollars — switch to cedis from the balance menu at the top to play."
        : real() ? "Not enough in your wallet — please deposit from the wallet." : "Not enough credits — top up from the menu.", "err");
      return;
    }
    const open = bettingRound();
    p.bet = { stake: p.amount, auto: !!auto, autoX: p.autoCash ? Math.min(p.target, capOf(p.amount)) : capOf(p.amount),
      roundNo: open ? open.no : 0, x: 0, win: 0 };
    p.status = open ? "pending" : "queued";
    if (real()) {
      if (open) sendBet(p);
    } else move(-p.amount);
    sfx.bet();
    panelsDirty = listDirty = true;
  }

  function cancelBet(p) {
    if (real()) return cancelReal(p);
    move(p.bet.stake);
    p.status = "idle";
    p.bet = null;
    panelsDirty = listDirty = true;
  }

  /* free credits: a cash-out is judged here and checked against the crash when it comes */
  function cashOutFun(p, x) {
    const b = p.bet;
    b.x = x;
    b.win = floor2(b.stake * x);
    b.manual = x !== b.autoX;
    move(b.win);
    funCashed.push({ roundNo: b.roundNo, bet: b, panel: p });
    showWin(p, x, b.win);
  }
  let funCashed = [];

  function settleFun(v) {
    if (real()) return;
    /* a tap that landed after the crash (the news takes a moment to arrive) doesn't count */
    funCashed.forEach((c) => {
      if (c.roundNo !== v.no) return;
      const late = c.bet.manual ? c.bet.x >= v.crash : c.bet.x > v.crash;
      if (late) {
        move(-c.bet.win);
        c.bet.x = 0;
        c.bet.win = 0;
        U.toast("Too late — it flew away at " + xText(v.crash) + ".", "err");
      }
    });
    funCashed = funCashed.filter((c) => c.roundNo > v.no);
    panels.forEach((p) => {
      if (p.status === "active" && p.bet.roundNo === v.no) {
        p.status = "idle";
        p.bet = null;
      }
    });
  }

  /* passes every auto cash-out the multiplier has reached */
  function autoUpTo(x) {
    panels.forEach((p) => {
      if (p.status !== "active") return;
      if (real()) {
        if (p.bet.autoX && p.bet.autoX <= x) askAuto(p);
      } else if (p.bet.autoX <= x) cashOutFun(p, p.bet.autoX);
    });
  }

  function showWin(p, x, win) {
    p.status = "idle";
    p.bet = null;
    panelsDirty = listDirty = true;
    p.el.classList.remove("won");
    void p.el.offsetWidth;
    p.el.classList.add("won");
    sfx.cashout();
    const msg = "You cashed out at " + xText(x) + " and won " + money(win) + " GHS";
    U.toast(msg, "ok");
    announce(msg);
  }

  function press(p) {
    advance();
    if (p.bet && p.bet.sending) return;
    if (p.status === "active") {
      if (real()) cashOutReal(p);
      else if (phase === "flying") cashOutFun(p, shownX);
    } else if (p.status === "idle") placeBet(p, false);
    else cancelBet(p);
    paintPanel(p);
  }

  /* ---------------- real money ---------------- */
  async function sendBet(p) {
    const b = p.bet;
    b.key = b.key || "sky:" + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    b.sending = true;
    panelsDirty = true;
    let r;
    for (let tries = 0; tries < 3; tries++) {
      r = await call("bet", { body: { round_no: b.roundNo, panel: p.i, stake: b.stake, auto: p.autoCash ? p.target : null, idempotency_key: b.key } });
      if (r.status !== 0) break; /* only a lost connection is tried again, with the same key */
      await sleep(700);
    }
    b.sending = false;
    panelsDirty = listDirty = true;
    if (p.bet !== b) return;
    if (r.ok) {
      b.id = r.data.bet.bet_id;
      b.autoX = r.data.bet.auto_x;
      setRealBalance(r.data.balance);
      const open = bettingRound();
      if (phase === "flying" && round.no === b.roundNo && p.status === "pending") p.status = "active";
      else if (!(open && open.no === b.roundNo) && !(phase === "flying" && round.no === b.roundNo)) settleMine(b.roundNo);
      refreshBets(true);
      return;
    }
    if (r.data && r.data.error === "too_late") {
      b.key = null; /* the plane took off before the bet arrived: it goes on the next round */
      p.status = "queued";
      const open = bettingRound();
      if (open && open.no !== b.roundNo) {
        b.roundNo = open.no;
        p.status = "pending";
        sendBet(p);
      }
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
    if (p.status === "queued" || !b.id) {
      if (b.sending) return;
      p.status = "idle";
      p.bet = null;
      panelsDirty = listDirty = true;
      return;
    }
    b.sending = true;
    panelsDirty = true;
    const r = await call("cancel", { body: { bet_id: b.id } });
    b.sending = false;
    panelsDirty = listDirty = true;
    if (!r.ok || r.data.bet.status !== "CANCELLED") {
      U.toast(errorText(r), "err");
      return;
    }
    if (p.bet === b) {
      p.status = "idle";
      p.bet = null;
    }
    setRealBalance(r.data.balance);
    refreshBets(true);
  }

  async function cashOutReal(p) {
    const b = p.bet;
    if (!b.id) return;
    b.sending = true;
    panelsDirty = true;
    const r = await call("cashout", { body: { bet_id: b.id } });
    b.sending = false;
    panelsDirty = true;
    if (!r.ok) {
      U.toast(errorText(r), "err");
      return;
    }
    if (r.data.bet.status === "LOST" && r.data.crash) U.toast("Too late — it flew away at " + xText(r.data.crash) + ".", "err");
    settleReal(p, r.data.bet, r.data.balance);
  }

  /* the multiplier on screen has passed this bet's auto cash-out: ask the server whether it's come in */
  async function askAuto(p) {
    const b = p.bet;
    if (!b.id || b.sending || b.askAt > performance.now()) return;
    b.sending = true;
    const r = await call("cashout", { body: { bet_id: b.id, auto: true } });
    b.sending = false;
    if (r.ok) settleReal(p, r.data.bet, r.data.balance);
    if (p.bet === b) b.askAt = performance.now() + 400;
  }

  function settleReal(p, v, bal) {
    const b = p.bet;
    if (!b || b.id !== v.bet_id) return;
    setRealBalance(bal);
    if (v.status === "WON") showWin(p, v.x, v.payout);
    else if (v.status === "LOST" || v.status === "CANCELLED") {
      p.status = "idle";
      p.bet = null;
      panelsDirty = listDirty = true;
    }
  }

  /* after a crash: every bet of mine in that round, settled, and the balance */
  async function settleMine(no) {
    for (let tries = 0; tries < 4; tries++) {
      const r = await call("mine/" + no);
      if (r.ok) {
        r.data.bets.forEach((v) => {
          const p = panels.find((q) => q.bet && q.bet.id === v.bet_id);
          if (p) settleReal(p, v, r.data.balance);
        });
        if (typeof r.data.avatar === "number") setMyAvatar(r.data.avatar);
        setRealBalance(r.data.balance);
        return;
      }
      if (r.status === 401) return;
      await sleep(800 * (tries + 1));
    }
    U.refreshBalance().then(paintBalance);
  }

  /* after a reload: bets already on the server for the round on screen */
  async function restoreMine(no) {
    const r = await call("mine/" + no);
    if (!r.ok) {
      if (r.status === 401) U.toast("Your session has ended. Sign in again to play for real money.", "err");
      return;
    }
    if (typeof r.data.avatar === "number") setMyAvatar(r.data.avatar);
    setRealBalance(r.data.balance);
    r.data.bets.forEach((v) => {
      const p = panels[v.panel];
      if (!p || v.status !== "ACTIVE" || p.status !== "idle") return;
      p.bet = { stake: v.stake, id: v.bet_id, autoX: v.auto_x, roundNo: v.round_no, x: 0, win: 0, key: "restored" };
      p.status = phase === "flying" && v.round_no === round.no ? "active" : "pending";
    });
    panelsDirty = listDirty = true;
  }

  function setMyAvatar(i) {
    if (myAvatar === i) return;
    myAvatar = i;
    store.set("avatar", i);
    paintMe();
  }

  /* ---------------- panels ---------------- */
  const clampAmount = (v) => Math.min(MAX_BET, Math.max(MIN_BET, round2(v)));
  const clampTarget = (v) => Math.min(MAX_CRASH, Math.max(1.01, round2(v)));
  const parse = (s) => Number(String(s).replace(/[^\d.]/g, ""));
  const ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M8.5 12h7"/></svg>';
  const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="M8.5 12h7M12 8.5v7"/></svg>';

  function buildPanel(p) {
    const el = document.createElement("section");
    el.className = "sr-panel";
    el.setAttribute("aria-label", "Bet " + (p.i + 1));
    el.innerHTML =
      '<div class="sr-panel-top">' +
      '<div class="sr-switch"><button type="button" data-tab="bet">Bet</button><button type="button" data-tab="auto">Auto</button></div>' +
      '<button type="button" class="sr-pm" data-pm></button></div>' +
      '<div class="sr-body"><div class="sr-amount">' +
      '<div class="sr-stepper">' +
      '<button type="button" class="sr-step" data-step="-1" aria-label="Lower bet ' + (p.i + 1) + '"><svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg></button>' +
      '<input class="sr-input" type="text" inputmode="decimal" autocomplete="off" aria-label="Bet ' + (p.i + 1) + ' amount in GHS" data-amount>' +
      '<button type="button" class="sr-step" data-step="1" aria-label="Raise bet ' + (p.i + 1) + '"><svg viewBox="0 0 24 24"><path d="M6 12h12M12 6v12"/></svg></button></div>' +
      '<div class="sr-quick">' + QUICK.map((v) => '<button type="button" data-quick="' + v + '">' + v + "</button>").join("") + "</div></div>" +
      '<div class="sr-cta-wrap"><div class="sr-cta-note"></div>' +
      '<button class="sr-cta" type="button" data-cta><span class="sr-cta-label">Bet</span><span class="sr-cta-amount"></span></button></div></div>' +
      '<div class="sr-auto" hidden>' +
      '<div class="sr-auto-item"><label><input type="checkbox" class="sr-toggle" data-auto-bet>Auto bet</label></div>' +
      '<div class="sr-auto-item"><label><input type="checkbox" class="sr-toggle" data-auto-cash>Auto cash out</label>' +
      '<span class="sr-target"><input type="text" inputmode="decimal" autocomplete="off" aria-label="Auto cash out multiplier for bet ' + (p.i + 1) + '" data-target><span aria-hidden="true">x</span></span></div></div>';
    p.el = el;
    const amountInput = el.querySelector("[data-amount]");
    const targetInput = el.querySelector("[data-target]");
    const setAmount = (v) => {
      p.amount = clampAmount(v);
      store.set("amount" + p.i, p.amount);
      panelsDirty = true;
      paintPanel(p);
    };
    el.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-tab]");
      const step = e.target.closest("[data-step]");
      const quick = e.target.closest("[data-quick]");
      if (tab) {
        p.tab = tab.dataset.tab;
        /* leaving Auto switches automation off, so nothing keeps betting out of sight */
        if (p.tab === "bet") p.autoBet = p.autoCash = false;
        paintPanel(p);
      } else if (step) setAmount(p.amount + Number(step.dataset.step));
      else if (quick) setAmount(Number(quick.dataset.quick));
      else if (e.target.closest("[data-pm]")) {
        if (p.i === 1) {
          if (p.status !== "idle") {
            U.toast("Cash out or cancel this bet first.", "err");
            return;
          }
          p.autoBet = false;
          showSecond = false;
        } else showSecond = true;
        store.set("second", showSecond);
        layoutPanels();
      } else if (e.target.closest("[data-cta]")) press(p);
    });
    amountInput.addEventListener("change", () => setAmount(parse(amountInput.value) || MIN_BET));
    amountInput.addEventListener("focus", () => amountInput.select());
    targetInput.addEventListener("change", () => {
      p.target = clampTarget(parse(targetInput.value) || 2);
      store.set("target" + p.i, p.target);
      paintPanel(p);
    });
    [amountInput, targetInput].forEach((input) => input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (["-", "+", "e", "E"].includes(e.key)) e.preventDefault();
    }));
    el.querySelector("[data-auto-bet]").addEventListener("change", (e) => {
      p.autoBet = e.target.checked;
      if (p.autoBet && p.status === "idle" && bettingRound()) placeBet(p, true);
      paintPanel(p);
    });
    el.querySelector("[data-auto-cash]").addEventListener("change", (e) => {
      p.autoCash = e.target.checked;
      paintPanel(p);
    });
    return el;
  }

  function layoutPanels() {
    panels[1].el.hidden = !showSecond;
    $("srPanels").classList.toggle("two", showSecond);
    const pm0 = panels[0].el.querySelector("[data-pm]");
    pm0.hidden = showSecond;
    pm0.innerHTML = ICON_PLUS;
    pm0.setAttribute("aria-label", "Add a second bet");
    const pm1 = panels[1].el.querySelector("[data-pm]");
    pm1.innerHTML = ICON_MINUS;
    pm1.setAttribute("aria-label", "Remove the second bet");
  }

  function paintPanel(p) {
    const el = p.el;
    const busy = p.status !== "idle";
    el.classList.toggle("armed", p.status === "pending" || p.status === "queued");
    el.classList.toggle("flying", p.status === "active");
    el.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === p.tab)));
    el.querySelector(".sr-auto").hidden = p.tab !== "auto";
    el.querySelectorAll("[data-step], [data-quick], [data-amount]").forEach((c) => (c.disabled = busy));
    /* a real bet takes its auto cash-out to the server with it, so it's fixed until the bet is over */
    el.querySelectorAll("[data-auto-cash], [data-target]").forEach((c) => (c.disabled = busy && (real() || p.status === "active")));
    const amountInput = el.querySelector("[data-amount]");
    const targetInput = el.querySelector("[data-target]");
    if (document.activeElement !== amountInput) amountInput.value = money(p.amount);
    if (document.activeElement !== targetInput) targetInput.value = p.target.toFixed(2);
    el.querySelector("[data-auto-bet]").checked = p.autoBet;
    el.querySelector("[data-auto-cash]").checked = p.autoCash;

    const cta = el.querySelector("[data-cta]");
    cta.disabled = !!(p.bet && p.bet.sending);
    cta.className = "sr-cta" + (p.status === "active" ? " cash" : busy ? " cancel" : "");
    el.querySelector(".sr-cta-note").textContent = p.status === "queued" ? "Waiting for next round" : "";
    el.querySelector(".sr-cta-label").textContent = p.status === "active" ? "Cash Out" : busy ? "Cancel" : "Bet";
    el.querySelector(".sr-cta-amount").innerHTML =
      p.status === "active" ? money(floor2(p.bet.stake * shownX)) + " <small>GHS</small>"
      : busy ? "" : money(p.amount) + " <small>GHS</small>";
  }

  /* ---------------- bets list ---------------- */
  let listTab = "all";
  let listDirty = true;
  let listRound = 0;
  let lastList = null;     // the server's latest list for listRound
  let board = "wins";
  let period = "day";
  const topCache = new Map();

  let fetchingBets = false;
  let betsAt = 0;
  async function refreshBets(force) {
    if (fetchingBets || !listRound) return;
    if (!force && Date.now() - betsAt < 1500) return;
    fetchingBets = true;
    betsAt = Date.now();
    const no = listRound;
    const r = await call("bets/" + no);
    fetchingBets = false;
    if (r.ok && no === listRound) {
      lastList = r.data;
      listDirty = true;
    }
  }

  async function fetchPrevious(no) {
    await sleep(600); /* the round settles first */
    const r = await call("bets/" + no);
    if (r.ok && previous && previous.no === no) {
      previous.list = r.data;
      if (listTab === "previous") listDirty = true;
    }
  }

  function myRows() {
    if (real()) return [];
    return panels.filter((p) => p.bet && (p.status === "pending" || p.status === "active") && p.bet.roundNo === listRound)
      .map((p) => ({ user: "You", avatar: myAvatar, stake: p.bet.stake, x: null, win: 0, mine: true }))
      .concat(funCashed.filter((c) => c.roundNo === listRound && c.bet.win > 0)
        .map((c) => ({ user: "You", avatar: myAvatar, stake: c.bet.stake, x: c.bet.x, win: c.bet.win, mine: true })));
  }

  function rowHtml(b) {
    return '<div class="sr-row' + (b.x ? " won" : "") + (b.mine ? " mine" : "") + '">' +
      '<span class="sr-user">' + avaImg(b.avatar) + '<span class="sr-name">' + esc(b.user) + "</span></span>" +
      '<span class="sr-num">' + money(b.stake) + "</span>" +
      '<span class="sr-xc">' + (b.x ? '<span class="sr-xpill ' + xClass(b.x) + '">' + xText(b.x) + "</span>" : "") + "</span>" +
      '<span class="sr-num">' + (b.x ? money(b.win) : "") + "</span></div>";
  }

  function paintSummary(view, extra) {
    const v = view || { count: 0, cashed: 0, total_win: 0, avatars: [] };
    $("srSumCashed").textContent = count(v.cashed);
    $("srSumCount").textContent = count(v.count);
    $("srSumWin").textContent = money(v.total_win);
    $("srSumBar").style.width = (v.count ? Math.min(100, (v.cashed / v.count) * 100) : 0).toFixed(1) + "%";
    $("srSumAvas").innerHTML = (v.avatars || []).map((a) => '<img src="' + avatar(a) + '" alt="">').join("");
    $("srSum").hidden = !!extra;
  }

  function renderList() {
    const list = $("srList");
    const cols = $("srCols");
    $("srTopTabs").hidden = listTab !== "top";
    $("srPrev").hidden = listTab !== "previous";
    if (listTab === "all") {
      cols.hidden = false;
      paintSummary(lastList);
      const rows = myRows().concat(lastList ? lastList.bets : []);
      list.innerHTML = rows.length ? rows.map(rowHtml).join("")
        : '<p class="sr-empty">No bets in this round yet.</p>';
    } else if (listTab === "previous") {
      cols.hidden = false;
      paintSummary(previous && previous.list);
      $("srPrev").innerHTML = previous
        ? "Round result <span class=\"sr-xpill " + xClass(previous.crash) + "\">" + xText(previous.crash) + "</span>"
        : "The last round's bets will show here.";
      const rows = previous && previous.list ? previous.list.bets : [];
      list.innerHTML = rows.length ? rows.map(rowHtml).join("") : '<p class="sr-empty">' + (previous ? "Nobody bet in the last round." : "") + "</p>";
    } else {
      cols.hidden = true;
      $("srSum").hidden = true;
      renderTop();
    }
    paintCrowd();
  }

  function paintCrowd() {
    const v = lastList;
    const n = v ? v.players : 0;
    $("srCrowd").hidden = !n;
    if (n) {
      $("srCrowdCount").textContent = count(n);
      $("srCrowdAvas").innerHTML = (v.avatars || []).map((a) => '<img src="' + avatar(a) + '" alt="">').join("");
    }
  }

  async function renderTop() {
    const k = board + ":" + period;
    const hit = topCache.get(k);
    const list = $("srList");
    if (!hit || Date.now() - hit.at > 30000) {
      if (!hit) list.innerHTML = '<p class="sr-empty">Loading…</p>';
      const r = await call("top?by=" + board + "&period=" + period);
      if (!r.ok) {
        list.innerHTML = '<p class="sr-empty">' + esc(errorText(r)) + "</p>";
        return;
      }
      topCache.set(k, { at: Date.now(), data: r.data });
      if (listTab !== "top" || board + ":" + period !== k) return;
    }
    const d = topCache.get(k).data;
    const when = (ms) => new Date(ms).toLocaleDateString("en-GH", { day: "numeric", month: "short" });
    if (d.rounds) {
      list.innerHTML = d.rounds.length ? d.rounds.map((r) =>
        '<button type="button" class="sr-roundcard" data-round="' + r.no + '"><span>Round ' + count(r.no) + " · " + when(r.at) + "</span>" +
        '<b class="' + xClass(r.crash) + '" style="color:var(--sr-' + (r.crash < 2 ? "blue" : r.crash < 10 ? "purple" : "pink") + ')">' + xText(r.crash) + "</b></button>").join("")
        : '<p class="sr-empty">No rounds yet in this period.</p>';
      return;
    }
    list.innerHTML = d.wins && d.wins.length ? d.wins.map((w) =>
      '<div class="sr-topcard"><img src="' + avatar(w.avatar) + '" alt="">' +
      '<span class="t-name">' + esc(w.user) + "</span>" +
      '<span class="t-right"><span class="t-win">' + money(w.win) + ' GHS</span><br><span class="t-x" style="color:var(--sr-' +
      (w.x < 2 ? "blue" : w.x < 10 ? "purple" : "pink") + ')">' + xText(w.x) + "</span></span>" +
      '<span class="t-sub">Bet ' + money(w.stake) + " · round " + xText(w.round_crash) + " · " + when(w.at) + "</span></div>").join("")
      : '<p class="sr-empty">No wins yet in this period.</p>';
  }

  document.querySelector(".sr-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-list]");
    if (!b) return;
    listTab = b.dataset.list;
    document.querySelectorAll("[data-list]").forEach((t) => t.setAttribute("aria-selected", String(t === b)));
    listDirty = true;
  });
  $("srTopTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-board]");
    const per = e.target.closest("[data-period]");
    if (b) board = b.dataset.board;
    if (per) period = per.dataset.period;
    if (!b && !per) return;
    document.querySelectorAll("[data-board]").forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.board === board)));
    document.querySelectorAll("[data-period]").forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.period === period)));
    listDirty = true;
  });
  $("srList").addEventListener("click", (e) => {
    const r = e.target.closest("[data-round]");
    if (r) openRound(Number(r.dataset.round));
  });

  /* ---------------- history strip and round checks ---------------- */
  function hxHtml(h, fresh) {
    return '<button type="button" class="sr-hx ' + xClass(h.crash) + (fresh ? " new" : "") + '" data-round="' + h.no + '" aria-label="Round ' +
      h.no + ": " + xText(h.crash) + '">' + xText(h.crash) + "</button>";
  }
  function renderHistory(fresh) {
    $("srHistory").innerHTML = history.slice(0, 30).map((h, i) => hxHtml(h, fresh && i === 0)).join("");
    $("srHistoryGrid").innerHTML = history.map((h) => hxHtml(h, false)).join("");
  }
  [$("srHistory"), $("srHistoryGrid")].forEach((el) => el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-round]");
    if (b) openRound(Number(b.dataset.round));
  }));
  $("srHistoryMore").addEventListener("click", () => {
    const all = $("srHistoryAll");
    all.hidden = !all.hidden;
    $("srHistoryMore").setAttribute("aria-expanded", String(!all.hidden));
  });
  $("srHistoryClose").addEventListener("click", () => {
    $("srHistoryAll").hidden = true;
    $("srHistoryMore").setAttribute("aria-expanded", "false");
  });

  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  async function checkRound(v) {
    const enc = new TextEncoder();
    const digest = hex(await crypto.subtle.digest("SHA-256", enc.encode(v.seed)));
    const key = await crypto.subtle.importKey("raw", enc.encode(v.seed), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const h = hex(await crypto.subtle.sign("HMAC", key, enc.encode("sky-rush:" + v.no)));
    const u = parseInt(h.slice(0, 13), 16) / Math.pow(2, 52);
    const x = Math.min(MAX_CRASH, Math.max(1, Math.floor(97 / (1 - u)) / 100));
    return { hashOk: digest === v.hash, x, crashOk: x === v.crash };
  }

  async function openRound(no) {
    const dlg = $("srRound");
    $("srRoundTitle").textContent = "Round " + count(no);
    $("srRoundX").textContent = "";
    $("srRoundHash").textContent = "…";
    $("srRoundSeed").textContent = "…";
    const check = $("srRoundCheck");
    check.className = "sr-round-check";
    check.textContent = "Checking…";
    if (!dlg.open) dlg.showModal();
    const r = await call("round/" + no);
    if (!r.ok) {
      check.textContent = errorText(r);
      return;
    }
    const v = r.data;
    $("srRoundHash").textContent = v.hash;
    if (!v.over) {
      $("srRoundSeed").textContent = "Shown once the plane has flown away.";
      check.textContent = "This round hasn't finished yet.";
      return;
    }
    $("srRoundX").textContent = xText(v.crash);
    $("srRoundX").className = "sr-round-x " + xClass(v.crash);
    $("srRoundSeed").textContent = v.seed;
    if (!(window.crypto && crypto.subtle)) {
      check.textContent = "This browser can't check it here — any SHA-256 / HMAC tool can, with the seed above.";
      return;
    }
    try {
      const c = await checkRound(v);
      const ok = c.hashOk && c.crashOk;
      check.className = "sr-round-check " + (ok ? "ok" : "bad");
      check.textContent = ok
        ? "✓ Checked in your browser: the seed matches the fingerprint and gives " + xText(c.x) + "."
        : "✗ This round doesn't check out (" + (c.hashOk ? "the seed gives " + xText(c.x) : "the seed doesn't match the fingerprint") + ").";
    } catch (e) {
      check.textContent = "This browser couldn't run the check.";
    }
  }

  /* ---------------- stage ---------------- */
  const stage = $("srStage");
  const mult = $("srMult");
  let paintedPhase = "";
  function paintStage() {
    const view = phase === "loading" || phase === "betting" || (phase === "flown" && Date.now() - flownAt >= FLEW_MS) ? "wait"
      : phase === "flown" ? "flown" : "fly";
    if (paintedPhase !== view) {
      paintedPhase = view;
      stage.classList.toggle("crashed", view === "flown");
      $("srWait").hidden = view !== "wait";
      $("srFlew").hidden = view !== "flown";
      mult.hidden = view === "wait";
      if (view === "wait" && phase !== "loading") setWaitTitle("WAITING FOR NEXT ROUND");
    }
    if (view === "wait") {
      const r = phase === "flown" ? nextRound : phase === "betting" ? round : null;
      const left = r ? Math.max(0, r.starts_at - sNow()) : 0;
      const span = 5000;
      $("srWaitBar").style.transform = "scaleX(" + (r ? Math.min(1, left / span) : 0).toFixed(3) + ")";
    } else {
      const text = xText(shownX);
      if (mult.textContent !== text) mult.textContent = text;
    }
  }

  /* ---------------- canvas: turning rays, glow, the red curve and the plane ---------------- */
  const canvas = $("srCanvas");
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

  /* The supplied aircraft artwork is rasterised once at 4× into an offscreen canvas. Its live propeller is attached
     to the hub in the supplied SVG, so the dimensions and pivot coordinates must match the asset exactly. */
  const ART_W = 240;
  const ART_H = 110;
  const TAIL = { x: 14, y: 47.5 };
  const HUB = { x: 208.5, y: 52 };
  let planeArt = null;
  const planeImg = new Image();
  planeImg.onload = () => {
    const art = document.createElement("canvas");
    art.width = ART_W * 4;
    art.height = ART_H * 4;
    art.getContext("2d").drawImage(planeImg, 0, 0, art.width, art.height);
    planeArt = art;
  };
  planeImg.src = "assets/img/sky-rush-plane.svg?v=2";

  /* a flat red two-blade propeller: as it turns, each blade's visible length swings */
  function drawPropeller(now) {
    const r = 34;
    const turn = animate ? now / 26 : 0.6;
    const hx = HUB.x + 1;
    ctx.lineCap = "round";
    [0, Math.PI].forEach((offset) => {
      const reach = Math.cos(turn + offset) * r;
      if (Math.abs(reach) < 6) return;
      ctx.beginPath();
      ctx.moveTo(hx, HUB.y + Math.sign(reach) * 4);
      ctx.lineTo(hx, HUB.y + reach);
      ctx.strokeStyle = "#8f0221";
      ctx.lineWidth = 8.6;
      ctx.stroke();
      ctx.strokeStyle = "#e50539";
      ctx.lineWidth = 5.2;
      ctx.stroke();
    });
    ctx.beginPath();
    ctx.arc(hx, HUB.y, 3.8, 0, Math.PI * 2);
    ctx.fillStyle = "#e50539";
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = "#8f0221";
    ctx.stroke();
  }

  function drawPlane(x, y, angle, size, now) {
    if (!planeArt) return;
    const s = size / ART_W;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(s, s);
    ctx.translate(-TAIL.x, -TAIL.y);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(planeArt, 0, 0, ART_W, ART_H);
    drawPropeller(now);
    ctx.restore();
  }

  const GLOWS = { blue: [22, 100, 164], purple: [124, 32, 176], pink: [184, 20, 150] };
  const glowFor = (x) => (x < 2 ? GLOWS.blue : x < 10 ? GLOWS.purple : GLOWS.pink);
  const glowRGB = GLOWS.blue.slice();

  function drawBackdrop(now, flying) {
    const ox = 0;
    const oy = H;
    const R = Math.hypot(W, H) * 1.2;
    const turn = animate ? (now / 1000) * (flying ? 0.08 : 0.035) : 0.2;
    const rays = 26;
    const step = (Math.PI * 2) / rays;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255, 255, 255, .07)";
    ctx.beginPath();
    for (let i = 0; i < rays; i++) {
      const a = -turn + i * step;
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + R * Math.cos(a), oy + R * Math.sin(a));
      ctx.lineTo(ox + R * Math.cos(a + step / 2), oy + R * Math.sin(a + step / 2));
      ctx.closePath();
    }
    ctx.fill();
    /* the glow behind the multiplier takes the multiplier's colour: blue under 2x, purple to 10x, pink beyond */
    const want = glowFor(phase === "flying" || phase === "flown" ? shownX : 1);
    for (let i = 0; i < 3; i++) glowRGB[i] += (want[i] - glowRGB[i]) * 0.06;
    const [r, g, b] = glowRGB.map((v) => Math.round(v));
    const gx = W * 0.56;
    const gy = H * 0.48;
    const gr = Math.max(W, H) * 0.52;
    const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    glow.addColorStop(0, "rgba(" + r + ", " + g + ", " + b + ", .68)");
    glow.addColorStop(0.45, "rgba(" + Math.round(r * 0.75) + ", " + Math.round(g * 0.7) + ", " + Math.round(b * 0.8) + ", .30)");
    glow.addColorStop(1, "rgba(" + Math.round(r * 0.5) + ", " + Math.round(g * 0.4) + ", " + Math.round(b * 0.55) + ", 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    /* darker toward the take-off corner, like a vignette */
    const vig = ctx.createRadialGradient(W * 0.5, H * 0.45, Math.min(W, H) * 0.3, W * 0.5, H * 0.5, Math.max(W, H) * 0.85);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(0,0,0,.55)");
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, W, H);
  }

  /* where the curve ends t seconds into the flight: up to a cruising spot, then drifting like the plane rides the wind */
  function tipAt(t, size) {
    const k = Math.min(1, t / CRUISE_S);
    const e = 1 - (1 - k) * (1 - k);
    const top = { x: W - size * 0.98 - 10, y: Math.max(size * 0.55, H * 0.24) };
    let x = top.x * e;
    let y = H - (H - top.y) * Math.pow(e, 1.5);
    if (k === 1 && animate) {
      const low = { x: Math.max(size * 0.6, W * 0.46), y: Math.min(H - size * 0.35, H * 0.6) };
      const s = 0.5 - 0.5 * Math.cos(((t - CRUISE_S) / 7) * Math.PI * 2);
      x = top.x + (low.x - top.x) * s;
      y = top.y + (low.y - top.y) * s;
    }
    return { x, y };
  }

  function draw(now) {
    const flying = phase === "flying";
    drawBackdrop(now, flying);
    const flown = phase === "flown" && Date.now() - flownAt < FLEW_MS;
    if (!flying && !flown) return;
    const size = Math.min(150, Math.max(78, W * 0.24));
    const t = flying ? Math.max(0, (sNow() - round.starts_at) / 1000) : flownT;
    const tip = tipAt(t, size);
    const cx = tip.x * 0.58;
    const cy = H;
    if (flying) {
      const fill = ctx.createLinearGradient(0, tip.y, 0, H);
      fill.addColorStop(0, "rgba(229, 5, 57, .62)");
      fill.addColorStop(1, "rgba(229, 5, 57, .42)");
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.quadraticCurveTo(cx, cy, tip.x, tip.y);
      ctx.lineTo(tip.x, H);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.quadraticCurveTo(cx, cy, tip.x, tip.y);
      ctx.strokeStyle = "#e50539";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.stroke();
    }
    let angle = Math.max(-0.32, Math.min(0.04, Math.atan2(tip.y - cy, tip.x - cx) * 0.6));
    let px = tip.x;
    let py = tip.y;
    if (!flying) {
      const k = Math.min(1, (Date.now() - flownAt) / 800);
      if (k >= 1) return;
      px += (W + size * 2 - tip.x) * k * k;
      py -= (tip.y + size * 2) * k * k;
      angle = -0.45;
    } else if (t >= CRUISE_S && animate) angle += Math.sin(now / 520) * 0.035;
    drawPlane(px, py - size * 0.06, angle, size, now);
  }

  /* ---------------- sound (Web Audio, starts after the first tap) ---------------- */
  let soundOn = store.get("sound", true);
  let actx = null;
  let master = null;
  let engine = null;
  function unlockAudio() {
    if (actx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = new AC();
    master = actx.createGain();
    master.gain.value = soundOn ? 0.8 : 0;
    master.connect(actx.destination);
  }
  document.addEventListener("pointerdown", unlockAudio, { once: true });
  function noise(dur) {
    const buf = actx.createBuffer(1, Math.ceil(actx.sampleRate * dur), actx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = actx.createBufferSource();
    src.buffer = buf;
    return src;
  }
  function tone(freq, start, dur, type, vol) {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(master);
    o.start(start);
    o.stop(start + dur + 0.05);
  }
  function stopEngine() {
    if (!engine) return;
    const t = actx.currentTime;
    engine.gain.gain.cancelScheduledValues(t);
    engine.gain.gain.setTargetAtTime(0, t, 0.08);
    engine.osc.stop(t + 0.5);
    engine.hum.stop(t + 0.5);
    engine = null;
  }
  const sfx = {
    bet() {
      if (!actx || !soundOn) return;
      tone(520, actx.currentTime, 0.08, "triangle", 0.16);
    },
    takeoff() {
      if (!actx || !soundOn) return;
      const t = actx.currentTime;
      const n = noise(1.3);
      const f = actx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.setValueAtTime(260, t);
      f.frequency.exponentialRampToValueAtTime(1800, t + 1.1);
      const g = actx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      n.connect(f).connect(g).connect(master);
      n.start(t);
      stopEngine();
      const osc = actx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 58;
      const hum = actx.createOscillator();
      hum.type = "sine";
      hum.frequency.value = 116;
      const lp = actx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 380;
      const eg = actx.createGain();
      eg.gain.setValueAtTime(0, t);
      eg.gain.linearRampToValueAtTime(0.05, t + 0.6);
      osc.connect(lp);
      hum.connect(lp);
      lp.connect(eg).connect(master);
      osc.start(t);
      hum.start(t);
      engine = { osc, hum, gain: eg };
    },
    climb(m) {
      if (!engine) return;
      const f = 58 + Math.min(1, Math.log10(m) / 2) * 70;
      engine.osc.frequency.setTargetAtTime(f, actx.currentTime, 0.3);
      engine.hum.frequency.setTargetAtTime(f * 2, actx.currentTime, 0.3);
    },
    cashout() {
      if (!actx || !soundOn) return;
      const t = actx.currentTime;
      tone(880, t, 0.18, "sine", 0.2);
      tone(1320, t + 0.09, 0.3, "sine", 0.18);
      tone(1760, t + 0.18, 0.4, "sine", 0.1);
    },
    crash() {
      if (!actx) return;
      stopEngine();
      if (!soundOn) return;
      const t = actx.currentTime;
      const n = noise(0.9);
      const f = actx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(1600, t);
      f.frequency.exponentialRampToValueAtTime(120, t + 0.8);
      const g = actx.createGain();
      g.gain.setValueAtTime(0.28, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      n.connect(f).connect(g).connect(master);
      n.start(t);
    }
  };

  /* ---------------- header and menu ---------------- */
  const menu = $("srMenu");
  const setMenu = (open) => {
    menu.hidden = !open;
    $("srMenuBtn").setAttribute("aria-expanded", String(open));
    $("srMe").setAttribute("aria-expanded", String(open));
  };
  $("srMenuBtn").addEventListener("click", () => setMenu(menu.hidden));
  $("srMe").addEventListener("click", () => setMenu(menu.hidden));
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !$("srMenuBtn").contains(e.target) && !$("srMe").contains(e.target)) setMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      setMenu(false);
      $("srMenuBtn").focus();
    }
  });
  menu.addEventListener("click", (e) => {
    const m = e.target.closest("[data-mode]");
    if (!m || m.dataset.mode === mode || (m.dataset.mode === "real" && !signedIn)) return;
    if (panels.some((p) => p.status !== "idle")) {
      U.toast("Cash out or cancel your bets before switching.", "err");
      return;
    }
    params.set("mode", m.dataset.mode);
    location.replace(location.pathname + "?" + params.toString());
  });
  document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => {
    setMenu(false);
    const d = $(b.dataset.open);
    if (d && !d.open) d.showModal();
  }));
  $("srTopUp").addEventListener("click", () => {
    fun = Math.max(fun, FUN_CREDITS);
    paintBalance();
    setMenu(false);
    U.toast("Credits topped up to " + money(fun) + " GHS", "ok");
  });
  $("srSound").checked = soundOn;
  $("srSound").addEventListener("change", (e) => {
    soundOn = e.target.checked;
    store.set("sound", soundOn);
    unlockAudio();
    if (master) master.gain.value = soundOn ? 0.8 : 0;
    if (!soundOn && actx) stopEngine();
  });
  $("srAnim").checked = animate;
  $("srAnim").addEventListener("change", (e) => {
    animate = e.target.checked;
    store.set("anim", animate);
    document.body.classList.toggle("still", !animate);
  });
  document.body.classList.toggle("still", !animate);
  $("srChat").addEventListener("click", () => U.openChat());
  window.addEventListener("storage", paintBalance);
  document.addEventListener("vb:balance", paintBalance);

  /* ---------------- frame loop ---------------- */
  function frame(now) {
    if (round) advance();
    paintStage();
    draw(now);
    if (listDirty) {
      listDirty = false;
      renderList();
    }
    if (panelsDirty) {
      panelsDirty = false;
      panels.forEach(paintPanel);
    } else if (phase === "flying") {
      panels.forEach((p) => {
        if (p.status === "active") p.el.querySelector(".sr-cta-amount").innerHTML = money(floor2(p.bet.stake * shownX)) + " <small>GHS</small>";
      });
    }
    if ((phase === "betting" || phase === "flying") && listTab === "all") refreshBets(false);
    requestAnimationFrame(frame);
  }

  $("srPanels").append(...panels.map(buildPanel));
  layoutPanels();
  paintMe();
  paintBalance();
  if (real()) {
    U.refreshBalance().then(() => {
      paintBalance();
      if (balance() < MIN_BET) U.toast("Your wallet is empty — deposit to play for real money.", "err");
    });
  }
  requestAnimationFrame(frame);
  start();
})();
