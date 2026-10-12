/* Rendo Coin — a shared round every few seconds: call HEADS or TAILS while the bar runs down, then the gold coin is
   tossed. Pays 2x; if the coin lands standing on its edge, every bet loses.
   State machine:  WAITING (bets open, bar runs down) → FLIPPING (bets locked, coin in the air) → RESULT (banner,
   payouts) → WAITING …
   Fairness: the outcome is drawn when the bets lock — heads 48.5%, tails 48.5%, edge 3% — so a call returns
   2 × 48.5% = 97%. The coin is a 3D stack (two faces painted on canvases, a reeded edge of thin layers) and the
   toss only plays out the result already drawn. The bets lists show real players' settled bets (masked numbers), never
   made-up players; for real money the results ribbon shows the server's real flips.
   The balance, menu, sounds and confetti come from the shared mini-game kit (minigame.js). */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);

  const WAIT_MS = 8000;
  const FLIP_MS = 2600;
  const RESULT_MS = 3200;
  const P_EDGE = 0.03;
  const MIN_BET = 0.2;
  const TABLE_MAX = 50000;
  const LADDER = [0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
  const LAYERS = 14;            /* thin discs between the faces: the coin's thickness and reeded edge */

  const kit = window.VBMini.create({
    prefix: "fc",
    winSound: "coinWin",
    gameId: "volta-coin",
    server: true,         /* real-money bets are drawn and settled by the server when the bets lock */
    minBet: MIN_BET,
    tableMax: TABLE_MAX,
    chips: [],
    busy: () => !!mine && phase !== "WAITING",
    busyText: "Wait for the flip to finish before switching.",
    onChange: () => paint(),
    confettiFrom: () => $("fcArena"),
    confettiStyle: "coins"
  });
  const { money, round2, announce } = kit;
  const ghs = (v) => "GHS " + money(v);

  /* ---------------- the coin's faces, painted once ---------------- */
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  function gold(g, x0, y0, x1, y1, dark) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    if (dark) {
      gr.addColorStop(0, "#7a4a08");
      gr.addColorStop(0.5, "#b07a18");
      gr.addColorStop(1, "#5a3404");
    } else {
      gr.addColorStop(0, "#fff4c2");
      gr.addColorStop(0.22, "#f6cf55");
      gr.addColorStop(0.45, "#c08a1e");
      gr.addColorStop(0.62, "#ffe08a");
      gr.addColorStop(0.82, "#b27a14");
      gr.addColorStop(1, "#7a4a08");
    }
    return gr;
  }
  /* draws a design raised from the field: a shadow below-right, a highlight above-left, then the gold face */
  function emboss(g, draw, S) {
    g.save();
    g.translate(S * 0.006, S * 0.008);
    g.fillStyle = "rgba(60,30,0,.65)";
    draw();
    g.restore();
    g.save();
    g.translate(-S * 0.004, -S * 0.005);
    g.fillStyle = "rgba(255,250,220,.85)";
    draw();
    g.restore();
    g.fillStyle = gold(g, S * 0.3, S * 0.25, S * 0.7, S * 0.75);
    draw();
  }
  function arcText(g, text, cx, cy, r, start, size) {
    g.font = "800 " + size + "px Georgia, 'Times New Roman', serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    const step = (size * 0.78) / r;
    let a = start - (step * (text.length - 1)) / 2;
    for (const ch of text) {
      g.save();
      g.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      g.rotate(a + Math.PI / 2);
      g.fillStyle = "rgba(60,30,0,.7)";
      g.fillText(ch, 1, 1.2);
      g.fillStyle = "rgba(255,248,215,.95)";
      g.fillText(ch, -0.6, -0.6);
      g.fillStyle = gold(g, -size / 2, -size / 2, size / 2, size / 2);
      g.fillText(ch, 0, 0);
      g.restore();
      a += step;
    }
  }

  function face(kind) {
    const S = 320;
    const c = document.createElement("canvas");
    c.width = c.height = S * DPR;
    const g = c.getContext("2d");
    g.scale(DPR, DPR);
    const cx = S / 2, cy = S / 2, R = S / 2 - 2;
    /* the reeded rim: a band of fine grooves */
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fillStyle = gold(g, 0, 0, S, S);
    g.fill();
    for (let i = 0; i < 160; i++) {
      const a = (i / 160) * Math.PI * 2;
      g.strokeStyle = i % 2 ? "rgba(80,45,0,.45)" : "rgba(255,240,190,.35)";
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * R * 0.9, cy + Math.sin(a) * R * 0.9);
      g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.stroke();
    }
    /* the raised lip, then the field, sunk a little, with a soft satin finish */
    g.beginPath();
    g.arc(cx, cy, R * 0.89, 0, Math.PI * 2);
    g.lineWidth = R * 0.05;
    g.strokeStyle = gold(g, S, S, 0, 0);
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, R * 0.86, 0, Math.PI * 2);
    let gr = g.createRadialGradient(cx - R * 0.3, cy - R * 0.35, R * 0.05, cx, cy, R * 0.9);
    gr.addColorStop(0, "#ffe9a0");
    gr.addColorStop(0.5, "#e2a935");
    gr.addColorStop(1, "#9a6410");
    g.fillStyle = gr;
    g.fill();
    g.save();
    g.clip();
    /* inner shadow round the field's edge: it's sunk below the lip */
    g.lineWidth = R * 0.08;
    g.strokeStyle = "rgba(70,35,0,.4)";
    g.beginPath();
    g.arc(cx + 2, cy + 3, R * 0.88, 0, Math.PI * 2);
    g.stroke();
    /* fine brushed texture */
    for (let i = 0; i < 260; i++) {
      g.fillStyle = Math.random() < 0.5 ? "rgba(255,255,255,.05)" : "rgba(90,50,0,.06)";
      g.fillRect(Math.random() * S, Math.random() * S, 1, 1);
    }
    g.restore();
    /* a dotted ring */
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      g.fillStyle = "rgba(255,240,190,.75)";
      g.beginPath();
      g.arc(cx + Math.cos(a) * R * 0.78, cy + Math.sin(a) * R * 0.78, 1.6, 0, Math.PI * 2);
      g.fill();
    }

    if (kind === "heads") {
      /* a crown: band, five points with pearls, jewels */
      emboss(g, () => {
        g.beginPath();
        g.moveTo(cx - 62, cy + 30);
        g.lineTo(cx - 70, cy - 32);
        g.lineTo(cx - 38, cy - 4);
        g.lineTo(cx - 20, cy - 46);
        g.lineTo(cx, cy - 8);
        g.lineTo(cx + 20, cy - 46);
        g.lineTo(cx + 38, cy - 4);
        g.lineTo(cx + 70, cy - 32);
        g.lineTo(cx + 62, cy + 30);
        g.closePath();
        g.fill();
        g.fillRect(cx - 64, cy + 30, 128, 18);
        [[-70, -32], [-20, -46], [20, -46], [70, -32], [0, -10]].forEach(([x, y]) => {
          g.beginPath();
          g.arc(cx + x, cy + y - 6, 7, 0, Math.PI * 2);
          g.fill();
        });
      }, S);
      [[-34, 39], [0, 39], [34, 39]].forEach(([x, y]) => {
        g.beginPath();
        g.arc(cx + x, cy + y, 5, 0, Math.PI * 2);
        g.fillStyle = "rgba(70,35,0,.6)";
        g.fill();
      });
      arcText(g, "HEADS", cx, cy, R * 0.66, -Math.PI / 2, 22);
      arcText(g, "RENDO", cx, cy, R * 0.66, Math.PI / 2, 18);
    } else if (kind === "tails") {
      /* the four suits, in a cross */
      emboss(g, () => {
        g.font = "900 58px 'Apple Symbols', 'Segoe UI Symbol', Georgia, serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText("♠", cx, cy - 46);
        g.fillText("♥", cx + 48, cy + 2);
        g.fillText("♦", cx, cy + 50);
        g.fillText("♣", cx - 48, cy + 2);
      }, S);
      arcText(g, "TAILS", cx, cy, R * 0.66, -Math.PI / 2, 22);
    } else {
      /* idle: the cedi sign among sparkles */
      emboss(g, () => {
        g.font = "900 140px Georgia, 'Times New Roman', serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText("₵", cx, cy + 6);
      }, S);
      [[-70, -60, 10], [74, -52, 7], [62, 66, 9], [-66, 60, 6]].forEach(([x, y, r]) => {
        g.fillStyle = "rgba(255,250,220,.95)";
        g.beginPath();
        g.moveTo(cx + x, cy + y - r * 2);
        g.quadraticCurveTo(cx + x, cy + y, cx + x + r * 2, cy + y);
        g.quadraticCurveTo(cx + x, cy + y, cx + x, cy + y + r * 2);
        g.quadraticCurveTo(cx + x, cy + y, cx + x - r * 2, cy + y);
        g.quadraticCurveTo(cx + x, cy + y, cx + x, cy + y - r * 2);
        g.fill();
      });
    }
    /* a specular sweep over the whole face */
    gr = g.createLinearGradient(0, 0, S, S);
    gr.addColorStop(0, "rgba(255,255,255,.28)");
    gr.addColorStop(0.35, "rgba(255,255,255,0)");
    gr.addColorStop(0.7, "rgba(0,0,0,0)");
    gr.addColorStop(1, "rgba(60,30,0,.25)");
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fillStyle = gr;
    g.fill();
    return c.toDataURL();
  }
  const FACES = { heads: face("heads"), tails: face("tails"), idle: face("idle") };

  /* build the coin: front face, the layered edge, back face */
  const coin = $("fcCoin");
  for (let i = 0; i < LAYERS; i++) {
    const l = document.createElement("span");
    l.className = "fc-layer";
    l.style.setProperty("--z", (i - (LAYERS - 1) / 2) + "");
    coin.insertBefore(l, $("fcBack"));
  }
  $("fcFront").src = FACES.idle;
  $("fcBack").src = FACES.tails;

  /* ---------------- sounds (themed, from the kit) ---------------- */
  const sfx = (n, a) => kit.play(n, a);

  /* ---------------- real players: the server's latest settled bets and biggest wins on this game ---------------- */
  let feed = { recent: [], top: [] };
  const asRow = (b) => ({ name: b.player, stake: b.stake, pick: b.pick || "", win: b.payout });
  function loadFeed() {
    U.activity.game("volta-coin").then((d) => {
      if (!d) return;
      feed = { recent: d.recent.map(asRow), top: d.top.map(asRow) };
      /* real money: the ribbon is the server's real flips (everyone's, newest first) */
      if (kit.isReal() && Array.isArray(d.results) && d.results.length) {
        history.splice(0, history.length, ...d.results.map((o) => String((o && o.result) || "")[0]).filter(Boolean));
        paintHistory();
      }
      rowsDirty = true;
    });
  }

  /* ---------------- the round ---------------- */
  let phase = "WAITING";
  let phaseStart = performance.now();
  let mine = null;               /* { name: "You", stake, pick, win } */
  const myBets = [];
  /* the flips that really happened: the server's, or (free play) this session's own */
  const history = [];
  let outcome = null;            /* "HEADS" | "TAILS" | "EDGE" */
  let tab = "all";
  let rowsDirty = true;

  function draw() {
    const u = Math.random();
    return u < P_EDGE ? "EDGE" : u < P_EDGE + (1 - P_EDGE) / 2 ? "HEADS" : "TAILS";
  }

  function place(pick) {
    if (phase !== "WAITING") {
      U.toast("Bets are locked — wait for the next round.", "");
      return;
    }
    kit.unlockAudio();
    if (mine && mine.pick === pick) {   /* tapping your pick again takes the bet back */
      kit.move(mine.stake);
      myBets.splice(myBets.indexOf(mine), 1);
      mine = null;
      announce("Bet cancelled.");
    } else {
      if (mine) {                       /* switching sides: the stake moves with you */
        kit.move(mine.stake);
        myBets.splice(myBets.indexOf(mine), 1);
        mine = null;
      }
      const stake = kit.bet();
      if (!kit.canAfford(stake)) return;
      kit.move(-stake);
      mine = { name: "You", stake, pick, win: null, mine: true };
      myBets.unshift(mine);
      myBets.length = Math.min(myBets.length, 50);
      sfx("cupSlide");
      announce("Bet " + ghs(stake) + " on " + pick + ".");
    }
    rowsDirty = true;
    paint();
  }

  /* the toss: up, turning end over end, down with a couple of bounces, landing on the drawn side */
  function toss(result) {
    const front = $("fcFront");
    front.src = FACES.heads;
    const turns = 6 + Math.floor(Math.random() * 3);
    const spin = turns * 360 + (result === "TAILS" ? 180 : 0);
    const D = kit.reduceMotion ? 600 : FLIP_MS;
    /* an edge: it comes down face-on, then rolls up onto its rim and stands there side-on, rocking */
    const side = result === "EDGE" ? 84 : 0;
    const tf = (x, y) => "rotateX(" + x + "deg) rotateY(" + y + "deg)";
    coin.animate([
      { transform: tf(0, 0) },
      { transform: tf(spin * 0.55, 0), offset: 0.42 },
      { transform: tf(spin - 40, side * 0.3), offset: 0.78 },
      { transform: tf(spin, side * 1.08), offset: 0.92 },
      { transform: tf(spin, side) }
    ], { duration: D, easing: "cubic-bezier(.2,.6,.3,1)", fill: "forwards" });
    if (result === "EDGE" && !kit.reduceMotion) {
      setTimeout(() => coin.animate([{ transform: tf(spin, side) }, { transform: tf(spin, side - 7) }, { transform: tf(spin, side + 4) }, { transform: tf(spin, side) }],
        { duration: 900, iterations: 2, easing: "ease-in-out", fill: "forwards" }), D);
    }
    $("fcToss").animate([
      { transform: "translateY(0) scale(1)" },
      { transform: "translateY(-150%) scale(.82)", offset: 0.42 },
      { transform: "translateY(0) scale(1)", offset: 0.74 },
      { transform: "translateY(-14%) scale(.98)", offset: 0.84 },
      { transform: "translateY(0) scale(1)", offset: 0.93 },
      { transform: "translateY(-3%) scale(1)", offset: 0.97 },
      { transform: "translateY(0) scale(1)" }
    ], { duration: D, easing: "ease-in-out" });
    $("fcShadow").animate([
      { transform: "translateX(-50%) scale(1)", opacity: 0.6 },
      { transform: "translateX(-50%) scale(.45)", opacity: 0.2, offset: 0.42 },
      { transform: "translateX(-50%) scale(1)", opacity: 0.6, offset: 0.74 },
      { transform: "translateX(-50%) scale(1)", opacity: 0.6 }
    ], { duration: D, easing: "ease-in-out" });
    sfx("coinFlip");
    if (!kit.reduceMotion) [0.74, 0.93, 0.99].forEach((k, i) => setTimeout(() => sfx("coinLand", 1 - i * 0.35), D * k));
  }

  function settle() {
    outcome = outcomeNext;
    /* a toss with no real bet behind it isn't a real flip: real money records only the player's own */
    if (!kit.isReal() || mine) {
      history.unshift(outcome[0]);
      history.length = Math.min(history.length, 30);
    }
    const side = $("fcResultSide"), msg = $("fcResultMsg"), box = $("fcResult");
    side.textContent = outcome === "EDGE" ? "EDGE!" : outcome;
    box.className = "fc-result";
    if (mine) {
      if (mine.pick === outcome) {
        mine.win = mine.round ? mine.round.payout : round2(mine.stake * 2);
        kit.collect(mine.win);
        box.classList.add("is-win");
        msg.innerHTML = "You Won 🏆 " + ghs(mine.win);
        kit.celebrate();
      } else {
        mine.win = 0;
        kit.collect(0);
        box.classList.add("is-loss");
        msg.textContent = outcome === "EDGE" ? "It landed on its edge — every bet loses." : "Sorry, you chose " + mine.pick + "!";
      }
    } else {
      box.classList.add("is-plain");
      msg.textContent = outcome === "EDGE" ? "It landed on its edge — every bet loses." : "No bet this round.";
    }
    box.hidden = false;
    announce("The coin landed " + (outcome === "EDGE" ? "on its edge" : outcome) + ". " + msg.textContent);
    rowsDirty = true;
  }


  let outcomeNext = null;
  let awaitingServer = false;
  function tick(now) {
    const t = now - phaseStart;
    if (phase === "WAITING") {
      $("fcTimer").style.transform = "scaleX(" + Math.max(0, 1 - t / WAIT_MS).toFixed(3) + ")";
      if (t >= WAIT_MS) {
        phase = "FLIPPING";
        phaseStart = now;
        $("fcStatus").textContent = "Flipping Coin...";
        $("fcTimer").style.transform = "scaleX(0)";
        paint();
        if (mine && kit.isReal()) {
          /* a real-money bet: the server draws the flip as the bets lock, and the toss plays out its answer */
          awaitingServer = true;
          const bet = mine;
          kit.place(bet.stake, { pick: bet.pick }).then((round) => {
            if (round === false) {   /* the bet didn't go through: it's void, and the round goes on without it */
              myBets.splice(myBets.indexOf(bet), 1);
              if (mine === bet) mine = null;
              rowsDirty = true;
              outcomeNext = draw();
            } else {
              bet.round = round;
              outcomeNext = round.outcome.result;
            }
            awaitingServer = false;
            phaseStart = performance.now();
            toss(outcomeNext);
          });
        } else {
          outcomeNext = draw();          /* the flip — decided as the bets lock */
          toss(outcomeNext);
        }
      }
    } else if (phase === "FLIPPING") {
      if (awaitingServer) {
        /* holding until the server has drawn the flip */
      } else if (t > FLIP_MS * 0.55 && $("fcStatus").textContent !== "Generating Result...") $("fcStatus").textContent = "Generating Result...";
      if (!awaitingServer && t >= (kit.reduceMotion ? 650 : FLIP_MS + 120)) {
        phase = "RESULT";
        phaseStart = now;
        settle();
        $("fcStatus").textContent = outcome === "EDGE" ? "Edge — house wins" : outcome + " wins!";
        paintHistory();
        paint();
      }
    } else if (phase === "RESULT" && t >= RESULT_MS) {
      phase = "WAITING";
      phaseStart = now;
      mine = null;
      loadFeed();
      $("fcResult").hidden = true;
      $("fcStatus").textContent = "Waiting for Next Round...";
      /* the coin lies as it landed; between rounds it shows the idle face */
      coin.getAnimations().forEach((a) => a.cancel());
      $("fcFront").src = FACES.idle;
      rowsDirty = true;
      paint();
    }
    if (rowsDirty) renderRows();
    requestAnimationFrame(tick);
  }

  /* ---------------- painting ---------------- */
  function paint() {
    const open = phase === "WAITING";
    kit.paintBet(!open || !!mine);
    $("fcMinus").disabled = !open || !!mine || kit.bet() <= MIN_BET + 1e-9;
    $("fcPlus").disabled = !open || !!mine || kit.bet() >= kit.maxBet() - 1e-9;
    document.querySelectorAll("#fcPresets button").forEach((b) => {
      b.disabled = !open || !!mine;
      b.classList.toggle("on", Number(b.dataset.v) === kit.bet());
    });
    document.querySelectorAll(".fc-pick").forEach((b) => {
      const picked = mine && mine.pick === b.dataset.pick;
      b.classList.toggle("is-picked", !!picked);
      b.setAttribute("aria-disabled", String(!open));
      b.querySelector("span:last-child").textContent = picked ? (open ? "Your bet " + money(mine.stake) + " · tap to cancel" : "Your bet " + money(mine.stake)) : "Pays 2x";
    });
  }

  function badge(r) {
    return '<li class="fc-h fc-h-' + r + '" title="' + (r === "H" ? "Heads" : r === "T" ? "Tails" : "Edge") + '">' + r + "</li>";
  }
  function paintHistory() {
    $("fcHistory").innerHTML = history.slice(0, 9).map(badge).join("");
    const first = $("fcHistory").firstElementChild;
    if (first) first.classList.add("is-new");
  }

  function row(b) {
    const settled = b.win !== null;
    return '<div class="fc-row' + (b.mine ? " mine" : "") + (settled && b.win ? " won" : "") + (settled && !b.win ? " lost" : "") + '">' +
      "<span>" + U.esc(b.name) + "</span>" +
      "<span>" + money(b.stake) + (settled ? "/" + (b.win ? money(b.win) : "0") : "") + "</span>" +
      (b.pick ? '<span><i class="fc-pickbadge fc-p-' + U.esc(b.pick[0]) + '">' + U.esc(b.pick) + "</i></span>" : "<span></span>") + "</div>";
  }
  function renderRows() {
    rowsDirty = false;
    const list = tab === "all" ? (mine ? [mine] : []).concat(feed.recent) : tab === "my" ? myBets : feed.top;
    $("fcRows").innerHTML = list.length ? list.slice(0, 40).map(row).join("")
      : '<p class="fc-empty">' + (tab === "my" ? "Your bets this session will show here." : tab === "top" ? "No real-money wins on this game this week yet." : "No real-money bets on this game today yet.") + "</p>";
  }

  /* ---------------- controls ---------------- */
  document.querySelectorAll(".fc-pick").forEach((b) => b.addEventListener("click", () => place(b.dataset.pick)));
  function stepBet(dir) {
    const v = kit.bet();
    kit.setBet(dir > 0 ? LADDER.find((x) => x > v + 1e-9) || kit.maxBet() : LADDER.slice().reverse().find((x) => x < v - 1e-9) || MIN_BET);
    paint();
  }
  $("fcMinus").addEventListener("click", () => stepBet(-1));
  $("fcPlus").addEventListener("click", () => stepBet(1));
  $("fcPresets").addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]");
    if (!b) return;
    kit.setBet(Number(b.dataset.v));
    paint();
  });
  document.querySelector(".fc-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll(".fc-tabs [data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    renderRows();
  });
  $("fcHowTo").addEventListener("click", () => $("fcRules").showModal());

  kit.setBet(MIN_BET);
  loadFeed();
  setInterval(() => { if (!document.hidden) loadFeed(); }, 15000);
  paintHistory();
  paint();
  requestAnimationFrame(tick);
})();
