/* WIN B Lotto (lotto.html). The server (backend games/lotto.ts) holds the draws, sells the tickets, draws the winning
   numbers from each draw's seed and pays the winners; this page shows the draws taking bets, lets the player build a
   Direct, Perm or Banker ticket, confirm it and buy it, and lists their tickets and the published results. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);
  const esc = U.esc;
  const GAME = "/api/games/lotto";
  const DRAWN = 5;
  const ghs = (n) => "GHS " + Number(n || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const xFmt = (m) => Number(m).toLocaleString("en-GH", { maximumFractionDigits: 1 }) + "×";
  const when = (iso) => iso ? new Date(iso).toLocaleString("en-GB", {
    timeZone: "Africa/Accra", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  }) + " GMT" : "—";
  const choose = (n, k) => { if (k < 0 || k > n) return 0; let r = 1; for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1); return Math.round(r); };
  const chance = (k) => choose(5, k) / choose(90, k);

  const state = {
    st: null, offset: 0, drawId: null, type: "DIRECT", permSize: 2, picks: [], banker: null, againstAll: false,
    mine: [], summary: null, filter: "all", buying: false, revealed: {},
  };
  const draw = () => (state.st && state.st.draws.find((d) => d.id === state.drawId)) || (state.st && state.st.draws[0]) || null;

  /* ---------------- bet types and the board ---------------- */
  const board = $("ltBoard");
  board.innerHTML = Array.from({ length: 90 }, (_, i) =>
    `<button type="button" class="lt-num" data-n="${i + 1}" aria-pressed="false">${i + 1}</button>`).join("");

  function offered() {
    const bt = (state.st && state.st.bet_types) || { direct: [1, 2, 3, 4, 5], perm: [2, 3], banker: true };
    return [
      bt.direct.length ? ["DIRECT", "Direct"] : null,
      bt.perm.length ? ["PERM", "Perm"] : null,
      bt.banker ? ["BANKER", "Banker"] : null,
    ].filter(Boolean);
  }
  function paintTypes() {
    const types = offered();
    if (!types.some((t) => t[0] === state.type) && types[0]) state.type = types[0][0];
    $("ltTypes").innerHTML = types.map(([id, label]) =>
      `<button type="button" role="tab" data-type="${id}" aria-selected="${id === state.type}">${label}</button>`).join("");
    const bt = state.st.bet_types;
    $("ltPermSize").innerHTML = bt.perm.map((k) => `<option value="${k}"${k === state.permSize ? " selected" : ""}>${k} per line</option>`).join("");
    if (!bt.perm.includes(state.permSize) && bt.perm[0]) state.permSize = bt.perm[0];
    const qp = state.type === "DIRECT" ? bt.direct : state.type === "PERM" ? [state.permSize + 1, state.permSize + 2, state.permSize + 3].filter((n) => n <= 15) : [1, 2, 3, 4];
    const cur = Number($("ltQpCount").value) || qp[Math.min(1, qp.length - 1)];
    $("ltQpCount").innerHTML = qp.map((n) => `<option value="${n}"${n === cur ? " selected" : ""}>${n}</option>`).join("");
    $("ltPermSizeWrap").hidden = state.type !== "PERM";
    $("ltAllWrap").hidden = state.type !== "BANKER";
    $("ltPickTitle").textContent = state.type === "DIRECT" ? "Pick 1 to 5 numbers" : state.type === "PERM" ? `Pick ${state.permSize + 1} to 15 numbers` : "Pick a banker, then partners";
    $("ltHint").textContent = state.type === "DIRECT"
      ? "One line: every number you pick must be among the winning numbers."
      : state.type === "PERM"
        ? `Every combination of ${state.permSize} of your numbers is its own line. Each line that's fully among the winning numbers pays.`
        : "Tap your banker first (red), then its partners. Each line is the banker with one partner; it pays when both are winning numbers.";
  }
  $("ltTypes").addEventListener("click", (e) => {
    const b = e.target.closest("[data-type]");
    if (!b || b.dataset.type === state.type) return;
    state.type = b.dataset.type;
    clearPicks();
    paintTypes();
  });
  $("ltPermSize").addEventListener("change", () => { state.permSize = Number($("ltPermSize").value); paintTypes(); paintPicks(); });
  $("ltAgainstAll").addEventListener("change", () => { state.againstAll = $("ltAgainstAll").checked; if (state.againstAll) state.picks = []; paintPicks(); });

  const maxPicks = () => state.type === "DIRECT" ? Math.max(...state.st.bet_types.direct, 1) : state.type === "PERM" ? 15 : 89;
  function clearPicks() { state.picks = []; state.banker = null; state.againstAll = false; $("ltAgainstAll").checked = false; paintPicks(); }

  function shape() {
    const picks = state.picks.slice().sort((a, b) => a - b);
    if (state.type === "BANKER") {
      const partners = state.againstAll ? 89 : picks.length;
      return { label: "Banker", size: 2, lines: state.banker ? partners : 0, best: Math.min(partners, DRAWN - 1), ok: !!state.banker && partners > 0, picks };
    }
    if (state.type === "PERM") {
      const ok = picks.length > state.permSize;
      return { label: `Perm ${state.permSize}`, size: state.permSize, lines: ok ? choose(picks.length, state.permSize) : 0,
        best: ok ? choose(Math.min(picks.length, DRAWN), state.permSize) : 0, ok, picks };
    }
    const k = picks.length;
    return { label: k ? `Direct-${k}` : "Direct", size: k, lines: k ? 1 : 0, best: 1, ok: k > 0 && state.st.bet_types.direct.includes(k), picks };
  }

  function paintPicks() {
    const full = state.type !== "BANKER" && state.picks.length >= maxPicks();
    board.querySelectorAll(".lt-num").forEach((b) => {
      const n = Number(b.dataset.n);
      const isBank = state.type === "BANKER" && state.banker === n;
      const on = state.picks.includes(n) || isBank;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.classList.toggle("is-banker", isBank);
      b.disabled = (full && !on) || (state.type === "BANKER" && state.againstAll && state.banker !== null && !isBank);
    });
    const s = shape();
    const balls = [];
    if (state.type === "BANKER" && state.banker) balls.push(`<span class="lt-ball is-banker" title="Banker">${state.banker}</span>`);
    if (state.type === "BANKER" && state.againstAll) balls.push('<span class="lt-all-tag">+ all 89 numbers</span>');
    else s.picks.forEach((n) => balls.push(`<span class="lt-ball">${n}</span>`));
    $("ltPicked").innerHTML = balls.length ? balls.join("") : '<span class="lt-empty">Tap numbers on the board</span>';
    paintSlip();
  }

  function paintSlip() {
    const st = state.st;
    if (!st) return;
    const s = shape();
    const mult = s.size ? st.multipliers[s.size] : null;
    const unit = Number($("ltStake").value) || 0;
    const cost = Math.round(unit * s.lines * 100) / 100;
    const pot = mult && s.ok ? Math.min(Math.round(unit * mult * s.best * 100) / 100, st.max_win) : 0;
    $("ltType").textContent = s.ok || s.picks.length || state.banker ? s.label : "—";
    $("ltLines").textContent = s.lines ? String(s.lines) : "—";
    $("ltMult").textContent = mult ? xFmt(mult) : "—";
    $("ltStakeLabel").textContent = s.lines > 1 ? "Stake per line (GHS)" : "Stake (GHS)";
    $("ltCost").textContent = ghs(cost);
    $("ltPotential").textContent = ghs(pot);
    const d = draw();
    const open = d && d.status === "OPEN" && !d.paused;
    const blocked = !st.real_money || !open;
    const tooMuch = cost > st.max_bet || s.lines > st.max_lines;
    $("ltBuy").disabled = !s.ok || blocked || unit <= 0 || tooMuch || state.buying;
    $("ltBuy").textContent = !st.real_money ? "Ticket sales open soon" : !open ? (d && d.paused ? "Draw paused" : "Betting closed")
      : tooMuch ? (s.lines > st.max_lines ? `Max ${st.max_lines} lines` : `Max ${ghs(st.max_bet)} per ticket`)
      : state.buying ? "Buying…" : s.ok ? `Review ticket · ${ghs(cost)}` : "Review ticket";
  }

  board.addEventListener("click", (e) => {
    const b = e.target.closest(".lt-num");
    if (!b || b.disabled) return;
    const n = Number(b.dataset.n);
    if (state.type === "BANKER") {
      if (state.banker === n) state.banker = null;
      else if (!state.banker) { state.banker = n; state.picks = state.picks.filter((x) => x !== n); }
      else if (!state.againstAll) state.picks = state.picks.includes(n) ? state.picks.filter((x) => x !== n) : state.picks.concat(n);
    } else {
      state.picks = state.picks.includes(n) ? state.picks.filter((x) => x !== n) : state.picks.concat(n);
    }
    paintPicks();
  });
  $("ltClear").addEventListener("click", clearPicks);
  $("ltQuick").addEventListener("click", () => {
    const k = Number($("ltQpCount").value) || 2;
    const pool = Array.from({ length: 90 }, (_, i) => i + 1);
    const take = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return pool.splice(a[0] % pool.length, 1)[0]; };
    clearPicks();
    if (state.type === "BANKER") state.banker = take();
    for (let i = 0; i < k; i++) state.picks.push(take());
    paintPicks();
  });

  /* stake */
  const stakeIn = $("ltStake");
  const clampStake = () => {
    const st = state.st;
    let v = Math.round((Number(stakeIn.value) || 0) * 100) / 100;
    if (st) v = Math.min(Math.max(v, st.min_bet), st.max_bet);
    stakeIn.value = String(v);
    paintSlip();
  };
  stakeIn.addEventListener("input", paintSlip);
  stakeIn.addEventListener("change", clampStake);
  document.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
    stakeIn.value = String(Math.max(0, (Number(stakeIn.value) || 0) + Number(b.dataset.step)));
    clampStake();
  }));
  document.querySelectorAll("[data-chip]").forEach((b) => b.addEventListener("click", () => { stakeIn.value = b.dataset.chip; clampStake(); }));

  /* ---------------- the draws ---------------- */
  function paintDrawTabs() {
    const ds = state.st.draws;
    $("ltDrawTabs").hidden = ds.length < 2;
    $("ltDrawTabs").innerHTML = ds.map((d) =>
      `<button type="button" role="tab" data-draw="${d.id}" aria-selected="${d.id === (draw() && draw().id)}"><b>${esc(d.name)}</b><small>${esc(when(d.draw_at))}</small></button>`).join("");
  }
  $("ltDrawTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-draw]");
    if (!b) return;
    state.drawId = Number(b.dataset.draw);
    paintDraw();
  });

  function paintDraw() {
    const st = state.st;
    if (!st) return;
    const d = draw();
    paintDrawTabs();
    const badge = $("ltStatus");
    if (!d) {
      badge.className = "lt-badge is-drawing";
      badge.textContent = "No draw open";
      $("ltDrawTitle").textContent = "WIN B Lotto";
      $("ltDrawWhen").textContent = st.upcoming && st.upcoming[0] ? "Next: " + st.upcoming[0].name + " opens " + when(st.upcoming[0].opens_at) : "";
      $("ltCountLabel").textContent = "The next draw opens soon";
      $("ltCount").textContent = "—";
      $("ltHashRow").hidden = true;
    } else {
      badge.className = "lt-badge" + (d.paused ? " is-drawing" : "");
      badge.textContent = d.paused ? "Paused" : "Betting open";
      $("ltDrawTitle").textContent = d.name;
      $("ltDrawWhen").textContent = "Draw " + when(d.draw_at);
      $("ltHashRow").hidden = !d.hash;
      if (d.hash) { $("ltHash").textContent = d.hash.slice(0, 16) + "…" + d.hash.slice(-8); $("ltHash").title = d.hash; }
    }
    $("ltSalesClosed").hidden = st.real_money;
    $("ltLimits").textContent = `Stake from ${ghs(st.min_bet)} per line · up to ${ghs(st.max_bet)} and ${st.max_lines} lines per ticket · top win ${ghs(st.max_win)} per ticket`;
    stakeIn.min = String(st.min_bet);
    $("ltPayouts").innerHTML = [1, 2, 3, 4, 5].map((k) =>
      `<tr><td>${k} number${k > 1 ? "s" : ""}${st.bet_types.direct.includes(k) ? "" : ' <small class="lt-off">(Perm only)</small>'}</td><td>${xFmt(st.multipliers[k])}</td><td>1 in ${Math.round(1 / chance(k)).toLocaleString("en-GH")}</td></tr>`).join("");
    $("ltPayFoot").textContent = "*The chance a line wins: the 5 numbers are drawn at random from 1 to 90 by the server.";
    paintTypes();
    paintResults();
    paintRules();
    paintPicks();
    tick();
  }

  function tick() {
    const st = state.st;
    const d = draw();
    if (!st || !d) return;
    const now = Date.now() + state.offset;
    const ms = Math.max(0, new Date(d.closes_at).getTime() - now);
    const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3), s = Math.floor((ms % 60e3) / 1000);
    $("ltCountLabel").textContent = "Betting closes in";
    $("ltCount").textContent = (h >= 24 ? Math.floor(h / 24) + "d " : "") + [h % 24, m, s].map((v) => String(v).padStart(2, "0")).join(":");
    if (ms === 0 && !state.reloading) {
      state.reloading = true;
      setTimeout(() => load().finally(() => { state.reloading = false; }), 1500);
    }
  }

  async function load() {
    const r = await U.paymentApi(GAME + "/state");
    if (!r.ok || !r.data || !r.data.draws) { $("ltStatus").textContent = "Unavailable"; return; }
    const first = !state.st;
    state.st = r.data;
    state.offset = new Date(r.data.now).getTime() - Date.now();
    if (!state.st.draws.some((d) => d.id === state.drawId)) state.drawId = state.st.draws[0] ? state.st.draws[0].id : null;
    paintDraw();
  }

  /* ---------------- rules ---------------- */
  function paintRules() {
    const st = state.st;
    $("ltRulesBody").innerHTML =
      `<ol>
        <li>Choose a draw, a bet type and your numbers from 1 to 90, set your stake and tap <b>Review ticket</b>. Check it and tap <b>Confirm &amp; buy</b>: the whole cost is taken from your balance once and you get a ticket code.</li>
        <li><b>Direct</b> — one line of 1 to 5 numbers. It wins when every number on it is a winning number.</li>
        <li><b>Perm</b> — every combination of 2, 3… of your numbers is its own line (5 numbers in Perm 2 is 10 lines). You pay the stake for each line; each line that's fully among the winning numbers pays.</li>
        <li><b>Banker</b> — a banker number plus partner numbers (or all 89 others). Each line is the banker with one partner and pays like a 2-number line when both are winning numbers.</li>
        <li>Betting closes at the time shown. Then <b>5 winning numbers</b> are drawn at random from 1 to 90 and published. Winning tickets are paid to your balance automatically and can be withdrawn.</li>
        <li>A ticket's total win is capped at ${ghs(st.max_win)}. If a draw is cancelled, every ticket is refunded in full.</li>
      </ol>
      <p><b>Fairness:</b> the numbers are drawn by the server from a secret seed made when the draw opens. Nobody chooses them. The seed's fingerprint is shown while you play; after the results the seed is published so anyone can check it gives those numbers.</p>`;
  }
  const openRules = () => $("ltRules").showModal();
  $("ltRulesBtn").addEventListener("click", openRules);
  $("ltRulesLink").addEventListener("click", openRules);

  /* ---------------- results and my tickets ---------------- */
  function ballsHtml(ns, cls, animate) {
    return ns.map((n, i) => `<span class="lt-ball ${cls}${animate ? " lt-pop" : ""}" style="${animate ? `animation-delay:${i * 0.28}s` : ""}">${n}</span>`).join("");
  }
  function paintResults() {
    const list = (state.st && state.st.results) || [];
    $("ltResults").innerHTML = list.length ? list.map((d, i) => {
      const first = i === 0 && d.numbers;
      const animate = first && !state.revealed[d.id];
      if (animate) state.revealed[d.id] = true;
      const balls = d.numbers ? ballsHtml(d.numbers, "is-drawn", animate)
        : `<span class="lt-empty">${d.status === "CANCELLED" ? "Cancelled — every ticket refunded" : "Results coming soon"}</span>`;
      const proof = d.seed ? `<div class="lt-hash">Seed <code>${esc(d.seed)}</code></div>` : "";
      return `<div class="lt-row${first ? " lt-row-latest" : ""}"><div class="lt-row-top"><span><b>${esc(d.name)}</b> · ${esc(when(d.draw_at))}</span><span>Draw #${d.id}</span></div>
        <div class="lt-row-balls">${balls}</div>${proof}</div>`;
    }).join("") : '<p class="lt-none">No results yet — the first draw is coming up.</p>';
  }

  const ST_LABEL = { ACTIVE: "Waiting for results", WON: "Won", LOST: "Lost", REFUNDED: "Refunded" };
  function ticketHtml(t) {
    const drawn = t.numbers || null;
    const ball = (n, extra) => `<span class="lt-ball sm${extra || ""}${drawn ? (drawn.includes(n) ? " is-drawn" : " is-miss") : ""}">${n}</span>`;
    const balls = (t.banker ? ball(t.banker, " is-banker") : "") +
      (t.bet_type === "BANKER" && t.picks.length >= 89 ? '<span class="lt-all-tag">+ all 89</span>' : t.picks.map((n) => ball(n)).join(""));
    const cls = t.status.toLowerCase();
    const money = t.status === "WON" ? `+${ghs(t.payout)}` : t.status === "ACTIVE" ? `up to ${ghs(t.potential)}` : t.status === "REFUNDED" ? `${ghs(t.stake)} back` : "";
    const lines = t.lines > 1 ? ` · ${t.lines} lines × ${ghs(t.unit_stake)}` : "";
    return `<div class="lt-ticket ${cls}">
      <div class="lt-ticket-head"><span class="lt-ticket-code">${esc(t.code)}</span><span class="lt-st ${cls}">${ST_LABEL[t.status] || t.status}</span></div>
      <div class="lt-ticket-draw">${esc(t.draw_name || "Draw #" + t.draw_id)} · ${esc(when(t.draw_at))}</div>
      <div class="lt-row-balls">${balls}</div>
      <div class="lt-ticket-foot"><span>${esc(t.bet)} · ${xFmt(t.multiplier)}${lines}</span><span>Stake ${ghs(t.stake)}</span></div>
      ${money ? `<div class="lt-ticket-money ${cls}">${money}${t.winning_lines > 1 ? ` (${t.winning_lines} winning lines)` : ""}</div>` : ""}
    </div>`;
  }
  function paintMine() {
    const box = $("ltMine");
    if (!U.session.get()) {
      box.innerHTML = '<p class="lt-none"><a href="register.html#login">Log in</a> to buy tickets and see them here.</p>';
      $("ltSummary").hidden = true;
      return;
    }
    const s = state.summary;
    $("ltSummary").hidden = !s || !s.tickets;
    if (s) $("ltSummary").innerHTML = `${s.tickets} ticket${s.tickets === 1 ? "" : "s"} · ${s.pending} pending · ${s.won} won · <b>${ghs(s.won_total)}</b> in winnings`;
    box.innerHTML = state.mine.length ? state.mine.map(ticketHtml).join("")
      : `<p class="lt-none">${state.filter === "all" ? "No tickets yet. Pick your numbers above." : "No tickets here."}</p>`;
  }
  async function loadMine() {
    if (!U.session.get()) { paintMine(); return; }
    const r = await U.paymentApi(GAME + "/tickets?status=" + state.filter);
    if (r.ok && r.data && Array.isArray(r.data.tickets)) { state.mine = r.data.tickets; state.summary = r.data.summary; }
    paintMine();
  }
  $("ltMineFilter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]");
    if (!b) return;
    state.filter = b.dataset.f;
    $("ltMineFilter").querySelectorAll("[data-f]").forEach((x) => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    loadMine();
  });
  document.querySelectorAll("[data-lt-tab]").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("[data-lt-tab]").forEach((x) => x.setAttribute("aria-selected", x === b ? "true" : "false"));
    $("ltMineWrap").hidden = b.dataset.ltTab !== "mine";
    $("ltResults").hidden = b.dataset.ltTab !== "results";
    if (b.dataset.ltTab === "results") { state.revealed = {}; paintResults(); }
  }));

  /* ---------------- review, confirm, buy ---------------- */
  function ticketBody() {
    const s = shape();
    const d = draw();
    const unit = Number(stakeIn.value) || 0;
    const mult = state.st.multipliers[s.size];
    const balls = (state.banker && state.type === "BANKER" ? `<span class="lt-ball is-banker">${state.banker}</span>` : "") +
      (state.type === "BANKER" && state.againstAll ? '<span class="lt-all-tag">+ all 89</span>' : s.picks.map((n) => `<span class="lt-ball">${n}</span>`).join(""));
    return `<div class="lt-ticket lt-ticket-big">
      <div class="lt-ticket-head"><span class="lt-ticket-brand">WIN B LOTTO</span><span>${esc(s.label)}</span></div>
      <div class="lt-ticket-draw">${esc(d.name)} · ${esc(when(d.draw_at))}</div>
      <div class="lt-row-balls">${balls}</div>
      <dl class="lt-slip-rows">
        <div><dt>Lines</dt><dd>${s.lines}</dd></div>
        <div><dt>Stake${s.lines > 1 ? " per line" : ""}</dt><dd>${ghs(unit)}</dd></div>
        <div><dt>Pays per winning line</dt><dd>${xFmt(mult)}</dd></div>
        <div><dt>Ticket cost</dt><dd>${ghs(unit * s.lines)}</dd></div>
        <div><dt>Potential win</dt><dd class="lt-win">${ghs(Math.min(unit * mult * s.best, state.st.max_win))}</dd></div>
      </dl>
    </div>`;
  }
  $("ltBuy").addEventListener("click", () => {
    if (!U.session.get()) { U.toast("Log in to buy a lotto ticket."); location.href = "register.html#login"; return; }
    clampStake();
    if ($("ltBuy").disabled) return;
    $("ltConfirmBody").innerHTML = ticketBody();
    $("ltConfirm").showModal();
  });
  $("ltConfirmBack").addEventListener("click", () => $("ltConfirm").close());
  $("ltConfirmBuy").addEventListener("click", async () => {
    if (state.buying) return;
    const s = shape();
    state.buying = true;
    $("ltConfirmBuy").disabled = true;
    paintSlip();
    const body = {
      bet_type: state.type, size: s.size, picks: state.type === "BANKER" && state.againstAll ? [] : s.picks, stake: Number(stakeIn.value),
      draw_id: draw() && draw().id,
      idempotency_key: "lotto:" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2)),
    };
    if (state.type === "BANKER") { body.banker = state.banker; body.against_all = state.againstAll; }
    const r = await U.paymentApi(GAME + "/ticket", { body });
    state.buying = false;
    $("ltConfirmBuy").disabled = false;
    $("ltConfirm").close();
    if (r.ok && r.data && r.data.ticket) {
      U.wallet.setBalance(r.data.balance);
      const t = Object.assign({}, r.data.ticket, { draw_name: draw() && draw().name, draw_at: draw() && draw().draw_at });
      $("ltIssuedBody").innerHTML = `<p class="lt-sub">Your stake of <b>${ghs(t.stake)}</b> has been taken from your balance. Good luck!</p>` + ticketHtml(t);
      $("ltIssued").showModal();
      clearPicks();
      state.filter = "all";
      $("ltMineFilter").querySelectorAll("[data-f]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.f === "all" ? "true" : "false"));
      document.querySelector('[data-lt-tab="mine"]').click();
      await loadMine();
    } else {
      const err = r.data && r.data.error;
      U.toast((r.data && (r.data.message || r.data.error)) || "Couldn't buy the ticket — try again.", "error");
      if (err === "too_late" || err === "draw_paused" || err === "sales_closed") load();
      paintSlip();
    }
  });

  /* ---------------- start ---------------- */
  load();
  loadMine();
  U.refreshBalance();
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden && !document.querySelector("dialog[open]")) { load(); loadMine(); } }, 30000);
})();
