/* Red Black — call the colour of the next card: hearts and diamonds are RED, spades and clubs BLACK, and a correct
   call pays 2x. A round is one shuffled deck of 54 cards: 52, plus 2 Jokers that lose every call. Cards aren't put
   back, so the deck runs down through the round and the history shows every card drawn; New Round shuffles a full deck.
   Each hand:  IDLE (choose a bet) → REVEALING (the top card turns over) → RESULT (Play Next Hand).
   The deck is shuffled at the start of a round and then dealt in order — no card is ever picked to suit a call.
   The balance, bet controls, menu, sounds and confetti come from the shared mini-game kit (minigame.js). */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);

  const PAYOUT = 2;
  const FLIP_MS = 700;   // matches the card's CSS flip
  const SUITS = {
    H: { name: "hearts", red: true },
    D: { name: "diamonds", red: true },
    S: { name: "spades", red: false },
    C: { name: "clubs", red: false }
  };
  const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const RANK_NAMES = { A: "Ace", J: "Jack", Q: "Queen", K: "King" };
  const JOKERS = 2;
  const DECK_SIZE = Object.keys(SUITS).length * RANKS.length + JOKERS;   // 54
  const IDLE_TEXT = "Red or black? Make your call.";

  const card = $("rbCard");
  const slot = $("rbSlot");
  const inner = $("rbInner");
  const front = $("rbFront");
  const histList = $("rbHistory");
  const deckEl = $("rbDeck");
  const sideButtons = Array.from(document.querySelectorAll("[data-side]"));

  let phase = "IDLE";   /* IDLE → REVEALING → RESULT */
  let deck = [];        /* face-down cards; the top card is the last one */
  let drawn = [];       /* this round's cards, in the order they came out */
  let call = null;      /* { side, stake } — the hand being played */

  const kit = window.VBMini.create({
    prefix: "rb",
    winSound: "cardFan",   /* this game's own win sound (minigame.js SFX) */
    gameId: "red-black",
    server: true,         /* real-money rounds are drawn and settled by the server */
    minBet: 0.2,
    tableMax: 15000,
    chips: [0.2, 1, 5, 10, 50, 100, 500],
    busy: () => phase === "REVEALING",
    busyText: "Wait for the card to turn before switching.",
    onChange: () => paint(),
    confettiFrom: () => card,
    confettiColors: ["#ff3d3d", "#ffffff", "#ffcc00", "#111111", "#ff8a80", "#4caf50"]
  });
  const { money, round2, announce } = kit;

  /* 26 of the 54 cards win a call, so on a full deck a call returns 2 × 26/54 = 96.3% */
  const RTP = Math.round(PAYOUT * (26 / DECK_SIZE) * 1000) / 10;
  $("rbRtp").textContent = RTP + "%";
  $("rbRulesRtp").textContent = RTP + "%";

  /* ---------------- cards ---------------- */
  const colourOf = (c) => (c.joker ? "JOKER" : SUITS[c.suit].red ? "RED" : "BLACK");
  const nameOf = (c) => (c.joker ? "Joker" : (RANK_NAMES[c.rank] || c.rank) + " of " + SUITS[c.suit].name);
  const codeOf = (c) => (c.joker ? "JK" : c.rank + c.suit);

  /* a full deck in a random order — Fisher–Yates, so every order is equally likely */
  function shuffledDeck() {
    const cards = [];
    Object.keys(SUITS).forEach((suit) => RANKS.forEach((rank) => cards.push({ rank, suit })));
    for (let j = 0; j < JOKERS; j++) cards.push({ joker: true });
    for (let i = cards.length - 1; i > 0; i--) {
      const k = Math.floor(Math.random() * (i + 1));
      [cards[i], cards[k]] = [cards[k], cards[i]];
    }
    return cards;
  }

  /* ---------------- card art: SVG on a 250 × 350 card, with the suits from the page's sprite ---------------- */
  const SERIF = "Georgia, 'Times New Roman', serif";
  const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";
  const INK_RED = "#cf1d24";
  const INK_BLACK = "#151515";
  const INK_JOKER = "#5b1a8e";
  const GOLD = "#e8b923";
  const COL = { L: 78, C: 125, R: 172 };
  /* the standard pip layouts: [column, height from 0 (top) to 1 (bottom)]; pips in the lower half print upside down */
  const PIPS = {
    2: [["C", 0], ["C", 1]],
    3: [["C", 0], ["C", 0.5], ["C", 1]],
    4: [["L", 0], ["R", 0], ["L", 1], ["R", 1]],
    5: [["L", 0], ["R", 0], ["C", 0.5], ["L", 1], ["R", 1]],
    6: [["L", 0], ["R", 0], ["L", 0.5], ["R", 0.5], ["L", 1], ["R", 1]],
    7: [["L", 0], ["R", 0], ["C", 0.25], ["L", 0.5], ["R", 0.5], ["L", 1], ["R", 1]],
    8: [["L", 0], ["R", 0], ["C", 0.25], ["L", 0.5], ["R", 0.5], ["C", 0.75], ["L", 1], ["R", 1]],
    9: [["L", 0], ["R", 0], ["L", 1 / 3], ["R", 1 / 3], ["C", 0.5], ["L", 2 / 3], ["R", 2 / 3], ["L", 1], ["R", 1]],
    10: [["L", 0], ["R", 0], ["C", 1 / 6], ["L", 1 / 3], ["R", 1 / 3], ["L", 2 / 3], ["R", 2 / 3], ["C", 5 / 6], ["L", 1], ["R", 1]]
  };

  const pip = (suit, x, y, size, upsideDown) =>
    '<use href="#rb' + suit + '" x="' + (x - size / 2) + '" y="' + (y - size / 2) + '" width="' + size + '" height="' + size + '"' +
    (upsideDown ? ' transform="rotate(180 ' + x + " " + y + ')"' : "") + "/>";
  const svg = (viewBox, ink, body) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + viewBox + '" fill="' + ink + '" aria-hidden="true" focusable="false">' + body + "</svg>";
  /* playing cards read the same both ways up: draw a corner or a court half, then again turned round */
  const bothWays = (body) => "<g>" + body + '</g><g transform="rotate(180 125 175)">' + body + "</g>";

  /* a crown for a King, a tiara for a Queen, a plumed cap for a Jack — each sits above the letter */
  const EMBLEMS = {
    K: (ink) => '<path d="M97 112V84l14 13 14-23 14 23 14-13v28z" fill="' + GOLD + '" stroke="' + ink + '" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M97 104H153" stroke="' + ink + '" stroke-width="2"/>' +
      '<circle cx="97" cy="81" r="3.5"/><circle cx="125" cy="71" r="3.5"/><circle cx="153" cy="81" r="3.5"/>',
    Q: (ink) => '<path d="M98 112C98 100 101 92 106 86C110 92 116 94 125 72C134 94 140 92 144 86C149 92 152 100 152 112Z" fill="' + GOLD +
      '" stroke="' + ink + '" stroke-width="2" stroke-linejoin="round"/>' +
      '<circle cx="106" cy="83" r="3"/><circle cx="125" cy="69" r="3.5"/><circle cx="144" cy="83" r="3"/>',
    J: (ink) => '<path d="M99 112c0-15 11-26 26-26s26 11 26 26z" fill="' + GOLD + '" stroke="' + ink + '" stroke-width="2"/>' +
      '<path d="M138 92c8-13 19-19 31-21-8 8-13 17-23 25z"/><path d="M96 112H154" stroke="' + ink + '" stroke-width="3"/>'
  };

  function faceSVG(c) {
    if (c.joker) return jokerSVG();
    const ink = SUITS[c.suit].red ? INK_RED : INK_BLACK;
    const ten = c.rank === "10";
    const index = '<text x="27" y="50" text-anchor="middle" font-family="' + SERIF + '" font-weight="700" font-size="' + (ten ? 34 : 40) + '"' +
      (ten ? ' letter-spacing="-3"' : "") + ">" + c.rank + "</text>" + pip(c.suit, 27, 70, 24);
    let middle;
    if (c.rank === "A") middle = pip(c.suit, 125, 175, c.suit === "S" ? 128 : 96);
    else if (PIPS[c.rank]) middle = PIPS[c.rank].map(([col, f]) => pip(c.suit, COL[col], 76 + f * 198, 44, f > 0.5)).join("");
    else middle = courtSVG(c, ink);
    return svg("0 0 250 350", ink, bothWays(index) + middle);
  }

  /* court cards: a framed, double-headed panel with the emblem, the letter and a suit */
  function courtSVG(c, ink) {
    const half = EMBLEMS[c.rank](ink) +
      '<text x="125" y="168" text-anchor="middle" font-family="' + SERIF + '" font-weight="700" font-size="74">' + c.rank + "</text>" +
      pip(c.suit, 74, 68, 24);
    return '<rect x="50" y="44" width="150" height="262" rx="6" fill="' + (SUITS[c.suit].red ? "#fdeceb" : "#e9eef7") +
      '" stroke="' + ink + '" stroke-width="2.5"/>' +
      '<rect x="56" y="50" width="138" height="250" rx="4" fill="none" stroke="' + GOLD + '" stroke-width="1.5"/>' +
      '<path d="M56 194L194 156" stroke="' + GOLD + '" stroke-width="1.5"/>' + bothWays(half);
  }

  function jokerSVG() {
    const corner = "JOKER".split("").map((ch, i) =>
      '<text x="25" y="' + (42 + i * 23) + '" text-anchor="middle" font-family="' + SANS + '" font-weight="900" font-size="21">' + ch + "</text>").join("") +
      '<path d="M25 148l4 8.5 9 1.2-6.6 6.2 1.7 9-8.1-4.4-8.1 4.4 1.7-9-6.6-6.2 9-1.2z" fill="' + GOLD + '"/>';
    return svg("0 0 250 350", INK_JOKER, bothWays(corner) +
      '<use href="#rbJester" x="45" y="88" width="160" height="132"/>' +
      '<text x="125" y="262" text-anchor="middle" font-family="' + SANS + '" font-weight="900" font-size="34" letter-spacing="5">JOKER</text>');
  }

  /* history cards: rank and suit along the top (what shows in the overlapped column), a large suit below */
  function miniSVG(c) {
    if (c.joker) {
      return svg("0 0 42 59", INK_JOKER,
        '<text x="21" y="15" text-anchor="middle" font-family="' + SANS + '" font-weight="900" font-size="9" letter-spacing=".4">JOKER</text>' +
        '<use href="#rbJester" x="4" y="24" width="34" height="28"/>');
    }
    const ten = c.rank === "10";
    return svg("0 0 42 59", SUITS[c.suit].red ? INK_RED : INK_BLACK,
      '<text x="4" y="17" font-family="' + SERIF + '" font-weight="700" font-size="' + (ten ? 14 : 16) + '"' + (ten ? ' letter-spacing="-1"' : "") + ">" +
      c.rank + "</text>" + pip(c.suit, 32, 11, 13) + pip(c.suit, 21, 39, 24));
  }

  const suitIcon = (suit) => '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><use href="#rb' + suit + '"/></svg>';

  /* ---------------- the table: deck, history, tracker dots, status ---------------- */
  function paintDeck() {
    const left = deck.length;
    const layers = left ? Math.min(9, Math.ceil(left / 6)) : 0;  /* the stack gets thinner as it runs down */
    deckEl.innerHTML = Array.from({ length: layers }, (_, i) => '<i style="--o:' + (layers - 1 - i) + '"></i>').join("");
    $("rbLeft").textContent = left;
  }

  /* the last ten colours, newest first */
  function paintDots() {
    const recent = drawn.slice(-10).reverse();
    $("rbDots").innerHTML = Array.from({ length: 10 }, (_, i) =>
      '<span class="rb-dot' + (recent[i] ? " is-" + colourOf(recent[i]).toLowerCase() : "") + '"></span>').join("");
  }

  function addToHistory(c) {
    const li = document.createElement("li");
    li.className = "rb-mini is-new";
    li.dataset.card = codeOf(c);
    li.innerHTML = '<span class="sr-only">' + nameOf(c) + "</span>" + miniSVG(c);
    histList.appendChild(li);
  }

  function showStatus(msg, result) {
    const badge = $("rbBadge");
    badge.hidden = !result;
    if (result) {
      badge.className = "rb-badge is-" + result.colour.toLowerCase() + (result.won ? " is-win" : "");
      badge.innerHTML = (result.suit ? suitIcon(result.suit) : "") + "<span>" + result.colour + "</span>";
    }
    $("rbMsg").className = "rb-msg" + (result && result.won ? " win" : "");
    $("rbMsg").textContent = msg;
  }

  function paint() {
    const busy = phase === "REVEALING";
    sideButtons.forEach((b) => {
      b.hidden = phase === "RESULT";
      b.setAttribute("aria-disabled", String(busy));
      b.classList.toggle("picked", busy && !!call && b.dataset.side === call.side);
    });
    $("rbNext").hidden = phase !== "RESULT";
    $("rbNew").hidden = drawn.length === 0;   /* a round is under way once a card has come out */
    $("rbNew").disabled = busy;
    kit.paintBet(busy);
  }

  /* ---------------- moving the card ---------------- */
  /* turns the card over (it lifts a little on the way) and calls done once it lies face up */
  function turnOver(c, done) {
    front.innerHTML = faceSVG(c);
    card.classList.remove("is-win", "is-lifting");
    void card.offsetWidth;
    card.classList.add("is-lifting", "is-up");
    kit.flick();
    let settled = false;
    const end = () => {
      if (settled) return;
      settled = true;
      card.classList.remove("is-lifting");
      done();
    };
    inner.addEventListener("transitionend", function onEnd(e) {
      if (e.target !== inner) return;
      inner.removeEventListener("transitionend", onEnd);
      end();
    });
    setTimeout(end, FLIP_MS + 150); /* in case transitionend never fires (hidden tab, reduced motion) */
  }

  /* puts the card face down again at once, ready for the next hand */
  function faceDown() {
    inner.style.transition = "none";
    card.classList.remove("is-up", "is-win", "is-lifting");
    void inner.offsetWidth;
    inner.style.transition = "";
    card.setAttribute("aria-label", "Face-down card — pays 2x");
  }

  /* the turned card slides off to its place in the history … */
  function discard() {
    const target = histList.lastElementChild;
    if (kit.reduceMotion || !target) return;
    const from = card.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const ghost = document.createElement("div");
    ghost.className = "rb-ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.innerHTML = front.innerHTML;
    Object.assign(ghost.style, { left: from.left + "px", top: from.top + "px", width: from.width + "px", height: from.height + "px" });
    document.body.appendChild(ghost);
    void ghost.offsetWidth;
    ghost.style.transform = "translate(" + (to.left - from.left) + "px, " + (to.top - from.top) + "px) scale(" + to.width / from.width + ")";
    ghost.style.opacity = "0.2";
    setTimeout(() => ghost.remove(), 450);
  }

  /* … and the next one is dealt from the deck */
  function dealIn() {
    if (kit.reduceMotion || !deck.length) return;
    const from = deckEl.getBoundingClientRect();
    const to = slot.getBoundingClientRect();
    slot.style.setProperty("--dx", from.left + from.width / 2 - (to.left + to.width / 2) + "px");
    slot.style.setProperty("--dy", from.top + from.height / 2 - (to.top + to.height / 2) + "px");
    slot.style.setProperty("--ds", (from.width / to.width).toFixed(3));
    slot.classList.remove("is-dealt");
    void slot.offsetWidth;
    slot.classList.add("is-dealt");
  }

  /* ---------------- a hand ---------------- */
  async function play(side, stake) {
    if (phase !== "IDLE" || !deck.length) return false;
    if (!kit.canAfford(stake)) return false;
    kit.unlockAudio();
    call = { side, stake };
    phase = "REVEALING";
    paint();
    showStatus("Turning the card…");
    const round = await kit.place(stake, { side });
    if (round === false) {
      phase = "IDLE";
      showStatus(IDLE_TEXT);
      paint();
      return false;
    }
    /* real money: the server deals from a freshly shuffled full deck every hand; free credits run this deck down */
    const c = round ? round.outcome.card : deck.pop();
    paintDeck();
    card.setAttribute("aria-label", "Turning the card");
    announce("You called " + side + " for GHS " + money(stake) + ". Turning the card.");
    turnOver(c, () => finish(c, side, stake, round));
    return true;
  }

  /* a focused button that's about to be hidden hands focus to the button replacing it, so keyboard play carries on.
     Checked before repainting: the browser drops focus from a hidden button as soon as it restyles the page. */
  const holdsFocus = (...buttons) => buttons.includes(document.activeElement);

  function finish(c, side, stake, round) {
    const refocus = holdsFocus(...sideButtons);
    const colour = colourOf(c);
    const won = colour === side;
    const win = round ? round.payout : won ? round2(stake * PAYOUT) : 0;
    kit.collect(win);
    drawn.push(c);
    addToHistory(c);
    paintDots();
    phase = "RESULT";
    card.setAttribute("aria-label", nameOf(c));
    card.classList.toggle("is-win", won);
    const msg = won ? "You Won 🏆 GHS " + money(win)
      : c.joker ? "It's a Joker — sorry, every call loses."
      : "Sorry, you chose " + side + "!";
    showStatus(msg, { colour, suit: c.suit, won });
    paint();
    if (refocus) $("rbNext").focus();
    if (won) kit.celebrate();
    announce(nameOf(c) + ", " + colour + ". " + msg);
  }

  function nextHand() {
    if (phase !== "RESULT") return;
    const refocus = holdsFocus($("rbNext"));
    if (!deck.length) {
      newRound();
      U.toast("That was the last card — a fresh deck is shuffled.", "ok");
    } else {
      discard();
      faceDown();
      dealIn();
      phase = "IDLE";
      showStatus(IDLE_TEXT);
      paint();
    }
    if (refocus) (sideButtons.find((b) => call && b.dataset.side === call.side) || sideButtons[0]).focus();
  }

  /* a fresh, shuffled deck: the history and the tracker start again */
  function newRound() {
    deck = shuffledDeck();
    drawn = [];
    call = null;
    histList.innerHTML = "";
    paintDots();
    paintDeck();
    faceDown();
    dealIn();
    deckEl.classList.remove("is-shuffling");
    void deckEl.offsetWidth;
    deckEl.classList.add("is-shuffling");
    phase = "IDLE";
    showStatus("New deck shuffled — " + IDLE_TEXT.charAt(0).toLowerCase() + IDLE_TEXT.slice(1));
    paint();
    announce("New round: a full deck of " + DECK_SIZE + " cards is shuffled.");
  }

  sideButtons.forEach((b) => b.addEventListener("click", () => {
    if (phase === "IDLE") play(b.dataset.side, kit.bet());
  }));
  $("rbNext").addEventListener("click", nextHand);

  /* New Round mid-round asks first, in a sheet from the bottom */
  const sheet = $("rbConfirm");
  $("rbNew").addEventListener("click", () => {
    if (phase !== "REVEALING" && drawn.length) sheet.showModal();
  });
  $("rbConfirmNew").addEventListener("click", () => {
    sheet.close();   /* focus goes back to New Round, which the fresh deck hides */
    const refocus = holdsFocus($("rbNew"));
    newRound();
    if (refocus) sideButtons[0].focus();
  });
  $("rbConfirmStay").addEventListener("click", () => sheet.close());
  /* a tap on the dimmed backdrop counts as Stay */
  window.VBMini.backdropClose(sheet);

  deck = shuffledDeck();
  paintDeck();
  paintDots();
  paint();
})();
