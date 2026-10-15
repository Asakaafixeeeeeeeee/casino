/* Game promotions and the Lotto results popup, loaded on every page by site.js.

   1. Promotions: a picture card advertising a game (Lotto every other time, so it shows most), on this repeating
      schedule across all pages of the site: the first 5 minutes after the visitor arrives, then 1 hour, 2 minutes,
      5 minutes, 1 hour and 3 minutes after each previous one, then the same again. The schedule lives in localStorage,
      so it carries over from page to page and between tabs (only one tab shows each one). Promotions never show on a
      game page, the wallet, withdrawals, sign-up, admin or partner pages, while a dialog or payment screen is open, or
      on top of another popup; an overdue one waits for a quiet moment. Close it, or mute promotions for 24 hours.
   2. Lotto results: when the main admin publishes a draw's results, every visitor with the site open sees a
      "CONGRATULATIONS" popup with the draw's name and winning numbers within about half a minute (only published
      results are ever served), once per draw. */
(function () {
  "use strict";
  const U = window.VBUtil;
  if (!U || window.WinBPromos) return;
  /* automated test browsers stay quiet unless a test asks for the popups (e2e/tests/promos-accounts.spec.ts) */
  try { if (navigator.webdriver && localStorage.getItem("winb.promos.test") !== "1") return; } catch (e) { return; }

  const me = document.currentScript && document.currentScript.src;
  const root = me ? new URL("../../", me).href : "/";
  const at = (p) => new URL(p, root).href;
  const page = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  const isGame = !!document.querySelector("body.game-page, body[data-shell='game']") || /\/(volta-jet|mines-live)\//.test(location.pathname);
  const PROMO_OFF = /^(admin|wallet|withdraw|register|partners|partner-setup|regional)\.html$/;
  const RESULT_OFF = /^(admin|wallet|withdraw|partners|partner-setup|regional)\.html$/;
  const promoHere = !isGame && !PROMO_OFF.test(page);
  const resultHere = !RESULT_OFF.test(page);

  const MIN = 60 * 1000;
  const GAPS = [5, 60, 2, 5, 60, 3]; /* minutes before popup 1, 2, 3, 4, 5, 6; then again */
  const KEY = "winb.promos.v1";
  const MUTE = "winb.promos.mute";
  const SEEN = "winb.lotto.seenResult";
  const loadedAt = Date.now();
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } };
  const esc = U.esc;

  /* ---------------- what to advertise ---------------- */
  const gameName = (pg, fallback) => {
    const g = ((window.VB && window.VB.games) || []).find((x) => x.page === pg);
    return (g && g.name) || fallback;
  };
  const LOTTO = [
    { page: "lotto.html", img: "assets/img/lotto/lotto-machine.svg", tag: "Daily draw", title: "WIN B Lotto",
      text: "Pick 1 to 5 lucky numbers from 1–90. Five winning numbers are drawn every day.", cta: "Play Lotto" },
    { page: "lotto.html", img: "assets/img/lotto/lotto-ticket.svg", tag: "Fixed payouts", title: "Your numbers, your ticket",
      text: "Direct, Perm or Banker — payouts are fixed the moment you buy your Lotto ticket.", cta: "Pick my numbers" },
    { page: "lotto.html", img: "assets/img/thumbs/lotto.webp", tag: "Tonight's draw", title: "Will tonight be lucky?",
      text: "Get your WIN B Lotto ticket before betting closes. Winners are paid straight to their balance.", cta: "Stake Lotto" },
  ];
  const OTHERS = [
    { page: "aviator.html", img: "assets/img/thumbs/sky-rush.webp", tag: "Live", fallback: "Aviator", text: "Watch the plane climb and cash out before it flies away." },
    { page: "mines.html", img: "assets/img/thumbs/volta-mines.webp", tag: "Popular", fallback: "Mines", text: "Find the gems, dodge the mines, and cash out when you like." },
    { page: "magicball.html", img: "assets/img/thumbs/magic-ball.webp", tag: "Instant", fallback: "Magic Ball", text: "Call the colour of the next ball and win in seconds." },
    { page: "olympus.html", img: "assets/img/thumbs/volta-olympus.webp", tag: "Slots", fallback: "Olympus", text: "Spin with the gods for multipliers on every tumble." },
    { page: "fruits.html", img: "assets/img/thumbs/volta-fruits.webp", tag: "Slots", fallback: "Fruits", text: "A juicy classic: line up the fruits for a win." },
    { page: "roulette.html", img: "assets/img/thumbs/roulette.webp", tag: "Table", fallback: "Roulette", text: "Red or black, odd or even — place your chips and spin." },
    { page: "goal.html", img: "assets/img/thumbs/volta-goal.webp", tag: "Sport", fallback: "Goal", text: "Pick your corner and beat the keeper." },
    { page: "crash.html", img: "assets/img/thumbs/volta-crash.webp", tag: "Rounds", fallback: "Crash", text: "Ride the multiplier and cash out in time." },
  ];
  /* Lotto on popups 1, 3 and 5 of every round of six (half of all promotions); other games take turns on the rest */
  function promoFor(step, n) {
    if (step % 2 === 0) return LOTTO[(n || 0) % LOTTO.length];
    const o = OTHERS[(n || 0) % OTHERS.length];
    return { page: o.page, img: o.img, tag: o.tag, title: gameName(o.page, o.fallback), text: o.text, cta: "Play now" };
  }

  /* ---------------- quiet moments ---------------- */
  function busy() {
    if (document.hidden) return true;
    if (document.querySelector("dialog[open], .me-dialog, .me-sheet, .wbp-card, .wbc-wrap, [aria-modal='true']:not([hidden])")) return true;
    const pay = document.querySelector(".payfx");
    if (pay && !pay.hidden && pay.offsetParent !== null) return true;
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true; /* typing something */
    return false;
  }

  /* ---------------- the promotion card ---------------- */
  let card = null;
  function closeCard(how) {
    if (!card) return;
    const c = card;
    card = null;
    c.classList.add("is-out");
    setTimeout(() => c.remove(), 420);
    if (how === "mute") {
      write(MUTE, Date.now() + 24 * 60 * MIN);
      U.toast && U.toast("Promotions muted for 24 hours.");
    }
  }
  function showPromo(p, step) {
    card = document.createElement("aside");
    card.className = "wbp-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Promotion: " + p.title);
    card.dataset.step = String(step);
    card.dataset.game = p.page.replace(/\.html$/, "");
    card.innerHTML =
      '<button type="button" class="wbp-close" data-wbp-close aria-label="Close">&times;</button>' +
      '<div class="wbp-pic"><img src="' + esc(at(p.img)) + '" alt="' + esc(p.title) + '" loading="eager"><span class="wbp-tag">' + esc(p.tag) + "</span></div>" +
      '<div class="wbp-body"><h2 class="wbp-title">' + esc(p.title) + '</h2><p class="wbp-text">' + esc(p.text) + "</p>" +
      '<a class="wbp-cta" href="' + esc(at(p.page)) + '">' + esc(p.cta) + "</a>" +
      '<button type="button" class="wbp-mute" data-wbp-mute>Mute promotions for 24 hours</button></div>';
    document.body.appendChild(card);
    requestAnimationFrame(() => card && card.classList.add("is-in"));
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-wbp-close]")) closeCard();
      else if (e.target.closest("[data-wbp-mute]")) closeCard("mute");
    });
    const c = card;
    setTimeout(() => { if (card === c) closeCard(); }, 30000);
  }

  /* ---------------- the schedule ---------------- */
  function schedule() {
    let s = read(KEY, null);
    if (!s || typeof s.nextAt !== "number" || typeof s.step !== "number") {
      s = { step: 0, nextAt: Date.now() + GAPS[0] * MIN, lotto: 0, other: 0 };
      write(KEY, s);
    }
    return s;
  }
  function tickPromos() {
    if (!promoHere || card) return;
    if (read(MUTE, 0) > Date.now()) return;
    const s = schedule();
    const now = Date.now();
    if (now < s.nextAt) return;
    if (now - loadedAt < 15000) return; /* give a page that just opened a moment first */
    if (busy()) return;
    /* claim this popup first, so another tab doesn't show it too */
    const step = s.step % GAPS.length;
    const lottoTurn = step % 2 === 0;
    const p = promoFor(step, lottoTurn ? s.lotto : s.other);
    const next = { step: (step + 1) % GAPS.length, nextAt: now + GAPS[(step + 1) % GAPS.length] * MIN,
      lotto: (s.lotto || 0) + (lottoTurn ? 1 : 0), other: (s.other || 0) + (lottoTurn ? 0 : 1), last: { step, game: p.page, at: now } };
    write(KEY, next);
    showPromo(p, step);
  }

  /* ---------------- Lotto results: the congratulations popup ---------------- */
  let shown = false;
  const ballCls = (n) => "lt-c" + Math.min(8, Math.floor((Number(n) - 1) / 10));
  function closeCongrats(wrap) {
    if (!wrap.isConnected || wrap.classList.contains("is-out")) return;
    wrap.classList.add("is-out");
    setTimeout(() => { wrap.remove(); shown = false; }, 600);
  }
  function showCongrats(r) {
    shown = true;
    write(SEEN, r.id);
    const wrap = document.createElement("div");
    wrap.className = "wbc-wrap";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-label", "Lotto results published: " + r.name);
    const COLORS = ["#ffd34d", "#ff4b6e", "#4fd1ff", "#6ff0a4", "#c58bff", "#ff9a3c", "#ffffff"];
    const FLOWERS = ["🌸", "🌼", "✿", "❀", "🎉", "✨"];
    let bits = "";
    for (let i = 0; i < 46; i++) {
      const left = (Math.random() * 100).toFixed(1), delay = (Math.random() * 2.4).toFixed(2), dur = (3.6 + Math.random() * 2.8).toFixed(2);
      const drift = ((Math.random() - 0.5) * 160).toFixed(0), spin = ((Math.random() - 0.5) * 1080).toFixed(0);
      const style = "left:" + left + "%;animation-delay:" + delay + "s;animation-duration:" + dur + "s;--drift:" + drift + "px;--spin:" + spin + "deg";
      if (i % 4 === 0) bits += '<span class="wbc-flower" style="' + style + ";font-size:" + (12 + Math.random() * 12).toFixed(0) + 'px">' + FLOWERS[i % FLOWERS.length] + "</span>";
      else bits += '<span class="wbc-bit" style="' + style + ";background:" + COLORS[i % COLORS.length] + (i % 3 === 0 ? ";border-radius:50%" : "") + '"></span>';
    }
    const onLotto = page === "lotto.html";
    wrap.innerHTML =
      '<div class="wbc-confetti" aria-hidden="true">' + bits + "</div>" +
      '<button type="button" class="wbc-close" data-wbc-close aria-label="Close">&times;</button>' +
      '<div class="wbc-stage">' +
        '<p class="wbc-kicker">Lotto results are out</p>' +
        '<h2 class="wbc-title">CONGRATULATIONS <span aria-hidden="true">🎉</span></h2>' +
        '<p class="wbc-draw">' + esc(r.name) + " · Draw #" + r.id + "</p>" +
        '<div class="wbc-balls" aria-label="Winning numbers: ' + r.numbers.join(", ") + '">' +
          r.numbers.map((n, i) => '<span class="wbc-ball ' + ballCls(n) + '" style="animation-delay:' + (0.35 + i * 0.22).toFixed(2) + 's"><i>' + n + "</i></span>").join("") +
        "</div>" +
        '<p class="wbc-note">Winning numbers · published ' + esc(new Date(r.published_at).toLocaleString("en-GB", { timeZone: "Africa/Accra", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })) + " GMT</p>" +
        '<a class="wbc-stake" href="' + esc(at("lotto.html")) + (onLotto ? "#ltPick" : "") + '">STAKE LOTTO</a>' +
      "</div>";
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("is-in"));
    wrap.addEventListener("click", (e) => {
      if (e.target.closest("[data-wbc-close]") || e.target === wrap) return closeCongrats(wrap);
      if (onLotto && e.target.closest(".wbc-stake")) closeCongrats(wrap);
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { closeCongrats(wrap); document.removeEventListener("keydown", onKey); }
    });
    setTimeout(() => closeCongrats(wrap), 16000);
  }
  let pending = null;
  async function checkResult() {
    if (!resultHere || shown) return;
    if (!pending) {
      const r = await U.paymentApi("/api/games/lotto/latest-result", { timeout: 15000 });
      const res = r.ok && r.data && r.data.result;
      if (!res || !Array.isArray(res.numbers) || !res.numbers.length) return;
      const seen = Number(read(SEEN, 0)) || 0;
      const fresh = Date.now() - new Date(res.published_at).getTime() < 6 * 3600e3;
      if (res.id <= seen || !fresh) return;
      pending = res;
    }
    if (busy() && !document.querySelector(".wbp-card")) return; /* wait for a quiet moment (a promotion just makes way) */
    if (card) closeCard();
    const r = pending;
    pending = null;
    showCongrats(r);
  }

  window.WinBPromos = { GAPS, KEY, state: () => read(KEY, null), tick: tickPromos, checkResult };
  schedule();
  setInterval(tickPromos, 5000);
  setTimeout(checkResult, 2500);
  setInterval(() => { if (!document.hidden) checkResult(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { checkResult(); tickPromos(); } });
})();
