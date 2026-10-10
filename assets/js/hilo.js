/* Hi-Lo — a card shows; call whether the next one is HIGHER or LOWER. Aces high, a tie loses, and every call pays
   97% ÷ its chance (the multiplier on the button), rounded down to the cent.
   Each hand:  IDLE (choose a bet, tap a call) → CONFIRM (the sheet) → REVEALING (the next card turns) → RESULT
   (Play Next Hand: the pair goes to the hands column and a fresh card is dealt).
   For real money the server draws the next card from the other 51 and pays; with credits the page draws it. The
   balance, bet controls, menu, sounds and confetti come from the shared mini-game kit (minigame.js). */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);

  const TARGET = 0.97;   /* the share of a call's fair odds that it pays */
  const FLIP_MS = 700;
  const SUITS = { H: { name: "hearts", red: true }, D: { name: "diamonds", red: true }, S: { name: "spades", red: false }, C: { name: "clubs", red: false } };
  const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];   /* low to high: aces high */
  const RANK_NAMES = { A: "Ace", J: "Jack", Q: "Queen", K: "King" };
  const IDLE_TEXT = "Higher or lower? Make your call.";

  let phase = "IDLE";   /* IDLE → CONFIRM → REVEALING → RESULT */
  let base = null;      /* the card showing */
  let next = null;      /* the card turned over this hand */
  let call = null;      /* { pick, stake, mult } */
  let hands = 0;

  const kit = window.VBMini.create({
    prefix: "hl",
    winSound: "cardFan",
    gameId: "volta-hilo",
    server: true,
    minBet: 0.2,
    tableMax: 10000,
    chips: [0.2, 1, 5, 10, 50, 100],
    busy: () => phase === "REVEALING",
    busyText: "Wait for the card to turn before switching.",
    onChange: () => paint(),
    confettiFrom: () => $("hlNext"),
    confettiColors: ["#ffd54f", "#ffffff", "#c8102e", "#2e9e4a", "#fff3c4"]
  });
  const { money, announce } = kit;
  const floor2 = (v) => Math.floor(v * 100 + 1e-6) / 100;

  /* ---------------- the odds ---------------- */
  const rankIndex = (c) => RANKS.indexOf(c.rank);
  const wins = (c, pick) => (pick === "HIGHER" ? RANKS.length - 1 - rankIndex(c) : rankIndex(c)) * 4;
  /* the multiplier a call pays: 97% ÷ P(win) over the other 51 cards, down to the cent — the same sum as the server's */
  const multiplier = (c, pick) => { const w = wins(c, pick); return w ? floor2((TARGET * 51) / w) : 0; };
  const fmtX = (m) => m.toFixed(2) + "x";

  /* ---------------- cards ---------------- */
  const nameOf = (c) => (RANK_NAMES[c.rank] || c.rank) + " of " + SUITS[c.suit].name;
  const randomCard = (not) => {
    for (;;) {
      const c = { rank: RANKS[Math.floor(Math.random() * 13)], suit: Object.keys(SUITS)[Math.floor(Math.random() * 4)] };
      if (!not || c.rank !== not.rank || c.suit !== not.suit) return c;
    }
  };
  const INK_RED = "#cf1d24", INK_BLACK = "#1a1a1a";
  const pip = (suit, x, y, size, flip) =>
    '<use href="#hl' + suit + '" x="' + (x - size / 2) + '" y="' + (y - size / 2) + '" width="' + size + '" height="' + size + '"' + (flip ? ' transform="rotate(180 ' + x + " " + y + ')"' : "") + "/>";
  /* a face: rank and suit in the corners, one large suit in the middle (court cards get a letter panel) */
  function face(c) {
    const ink = SUITS[c.suit].red ? INK_RED : INK_BLACK;
    const ten = c.rank === "10";
    const corner = (x, y, flip) =>
      '<text x="' + x + '" y="' + y + '" font-family="Georgia, serif" font-size="46" font-weight="700" text-anchor="middle"' + (ten ? ' letter-spacing="-3"' : "") + (flip ? ' transform="rotate(180 ' + x + " " + (y - 16) + ')"' : "") + ">" + c.rank + "</text>" +
      pip(c.suit, x, y + 28, 26, flip);
    const court = "JQK".includes(c.rank);
    const middle = court
      ? '<rect x="62" y="80" width="126" height="190" rx="8" fill="' + (SUITS[c.suit].red ? "#fdeceb" : "#e9eef7") + '" stroke="' + ink + '" stroke-width="2"/>' +
        '<text x="125" y="200" font-family="Georgia, serif" font-size="110" font-weight="700" text-anchor="middle">' + c.rank + "</text>" + pip(c.suit, 125, 232, 30)
      : pip(c.suit, 125, 175, c.rank === "A" ? 120 : 90);
    return '<svg viewBox="0 0 250 350" fill="' + ink + '" aria-hidden="true">' + corner(30, 48) + corner(220, 302, true) + middle + "</svg>";
  }
  const mini = (c) => '<svg viewBox="0 0 42 59" fill="' + (SUITS[c.suit].red ? INK_RED : INK_BLACK) + '" aria-hidden="true"><text x="21" y="26" font-family="Georgia, serif" font-size="22" font-weight="700" text-anchor="middle"' + (c.rank === "10" ? ' letter-spacing="-2"' : "") + ">" + c.rank + "</text>" + pip(c.suit, 21, 43, 18) + "</svg>";

  function showBase(c, dealt) {
    base = c;
    $("hlBaseFace").innerHTML = face(c);
    $("hlBase").setAttribute("aria-label", "The base card: " + nameOf(c));
    const slot = $("hlBase").parentElement;
    if (dealt) { slot.classList.remove("is-dealt"); void slot.offsetWidth; slot.classList.add("is-dealt"); }
  }
  function hideNext() {
    const card = $("hlNext");
    card.classList.remove("is-up", "is-win");
    card.setAttribute("aria-label", "The next card, face down");
    setTimeout(() => { if (!card.classList.contains("is-up")) $("hlNextFace").innerHTML = ""; }, FLIP_MS);
  }

  /* ---------------- painting ---------------- */
  function paint() {
    const idle = phase === "IDLE";
    const hi = base ? multiplier(base, "HIGHER") : 0;
    const lo = base ? multiplier(base, "LOWER") : 0;
    $("hlPaysTop").textContent = hi ? "HIGHER · PAYS " + fmtX(hi) : "HIGHER · —";
    $("hlPaysBottom").textContent = lo ? "LOWER · PAYS " + fmtX(lo) : "LOWER · —";
    $("hlPaysTop").classList.toggle("off", !hi);
    $("hlPaysBottom").classList.toggle("off", !lo);
    $("hlHigherPays").textContent = hi ? "Pays : " + fmtX(hi) : "Not possible";
    $("hlLowerPays").textContent = lo ? "Pays : " + fmtX(lo) : "Not possible";
    document.querySelectorAll("[data-pick]").forEach((b) => {
      const m = b.dataset.pick === "HIGHER" ? hi : lo;
      b.hidden = phase === "RESULT";
      b.disabled = !idle || !m;
    });
    $("hlNextHand").hidden = phase !== "RESULT";
    $("hlNew").disabled = phase === "REVEALING";
    $("hlMaxLabel").textContent = "Max: " + (kit.maxBet() >= 1000 ? Math.round(kit.maxBet() / 1000) + "K" : money(kit.maxBet()));
    kit.paintBet(!idle);
  }

  /* ---------------- a hand ---------------- */
  function ask(pick) {
    if (phase !== "IDLE" || !base) return;
    const stake = kit.bet();
    if (!kit.canAfford(stake)) return;
    const mult = multiplier(base, pick);
    if (!mult) return;
    call = { pick, stake, mult };
    phase = "CONFIRM";
    $("hlConfirmTitle").textContent = "Place bet of GHS " + money(stake) + " for " + (pick === "HIGHER" ? "Higher" : "Lower") + "?";
    $("hlConfirmText").textContent = "The next card turns over. Win and it pays " + fmtX(mult) + " — GHS " + money(floor2(stake * mult)) + ".";
    $("hlConfirm").showModal();
    paint();
  }
  function cancel() {
    if (phase !== "CONFIRM") return;
    $("hlConfirm").close();
    phase = "IDLE";
    call = null;
    paint();
  }
  async function reveal() {
    if (phase !== "CONFIRM") return;
    $("hlConfirm").close();
    phase = "REVEALING";
    kit.unlockAudio();
    paint();
    $("hlBadge").hidden = true;
    $("hlMsg").textContent = "Turning the card…";
    const { pick, stake } = call;
    /* the next card: for real money the server draws it from the other 51 and pays; with credits the page does */
    const round = await kit.place(stake, { base: { rank: base.rank, suit: base.suit }, pick });
    if (round === false) { phase = "IDLE"; call = null; $("hlMsg").textContent = IDLE_TEXT; paint(); return; }
    next = round ? round.outcome.next : randomCard(base);
    const won = round ? round.outcome.won : (pick === "HIGHER" ? rankIndex(next) > rankIndex(base) : rankIndex(next) < rankIndex(base));
    const win = round ? round.payout : won ? floor2(stake * call.mult) : 0;

    const card = $("hlNext");
    $("hlNextFace").innerHTML = face(next);
    card.setAttribute("aria-label", "The next card: " + nameOf(next));
    kit.flick();
    card.classList.add("is-lifting");
    card.classList.add("is-up");
    setTimeout(() => card.classList.remove("is-lifting"), FLIP_MS);
    await new Promise((r) => setTimeout(r, FLIP_MS));

    const outcome = rankIndex(next) > rankIndex(base) ? "HIGHER" : rankIndex(next) < rankIndex(base) ? "LOWER" : "SAME";
    const badge = $("hlBadge");
    badge.hidden = false;
    badge.textContent = outcome === "SAME" ? "SAME" : outcome;
    badge.classList.toggle("is-win", won);
    card.classList.toggle("is-win", won);
    kit.collect(win);
    if (won) {
      $("hlMsg").textContent = "You Won 🏆 GHS " + money(win);
      announce(nameOf(next) + " — " + outcome.toLowerCase() + ". You win GHS " + money(win) + ".");
      kit.celebrate();
    } else {
      $("hlMsg").textContent = outcome === "SAME" ? "Sorry, the same rank loses!" : "Sorry, you chose " + pick + "!";
      announce(nameOf(next) + " — " + (outcome === "SAME" ? "the same rank" : outcome.toLowerCase()) + ". No win.");
      kit.play("thump");
    }
    phase = "RESULT";
    paint();
  }

  /* the pair goes to the hands column and a fresh card is dealt */
  function nextHand() {
    if (phase !== "RESULT") return;
    const li = document.createElement("li");
    li.className = "hl-hand is-new" + (call && $("hlBadge").classList.contains("is-win") ? " is-win" : "");
    li.innerHTML = '<span class="hl-mini">' + mini(base) + '</span><span class="hl-mini">' + mini(next) + "</span>";
    li.setAttribute("aria-label", nameOf(base) + " then " + nameOf(next));
    $("hlHistory").prepend(li);
    hands++;
    hideNext();
    showBase(randomCard(), true);
    $("hlBadge").hidden = true;
    $("hlMsg").textContent = IDLE_TEXT;
    call = null;
    next = null;
    phase = "IDLE";
    kit.flick();
    paint();
  }
  function newRound() {
    $("hlHistory").innerHTML = "";
    hands = 0;
    hideNext();
    showBase(randomCard(), true);
    $("hlBadge").hidden = true;
    $("hlMsg").textContent = IDLE_TEXT;
    call = null;
    next = null;
    phase = "IDLE";
    paint();
  }

  /* ---------------- wiring ---------------- */
  document.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => ask(b.dataset.pick)));
  $("hlConfirmNo").addEventListener("click", cancel);
  $("hlConfirm").addEventListener("cancel", (e) => { e.preventDefault(); cancel(); });
  $("hlConfirmYes").addEventListener("click", reveal);
  $("hlNextHand").addEventListener("click", nextHand);
  $("hlNew").addEventListener("click", () => {
    if (phase === "REVEALING") return;
    if (!hands && phase === "IDLE") return newRound();
    $("hlNewConfirm").showModal();
  });
  $("hlNewNo").addEventListener("click", () => $("hlNewConfirm").close());
  $("hlNewYes").addEventListener("click", () => { $("hlNewConfirm").close(); if (phase === "CONFIRM") cancel(); newRound(); });

  /* the odds table in the rules */
  (function odds() {
    const row = (rank) => {
      const c = { rank, suit: "S" };
      const cell = (pick) => { const m = multiplier(c, pick); const w = wins(c, pick); return w ? "<td>" + fmtX(m) + "</td><td>" + (w / 51 * 100).toFixed(1) + "%</td>" : "<td>—</td><td>—</td>"; };
      return "<tr><td>" + rank + "</td>" + cell("HIGHER") + cell("LOWER") + "</tr>";
    };
    $("hlOdds").innerHTML = "<tr><th>Card</th><th>Higher</th><th>chance</th><th>Lower</th><th>chance</th></tr>" + RANKS.map(row).join("");
    let total = 0, n = 0;
    RANKS.forEach((rank) => ["HIGHER", "LOWER"].forEach((pick) => { const c = { rank, suit: "S" }; const w = wins(c, pick); if (w) { total += multiplier(c, pick) * w / 51; n++; } }));
    const rtp = (total / n * 100).toFixed(1) + "%";
    $("hlRtp").textContent = rtp;
    $("hlRulesRtp").textContent = rtp;
  })();

  newRound();
})();
