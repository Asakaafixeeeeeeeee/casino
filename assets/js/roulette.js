/* Roulette — 13-pocket mini roulette (0–12) on a green felt.
   State machine:  BETTING (pick a chip, tap the felt) → SPINNING (wheel overlay) → RESULT (win pop-up or a quiet
   loss) → BETTING with a clear table. AUTO PLAY repeats the last bet until it's switched off.
   Fairness: the pocket is drawn uniformly from the 13 when SPIN is pressed; the wheel then plays a spin that ends
   there. Pays (stake back included): number ×12, row ×3, even-money ×2 — every bet returns 12/13 = 92.3%.
   The wheel is drawn by roulette-wheel.js; balance, menu, sounds and confetti come from the mini-game kit. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const RW = window.VBRouletteWheel;
  const $ = (id) => document.getElementById(id);

  const CHIPS = [0.1, 1, 10, 20, 100];
  const CHIP_COLORS = { 0.1: "#64748b", 1: "#1e88e5", 10: "#e53935", 20: "#2e7d32", 100: "#111827" };
  const MAX_STAKE = 2000;     /* the most on the table in one round */
  const AUTO_MAX = 50;
  const HISTORY_MAX = 100;
  const HISTORY_KEY = "voltabet.roulette.history";

  /* every spot: the numbers it covers and what it returns per unit staked (stake included) */
  const SPOTS = {};
  for (let n = 0; n <= 12; n++) SPOTS["n" + n] = { nums: [n], x: 12, label: String(n) };
  SPOTS.c1 = { nums: [1, 4, 7, 10], x: 3, label: "C1" };
  SPOTS.c2 = { nums: [2, 5, 8, 11], x: 3, label: "C2" };
  SPOTS.c3 = { nums: [3, 6, 9, 12], x: 3, label: "C3" };
  SPOTS.red = { nums: [...RW.RED], x: 2, label: "Red" };
  SPOTS.black = { nums: [2, 4, 6, 8, 10, 11], x: 2, label: "Black" };
  SPOTS.odd = { nums: [1, 3, 5, 7, 9, 11], x: 2, label: "Odd" };
  SPOTS.even = { nums: [2, 4, 6, 8, 10, 12], x: 2, label: "Even" };
  SPOTS.low = { nums: [1, 2, 3, 4, 5, 6], x: 2, label: "1-6" };
  SPOTS.high = { nums: [7, 8, 9, 10, 11, 12], x: 2, label: "7-12" };

  let phase = "BETTING";      /* BETTING → SPINNING → RESULT → BETTING */
  let chip = 1;
  let bets = {};              /* spot → amount */
  let placed = [];            /* the order chips went down, for RESET */
  let lastBets = null;        /* the last spun layout, for AUTO PLAY */
  let auto = 0;               /* rounds left on AUTO PLAY (0 = off) */
  let history = [];
  let tipShown = false;

  const kit = window.VBMini.create({
    prefix: "rl",
    winSound: "chipsPayout",   /* this game's own win sound (minigame.js SFX) */
    gameId: "roulette",
    server: true,         /* real-money rounds are drawn and settled by the server */
    minBet: 0.1,
    tableMax: MAX_STAKE,
    chips: [],
    busy: () => phase !== "BETTING",
    busyText: "Wait for the wheel to stop before switching.",
    onChange: () => paint(),
    confettiFrom: () => $("rlWin").querySelector(".rl-win-card")
  });
  const { money, round2, announce } = kit;
  const ghs = (v) => "GHS " + money(v);

  try {
    history = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]").filter((n) => Number.isInteger(n) && n >= 0 && n <= 12);
  } catch (e) { /* storage unavailable */ }

  /* ---------------- sound ---------------- */
  function click(freq, vol, len) {
    const ac = kit.audio();
    if (!ac) return;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + len);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + len + 0.02);
  }
  const chipSound = () => { kit.flick(); click(2400, 0.06, 0.05); };
  /* the ball rattling over the frets as it drops in */
  const tick = (speed) => click(1800 + speed * 1600, 0.05 + speed * 0.06, 0.03);
  /* the ball rolling round the track: filtered noise that fades as it slows */
  function roll(ms) {
    const ac = kit.audio();
    if (!ac) return;
    const t = ac.currentTime, dur = ms / 1000;
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 3;
    bp.frequency.setValueAtTime(1300, t);
    bp.frequency.exponentialRampToValueAtTime(500, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(ac.destination);
    src.start(t);
  }

  const wheel = RW.create($("rlWheel"), { reduceMotion: kit.reduceMotion, onTick: tick });

  /* ---------------- the felt ---------------- */
  const board = $("rlBoard");
  [[3, 6, 9, 12, "c3"], [2, 5, 8, 11, "c2"], [1, 4, 7, 10, "c1"]].forEach((row, r) => {
    row.slice(0, 4).forEach((n, c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "rl-spot rl-num rl-" + RW.colorOf(n);
      b.dataset.spot = "n" + n;
      b.style.gridRow = String(r + 1);
      b.style.gridColumn = String(c + 2);
      b.innerHTML = "<b>" + n + "</b>";
      board.appendChild(b);
    });
    const col = document.createElement("button");
    col.type = "button";
    col.className = "rl-spot rl-col";
    col.dataset.spot = row[4];
    col.style.gridRow = String(r + 1);
    col.style.gridColumn = "6";
    col.innerHTML = "<b>" + row[4].toUpperCase() + "</b><small>2:1</small>";
    board.appendChild(col);
  });
  const spotEls = {};
  document.querySelectorAll(".rl-spot").forEach((el) => {
    spotEls[el.dataset.spot] = el;
    el.setAttribute("aria-label", "Bet on " + SPOTS[el.dataset.spot].label);
  });

  /* a stack of real chips on a spot (the biggest denomination on top, up to 4 high) with the total on a tag */
  const ART = window.VBRouletteArt;
  document.body.style.setProperty("--rl-felt-tex", "url(" + ART.felt() + ")");
  function chipFace(amount, spot) {
    const top = CHIPS.slice().reverse().find((v) => amount >= v - 1e-9) || CHIPS[0];
    const count = placed.filter(([k]) => k === spot).length || 1;
    const img = ART.chip(top, CHIP_COLORS[top], 30, { stack: Math.min(4, count) });
    return '<span class="rl-chip-on"><img alt="" src="' + img.url + '" style="width:' + img.w + "px;height:" + img.h + 'px"><em>' + short(amount) + "</em></span>";
  }
  const short = (v) => (v >= 1000 ? round2(v / 1000) + "K" : v >= 100 ? Math.round(v) : String(round2(v)));

  function paintSpots(winning) {
    Object.keys(spotEls).forEach((k) => {
      const el = spotEls[k];
      el.querySelector(".rl-chip-on")?.remove();
      if (bets[k]) el.insertAdjacentHTML("beforeend", chipFace(bets[k], k));
      el.classList.toggle("is-hit", !!winning && SPOTS[k].nums.includes(winning.n));
    });
  }

  const totalStake = () => round2(Object.values(bets).reduce((a, b) => a + b, 0));

  function place(spot) {
    if (phase !== "BETTING") return;
    if (auto) stopAuto();
    const add = chip;
    if (totalStake() + add > MAX_STAKE + 1e-9) {
      U.toast("The most you can stake in one round is " + ghs(MAX_STAKE) + ".", "err");
      return;
    }
    if (totalStake() + add > kit.balance() + 1e-9) {
      kit.canAfford(totalStake() + add);
      return;
    }
    kit.unlockAudio();
    bets[spot] = round2((bets[spot] || 0) + add);
    placed.push([spot, add]);
    chipSound();
    paint();
    const el = spotEls[spot].querySelector(".rl-chip-on");
    if (el && !kit.reduceMotion) el.classList.add("is-new");
    if (!tipShown) {
      tipShown = true;
      U.toast("Tap 'Clear' to remove the chip.", "");
    }
    announce(ghs(add) + " on " + SPOTS[spot].label + ". Total stake " + ghs(totalStake()) + ".");
  }

  /* ---------------- painting ---------------- */
  function paint(winning) {
    const betting = phase === "BETTING";
    paintSpots(winning);
    $("rlStake").textContent = ghs(totalStake());
    $("rlSpin").disabled = !betting && !auto;
    $("rlSpin").textContent = auto ? "STOP" : "SPIN";
    $("rlClear").disabled = !betting || !placed.length;
    $("rlReset").disabled = !betting || !placed.length;
    document.querySelectorAll(".rl-chip-btn").forEach((b) => {
      const v = Number(b.dataset.v);
      b.setAttribute("aria-checked", String(v === chip));
      b.disabled = !betting;
    });
    $("rlAuto").setAttribute("aria-pressed", String(!!auto));
    $("rlAutoLabel").textContent = auto ? "AUTO " + auto : "AUTO PLAY";
    paintHistory();
  }

  function badge(n) {
    return '<li class="rl-badge rl-' + RW.colorOf(n) + '">' + n + "</li>";
  }
  function paintHistory() {
    $("rlBadges").innerHTML = history.slice(0, 12).map(badge).join("") || '<li class="rl-empty">No spins yet</li>';
  }

  /* ---------------- chips ---------------- */
  CHIPS.forEach((v) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rl-chip-btn";
    b.dataset.v = v;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", "Chip " + v);
    const img = ART.chip(v, CHIP_COLORS[v], 50);
    b.innerHTML = '<img alt="" src="' + img.url + '">';
    b.addEventListener("click", () => {
      chip = v;
      chipSound();
      paint();
    });
    $("rlChipRow").appendChild(b);
  });

  /* ---------------- a round ---------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function spin() {
    if (phase !== "BETTING") return;
    const stake = totalStake();
    if (!stake) {
      U.toast("Place a chip on the table first.", "");
      if (auto) stopAuto();
      return;
    }
    if (!kit.canAfford(stake)) {
      if (auto) stopAuto();
      return;
    }
    kit.unlockAudio();
    phase = "SPINNING";
    lastBets = { ...bets };
    paint();
    const round = await kit.place(stake, { bets: { ...bets } });
    if (round === false) {
      phase = "BETTING";
      paint();
      if (auto) stopAuto();
      return;
    }
    /* the pocket: drawn by the server for real money, here with credits */
    const n = round ? round.outcome.pocket : Math.floor(Math.random() * 13);
    announce("Spinning. Total stake " + ghs(stake) + ".");

    /* the table dims, the wheel slides in */
    const ov = $("rlWheelOv");
    $("rlResult").hidden = true;
    ov.hidden = false;
    document.body.classList.add("is-spinning");
    await sleep(kit.reduceMotion ? 50 : 450);
    roll(kit.reduceMotion ? 1100 : 5400);
    await wheel.spin(n);

    /* the result */
    const col = RW.colorOf(n);
    const res = $("rlResult");
    res.className = "rl-result rl-" + col;
    res.innerHTML = "<b>" + n + "</b><span>" + (col === "green" ? "ZERO" : col.toUpperCase()) + "</span>";
    res.hidden = false;
    history.unshift(n);
    history = history.slice(0, HISTORY_MAX);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch (e) { /* storage unavailable */ }
    const win = round ? round.payout : round2(Object.keys(bets).reduce((a, k) => a + (SPOTS[k].nums.includes(n) ? bets[k] * SPOTS[k].x : 0), 0));
    phase = "RESULT";
    paint({ n });
    announce("The ball lands on " + n + (col === "green" ? "." : ", " + col + ".") + (win ? " You win " + ghs(win) + "." : " No win."));
    await sleep(1300);
    ov.hidden = true;
    document.body.classList.remove("is-spinning");
    wheel.idle();

    kit.collect(win);
    if (win > 0) {
      $("rlWinAmt").textContent = ghs(win);
      $("rlWinSub").textContent = "Ball on " + n + " · stake " + ghs(stake);
      await showWin(auto ? 1800 : 6000);
    } else {
      await sleep(700);
    }

    /* the table clears for the next round */
    bets = {};
    placed = [];
    phase = "BETTING";
    paint();
    if (auto) nextAuto();
  }

  function showWin(ms) {
    const el = $("rlWin");
    el.hidden = false;
    ART.cups($("rlCups"));
    kit.celebrate();
    return new Promise((res) => {
      const close = () => {
        clearTimeout(t);
        el.hidden = true;
        $("rlWinOk").removeEventListener("click", close);
        el.removeEventListener("click", outside);
        res();
      };
      const outside = (e) => { if (e.target === el) close(); };
      const t = setTimeout(close, ms);
      $("rlWinOk").addEventListener("click", close);
      el.addEventListener("click", outside);
    });
  }

  /* ---------------- AUTO PLAY ---------------- */
  function nextAuto() {
    if (!auto || !lastBets) return stopAuto();
    const stake = round2(Object.values(lastBets).reduce((a, b) => a + b, 0));
    if (stake > kit.balance() + 1e-9) {
      U.toast("AUTO PLAY stopped: not enough balance for the bet.", "err");
      return stopAuto();
    }
    auto--;
    bets = { ...lastBets };
    placed = Object.entries(bets);
    paint();
    setTimeout(() => (auto || placed.length) && phase === "BETTING" && spin(), 700);
    if (!auto) setTimeout(() => paint(), 800);
  }
  function stopAuto() {
    auto = 0;
    paint();
  }
  $("rlAuto").addEventListener("click", () => {
    if (auto) return stopAuto();
    const layout = totalStake() ? { ...bets } : lastBets;
    if (!layout) {
      U.toast("Place a bet first — AUTO PLAY repeats it every round.", "");
      return;
    }
    lastBets = layout;
    auto = AUTO_MAX;
    announce("AUTO PLAY on: your bet repeats every round. Tap again to stop.");
    if (phase === "BETTING") {
      if (totalStake()) {
        auto--;
        paint();
        spin();
      } else nextAuto();
    } else paint();
  });

  /* ---------------- buttons ---------------- */
  document.querySelector(".rl-felt").addEventListener("click", (e) => {
    const s = e.target.closest(".rl-spot");
    if (s) place(s.dataset.spot);
  });
  $("rlSpin").addEventListener("click", () => (auto ? stopAuto() : spin()));
  $("rlClear").addEventListener("click", () => {
    if (phase !== "BETTING") return;
    bets = {};
    placed = [];
    paint();
    announce("All chips removed.");
  });
  $("rlReset").addEventListener("click", () => {
    if (phase !== "BETTING" || !placed.length) return;
    const [spot, amt] = placed.pop();
    bets[spot] = round2(bets[spot] - amt);
    if (bets[spot] <= 1e-9) delete bets[spot];
    paint();
    announce("Took back " + ghs(amt) + " from " + SPOTS[spot].label + ".");
  });

  const hist = $("rlHistory");
  window.VBMini.backdropClose(hist);
  $("rlHistoryBtn").addEventListener("click", () => {
    const c = { red: 0, black: 0, green: 0 };
    history.forEach((n) => c[RW.colorOf(n)]++);
    $("rlHistStats").textContent = history.length
      ? "Last " + history.length + " spins — red " + c.red + " · black " + c.black + " · zero " + c.green + ". Each spin is independent."
      : "No spins yet.";
    $("rlHistAll").innerHTML = history.map(badge).join("");
    hist.showModal();
  });

  /* the floating lights in the win pop-up */
  const lights = document.querySelector(".rl-lights");
  for (let i = 0; i < 16; i++) {
    const s = document.createElement("i");
    s.style.setProperty("--x", Math.random() * 100 + "%");
    s.style.setProperty("--d", 2.5 + Math.random() * 3 + "s");
    s.style.setProperty("--s", 4 + Math.random() * 10 + "px");
    s.style.animationDelay = -Math.random() * 5 + "s";
    lights.appendChild(s);
  }

  paint();
})();
