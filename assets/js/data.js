/* WIN B casino — invented catalogue data. No third-party game or provider names are used. */
(function (global) {
  "use strict";

  /* the studios behind the games; game counts are derived from the catalogue below, so they always match the lobby */
  const providers = [
    { id: "bonwire", name: "Bonwire Labs", short: "Bonwire", color: "#8b5cf6" },
    { id: "accra", name: "Accra Play", short: "Accra Play", color: "#ff5d7a" }
  ];

  /* lobby categories, in tab order */
  const categories = ["Live Casino", "Instant Win", "Slots"];

  /* artwork base hue per category; each title drifts up to ±25° from it */
  const hues = { Crash: 355, "Instant Win": 90, Slots: 45 };

  /* Deterministic pseudo-random so every page load renders the same recent winners. */
  function seeded(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /* stable string hash — per-game artwork and player counts */
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  const rand = seeded(20260419);

  /* the lobby: WIN B casino's own games, each played on its own full-screen page */
  const games = [
    /* one live round for everybody (backend games/skyRush.ts, page aviator.html): P(crash ≥ m) = 97% ÷ m, each round's
       seed fingerprint is published before take-off and the seed after it */
    { id: "aviator", name: "Aviator", category: "Live Casino", providerId: "bonwire", icon: "✈️", rtp: 97, maxWin: "₵ 250,000",
      volatility: "Medium", minBet: "₵ 1", tags: ["LIVE", "NEW", "HOT"], real: true, page: "aviator.html", thumb: "assets/img/thumbs/sky-rush.webp" },
    /* the crash maths runs at this RTP (crash.js for credits, backend games/flights.ts for real money) */
    { name: "Crash", category: "Live Casino", providerId: "bonwire", icon: "💥", rtp: 99.23, maxWin: "₵ 250,000",
      volatility: "Low", minBet: "₵ 1", tags: ["HOT"], real: true, page: "crash.html", thumb: "assets/img/thumbs/volta-crash.webp" },
    /* the landing chance is set so that bet × multiplier returns 97% (wings.js) */
    { id: "wings", name: "Rendo Wings", category: "Live Casino", providerId: "bonwire", icon: "🛩️", rtp: 97, maxWin: "₵ 25,000",
      volatility: "High", minBet: "₵ 0.10", tags: ["NEW"], real: true, page: "wings.html", thumb: "assets/img/thumbs/volta-wings.webp" },
    /* its own page (volta-jet/): P(passing x) = 98% ÷ x up to a 10.70x top, in the page for credits and in backend
       games/flights.ts for real money */
    { name: "Jet", category: "Live Casino", providerId: "bonwire", icon: "✈️", rtp: 98, maxWin: "10.7x",
      volatility: "Medium", minBet: "₵ 0.10", tags: ["NEW"], real: true, page: "volta-jet/index.html", thumb: "assets/img/thumbs/volta-jet.webp" },
    /* the knockout point follows the crash maths, P(KO ≥ m) = 97% ÷ m (knockout.js, games/flights.ts); ColorGo pays the same RTP */
    { name: "Knockout", category: "Live Casino", providerId: "bonwire", icon: "🥊", rtp: 97, maxWin: "₵ 250,000",
      volatility: "High", minBet: "₵ 0.10", tags: ["NEW"], real: true, page: "knockout.html",
      thumb: "assets/img/thumbs/volta-knockout.webp" },
    { name: "Bottle", category: "Instant Win", providerId: "accra", icon: "🍾", rtp: 96, maxWin: "₵ 100,000",
      volatility: "Low", minBet: "₵ 0.50", tags: ["NEW"], real: true, page: "bottle.html", thumb: "assets/img/thumbs/volta-bottle-alt.webp" },
    /* 26 winning cards in a 54-card deck at 2x: 96.3% on a fresh deck */
    { name: "Red Black", category: "Instant Win", providerId: "accra", icon: "🃏", rtp: 96.3, maxWin: "₵ 30,000",
      volatility: "Low", minBet: "₵ 0.20", tags: ["NEW"], real: true, page: "redblack.html", thumb: "assets/img/thumbs/red-black.webp" },
    /* every multiplier is 96.5% ÷ the chance of that many stars in a row */
    { name: "Mines", category: "Instant Win", providerId: "accra", icon: "💣", rtp: 96.5, maxWin: "₵ 100,000",
      volatility: "High", minBet: "₵ 0.10", tags: ["NEW"], real: true, page: "mines.html", thumb: "assets/img/thumbs/volta-mines.webp" },
    /* the ball is under each of the 3 cups one time in three, and a spot pays 2.9x: 96.67% */
    { name: "Magic Ball", category: "Instant Win", providerId: "accra", icon: "🥤", rtp: 96.67, maxWin: "₵ 29,000",
      volatility: "Low", minBet: "₵ 0.20", tags: ["NEW"], real: true, page: "magicball.html", thumb: "assets/img/thumbs/magic-ball.webp" },
    /* the chance of reaching a lane is 97% ÷ its multiplier (crossing.js) */
    { name: "Crossing", category: "Instant Win", providerId: "accra", icon: "🐔", rtp: 97, maxWin: "₵ 100,000",
      volatility: "High", minBet: "₵ 0.10", tags: ["NEW"], real: true, page: "crossing.html", thumb: "assets/img/thumbs/volta-crossing.webp" },
    /* 13 pockets, a number pays ×12, a row ×3, even-money ×2: 12/13 on every bet */
    { name: "Roulette", category: "Instant Win", providerId: "accra", icon: "🎡", rtp: 92.31, maxWin: "₵ 24,000",
      volatility: "Medium", minBet: "₵ 0.10", tags: ["NEW"], real: true, page: "roulette.html", thumb: "assets/img/thumbs/roulette.webp" },
    /* 105 of the 216 rolls win for each call, at 2x: 97.22% */
    { name: "Even-Odd", category: "Instant Win", providerId: "accra", icon: "🎲", rtp: 97.22, maxWin: "₵ 30,000",
      volatility: "Low", minBet: "₵ 0.20", tags: ["NEW"], real: true, page: "evenodd.html", thumb: "assets/img/thumbs/even-odd.webp" },
    /* one bomb a column; each multiplier is 97% ÷ the chance of getting there, rounded down */
    { name: "Goal", category: "Instant Win", providerId: "accra", icon: "⚽", rtp: 97, maxWin: "₵ 100,000",
      volatility: "Medium", minBet: "₵ 0.10", tags: ["NEW"], real: true, page: "goal.html", thumb: "assets/img/thumbs/volta-goal.webp" },
    /* heads 48.5%, tails 48.5%, edge 3% (every bet loses); a call pays 2x: 97% */
    { id: "coin", name: "Flip Da' Coin", category: "Instant Win", providerId: "accra", icon: "🪙", rtp: 97, maxWin: "₵ 100,000",
      volatility: "Low", minBet: "₵ 0.20", tags: ["NEW"], real: true, page: "coin.html", thumb: "assets/img/thumbs/volta-coin.webp" },
    /* the shared-board game on its own Node server (mines-live/); real-money rounds and bets are the balance service's
       (games/minesLive.ts); 96.5% ÷ P(all picked tiles safe) */
    { id: "mines-live", name: "Live Mines", category: "Instant Win", providerId: "accra", icon: "💣", rtp: 96.5, maxWin: "₵ 10,000",
      volatility: "Medium", minBet: "₵ 0.10", tags: ["LIVE", "NEW"], real: true, page: "https://asakaa-mines-live.onrender.com/",
      thumb: "assets/img/thumbs/volta-mines-live.webp" },
    /* Magic Ball Live: one table for everyone on its own server (magicball-live/), demo credits for now */
    { id: "magic-ball-live", name: "Magic Ball Live", category: "Live Casino", providerId: "accra", icon: "🥤", rtp: 96.7, maxWin: "2.9x",
      volatility: "Medium", minBet: "1 credit", tags: ["LIVE", "NEW"], real: false, page: "https://asakaa-mines-live.onrender.com/magicball/",
      thumb: "assets/img/thumbs/magic-ball-live.webp" },
    /* Hi-Lo: each call pays 97% ÷ its chance, down to the cent: 96.47%–96.94% a call, 96.8% on average (games/catalog.ts) */
    { name: "Hi-Lo", category: "Instant Win", providerId: "bonwire", icon: "🃏", rtp: 96.8, maxWin: "12.36x",
      volatility: "Low", minBet: "₵ 0.20", tags: ["NEW"], real: true, page: "hilo.html", thumb: "assets/img/thumbs/volta-hilo.webp" },
    /* a 5×3, 20-line fruit slot; the RTP is exact (fruits-math.js enumerates every payline outcome) */
    { name: "Blaze Fruits", category: "Slots", providerId: "accra", icon: "🍒", rtp: 96.05, maxWin: "2,500x",
      volatility: "Medium", minBet: "₵ 0.20", tags: ["NEW", "HOT"], real: true, page: "fruits.html", thumb: "assets/img/thumbs/volta-fruits.webp" },
    /* RTP measured over 50M spins played the way real money plays them (olympus-math.js MEASURED) */
    { name: "Olympus", category: "Slots", providerId: "bonwire", icon: "⚡", rtp: 96.0, maxWin: "15,000x",
      volatility: "High", minBet: "₵ 0.20", tags: ["NEW"], real: true, page: "olympus.html", thumb: "assets/img/thumbs/volta-olympus.webp" }
  ].map((o) => {
    /* a game's id is its name as a slug — unless it carries its own, so a renamed game keeps its id (storage keys,
       the admin catalogue and the server all refer to it) */
    const id = o.id || o.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const h = hash(id);
    const provider = providers.find((p) => p.id === o.providerId);
    return Object.assign({}, o, {
      id,
      provider: provider.name,
      providerShort: provider.short,
      hue: (hues[o.category] + (h % 51) - 25 + 360) % 360,
      /* simulated "playing now" count */
      players: 1890 + (h % 2400)
    });
  });

  /* "momo" wallets are checked against their network prefixes; withdrawals go to momo only.
     Vodafone Cash became Telecel Cash in 2024, so 020 and 050 are one network. */
  const payments = [
    { id: "mtn", name: "MTN MoMo", desc: "Instant · 024 / 054 / 055 / 059", initials: "MoMo", color: "#ffcc00", ink: "#1a1204",
      type: "momo", prefixes: ["024", "025", "053", "054", "055", "059"] },
    { id: "telecel", name: "Telecel Cash", desc: "Instant · 020 / 050", initials: "TC", color: "#1c62b9",
      type: "momo", prefixes: ["020", "050"] },
    { id: "airteltigo", name: "AirtelTigo Money", desc: "Instant · 026 / 027 / 056 / 057", initials: "AT", color: "#e4002b",
      type: "momo", prefixes: ["026", "027", "056", "057"] },
    { id: "bank", name: "Bank Transfer", desc: "1–3 working days · no fee from ₵ 1,000", initials: "🏦", color: "#2f7a5f", type: "bank" },
    { id: "card", name: "Visa / Mastercard", desc: "Instant · 3D Secure", initials: "💳", color: "#3b5bdb", type: "card" }
  ];

  /* promotions — shown in the home carousel and on promotions.html. None is live yet: each is marked
     "Coming soon" and says plainly that nothing is paid until it launches. */
  const promos = [
    {
      id: "cashback", theme: "orange", art: "💰", soon: true,
      kicker: "Coming soon", title: "Lucky Cash Back", highlight: "Cash Back",
      sub: "10% of last week's net losses back, up to ₵ 1,000.",
      cta: "Learn more", href: "promotions.html#cashback",
      terms: [
        "Not live yet — no cashback is paid until it launches.",
        "Planned: credited every Monday, based on net casino losses from Monday to Sunday.",
        "Planned: 1x wagering on cashback funds."
      ]
    },
    {
      id: "vip", theme: "gold", art: "👑", soon: true,
      kicker: "Coming soon", title: "VIP & Bonus", highlight: "Bonus",
      sub: "Five VIP levels with reload bonuses and faster payouts.",
      cta: "Learn more", href: "promotions.html#vip",
      terms: [
        "Not live yet — VIP points aren't being collected.",
        "Planned: every ₵ 10 wagered earns one VIP point.",
        "Planned: weekly reload bonuses from level 3, priority withdrawals at level 5."
      ]
    },
    {
      id: "welcome", theme: "red", art: "🎁", soon: true,
      kicker: "Coming soon", title: "Welcome Bonus", highlight: "Bonus",
      sub: "100% up to ₵ 500 on your first two deposits.",
      cta: "Learn more", href: "promotions.html#welcome",
      terms: [
        "Not live yet — deposits made now don't receive a bonus.",
        "Planned: new accounts only, 20x wagering on bonus funds."
      ]
    }
  ];

  /* games and studios an admin has switched off (site.js keeps this list fresh from the server): they're left out of
     every list, but still findable by id in allGames, so a game's own page keeps working */
  let hidden = { games: [], providers: [] };
  try {
    const h = JSON.parse(localStorage.getItem("vb.catalog.hidden") || "null");
    if (h && Array.isArray(h.games) && Array.isArray(h.providers)) hidden = h;
  } catch (e) { /* storage unavailable */ }
  const isHidden = (g) => hidden.games.includes(g.id) || hidden.providers.includes(g.providerId);
  const visible = games.filter((g) => !isHidden(g));

  /* deterministic recent wins for the winner banner, taking the lobby's games in turn — never a game that's switched
     off, which the home page couldn't show; player numbers are masked like a phone */
  const recentWins = !visible.length ? [] : Array.from({ length: 14 }, (_, i) => {
    const g = visible[i % visible.length];
    return {
      gameId: g.id,
      masked: "****" + String(1000 + Math.floor(rand() * 9000)),
      amount: Math.round((120 + rand() * 3800) * 100) / 100
    };
  });

  /* customer care: live chat is on every page; the email and the numbers to call go HERE, in one place, and show up on
     the Customer care page, in the footer, in the chat and on the legal pages. Leave a field empty and it's not shown. */
  const contact = {
    email: "",                      /* e.g. "support@rendowin.com" */
    phones: [                       /* { label, number } — more than one is fine */
      { label: "Customer care", number: "+233 55 618 5004" }
    ],
    whatsapp: "",                   /* e.g. "+233240000000" (digits only, with the country code) */
    hours: "8:00 am – 10:00 pm GMT, every day"
  };

  /* the countries a player can register from (the balance service's countries table has the same codes). Ghana first:
     the site's home, and the only country whose numbers can deposit and withdraw by mobile money for now. */
  const countries = [
    { code: "GH", name: "Ghana", dial: "233", flag: "🇬🇭" },
    { code: "NG", name: "Nigeria", dial: "234", flag: "🇳🇬" },
    { code: "KE", name: "Kenya", dial: "254", flag: "🇰🇪" },
    { code: "ZA", name: "South Africa", dial: "27", flag: "🇿🇦" },
    { code: "EG", name: "Egypt", dial: "20", flag: "🇪🇬" },
    { code: "US", name: "United States", dial: "1", flag: "🇺🇸" },
    { code: "CA", name: "Canada", dial: "1", flag: "🇨🇦" },
    { code: "GB", name: "United Kingdom", dial: "44", flag: "🇬🇧" },
    { code: "DE", name: "Germany", dial: "49", flag: "🇩🇪" },
    { code: "FR", name: "France", dial: "33", flag: "🇫🇷" },
    { code: "ES", name: "Spain", dial: "34", flag: "🇪🇸" },
    { code: "IT", name: "Italy", dial: "39", flag: "🇮🇹" },
    { code: "IN", name: "India", dial: "91", flag: "🇮🇳" },
    { code: "BR", name: "Brazil", dial: "55", flag: "🇧🇷" },
    { code: "AE", name: "United Arab Emirates", dial: "971", flag: "🇦🇪" },
    { code: "JP", name: "Japan", dial: "81", flag: "🇯🇵" },
    { code: "AU", name: "Australia", dial: "61", flag: "🇦🇺" }
  ];

  global.VB = { providers, categories, games: visible, allGames: games, isHidden, recentWins, payments, promos, contact, countries };
})(window);
