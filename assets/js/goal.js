/* Rendo Goal — dribble up the pitch: each column hides one bomb among its tiles. Pick a tile in the glowing column;
   a ball moves you on to the next column and raises the multiplier, a bomb ends the round. Cash out any time after
   the first ball; clearing the last column is a GOAL and cashes out by itself.
   State machine:  IDLE (field size, bet) → ACTIVE (pick column by column, or CASH OUT) → IDLE.
   Fairness: one bomb per column, its row drawn at random when BET is pressed. With r tiles a column, getting past k
   columns has chance ((r−1)/r)^k, and the multiplier there is 97% ÷ that chance, rounded down to the cent.
   Auto Game: pick one tile in as many columns as you like (from the left), press BET, and they open in order.
   The balance, menu, sounds and confetti come from the shared mini-game kit (minigame.js). */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);

  const FIELDS = {
    small: { name: "Small", cols: 4, rows: 3 },
    medium: { name: "Medium", cols: 5, rows: 4 },
    large: { name: "Large", cols: 7, rows: 5 }
  };
  const RTP_CENTS = 97n;
  const MAX_WIN = 100000;
  const MIN_BET = 0.1;
  const TABLE_MAX = 10000;
  const CHIPS = [0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000];
  const LADDER = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const AUTO_START_MS = 450;
  const AUTO_STEP_MS = 520;
  const SPARKS = 12;
  const FX = ".gl-blast, .gl-spark, .gl-flash, .gl-fire, .gl-shock, .gl-smoke, .gl-float";

  const grid = $("glGrid");
  const pitch = $("glPitch");
  const goBtn = $("glGo");
  const select = $("glField");

  let field = "medium";
  let phase = "IDLE";   /* IDLE → ACTIVE → IDLE */
  let auto = false;
  let selected = [];    /* Auto Game: selected[col] = row */
  let round = null;     /* { stake, field, bombs:[row by col], col, picks:[row by col], auto, queue } */
  let dirty = false;    /* the pitch still shows the last round */
  let autoTimer = 0;
  let tiles = [];       /* tiles[col][row] */

  const kit = window.VBMini.create({
    prefix: "gl",
    winSound: "crowd",   /* the referee's whistle and the crowd roaring */
    gameId: "volta-goal",
    server: true,         /* real-money rounds: the server places the bombs and judges every pick */
    minBet: MIN_BET,
    tableMax: TABLE_MAX,
    chips: CHIPS,
    busy: () => phase === "ACTIVE",
    busyText: "Cash out or finish your round before switching.",
    onChange: () => paint(),
    confettiFrom: () => pitch,
    confettiStyle: "coins"
  });
  const { money, round2, announce } = kit;

  /* ---------------- the maths ---------------- */
  /* the multiplier after k balls: 0.97 × (r/(r−1))^k, rounded down to the cent (exact, with BigInt) */
  const tables = {};
  function multipliers(key) {
    if (tables[key]) return tables[key];
    const r = BigInt(FIELDS[key].rows);
    const t = [1];
    for (let k = 1; k <= FIELDS[key].cols; k++) t[k] = Number((RTP_CENTS * r ** BigInt(k)) / (r - 1n) ** BigInt(k)) / 100;
    return (tables[key] = t);
  }
  const F = () => FIELDS[round ? round.field : field];
  const payout = (stake, m) => Math.min(MAX_WIN, Math.floor(stake * m * 100 + 1e-6) / 100);
  const fmtX = (x) => x.toFixed(2) + "x";

  /* ---------------- the tiles ---------------- */
  function build() {
    const { cols, rows } = FIELDS[field];
    grid.innerHTML = "";
    grid.style.setProperty("--cols", cols);
    grid.style.setProperty("--rows", rows);
    pitch.dataset.field = field;
    tiles = [];
    for (let c = 0; c < cols; c++) {
      tiles.push([]);
      for (let r = 0; r < rows; r++) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "gl-tile";
        b.dataset.c = c;
        b.dataset.r = r;
        b.style.gridColumn = String(c + 1);
        b.style.gridRow = String(r + 1);
        b.innerHTML = '<span class="gl-flip"><span class="gl-face gl-up"></span><span class="gl-face gl-down"></span></span>';
        grid.appendChild(b);
        tiles[c].push(b);
      }
    }
    const t = multipliers(field);
    $("glMults").style.setProperty("--cols", cols);
    $("glMults").innerHTML = t.slice(1).map((m) => "<span>" + fmtX(m) + "</span>").join("");
    dirty = false;
  }

  function layer(t, tag, cls, style) {
    const el = document.createElement(tag);
    el.className = cls;
    if (style) Object.keys(style).forEach((k) => el.style.setProperty(k, style[k]));
    t.appendChild(el);
    return el;
  }

  /* the bomb going off: flash, fireball, shockwave, sparks, smoke, then the scorch left behind */
  function explode(t) {
    layer(t, "span", "gl-flash");
    layer(t, "span", "gl-fire");
    layer(t, "span", "gl-shock");
    for (let n = 0; n < SPARKS; n++) {
      layer(t, "i", "gl-spark", {
        "--a": (n * 360) / SPARKS + ((n * 37) % 17) - 8 + "deg",
        "--r": 46 + ((n * 23) % 5) * 10 + "px",
        "--s": 3 + (n % 3) + "px",
        "--t": (0.6 + (n % 4) * 0.12).toFixed(2) + "s"
      });
    }
    layer(t, "span", "gl-smoke", { "--sx": "-8px", "--sr": "34deg", "--sd": ".7s" });
    layer(t, "span", "gl-smoke", { "--sx": "10px", "--sr": "-42deg", "--sd": ".86s" });
    layer(t, "span", "gl-blast").innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#glBlast"/></svg>';
    setTimeout(() => t.querySelectorAll(".gl-flash, .gl-fire, .gl-shock, .gl-spark, .gl-smoke").forEach((n) => n.remove()), 3200);
  }

  /* turns a tile over: "ball", "bomb" (the one hit) or "mine" (a bomb shown after the round) */
  function reveal(c, r, kind, opts) {
    const o = opts || {};
    const t = tiles[c][r];
    const bomb = kind !== "ball";
    t.querySelector(".gl-down").innerHTML = '<svg viewBox="0 0 64 64" aria-hidden="true"><use href="#' + (bomb ? "glBomb" : "glBall") + '"/></svg>';
    t.style.setProperty("--d", (o.delay || 0) + "ms");
    t.classList.add("is-open", bomb ? "is-bomb" : "is-ball");
    if (kind === "bomb") {
      t.classList.add("is-boom");
      explode(t);
    }
    if (o.ghost) t.classList.add("is-ghost");
    if (o.label) {
      layer(t, "span", "gl-float").textContent = o.label;
      setTimeout(() => t.querySelector(".gl-float")?.remove(), 1400);
    }
    t.setAttribute("aria-label", "Column " + (c + 1) + ", tile " + (r + 1) + ": " + (bomb ? "bomb" : "ball"));
  }

  /* after a ball: a ball rolls from the tile into the middle of the next column, which then lights up */
  function dribble(c, r) {
    if (kit.reduceMotion) return;
    const from = tiles[c][r].getBoundingClientRect();
    const col = tiles[c + 1];
    const a = col[0].getBoundingClientRect(), z = col[col.length - 1].getBoundingClientRect();
    const g = pitch.getBoundingClientRect();   /* the ball rides above the grid, so the 3D tiles can't cover it */
    const size = Math.min(from.width, from.height) * 0.75;
    const ball = document.createElement("span");
    ball.className = "gl-runner";
    ball.style.width = ball.style.height = size + "px";
    ball.innerHTML = '<svg viewBox="0 0 64 64" aria-hidden="true"><use href="#glBall"/></svg>';
    pitch.appendChild(ball);
    const x0 = from.left - g.left + from.width / 2 - size / 2, y0 = from.top - g.top + from.height / 2 - size / 2;
    const x1 = a.left - g.left + a.width / 2 - size / 2, y1 = (a.top + z.bottom) / 2 - g.top - size / 2;
    const mx = (x0 + x1) / 2, my = Math.min(y0, y1) - size * 0.8;   /* a little hop on the way */
    ball.animate([
      { transform: "translate(" + x0 + "px," + y0 + "px) rotate(0)", opacity: 1 },
      { transform: "translate(" + mx + "px," + my + "px) rotate(270deg) scale(1.15)", opacity: 1, offset: 0.4 },
      { transform: "translate(" + x1 + "px," + y1 + "px) rotate(540deg)", opacity: 1, offset: 0.75 },
      { transform: "translate(" + x1 + "px," + y1 + "px) rotate(560deg) scale(.7)", opacity: 0 }
    ], { duration: 950, easing: "ease-in-out" }).finished.then(() => ball.remove());
  }

  /* end of a round: every bomb not yet seen shows, column by column from the left */
  function showBombs() {
    round.bombs.forEach((r, c) => {
      if (!tiles[c][r].classList.contains("is-open")) reveal(c, r, "mine", { ghost: true, delay: kit.reduceMotion ? 0 : 250 + c * 90 });
    });
    dirty = true;
  }

  function resetBoard() {
    if (dirty || grid.children.length === 0) build();
    paintSelection();
  }

  /* ---------------- painting ---------------- */
  const setDisabled = (btn, off) => btn.setAttribute("aria-disabled", String(!!off));

  /* which column is live: in a round, the one to pick in; it glows, later columns are dimmed */
  function paintColumns() {
    const active = phase === "ACTIVE";
    const cur = active ? round.col : -1;
    tiles.forEach((col, c) => col.forEach((t) => {
      t.classList.toggle("is-live", active && !round.auto && c === cur);
      t.classList.toggle("is-ahead", active && c > cur);
      t.disabled = active ? round.auto || c !== cur || t.classList.contains("is-open") : false;
    }));
    $("glMults").querySelectorAll("span").forEach((s, c) => {
      s.classList.toggle("is-done", active && c < cur);
      s.classList.toggle("is-next", active ? c === cur : c === 0);
    });
  }

  function paintSelection() {
    tiles.forEach((col, c) => col.forEach((t, r) => t.classList.toggle("is-pick", auto && selected[c] === r)));
  }

  /* Auto Game plays the selected columns from the left until the first column without a pick */
  const queueOf = () => {
    const q = [];
    for (let c = 0; c < F().cols && selected[c] !== undefined; c++) q.push(selected[c]);
    return q;
  };

  function paint() {
    const active = phase === "ACTIVE";
    const t = mults();
    /* Next: the multiplier one more ball would reach */
    let label = "Next:";
    let val;
    if (active) val = round.col < F().cols ? fmtX(t[round.col + 1]) : "—";
    else if (auto && queueOf().length) {
      label = "Target:";
      val = fmtX(t[queueOf().length]);
    } else val = fmtX(t[1]);
    $("glNextVal").parentElement.firstChild.textContent = label + " ";
    $("glNextVal").textContent = val;

    if (active) {
      const k = round.col;
      goBtn.dataset.state = "cash";
      setDisabled(goBtn, k === 0 || round.auto);
      goBtn.innerHTML = "<b>CASH OUT</b>" + (k ? " <span>" + money(payout(round.stake, t[k])) + " GHS</span>" : "");
    } else {
      goBtn.dataset.state = "bet";
      setDisabled(goBtn, false);
      goBtn.innerHTML = U.icon("play") + " <b>BET</b>";
    }
    select.disabled = active;
    $("glAuto").setAttribute("aria-checked", String(auto));
    setDisabled($("glAuto"), active);
    setDisabled($("glRandom"), active ? round.auto : !auto);
    setDisabled($("glRefresh"), active);
    kit.paintBet(active);
    $("glMinus").disabled = active || kit.bet() <= MIN_BET + 1e-9;
    $("glPlus").disabled = active || kit.bet() >= kit.maxBet() - 1e-9;
    $("glStack").disabled = active;
    ["glHalf", "glDouble", "glMax"].forEach((id) => ($(id).disabled = active));
    pitch.classList.toggle("is-live", active);
    paintColumns();
  }
  const mults = () => multipliers(round ? round.field : field);

  /* ---------------- a round ---------------- */
  let starting = false;
  async function start() {
    if (phase !== "IDLE" || starting) return;
    if (auto && !queueOf().length) {
      U.toast("Auto Game: pick a tile in the first column (and any after it), then press BET.", "err");
      return;
    }
    const stake = kit.bet();
    if (!kit.canAfford(stake)) return;
    kit.unlockAudio();
    /* real money: the server takes the stake and places the bombs, keeping them secret until the round ends */
    let session = null;
    if (kit.isReal()) {
      starting = true;
      const r = await kit.request("start", { stake, params: { field }, idempotency_key: "round:" + crypto.randomUUID() });
      starting = false;
      if (!r) return;
      kit.showBalance(r.balance);
      session = r.session_id;
    } else {
      kit.move(-stake);
    }
    hideBanner();
    resetBoard();
    const { cols, rows } = FIELDS[field];
    round = { stake, field, bombs: session ? null : Array.from({ length: cols }, () => Math.floor(Math.random() * rows)), col: 0, picks: [],
      auto, queue: auto ? queueOf() : [], session, waiting: false };
    phase = "ACTIVE";
    paint();
    announce("Kick-off: GHS " + money(stake) + ". " + (auto ? "Auto Game is playing your tiles." : "Pick a tile in the first column."));
    if (auto) runAuto(AUTO_START_MS);
  }

  function runAuto(delay) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(async () => {
      if (phase !== "ACTIVE" || !round.auto) return;
      const r = round.queue[round.col];
      if (r === undefined) return;
      await pick(round.col, r);
      if (phase === "ACTIVE") runAuto(AUTO_STEP_MS);
    }, delay);
  }

  async function pick(c, r) {
    if (phase !== "ACTIVE" || c !== round.col) return;
    let answer = null;
    if (round.session) {
      if (round.waiting) return;
      round.waiting = true;
      answer = await kit.request("step", { session_id: round.session, move: r });
      round.waiting = false;
      if (!answer || phase !== "ACTIVE") return;
      if (answer.status === "LOST") {
        round.bombs = answer.reveal.bombs;
        return lose(c, r);
      }
    } else if (round.bombs[c] === r) return lose(c, r);
    round.picks[c] = r;
    round.col = c + 1;
    const t = mults();
    reveal(c, r, "ball", { label: fmtX(t[round.col]) });
    kit.play("kick", c);
    if (round.col < F().cols) dribble(c, r);
    paint();
    const k = round.col;
    announce("Ball! " + fmtX(t[k]) + ". Cash out GHS " + money(payout(round.stake, t[k])) + (k < F().cols ? ", or pick in the next column for " + fmtX(t[k + 1]) + "." : "."));
    if (answer && answer.status === "WON") {   /* a goal or the top prize: the server paid out by itself */
      round.bombs = answer.reveal.bombs;
      setTimeout(() => finishWin(answer.payout, answer.balance), kit.reduceMotion ? 0 : 450);
      return;
    }
    if ((!answer && (k === F().cols || round.stake * t[k] >= MAX_WIN)) || (round.auto && k === round.queue.length)) {
      setTimeout(() => cashOut(), kit.reduceMotion ? 0 : 450);
    }
  }

  async function cashOut() {
    if (phase !== "ACTIVE" || round.col === 0) return;
    clearTimeout(autoTimer);
    if (round.session) {
      if (round.waiting) return;
      round.waiting = true;
      const r = await kit.request("cashout", { session_id: round.session });
      round.waiting = false;
      if (!r || phase !== "ACTIVE") return;
      round.bombs = r.reveal.bombs;
      finishWin(r.payout, r.balance);
      return;
    }
    finishWin(payout(round.stake, mults()[round.col]));
  }

  /* the round is won: real money passes the server's balance, credits are paid here */
  function finishWin(win, serverBalance) {
    clearTimeout(autoTimer);
    const k = round.col;
    const mult = mults()[k];
    const goal = k === F().cols;
    phase = "IDLE";
    if (serverBalance === undefined) kit.move(win);
    else kit.showBalance(serverBalance, win);
    showBombs();
    paint();
    showBanner((goal ? "GOAL! " : "You have cashed out! ") + fmtX(mult) + " | Win GHS " + money(win), "win");
    announce((goal ? "Goal! " : "Cashed out at ") + fmtX(mult) + ". You win GHS " + money(win) + ".");
    if (goal || mult >= 2) kit.celebrate();
    else kit.play("crowd", false);
  }

  function lose(c, r) {
    clearTimeout(autoTimer);
    phase = "IDLE";
    reveal(c, r, "bomb");
    showBombs();
    kit.boom();
    if (navigator.vibrate) navigator.vibrate(180);
    if (!kit.reduceMotion) {
      pitch.classList.remove("is-shaking");
      void pitch.offsetWidth;
      pitch.classList.add("is-shaking");
    }
    paint();
    showBanner("Bomb! The round is over.", "loss");
    announce("Bomb in column " + (c + 1) + ". The bet is lost.");
  }

  /* the floating banner at the top */
  let bannerTimer = 0;
  function showBanner(text, kind) {
    const b = $("glBanner");
    b.textContent = text;
    b.className = "gl-banner " + kind;
    b.hidden = false;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(hideBanner, 3600);
  }
  function hideBanner() {
    $("glBanner").hidden = true;
  }

  /* ---------------- tapping tiles, RANDOM, reset, Auto Game ---------------- */
  grid.addEventListener("click", (e) => {
    const t = e.target.closest(".gl-tile");
    if (!t) return;
    const c = Number(t.dataset.c), r = Number(t.dataset.r);
    if (phase === "ACTIVE") {
      if (!round.auto) pick(c, r);
    } else if (auto) {
      if (dirty) resetBoard();
      selected[c] = selected[c] === r ? undefined : r;
      paintSelection();
      paint();
    } else if (c === 0) {
      /* tapping the first column with no round on places the bet and plays that tile straight away */
      start();
      if (phase === "ACTIVE") setTimeout(() => pick(0, r), kit.reduceMotion ? 0 : 120);
    } else {
      U.toast("Start from the first column on the left (or press BET).", "");
    }
  });

  $("glRandom").addEventListener("click", () => {
    if (phase === "ACTIVE") {
      if (!round.auto) pick(round.col, Math.floor(Math.random() * F().rows));
    } else if (auto) {
      /* lines up a random tile in the first column without a pick */
      if (dirty) resetBoard();
      const c = queueOf().length;
      if (c >= F().cols) return;
      selected[c] = Math.floor(Math.random() * F().rows);
      paintSelection();
      paint();
    }
  });

  $("glRefresh").addEventListener("click", () => {
    if (phase === "ACTIVE") return;
    selected = [];
    dirty = true;
    hideBanner();
    resetBoard();
    paint();
  });

  $("glAuto").addEventListener("click", () => {
    if (phase === "ACTIVE") return;
    auto = !auto;
    selected = [];
    dirty = true;
    resetBoard();
    paint();
    announce(auto ? "Auto Game on. Pick a tile in each column you want played, from the left, then press BET." : "Auto Game off.");
  });

  Object.keys(FIELDS).forEach((k) => {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = FIELDS[k].name + " " + FIELDS[k].cols + "×" + FIELDS[k].rows;
    select.appendChild(o);
  });
  select.value = field;
  select.addEventListener("change", () => {
    if (phase === "ACTIVE") return;
    field = select.value;
    selected = [];
    round = null;
    dirty = true;
    hideBanner();
    resetBoard();
    paint();
  });

  goBtn.addEventListener("click", () => {
    if (phase === "IDLE") start();
    else if (round.col > 0 && !round.auto) cashOut();
    else if (!round.auto) U.toast("Find a ball first — you can cash out after the first column.", "");
  });

  /* ---------------- the bet ---------------- */
  function stepBet(dir) {
    const cur = kit.bet();
    const next = dir > 0 ? LADDER.find((v) => v > cur + 1e-9) || kit.maxBet() : LADDER.slice().reverse().find((v) => v < cur - 1e-9) || MIN_BET;
    kit.setBet(next);
    paint();
  }
  $("glMinus").addEventListener("click", () => stepBet(-1));
  $("glPlus").addEventListener("click", () => stepBet(1));
  const sheet = $("glBetSheet");
  window.VBMini.backdropClose(sheet);
  $("glStack").addEventListener("click", () => sheet.showModal());
  $("glSheetDone").addEventListener("click", () => sheet.close());
  $("glChips").addEventListener("click", (e) => {
    if (!e.target.closest("[data-chip]")) return;
    paint();
    sheet.close();
  });
  $("glHalf").addEventListener("click", () => { kit.setBet(kit.bet() / 2); paint(); });
  $("glDouble").addEventListener("click", () => { kit.setBet(kit.bet() * 2); paint(); });
  $("glMax").addEventListener("click", () => { kit.setBet(kit.maxBet()); paint(); });

  /* the rules' table of multipliers */
  $("glOdds").innerHTML = Object.keys(FIELDS).map((k) => "<tr><th>" + FIELDS[k].name + " " + FIELDS[k].cols + "×" + FIELDS[k].rows +
    "</th><td>" + multipliers(k).slice(1).map(fmtX).join(" · ") + "</td></tr>").join("");

  build();
  paint();

  /* a real-money round left open (the page was closed or reloaded) carries on from the column it reached */
  if (kit.isReal()) {
    kit.request("open").then((res) => {
      if (!res || !res.session || phase !== "IDLE") return;
      const sess = res.session;
      field = sess.state.field;
      select.value = field;
      dirty = true;
      resetBoard();
      round = { stake: sess.stake, field, bombs: null, col: sess.state.col, picks: sess.state.picks.slice(), auto: false, queue: [],
        session: sess.session_id, waiting: false };
      round.picks.forEach((r, c) => reveal(c, r, "ball"));
      phase = "ACTIVE";
      paint();
      U.toast("Your round in progress is back — pick on, or cash out.", "ok");
    });
  }
})();
