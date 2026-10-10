/* Magic Ball — three cups, one ball. Put chips on up to two spots; the cups lift together and the spot with the ball
   pays 2.9x. A local state machine drives each round:
     SHUFFLING (the cups swap about) → IDLE (chips on spots, Place Bet) → REVEAL (the cups lift) → RESULT (Shuffle Again)
   The ball's spot is drawn at random when the bet is placed — one time in three each. The shuffle is for show: the
   ball is never seen going under a cup, so there is nothing to follow, and nothing is steered.
   The balance, chips, menu, sounds and confetti come from the shared mini-game kit (minigame.js). */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);

  const PAYOUT = 2.9;
  const MIN_BET = 0.2;
  const SPOT_MAX = 10000;      // the most one spot takes
  const MAX_SPOTS = 2;
  const CHIPS = [0.2, 1, 5, 10, 50, 500];
  const LIFT_MS = 650;         // matches the cups' CSS transition
  const COLLECT_MS = 260;      // the ball is taken away before the cups come down
  const SWAPS = [380, 340, 300, 270, 250, 250, 290, 340];   // one shuffle: quick in the middle, settling at the end

  const stage = $("mbStage");
  const cupsBox = $("mbCups");
  const ball = $("mbBall");
  const go = $("mbGo");
  const cups = Array.from(cupsBox.querySelectorAll(".mb-cup"));
  const spotButtons = Array.from(document.querySelectorAll(".mb-spot"));
  const marks = Array.from(document.querySelectorAll(".mb-mark"));
  const SUBTITLE = $("mbMsg").textContent;

  let phase = "IDLE";              /* SHUFFLING → IDLE → REVEAL → RESULT → SHUFFLING … */
  const bets = { 1: 0, 2: 0, 3: 0 }; /* the chips on each spot, in GHS */
  let ballSpot = 0;
  const slots = [0, 1, 2];         /* slots[i]: the slot cup i stands on (0 = SPOT 1) */

  const kit = window.VBMini.create({
    prefix: "mb",
    winSound: "sparkle",   /* this game's own win sound (minigame.js SFX) */
    gameId: "magic-ball",
    server: true,         /* real-money rounds are drawn and settled by the server */
    minBet: MIN_BET,
    tableMax: SPOT_MAX,
    chips: CHIPS,
    busy: () => phase === "REVEAL",
    busyText: "Wait for the cups to lift before switching.",
    onChange: () => paint(),
    confettiFrom: () => stage
  });
  const { money, round2, announce } = kit;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* a spot wins one time in three and pays 2.9x: 96.7% */
  const RTP = Math.round((PAYOUT / 3) * 1000) / 10;
  $("mbRtp").textContent = RTP + "%";
  $("mbRulesRtp").textContent = RTP + "%";

  /* ---------------- chips on spots ---------------- */
  const chosen = () => [1, 2, 3].filter((n) => bets[n] > 0);
  const total = () => round2(bets[1] + bets[2] + bets[3]);
  const names = (spots) => spots.map((n) => "SPOT " + n).join(" and ");
  /* chip labels: 0.2 · 5 · 12.5 · 1K · 2.5K · 10K */
  const short = (v) => (v >= 1000 ? +(v / 1000).toFixed(2) + "K" : String(+v.toFixed(2)));
  const chipColor = (v) => (v >= 500 ? "#7b1fa2" : v >= 50 ? "#ef6c00" : v >= 10 ? "#2e7d32" : v >= 5 ? "#e53935" : v >= 1 ? "#1e88e5" : "#78909c");
  const locked = () => phase === "REVEAL" || phase === "RESULT";

  function addChip(n) {
    if (locked()) return;
    if (!bets[n] && chosen().length >= MAX_SPOTS) {
      U.toast("You can bet on up to two SPOTS — clear your chips to change spots.", "err");
      return;
    }
    if (bets[n] >= SPOT_MAX) {
      U.toast("A spot takes at most GHS 10,000.", "err");
      return;
    }
    const add = Math.min(kit.bet(), round2(SPOT_MAX - bets[n]));
    if (!kit.canAfford(round2(total() + add))) return;
    kit.unlockAudio();
    kit.flick();
    bets[n] = round2(bets[n] + add);
    paint();
    announce("SPOT " + n + ": GHS " + money(bets[n]) + ".");
  }

  function clearChips() {
    if (locked() || !chosen().length) return;
    bets[1] = bets[2] = bets[3] = 0;
    paint();
    announce("Chips cleared.");
  }

  /* ---------------- painting ---------------- */
  function paintGo() {
    const spots = chosen();
    let state = "bet";
    let off = false;
    let html;
    if (phase === "SHUFFLING") {
      state = "shuffling";
      off = true;
      html = '<b>Shuffling<span class="mb-bars" aria-hidden="true"><i></i><i></i><i></i></span></b>';
    } else if (phase === "REVEAL") {
      state = "shuffling";
      off = true;
      html = "<b>Lifting the cups…</b>";
    } else if (phase === "RESULT") {
      state = "again";
      html = "<b>Shuffle Again</b>";
    } else if (spots.length) {
      html = "<b>Place Bet ( SPOT " + spots.join(" + ") + " )</b> <span>Total GHS " + money(total()) + "</span>";
    } else {
      off = true;
      html = "<b>Place Bet</b> <span>Tap a spot to put your chips on it</span>";
    }
    go.dataset.state = state;
    go.setAttribute("aria-disabled", String(off));
    go.innerHTML = html;
  }

  function paint() {
    const lock = locked();
    spotButtons.forEach((b) => {
      const n = Number(b.dataset.spot);
      const v = bets[n];
      const chip = b.querySelector(".mb-spot-chip");
      b.classList.toggle("has-bet", v > 0);
      b.setAttribute("aria-disabled", String(lock));
      b.setAttribute("aria-label", "SPOT " + n + (v ? ": GHS " + money(v) + " on it" : ": no chips") +
        (lock ? "" : ". Tap to add GHS " + money(kit.bet()) + "."));
      chip.hidden = !v;
      if (v && chip.textContent !== short(v)) {
        chip.textContent = short(v);
        chip.style.setProperty("--c", chipColor(v));
      }
    });
    marks.forEach((m) => m.classList.toggle("is-on", bets[m.dataset.spot] > 0));
    $("mbClear").disabled = lock || !chosen().length;
    $("mbReshuffle").disabled = phase === "SHUFFLING" || phase === "REVEAL";
    kit.paintBet(lock);
    paintGo();
  }

  function showResult(win) {
    const badge = $("mbBadge");
    const msg = $("mbMsg");
    badge.hidden = false;
    badge.textContent = "SPOT " + ballSpot;
    badge.className = "mb-badge " + (win ? "is-win" : "is-loss");
    msg.className = "mb-msg " + (win ? "win" : "loss");
    msg.textContent = win ? "You Won 🏆 GHS " + money(win) : "Sorry, you chose " + names(chosen()) + "!";
    marks.forEach((m) => m.classList.toggle("is-ball", Number(m.dataset.spot) === ballSpot));
    spotButtons.forEach((b) => b.classList.toggle("is-ball", Number(b.dataset.spot) === ballSpot));
    stage.dataset.result = $("mbSpots").dataset.result = win ? "win" : "loss";
  }

  function clearResult() {
    $("mbBadge").hidden = true;
    $("mbMsg").className = "mb-msg";
    $("mbMsg").textContent = SUBTITLE;
    marks.forEach((m) => m.classList.remove("is-ball"));
    spotButtons.forEach((b) => b.classList.remove("is-ball"));
    delete stage.dataset.result;
    delete $("mbSpots").dataset.result;
  }

  /* ---------------- the cups ---------------- */
  /* one swap: the two cups trade places along arcs, one passing in front (lower and larger), the other behind */
  function swap(cup, from, to, front, ms) {
    const x = (s) => (s - 1) * 133.333;
    cup.style.setProperty("--slot", to);
    cup.style.zIndex = front ? 3 : 1;
    const anim = cup.animate([
      { transform: "translateX(" + x(from) + "%) translateY(0%) scale(1)", filter: "blur(0px)" },
      { transform: "translateX(" + (x(from) + x(to)) / 2 + "%) translateY(" + (front ? 9 : -9) + "%) scale(" + (front ? 1.06 : 0.94) + ")",
        filter: "blur(1.6px)", offset: 0.5 },
      { transform: "translateX(" + x(to) + "%) translateY(0%) scale(1)", filter: "blur(0px)" }
    ], { duration: ms, easing: "cubic-bezier(.45, .05, .55, .95)" });
    anim.onfinish = () => (cup.style.zIndex = "");
  }

  async function swapCups() {
    if (kit.reduceMotion) {
      await sleep(120);
      return;
    }
    cupsBox.classList.add("is-shuffling");
    let last = "";
    for (const ms of SWAPS) {
      let a;
      let b;
      do {
        a = Math.floor(Math.random() * 3);
        b = Math.floor(Math.random() * 3);
      } while (a === b || [a, b].sort().join() === last);   /* never the same pair twice running */
      last = [a, b].sort().join();
      const ca = cups[slots.indexOf(a)];
      const cb = cups[slots.indexOf(b)];
      swap(ca, a, b, true, ms);
      swap(cb, b, a, false, ms);
      slots[cups.indexOf(ca)] = b;
      slots[cups.indexOf(cb)] = a;
      kit.play("cupSlide");
      await sleep(ms);
    }
    cupsBox.classList.remove("is-shuffling");
  }

  /* the next round: the ball is taken away, the cups come down and are shuffled */
  async function shuffleRound() {
    if (phase === "SHUFFLING" || phase === "REVEAL") return;
    const wasUp = cupsBox.classList.contains("is-up");
    phase = "SHUFFLING";
    clearResult();
    paint();
    announce("Shuffling the cups.");
    if (wasUp) {
      ball.classList.remove("is-in", "is-win");
      ball.classList.add("is-gone");
      await sleep(kit.reduceMotion ? 0 : COLLECT_MS);
      cupsBox.classList.remove("is-up");
      await sleep(kit.reduceMotion ? 0 : LIFT_MS);
    }
    await swapCups();
    phase = "IDLE";
    paint();
    announce("The cups are shuffled. Put your chips on a spot and place your bet.");
  }

  /* ---------------- a round ---------------- */
  async function placeBet() {
    if (phase !== "IDLE") return;
    const spots = chosen();
    if (!spots.length) {
      U.toast("Tap SPOT 1, 2 or 3 to put your chips on it first.", "");
      return;
    }
    const stake = total();
    if (!kit.canAfford(stake)) return;
    kit.unlockAudio();
    phase = "REVEAL"; /* locks the table while the bet is placed */
    paint();
    const round = await kit.place(stake, { bets: Object.fromEntries(spots.map((s) => [s, bets[s]])) });
    if (round === false) {
      phase = "IDLE";
      paint();
      return;
    }
    /* one time in three for each spot: drawn by the server for real money, here with credits */
    ballSpot = round ? round.outcome.ball : 1 + Math.floor(Math.random() * 3);
    /* the ball goes under its cup out of sight (no slide), then the cups lift together */
    ball.classList.add("no-anim");
    ball.classList.remove("is-gone", "is-win");
    ball.style.setProperty("--slot", ballSpot - 1);
    void ball.offsetWidth;
    ball.classList.remove("no-anim");
    ball.classList.add("is-in");
    paint();
    announce("Bet placed: GHS " + money(stake) + " on " + names(spots) + ". The cups are lifting.");
    cupsBox.classList.add("is-up");
    setTimeout(() => finish(round), kit.reduceMotion ? 30 : LIFT_MS);
  }

  function finish(round) {
    const win = round ? round.payout : bets[ballSpot] ? Math.floor(bets[ballSpot] * PAYOUT * 100 + 1e-6) / 100 : 0;
    kit.collect(win);
    phase = "RESULT";
    ball.classList.toggle("is-win", !!win);
    showResult(win);
    paint();
    if (win) kit.celebrate();
    announce("The ball is under SPOT " + ballSpot + ". " + $("mbMsg").textContent);
  }

  /* ---------------- controls ---------------- */
  spotButtons.forEach((b) => b.addEventListener("click", () => addChip(Number(b.dataset.spot))));
  $("mbClear").addEventListener("click", clearChips);
  $("mbReshuffle").addEventListener("click", () => {
    kit.unlockAudio();
    shuffleRound();
  });
  /* a new chip value changes what a tap on a spot adds */
  $("mbChips").addEventListener("click", () => paint());
  go.addEventListener("click", () => {
    if (phase === "IDLE") placeBet();
    else if (phase === "RESULT") {
      kit.unlockAudio();
      shuffleRound();
    }
  });

  paint();
  shuffleRound();   /* the table opens with a shuffle */
})();
