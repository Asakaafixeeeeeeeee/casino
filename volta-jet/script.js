/* Rendo Jet — a crash game, with free credits or real money.
   Rounds: 8 s "Place your bet" → the jet takes off and the multiplier climbs 0.001 every 1/60 s (0.06x a second) →
   it flies away at the crash point → the crash point joins the history strip → next pause.
   Odds: the jet passes x with chance 98% ÷ x, up to the 10.70x top, where every bet still flying is paid 10.70x.
   With free credits the page draws each crash point. With real money the server runs the player's rounds (backend
   games/flights.ts, the same odds): it draws the crash point, takes the bets, judges every cash-out on its own clock
   and pays it, and the page learns where a round ended only once it's over. */
(() => {
  "use strict";

  const START_CENTS = 300000; /* GHS 3,000 of free credits per session */
  const PAUSE_MS = 8000;    /* "Place your bet" window */
  const STEPS_PER_MS = 0.06; /* the multiplier climbs 0.001 a step: 60 steps a second */
  const RTP = 0.98;
  const TOP = 10.7;          /* the highest crash point */
  const LOST_SHOW_MS = 2000; /* a lost bet's button reads "Flew away" this long */
  const HISTORY_MAX = 30;

  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  const multEl = $("mult");
  const lastEl = $("last");
  const barEl = $("bar");
  const balanceEl = $("balance");
  const historyEl = $("history");
  const toastEl = $("toast");
  const betsEl = $("bets");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (location.pathname.includes("/volta-jet/")) {
    const back = $("back");
    back.hidden = false;
    /* replace, not push: leaving the game shouldn't leave a lobby entry on top of it that the browser Back
       button then returns to, trapping the player bouncing between the game and the lobby */
    back.addEventListener("click", (e) => {
      if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        location.replace(back.href);
      }
    });
  }

  /* ---------------- free credits or real money ---------------- */
  /* real money needs a signed-in player (the site's session, on this same origin) and ?mode=real from the lobby */
  const params = new URLSearchParams(location.search);
  const session = (() => {
    try {
      return JSON.parse(localStorage.getItem("voltabet.session") || "null");
    } catch {
      return null;
    }
  })();
  const real = !!(session && session.token) && params.get("mode") === "real";
  const API = window.VB_PAYMENT_API ||
    (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://localhost:8781" : "https://asakaa-balance.onrender.com");
  $("playTag").textContent = real ? "Real money" : "Free credits";
  $("playTag").title = real ? "Bets come from your RendoWin wallet" : "Every session starts with GHS 3,000 of free credits";
  $("playTag").classList.toggle("is-real", real);

  /* ---------------- state ---------------- */
  let balance = real ? 0 : START_CENTS;
  let phase = "WAITING";    /* WAITING (between rounds) | FLYING */
  let steps = 0;            /* multiplier = 1 + steps / 1000 */
  let crashSteps = 0;       /* the round ends on the frame steps reaches this */
  let crashPoint = 0;       /* this round's crash point, as received */
  /* two bet panels; each holds its own bet: { cents, live, lost, row } for the current or next round */
  const slots = [...document.querySelectorAll(".panel")].map((panel, i) => ({
    i,
    panel,
    input: panel.querySelector(".stake-input"),
    box: panel.querySelector(".stake-box"),
    btn: panel.querySelector(".main-btn"),
    title: panel.querySelector(".btn-title"),
    sub: panel.querySelector(".btn-sub"),
    bet: null
  }));
  let crashedAt = -Infinity;
  let pauseEnd = 0;
  let flightStart = 0;
  let nextOdds = null;      /* crash point for the next round, once fetched */
  let crashPos = null;      /* where the jet was when it flew away */

  const money = (cents) => (cents / 100).toFixed(2);
  const multOf = (s) => (1000 + s) / 1000;
  const tier = (m) => (m < 2 ? "low" : m < 10 ? "mid" : "high");

  /* ---------------- crash point ---------------- */
  /* free credits: P(the jet passes x) = 98% ÷ x, up to the top; draws under 1.01 end the round at take-off */
  function drawCrash() {
    const u = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32; /* uniform in [0, 1) */
    return Math.min(TOP, Math.max(1, Math.floor((100 * RTP) / (1 - u)) / 100));
  }
  const stepsTo = (x) => Math.round((x - 1) * 1000);

  function startPause(now) {
    phase = "WAITING";
    if (real) {
      pauseEnd = Infinity; /* until the server opens the next round */
      flightId = null;
      nextRound();
    } else {
      pauseEnd = now + PAUSE_MS;
      nextOdds = drawCrash();
    }
  }

  function takeOff(now) {
    phase = "FLYING";
    steps = 0;
    /* real money: the crash point arrives from the server when the round is over (or already has) */
    if (!real) {
      crashPoint = nextOdds;
      crashSteps = stepsTo(crashPoint);
    }
    flightStart = now;
    crashPos = null;
    for (const sl of slots) {
      if (!sl.bet) continue;
      sl.bet.live = true;
      sl.bet.row.querySelector(".x").textContent = "in flight";
    }
    if (crashSteps === 0) return crash(now);
    sfx.takeoff();
    render();
  }

  function crash(now) {
    const point = crashPoint;
    crashedAt = now;
    let lost = 0;
    for (const sl of slots) {
      if (!sl.bet || !sl.bet.live) continue;
      /* at the top every bet still flying is paid there (with real money the server already has) */
      if (point >= TOP) {
        if (!real) balance += winOf(sl);
        settleRow(sl.bet.row, "won", TOP, winOf(sl));
        toast("Top reached · paid at " + TOP.toFixed(2) + "x", true);
        sl.bet = null;
        continue;
      }
      sl.bet.lost = true;
      settleRow(sl.bet.row, "lost", point);
      lost++;
    }
    if (lost) toast(lost > 1 ? "Flew away — both stakes lost" : "Flew away — stake lost");
    addHistory(point);
    lastEl.innerHTML = "Flew away at <b>" + point.toFixed(2) + "x</b>";
    sfx.crash();
    startPause(now);
    render();
  }

  /* ---------------- player actions (each panel on its own) ---------------- */
  const winOf = (sl) => Math.floor((sl.bet.cents * (1000 + steps)) / 1000);

  function readStake(sl) {
    const v = Number(sl.input.value);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.round(v * 100);
  }

  function onAction(sl) {
    unlockAudio();
    if (sl.bet) {
      /* the button reads Cash Out */
      if (sl.bet.sending) return;
      if (phase === "FLYING" && sl.bet.live) {
        if (real) cashOutReal(sl);
        else cashOut(sl);
      } else toast("Can't cash out now");
      return;
    }
    if (phase !== "WAITING" || (real && !flightId)) return toast("Wait for the next round");
    const cents = readStake(sl);
    if (cents < 1) return toast("Enter a stake");
    if (cents > balance) return toast("Stake is more than your balance");
    if (real) return betReal(sl, cents);
    balance -= cents;
    sl.bet = { cents, live: false, lost: false, row: addRow(cents, sl.i) };
    sl.input.value = money(cents);
    sfx.bet();
    render();
  }

  function cashOut(sl) {
    const win = winOf(sl);
    balance += win;
    toast("Cashed out at " + multOf(steps).toFixed(2) + "x · +" + money(win) + " GHS", true);
    settleRow(sl.bet.row, "won", multOf(steps), win);
    sl.bet = null;
    sfx.cashout();
    render();
  }

  /* ---------------- real money: the server runs the rounds ---------------- */
  let flightId = null;
  let syncWarned = false;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const errorText = (r) => (r.data && (r.data.message || r.data.error)) || "Couldn't reach the game server. Try again.";

  /* → { ok, status, data }; status 0 = no answer */
  async function api(path, body, timeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || 20000);
    try {
      const res = await fetch(API + "/api/games/volta-jet/flight/" + path, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.token },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
      let data = {};
      try { data = await res.json(); } catch { /* not JSON */ }
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: {} };
    } finally {
      clearTimeout(timer);
    }
  }
  const setBalance = (ghs) => { if (typeof ghs === "number") balance = Math.round(ghs * 100); };

  /* the next round, or the one under way (after a reload) */
  async function nextRound() {
    for (;;) {
      const r = await api("next", {});
      if (r.ok) return openRound(r.data);
      if (!syncWarned) toast(r.status === 401 ? "Your session has ended. Sign in again to play for real money." : errorText(r));
      syncWarned = true;
      await sleep(3000);
    }
  }

  function openRound(d) {
    syncWarned = false;
    const now = performance.now();
    if (!flightHistoryShown) {
      flightHistoryShown = true;
      [...d.history].reverse().forEach(addHistory);
    }
    flightId = d.flight_id;
    crashPoint = Infinity;
    crashSteps = Infinity;
    pauseEnd = now + d.starts_in_ms;
    setBalance(d.balance);
    /* bets this round already has (the page was reloaded) */
    for (const v of d.bets) {
      const sl = slots[v.panel];
      if (!sl || sl.bet || v.status !== "ACTIVE") continue;
      const cents = Math.round(v.stake * 100);
      sl.bet = { cents, live: false, lost: false, row: addRow(cents, sl.i), id: v.bet_id };
    }
    if (d.starts_in_ms <= 0) takeOff(pauseEnd); /* already flying: it picks up from the right moment */
    watch(d.flight_id);
    render();
  }
  let flightHistoryShown = false;

  /* the long poll: answered when the round is over, with the crash point, every bet's result and the balance */
  async function watch(id) {
    while (flightId === id) {
      const r = await api(id + "/wait", null, 40000);
      if (flightId !== id) return;
      if (r.ok && r.data.over) {
        setBalance(r.data.balance);
        crashPoint = r.data.crash;
        crashSteps = stepsTo(r.data.crash); /* the loop flies it away there */
        return;
      }
      if (!r.ok) await sleep(1500);
    }
  }

  async function betReal(sl, cents) {
    if (cents < 10 || cents > 100000) return toast("Stakes are GHS 0.10 to GHS 1,000");
    const bet = { cents, live: false, lost: false, row: addRow(cents, sl.i), sending: true, key: "flight:" + crypto.randomUUID() };
    sl.bet = bet;
    sl.input.value = money(cents);
    render();
    let r;
    for (let tries = 0; tries < 3; tries++) {
      r = await api("bet", { flight_id: flightId, panel: sl.i, stake: cents / 100, idempotency_key: bet.key });
      if (r.status !== 0) break; /* only a lost connection is tried again, with the same key */
      await sleep(700);
    }
    bet.sending = false;
    if (r.ok) {
      bet.id = r.data.bet.bet_id;
      setBalance(r.data.balance);
      sfx.bet();
    } else {
      if (sl.bet === bet) sl.bet = null;
      bet.row.remove();
      toast(r.data && r.data.error === "too_late" ? "Wait for the next round" : errorText(r));
    }
    render();
  }

  async function cashOutReal(sl) {
    const bet = sl.bet;
    bet.sending = true;
    render();
    const r = await api("cashout", { bet_id: bet.id });
    bet.sending = false;
    if (!r.ok) {
      toast(errorText(r));
      return render();
    }
    const v = r.data.bet;
    setBalance(r.data.balance);
    if (v.status === "WON") {
      const win = Math.round(v.payout * 100);
      toast("Cashed out at " + v.x.toFixed(2) + "x · +" + money(win) + " GHS", true);
      settleRow(bet.row, "won", v.x, win);
      if (sl.bet === bet) sl.bet = null;
      sfx.cashout();
    } else if (v.status === "LOST" && r.data.crash && !isFinite(crashSteps)) {
      crashPoint = r.data.crash; /* it had already flown away */
      crashSteps = stepsTo(r.data.crash);
    }
    render();
  }

  /* − and + walk a ladder of round stakes; the chips set one directly */
  const LADDER = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 300000];
  function setStake(sl, cents) {
    if (sl.bet) return;
    sl.input.value = money(Math.max(1, cents));
    render();
  }

  for (const sl of slots) {
    sl.btn.addEventListener("click", () => onAction(sl));
    /* numbers only: no minus, plus or exponent */
    sl.input.addEventListener("keydown", (e) => {
      if (["-", "+", "e", "E"].includes(e.key)) e.preventDefault();
      if (e.key === "Enter") onAction(sl);
    });
    sl.input.addEventListener("input", () => render());
    sl.input.addEventListener("blur", () => {
      const c = readStake(sl);
      sl.input.value = c ? money(c) : "";
      render();
    });
    sl.panel.querySelector(".plus").addEventListener("click", () => {
      const c = readStake(sl);
      setStake(sl, LADDER.find((v) => v > c) || c);
    });
    sl.panel.querySelector(".minus").addEventListener("click", () => {
      const c = readStake(sl);
      setStake(sl, [...LADDER].reverse().find((v) => v < c) || c);
    });
    sl.panel.querySelector(".chips").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-v]");
      if (b) setStake(sl, Number(b.dataset.v) * 100);
    });
  }

  /* ---------------- My bets ---------------- */
  const BETS_MAX = 30;
  function addRow(cents, slot) {
    const li = document.createElement("li");
    li.className = "live";
    li.innerHTML = '<span class="s"><i class="tag"></i></span><span class="x">waiting…</span><span class="w">—</span>';
    li.querySelector(".tag").textContent = slot + 1;
    li.querySelector(".tag").title = "Bet " + (slot + 1);
    li.querySelector(".s").append(money(cents) + " GHS");
    const empty = $("betsEmpty");
    if (empty) empty.remove();
    betsEl.prepend(li);
    while (betsEl.children.length > BETS_MAX) betsEl.lastChild.remove();
    return li;
  }
  function settleRow(li, result, m, win) {
    li.className = result;
    const x = li.querySelector(".x");
    x.innerHTML = "";
    const b = document.createElement("b");
    b.className = tier(m);
    b.textContent = m.toFixed(2) + "x";
    x.append(b);
    li.querySelector(".w").textContent = result === "won" ? "+" + money(win) + " GHS" : "Lost";
  }

  /* ---------------- DOM ---------------- */
  let toastTimer = 0;
  function toast(msg, win) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("win", !!win);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  function addHistory(point) {
    const chip = document.createElement("span");
    chip.className = "chip " + tier(point);
    const empty = $("historyEmpty");
    if (empty) empty.remove();
    chip.textContent = point.toFixed(2) + "x";
    historyEl.prepend(chip);
    while (historyEl.children.length > HISTORY_MAX) historyEl.lastChild.remove();
  }

  function render() {
    balanceEl.textContent = money(balance);
    for (const sl of slots) {
      const bet = sl.bet;
      sl.input.disabled = !!bet;
      sl.box.classList.toggle("locked", !!bet);
      sl.box.querySelectorAll("button").forEach((b) => { b.disabled = !!bet; });
      sl.btn.classList.remove("bet", "cash", "waiting-bet");
      sl.btn.disabled = false;
      if (!bet) {
        sl.btn.classList.add("bet");
        sl.title.textContent = "Bet";
        const c = readStake(sl);
        sl.sub.textContent = c ? money(c) + " GHS" : "Enter a stake";
      } else if (phase === "FLYING" && bet.live) {
        sl.btn.classList.add("cash");
        sl.btn.disabled = !!bet.sending;
        sl.title.textContent = "Cash Out";
        sl.sub.textContent = money(winOf(sl)) + " GHS";
      } else {
        sl.btn.classList.add("waiting-bet");
        sl.title.textContent = "Cash Out";
        sl.sub.textContent = bet.lost ? "Flew away" : bet.sending ? "Placing your bet…" : "Next round · " + money(bet.cents) + " GHS";
      }
    }
  }

  /* ---------------- canvas ---------------- */
  const canvas = $("sky");
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

  /* the jet artwork (jet.svg, 260 × 100 side view) rasterised once at 4×; the afterburner is drawn live behind it */
  const ART_W = 260;
  const ART_H = 100;
  const TAIL = { x: 8, y: 57 }; /* exhaust nozzle: where the flight curve meets the jet */
  let planeArt = null;
  const planeImg = new Image();
  planeImg.onload = () => {
    const art = document.createElement("canvas");
    art.width = ART_W * 4;
    art.height = ART_H * 4;
    art.getContext("2d").drawImage(planeImg, 0, 0, art.width, art.height);
    planeArt = art;
  };
  planeImg.src = "jet.svg";

  /* afterburner: an orange plume with a hot blue-white core and a few shock diamonds, flickering */
  function drawAfterburner(now, power) {
    const flick = reduceMotion ? 1 : 0.88 + 0.12 * Math.sin(now / 37) + 0.06 * Math.sin(now / 13);
    const len = (48 + 36 * power) * flick;
    const x0 = TAIL.x + 1;
    const y0 = TAIL.y;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const plume = ctx.createLinearGradient(x0, 0, x0 - len, 0);
    plume.addColorStop(0, "rgba(255, 196, 92, .95)");
    plume.addColorStop(0.35, "rgba(255, 110, 40, .7)");
    plume.addColorStop(1, "rgba(255, 60, 30, 0)");
    ctx.fillStyle = plume;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 7.5);
    ctx.quadraticCurveTo(x0 - len * 0.45, y0 - 6.5, x0 - len, y0);
    ctx.quadraticCurveTo(x0 - len * 0.45, y0 + 6.5, x0, y0 + 7.5);
    ctx.closePath();
    ctx.fill();
    const core = ctx.createLinearGradient(x0, 0, x0 - len * 0.5, 0);
    core.addColorStop(0, "rgba(235, 245, 255, 1)");
    core.addColorStop(0.5, "rgba(140, 190, 255, .65)");
    core.addColorStop(1, "rgba(120, 170, 255, 0)");
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 4.5);
    ctx.quadraticCurveTo(x0 - len * 0.22, y0 - 3.5, x0 - len * 0.5, y0);
    ctx.quadraticCurveTo(x0 - len * 0.22, y0 + 3.5, x0, y0 + 4.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255, 236, 200, .55)";
    for (let i = 1; i <= 3; i++) {
      const cx = x0 - len * (0.16 + i * 0.13);
      const r = 2.6 - i * 0.5;
      ctx.beginPath();
      ctx.ellipse(cx, y0, r * 1.8, r, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const glow = ctx.createRadialGradient(x0, y0, 0, x0, y0, 22);
    glow.addColorStop(0, "rgba(255, 150, 60, .45)");
    glow.addColorStop(1, "rgba(255, 150, 60, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(x0 - 22, y0 - 22, 44, 44);
    ctx.restore();
  }

  function drawPlane(x, y, angle, size, now, power) {
    if (!planeArt) return;
    const s = size / ART_W;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.scale(s, s);
    ctx.translate(-TAIL.x, -TAIL.y);
    drawAfterburner(now, power);
    ctx.shadowColor = "rgba(0, 0, 0, .55)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(planeArt, 0, 0, ART_W, ART_H);
    ctx.restore();
  }

  /* ---------------- the sky: sunset, mountains and clouds; the camera climbs with the jet ---------------- */
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const mix = (a, b, t) => "rgb(" + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",") + ")";

  /* sky colours near the ground (sunset) and high up (stratosphere), top → horizon */
  const LOW = [[44, 98, 170], [126, 172, 222], [255, 196, 138]];
  const HIGH = [[3, 7, 26], [11, 30, 74], [36, 70, 132]];

  let alt = 0;      /* 0 on the runway → 1 high up, eased */
  let scroll = 0;   /* sideways travel, px */
  let lastSkyAt = 0;

  const STARS = Array.from({ length: 110 }, () => ({
    x: Math.random(), y: Math.random() * 0.75, r: Math.random() < 0.1 ? 1.4 : 0.5 + Math.random() * 0.6,
    tw: Math.random() * Math.PI * 2
  }));

  /* two mountain ridges from a few summed sine waves */
  function ridge(seed, n) {
    const waves = Array.from({ length: n }, (_, i) => ({
      f: (i + 1) * (0.7 + ((seed * (i + 3)) % 7) / 10), p: (seed * 13.7 * (i + 1)) % 6.28, a: 1 / (i + 1.4)
    }));
    return (x) => waves.reduce((s, w) => s + Math.sin(x * w.f + w.p) * w.a, 0);
  }
  const FAR_RIDGE = ridge(3, 5);
  const NEAR_RIDGE = ridge(7, 4);

  /* cloud sprites: soft white puffs, lit warm from above and shaded blue-grey underneath, rendered once */
  const CLOUD_W = 420;
  const CLOUD_H = 220;
  const cloudSprites = [0, 1, 2, 3].map((k) => {
    const c = document.createElement("canvas");
    c.width = CLOUD_W;
    c.height = CLOUD_H;
    const g = c.getContext("2d");
    const puffs = 9 + k * 2;
    for (let i = 0; i < puffs; i++) {
      const u = (i + 0.5) / puffs;
      /* every puff stays inside the sprite, so no cloud gets a straight cut edge */
      const x = 80 + u * (CLOUD_W - 160) + (Math.random() - 0.5) * 24;
      const hump = Math.sin(u * Math.PI);
      const y = CLOUD_H * 0.68 - hump * (28 + k * 6) + (Math.random() - 0.5) * 10;
      const r = 26 + hump * (30 + k * 5) + Math.random() * 12;
      const puff = g.createRadialGradient(x, y - r * 0.2, r * 0.1, x, y, r);
      puff.addColorStop(0, "rgba(255,255,255,1)");
      puff.addColorStop(0.6, "rgba(255,255,255,.85)");
      puff.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = puff;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = "source-atop";
    const shade = g.createLinearGradient(0, 10, 0, CLOUD_H);
    shade.addColorStop(0, "rgba(255, 244, 228, .9)");
    shade.addColorStop(0.55, "rgba(236, 240, 248, .6)");
    shade.addColorStop(1, "rgba(120, 140, 175, .95)");
    g.fillStyle = shade;
    g.fillRect(0, 0, CLOUD_W, CLOUD_H);
    return c;
  });
  const CLOUDS = Array.from({ length: 16 }, (_, i) => ({
    x: Math.random(),
    h: 0.05 + (i / 16) * 2.3 + Math.random() * 0.15,   /* height above the horizon, in stage heights */
    depth: 0.35 + Math.random() * 0.65,                  /* parallax: 1 = nearest */
    sprite: cloudSprites[i % cloudSprites.length],
    scale: 0.5 + Math.random() * 0.7
  })).sort((a, b) => a.depth - b.depth);

  function cloudPos(c, camY) {
    /* clouds are sized for a wide stage and shrink on narrow (phone) screens */
    const w = CLOUD_W * c.scale * (0.55 + c.depth * 0.6) * Math.max(0.42, Math.min(1, W / 1000));
    const span = W + w * 2;
    const x = ((((c.x * span - scroll * c.depth) % span) + span) % span) - w;
    const y = H * 0.8 - c.h * H + camY * c.depth;
    return { x, y, w, h: (w * CLOUD_H) / CLOUD_W };
  }

  function drawSky(now, camY) {
    const horizon = H * 0.8 + camY * 0.45;
    const sky = ctx.createLinearGradient(0, 0, 0, Math.max(horizon, 1));
    sky.addColorStop(0, mix(LOW[0], HIGH[0], alt));
    sky.addColorStop(0.62, mix(LOW[1], HIGH[1], alt));
    sky.addColorStop(1, mix(LOW[2], HIGH[2], alt));
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    /* stars come out as the air thins */
    const starA = clamp01((alt - 0.45) / 0.4);
    if (starA > 0) {
      for (const st of STARS) {
        const a = starA * (reduceMotion ? 0.8 : 0.55 + 0.35 * Math.sin(now / 650 + st.tw));
        ctx.fillStyle = "rgba(225, 235, 255, " + a.toFixed(3) + ")";
        ctx.beginPath();
        ctx.arc((((st.x * W - scroll * 0.03) % W) + W) % W, st.y * H, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /* low sun glowing over the horizon */
    const sunA = 1 - clamp01(alt * 1.3);
    if (sunA > 0) {
      const sx = W * 0.78;
      const sy = horizon - H * 0.07;
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, Math.max(W, H) * 0.55);
      glow.addColorStop(0, "rgba(255, 226, 170, " + (0.75 * sunA).toFixed(3) + ")");
      glow.addColorStop(0.08, "rgba(255, 190, 120, " + (0.45 * sunA).toFixed(3) + ")");
      glow.addColorStop(1, "rgba(255, 160, 100, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "rgba(255, 246, 225, " + sunA.toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(10, H * 0.035), 0, Math.PI * 2);
      ctx.fill();
    }

    /* mountains and the valley floor, sinking away as the jet climbs */
    if (horizon < H + 60) {
      const ridgeAt = (fn, base, amp, depth) => {
        ctx.beginPath();
        ctx.moveTo(0, H + 2);
        for (let x = 0; x <= W + 8; x += 8) {
          const wx = (x + scroll * depth) / 140;
          ctx.lineTo(x, base - amp * (1.3 + fn(wx)));
        }
        ctx.lineTo(W, H + 2);
        ctx.closePath();
      };
      ridgeAt(FAR_RIDGE, horizon, H * 0.05, 0.12);
      ctx.fillStyle = mix([108, 120, 160], [40, 58, 104], alt);
      ctx.fill();
      ridgeAt(NEAR_RIDGE, horizon + H * 0.06, H * 0.045, 0.3);
      const near = ctx.createLinearGradient(0, horizon - H * 0.1, 0, H);
      near.addColorStop(0, "#2a3554");
      near.addColorStop(1, "#0d1424");
      ctx.fillStyle = near;
      ctx.fill();
    }

    /* far clouds, behind the jet */
    for (const c of CLOUDS) {
      if (c.depth > 0.85) continue;
      drawCloud(c, camY);
    }
    return horizon;
  }

  function drawCloud(c, camY) {
    const p = cloudPos(c, camY);
    if (p.y > H || p.y + p.h < 0) return;
    ctx.globalAlpha = 0.45 + c.depth * 0.5;
    ctx.drawImage(c.sprite, p.x, p.y, p.w, p.h);
    ctx.globalAlpha = 1;
  }

  /* a heads-up altitude tape on the right edge */
  function drawHud(camY) {
    const x = W - 18;
    const feet = Math.round(1200 + alt * 38000);
    ctx.save();
    ctx.strokeStyle = "rgba(160, 230, 255, .55)";
    ctx.fillStyle = "rgba(190, 240, 255, .75)";
    ctx.lineWidth = 1.2;
    ctx.font = "600 10px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.beginPath();
    ctx.moveTo(x, H * 0.12);
    ctx.lineTo(x, H * 0.88);
    ctx.stroke();
    const gap = 26;
    const off = (camY * 0.9) % gap;
    for (let y = H * 0.12 + off; y < H * 0.88; y += gap) {
      const major = Math.round((y - off) / gap) % 2 === 0;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - (major ? 10 : 5), y);
      ctx.stroke();
    }
    const by = H * 0.5;
    ctx.fillStyle = "rgba(6, 18, 36, .7)";
    ctx.strokeStyle = "rgba(160, 230, 255, .8)";
    ctx.beginPath();
    ctx.roundRect(x - 66, by - 11, 58, 22, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#c8f1ff";
    ctx.fillText(feet.toLocaleString("en-US") + " ft", x - 12, by + 4);
    ctx.fillStyle = "rgba(190, 240, 255, .6)";
    ctx.fillText("ALT", x - 4, H * 0.12 - 6);
    ctx.restore();
  }

  /* a soft white vapour trail from the take-off point to the jet, thickest and brightest at the jet */
  function drawContrail(x0, y0, x1, y1) {
    const dx = Math.max(1, x1 - x0);
    const dy = y0 - y1;
    const fade = ctx.createLinearGradient(x0, y0, x1, y1);
    fade.addColorStop(0, "rgba(255, 255, 255, 0)");
    fade.addColorStop(0.55, "rgba(255, 255, 255, .25)");
    fade.addColorStop(1, "rgba(255, 255, 255, .9)");
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = fade;
    [[14, 0.12], [7, 0.25], [2.6, 0.8]].forEach(([w, a]) => {
      ctx.globalAlpha = a;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      for (let i = 1; i <= 40; i++) {
        const s = i / 40;
        ctx.lineTo(x0 + dx * s, y0 - dy * s * s);
      }
      ctx.stroke();
    });
    ctx.restore();
  }

  function jetAt(t, ox, oy) {
    const f = 1 - Math.exp(-t / 3.2);
    const x = ox + (W * 0.74 - ox) * f;
    const lift = H * 0.5 * Math.pow(f, 1.5);
    const bob = reduceMotion ? 0 : Math.sin(t * 1.7) * H * 0.025 * f * f;
    return { x, y: oy - lift + bob, bob };
  }

  function draw(now) {
    const dt = lastSkyAt ? Math.min(0.1, (now - lastSkyAt) / 1000) : 0;
    lastSkyAt = now;
    const target = phase === "FLYING" ? clamp01(Math.log(multOf(steps)) / Math.log(8)) : 0;
    alt += (target - alt) * Math.min(1, dt * (phase === "FLYING" ? 2.5 : 0.6));
    if (!reduceMotion) scroll += dt * (phase === "FLYING" ? 120 + alt * 160 : 10);
    const camY = alt * H * 1.8;

    drawSky(now, camY);

    const ox = Math.round(W * 0.07);
    const oy = Math.round(H * 0.84);
    const size = Math.max(84, Math.min(170, W * 0.22));

    if (phase === "FLYING") {
      const t = (now - flightStart) / 1000;
      const p = jetAt(t, ox, oy);
      drawContrail(ox, oy + camY * 0.6, p.x, p.y);
      const dx = Math.max(1, p.x - ox);
      const dy = oy - p.y;
      const angle = Math.max(-0.5, Math.min(0.05, Math.atan2(-2 * dy, dx) * 0.55 + p.bob * -0.004));
      drawPlane(p.x, p.y, angle, size, now, Math.min(1, t / 3));
      crashPos = { x: p.x, y: p.y, angle };
    } else if (crashPos && now - crashedAt < 1400) {
      /* the jet punches away off the top-right corner */
      const tc = (now - crashedAt) / 1000;
      const ease = tc * tc;
      const x = crashPos.x + W * 1.3 * ease;
      const y = crashPos.y - H * 0.7 * ease;
      drawContrail(crashPos.x - W * 0.3, crashPos.y + H * 0.15, x, y);
      drawPlane(x, y, crashPos.angle - 0.25 * Math.min(1, tc * 2), size, now, 1.4);
    }

    /* the nearest clouds pass in front of the jet */
    for (const c of CLOUDS) if (c.depth > 0.85) drawCloud(c, camY);
    if (phase === "FLYING" || alt > 0.02) drawHud(camY);
  }

  /* ---------------- sound (Web Audio, starts after the first tap) ---------------- */
  let actx = null;
  let master = null;
  let engine = null;
  let soundOn = true;

  function unlockAudio() {
    if (actx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = new AC();
    master = actx.createGain();
    master.gain.value = soundOn ? 0.9 : 0;
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
      if (!actx) return;
      tone(520, actx.currentTime, 0.08, "triangle", 0.18);
    },
    takeoff() {
      if (!actx) return;
      const t = actx.currentTime;
      const n = noise(1.4);
      const f = actx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.setValueAtTime(300, t);
      f.frequency.exponentialRampToValueAtTime(2200, t + 1.2);
      const g = actx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      n.connect(f).connect(g).connect(master);
      n.start(t);
      /* engine drone that rises with the multiplier */
      stopEngine();
      const osc = actx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 62;
      const hum = actx.createOscillator();
      hum.type = "sine";
      hum.frequency.value = 124;
      const lp = actx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 420;
      const eg = actx.createGain();
      eg.gain.setValueAtTime(0, t);
      eg.gain.linearRampToValueAtTime(0.06, t + 0.6);
      osc.connect(lp);
      hum.connect(lp);
      lp.connect(eg).connect(master);
      osc.start(t);
      hum.start(t);
      engine = { osc, hum, gain: eg };
    },
    climb(m) {
      if (!engine) return;
      const f = 62 + Math.min(1, (m - 1) / 6) * 60;
      engine.osc.frequency.setTargetAtTime(f, actx.currentTime, 0.2);
      engine.hum.frequency.setTargetAtTime(f * 2, actx.currentTime, 0.2);
    },
    cashout() {
      if (!actx) return;
      const t = actx.currentTime;
      tone(880, t, 0.18, "sine", 0.22);
      tone(1320, t + 0.09, 0.3, "sine", 0.2);
      tone(1760, t + 0.18, 0.4, "sine", 0.12);
    },
    crash() {
      if (!actx) return;
      stopEngine();
      const t = actx.currentTime;
      const n = noise(0.9);
      const f = actx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(1800, t);
      f.frequency.exponentialRampToValueAtTime(120, t + 0.8);
      const g = actx.createGain();
      g.gain.setValueAtTime(0.35, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      n.connect(f).connect(g).connect(master);
      n.start(t);
      const o = actx.createOscillator();
      const og = actx.createGain();
      o.frequency.setValueAtTime(170, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.6);
      og.gain.setValueAtTime(0.3, t);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(og).connect(master);
      o.start(t);
      o.stop(t + 0.75);
    }
  };

  const soundBtn = $("sound");
  soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    soundBtn.setAttribute("aria-pressed", String(soundOn));
    soundBtn.setAttribute("aria-label", soundOn ? "Sound on" : "Sound off");
    if (master) master.gain.setTargetAtTime(soundOn ? 0.9 : 0, actx.currentTime, 0.02);
  });

  /* ---------------- main loop: the multiplier follows the clock (0.001 every 1/60 s) ---------------- */
  function frame(now) {
    if (phase === "FLYING") {
      const before = steps;
      steps = Math.max(0, Math.floor((now - flightStart) * STEPS_PER_MS));
      if (steps >= crashSteps) {
        steps = crashSteps;
        crash(now);
      } else {
        for (const sl of slots) if (sl.bet && sl.bet.live) sl.sub.textContent = money(winOf(sl)) + " GHS";
      }
      if (Math.floor(steps / 20) > Math.floor(before / 20)) sfx.climb(multOf(steps));
    } else {
      /* a lost bet's button clears once "Flew away" has been shown */
      if (now - crashedAt >= LOST_SHOW_MS && slots.some((sl) => sl.bet && sl.bet.lost)) {
        for (const sl of slots) if (sl.bet && sl.bet.lost) sl.bet = null;
        render();
      }
      if (now >= pauseEnd && (real ? flightId : nextOdds !== null)) takeOff(real ? pauseEnd : now);
    }

    stage.classList.toggle("waiting-phase", phase === "WAITING");
    multEl.textContent = multOf(steps).toFixed(2) + "x";
    if (phase === "WAITING") {
      const left = Math.min(PAUSE_MS, Math.max(0, pauseEnd - now));
      barEl.style.width = ((left / PAUSE_MS) * 100).toFixed(1) + "%";
    }

    draw(now);
    requestAnimationFrame(frame);
  }

  startPause(performance.now());
  if (real) {
    /* the wallet balance, before the first round arrives */
    fetch(API + "/api/user/balances", { headers: { Authorization: "Bearer " + session.token } })
      .then((res) => res.json())
      .then((d) => { if (d && d.primary && !flightId) { setBalance(Number(d.primary.available)); render(); } })
      .catch(() => {});
  }
  render();
  requestAnimationFrame(frame);
})();
