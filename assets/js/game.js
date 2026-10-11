/* Game detail page + demo round simulation */
(function () {
  "use strict";
  const { games } = window.VB;
  const U = window.VBUtil;

  const id = new URLSearchParams(location.search).get("game");
  const game = (window.VB.allGames || games).find((g) => g.id === id); /* found even while switched off */

  /* unknown or missing ?game= — say so instead of silently showing another title */
  if (!game) {
    document.title = "Game not found — WIN B WIN";
    document.querySelector("main").innerHTML =
      '<div class="empty" style="margin:40px 0">' +
      "<div style='font-size:2rem;margin-bottom:8px'>🎰</div>" +
      "<h1 style='font-size:1.4rem;color:var(--text)'>Game not found</h1>" +
      "<p>That title isn't in the lobby. The link may be out of date.</p>" +
      '<a class="btn btn-primary btn-sm" href="games.html">Browse all games</a></div>';
    return;
  }
  document.title = game.name + " — WIN B WIN";
  /* switched off by an admin: say so plainly rather than offering a game that won't take bets */
  if (window.VB.isHidden && window.VB.isHidden(game)) {
    document.querySelector("main").innerHTML =
      '<div class="empty" style="margin:40px 0">' +
      "<div style='font-size:2rem;margin-bottom:8px'>" + game.icon + "</div>" +
      "<h1 style='font-size:1.4rem;color:var(--text)'>" + U.esc(game.name) + " is unavailable</h1>" +
      "<p>This game is switched off for now. Please try another one.</p>" +
      '<a class="btn btn-primary btn-sm" href="games.html">Browse all games</a></div>';
    return;
  }
  U.recent.add(game.id); /* feeds the home page's "For You" row */

  /* ---- populate ---- */
  const poster = document.getElementById("poster");
  poster.style.setProperty("--h", game.hue);
  poster.classList.toggle("has-img", !!game.thumb);
  poster.innerHTML = U.thumbFace(game);

  document.getElementById("title").textContent = game.name;
  document.getElementById("tagCat").textContent = game.category;
  document.getElementById("tagVol").textContent = game.volatility + " volatility";
  document.getElementById("tagRtp").textContent = game.rtp + "% RTP";
  document.getElementById("blurb").textContent =
    game.name + " sits in our " + game.category.toLowerCase() +
    " collection with a theoretical return of " + game.rtp + "% and a maximum award of " + game.maxWin + ".";

  const info = [
    ["Category", game.category],
    ["RTP", game.rtp + "%"],
    ["Volatility", game.volatility],
    ["Minimum bet", game.minBet],
    ["Maximum win", game.maxWin],
    ["Lines / rounds", game.category === "Slots" ? "20 paylines" : "Unlimited rounds"],
    ["Support", "Mobile, tablet, desktop"],
    ["Free play", "Available without deposit"]
  ];
  document.getElementById("info").innerHTML = info
    .map((r) => "<div class='line'><span>" + r[0] + "</span><span>" + r[1] + "</span></div>")
    .join("");

  document.getElementById("rtpVal").textContent = game.rtp + "%";
  document.getElementById("rtpBar").style.width = Math.min(100, game.rtp) + "%";

  document.getElementById("about").textContent =
    game.name + " is an original WIN B casino game in our " +
    game.category.toLowerCase() + " range. It supports an adjustable bet size, autoplay and a " +
    "round history you can reopen at any time. All titles in this lobby are original works created for WIN B casino.";

  /* ---- related (the section is hidden when no other game is similar) ---- */
  const related = document.getElementById("related");
  const similar = games
    .filter((g) => g.id !== game.id && g.category === game.category)
    .slice(0, 6);
  similar.forEach((g) => related.appendChild(U.gameCard(g)));
  related.closest("section").hidden = !similar.length;
  document.getElementById("similarAll").href = "games.html?category=" + encodeURIComponent(game.category);

  /* ---- favourite toggle ---- */
  const favBtn = document.getElementById("favBtn");
  const paintFav = () => {
    const on = U.favs.has(game.id);
    favBtn.innerHTML = U.icon("heart") + (on ? "In My Games" : "Add to My Games");
    favBtn.classList.toggle("on", on);
    favBtn.setAttribute("aria-pressed", String(on));
  };
  paintFav();
  favBtn.addEventListener("click", () => {
    const on = U.favs.toggle(game.id);
    paintFav();
    U.toast(on ? "Added to My Games" : "Removed from My Games", on ? "ok" : "");
  });

  document.getElementById("shareBtn").addEventListener("click", async () => {
    const url = location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: game.name, url });
        return;
      } catch (e) {
        if (e.name === "AbortError") return; /* user closed the share sheet */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      U.toast("Link copied to clipboard", "ok");
    } catch (e) {
      U.toast("Copy failed — " + url);
    }
  });

  /* ---- round outcomes ----
     Win multipliers with relative weights, by volatility: low pays small and often, high pays
     big and rarely. The hit rate is derived from the title's RTP so that, over many rounds,
     P(win) × average multiplier = RTP — e.g. 96.2% RTP returns ₵ 96.20 per ₵ 100 staked. */
  const PAYTABLE = {
    Low: [[2, 60], [3, 25], [5, 10], [10, 5]],
    Medium: [[2, 45], [3, 28], [5, 17], [10, 8], [25, 2]],
    High: [[2, 40], [5, 28], [10, 17], [25, 10], [50, 4], [100, 1]]
  };
  const table = PAYTABLE[game.volatility] || PAYTABLE.Medium;
  const totalWeight = table.reduce((sum, [, w]) => sum + w, 0);
  const meanMultiplier = table.reduce((sum, [m, w]) => sum + m * w, 0) / totalWeight;
  const hitRate = game.rtp / 100 / meanMultiplier;

  function drawMultiplier() {
    if (Math.random() >= hitRate) return 0;
    let r = Math.random() * totalWeight;
    for (const [m, w] of table) {
      if ((r -= w) < 0) return m;
    }
    return table[table.length - 1][0];
  }

  /* ---- demo modal ---- */
  const DEMO_CREDITS = 5000;
  const modal = document.getElementById("demo");
  const spinBtn = document.getElementById("spin");
  const stageIcon = document.getElementById("stageIcon");
  const stageTitle = document.getElementById("stageTitle");
  const stageMsg = document.getElementById("stageMsg");
  const betInput = document.getElementById("bet");
  /* everything outside the modal — including the shell's bottom nav and chat — is made inert while it is open */
  const page = Array.from(document.querySelectorAll(".site-header, main, .site-footer, .bottom-nav, .chat-fab, .chat-sheet"));

  let mode = "demo"; /* production game pages expose only the in-game demo play */
  let credits = DEMO_CREDITS;
  let spinning = false;
  let returnFocus = null;

  const fmt = (n, real) => (real ? U.money(n) : n.toLocaleString("en-GH") + " credits");
  const funds = () => (mode === "real" ? U.wallet.balance() : credits);
  const fundsLine = () =>
    mode === "real" ? "Balance: " + U.money(U.wallet.balance()) : "Free credits: " + credits.toLocaleString("en-GH");

  function openDemo(real) {
    if (game.funOnly) {
      location.href = game.page;
      return;
    }
    if (real && !U.session.get()) {
      U.toast("Log in to play for real money.", "err");
      setTimeout(() => location.assign("register.html#login"), 900);
      return;
    }
    /* games the server doesn't settle yet open with free credits — said plainly, never passed off as real */
    let downgraded = false;
    if (real && !game.real) {
      U.toast("Real-money play for " + game.name + " is coming soon — opening it with free credits.", "");
      real = false;
      downgraded = true;
    }
    if (real && U.wallet.balance() < 1) {
      U.toast("Your balance is " + U.money(U.wallet.balance()) + ". Deposit in the wallet, or try free play.", "err");
      return;
    }
    if (game.page) {
      let url = game.page + "?game=" + encodeURIComponent(game.id) + "&mode=" + (real ? "real" : "fun");
      /* a game on its own server (Mines Live) can't see this site's sign-in, so a real-money visit carries it in the
         address's #fragment, which the browser never sends anywhere; the game takes it out of the address at once */
      if (real && /^https?:/.test(game.page)) url += "#t=" + encodeURIComponent(U.session.get().token);
      setTimeout(() => location.assign(url), downgraded ? 1400 : 0); /* time to read the message */
      return;
    }
    mode = real ? "real" : "demo";
    if (!real) credits = DEMO_CREDITS;

    document.getElementById("demoTitle").textContent = game.name + (real ? " — real play" : " — free play");
    document.getElementById("demoNote").textContent = real
      ? "Bets come out of your wallet balance."
      : "Free credits reset each time you open free play. Deposit to play for real.";
    stageIcon.textContent = game.icon;
    stageTitle.textContent = "Ready when you are";
    stageMsg.textContent = fundsLine() + " · " + game.name;

    returnFocus = document.activeElement;
    modal.classList.add("open");
    page.forEach((el) => (el.inert = true));
    document.body.style.overflow = "hidden";
    spinBtn.focus();
  }

  function closeDemo() {
    modal.classList.remove("open");
    page.forEach((el) => (el.inert = false));
    document.body.style.overflow = "";
    if (returnFocus) returnFocus.focus();
  }

  const playDemo = document.getElementById("playDemo");
  const playReal = document.getElementById("playReal");
  playDemo.addEventListener("click", () => openDemo(false));
  playReal.addEventListener("click", () => openDemo(true));
  modal.addEventListener("click", (e) => {
    if (e.target === modal || e.target.closest("[data-close]")) closeDemo();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) closeDemo();
  });

  document.querySelectorAll("[data-bet]").forEach((b) =>
    b.addEventListener("click", () => (betInput.value = b.dataset.bet))
  );

  /* moves money for one round — real mode uses the wallet, demo mode its own credits */
  function settle(real, delta) {
    if (real) U.wallet.setBalance(U.wallet.balance() + delta);
    else credits += delta;
  }

  function spin() {
    if (spinning) return;
    const real = mode === "real";
    const bet = Math.max(1, Math.floor(Number(betInput.value) || 0));
    betInput.value = bet;
    if (bet > funds()) {
      stageTitle.textContent = real ? "Not enough balance" : "Not enough credits";
      stageMsg.textContent = real
        ? "Lower your bet or top up in the wallet."
        : "Lower your bet, or reopen free play to reset your credits.";
      return;
    }

    settle(real, -bet);
    /* aria-disabled rather than disabled, so keyboard focus stays on the button */
    spinning = true;
    spinBtn.setAttribute("aria-disabled", "true");
    stageTitle.textContent = "Spinning…";
    stageMsg.textContent = "Best of luck";

    setTimeout(() => {
      const multiplier = drawMultiplier();
      const payout = bet * multiplier;
      settle(real, payout);
      spinning = false;
      spinBtn.removeAttribute("aria-disabled");

      stageIcon.textContent = payout ? "🎉" : game.icon;
      stageTitle.textContent = payout ? "You won " + fmt(payout, real) + "!" : "No win this round";
      stageMsg.textContent = fundsLine() + " · bet " + fmt(bet, real) + (payout ? " · x" + multiplier : "");
      if (payout) U.toast("Round win: " + fmt(payout, real), "ok");
    }, 620);
  }

  spinBtn.addEventListener("click", spin);
  betInput.addEventListener("keydown", (e) => { if (e.key === "Enter") spin(); });
})();
