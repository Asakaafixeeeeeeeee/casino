/* Ghana admin dashboard (regional.html). Signs in with a username and a 6-digit PIN against /api/regional and keeps
   that sign-in in this tab only (sessionStorage), apart from any player sign-in. Everything shown comes from the
   regional API, which answers for Ghana's players only — the region is fixed by the account on the server, so nothing
   on this page can widen it. */
(function () {
  "use strict";
  const API = window.VB_PAYMENT_API ||
    (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://localhost:8781" : "https://asakaa-balance.onrender.com");
  const KEY = "rendowin.regional.session";
  const REFRESH_MS = 60000;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => (n < 0 ? "−" : "") + "GHS " + Math.abs(Number(n) || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  /* ---------------- the sign-in, this tab only ---------------- */
  const session = {
    get() {
      try {
        const s = JSON.parse(sessionStorage.getItem(KEY) || "null");
        return s && s.token && Date.parse(s.expires_at) > Date.now() ? s : null;
      } catch (e) {
        return null;
      }
    },
    set(s) { try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* storage blocked: this page load only */ } memo = s; },
    clear() { try { sessionStorage.removeItem(KEY); } catch (e) { /* nothing stored */ } memo = null; }
  };
  let memo = null;
  const current = () => session.get() || memo;

  async function api(path, body) {
    const s = current();
    const headers = { "Content-Type": "application/json" };
    if (s) headers.Authorization = "Bearer " + s.token;
    let res;
    try {
      res = await fetch(API + "/api/regional" + path, {
        method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store"
      });
    } catch (e) {
      return { ok: false, status: 0, data: { message: "Can't reach the server. Check your connection and try again." } };
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty answer */ }
    if (res.status === 401 && path !== "/login") {
      session.clear();
      showLogin("Your sign-in has ended. Please sign in again.");
    }
    return { ok: res.ok, status: res.status, data };
  }

  /* ---------------- sign in / out ---------------- */
  const say = (kind, text) => ($("rgMsg").innerHTML = text ? '<div class="alert alert-' + kind + '">' + esc(text) + "</div>" : "");

  function showLogin(message) {
    stopRefresh();
    $("rgDash").hidden = true;
    $("rgLogout").hidden = true;
    $("rgLogin").hidden = false;
    say(message ? "info" : "", message || "");
    $("rgPin").value = "";
    ($("rgUser").value ? $("rgPin") : $("rgUser")).focus();
  }

  $("rgPin").addEventListener("input", () => {
    const digits = $("rgPin").value.replace(/\D/g, "").slice(0, 6);
    if ($("rgPin").value !== digits) $("rgPin").value = digits;
  });

  $("rgForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("rgUser").value.trim();
    const pin = $("rgPin").value.trim();
    if (!username) return say("err", "Enter your username.");
    if (!/^\d{6}$/.test(pin)) return say("err", "Your PIN is 6 digits.");
    const btn = $("rgSubmit");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    const r = await api("/login", { username, pin });
    btn.disabled = false;
    btn.textContent = "Sign in";
    if (!r.ok) {
      $("rgPin").value = "";
      $("rgPin").focus();
      return say("err", r.data.message || "Couldn't sign in. Try again.");
    }
    session.set({ token: r.data.token, expires_at: r.data.expires_at, admin: r.data.admin });
    say("", "");
    showDash();
  });

  $("rgLogout").addEventListener("click", async () => {
    await api("/logout", {});
    session.clear();
    state.rows = [];
    showLogin("You've signed out.");
  });

  /* ---------------- the dashboard ---------------- */
  const state = { status: "all", kind: "all", rows: [], next: null, counts: null, loading: false };
  const STATUSES = [["all", "All"], ["successful", "Successful"], ["pending", "Pending"], ["failed", "Failed"]];
  const KINDS = [["all", "All payments"], ["deposit", "Deposits"], ["withdrawal", "Withdrawals"]];
  const TONE = { successful: "ok", pending: "warn", failed: "bad" };
  const LABEL = { successful: "Successful", pending: "Pending", failed: "Failed" };

  function showDash() {
    const s = current();
    $("rgLogin").hidden = true;
    $("rgDash").hidden = false;
    $("rgLogout").hidden = false;
    const a = (s && s.admin) || {};
    $("rgWho").innerHTML = "Signed in as <b>" + esc(a.name || a.username || "Ghana admin") + "</b>";
    load();
    startRefresh();
  }

  const kpi = (label, value, sub, extra) =>
    '<div class="adm-kpi' + (extra || "") + '"><span>' + label + "</span><strong" + (String(value).startsWith("−") ? ' class="neg"' : "") + ">" +
    value + "</strong>" + (sub ? "<small>" + sub + "</small>" : "") + "</div>";

  function paintSummary(s) {
    const r = s.revenue;
    $("rgKpis").innerHTML =
      kpi("Ghana revenue · all time", money(r.all_time), "bets − wins, every Ghana player") +
      kpi("Ghana revenue · today", money(r.today), r.bets_today.toLocaleString("en-GH") + " bets since midnight") +
      kpi("10% of today's revenue", money(r.today_10pct), "of " + money(r.today), " share");
  }

  function chips(host, items, current, counts) {
    host.innerHTML = items.map(([v, label]) =>
      '<button type="button" class="chip' + (v === current ? " on" : "") + '" data-v="' + v + '" aria-pressed="' + (v === current) + '">' +
      esc(label) + (counts && counts[v] !== undefined ? "<b>" + counts[v].toLocaleString("en-GH") + "</b>" : "") + "</button>").join("");
  }

  /* the player's full name from sign-up; players who signed up before it was asked for show their username (e.g.
     abena99, or the Player482193 they were given), else their number */
  const nameOf = (u) => u.full_name || u.username || u.phone || "Player " + String(u.id).slice(0, 8);

  function row(t) {
    const out = t.kind === "withdrawal";
    /* data-label: on a phone each row becomes a card, and each value carries its column's name */
    return "<tr>" +
      '<td data-label="User name" class="rg-name"><b>' + esc(nameOf(t.user)) + "</b>" +
        (t.user.full_name && t.user.username ? "<small>" + esc(t.user.username) + "</small>" : "") +
        ((t.user.full_name || t.user.username) && t.user.phone ? "<small>" + esc(t.user.phone) + "</small>" : "") + "</td>" +
      '<td data-label="User ID" class="rg-uid">' + esc(t.user.id) + "</td>" +
      '<td data-label="Amount" class="rg-amount"><span class="rg-amt' + (out ? "" : " in") + '">' + (out ? "− " : "+ ") + money(t.amount) + "</span><small>" + (out ? "Withdrawal" : "Deposit") + "</small></td>" +
      '<td data-label="Payment method" class="rg-method">' + esc(t.method) + "</td>" +
      '<td data-label="Transaction ID" class="rg-ref">' + esc(t.transaction_id) + "</td>" +
      '<td data-label="Timestamp" class="rg-time">' + esc(when(t.at)) + "</td>" +
      '<td data-label="Status" class="rg-status"><span class="adm-pill ' + TONE[t.status] + '">' + LABEL[t.status] + "</span>" + (t.note ? "<small>" + esc(t.note) + "</small>" : "") + "</td></tr>";
  }

  function paintRows() {
    $("rgRows").innerHTML = state.rows.map(row).join("");
    $("rgEmpty").hidden = state.rows.length > 0;
    $("rgMore").hidden = !state.next;
    chips($("rgStatus"), STATUSES, state.status, state.counts);
    chips($("rgKind"), KINDS, state.kind);
  }

  const listPath = (before) => "/transactions?status=" + state.status + "&kind=" + state.kind + (before ? "&before=" + encodeURIComponent(before) : "");

  async function load() {
    if (state.loading) return;
    state.loading = true;
    const [sum, list] = await Promise.all([api("/summary"), api(listPath())]);
    state.loading = false;
    if (!current()) return;
    if (sum.ok) paintSummary(sum.data);
    if (list.ok) {
      state.rows = list.data.transactions;
      state.next = list.data.next;
      state.counts = list.data.counts;
      paintRows();
    } else if (list.status !== 401) {
      $("rgEmpty").hidden = false;
      $("rgEmpty").textContent = list.data.message || "Couldn't load the payments. Try again shortly.";
    }
  }

  $("rgMore").addEventListener("click", async () => {
    if (!state.next || state.loading) return;
    state.loading = true;
    $("rgMore").disabled = true;
    const r = await api(listPath(state.next));
    state.loading = false;
    $("rgMore").disabled = false;
    if (!r.ok) return;
    state.rows = state.rows.concat(r.data.transactions);
    state.next = r.data.next;
    paintRows();
  });

  [["rgStatus", "status"], ["rgKind", "kind"]].forEach(([id, key]) => {
    $(id).addEventListener("click", (e) => {
      const b = e.target.closest("[data-v]");
      if (!b || state[key] === b.dataset.v) return;
      state[key] = b.dataset.v;
      state.rows = [];
      state.next = null;
      paintRows();
      load();
    });
  });

  /* fresh numbers every minute while the page is open, unless older pages have been loaded */
  let timer = 0;
  function startRefresh() {
    stopRefresh();
    timer = setInterval(() => {
      if (!document.hidden && current() && state.rows.length <= 50) load();
    }, REFRESH_MS);
  }
  function stopRefresh() {
    clearInterval(timer);
    timer = 0;
  }

  if (current()) showDash();
  else showLogin();
})();
