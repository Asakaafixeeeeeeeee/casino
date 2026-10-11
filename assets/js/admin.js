/* Admin dashboard: the numbers, players, the money feed, games and studios, partners, withdrawals and
   support, grouped in a sections menu (a sidebar on a computer, a menu that slides in on a phone).
   Access is enforced by the balance service (every /api/admin route needs an ADMIN_PHONES account); this page only
   shows what the server allows. Each section keeps its own small state and redraws from it; sections switch without
   adding history entries, so the browser Back button leaves the dashboard instead of stepping through them. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);
  const esc = U.esc;
  const money = (n) => U.money(n);
  const api = (path, body) => U.paymentApi("/api/admin" + path, body ? { body } : {});
  const errText = (r, fallback) => esc((r.data && (r.data.message || r.data.error)) || fallback);
  const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");
  const ago = (iso) => {
    if (!iso) return "never";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + " min ago" : s < 86400 ? Math.floor(s / 3600) + " h ago" : Math.floor(s / 86400) + " d ago";
  };
  const pct = (x) => (x * 100).toFixed(1) + "%";
  const count = (n) => Number(n || 0).toLocaleString("en-GH");
  const newKey = () => "adm:" + crypto.randomUUID();
  const loading = '<div class="txr-loading">' + "<i></i>".repeat(3) + "</div>";
  const empty = (text, ico) => '<div class="me-empty"><span class="me-done-ico">' + U.icon(ico || "receipt") + "</span><p>" + text + "</p></div>";

  const state = { tab: "overview", me: null, timers: [] };

  /* ---------------- messages ---------------- */
  let msgTimer = 0;
  function flash(kind, html) {
    const box = $("msg");
    clearTimeout(msgTimer);
    box.innerHTML = html ? "<div class='alert alert-" + (kind === "error" ? "err" : kind) + "'>" + html + "</div>" : "";
    if (html && kind !== "error") msgTimer = setTimeout(() => (box.innerHTML = ""), 6000);
  }

  /* ---------------- dialogs and sheets ---------------- */
  /* a confirmation, optionally asking for some text; resolves with the text ("" when none asked), or null on cancel */
  function ask({ title, text, yes, danger, input, placeholder, required }) {
    return new Promise((resolve) => {
      const dlg = document.createElement("div");
      dlg.className = "me-dialog";
      dlg.setAttribute("role", "alertdialog");
      dlg.setAttribute("aria-modal", "true");
      dlg.innerHTML = '<div class="me-dialog-card"><h2>' + title + "</h2><p>" + text + "</p>" +
        (input ? '<label class="sr-only" for="admAsk">' + esc(placeholder || "Details") + '</label><textarea id="admAsk" class="me-textarea adm-reason" rows="2" maxlength="200" placeholder="' + esc(placeholder || "") + '"></textarea>' : "") +
        '<p class="adm-ask-err" hidden></p>' +
        '<div class="me-dialog-actions"><button class="btn btn-ghost btn-lg" type="button" data-no>Cancel</button>' +
        '<button class="btn ' + (danger ? "btn-danger" : "btn-primary") + ' btn-lg" type="button" data-yes>' + yes + "</button></div></div>";
      document.body.appendChild(dlg);
      const done = (v) => {
        dlg.remove();
        document.removeEventListener("keydown", onKey);
        resolve(v);
      };
      const onKey = (e) => { if (e.key === "Escape") done(null); };
      document.addEventListener("keydown", onKey);
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg || e.target.closest("[data-no]")) return done(null);
        if (!e.target.closest("[data-yes]")) return;
        const v = input ? dlg.querySelector("#admAsk").value.trim() : "";
        if (input && required && v.length < required) {
          const err = dlg.querySelector(".adm-ask-err");
          err.hidden = false;
          err.textContent = "Please write at least " + required + " characters.";
          return;
        }
        done(v);
      });
      (dlg.querySelector("#admAsk") || dlg.querySelector("[data-yes]")).focus();
    });
  }

  /* a bottom sheet for a player or a partner; redraw with sheet.set(html) */
  function sheet(title) {
    const el = document.createElement("div");
    el.className = "me-sheet adm-sheet";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", title);
    el.innerHTML = '<div class="me-sheet-panel adm-sheet-panel"><div class="me-sheet-grip"></div>' +
      '<div class="me-sheet-head"><h2>' + esc(title) + '</h2><button class="me-sheet-close" type="button" data-close aria-label="Close">' + U.icon("close") + "</button></div>" +
      '<div class="adm-sheet-body">' + loading + "</div></div>";
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    const opener = document.activeElement;
    const close = () => {
      el.classList.remove("show");
      document.removeEventListener("keydown", onKey);
      setTimeout(() => el.remove(), 220);
      if (opener && opener.focus) opener.focus();
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    el.addEventListener("click", (e) => { if (e.target === el || e.target.closest("[data-close]")) close(); });
    el.querySelector("[data-close]").focus();
    const body = el.querySelector(".adm-sheet-body");
    return { el, body, close, set: (html) => (body.innerHTML = html) };
  }

  /* ---------------- little building blocks ---------------- */
  const pill = (text, tone) => '<span class="adm-pill' + (tone ? " " + tone : "") + '">' + esc(text) + "</span>";
  const STATUS_TONE = { ACTIVE: "ok", SUSPENDED: "bad", CLOSED: "bad", PENDING: "warn", REJECTED: "bad", REQUESTED: "warn", PAID: "ok", VERIFIED: "ok", UNVERIFIED: "", PAYING: "warn", DECLINED: "bad", DISABLED: "bad", FAILED: "bad" };
  const statusPill = (s) => pill(s.charAt(0) + s.slice(1).toLowerCase(), STATUS_TONE[s]);
  const kpi = (label, value, sub, tone) =>
    '<div class="adm-kpi' + (tone ? " " + tone : "") + '"><span>' + label + "</span><strong>" + value + "</strong>" + (sub ? "<small>" + sub + "</small>" : "") + "</div>";
  const mini = (label, value, tone) => '<div class="adm-mini' + (tone ? " " + tone : "") + '"><span>' + label + "</span><b>" + value + "</b></div>";
  const chips = (name, items, current) =>
    '<div class="chip-list adm-chips" data-chips="' + name + '">' +
    items.map(([v, label]) => '<button type="button" class="chip' + (v === current ? " on" : "") + '" data-v="' + v + '" aria-pressed="' + (v === current) + '">' + label + "</button>").join("") + "</div>";
  const signed = (n, dir) => (dir === "CREDIT" ? "+ " : "− ") + money(n);
  const avatar = (name) => '<span class="adm-ava" aria-hidden="true">' + esc((name || "?").charAt(0).toUpperCase()) + "</span>";

  /* how a ledger movement reads in the feed */
  function moveLabel(t) {
    switch (t.type) {
      case "DEPOSIT": return "Deposit";
      case "WITHDRAWAL_REQUEST": return "Withdrawal";
      case "REVERSAL": return "Withdrawal returned";
      case "BET_VOID": return "Bet cancelled";
      case "ADJUSTMENT": return t.direction === "CREDIT" ? "Adjustment (credit)" : "Adjustment (debit)";
      default: return t.description || t.type;
    }
  }
  function moveRow(t, withUser, ownPhone) {
    const into = t.direction === "CREDIT";
    const own = withUser ? t.phone : ownPhone;
    return '<div class="txr-row adm-move' + (t.fresh ? " fresh" : "") + '"' + (withUser ? ' data-user="' + esc(t.user_id) + '" role="button" tabindex="0"' : "") + ">" +
      '<span class="txr-ico ' + (into ? "in" : "out") + '">' + U.icon(t.type === "DEPOSIT" ? "wallet" : t.type.startsWith("WITHDRAWAL") || t.type === "REVERSAL" ? "withdraw" : t.type === "ADJUSTMENT" ? "shield" : "play") + "</span>" +
      '<span class="txr-main"><strong>' + esc(moveLabel(t)) + "</strong>" +
      (withUser ? "<small>" + esc(t.full_name || t.username || "Player") + (t.phone ? " · " + esc(t.phone) : "") + "</small>" : "") +
      "<small>" + when(t.at) + (t.balance_after !== null && t.balance_after !== undefined ? " · balance " + money(t.balance_after) : "") + "</small>" +
      (t.type === "ADJUSTMENT" ? '<small class="txr-detail">' + esc(t.reason || "") + " — by " + esc(t.by || "") + "</small>" : "") +
      /* a deposit paid from a wallet that isn't the player's own number */
      (t.type === "DEPOSIT" && t.payer ? "<small>Paid from " + esc(t.payer) + (own && t.payer !== own ? " " + pill("another number", "warn") : "") + "</small>" : "") +
      "</span>" +
      '<span class="txr-end"><b class="' + (into ? "in" : "out") + '">' + signed(t.amount, t.direction) + "</b></span></div>";
  }

  /* ================= Overview ================= */
  const ov = { range: "today", data: null, waitingDeposits: 0 };
  const RANGES = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["all", "All time"]];
  const RANGE_NAME = { today: "today", "7d": "last 7 days", "30d": "last 30 days", all: "all time" };

  /* "Add money to a player", in a sheet opened from the section title: credit a player by their mobile number.
     Confirms who the number belongs to first, then goes through the same audited adjustment as a player's profile
     (capped, logged, posted to the ledger). */
  function openCredit() {
    const s = sheet("Add money to a player");
    s.set('<form data-form="credit" class="adm-credit-form" autocomplete="off">' +
        '<div class="field"><label for="crPhone">Player’s mobile number</label>' +
          '<input id="crPhone" type="tel" inputmode="numeric" maxlength="20" placeholder="024 123 4567" required></div>' +
        '<div class="field"><label for="crAmt">Amount to add (GHS)</label>' +
          '<input id="crAmt" type="number" step="0.01" min="0.01" inputmode="decimal" placeholder="e.g. 50" required></div>' +
        '<div class="field adm-credit-why"><label for="crWhy">Reason (goes in the ledger)</label>' +
          '<input id="crWhy" type="text" maxlength="200" minlength="8" placeholder="e.g. Goodwill credit for complaint #1042" required></div>' +
        '<button class="btn btn-primary" type="submit">Add money</button>' +
      "</form>" +
      '<div class="adm-sheet-msg" aria-live="polite"></div>' +
      '<p class="adm-credit-note">It finds the player by number and credits their balance as an adjustment — the same as from a player’s profile, recorded with your number and the reason.</p>' +
      '<p class="adm-credit-note adm-credit-warn"><b>Not for a deposit that hasn’t arrived.</b> A deposit is credited by itself the moment TheTeller confirms it (the player’s Deposit page and a background check keep asking), so adding it here too would pay it twice. You can’t add money to your own account.</p>');
    const form = s.body.querySelector("form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitCredit(form, s);
    });
    form.querySelector("#crPhone").focus();
  }

  async function submitCredit(form, s) {
    /* problems show in the sheet, where the admin is looking */
    const say = (html) => (s.body.querySelector(".adm-sheet-msg").innerHTML = html ? "<div class='alert alert-err'>" + html + "</div>" : "");
    say("");
    const phone = form.querySelector("#crPhone").value.trim();
    const amount = Number(form.querySelector("#crAmt").value);
    const reason = form.querySelector("#crWhy").value.trim();
    if (!phone || !(amount > 0) || reason.length < 8) {
      return say("Enter the player’s number, an amount to add, and a reason of at least 8 characters.");
    }
    const who = await api("/credit/lookup?phone=" + encodeURIComponent(phone));
    if (!who.ok) return say(errText(who, "Couldn’t find that player."));
    const p = who.data;
    const yes = await ask({
      title: "Add " + money(amount) + "?",
      text: "To <b>" + esc(p.full_name || p.username || "player") + "</b> (" + esc(p.phone || phone) + "). Balance " + money(p.balance) +
        " → " + money(p.balance + amount) + ". This goes in the ledger with your number and the reason.",
      yes: "Add money" });
    if (yes === null) return;
    /* one key per credit: resending the same credit after a lost answer can't pay it twice */
    const sig = [phone, amount, reason].join("|");
    if (form.dataset.sig !== sig || !form.dataset.key) { form.dataset.sig = sig; form.dataset.key = newKey(); }
    const r = await api("/credit", { phone, amount, reason, idempotency_key: form.dataset.key });
    if (!r.ok) return say(errText(r, "Couldn’t add the money."));
    s.close();
    flash("ok", "Added " + money(r.data.added) + " to " + esc(r.data.player.full_name || r.data.player.username || "the player") +
      " — balance now " + money(r.data.balance) + ".");
  }

  /* what's waiting for an admin, as cards that open the section that deals with it */
  function attention() {
    const w = (state.me && state.me.waiting) || {};
    const o = ov.data;
    const many = (n, one, more) => (n === 1 ? one : more);
    const card = (tone, ico, n, label, sub, go, view) =>
      '<button type="button" class="adm-attn-card' + (tone ? " " + tone : "") + '" data-go="' + go + '"' + (view ? ' data-view="' + view + '"' : "") + ">" +
      '<span class="adm-attn-ico">' + U.icon(ico) + "</span><b>" + count(n) + '</b><span class="adm-attn-t">' + label + "</span><small>" + sub + "</small></button>";
    const cards = [];
    if (o && o.integrity.unbackedDeposits) {
      const n = o.integrity.unbackedDeposits;
      cards.push(card("bad", "shield", n, many(n, "Deposit credit to check", "Deposit credits to check"),
        money(o.integrity.unbackedAmount) + " with no confirmed TheTeller payment behind " + many(n, "it", "them"), "money", "deposits"));
    }
    if (w.withdrawals) cards.push(card("warn", "withdraw", w.withdrawals, many(w.withdrawals, "Withdrawal to pay", "Withdrawals to pay"), "Pay or reject", "withdrawals"));
    if (w.support) cards.push(card("warn", "chat", w.support, many(w.support, "Chat to answer", "Chats to answer"), "Waiting for a reply", "support"));
    if (ov.waitingDeposits) cards.push(card("", "wallet", ov.waitingDeposits, many(ov.waitingDeposits, "Deposit waiting", "Deposits waiting"), "for TheTeller to confirm", "money", "deposits"));
    if (w.partners) cards.push(card("", "star", w.partners, many(w.partners, "Partner application", "Partner applications"), "Approve or reject", "partners", "PENDING"));
    if (w.partnerPayouts) cards.push(card("", "wallet", w.partnerPayouts, many(w.partnerPayouts, "Partner payout", "Partner payouts"), "Asked for by partners", "partners", "payouts"));
    return '<h3 class="adm-h">Needs your attention</h3>' + (cards.length
      ? '<div class="adm-attn">' + cards.join("") + "</div>"
      : '<p class="adm-allclear"><i aria-hidden="true">✓</i>Nothing is waiting for you right now.</p>');
  }

  async function loadOverview() {
    const panel = panelOf("overview");
    const figures = () => '<div class="adm-ov-bar"><h3 class="adm-h">Figures for</h3>' + chips("range", RANGES, ov.range) + "</div>";
    panel.innerHTML = '<div id="ovAttn">' + attention() + "</div>" + figures() + loading;
    const [r, waiting] = await Promise.all([api("/overview?range=" + ov.range), api("/deposits/waiting")]);
    if (state.tab !== "overview") return;
    /* deposits from the last day TheTeller hasn't answered for yet (older ones stay listed under Money) */
    if (waiting.ok) ov.waitingDeposits = waiting.data.filter((d) => d.status === "PENDING" && Date.now() - new Date(d.created_at).getTime() < 864e5).length;
    if (!r.ok) {
      panel.innerHTML = '<div id="ovAttn">' + attention() + "</div>" + figures();
      return flash("error", errText(r, "Couldn't load the overview."));
    }
    const o = (ov.data = r.data);
    const g = o.gaming;
    const m = o.money;
    const max = Math.max(1, ...o.series.map((s) => Math.max(s.deposits, Math.abs(s.ggr))));
    panel.innerHTML =
      '<div id="ovAttn">' + attention() + "</div>" + figures() +
      '<div class="adm-ov-groups">' +
        '<section class="wide"><h3 class="adm-h">Money</h3><div class="adm-kpis">' +
          kpi("Deposits", money(m.deposits), count(m.depositCount) + " deposits · " + count(m.firstDeposits) + " first-time", "in") +
          kpi("Withdrawals paid", money(m.withdrawalsPaid), count(m.withdrawalsPaidCount) + " paid") +
          kpi("Waiting to pay", money(m.withdrawalsPending), count(m.withdrawalsPendingCount) + " request" + (m.withdrawalsPendingCount === 1 ? "" : "s"), m.withdrawalsPendingCount ? "warn" : "") +
          kpi("Player balances", money(m.playerBalances), "what you owe players now") +
        "</div></section>" +
        '<section><h3 class="adm-h">Gaming</h3><div class="adm-kpis">' +
          kpi("Stakes", money(g.stakes), count(g.bets) + " bets") +
          kpi("GGR", money(g.ggr), "stakes − winnings · margin " + pct(g.margin), g.ggr >= 0 ? "in" : "bad") +
          kpi("In play", money(g.inPlay), "stakes not settled yet") +
        "</div></section>" +
        '<section><h3 class="adm-h">Players</h3><div class="adm-kpis">' +
          kpi("Players", count(o.players.total), "+" + count(o.players.new) + " new") +
          kpi("Active", count(o.players.active), "bet or deposited") +
          kpi("Playing now", count(o.players.playingNow), "bet in the last 5 min", o.players.playingNow ? "live" : "") +
        "</div></section>" +
      "</div>" +
      '<div class="adm-ov-split"><section>' +
      '<h3 class="adm-h">Last 14 days</h3><div class="adm-chart" role="img" aria-label="Daily deposits and GGR for the last 14 days">' +
        o.series.map((s) => '<div class="adm-bar-day" title="' + esc(s.day) + ": deposits " + money(s.deposits) + ", GGR " + money(s.ggr) + ", " + s.players + ' players">' +
          '<div class="adm-bars"><i class="dep" style="height:' + (s.deposits / max) * 100 + '%"></i><i class="ggr' + (s.ggr < 0 ? " neg" : "") + '" style="height:' + (Math.abs(s.ggr) / max) * 100 + '%"></i></div>' +
          "<span>" + new Date(s.day + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", timeZone: "UTC" }) + "</span></div>").join("") +
      '</div><p class="adm-legend"><i class="dep"></i>Deposits <i class="ggr"></i>GGR <i class="ggr neg"></i>Negative GGR (players won)</p></section>' +
      '<section><h3 class="adm-h">By game · ' + RANGE_NAME[ov.range] + "</h3>" +
      (o.games.length
        ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Game</th><th>Bets</th><th>Players</th><th>Stakes</th><th>GGR</th></tr></thead><tbody>' +
          o.games.map((x) => "<tr><td>" + esc(x.name) + "</td><td>" + count(x.bets) + "</td><td>" + count(x.players) + "</td><td>" + money(x.stakes) +
            '</td><td class="' + (x.ggr >= 0 ? "in" : "bad") + '">' + money(x.ggr) + "</td></tr>").join("") + "</tbody></table></div>"
        : empty("No real-money bets in this period.", "slots")) +
      "</section></div>";
  }

  /* ================= Players ================= */
  const pl = { q: "", status: "", kyc: "", offset: 0, users: [], total: 0, timer: 0 };
  function playersShell() {
    const panel = panelOf("players");
    if (panel.querySelector("#plQ")) return;
    panel.innerHTML =
      '<div class="adm-toolbar"><label class="searchbar adm-search">' + U.icon("search") +
        '<input id="plQ" type="search" placeholder="Name, phone number or player id" autocomplete="off" aria-label="Search players"></label>' +
        '<select class="select" id="plStatus" aria-label="Account status"><option value="">Any status</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option></select>' +
        '<select class="select" id="plKyc" aria-label="KYC"><option value="">Any KYC</option><option value="UNVERIFIED">Unverified</option><option value="PENDING">KYC pending</option><option value="VERIFIED">Verified</option><option value="REJECTED">KYC rejected</option></select></div>' +
      '<p class="txr-count" id="plCount"></p><div id="plList"></div>';
    $("plQ").addEventListener("input", () => {
      clearTimeout(pl.timer);
      pl.timer = setTimeout(() => { pl.q = $("plQ").value.trim(); loadPlayers(); }, 300);
    });
    $("plStatus").addEventListener("change", () => { pl.status = $("plStatus").value; loadPlayers(); });
    $("plKyc").addEventListener("change", () => { pl.kyc = $("plKyc").value; loadPlayers(); });
  }
  function playerRow(u) {
    return '<div class="txr-row adm-player" data-user="' + esc(u.id) + '" role="button" tabindex="0">' + avatar(u.full_name || u.username) +
      '<span class="txr-main"><strong>' + esc(u.full_name || u.username || "Player") + "</strong>" +
      "<small>" + (u.full_name && u.username ? esc(u.username) + " · " : "") + esc(u.phone || "number not seen yet") + "</small>" +
      "<small>Joined " + when(u.created_at) + " · seen " + ago(u.last_seen) + "</small></span>" +
      '<span class="txr-end"><b>' + money(u.balance) + "</b><span class='adm-pills'>" +
        (u.status !== "ACTIVE" ? statusPill(u.status) : "") + (u.kyc === "VERIFIED" ? pill("KYC ✓", "ok") : u.kyc === "PENDING" ? pill("KYC pending", "warn") : u.kyc === "REJECTED" ? pill("KYC ✗", "bad") : "") +
        (u.partner ? pill("Partner", u.partner === "ACTIVE" ? "brand" : "") : "") +
      "</span></span></div>";
  }
  async function loadPlayers(more) {
    playersShell();
    if (!more) {
      pl.offset = 0;
      pl.users = [];
      $("plList").innerHTML = loading;
    }
    const qs = new URLSearchParams({ q: pl.q, status: pl.status, kyc: pl.kyc, offset: String(pl.offset) });
    const r = await api("/users?" + qs);
    if (state.tab !== "players") return;
    if (!r.ok) return flash("error", errText(r, "Couldn't load players."));
    pl.users = pl.users.concat(r.data.users);
    pl.total = r.data.total;
    pl.offset = pl.users.length;
    $("plCount").textContent = count(pl.total) + " player" + (pl.total === 1 ? "" : "s");
    $("plList").innerHTML = pl.users.length
      ? '<div class="txr-group">' + pl.users.map(playerRow).join("") + "</div>" +
        (pl.users.length < pl.total ? '<button class="btn btn-ghost btn-block adm-more" type="button" data-more="players">Show more</button>' : "")
      : empty("No players match.", "user");
  }

  /* one player's sheet: profile, totals, actions, and history */
  async function openPlayer(id) {
    const s = sheet("Player");
    const draw = async () => {
      const r = await api("/users/" + encodeURIComponent(id));
      if (!r.ok) return s.set("<div class='alert alert-err'>" + errText(r, "Couldn't load this player.") + "</div>");
      const { profile: p, totals: t, transactions, bets, actions } = r.data;
      s.set(
        '<div class="adm-who">' + avatar(p.full_name || p.username) + "<div><strong>" + esc(p.full_name || p.username || "Player") + "</strong>" +
          "<small>" + (p.full_name && p.username ? esc(p.username) + " · " : "") +
          (p.phone ? '<a href="tel:' + esc(p.phone) + '">' + esc(p.phone) + "</a>" : "number not seen yet") + " · joined " + when(p.created_at) + "</small>" +
          '<small class="adm-id">' + esc(p.id) + "</small></div>" +
          '<div class="adm-who-bal"><span>Balance</span><b>' + money(p.balance) + "</b></div></div>" +
        '<div class="adm-pills adm-pills-row">' + statusPill(p.status) + pill("KYC " + p.kyc.toLowerCase(), STATUS_TONE[p.kyc]) +
          (p.partner ? pill("Partner " + p.partner.code + " · " + p.partner.status.toLowerCase(), "brand") : "") +
          (p.referredBy ? pill("Referred by " + (p.referredBy.username || p.referredBy.code), "") : "") +
          (p.excludedUntil ? pill("On a break until " + when(p.excludedUntil), "warn") : "") +
          pill("Seen " + ago(p.last_seen), "") + "</div>" +
        '<div class="adm-minis">' +
          mini("Deposited", money(t.deposited) + " <small>(" + count(t.deposits) + ")</small>", "in") +
          mini("Withdrawn", money(t.withdrawn)) +
          mini("Withdrawal waiting", money(t.withdrawPending), t.withdrawPending ? "warn" : "") +
          mini("Staked", money(t.staked) + " <small>(" + count(t.bets) + " bets)</small>") +
          mini("Won", money(t.won)) +
          mini("GGR from player", money(t.ggr), t.ggr >= 0 ? "in" : "bad") +
          mini("In play", money(t.inPlay)) +
          mini("Adjustments", money(t.adjustments)) +
        "</div>" +
        '<h3 class="me-sheet-sub">Account</h3><div class="adm-actions-box">' +
          (p.status === "ACTIVE"
            ? '<button class="btn btn-danger btn-sm" type="button" data-act="suspend">' + U.icon("shield") + "Suspend account</button>"
            : '<button class="btn btn-success btn-sm" type="button" data-act="reactivate">' + U.icon("shield") + "Reactivate account</button>") +
          '<div class="adm-inline"><select class="select" id="kycSel" aria-label="KYC status">' +
            ["UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"].map((k) => '<option value="' + k + '"' + (k === p.kyc ? " selected" : "") + ">KYC: " + k.charAt(0) + k.slice(1).toLowerCase() + "</option>").join("") +
          '</select><button class="btn btn-ghost btn-sm" type="button" data-act="kyc">Save KYC</button></div>' +
          (p.partner
            ? '<button class="btn btn-ghost btn-sm" type="button" data-act="partner">Open partner account</button>'
            : '<button class="btn btn-ghost btn-sm" type="button" data-act="make-partner">Make partner</button>') +
        "</div>" +
        '<h3 class="me-sheet-sub">Adjust balance</h3><form class="adm-adjust" data-act="adjust">' +
          '<div class="field"><label for="adjAmt">Amount (GHS) — negative to take money off</label><input id="adjAmt" type="number" step="0.01" inputmode="decimal" placeholder="e.g. 20 or -5" required></div>' +
          '<div class="field"><label for="adjWhy">Reason (goes in the ledger)</label><input id="adjWhy" type="text" maxlength="200" minlength="8" placeholder="e.g. Goodwill for a delayed payout" required></div>' +
          '<button class="btn btn-primary btn-sm" type="submit">Apply adjustment</button></form>' +
        '<h3 class="me-sheet-sub">Recent money</h3>' +
          (transactions.length ? '<div class="txr-group">' + transactions.map((x) => moveRow(x, false, p.phone)).join("") + "</div>" : '<p class="me-sheet-note">No money movements yet.</p>') +
        '<h3 class="me-sheet-sub">Recent bets</h3>' +
          (bets.length
            ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Game</th><th>Stake</th><th>Paid</th><th>When</th></tr></thead><tbody>' +
              bets.map((b) => "<tr><td>" + esc(b.name) + "</td><td>" + money(b.stake) + '</td><td class="' + (b.payout > 0 ? "in" : "") + '">' + (b.settled ? money(b.payout) : "in play") + "</td><td>" + when(b.at) + "</td></tr>").join("") +
              "</tbody></table></div>"
            : '<p class="me-sheet-note">No real-money bets yet.</p>') +
        '<h3 class="me-sheet-sub">Admin history</h3>' +
          (actions.length
            ? '<div class="adm-log">' + actions.map((a) => "<div><b>" + esc(a.action) + "</b> " + esc(JSON.stringify(a.details)) + "<small>" + esc(a.admin) + " · " + when(a.at) + "</small></div>").join("") + "</div>"
            : '<p class="me-sheet-note">Nothing yet.</p>'));
    };
    s.body.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-act]");
      if (!b) return;
      const act = b.dataset.act;
      if (act === "suspend") {
        const reason = await ask({ title: "Suspend this account?", text: "They can still log in, see their balance and finish a round in play, but can't bet, deposit or withdraw until you reactivate them.", yes: "Suspend", danger: true, input: true, placeholder: "Reason (kept in the admin history)", required: 4 });
        if (reason === null) return;
        const r = await api("/users/" + id + "/status", { status: "SUSPENDED", reason });
        flash(r.ok ? "ok" : "error", r.ok ? "Account suspended." : errText(r, "Couldn't suspend."));
      } else if (act === "reactivate") {
        const r = await api("/users/" + id + "/status", { status: "ACTIVE" });
        flash(r.ok ? "ok" : "error", r.ok ? "Account reactivated." : errText(r, "Couldn't reactivate."));
      } else if (act === "kyc") {
        const r = await api("/users/" + id + "/kyc", { kyc: s.body.querySelector("#kycSel").value });
        flash(r.ok ? "ok" : "error", r.ok ? "KYC status saved." : errText(r, "Couldn't save."));
      } else if (act === "make-partner") {
        const ok = await ask({ title: "Make this player a partner?", text: "They get a referral code and earn 5% of every deposit their players make. You can change the rate on their partner page.", yes: "Make partner" });
        if (ok === null) return;
        const r = await api("/partners/" + id, { status: "ACTIVE" });
        flash(r.ok ? "ok" : "error", r.ok ? "They're now a partner (code " + esc(r.data.code) + ")." : errText(r, "Couldn't make them a partner."));
      } else if (act === "partner") {
        s.close();
        return openPartner(id);
      }
      draw();
      if (state.tab === "players") loadPlayers();
    });
    s.body.addEventListener("submit", async (e) => {
      if (!e.target.matches("form[data-act=adjust]")) return;
      e.preventDefault();
      const amount = Number(s.body.querySelector("#adjAmt").value);
      const reason = s.body.querySelector("#adjWhy").value.trim();
      if (!amount || reason.length < 8) return flash("error", "Enter an amount and a reason of at least 8 characters.");
      const yes = await ask({ title: (amount > 0 ? "Credit " : "Take ") + money(Math.abs(amount)) + (amount > 0 ? "?" : " off?"),
        text: "This goes in the ledger as an adjustment, with your number and the reason.", yes: "Apply", danger: amount < 0 });
      if (yes === null) return;
      const r = await api("/users/" + id + "/adjust", { amount, reason, idempotency_key: newKey() });
      flash(r.ok ? "ok" : "error", r.ok ? "Adjusted — their balance is now " + money(r.data.balance) + "." : errText(r, "Couldn't adjust."));
      if (r.ok) draw();
    });
    draw();
  }

  /* ================= Money feed ================= */
  const mf = { type: "", q: "", rows: [], timer: 0, hasMore: false };
  const FEED = [["", "All"], ["deposits", "Deposits"], ["withdrawals", "Withdrawals"], ["bets", "Bets"], ["wins", "Wins"], ["adjustments", "Adjustments"]];
  function moneyShell() {
    const panel = panelOf("money");
    if (panel.querySelector("#mfQ")) return;
    panel.innerHTML = '<div class="adm-feed-head">' + chips("feed", FEED, mf.type) +
      '<span class="adm-live-dot" title="Updates every 10 seconds">Live</span></div>' +
      '<div class="adm-toolbar"><label class="searchbar adm-search">' + U.icon("search") +
      '<input id="mfQ" type="search" placeholder="Filter by player name or phone" autocomplete="off" aria-label="Filter by player"></label></div>' +
      '<div id="mfWaiting"></div><div id="mfList"></div>';
    /* a recheck asks TheTeller about one waiting deposit and settles it the player's own way: credited at most once */
    $("mfWaiting").addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-deprecheck]");
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      const r = await api("/deposits/" + encodeURIComponent(btn.dataset.deprecheck) + "/recheck", {});
      if (!r.ok) { btn.disabled = false; return flash("error", errText(r, "Couldn't recheck that deposit.")); }
      flash(r.data.status === "approved" ? "ok" : r.data.status === "declined" ? "error" : "info",
        r.data.status === "approved" ? "TheTeller confirmed it — the deposit is credited." :
        r.data.status === "declined" ? "TheTeller declined it" + (r.data.note ? ": " + esc(r.data.note) : ".") :
        "No final answer from TheTeller yet" + (r.data.note ? " (" + esc(r.data.note) + ")" : "") + ". Try again later.");
      loadMoney();
    });
    $("mfQ").addEventListener("input", () => {
      clearTimeout(mf.timer);
      mf.timer = setTimeout(() => { mf.q = $("mfQ").value.trim(); loadMoney(); }, 300);
    });
  }
  const feedQuery = (extra) => "/transactions?" + new URLSearchParams(Object.assign({ type: mf.type, q: mf.q }, extra));
  function drawMoney() {
    $("mfList").innerHTML = mf.rows.length
      ? '<div class="txr-group">' + mf.rows.map((t) => moveRow(t, true)).join("") + "</div>" +
        (mf.hasMore ? '<button class="btn btn-ghost btn-block adm-more" type="button" data-more="money">Older</button>' : "")
      : empty("Nothing here yet.", "receipt");
  }
  async function loadWaiting() {
    const r = await api("/deposits/waiting");
    if (!r.ok || state.tab !== "money") return;
    const rows = r.data;
    $("mfWaiting").innerHTML = rows.length
      ? '<section class="adm-waiting"><h3 class="adm-h">Deposits waiting for TheTeller (' + rows.length + ")</h3>" +
        '<p class="adm-note">Credited by themselves once TheTeller confirms. Recheck asks it now — never add these by hand.</p>' +
        '<div class="txr-group">' + rows.map((d) =>
          '<div class="txr-row adm-item"><span class="txr-ico out">' + U.icon("wallet") + "</span>" +
          '<span class="txr-main"><strong>' + esc(d.username || "Player") + (d.phone ? " · " + esc(d.phone) : "") + "</strong>" +
          "<small>Ref " + esc(d.reference || d.transaction_id) + " · " + when(d.created_at) + "</small>" +
          (d.note ? '<small class="txr-detail">' + esc(d.note) + "</small>" : "") + "</span>" +
          '<span class="txr-end"><b>' + money(d.amount) + "</b>" + statusPill(d.status) + "</span>" +
          '<span class="adm-item-actions"><button class="btn btn-ghost btn-sm" type="button" data-deprecheck="' + esc(d.transaction_id) + '">Recheck</button></span></div>').join("") +
        "</div></section>"
      : "";
  }
  async function loadMoney() {
    moneyShell();
    /* the filter can also be set from the overview's cards, after the chips were drawn */
    panelOf("money").querySelectorAll('[data-chips="feed"] [data-v]').forEach((c) => {
      c.classList.toggle("on", c.dataset.v === mf.type);
      c.setAttribute("aria-pressed", String(c.dataset.v === mf.type));
    });
    loadWaiting();
    $("mfList").innerHTML = loading;
    const r = await api(feedQuery({}));
    if (state.tab !== "money") return;
    if (!r.ok) return flash("error", errText(r, "Couldn't load the money feed."));
    mf.rows = r.data.transactions;
    mf.hasMore = r.data.transactions.length === 60; /* a full page: there may be older ones */
    drawMoney();
  }
  async function pollMoney() {
    if (state.tab !== "money" || document.hidden || !mf.rows) return;
    const newest = mf.rows.length ? mf.rows[0].id : 0;
    const r = await api(feedQuery(newest ? { after: String(newest) } : {}));
    if (!r.ok || !r.data.transactions.length || state.tab !== "money") return;
    r.data.transactions.forEach((t) => (t.fresh = true));
    mf.rows = r.data.transactions.concat(mf.rows.map((t) => Object.assign(t, { fresh: false })));
    drawMoney();
  }
  async function olderMoney() {
    const oldest = mf.rows[mf.rows.length - 1];
    const r = await api(feedQuery({ before: String(oldest.id) }));
    if (!r.ok) return flash("error", errText(r, "Couldn't load more."));
    mf.rows = mf.rows.concat(r.data.transactions);
    mf.hasMore = r.data.transactions.length === 60;
    drawMoney();
  }

  /* ================= Games & studios ================= */
  const gm = { range: "30d" };
  const toggle = (kind, id, on, label) =>
    '<label class="adm-switch"><input type="checkbox" data-kind="' + kind + '" data-id="' + esc(id) + '" data-label="' + esc(label) + '"' + (on ? " checked" : "") +
    ' aria-label="' + esc(label) + ' on or off"><span aria-hidden="true"></span></label>';
  async function loadGames() {
    const panel = panelOf("games");
    panel.innerHTML = chips("grange", [["7d", "7 days"], ["30d", "30 days"], ["all", "All time"]], gm.range) + loading;
    const r = await api("/catalog?range=" + gm.range);
    if (state.tab !== "games") return;
    if (!r.ok) return flash("error", errText(r, "Couldn't load the games."));
    const { providers, games } = r.data;
    panel.innerHTML = chips("grange", [["7d", "7 days"], ["30d", "30 days"], ["all", "All time"]], gm.range) +
      providers.map((p) => {
        const list = games.filter((g) => g.provider === p.id);
        return '<div class="adm-studio' + (p.enabled ? "" : " off") + '"><div class="adm-studio-head"><div><strong>' + esc(p.name) + "</strong><small>" +
          list.length + " games · " + (p.enabled ? "on" : "switched off") + "</small></div>" + toggle("provider", p.id, p.enabled, p.name) + "</div>" +
          '<div class="txr-group">' + list.map((g) => '<div class="txr-row adm-game' + (g.enabled && p.enabled ? "" : " off") + '">' +
            '<span class="txr-main"><strong>' + esc(g.name) + (g.enabled ? "" : " " + pill("Off", "bad")) + "</strong>" +
            "<small>" + count(g.bets) + " bets · " + count(g.players) + " players · stakes " + money(g.stakes) + ' · GGR <b class="' + (g.ggr >= 0 ? "in" : "bad") + '">' + money(g.ggr) + "</b></small></span>" +
            toggle("game", g.id, g.enabled, g.name) + "</div>").join("") + "</div></div>";
      }).join("");
  }

  /* ================= Partners ================= */
  const pt = { view: "PENDING" };
  const PVIEWS = [["PENDING", "Applications"], ["ACTIVE", "Active"], ["payouts", "Payout requests"], ["", "All"]];
  const terms = (p) => p.deposit_pct + "% of every deposit";
  const METHOD = { MOMO: "Mobile Money", BANK: "Bank transfer", CRYPTO: "Crypto" };
  const payTo = (p) => {
    const d = p.details || {};
    return p.method === "MOMO" ? esc(d.phone) + " · " + esc(d.name) :
      p.method === "BANK" ? esc(d.bank) + " · " + esc(d.account_number) + " · " + esc(d.account_name) :
      esc(d.asset) + " (" + esc(d.network) + ") · <span class='adm-addr'>" + esc(d.address) + "</span>";
  };
  async function loadPartners() {
    const panel = panelOf("partners");
    panel.innerHTML = chips("pview", PVIEWS, pt.view) + loading;
    const r = await api(pt.view === "payouts" ? "/partner-payouts?status=REQUESTED" : "/partners?status=" + pt.view);
    if (state.tab !== "partners") return;
    if (!r.ok) return flash("error", errText(r, "Couldn't load partners."));
    let html = chips("pview", PVIEWS, pt.view);
    if (pt.view === "payouts") {
      const list = r.data.payouts;
      html += list.length
        ? '<div class="txr-group">' + list.map((p) => '<div class="txr-row adm-item">' +
            '<span class="txr-ico out">' + U.icon("withdraw") + "</span>" +
            '<span class="txr-main"><strong>' + esc(p.username || "Partner") + " · " + esc(p.code) + "</strong>" +
            "<small>" + METHOD[p.method] + ": " + payTo(p) + "</small><small>Requested " + when(p.created_at) + "</small></span>" +
            '<span class="txr-end"><b class="out">' + money(p.amount) + "</b></span>" +
            '<span class="adm-item-actions">' +
            '<button class="btn btn-primary btn-sm" type="button" data-payout="' + esc(p.id) + '" data-do="pay" data-amount="' + p.amount + '">Mark paid</button>' +
            '<button class="btn btn-ghost btn-sm" type="button" data-payout="' + esc(p.id) + '" data-do="reject">Reject</button></span></div>').join("") + "</div>"
        : empty("No payout requests waiting.", "wallet");
    } else {
      const list = r.data.partners;
      html += list.length
        ? '<div class="txr-group">' + list.map((p) => '<div class="txr-row adm-player" data-partner="' + esc(p.user_id) + '" role="button" tabindex="0">' + avatar(p.username) +
            '<span class="txr-main"><strong>' + esc(p.username || "Player") + " · " + esc(p.code) + "</strong>" +
            "<small>" + esc(p.phone || "") + " · applied " + when(p.created_at) + "</small>" +
            '<small class="txr-detail">' + (p.status === "PENDING" ? "“" + esc(p.channel || "") + "”"
              : esc(terms(p)) + " · " + count(p.signups) + " players · deposits " + money(p.deposits) + " · earned " + money(p.earned) +
                " · paid " + money(p.paid) + " · available " + money(p.available)) + "</small></span>" +
            '<span class="txr-end">' + statusPill(p.status) + (p.payoutWaiting ? pill("Payout waiting", "warn") : "") + "</span></div>").join("") + "</div>"
        : empty(pt.view === "PENDING" ? "No applications waiting." : "No partners here yet.", "star");
    }
    panel.innerHTML = html;
  }

  async function openPartner(userId) {
    const s = sheet("Partner");
    const draw = async () => {
      const r = await api("/partners/" + encodeURIComponent(userId));
      if (!r.ok) return s.set("<div class='alert alert-err'>" + errText(r, "Couldn't load this partner.") + "</div>");
      const { partner: p, stats: st, referrals, payouts } = r.data;
      const c = st.commission;
      s.set(
        '<div class="adm-who">' + avatar(p.username) + "<div><strong>" + esc(p.username || "Player") + " · " + esc(p.code) + "</strong>" +
          "<small>" + esc(p.phone || "") + " · applied " + when(p.created_at) + "</small></div>" +
          '<div class="adm-who-bal"><span>Available</span><b>' + money(c.available) + "</b></div></div>" +
        '<div class="adm-pills adm-pills-row">' + statusPill(p.status) + (p.decided_by ? pill("by " + p.decided_by, "") : "") + "</div>" +
        (p.channel ? '<p class="me-sheet-note">Where they promote: <b>' + esc(p.channel) + "</b></p>" : "") +
        '<div class="adm-actions-box">' +
          (p.status !== "ACTIVE" ? '<button class="btn btn-success btn-sm" type="button" data-status="ACTIVE">' + (p.status === "PENDING" ? "Approve" : "Reactivate") + "</button>" : "") +
          (p.status === "PENDING" ? '<button class="btn btn-ghost btn-sm" type="button" data-status="REJECTED">Reject application</button>' : "") +
          (p.status === "ACTIVE" ? '<button class="btn btn-danger btn-sm" type="button" data-status="SUSPENDED">Suspend partner</button>' : "") +
        "</div>" +
        '<h3 class="me-sheet-sub">Commission rate</h3><form class="adm-terms" data-form="terms">' +
          '<div class="field"><label for="tPct">% of every deposit</label><input id="tPct" type="number" min="0" max="30" step="0.5" value="' + p.deposit_pct + '"></div>' +
          '<div class="field adm-wide"><label for="tNote">Note (admins only)</label><input id="tNote" type="text" maxlength="300" value="' + esc(p.note || "") + '"></div>' +
          '<button class="btn btn-primary btn-sm" type="submit">Save</button></form>' +
        '<p class="hint">The partner earns this percentage of every confirmed deposit their players make, from 0% to 30%. A new rate applies to all of their players\' deposits so far.</p>' +
        '<h3 class="me-sheet-sub">Commission</h3><div class="adm-minis">' +
          mini("Rate", c.pct + "% of deposits") +
          mini("Earned", money(c.earned) + " <small>(" + c.pct + "% of " + money(st.money.deposits) + ")</small>", "in") +
          mini("Paid", money(c.paid)) +
          mini("Waiting", money(c.pending), c.pending ? "warn" : "") +
          mini("Available", money(c.available)) +
        "</div>" +
        '<h3 class="me-sheet-sub">Their players\' money</h3><div class="adm-minis">' +
          mini("Deposits", money(st.money.deposits) + " <small>(" + money(st.money.deposits30) + " in 30 d)</small>", "in") +
          mini("Withdrawals paid", money(st.money.withdrawals)) +
          mini("Bets", money(st.money.stakes)) +
          mini("Wins", money(st.money.wins)) +
          mini("Kept by the house", money(st.money.stakes - st.money.wins) + " <small>(bets − wins)</small>", st.money.stakes - st.money.wins >= 0 ? "in" : "bad") +
        "</div>" +
        '<h3 class="me-sheet-sub">Traffic</h3><div class="adm-minis">' +
          mini("Clicks", count(st.clicks.total) + " <small>(" + count(st.clicks.last30) + " in 30 d)</small>") +
          mini("Sign-ups", count(st.signups.total) + " <small>(" + count(st.signups.last30) + " in 30 d)</small>") +
          mini("Active players", count(st.activePlayers)) +
          mini("Depositors", count(st.depositors)) +
        "</div>" +
        '<h3 class="me-sheet-sub">Payouts</h3>' +
          (payouts.length
            ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Amount</th><th>Method</th><th>Status</th><th>When</th></tr></thead><tbody>' +
              payouts.map((x) => "<tr><td>" + money(x.amount) + "</td><td>" + METHOD[x.method] + "</td><td>" + statusPill(x.status) + (x.note ? "<small> " + esc(x.note) + "</small>" : "") + "</td><td>" + when(x.created_at) + "</td></tr>").join("") +
              "</tbody></table></div>"
            : '<p class="me-sheet-note">No payouts yet.</p>') +
        '<h3 class="me-sheet-sub">Their players (' + referrals.length + ")</h3>" +
          (referrals.length
            ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Player</th><th>Joined</th><th>Deposits</th><th>Commission</th><th>Active</th></tr></thead><tbody>' +
              referrals.slice(0, 50).map((x) => "<tr><td>" + esc(x.player) + (x.sub_id ? " <small>" + esc(x.sub_id) + "</small>" : "") + "</td><td>" + when(x.joined) + "</td><td>" +
                (x.deposits ? money(x.deposits) : "—") + "</td><td>" + (x.commission ? money(x.commission) : "—") + "</td><td>" + (x.active ? "✓" : "—") + "</td></tr>").join("") +
              "</tbody></table></div>"
            : '<p class="me-sheet-note">No sign-ups yet.</p>'));
    };
    s.body.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-status]");
      if (!b) return;
      const status = b.dataset.status;
      if (status !== "ACTIVE") {
        const ok = await ask({ title: status === "REJECTED" ? "Reject this application?" : "Suspend this partner?",
          text: status === "REJECTED" ? "They won't get a working referral link." : "Their link stops counting and they can't request payouts until you reactivate them.",
          yes: status === "REJECTED" ? "Reject" : "Suspend", danger: true });
        if (ok === null) return;
      }
      const r = await api("/partners/" + userId, { status });
      flash(r.ok ? "ok" : "error", r.ok ? "Partner " + (status === "ACTIVE" ? "approved" : status.toLowerCase()) + "." : errText(r, "Couldn't update."));
      draw();
      refreshBadges();
      if (state.tab === "partners") loadPartners();
    });
    s.body.addEventListener("submit", async (e) => {
      if (!e.target.matches("form[data-form=terms]")) return;
      e.preventDefault();
      const v = (sel) => s.body.querySelector(sel).value;
      const r = await api("/partners/" + userId, { deposit_pct: Number(v("#tPct")), note: v("#tNote") });
      flash(r.ok ? "ok" : "error", r.ok ? "Rate saved." : errText(r, "Couldn't save the rate."));
      if (r.ok) draw();
    });
    draw();
  }

  /* ================= Withdrawals ================= */
  const wd = { status: "REQUESTED" };
  const NETWORK = (p) =>
    ["024", "025", "053", "054", "055", "059"].includes(p.slice(0, 3)) ? "MTN" :
    ["020", "050"].includes(p.slice(0, 3)) ? "Telecel" :
    ["026", "027", "056", "057"].includes(p.slice(0, 3)) ? "AirtelTigo" : "Not mobile money";
  function withdrawalRow(w) {
    const actions =
      w.status === "REQUESTED"
        ? '<button class="btn btn-primary btn-sm" type="button" data-pay="' + w.id + '">Approve</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-reject="' + w.id + '">Reject</button>'
        : w.status === "PAYING" ? '<button class="btn btn-ghost btn-sm" type="button" data-recheck="' + w.id + '">Recheck</button>' : "";
    return '<div class="txr-row adm-row adm-item">' +
      '<span class="txr-ico out">' + U.icon("withdraw") + "</span>" +
      '<span class="txr-main"><strong>' + esc(w.username || "Player") + " · " + esc(w.phone || "no number") + "</strong>" +
      "<small>" + NETWORK(w.phone || "") + " · requested " + when(w.created_at) + "</small>" +
      (w.transaction_id ? "<small>TheTeller ref " + esc(w.transaction_id) + "</small>" : "") +
      (w.gateway_note ? '<small class="txr-detail' + (w.status === "DECLINED" ? " bad" : "") + '">' + esc(w.gateway_note) + "</small>" : "") +
      (w.decided_by ? "<small>By " + esc(w.decided_by) + "</small>" : "") +
      "</span>" +
      '<span class="txr-end"><b class="out">' + money(w.amount) + "</b></span>" +
      (actions ? '<span class="adm-item-actions">' + actions + "</span>" : "") + "</div>";
  }
  async function loadWithdrawals() {
    const panel = panelOf("withdrawals");
    const head = chips("wstatus", [["REQUESTED", "Waiting"], ["PAID", "Approved"], ["DECLINED", "Rejected"]], wd.status) +
      "<div class='alert alert-info'>Withdrawals are paid by hand: send the money to the player yourself, then press <b>Approve</b> (it only changes the status). <b>Reject</b> returns the money to the player's balance.</div>";
    panel.innerHTML = head + loading;
    const r = await api("/withdrawals?status=" + wd.status);
    if (state.tab !== "withdrawals") return;
    if (!r.ok) {
      panel.innerHTML = head;
      return flash("error", errText(r, "Couldn't load withdrawals."));
    }
    const items = r.data.withdrawals;
    const total = items.reduce((s, w) => s + w.amount, 0);
    panel.innerHTML = head + (items.length
      ? '<p class="txr-count">' + items.length + (items.length === 1 ? " request · " : " requests · ") + money(total) + "</p>" +
        '<div class="txr-group">' + items.map(withdrawalRow).join("") + "</div>"
      : empty("Nothing here.", "receipt"));
  }
  async function withdrawalAction(btn) {
    const card = btn.closest(".adm-row");
    const who = card.querySelector("strong").textContent;
    const amount = card.querySelector(".txr-end b").textContent;
    if (btn.dataset.pay) {
      const ok = await ask({ title: "Approve " + esc(amount) + " for " + esc(who) + "?", text: "This only marks it approved: no money is sent by the site. Pay the player yourself. It can't be undone.", yes: "Approve" });
      if (ok === null) return;
      btn.disabled = true;
      const r = await api("/withdrawals/" + btn.dataset.pay + "/pay", {});
      flash(r.ok ? "ok" : "error", r.ok ? "Approved " + esc(amount) + " for " + esc(who) + "." : errText(r, "Couldn't approve it"));
    } else if (btn.dataset.reject) {
      const reason = await ask({ title: "Reject this withdrawal?", text: esc(amount) + " goes back to " + esc(who) + "'s balance.", yes: "Reject", danger: true, input: true, placeholder: "Reason shown to the player" });
      if (reason === null) return;
      btn.disabled = true;
      const r = await api("/withdrawals/" + btn.dataset.reject + "/reject", { reason });
      flash(r.ok ? "ok" : "error", r.ok ? "Rejected — " + esc(amount) + " returned to " + esc(who) + "." : errText(r, "Couldn't reject"));
    } else if (btn.dataset.recheck) {
      btn.disabled = true;
      const r = await api("/withdrawals/" + btn.dataset.recheck + "/recheck", {});
      flash(r.ok ? "info" : "error", r.ok ? "Status: " + esc(r.data.status) + (r.data.note ? " — " + esc(r.data.note) : "") : errText(r, "Recheck failed"));
    }
    loadWithdrawals();
    refreshBadges();
  }

  /* ================= Support chat ================= */
  const sp = { view: "OPEN" };
  const SVIEWS = [["OPEN", "Open"], ["CLOSED", "Closed"], ["ALL", "All"]];
  /* replies admins send most; tapping one fills the box to edit before sending */
  const QUICK = [
    "Thanks for your message — we're looking into it now.",
    "Please send the reference number shown for that deposit on your Deposit page.",
    "Your withdrawal has been approved and is on its way to your registered mobile money number.",
    "Is there anything else we can help you with?",
  ];
  async function loadSupport(quiet) {
    const panel = panelOf("support");
    if (!quiet) panel.innerHTML = chips("sview", SVIEWS, sp.view) + loading;
    const r = await api("/support?status=" + sp.view);
    if (state.tab !== "support") return;
    if (!r.ok) return flash("error", errText(r, "Couldn't load the conversations."));
    const list = r.data.threads;
    panel.innerHTML = chips("sview", SVIEWS, sp.view) +
      (list.length
        ? '<div class="txr-group">' + list.map((t) =>
            '<div class="txr-row adm-chat-row' + (t.unread ? " unread" : "") + '" data-thread="' + esc(t.id) + '" role="button" tabindex="0">' + avatar(t.username) +
            '<span class="txr-main"><strong>' + esc(t.username || "Player") + (t.phone ? " · " + esc(t.phone) : "") + "</strong>" +
            '<small class="txr-detail">' + (t.last_from === "admin" ? "You: " : "") + esc(t.preview) + "</small>" +
            "<small>" + ago(t.last_at) + (t.status === "CLOSED" ? " · closed" : "") + "</small></span>" +
            '<span class="txr-end">' + (t.unread ? '<span class="badge">' + t.unread + "</span>" : "") + "</span></div>").join("") + "</div>"
        : empty(sp.view === "OPEN" ? "No open conversations. New messages from players show up here." : "Nothing here.", "chat"));
  }

  /* one conversation: messages, a reply box, quick replies; new messages appear every few seconds while it's open */
  function openThread(id) {
    const s = sheet("Support chat");
    const conv = { lastId: 0, shown: new Set(), thread: null };
    const msgHtml = (m) => '<div class="adm-msg ' + m.from + '">' + esc(m.body).replace(/\n/g, "<br>") +
      "<small>" + (m.from === "admin" ? "Support · " + esc(m.admin || "") + " · " : "") + when(m.at) + "</small></div>";
    const headHtml = (t) =>
      '<div class="adm-who">' + avatar(t.username) + "<div><strong>" + esc(t.username || "Player") + "</strong>" +
        "<small>" + (t.phone ? '<a href="tel:' + esc(t.phone) + '">' + esc(t.phone) + "</a> · " : "") + "since " + when(t.created_at) + "</small></div>" +
        '<div class="adm-who-bal">' + pill(t.status === "OPEN" ? "Open" : "Closed", t.status === "OPEN" ? "ok" : "") +
        (t.account_status !== "ACTIVE" ? " " + statusPill(t.account_status) : "") + "</div></div>" +
      '<div class="adm-actions-box adm-pills-row">' +
        '<button class="btn btn-ghost btn-sm" type="button" data-do="player">' + U.icon("user") + "Player profile</button>" +
        (t.status === "OPEN"
          ? '<button class="btn btn-ghost btn-sm" type="button" data-do="close">Mark solved (close)</button>'
          : '<button class="btn btn-ghost btn-sm" type="button" data-do="reopen">Reopen</button>') +
      "</div>";
    function layout(t) {
      s.set('<div id="convHead">' + headHtml(t) + "</div>" + '<div class="adm-convo" id="convo" aria-live="polite"></div>' +
        '<div class="adm-quick">' + QUICK.map((q, i) => '<button class="chip" type="button" data-quick="' + i + '">' + esc(q.length > 38 ? q.slice(0, 36) + "…" : q) + "</button>").join("") + "</div>" +
        '<form class="adm-reply" id="replyForm"><label class="sr-only" for="replyBox">Your reply</label>' +
        '<textarea id="replyBox" class="me-textarea" rows="2" maxlength="1000" placeholder="Write a reply… (Enter sends, Shift+Enter for a new line)"></textarea>' +
        '<button class="btn btn-primary" type="submit">Send</button></form>');
    }
    function append(messages) {
      const box = s.body.querySelector("#convo");
      if (!box) return;
      let added = false;
      messages.forEach((m) => {
        if (conv.shown.has(m.id)) return;
        conv.shown.add(m.id);
        conv.lastId = Math.max(conv.lastId, m.id);
        box.insertAdjacentHTML("beforeend", msgHtml(m));
        added = true;
      });
      if (added) box.scrollTop = box.scrollHeight;
    }
    async function pull(first) {
      if (!first && !document.body.contains(s.el)) return clearInterval(timer);
      const r = await api("/support/" + encodeURIComponent(id) + (conv.lastId ? "?after=" + conv.lastId : ""));
      if (!r.ok) {
        if (first) s.set("<div class='alert alert-err'>" + errText(r, "Couldn't load this conversation.") + "</div>");
        return;
      }
      if (first) {
        conv.thread = r.data.thread;
        layout(r.data.thread);
        s.body.querySelector("#replyBox").focus();
      }
      append(r.data.messages);
      if (r.data.messages.some((m) => m.from === "player")) refreshBadges();
    }
    const timer = setInterval(() => { if (!document.hidden) pull(false); }, 4000);

    async function sendReply() {
      const box = s.body.querySelector("#replyBox");
      const body = box.value.trim();
      if (!body) return;
      const btn = s.body.querySelector("#replyForm button");
      btn.disabled = true;
      const r = await api("/support/" + encodeURIComponent(id) + "/messages", { body });
      btn.disabled = false;
      if (!r.ok) return flash("error", errText(r, "Couldn't send the reply."));
      box.value = "";
      append([r.data.message]);
      if (conv.thread && conv.thread.status !== "OPEN") {
        conv.thread.status = "OPEN";
        s.body.querySelector("#convHead").innerHTML = headHtml(conv.thread);
      }
      box.focus();
      if (state.tab === "support") loadSupport(true);
    }
    s.body.addEventListener("submit", (e) => {
      if (e.target.id !== "replyForm") return;
      e.preventDefault();
      sendReply();
    });
    s.body.addEventListener("keydown", (e) => {
      if (e.target.id === "replyBox" && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendReply();
      }
    });
    s.body.addEventListener("click", async (e) => {
      const q = e.target.closest("[data-quick]");
      if (q) {
        const box = s.body.querySelector("#replyBox");
        box.value = QUICK[Number(q.dataset.quick)];
        return box.focus();
      }
      const b = e.target.closest("[data-do]");
      if (!b || !conv.thread) return;
      if (b.dataset.do === "player") {
        s.close();
        return openPlayer(conv.thread.user_id);
      }
      const status = b.dataset.do === "close" ? "CLOSED" : "OPEN";
      const r = await api("/support/" + encodeURIComponent(id) + "/status", { status });
      if (!r.ok) return flash("error", errText(r, "Couldn't update the conversation."));
      conv.thread.status = status;
      s.body.querySelector("#convHead").innerHTML = headHtml(conv.thread);
      flash("ok", status === "CLOSED" ? "Marked solved. If the player writes again it reopens." : "Reopened.");
      if (state.tab === "support") loadSupport(true);
    });
    pull(true);
  }

  /* ================= Mines live signal ================= */
  const minesSignals = { timer: 0, loading: false, last: [], skew: 0 };
  /* m:ss until a time, on the server's clock */
  const countdown = (at) => {
    const s = Math.max(0, Math.round((at - Date.now() - minesSignals.skew) / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };
  function renderMinesSignals(signals) {
    const panel = panelOf("mines");
    if (!signals.length) {
      panel.innerHTML = empty("No active Mines rounds right now.", "bolt");
      return;
    }
    const cards = signals.map((signal) => {
      const mineSet = new Set(signal.minePositions);
      const pickedSet = new Set(signal.pickedPositions);
      const board = Array.from({ length: 25 }, (_, position) => {
        /* a mine is always drawn as a mine — a player's pick on top of it never hides it, so the mines never look
           as if they moved once a bet comes in */
        const isMine = mineSet.has(position);
        const isPicked = pickedSet.has(position);
        const className = isMine ? (isPicked ? "mine picked" : "mine") : isPicked ? "selected" : "hidden";
        const label = isMine ? "💣" : isPicked ? "✓" : "";
        const description = isMine ? (isPicked ? "hidden mine, picked by the player" : "hidden mine") : isPicked ? "selected but not revealed" : "unrevealed";
        return `<div class="adm-mines-tile ${className}" aria-label="Tile ${position + 1}, ${description}">${label}</div>`;
      }).join("");
      const playerName = esc(signal.username || signal.playerId);
      const gameLabel = signal.source === "live" ? "Live Mines" : signal.game === "volta-mines-live" ? "Live Mines" : "Rendo Mines";
      const playerMeta = signal.hasBet ? `<div><span>Player</span><b>${esc(signal.playerId)}</b></div>` : "";
      const betMeta = signal.hasBet ? `<div><span>Bet</span><b>${money(signal.stake)}</b></div>` : "";
      /* a live round: the one in play counts down to its reveal; the next one is shown ahead, with when it starts */
      const isLive = signal.source === "live";
      const roundPill = !isLive ? "" : signal.phase === "next"
        ? pill("NEXT · starts in " + countdown(signal.startsAt), "warn")
        : pill("LIVE · ends in " + countdown(signal.endsAt), "ok");
      const title = isLive ? `Round ${signal.roundNo}` + (signal.hasBet ? ` · ${playerName}` : "") : playerName;
      const betPill = isLive && !signal.hasBet ? "" : pill(signal.hasBet ? "OPEN" : "NO BETS", "live");
      return `<article class="adm-mines-card${signal.phase === "next" ? " is-next" : ""}">
        <div class="adm-mines-card-head"><strong>${esc(title)}</strong><span class="adm-mines-pills">${roundPill}${betPill}</span></div>
        <div class="adm-mines-signal-board" role="img" aria-label="Active ${gameLabel} board for ${playerName}">${board}</div>
        <div class="adm-mines-meta">
          ${playerMeta}
          ${betMeta}
          <div><span>Mines</span><b>${signal.totalMines}</b></div>
          <div><span>Cashout</span><b>${signal.currentCashoutMultiplier.toFixed(2)}x</b></div>
        </div>
      </article>`;
    }).join("");
    panel.innerHTML = `<div class="adm-mines-signal-head">${pill("Refreshing every 2s", "live")}</div>
      <div class="adm-mines-signal-grid"><div class="adm-mines-signal-list">${cards}</div><aside><div class="adm-mines-card"><h3>Board legend</h3>
      <div class="adm-mines-legend"><span><i class="selected"></i>Selected, not revealed</span><span><i class="mine"></i>Hidden mine</span><span><i class="mine picked"></i>Mine the player picked</span><span><i class="hidden"></i>Unrevealed</span></div></div></aside></div>`;
  }
  async function loadMinesSignals() {
    if (minesSignals.loading || state.tab !== "mines") return;
    minesSignals.loading = true;
    const r = await api("/mines/signals");
    minesSignals.loading = false;
    if (!r.ok) return flash("error", errText(r, "Couldn't load Mines signals."));
    minesSignals.last = r.data;
    renderMinesSignals(r.data);
  }

  /* ================= Aviator ================= */
  /* live monitor (a round's crash point shows only once the plane has flown away), pause, and the published RTP and
     bet limits. The settings form is drawn once per visit so the 2-second refresh never wipes what's being typed. */
  const av = { loading: false, last: null };
  const AV_PHASE = { betting: ["Taking bets", "warn"], flying: ["In the air", "live"], ended: ["Idle: no one playing", ""] };
  const avStat = (label, value, cls) => "<div><span>" + label + "</span><b" + (cls ? ' class="' + cls + '"' : "") + ">" + value + "</b></div>";
  const avTotals = (t, title) => '<section class="adm-card"><h3 class="adm-h">' + title + '</h3><div class="adm-mines-meta">' +
    avStat("Rounds", count(t.rounds)) + avStat("Bets", count(t.bets)) + avStat("Players", count(t.players)) +
    avStat("Staked", money(t.staked)) + avStat("Paid out", money(t.paid)) + avStat("House profit", money(t.profit), t.profit >= 0 ? "in" : "bad") +
    avStat("Actual RTP", t.actual_rtp === null ? "—" : t.actual_rtp + "%") + "</div></section>";
  function avForm(s) {
    const f = (id, label, value, step, min, hint) => '<div class="field"><label for="' + id + '">' + label + "</label>" +
      '<input id="' + id + '" type="number" inputmode="decimal" step="' + step + '" min="' + min + '" value="' + value + '" required>' +
      (hint ? '<small class="adm-note">' + hint + "</small>" : "") + "</div>";
    return '<section class="adm-card"><h3 class="adm-h">Settings</h3>' +
      '<p class="adm-note">Changes apply from the next round and the next bet; a round already drawn and bets already placed keep what they had. ' +
      "The RTP is published on the game page, and every round keeps the RTP it was drawn with so players can still check it.</p>" +
      '<form class="adm-terms" data-form="aviator">' +
      f("avRtp", "RTP (%)", s.rtp_pct, "0.01", "80", "Between 80 and 99. Players get this much back on average.") +
      f("avMin", "Minimum bet (GHS)", s.min_bet, "0.01", "0.1") +
      f("avMax", "Maximum bet (GHS)", s.max_bet, "0.01", "0.1") +
      f("avWin", "Maximum win per bet (GHS)", s.max_win, "0.01", "1") +
      '<button class="btn btn-primary btn-sm" type="submit">Save settings</button></form>' +
      '<p class="adm-note">Last changed ' + (s.updated_at ? when(s.updated_at) + " by " + esc(s.updated_by || "—") : "never (defaults)") + ".</p></section>";
  }
  function renderAviator(d) {
    const panel = panelOf("aviator");
    if (!panel.querySelector("#avLive")) {
      panel.innerHTML = '<div id="avTop"></div>' + avForm(d.settings) + '<div id="avLive"></div>';
    }
    $("avTop").innerHTML = '<section class="adm-card"><div class="adm-studio-head"><div><strong>Aviator is ' + (d.enabled ? "on" : "paused") + "</strong><small>" +
      (d.enabled ? "Players can bet. Pausing stops new bets; a round in the air still finishes." : "No new bets are taken. Resume to open it again.") + "</small></div>" +
      '<button class="btn ' + (d.enabled ? "btn-danger" : "btn-success") + ' btn-sm" type="button" data-av-toggle>' + (d.enabled ? "Pause Aviator" : "Resume Aviator") + "</button></div>" +
      '<div class="adm-mines-meta">' + avStat("RTP", d.settings.rtp_pct + "%") + avStat("Bets", money(d.settings.min_bet) + " – " + money(d.settings.max_bet)) +
      avStat("Max win", money(d.settings.max_win)) + "</div></section>";
    const r = d.round;
    const phase = r ? AV_PHASE[r.phase] : null;
    const roundCard = !r ? empty("No rounds yet. A round starts when someone opens Aviator.", "bolt") :
      '<section class="adm-card"><div class="adm-mines-card-head"><strong>Round ' + count(r.no) + "</strong><span class='adm-mines-pills'>" +
        pill(phase[0], phase[1]) + (r.phase === "ended" ? pill("Crashed at " + r.crash.toFixed(2) + "x", "") : "") + pill("Refreshing every 2s", "live") + "</span></div>" +
        '<div class="adm-mines-meta">' + avStat("Players", count(r.players)) + avStat("Bets", count(r.bets.length)) + avStat("Staked", money(r.staked)) +
        avStat("RTP", Math.round(r.rtp * 10000) / 100 + "%") + "</div>" +
        (r.bets.length
          ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Player</th><th>Phone</th><th>Stake</th><th>Auto</th><th>Status</th><th>Cashed</th><th>Win</th></tr></thead><tbody>' +
            r.bets.map((b) => "<tr><td>" + esc(b.name) + "</td><td>" + esc(b.phone || "—") + "</td><td>" + money(b.stake) + "</td><td>" +
              (b.auto ? b.auto.toFixed(2) + "x" : "—") + "</td><td>" + pill(b.status === "ACTIVE" ? "Riding" : b.status === "WON" ? "Cashed out" : "Lost",
              b.status === "WON" ? "ok" : b.status === "LOST" ? "bad" : "live") + "</td><td>" + (b.x ? b.x.toFixed(2) + "x" : "—") + "</td><td>" +
              (b.payout ? money(b.payout) : "—") + "</td></tr>").join("") + "</tbody></table></div>"
          : '<p class="adm-note">No bets in this round.</p>') + "</section>";
    const recent = d.recent.length
      ? '<section class="adm-card"><h3 class="adm-h">Recent rounds</h3><div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Round</th><th>Crash</th><th>Bets</th><th>Players</th><th>Staked</th><th>Paid</th><th>Profit</th><th>When</th></tr></thead><tbody>' +
        d.recent.map((x) => "<tr><td>" + count(x.no) + "</td><td>" + x.crash.toFixed(2) + "x</td><td>" + count(x.bets) + "</td><td>" + count(x.players) + "</td><td>" +
          money(x.staked) + "</td><td>" + money(x.paid) + '</td><td class="' + (x.profit >= 0 ? "in" : "bad") + '">' + money(x.profit) + "</td><td>" + when(new Date(x.at).toISOString()) + "</td></tr>").join("") +
        "</tbody></table></div></section>"
      : "";
    $("avLive").innerHTML = roundCard + avTotals(d.today, "Today") + avTotals(d.week, "Last 7 days") + recent;
  }
  async function loadAviator(fresh) {
    if (av.loading || state.tab !== "aviator") return;
    if (fresh) panelOf("aviator").innerHTML = loading;
    av.loading = true;
    const r = await api("/aviator");
    av.loading = false;
    if (state.tab !== "aviator") return;
    if (!r.ok) return flash("error", errText(r, "Couldn't load Aviator."));
    av.last = r.data;
    renderAviator(r.data);
  }
  async function aviatorToggle() {
    const on = !(av.last && av.last.enabled);
    if (!on) {
      const ok = await ask({ title: "Pause Aviator?", text: "No new bets are taken until you resume it. A round already in the air still finishes and pays out.", yes: "Pause", danger: true });
      if (ok === null) return;
    }
    const r = await api("/catalog/game/aviator", { enabled: on });
    flash(r.ok ? "ok" : "error", r.ok ? "Aviator is now " + (on ? "on" : "paused") + "." : errText(r, "Couldn't change it."));
    loadAviator(false);
  }
  async function saveAviator(form) {
    const v = (id) => form.querySelector("#" + id).value;
    const body = { rtp: v("avRtp"), min_bet: v("avMin"), max_bet: v("avMax"), max_win: v("avWin") };
    if (av.last && Number(body.rtp) !== av.last.settings.rtp_pct) {
      const ok = await ask({ title: "Change the RTP to " + esc(body.rtp) + "%?", text: "It applies to every round from the next one, for every player, and the game page will show the new figure.", yes: "Change RTP" });
      if (ok === null) return;
    }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    const r = await api("/aviator/settings", body);
    btn.disabled = false;
    if (!r.ok) return flash("error", errText(r, "Couldn't save the settings."));
    flash("ok", "Aviator settings saved. They apply from the next round.");
    panelOf("aviator").innerHTML = "";
    loadAviator(true);
  }

  /* ================= sections, menu, events, badges ================= */
  const LOADERS = { overview: loadOverview, players: () => loadPlayers(), money: loadMoney, games: loadGames, mines: loadMinesSignals, aviator: () => loadAviator(true), partners: loadPartners, withdrawals: loadWithdrawals, support: () => loadSupport() };
  const ADD_MONEY = '<button class="btn btn-primary btn-sm" type="button" data-credit>' + U.icon("plus") + "Add money</button>";
  /* each section's title, a line on what it's for, and its buttons */
  const SECTIONS = {
    overview: { title: "Overview", lead: "How the casino is doing, and anything waiting for you.", actions: ADD_MONEY },
    players: { title: "Players", lead: "Find a player by name, number or id to see their money, bets and account.", actions: ADD_MONEY },
    money: { title: "Money", lead: "Every deposit, withdrawal, bet and adjustment as it happens." },
    withdrawals: { title: "Withdrawals", lead: "Players' requests to cash out. Pay sends the money through TheTeller; Reject returns it to the player's balance." },
    games: { title: "Games", lead: "Switching a game off takes it out of the lobby and stops new real-money bets on it; rounds already in play can still finish. A studio's switch does the same for all its games." },
    mines: { title: "Mines Signal", lead: "Admin only: where the hidden mines are in the rounds being played." },
    aviator: { title: "Aviator", lead: "Watch rounds and bets live, pause the game, and set its published RTP and bet limits." },
    partners: { title: "Partners", lead: "Applications, active partners, and the payouts they ask for." },
    support: { title: "Support", lead: "Players write from the chat button on every page; your replies show in their chat as “RendoWin Support”. Unread conversations come first." },
  };
  const panelOf = (tab) => document.querySelector('[data-panel="' + tab + '"]');
  function showTab(tab, reload) {
    if (!LOADERS[tab]) tab = "overview";
    state.tab = tab;
    document.querySelectorAll("[data-tab]").forEach((b) => (b.dataset.tab === tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
    document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab));
    const sec = SECTIONS[tab];
    $("admTitle").textContent = sec.title;
    $("admLead").textContent = sec.lead;
    $("admActions").innerHTML = sec.actions || "";
    history.replaceState(null, "", "#" + tab); /* no history entry: Back leaves the dashboard */
    if (reload !== false) LOADERS[tab]();
  }
  async function refreshBadges() {
    const r = await api("/me");
    if (!r.ok) return;
    state.me = r.data;
    const w = r.data.waiting || {};
    const set = (name, n) => {
      const b = document.querySelector('[data-badge="' + name + '"]');
      b.hidden = !n;
      b.textContent = n > 99 ? "99+" : String(n);
    };
    set("withdrawals", w.withdrawals || 0);
    set("partners", (w.partners || 0) + (w.partnerPayouts || 0));
    set("support", w.support || 0);
    /* on a phone the menu button carries a dot while anything is waiting */
    $("admMenuDot").hidden = !((w.withdrawals || 0) + (w.partners || 0) + (w.partnerPayouts || 0) + (w.support || 0));
    /* the overview's "needs your attention" cards follow the same counts */
    if (state.tab === "overview" && $("ovAttn")) $("ovAttn").innerHTML = attention();
    /* unread support messages show in the browser tab's title too, for an admin working in another tab */
    document.title = (w.support ? "(" + w.support + ") " : "") + "Admin | RendoWin";
  }

  /* the sections menu: beside the page on a computer; on a phone it slides in from the menu button */
  const menuOpen = () => document.body.classList.contains("adm-nav-open");
  function setMenu(open) {
    document.body.classList.toggle("adm-nav-open", open);
    $("admMenuBtn").setAttribute("aria-expanded", String(open));
    if (open) $("admTabs").querySelector('[aria-current="page"]').focus();
    else if ($("admTabs").contains(document.activeElement)) $("admMenuBtn").focus();
  }
  $("admMenuBtn").addEventListener("click", () => setMenu(!menuOpen()));
  document.addEventListener("click", (e) => { if (e.target.closest("[data-nav-close]")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menuOpen()) setMenu(false); });
  $("admTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-tab]");
    if (!b) return;
    if (menuOpen()) setMenu(false);
    showTab(b.dataset.tab);
    window.scrollTo(0, 0);
  });
  $("admActions").addEventListener("click", (e) => { if (e.target.closest("[data-credit]")) openCredit(); });
  $("admReload").addEventListener("click", () => { flash("", ""); refreshBadges(); LOADERS[state.tab](); });

  document.querySelector(".adm-wrap").addEventListener("submit", (e) => {
    if (e.target.matches('form[data-form="aviator"]')) { e.preventDefault(); saveAviator(e.target); }
  });

  document.querySelector(".adm-wrap").addEventListener("click", (e) => {
    if (e.target.closest("[data-av-toggle]")) return aviatorToggle();
    const chip = e.target.closest("[data-chips] [data-v]");
    if (chip) {
      const group = chip.closest("[data-chips]").dataset.chips;
      const v = chip.dataset.v;
      if (group === "range") { ov.range = v; return loadOverview(); }
      if (group === "feed") { mf.type = v; return loadMoney(); }
      if (group === "grange") { gm.range = v; return loadGames(); }
      if (group === "pview") { pt.view = v; return loadPartners(); }
      if (group === "wstatus") { wd.status = v; return loadWithdrawals(); }
      if (group === "sview") { sp.view = v; return loadSupport(); }
    }
    /* the overview's "needs your attention" cards open their section, on the right view */
    const go = e.target.closest("[data-go]");
    if (go) {
      const view = go.dataset.view;
      if (go.dataset.go === "partners" && view) pt.view = view;
      if (go.dataset.go === "money" && view) mf.type = view;
      if (go.dataset.go === "withdrawals") wd.status = "REQUESTED";
      if (go.dataset.go === "support") sp.view = "OPEN";
      showTab(go.dataset.go);
      return window.scrollTo(0, 0);
    }
    const more = e.target.closest("[data-more]");
    if (more) return more.dataset.more === "players" ? loadPlayers(true) : olderMoney();
    const user = e.target.closest("[data-user]");
    if (user) return openPlayer(user.dataset.user);
    const partner = e.target.closest("[data-partner]");
    if (partner) return openPartner(partner.dataset.partner);
    const w = e.target.closest("[data-pay], [data-reject], [data-recheck]");
    if (w) return withdrawalAction(w);
    const payout = e.target.closest("[data-payout]");
    if (payout) return decidePayout(payout);
    const thread = e.target.closest("[data-thread]");
    if (thread) return openThread(thread.dataset.thread);
  });
  /* rows are buttons for the keyboard too */
  document.querySelector(".adm-wrap").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-user], [data-partner], [data-thread]")) {
      e.preventDefault();
      e.target.click();
    }
  });
  document.querySelector(".adm-wrap").addEventListener("change", async (e) => {
    const sw = e.target.closest(".adm-switch input");
    if (!sw) return;
    const on = sw.checked;
    const label = sw.dataset.label;
    if (!on) {
      const ok = await ask({ title: "Switch off " + esc(label) + "?", text: (sw.dataset.kind === "provider" ? "All its games leave" : "It leaves") + " the lobby and stop" + (sw.dataset.kind === "provider" ? "" : "s") + " taking new real-money bets. Rounds already in play can still be finished.", yes: "Switch off", danger: true });
      if (ok === null) { sw.checked = true; return; }
    }
    const r = await api("/catalog/" + sw.dataset.kind + "/" + encodeURIComponent(sw.dataset.id), { enabled: on });
    flash(r.ok ? "ok" : "error", r.ok ? esc(label) + " is now " + (on ? "on" : "off") + "." : errText(r, "Couldn't change it."));
    loadGames();
  });

  async function decidePayout(btn) {
    const pay = btn.dataset.do === "pay";
    const note = await ask(pay
      ? { title: "Mark " + money(Number(btn.dataset.amount)) + " as paid?", text: "Send the money first (mobile money, bank or crypto), then record its reference here.", yes: "Mark paid", input: true, placeholder: "Payment reference", required: 3 }
      : { title: "Reject this payout request?", text: "The amount becomes available to them again.", yes: "Reject", danger: true, input: true, placeholder: "Reason shown to the partner", required: 3 });
    if (note === null) return;
    const r = await api("/partner-payouts/" + btn.dataset.payout, { action: pay ? "pay" : "reject", note });
    flash(r.ok ? "ok" : "error", r.ok ? (pay ? "Recorded as paid." : "Rejected.") : errText(r, "Couldn't update the payout."));
    loadPartners();
    refreshBadges();
  }

  /* ================= start: only for admins ================= */
  (async () => {
    const gate = (html) => ($("admGate").innerHTML = '<div class="adm-gate">' + U.icon("shield") + html + "</div>");
    if (!U.session.get()) return gate("<h1>Admins only</h1><p>Please <a href='register.html#login'>log in</a> with an admin account.</p>");
    const me = await api("/me");
    if (me.status === 403) return gate("<h1>Admins only</h1><p>This account isn't an admin. Admin numbers are set with <b>ADMIN_PHONES</b> on the asakaa-balance service in Render.</p>");
    if (!me.ok) return gate("<h1>Can't reach the server</h1><p>" + errText(me, "Try again in a moment.") + "</p>");
    state.me = me.data;
    document.body.classList.add("adm-ready");
    $("admTabs").hidden = false;
    $("admMenuBtn").hidden = false;
    $("admHead").hidden = false;
    $("admWho").innerHTML = $("admNavWho").innerHTML = "Signed in as <b>" + esc(me.data.phone || "admin") + "</b>";
    refreshBadges();
    showTab(location.hash.slice(1) || "overview");
    state.timers.push(
      setInterval(pollMoney, 10000),
      setInterval(refreshBadges, 20000),
      setInterval(() => { if (state.tab === "support" && !document.hidden && !document.querySelector(".adm-sheet")) loadSupport(true); }, 15000),
      setInterval(() => { if (state.tab === "mines" && !document.hidden) loadMinesSignals(); }, 2000),
      setInterval(() => { if (state.tab === "aviator" && !document.hidden && !document.querySelector(".adm-sheet")) loadAviator(false); }, 2000));
    /* the round countdowns tick every second between refreshes */
    setInterval(() => { if (state.tab === "mines" && !document.hidden && minesSignals.last.some((s) => s.source === "live")) renderMinesSignals(minesSignals.last); }, 1000);
  })();
})();
