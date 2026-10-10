/* Even-Odd — three dice; call the total EVEN or ODD. Pays 2x; any triple loses.
   State machine:  IDLE (bet, then EVEN or ODD) → ROLLING (dice tumble) → RESULT (Rebet or New Round) → IDLE.
   Fairness: the three dice are fair, independent 1–6, rolled the moment a call is made; 105 of the 216 rolls win
   for each call, so the return is 2 × 105/216 = 97.2%.
   The dice are CSS 3D cubes: each tumbles from where it lies to a pose showing its rolled face. The balance, bet
   slider, chips, menu, sounds and confetti come from the mini-game kit (minigame.js). */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);

  const MIN_BET = 0.2;
  const TABLE_MAX = 15000;
  const CHIPS = [0.2, 1, 5, 10, 50, 100];
  const ROLL_MS = 1500;

  /* which way to turn a cube so face n looks at the viewer (faces: front 1, top 2, right 3, left 4, bottom 5, back 6) */
  const POSE = { 1: [0, 0], 2: [-90, 0], 3: [0, -90], 4: [0, 90], 5: [90, 0], 6: [0, 180] };
  /* the resting tilt each die is seen at, so three faces of the cube show */
  const TILT = [[-18, 22, -6], [-20, -4, 4], [-16, -24, 8]];
  const PIPS = {   /* positions on a 3×3 grid: 0..8 */
    1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8]
  };

  let phase = "IDLE";   /* IDLE → ROLLING → RESULT */
  let last = null;      /* { pick, stake } for Rebet */

  const kit = window.VBMini.create({
    prefix: "eo",
    winSound: "tada",   /* this game's own win sound (minigame.js SFX) */
    gameId: "even-odd",
    server: true,         /* real-money rounds are drawn and settled by the server */
    minBet: MIN_BET,
    tableMax: TABLE_MAX,
    chips: CHIPS,
    busy: () => phase === "ROLLING",
    busyText: "Wait for the dice to settle before switching.",
    onChange: () => paint(),
    confettiFrom: () => $("eoStage")
  });
  const { money, round2, announce } = kit;
  const ghs = (v) => "GHS " + money(v);

  /* ---------------- the dice ---------------- */
  const dice = [0, 1, 2].map((i) => {
    const wrap = document.createElement("div");
    wrap.className = "eo-die-wrap";
    const cube = document.createElement("div");
    cube.className = "eo-die is-idle";
    for (let f = 1; f <= 6; f++) {
      const face = document.createElement("div");
      face.className = "eo-face eo-f" + f;
      face.innerHTML = Array.from({ length: 9 }, (_, k) => '<i class="' + (PIPS[f].includes(k) ? "on" : "") + '"></i>').join("");
      cube.appendChild(face);
    }
    /* three inner planes fill the rounded corners, so the cube reads as one solid block */
    cube.insertAdjacentHTML("afterbegin", '<span class="eo-core eo-cx"></span><span class="eo-core eo-cy"></span><span class="eo-core eo-cz"></span>');
    /* idle: the front face carries the house mark instead of a number */
    const mark = document.createElement("div");
    mark.className = "eo-mark";
    mark.textContent = "₵";
    cube.querySelector(".eo-f1").appendChild(mark);
    wrap.appendChild(cube);
    wrap.insertAdjacentHTML("beforeend", '<span class="eo-shadow"></span>');
    $("eoDice").appendChild(wrap);
    const pose = { x: 0, y: 0, z: 0 };   /* the cube's own turn, applied after the die's resting tilt */
    cube.style.transform = transformOf(i, pose);
    return { wrap, cube, pose, i };
  });

  /* the tilt the die rests at, then its own turn (so the rolled face ends up facing the viewer) */
  function transformOf(i, p) {
    const [tx, ty, tz] = TILT[i];
    return "rotateX(" + tx + "deg) rotateY(" + ty + "deg) rotateZ(" + (tz + p.z) + "deg) rotateX(" + p.x + "deg) rotateY(" + p.y + "deg)";
  }

  /* tumbles die d onto face n: a few whole turns about each axis, ending on the face's pose with the die's tilt */
  function tumble(d, n) {
    const [fx, fy] = POSE[n];
    const turnsX = (2 + Math.floor(Math.random() * 2)) * 360 * (Math.random() < 0.5 ? 1 : -1);
    const turnsY = (2 + Math.floor(Math.random() * 2)) * 360 * (Math.random() < 0.5 ? 1 : -1);
    const from = d.pose;
    const to = { x: fx + turnsX, y: fy + turnsY, z: (Math.random() - 0.5) * 16 };
    /* the cube spins (fast, then slowing); the wrapper hops, bounces twice and lands */
    const ms = kit.reduceMotion ? 200 : ROLL_MS + d.i * 160;
    d.cube.classList.remove("is-idle");
    const spin = d.cube.animate([{ transform: transformOf(d.i, from) }, { transform: transformOf(d.i, to) }],
      { duration: ms, easing: "cubic-bezier(.15,.6,.25,1)", fill: "forwards" });
    d.wrap.animate([
      { transform: "translateY(0)" },
      { transform: "translateY(-46%)", offset: 0.22 },
      { transform: "translateY(0)", offset: 0.45 },
      { transform: "translateY(-16%)", offset: 0.6 },
      { transform: "translateY(0)", offset: 0.74 },
      { transform: "translateY(-5%)", offset: 0.84 },
      { transform: "translateY(0)" }
    ], { duration: ms, easing: "ease-out" });
    /* a clack each time it lands */
    if (!kit.reduceMotion) [0.45, 0.74, 0.99].forEach((k, j) => setTimeout(() => clack(1 - j * 0.3), ms * k));
    d.pose = { x: ((to.x % 360) + 360) % 360, y: ((to.y % 360) + 360) % 360, z: to.z };
    return spin.finished.then(() => {
      d.cube.style.transform = transformOf(d.i, d.pose);
      spin.cancel();
    });
  }

  /* ---------------- sound: the rattle in the cup and the clack on the felt ---------------- */
  function burst(dur, f, vol, q) {
    const ac = kit.audio();
    if (!ac) return;
    const t = ac.currentTime;
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const bp = ac.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = f;
    bp.Q.value = q || 4;
    const g = ac.createGain();
    g.gain.value = vol;
    src.connect(bp).connect(g).connect(ac.destination);
    src.start(t);
  }
  const clack = (k) => { burst(0.05, 2200 + Math.random() * 800, 0.5 * k, 6); burst(0.04, 900, 0.3 * k, 3); };
  function rattle() {
    for (let i = 0; i < 12; i++) setTimeout(() => burst(0.03, 2600 + Math.random() * 1400, 0.22, 8), i * 45 + Math.random() * 25);
  }

  /* ---------------- painting ---------------- */
  function paint() {
    const idle = phase === "IDLE";
    kit.paintBet(!idle);
    $("eoMax").textContent = kit.maxBet() >= 1000 ? round2(kit.maxBet() / 1000) + "K" : money(kit.maxBet());
    document.querySelectorAll("[data-pick]").forEach((b) => {
      b.hidden = phase === "RESULT";
      b.setAttribute("aria-disabled", String(!idle));
    });
    $("eoRebet").hidden = $("eoNew").hidden = phase !== "RESULT";
    if (last) $("eoRebetInfo").textContent = last.pick + " · " + money(last.stake);
  }

  /* the net change floats up from the wallet pill: "+0.20" or "−0.20" */
  function net(v) {
    const el = $("eoNet");
    el.textContent = (v >= 0 ? "+" : "−") + money(Math.abs(v));
    el.className = "eo-net " + (v >= 0 ? "up" : "down");
    void el.offsetWidth;
    el.classList.add("show");
  }

  /* ---------------- a round ---------------- */
  async function roll(pick, stake) {
    if (phase !== "IDLE" && phase !== "RESULT") return;
    if (stake == null) stake = kit.bet();
    if (!kit.canAfford(stake)) {
      if (phase === "RESULT") newRound();
      return;
    }
    kit.unlockAudio();
    last = { pick, stake };
    phase = "ROLLING";
    $("eoResult").hidden = true;
    $("eoTotal").hidden = true;
    document.querySelectorAll("[data-pick]").forEach((b) => b.classList.toggle("picked", b.dataset.pick === pick));
    paint();
    const round = await kit.place(stake, { pick });
    if (round === false) {
      phase = "IDLE";
      document.querySelectorAll("[data-pick]").forEach((b) => b.classList.remove("picked"));
      paint();
      return;
    }
    /* the roll: drawn by the server for real money, here with free credits */
    const faces = round ? round.outcome.faces : [0, 1, 2].map(() => 1 + Math.floor(Math.random() * 6));
    announce("You called " + pick + " for " + ghs(stake) + ". Rolling.");
    rattle();
    await Promise.all(dice.map((d, i) => tumble(d, faces[i])));

    const total = faces[0] + faces[1] + faces[2];
    const triple = faces[0] === faces[1] && faces[1] === faces[2];
    const side = total % 2 ? "ODD" : "EVEN";
    const won = !triple && side === pick;
    const win = round ? round.payout : won ? round2(stake * 2) : 0;

    const tot = $("eoTotal");
    tot.textContent = (triple ? "Triple · " : "") + "Total " + total;
    tot.className = "eo-total" + (triple ? " is-triple" : "");
    tot.hidden = false;
    if (triple) dice.forEach((d) => d.wrap.classList.add("is-triple"));

    const badge = $("eoBadge");
    badge.textContent = triple ? "TRIPLE" : side;
    badge.className = "mg-badge " + (triple ? "eo-b-triple" : side === "EVEN" ? "eo-b-even" : "eo-b-odd");
    const msg = $("eoMsg");
    if (won) {
      msg.className = "mg-msg win";
      msg.innerHTML = "You Won 🏆 " + ghs(win);
      kit.collect(win);
      net(win - stake);
      kit.celebrate();
    } else {
      kit.collect(0);
      msg.className = "mg-msg";
      msg.textContent = triple ? "Triple " + faces[0] + "s — every bet loses." : "Sorry, you chose " + pick + "!";
      net(-stake);
    }
    $("eoResult").hidden = false;
    $("eoResult").classList.toggle("is-win", won);
    phase = "RESULT";
    paint();
    announce("Dice " + faces.join(", ") + ": total " + total + (triple ? ", a triple — the bet loses." : ", " + side + ". ") +
      (won ? "You win " + ghs(win) + "." : triple ? "" : "You lose."));
  }

  function newRound() {
    phase = "IDLE";
    $("eoResult").hidden = true;
    $("eoTotal").hidden = true;
    dice.forEach((d) => d.wrap.classList.remove("is-triple"));
    document.querySelectorAll("[data-pick]").forEach((b) => b.classList.remove("picked"));
    paint();
  }

  document.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
    if (phase === "IDLE") roll(b.dataset.pick);
  }));
  $("eoRebet").addEventListener("click", () => {
    if (phase !== "RESULT" || !last) return;
    dice.forEach((d) => d.wrap.classList.remove("is-triple"));
    roll(last.pick, last.stake);
  });
  $("eoNew").addEventListener("click", () => phase === "RESULT" && newRound());

  kit.setBet(MIN_BET);
  paint();
})();
