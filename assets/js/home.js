/* Home page: promo carousel, For You row, live winner banner, game sections and payments */
(function () {
  "use strict";
  const { games, payments, categories } = window.VB;
  const U = window.VBUtil;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const byId = (id) => games.find((g) => g.id === id);
  const byPlayers = (a, b) => b.players - a.players;

  /* ---------------- hero banners ---------------- */
  /* WIN B casino's own banners: black, gold and red, each with a different game's artwork. Every amount is the
     game's real top prize (data.js maxWin). Slides change by themselves every 5 seconds (or by swiping, or the arrows
     on a desktop); no pause button and no dots. */
  const HERO = [
    { game: "roulette", kicker: "WIN B casino", title: "Ghana's <span>premium</span> casino", sub: "Crash games, live tables, slots and instant wins, all in one place.", cta: "Play now", href: "games.html", tone: "gold" },
    { game: "crash", kicker: "Crash", title: "Fly up to <span>₵ 250,000</span>", sub: "Cash out before the plane goes down. A new round every few seconds.", cta: "Play Crash", tone: "red" },
    { game: "olympus", kicker: "Slots", title: "Win up to <span>15,000x</span>", sub: "Olympus: tumbling wins and multipliers from the gods.", cta: "Spin Olympus", tone: "gold" },
    { game: "knockout", kicker: "Fight night", title: "Knock out <span>₵ 250,000</span>", sub: "Mad Punch: cash out before the knockout, or call the colour of the round.", cta: "Play Knockout", tone: "red" },
    { game: "mines", kicker: "Instant win", title: "Pick the <span>gems</span>", sub: "Mines: every safe tile raises your win. Deposit in seconds with mobile money.", cta: "Play Mines", tone: "gold" }
  ];
  function carousel(host, list) {
    /* a slide whose game an admin switched off is left out */
    const slides = list.filter((p) => byId(p.game));
    host.innerHTML =
      '<div class="slides">' +
      slides.map((p, i) => {
        const g = byId(p.game);
        const href = p.href || "game.html?game=" + encodeURIComponent(g.id);
        const plain = p.title.replace(/<[^>]+>/g, "");
        return '<a class="slide hero-slide hero-' + p.tone + '" href="' + href + '" aria-roledescription="slide" aria-label="' +
          (i + 1) + " of " + slides.length + ": " + U.esc(plain) + '">' +
          (g.thumb ? '<img class="hero-photo" src="' + g.thumb + '" alt="" ' + (i ? 'loading="lazy" ' : "") + 'decoding="async">' : "") +
          '<span class="slide-copy"><span class="slide-kicker">' + p.kicker + "</span>" +
          '<strong class="slide-title">' + p.title + "</strong>" +
          '<span class="slide-sub">' + p.sub + "</span>" +
          '<span class="btn btn-primary btn-sm">' + p.cta + "</span></span></a>";
      }).join("") +
      "</div>" +
      '<button class="car-arrow prev" type="button" data-step="-1" aria-label="Previous slide">' + U.icon("chevronLeft") + "</button>" +
      '<button class="car-arrow next" type="button" data-step="1" aria-label="Next slide">' + U.icon("chevronRight") + "</button>";

    const track = host.querySelector(".slides");
    let index = 0;
    let timer = null;
    const still = reduceMotion; /* never auto-advance for people who asked for less motion */
    let hovering = false;
    let keyboardFocus = false;

    const go = (i) => {
      index = (i + slides.length) % slides.length;
      track.scrollTo({ left: index * track.clientWidth, behavior: reduceMotion ? "auto" : "smooth" });
    };
    /* auto-advance every 5s unless hovered, keyboard-focused, or the tab is hidden */
    const schedule = () => {
      clearInterval(timer);
      if (!still && !hovering && !keyboardFocus && !document.hidden) timer = setInterval(() => go(index + 1), 5000);
    };

    track.addEventListener("scroll", () => {
      index = Math.round(track.scrollLeft / track.clientWidth);
    }, { passive: true });

    host.addEventListener("click", (e) => {
      const step = e.target.closest("[data-step]");
      if (!step) return;
      go(index + Number(step.dataset.step));
      schedule(); /* a manual move restarts the 5s countdown */
    });
    host.addEventListener("mouseenter", () => { hovering = true; schedule(); });
    host.addEventListener("mouseleave", () => { hovering = false; schedule(); });
    /* only keyboard focus pauses — a mouse click on "play" must not leave the slideshow stuck */
    host.addEventListener("focusin", (e) => {
      keyboardFocus = e.target.matches(":focus-visible");
      schedule();
    });
    host.addEventListener("focusout", (e) => {
      if (host.contains(e.relatedTarget)) return;
      keyboardFocus = false;
      schedule();
    });
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("resize", () => track.scrollTo({ left: index * track.clientWidth }));

    schedule();
  }

  carousel(document.getElementById("carousel"), HERO);

  /* ---------------- For You: recently played and favourites first, then a mix of top titles ---------------- */
  const personal = U.recent.all().concat(U.favs.all()).map(byId).filter(Boolean);
  const topByCategory = categories.map((c) => games.filter((g) => g.category === c).sort(byPlayers));
  const mix = [];
  for (let round = 0; mix.length < games.length && round < 8; round++) {
    topByCategory.forEach((list) => list[round] && mix.push(list[round]));
  }
  const forYou = Array.from(new Set(personal.concat(mix))).slice(0, 12);
  const forYouRow = document.getElementById("forYou");
  forYou.forEach((g) => forYouRow.appendChild(U.miniCard(g)));

  /* ---------------- live winner banner ---------------- */
  /* Show verified wins and published top prizes; never invent player activity. */
  const winnerHost = document.getElementById("winner");
  winnerHost.hidden = true;
  const shuffle = (list) => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  U.activity.site().then((d) => {
    const all = ((d && d.wins) || [])
      .map((w) => ({ gameId: w.game, masked: w.player, amount: w.payout, big: !!w.big }))
      /* only wins whose game is in the lobby: a game an admin switched off must never take the whole page down */
      .filter((w) => byId(w.gameId));
    /* the games' top prizes: amounts in cedis, or multipliers of 100x and more */
    const prizes = games.filter((g) => g.maxWin && (/₵/.test(g.maxWin) || parseFloat(g.maxWin.replace(/,/g, "")) >= 100))
      .map((g) => ({ gameId: g.id, prize: g.maxWin }));
    const big = shuffle(all.filter((w) => w.big));
    const realWins = big.slice(0, 1).concat(shuffle(big.slice(1).concat(all.filter((w) => !w.big))));
    winnerBanner(winnerHost, realWins.concat(shuffle(prizes)));
  });
  function winnerBanner(host, wins) {
    if (!wins.length) return;
    host.hidden = false;
    const thumb = host.querySelector(".winner-thumb");
    const body = host.querySelector(".winner-body");
    const play = host.querySelector(".winner-play");
    let i = 0;
    let hovering = false;

    function paint() {
      const w = wins[i];
      const g = byId(w.gameId);
      thumb.style.setProperty("--h", g.hue);
      thumb.classList.toggle("has-img", !!g.thumb);
      thumb.innerHTML = U.thumbFace(g);
      body.innerHTML =
        '<strong class="winner-game">' + g.name + "</strong>" +
        (w.prize
          ? '<span class="winner-line">Win up to <em>' + U.esc(w.prize) + "</em></span>"
          : '<span class="winner-line">Congrats <b>' + U.esc(w.masked) + "</b> won <em>" +
            w.amount.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " GHS</em></span>");
      play.href = "game.html?game=" + encodeURIComponent(g.id);
      play.setAttribute("aria-label", "Play " + g.name);
      /* restart the slide-in animation */
      body.classList.remove("swap");
      void body.offsetWidth;
      body.classList.add("swap");
    }

    paint();
    host.addEventListener("mouseenter", () => (hovering = true));
    host.addEventListener("mouseleave", () => (hovering = false));
    host.addEventListener("focusin", () => (hovering = true));
    host.addEventListener("focusout", () => (hovering = false));
    if (!reduceMotion) {
      setInterval(() => {
        if (hovering || document.hidden) return;
        i = (i + 1) % wins.length;
        paint();
      }, 3500);
    }
  }

  /* ---------------- game sections ---------------- */
  const byCategory = (c) => games.filter((g) => g.category === c);
  const SECTIONS = [
    { title: "Hot", icon: "flame", tone: "tone-orange", list: games.filter((g) => g.tags.includes("HOT")), href: "games.html?tag=hot" },
    { title: "New", icon: "sparkle", tone: "tone-yellow", list: games.filter((g) => g.tags.includes("NEW")), href: "games.html?tag=new" },
    { title: "Slots", icon: "slots", tone: "tone-yellow", list: byCategory("Slots"), href: "games.html?category=Slots" },
    { title: "Live Casino", icon: "live", tone: "tone-red", list: byCategory("Live Casino"), href: "games.html?category=Live%20Casino" },
    /* bonus rounds and progressive prizes live in the jackpot titles */
    { title: "Bonus", icon: "gift", tone: "tone-orange", list: byCategory("Jackpots"), href: "games.html?category=Jackpots" }
  ];

  const sectionsHost = document.getElementById("sections");
  SECTIONS.forEach((s, n) => {
    if (!s.list.length) return; /* no games of that kind in the lobby yet */
    const section = document.createElement("section");
    section.className = "block";
    section.setAttribute("aria-labelledby", "sec" + n);
    section.innerHTML =
      '<div class="section-head">' +
      '<h2 class="section-title" id="sec' + n + '">' + U.icon(s.icon, s.tone) + s.title + "</h2>" +
      '<a class="view-all" href="' + s.href + '">View All' + U.icon("chevronRight") + '<span class="sr-only"> ' + s.title + " games</span></a>" +
      "</div>";
    const grid = document.createElement("div");
    grid.className = "game-grid";
    s.list.slice().sort(byPlayers).slice(0, 6).forEach((g) => grid.appendChild(U.gameCard(g)));
    section.appendChild(grid);
    sectionsHost.appendChild(section);
  });

  /* ---------------- complete catalogue ---------------- */
  const allGamesGrid = document.getElementById("allGamesGrid");
  games.slice().sort(byPlayers).forEach((g) => allGamesGrid.appendChild(U.gameCard(g)));

  /* ---------------- payment methods ---------------- */
  const paySection = document.querySelector('[aria-labelledby="payTitle"]');
  paySection.hidden = false;

  const pay = document.getElementById("payGrid");
  payments.forEach((m) => {
    const el = document.createElement("div");
    el.className = "pay-card";
    el.innerHTML =
      '<span class="pay-logo" style="background:' + m.color + (m.ink ? ";color:" + m.ink : "") + '">' + m.initials + "</span>" +
      "<span><strong>" + m.name + "</strong><small>" + m.desc.split(" · ")[0] + "</small></span>";
    pay.appendChild(el);
  });
})();
