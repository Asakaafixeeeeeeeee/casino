/* Rendo Bottle — spin the bottle and call UP or DOWN; a correct call pays 2x and the MIDDLE line loses.
   A local state machine drives each round:  IDLE (choose a bet) → SPINNING (about 2s) → RESULT (Rebet / New Round).
   The bottle stops at a uniformly random angle and the result is simply where it lands — nothing is steered.
   The balance, bet controls, menu, sounds and confetti come from the shared mini-game kit (minigame.js). */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  const PAYOUT = 2;
  const MIDDLE_HALF = 3.6;   // each MIDDLE wedge spans ±3.6° of the line: 2 × 7.2° = 4% of the circle
  const SPIN_MIN_MS = 3000;  // each spin lasts 3–4 seconds (set on the bottle's transition per spin)
  const SPIN_MAX_MS = 4000;

  const table = $("sbTable");
  let phase = "IDLE";  /* IDLE → SPINNING → RESULT */
  let angle = 0;       /* bottle rotation in degrees */
  let last = null;     /* { side, stake } — what Rebet repeats */

  const kit = window.VBMini.create({
    prefix: "sb",
    winSound: "clink",   /* this game's own win sound (minigame.js SFX) */
    gameId: "volta-bottle",
    server: true,         /* real-money rounds are drawn and settled by the server */
    minBet: 0.5,
    tableMax: 50000,
    chips: [0.5, 1, 5, 10, 50, 100, 500],
    busy: () => phase === "SPINNING",
    busyText: "Wait for the bottle to stop before switching.",
    onChange: () => paint(),
    confettiFrom: () => table
  });
  const { money, round2, announce } = kit;

  /* UP and DOWN each cover 48% of the circle and pay 2x, so the return is 96% */
  const RTP = Math.round(PAYOUT * ((180 - 2 * MIDDLE_HALF) / 360) * 1000) / 10;
  $("sbRtp").textContent = RTP + "%";
  $("sbRulesRtp").textContent = RTP + "%";

  /* ---------------- where the bottle points ---------------- */
  /* 0° = neck pointing right, angles grow clockwise, so 270° points straight UP */
  function outcomeAt(deg) {
    const d = ((deg % 360) + 360) % 360;
    if (d < MIDDLE_HALF || d > 360 - MIDDLE_HALF || Math.abs(d - 180) < MIDDLE_HALF) return "MIDDLE";
    return d > 180 ? "UP" : "DOWN";
  }

  /* ---------------- the bottle and its lighting ---------------- */
  let bottle = $("sbBottle");

  /* the lamp hangs above the table: the glare belongs on whichever side of the bottle faces up the screen.
     --light-a cross-fades the artwork's two lighting layers (1 = its top edge faces the lamp, 0 = its bottom edge) */
  function light(deg) {
    bottle.style.setProperty("--light-a", ((1 + Math.cos((deg * Math.PI) / 180)) / 2).toFixed(3));
  }

  /* while spinning, read the bottle's live angle every frame so the glare stays with the lamp */
  function followLight() {
    if (phase !== "SPINNING") return;
    const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(bottle).transform);
    if (m) {
      const [a, b] = m[1].split(",").map(Number);
      light((Math.atan2(b, a) * 180) / Math.PI);
    }
    requestAnimationFrame(followLight);
  }

  /* swap the <img> for the same artwork inline, so its lighting layers can be driven from here;
     if that fails (e.g. the page was opened from disk) the plain image stays, lit from one side */
  fetch(bottle.getAttribute("src"))
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
    .then((markup) => {
      const holder = document.createElement("div");
      holder.innerHTML = markup;
      const art = holder.querySelector("svg");
      art.removeAttribute("width");
      art.removeAttribute("height");
      art.id = "sbBottle";
      art.setAttribute("class", "sb-bottle");
      art.setAttribute("aria-hidden", "true");
      art.style.cssText = bottle.style.cssText; /* keeps the current angle */
      bottle.replaceWith(art);
      bottle = art;
      light(angle);
    })
    .catch(() => { /* keep the image */ });

  /* ---------------- round state machine ---------------- */
  const sideButtons = Array.from(document.querySelectorAll("[data-side]"));

  function paint() {
    const busy = phase === "SPINNING";
    $("sbResult").hidden = phase !== "RESULT";
    sideButtons.forEach((b) => {
      b.hidden = phase === "RESULT";
      b.setAttribute("aria-disabled", String(busy));
      b.classList.toggle("picked", busy && !!last && b.dataset.side === last.side);
    });
    $("sbRebet").hidden = $("sbNew").hidden = phase !== "RESULT";
    kit.paintBet(busy);
  }

  /* turns the bottle forward several times and lands it at `landing` degrees */
  function spinTo(landing, done) {
    /* restart from the resting angle (0–360) without animating, so the numbers never grow huge */
    bottle.style.transition = "none";
    angle = ((angle % 360) + 360) % 360;
    bottle.style.setProperty("--angle", angle + "deg");
    void bottle.offsetWidth;
    bottle.style.transition = "";

    const ms = kit.reduceMotion ? 400 : SPIN_MIN_MS + Math.random() * (SPIN_MAX_MS - SPIN_MIN_MS);
    bottle.style.setProperty("--spin-ms", Math.round(ms) + "ms");
    kit.play("bottleRoll", ms);   /* the bottle rolling round on the table */
    /* clockwise (the angle only ever grows). Kept to 4–5 turns with a gentle start: much faster and the bottle — which
       looks almost the same end to end — moves so far between frames that the eye reads it as turning backwards */
    const turns = 4 + Math.floor(Math.random() * 2);
    angle += turns * 360 + ((landing - angle + 360) % 360);
    bottle.style.setProperty("--angle", angle + "deg");

    let settled = false;
    const end = () => {
      if (settled) return;
      settled = true;
      done();
    };
    bottle.addEventListener("transitionend", end, { once: true });
    setTimeout(end, ms + 150); /* in case transitionend never fires (hidden tab, reduced motion) */
  }

  /* resolves true once the bottle is spinning, false if the bet didn't go through */
  async function play(side, stake) {
    if (phase === "SPINNING") return false;
    if (!kit.canAfford(stake)) return false;
    kit.unlockAudio();
    last = { side, stake };
    phase = "SPINNING"; /* locks the table while the bet is placed */
    delete table.dataset.result;
    paint();
    const round = await kit.place(stake, { side });
    if (round === false) {
      phase = "IDLE";
      paint();
      return false;
    }
    announce("Spinning. You called " + side + " for GHS " + money(stake) + ".");
    /* for real money the server chose where it lands; with free credits it's drawn here */
    const landing = round ? round.outcome.landing : Math.random() * 360;
    spinTo(landing, () => finish(outcomeAt(landing), side, stake, round));
    requestAnimationFrame(followLight);
    return true;
  }

  function finish(result, side, stake, round) {
    const won = result === side;
    const win = round ? round.payout : won ? round2(stake * PAYOUT) : 0;
    kit.collect(win);
    phase = "RESULT";
    light(angle); /* the glare settles for the resting position */
    table.dataset.result = result;

    const badge = $("sbBadge");
    badge.textContent = result;
    badge.className = "mg-badge is-" + result.toLowerCase();
    const msg = $("sbMsg");
    msg.className = "mg-msg" + (won ? " win" : "");
    msg.textContent = won ? "You Won 🏆 GHS " + money(win)
      : result === "MIDDLE" ? "It stopped on the MIDDLE line — sorry, that's a loss."
      : "Sorry, you chose " + side + "!";
    $("sbRebetInfo").textContent = side + " · " + money(stake);
    paint();
    if (won) kit.celebrate();
    announce(result + ". " + msg.textContent);
  }

  function newRound() {
    phase = "IDLE";
    delete table.dataset.result;
    paint();
  }

  sideButtons.forEach((b) => b.addEventListener("click", () => {
    if (phase === "IDLE") play(b.dataset.side, kit.bet());
  }));
  $("sbRebet").addEventListener("click", () => {
    if (phase === "RESULT" && last) play(last.side, last.stake).then((ok) => { if (!ok) newRound(); });
  });
  $("sbNew").addEventListener("click", () => {
    if (phase === "RESULT") newRound();
  });

  paint();
})();
