/* Rendo Mines — a 5×5 board hides 1–24 mines. Open tiles: a star raises the payout, a mine ends the round, and you can
   cash out any time after the first star.
   A local state machine drives each round:  IDLE (choose mines and a bet) → ACTIVE (open tiles) → back to IDLE on a
   cash-out or a mine. The mines are placed by a shuffle when BET is pressed and a tile only shows what is already under
   it — nothing moves or is steered afterwards.
   Auto Game: line up tiles before BET; they are then opened one by one, cashing out once they are all safe.
   The balance, menu, sounds and confetti come from the shared mini-game kit (minigame.js). */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);

  const SIZE = 5;
  const TILES = SIZE * SIZE;
  const RTP_PERCENT = 96.5;       // each multiplier is 96.5% ÷ the chance of that many stars in a row
  const MAX_WIN = 100000;         // the most one round can pay
  const DEFAULT_MINES = 3;
  const MIN_BET = 0.1;
  const TABLE_MAX = 10000;
  const CHIPS = [0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000];
  const LADDER = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];  // the − and + steps
  const AUTO_START_MS = 450;      // pause before Auto Game opens its first tile
  const AUTO_STEP_MS = 480;       // then one tile every
  const RIPPLE_MS = 70;           // end of round: tiles turn over in a ripple from the last tile
  const SPARKS = 12;
  const FX = ".mn-blast, .mn-spark, .mn-flash, .mn-fire, .mn-shock, .mn-smoke, .mn-glint, .mn-float";   /* effect layers on a tile */
  const HINT_GAP_MS = 2500;

  const board = $("mnBoard");
  const grid = $("mnGrid");
  const goBtn = $("mnGo");
  const select = $("mnMines");

  let phase = "IDLE";   /* IDLE → ACTIVE → IDLE */
  let mines = DEFAULT_MINES;
  let auto = false;     /* Auto Game switch */
  let selected = [];    /* Auto Game: tiles lined up, in the order they will open */
  let round = null;     /* { stake, count, mines:Set, picked:[], auto, queue:[] } */
  let dirty = false;    /* the board is still showing the last round's result */
  let autoTimer = 0;
  let lastHint = 0;

  const kit = window.VBMini.create({
    prefix: "mn",
    winSound: "coins",   /* this game's own win sound (minigame.js SFX) */
    gameId: "volta-mines",
    server: true,         /* real-money rounds: the server deals the mines and judges every tile */
    minBet: MIN_BET,
    tableMax: TABLE_MAX,
    chips: CHIPS,
    busy: () => phase === "ACTIVE",
    busyText: "Cash out or finish your round before switching.",
    onChange: () => paint(),
    confettiFrom: () => grid,
    confettiStyle: "coins"   /* a big cash-out showers gold coins */
  });
  const { money, round2, announce } = kit;

  $("mnRtp").textContent = RTP_PERCENT + "%";
  $("mnRulesRtp").textContent = RTP_PERCENT + "%";
  $("mnRulesRtp2").textContent = RTP_PERCENT + "%";

  /* ---------------- the maths ---------------- */
  /* with m mines, the chance of finding k stars in a row is ∏ (25−m−i) ÷ (25−i). A star's multiplier is
     96.5% ÷ that chance, so every cash-out strategy returns 96.5% on average. Exact integer maths (BigInt),
     rounded to the nearest 0.01 with ties up, so the numbers never drift. */
  const tables = {};
  function multipliers(m) {
    if (tables[m]) return tables[m];
    const t = [1];   /* t[k] = the multiplier after k stars */
    let num = 1n;
    let den = 1n;
    for (let k = 1; k <= TILES - m; k++) {
      num *= BigInt(TILES - m - (k - 1));
      den *= BigInt(TILES - (k - 1));
      /* 100 × 0.965 ÷ (num/den) = 193·den ÷ (2·num); round half up */
      t[k] = Number((386n * den + 2n * num) / (4n * num)) / 100;
    }
    tables[m] = t;
    return t;
  }
  const safeTotal = () => TILES - mines;
  /* down to the cent, the way the server pays */
  const payout = (stake, mult) => Math.min(MAX_WIN, Math.floor(stake * mult * 100 + 1e-6) / 100);
  const fmtX = (x) => x.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "x";
  const trimX = (x) => x.toLocaleString("en-GH", { maximumFractionDigits: 2 }) + "x";   /* 1.10 → "1.1x" */

  /* the mines: a Fisher–Yates shuffle of the 25 tiles, the first `count` of them are mines */
  function placeMines(count) {
    const order = Array.from({ length: TILES }, (_, i) => i);
    for (let i = TILES - 1; i > 0; i--) {
      const k = Math.floor(Math.random() * (i + 1));
      [order[i], order[k]] = [order[k], order[i]];
    }
    return new Set(order.slice(0, count));
  }

  /* ---------------- the tiles ---------------- */
  const tiles = [];
  for (let i = 0; i < TILES; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mn-tile";
    b.dataset.i = i;
    b.tabIndex = i === 0 ? 0 : -1;   /* one tab stop; the arrow keys move around the board */
    b.style.setProperty("--i", (i % SIZE) + Math.floor(i / SIZE));   /* the sheen sweeps corner to corner */
    b.innerHTML = '<span class="mn-flip"><span class="mn-face mn-up"></span><span class="mn-face mn-down"></span></span>' +
      '<span class="mn-order"></span>';
    grid.appendChild(b);
    tiles.push(b);
  }

  function labelTile(i) {
    const t = tiles[i];
    const state = t.dataset.state;
    const at = selected.indexOf(i);
    t.setAttribute("aria-label", "Tile " + (i + 1) + ", " + (
      state === "star" ? "star" :
      state === "boom" ? "mine, the one you hit" :
      state === "ghost-star" ? "star, not opened" :
      state === "ghost-mine" ? "mine" :
      at >= 0 ? "lined up to open number " + (at + 1) : "hidden"));
  }

  /* the Auto Game ring and its order number */
  function paintSelection() {
    tiles.forEach((t, i) => {
      const at = selected.indexOf(i);
      t.classList.toggle("is-pick", at >= 0);
      t.querySelector(".mn-order").textContent = at >= 0 ? at + 1 : "";
      labelTile(i);
    });
  }

  /* adds an effect element to a tile and returns it */
  function layer(t, tag, cls, style) {
    const el = document.createElement(tag);
    el.className = cls;
    if (style) Object.keys(style).forEach((k) => el.style.setProperty(k, style[k]));
    t.appendChild(el);
    return el;
  }

  /* the explosion over the tile that was hit: a flash, the fireball, a shockwave, sparks, smoke, then the burst left on it */
  function explode(t, i) {
    layer(t, "span", "mn-flash");
    layer(t, "span", "mn-fire");
    layer(t, "span", "mn-shock");
    for (let n = 0; n < SPARKS; n++) {
      layer(t, "i", "mn-spark", {
        "--a": (n * 360) / SPARKS + ((n * 37) % 17) - 8 + "deg",
        "--r": 46 + ((n * 23) % 5) * 10 + "px",
        "--s": 3 + (n % 3) + "px",
        "--t": (0.6 + (n % 4) * 0.12).toFixed(2) + "s"
      });
    }
    layer(t, "span", "mn-smoke", { "--sx": "-8px", "--sr": "34deg", "--sd": ".7s" });
    layer(t, "span", "mn-smoke", { "--sx": "10px", "--sr": "-42deg", "--sd": ".86s" });
    layer(t, "span", "mn-blast").innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#mnBlast"/></svg>';
    /* the blast lights up the board around the tile */
    const b = board.getBoundingClientRect();
    const r = t.getBoundingClientRect();
    board.style.setProperty("--hx", ((r.left + r.width / 2 - b.left) / b.width) * 100 + "%");
    board.style.setProperty("--hy", ((r.top + r.height / 2 - b.top) / b.height) * 100 + "%");
    board.classList.remove("is-hit");
    void board.offsetWidth;
    board.classList.add("is-hit");
    /* the short-lived layers go once they've played; the burst stays */
    setTimeout(() => t.querySelectorAll(".mn-flash, .mn-fire, .mn-shock, .mn-spark, .mn-smoke").forEach((n) => n.remove()), 3200);
  }

  /* a new star: glints flash round the tile and the multiplier it reached floats up */
  function sparkle(t, label) {
    [["-8%", "-6%", ".25s"], ["72%", "-10%", ".36s"], ["76%", "68%", ".44s"], ["-10%", "64%", ".31s"]].forEach(([x, y, d]) =>
      layer(t, "span", "mn-glint", { left: x, top: y, "animation-delay": d }));
    layer(t, "span", "mn-float").textContent = label;
    setTimeout(() => t.querySelectorAll(".mn-glint, .mn-float").forEach((n) => n.remove()), 1500);
  }

  /* turns a tile over to show a star, a mine or the mine that was hit */
  function reveal(i, kind, opts) {
    const o = opts || {};
    const t = tiles[i];
    const mine = kind !== "star";
    t.querySelector(".mn-down").innerHTML =
      '<svg viewBox="0 0 64 64" aria-hidden="true"><use href="#' + (mine ? "mnBomb" : "mnStar3d") + '"/></svg>' +
      (kind === "mine" ? '<i class="mn-fuse"></i>' : "");
    t.style.setProperty("--d", (o.delay || 0) + "ms");
    t.dataset.state = (o.ghost ? "ghost-" : "") + kind;
    t.classList.add("is-open", mine ? "is-mine" : "is-star");
    if (kind === "boom") t.classList.replace("is-mine", "is-boom");
    if (o.ghost) t.classList.add("is-ghost");
    if (o.fresh) t.classList.add("is-fresh");
    if (kind === "boom") explode(t, i);
    if (o.label) sparkle(t, o.label);
    labelTile(i);
  }

  /* back to a clean, covered board (keeping any Auto Game selection); no flip-back animation */
  function resetBoard() {
    grid.classList.add("no-anim");
    tiles.forEach((t) => {
      t.className = "mn-tile";
      delete t.dataset.state;
      t.style.removeProperty("--d");
      t.querySelector(".mn-down").innerHTML = "";
      t.querySelectorAll(FX).forEach((n) => n.remove());
    });
    board.classList.remove("is-shaking", "is-hit");
    void grid.offsetWidth;
    grid.classList.remove("no-anim");
    dirty = false;
    paintSelection();
  }

  /* end of a round: every tile that is still covered turns over, rippling out from `origin` */
  function endBoard(origin) {
    const ox = origin % SIZE;
    const oy = Math.floor(origin / SIZE);
    tiles.forEach((t, i) => {
      if (t.classList.contains("is-open")) return;
      const dist = Math.hypot((i % SIZE) - ox, Math.floor(i / SIZE) - oy);
      reveal(i, round.mines.has(i) ? "mine" : "star", { ghost: true, delay: kit.reduceMotion ? 0 : 260 + Math.round(dist * RIPPLE_MS) });
    });
    dirty = true;
  }

  /* ---------------- painting the controls ---------------- */
  const setDisabled = (btn, off) => btn.setAttribute("aria-disabled", String(!!off));

  function paintNext() {
    const t = multipliers(phase === "ACTIVE" ? round.count : mines);
    let label = "Next:";
    let value;
    if (phase === "ACTIVE") {
      const k = round.picked.length + 1;
      value = k <= TILES - round.count ? fmtX(t[k]) : "—";
    } else if (auto && selected.length) {
      label = "Target:";   /* the multiplier once every lined-up tile has turned out safe */
      value = fmtX(t[selected.length]);
    } else {
      value = fmtX(t[1]);
    }
    $("mnNextLabel").textContent = label;
    $("mnNextVal").textContent = value;
  }

  function paintGo() {
    if (phase === "ACTIVE") {
      const k = round.picked.length;
      goBtn.dataset.state = "cash";
      setDisabled(goBtn, k === 0);   /* cashing out needs at least one star */
      goBtn.classList.toggle("is-ready", k > 0);
      goBtn.innerHTML = "<b>CASH OUT</b>" + (k ? " <span>" + money(payout(round.stake, multipliers(round.count)[k])) + " GHS</span>" : "");
    } else {
      goBtn.dataset.state = "bet";
      setDisabled(goBtn, false);
      goBtn.classList.remove("is-ready");
      goBtn.innerHTML = U.icon("play") + " <b>BET</b>";
    }
  }

  function paint() {
    const active = phase === "ACTIVE";
    select.disabled = active;
    const sw = $("mnAuto");
    sw.setAttribute("aria-checked", String(auto));
    setDisabled(sw, active);
    /* RANDOM opens a random tile in a round; with Auto Game it lines one up */
    setDisabled($("mnRandom"), active ? round.auto : !auto || selected.length >= safeTotal());
    setDisabled($("mnRefresh"), active);
    board.dataset.live = String((active && !round.auto) || (!active && auto));
    paintNext();
    paintGo();
    kit.paintBet(active);
    $("mnMinus").disabled = active || kit.bet() <= MIN_BET + 1e-9;
    $("mnPlus").disabled = active || kit.bet() >= kit.maxBet() - 1e-9;
    $("mnStack").disabled = active;
    ["mnHalf", "mnDouble", "mnMax"].forEach((id) => ($(id).disabled = active));
  }

  /* ---------------- a round ---------------- */
  let starting = false;
  async function start() {
    if (phase !== "IDLE" || starting) return;
    if (auto && !selected.length) {
      U.toast("Auto Game: tap the tiles you want opened, then press BET.", "err");
      return;
    }
    const stake = kit.bet();
    if (!kit.canAfford(stake)) return;
    kit.unlockAudio();
    /* real money: the server takes the stake and deals the mines, keeping them secret until the round ends */
    let session = null;
    if (kit.isReal()) {
      starting = true;
      const r = await kit.request("start", { stake, params: { mines }, idempotency_key: "round:" + crypto.randomUUID() });
      starting = false;
      if (!r) return;
      kit.showBalance(r.balance);
      session = r.session_id;
    } else {
      kit.move(-stake);
    }
    resetBoard();
    round = { stake, count: mines, mines: session ? null : placeMines(mines), picked: [], auto, queue: auto ? selected.slice() : [],
      session, waiting: false };
    phase = "ACTIVE";
    paint();
    announce("Round started: GHS " + money(stake) + " on " + mines + " mine" + (mines === 1 ? "" : "s") + ". " +
      (auto ? "Auto Game is opening your tiles." : "Open a tile."));
    if (auto) runAuto(AUTO_START_MS);
  }

  /* Auto Game: opens the lined-up tiles one by one */
  function runAuto(delay) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(async () => {
      if (phase !== "ACTIVE" || !round.auto) return;
      const next = round.queue.shift();
      if (next === undefined) return;
      await pick(next);
      if (phase === "ACTIVE") runAuto(AUTO_STEP_MS);
    }, delay);
  }

  async function pick(i) {
    if (phase !== "ACTIVE" || round.picked.includes(i)) return;
    if (round.session) {
      if (round.waiting) return;
      round.waiting = true;
      const r = await kit.request("step", { session_id: round.session, move: i });
      round.waiting = false;
      if (!r || phase !== "ACTIVE") return;
      if (r.status === "LOST") {
        round.mines = new Set(r.reveal.mines);
        lose(i);
        return;
      }
      round.picked = r.state.picked.slice();
      const k = round.picked.length;
      reveal(i, "star", { fresh: true, label: fmtX(multipliers(round.count)[k]) });
      kit.ping(k - 1);
      if (r.status === "WON") {   /* the board was cleared or the top prize reached: the server paid out by itself */
        round.mines = new Set(r.reveal.mines);
        finishWin(r.payout, r.balance);
        return;
      }
      paint();
      announce("Star. You can cash out GHS " + money(payout(round.stake, multipliers(round.count)[k])) + ".");
      if (round.auto && !round.queue.length) cashOut();
      return;
    }
    if (round.mines.has(i)) {
      lose(i);
      return;
    }
    round.picked.push(i);
    const k = round.picked.length;
    const t = multipliers(round.count);
    reveal(i, "star", { fresh: true, label: fmtX(t[k]) });
    kit.ping(k - 1);
    const pay = payout(round.stake, t[k]);
    paint();
    announce("Star. You can cash out GHS " + money(pay) + (k < TILES - round.count ? ", or open another tile for " + fmtX(t[k + 1]) + "." : "."));
    /* the round pays out by itself once the board is cleared, the top prize is reached, or Auto Game has opened its last tile */
    if (k === TILES - round.count || round.stake * t[k] >= MAX_WIN || (round.auto && !round.queue.length)) cashOut();
  }

  async function cashOut() {
    if (phase !== "ACTIVE" || !round.picked.length) return;
    clearTimeout(autoTimer);
    if (round.session) {
      if (round.waiting) return;
      round.waiting = true;
      const r = await kit.request("cashout", { session_id: round.session });
      round.waiting = false;
      if (!r || phase !== "ACTIVE") return;
      round.mines = new Set(r.reveal.mines);
      finishWin(r.payout, r.balance);
      return;
    }
    finishWin(payout(round.stake, multipliers(round.count)[round.picked.length]));
  }

  /* the round is won: real money passes the server's balance, credits are paid here */
  function finishWin(win, serverBalance) {
    clearTimeout(autoTimer);
    const k = round.picked.length;
    const mult = multipliers(round.count)[k];
    const capped = round2(round.stake * mult) > MAX_WIN;
    phase = "IDLE";
    if (serverBalance === undefined) kit.move(win);
    else kit.showBalance(serverBalance, win);
    endBoard(round.picked[k - 1]);
    paint();
    const shown = capped ? win / round.stake : mult;
    U.toast("You have cashed out! " + trimX(shown) + " | Win GHS " + money(win), "ok");
    announce("Cashed out at " + trimX(shown) + ". You win GHS " + money(win) + ".");
    if (mult >= 2) kit.celebrate();
    else kit.play("coins");
  }

  function lose(i) {
    clearTimeout(autoTimer);
    phase = "IDLE";
    reveal(i, "boom");
    endBoard(i);
    kit.boom();
    if (navigator.vibrate) navigator.vibrate(180);
    if (!kit.reduceMotion) {
      board.classList.remove("is-shaking");
      void board.offsetWidth;
      board.classList.add("is-shaking");
    }
    paint();
    announce("Mine! Tile " + (i + 1) + " was a mine. The round is over and the bet is lost.");
  }

  /* ---------------- tapping tiles, RANDOM, reset, Auto Game ---------------- */
  function toggleSelect(i) {
    if (dirty) resetBoard();
    const at = selected.indexOf(i);
    if (at >= 0) selected.splice(at, 1);
    else if (selected.length < safeTotal()) selected.push(i);
    else {
      U.toast("With " + mines + " mine" + (mines === 1 ? "" : "s") + ", only " + safeTotal() + " tile" + (safeTotal() === 1 ? "" : "s") + " can be safe.", "err");
      return;
    }
    paintSelection();
    paint();
  }

  grid.addEventListener("click", (e) => {
    const t = e.target.closest(".mn-tile");
    if (!t) return;
    const i = Number(t.dataset.i);
    if (phase === "ACTIVE") {
      if (!round.auto) pick(i);
    } else if (auto) {
      toggleSelect(i);
    } else if (Date.now() - lastHint > HINT_GAP_MS) {
      lastHint = Date.now();
      U.toast("Press BET to start a round.", "");
    }
  });

  /* the arrow keys, Home and End move between tiles (Enter and Space open one) */
  const rover = (i) => tiles.forEach((t, n) => (t.tabIndex = n === i ? 0 : -1));
  grid.addEventListener("focusin", (e) => {
    const t = e.target.closest(".mn-tile");
    if (t) rover(Number(t.dataset.i));
  });
  grid.addEventListener("keydown", (e) => {
    const t = e.target.closest(".mn-tile");
    if (!t) return;
    const i = Number(t.dataset.i);
    const step = {
      ArrowLeft: i % SIZE ? -1 : 0, ArrowRight: i % SIZE < SIZE - 1 ? 1 : 0,
      ArrowUp: i >= SIZE ? -SIZE : 0, ArrowDown: i < TILES - SIZE ? SIZE : 0,
      Home: -(i % SIZE), End: SIZE - 1 - (i % SIZE)
    }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    tiles[i + step].focus();
  });

  $("mnRandom").addEventListener("click", () => {
    if (phase === "ACTIVE") {
      if (round.auto) return;
      const covered = tiles.map((_, i) => i).filter((i) => !round.picked.includes(i));
      pick(covered[Math.floor(Math.random() * covered.length)]);
    } else if (auto && selected.length < safeTotal()) {
      if (dirty) resetBoard();
      const free = tiles.map((_, i) => i).filter((i) => !selected.includes(i));
      selected.push(free[Math.floor(Math.random() * free.length)]);
      paintSelection();
      paint();
    }
  });

  /* clears the board, and any Auto Game tiles; not while a round is on */
  $("mnRefresh").addEventListener("click", () => {
    if (phase === "ACTIVE") return;
    selected = [];
    resetBoard();
    paint();
  });

  $("mnAuto").addEventListener("click", () => {
    if (phase === "ACTIVE") return;
    auto = !auto;
    selected = [];
    resetBoard();
    paint();
    announce(auto ? "Auto Game on. Tap the tiles you want opened, then press BET." : "Auto Game off.");
  });

  for (let n = 1; n < TILES; n++) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = "Mines: " + n;
    select.appendChild(o);
  }
  select.value = mines;
  select.addEventListener("change", () => {
    mines = Number(select.value);
    selected = selected.slice(0, safeTotal());   /* fewer safe tiles now, so fewer can be lined up */
    resetBoard();
    paint();
  });

  goBtn.addEventListener("click", () => {
    if (phase === "IDLE") start();
    else if (round.picked.length) cashOut();
    else U.toast("Open a tile first — you can cash out after your first star.", "");
  });

  /* ---------------- the bet: − and + step along a ladder, the stack opens the chips ---------------- */
  function stepBet(dir) {
    const cur = kit.bet();
    const next = dir > 0
      ? LADDER.find((v) => v > cur + 1e-9) || kit.maxBet()
      : LADDER.slice().reverse().find((v) => v < cur - 1e-9) || MIN_BET;
    kit.setBet(next);
    paint();
  }
  $("mnMinus").addEventListener("click", () => stepBet(-1));
  $("mnPlus").addEventListener("click", () => stepBet(1));

  const sheet = $("mnBetSheet");
  window.VBMini.backdropClose(sheet);
  $("mnStack").addEventListener("click", () => sheet.showModal());
  $("mnSheetDone").addEventListener("click", () => sheet.close());
  $("mnChips").addEventListener("click", (e) => {
    if (!e.target.closest("[data-chip]")) return;
    paint();
    sheet.close();
  });
  $("mnHalf").addEventListener("click", () => { kit.setBet(kit.bet() / 2); paint(); });
  $("mnDouble").addEventListener("click", () => { kit.setBet(kit.bet() * 2); paint(); });
  $("mnMax").addEventListener("click", () => { kit.setBet(kit.maxBet()); paint(); });

  resetBoard();
  paint();

  /* a real-money round left open (the page was closed or reloaded) carries on where it stopped */
  if (kit.isReal()) {
    kit.request("open").then((r) => {
      if (!r || !r.session || phase !== "IDLE") return;
      const sess = r.session;
      mines = sess.state.mines;
      select.value = String(mines);
      resetBoard();
      round = { stake: sess.stake, count: mines, mines: null, picked: sess.state.picked.slice(), auto: false, queue: [],
        session: sess.session_id, waiting: false };
      round.picked.forEach((i) => reveal(i, "star"));
      phase = "ACTIVE";
      paint();
      U.toast("Your round in progress is back — open another tile or cash out.", "ok");
    });
  }
})();
