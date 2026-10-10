/* Home page: promo carousel, For You row, live winner banner, game sections and payments */
(function () {
  "use strict";
  const { games, payments, recentWins, promos, categories } = window.VB;
  const U = window.VBUtil;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const byId = (id) => games.find((g) => g.id === id);
  const byPlayers = (a, b) => b.players - a.players;

  /* ---------------- promo carousel ---------------- */
  function carousel(host, slides) {
    const title = (p) => p.title.replace(p.highlight, "<span>" + p.highlight + "</span>");
    host.innerHTML =
      '<div class="slides">' +
      slides.map((p, i) =>
        '<a class="slide slide-' + p.theme + '" href="' + p.href + '" aria-roledescription="slide" aria-label="' +
        (i + 1) + " of " + slides.length + ": " + p.title + '">' +
        '<span class="slide-copy"><span class="slide-kicker">' + p.kicker + "</span>" +
        '<strong class="slide-title">' + title(p) + "</strong>" +
        '<span class="slide-sub">' + p.sub + "</span>" +
        '<span class="btn btn-primary btn-sm">' + p.cta + "</span></span>" +
        '<span class="slide-art" aria-hidden="true">' + p.art + "</span></a>").join("") +
      "</div>" +
      '<button class="car-arrow prev" type="button" data-step="-1" aria-label="Previous slide">' + U.icon("chevronLeft") + "</button>" +
      '<button class="car-arrow next" type="button" data-step="1" aria-label="Next slide">' + U.icon("chevronRight") + "</button>" +
      '<div class="dots">' +
      slides.map((p, i) => '<button class="dot" type="button" data-go="' + i + '" aria-label="Show slide ' + (i + 1) + '"></button>').join("") +
      "</div>" +
      '<button class="car-pause" type="button"></button>';

    const track = host.querySelector(".slides");
    const dots = Array.from(host.querySelectorAll(".dot"));
    const pauseBtn = host.querySelector(".car-pause");
    let index = 0;
    let timer = null;
    let paused = reduceMotion; /* never auto-advance for people who asked for less motion */
    let hovering = false;
    let keyboardFocus = false;

    const paint = () => {
      dots.forEach((d, i) => d.setAttribute("aria-current", String(i === index)));
      pauseBtn.innerHTML = U.icon(paused ? "play" : "pause");
      pauseBtn.setAttribute("aria-label", paused ? "Play slideshow" : "Pause slideshow");
    };
    const go = (i) => {
      index = (i + slides.length) % slides.length;
      track.scrollTo({ left: index * track.clientWidth, behavior: reduceMotion ? "auto" : "smooth" });
      paint();
    };
    /* auto-advance every 5s unless paused, hovered, keyboard-focused, or the tab is hidden */
    const schedule = () => {
      clearInterval(timer);
      if (!paused && !hovering && !keyboardFocus && !document.hidden) timer = setInterval(() => go(index + 1), 5000);
    };

    track.addEventListener("scroll", () => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      if (i !== index) {
        index = i;
        paint();
      }
    }, { passive: true });

    host.addEventListener("click", (e) => {
      const step = e.target.closest("[data-step]");
      const dot = e.target.closest("[data-go]");
      if (step) go(index + Number(step.dataset.step));
      else if (dot) go(Number(dot.dataset.go));
      else if (e.target.closest(".car-pause")) {
        paused = !paused;
        paint();
      } else return;
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

    paint();
    schedule();
  }

  carousel(document.getElementById("carousel"), promos);

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
  (function winnerBanner(host) {
    /* only wins whose game is in the lobby: a game an admin switched off must never take the whole page down */
    const wins = recentWins.filter((w) => byId(w.gameId));
    if (!wins.length) {
      host.hidden = true;
      return;
    }
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
        '<span class="winner-line">Congrats <b>' + w.masked + "</b> won <em>" +
        w.amount.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " GHS</em></span>";
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
  })(document.getElementById("winner"));

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
