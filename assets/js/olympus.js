/* Rendo Olympus — the page: plays rounds from olympus-math.js and animates them.
   State machine:  IDLE (bet, Ante bet, Buy) → SPINNING (drop, tumbles, orbs, free spins) → RESULT (win pop-up) → IDLE.
   The whole round is drawn by VBOlympusMath.round() the moment Spin (or Buy) is pressed; everything after is
   animation. Tapping Spin during a round only speeds the animation up ("TAP TO STOP REELS!").
   The balance, menu, sounds and confetti come from the shared mini-game kit (minigame.js). */
(function () {
  "use strict";
  const U = window.VBUtil;
  const M = window.VBOlympusMath;
  const A = window.VBOlympusArt;
  const $ = (id) => document.getElementById(id);

  const MIN_BET = 0.2;
  const TABLE_MAX = 100;
  const LADDER = [0.2, 0.4, 0.6, 0.8, 1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10, 15, 20, 25, 50, 100];
  const BANNERS = ["WIN UP TO 15,000X BET", "HIT 4× SCATTER TO WIN FREE SPINS", "8 OR MORE PAY ANYWHERE", "ORBS MULTIPLY YOUR TUMBLE WIN"];
  const TIERS = [[100, "SENSATIONAL!"], [50, "SUPERB!"], [25, "MEGA WIN!"], [10, "NICE!"]];

  const grid = $("olGrid");
  const spinBtn = $("olSpin");
  const banner = $("olBanner");
  const prompt = $("olPrompt");

  let phase = "IDLE";       /* IDLE → SPINNING → RESULT → IDLE */
  let ante = false;
  let turbo = false;        /* the menu's quick spin */
  let fast = false;         /* this round only: the player tapped to hurry it */
  let bannerTimer = 0, bannerAt = 0;
  const els = new Map();    /* cell id → element on the grid */

  const kit = window.VBMini.create({
    prefix: "ol",
    winSound: "heavenly",   /* this game's own win sound (minigame.js SFX) */
    gameId: "volta-olympus",
    server: true,           /* signed-in players spin for real money; the server plays and pays each round */
    minBet: MIN_BET,
    tableMax: TABLE_MAX,
    chips: [],
    busy: () => phase !== "IDLE",
    busyText: "Let the round finish before switching.",
    onChange: () => paint(),
    confettiFrom: () => $("olFrame"),
    confettiStyle: "coins"
  });
  const { money, announce } = kit;
  const cedi = (v) => "₵" + money(v);
  const cents = (v) => Math.floor(v * 100 + 1e-6) / 100;   /* pay outs are rounded down to the cent */
  /* the Ante bet's cost rounds up to the cent, exactly as the server charges it */
  const anteCost = (b) => Math.ceil(b * M.ANTE_COST * 100 - 1e-6) / 100;

  /* ---------------- art ---------------- */
  A.sky($("olSky"));
  const zeus = A.zeus($("olZeus"));
  const SPRITE = 150;
  const sprites = A.symbols(SPRITE);
  const pillar = A.pillar(40, 400);
  document.querySelectorAll(".ol-pillar").forEach((p) => (p.style.backgroundImage = "url(" + pillar + ")"));
  const srcOf = (c) => (c.s === M.ORB ? A.orb(c.m, SPRITE) : c.s === M.SCATTER ? sprites.scatter : sprites[M.SYMBOLS[c.s]]);
  const NAMES = ["Crown", "Hourglass", "Ring", "Chalice", "Red gem", "Purple gem", "Yellow gem", "Green gem", "Blue gem"];

  /* ---------------- timing ---------------- */
  const pace = () => (fast || turbo ? 0.35 : 1);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms * pace()));

  /* ---------------- sound ---------------- */
  function noise(dur, type, f0, f1, vol, q) {
    const ac = kit.audio();
    if (!ac) return;
    const t = ac.currentTime;
    const len = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = ac.createBufferSource();
    src.buffer = buf;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.Q.value = q || 1;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ac.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(ac.destination);
    src.start(t);
  }
  const thud = () => noise(0.12, "lowpass", 900, 120, 0.35);           /* a column landing */
  const shatter = () => noise(0.35, "highpass", 2500, 5000, 0.18);     /* winning gems bursting */

  /* ---------------- the grid ---------------- */
  function place(el, c, r) {
    el.style.left = (c * 100) / M.COLS + "%";
    el.style.top = (r * 100) / M.ROWS + "%";
  }

  function makeCell(cell, c, r) {
    const el = document.createElement("div");
    el.className = "ol-cell" + (cell.s === M.ORB ? " is-orb" : cell.s === M.SCATTER ? " is-scatter" : "");
    el.innerHTML = '<img alt="" draggable="false" src="' + srcOf(cell) + '">';
    place(el, c, r);
    grid.appendChild(el);
    els.set(cell.id, el);
    return el;
  }

  /* drops a whole new grid in, column by column, after the old one falls away */
  async function dropIn(g, spinMs) {
    const old = Array.from(els.values());
    els.clear();
    old.forEach((el, i) => {
      const c = Math.round(parseFloat(el.style.left) / (100 / M.COLS));
      el.animate([{ transform: "none" }, { transform: "translateY(" + M.ROWS * 110 + "%)", opacity: 0.2 }],
        { duration: 380 * pace(), delay: c * 40 * pace(), easing: "cubic-bezier(.5,0,1,.6)", fill: "forwards" })
        .finished.then(() => el.remove());
    });
    if (old.length) await sleep(220);
    if (spinMs) {
      await spinReels(g, spinMs);
      return;
    }
    const done = [];
    g.forEach((col, c) => col.forEach((cell, r) => {
      const el = makeCell(cell, c, r);
      const a = el.animate([{ transform: "translateY(" + -(M.ROWS + 1) * 100 + "%)" }, { transform: "none" }],
        { duration: 460 * pace(), delay: (c * 75 + (M.ROWS - 1 - r) * 30) * pace(), easing: "cubic-bezier(.3,.6,.5,1.12)", fill: "backwards" });
      done.push(a.finished);
      if (r === 0) setTimeout(thud, (c * 75 + 380) * pace());
    }));
    await Promise.all(done);
  }

  /* the build-up: every column spins as a blurred strip of random symbols for spinMs (10–15 s on a paid spin), then
     the columns stop one by one, left to right, landing the grid that was already drawn. Tapping Spin cuts it short. */
  let stopNow = null;
  async function spinReels(g, spinMs) {
    const pool = M.SYMBOLS.map((k) => sprites[k]);   /* no scatters flashing past: they'd tease more than really land */
    const strips = g.map((_, c) => {
      const strip = document.createElement("div");
      strip.className = "ol-strip";
      strip.style.left = (c * 100) / M.COLS + "%";
      let imgs = "";
      for (let k = 0; k < 10; k++) imgs += '<img alt="" src="' + pool[Math.floor(Math.random() * pool.length)] + '">';
      strip.innerHTML = '<div class="ol-strip-run" style="animation-duration:' + (0.32 + c * 0.02) + 's">' + imgs + imgs + "</div>";
      grid.appendChild(strip);
      return strip;
    });
    await new Promise((res) => {
      const t = setTimeout(res, spinMs);
      stopNow = () => {
        clearTimeout(t);
        res();
      };
    });
    stopNow = null;
    for (let c = 0; c < M.COLS; c++) {
      strips[c].remove();
      const done = g[c].map((cell, r) => makeCell(cell, c, r).animate(
        [{ transform: "translateY(" + -(M.ROWS - r) * 40 + "%)" }, { transform: "none" }],
        { duration: 300, easing: "cubic-bezier(.3,.7,.4,1.25)" }).finished);
      setTimeout(thud, 220);
      await Promise.all(done);
      await sleep(fast ? 40 : 150);
    }
  }

  /* winning symbols glow, then burst into sparks */
  async function explode(wins) {
    const cells = [].concat(...wins.map((w) => w.cells));
    const ids = [];
    cells.forEach(([c, r]) => {
      const id = cur[c][r].id;
      ids.push(id);
      els.get(id).classList.add("is-win");
    });
    kit.play("harp", step);
    await sleep(760);
    shatter();
    ids.forEach((id, k) => {
      const el = els.get(id);
      el.classList.add("is-pop");
      if (!kit.reduceMotion && k % 2 === 0) {
        for (let i = 0; i < 7; i++) {
          const sp = document.createElement("i");
          sp.className = "ol-spark";
          const a = Math.random() * Math.PI * 2, d = 40 + Math.random() * 60;
          sp.style.setProperty("--dx", Math.cos(a) * d + "%");
          sp.style.setProperty("--dy", Math.sin(a) * d + "%");
          sp.style.left = el.style.left;
          sp.style.top = el.style.top;
          grid.appendChild(sp);
          setTimeout(() => sp.remove(), 700);
        }
      }
    });
    await sleep(330);
    ids.forEach((id) => {
      els.get(id).remove();
      els.delete(id);
    });
  }

  /* after a burst: survivors fall to their new rows, new symbols drop in from above */
  async function fall(next) {
    const done = [];
    next.forEach((col, c) => {
      const fresh = col.filter((x) => !els.has(x.id)).length;
      col.forEach((cell, r) => {
        let el = els.get(cell.id), from;
        if (el) {
          const oldR = Math.round(parseFloat(el.style.top) / (100 / M.ROWS));
          if (oldR === r) return;
          from = -(r - oldR) * 100;
          place(el, c, r);
        } else {
          el = makeCell(cell, c, r);
          from = -(fresh + 0.3) * 100;
        }
        done.push(el.animate([{ transform: "translateY(" + from + "%)" }, { transform: "none" }],
          { duration: 380 * pace(), delay: c * 30 * pace(), easing: "cubic-bezier(.35,.7,.5,1.1)", fill: "backwards" }).finished);
      });
    });
    await Promise.all(done);
    if (done.length) thud();
  }

  let cur = null;   /* the grid on show */
  let step = 0;

  /* plays one spin's drop and tumbles; returns its pay × bet (orbs applied) for the counter */
  async function playSpin(s, opts) {
    const o = opts || {};
    cur = s.steps[0].grid;
    await dropIn(cur, o.spinMs);
    let tumble = 0;
    for (step = 0; step < s.steps.length; step++) {
      const st = s.steps[step];
      if (!st.wins.length) break;
      tumble += st.pay;
      showTumble((o.carry || 0) + tumble * bet());
      setBanner("TUMBLE WIN " + cedi(cents((o.carry || 0) + tumble * bet())));
      announce(st.wins.map((w) => w.count + " × " + NAMES[w.sym]).join(", ") + " — win " + cedi(cents(st.pay * bet())));
      await explode(st.wins);
      cur = s.steps[step + 1].grid;
      await fall(cur);
    }
    /* orbs: in the base game they multiply this spin; in free spins they feed the running multiplier */
    let pay = s.win;
    const mult = o.free ? o.multAfter : s.orbs;   /* free spins: the running total, which this spin's orbs joined */
    if (s.win > 0 && mult > 0) {
      if (s.orbs > 0) {
        grid.querySelectorAll(".is-orb").forEach((el) => el.classList.add("is-charged"));
        zeus.strike();
        kit.play("thunder");
        grid.classList.remove("is-flash");
        void grid.offsetWidth;
        grid.classList.add("is-flash");
        await sleep(700);
      }
      pay = s.win * mult;
      showTumble((o.carry || 0) + s.win * bet(), mult);
      await sleep(900);
      showTumble((o.carry || 0) + pay * bet());
      setBanner("TUMBLE WIN " + cedi(cents((o.carry || 0) + pay * bet())));
      if (o.free) $("olFsMult").textContent = "x" + o.multAfter;
      await sleep(500);
    }
    /* scatters glow, and pay */
    if (s.scatters >= (o.free ? 3 : 4)) {
      grid.querySelectorAll(".is-scatter").forEach((el) => el.classList.add("is-win"));
      kit.play("bell");
      await sleep(1100);
    }
    return pay + s.scatterPay;
  }

  function showTumble(amount, mult) {
    const t = $("olTumble");
    t.hidden = false;
    $("olTumbleAmt").innerHTML = mult ? cedi(cents(amount)) + ' <em>× ' + mult + "</em>" : cedi(cents(amount));
    t.classList.remove("bump");
    void t.offsetWidth;
    t.classList.add("bump");
  }

  /* ---------------- overlays ---------------- */
  function overlay(id, ms) {
    const el = $(id);
    el.hidden = false;
    return new Promise((res) => {
      let t = 0;
      const close = () => {
        clearTimeout(t);
        el.removeEventListener("click", close);
        el.hidden = true;
        res();
      };
      el.addEventListener("click", close);
      t = setTimeout(close, ms * (turbo ? 0.5 : 1));
    });
  }

  async function winPopup(win) {
    const x = win / bet();
    const tier = TIERS.find(([k]) => x >= k);
    $("olWinWord").textContent = tier ? tier[1] : "WIN";
    const amt = $("olWinAmt");
    const shown = overlay("olWin", tier ? 5200 : 2400);
    if (tier) kit.celebrate();
    else kit.play("heavenly", false);
    /* the amount counts up */
    const start = performance.now(), dur = (tier ? 2600 : 900) * (turbo ? 0.5 : 1);
    (function tick(now) {
      const k = Math.min(1, (now - start) / dur);
      amt.textContent = cedi(cents(win * (1 - Math.pow(1 - k, 3))));
      if (k < 1 && !$("olWin").hidden) requestAnimationFrame(tick);
      else amt.textContent = cedi(win);
    })(start);
    await shown;
  }

  /* ---------------- a round ---------------- */
  const bet = () => kit.bet();

  async function play(kind) {
    if (phase !== "IDLE") return;
    const cost = kind === "ante" ? anteCost(bet()) : cents(bet() * (kind === "buy" ? M.BUY_COST : 1));
    if (!kit.canAfford(cost)) return;
    kit.unlockAudio();
    phase = "SPINNING";
    fast = false;
    stopBanner();
    paint();
    /* the whole round, decided now: for real money the server plays it from four random words and pays it, and
       the same words replay the identical round here for the animation; with credits the page draws it */
    const round = await kit.place(cost, { kind, bet: bet() });
    if (round === false) {
      phase = "IDLE";
      paint();
      return;
    }
    const r = round ? M.round(M.seeded(round.outcome.seed), kind) : M.round(Math.random, kind);
    setPrompt("GOOD LUCK!");
    setTimeout(() => phase === "SPINNING" && setPrompt("TAP TO STOP REELS!"), 700);
    $("olTumble").hidden = true;

    let total = 0;   /* × bet, as shown so far */
    if (kind === "buy") announce("Free spins bought for " + cedi(cost) + ".");
    /* a paid spin takes 10–15 seconds from the press to the outcome: ~1 s for the old grid to fall away, the reels
       spinning 6.5–11.5 s, then ~2.5 s for the columns to stop one by one. Free spins spin for 2–3 s. */
    total += await playSpin(r.base, { spinMs: 6500 + Math.random() * 5000 });
    if (r.base.scatterPay) setBanner("SCATTER WIN " + cedi(cents(r.base.scatterPay * bet())));

    if (r.free.length) {
      $("olFsTitle").textContent = M.FREE_SPINS + " FREE SPINS";
      $("olFsSub").textContent = "Multiplier orbs add up for the whole feature";
      kit.celebrate("bell");
      await overlay("olFsIntro", 3000);
      document.body.classList.add("in-free");
      const hud = $("olFsHud");
      hud.hidden = false;
      $("olFsMult").textContent = "x0";
      let shownLeft = M.FREE_SPINS;
      for (let i = 0; i < r.free.length; i++) {
        const f = r.free[i];
        shownLeft--;
        $("olFsLeft").textContent = shownLeft;
        await playSpin(f.spin, { free: true, multAfter: f.mult, carry: total * bet(), spinMs: 2000 + Math.random() * 1000 });
        total += f.pay;
        showTumble(total * bet());
        if (f.spin.scatters >= 3) {
          shownLeft += M.RETRIGGER;
          $("olFsLeft").textContent = shownLeft;
          setBanner("+" + M.RETRIGGER + " FREE SPINS");
          await sleep(900);
        }
        await sleep(350);
      }
      hud.hidden = true;
      document.body.classList.remove("in-free");
      $("olFsTitle").textContent = "FEATURE WIN";
      $("olFsSub").textContent = cedi(cents(r.win * bet())) + " in " + r.free.length + " free spins";
      await overlay("olFsIntro", 3200);
    }

    /* settle: the round's win, capped, rounded down to the cent */
    const win = round ? round.payout : cents(r.win * bet());
    kit.collect(win);
    phase = "RESULT";
    setPrompt(win > 0 ? "WIN " + cedi(win) : "PLACE YOUR BETS!");
    if (r.capped) setBanner("MAX WIN 15,000X!");
    if (win > 0) {
      setBanner("WIN " + cedi(win));
      announce("Round over: you win " + cedi(win) + ".");
      await winPopup(win);
    } else {
      announce("No win this time.");
    }
    phase = "IDLE";
    setPrompt("PLACE YOUR BETS!");
    paint();
    startBanner(4000);
  }

  /* ---------------- banner and prompt ---------------- */
  function setBanner(text) {
    banner.textContent = text;
    banner.classList.remove("flip");
    void banner.offsetWidth;
    banner.classList.add("flip");
  }
  function startBanner(delay) {
    stopBanner();
    bannerTimer = setTimeout(function next() {
      setBanner(BANNERS[bannerAt++ % BANNERS.length]);
      bannerTimer = setTimeout(next, 3200);
    }, delay || 0);
  }
  function stopBanner() {
    clearTimeout(bannerTimer);
  }
  const setPrompt = (t) => (prompt.textContent = t);

  /* ---------------- controls ---------------- */
  function paint() {
    const idle = phase === "IDLE";
    kit.paintBet(!idle);
    $("olBet").textContent = cedi(ante ? anteCost(bet()) : cents(bet()));
    $("olBuyCost").textContent = cedi(cents(bet() * M.BUY_COST));
    $("olBuyDlgCost").textContent = cedi(cents(bet() * M.BUY_COST));
    $("olAnteCost").textContent = "BET " + cedi(anteCost(bet()));
    $("olAnte").setAttribute("aria-checked", String(ante));
    $("olAnte").disabled = !idle;
    $("olBuy").disabled = !idle || ante;
    $("olBuy").title = ante ? "Not available with Ante bet" : "";
    $("olMinus").disabled = !idle || bet() <= MIN_BET + 1e-9;
    $("olPlus").disabled = !idle || bet() >= kit.maxBet() - 1e-9;
    spinBtn.classList.toggle("is-busy", !idle);
    spinBtn.setAttribute("aria-label", idle ? "Spin" : "Speed up");
  }

  function stepBet(dir) {
    const v = bet();
    const next = dir > 0 ? LADDER.find((x) => x > v + 1e-9) || kit.maxBet() : LADDER.slice().reverse().find((x) => x < v - 1e-9) || MIN_BET;
    kit.setBet(next);
    paint();
  }
  $("olMinus").addEventListener("click", () => stepBet(-1));
  $("olPlus").addEventListener("click", () => stepBet(1));

  spinBtn.addEventListener("click", () => {
    if (phase === "IDLE") play(ante ? "ante" : "spin");
    else if (phase === "SPINNING" && !fast) {
      fast = true;   /* tap to stop: the reels stop now and the rest of the round plays quickly */
      if (stopNow) stopNow();
      setPrompt("GOOD LUCK!");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || e.target.closest("input, select, textarea, dialog, [role=switch]")) return;
    e.preventDefault();
    if (!$("olWin").hidden) $("olWin").click();
    else if (!$("olFsIntro").hidden) $("olFsIntro").click();
    else spinBtn.click();
  });

  $("olAnte").addEventListener("click", () => {
    if (phase !== "IDLE") return;
    ante = !ante;
    paint();
    announce(ante ? "Ante bet on: spins cost 25% more and the feature comes about twice as often." : "Ante bet off.");
  });

  const buyDlg = $("olBuyDlg");
  window.VBMini.backdropClose(buyDlg);
  $("olBuy").addEventListener("click", () => {
    if (phase !== "IDLE") return;
    if (ante) {
      U.toast("Turn Ante bet off to buy free spins.", "err");
      return;
    }
    buyDlg.showModal();
  });
  $("olBuyNo").addEventListener("click", () => buyDlg.close());
  $("olBuyYes").addEventListener("click", () => {
    buyDlg.close();
    play("buy");
  });

  const paintTurbo = () => {
    $("olTurbo").setAttribute("aria-pressed", String(turbo));
    $("olTurbo").querySelector("span").textContent = "Quick spin: " + (turbo ? "on" : "off");
  };
  $("olTurbo").addEventListener("click", () => {
    turbo = !turbo;
    paintTurbo();
  });

  /* ---------------- rules: the paytable and the measured return ---------------- */
  function paintRules() {
    const head = "<tr><th></th><th>8–9</th><th>10–11</th><th>12+</th></tr>";
    $("olPays").innerHTML = head + M.PAYS.map((row, i) =>
      '<tr><th><img alt="" src="' + sprites[M.SYMBOLS[i]] + '"> ' + NAMES[i] + "</th>" + row.map((v) => "<td>" + v + "×</td>").join("") + "</tr>").join("") +
      '<tr><th><img alt="" src="' + sprites.scatter + '"> Scatter</th><td>4: ' + M.SCATTER_PAYS[4] + "×</td><td>5: " + M.SCATTER_PAYS[5] + "×</td><td>6: " + M.SCATTER_PAYS[6] + "×</td></tr>";
    const m = M.MEASURED;
    $("olRtp").textContent = m.rtp.toFixed(1) + "%";
    $("olRtpBase").textContent = m.rtp.toFixed(1) + "%";
    $("olRtpAnte").textContent = m.ante.toFixed(1) + "%";
    $("olRtpBuy").textContent = m.buy.toFixed(1) + "%";
    $("olRulesN").textContent = m.rounds.toLocaleString("en-GH");
    $("olRulesBuyN").textContent = m.buyRounds.toLocaleString("en-GH");
    $("olRtpMargin").textContent = m.margin;
  }

  /* a first grid to look at, with no wins on it */
  let first;
  do first = M.freshGrid(Math.random, "base"); while (M.wins(first).length);
  first.forEach((col, c) => col.forEach((cell, r) => makeCell(cell, c, r)));

  paintRules();
  paintTurbo();
  kit.setBet(1);
  paint();
  startBanner(0);
})();
