/* Blaze Fruits — the page: spins come from fruits-math.js and the reels animate them.
   State machine:  IDLE (bet, auto, max) → SPINNING (reels turn, stop one by one) → RESULT (lines, big win) → IDLE.
   The whole spin is decided by VBFruitsMath.spin() the moment Spin is pressed (for real money, by the server, and
   the page replays its seed); everything after is animation. The balance, menu, sounds and confetti come from the
   shared mini-game kit (minigame.js). */
(function () {
  "use strict";
  const U = window.VBUtil;
  const M = window.VBFruitsMath;
  const A = window.VBFruitsArt;
  const $ = (id) => document.getElementById(id);

  const MIN_BET = 0.2;
  const TABLE_MAX = 100;
  /* total bets: 20 lines × a whole number of pesewas, so every step is a multiple of ₵0.20 */
  const LADDER = [0.2, 0.4, 0.6, 0.8, 1, 1.6, 2, 3, 4, 5, 8, 10, 16, 20, 30, 40, 50, 80, 100];
  const QUICK = [0.2, 1, 5, 20, 100];
  const TIERS = [[100, "EPIC WIN"], [40, "MEGA WIN"], [15, "BIG WIN"]];   /* × the total bet */

  let phase = "IDLE";
  let turbo = false;
  let autoLeft = 0;          /* spins still to auto-play; -1 = until stopped */
  let lastWinEls = [];
  const reels = [];          /* { el, strip, cells:[3 imgs], spinning } */

  const kit = window.VBMini.create({
    prefix: "fr",
    winSound: "fanfare",
    gameId: "volta-fruits",
    server: true,
    minBet: MIN_BET,
    tableMax: TABLE_MAX,
    chips: [],
    busy: () => phase !== "IDLE",
    busyText: "Let the spin finish before switching.",
    onChange: () => paint(),
    confettiFrom: () => $("frFrame"),
    confettiStyle: "coins"
  });
  const { money, announce } = kit;
  const cedi = (v) => "₵" + money(v);
  const cents = (v) => Math.floor(v * 100 + 1e-6) / 100;
  const bet = () => kit.bet();
  const lineBet = () => bet() / M.LINES.length;
  const pace = () => (turbo ? 0.45 : 1);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms * pace()));

  /* ---------------- art and the reels ---------------- */
  const art = A.symbols();
  A.embers($("frEmbers"));
  const srcOf = (s) => art[M.SYMBOLS[s]];
  const NAMES = ["Seven", "Watermelon", "Grapes", "Plum", "Orange", "Lemon", "Cherries", "Star"];
  const STRIP = 14;   /* symbols on a reel strip while it spins: 3 showing + the rest scrolling through */

  function buildReels() {
    const host = $("frReels");
    host.innerHTML = "";
    for (let c = 0; c < M.COLS; c++) {
      const el = document.createElement("div");
      el.className = "fr-reel";
      const strip = document.createElement("div");
      strip.className = "fr-strip";
      const cells = [];
      for (let i = 0; i < STRIP; i++) {
        const cell = document.createElement("div");
        cell.className = "fr-cell";
        const img = document.createElement("img");
        img.alt = "";
        img.draggable = false;
        img.src = srcOf(Math.floor(Math.random() * 7));
        cell.appendChild(img);
        strip.appendChild(cell);
        cells.push(cell);
      }
      el.appendChild(strip);
      host.appendChild(el);
      reels.push({ el, strip, cells, spinning: false, offset: 0 });
    }
  }
  /* the three symbols a reel shows at rest live in strip cells 0–2; the rest are the blur behind them */
  const show = (reel, syms) => syms.forEach((s, row) => { reel.cells[row].firstChild.src = srcOf(s); reel.cells[row].dataset.sym = s; });

  /* a reel spinning: the strip scrolls down continuously, wrapping cells from the bottom back to the top */
  function startReel(reel) {
    reel.spinning = true;
    reel.el.classList.remove("landed");
    reel.el.classList.add("spinning");
    const cellH = () => reel.el.clientHeight / M.ROWS;
    let y = 0, last = performance.now();
    const speed = turbo ? 2.6 : 2.0;   /* reel heights per second */
    const tick = (now) => {
      if (!reel.spinning) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      y += speed * reel.el.clientHeight * dt;
      const h = cellH();
      while (y >= h) {
        y -= h;
        /* move the last cell to the front with a fresh random symbol */
        const cell = reel.strip.lastElementChild;
        cell.firstChild.src = srcOf(Math.floor(Math.random() * M.SYMBOLS.length));
        reel.strip.insertBefore(cell, reel.strip.firstElementChild);
      }
      reel.strip.style.transform = "translateY(" + (y - h) + "px)";
      requestAnimationFrame(tick);
    };
    reel.strip.style.transform = "translateY(" + (-cellH()) + "px)";
    requestAnimationFrame(tick);
  }
  function stopReel(reel, syms) {
    reel.spinning = false;
    reel.cells = Array.from(reel.strip.children);
    reel.strip.style.transform = "translateY(0)";
    show(reel, syms);
    reel.el.classList.remove("spinning");
    reel.el.classList.add("landed");
    kit.flick();
  }

  /* ---------------- sound ---------------- */
  let whir = null;
  function startWhir() {
    const ac = kit.audio();
    if (!ac) return;
    const len = Math.floor(ac.sampleRate * 2);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1);
    const src = ac.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 900;
    f.Q.value = 0.8;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.05, ac.currentTime + 0.15);
    src.connect(f).connect(g).connect(ac.destination);
    src.start();
    whir = { src, g, ac };
  }
  function stopWhir() {
    if (!whir) return;
    const { src, g, ac } = whir;
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.25);
    src.stop(ac.currentTime + 0.3);
    whir = null;
  }

  /* ---------------- paylines ---------------- */
  const svg = $("frLinesSvg");
  function cellCentre(col, row) {
    const host = $("frReels");
    const reel = reels[col].el;
    const base = host.getBoundingClientRect();
    const r = reel.getBoundingClientRect();
    const cellH = r.height / M.ROWS;
    return [r.left - base.left + r.width / 2, r.top - base.top + cellH * (row + 0.5)];
  }
  function drawLines(wins) {
    const host = $("frReels");
    svg.setAttribute("viewBox", "0 0 " + host.clientWidth + " " + host.clientHeight);
    svg.innerHTML = wins.map((w) => {
      const rows = M.LINES[w.line];
      const pts = rows.map((row, col) => cellCentre(col, row).join(",")).join(" ");
      return '<polyline class="under" points="' + pts + '"/><polyline points="' + pts + '"/>';
    }).join("");
  }
  function clearLines() {
    svg.innerHTML = "";
    $("frLineWin").hidden = true;
    lastWinEls.forEach((el) => el.classList.remove("hot"));
    lastWinEls = [];
    $("frReels").classList.remove("dim");
  }
  function light(cells) {
    lastWinEls.forEach((el) => el.classList.remove("hot"));
    lastWinEls = cells.map(([col, row]) => reels[col].cells[row]);
    lastWinEls.forEach((el) => el.classList.add("hot"));
  }

  /* shows every winning line together, then each in turn with its pay, until the next spin */
  let cycle = 0;
  async function presentWins(r) {
    const mine = ++cycle;
    const all = r.lines.map((w) => ({ ...w, label: w.count + " × " + NAMES[w.symbol] + " · " + cedi(cents(w.pay * lineBet())) }));
    if (r.scatterPay) all.push({ line: -1, cells: r.scatterCells, label: r.scatterCells.length + " × Star · " + cedi(cents(r.scatterPay * lineBet())) });
    if (!all.length) return;
    $("frReels").classList.add("dim");
    drawLines(all.filter((w) => w.line >= 0));
    light(all.flatMap((w) => w.cells));
    $("frLineWin").hidden = all.length > 1;
    $("frLineWin").textContent = all[0].label;
    if (all.length === 1) return;
    await sleep(1400);
    for (let i = 0; mine === cycle; i = (i + 1) % all.length) {
      const w = all[i];
      drawLines(w.line >= 0 ? [w] : []);
      light(w.cells);
      $("frLineWin").hidden = false;
      $("frLineWin").textContent = w.label;
      await sleep(1100);
    }
  }

  /* ---------------- the big win ---------------- */
  function overlay(id, ms) {
    const el = $(id);
    el.hidden = false;
    return new Promise((res) => {
      let t = 0;
      const close = () => { clearTimeout(t); el.removeEventListener("click", close); el.hidden = true; res(); };
      el.addEventListener("click", close);
      t = setTimeout(close, ms * pace());
    });
  }
  async function bigWin(win) {
    const x = win / bet();
    const tier = TIERS.find(([k]) => x >= k);
    if (!tier) return;
    $("frBigWord").textContent = tier[1];
    const amt = $("frBigAmt");
    const shown = overlay("frBigWin", 5200);
    kit.celebrate("fanfare");
    const start = performance.now(), dur = 2600 * pace();
    (function tick(now) {
      const k = Math.min(1, (now - start) / dur);
      amt.textContent = cedi(cents(win * (1 - Math.pow(1 - k, 3))));
      if (k < 1 && !$("frBigWin").hidden) requestAnimationFrame(tick);
      else amt.textContent = cedi(win);
    })(start);
    await shown;
  }

  /* ---------------- a spin ---------------- */
  function setPrompt(t) { $("frPrompt").textContent = t; }
  function setWin(v) {
    const el = $("frWin");
    el.textContent = cedi(v);
    const box = el.parentElement;
    box.classList.remove("pop");
    if (v > 0) { void box.offsetWidth; box.classList.add("pop"); }
  }

  async function spinOnce() {
    if (phase !== "IDLE") return false;
    const stake = bet();
    if (!kit.canAfford(stake)) return false;
    phase = "SPINNING";
    kit.unlockAudio();
    cycle++;
    clearLines();
    setWin(0);
    paint();
    /* the spin, decided now: for real money the server plays it from four random words and pays it, and the same
       words replay the identical spin here; with credits the page draws it */
    const round = await kit.place(stake, { bet: stake });
    if (round === false) { phase = "IDLE"; paint(); return false; }
    const r = round ? M.spin(M.seeded(round.outcome.seed)) : M.spin(Math.random);
    setPrompt("GOOD LUCK!");
    $("frSpin").classList.add("spinning");
    startWhir();
    reels.forEach((reel, i) => setTimeout(() => startReel(reel), i * 60 * pace()));
    /* the reels run, then stop one after another from the left */
    await sleep(turbo ? 500 : 1100);
    for (let c = 0; c < M.COLS; c++) {
      stopReel(reels[c], r.grid[c]);
      /* a third star in sight, or a run of sevens, makes the next reel hang a moment longer */
      const tease = c >= 1 && c < M.COLS - 1 && (r.grid.slice(0, c + 1).flat().filter((s) => s === M.SCATTER).length >= 2 || r.grid.slice(0, c + 1).every((reel) => reel.includes(M.WILD)));
      await sleep(tease ? 650 : 260);
    }
    stopWhir();
    $("frSpin").classList.remove("spinning");

    /* settle: the spin's win, rounded down to the cent */
    const win = round ? round.payout : cents(r.win * lineBet());
    phase = "RESULT";
    if (win > 0) {
      setWin(win);
      setPrompt("WIN " + cedi(win) + (r.capped ? " · MAX WIN" : ""));
      announce("You win " + cedi(win) + ".");
      if (win / stake >= TIERS[TIERS.length - 1][0]) kit.play("tada"); else kit.chime();
      kit.collect(win);
      presentWins(r);
      await bigWin(win);
      await sleep(win / stake >= 5 ? 900 : 500);
    } else {
      kit.collect(0);
      setPrompt("PLACE YOUR BET");
      announce("No win this time.");
      await sleep(150);
    }
    phase = "IDLE";
    paint();
    return true;
  }

  async function autoRun() {
    while (autoLeft !== 0 && phase === "IDLE") {
      const ok = await spinOnce();
      if (!ok) break;
      if (autoLeft > 0) autoLeft--;
      paintAuto();
      if (autoLeft !== 0) await sleep(650);
    }
    autoLeft = 0;
    paintAuto();
  }
  function paintAuto() {
    const on = autoLeft !== 0;
    $("frAuto").setAttribute("aria-pressed", String(on));
    $("frAuto").querySelector("span").textContent = on ? "Stop" : "Auto";
    const left = $("frAutoLeft");
    left.hidden = !on;
    left.textContent = autoLeft < 0 ? "∞" : autoLeft;
  }

  /* ---------------- bet controls ---------------- */
  function step(dir) {
    const v = bet();
    const next = dir > 0 ? LADDER.find((x) => x > v + 1e-9) || kit.maxBet() : LADDER.slice().reverse().find((x) => x < v - 1e-9) || MIN_BET;
    kit.setBet(Math.min(next, kit.maxBet()));
    kit.flick();
    paint();
  }
  function paint() {
    const idle = phase === "IDLE";
    $("frBet").textContent = cedi(bet());
    $("frMinus").disabled = !idle || bet() <= MIN_BET + 1e-9;
    $("frPlus").disabled = !idle || bet() >= kit.maxBet() - 1e-9;
    $("frMax").disabled = !idle;
    $("frSpin").disabled = !idle && autoLeft === 0;
    document.querySelectorAll("#frQuick button").forEach((b) => {
      b.setAttribute("aria-pressed", String(Math.abs(Number(b.dataset.bet) - bet()) < 1e-9));
      b.disabled = !idle || Number(b.dataset.bet) > kit.maxBet() + 1e-9;
    });
  }

  $("frQuick").innerHTML = QUICK.map((v) => '<button type="button" data-bet="' + v + '">' + cedi(v) + "</button>").join("");
  $("frQuick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-bet]");
    if (!b || phase !== "IDLE") return;
    kit.setBet(Math.min(Number(b.dataset.bet), kit.maxBet()));
    kit.flick();
    paint();
  });
  $("frMinus").addEventListener("click", () => step(-1));
  $("frPlus").addEventListener("click", () => step(1));
  $("frMax").addEventListener("click", () => { if (phase === "IDLE") { kit.setBet(kit.maxBet()); kit.flick(); paint(); } });
  $("frSpin").addEventListener("click", () => {
    if (autoLeft !== 0) { autoLeft = 0; paintAuto(); return; }
    spinOnce();
  });
  $("frAuto").addEventListener("click", () => {
    if (autoLeft !== 0) { autoLeft = 0; paintAuto(); return; }
    $("frAutos").hidden = !$("frAutos").hidden;
  });
  $("frAutos").addEventListener("click", (e) => {
    const b = e.target.closest("[data-auto]");
    if (!b) return;
    $("frAutos").hidden = true;
    autoLeft = Number(b.dataset.auto);
    paintAuto();
    autoRun();
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#frAutos") && !e.target.closest("#frAuto")) $("frAutos").hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.code === "Space" && !e.target.closest("input,select,textarea,dialog")) { e.preventDefault(); $("frSpin").click(); } });

  /* quick spin */
  const paintTurbo = () => {
    $("frTurbo").setAttribute("aria-pressed", String(turbo));
    $("frTurbo").querySelector("span").textContent = "Quick spin: " + (turbo ? "on" : "off");
  };
  $("frTurbo").addEventListener("click", () => { turbo = !turbo; try { localStorage.setItem("vb.fruits.turbo", turbo ? "1" : ""); } catch (e) { /* storage unavailable */ } paintTurbo(); });
  try { turbo = localStorage.getItem("vb.fruits.turbo") === "1"; } catch (e) { /* storage unavailable */ }
  paintTurbo();

  /* ---------------- the paytable ---------------- */
  (function rules() {
    const head = "<tr><th>Symbol</th><th>×3</th><th>×4</th><th>×5</th></tr>";
    $("frPays").innerHTML = head + M.PAYS.map((row, i) => i === M.SCATTER ? "" :
      '<tr><td><img src="' + srcOf(i) + '" alt="">' + NAMES[i] + (i === M.WILD ? " (wild)" : "") + "</td>" + row.map((p) => "<td>" + p + "</td>").join("") + "</tr>").join("");
    $("frScat").textContent = M.SCATTER_PAYS.join(" / ");
    const e = M.exactRtp();
    $("frRtpExact").textContent = (e.rtp * 100).toFixed(2) + "%";
    $("frRtpLines").textContent = (e.lines * 100).toFixed(2) + "%";
    $("frRtpScat").textContent = (e.scatters * 100).toFixed(2) + "%";
    $("frRtp").textContent = M.RTP.toFixed(2) + "%";
  })();

  buildReels();
  reels.forEach((reel) => show(reel, [Math.floor(Math.random() * 7), Math.floor(Math.random() * 7), Math.floor(Math.random() * 7)]));
  kit.setBet(1);
  paint();
  setPrompt("PLACE YOUR BET");
})();
