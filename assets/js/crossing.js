/* Rendo Crossing — help the hen across a busy road one lane at a time. Every lane she reaches raises the multiplier;
   cash out whenever you like, or keep going until a car gets her.
   A local state machine drives each round:  IDLE (choose difficulty and a bet) → ACTIVE (Go, Go, … or Cash out) →
   back to IDLE on a cash-out, a hit, or reaching the far side.
   Fairness: how far the hen gets is drawn once, the moment Bet is pressed — a single uniform number u, and she is hit
   on the first lane k where u ≥ 97% ÷ multiplier(k). So the chance of reaching lane k is exactly 97% ÷ its
   multiplier, and every cash-out plan returns 97% on average. Nothing is steered after that.
   The scene is drawn by crossing-art.js; the balance, menu, sounds and confetti come from the mini-game kit. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);

  const RTP = 0.97;
  const MAX_WIN = 100000;     /* the most one round can pay */
  const MIN_BET = 0.1;
  const TABLE_MAX = 10000;
  const STRIKE_DELAY_MS = 140;    /* the car comes this long after she lands */
  const RESULT_HOLD_MS = 2800;    /* the result stays on the road this long before it resets */

  /* how the risk grows across the road on each difficulty: the risk of lane n (from 0) is a + b·n + c·n²; the
     multipliers come from it and are rounded to 0.01. Only the rounded multipliers matter for the draw. */
  const LEVELS = {
    easy:   { name: "Easy",   lanes: 24, a: 0.04,   b: 0.002, c: 0.0004, traffic: 0.8 },
    medium: { name: "Medium", lanes: 22, a: 0.1565, b: 0.002, c: 0.0012, traffic: 1 },
    hard:   { name: "Hard",   lanes: 20, a: 0.24,   b: 0.006, c: 0.0012, traffic: 1.2 },
    expert: { name: "Expert", lanes: 15, a: 0.38,   b: 0.01,  c: 0.0015, traffic: 1.45 }
  };

  const tables = {};
  function table(key) {
    if (tables[key]) return tables[key];
    const L = LEVELS[key];
    const out = [];
    let alive = 1, prev = 0;
    for (let n = 0; n < L.lanes; n++) {
      alive *= 1 - (L.a + L.b * n + L.c * n * n);
      let m = Math.round((RTP / alive) * 100) / 100;
      if (m <= prev) m = Math.round((prev + 0.01) * 100) / 100;
      out.push(m);
      prev = m;
    }
    return (tables[key] = out);
  }
  /* the chance of getting through lane i (from 0) and every lane before it */
  const reachChance = (key, i) => RTP / table(key)[i];
  window.VBCrossing = { RTP, LEVELS, table, reachChance };

  const fmtX = (m) => (m < 1000 ? m.toFixed(2) : m < 100000 ? Math.round(m).toLocaleString("en-GH") : Math.round(m / 1000).toLocaleString("en-GH") + "K") + "x";

  const stage = $("cxStage");
  const goBtn = $("cxGo");
  const cashBtn = $("cxCash");
  const betInput = $("cxBet");
  const diffSel = $("cxDiff");
  const pop = $("cxPop");

  let level = "medium";
  let phase = "IDLE";   /* IDLE → ACTIVE → IDLE */
  let round = null;     /* { stake, level, at, fate, busy, result } */
  let resetTimer = 0;

  const kit = window.VBMini.create({
    prefix: "cx",
    winSound: "whistle",   /* this game's own win sound (minigame.js SFX) */
    gameId: "volta-crossing",
    server: true,         /* real-money rounds: the server draws how far she gets and judges every lane */
    minBet: MIN_BET,
    tableMax: TABLE_MAX,
    chips: [],
    busy: () => phase === "ACTIVE",
    busyText: "Cash out or finish your crossing before switching.",
    onChange: () => paint(),
    confettiFrom: () => stage,
    confettiStyle: "coins"
  });
  const { money, round2, announce } = kit;

  /* ---------------- sound: a car horn and a tyre screech, made with the kit's audio context ---------------- */
  function honk() {
    const ac = kit.audio();
    if (!ac) return;
    const t = ac.currentTime;
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1600;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.09, t + 0.02);
    gain.gain.setValueAtTime(0.09, t + 0.32);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    lp.connect(gain).connect(ac.destination);
    [392, 494].forEach((f) => {
      const osc = ac.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + 0.45);
    });
  }

  /* a car going by: engine growl that drops in pitch as it passes (Doppler) under a burst of tyre and wind noise.
     Louder the closer the lane is to the hen; at most a few at a time so busy traffic doesn't turn to mush. */
  let passing = 0;
  function passBy(p) {
    const ac = kit.audio();
    if (!ac || passing >= 3) return;
    const vol = Math.max(0, 1 - p.near * 0.28) * (p.speed > 2 ? 1.3 : 1);
    if (vol < 0.12) return;
    passing++;
    const t = ac.currentTime;
    const dur = 0.9;
    const out = ac.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.16 * vol, t + dur * 0.42);
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let dest = ac.destination;
    if (ac.createStereoPanner) {
      const pan = ac.createStereoPanner();
      pan.pan.setValueAtTime(p.pan, t);
      pan.connect(ac.destination);
      dest = pan;
    }
    out.connect(dest);
    /* engine: two detuned saws through a low-pass, pitch falling past the hen */
    const f0 = 70 + Math.random() * 40;
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 520;
    lp.connect(out);
    [1, 1.51].forEach((k) => {
      const osc = ac.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(f0 * k * 1.12, t);
      osc.frequency.linearRampToValueAtTime(f0 * k * 0.86, t + dur);
      const g = ac.createGain();
      g.gain.value = k === 1 ? 0.55 : 0.25;
      osc.connect(g).connect(lp);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    });
    /* tyres and wind */
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 0.7;
    bp.frequency.setValueAtTime(1400, t);
    bp.frequency.exponentialRampToValueAtTime(600, t + dur);
    const ng = ac.createGain();
    ng.gain.value = 0.5;
    src.connect(bp).connect(ng).connect(out);
    src.start(t);
    src.onended = () => passing--;
  }

  /* the hen when she's hit: a short, rough squawk — "b-KAW!" — a reedy voice that jumps up and cracks down */
  function squawk() {
    const ac = kit.audio();
    if (!ac) return;
    const t = ac.currentTime;
    const out = ac.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
    out.gain.setValueAtTime(0.2, t + 0.06);
    out.gain.exponentialRampToValueAtTime(0.06, t + 0.09);     /* the little break between "b" and "KAW" */
    out.gain.exponentialRampToValueAtTime(0.24, t + 0.12);
    out.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    /* a throaty formant filter */
    const f1 = ac.createBiquadFilter();
    f1.type = "bandpass";
    f1.frequency.value = 1500;
    f1.Q.value = 2.2;
    f1.connect(out).connect(ac.destination);
    const osc = ac.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(620, t);
    osc.frequency.exponentialRampToValueAtTime(980, t + 0.1);
    osc.frequency.exponentialRampToValueAtTime(1350, t + 0.16);
    osc.frequency.exponentialRampToValueAtTime(520, t + 0.42);
    /* a fast flutter makes it sound alive rather than electronic */
    const lfo = ac.createOscillator();
    const depth = ac.createGain();
    lfo.frequency.value = 38;
    depth.gain.value = 70;
    lfo.connect(depth).connect(osc.frequency);
    osc.connect(f1);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 0.45);
    lfo.stop(t + 0.45);
  }

  let lastScreech = 0;
  function screech() {
    const ac = kit.audio();
    if (!ac || performance.now() - lastScreech < 900) return;
    lastScreech = performance.now();
    const t = ac.currentTime;
    const len = Math.floor(ac.sampleRate * 0.45);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.5);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 9;
    bp.frequency.setValueAtTime(2900, t);
    bp.frequency.linearRampToValueAtTime(2200, t + 0.45);
    const gain = ac.createGain();
    gain.gain.value = 0.22;
    src.connect(bp).connect(gain).connect(ac.destination);
    src.start(t);
  }

  const scene = window.VBCrossingArt.create($("cxCanvas"), { reduceMotion: kit.reduceMotion, onHonk: honk, onScreech: screech, onPass: passBy });
  /* browsers only allow sound after a tap: start it on the first one anywhere, so the traffic can be heard at once */
  document.addEventListener("pointerdown", () => kit.unlockAudio(), { once: true });

  /* ---------------- painting ---------------- */
  const setDisabled = (btn, off) => btn.setAttribute("aria-disabled", String(!!off));
  const mults = () => table(round ? round.level : level);
  /* rounded down to the cent, so a small bet never pays more than its multiplier */
  const payout = (stake, m) => Math.min(MAX_WIN, Math.floor(stake * m * 100 + 1e-6) / 100);

  function paintBadges() {
    scene.setBadges((i) => {
      if (!round) return i === 0 ? "next" : "";
      const r = round;
      if (r.result === "lost") return i === r.at + 1 ? "lost" : i <= r.at ? "passed" : "";
      if (r.result === "win") return i === r.at ? "win" : i < r.at ? "passed" : "";
      if (i < r.at) return "passed";
      if (i === r.at) return "current";
      if (i === r.at + 1) return "next";
      return "";
    });
  }

  function paint() {
    const active = phase === "ACTIVE";
    const busy = active && round.busy;
    const t = mults();

    /* Cash out: live once she has made it across at least one lane */
    const canCash = active && round.at >= 0 && !busy;
    setDisabled(cashBtn, !canCash);
    cashBtn.classList.toggle("is-ready", canCash);
    cashBtn.innerHTML = "<b>Cash out</b>" + (active && round.at >= 0 ? " <span>GHS " + money(payout(round.stake, t[round.at])) + "</span>" : "");

    /* the main button: Bet to start, then Go for each lane */
    if (active) {
      const next = t[round.at + 1];
      goBtn.dataset.state = "go";
      goBtn.innerHTML = "<b>Go</b>" + (next ? "<span>Next " + fmtX(next) + "</span>" : "");
      setDisabled(goBtn, busy || next === undefined);
    } else {
      goBtn.dataset.state = "bet";
      goBtn.innerHTML = "<b>Bet</b><span>First lane " + fmtX(table(level)[0]) + "</span>";
      setDisabled(goBtn, false);
    }

    kit.paintBet(active);
    if (document.activeElement !== betInput) betInput.value = money(kit.bet());
    betInput.disabled = active;
    $("cxHalf").disabled = active;
    $("cxDouble").disabled = active;
    diffSel.disabled = active;
    $("cxMax").textContent = fmtX(table(level)[table(level).length - 1]);
    paintBadges();
  }

  /* ---------------- the win pop-up over the lane ---------------- */
  function showPop(i, mult, win) {
    const p = scene.laneScreen(i);
    pop.style.left = p.x + "px";
    pop.style.top = p.y + "px";
    pop.innerHTML = "<b>" + fmtX(mult) + "</b><span>GHS " + money(win) + "</span>";
    pop.hidden = false;
    pop.classList.remove("show");
    void pop.offsetWidth;
    pop.classList.add("show");
  }

  /* ---------------- a round ---------------- */
  function clearResult() {
    clearTimeout(resetTimer);
    pop.hidden = true;
    if (phase !== "ACTIVE") {
      round = null;
      scene.reset();
      scene.setLight("red");
      paint();
    }
  }

  let starting = false;
  async function start() {
    if (phase !== "IDLE" || starting) return;
    const stake = kit.bet();
    if (!kit.canAfford(stake)) return;
    kit.unlockAudio();
    clearResult();
    /* real money: the server takes the stake and draws how far she gets, keeping it secret until the round ends */
    let session = null;
    let fate;
    if (kit.isReal()) {
      starting = true;
      const r = await kit.request("start", { stake, params: { level }, idempotency_key: "round:" + crypto.randomUUID() });
      starting = false;
      if (!r) return;
      kit.showBalance(r.balance);
      session = r.session_id;
    } else {
      kit.move(-stake);
      /* the draw: she is hit on the first lane whose reach chance is below u (none → she gets across) */
      const u = Math.random();
      const t = table(level);
      fate = t.findIndex((m, i) => u >= reachChance(level, i));
      if (fate < 0) fate = Infinity;
    }
    round = { stake, level, at: -1, fate, busy: false, result: null, session, answer: null };
    phase = "ACTIVE";
    scene.setLight("green");
    announce("Bet placed: GHS " + money(stake) + " on " + LEVELS[level].name + ". The hen steps out.");
    step();
  }

  async function step() {
    if (phase !== "ACTIVE" || round.busy) return;
    const next = round.at + 1;
    if (next >= mults().length) return;
    round.busy = true;
    paint();
    if (round.session) {   /* the server says what happens on this lane before she hops */
      const r = await kit.request("step", { session_id: round.session });
      if (!r || phase !== "ACTIVE") {
        round.busy = false;
        paint();
        return;
      }
      round.answer = r;
    }
    scene.hop(next, () => land(next));
  }

  function land(i) {
    if (phase !== "ACTIVE") return;
    const hit = round.session ? round.answer.status === "LOST" : i === round.fate;
    if (hit) {
      setTimeout(() => scene.strike(i, () => lose(i)), STRIKE_DELAY_MS);
      return;
    }
    round.at = i;
    round.busy = false;
    scene.barricade(i);
    kit.play("cluck", i);
    const t = mults();
    const pay = payout(round.stake, t[i]);
    /* the far side, or the top prize, pays out by itself (for real money the server already has) */
    if (round.session && round.answer.status === "WON") {
      finishWin(round.answer.payout, round.answer.balance);
      return;
    }
    if (!round.session && (i === t.length - 1 || round.stake * t[i] >= MAX_WIN)) {
      cashOut();
      return;
    }
    paint();
    announce("Safe at " + fmtX(t[i]) + ". Cash out GHS " + money(pay) + ", or go on for " + fmtX(t[i + 1]) + ".");
  }

  async function cashOut() {
    if (phase !== "ACTIVE" || round.at < 0 || round.busy) return;
    if (round.session) {
      round.busy = true;
      const r = await kit.request("cashout", { session_id: round.session });
      round.busy = false;
      if (!r || phase !== "ACTIVE") return;
      finishWin(r.payout, r.balance);
      return;
    }
    finishWin(payout(round.stake, mults()[round.at]));
  }

  /* the round is won: real money passes the server's balance, credits are paid here */
  function finishWin(win, serverBalance) {
    const t = mults();
    const mult = t[round.at];
    phase = "IDLE";
    round.result = "win";
    if (serverBalance === undefined) kit.move(win);
    else kit.showBalance(serverBalance, win);
    scene.cheer();
    scene.setLight("green");
    const shown = win < round2(round.stake * mult) - 0.01 ? win / round.stake : mult;   /* only differs when capped */
    showPop(round.at, shown, win);
    paint();
    const across = round.at === t.length - 1;
    if (across) U.toast("Made it across! " + fmtX(shown) + " · Win GHS " + money(win), "ok");
    announce((across ? "The hen made it across. " : "Cashed out at ") + fmtX(shown) + ". You win GHS " + money(win) + ".");
    if (mult >= 2) kit.celebrate();
    else kit.play("whistle", false);
    resetTimer = setTimeout(clearResult, RESULT_HOLD_MS);
  }

  function lose(i) {
    phase = "IDLE";
    round.result = "lost";
    round.busy = false;
    scene.setLight("amber");
    squawk();
    kit.play("thump");
    if (navigator.vibrate) navigator.vibrate(180);
    paint();
    announce("Hit by a car on lane " + (i + 1) + " (" + fmtX(mults()[i]) + "). The bet is lost.");
    resetTimer = setTimeout(clearResult, RESULT_HOLD_MS);
  }

  /* ---------------- controls ---------------- */
  goBtn.addEventListener("click", () => {
    if (goBtn.getAttribute("aria-disabled") === "true") return;
    if (phase === "IDLE") start();
    else step();
  });
  cashBtn.addEventListener("click", () => {
    if (cashBtn.getAttribute("aria-disabled") === "true") {
      if (phase !== "ACTIVE") U.toast("Press Bet to start a crossing.", "");
      return;
    }
    cashOut();
  });

  /* tapping the next manhole hops to it */
  $("cxCanvas").addEventListener("click", (e) => {
    const lane = scene.laneAt(e.clientX);
    if (phase === "ACTIVE" && lane === round.at + 1) step();
    else if (phase === "IDLE" && lane === 0) start();
  });

  function readBet() {
    const v = parseFloat(String(betInput.value).replace(/,/g, ""));
    if (isFinite(v)) kit.setBet(v);
    betInput.value = money(kit.bet());
    paint();
  }
  betInput.addEventListener("change", readBet);
  betInput.addEventListener("blur", readBet);
  betInput.addEventListener("focus", () => betInput.select());
  betInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") betInput.blur();
  });
  $("cxHalf").addEventListener("click", () => { kit.setBet(kit.bet() / 2); paint(); });
  $("cxDouble").addEventListener("click", () => { kit.setBet(kit.bet() * 2); paint(); });

  Object.keys(LEVELS).forEach((k) => {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = LEVELS[k].name;
    diffSel.appendChild(o);
  });
  diffSel.value = level;
  diffSel.addEventListener("change", () => {
    if (phase === "ACTIVE") return;
    level = diffSel.value;
    clearResult();
    scene.setLanes(table(level), fmtX);
    scene.setTraffic(LEVELS[level].traffic);
    paint();
  });

  /* the odds table in the rules */
  function paintRules() {
    $("cxRulesRtp").textContent = RTP * 100 + "%";
    $("cxRtp").textContent = RTP * 100 + "%";
    $("cxOdds").innerHTML = Object.keys(LEVELS).map((k) => {
      const t = table(k);
      return "<tr><th>" + LEVELS[k].name + "</th><td>" + LEVELS[k].lanes + "</td><td>" + fmtX(t[0]) + "</td><td>" +
        (reachChance(k, 0) * 100).toFixed(1) + "%</td><td>" + fmtX(t[t.length - 1]) + "</td></tr>";
    }).join("");
  }

  scene.setLanes(table(level), fmtX);
  scene.setTraffic(LEVELS[level].traffic);
  paintRules();
  paint();

  /* a real-money round left open (the page was closed or reloaded) carries on from the lane she reached */
  if (kit.isReal()) {
    kit.request("open").then((r) => {
      if (!r || !r.session || phase !== "IDLE") return;
      const sess = r.session;
      level = sess.state.level;
      diffSel.value = level;
      scene.setLanes(table(level), fmtX);
      scene.setTraffic(LEVELS[level].traffic);
      round = { stake: sess.stake, level, at: sess.state.at, fate: undefined, busy: false, result: null, session: sess.session_id, answer: null };
      phase = "ACTIVE";
      if (round.at >= 0) scene.place(round.at);
      scene.setLight("green");
      paint();
      U.toast("Your round in progress is back — go on or cash out.", "ok");
    });
  }
})();
