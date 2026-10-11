/* Rendo Mines Live — the client. Everyone plays the same board this round; you choose your tiles, lock them in with
   a bet, and the board is only revealed — to everyone at once — when the 3-minute clock runs out.
   The server holds the board and decides everything; this page shows the round, sends the bet, and follows the clock.
   With fun credits each browser keeps a random player id (localStorage) so a refresh or a second tab is the same
   player. With real money the player is their WIN B casino sign-in, handed over by the lobby. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const money = (n) => Number(n).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtX = (x) => x.toFixed(2) + "x";
  const TILES = 25;
  const LADDER = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
  const REVEAL_MS = 7000;    /* the last round's result stays on the board this long (or until you start picking) */

  /* a stable player id for this browser */
  let playerId = null;
  try {
    playerId = localStorage.getItem("voltabet.minesLive.id");
  } catch (e) { /* storage unavailable */ }
  if (!playerId) {
    playerId = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^A-Za-z0-9_-]/g, "");
    try {
      localStorage.setItem("voltabet.minesLive.id", playerId);
    } catch (e) { /* storage unavailable */ }
  }

  /* real money: the WIN B casino lobby passes the player's sign-in in the address's #fragment (which never leaves the
     browser); it's kept in this tab's session storage and taken out of the address at once */
  const params = new URLSearchParams(location.search);
  let token = null;
  const handed = /(?:^#|&)t=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (handed) {
    token = handed[1];
    try {
      sessionStorage.setItem("voltabet.minesLive.token", token);
    } catch (e) { /* storage unavailable */ }
    history.replaceState(null, "", location.pathname + location.search);
  } else {
    try {
      token = sessionStorage.getItem("voltabet.minesLive.token");
    } catch (e) { /* storage unavailable */ }
  }
  const realMode = params.get("mode") === "real" && !!token;
  const socket = io({ auth: realMode ? { mode: "real", token } : { playerId } });

  /* leaving to the lobby replaces this page in history, so the browser Back button doesn't bounce back into the
     game (a plain link would push a lobby entry on top, trapping the player between the game and the lobby) */
  const backLink = document.querySelector("header .back");
  if (backLink) backLink.addEventListener("click", (e) => {
    if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      location.replace(backLink.href);
    }
  });
  let S = null;              /* the latest state from the server */
  const maxPicks = () => TILES - (S ? S.round.mines : 6);   /* the mine count comes from the server */
  let clockSkew = 0;         /* server time − our time */
  let picks = [];            /* the tiles chosen for the next bet */
  let auto = false;          /* Auto Game: bet the same tiles and stake every round */
  let autoPlan = null;       /* { stake, picks } to repeat */
  let busy = false;
  let revealing = false;     /* the board is showing the last round's result */
  let revealTimer = 0;

  /* ---------------- the board ---------------- */
  const grid = $("grid");
  const tiles = [];
  for (let i = 0; i < TILES; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tile";
    b.dataset.i = i;
    b.setAttribute("aria-label", "Tile " + (i + 1));
    b.style.setProperty("--i", (i % 5) + Math.floor(i / 5));   /* the light sweeping across the covered tiles, corner to corner */
    b.innerHTML = '<span class="flip"><span class="face up"></span><span class="face down"></span></span><span class="order"></span>';
    grid.appendChild(b);
    tiles.push(b);
  }
  const icon = (id) => '<svg viewBox="0 0 64 64" aria-hidden="true"><use href="#' + id + '"/></svg>';

  /* the same tile states as Rendo Mines: a star, a mine shown at the end (its fuse still burning), the mine that was
     hit, and the tiles you didn't pick shown faded ("ghost") */
  const CLASSES = { star: "is-star", "ghost-star": "is-star is-ghost", "ghost-mine": "is-mine is-ghost", boom: "is-boom" };
  function setTile(i, kind, delay) {
    const t = tiles[i];
    t.style.setProperty("--d", (delay || 0) + "ms");
    t.querySelector(".down").innerHTML = (kind === "star" || kind === "ghost-star" ? icon("mnStar3d") : icon("mnBomb")) +
      (kind === "ghost-mine" ? '<i class="fuse"></i>' : "");
    t.className = "tile is-open " + CLASSES[kind];
    if (kind === "boom") setTimeout(() => explode(t), delay || 0);
  }
  /* the blast: a white flash, the fireball, a shockwave, sparks, smoke, the burst left on the tile, and the board lit
     up around it (the same effect as Rendo Mines) */
  const SPARKS = 12;
  function explode(t) {
    const add = (tag, cls, style) => {
      const el = document.createElement(tag);
      el.className = "fx " + cls;
      if (style) Object.keys(style).forEach((k) => el.style.setProperty(k, style[k]));
      t.appendChild(el);
      return el;
    };
    add("span", "flash");
    add("span", "fire");
    add("span", "shock");
    for (let n = 0; n < SPARKS; n++) {
      add("i", "spark", {
        "--a": (n * 360) / SPARKS + ((n * 37) % 17) - 8 + "deg", "--r": 46 + ((n * 23) % 5) * 10 + "px",
        "--s": 3 + (n % 3) + "px", "--t": (0.6 + (n % 4) * 0.12).toFixed(2) + "s"
      });
    }
    add("span", "smoke", { "--sx": "-8px", "--sr": "34deg", "--sd": ".7s" });
    add("span", "smoke", { "--sx": "10px", "--sr": "-42deg", "--sd": ".86s" });
    add("span", "blast").innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#mnBlast"/></svg>';
    const board = $("board"), b = board.getBoundingClientRect(), r = t.getBoundingClientRect();
    board.style.setProperty("--hx", ((r.left + r.width / 2 - b.left) / b.width) * 100 + "%");
    board.style.setProperty("--hy", ((r.top + r.height / 2 - b.top) / b.height) * 100 + "%");
    board.classList.remove("is-hit", "is-shaking");
    void board.offsetWidth;
    board.classList.add("is-hit", "is-shaking");
    setTimeout(() => t.querySelectorAll(".flash, .fire, .shock, .spark, .smoke").forEach((n) => n.remove()), 3200);
  }
  function clearBoard() {
    tiles.forEach((t) => {
      t.className = "tile";
      t.style.removeProperty("--d");
      t.querySelector(".down").innerHTML = "";
      t.querySelectorAll(".fx").forEach((n) => n.remove());
    });
  }
  function endReveal() {
    clearTimeout(revealTimer);
    if (!revealing) return;
    revealing = false;
    clearBoard();
  }

  /* the mirror: as the pointer moves over the board, the reflections in the tiles slide, like looking at real glass
     from a different angle (and drift back to the middle when it leaves) */
  const boardEl = $("board");
  boardEl.addEventListener("pointermove", (e) => {
    const r = boardEl.getBoundingClientRect();
    boardEl.style.setProperty("--mx", Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)).toFixed(3));
    boardEl.style.setProperty("--my", Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)).toFixed(3));
  });
  boardEl.addEventListener("pointerleave", () => {
    boardEl.style.setProperty("--mx", ".5");
    boardEl.style.setProperty("--my", ".5");
  });

  /* the picks: highlighted with their order; locked ones (a placed bet) show a padlock-gold ring */
  function paintPicks() {
    if (revealing) return;
    const placed = S && S.bet && S.bet.status === "placed";
    const shown = placed ? S.bet.picks : picks;
    tiles.forEach((t, i) => {
      const at = shown.indexOf(i);
      t.classList.toggle("is-pick", at >= 0);
      t.classList.toggle("is-locked", placed && at >= 0);
      t.querySelector(".order").textContent = at >= 0 ? at + 1 : "";
    });
  }

  /* ---------------- the controls ---------------- */
  const goBtn = $("goBtn");
  const betInput = $("betInput");
  const bet = () => Math.max(0.1, Math.min(100, Math.round(Number(String(betInput.value).replace(/,/g, "")) * 100) / 100 || 0.1));
  const remaining = () => (S ? Math.max(0, S.round.endsAt - (Date.now() + clockSkew)) : 0);
  const closing = () => S && remaining() < S.round.betCutoffMs;

  function paint() {
    if (!S) return;
    $("balance").textContent = money(S.balance);
    $("balLabel").textContent = S.real ? "Wallet" : "Fun credits";
    $("modeNote").textContent = S.real ? "Real money · bets come from your WIN B casino wallet · 18+ · play responsibly · " : "Fun credits · no real money · ";
    $("roundId").textContent = S.round.id;
    $("hash").textContent = S.round.hash.slice(0, 20) + "…";
    $("minesSelect").options[0].textContent = "Mines: " + S.round.mines;
    $("meName").textContent = S.me.name;
    paintMine();
    $("minesCount").textContent = S.round.mines;
    const b = S.bet;
    const placed = b && b.status === "placed";
    const n = placed ? b.picks.length : picks.length;
    /* the multiplier for that many tiles — all must be safe */
    $("nextLabel").textContent = n ? "Pays" : "1 tile pays";
    $("nextMult").textContent = fmtX(S.mult[Math.max(1, n)]);
    if (placed) {
      goBtn.dataset.state = "placed";
      goBtn.innerHTML = "<b>BET PLACED</b> <span>Win GHS " + money(b.potential) + " · " + (closing() ? "locked" : "tap to cancel") + "</span>";
      goBtn.setAttribute("aria-disabled", String(closing()));
    } else {
      goBtn.dataset.state = "bet";
      goBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.6v12.8c0 .9 1 1.4 1.7.9l9.4-6.4c.6-.4.6-1.3 0-1.8l-9.4-6.4c-.7-.5-1.7 0-1.7.9z"/></svg><b>BET</b>' +
        (picks.length ? " <span>" + picks.length + " tile" + (picks.length > 1 ? "s" : "") + " · win " + money(Math.min(10000, bet() * S.mult[picks.length])) + "</span>" : "");
      goBtn.setAttribute("aria-disabled", String(closing() || !picks.length));
    }
    [betInput, $("minusBtn"), $("plusBtn"), $("halfBtn"), $("doubleBtn")].forEach((el) => (el.disabled = !!placed));
    $("randomBtn").disabled = !!placed || picks.length >= maxPicks();
    $("board").dataset.live = String(!placed && !revealing);   /* covered tiles press and glow under the pointer while you can pick */
    $("clearBtn").disabled = !!placed || !picks.length;
    $("autoBtn").setAttribute("aria-checked", String(auto));
    paintStatus();
    paintPicks();
  }

  function paintStatus() {
    const b = S.bet;
    let title = "Choose your tiles", sub = "Results are revealed to everyone when the clock hits 0:00";
    if (b && b.status === "placed") { title = "Bet placed — waiting for 0:00"; sub = b.picks.length + " tile" + (b.picks.length > 1 ? "s" : "") + " at " + fmtX(b.mult) + " · win GHS " + money(b.potential) + " if all are stars"; }
    else if (closing()) { title = "Round closing"; sub = "Bets for the next round open in a moment"; }
    else if (S.real && !S.round.real) { title = "Real-money bets paused"; sub = "The wallet service isn't answering — bets open again next round"; }
    else if (picks.length) { title = picks.length + " tile" + (picks.length > 1 ? "s" : "") + " chosen"; sub = "Press BET to lock them in"; }
    $("statusTitle").textContent = title;
    $("statusSub").textContent = sub;
  }

  function tickClock() {
    if (S) {
      const ms = remaining();
      const s = Math.ceil(ms / 1000);
      $("clock").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
      $("ring").style.strokeDashoffset = String(97.4 * (1 - ms / 180000));
      $("clockWrap").classList.toggle("urgent", ms < 15000);
      boardEl.classList.toggle("tense", ms < 10000 && ms > 0 && !revealing);
      /* the last five seconds tick */
      if (ms < 5500 && ms > 0 && s !== tickClock.last) {
        tickClock.last = s;
        sfx.tick(s <= 3);
        const c = $("clock");
        c.classList.remove("pop");
        void c.offsetWidth;
        c.classList.add("pop");
      }
      const was = goBtn.dataset.closing === "1";
      if (was !== !!closing()) {
        goBtn.dataset.closing = closing() ? "1" : "";
        paint();
      }
    }
    requestAnimationFrame(tickClock);
  }
  requestAnimationFrame(tickClock);

  function toast(text, kind, ms) {
    const t = $("toast");
    t.textContent = text;
    t.className = "toast " + (kind || "");
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), ms || 3200);
  }

  /* ---------------- live bets, history, my bets ---------------- */
  /* names are typed by players: always escaped before they go into the page */
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hue = (pub) => parseInt(pub.slice(0, 6), 16) % 360;
  let tab = "live";
  let live = { roundId: 0, bets: [], final: false };
  let hist = [];
  const seenPubs = new Set();   /* players already in the list, so newcomers can slide in */

  function who(name, pub, demo) {
    const h = demo ? 0 : hue(pub.replace(/^demo-/, ""));
    return '<span class="who"><i style="background:' + (demo ? "#3a4566" : "hsl(" + h + " 55% 42%)") + '">' + esc(name.replace(/^Player /, "").charAt(0).toUpperCase()) + "</i><b>" + esc(name) + "</b>" +
      (demo ? '<em class="demo" title="A simulated player">DEMO</em>' : "") + "</span>";
  }
  function result(b) {
    if (b.status === "won") return '<span class="won">+' + money(b.win) + "</span>";
    if (b.status === "lost") return '<span class="lost">Lost</span>';
    return '<span class="wait">' + fmtX(b.mult) + "</span>";
  }
  function paintLive() {
    const me = S && S.me ? S.me.pub : "";
    const bets = live.bets;
    $("liveCount").textContent = bets.length;
    const staked = bets.reduce((a, b) => a + b.stake, 0);
    const demos = bets.filter((b) => b.demo).length;
    const who2 = bets.length + " player" + (bets.length === 1 ? "" : "s") + (demos ? " (" + demos + " demo)" : "");
    $("liveSummary").innerHTML = live.final
      ? "<span>Round " + live.roundId + " · " + who2 + "</span><span>Staked <b>" + money(staked) + "</b> · paid <b>" + money(bets.reduce((a, b) => a + b.win, 0)) + "</b></span>"
      : "<span>Round " + live.roundId + " · " + who2 + " staking</span><span>Total <b>GHS " + money(staked) + "</b></span>";
    const fresh = new Set(bets.filter((b) => !seenPubs.has(b.pub)).map((b) => b.pub));
    bets.forEach((b) => seenPubs.add(b.pub));
    if (!live.final && bets.length === 0) seenPubs.clear();
    $("liveRows").innerHTML = bets.length
      ? bets.map((b) => '<div class="rows' + (b.pub === me ? " you" : "") + (b.demo ? " sim" : "") + (fresh.has(b.pub) && seenPubs.size > fresh.size ? " new" : "") + '">' + who(b.pub === me ? b.name + " (you)" : b.name, b.pub, b.demo) +
          "<span>" + b.tiles + "</span><span>" + money(b.stake) + "</span><span>" + result(b) + "</span></div>").join("")
      : '<p class="empty">No bets yet this round — be the first.</p>';
  }
  function mini(mines, picks) {
    let h = '<span class="mini" aria-hidden="true">';
    for (let i = 0; i < TILES; i++) h += '<i class="' + (mines.includes(i) ? "m" : "") + (picks && picks.includes(i) ? " p" : "") + '"></i>';
    return h + "</span>";
  }
  function paintHistory() {
    $("tabHistory").innerHTML = hist.length
      ? hist.map((r) => '<div class="hist">' + mini(r.mines) + "<span><b>Round " + r.roundId + "</b><small>" +
          new Date(r.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · mines " + r.mines.map((m) => m + 1).join(", ") +
          ' · <a href="/api/verify/' + r.seed + "/" + r.roundId + '" target="_blank" rel="noopener">verify</a></small></span>' +
          '<span class="pay"><b>' + r.players + " player" + (r.players === 1 ? "" : "s") + "</b>" + (r.demo ? "<small>incl. " + r.demo + " demo</small>" : "") + "<small>staked " + money(r.staked) + " · paid " + money(r.paid) +
          (r.top ? "<br>top win " + esc(r.top.name) + (r.top.demo ? " (demo)" : "") + " " + money(r.top.win) : "") + "</small></span></div>").join("")
      : '<p class="empty">Finished rounds will show here.</p>';
  }
  function paintMine() {
    const list = (S && S.myBets) || [];
    $("tabMine").innerHTML = list.length
      ? list.map((b) => '<div class="hist">' + mini(b.hit && b.hit.length ? b.hit : [], b.picks) + "<span><b>Round " + b.roundId + "</b><small>" + b.picks.length +
          " tile" + (b.picks.length === 1 ? "" : "s") + " at " + fmtX(b.mult) + " · stake " + money(b.stake) + "</small></span>" +
          '<span class="pay">' + (b.status === "won" ? '<b style="color:#4ade80">+' + money(b.win) + "</b>" : '<b style="color:#f87171">Lost</b><small>mine on ' + b.hit.map((m) => m + 1).join(", ") + "</small>") + "</span></div>").join("")
      : '<p class="empty">Your bets will show here once a round you played has ended.</p>';
  }
  document.querySelector(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll(".tabs [data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $("tabLive").hidden = tab !== "live";
    $("tabHistory").hidden = tab !== "history";
    $("tabMine").hidden = tab !== "mine";
  });

  /* ---------------- talking to the server ---------------- */
  function ask(ev, arg) {
    return new Promise((res) => {
      busy = true;
      socket.timeout(8000).emit(ev, arg, (err, r) => {
        busy = false;
        res(err ? { error: "The server didn't answer — check your connection." } : r);
      });
    });
  }

  async function placeBet(stake, chosen) {
    if (busy) return false;
    const r = await ask("bet", { stake, picks: chosen });
    if (r.error) {
      toast(r.error, "err");
      return false;
    }
    autoPlan = { stake, picks: chosen.slice() };
    picks = [];
    setTimeout(() => lockIn(chosen), 60);
    toast("Bet placed — " + chosen.length + " tile" + (chosen.length > 1 ? "s" : "") + ". Results at 0:00.", "");
    return true;
  }

  socket.on("state", (st) => {
    clockSkew = st.round.serverNow - Date.now();
    const newRound = S && S.round.id !== st.round.id;
    S = st;
    paint();
    /* Auto Game: the same tiles and stake again, as soon as the new round opens */
    if (newRound && auto && autoPlan && !S.bet) {
      setTimeout(() => {
        if (auto && S && !S.bet) placeBet(autoPlan.stake, autoPlan.picks);
      }, 1200);
    }
  });
  socket.on("bets", (x) => {
    /* a finished round's results stay up a moment; then the new round's list takes over */
    if (live.final && !x.final && x.roundId !== live.roundId && Date.now() - live.at < REVEAL_MS && !x.bets.length) {
      clearTimeout(paintLive.t);
      paintLive.t = setTimeout(() => {
        live = { roundId: x.roundId, bets: x.bets, final: false };
        paintLive();
      }, REVEAL_MS - (Date.now() - live.at));
      return;
    }
    live = { roundId: x.roundId, bets: x.bets, final: !!x.final, at: Date.now() };
    paintLive();
  });
  socket.on("history", (h) => {
    hist = h;
    paintHistory();
  });
  socket.on("timer_tick", (t) => {
    clockSkew = t.serverNow - Date.now();
    if (S && t.roundId === S.round.id) S.round.endsAt = t.serverNow + t.remainingMs;
  });

  /* 0:00 — the board turns over for everyone: your picks first, then the rest */
  socket.on("round_end", (r) => {
    if (r.unavailable) {
      toast("Round " + r.roundId + "'s results aren't available yet.", "err", 5000);
      return;
    }
    revealing = true;
    clearBoard();
    $("lastRound").innerHTML = "Round " + r.roundId + ": mines on tiles " + r.mines.map((m) => m + 1).join(", ") +
      " · seed <code>" + r.seed.slice(0, 16) + "…</code>";
    const v = $("verifyLink");
    v.hidden = false;
    v.href = "/api/verify/" + r.seed + "/" + r.roundId;
    const mine = S && S.bet && S.bet.status === "placed" ? S.bet.picks : [];
    /* your tiles turn first, one by one; then the rest of the board turns in a wave spreading from the centre */
    mine.forEach((i, k) => {
      const d = 150 + k * 140;
      const bomb = r.mines.includes(i);
      setTile(i, bomb ? "boom" : "star", d);
      if (bomb) sfx.boom(d / 1000);
      else {
        sfx.star(d / 1000);
        glints(tiles[i], d + 300);
      }
    });
    const after = 200 + mine.length * 140;
    for (let i = 0; i < TILES; i++) {
      if (mine.includes(i)) continue;
      const d = after + 250 + Math.round(Math.hypot(Math.floor(i / 5) - 2, (i % 5) - 2) * 110);
      setTile(i, r.mines.includes(i) ? "ghost-mine" : "ghost-star", d);
      sfx.flip(d / 1000 + 0.2);
    }
    boardEl.classList.remove("tense");
    if (!mine.length) toast("Round " + r.roundId + " is over — mines on " + r.mines.map((m) => m + 1).join(", ") + ".", "", 4000);
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => {
      endReveal();
      paint();
    }, REVEAL_MS);
  });
  socket.on("settled", (s) => {
    if (s.status === "void") return toast(s.note, "", 6000);
    const delay = 300 + s.picks.length * 140;
    setTimeout(() => {
      if (s.status === "won") {
        celebrate(s.win, s.mult);
        coinShower();
        sfx.win();
      }
      else toast("Mine on tile " + s.hit.map((m) => m + 1).join(", ") + " — you lost GHS " + money(s.stake) + ".", "err", 5000);
    }, delay);
  });
  socket.on("connect_error", () => {
    $("statusTitle").textContent = "Can't reach the game server";
    $("statusSub").textContent = "Trying again… (it can take up to a minute to wake up)";
  });
  socket.on("fatal", (m) => {
    toast(m, "err", 8000);
    $("statusTitle").textContent = m;
    $("statusSub").textContent = realMode ? "Open Live Mines again from the WIN B casino lobby, or play with fun credits." : "";
  });

  /* the menu: the hamburger slides it in; it closes on the X, the dimmed page, Esc, or after a shortcut is used */
  const menu = $("menu"), menuBtn = $("menuBtn");
  function openMenu() {
    menu.hidden = false;
    requestAnimationFrame(() => menu.classList.add("open"));
    menuBtn.setAttribute("aria-expanded", "true");
    menu.querySelector(".menu-close").focus({ preventScroll: true });
  }
  function closeMenu() {
    if (menu.hidden) return;
    menu.classList.remove("open");
    menuBtn.setAttribute("aria-expanded", "false");
    setTimeout(() => { if (!menu.classList.contains("open")) menu.hidden = true; }, reduceMotion ? 0 : 260);
    menuBtn.focus({ preventScroll: true });
  }
  menuBtn.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
  menu.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) return closeMenu();
    const go = e.target.closest("[data-go]");
    if (!go) return;
    closeMenu();
    if (go.dataset.go === "fair") {
      const f = $("fair");
      f.open = true;
      f.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    } else {
      const t = document.querySelector('.tabs [data-tab="' + go.dataset.go + '"]');
      t.click();
      t.closest(".panel").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  /* your name, shown to other players in the live bets list */
  $("meBtn").addEventListener("click", async () => {
    const name = prompt("Your name, as other players see it (2–16 letters or numbers):", S ? S.me.name : "");
    if (name == null) return;
    const r = await ask("set_name", { name });
    toast(r.error || "You're now " + r.name + ".", r.error ? "err" : "ok");
  });

  /* ================= sound: glassy clicks, the lock-in, the countdown ticks, the reveal, a blast, a win ================= */
  let soundOn = true;
  try {
    soundOn = localStorage.getItem("voltabet.minesLive.sound") !== "off";
  } catch (e) { /* storage unavailable */ }
  let ac = null;
  document.addEventListener("pointerdown", () => {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === "suspended") ac.resume();
    } catch (e) { ac = null; }
  });
  const audible = () => soundOn && ac;
  function tone(f, type, at, dur, vol, to) {
    const t = ac.currentTime + (at || 0), o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ac.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  function noise(at, dur, type, f0, f1, vol) {
    const t = ac.currentTime + at, n = Math.floor(ac.sampleRate * dur), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
    const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = buf;
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.value = vol;
    src.connect(f).connect(g).connect(ac.destination);
    src.start(t);
  }
  const sfx = {
    tink(k) { if (!audible()) return; const f = 1900 + (k || 0) * 90; tone(f, "sine", 0, 0.25, 0.12); tone(f * 2.76, "sine", 0, 0.12, 0.04); },
    lock() { if (!audible()) return; noise(0, 0.06, "lowpass", 1200, 300, 0.4); [880, 1320, 1760].forEach((f, i) => tone(f, "triangle", 0.05 + i * 0.07, 0.3, 0.07)); },
    tick(hot) { if (!audible()) return; tone(hot ? 1500 : 1100, "square", 0, 0.05, 0.05); },
    flip(at) { if (!audible()) return; noise(at, 0.04, "bandpass", 2600, 1800, 0.18); },
    star(at) { if (!audible()) return; tone(1568, "sine", at, 0.5, 0.08); tone(2349, "sine", at + 0.05, 0.4, 0.05); },
    boom(at) { if (!audible()) return; noise(at, 0.7, "lowpass", 2400, 120, 0.6); tone(110, "sine", at, 0.45, 0.45, 38); },
    win() { if (!audible()) return; [523.3, 659.3, 784, 1046.5, 1318.5].forEach((f, i) => tone(f, "triangle", i * 0.08, 0.6, 0.12));
      for (let i = 0; i < 14; i++) tone(2600 + Math.random() * 2400, "sine", 0.3 + i * 0.05, 0.15, 0.04); }
  };
  const soundBtn = $("soundBtn");
  const paintSound = () => {
    soundBtn.setAttribute("aria-pressed", String(soundOn));
    soundBtn.setAttribute("aria-label", soundOn ? "Sound on — tap to mute" : "Sound off — tap to turn on");
  };
  soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    try {
      localStorage.setItem("voltabet.minesLive.sound", soundOn ? "on" : "off");
    } catch (e) { /* storage unavailable */ }
    paintSound();
  });
  paintSound();

  /* ================= the room's light: the reflections drift on their own, and the glass twinkles ================= */
  let pointerIn = false;
  boardEl.addEventListener("pointerenter", () => (pointerIn = true));
  boardEl.addEventListener("pointerleave", () => (pointerIn = false));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  (function drift(now) {
    if (!pointerIn && !reduceMotion) {
      const t = now / 1000;
      boardEl.style.setProperty("--mx", (0.5 + 0.38 * Math.sin(t * 0.32)).toFixed(3));
      boardEl.style.setProperty("--my", (0.5 + 0.22 * Math.sin(t * 0.21 + 1.3)).toFixed(3));
    }
    requestAnimationFrame(drift);
  })(0);
  setInterval(() => {
    if (reduceMotion || document.hidden) return;
    const covered = tiles.filter((t) => !t.classList.contains("is-open"));
    if (!covered.length) return;
    const t = covered[Math.floor(Math.random() * covered.length)];
    const g = document.createElement("i");
    g.className = "twinkle";
    g.style.left = 20 + Math.random() * 60 + "%";
    g.style.top = 15 + Math.random() * 50 + "%";
    t.appendChild(g);
    setTimeout(() => g.remove(), 1100);
  }, 700);

  /* a tile tapped: it clicks down, and a ring of light ripples out across the glass */
  function ripple(i) {
    if (reduceMotion) return;
    const r0 = Math.floor(i / 5), c0 = i % 5;
    tiles.forEach((t, j) => {
      const d = Math.hypot(Math.floor(j / 5) - r0, (j % 5) - c0);
      t.style.setProperty("--rd", Math.round(d * 70) + "ms");
      t.classList.remove("ripple");
      void t.offsetWidth;
      t.classList.add("ripple");
    });
    const t = tiles[i];
    t.classList.remove("press");
    void t.offsetWidth;
    t.classList.add("press");
    clearTimeout(ripple.timer);
    ripple.timer = setTimeout(() => tiles.forEach((x) => x.classList.remove("ripple", "press")), 900);
  }

  /* the bet locked in: a gold shimmer sweeps over the chosen tiles, one after another, and they settle */
  function lockIn(chosen) {
    sfx.lock();
    if (reduceMotion) return;
    chosen.forEach((i, k) => {
      const t = tiles[i];
      t.style.setProperty("--ld", k * 70 + "ms");
      t.classList.remove("lockin");
      void t.offsetWidth;
      t.classList.add("lockin");
      setTimeout(() => t.classList.remove("lockin"), 900 + k * 70);
    });
  }

  /* a star found: glints flash round the tile */
  function glints(t, delay) {
    if (reduceMotion) return;
    setTimeout(() => {
      [["-8%", "-6%", "0s"], ["72%", "-10%", ".1s"], ["76%", "68%", ".18s"], ["-10%", "64%", ".06s"]].forEach(([x, y, d]) => {
        const g = document.createElement("span");
        g.className = "fx glint";
        g.style.left = x;
        g.style.top = y;
        g.style.animationDelay = d;
        t.appendChild(g);
        setTimeout(() => g.remove(), 1100);
      });
    }, delay);
  }

  /* a win: minted gold coins burst up from the board and tumble down. Each face is drawn once in detail (milled rim,
     raised ring of beads, an embossed star, brushed metal lit from the top left) and then spun in 3D: the face narrows as
     it turns, the reeded edge shows as thickness, and the light catches it as it passes the viewer. */
  const coinCanvas = $("coins");
  let coinFace = null, coinRaf = 0;
  function mintCoin(R) {
    const c = document.createElement("canvas");
    c.width = c.height = R * 2 + 4;
    const g = c.getContext("2d"), o = R + 2;
    const star = (r1, r2) => {
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? r2 : r1, a = -Math.PI / 2 + (i * Math.PI) / 5;
        g[i ? "lineTo" : "moveTo"](o + Math.cos(a) * r, o + Math.sin(a) * r);
      }
      g.closePath();
    };
    /* the body: deep gold, lit from the top left */
    let gr = g.createRadialGradient(o - R * 0.45, o - R * 0.5, R * 0.05, o, o, R * 1.05);
    gr.addColorStop(0, "#fff6d0"); gr.addColorStop(0.25, "#f5cd62"); gr.addColorStop(0.6, "#c88c1c"); gr.addColorStop(1, "#6e4204");
    g.fillStyle = gr; g.beginPath(); g.arc(o, o, R, 0, Math.PI * 2); g.fill();
    /* brushed-metal sheen: light catching the turning grain */
    if (g.createConicGradient) {
      const cg = g.createConicGradient(-0.6, o, o);
      [[0, .0], [.12, .28], [.22, 0], [.5, 0], [.62, .22], [.72, 0], [1, 0]].forEach(([k, al]) => cg.addColorStop(k, "rgba(255,250,225," + al + ")"));
      g.fillStyle = cg; g.beginPath(); g.arc(o, o, R * 0.8, 0, Math.PI * 2); g.fill();
    }
    /* milled rim: a raised band with fine ridges */
    g.lineWidth = R * 0.14;
    gr = g.createLinearGradient(o - R, o - R, o + R, o + R);
    gr.addColorStop(0, "#fff3c0"); gr.addColorStop(0.45, "#d9a234"); gr.addColorStop(1, "#5c3502");
    g.strokeStyle = gr; g.beginPath(); g.arc(o, o, R * 0.92, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = "rgba(70,35,0,.35)"; g.lineWidth = Math.max(0.6, R * 0.025);
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      g.beginPath(); g.moveTo(o + Math.cos(a) * R * 0.86, o + Math.sin(a) * R * 0.86); g.lineTo(o + Math.cos(a) * R * 0.99, o + Math.sin(a) * R * 0.99); g.stroke();
    }
    /* the step down from the rim into the field */
    g.lineWidth = Math.max(1, R * 0.04);
    g.strokeStyle = "rgba(60,30,0,.55)"; g.beginPath(); g.arc(o, o, R * 0.8, Math.PI * 0.75, Math.PI * 1.75); g.stroke();
    g.strokeStyle = "rgba(255,245,200,.6)"; g.beginPath(); g.arc(o, o, R * 0.8, Math.PI * 1.75, Math.PI * 2.75); g.stroke();
    /* a ring of raised beads */
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2, x = o + Math.cos(a) * R * 0.7, y = o + Math.sin(a) * R * 0.7, br = R * 0.035;
      g.fillStyle = "rgba(70,35,0,.5)"; g.beginPath(); g.arc(x + br * 0.5, y + br * 0.5, br, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#ffe9a0"; g.beginPath(); g.arc(x - br * 0.3, y - br * 0.3, br * 0.8, 0, Math.PI * 2); g.fill();
    }
    /* the embossed star: a shadow edge, a lit edge, then the struck face */
    const off = Math.max(1, R * 0.045);
    g.save(); g.translate(off, off); star(R * 0.5, R * 0.21); g.fillStyle = "rgba(60,28,0,.7)"; g.fill(); g.restore();
    g.save(); g.translate(-off * 0.8, -off * 0.8); star(R * 0.5, R * 0.21); g.fillStyle = "rgba(255,250,225,.9)"; g.fill(); g.restore();
    gr = g.createLinearGradient(o - R * 0.5, o - R * 0.5, o + R * 0.5, o + R * 0.5);
    gr.addColorStop(0, "#ffeaa0"); gr.addColorStop(0.5, "#e7b445"); gr.addColorStop(1, "#a86c0e");
    star(R * 0.5, R * 0.21); g.fillStyle = gr; g.fill();
    /* the facets of the star's arms */
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      g.beginPath(); g.moveTo(o, o); g.lineTo(o + Math.cos(a) * R * 0.5, o + Math.sin(a) * R * 0.5);
      g.strokeStyle = Math.cos(a + 0.8) > 0 ? "rgba(255,250,220,.55)" : "rgba(90,45,0,.35)"; g.lineWidth = Math.max(0.6, R * 0.025); g.stroke();
    }
    /* a fine dark line where the coin's edge meets the air */
    g.strokeStyle = "rgba(50,25,0,.8)"; g.lineWidth = 1; g.beginPath(); g.arc(o, o, R - 0.5, 0, Math.PI * 2); g.stroke();
    return c;
  }
  function coinShower() {
    if (reduceMotion) return;
    cancelAnimationFrame(coinRaf);
    const g = coinCanvas.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = (coinCanvas.width = innerWidth * dpr), H = (coinCanvas.height = innerHeight * dpr);
    coinCanvas.hidden = false;
    coinFace = coinFace || mintCoin(64);
    /* they burst out from behind the card's medallion and fan out to both sides, clear of the lettering */
    const m = document.querySelector(".winfx-star").getBoundingClientRect();
    const ox = m.left + m.width / 2, oy = m.top + m.height / 2;
    const coins = Array.from({ length: 56 }, (_, i) => {
      const depth = 0.55 + Math.random() * 0.75; /* nearer coins are bigger, faster and less hazy */
      const side = i % 2 ? 1 : -1;
      return {
        x: (ox + side * (10 + Math.random() * 20)) * dpr, y: oy * dpr,
        vx: side * (4 + Math.random() * 9) * dpr * depth, vy: (-Math.random() * 11 - 8) * dpr * depth,
        s: 13 * depth * dpr, depth, spin: Math.random() * Math.PI * 2, vs: (0.12 + Math.random() * 0.22) * (Math.random() < 0.5 ? -1 : 1),
        tilt: (Math.random() - 0.5) * 1.2, vt: (Math.random() - 0.5) * 0.03, delay: i * 9, flash: 0
      };
    }).sort((a, b) => a.depth - b.depth);
    const t0 = performance.now();
    function draw(c) {
      const cos = Math.cos(c.spin), w = Math.max(0.06, Math.abs(cos)), thick = c.s * 0.16 * Math.sqrt(1 - cos * cos);
      g.save();
      g.translate(c.x, c.y);
      g.rotate(c.tilt);
      g.globalAlpha = Math.min(1, 0.55 + c.depth * 0.45);
      /* soft shadow, as if lit from above */
      g.shadowColor = "rgba(0,0,0,.45)"; g.shadowBlur = 6 * c.depth; g.shadowOffsetY = 3 * c.depth;
      /* the reeded edge: thickness that shows as the coin turns */
      if (thick > 0.5) {
        const dir = cos > 0 ? -1 : 1, eg = g.createLinearGradient(0, -c.s, 0, c.s);
        eg.addColorStop(0, "#f0c860"); eg.addColorStop(0.5, "#8a560a"); eg.addColorStop(1, "#4a2a00");
        g.fillStyle = eg;
        g.beginPath();
        g.ellipse(dir * thick * 0.5, 0, w * c.s, c.s, 0, 0, Math.PI * 2);
        g.rect(Math.min(0, dir * thick), -c.s, Math.abs(thick), c.s * 2);
        g.fill();
        g.shadowColor = "transparent";
        g.strokeStyle = "rgba(60,30,0,.35)"; g.lineWidth = 0.7 * dpr;
        for (let k = -c.s + 2; k < c.s; k += 2.4 * dpr) { g.beginPath(); g.moveTo(Math.min(0, dir * thick), k); g.lineTo(Math.max(0, dir * thick), k); g.stroke(); }
      }
      g.shadowColor = "transparent";
      /* the face, narrowed by the turn; the back is the same strike, mirrored */
      g.scale(cos >= 0 ? w : -w, 1);
      g.drawImage(coinFace, -c.s, -c.s, c.s * 2, c.s * 2);
      /* the face darkens as it turns away from the light, and flares as it faces it */
      g.globalCompositeOperation = "source-atop";
      const lit = cos * 0.6 + Math.sin(c.spin + 0.9) * 0.4;
      if (lit < 0) { g.fillStyle = "rgba(40,20,0," + Math.min(0.55, -lit * 0.6) + ")"; g.fillRect(-c.s, -c.s, c.s * 2, c.s * 2); }
      g.restore();
      if (lit > 0.88) c.flash = 1;
      if (c.flash > 0.02) { /* a sparkle off the polished face */
        const fl = c.flash * c.s * 1.6, x = c.x - c.s * 0.3, y = c.y - c.s * 0.35;
        g.save();
        g.globalCompositeOperation = "lighter";
        const rg = g.createRadialGradient(x, y, 0, x, y, fl);
        rg.addColorStop(0, "rgba(255,255,240," + 0.9 * c.flash + ")"); rg.addColorStop(0.25, "rgba(255,220,140," + 0.35 * c.flash + ")"); rg.addColorStop(1, "rgba(255,200,100,0)");
        g.fillStyle = rg; g.beginPath(); g.arc(x, y, fl, 0, Math.PI * 2); g.fill();
        g.strokeStyle = "rgba(255,255,235," + 0.8 * c.flash + ")"; g.lineWidth = dpr;
        g.beginPath(); g.moveTo(x - fl * 1.4, y); g.lineTo(x + fl * 1.4, y); g.moveTo(x, y - fl * 1.4); g.lineTo(x, y + fl * 1.4); g.stroke();
        g.restore();
        c.flash *= 0.84;
      }
    }
    (function step(now) {
      const t = now - t0;
      g.clearRect(0, 0, W, H);
      coins.forEach((c) => {
        if (t < c.delay) return;
        c.vy += 0.46 * dpr * c.depth;
        c.vx *= 0.995;
        c.x += c.vx; c.y += c.vy;
        c.spin += c.vs; c.tilt += c.vt;
        draw(c);
      });
      if (t < 3400) coinRaf = requestAnimationFrame(step);
      else { g.clearRect(0, 0, W, H); coinCanvas.hidden = true; }
    })(t0);
  }

  /* a win: "Congratulations! You won GHS …" pops up over the board, the amount counts up, then it goes by itself */
  const winfx = $("winfx");
  let winfxTimer = 0;
  function celebrate(amount, mult) {
    clearTimeout(winfxTimer);
    $("winfxMult").textContent = fmtX(mult) + " · all your tiles were stars";
    winfx.hidden = false;
    winfx.classList.remove("show");
    void winfx.offsetWidth; /* restart the animations */
    winfx.classList.add("show");
    const out = $("winfxAmount"), t0 = performance.now(), dur = reduceMotion ? 0 : 1600;
    (function step(now) {
      const k = dur ? Math.min(1, (now - t0) / dur) : 1;
      out.textContent = money(amount * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
      else out.classList.add("done");
    })(t0);
    $("winfxOk").focus({ preventScroll: true });
    winfxTimer = setTimeout(closeWin, 6500);
  }
  function closeWin() {
    clearTimeout(winfxTimer);
    winfx.classList.remove("show");
    $("winfxAmount").classList.remove("done");
    winfx.hidden = true;
  }
  $("winfxOk").addEventListener("click", closeWin);
  winfx.addEventListener("click", (e) => { if (e.target === winfx) closeWin(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !winfx.hidden) closeWin(); });

  /* ---------------- input ---------------- */
  grid.addEventListener("click", (e) => {
    const t = e.target.closest(".tile");
    if (!t || !S) return;
    if (S.bet && S.bet.status === "placed") return toast("Your tiles are locked in — results at 0:00.", "");
    endReveal();
    const i = Number(t.dataset.i);
    const at = picks.indexOf(i);
    if (at >= 0) picks.splice(at, 1);
    else if (picks.length < maxPicks()) picks.push(i);
    else return toast("At most " + maxPicks() + " tiles — " + S.round.mines + " of the 25 are mines.", "err");
    sfx.tink(at >= 0 ? -4 : picks.length);
    ripple(i);
    paint();
  });
  goBtn.addEventListener("click", async () => {
    if (goBtn.getAttribute("aria-disabled") === "true" || !S) return;
    if (S.bet && S.bet.status === "placed") {
      const r = await ask("cancel");
      if (r.error) toast(r.error, "err");
      else {
        auto = false;
        toast("Bet cancelled — your stake is back.", "");
      }
      return;
    }
    endReveal();
    placeBet(bet(), picks);
  });
  $("randomBtn").addEventListener("click", () => {
    if (!S || (S.bet && S.bet.status === "placed")) return;
    endReveal();
    const free = tiles.map((_, i) => i).filter((i) => !picks.includes(i));
    if (picks.length < maxPicks()) picks.push(free[Math.floor(Math.random() * free.length)]);
    paint();
  });
  $("clearBtn").addEventListener("click", () => {
    picks = [];
    paint();
  });
  $("autoBtn").addEventListener("click", () => {
    auto = !auto;
    if (auto && !autoPlan && !(S && S.bet)) toast("Auto Game: your next bet's tiles and stake will be placed again every round.", "");
    if (auto && S && S.bet && S.bet.status === "placed") autoPlan = { stake: S.bet.stake, picks: S.bet.picks.slice() };
    paint();
  });
  const setBet = (v) => {
    betInput.value = money(Math.max(0.1, Math.min(100, Math.round(v * 100) / 100)));
    paint();
  };
  $("minusBtn").addEventListener("click", () => setBet(LADDER.slice().reverse().find((x) => x < bet() - 1e-9) || 0.1));
  $("plusBtn").addEventListener("click", () => setBet(LADDER.find((x) => x > bet() + 1e-9) || 100));
  $("halfBtn").addEventListener("click", () => setBet(bet() / 2));
  $("doubleBtn").addEventListener("click", () => setBet(bet() * 2));
  betInput.addEventListener("change", () => setBet(bet()));
})();
