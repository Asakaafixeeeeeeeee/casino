/* Rendo Wings — a red biplane takes off from one carrier and has to land on another. On the way it flies through
   pickups (+1 +2 +5 +10 add to the multiplier, ×2 … ×5 multiply it) and bombs (−50%, and the plane drops a little): 6–10 of them a flight. More numbers and bombs float in the
   sky off its line; they're scenery and never touch the plane.
   Land on the second ship and the bet pays × the multiplier, up to ×250; come down in the sea and it is lost.
   The whole flight — its events and whether it reaches the ship — is drawn the moment Play is pressed, and the
   animation just shows it: nothing is steered, and nothing during the flight changes it.
   A local state machine:  IDLE → FLYING (roll down the deck, climb, cruise, then land or ditch) → IDLE with the result.
   The balance, menu and sounds come from the shared mini-game kit (minigame.js); the artwork from wings-art.js. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const ART = window.VBWingsArt;
  const $ = (id) => document.getElementById(id);

  /* ---------------- the maths: what a flight can hold ---------------- */
  const EVENTS = [
    { label: "+1", kind: "add", value: 1, weight: 300 },
    { label: "+2", kind: "add", value: 2, weight: 90 },
    { label: "+5", kind: "add", value: 5, weight: 22 },
    { label: "+10", kind: "add", value: 10, weight: 6 },
    { label: "×2", kind: "mul", value: 2, weight: 80 },
    { label: "×3", kind: "mul", value: 3, weight: 20 },
    { label: "×4", kind: "mul", value: 4, weight: 6 },
    { label: "×5", kind: "mul", value: 5, weight: 2 },
    { label: "-50%", kind: "rocket", value: 0.5, weight: 474 }
  ];
  /* the route: a stretch of events, then a carrier, then the next stretch … The flight can end anywhere on it: on each
     stretch the plane may go down in the sea before it reaches the next carrier, and over each carrier it reaches it
     may land. Past the last carrier the fuel runs out. */
  const SEGMENT = [2, 3];        // events on each stretch, equally likely
  const SHIPS = 6;               // carriers along the route
  const CAP = 250;               // the multiplier never goes past ×250
  const DOWN_PER_STRETCH = 0.3;  // chance of going down in the sea on each stretch, before its carrier
  /* At each carrier it reaches, the plane lands with this chance. The multiplier is kept in whole cents and rounded
     down after every event, so every reachable value is one of 0.00 … 250.00 and the return can be summed exactly:
     the average multiplier on reaching carrier 1…6 is 2.2978 3.3196 4.1185 4.7325 5.1951 5.5377, and with a 30% chance
     of going down on each stretch, landing with chance 19.2660060661% at each carrier makes
     Σ (1−q)^(k−1)·0.7^k·q·E[mult at carrier k] = 0.970000000000 — a 97% return. 30.0% of flights land; most flights
     end — on a deck or in the sea — within the first two or three carriers. */
  const LAND_PER_SHIP = 0.192660060661;
  let landSum = 0;
  for (let k = 1; k <= 6; k++) landSum += Math.pow(1 - LAND_PER_SHIP, k - 1) * Math.pow(1 - DOWN_PER_STRETCH, k) * LAND_PER_SHIP;
  const LAND_CHANCE = landSum;
  const RTP = 97;

  /* the multiplier in whole cents: additions and multiplications stay whole, a bomb halves it rounding down */
  const applyC = (c, ev) => Math.min(CAP * 100, ev.kind === "add" ? c + 100 * ev.value : ev.kind === "mul" ? c * ev.value : Math.floor(c / 2));
  const apply = (m, ev) => applyC(Math.round(m * 100), ev) / 100;

  /* a whole flight, drawn from a source of random numbers in [0, 1): segments of events with a ship after each,
     and at each ship a draw for whether it lands there */
  function plan(rand) {
    const total = EVENTS.reduce((s, e) => s + e.weight, 0);
    const events = [];
    const steps = [];
    const ships = [];              /* how many events come before each ship it reaches */
    let c = 100;
    let landed = false;
    for (let k = 0; k < SHIPS && !landed; k++) {   /* a stretch: its events, then the chance of going down, then the carrier */
      const n = SEGMENT[Math.floor(rand() * SEGMENT.length)];
      for (let i = 0; i < n; i++) {
        let r = rand() * total;
        const ev = EVENTS.find((e) => (r -= e.weight) < 0) || EVENTS[EVENTS.length - 1];
        c = applyC(c, ev);
        events.push(ev);
        steps.push(c / 100);
      }
      ships.push(events.length);
      if (rand() < DOWN_PER_STRETCH) return { events, steps, ships, landed: false, landAt: -1, downAt: k, final: c / 100 };
      landed = rand() < LAND_PER_SHIP;
    }
    return { events, steps, ships, landed, landAt: landed ? ships.length - 1 : -1, downAt: -1, final: c / 100 };
  }
  /* the odds are public: the rules quote them, and anyone can check them from here */
  window.VBWings = { EVENTS, SEGMENT, SHIPS, CAP, DOWN_PER_STRETCH, LAND_PER_SHIP, LAND_CHANCE, RTP, plan, apply };

  /* ---------------- the world ---------------- */
  const SEA = ART.SEA_Y;
  const DECK = ART.DECK_Y;
  const SHIP = ART.CARRIER_L;
  const START_X = 20;            // the first carrier's stern
  const ON_DECK = DECK - 6;      // the plane's centre with its wheels on the deck
  const CRUISE = 44;             // the cruising height after take-off: low, so there's sky above to climb into
  const FLOOR = SEA - 46;        // rockets can knock the plane down, but never below this before the landing
  const V = 110;                 // cruise speed, units per second at normal speed
  const RUN_X = 150;             // a rocket streaks in from this far ahead of where it meets the plane…
  const RUN_Y = 40;              // …and this far below
  const SPEEDS = [{ name: "Normal", x: 1 }, { name: "Fast", x: 2 }, { name: "Turbo", x: 4 }];
  const SPEED_KEY = "voltabet.wings.speed";

  const MIN_BET = 0.1;
  const TABLE_MAX = 100;
  const LADDER = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];

  const stage = $("wgStage");
  const canvas = $("wgCanvas");
  const playBtn = $("wgPlay");
  let phase = "IDLE";            /* IDLE → FLYING → IDLE */

  const kit = window.VBMini.create({
    prefix: "wg",
    winSound: "fanfare",   /* this game's own win sound (minigame.js SFX) */
    gameId: "volta-wings",
    server: true,         /* real-money flights are drawn and settled by the server */
    minBet: MIN_BET,
    tableMax: TABLE_MAX,
    chips: [],
    busy: () => phase === "FLYING",
    busyText: "Wait for the plane to come down before switching.",
    onChange: () => paint(),
    confettiFrom: () => stage,
    confettiStyle: "coins"
  });
  const { money, round2, announce } = kit;
  kit.setBet(0.5);
  $("wgRtp").textContent = RTP + "%";
  $("wgRulesRtp").textContent = RTP + "%";
  $("wgRulesLand").textContent = (LAND_CHANCE * 100).toFixed(1) + "%";
  $("wgRulesShip").textContent = (LAND_PER_SHIP * 100).toFixed(2) + "%";
  $("wgRulesDown").textContent = Math.round(DOWN_PER_STRETCH * 100) + "%";
  $("wgOdds").textContent = EVENTS.map((e) => (e.kind === "rocket" ? "bomb" : e.label) + " " + (e.weight / 10) + "%").join(" · ");

  const unit = () => (kit.mode() === "fun" ? "FUN" : "GHS");
  const smooth = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  /* ×1.0 · ×2.5 · ×1.25 · ×146.5 */
  const fmtM = (m) => {
    const s = String(Math.round(m * 100) / 100);
    return "×" + (s.includes(".") ? s : s + ".0");
  };

  /* ---------------- a flight's path, worked out in advance ---------------- */
  function layout(p) {
    const xLift = START_X + SHIP - 6;
    /* the route: a run of events, then a ship under the plane, then the next run … */
    const items = [];
    const ships = [];
    let x = xLift + 150;
    p.ships.forEach((upTo, k) => {
      for (let i = k ? p.ships[k - 1] : 0; i < upTo; i++) {
        items.push({ ev: p.events[i], x: x + (((i * 37) % 15) - 7), m: p.steps[i] });
        x += 95;   /* room between numbers to see it sink toward the sea before the next one lifts it */
      }
      /* the ship, a little past the run's last event — or, when the plane goes down on this stretch, far enough on
         that its glide into the sea comes down well short of it */
      const sx = x + (p.downAt === k ? 560 : 60);
      ships.push({ x: sx, landing: p.landed && k === p.landAt });
      x = sx + SHIP + 100;                      /* the next run starts once it's clear of the ship */
    });
    const lastShip = ships[ships.length - 1];
    const lastItem = items[items.length - 1].x;
    const f = { p, items, ships, xLift };
    /* where its ending begins: the glide down to the deck it lands on · losing lift short of the carrier it was making
       for · the fuel running out past the last one */
    const xApp = p.landed ? lastItem + 26 : p.downAt >= 0 ? lastItem + 8 : lastShip.x + SHIP + 30;

    /* bake the flight: run the physics (plane-physics.js) at a fixed step from lift-off to the end. Each pickup and
       bomb sits exactly where the plane will be when it gets there, so the path is the physics, and the outcome —
       drawn by plan() — is just played out. */
    const ctl = new window.PlanePhysicsController({
      x: xLift, y: ON_DECK, seaY: SEA, cruiseSpeed: V, trimY: CRUISE, ceilingY: 22, floorY: FLOOR, groundPitch: ART.GROUND_PITCH,
      descent: 40   /* between pickups it keeps coming down as if to land; each number lifts it back up */
    });
    const DT = 1 / 120;
    const path = [];
    let t = 0, next = 0, ended = false;
    f.touchT = f.splashT = f.failT = -1;
    ctl.cb.touchdown = () => (f.touchT = t);
    ctl.cb.splash = () => (f.splashT = t);
    while (!ended && t < 120) {
      while (next < items.length && ctl.x >= items[next].x) {
        const it = items[next++];
        it.y = ctl.y;
        it.t = t;
        if (it.ev.kind === "rocket") ctl.onHitMine();
        else ctl.onHitBooster(it.ev.kind === "mul" ? it.ev.value : 1 + it.ev.value / 5);
      }
      if (ctl.mode === "flying" && ctl.x >= xApp) {
        if (p.landed) ctl.startLanding(lastShip.x + 26, ON_DECK);
        else {
          ctl.startDitch();
          f.failT = t;   /* the moment the engine gives out */
        }
      }
      ctl.update(DT);
      t += DT;
      path.push({ t, x: ctl.x, y: ctl.y, r: ctl.rotation });
      ended = ctl.mode === "stopped" || ctl.mode === "sunk";
    }
    f.path = path;
    f.duration = t;
    /* the plane's state at time t into the flight, and its height at a given x (for keeping scenery clear of it) */
    f.at = (tt) => {
      const k = Math.min(path.length - 1, Math.max(0, Math.round(tt / DT) - 1));
      return path[k];
    };
    f.yAtX = (xx) => {
      let lo = 0, hi = path.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (path[mid].x < xx) lo = mid + 1;
        else hi = mid;
      }
      return path[lo].y;
    };
    f.scenery = scenery(items, f);
    return f;
  }

  /* the sky around the plane's line: more numbers (drawn from the same table, so they look like the real mix) and
     bombs floating beside some of them. Purely scenery — they sit well off the line and the plane never touches them. */
  const TOTAL_W = EVENTS.reduce((s, e) => s + e.weight, 0);
  const pickEvent = () => {
    let r = Math.random() * TOTAL_W;
    return EVENTS.find((e) => (r -= e.weight) < 0) || EVENTS[0];
  };
  function scenery(items, f) {
    const coins = [];
    const bombs = [];
    const TOP = 12, BOTTOM = SEA - 16, CLEAR = 15;   /* never within CLEAR units of the plane's line */
    const free = (x, y) => Math.abs(y - f.yAtX(x)) >= CLEAR && y >= TOP && y <= BOTTOM &&
      !coins.concat(bombs).some((o) => Math.abs(o.x - x) < 11 && Math.abs(o.y - y) < 11);
    const x0 = items[0].x - 40, x1 = items[items.length - 1].x + 30;
    for (let x = x0; x < x1; x += 22 + Math.random() * 16) {
      for (let tries = 0; tries < 4; tries++) {
        const y = TOP + Math.random() * (BOTTOM - TOP);
        if (!free(x, y)) continue;
        const ev = pickEvent();
        if (ev.kind === "rocket") bombs.push({ x, y });
        else coins.push({ x, y, label: ev.label, kind: ev.kind, decoy: true });
        break;
      }
    }
    /* bombs right beside some of the numbers — the real ones on the line and the floating ones — above or below them */
    items.filter((it) => it.ev.kind !== "rocket").concat(coins).forEach((c) => {
      if (Math.random() > 0.45) return;
      const dx = (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 4);
      for (const dy of Math.random() < 0.5 ? [-12, 12] : [12, -12]) {
        const x = c.x + dx, y = c.y + dy;
        if (free(x, y)) {
          bombs.push({ x, y });
          break;
        }
      }
    });
    return { coins, bombs };
  }

  /* ---------------- the scene ---------------- */
  const art = ART.createRenderer(canvas);
  let viewW = art.resize();
  window.addEventListener("resize", () => (viewW = art.resize()));

  let flight = null;              /* the flight in the air (or the last one, still on screen) */
  const plane = { x: START_X + 22, y: ON_DECK, angle: ART.GROUND_PITCH, flash: 0, visible: true, spin: 6 };
  let state = { stage: "parked", v: 0, sink: 0, m: 1, shown: 1, hit: 0 };
  let speed = 1;
  let time = 0;
  let engine = null;

  function scene() {
    const carriers = [{ x: START_X, landing: false }];
    if (flight) flight.ships.forEach((sh) => carriers.push(sh));
    const pickups = flight ? flight.items.filter((it) => it.ev.kind !== "rocket").map((it) => ({ x: it.x, y: it.y, label: it.ev.label, kind: it.ev.kind, taken: it.done }))
      .concat(flight.scenery.coins) : [];
    /* the bombs on the plane's line are the real events; the rest float as scenery */
    const bombs = flight ? flight.items.filter((it) => it.ev.kind === "rocket").map((it) => ({ x: it.x + 2, y: it.y, gone: it.done }))
      .concat(flight.scenery.bombs) : [];
    const rockets = [];
    const bet = state.bet || kit.bet();
    return {
      time, carriers, pickups, rockets, bombs, plane,
      camX: plane.x - viewW * 0.32,
      counter: money(round2(bet * state.shown)) + " " + unit()
    };
  }

  /* ---------------- the HUD ---------------- */
  function hud() {
    const alt = Math.max(0, SEA - (plane.y + 5)) * 0.8;
    const dist = flight && state.stage !== "parked" ? Math.max(0, plane.x - (START_X + 22)) * 0.4 : 0;
    $("wgAlt").textContent = alt.toFixed(1) + "m";
    $("wgDist").textContent = dist.toFixed(1) + "m";
    $("wgMult").textContent = fmtM(state.m);
  }

  /* ---------------- one frame of flight ---------------- */
  function fly(dt) {
    const f = flight;
    const s = state;
    if (s.stage === "roll") {
      /* the take-off run along the first deck, then the baked flight takes over */
      s.v = Math.min(V, s.v + 70 * dt);
      plane.x += s.v * dt;
      plane.angle += (ART.GROUND_PITCH * (1 - smooth(V * 0.3, V * 0.75, s.v)) - plane.angle) * Math.min(1, dt * 7);
      if (plane.x >= f.xLift) {
        s.stage = "air";
        s.t = 0;
      }
      return;
    }
    if (s.stage === "air") {
      s.t += dt;
      const q = f.at(s.t);
      plane.x = q.x;
      plane.y = q.y;
      plane.angle = q.r;
      f.items.forEach((it, i) => {
        if (it.done || s.t < it.t) return;
        if (it.ev.kind === "rocket") hitBy(it, i);
        else collect(it, i);
      });
      if (f.failT >= 0 && s.t >= f.failT && !s.failed) {
        s.failed = true;   /* the engine coughs and smokes; the plane glides down */
        art.engineTrouble(f.duration - f.failT + 1);
        kit.play("sputter");
        announce("Engine trouble! The plane is gliding down.");
      }
      if (f.touchT >= 0 && s.t >= f.touchT && !s.touched) {
        s.touched = true;
        art.dust(plane.x + ART.WHEEL_X, DECK - 0.2);
        kit.play("chirp");
      }
      if (f.splashT >= 0 && s.t >= f.splashT) {
        s.stage = "sink";
        s.sink = 0;
        art.splash(plane.x + 7);
        kit.play("splash");
        announce("Splash! The plane came down in the sea.");
      } else if (s.t >= f.duration) settle();
      return;
    }
    if (s.stage === "sink") {
      s.sink += dt;
      plane.x += Math.max(0, 14 - s.sink * 14) * dt;
      plane.y = SEA - 1 + s.sink * 20;   /* deep enough that the tail, tipped up as the nose goes in, slips under too */
      plane.angle += (0.5 - plane.angle) * Math.min(1, dt * 4);
      if (s.sink >= 1.1) settle();
    }
  }

  function collect(it, i) {
    it.done = true;
    state.m = it.m;
    art.sparkle(it.x, it.y, it.ev.kind === "add" ? "#95d5b2" : "#ffe066");
    art.pop(it.x, it.y, it.ev.label, it.ev.kind === "add" ? "#80ed99" : "#ffd60a");
    kit.play("pickup", i * 2 + (it.ev.kind === "mul" ? 5 : 0));
    announce("Picked up " + it.ev.label.replace("×", "times ") + ". Multiplier " + fmtM(state.m).replace("×", "") + ".");
  }

  function hitBy(it, i) {
    it.done = true;
    state.m = it.m;
    plane.flash = 0.5;
    art.explode(it.x + 6, it.y);
    art.pop(it.x, it.y, "-50%", "#ff6b6b");
    kit.boom();
    if (navigator.vibrate) navigator.vibrate(90);
    announce("Hit a bomb: minus 50 percent. Multiplier " + fmtM(state.m).replace("×", "") + ".");
  }

  function loop(now) {
    const raw = Math.min(0.05, (now - (loop.last || now)) / 1000);
    loop.last = now;
    const dt = raw * (phase === "FLYING" ? speed : 1);
    time += raw;
    plane.flash = Math.max(0, plane.flash - dt);
    if (phase === "FLYING") fly(dt);
    /* the counter above the plane catches up with the multiplier */
    state.shown += (state.m - state.shown) * Math.min(1, dt * 9);
    if (Math.abs(state.m - state.shown) < 0.004) state.shown = state.m;
    /* the propeller: a blur under power, windmilling slowly once the engine has failed */
    plane.spin = phase === "FLYING" && state.stage !== "sink" ? (state.failed ? 9 : 40) : 6;
    if (engine) {
      engine.frequency.value = 58 + (SEA - plane.y) * 0.35;
      if (state.failed && engine.gainNode && !engine.cut) {   /* the engine note dies away */
        engine.cut = true;
        const a = kit.audio();
        if (a) engine.gainNode.gain.linearRampToValueAtTime(0.004, a.currentTime + 0.8);
      }
    }
    art.draw(scene(), raw * (phase === "FLYING" ? speed : 1));
    hud();
    requestAnimationFrame(loop);
  }

  /* ---------------- a round ---------------- */
  function startEngine() {
    const a = kit.audio();
    if (!a) return;
    const osc = a.createOscillator();
    const low = a.createBiquadFilter();
    const gain = a.createGain();
    osc.type = "sawtooth";
    osc.frequency.value = 70;
    low.type = "lowpass";
    low.frequency.value = 420;
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(0.035, a.currentTime + 0.4);
    osc.connect(low).connect(gain).connect(a.destination);
    osc.start();
    engine = osc;
    engine.gainNode = gain;
  }
  function stopEngine() {
    if (!engine) return;
    const a = kit.audio();
    try {
      if (a) engine.gainNode.gain.linearRampToValueAtTime(0, a.currentTime + 0.3);
      engine.stop(a ? a.currentTime + 0.35 : 0);
    } catch (e) { /* already stopped */ }
    engine = null;
  }

  let starting = false;
  async function play() {
    if (phase !== "IDLE" || starting) return;
    const bet = kit.bet();
    if (!kit.canAfford(bet)) return;
    kit.unlockAudio();
    starting = true;
    const round = await kit.place(bet, {});
    starting = false;
    if (round === false) return;
    /* the whole flight, decided before take-off: by the server for real money (the same plan as below), here with credits */
    const p = round ? Object.assign({}, round.outcome, { events: round.outcome.events.map((i) => EVENTS[i]) }) : plan(Math.random);
    const f = layout(p);
    flight = f;
    art.clear();
    Object.assign(plane, { x: START_X + 22, y: ON_DECK, angle: ART.GROUND_PITCH, flash: 0, visible: true });
    state = { stage: "roll", v: 20, sink: 0, m: 1, shown: 1, bet, round };
    phase = "FLYING";
    $("wgBanner").hidden = true;
    startEngine();
    paint();
    hud();   /* the telemetry starts again at once, not a frame later */
    canvas.setAttribute("aria-label", "Rendo Wings: the plane is taking off");
    announce("Bet " + money(bet) + " " + unit() + ". The plane is taking off.");
  }

  function settle() {
    const f = flight;
    const bet = state.bet;
    phase = "IDLE";
    stopEngine();
    const banner = $("wgBanner");
    banner.hidden = false;
    if (f.p.landed) {
      const win = state.round ? state.round.payout : Math.floor(bet * f.p.final * 100 + 1e-6) / 100;
      kit.collect(win);
      banner.className = "wg-banner win";
      banner.textContent = "WIN: " + money(win) + " " + unit() + "!";
      $("wgLast").textContent = "Last win: " + money(win) + " " + unit();
      if (f.p.final >= 2) kit.celebrate();
      else kit.play("fanfare", false);
      canvas.setAttribute("aria-label", "Rendo Wings: landed on the ship at " + fmtM(f.p.final));
      announce("Landed on the ship! Multiplier " + fmtM(f.p.final).replace("×", "") + ". You win " + money(win) + " " + unit() + ".");
    } else {
      kit.collect(0);
      banner.className = "wg-banner loss";
      banner.textContent = "LOST AT SEA";
      $("wgLast").textContent = "Last win: " + money(0) + " " + unit();
      canvas.setAttribute("aria-label", "Rendo Wings: the plane came down in the sea");
      announce("Lost at sea. The bet is lost.");
    }
    paint();
  }

  /* ---------------- controls ---------------- */
  function paint() {
    const flying = phase === "FLYING";
    playBtn.setAttribute("aria-disabled", String(flying));
    playBtn.classList.toggle("is-flying", flying);
    playBtn.setAttribute("aria-label", flying ? "The plane is in the air" : "Play: bet " + money(kit.bet()) + " " + unit());
    kit.paintBet(flying);
    $("wgMinus").disabled = flying || kit.bet() <= MIN_BET + 1e-9;
    $("wgPlus").disabled = flying || kit.bet() >= kit.maxBet() - 1e-9;
    document.querySelectorAll(".wg-unit").forEach((el) => (el.textContent = unit()));
    const lw = $("wgLast");
    lw.textContent = lw.textContent.replace(/(FUN|GHS)$/, unit());
  }

  function stepBet(dir) {
    const cur = kit.bet();
    const next = dir > 0
      ? LADDER.find((v) => v > cur + 1e-9) || kit.maxBet()
      : LADDER.slice().reverse().find((v) => v < cur - 1e-9) || MIN_BET;
    kit.setBet(next);
    paint();
  }
  $("wgMinus").addEventListener("click", () => stepBet(-1));
  $("wgPlus").addEventListener("click", () => stepBet(1));
  playBtn.addEventListener("click", play);

  /* flight speed, from the menu: Normal, Fast, Turbo (it only changes how fast the flight is shown) */
  try {
    const saved = Number(localStorage.getItem(SPEED_KEY));
    if (SPEEDS[saved]) speed = SPEEDS[saved].x;
  } catch (e) { /* storage unavailable */ }
  const paintSpeed = () => ($("wgSpeed").querySelector("span").textContent = "Speed: " + SPEEDS.find((s) => s.x === speed).name);
  $("wgSpeed").addEventListener("click", () => {
    const i = (SPEEDS.findIndex((s) => s.x === speed) + 1) % SPEEDS.length;
    speed = SPEEDS[i].x;
    try {
      localStorage.setItem(SPEED_KEY, String(i));
    } catch (e) { /* storage unavailable */ }
    paintSpeed();
  });

  /* the flight-data icons: climbing, distance flown, the multiplier's bolt */
  const GAUGES = {
    alt: { color: "#7ee0ff", svg: '<path d="M12 3.5 18 10h-4v6.5h-4V10H6z"/><rect x="4" y="18.5" width="16" height="2" rx="1"/>' },
    dist: { color: "#8cf5a8", svg: '<circle cx="5.5" cy="17.5" r="2.5"/><circle cx="18.5" cy="6.5" r="2.5"/>' +
      '<path d="M7.6 16.4c5-1.3 2.6-6.6 8.8-8.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="2.2 2.6"/>' },
    mult: { color: "#ffd60a", svg: '<path d="M13.5 2.5 5 13.6h5.6L9.4 21.5l9-11.6h-5.7z"/>' }
  };
  document.querySelectorAll(".wg-ico").forEach((el) => {
    const g = GAUGES[el.dataset.gauge];
    el.style.setProperty("--c", g.color);
    el.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" focusable="false">' + g.svg + "</svg>";
  });

  $("wgLast").textContent = "Last win: " + money(0) + " " + unit();
  paintSpeed();
  paint();
  requestAnimationFrame(loop);
})();
