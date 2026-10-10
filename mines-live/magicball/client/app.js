/* Magic Ball Live — the page. The server runs the table; this draws it. Everything timed — the countdown, when the
   cups shuffle, when they lift — is read from the server's timestamps (corrected for this device's clock skew), so
   every player's page does the same thing at the same moment. The page never picks a position, never settles a bet
   and never trusts its own clock to open or close betting: the server answers every bet. */
(function () {
  "use strict";
  const C = window.MB_CONSTANTS;
  const $ = (id) => document.getElementById(id);
  const money = (n) => Number(n).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const CHIPS = [1, 5, 10, 25, 50, 100, 500, 1000];
  const chipColor = (v) => (v >= 500 ? "#7b1fa2" : v >= 100 ? "#111" : v >= 50 ? "#ef6c00" : v >= 25 ? "#2e7d32" : v >= 10 ? "#1e88e5" : v >= 5 ? "#e53935" : "#78909c");

  /* a stable player id for this browser: a refresh or a second tab is the same player and the same demo wallet */
  let playerId = null;
  try { playerId = localStorage.getItem("mb.live.id"); } catch (e) { /* storage unavailable */ }
  if (!playerId) {
    playerId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, "");
    try { localStorage.setItem("mb.live.id", playerId); } catch (e) { /* storage unavailable */ }
  }

  /* ---------------- state ---------------- */
  let round = null;        /* the current round, as the server describes it */
  let skew = 0;            /* server time − our time */
  let balance = 0;
  let myBet = null;        /* { roundId, spot, amount, result, payout } */
  let chosen = 0;          /* the spot picked, before the bet is placed */
  let amount = 10;
  let history = [];
  let shownState = null;   /* the state the stage is drawn in */
  let shuffleJob = 0;
  const myResults = {};    /* roundId → "WIN" | "LOSE" */
  const now = () => Date.now() + skew;

  /* ---------------- toasts ---------------- */
  let toastTimer = 0;
  function toast(text, kind) {
    const t = $("toast");
    t.textContent = text;
    t.className = "toast" + (kind ? " " + kind : "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  /* ---------------- sound: tiny synthesised cues, after the first tap ---------------- */
  let soundOn = true;
  try { soundOn = localStorage.getItem("mb.live.sound") !== "off"; } catch (e) { /* storage unavailable */ }
  let ac = null;
  const audio = () => { if (!soundOn) return null; if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } } if (ac.state === "suspended") ac.resume(); return ac; };
  document.addEventListener("pointerdown", () => audio(), { once: true, passive: true });
  function tone(f, type, dur, vol, to) {
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(f, a.currentTime); if (to) o.frequency.exponentialRampToValueAtTime(to, a.currentTime + dur);
    g.gain.setValueAtTime(vol, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + dur);
  }
  function whoosh(dur) {
    const a = audio(); if (!a) return;
    const len = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.sin((i / len) * Math.PI);
    const src = a.createBufferSource(); src.buffer = buf;
    const f = a.createBiquadFilter(); f.type = "bandpass"; f.frequency.setValueAtTime(400, a.currentTime); f.frequency.exponentialRampToValueAtTime(1800, a.currentTime + dur); f.Q.value = 0.9;
    const g = a.createGain(); g.gain.value = 0.12;
    src.connect(f).connect(g).connect(a.destination); src.start();
  }
  const sfx = {
    swap: (ms) => whoosh(ms / 1000),
    thud: () => tone(90, "sine", 0.12, 0.25, 50),
    lift: () => tone(520, "triangle", 0.18, 0.12, 780),
    chip: () => { tone(1800, "square", 0.05, 0.05); setTimeout(() => tone(2400, "square", 0.05, 0.04), 50); },
    tick: () => tone(1200, "square", 0.04, 0.05),
    win: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, "triangle", 0.35, 0.16), i * 110)),
    lose: () => tone(220, "sawtooth", 0.3, 0.08, 110)
  };
  $("sound").addEventListener("click", () => {
    soundOn = !soundOn;
    try { localStorage.setItem("mb.live.sound", soundOn ? "on" : "off"); } catch (e) { /* storage unavailable */ }
    $("sound").setAttribute("aria-pressed", String(soundOn)); $("sound").textContent = soundOn ? "🔊" : "🔇"; $("sound").setAttribute("aria-label", soundOn ? "Sound on" : "Sound off");
  });
  $("sound").setAttribute("aria-pressed", String(soundOn)); $("sound").textContent = soundOn ? "🔊" : "🔇";

  /* ---------------- dust in the spotlight ---------------- */
  (function dust() {
    const cv = $("dust"), ctx = cv.getContext("2d");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const motes = Array.from({ length: 40 }, () => ({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.6, vx: (Math.random() - 0.5) * 0.02, vy: -0.01 - Math.random() * 0.02, a: Math.random() * Math.PI * 2 }));
    let w = 0, h = 0, last = 0;
    const resize = () => { w = cv.width = cv.clientWidth; h = cv.height = cv.clientHeight; };
    resize(); window.addEventListener("resize", resize);
    (function frame(t) {
      const dt = Math.min(0.05, (t - last) / 1000 || 0.016); last = t;
      ctx.clearRect(0, 0, w, h);
      for (const m of motes) {
        m.a += dt; m.x += (m.vx + Math.sin(m.a) * 0.01) * dt; m.y += m.vy * dt;
        if (m.y < -0.02) { m.y = 1.02; m.x = Math.random(); } if (m.x < 0 || m.x > 1) m.vx *= -1;
        const inBeam = Math.abs(m.x - 0.5) < 0.16 + m.y * 0.3;   /* the lamp's cone widens downwards */
        ctx.globalAlpha = (inBeam ? 0.55 : 0.12) * (0.5 + 0.5 * Math.sin(m.a * 2));
        ctx.fillStyle = "#ffe9b8"; ctx.beginPath(); ctx.arc(m.x * w, m.y * h, m.r, 0, Math.PI * 2); ctx.fill();
      }
      requestAnimationFrame(frame);
    })(0);
  })();

  /* ---------------- confetti ---------------- */
  function confetti() {
    const cv = $("confetti"), ctx = cv.getContext("2d");
    cv.width = innerWidth; cv.height = innerHeight;
    const colors = ["#ffd54f", "#ffffff", "#c8102e", "#2e9e4a", "#a85cff", "#ffb703"];
    const bits = Array.from({ length: 140 }, () => ({ x: innerWidth / 2 + (Math.random() - 0.5) * 120, y: innerHeight * 0.42, vx: (Math.random() - 0.5) * 900, vy: -500 - Math.random() * 500, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12, w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, c: colors[Math.floor(Math.random() * colors.length)] }));
    let last = performance.now();
    (function frame(t) {
      const dt = Math.min(0.05, (t - last) / 1000); last = t;
      ctx.clearRect(0, 0, cv.width, cv.height);
      let alive = 0;
      for (const b of bits) {
        b.vy += 1400 * dt; b.vx *= 0.99; b.x += b.vx * dt; b.y += b.vy * dt; b.r += b.vr * dt;
        if (b.y < cv.height + 20) alive++;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
      }
      if (alive) requestAnimationFrame(frame); else ctx.clearRect(0, 0, cv.width, cv.height);
    })(last);
  }

  /* ---------------- the chip on the table ---------------- */
  const MARK_X = [0.22, 0.5, 0.78], MARK_Y = [0.565, 0.573, 0.565];   /* the painted spots, as fractions of the stage */
  let tableChip = null;
  function placeChip(spot, value) {
    const layer = $("chipLayer");
    if (tableChip) tableChip.remove();
    const c = document.createElement("span");
    c.className = "tchip fly";
    c.style.setProperty("--c", chipColor(value));
    c.textContent = value >= 1000 ? "1K" : value;
    c.style.left = "50%"; c.style.top = "118%";
    layer.appendChild(c);
    tableChip = c;
    requestAnimationFrame(() => { c.style.left = MARK_X[spot - 1] * 100 + "%"; c.style.top = MARK_Y[spot - 1] * 100 + "%"; });
    sfx.chip();
  }
  function removeChip(won) {
    if (!tableChip) return;
    const c = tableChip; tableChip = null;
    if (won) { c.classList.add("win"); setTimeout(() => c.remove(), 2600); }
    else { c.classList.add("gone"); setTimeout(() => c.remove(), 400); }
  }

  /* ---------------- the table ---------------- */
  const cupsBox = $("cups");
  const cups = Array.from(cupsBox.querySelectorAll(".cup"));
  const ball = $("ball");
  const marks = Array.from(document.querySelectorAll(".mark"));
  let slots = [0, 1, 2];   /* slots[i]: the slot cup i stands on */

  const setCup = (i, slot) => { slots[i] = slot; cups[i].style.setProperty("--slot", slot); };
  function cupsDown() {
    cupsBox.classList.remove("is-up");
    ball.classList.remove("is-in", "is-win");
    marks.forEach((m) => m.classList.remove("is-ball"));
    $("stage").removeAttribute("data-result");
  }
  /* one swap: the two cups trade places along arcs, one passing in front, the other behind */
  function swap(cup, from, to, front, ms) {
    const start = performance.now();
    (function step(t) {
      const k = Math.min(1, (t - start) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const x = from + (to - from) * e;
      const arc = Math.sin(k * Math.PI) * (front ? 18 : -14);
      const s = front ? 1 + Math.sin(k * Math.PI) * 0.08 : 1 - Math.sin(k * Math.PI) * 0.06;
      cup.style.transform = "translateX(calc((" + x + " - 1) * 133.333%)) translateY(" + arc + "%) scale(" + s + ")";
      cup.style.zIndex = front ? 3 : 2;
      if (k < 1) requestAnimationFrame(step);
      else { cup.style.transform = ""; cup.style.zIndex = ""; }
    })(start);
  }
  /* the shuffle everyone sees: the server's swaps, started from the server's shuffleStart; a page that arrives
     mid-shuffle skips the swaps already done and plays the rest in time */
  async function playShuffle(r) {
    const job = ++shuffleJob;
    cupsDown();
    cupsBox.classList.add("is-shuffling");
    let at = r.shuffleStart;
    for (const [a, b, ms] of r.shuffle) {
      const wait = at - now();
      if (wait > 0) await sleep(wait);
      if (job !== shuffleJob) return;
      if (at + ms > now()) {
        const ca = cups.findIndex((_, i) => slots[i] === a), cb = cups.findIndex((_, i) => slots[i] === b);
        cups[ca].classList.add("moving"); cups[cb].classList.add("moving");
        sfx.swap(ms);
        swap(cups[ca], a, b, true, ms);
        swap(cups[cb], b, a, false, ms);
        setCup(ca, b); setCup(cb, a);
        setTimeout(() => { cups[ca].classList.remove("moving"); cups[cb].classList.remove("moving"); const st = $("stage"); st.classList.remove("thump"); void st.offsetWidth; st.classList.add("thump"); }, ms);
      } else {   /* already happened: just update where the cups stand */
        const ca = slots.indexOf(a), cb = slots.indexOf(b);
        setCup(ca, b); setCup(cb, a);
      }
      at += ms + 90;
    }
    cupsBox.classList.remove("is-shuffling");
  }
  /* the reveal: the ball appears on the hidden spot and the cups lift */
  function showReveal(r) {
    shuffleJob++;
    cupsBox.classList.remove("is-shuffling");
    cups.forEach((c, i) => { c.style.transform = ""; c.style.zIndex = ""; setCup(i, i); });
    const spot = r.hiddenPosition;
    ball.style.setProperty("--slot", spot - 1);
    const fresh = now() - r.revealTime < 2500;   /* arriving mid-reveal: show it, don't replay the fanfare */
    cupsBox.classList.add("is-up");
    if (fresh) sfx.lift();
    setTimeout(() => { ball.classList.add("is-in"); marks.forEach((m) => m.classList.toggle("is-ball", Number(m.dataset.spot) === spot)); const f = $("flash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go"); }, fresh ? 420 : 0);
    if (myBet && myBet.roundId === r.roundId) {
      const won = myBet.spot === spot;
      $("stage").dataset.result = won ? "win" : "loss";
      if (won) ball.classList.add("is-win");
      setTimeout(() => removeChip(won), fresh ? 600 : 0);
    }
  }
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  /* ---------------- the clock ---------------- */
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); };
  function paintClock() {
    if (!round) return;
    const t = now();
    const state = stateAt(round, t);
    const until = state === "BETTING" ? round.bettingEnds : state === "SHUFFLING" ? round.shuffleEnd : state === "REVEALING" ? round.resultTime : round.endTime;
    const remaining = Math.max(0, until - t);
    $("clockLabel").textContent = state === "BETTING" ? "NEXT RESULT" : state === "RESULT" ? "NEXT ROUND" : state;
    $("clockTime").textContent = mmss(state === "BETTING" ? round.revealTime - t : remaining);
    $("clockTime").classList.toggle("hurry", state === "BETTING" && remaining < 10000);
    const sec = Math.ceil(remaining / 1000);
    if (state === "BETTING" && sec <= 5 && sec !== paintClock.lastSec) sfx.tick();
    paintClock.lastSec = sec;
    $("clockState").textContent = state === "BETTING" ? "Betting closes in " + mmss(remaining) : state === "SHUFFLING" ? "Bets closed · shuffling" : state === "REVEALING" ? "Revealing…" : "Result";
    const span = state === "BETTING" ? C.BETTING_MS : state === "SHUFFLING" ? C.SHUFFLE_MS : state === "REVEALING" ? C.REVEAL_MS : C.RESULT_MS;
    $("clockBar").style.transform = "scaleX(" + (remaining / span).toFixed(3) + ")";
    document.querySelector(".clock").dataset.state = state;
    const dev = $("dev");
    if (!dev.hidden) { $("devRound").textContent = round.roundId; $("devTime").textContent = new Date(t).toISOString().slice(11, 23); $("devState").textContent = state; $("devSkew").textContent = skew + " ms"; }
  }
  function stateAt(r, t) {
    const d = t - r.startTime;
    if (d < 0) return "WAITING";
    if (d < C.BETTING_MS) return "BETTING";
    if (d < C.BETTING_MS + C.SHUFFLE_MS) return "SHUFFLING";
    if (d < C.BETTING_MS + C.SHUFFLE_MS + C.REVEAL_MS) return "REVEALING";
    return "RESULT";
  }

  /* the stage follows the round's state (from the server's timestamps, so a late joiner lands in the right place) */
  function syncStage() {
    if (!round) return;
    const state = stateAt(round, now());
    const key = round.roundId + ":" + state;
    if (key === shownState) return;
    shownState = key;
    if (state === "BETTING") {
      shuffleJob++; cupsDown(); $("banner").hidden = true; removeChip(false);
      cups.forEach((c, i) => { c.style.transform = ""; setCup(i, i); c.classList.remove("is-dealt"); void c.offsetWidth; c.classList.add("is-dealt"); });
      setTimeout(() => cups.forEach((c) => c.classList.remove("is-dealt")), 900);
      if (now() - round.startTime < 3000) setTimeout(sfx.thud, 350);
      cupsBox.classList.add("idle");
    } else cupsBox.classList.remove("idle");
    if (state === "SHUFFLING") playShuffle(round);
    if ((state === "REVEALING" || state === "RESULT") && round.hiddenPosition) showReveal(round);
    paintBet();
  }

  /* ---------------- the bet panel ---------------- */
  function paintBalance(bump) {
    $("balance").textContent = money(balance);
    const el = $("balance").closest(".bal");
    if (bump) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
  }
  function paintBet() {
    const state = round ? stateAt(round, now()) : "WAITING";
    const open = state === "BETTING";
    const placed = !!(myBet && round && myBet.roundId === round.roundId);
    document.querySelectorAll(".spot").forEach((b) => {
      const n = Number(b.dataset.spot);
      b.setAttribute("aria-pressed", String(placed ? myBet.spot === n : chosen === n));
      b.disabled = !open || placed;
      b.classList.toggle("won", placed && myBet.result === "WIN" && myBet.spot === n);
    });
    $("amount").textContent = amount.toLocaleString("en-GH");
    document.querySelectorAll(".chip").forEach((c) => { c.classList.toggle("on", Number(c.dataset.chip) === amount); c.disabled = !open || placed; });
    $("placeBtn").disabled = !open || placed || !chosen;
    $("placeBtn").textContent = placed ? "Bet placed" : "Place Bet";
    $("clearBtn").disabled = !open || (!placed && !chosen);
    marks.forEach((m) => m.classList.toggle("is-on", (placed ? myBet.spot : chosen) === Number(m.dataset.spot)));
    const mine = $("mine");
    if (placed) {
      mine.hidden = false;
      mine.className = "mine" + (myBet.result === "WIN" ? " win" : myBet.result === "LOSE" ? " lose" : "");
      mine.textContent = myBet.result === "WIN" ? "You won " + money(myBet.payout) + " on Spot " + myBet.spot + " 🏆"
        : myBet.result === "LOSE" ? "Spot " + myBet.spot + " — not this time. The ball was under Spot " + round.hiddenPosition + "."
        : "Your bet: " + money(myBet.amount) + " on Spot " + myBet.spot + " · wins " + money(myBet.amount * C.PAYOUT);
    } else mine.hidden = true;
    $("msg").textContent = !round ? "Connecting to the table…"
      : state === "BETTING" ? (placed ? "Bet placed. Everyone's result comes at the same moment — watch the clock." : "Pick a spot and place your bet. The ball is revealed to everyone when the clock runs out.")
      : state === "SHUFFLING" ? "Bets are closed. The cups are being shuffled…"
      : state === "REVEALING" ? "The cups lift…"
      : "The ball was under Spot " + (round.hiddenPosition || "?") + ". Next round in a moment.";
  }

  /* ---------------- the history ---------------- */
  function paintHistory() {
    $("history").innerHTML = history.slice(0, C.HISTORY).map((h) =>
      '<li class="' + (myResults[h.roundId] === "WIN" ? "me-win" : "") + '" title="' + h.roundId + ' · seed ' + (h.seed || "").slice(0, 12) + '…"><span>' + h.roundId.replace("ROUND-", "#") + "</span><b>" + h.hiddenPosition + "</b></li>").join("")
      || '<li><span>No rounds finished yet</span></li>';
  }

  /* ---------------- the connection ---------------- */
  /* the game's own namespace on whichever server hosts it */
  const socket = io("/magicball", { auth: { playerId } });
  function applySync(s) {
    skew = s.serverTime - Date.now();
    round = s.round;
    balance = s.balance;
    myBet = s.myBet;
    history = s.history || [];
    $("players").querySelector("b").textContent = s.players;
    $("minBet").textContent = s.constants.MIN_BET;
    $("maxBet").textContent = s.constants.MAX_BET.toLocaleString("en-GH");
    $("pays").textContent = s.constants.PAYOUT + "x";
    shownState = null;
    paintBalance();
    paintHistory();
    syncStage();
    paintClock();
    if (myBet && round && myBet.roundId === round.roundId && !myBet.result) { placeChip(myBet.spot, myBet.amount); if (tableChip) tableChip.classList.remove("fly"); }
  }
  socket.on("game:sync", applySync);
  socket.on("connect", () => { if (round) socket.emit("game:sync", null, applySync); });
  socket.on("disconnect", () => { $("clockState").textContent = "Reconnecting…"; });
  socket.on("game:countdown", (c) => { skew = c.serverTime - Date.now(); paintClock(); });
  socket.on("game:round", (r) => { skew = r.serverTime - Date.now(); round = r; chosen = 0; shownState = null; syncStage(); paintClock(); });
  socket.on("game:state", (r) => { skew = r.serverTime - Date.now(); round = r; syncStage(); paintClock(); });
  socket.on("game:shuffle", (s) => { if (round && round.roundId === s.roundId) { round.shuffleStart = s.shuffleStart; round.shuffle = s.swaps; } });
  socket.on("game:reveal", (r) => { if (round && round.roundId === r.roundId) { round.hiddenPosition = r.hiddenPosition; round.seed = r.seed; shownState = null; syncStage(); } });
  socket.on("game:result", (s) => {
    if (myBet && myBet.roundId === s.roundId) { myBet.result = s.won ? "WIN" : "LOSE"; myBet.payout = s.payout; }
    myResults[s.roundId] = s.won ? "WIN" : "LOSE";
    balance = s.balance;
    paintBalance(s.won);
    const b = $("banner");
    b.hidden = false;
    b.className = "banner " + (s.won ? "win" : "lose");
    b.textContent = s.won ? "YOU WON " + money(s.payout) : "SPOT " + s.hiddenPosition + " · YOU LOSE";
    paintBet();
    if (s.won) { setTimeout(() => { confetti(); sfx.win(); winOverlay(s.payout); }, 700); }
    else setTimeout(sfx.lose, 700);
  });
  function winOverlay(amount) {
    const el = $("winover"), amt = $("winAmt");
    el.hidden = false;
    const start = performance.now(), dur = 1600;
    (function tick(t) { const k = Math.min(1, (t - start) / dur); amt.textContent = money(amount * (1 - Math.pow(1 - k, 3))); if (k < 1 && !el.hidden) requestAnimationFrame(tick); else amt.textContent = money(amount); })(start);
    const close = () => { el.hidden = true; el.removeEventListener("click", close); };
    el.addEventListener("click", close);
    setTimeout(close, 4200);
  }
  socket.on("bet:mine", (m) => { myBet = m.bet ? { ...m.bet, result: null, payout: 0 } : null; balance = m.balance; paintBalance(); paintBet(); });
  socket.on("wallet", (w) => { balance = w.balance; paintBalance(true); });
  socket.on("players:count", (n) => { $("players").querySelector("b").textContent = n; });
  socket.on("game:bets", (b) => { $("roundBets").textContent = b.bets + (b.bets === 1 ? " bet" : " bets") + " on this round · " + money(b.wagered) + " wagered"; });
  socket.on("game:error", (e) => toast(e.message, "err"));
  socket.on("connect_error", (e) => toast("Can't reach the table: " + e.message, "err"));

  /* the history grows as rounds reveal */
  socket.on("game:reveal", (r) => {
    if (!history.some((h) => h.roundId === r.roundId)) { history.unshift({ roundId: r.roundId, hiddenPosition: r.hiddenPosition, seed: r.seed }); history.length = Math.min(history.length, C.HISTORY); }
    setTimeout(paintHistory, 600);
  });

  /* ---------------- controls ---------------- */
  document.querySelectorAll(".spot").forEach((b) => b.addEventListener("click", () => { if (b.disabled) return; chosen = Number(b.dataset.spot); paintBet(); }));
  $("chips").innerHTML = CHIPS.map((v) => '<button class="chip" type="button" data-chip="' + v + '" style="--c:' + chipColor(v) + '">' + (v >= 1000 ? "1K" : v) + "</button>").join("");
  $("chips").addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (!c || c.disabled) return; amount = Number(c.dataset.chip); paintBet(); });
  $("placeBtn").addEventListener("click", () => {
    if (!chosen) return toast("Pick Spot 1, 2 or 3 first.", "err");
    if (amount > balance) return toast("Not enough credits — top up from the bottom of the page.", "err");
    $("placeBtn").disabled = true;
    socket.emit("bet:place", { spot: chosen, amount }, (r) => {
      if (!r || r.error) { paintBet(); return; }
      myBet = { ...r.bet, result: null, payout: 0 }; balance = r.balance; chosen = 0;
      paintBalance(); paintBet(); placeChip(r.bet.spot, r.bet.amount);
      toast("Bet placed: " + money(r.bet.amount) + " on Spot " + r.bet.spot + ".");
    });
  });
  $("clearBtn").addEventListener("click", () => {
    if (myBet && round && myBet.roundId === round.roundId) {
      socket.emit("bet:clear", null, (r) => { if (!r || r.error) return; myBet = null; balance = r.balance; paintBalance(); paintBet(); removeChip(false); toast("Bet cleared — your stake is back."); });
    } else { chosen = 0; paintBet(); }
  });
  $("topup").addEventListener("click", () => socket.emit("wallet:topup", null, (r) => { if (r && r.ok) { balance = r.balance; paintBalance(true); toast("Demo credits topped up to " + money(r.balance) + "."); } }));

  /* the dev box: on when the server says so (DEV_INDICATOR=1) or with ?dev=1 */
  fetch("api/config").then((r) => r.json()).then((c) => { if (c.dev || new URLSearchParams(location.search).get("dev") === "1") $("dev").hidden = false; }).catch(() => {});

  /* the page's own clock only repaints what the server's timestamps already fixed */
  setInterval(() => { paintClock(); syncStage(); }, 200);
  paintBet();
})();
