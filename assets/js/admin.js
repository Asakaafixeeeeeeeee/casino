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
  const STATUS_TONE = { ACTIVE: "ok", SUSPENDED: "bad", CLOSED: "bad", PENDING: "warn", REJECTED: "bad", REQUESTED: "warn", PAID: "ok", VERIFIED: "ok", UNVERIFIED: "", PAYING: "warn", DECLINED: "bad", DISABLED: "bad", FAILED: "bad", APPROVED: "brand" };
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
    const s = sheet("Add or take money");
    s.set('<form data-form="credit" class="adm-credit-form" autocomplete="off">' +
        '<div class="adm-credit-dir" role="radiogroup" aria-label="Add or take money">' +
          '<label><input type="radio" name="crDir" value="add" checked><span>' + U.icon("plus") + "Add money</span></label>" +
          '<label class="take"><input type="radio" name="crDir" value="take"><span>− Take money off</span></label></div>' +
        '<div class="field"><label for="crPhone">Player’s mobile number</label>' +
          '<input id="crPhone" type="tel" inputmode="numeric" maxlength="20" placeholder="024 123 4567" required></div>' +
        '<div class="field"><label for="crAmt">Amount (GHS)</label>' +
          '<input id="crAmt" type="number" step="0.01" min="0.01" inputmode="decimal" placeholder="e.g. 50" required></div>' +
        '<div class="field adm-credit-why"><label for="crWhy">Reason (goes in the ledger)</label>' +
          '<input id="crWhy" type="text" maxlength="200" minlength="8" placeholder="e.g. Goodwill credit for complaint #1042" required></div>' +
        '<button class="btn btn-primary" type="submit" data-cr-go>Add money</button>' +
      "</form>" +
      '<div class="adm-sheet-msg" aria-live="polite"></div>' +
      '<p class="adm-credit-note">It finds the player by number and adds to or takes off their balance as an adjustment — the same as from a player’s profile, recorded with your number and the reason.</p>' +
      '<p class="adm-credit-note adm-credit-warn"><b>Not for a deposit that hasn’t arrived.</b> A deposit is credited by itself the moment TheTeller confirms it (the player’s Deposit page and a background check keep asking), so adding it here too would pay it twice. You can’t add money to your own account.</p>');
    const form = s.body.querySelector("form");
    form.addEventListener("change", () => {
      const take = form.querySelector("input[name=crDir]:checked").value === "take";
      const go = form.querySelector("[data-cr-go]");
      go.textContent = take ? "Take money off" : "Add money";
      go.classList.toggle("btn-danger", take);
    });
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
    const take = form.querySelector("input[name=crDir]:checked").value === "take";
    if (!phone || !(amount > 0) || reason.length < 8) {
      return say("Enter the player’s number, an amount, and a reason of at least 8 characters.");
    }
    const who = await api("/credit/lookup?phone=" + encodeURIComponent(phone));
    if (!who.ok) return say(errText(who, "Couldn’t find that player."));
    const p = who.data;
    if (take && amount > p.balance) return say("That’s more than the player’s balance (" + money(p.balance) + ").");
    const yes = await ask({
      title: (take ? "Take " + money(amount) + " off?" : "Add " + money(amount) + "?"),
      text: (take ? "From" : "To") + " <b>" + esc(p.full_name || p.username || "player") + "</b> (" + esc(p.phone || phone) + "). Balance " + money(p.balance) +
        " → " + money(take ? p.balance - amount : p.balance + amount) + ". This goes in the ledger with your number and the reason.",
      yes: take ? "Take money off" : "Add money", danger: take });
    if (yes === null) return;
    /* one key per credit: resending the same credit after a lost answer can't pay it twice */
    const sig = [phone, amount, reason, take].join("|");
    if (form.dataset.sig !== sig || !form.dataset.key) { form.dataset.sig = sig; form.dataset.key = newKey(); }
    const r = await api("/credit", { phone, amount, reason, direction: take ? "take" : "add", idempotency_key: form.dataset.key });
    if (!r.ok) return say(errText(r, take ? "Couldn’t take the money off." : "Couldn’t add the money."));
    s.close();
    flash("ok", (take ? "Took " + money(r.data.taken) + " off " : "Added " + money(r.data.added) + " to ") + esc(r.data.player.full_name || r.data.player.username || "the player") +
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
      const games = r.data.games || [];
      const rewards = r.data.rewards || [];
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
        '<h3 class="me-sheet-sub">Deposit and bet limits</h3>' +
        '<form class="adm-adjust agm-reward" data-act="limits">' +
          '<div class="field"><label for="rkMinDep">Smallest deposit (GHS)</label><input id="rkMinDep" type="number" step="0.01" min="1" inputmode="decimal" placeholder="no minimum"></div>' +
          '<div class="field"><label for="rkMaxDep">Largest single deposit (GHS)</label><input id="rkMaxDep" type="number" step="0.01" min="1" inputmode="decimal" placeholder="no maximum"></div>' +
          '<div class="field"><label for="rkMaxBet">Largest bet (GHS)</label><input id="rkMaxBet" type="number" step="0.01" min="0.1" inputmode="decimal" placeholder="no maximum"></div>' +
          '<div class="field"><label for="rkNote">Note (admin only)</label><input id="rkNote" type="text" maxlength="160" placeholder="why, for the record"></div>' +
          '<button class="btn btn-primary btn-sm" type="submit">Save limits</button></form>' +
        '<p class="hint">The player is told the limit when a deposit or bet is outside it. Limits never touch their balance, their winnings or how any result is drawn. Leave a field empty for no limit.</p>' +
        '<h3 class="me-sheet-sub">Wins and losses by game</h3>' +
          (games.length
            ? table(["Game", "Bets", "Staked", "Paid", "Net for player", "Biggest payout", "Last bet"], games.map((g) =>
                "<tr><td>" + esc(g.name) + "</td><td>" + count(g.bets) + "</td><td>" + money(g.staked) + "</td><td>" + money(g.paid) + '</td><td class="' + tone(g.net) + '"><b>' + money(g.net) +
                "</b></td><td>" + money(g.top_win) + "</td><td>" + when(g.last_bet) + "</td></tr>"))
            : '<p class="me-sheet-note">No real-money bets yet.</p>') +
        '<h3 class="me-sheet-sub">Rewards and adjustments</h3><form class="adm-adjust agm-reward" data-act="adjust">' +
          '<div class="field"><label for="adjKind">Type</label><select class="select" id="adjKind">' +
            '<option value="PROMO">Promotional reward</option><option value="BONUS">Bonus</option><option value="CORRECTION">Correction (add or take off)</option></select></div>' +
          '<div class="field"><label for="adjAmt">Amount (GHS) — negative only for a correction</label><input id="adjAmt" type="number" step="0.01" inputmode="decimal" placeholder="e.g. 20" required></div>' +
          '<div class="field"><label for="adjWhy">Reason (goes in the ledger)</label><input id="adjWhy" type="text" maxlength="200" minlength="8" placeholder="e.g. Goodwill for a delayed payout" required></div>' +
          '<button class="btn btn-primary btn-sm" type="submit">Give / apply</button></form>' +
        '<p class="hint">Recorded in the ledger and the audit log with its type, the reason and your number. Rewards never change a bet or its result.</p>' +
        (rewards.length
          ? fold("Rewards and adjustments given", rewards.length, table(["When", "Type", "Amount", "Reason", "By"], rewards.map((x) =>
              "<tr><td>" + when(x.at) + "</td><td>" + esc(x.description || "Adjustment") + '</td><td class="' + tone(x.amount) + '"><b>' + money(x.amount) + "</b></td><td class='adm-wrapcell'>" + esc(x.reason || "") +
              "</td><td>" + esc(x.by || "") + "</td></tr>")), true)
          : '<p class="me-sheet-note">No rewards or adjustments yet.</p>') +
        '<h3 class="me-sheet-sub">Recent money</h3>' +
          (transactions.length ? '<div class="txr-group">' + transactions.map((x) => moveRow(x, false, p.phone)).join("") + "</div>" : '<p class="me-sheet-note">No money movements yet.</p>') +
        '<h3 class="me-sheet-sub">Bets</h3>' +
          (bets.length
            ? fold("Latest " + count(bets.length) + " bets", null, '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Game</th><th>Stake</th><th>Paid</th><th>Net</th><th>When</th></tr></thead><tbody>' +
              bets.map((b) => "<tr><td>" + esc(b.name) + "</td><td>" + money(b.stake) + '</td><td class="' + (b.payout > 0 ? "in" : "") + '">' + (b.settled ? money(b.payout) : "in play") +
                '</td><td class="' + (b.settled ? tone(b.payout - b.stake) : "") + '">' + (b.settled ? money(b.payout - b.stake) : "—") + "</td><td>" + when(b.at) + "</td></tr>").join("") +
              "</tbody></table></div>", true)
            : '<p class="me-sheet-note">No real-money bets yet.</p>') +
        '<h3 class="me-sheet-sub">Admin history</h3>' +
          (actions.length
            ? '<div class="adm-log">' + actions.map((a) => "<div><b>" + esc(a.action) + "</b> " + esc(JSON.stringify(a.details)) + "<small>" + esc(a.admin) + " · " + when(a.at) + "</small></div>").join("") + "</div>"
            : '<p class="me-sheet-note">Nothing yet.</p>'));
      /* fill the limit fields with whatever is set for this player */
      const rk = await api("/risk/player/" + encodeURIComponent(id));
      if (rk.ok && rk.data.risk) {
        const put = (sel, v) => { const el = s.body.querySelector(sel); if (el && v !== null && v !== undefined) el.value = v; };
        put("#rkMinDep", rk.data.risk.min_deposit); put("#rkMaxDep", rk.data.risk.max_deposit);
        put("#rkMaxBet", rk.data.risk.max_bet); put("#rkNote", rk.data.risk.note);
      }
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
        const ok = await ask({ title: "Make this player a partner?", text: "They become an active partner with a referral link and promo code, earning the default revenue share: a share of the net gaming revenue (losses) of the players they bring in, less a deduction on those players' net winnings. You can change their rate on their partner profile.", yes: "Make partner" });
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
      if (!e.target.matches("form[data-act=limits]")) return;
      e.preventDefault();
      const num = (sel) => { const v = s.body.querySelector(sel).value.trim(); return v === "" ? null : Number(v); };
      const r = await api("/risk/player/" + id, {
        min_deposit: num("#rkMinDep"), max_deposit: num("#rkMaxDep"), max_bet: num("#rkMaxBet"),
        note: s.body.querySelector("#rkNote").value.trim(),
      });
      flash(r.ok ? "ok" : "error", r.ok ? "Limits saved for this player." : errText(r, "Couldn't save the limits."));
      if (r.ok && state.tab === "risk") loadRisk();
    });
    s.body.addEventListener("submit", async (e) => {
      if (!e.target.matches("form[data-act=adjust]")) return;
      e.preventDefault();
      const amount = Number(s.body.querySelector("#adjAmt").value);
      const reason = s.body.querySelector("#adjWhy").value.trim();
      const kind = s.body.querySelector("#adjKind").value;
      const KIND = { PROMO: "promotional reward", BONUS: "bonus", CORRECTION: "correction" };
      if (!amount || reason.length < 8) return flash("error", "Enter an amount and a reason of at least 8 characters.");
      if (kind !== "CORRECTION" && amount < 0) return flash("error", "Rewards and bonuses add money. Use a correction to take money off.");
      const yes = await ask({ title: (amount > 0 ? "Give " : "Take ") + money(Math.abs(amount)) + (amount > 0 ? " as a " + KIND[kind] + "?" : " off?"),
        text: "This goes in the ledger as a " + KIND[kind] + ", with your number and the reason. It doesn't change any bet.", yes: "Apply", danger: amount < 0 });
      if (yes === null) return;
      const r = await api("/users/" + id + "/adjust", { amount, reason, kind, idempotency_key: newKey() });
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
  const gm = { range: "30d", filter: "all", q: "", list: null };
  const toggle = (kind, id, on, label) =>
    '<label class="adm-switch"><input type="checkbox" data-kind="' + kind + '" data-id="' + esc(id) + '" data-label="' + esc(label) + '"' + (on ? " checked" : "") +
    ' aria-label="' + esc(label) + ' on or off"><span aria-hidden="true"></span></label>';
  /* Game management: every game as a card (on/off, paused, today's numbers, live play), the studios' switches, and
     a control sheet per game (pause and resume, bet limits, round timing, live activity, statistics, history and
     players' wins and losses). Results are drawn by the server; nothing here can see or change one before it's over. */
  const GM_KIND = { race: "Race", flight: "Rounds", aviator: "Shared rounds", live: "Live", lotto: "Daily draw", instant: "Instant", session: "Step by step", demo: "Demo" };
  const GM_FILTERS = [["all", "All games"], ["rounds", "Round games"], ["instant", "Instant & step"], ["paused", "Paused"], ["off", "Off"]];
  const GAME_PAGE = { aviator: "aviator.html", knockout: "knockout.html", crash: "crash.html", mines: "mines.html", "hi-lo": "hilo.html",
    roulette: "roulette.html", olympus: "olympus.html", "blaze-fruits": "fruits.html", "magic-ball": "magicball.html", "red-black": "redblack.html",
    "even-odd": "evenodd.html", bottle: "bottle.html", coin: "coin.html", goal: "goal.html", crossing: "crossing.html", wings: "wings.html", lotto: "lotto.html", "bnc-win": "bncwin.html", jet: "volta-jet/index.html" };
  const gmState = (g) => (!g.enabled || !g.studio_enabled ? ["bad", g.studio_enabled ? "Off" : "Studio off"] : g.paused ? ["warn", "Paused"] : ["ok", "On"]);
  const xSecs = (x) => Math.log(Math.max(1, x)) / 0.12;
  const secs = (s) => (s >= 60 ? Math.floor(s / 60) + " min " + Math.round(s % 60) + " s" : Math.round(s) + " s");

  /* a game's own extras, each saved the moment it's switched: free play (practice credits, the same odds as real
     money) and the big-wins strip (real wins of the last 7 days on its page). Neither changes how results are drawn. */
  function gameFlags(g) {
    const row = (key, label, hint, on, fits) =>
      '<div class="agm-flag' + (fits ? "" : " is-na") + '"><div><b>' + label + "</b><small>" + hint + "</small></div>" +
      (fits
        ? '<label class="adm-switch"><input type="checkbox" data-gflag="' + key + '" data-game="' + esc(g.id) + '" data-label="' + esc(g.name) + '"' +
          (on ? " checked" : "") + ' aria-label="' + esc(label + " on " + g.name) + '"><span aria-hidden="true"></span></label>'
        : '<span class="adm-pill">n/a</span>') + "</div>";
    return '<div class="agm-flags">' +
      row("free_play", "Free play", g.kind === "demo" ? "This game is free play only" : "Practice credits · same odds", g.free_play, g.kind !== "demo") +
      row("showcase", "Big wins strip", g.showcase_fits ? "Real wins on its page" : "Its page runs on its own", g.showcase, g.showcase_fits) +
      "</div>";
  }

  function gameCard(g) {
    const [cls, txt] = gmState(g);
    return '<article class="agm-card' + (cls === "ok" ? "" : " is-" + cls) + '">' +
      '<div class="agm-card-top"><span class="agm-ico" aria-hidden="true">' + U.icon(g.kind === "flight" || g.kind === "aviator" ? "crash" : g.kind === "live" ? "live" : "slots") + "</span>" +
        '<div class="agm-card-who"><strong>' + esc(g.name) + "</strong><small>" + esc(g.studio) + " · " + esc(GM_KIND[g.kind] || g.kind) + (g.rtp ? " · RTP " + g.rtp + "%" : "") + "</small></div>" +
        '<span class="adm-pill ' + cls + '">' + txt + "</span></div>" +
      '<div class="apt-stats">' +
        '<div class="apt-stat"><span>Bets today</span><b>' + count(g.today.bets) + "</b></div>" +
        '<div class="apt-stat"><span>Players</span><b>' + count(g.today.players) + "</b></div>" +
        '<div class="apt-stat"><span>GGR today</span><b class="' + tone(g.today.ggr) + '">' + money(g.today.ggr) + "</b></div>" +
        '<div class="apt-stat"><span>In play</span><b' + (g.live.in_play ? ' class="warn"' : "") + ">" + count(g.live.in_play) + "</b></div>" +
      "</div>" +
      gameFlags(g) +
      '<div class="agm-card-foot"><span class="agm-onoff">' + toggle("game", g.lobby_id, g.enabled, g.name) + "<small>" + (g.enabled ? "In the lobby" : "Switched off") + "</small></span>" +
        '<button class="btn btn-primary btn-sm" type="button" data-game-open="' + esc(g.id) + '">' + U.icon("settings") + "Manage</button></div></article>";
  }

  /* saves a game's free play or big-wins switch at once (and puts it back if the server says no) */
  async function gameFlag(input) {
    const key = input.dataset.gflag;
    const on = input.checked;
    const name = input.dataset.label;
    input.disabled = true;
    const r = await api("/game-control/" + encodeURIComponent(input.dataset.game), { [key]: on });
    input.disabled = false;
    if (!r.ok) {
      input.checked = !on;
      return flash("error", errText(r, "Couldn't save it."));
    }
    const g = (gm.list || []).find((x) => x.id === input.dataset.game);
    if (g) g[key] = on;
    flash("ok", (key === "free_play" ? "Free play" : "The big-wins strip") + " is now " + (on ? "on" : "off") + " for " + esc(name) + ".");
  }

  async function loadGames() {
    const panel = panelOf("games");
    if (!panel.innerHTML.trim()) panel.innerHTML = loading;
    const [r, cat] = await Promise.all([api("/game-control"), api("/catalog?range=today")]);
    if (state.tab !== "games") return;
    if (!r.ok || !cat.ok) {
      panel.innerHTML = "";
      return flash("error", errText(r.ok ? cat : r, "Couldn't load the games."));
    }
    gm.list = r.data.games;
    const all = gm.list;
    const live = all.filter((g) => g.enabled && g.studio_enabled && !g.paused).length;
    const totals = all.reduce((t, g) => ({ bets: t.bets + g.today.bets, ggr: t.ggr + g.today.ggr, inPlay: t.inPlay + g.live.in_play, players: t.players + g.live.players }),
      { bets: 0, ggr: 0, inPlay: 0, players: 0 });
    panel.innerHTML =
      '<div class="apt-overview agm-overview">' +
        '<div class="apt-ov"><i class="apt-ov-ico">' + U.icon("slots") + "</i><span>Games running</span><strong>" + count(live) + " / " + count(all.length) + "</strong><small>" +
          count(all.filter((g) => g.paused).length) + " paused · " + count(all.filter((g) => !g.enabled || !g.studio_enabled).length) + " off</small></div>" +
        '<div class="apt-ov"><i class="apt-ov-ico">' + U.icon("users") + "</i><span>Playing now</span><strong>" + count(totals.players) + "</strong><small>players in the last 5 minutes</small></div>" +
        '<div class="apt-ov' + (totals.inPlay ? " warn" : "") + '"><i class="apt-ov-ico">' + U.icon("history") + "</i><span>Bets in play</span><strong>" + count(totals.inPlay) + "</strong><small>not settled yet</small></div>" +
        '<div class="apt-ov ' + (totals.ggr >= 0 ? "in" : "bad") + '"><i class="apt-ov-ico">' + U.icon("trend") + "</i><span>GGR today</span><strong>" + money(totals.ggr) + "</strong><small>" + count(totals.bets) + " bets settled</small></div>" +
      "</div>" +
      '<div class="agm-studios">' + cat.data.providers.map((p) => '<div class="agm-studio"><div><strong>' + esc(p.name) + "</strong><small>Studio · " +
          count(all.filter((g) => g.studio === p.name).length) + " games</small></div>" + toggle("provider", p.id, p.enabled, p.name) + "</div>").join("") + "</div>" +
      '<div class="apt-toolbar">' + chips("gfilter", GM_FILTERS, gm.filter) +
        '<label class="searchbar adm-search apt-search">' + U.icon("search") + '<input id="gmQ" type="search" placeholder="Find a game" autocomplete="off" aria-label="Find a game" value="' + esc(gm.q) + '"></label></div>' +
      '<div id="gmList"></div>';
    drawGameList();
    $("gmQ").addEventListener("input", () => { gm.q = $("gmQ").value.trim(); drawGameList(); });
  }
  function drawGameList() {
    const q = gm.q.toLowerCase();
    const list = (gm.list || []).filter((g) =>
      (gm.filter === "all" || (gm.filter === "rounds" && ["flight", "aviator", "live", "lotto"].includes(g.kind)) || (gm.filter === "instant" && ["instant", "session"].includes(g.kind)) ||
        (gm.filter === "paused" && g.paused) || (gm.filter === "off" && (!g.enabled || !g.studio_enabled))) &&
      (!q || g.name.toLowerCase().includes(q) || g.studio.toLowerCase().includes(q)));
    $("gmList").innerHTML = list.length ? '<div class="apt-grid agm-grid">' + list.map(gameCard).join("") + "</div>" : empty("No games here.", "slots");
  }

  /* ---- one game's control sheet ---- */
  async function openGame(id) {
    const s = sheet("Game");
    let d = null;
    let timer = 0;
    const isOpen = () => s.el.isConnected;

    const liveHtml = () => {
      const l = d.live;
      const rounds = d.rounds;
      return '<div class="apt-overview agm-mini">' +
          '<div class="apt-ov"><i class="apt-ov-ico">' + U.icon("users") + "</i><span>Players now</span><strong>" + count(l.last5.players) + "</strong><small>last 5 minutes · " + count(l.last5.bets) + " bets</small></div>" +
          '<div class="apt-ov' + (l.in_play.bets ? " warn" : "") + '"><i class="apt-ov-ico">' + U.icon("history") + "</i><span>Bets in play</span><strong>" + count(l.in_play.bets) + "</strong><small>" + money(l.in_play.staked) + " staked · " + count(l.in_play.players) + " players</small></div>" +
        "</div>" +
        (rounds
          ? '<h4 class="agm-sub">Rounds open now <small>(results stay hidden until each round ends)</small></h4>' +
            (rounds.open.length
              ? table(["Player", "Phase", "Bets", "Still riding", "Staked"], rounds.open.map((o) =>
                  '<tr class="adm-trow" data-user="' + esc(o.user_id) + '" role="button" tabindex="0"><td>' + esc(o.player) + (o.phone ? " <small>" + esc(o.phone) + "</small>" : "") + "</td><td>" +
                  (o.phase === "betting" ? pill("Betting · " + Math.max(0, Math.ceil(o.starts_in_ms / 1000)) + " s", "warn") : pill("In play", "brand")) + "</td><td>" + count(o.bets) + "</td><td>" + count(o.riding) +
                  "</td><td>" + money(o.staked) + "</td></tr>"))
              : '<p class="me-sheet-note">Nobody has a round open right now.</p>')
          : "") +
        '<h4 class="agm-sub">Latest bets</h4>' +
        (l.recent.length
          ? table(["When", "Player", "Stake", "Paid", "Result"], l.recent.slice(0, 25).map((b) =>
              '<tr class="adm-trow" data-user="' + esc(b.user_id) + '" role="button" tabindex="0"><td>' + when(b.at) + "</td><td>" + esc(b.name) + (b.phone ? " <small>" + esc(b.phone) + "</small>" : "") +
              "</td><td>" + money(b.stake) + "</td><td>" + (b.settled ? money(b.payout) : "—") + "</td><td>" +
              (!b.settled ? pill("In play", "warn") : b.payout > b.stake ? pill("Won " + money(b.payout - b.stake), "ok") : b.payout > 0 ? pill("Part back", "") : pill("Lost", "bad")) + "</td></tr>"))
          : '<p class="me-sheet-note">No bets yet.</p>');
    };

    function html() {
      const g = d.game;
      const c = d.controls;
      const st = d.stats;
      const [cls, txt] = gmState({ enabled: g.enabled, studio_enabled: g.studio_enabled, paused: c.paused_now });
      const page = GAME_PAGE[g.lobby_id] ? GAME_PAGE[g.lobby_id] : "game.html?game=" + encodeURIComponent(g.lobby_id);
      const statTable = (ts) => table(["", "Today", "7 days", "30 days"], [
        ["Bets", (t) => count(t.bets)], ["Players", (t) => count(t.players)], ["Staked", (t) => money(t.staked)], ["Paid out", (t) => money(t.paid)],
        ["GGR (stakes − payouts)", (t) => '<b class="' + tone(t.ggr) + '">' + money(t.ggr) + "</b>"], ["Actual RTP", (t) => (t.actual_rtp === null ? "—" : t.actual_rtp + "%")],
        ["Winning bets", (t) => (t.win_rate === null ? "—" : t.win_rate + "%")], ["Biggest payout", (t) => money(t.top_win)],
      ].map(([label, fn]) => "<tr><td>" + label + "</td>" + ts.map((t) => "<td>" + fn(t) + "</td>").join("") + "</tr>"));
      const maxDay = Math.max(1, ...st.daily.map((x) => Math.abs(x.ggr)));
      const playerRows = (list) => list.length
        ? table(["Player", "Bets", "Staked", "Paid", "Net"], list.map((p) => '<tr class="adm-trow" data-user="' + esc(p.user_id) + '" role="button" tabindex="0"><td>' + esc(p.name) +
            (p.phone ? " <small>" + esc(p.phone) + "</small>" : "") + "</td><td>" + count(p.bets) + "</td><td>" + money(p.staked) + "</td><td>" + money(p.paid) +
            '</td><td class="' + tone(p.net) + '"><b>' + money(p.net) + "</b></td></tr>"))
        : '<p class="me-sheet-note">Nobody yet.</p>';
      const fin = d.rounds ? d.rounds.finished : [];
      const wk = d.rounds ? d.rounds.week : null;
      const lim = (v, base) => (v === null || v === undefined ? "" : String(v)) ;
      return (
        '<div class="agm-head"><span class="agm-ico agm-ico-lg" aria-hidden="true">' + U.icon(g.kind === "flight" || g.kind === "aviator" ? "crash" : "slots") + "</span>" +
          '<div><strong>' + esc(g.name) + "</strong><small>" + esc(g.studio) + " · " + esc(g.note) + "</small>" +
          '<span class="adm-pills">' + '<span class="adm-pill ' + cls + '">' + txt + "</span>" + (g.rtp ? pill("RTP " + g.rtp + "%", "brand") : "") +
            (g.min_bet !== null ? pill("Bets " + money(Math.max(g.min_bet, c.min_bet || 0)) + " – " + money(Math.min(g.max_bet, c.max_bet || Infinity)), "") : "") + "</span></div></div>" +
        (c.paused_now
          ? '<div class="alert alert-info agm-paused"><b>Paused</b> — no new rounds or bets' + (c.paused_until ? " until " + when(c.paused_until) : " until you resume it") +
            (c.pause_note ? " · “" + esc(c.pause_note) + "”" : "") + ". Rounds already in play still finish.</div>" : "") +
        '<div class="adm-actions-box agm-actions">' +
          (g.enabled ? '<button class="btn btn-ghost btn-sm" type="button" data-gm="power" data-on="0">' + U.icon("close") + "Switch off</button>"
                     : '<button class="btn btn-success btn-sm" type="button" data-gm="power" data-on="1">' + U.icon("play") + "Switch on</button>") +
          (g.kind === "demo" ? "" : c.paused_now
            ? '<button class="btn btn-success btn-sm" type="button" data-gm="resume">' + U.icon("play") + "Resume now</button>"
            : '<button class="btn btn-ghost btn-sm" type="button" data-gm="pause">' + U.icon("pause") + "Pause</button>") +
          '<a class="btn btn-ghost btn-sm" href="' + esc(page) + '" target="_blank" rel="noopener">' + U.icon("play") + "Open game</a>" +
          (g.kind === "aviator" ? '<button class="btn btn-ghost btn-sm" type="button" data-gm="aviator">' + U.icon("bolt") + "Aviator tab</button>" : "") +
          '<button class="btn btn-ghost btn-sm" type="button" data-gm="refresh">' + U.icon("refresh") + "Refresh</button>" +
        "</div>" +

        '<section class="agm-sec"><h3 class="me-sheet-sub">Live now <small class="agm-live">● updates every 10 s</small></h3><div id="gmLive">' + liveHtml() + "</div></section>" +

        (g.kind === "demo" ? "" :
        '<section class="agm-sec"><h3 class="me-sheet-sub">Controls</h3>' +
        '<form class="agm-form" data-gf="controls">' +
          (g.kind !== "aviator" ? '<fieldset><legend>Bet limits</legend><div class="agm-row">' +
            '<div class="field"><label for="gmMin">Minimum bet (GHS)</label><input id="gmMin" type="number" inputmode="decimal" step="0.01" min="' + g.min_bet + '" max="' + g.max_bet + '" value="' + lim(c.min_bet) + '" placeholder="' + g.min_bet + ' (game\'s own)"></div>' +
            '<div class="field"><label for="gmMax">Maximum bet (GHS)</label><input id="gmMax" type="number" inputmode="decimal" step="0.01" min="' + g.min_bet + '" max="' + g.max_bet + '" value="' + lim(c.max_bet) + '" placeholder="' + g.max_bet + ' (game\'s own)"></div>' +
            '</div><p class="hint">Within the game\'s own ' + money(g.min_bet) + " – " + money(g.max_bet) + ". Empty = the game's own limit. Applies to the next bet.</p></fieldset>" : "") +
          (g.kind === "flight" ? '<fieldset><legend>Round timing</legend><div class="agm-row">' +
            '<div class="field"><label for="gmWait">Betting time before each round (seconds)</label><input id="gmWait" type="number" inputmode="numeric" min="3" max="60" step="1" value="' + Math.round((c.wait_ms || g.wait_ms) / 1000) + '"></div>' +
            (g.max_x_settable ? '<div class="field"><label for="gmMaxX">Longest round: top multiplier (x)</label><input id="gmMaxX" type="number" inputmode="decimal" min="2" max="' + g.max_x + '" step="0.01" value="' + (c.max_x || g.max_x) + '">' +
              '<small class="hint" id="gmMaxXHint">A round lasts at most ' + secs(xSecs(c.max_x || g.max_x)) + ".</small></div>" : "") +
            '</div><p class="hint">The betting time is also the wait between rounds. A round\'s length comes from its random result; the top multiplier caps it, and bets still riding there are paid at it, so the published RTP stays the same. Changes apply from each player\'s next round — never to a round already open.</p></fieldset>' : "") +
          (g.kind === "aviator" ? '<p class="hint">Aviator\'s RTP and bet limits are in the Aviator tab. Pause and switch it off here.</p>' : "") +
          (g.kind !== "aviator" ? '<button class="btn btn-primary btn-sm" type="submit">Save controls</button>' : "") +
        "</form>" +
        (c.updated_by ? '<p class="hint">Last changed ' + when(c.updated_at) + " by " + esc(c.updated_by) + ".</p>" : "") + "</section>") +

        '<section class="agm-sec"><h3 class="me-sheet-sub">Betting statistics</h3>' + statTable([st.today, st.week, st.month]) +
          (st.daily.length ? '<div class="agm-bars" aria-label="GGR per day, last 14 days">' + st.daily.map((x) => '<div class="agm-bar" title="' + esc(x.day) + ": GGR " + esc(money(x.ggr)) + ", " + x.bets + ' bets">' +
              '<i class="' + (x.ggr >= 0 ? "pos" : "neg") + '" style="height:' + Math.max(3, (100 * Math.abs(x.ggr)) / maxDay).toFixed(1) + '%"></i><small>' + esc(x.day.slice(8)) + "</small></div>").join("") + "</div>" +
            '<p class="hint">GGR per day (stakes − payouts), last 14 days, UTC.</p>' : "") +
        "</section>" +

        (d.rounds ? '<section class="agm-sec"><h3 class="me-sheet-sub">Round results</h3>' +
          (wk && wk.rounds ? '<div class="adm-minis">' + mini("Rounds with bets (7 days)", count(wk.rounds)) + mini("Median result", wk.median + "x") + mini("Highest", wk.highest + "x") +
            mini("Reached 2x", wk.at_least_2x + "%") + mini("Reached 10x", wk.at_least_10x + "%") + "</div>" : "") +
          (fin.length ? '<div class="prt-hist agm-hist">' + fin.map((f) => '<span class="' + (f.crash >= 10 ? "hi" : f.crash >= 2 ? "mid" : "lo") + '" title="' + esc(f.player) + " · " + esc(when(f.at)) + '">' + f.crash.toFixed(2) + "x</span>").join("") + "</div>" +
            fold("Finished rounds with bets", fin.length, table(["Ended", "Player", "Result", "Bets", "Staked", "Paid", "Best cash-out"], fin.map((f) =>
              "<tr><td>" + when(f.at) + "</td><td>" + esc(f.player) + "</td><td><b>" + f.crash.toFixed(2) + "x</b></td><td>" + count(f.bets) + "</td><td>" + money(f.staked) + "</td><td>" + money(f.paid) +
              "</td><td>" + (f.best_x ? f.best_x + "x" : "—") + "</td></tr>")))
            : '<p class="me-sheet-note">No finished rounds with bets yet.</p>') + "</section>" : "") +

        '<section class="agm-sec"><h3 class="me-sheet-sub">Players\' wins and losses <small>(last 30 days)</small></h3>' +
          '<div class="agm-cols"><div><h4 class="agm-sub">Biggest winners</h4>' + playerRows(d.players.winners) + "</div>" +
          '<div><h4 class="agm-sub">Biggest losers</h4>' + playerRows(d.players.losers) + "</div></div>" +
          '<p class="hint">Open a player to see all their bets and to give a promotional reward, a bonus or a correction.</p></section>' +

        '<section class="agm-sec"><h3 class="me-sheet-sub">Game history</h3>' +
          fold("All recent bets", d.live.recent.length, table(["When", "Player", "Stake", "Paid", "Net"], d.live.recent.map((b) =>
            '<tr class="adm-trow" data-user="' + esc(b.user_id) + '" role="button" tabindex="0"><td>' + when(b.at) + "</td><td>" + esc(b.name) + "</td><td>" + money(b.stake) + "</td><td>" +
            (b.settled ? money(b.payout) : "in play") + '</td><td class="' + (b.settled ? tone(b.payout - b.stake) : "") + '">' + (b.settled ? money(b.payout - b.stake) : "—") + "</td></tr>"))) +
          '<p class="hint">Every admin change to this game is in the audit log.</p></section>'
      );
    }

    const draw = async (quiet) => {
      const r = await api("/game-control/" + encodeURIComponent(id));
      if (!isOpen()) return;
      if (!r.ok) return quiet ? null : s.set("<div class='alert alert-err'>" + errText(r, "Couldn't load this game.") + "</div>");
      d = r.data;
      if (quiet && $("gmLive")) {
        $("gmLive").innerHTML = liveHtml();
        return;
      }
      const scroller = s.el.querySelector(".adm-sheet-panel");
      const y = scroller ? scroller.scrollTop : 0;
      s.set(html());
      if (scroller) scroller.scrollTop = y;
      const mx = s.body.querySelector("#gmMaxX");
      if (mx) mx.addEventListener("input", () => { const h = s.body.querySelector("#gmMaxXHint"); if (h) h.textContent = "A round lasts at most " + secs(xSecs(Number(mx.value) || 2)) + "."; });
    };
    const save = async (body, done, b) => {
      if (b) b.disabled = true;
      const r = await api("/game-control/" + encodeURIComponent(id), body);
      if (b) b.disabled = false;
      flash(r.ok ? "ok" : "error", r.ok ? done : errText(r, "Couldn't save."));
      if (r.ok) {
        await draw(false);
        if (state.tab === "games") loadGames();
      }
      return r.ok;
    };

    s.body.addEventListener("click", async (e) => {
      const u = e.target.closest("[data-user]");
      if (u) return openPlayer(u.dataset.user);
      const b = e.target.closest("[data-gm]");
      if (!b || !d) return;
      const g = d.game;
      const act = b.dataset.gm;
      if (act === "refresh") return draw(false);
      if (act === "aviator") { s.close(); return showTab("aviator"); }
      if (act === "power") {
        const on = b.dataset.on === "1";
        if (!on) {
          const ok = await ask({ title: "Switch off " + esc(g.name) + "?", text: "It leaves the lobby and stops taking new real-money bets. Rounds already in play can still be finished.", yes: "Switch off", danger: true });
          if (ok === null) return;
        }
        b.disabled = true;
        const r = await api("/catalog/game/" + encodeURIComponent(g.lobby_id), { enabled: on });
        b.disabled = false;
        flash(r.ok ? "ok" : "error", r.ok ? esc(g.name) + " is now " + (on ? "on" : "off") + "." : errText(r, "Couldn't change it."));
        if (r.ok) { await draw(false); if (state.tab === "games") loadGames(); }
        return;
      }
      if (act === "resume") return save({ paused: false }, esc(g.name) + " resumed: new rounds and bets are open again.", b);
      if (act === "pause") {
        const dlg = await askPause(g.name);
        if (!dlg) return;
        return save({ paused: true, paused_until: dlg.until, pause_note: dlg.note }, esc(g.name) + " paused" + (dlg.until ? " until " + when(dlg.until) : "") + ".", b);
      }
    });
    s.body.addEventListener("submit", async (e) => {
      const f = e.target.closest("form[data-gf]");
      if (!f || !d) return;
      e.preventDefault();
      const g = d.game;
      const c = d.controls;
      const body = {};
      const v = (sel) => { const i = f.querySelector(sel); return i ? i.value.trim() : undefined; };
      const lines = [];
      const minV = v("#gmMin");
      const maxV = v("#gmMax");
      if (minV !== undefined && (minV === "" ? null : Number(minV)) !== c.min_bet) { body.min_bet = minV === "" ? null : minV; lines.push("Minimum bet → <b>" + (minV === "" ? "the game's own" : money(Number(minV))) + "</b>"); }
      if (maxV !== undefined && (maxV === "" ? null : Number(maxV)) !== c.max_bet) { body.max_bet = maxV === "" ? null : maxV; lines.push("Maximum bet → <b>" + (maxV === "" ? "the game's own" : money(Number(maxV))) + "</b>"); }
      const w = v("#gmWait");
      if (w !== undefined && Math.round(Number(w) * 1000) !== (c.wait_ms || g.wait_ms)) {
        if (!(Number(w) >= 3 && Number(w) <= 60)) return flash("error", "The betting time must be 3 to 60 seconds.");
        body.wait_ms = Math.round(Number(w) * 1000);
        lines.push("Betting time → <b>" + Number(w) + " s</b>");
      }
      const mx = v("#gmMaxX");
      if (mx !== undefined && Number(mx) !== (c.max_x || g.max_x)) {
        if (!(Number(mx) >= 2 && Number(mx) <= g.max_x)) return flash("error", "The top multiplier must be 2x to " + g.max_x + "x.");
        body.max_x = Number(mx);
        lines.push("Top multiplier → <b>" + Number(mx) + "x</b> (rounds of at most " + secs(xSecs(Number(mx))) + ")");
      }
      if (!lines.length) return flash("info", "Nothing changed.");
      const ok = await ask({ title: "Save " + esc(g.name) + "'s controls?", text: lines.join("<br>") + "<br>Applies from the next round and bet; rounds already open keep their settings.", yes: "Save" });
      if (ok === null) return;
      return save(body, esc(g.name) + ": controls saved.", f.querySelector("button[type=submit]"));
    });

    await draw(false);
    timer = setInterval(() => { if (!isOpen()) return clearInterval(timer); if (!document.hidden) draw(true); }, 10000);
  }

  /* pause now, optionally until a time, with a note for the team */
  function askPause(name) {
    return new Promise((resolve) => {
      const dlg = document.createElement("div");
      dlg.className = "me-dialog";
      dlg.setAttribute("role", "dialog");
      dlg.setAttribute("aria-modal", "true");
      const minLocal = new Date(Date.now() + 60e3 - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
      dlg.innerHTML = '<div class="me-dialog-card"><h2>Pause ' + esc(name) + "?</h2>" +
        "<p>No new rounds or bets start while it's paused. It stays in the lobby, and rounds already in play still finish.</p>" +
        '<div class="field"><label for="gmUntil">Resume automatically at <span class="opt">(optional)</span></label><input id="gmUntil" type="datetime-local" min="' + minLocal + '"></div>' +
        '<div class="field"><label for="gmNote">Note for the team <span class="opt">(optional)</span></label><input id="gmNote" type="text" maxlength="120" placeholder="e.g. Checking a player report"></div>' +
        '<p class="adm-ask-err" hidden></p>' +
        '<div class="me-dialog-actions"><button class="btn btn-ghost btn-lg" type="button" data-no>Cancel</button><button class="btn btn-primary btn-lg" type="button" data-yes>Pause</button></div></div>';
      document.body.appendChild(dlg);
      const done = (v) => { dlg.remove(); resolve(v); };
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg || e.target.closest("[data-no]")) return done(null);
        if (!e.target.closest("[data-yes]")) return;
        const raw = dlg.querySelector("#gmUntil").value;
        const until = raw ? new Date(raw) : null;
        if (until && (Number.isNaN(until.getTime()) || until.getTime() <= Date.now())) {
          const err = dlg.querySelector(".adm-ask-err");
          err.textContent = "Choose a time in the future, or leave it empty.";
          err.hidden = false;
          return;
        }
        done({ until: until ? until.toISOString() : null, note: dlg.querySelector("#gmNote").value.trim() });
      });
      dlg.querySelector("#gmUntil").focus();
    });
  }

  /* ================= Partners ================= */
  /* Partners earn a revenue share: their % of the net gaming revenue (stakes − winnings) of every losing bet settled by a
     player they brought in, less the win deduction % of the net winnings of every winning bet. Commission is recorded per
     settled bet, credited to the partner's commission wallet when its settlement period closes, and paid out by hand on
     request. Everything here comes from the server; this page only draws it. */
  const pt = { view: null, status: "ACTIVE", setView: "settings", over: null, q: "", pay: "OPEN", range: "30d", from: "", to: "", timer: 0, seq: 0, settings: null, perms: null, flyers: null };
  const PSTATUS = [["ACTIVE", "Active"], ["PENDING", "Applications"], ["SUSPENDED", "Suspended"], ["DISABLED", "Disabled"], ["", "All"]];
  const PSET_VIEWS = [["settings", "Commission"], ["permissions", "Permissions"], ["flyers", "Flyers"]];
  const LIST_VIEWS = ["PENDING", "ACTIVE", "SUSPENDED", "DISABLED", ""];
  const PAY_VIEWS = [["OPEN", "Open"], ["REQUESTED", "Requested"], ["APPROVED", "Approved"], ["PAID", "Paid"], ["REJECTED", "Rejected"]];
  const PRANGES = [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7 days"], ["30d", "30 days"], ["this_month", "This month"],
    ["last_month", "Last month"], ["all", "All time"], ["custom", "Custom"]];
  const METHOD = { MOMO: "Mobile Money", BANK: "Bank transfer", CRYPTO: "Crypto" };
  const WALLET_KIND = { OPENING: "Opening balance", SETTLEMENT: "Settlement credited", CORRECTION: "Correction by admin",
    PAYOUT_HOLD: "Held for a payout request", PAYOUT_RELEASE: "Payout rejected: returned" };
  const tx = (s) => esc(s === null || s === undefined ? "" : s);
  const refLink = (code) => location.origin + "/?ref=" + encodeURIComponent(code || "");
  const rateOf = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-GB", { maximumFractionDigits: 2 }) + "%");
  const tone = (n) => (n > 0 ? "in" : n < 0 ? "bad" : "");
  const dayOf = (v) => (v ? new Date(v).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
  /* a statistics bucket: "2026-10-03" (a day) or "2026-10" (a month), both UTC */
  const bucket = (d) => d.length === 7
    ? new Date(d + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })
    : new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const detailsOf = (p) => {
    if (p.details && typeof p.details === "object") return p.details;
    try { return JSON.parse(p.details || "{}") || {}; } catch (e) { return {}; }
  };
  const payTo = (p) => {
    const d = detailsOf(p);
    return p.method === "MOMO" ? "number <b>" + tx(d.phone) + "</b> · name " + tx(d.name) :
      p.method === "BANK" ? tx(d.bank) + " · account <b>" + tx(d.account_number) + "</b> · " + tx(d.account_name) :
      p.method === "CRYPTO" ? tx(d.asset) + " (" + tx(d.network) + ") · <span class='adm-addr'>" + tx(d.address) + "</span>" : "—";
  };
  const table = (heads, rows, foot) => '<div class="adm-table-wrap"><table class="adm-table"><thead><tr>' + heads.map((h) => "<th>" + h + "</th>").join("") +
    "</tr></thead><tbody>" + rows.join("") + "</tbody>" + (foot ? "<tfoot>" + foot + "</tfoot>" : "") + "</table></div>";
  const fold = (title, n, inner, open) => '<details class="adm-pdet"' + (open ? " open" : "") + "><summary>" + title +
    (n !== null && n !== undefined ? " <small>(" + count(n) + ")</small>" : "") + "</summary>" + inner + "</details>";

  async function copyText(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      flash("ok", done ? esc(done) : "Copied: " + esc(text));
    } catch (e) {
      window.prompt("Copy this:", text);
    }
  }

  /* what changing a partner's status does, asked before doing it; resolves true to go ahead */
  async function confirmStatus(status, from, name) {
    const who = esc(name || "this partner");
    const c = status === "ACTIVE"
      ? from === "PENDING" || from === "REJECTED"
        ? { title: "Approve " + who + "?", yes: "Approve",
            text: "They become an active partner on the default revenue share (change it on their profile). Their referral link and promo code start bringing in players straight away." }
        : { title: "Reactivate " + who + "?", yes: "Reactivate",
            text: "Their link and promo code work again and they can ask for payouts." +
              (from === "DISABLED" ? " Bets their players settled while the account was disabled never earn commission." : "") }
      : status === "REJECTED"
        ? { title: "Reject " + who + "'s application?", yes: "Reject", danger: true, text: "Their link and promo code won't bring in players. You can still approve them later." }
        : status === "SUSPENDED"
          ? { title: "Suspend " + who + "?", yes: "Suspend", danger: true,
              text: "Their link and promo code stop bringing in new players and they can't ask for payouts until you reactivate them. Players they already brought in keep earning them commission while suspended." }
          : { title: "Disable " + who + "?", yes: "Disable", danger: true,
              text: "Their link and promo code stop working, they can't ask for payouts, and <b>no commission is recorded</b> for bets settled while disabled — not even after you reactivate them. Their commission balance stays." };
    return (await ask(c)) !== null;
  }
  const STATUS_DONE = { ACTIVE: "Partner is active.", REJECTED: "Application rejected.", SUSPENDED: "Partner suspended.", DISABLED: "Partner disabled." };

  /* ---- the section: an overview strip, five areas (partners, invitations, payouts, statistics, settings), each
     drawing into #ptBody ---- */
  const ptHere = (view) => state.tab === "partners" && pt.view === view && $("ptBody");
  const PSECTIONS = [["partners", "Partners", "users"], ["invites", "Invitations", "link"], ["payouts", "Payouts", "wallet"],
    ["stats", "Statistics", "chart"], ["settings", "Settings", "settings"]];
  const secOf = (view) => (LIST_VIEWS.includes(view) ? "partners" : PSET_VIEWS.some((x) => x[0] === view) ? "settings" : view);
  const pnum = (n) => (n === null || n === undefined ? "…" : count(n));

  /* the numbers along the top: each one opens its area */
  function overviewHtml(o) {
    const card = (sec, view, ic, label, value, sub, tone) =>
      '<button type="button" class="apt-ov' + (tone ? " " + tone : "") + '" data-psec="' + sec + '"' + (view !== null ? ' data-pv="' + esc(view) + '"' : "") + ">" +
        '<i class="apt-ov-ico">' + U.icon(ic) + "</i><span>" + label + "</span><strong>" + value + "</strong>" + (sub ? "<small>" + sub + "</small>" : "") + "</button>";
    const p = o && o.stats ? o.stats.partners : null;
    const t = o && o.stats ? o.stats.totals : null;
    return card("partners", "ACTIVE", "users", "Active partners", pnum(p && p.active), p && p.paused ? count(p.paused) + " suspended or disabled" : "") +
      card("partners", "PENDING", "star", "Applications", pnum(p && p.pending), p && p.pending ? "waiting for you" : "none waiting", p && p.pending ? "warn" : "") +
      card("invites", null, "link", "Open invitations", pnum(o && o.openInvites), "setup links not used yet") +
      card("payouts", null, "withdraw", "Payout requests", pnum(o && o.payouts && o.payouts.length),
        o && o.payouts && o.payouts.length ? money(o.payouts.reduce((s, x) => s + Number(x.amount), 0)) + " to pay" : "nothing waiting", o && o.payouts && o.payouts.length ? "warn" : "") +
      card("stats", null, "trend", "Net commission · 30 days", t ? money(t.net) : "…", t ? count(t.signups) + " new referrals" : "", t && t.net < 0 ? "bad" : "in") +
      card("stats", null, "wallet", "Owed to partners", p ? money(p.owed) : "…", p ? money(p.paid) + " paid all time" : "");
  }
  async function loadPtOverview() {
    const [st, inv, pay] = await Promise.all([api("/partner-stats?range=30d"), api("/partner-invites"), api("/partner-payouts?status=OPEN")]);
    pt.over = {
      stats: st.ok ? st.data : null,
      openInvites: inv.ok ? inv.data.invites.filter((i) => i.state === "open").length : null,
      payouts: pay.ok ? pay.data.payouts : null,
    };
    if (state.tab === "partners" && $("ptOver")) {
      $("ptOver").innerHTML = overviewHtml(pt.over);
      const pend = pt.over.stats ? pt.over.stats.partners.pending : 0;
      const b = document.querySelector('[data-chips="pview"] [data-v="PENDING"] .apt-badge');
      if (b) b.textContent = pend ? count(pend) : "";
    }
    return pt.over;
  }

  async function loadPartners() {
    const panel = panelOf("partners");
    /* first visit: applications first when some are waiting, otherwise the active partners */
    if (pt.view === null) {
      panel.innerHTML = loading;
      const o = await loadPtOverview();
      if (state.tab !== "partners") return;
      if (pt.view === null) pt.view = o.stats && o.stats.partners.pending ? "PENDING" : "ACTIVE";
    } else loadPtOverview();
    const sec = secOf(pt.view);
    const pend = pt.over && pt.over.stats ? pt.over.stats.partners.pending : 0;
    panel.innerHTML =
      '<div class="apt-overview" id="ptOver">' + overviewHtml(pt.over) + "</div>" +
      '<nav class="apt-nav" aria-label="Partner areas">' +
        PSECTIONS.map(([id, label, ic]) => '<button type="button" data-psec="' + id + '" aria-current="' + (id === sec ? "page" : "false") + '">' + U.icon(ic) + "<span>" + label + "</span></button>").join("") +
      "</nav>" +
      (sec === "partners"
        ? '<div class="apt-toolbar">' +
            '<div class="chip-list adm-chips" data-chips="pview">' + PSTATUS.map(([v, label]) => '<button type="button" class="chip' + (v === pt.view ? " on" : "") + '" data-v="' + v + '" aria-pressed="' + (v === pt.view) + '">' + label +
              (v === "PENDING" ? '<span class="apt-badge">' + (pend ? count(pend) : "") + "</span>" : "") + "</button>").join("") + "</div>" +
            '<label class="searchbar adm-search apt-search">' + U.icon("search") +
              '<input id="ptQ" type="search" placeholder="Search name, phone, email, Partner ID or promo code" autocomplete="off" aria-label="Search partners" value="' + esc(pt.q) + '"></label>' +
          "</div>"
        : sec === "settings" ? chips("pset", PSET_VIEWS, pt.view) : "") +
      '<div id="ptBody"></div>';
    if (pt.view === "payouts") return loadPartnerPayouts();
    if (pt.view === "stats") return loadPartnerStats();
    if (pt.view === "settings") return loadPartnerSettings();
    if (pt.view === "permissions") return loadPartnerPermissions();
    if (pt.view === "flyers") return loadPartnerFlyers();
    if (pt.view === "invites") return loadPartnerInvites();
    $("ptBody").innerHTML = '<p class="txr-count" id="ptCount"></p><div id="ptList"></div>';
    $("ptQ").addEventListener("input", () => {
      clearTimeout(pt.timer);
      pt.timer = setTimeout(() => { pt.q = $("ptQ").value.trim(); loadPartnerList(); }, 300);
    });
    loadPartnerList();
  }
  /* an area of the section: Partners goes back to the status last shown, Settings to its last page */
  function showPtSection(sec, view) {
    pt.view = view !== undefined && view !== null ? view
      : sec === "partners" ? (LIST_VIEWS.includes(pt.status) ? pt.status : "ACTIVE")
      : sec === "settings" ? pt.setView || "settings" : sec;
    if (sec === "payouts" && view === undefined) pt.pay = "OPEN";
    return loadPartners();
  }

  /* one partner as a card: who they are, their numbers, their codes, and what to do */
  function partnerRow(p) {
    const name = p.full_name || p.username || "Player";
    const stat = (label, v, cls) => '<div class="apt-stat"><span>' + label + "</span><b" + (cls ? ' class="' + cls + '"' : "") + ">" + v + "</b></div>";
    const actions = (p.status === "PENDING" || p.status === "REJECTED"
      ? '<button class="btn btn-success btn-sm" type="button" data-pact="ACTIVE" data-id="' + esc(p.user_id) + '" data-from="' + esc(p.status) + '" data-name="' + esc(name) + '">Approve</button>'
      : "") +
      (p.status === "PENDING"
        ? '<button class="btn btn-ghost btn-sm" type="button" data-pact="REJECTED" data-id="' + esc(p.user_id) + '" data-from="PENDING" data-name="' + esc(name) + '">Reject</button>'
        : "") +
      '<button class="btn btn-ghost btn-sm" type="button" data-copy="' + esc(refLink(p.code)) + '" aria-label="Copy referral link">' + U.icon("copy") + "Copy link</button>" +
      '<button class="btn btn-primary btn-sm" type="button" data-partner="' + esc(p.user_id) + '">Open profile</button>';
    const flags = (p.link_live ? "" : pill(p.link_enabled ? "Link not live" : "Link off", "bad")) +
      (p.promo_request ? pill("Asks for promo " + p.promo_request, "warn") : "") +
      (p.payoutWaiting ? pill("Payout waiting", "warn") : "");
    return '<article class="adm-prow apt-card">' +
      '<div class="apt-card-top">' + avatar(name) +
        '<div class="apt-card-who"><strong>' + esc(name) + "</strong>" +
          "<small>" + [p.full_name && p.username ? esc(p.username) : "", tx(p.phone), tx(p.email)].filter(Boolean).join(" · ") + "</small></div>" +
        '<div class="apt-card-pills">' + statusPill(p.status) + pill(rateOf(p.revshare_pct), "brand") + "</div></div>" +
      '<div class="apt-stats">' + stat("Referrals", count(p.referrals)) + stat("Earnings", money(p.totalEarnings), tone(p.totalEarnings)) +
        stat("Available", money(p.available)) + stat("Pending", money(p.pending), p.pending ? "warn" : "") + "</div>" +
      '<div class="apt-codes"><span class="apt-code">Partner ID <b>' + tx(p.partner_id || p.code) + "</b></span>" +
        '<span class="apt-code">Promo <b>' + (p.promo_code ? esc(p.promo_code) : "—") + "</b></span>" +
        '<span class="apt-code">Since <b>' + dayOf(p.created_at) + "</b></span></div>" +
      (flags ? '<div class="adm-pills">' + flags + "</div>" : "") +
      (p.status === "PENDING" && p.channel ? '<p class="apt-channel">Where they promote: “' + esc(p.channel) + "”</p>" : "") +
      '<div class="adm-item-actions apt-actions">' + actions + "</div></article>";
  }
  async function loadPartnerList() {
    const view = pt.view;
    const seq = ++pt.seq;
    if (!$("ptList")) return;
    $("ptList").innerHTML = loading;
    const r = await api("/partners?" + new URLSearchParams({ status: view, q: pt.q }));
    if (!ptHere(view) || !$("ptList") || seq !== pt.seq) return;
    if (!r.ok) {
      $("ptList").innerHTML = "";
      return flash("error", errText(r, "Couldn't load partners."));
    }
    const list = r.data.partners;
    $("ptCount").textContent = count(list.length) + " partner" + (list.length === 1 ? "" : "s") + (list.length >= 300 ? " (the first 300 — search to narrow it down)" : "");
    $("ptList").innerHTML = list.length
      ? '<div class="apt-grid">' + list.map(partnerRow).join("") + "</div>"
      : empty(pt.q ? "No partners match." : view === "PENDING" ? "No applications waiting." : "No partners here yet.", "star") +
        (view === "ACTIVE" && !pt.q ? '<div class="apt-empty-cta"><button class="btn btn-primary" type="button" data-add-partner>' + U.icon("plus") + "Add your first partner</button></div>" : "");
  }

  /* ---- invitations: the setup links admins made, used or not ---- */
  const INV_STATE = { open: ["ok", "Open"], used: ["brand", "Used"], expired: ["bad", "Expired"], cancelled: ["bad", "Cancelled"], busy: ["warn", "Being used"] };
  const setupLink = (token) => location.origin + "/partner-setup.html#" + token;
  function inviteRow(i) {
    const [cls, txt] = INV_STATE[i.state] || ["", i.state];
    const perms = Object.entries(i.permissions || {}).map(([k, v]) => (PERM_LABEL[k] || k) + (v ? " on" : " off"));
    const actions = i.state === "used"
      ? (i.used_by ? '<button class="btn btn-primary btn-sm" type="button" data-partner="' + esc(i.used_by) + '">Open partner</button>' : "")
      : '<button class="btn btn-ghost btn-sm" type="button" data-inv-renew="' + esc(i.id) + '" data-phone="' + esc(i.phone) + '">' + U.icon("refresh") + "New link</button>" +
        (i.state === "open" ? '<button class="btn btn-ghost btn-sm" type="button" data-inv-cancel="' + esc(i.id) + '" data-phone="' + esc(i.phone) + '">Cancel</button>' : "");
    return '<article class="apt-card apt-inv">' +
      '<div class="apt-card-top"><span class="adm-ava apt-inv-ava" aria-hidden="true">' + U.icon("link") + "</span>" +
        '<div class="apt-card-who"><strong>' + tx(i.phone) + "</strong><small>" +
          (i.state === "used" ? "Registered as <b>" + tx(i.used_name || i.used_username || "a partner") + "</b>" + (i.partner_code ? " · " + tx(i.partner_code) : "") + " · " + when(i.used_at)
            : i.state === "open" ? "Valid until " + when(i.expires_at) : "Made " + when(i.created_at)) + "</small></div>" +
        '<div class="apt-card-pills"><span class="adm-pill ' + cls + '">' + txt + "</span>" + pill(rateOf(i.revshare_pct), "brand") + "</div></div>" +
      '<p class="apt-inv-meta">Made by ' + tx(i.created_by) + " · " + when(i.created_at) + (perms.length ? " · " + esc(perms.join(", ")) : " · default features") + "</p>" +
      (actions ? '<div class="adm-item-actions apt-actions">' + actions + "</div>" : "") + "</article>";
  }
  async function loadPartnerInvites() {
    $("ptBody").innerHTML = loading;
    const r = await api("/partner-invites");
    if (!ptHere("invites")) return;
    if (!r.ok) {
      $("ptBody").innerHTML = "";
      return flash("error", errText(r, "Couldn't load the invitations."));
    }
    const list = r.data.invites;
    const open = list.filter((i) => i.state === "open" || i.state === "busy");
    const rest = list.filter((i) => !(i.state === "open" || i.state === "busy"));
    $("ptBody").innerHTML =
      '<div class="apt-howto"><div><strong>Partner setup links</strong><p>Enter a partner\'s number, commission and features; send them the link. ' +
        "They open it and register their own account. Each link works once, for that number only, for " + count(r.data.days) + " days.</p></div>" +
        '<button class="btn btn-primary" type="button" data-add-partner>' + U.icon("plus") + "New setup link</button></div>" +
      '<h3 class="adm-h">Waiting to be used <small>(' + count(open.length) + ")</small></h3>" +
      (open.length ? '<div class="apt-grid">' + open.map(inviteRow).join("") + "</div>" : '<p class="me-sheet-note">No open invitations.</p>') +
      (rest.length ? '<h3 class="adm-h">Used, expired and cancelled</h3><div class="apt-grid">' + rest.slice(0, 60).map(inviteRow).join("") + "</div>" : "");
  }
  async function inviteAction(b) {
    if (b.dataset.invCancel) {
      const ok = await ask({ title: "Cancel the setup link for " + esc(b.dataset.phone) + "?", text: "The link stops working at once. You can make a new one later.", yes: "Cancel link", danger: true });
      if (ok === null) return;
      b.disabled = true;
      const r = await api("/partner-invites/" + encodeURIComponent(b.dataset.invCancel) + "/cancel", {});
      b.disabled = false;
      flash(r.ok ? "ok" : "error", r.ok ? "Setup link cancelled." : errText(r, "Couldn't cancel it."));
    } else {
      const ok = await ask({ title: "Make a new setup link for " + esc(b.dataset.phone) + "?", text: "The old link stops working at once; the new one is valid for 7 days.", yes: "Make new link" });
      if (ok === null) return;
      b.disabled = true;
      const r = await api("/partner-invites/" + encodeURIComponent(b.dataset.invRenew) + "/renew", {});
      b.disabled = false;
      if (!r.ok) return flash("error", errText(r, "Couldn't make a new link."));
      showInviteLink(r.data, false);
    }
    if (state.tab === "partners") loadPartners();
  }
  /* Approve / Reject straight from the Applications list */
  /* a new partner's unique referral link, to copy and send them */
  const refLinkNote = (code) => "Their referral link: <b>" + esc(location.origin + "/?ref=" + code) + "</b> " +
    '<button class="btn btn-ghost btn-sm" type="button" data-copy="' + esc(location.origin + "/?ref=" + code) + '">Copy link</button>';
  async function partnerQuick(btn) {
    const status = btn.dataset.pact;
    if (!(await confirmStatus(status, btn.dataset.from, btn.dataset.name))) return;
    btn.disabled = true;
    const r = await api("/partners/" + encodeURIComponent(btn.dataset.id), { status });
    btn.disabled = false;
    flash(r.ok ? "ok" : "error", r.ok ? esc(btn.dataset.name) + ": " + STATUS_DONE[status] + (status === "ACTIVE" ? " " + refLinkNote(r.data.code) : "")
      : errText(r, "Couldn't update the partner."));
    refreshBadges();
    if (state.tab === "partners") loadPartnerList();
  }

  /* ---- payout requests ---- */
  function payoutRow(p) {
    const open = p.status === "REQUESTED" || p.status === "APPROVED";
    const name = p.full_name || p.username || "Partner";
    const data = ' data-payout="' + esc(p.id) + '" data-amount="' + Number(p.amount) + '" data-who="' + esc(name) + '"';
    const actions = (p.status === "REQUESTED" ? '<button class="btn btn-ghost btn-sm" type="button"' + data + ' data-do="approve">Approve</button>' : "") +
      (open ? '<button class="btn btn-primary btn-sm" type="button"' + data + ' data-do="pay">Mark paid</button>' +
        '<button class="btn btn-ghost btn-sm" type="button"' + data + ' data-do="reject">Reject</button>' : "") +
      (p.affiliate_id ? '<button class="btn btn-ghost btn-sm" type="button" data-partner="' + esc(p.affiliate_id) + '">Partner</button>' : "");
    return '<div class="txr-row adm-item">' +
      '<span class="txr-ico out">' + U.icon("withdraw") + "</span>" +
      '<span class="txr-main"><strong>' + esc(name) + " · " + tx(p.code) + "</strong>" +
        "<small>" + [p.full_name && p.username ? esc(p.username) : "", tx(p.phone), p.promo_code ? "promo " + esc(p.promo_code) : ""].filter(Boolean).join(" · ") + "</small>" +
        "<small>" + tx(METHOD[p.method] || p.method) + ": " + payTo(p) + "</small>" +
        "<small>Requested " + when(p.created_at) +
          (p.approved_at ? " · approved " + when(p.approved_at) + (p.approved_by ? " by " + esc(p.approved_by) : "") : "") +
          (p.decided_at ? " · " + (p.status === "PAID" ? "paid " : "decided ") + when(p.decided_at) + (p.decided_by ? " by " + esc(p.decided_by) : "") : "") + "</small>" +
        (p.status === "PAID" && (p.reference || p.note) ? "<small>Payment reference <b>" + tx(p.reference || p.note) + "</b></small>" :
          p.note ? '<small class="txr-detail' + (p.status === "REJECTED" ? " bad" : "") + '">' + esc(p.note) + "</small>" : "") +
        "<small>Commission balance now <b>" + money(p.available) + "</b>" + (open ? " (this request is already held from it)" : "") + "</small></span>" +
      '<span class="txr-end"><b class="out">' + money(p.amount) + "</b>" + statusPill(p.status) + "</span>" +
      '<span class="adm-item-actions">' + actions + "</span></div>";
  }
  async function loadPartnerPayouts() {
    const head = chips("ppay", PAY_VIEWS, pt.pay) +
      "<div class='alert alert-info'>Partner commission is paid by hand. <b>Approve</b> once you've checked a request, send the money yourself " +
      "(mobile money, bank or crypto), then <b>Mark paid</b> with the transfer's payment reference. <b>Reject</b> returns the held amount to the partner's commission balance.</div>";
    $("ptBody").innerHTML = head + loading;
    const status = pt.pay;
    const r = await api("/partner-payouts?status=" + status);
    if (!ptHere("payouts") || status !== pt.pay) return;
    if (!r.ok) {
      $("ptBody").innerHTML = head;
      return flash("error", errText(r, "Couldn't load payout requests."));
    }
    const items = r.data.payouts;
    const total = items.reduce((s, p) => s + Number(p.amount), 0);
    $("ptBody").innerHTML = head + (items.length
      ? '<p class="txr-count">' + count(items.length) + (items.length === 1 ? " request · " : " requests · ") + money(total) + "</p>" +
        '<div class="txr-group">' + items.map(payoutRow).join("") + "</div>"
      : empty(status === "OPEN" ? "No payout requests waiting." : "Nothing here.", "wallet"));
  }
  /* approve, mark paid (only with the transfer's reference) or reject (with a reason) one payout; resolves true when done */
  async function decidePayout(btn) {
    const act = btn.dataset.do;
    const amount = money(Number(btn.dataset.amount));
    const who = esc(btn.dataset.who || "the partner");
    let body;
    if (act === "approve") {
      const ok = await ask({ title: "Approve " + amount + " for " + who + "?",
        text: "This marks it checked and about to be paid. The site sends no money: pay it yourself, then press <b>Mark paid</b> with the payment reference.", yes: "Approve" });
      if (ok === null) return false;
      body = { action: "approve" };
    } else if (act === "pay") {
      const reference = await ask({ title: "Mark " + amount + " to " + who + " as paid?",
        text: "Only once the money has gone out. Enter the transfer's payment reference (mobile money transaction ID, bank reference or crypto transaction hash); the partner sees it and it's kept in the audit log.",
        yes: "Mark paid", input: true, placeholder: "Payment reference", required: 3 });
      if (reference === null) return false;
      body = { action: "pay", reference };
    } else {
      const note = await ask({ title: "Reject " + amount + " for " + who + "?", text: "The held amount goes back to their commission balance.",
        yes: "Reject", danger: true, input: true, placeholder: "Reason shown to the partner", required: 3 });
      if (note === null) return false;
      body = { action: "reject", note };
    }
    btn.disabled = true;
    const r = await api("/partner-payouts/" + encodeURIComponent(btn.dataset.payout), body);
    btn.disabled = false;
    flash(r.ok ? "ok" : "error", r.ok
      ? (act === "approve" ? "Approved " + amount + " for " + who + ". Mark it paid once the money is sent." : act === "pay" ? "Recorded " + amount + " to " + who + " as paid." : "Rejected — " + amount + " returned to " + who + "'s commission balance.")
      : errText(r, "Couldn't update the payout."));
    refreshBadges();
    if (ptHere("payouts")) loadPartnerPayouts();
    return r.ok;
  }

  /* ---- statistics for the whole programme ---- */
  async function loadPartnerStats() {
    const custom = pt.range === "custom";
    const today = new Date().toISOString().slice(0, 10);
    $("ptBody").innerHTML = chips("prange", PRANGES, pt.range) +
      (custom ? '<form class="adm-prange" data-form="pstats">' +
        '<div class="field"><label for="pstFrom">From</label><input id="pstFrom" type="date" max="' + today + '" value="' + esc(pt.from) + '" required></div>' +
        '<div class="field"><label for="pstTo">To</label><input id="pstTo" type="date" max="' + today + '" value="' + esc(pt.to) + '" required></div>' +
        '<button class="btn btn-primary btn-sm" type="submit">Show</button></form>' : "") +
      '<p class="adm-note">Days are UTC (Ghana time). Figures come from the commission recorded for each settled bet of a referred player.</p><div id="ptStats"></div>';
    if (custom && !(pt.from && pt.to)) return ($("ptStats").innerHTML = '<p class="me-sheet-note">Choose a start and end date.</p>');
    $("ptStats").innerHTML = loading;
    const qs = new URLSearchParams({ range: pt.range });
    if (custom) { qs.set("from", pt.from); qs.set("to", pt.to); }
    const key = qs.toString();
    const r = await api("/partner-stats?" + key);
    const now = new URLSearchParams({ range: pt.range });
    if (pt.range === "custom") { now.set("from", pt.from); now.set("to", pt.to); }
    if (!ptHere("stats") || !$("ptStats") || now.toString() !== key) return;
    if (!r.ok) {
      $("ptStats").innerHTML = "";
      return flash("error", errText(r, "Couldn't load the statistics."));
    }
    const { totals: t, partners: p, top, range } = r.data;
    $("ptStats").innerHTML =
      '<h3 class="adm-h">Referred players · ' + esc(range.label) + '</h3><div class="adm-kpis">' +
        kpi("Stakes", money(t.stakes), "settled bets of referred players") +
        kpi("Winnings paid", money(t.payouts), "to referred players") +
        kpi("Net gaming revenue", money(t.ngr), "stakes − winnings", t.ngr >= 0 ? "in" : "bad") +
        kpi("Commission earned", money(t.commission), "revenue share on losing bets") +
        kpi("Win deductions", money(t.negative), "on players' net winnings", t.negative < 0 ? "bad" : "") +
        kpi("Net commission", money(t.net), "earned + deductions", t.net >= 0 ? "in" : "bad") +
        kpi("Active players", count(t.activePlayers), "referred players who settled a bet") +
        kpi("New referrals", count(t.signups), "sign-ups through a partner") +
      "</div>" +
      '<h3 class="adm-h">Partners now</h3><div class="adm-kpis">' +
        kpi("Active partners", count(p.active)) +
        kpi("Applications", count(p.pending), "waiting for you", p.pending ? "warn" : "") +
        kpi("Suspended or disabled", count(p.paused)) +
        kpi("Commission balances", money(p.owed), "available in partners' wallets (open requests already held)") +
        kpi("Paid to partners", money(p.paid), "all time") +
      "</div>" +
      '<h3 class="adm-h">Top partners · ' + esc(range.label) + "</h3>" +
      (top.length
        ? table(["Partner", "Partner ID", "Active players", "NGR", "Net commission"], top.map((x) =>
            '<tr class="adm-trow" data-partner="' + esc(x.user_id) + '" role="button" tabindex="0"><td>' + esc(x.full_name || x.username || "Player") + "</td><td>" + tx(x.code) +
            "</td><td>" + count(x.players) + '</td><td class="' + tone(x.ngr) + '">' + money(x.ngr) + '</td><td class="' + tone(x.net) + '">' + money(x.net) + "</td></tr>"))
        : empty("No partner commission in this period.", "star"));
  }

  /* ---- the programme's settings ---- */
  function partnerSettingsHtml(s, history) {
    const num = (id, label, value, step, min, max, hint) => '<div class="field"><label for="' + id + '">' + label + "</label>" +
      '<input id="' + id + '" type="number" inputmode="decimal" step="' + step + '" min="' + min + '"' + (max !== undefined ? ' max="' + max + '"' : "") +
      ' value="' + esc(String(value)) + '" required>' + (hint ? '<small class="hint">' + hint + "</small>" : "") + "</div>";
    const sw = (id, label, on, hint) => '<div class="adm-pset-sw"><div><b>' + label + "</b><small>" + hint + "</small></div>" +
      '<label class="adm-switch"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") + ' aria-label="' + esc(label) + '"><span aria-hidden="true"></span></label></div>';
    const now = Date.now();
    return '<section class="adm-card"><h3 class="adm-h">Commission settings</h3>' +
      '<p class="adm-note">Partners earn their revenue share % of the net gaming revenue (stakes − winnings) on every losing bet settled by a player they brought in; ' +
      "on every winning bet, the win deduction % of the player's net winnings is taken off. A change applies to bets settled after it takes effect — commission already recorded is never recalculated. " +
      "<b>Each partner's own rate is set on their profile</b> (open a partner → Commission rate).</p>" +
      '<form class="adm-pset" data-form="psettings">' +
        num("psDefault", "Default revenue share (%)", s.default_revshare_pct, "0.01", "0", "90", "Given to a partner when they're approved or added. Doesn't change partners who already have a rate.") +
        num("psDed", "Winning bet deduction (%)", s.win_deduction_pct, "0.01", "0", "100", "Of a referred player's net winnings on a winning bet, taken off the partner's commission. All partners.") +
        '<div class="field"><label for="psDedFrom">Deduction change starts <span class="opt">(optional)</span></label><input id="psDedFrom" type="datetime-local">' +
          '<small class="hint">Empty means now. Now or later only, never in the past.</small></div>' +
        '<div class="field"><label for="psPeriod">Settlement period</label><select id="psPeriod">' +
          [["DAILY", "Daily"], ["WEEKLY", "Weekly (Monday to Sunday)"], ["MONTHLY", "Monthly"]].map(([v, l]) => '<option value="' + v + '"' + (v === s.settlement_period ? " selected" : "") + ">" + l + "</option>").join("") +
          '</select><small class="hint">How often pending commission is closed and credited to partners\' balances (UTC days).</small></div>' +
        num("psMin", "Minimum partner withdrawal (GHS)", s.min_payout, "0.01", "0.01") +
        num("psMax", "Maximum partner withdrawal (GHS)", s.max_payout, "0.01", "0.01") +
        num("psDays", "Referral window (days)", s.referral_days, "1", "0", "365", "How new an account must be for a partner's link or promo code to claim it.") +
        '<div class="adm-pset-sws">' +
          sw("psCarry", "Carry negative balances over", s.carry_negative, "A period that ends below zero is taken off the next periods. Off: it's written off.") +
          sw("psLinks", "Referral links", s.links_enabled, "Off: no partner link brings in players or counts clicks.") +
          sw("psPromos", "Promo codes", s.promo_codes_enabled, "Off: promo codes can't be used at sign-up.") +
          sw("psPromoEdit", "Partners set their own promo code", s.partner_promo_edit, "Off: a partner's choice waits for your approval on their profile.") +
        "</div>" +
        '<button class="btn btn-primary btn-sm" type="submit">Save settings</button></form>' +
      '<p class="adm-note">Last changed ' + (s.updated_by ? when(s.updated_at) + " by " + esc(s.updated_by) : "never (defaults)") + ".</p></section>" +
      '<section class="adm-card"><h3 class="adm-h">Settlement</h3>' +
        '<p class="adm-note">Closed periods settle by themselves a few minutes after they end. This settles any closed period now (for example right after changing the period). Open periods are never settled early.</p>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-psettle>Settle closed periods now</button></section>' +
      '<section class="adm-card"><h3 class="adm-h">Win deduction history</h3>' +
        (history.length
          ? table(["Deduction", "Applies from", "Set by", "Recorded"], history.map((d) => "<tr><td>" + rateOf(d.pct) +
              (d.effective_from && new Date(d.effective_from).getTime() > now ? " " + pill("scheduled", "warn") : "") + "</td><td>" + when(d.effective_from) +
              "</td><td>" + tx(d.set_by || "—") + "</td><td>" + when(d.created_at) + "</td></tr>"))
          : '<p class="me-sheet-note">No changes yet.</p>') + "</section>";
  }
  async function loadPartnerSettings() {
    $("ptBody").innerHTML = loading;
    const r = await api("/partner-settings");
    if (!ptHere("settings")) return;
    if (!r.ok) {
      $("ptBody").innerHTML = "";
      return flash("error", errText(r, "Couldn't load the commission settings."));
    }
    pt.settings = r.data.settings;
    $("ptBody").innerHTML = partnerSettingsHtml(r.data.settings, r.data.deductionHistory || []);
  }
  async function savePartnerSettings(form) {
    const s = pt.settings;
    if (!s) return;
    const el = (id) => form.querySelector("#" + id);
    const body = {};
    [["psDefault", "default_revshare_pct"], ["psDed", "win_deduction_pct"], ["psMin", "min_payout"], ["psMax", "max_payout"], ["psDays", "referral_days"]].forEach(([id, key]) => {
      const v = el(id).value.trim();
      if (v !== "" && Number(v) !== Number(s[key])) body[key] = v;
    });
    if (body.referral_days !== undefined) body.referral_days = Number(body.referral_days);
    if (el("psPeriod").value !== s.settlement_period) body.settlement_period = el("psPeriod").value;
    [["psCarry", "carry_negative"], ["psLinks", "links_enabled"], ["psPromos", "promo_codes_enabled"], ["psPromoEdit", "partner_promo_edit"]].forEach(([id, key]) => {
      if (el(id).checked !== Boolean(s[key])) body[key] = el(id).checked;
    });
    const from = el("psDedFrom").value;
    if (body.win_deduction_pct !== undefined && from) {
      const d = new Date(from);
      if (Number.isNaN(d.getTime())) return flash("error", "Enter a valid date and time for the deduction change.");
      if (d.getTime() < Date.now() - 60000) return flash("error", "The deduction change can start now or later, never in the past.");
      body.effective_from = d.toISOString();
    }
    if (!Object.keys(body).length) return flash("info", "Nothing changed.");
    const lines = [];
    if (body.default_revshare_pct !== undefined) lines.push("Default revenue share " + rateOf(s.default_revshare_pct) + " → <b>" + esc(body.default_revshare_pct) + "%</b> (new partners only)");
    if (body.win_deduction_pct !== undefined) lines.push("Win deduction " + rateOf(s.win_deduction_pct) + " → <b>" + esc(body.win_deduction_pct) + "%</b> from " + (body.effective_from ? when(body.effective_from) : "now") + ", for every partner");
    if (body.links_enabled === false) lines.push("<b>All referral links switched off</b>");
    if (body.promo_codes_enabled === false) lines.push("<b>All promo codes switched off</b>");
    if (body.settlement_period) lines.push("Settlement period → <b>" + esc(body.settlement_period.toLowerCase()) + "</b>");
    if (lines.length) {
      const ok = await ask({ title: "Save these changes?", text: lines.join("<br>") + "<br>Commission already recorded stays as it is.", yes: "Save" });
      if (ok === null) return;
    }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    const r = await api("/partner-settings", body);
    btn.disabled = false;
    if (!r.ok) return flash("error", errText(r, "Couldn't save the settings."));
    flash("ok", "Commission settings saved.");
    loadPartnerSettings();
  }
  async function settleNow(btn) {
    const ok = await ask({ title: "Settle closed periods now?", text: "Pending commission from periods that have already ended is credited to partners' balances (or carried over if negative). Each period is settled only once.", yes: "Settle now" });
    if (ok === null) return;
    btn.disabled = true;
    const r = await api("/partner-settings/settle", {});
    btn.disabled = false;
    flash(r.ok ? "ok" : "error", r.ok
      ? (r.data.settled ? "Settled " + count(r.data.settled) + " partner" + (r.data.settled === 1 ? "" : "s") + "." : "Nothing to settle: no closed period has pending commission (or the period ended less than 5 minutes ago).")
      : errText(r, "Couldn't settle."));
  }

  /* ---- partner features: on or off for every partner (a partner's profile can override each one) ---- */
  const PERM_HINT = {
    dashboard: "Their partner dashboard: summary, earnings and settings.",
    referral_links: "Their referral link and its numbers.",
    promo_codes: "Their promo code, and asking for a new one.",
    referral_stats: "Statistics on the players they brought in.",
    commission_withdrawals: "Asking for commission payouts.",
    wallet_deposits: "Deposits through their partner wallet.",
    flyers: "Making promotional flyers from the templates switched on in Flyers.",
    campaigns: "Adding an active campaign's offer to their flyers.",
    tools_mines: "Mines: the real odds per number of mines and picks, and finished rounds.",
    tools_aviator: "Aviator: the published RTP, odds per multiplier and finished rounds.",
    tools_crash: "Crash and Knockout: odds and finished flights.",
    tools_other: "The other games' published RTP and main odds.",
  };
  async function loadPartnerPermissions() {
    $("ptBody").innerHTML = loading;
    const r = await api("/partner-permissions");
    if (!ptHere("permissions")) return;
    if (!r.ok) {
      $("ptBody").innerHTML = "";
      return flash("error", errText(r, "Couldn't load the partner features."));
    }
    pt.perms = r.data;
    const sw = ({ key, label }) => '<div class="adm-pset-sw"><div><b>' + esc(label) + "</b><small>" + esc(PERM_HINT[key] || "") + "</small></div>" +
      '<label class="adm-switch"><input type="checkbox" data-perm="' + esc(key) + '"' + (r.data.permissions[key] ? " checked" : "") + ' aria-label="' + esc(label) + '"><span aria-hidden="true"></span></label></div>';
    const list = r.data.list || [];
    $("ptBody").innerHTML = '<section class="adm-card"><h3 class="adm-h">Partner features</h3>' +
      '<p class="adm-note">These apply to <b>every partner</b> unless you set a feature differently on a partner\'s profile (open a partner → Permissions). ' +
      "A feature switched off is <b>blocked by the server</b>, not just hidden: the partner's requests for it are refused.</p>" +
      '<form class="adm-pset" data-form="pperms"><div class="adm-pset-sws">' + list.filter((x) => !x.key.startsWith("tools_")).map(sw).join("") + "</div>" +
        '<h3 class="adm-h adm-wide">Game tools</h3>' +
        '<div class="alert alert-info adm-wide">Game tools show each game\'s <b>real odds</b> and the results of rounds that have <b>already finished</b> — never a round in play, a hidden board or anyone\'s balance. ' +
          "Results are drawn by the server with secure randomness and can't be predicted. They're off by default.</div>" +
        '<div class="adm-pset-sws">' + list.filter((x) => x.key.startsWith("tools_")).map(sw).join("") + "</div>" +
        '<button class="btn btn-primary btn-sm" type="submit">Save features</button></form></section>';
  }
  async function savePartnerPermissions(form) {
    if (!pt.perms) return;
    const now = pt.perms.permissions;
    const changes = {};
    const lines = [];
    (pt.perms.list || []).forEach(({ key, label }) => {
      const i = form.querySelector('input[data-perm="' + CSS.escape(key) + '"]');
      if (!i || i.checked === Boolean(now[key])) return;
      changes[key] = i.checked;
      lines.push(esc(label) + " → <b>" + (i.checked ? "on" : "off") + "</b>");
    });
    if (!lines.length) return flash("info", "Nothing changed.");
    const ok = await ask({ title: "Change features for every partner?", text: lines.join("<br>") + "<br>Partners with their own setting for a feature keep it. The server applies this at once.", yes: "Save" });
    if (ok === null) return;
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    const r = await api("/partner-permissions", { permissions: changes });
    btn.disabled = false;
    if (!r.ok) return flash("error", errText(r, "Couldn't save the partner features."));
    flash("ok", "Partner features saved.");
    loadPartnerPermissions();
  }

  /* ---- flyers: the templates partners make flyers from, admin-approved campaigns (the only source of an offer on a
     flyer) and uploaded images. Previews are drawn by the flyer module (assets/js/flyers.js) with a sample partner. ---- */
  const FLY_SAMPLE = { code: "WB7K2Q9X", promo_code: "PREVIEW1" };
  const FLY_THUMB = { w: 540, h: 675 };
  const FLY_BIG = { w: 1080, h: 1350 };
  const SPORTS = ["sports", "football", "basketball"];
  const IMG_TYPES = ["image/png", "image/jpeg", "image/webp"];
  const assetUrl = (id) => U.paymentBase + "/api/partners/assets/" + encodeURIComponent(id);
  const tplOf = (id) => (pt.flyers ? pt.flyers.templates.find((t) => t.id === id) : null);
  const campOf = (id) => (pt.flyers ? pt.flyers.campaigns.find((c) => c.id === id) : null);
  const cfgOf = (t) => {
    if (!t || !t.config) return {};
    if (typeof t.config === "object") return t.config;
    try { return JSON.parse(t.config) || {}; } catch (e) { return {}; }
  };
  const layoutName = (id) => id.charAt(0).toUpperCase() + id.slice(1).replace(/-/g, " ");
  const kb = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1e3)) + " KB");
  /* a datetime-local value (local time) from an ISO date */
  const localInput = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  };
  const assetOptions = (current) => '<option value="">None</option>' + (pt.flyers ? pt.flyers.assets : []).map((a) =>
    '<option value="' + esc(a.id) + '"' + (a.id === current ? " selected" : "") + ">" + esc(a.name) + "</option>").join("");

  /* draws one flyer on a canvas, or says the preview isn't available */
  function drawFlyer(canvas, template, campaign, size) {
    const box = canvas.parentElement;
    const na = box.querySelector(".adm-flprev-na");
    if (na) na.remove();
    canvas.hidden = false;
    const fail = () => {
      canvas.hidden = true;
      if (!box.querySelector(".adm-flprev-na")) box.insertAdjacentHTML("beforeend", '<span class="adm-flprev-na">Preview unavailable</span>');
    };
    if (!window.VBFlyers || typeof window.VBFlyers.render !== "function") return fail();
    canvas.width = size.w;
    canvas.height = size.h;
    try {
      Promise.resolve(window.VBFlyers.render(canvas, { template, campaign: campaign || null, size, partner: FLY_SAMPLE, link: refLink(FLY_SAMPLE.code), assetUrl })).catch(fail);
    } catch (e) {
      fail();
    }
  }
  /* the small previews are drawn as they scroll into view */
  let flyObs = null;
  function lazyPreviews(root) {
    if (flyObs) flyObs.disconnect();
    const go = (c) => { const t = tplOf(c.dataset.flprev); if (t) drawFlyer(c, t, null, FLY_THUMB); };
    const all = root.querySelectorAll("canvas[data-flprev]");
    if (!("IntersectionObserver" in window)) return all.forEach(go);
    flyObs = new IntersectionObserver((seen) => seen.forEach((x) => {
      if (!x.isIntersecting) return;
      flyObs.unobserve(x.target);
      go(x.target);
    }), { rootMargin: "300px" });
    all.forEach((c) => flyObs.observe(c));
  }

  async function loadPartnerFlyers() {
    if (!$("ptBody").innerHTML) $("ptBody").innerHTML = loading;
    const r = await api("/flyers");
    if (!ptHere("flyers")) return;
    if (!r.ok) {
      $("ptBody").innerHTML = "";
      return flash("error", errText(r, "Couldn't load the flyers."));
    }
    pt.flyers = r.data;
    $("ptBody").innerHTML = flyerTemplatesHtml(r.data) + flyerCampaignsHtml(r.data) + flyerAssetsHtml(r.data);
    lazyPreviews($("ptBody"));
  }

  function tplCard(t) {
    const sport = SPORTS.includes(t.id) || SPORTS.includes(cfgOf(t).layout);
    return '<div class="adm-fltpl' + (t.enabled ? "" : " off") + '" data-fltpl="' + esc(t.id) + '">' +
      '<div class="adm-flprev"><canvas data-flprev="' + esc(t.id) + '" role="img" aria-label="Preview of ' + esc(t.name) + '"></canvas></div>' +
      '<div class="adm-fltpl-main"><strong>' + esc(t.name) + "</strong><small>" + esc(t.category) + " · order " + esc(String(t.sort)) + "</small>" +
        '<span class="adm-pills">' + (t.builtin ? pill("Built-in", "") : pill("Custom", "brand")) + (sport ? pill("No sportsbook yet", "warn") : "") + "</span></div>" +
      '<div class="adm-fltpl-act"><label class="adm-switch"><input type="checkbox" data-fltpl-on="' + esc(t.id) + '"' + (t.enabled ? " checked" : "") +
          ' aria-label="' + esc(t.name) + ' on for partners"><span aria-hidden="true"></span></label>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-fl="tpl-edit" data-id="' + esc(t.id) + '">Edit</button>' +
        (t.builtin ? "" : '<button class="btn btn-ghost btn-sm" type="button" data-fl="tpl-del" data-id="' + esc(t.id) + '" data-name="' + esc(t.name) + '">Delete</button>') +
      "</div></div>";
  }
  function flyerTemplatesHtml(f) {
    const on = f.templates.filter((t) => t.enabled).length;
    return '<section class="adm-card"><div class="adm-card-top"><h3 class="adm-h">Flyer templates <small>' + count(on) + " of " + count(f.templates.length) + " on</small></h3>" +
        '<button class="btn btn-primary btn-sm" type="button" data-fl="tpl-add">' + U.icon("plus") + "Add template</button></div>" +
      '<p class="adm-note">Partners make flyers from the templates switched on here, with their own referral link, QR code and promo code. ' +
        "<b>Sports, Football and Basketball are off by default because WIN B has no sportsbook yet</b> — keep them off until it does." +
        (window.VBFlyers ? "" : " <b>Preview unavailable:</b> the flyer module didn't load.") + "</p>" +
      (f.templates.length ? '<div class="adm-fltpls">' + f.templates.map(tplCard).join("") + "</div>" : '<p class="me-sheet-note">No templates.</p>') + "</section>";
  }
  function campState(c) {
    const now = Date.now();
    if (!c.active) return pill("Off", "bad");
    if (c.ends_at && new Date(c.ends_at).getTime() <= now) return pill("Ended", "bad");
    if (c.starts_at && new Date(c.starts_at).getTime() > now) return pill("Scheduled", "warn");
    return pill("Live on flyers", "ok");
  }
  function campRow(c) {
    const ids = Array.isArray(c.template_ids) && c.template_ids.length ? c.template_ids : null;
    const tpls = ids ? ids.map((id) => (tplOf(id) || { name: id }).name).join(", ") : "any template";
    const dates = c.starts_at || c.ends_at
      ? (c.starts_at ? "From " + when(c.starts_at) : "From now") + (c.ends_at ? " until " + when(c.ends_at) : ", no end date")
      : "No dates: runs while active";
    return '<div class="txr-row adm-item adm-flcamp" data-flcamp="' + esc(c.id) + '">' +
      (c.asset_id ? '<img class="adm-flthumb" src="' + esc(assetUrl(c.asset_id)) + '" alt="" loading="lazy">' : '<span class="txr-ico">' + U.icon("star") + "</span>") +
      '<span class="txr-main"><strong>' + esc(c.title) + "</strong>" +
        "<small>Headline <b>" + esc(c.headline) + "</b></small>" +
        (c.offer ? "<small>Offer <b>" + esc(c.offer) + "</b></small>" : "<small>No offer</small>") +
        "<small>" + dates + " · " + esc(tpls) + "</small>" +
        '<span class="adm-pills">' + campState(c) + "</span></span>" +
      '<span class="adm-item-actions"><label class="adm-switch"><input type="checkbox" data-flcamp-on="' + esc(c.id) + '"' + (c.active ? " checked" : "") +
          ' aria-label="' + esc(c.title) + ' active"><span aria-hidden="true"></span></label>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-fl="camp-edit" data-id="' + esc(c.id) + '">Edit</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-fl="camp-del" data-id="' + esc(c.id) + '" data-name="' + esc(c.title) + '">Delete</button></span></div>';
  }
  function flyerCampaignsHtml(f) {
    return '<section class="adm-card"><div class="adm-card-top"><h3 class="adm-h">Campaigns</h3>' +
        '<button class="btn btn-primary btn-sm" type="button" data-fl="camp-add">' + U.icon("plus") + "New campaign</button></div>" +
      '<p class="adm-note">Offers and bonuses appear on partners\' flyers <b>only from active campaigns, exactly as written here</b> — partners can\'t type their own. ' +
        "A flyer is always drawn with the campaign's current wording, so new flyers (and saved ones made again) use what's here now; switching a campaign off or letting it end takes its offer off flyers.</p>" +
      (f.campaigns.length ? '<div class="txr-group">' + f.campaigns.map(campRow).join("") + "</div>" : empty("No campaigns yet. Without one, flyers carry no offer.", "star")) + "</section>";
  }
  function flyerAssetsHtml(f) {
    return '<section class="adm-card"><h3 class="adm-h">Images</h3>' +
      '<p class="adm-note">Backgrounds and pictures for templates and campaigns: PNG, JPG or WebP, up to 2 MB. Anyone with an image\'s link can see it, so upload promotional images only.</p>' +
      '<form class="adm-flup" data-form="flupload">' +
        fld("flFile", "Image", '<input id="flFile" type="file" accept="image/png,image/jpeg,image/webp" required>') +
        fld("flName", "Name" + OPT, '<input id="flName" type="text" maxlength="80" autocomplete="off" placeholder="e.g. Gold coins background">') +
        '<button class="btn btn-primary btn-sm" type="submit">Upload</button></form>' +
      (f.assets.length
        ? '<div class="adm-flassets">' + f.assets.map((a) => '<figure class="adm-flasset"><img src="' + esc(assetUrl(a.id)) + '" alt="' + esc(a.name) + '" loading="lazy">' +
            "<figcaption><b>" + esc(a.name) + "</b><small>" + kb(Number(a.size)) + " · " + dayOf(a.created_at) + "</small></figcaption>" +
            '<button class="btn btn-ghost btn-sm" type="button" data-fl="asset-del" data-id="' + esc(a.id) + '" data-name="' + esc(a.name) + '">Delete</button></figure>').join("") + "</div>"
        : '<p class="me-sheet-note">No images yet.</p>') + "</section>";
  }

  /* add a template (from a built-in design) or change one; built-in designs only get a name, category and order */
  function openTemplate(id, base) {
    if (!pt.flyers) return;
    const t = id ? tplOf(id) : null;
    if (id && !t) return;
    const custom = !t || !t.builtin;
    const layouts = pt.flyers.layouts || [];
    const c = t ? cfgOf(t) : { layout: layouts.includes(base) ? base : "general" };
    const own = !(c.primary || c.accent || c.background);
    const s = sheet(t ? "Edit template" : "Add a flyer template");
    const msg = '<div class="adm-sheet-msg" aria-live="polite"></div>';
    const color = (cid, label, v) => '<div class="field"><label for="' + cid + '">' + label + '</label><input id="' + cid + '" type="color" value="' + esc(v) + '"' + (own ? " disabled" : "") + "></div>";
    s.set('<div class="adm-flbig"><canvas id="ftPrev" role="img" aria-label="Preview"></canvas></div>' +
      '<p class="hint">Preview with a sample partner (Partner ID ' + FLY_SAMPLE.code + ", promo code " + FLY_SAMPLE.promo_code + ").</p>" +
      '<form class="adm-flform" data-form="fltpl" autocomplete="off" novalidate>' +
        fld("ftName", "Name", '<input id="ftName" type="text" maxlength="60" required value="' + tx(t ? t.name : "") + '">') +
        fld("ftCat", "Category" + (t ? "" : OPT), '<input id="ftCat" type="text" maxlength="30" value="' + tx(t ? t.category : "") + '" placeholder="Custom">') +
        (t ? fld("ftSort", "Order", '<input id="ftSort" type="number" step="1" inputmode="numeric" value="' + esc(String(t.sort)) + '">', "Lower numbers come first for partners.") : "") +
        (custom
          ? fld("ftLayout", "Based on design", '<select id="ftLayout">' + layouts.map((l) => '<option value="' + esc(l) + '"' + (l === c.layout ? " selected" : "") + ">" + esc(layoutName(l)) +
              (SPORTS.includes(l) ? " (no sportsbook yet)" : "") + "</option>").join("") + "</select>") +
            fld("ftAsset", "Background image" + OPT, '<select id="ftAsset">' + assetOptions(c.asset_id) + "</select>", "Upload images under Images.") +
            '<div class="adm-wide adm-flcolors"><label class="adm-check"><input type="checkbox" id="ftOwn"' + (own ? " checked" : "") + "> Use the design's own colours</label>" +
              '<div class="adm-flcolor-row">' + color("ftPrimary", "Primary", c.primary || "#ffc83d") + color("ftAccent", "Accent", c.accent || "#34d77a") +
              color("ftBg", "Background", c.background || "#0d0e10") + "</div></div>" +
            fld("ftHead", "Headline" + OPT, '<input id="ftHead" type="text" maxlength="60" value="' + tx(c.headline) + '" placeholder="The design\'s own">', "", true) +
            fld("ftTag", "Tagline" + OPT, '<input id="ftTag" type="text" maxlength="120" value="' + tx(c.tagline) + '">', "", true) +
            fld("ftCta", "Button words" + OPT, '<input id="ftCta" type="text" maxlength="24" value="' + tx(c.cta) + '" placeholder="Join now">') +
            '<p class="hint adm-wide">No bonuses or offers here: an offer can only come from an active campaign.</p>'
          : '<p class="adm-note adm-wide">Built-in designs are drawn by the page and can\'t be redrawn. ' +
            '<button class="link-btn adm-link" type="button" data-fl-copy>Add a custom template based on it</button> to change its colours, image or words.</p>') +
        '<button class="btn btn-primary adm-wide" type="submit">' + (t ? "Save template" : "Add template") + "</button></form>" + msg);
    const g = (x) => s.body.querySelector("#" + x);
    const say = (html) => (s.body.querySelector(".adm-sheet-msg").innerHTML = html ? "<div class='alert alert-err'>" + html + "</div>" : "");
    const config = () => {
      const out = { layout: g("ftLayout").value, headline: g("ftHead").value.trim(), tagline: g("ftTag").value.trim(), cta: g("ftCta").value.trim() };
      if (!g("ftOwn").checked) { out.primary = g("ftPrimary").value; out.accent = g("ftAccent").value; out.background = g("ftBg").value; }
      if (g("ftAsset").value) out.asset_id = g("ftAsset").value;
      return out;
    };
    const preview = () => drawFlyer(g("ftPrev"), custom
      ? { id: t ? t.id : "preview", name: g("ftName").value.trim() || "Preview", category: g("ftCat").value.trim() || "Custom", builtin: false, enabled: true, config: config() }
      : t, null, FLY_BIG);
    let timer = 0;
    s.body.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(preview, 250); });
    s.body.addEventListener("change", (e) => {
      if (e.target.id === "ftOwn") ["ftPrimary", "ftAccent", "ftBg"].forEach((x) => (g(x).disabled = e.target.checked));
      clearTimeout(timer);
      timer = setTimeout(preview, 100);
    });
    s.body.addEventListener("click", (e) => {
      if (!e.target.closest("[data-fl-copy]")) return;
      s.close();
      openTemplate(null, c.layout || t.id);
    });
    s.body.addEventListener("submit", async (e) => {
      e.preventDefault();
      say("");
      const name = g("ftName").value.trim();
      if (name.length < 3) return say("Give the template a name (at least 3 characters).");
      const body = { name, category: g("ftCat").value.trim() };
      if (t) {
        const sort = g("ftSort").value.trim();
        if (sort !== "" && !Number.isInteger(Number(sort))) return say("The order is a whole number.");
        if (sort !== "") body.sort = Number(sort);
      }
      if (custom) body.config = config();
      const btn = e.target.querySelector("button[type=submit]");
      btn.disabled = true;
      const r = await api(t ? "/flyer-templates/" + encodeURIComponent(t.id) : "/flyer-templates", body);
      btn.disabled = false;
      if (!r.ok) return say(errText(r, "Couldn't save the template."));
      s.close();
      flash("ok", t ? "Template saved." : "Template added and switched on for partners.");
      if (ptHere("flyers")) loadPartnerFlyers();
    });
    g("ftName").focus();
    requestAnimationFrame(preview);
  }

  /* a promotional campaign: the approved wording (and offer) partners can put on flyers */
  function openCampaign(id) {
    if (!pt.flyers) return;
    const c = id ? campOf(id) : null;
    if (id && !c) return;
    const s = sheet(c ? "Edit campaign" : "New campaign");
    const msg = '<div class="adm-sheet-msg" aria-live="polite"></div>';
    const chosen = c && Array.isArray(c.template_ids) ? c.template_ids : [];
    const tpls = pt.flyers.templates;
    s.set('<div class="adm-flbig"><canvas id="fcPrev" role="img" aria-label="Preview"></canvas></div>' +
      '<div class="field"><label for="fcPrevTpl">Preview on</label><select id="fcPrevTpl">' +
        tpls.filter((t) => t.enabled).map((t) => '<option value="' + esc(t.id) + '"' + (chosen[0] === t.id ? " selected" : "") + ">" + esc(t.name) + "</option>").join("") + "</select></div>" +
      '<p class="hint">The words below are exactly what partners\' flyers show — new flyers always use the current wording.</p>' +
      '<form class="adm-flform" data-form="flcamp" autocomplete="off" novalidate>' +
        fld("fcTitle", "Campaign name", '<input id="fcTitle" type="text" maxlength="80" required value="' + tx(c && c.title) + '" placeholder="e.g. October weekend">', "Partners see it when choosing a campaign.", true) +
        fld("fcHead", "Headline", '<input id="fcHead" type="text" maxlength="60" required value="' + tx(c && c.headline) + '" placeholder="e.g. Play this weekend">', "", true) +
        fld("fcOffer", "Offer or bonus" + OPT, '<input id="fcOffer" type="text" maxlength="80" value="' + tx(c && c.offer) + '">', "Only what the casino actually gives — it's printed word for word.", true) +
        fld("fcBody", "Supporting text" + OPT, '<input id="fcBody" type="text" maxlength="160" value="' + tx(c && c.body) + '">', "", true) +
        fld("fcCta", "Button words" + OPT, '<input id="fcCta" type="text" maxlength="24" value="' + tx(c && c.cta) + '" placeholder="Join now">') +
        fld("fcAsset", "Image" + OPT, '<select id="fcAsset">' + assetOptions(c && c.asset_id) + "</select>") +
        fld("fcTerms", "Terms (small print)" + OPT, '<input id="fcTerms" type="text" maxlength="200" value="' + tx(c && c.terms) + '" placeholder="e.g. 18+. T&amp;Cs apply.">', "", true) +
        fld("fcFrom", "Starts" + OPT, '<input id="fcFrom" type="datetime-local" value="' + esc(localInput(c && c.starts_at)) + '">', "Empty: straight away.") +
        fld("fcTo", "Ends" + OPT, '<input id="fcTo" type="datetime-local" value="' + esc(localInput(c && c.ends_at)) + '">', "Empty: no end date.") +
        '<div class="adm-wide">' + fold("Templates it suits <small>" + (chosen.length ? count(chosen.length) + " chosen" : "any") + "</small>", null,
          '<p class="hint">None ticked: any template.</p><div class="adm-fltplpick">' + tpls.map((t) => '<label class="adm-check"><input type="checkbox" data-fctpl="' + esc(t.id) + '"' +
            (chosen.includes(t.id) ? " checked" : "") + "> " + esc(t.name) + (t.enabled ? "" : " <small>(off)</small>") + "</label>").join("") + "</div>") + "</div>" +
        '<div class="adm-pset-sw adm-wide"><div><b>Active</b><small>Partners can use it between its dates.</small></div>' +
          '<label class="adm-switch"><input type="checkbox" id="fcActive"' + (!c || c.active ? " checked" : "") + ' aria-label="Active"><span aria-hidden="true"></span></label></div>' +
        '<button class="btn btn-primary adm-wide" type="submit">' + (c ? "Save campaign" : "Create campaign") + "</button></form>" + msg);
    const g = (x) => s.body.querySelector("#" + x);
    const say = (html) => (s.body.querySelector(".adm-sheet-msg").innerHTML = html ? "<div class='alert alert-err'>" + html + "</div>" : "");
    const val = (x) => g(x).value.trim();
    const iso = (x) => (val(x) ? new Date(val(x)) : null);
    const draft = () => ({ id: c ? c.id : "preview", title: val("fcTitle"), headline: val("fcHead"), offer: val("fcOffer") || null, body: val("fcBody") || null,
      cta: val("fcCta") || "Join now", terms: val("fcTerms") || null, asset_id: g("fcAsset").value || null });
    const preview = () => {
      const t = tplOf(g("fcPrevTpl").value);
      if (t) drawFlyer(g("fcPrev"), t, draft(), FLY_BIG);
      else g("fcPrev").hidden = true;
    };
    let timer = 0;
    const later = () => { clearTimeout(timer); timer = setTimeout(preview, 250); };
    s.body.addEventListener("input", later);
    s.body.addEventListener("change", later);
    s.body.addEventListener("submit", async (e) => {
      e.preventDefault();
      say("");
      const d = draft();
      if (d.title.length < 3) return say("Enter the campaign name (at least 3 characters).");
      if (d.headline.length < 3) return say("Enter the headline (at least 3 characters).");
      const from = iso("fcFrom");
      const to = iso("fcTo");
      if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) return say("Enter valid dates.");
      if (from && to && to <= from) return say("The end must be after the start.");
      const ids = Array.from(s.body.querySelectorAll("input[data-fctpl]:checked")).map((x) => x.dataset.fctpl);
      const body = { title: d.title, headline: d.headline, offer: d.offer || "", body: d.body || "", cta: val("fcCta"), terms: d.terms || "", asset_id: d.asset_id,
        template_ids: ids.length ? ids : null, active: g("fcActive").checked, starts_at: from ? from.toISOString() : null, ends_at: to ? to.toISOString() : null };
      const btn = e.target.querySelector("button[type=submit]");
      btn.disabled = true;
      const r = await api(c ? "/flyer-campaigns/" + encodeURIComponent(c.id) : "/flyer-campaigns", body);
      btn.disabled = false;
      if (!r.ok) return say(errText(r, "Couldn't save the campaign."));
      s.close();
      flash("ok", c ? "Campaign saved. New flyers use the new wording." : "Campaign created.");
      if (ptHere("flyers")) loadPartnerFlyers();
    });
    g("fcTitle").focus();
    requestAnimationFrame(preview);
  }

  async function uploadFlyerAsset(form) {
    const file = form.querySelector("#flFile").files[0];
    if (!file) return flash("error", "Choose an image to upload.");
    if (!IMG_TYPES.includes(file.type)) return flash("error", "Upload a PNG, JPG or WebP image.");
    if (file.size > 2000000) return flash("error", "Images can be up to 2 MB — this one is " + kb(file.size) + ".");
    const data = await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(file);
    });
    if (!data) return flash("error", "Couldn't read that file.");
    const name = form.querySelector("#flName").value.trim() || file.name.replace(/\.[^.]+$/, "");
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    const r = await api("/flyer-assets", { name, data });
    btn.disabled = false;
    if (!r.ok) return flash("error", errText(r, "Couldn't upload the image."));
    flash("ok", "Image uploaded: " + esc(r.data.asset.name) + ".");
    if (ptHere("flyers")) loadPartnerFlyers();
  }

  /* the Flyers view's buttons */
  async function flyerAction(b) {
    const act = b.dataset.fl;
    const id = b.dataset.id;
    const name = esc(b.dataset.name || "");
    if (act === "tpl-add") return openTemplate(null);
    if (act === "tpl-edit") return openTemplate(id);
    if (act === "camp-add") return openCampaign(null);
    if (act === "camp-edit") return openCampaign(id);
    let req;
    if (act === "tpl-del") {
      if ((await ask({ title: "Delete " + name + "?", text: "Partners can't make flyers with it any more, and flyers they saved with it are removed.", yes: "Delete", danger: true })) === null) return;
      req = ["/flyer-templates/" + encodeURIComponent(id) + "/delete", {}, "Template deleted."];
    } else if (act === "camp-del") {
      if ((await ask({ title: "Delete " + name + "?", text: "Its offer and wording come off every flyer at once. To pause it instead, switch it off.", yes: "Delete", danger: true })) === null) return;
      req = ["/flyer-campaigns/" + encodeURIComponent(id), { delete: true }, "Campaign deleted."];
    } else if (act === "asset-del") {
      const f = pt.flyers || { templates: [], campaigns: [] };
      const used = f.templates.filter((t) => cfgOf(t).asset_id === id).length + f.campaigns.filter((c) => c.asset_id === id).length;
      if ((await ask({ title: "Delete " + name + "?", text: used ? "It's used by " + count(used) + " template" + (used === 1 ? "" : "s") + " or campaign" + (used === 1 ? "" : "s") + ", which will show without it." : "It isn't used by any template or campaign.", yes: "Delete", danger: true })) === null) return;
      req = ["/flyer-assets/" + encodeURIComponent(id) + "/delete", {}, "Image deleted."];
    } else return;
    b.disabled = true;
    const r = await api(req[0], req[1]);
    b.disabled = false;
    flash(r.ok ? "ok" : "error", r.ok ? req[2] : errText(r, "Couldn't delete it."));
    if (r.ok && ptHere("flyers")) loadPartnerFlyers();
  }
  /* switching a template on or off, or a campaign active or not */
  async function flyerToggle(input) {
    const on = input.checked;
    const tid = input.dataset.fltplOn;
    if (tid) {
      const t = tplOf(tid);
      if (!t) return;
      if (on && (SPORTS.includes(t.id) || SPORTS.includes(cfgOf(t).layout))) {
        const ok = await ask({ title: "Switch on " + esc(t.name) + "?", text: "WIN B has no sportsbook yet, so a sports flyer would advertise something players can't find.", yes: "Switch on anyway", danger: true });
        if (ok === null) { input.checked = false; return; }
      }
      input.disabled = true;
      const r = await api("/flyer-templates/" + encodeURIComponent(tid), { enabled: on });
      input.disabled = false;
      if (!r.ok) { input.checked = !on; return flash("error", errText(r, "Couldn't change the template.")); }
      t.enabled = on;
      const card = input.closest(".adm-fltpl");
      if (card) card.classList.toggle("off", !on);
      return flash("ok", esc(t.name) + (on ? " is on for partners." : " is off: partners can't make new flyers with it, and their saved ones with it are hidden."));
    }
    const c = campOf(input.dataset.flcampOn);
    if (!c) return;
    input.disabled = true;
    const r = await api("/flyer-campaigns/" + encodeURIComponent(c.id), { active: on });
    input.disabled = false;
    if (!r.ok) { input.checked = !on; return flash("error", errText(r, "Couldn't change the campaign.")); }
    Object.assign(c, r.data.campaign || { active: on });
    const row = input.closest(".adm-flcamp");
    if (row) row.outerHTML = campRow(c);
    flash("ok", esc(c.title) + (on ? " is active: partners can use it on flyers." : " is off: its offer is off every flyer."));
  }

  /* ---- "Add partner": a brand-new partner account (sign-in account, wallet and partner account in one go), or, as a
     second way, a player who already has an account made a partner ---- */
  const fld = (id, label, input, hint, wide) => '<div class="field' + (wide ? " adm-wide" : "") + '"><label for="' + id + '">' + label + "</label>" + input +
    (hint ? '<small class="hint">' + hint + "</small>" : "") + "</div>";
  const OPT = ' <span class="opt">(optional)</span>';
  const pad2 = (n) => String(n).padStart(2, "0");
  /* the latest date of birth that is 18 or older today, as YYYY-MM-DD */
  /* the link to send a new partner, with what it gives them; used after making a link and after "New link" */
  function inviteLinkHtml(d) {
    const i = d.invite;
    const link = setupLink(d.token);
    const msg = "Hello! You're invited to become a WIN B casino partner (" + rateOf(i.revshare_pct) + " revenue share). " +
      "Open this link to set up your partner account: " + link + "\nIt works once, for your number " + i.phone + ", until " + dayOf(i.expires_at) + ".";
    return '<div class="alert alert-ok">Setup link ready for <b>' + tx(i.phone) + "</b>. Send it to the partner privately.</div>" +
      '<div class="apt-linkbox" data-pi-result>' +
        '<span class="prt-label">Partner setup link</span>' +
        '<div class="apt-linkrow"><input id="piLink" readonly value="' + esc(link) + '" aria-label="Partner setup link">' +
          '<button class="btn btn-primary btn-sm" type="button" data-copy="' + esc(link) + '">' + U.icon("copy") + "Copy link</button></div>" +
        '<div class="apt-linkacts">' +
          '<a class="btn btn-ghost btn-sm" href="https://wa.me/?text=' + encodeURIComponent(msg) + '" target="_blank" rel="noopener">' + U.icon("chat") + "Send on WhatsApp</a>" +
          '<button class="btn btn-ghost btn-sm" type="button" data-copy="' + esc(msg) + '">' + U.icon("copy") + "Copy message</button></div>" +
      "</div>" +
      '<dl class="apt-facts">' +
        "<div><dt>Number</dt><dd>" + tx(i.phone) + "</dd></div>" +
        "<div><dt>Commission</dt><dd>" + rateOf(i.revshare_pct) + " revenue share</dd></div>" +
        "<div><dt>Valid until</dt><dd>" + dayOf(i.expires_at) + " · works once</dd></div>" +
      "</dl>" +
      (d.existingAccount ? '<p class="adm-credit-note">This number already has a player account: when they open the link, they log in to it and accept — their account becomes a partner account.</p>'
        : '<p class="adm-credit-note">They open the link, enter their name, username, password and date of birth, and land on their partner dashboard. They choose their promo code there.</p>') +
      '<p class="adm-credit-note adm-credit-warn">The link is shown only now. If it\'s lost, make a new one under Partners → Invitations.</p>';
  }
  function showInviteLink(d) {
    const s = sheet("Partner setup link");
    s.set(inviteLinkHtml(d) + '<div class="adm-actions-box"><button class="btn btn-ghost btn-sm" type="button" data-close-sheet>Done</button></div>');
    s.body.addEventListener("click", (e) => {
      const cp = e.target.closest("[data-copy]");
      if (cp) return copyText(cp.dataset.copy, cp.dataset.copy.startsWith("http") ? "Setup link copied." : "Message copied.");
      if (e.target.closest("[data-close-sheet]")) s.close();
    });
  }

  const PERM_LABEL = { dashboard: "Partner dashboard", referral_links: "Referral links", promo_codes: "Promo codes", referral_stats: "Referral statistics",
    commission_withdrawals: "Commission withdrawals", wallet_deposits: "Wallet deposits", flyers: "Flyer generator", campaigns: "Promotional campaigns",
    tools_mines: "Mines tools", tools_aviator: "Aviator tools", tools_crash: "Crash tools", tools_other: "Other game tools" };
  function openAddPartner() {
    const s = sheet("Add a partner");
    const settings = api("/partner-settings");
    const perms = api("/partner-permissions");
    const msg = '<div class="adm-sheet-msg" aria-live="polite"></div>';
    const say = (html, kind) => {
      const box = s.body.querySelector(".adm-sheet-msg");
      if (box) box.innerHTML = html ? "<div class='alert alert-" + (kind || "err") + "'>" + html + "</div>" : "";
    };
    let global = null;

    /* the usual way: a number, a commission and the features; the partner registers through the link */
    async function showInvite() {
      s.set('<p class="adm-credit-note adm-padd-lead">Enter the partner\'s number, their commission and what they can use. You get a secure link to send them; they open it and set up their own account.</p>' +
        '<form class="apt-addform" data-form="pinvite" autocomplete="off" novalidate>' +
          '<div class="apt-add-row">' +
            fld("piPhone", "Partner's mobile number", '<input id="piPhone" type="tel" inputmode="tel" maxlength="20" autocomplete="off" placeholder="024 123 4567" required>') +
            fld("piPct", "Commission (%)", '<input id="piPct" type="number" inputmode="decimal" min="0" max="90" step="0.01" required>', "Revenue share, 0–90%.") +
          "</div>" +
          '<div class="apt-perms" id="piPerms">' + loading + "</div>" +
          '<button class="btn btn-primary btn-block" type="submit">' + U.icon("link") + "Create partner</button>" +
        "</form>" + msg +
        '<p class="adm-padd-alt"><button class="link-btn" type="button" data-padd-mode="existing">Already a player? Make an existing account a partner directly</button></p>');
      s.body.querySelector("#piPhone").focus();
      const [st, pr] = await Promise.all([settings, perms]);
      const pctIn = s.body.querySelector("#piPct");
      if (pctIn && st.ok && pctIn.value === "") pctIn.value = st.data.settings.default_revshare_pct;
      const box = s.body.querySelector("#piPerms");
      if (!box) return;
      if (!pr.ok) return (box.innerHTML = '<p class="me-sheet-note">' + errText(pr, "Couldn't load the features — the partner gets the defaults.") + "</p>");
      global = pr.data.permissions;
      const sw = ({ key, label }) => {
        return '<label class="apt-perm"><span><b>' + esc(label) + "</b><small>" + esc(PERM_HINT[key] || "") + "</small></span>" +
          '<span class="adm-switch"><input type="checkbox" data-piperm="' + esc(key) + '"' + (global[key] ? " checked" : "") + '><span aria-hidden="true"></span></span></label>';
      };
      box.innerHTML = '<span class="prt-label">Features</span><div class="apt-perm-grid">' + pr.data.list.filter((x) => !x.key.startsWith("tools_")).map(sw).join("") + "</div>" +
        '<span class="prt-label">Game tools <small>(real odds and finished rounds only)</small></span><div class="apt-perm-grid">' + pr.data.list.filter((x) => x.key.startsWith("tools_")).map(sw).join("") + "</div>" +
        '<p class="hint">Switched on now as for every partner. Change any for this partner; you can change them later on their profile.</p>';
    }

    async function submitInvite(form) {
      say("");
      const phone = form.querySelector("#piPhone").value.trim();
      const pctv = form.querySelector("#piPct").value.trim();
      if (phone.replace(/\D/g, "").length < 9) return say("Enter the partner's mobile number.");
      if (pctv === "" || !(Number(pctv) >= 0 && Number(pctv) <= 90)) return say("Enter a commission from 0% to 90%.");
      const body = { phone, revshare_pct: pctv };
      if (global) {
        const own = {};
        form.querySelectorAll("input[data-piperm]").forEach((i) => { if (i.checked !== Boolean(global[i.dataset.piperm])) own[i.dataset.piperm] = i.checked; });
        if (Object.keys(own).length) body.permissions = own;
      }
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      const r = await api("/partner-invites", body);
      btn.disabled = false;
      if (!r.ok) return say(errText(r, "Couldn't create the setup link."));
      s.set(inviteLinkHtml(r.data) +
        '<div class="adm-actions-box"><button class="btn btn-ghost btn-sm" type="button" data-padd-mode="invite">Add another partner</button>' +
          '<button class="btn btn-ghost btn-sm" type="button" data-close-sheet>Done</button></div>');
      if (state.tab === "partners") loadPartners();
    }

    /* the second way: find a registered player and make them a partner */
    function showExisting(q) {
      s.set('<form class="adm-padd" data-form="plookup" autocomplete="off">' +
          '<div class="field"><label for="paQ">Find a registered player</label><input id="paQ" type="search" maxlength="120" placeholder="Phone number, username or email" required></div>' +
          '<button class="btn btn-primary" type="submit">Find</button></form>' +
        msg + '<div id="paFound"></div>' +
        '<p class="adm-credit-note">The player becomes an active partner straight away, with a referral link and a Partner ID. They earn the revenue share you set of the net gaming revenue from players they bring in, less the win deduction on those players\' net winnings.</p>' +
        '<p class="adm-padd-alt"><button class="link-btn" type="button" data-padd-mode="invite">Back: make a partner setup link</button></p>');
      const input = s.body.querySelector("#paQ");
      input.focus();
      if (q) {
        input.value = q;
        s.body.querySelector('form[data-form="plookup"] button[type=submit]').click();
      }
    }
    const card = (u, def) => {
      const name = u.full_name || u.username || "Player";
      return '<div class="adm-pfound-card">' + avatar(name) + '<div class="adm-pfound-main"><strong>' + esc(name) + "</strong>" +
        "<small>" + [u.full_name && u.username ? esc(u.username) : "", tx(u.phone), tx(u.email)].filter(Boolean).join(" · ") + "</small>" +
        "<small>Joined " + when(u.joined) + " " + (u.status && u.status !== "ACTIVE" ? statusPill(u.status) : "") + "</small></div>" +
        (u.partner_status
          ? '<div class="adm-pfound-act">' + pill("Already a partner · " + u.partner_status.toLowerCase(), "brand") +
            '<button class="btn btn-ghost btn-sm" type="button" data-open-partner="' + esc(u.user_id) + '">Open partner profile</button></div>'
          : '<div class="adm-pfound-act"><div class="field"><label for="paPct-' + esc(u.user_id) + '">Revenue share (%)</label>' +
            '<input id="paPct-' + esc(u.user_id) + '" type="number" inputmode="decimal" min="0" max="90" step="0.01" value="' + esc(def === null ? "" : String(def)) + '"></div>' +
            '<button class="btn btn-primary btn-sm" type="button" data-make="' + esc(u.user_id) + '" data-name="' + esc(name) + '">Make partner</button></div>') +
        "</div>";
    };
    async function lookup() {
      say("");
      const q = s.body.querySelector("#paQ").value.trim();
      if (q.length < 3) return say("Enter at least 3 characters: a phone number, username or email.");
      const found = s.body.querySelector("#paFound");
      found.innerHTML = loading;
      const [r, st] = await Promise.all([api("/partner-lookup?q=" + encodeURIComponent(q)), settings]);
      if (!s.body.contains(found)) return;
      const def = st.ok ? st.data.settings.default_revshare_pct : null;
      if (!r.ok) {
        found.innerHTML = "";
        return say(errText(r, "Couldn't find that player."));
      }
      found.innerHTML = '<div class="adm-pfound">' + r.data.players.map((u) => card(u, def)).join("") + "</div>";
    }
    async function make(b) {
      say("");
      const id = b.dataset.make;
      const pct = s.body.querySelector("#paPct-" + CSS.escape(id)).value.trim();
      if (pct === "" || !(Number(pct) >= 0 && Number(pct) <= 90)) return say("Enter a revenue share from 0% to 90%.");
      const ok = await ask({ title: "Make " + esc(b.dataset.name) + " a partner?",
        text: "They become an active partner now on <b>" + esc(pct) + "%</b> revenue share of the net gaming revenue from players they bring in, with a new referral link and Partner ID.", yes: "Make partner" });
      if (ok === null) return;
      b.disabled = true;
      const r = await api("/partners/" + encodeURIComponent(id), { status: "ACTIVE", revshare_pct: pct });
      if (!r.ok) {
        b.disabled = false;
        return say(errText(r, "Couldn't make them a partner."));
      }
      s.close();
      flash("ok", esc(b.dataset.name) + " is now a partner (Partner ID " + esc(r.data.code) + "). " + refLinkNote(r.data.code));
      refreshBadges();
      if (state.tab === "partners") loadPartners();
      openPartner(id);
    }

    s.body.addEventListener("submit", (e) => {
      if (e.target.matches('form[data-form="pinvite"]')) { e.preventDefault(); return submitInvite(e.target); }
      if (e.target.matches('form[data-form="plookup"]')) { e.preventDefault(); return lookup(); }
    });
    s.body.addEventListener("click", async (e) => {
      const mode = e.target.closest("[data-padd-mode]");
      if (mode) return mode.dataset.paddMode === "existing" ? showExisting(mode.dataset.q || "") : showInvite();
      if (e.target.closest("[data-close-sheet]")) return s.close();
      const cp = e.target.closest("[data-copy]");
      if (cp) return copyText(cp.dataset.copy, cp.dataset.copy.startsWith("http") ? "Setup link copied." : "Copied.");
      const open = e.target.closest("[data-open-partner]");
      if (open) {
        s.close();
        return openPartner(open.dataset.openPartner);
      }
      const b = e.target.closest("[data-make]");
      if (b) return make(b);
    });
    showInvite();
  }

  /* ---- one partner's profile: account, link and promo code, totals, statistics, money, history, and every action ---- */
  async function openPartner(userId) {
    const s = sheet("Partner");
    const uid = encodeURIComponent(userId);
    let cur = null;
    let perms = null; /* {effective, global, overrides, list}, or the reason it could not load */
    let permsErr = "";
    /* each feature: Default (follows the setting for every partner), On or Off for this partner, and what applies now */
    const permsHtml = () => {
      if (!perms) return "<p class='me-sheet-note'>" + (permsErr || "Couldn't load the permissions.") + "</p>";
      const ov = perms.overrides || {};
      return '<form class="adm-pperms" data-pf="perms"><p class="hint">Default follows the setting for every partner (Partners → Permissions); On or Off here is for this partner only. ' +
        "A feature that's off is blocked by the server, not just hidden.</p>" +
        perms.list.map(({ key, label }) => {
          const now = key in ov ? (ov[key] ? "on" : "off") : "";
          const opt = (v, l) => '<label><input type="radio" name="pp-' + esc(key) + '" value="' + v + '" data-pperm="' + esc(key) + '"' + (v === now ? " checked" : "") + "><span>" + l + "</span></label>";
          return '<div class="adm-pperm"><div class="adm-pperm-name"><b>' + esc(label) + "</b>" + (perms.effective[key] ? pill("On", "ok") : pill("Off", "bad")) +
              (key in ov ? "<small>set for this partner</small>" : "<small>default</small>") + "</div>" +
            '<div class="adm-seg" role="radiogroup" aria-label="' + esc(label) + '">' + opt("", "Default (" + (perms.global[key] ? "on" : "off") + ")") + opt("on", "On") + opt("off", "Off") + "</div></div>";
        }).join("") +
        '<button class="btn btn-primary btn-sm" type="submit">Save permissions</button></form>';
    };
    const statRow = (x, label) => "<tr><td>" + label + "</td><td>" + count(x.signups) + "</td><td>" + (x.activePlayers === null ? "—" : count(x.activePlayers)) + "</td><td>" + money(x.stakes) +
      "</td><td>" + money(x.payouts) + '</td><td class="' + tone(x.ngr) + '">' + money(x.ngr) + "</td><td>" + money(x.commission) + '</td><td class="' + tone(x.negative) + '">' +
      money(x.negative) + '</td><td class="' + tone(x.earnings) + '"><b>' + money(x.earnings) + "</b></td></tr>";
    const STAT_HEADS = ["Period", "Sign-ups", "Active players", "Stakes", "Payouts", "NGR", "Commission", "Deductions", "Net"];
    const sum = (rows, k) => rows.reduce((a, x) => a + Number(x[k] || 0), 0);
    const statTable = (rows, footLabel, foot) => table(STAT_HEADS, rows.slice().reverse().map((x) => statRow(x, bucket(x.date))),
      foot ? statRow(foot, "<b>" + footLabel + "</b>") : "");

    function html(d) {
      const { partner: p, rate: rt, lifetime: lt, wallet: w } = d;
      const name = p.full_name || p.username || "Player";
      const link = refLink(p.code);
      const st = p.status;
      const btn = (cls, attrs, label) => '<button class="btn ' + cls + ' btn-sm" type="button" ' + attrs + ">" + label + "</button>";
      const statusBtns =
        (st === "PENDING" || st === "REJECTED" ? btn("btn-success", 'data-pa="status" data-status="ACTIVE"', st === "PENDING" ? "Approve application" : "Approve") : "") +
        (st === "PENDING" ? btn("btn-ghost", 'data-pa="status" data-status="REJECTED"', "Reject application") : "") +
        (st === "SUSPENDED" || st === "DISABLED" ? btn("btn-success", 'data-pa="status" data-status="ACTIVE"', "Reactivate") : "") +
        (st === "ACTIVE" ? btn("btn-danger", 'data-pa="status" data-status="SUSPENDED"', "Suspend") : "") +
        (st === "ACTIVE" || st === "SUSPENDED" ? btn("btn-ghost", 'data-pa="status" data-status="DISABLED"', "Disable partner") : "");
      const nowMs = Date.now();
      const currentRate = rt.history.find((x) => new Date(x.effective_from).getTime() <= nowMs);
      const ref = d.referrals || [];
      return (
        '<div class="adm-who">' + avatar(name) + "<div><strong>" + esc(name) + "</strong>" +
          "<small>" + [p.full_name && p.username ? esc(p.username) : "", p.phone ? '<a href="tel:' + esc(p.phone) + '">' + esc(p.phone) + "</a>" : "",
            p.email ? '<a href="mailto:' + esc(p.email) + '">' + esc(p.email) + "</a>" : ""].filter(Boolean).join(" · ") + "</small>" +
          "<small>Partner ID <b>" + tx(p.partner_id || p.code) + "</b> · registered " + when(p.created_at) + "</small>" +
          '<small class="adm-id">' + esc(p.user_id) + "</small></div>" +
          '<div class="adm-who-bal"><span>Available</span><b>' + money(w.available) + "</b></div></div>" +
        '<div class="adm-pills adm-pills-row">' + statusPill(st) + pill(rateOf(rt.pct) + " revenue share", "brand") +
          (rt.scheduled ? pill(rateOf(rt.scheduled.pct) + " from " + when(rt.scheduled.effective_from), "warn") : "") +
          (p.link_live ? pill("Link live", "ok") : pill(p.link_enabled ? "Link not live (" + st.toLowerCase() + ")" : "Link switched off", "bad")) +
          (p.payoutWaiting ? pill("Payout waiting", "warn") : "") +
          (p.decided_by ? pill("Status by " + p.decided_by, "") : "") + "</div>" +
        (p.channel ? '<p class="me-sheet-note">Where they promote: <b>' + esc(p.channel) + "</b></p>" : "") +
        (p.accrue_from ? '<p class="me-sheet-note">Earning again since ' + when(p.accrue_from) + " — bets settled while they were disabled don't count.</p>" : "") +
        '<div class="adm-actions-box">' +
          '<a class="btn btn-primary btn-sm" href="partners.html?preview=' + uid + '" target="_blank" rel="noopener">' + U.icon("user") + "View partner dashboard</a>" +
          statusBtns + "</div>" +

        '<h3 class="me-sheet-sub">Referral link &amp; promo code</h3>' +
        '<div class="adm-plinkbox"><span class="adm-addr">' + esc(link) + "</span>" +
          '<div class="adm-actions-box">' + btn("btn-ghost", 'data-copy="' + esc(link) + '"', "Copy link") +
            (p.link_enabled ? btn("btn-ghost", 'data-pa="link"', "Disable link") : btn("btn-success", 'data-pa="link"', "Enable link")) +
            btn("btn-ghost", 'data-pa="regen"', "Generate new link") + "</div></div>" +
        (p.promo_request
          ? '<div class="alert alert-info adm-preq">They asked for promo code <b>' + esc(p.promo_request) + "</b>. " +
            btn("btn-success", 'data-pa="promo-yes"', "Approve") + " " + btn("btn-ghost", 'data-pa="promo-no"', "Decline") + "</div>"
          : "") +
        '<form class="adm-terms" data-pf="promo"><div class="field"><label for="pPromo">Promo code</label>' +
          '<input id="pPromo" type="text" maxlength="16" autocapitalize="characters" spellcheck="false" class="adm-upper" value="' + tx(p.promo_code) + '" placeholder="None"></div>' +
          '<button class="btn btn-primary btn-sm" type="submit">Save promo code</button></form>' +
        '<p class="hint">4 to 16 letters and numbers. Leave it empty to remove it. The old code stops working at once; players already brought in stay theirs.</p>' +

        '<h3 class="me-sheet-sub">Totals (lifetime)</h3><div class="adm-minis">' +
          mini("Referred users", count(p.referrals)) +
          mini("Stakes", money(lt.stakes)) +
          mini("Payouts (winnings)", money(lt.payouts)) +
          mini("Net gaming revenue", money(lt.ngr), tone(lt.ngr)) +
          mini("Total commission", money(lt.commission), "in") +
          mini("Deposits by their players", money(lt.deposits || 0)) +
          mini("Eligible deposit losses", money(lt.eligibleLosses || 0)) +
          mini("Deductions from player wins", money(lt.negative), lt.negative < 0 ? "bad" : "") +
          mini("Net commission", money(lt.net), tone(lt.net)) +
          (Math.abs(p.totalEarnings - lt.net) >= 0.005 ? mini("Total earnings", money(p.totalEarnings) + " <small>(incl. opening balance)</small>") : "") +
          mini("Pending (period open)", money(w.pending), w.pending ? "warn" : "") +
          (w.carriedNegative ? mini("Negative carried over", money(w.carriedNegative), "bad") : "") +
          (w.corrections ? mini("Corrections", money(w.corrections), tone(w.corrections)) : "") +
          mini("Available", money(w.available), "in") +
          mini("Pending withdrawals", money(w.pendingWithdrawals), w.pendingWithdrawals ? "warn" : "") +
          mini("Completed withdrawals", money(w.withdrawn)) +
        "</div>" +
        '<p class="hint">Settled ' + tx(String(w.settlementPeriod || "").toLowerCase()) + " · withdrawals from " + money(w.minPayout) + " to " + money(w.maxPayout) + ".</p>" +

        '<h3 class="me-sheet-sub">Commission rate</h3>' +
        '<p class="me-sheet-note">Now <b>' + rateOf(rt.pct) + "</b> of the net gaming revenue on their players' losing bets" +
          (rt.scheduled ? "; <b>" + rateOf(rt.scheduled.pct) + "</b> from " + when(rt.scheduled.effective_from) : "") +
          ". The win deduction is the same for every partner (Commission settings).</p>" +
        '<form class="adm-terms" data-pf="rate">' +
          '<div class="field"><label for="pRate">New revenue share (%)</label><input id="pRate" type="number" inputmode="decimal" min="0" max="90" step="0.01" value="' + esc(String(rt.pct)) + '" required></div>' +
          '<div class="field"><label for="pRateFrom">Starts <span class="opt">(optional)</span></label><input id="pRateFrom" type="datetime-local"></div>' +
          '<button class="btn btn-primary btn-sm" type="submit">Change rate</button></form>' +
        '<p class="hint">0% to 90%. Applies to bets settled from the start time (empty = now; never in the past). Commission already recorded is never recalculated.</p>' +
        fold("Rate history", rt.history.length, rt.history.length
          ? table(["Rate", "From", "Set by", "Recorded"], rt.history.map((h) => {
              const at = new Date(h.effective_from).getTime();
              return "<tr><td>" + rateOf(h.pct) + " " + (at > nowMs ? pill("scheduled", "warn") : h === currentRate ? pill("current", "ok") : "") +
                "</td><td>" + when(h.effective_from) + "</td><td>" + tx(h.set_by || "—") + "</td><td>" + when(h.created_at) + "</td></tr>";
            }))
          : '<p class="me-sheet-note">No rate set yet: the default applies once approved.</p>') +

        '<h3 class="me-sheet-sub">Correct commission</h3>' +
        '<form class="adm-terms" data-pf="correct">' +
          '<div class="field"><label for="pCorAmt">Amount (GHS)</label><input id="pCorAmt" type="text" inputmode="decimal" maxlength="12" placeholder="12.50 or -12.50" required></div>' +
          '<div class="field adm-wide"><label for="pCorWhy">Reason (kept in the audit log)</label><input id="pCorWhy" type="text" maxlength="200" minlength="8" placeholder="e.g. Bet #1234 was voided after settlement" required></div>' +
          '<button class="btn btn-primary btn-sm" type="submit">Apply correction</button></form>' +
        '<p class="hint">Only for a verified commission error. A positive amount adds to their available balance, a negative one takes off. It shows in their wallet history.</p>' +

        '<h3 class="me-sheet-sub">Admin note</h3>' +
        '<form class="adm-terms" data-pf="note"><div class="field adm-wide"><label for="pNote">Note (admins only)</label><input id="pNote" type="text" maxlength="300" value="' + tx(p.note) + '"></div>' +
          '<button class="btn btn-ghost btn-sm" type="submit">Save note</button></form>' +

        '<h3 class="me-sheet-sub">Permissions</h3>' +
        fold("Features for this partner" + (perms && Object.keys(perms.overrides || {}).length ? " · " + count(Object.keys(perms.overrides).length) + " set here" : ""), null, permsHtml()) +
        (p.status !== "ACTIVE" ? '<p class="hint">They\'re not an active partner right now; these settings apply while they are.</p>' : "") +

        '<h3 class="me-sheet-sub">Statistics</h3>' +
        fold("Daily · last 30 days", null, statTable(d.daily || [], "30 days", {
          signups: sum(d.daily || [], "signups"), activePlayers: null, stakes: sum(d.daily || [], "stakes"), payouts: sum(d.daily || [], "payouts"),
          ngr: sum(d.daily || [], "ngr"), commission: sum(d.daily || [], "commission"), negative: sum(d.daily || [], "negative"), earnings: sum(d.daily || [], "earnings") }), true) +
        fold("Monthly · last 12 months", null, statTable(d.monthly || [], "Lifetime", {
          signups: p.referrals, activePlayers: null, stakes: lt.stakes, payouts: lt.payouts, ngr: lt.ngr, commission: lt.commission, negative: lt.negative, earnings: lt.net })) +

        fold("Commission records", (d.commissions || []).length, (d.commissions || []).length
          ? table(["Date", "Player", "Game", "Stake", "From deposit", "Payout", "Eligible loss", "Rate", "Commission", "Status"], d.commissions.map((c) =>
              "<tr><td>" + when(c.settled_at) + '</td><td><a href="#" data-user="' + esc(c.user_id) + '">' + esc(c.full_name || c.username || c.player) + "</a>" +
              (c.phone ? " <small>" + esc(c.phone) + "</small>" : "") + "</td><td>" + esc(c.game) + "</td><td>" + money(c.stake) + "</td><td>" +
              (c.depositStake === null ? "—" : money(c.depositStake)) + "</td><td>" + money(c.payout) + "</td><td>" + money(c.eligibleLoss) + "</td><td>" + c.pct + "%" +
              (c.kind === "deduction" ? " <small>deduction</small>" : "") + '</td><td class="' + tone(c.amount) + '">' + money(c.amount) +
              (c.kind === "not_eligible" ? " <small>lost winnings — not eligible</small>" : "") + (c.rule === "loss" ? " <small>earlier rule</small>" : "") +
              "</td><td>" + (c.status === "settled" ? "Settled" : "Pending") + "</td></tr>")) +
            '<p class="hint">Commission = rate × the eligible loss: the part of a lost stake that was the player\'s own deposited money (stakes use deposited money first; every payout counts as winnings). A win deducts the win-deduction % of the player\'s net winnings. Newest 500.</p>'
          : '<p class="me-sheet-note">No commission records yet.</p>') +

        fold("Referred users", ref.length, ref.length
          ? table(["Player", "Joined", "Via", "Stakes", "Payouts", "NGR", "Commission", "Last bet"], ref.slice(0, 300).map((x) =>
              "<tr><td>" + (x.user_id ? "<a href=\"#\" data-user=\"" + esc(x.user_id) + "\">" + esc(x.full_name || x.username || x.player) + "</a>" + (x.phone ? " <small>" + esc(x.phone) + "</small>" : "") : tx(x.player)) + " <small>" + tx(x.id) + "</small>" + (x.sub_id ? " <small>" + esc(x.sub_id) + "</small>" : "") + "</td><td>" + when(x.joined) + "</td><td>" + tx(x.via) +
              "</td><td>" + money(x.stakes) + "</td><td>" + money(x.payouts) + '</td><td class="' + tone(x.ngr) + '">' + money(x.ngr) + '</td><td class="' + tone(x.commission) + '">' +
              money(x.commission) + "</td><td>" + when(x.last_activity) + "</td></tr>")) +
            (ref.length > 300 ? '<p class="hint">Showing the newest 300.</p>' : "")
          : '<p class="me-sheet-note">No referred players yet.</p>') +

        '<h3 class="me-sheet-sub">Money history</h3>' +
        fold("Payouts", d.payouts.length, d.payouts.length
          ? table(["Requested", "Amount", "Paid to", "Status", "Reference / note", ""], d.payouts.map((x) => {
              const open = x.status === "REQUESTED" || x.status === "APPROVED";
              const data = ' data-payout="' + esc(x.id) + '" data-amount="' + Number(x.amount) + '" data-who="' + esc(name) + '"';
              return "<tr><td>" + when(x.created_at) + "</td><td><b>" + money(x.amount) + "</b></td><td class='adm-wrapcell'>" + tx(METHOD[x.method] || x.method) + ": " + payTo(x) +
                "</td><td>" + statusPill(x.status) + "</td><td class='adm-wrapcell'>" + tx(x.reference || x.note || "") + (x.decided_at ? "<small> · " + when(x.decided_at) + "</small>" : "") + "</td><td>" +
                (x.status === "REQUESTED" ? btn("btn-ghost", data + ' data-do="approve"', "Approve") : "") +
                (open ? btn("btn-primary", data + ' data-do="pay"', "Mark paid") + btn("btn-ghost", data + ' data-do="reject"', "Reject") : "") + "</td></tr>";
            }))
          : '<p class="me-sheet-note">No payouts yet.</p>', d.payouts.some((x) => x.status === "REQUESTED" || x.status === "APPROVED")) +
        fold("Wallet movements", d.entries.length, d.entries.length
          ? table(["When", "What", "Amount", "Note"], d.entries.map((x) => "<tr><td>" + when(x.created_at) + "</td><td>" + tx(WALLET_KIND[x.kind] || x.kind) +
              '</td><td class="' + tone(x.amount) + '">' + money(x.amount) + "</td><td class='adm-wrapcell'>" + tx(x.note) + "</td></tr>"))
          : '<p class="me-sheet-note">No wallet movements yet.</p>') +
        fold("Settlements", d.settlements.length, d.settlements.length
          ? table(["Period", "Dates", "Commission", "Deductions", "Carried in", "Credited", "Carried out", "Settled"], d.settlements.map((x) =>
              "<tr><td>" + tx(String(x.period || "").toLowerCase()) + "</td><td>" + dayOf(x.period_start) + " – " + dayOf(new Date(new Date(x.period_end).getTime() - 864e5)) +
              "</td><td>" + money(x.positive) + '</td><td class="' + tone(x.negative) + '">' + money(x.negative) + "</td><td>" + money(x.carried_in) + '</td><td class="in">' + money(x.credited) +
              "</td><td>" + money(x.carried_out) + "</td><td>" + when(x.created_at) + "</td></tr>"))
          : '<p class="me-sheet-note">No settled periods yet.</p>') +

        fold("Audit log", d.audit.length, d.audit.length
          ? '<div class="adm-log">' + d.audit.map((a) => "<div><b>" + esc(a.action) + "</b> " + esc(JSON.stringify(a.details)) + "<small>" + tx(a.admin) + " · " + when(a.created_at) + "</small></div>").join("") + "</div>"
          : '<p class="me-sheet-note">No admin changes yet.</p>')
      );
    }

    const draw = async () => {
      const [r, pr] = await Promise.all([api("/partners/" + uid), api("/partners/" + uid + "/permissions")]);
      perms = pr.ok ? pr.data : null;
      permsErr = pr.ok ? "" : errText(pr, "Couldn't load the permissions.");
      if (!r.ok) return s.set("<div class='alert alert-err'>" + errText(r, "Couldn't load this partner.") + "</div>");
      cur = r.data;
      /* keep the scroll position and which folds are open across a redraw */
      const scroller = s.el.querySelector(".adm-sheet-panel");
      const y = scroller ? scroller.scrollTop : 0;
      const yb = s.body.scrollTop;
      const open = Array.from(s.body.querySelectorAll("details.adm-pdet")).map((x) => x.open);
      s.set(html(r.data));
      if (open.length) s.body.querySelectorAll("details.adm-pdet").forEach((x, i) => { if (open[i] !== undefined) x.open = open[i]; });
      if (scroller) scroller.scrollTop = y;
      s.body.scrollTop = yb;
    };
    const after = () => {
      draw();
      refreshBadges();
      if (state.tab === "partners") loadPartners();
    };
    const update = async (body, done, b) => {
      if (b) b.disabled = true;
      const r = await api("/partners/" + uid, body);
      if (b) b.disabled = false;
      flash(r.ok ? "ok" : "error", r.ok ? done(r.data) : errText(r, "Couldn't update the partner."));
      if (r.ok) after();
      return r.ok;
    };

    s.body.addEventListener("click", async (e) => {
      const cp = e.target.closest("[data-copy]");
      if (cp) return copyText(cp.dataset.copy);
      const pl = e.target.closest("[data-user]");
      if (pl) {
        e.preventDefault();
        return openPlayer(pl.dataset.user);
      }
      const po = e.target.closest("[data-payout]");
      if (po) {
        if (await decidePayout(po)) after();
        return;
      }
      const b = e.target.closest("button[data-pa]");
      if (!b || !cur) return;
      const p = cur.partner;
      const name = p.full_name || p.username;
      const act = b.dataset.pa;
      if (act === "status") {
        const status = b.dataset.status;
        if (!(await confirmStatus(status, p.status, name))) return;
        return update({ status }, () => STATUS_DONE[status], b);
      }
      if (act === "link") {
        if (p.link_enabled) {
          const ok = await ask({ title: "Disable their referral link?", text: "Visits through it stop counting and new sign-ups through it aren't theirs until you enable it again. Their promo code isn't affected.", yes: "Disable link", danger: true });
          if (ok === null) return;
        }
        return update({ link_enabled: !p.link_enabled }, () => (p.link_enabled ? "Referral link disabled." : "Referral link enabled."), b);
      }
      if (act === "regen") {
        const ok = await ask({ title: "Generate a new referral link?", text: "They get a new link and Partner ID. <b>The old link (" + esc(refLink(p.code)) + ") stops working at once</b>, wherever it's been shared. Players already brought in stay theirs.", yes: "Generate new link", danger: true });
        if (ok === null) return;
        return update({ regenerate_code: true }, (d) => "New referral link: " + esc(refLink(d.code)), b);
      }
      if (act === "promo-yes" || act === "promo-no") {
        const yes = act === "promo-yes";
        return update({ approve_promo_request: yes }, () => (yes ? "Promo code " + esc(p.promo_request) + " approved." : "Promo code request declined."), b);
      }
    });

    s.body.addEventListener("submit", async (e) => {
      const f = e.target.closest("form[data-pf]");
      if (!f || !cur) return;
      e.preventDefault();
      const p = cur.partner;
      const v = (id) => f.querySelector("#" + id).value.trim();
      const kind = f.dataset.pf;
      const b = f.querySelector("button[type=submit]");
      if (kind === "rate") {
        const pctv = v("pRate");
        if (pctv === "" || !(Number(pctv) >= 0 && Number(pctv) <= 90)) return flash("error", "Enter a revenue share from 0% to 90%.");
        const at = v("pRateFrom");
        let iso = "";
        if (at) {
          const d = new Date(at);
          if (Number.isNaN(d.getTime())) return flash("error", "Enter a valid start date and time.");
          if (d.getTime() < Date.now() - 60000) return flash("error", "A rate change can start now or later, never in the past.");
          iso = d.toISOString();
        }
        const ok = await ask({ title: "Change the revenue share to " + esc(pctv) + "%?",
          text: (iso ? "From " + when(iso) : "From now") + ", for bets their players settle from then on. Commission already recorded stays as it is.", yes: "Change rate" });
        if (ok === null) return;
        const body = { revshare_pct: pctv };
        if (iso) body.effective_from = iso;
        return update(body, () => "Revenue share set to " + esc(pctv) + "%" + (iso ? " from " + when(iso) : "") + ".", b);
      }
      if (kind === "promo") {
        const code = v("pPromo").toUpperCase();
        if (code === (p.promo_code || "")) return flash("info", "Nothing changed.");
        if (code && !/^[A-Z0-9]{4,16}$/.test(code)) return flash("error", "Use 4 to 16 letters and numbers, no spaces or symbols.");
        if (!code) {
          const ok = await ask({ title: "Remove their promo code?", text: "<b>" + esc(p.promo_code) + "</b> stops working at once.", yes: "Remove", danger: true });
          if (ok === null) return;
        } else if (p.promo_code) {
          const ok = await ask({ title: "Change the promo code to " + esc(code) + "?", text: "<b>" + esc(p.promo_code) + "</b> stops working at once.", yes: "Change" });
          if (ok === null) return;
        }
        return update({ promo_code: code }, () => (code ? "Promo code set to " + esc(code) + "." : "Promo code removed."), b);
      }
      if (kind === "correct") {
        const amount = v("pCorAmt").replace(/\s/g, "");
        const reason = v("pCorWhy");
        if (!/^-?\d+(\.\d{1,2})?$/.test(amount) || Number(amount) === 0) return flash("error", "Enter an amount like 12.50 or -12.50.");
        if (reason.length < 8) return flash("error", "Explain the correction (at least 8 characters).");
        const n = Number(amount);
        const ok = await ask({ title: (n > 0 ? "Add " : "Take off ") + money(Math.abs(n)) + "?",
          text: (n > 0 ? "Added to" : "Taken off") + " their available commission balance (now " + money(cur.wallet.available) + "), with your number and the reason in the audit log.", yes: "Apply correction", danger: n < 0 });
        if (ok === null) return;
        b.disabled = true;
        const r = await api("/partners/" + uid + "/correction", { amount, reason });
        b.disabled = false;
        flash(r.ok ? "ok" : "error", r.ok ? "Correction applied — available balance now " + money(r.data.wallet.available) + "." : errText(r, "Couldn't apply the correction."));
        if (r.ok) after();
        return;
      }
      if (kind === "note") return update({ note: v("pNote") }, () => "Note saved.", b);
      if (kind === "perms" && perms) {
        const ov = perms.overrides || {};
        const changes = {};
        const lines = [];
        perms.list.forEach(({ key, label }) => {
          const pick = f.querySelector('input[data-pperm="' + CSS.escape(key) + '"]:checked');
          const want = !pick || pick.value === "" ? null : pick.value === "on";
          const had = key in ov ? ov[key] : null;
          if (want === had) return;
          changes[key] = want;
          lines.push(esc(label) + " → <b>" + (want === null ? "default (" + (perms.global[key] ? "on" : "off") + ")" : want ? "on" : "off") + "</b>");
        });
        if (!lines.length) return flash("info", "Nothing changed.");
        const ok = await ask({ title: "Change " + esc(p.full_name || p.username || "this partner") + "'s permissions?", text: lines.join("<br>") + "<br>The server applies it at once.", yes: "Save" });
        if (ok === null) return;
        b.disabled = true;
        const r = await api("/partners/" + uid + "/permissions", { permissions: changes });
        b.disabled = false;
        flash(r.ok ? "ok" : "error", r.ok ? "Permissions saved." : errText(r, "Couldn't save the permissions."));
        if (r.ok) draw();
        return;
      }
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

  /* ================= Lotto ================= */
  /* the daily 5/90 draw: schedule, payouts and limits; every draw with its tickets; a draw's numbers once betting has
     closed; Release results pays the winners, Cancel (only while betting is open) refunds every ticket. The settings
     form is drawn once per visit so the refresh never wipes what's being typed. */
  const lt = { loading: false, last: null, tickets: null };
  const LT_STATUS = { OPEN: ["Betting open", "live"], CLOSED: ["Drawn — waiting for release", "warn"], RELEASED: ["Results released", "ok"], CANCELLED: ["Cancelled — refunded", "bad"] };
  const ltBalls = (ns) => '<span class="lta-balls">' + ns.map((n) => '<span class="lta-ball">' + n + "</span>").join("") + "</span>";
  function ltForm(s) {
    const f = (id, label, value, type, step, min, hint) => '<div class="field"><label for="' + id + '">' + label + "</label>" +
      '<input id="' + id + '" type="' + type + '"' + (step ? ' step="' + step + '"' : "") + (min !== null ? ' min="' + min + '"' : "") + ' value="' + esc(value) + '" required>' +
      (hint ? '<small class="adm-note">' + hint + "</small>" : "") + "</div>";
    return '<section class="adm-card"><h3 class="adm-h">Schedule and payouts</h3>' +
      '<p class="adm-note">Changes apply to the draw taking bets and every draw after it. Tickets already bought keep the payout they were sold at.</p>' +
      '<form class="adm-terms" data-form="lotto">' +
      f("ltaTime", "Daily draw time (Ghana time)", s.draw_time, "time", null, null, "Results can be released once betting closes.") +
      f("ltaCutoff", "Betting closes (minutes before the draw)", s.cutoff_min, "number", "1", "1") +
      f("ltaRtp", "RTP (%)", s.rtp_pct, "number", "0.01", "50", "Between 50 and 99. Sets every payout: higher RTP = bigger payouts.") +
      f("ltaMin", "Minimum stake (GHS)", s.min_bet, "number", "0.01", "0.5") +
      f("ltaMax", "Maximum stake (GHS)", s.max_bet, "number", "0.01", "0.5") +
      f("ltaWin", "Top win per ticket (GHS)", s.max_win, "number", "0.01", "1") +
      '<button class="btn btn-primary btn-sm" type="submit">Save settings</button></form>' +
      '<p class="adm-note">Last changed ' + (s.updated_by ? when(s.updated_at) + " by " + esc(s.updated_by || "—") : "never (defaults)") + ".</p></section>";
  }
  function renderLotto(d) {
    const panel = panelOf("lotto");
    if (!panel.querySelector("#ltaDraws")) {
      panel.innerHTML = '<div id="ltaKey"></div><div id="ltaTop"></div><div id="ltaDraws"></div><div id="ltaTickets"></div>' + ltForm(d.settings);
    }
    const s = d.settings;
    $("ltaTop").innerHTML = '<section class="adm-card"><div class="adm-studio-head"><div><strong>Lotto is ' + (d.enabled ? "on" : "paused") + "</strong><small>" +
      (d.enabled ? "Players can buy tickets. Pausing stops new tickets; tickets already bought stay in their draw." : "No new tickets are sold. Resume to open it again.") + "</small></div>" +
      '<button class="btn ' + (d.enabled ? "btn-danger" : "btn-success") + ' btn-sm" type="button" data-lt-toggle>' + (d.enabled ? "Pause Lotto" : "Resume Lotto") + "</button></div>" +
      '<div class="adm-studio-head"><div><strong>Ticket sales are ' + (s.real_money ? "open" : "closed") + "</strong><small>" +
      (s.real_money ? "Players can buy real-money tickets." : "Players can see the Lotto page but can't buy tickets. Open sales once the required lotto licence and approvals are in place.") + "</small></div>" +
      '<button class="btn ' + (s.real_money ? "btn-danger" : "btn-success") + ' btn-sm" type="button" data-lt-sales>' + (s.real_money ? "Close ticket sales" : "Open ticket sales") + "</button></div>" +
      '<div class="adm-mines-meta">' + avStat("Daily draw", esc(s.draw_time) + " GMT") + avStat("Betting closes", s.cutoff_min + " min before") +
      avStat("RTP", s.rtp_pct + "%") + avStat("Stakes", money(s.min_bet) + " – " + money(s.max_bet)) + avStat("Top win", money(s.max_win)) + "</div>" +
      '<div class="adm-mines-meta">' + [1, 2, 3, 4, 5].map((k) => avStat("Direct-" + k, count(d.multipliers[k]) + "×")).join("") + "</div></section>";
    const rows = d.draws.map((x) => {
      const st = LT_STATUS[x.status] || [x.status, ""];
      let act = '<button class="btn btn-ghost btn-sm" type="button" data-lt-tickets="' + x.id + '">Tickets</button>';
      if (x.status === "OPEN") act += ' <button class="btn btn-danger btn-sm" type="button" data-lt-cancel="' + x.id + '">Cancel &amp; refund</button>';
      if (x.status === "CLOSED") act += ' <button class="btn btn-success btn-sm" type="button" data-lt-release="' + x.id + '">Release results</button>';
      const result = x.numbers ? ltBalls(x.numbers) : '<span class="adm-note">Hidden until betting closes</span>';
      const pay = x.status === "CLOSED" && x.projected ? count(x.projected.winners) + " win · " + money(x.projected.payout) + " to pay"
        : x.status === "RELEASED" ? count(x.winners) + " won · " + money(x.paid) + " paid"
        : x.status === "CANCELLED" ? count(x.refunded) + " refunded" : "—";
      return "<tr><td>#" + x.id + " " + esc(x.name || "") + "</td><td>" + when(x.draw_at) + "</td><td>" + pill(st[0], st[1]) + "</td><td>" + result + "</td><td>" +
        count(x.tickets) + "</td><td>" + money(x.staked) + "</td><td>" + pay + '</td><td class="lta-act">' + act + "</td></tr>";
    }).join("");
    $("ltaDraws").innerHTML = '<section class="adm-card"><h3 class="adm-h">Draws</h3>' +
      '<p class="adm-note">The numbers are drawn by the server when betting closes and are locked to the fingerprint players saw. ' +
      "Check them here, then press <b>Release results</b> to publish them and pay every winning ticket. A draw nobody releases is released automatically 24 hours after its draw time.</p>" +
      (rows ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Draw</th><th>Draw time</th><th>Status</th><th>Numbers</th><th>Tickets</th><th>Staked</th><th>Winners</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>"
        : empty("No draws yet.", "star")) + "</section>";
  }
  function renderLottoTickets() {
    const t = lt.tickets;
    if (!t) { $("ltaTickets").innerHTML = ""; return; }
    $("ltaTickets").innerHTML = '<section class="adm-card"><div class="adm-mines-card-head"><strong>Tickets in draw #' + t.id + "</strong>" +
      '<button class="btn btn-ghost btn-sm" type="button" data-lt-tickets-close>Close</button></div>' +
      (t.list.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Ticket</th><th>Player</th><th>Phone</th><th>Numbers</th><th>Bet</th><th>Stake</th><th>Potential</th><th>Status</th><th>Win</th><th>Bought</th></tr></thead><tbody>' +
        t.list.map((x) => "<tr><td>" + esc(x.code || "") + "</td><td>" + esc(x.name) + "</td><td>" + esc(x.phone || "—") + "</td><td>" +
          (x.banker ? '<span class="lta-balls"><span class="lta-ball lta-bank" title="Banker">' + x.banker + "</span></span> + " : "") +
          (x.picks.length >= 89 ? "all 89" : ltBalls(x.picks)) + "</td><td>" + esc(x.bet || "Direct-" + x.picks.length) +
          " · " + count(x.multiplier) + "×" + (x.lines > 1 ? " · " + count(x.lines) + " lines" : "") + "</td><td>" + money(x.stake) + "</td><td>" + money(x.potential) + "</td><td>" +
          pill(x.status === "ACTIVE" ? "Waiting" : x.status === "WON" ? "Won" : x.status === "LOST" ? "Lost" : "Refunded", x.status === "WON" ? "ok" : x.status === "LOST" ? "bad" : x.status === "ACTIVE" ? "live" : "") +
          "</td><td>" + (x.payout ? money(x.payout) : "—") + "</td><td>" + when(x.created_at) + "</td></tr>").join("") + "</tbody></table></div>"
        : '<p class="adm-note">No tickets in this draw.</p>') + "</section>";
  }
  async function loadLotto(fresh) {
    if (lt.loading || state.tab !== "lotto") return;
    if (fresh) { panelOf("lotto").innerHTML = loading; lt.tickets = null; }
    lt.loading = true;
    const r = await api("/lotto");
    lt.loading = false;
    if (state.tab !== "lotto") return;
    if (!r.ok) return flash("error", errText(r, "Couldn't load Lotto."));
    lt.last = r.data;
    renderLotto(r.data);
    renderLottoTickets();
    loadLottoKey();
  }
  async function lottoTickets(id) {
    const r = await api("/lotto/tickets?draw=" + encodeURIComponent(id));
    if (!r.ok) return flash("error", errText(r, "Couldn't load the tickets."));
    lt.tickets = { id, list: r.data.tickets };
    renderLottoTickets();
    $("ltaTickets").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function lottoToggle() {
    const on = !(lt.last && lt.last.enabled);
    if (!on) {
      const ok = await ask({ title: "Pause Lotto?", text: "No new tickets are sold until you resume it. Tickets already bought stay in their draw.", yes: "Pause", danger: true });
      if (ok === null) return;
    }
    const r = await api("/catalog/game/lotto", { enabled: on });
    flash(r.ok ? "ok" : "error", r.ok ? "Lotto is now " + (on ? "on" : "paused") + "." : errText(r, "Couldn't change it."));
    loadLotto(false);
  }
  async function lottoSales() {
    const open = !(lt.last && lt.last.settings.real_money);
    const ok = open
      ? await ask({ title: "Open real-money ticket sales?", text: "Players will be able to buy Lotto tickets with their balance. Only do this once the required lotto licence and approvals are in place — you confirm they are.", yes: "Yes, open sales" })
      : await ask({ title: "Close ticket sales?", text: "No new tickets are sold. Tickets already bought stay in their draw and are settled as normal.", yes: "Close sales", danger: true });
    if (ok === null) return;
    const r = await api("/lotto/settings", open ? { real_money: true, licence_confirmed: true } : { real_money: false });
    flash(r.ok ? "ok" : "error", r.ok ? "Lotto ticket sales are now " + (open ? "open" : "closed") + "." : errText(r, "Couldn't change it."));
    loadLotto(false);
  }
  async function lottoRelease(id) {
    const x = lt.last && lt.last.draws.find((d) => d.id === Number(id));
    const pay = x && x.projected ? x.projected : { winners: 0, payout: 0 };
    const ok = await ask({ title: "Release the results of draw #" + id + "?",
      text: "Numbers: " + (x && x.numbers ? x.numbers.join(", ") : "—") + ". " + count(pay.winners) + " winning ticket(s) will be paid " + money(pay.payout) +
        " in total, straight to their balances. Players see the results at once. This can't be undone.", yes: "Release and pay" });
    if (ok === null) return;
    const r = await api("/lotto/draws/" + id + "/release", { confirm: true });
    flash(r.ok ? "ok" : "error", r.ok ? "Draw #" + id + " released: " + count(r.data.winners) + " winner(s), " + money(r.data.paid) + " paid." : errText(r, "Couldn't release the results."));
    refreshBadges();
    loadLotto(false);
  }
  async function lottoCancel(id) {
    const ok = await ask({ title: "Cancel draw #" + id + "?", text: "Every ticket in this draw is refunded in full to the player's balance and no more tickets are sold for it. This can't be undone.", yes: "Cancel and refund", danger: true });
    if (ok === null) return;
    const r = await api("/lotto/draws/" + id + "/cancel", {});
    flash(r.ok ? "ok" : "error", r.ok ? "Draw #" + id + " cancelled: " + count(r.data.tickets) + " ticket(s), " + money(r.data.refunded) + " refunded." : errText(r, "Couldn't cancel the draw."));
    loadLotto(false);
  }
  async function saveLotto(form) {
    const v = (id) => form.querySelector("#" + id).value;
    const body = { draw_time: v("ltaTime"), cutoff_min: v("ltaCutoff"), rtp_pct: v("ltaRtp"), min_bet: v("ltaMin"), max_bet: v("ltaMax"), max_win: v("ltaWin") };
    if (lt.last && Number(body.rtp_pct) !== lt.last.settings.rtp_pct) {
      const ok = await ask({ title: "Change the RTP to " + esc(body.rtp_pct) + "%?", text: "Every payout changes for new tickets, and the game page shows the new payouts. Tickets already bought keep theirs.", yes: "Change RTP" });
      if (ok === null) return;
    }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    const r = await api("/lotto/settings", body);
    btn.disabled = false;
    if (!r.ok) return flash("error", errText(r, "Couldn't save the settings."));
    flash("ok", "Lotto settings saved.");
    panelOf("lotto").innerHTML = "";
    loadLotto(true);
  }

  /* ================= TheTeller Payment Settings ================= */
  /* the main admin's ON/OFF switch for new payments, the merchant id and the connection; API keys and passwords never
     reach this page (the server sends only whether each one is set) */
  const tp = { loading: false, last: null, test: null };
  const TP_CONN = { connected: ["Connected", "ok"], unreachable: ["Not reachable", "bad"], not_configured: ["Not configured", "bad"] };
  function renderPaymentSettings(d) {
    const on = d.payments_enabled;
    const t = d.teller;
    const c = tp.test ? Object.assign({}, d.connection, tp.test, { status: tp.test.reachable ? "connected" : (t.configured ? "unreachable" : "not_configured") }) : d.connection;
    const conn = TP_CONN[c.status] || [c.status, ""];
    const secret = (set) => set ? '<span class="adm-tp-secret">' + U.icon("shield") + "Set · hidden</span>" : '<span class="adm-tp-missing">Not set</span>';
    const h = d.last_24h;
    panelOf("payments").innerHTML =
      '<section class="adm-card adm-tp-hero ' + (on ? "is-on" : "is-off") + '">' +
        '<div class="adm-studio-head"><div><strong>Payments are ' + (on ? "ON" : "OFF") + "</strong><small>" +
          (on ? "All TheTeller payments work normally: players can deposit by mobile money, Paybill and card."
            : "No one can start a new payment anywhere on the website. Payments already started are still checked with TheTeller and credited.") + "</small></div>" +
        '<label class="adm-switch adm-tp-switch"><input type="checkbox" data-pay-switch' + (on ? " checked" : "") + ' aria-label="TheTeller payments on or off"><span aria-hidden="true"></span></label></div>' +
        (on ? "" : '<div class="adm-tp-notice"><span>Players see</span><p>' + esc(d.off_message) + "</p></div>") +
        '<p class="adm-note">' + (d.updated_by ? "Last changed " + when(d.updated_at) + " by " + esc(d.updated_by) : "Never changed (on by default)") +
          ". The switch stays as you set it until an admin changes it.</p></section>" +
      '<section class="adm-card"><div class="adm-mines-card-head"><strong>TheTeller account</strong>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-tp-test>' + U.icon("refresh") + "Test connection</button></div>" +
        '<div class="adm-mines-meta adm-tp-meta">' +
          avStat("Merchant ID", t.merchant_id ? esc(t.merchant_id) + (t.merchant_id_looks_valid ? "" : ' <small class="adm-tp-missing">check format</small>') : '<span class="adm-tp-missing">Not set</span>') +
          avStat("Payment status", on ? "ON — accepting payments" : "OFF — paused by admin", on ? "in" : "bad") +
          avStat("Connection", pill(conn[0], conn[1]) + (c.http ? ' <small class="adm-note">HTTP ' + c.http + " · " + c.ms + " ms</small>" : c.error ? ' <small class="adm-note">' + esc(c.error) + "</small>" : "")) +
          avStat("Mode", t.mode === "test" ? "Sandbox (test)" : "Live") +
          avStat("API username", secret(t.secrets.api_username)) +
          avStat("API key", secret(t.secrets.api_key)) +
          avStat("Payout passcode", secret(t.secrets.payout_passcode)) +
          avStat("Last confirmed payment", c.last_confirmed_at ? ago(c.last_confirmed_at) : "none yet") +
        "</div>" +
        (t.configured ? "" : '<p class="adm-note adm-tp-missing">Missing on the asakaa-balance service in Render: <b>' + esc(t.missing.join(", ")) + "</b>.</p>") +
        '<p class="adm-note">API keys and passwords are kept on the server (Render environment variables) and are never shown here. ' +
          "“Connected” means TheTeller's server answered; the last confirmed payment shows the keys are being accepted.</p></section>" +
      '<section class="adm-card"><h3 class="adm-h">Last 24 hours</h3><div class="adm-mines-meta">' +
        avStat("Confirmed", count(h.confirmed), "in") + avStat("Amount confirmed", money(h.confirmed_amount)) +
        avStat("Pending", count(h.pending)) + avStat("Failed", count(h.failed), h.failed ? "bad" : "") + "</div>" +
        '<p class="adm-note">' + count(d.waiting_to_settle) + " payment(s) waiting for TheTeller's answer. Turning payments OFF never stops these: " +
        "they keep being verified every minute and are credited once TheTeller confirms them. See <b>Recent deposits</b> for each one.</p></section>";
  }
  async function loadPaymentSettings(fresh) {
    if (tp.loading || state.tab !== "payments") return;
    if (fresh) { panelOf("payments").innerHTML = loading; tp.test = null; }
    tp.loading = true;
    const r = await api("/payment-settings");
    tp.loading = false;
    if (state.tab !== "payments") return;
    if (!r.ok) return flash("error", errText(r, "Couldn't load the payment settings."));
    tp.last = r.data;
    renderPaymentSettings(r.data);
  }
  async function paymentSwitch(input) {
    const on = input.checked;
    const ok = on
      ? await ask({ title: "Turn payments ON?", text: "Players can deposit again with TheTeller (mobile money, Paybill and card).", yes: "Turn ON" })
      : await ask({ title: "Turn payments OFF?", text: "No one can start a new payment anywhere on the website. Players see: “" + esc(tp.last ? tp.last.off_message : "Payments are temporarily unavailable. Please try again later.") +
          "” Payments already started are still verified and credited.", yes: "Turn OFF", danger: true });
    if (ok === null) { input.checked = !on; return; }
    input.disabled = true;
    const r = await api("/payment-settings", { enabled: on });
    input.disabled = false;
    if (!r.ok) { input.checked = !on; return flash("error", errText(r, "Couldn't change it.")); }
    flash("ok", "TheTeller payments are now <b>" + (on ? "ON" : "OFF") + "</b>.");
    refreshBadges();
    loadPaymentSettings(false);
  }
  async function paymentTest(btn) {
    btn.disabled = true;
    const r = await api("/payment-settings/test", {});
    btn.disabled = false;
    if (!r.ok) return flash("error", errText(r, "Couldn't test the connection."));
    tp.test = r.data;
    flash(r.data.reachable ? "ok" : "error", r.data.reachable ? "TheTeller answered in " + r.data.ms + " ms." : "TheTeller didn't answer: " + esc(r.data.error || "unknown error") + ".");
    if (tp.last) renderPaymentSettings(tp.last);
  }

  /* ================= Betting & withdrawal settings ================= */
  /* The site's minimum deposit, the betting eligibility rule and the withdrawal play-through rule, with the wording
     players see; who each rule affects; and every change. Each save is confirmed, audited and kept in the history.
     Neither rule ever deducts money; a material change asks players to accept the rules again before depositing. */
  const mr = { data: null, affected: null, history: null, q: "", timer: 0, saving: false };
  const MR_LABEL = {
    min_deposit: "Minimum deposit", bet_rule_enabled: "Betting rule", bet_rule_days: "Betting rule window",
    bet_rule_message: "Betting rule message", withdraw_rule_enabled: "Withdrawal play-through rule",
    withdraw_rule_multiple: "Play-through multiple", withdraw_rule_message: "Play-through message",
    withdraw_info: "Withdrawal information", rules_version: "Rules version",
    policy_heading: "Deposit page heading", policy_min_deposit: "Minimum deposit text", policy_betting: "Betting eligibility text",
    policy_funds: "Your funds text", policy_withdrawal: "Withdrawal processing text", policy_min_withdrawal: "Minimum withdrawal text",
    policy_notice: "Important notice", policy_accept: "Acceptance checkbox text",
  };
  const MR_POLICY = [["policy_heading", "Heading"], ["policy_min_deposit", "Minimum Deposit"], ["policy_betting", "Betting Eligibility"],
    ["policy_funds", "Your Funds"], ["policy_withdrawal", "Withdrawal Processing"], ["policy_min_withdrawal", "Minimum Withdrawal"],
    ["policy_notice", "Important Notice"], ["policy_accept", "Acceptance checkbox"]];
  const MR_TEXT = ["bet_rule_message", "withdraw_rule_message", "withdraw_info"].concat(MR_POLICY.map((x) => x[0]));
  const MR_MATERIAL = ["min_deposit", "bet_rule_enabled", "bet_rule_days", "withdraw_rule_enabled", "withdraw_rule_multiple",
    "policy_min_deposit", "policy_betting", "policy_funds", "policy_withdrawal", "policy_min_withdrawal", "policy_accept"];
  const mrValue = (k, v) => {
    if (v === true) return "ON";
    if (v === false) return "OFF";
    if (k === "min_deposit") return "GHS " + esc(String(v));
    if (k === "bet_rule_days") return esc(String(v)) + " days";
    if (k === "withdraw_rule_multiple") return esc(String(v)) + "×";
    if (MR_TEXT.includes(k)) return "“" + esc(String(v).length > 80 ? String(v).slice(0, 80) + "…" : String(v)) + "”";
    return esc(String(v));
  };
  const mrField = (id, label, input, hint) => '<div class="field"><label for="' + id + '">' + label + "</label>" + input + (hint ? '<small class="hint">' + hint + "</small>" : "") + "</div>";
  const mrSwitch = (key, on, label) => '<label class="adm-switch"><input type="checkbox" data-mr="' + key + '"' + (on ? " checked" : "") + ' aria-label="' + esc(label) + '"><span aria-hidden="true"></span></label>';
  const mrArea = (id, value) => '<textarea id="' + id + '" class="me-textarea mr-text" rows="4" maxlength="1000">' + esc(value) + "</textarea>";

  function renderMoneyRules() {
    const panel = panelOf("moneyrules");
    const d = mr.data;
    if (!d) return;
    const s = d.settings;
    const p = d.preview;
    panel.innerHTML =
      '<form class="mr-form" data-form="moneyrules" novalidate>' +
      /* minimum deposit */
      '<section class="adm-card mr-card"><h3 class="adm-h">' + U.icon("wallet") + "Minimum deposit</h3>" +
        mrField("mrMin", "Minimum deposit (GHS)", '<input id="mrMin" type="number" inputmode="decimal" step="0.01" min="1" max="50000" value="' + esc(String(s.min_deposit)) + '">',
          "Every deposit (mobile money, Paybill and card) must be at least this much. GHS 1 to GHS 50,000.") +
      "</section>" +
      /* betting eligibility */
      '<section class="adm-card mr-card ' + (s.bet_rule_enabled ? "is-on" : "") + '">' +
        '<div class="adm-studio-head"><div><strong>New-deposit betting requirement</strong><small>' +
          (s.bet_rule_enabled ? "ON — since " + when(s.bet_rule_enabled_at) + ": only deposited funds can be staked" : "OFF — the whole balance can be staked") + "</small></div>" +
          mrSwitch("bet_rule_enabled", s.bet_rule_enabled, "New-deposit betting requirement on or off") + "</div>" +
        '<p class="adm-note">When ON, every casino game stakes only from session funds (deposited money not yet staked). Winnings can\u2019t be staked; ' +
          "they stay the player\u2019s and can be withdrawn. A new deposit adds session funds. Balances are never deducted.</p>" +
        '<input id="mrDays" type="hidden" value="' + esc(String(s.bet_rule_days)) + '">' +
        mrField("mrBetMsg", "Message players see when a bet is refused", mrArea("mrBetMsg", s.bet_rule_message), "Plain text, up to 1,000 characters. {min} = minimum deposit, {session} = their session funds, {winnings} = their winnings.") +
        '<div class="adm-tp-notice mr-preview"><span>Players read</span><p data-mr-preview="bet">' + esc(p.bet_rule.message) + "</p></div>" +
      "</section>" +
      /* withdrawal play-through */
      '<section class="adm-card mr-card ' + (s.withdraw_rule_enabled ? "is-on" : "") + '">' +
        '<div class="adm-studio-head"><div><strong>Withdrawal play-through rule</strong><small>' +
          (s.withdraw_rule_enabled ? "ON — counts deposits made since " + when(s.withdraw_rule_enabled_at) : "OFF — nothing is held") + "</small></div>" +
          mrSwitch("withdraw_rule_enabled", s.withdraw_rule_enabled, "Withdrawal play-through rule on or off") + "</div>" +
        '<p class="adm-note">When ON, deposited money not yet bet is held from withdrawal: held = the smaller of the balance, the deposited part of the balance, ' +
          "the qualifying deposits, and (multiple × qualifying deposits − stakes since). Only deposits made after the rule is switched on and after the player's " +
          "last paid withdrawal count. Winnings are never held and nothing is deducted.</p>" +
        mrField("mrMult", "Play-through multiple (×)", '<input id="mrMult" type="number" inputmode="decimal" step="0.1" min="0" max="20" value="' + esc(String(s.withdraw_rule_multiple)) + '">', "0 to 20. 1 means each qualifying deposit has to be bet once.") +
        mrField("mrWdMsg", "Message players see when a withdrawal is over what they can withdraw", mrArea("mrWdMsg", s.withdraw_rule_message),
          "Plain text, up to 1,000 characters. {held} becomes the amount held, {to_bet} what is still to bet, {multiple} the multiple.") +
      "</section>" +
      /* the deposit page's "Before you proceed" box: every line players read and accept */
      '<section class="adm-card mr-card"><h3 class="adm-h">' + U.icon("shield") + "Deposit page conditions (what players accept)</h3>" +
        '<p class="adm-note">Shown before every first deposit and after any change. {min} and {max} become the minimum and maximum deposit. ' +
          "Betting Eligibility and Your Funds only show while the new-deposit requirement is ON.</p>" +
        MR_POLICY.map(([k, label]) => mrField("mr_" + k, label, mrArea("mr_" + k, s[k]), "")).join("") +
      "</section>" +
      /* general withdrawal information */
      '<section class="adm-card mr-card"><h3 class="adm-h">' + U.icon("withdraw") + "Withdrawal information</h3>" +
        mrField("mrInfo", "Shown on the withdraw page, the deposit page's rules box and the terms", mrArea("mrInfo", s.withdraw_info), "Plain text, up to 1,000 characters.") +
      "</section>" +
      '<div class="mr-save"><button class="btn btn-primary btn-lg" type="submit"' + (mr.saving ? " disabled" : "") + ">Save settings</button>" +
        '<p class="adm-note">Rules version <b>' + s.rules_version + "</b> · " + count(d.accepted_current) + " player(s) accepted it · " +
        (s.updated_by ? "last changed " + when(s.updated_at) + " by " + esc(s.updated_by) : "never changed (defaults)") +
        ". Changing the minimum, a switch, the multiple or the conditions text asks players to accept again before their next deposit.</p></div>" +
      "</form>" +
      '<section class="adm-card mr-card" id="mrAffected">' + loading + "</section>" +
      '<section class="adm-card mr-card" id="mrHistory">' + loading + "</section>";
    renderAffected();
    renderHistory();
  }

  function renderAffected() {
    const host = $("mrAffected");
    if (!host) return;
    const a = mr.affected;
    if (!a) { host.innerHTML = loading; return; }
    const who = (p) => "<td><b>" + esc(p.name) + "</b>" + (p.phone ? "<small>" + esc(p.phone) + "</small>" : "") + "</td>";
    const last = (p) => (p.last_deposit === null ? "none" : money(p.last_deposit) + "<small>" + when(p.last_deposit_at) + "</small>");
    const bet = a.bet_rule;
    const wd = a.withdraw_rule;
    host.innerHTML = '<h3 class="adm-h">' + U.icon("users") + "Affected players</h3>" +
      '<div class="adm-toolbar"><label class="searchbar adm-search">' + U.icon("search") +
      '<input id="mrQ" type="search" placeholder="Find a player by name or number" autocomplete="off" aria-label="Find an affected player" value="' + esc(mr.q) + '"></label></div>' +
      '<h4 class="mr-sub">' + (bet.enabled ? "Can't bet right now" : "Would be stopped from betting if the rule were ON") +
        ' <span class="adm-chip-count">' + count(bet.players.length) + (bet.players.length >= 100 ? "+" : "") + "</span></h4>" +
      '<p class="adm-note">Players with money in their balance and no deposit of at least ' + money(bet.min_deposit) + " in the last " + bet.days + " days. Their balance is untouched and they can still withdraw.</p>" +
      (bet.players.length
        ? table(["Player", "Balance", "Last deposit"], bet.players.map((p) =>
            '<tr class="adm-rowlink" data-user="' + esc(p.id) + '" tabindex="0" role="button">' + who(p) + "<td>" + money(p.balance) + "</td><td>" + last(p) + "</td></tr>"))
        : '<p class="me-sheet-note">' + (mr.q ? "No players match." : "No one.") + "</p>") +
      '<h4 class="mr-sub">Money held by the play-through rule <span class="adm-chip-count">' + count(wd.players.length) + (wd.players.length >= 100 ? "+" : "") + "</span></h4>" +
      (wd.enabled
        ? (wd.players.length
            ? table(["Player", "Balance", "Held", "Still to bet", "Last qualifying deposit"], wd.players.map((p) =>
                '<tr class="adm-rowlink" data-user="' + esc(p.id) + '" tabindex="0" role="button">' + who(p) + "<td>" + money(p.balance) + '</td><td class="bad"><b>' + money(p.held) +
                "</b></td><td>" + money(p.to_bet) + "</td><td>" + last(p) + "</td></tr>"))
            : '<p class="me-sheet-note">' + (mr.q ? "No players match." : "Nothing is held for anyone.") + "</p>")
        : '<p class="me-sheet-note">The play-through rule is OFF, so nothing is held.</p>');
    const q = $("mrQ");
    q.addEventListener("input", () => {
      clearTimeout(mr.timer);
      mr.timer = setTimeout(async () => {
        mr.q = q.value.trim();
        const r = await api("/money-rules/affected?" + new URLSearchParams({ q: mr.q }));
        if (!r.ok || state.tab !== "moneyrules") return;
        mr.affected = r.data;
        const pos = q.selectionStart;
        renderAffected();
        const again = $("mrQ");
        again.focus();
        try { again.setSelectionRange(pos, pos); } catch (e) { /* not a text field */ }
      }, 300);
    });
  }

  function renderHistory() {
    const host = $("mrHistory");
    if (!host) return;
    const h = mr.history;
    if (!h) { host.innerHTML = loading; return; }
    host.innerHTML = '<h3 class="adm-h">' + U.icon("history") + "Change history</h3>" +
      (h.changes.length
        ? table(["When", "Admin", "What changed"], h.changes.map((c) =>
            "<tr><td>" + when(c.at) + "</td><td>" + esc(c.admin) + '</td><td class="mr-changes">' +
            Object.keys(c.changes).map((k) => "<div><b>" + esc(MR_LABEL[k] || k) + ":</b> " +
              (MR_TEXT.includes(k) ? "edited " + mrValue(k, c.changes[k].after) : mrValue(k, c.changes[k].before) + " → " + mrValue(k, c.changes[k].after)) + "</div>").join("") +
            "</td></tr>"))
        : '<p class="me-sheet-note">No changes yet: the defaults are in force (minimum deposit GHS 135, both rules OFF).</p>');
  }

  async function loadMoneyRules(fresh) {
    const panel = panelOf("moneyrules");
    if (fresh !== false) { panel.innerHTML = loading; mr.affected = null; mr.history = null; }
    const [r, a, h] = await Promise.all([api("/money-rules"), api("/money-rules/affected?" + new URLSearchParams({ q: mr.q })), api("/money-rules/history")]);
    if (state.tab !== "moneyrules") return;
    if (!r.ok) { panel.innerHTML = ""; return flash("error", errText(r, "Couldn't load the betting & withdrawal settings.")); }
    mr.data = r.data;
    mr.affected = a.ok ? a.data : null;
    mr.history = h.ok ? h.data : null;
    renderMoneyRules();
    if (!a.ok) $("mrAffected").innerHTML = '<p class="me-sheet-note">' + errText(a, "Couldn't load the affected players.") + "</p>";
    if (!h.ok) $("mrHistory").innerHTML = '<p class="me-sheet-note">' + errText(h, "Couldn't load the history.") + "</p>";
  }

  /* the form's values; a switch flipped in the form is saved with everything else */
  function moneyRulesForm(form) {
    const val = (id) => form.querySelector("#" + id).value;
    const sw = (k) => form.querySelector('input[data-mr="' + k + '"]').checked;
    return {
      min_deposit: val("mrMin").trim() === "" ? "" : Number(val("mrMin")),
      bet_rule_enabled: sw("bet_rule_enabled"),
      bet_rule_days: val("mrDays").trim() === "" ? "" : Number(val("mrDays")),
      bet_rule_message: val("mrBetMsg").trim(),
      withdraw_rule_enabled: sw("withdraw_rule_enabled"),
      withdraw_rule_multiple: val("mrMult").trim() === "" ? "" : Number(val("mrMult")),
      withdraw_rule_message: val("mrWdMsg").trim(),
      withdraw_info: val("mrInfo").trim(),
      ...Object.fromEntries(MR_POLICY.map(([k]) => [k, val("mr_" + k).trim()])),
    };
  }
  async function saveMoneyRules(form) {
    if (!mr.data || mr.saving) return;
    const cur = mr.data.settings;
    const next = moneyRulesForm(form);
    const changed = Object.keys(next).filter((k) => next[k] !== cur[k]);
    if (!changed.length) return flash("info", "Nothing changed.");
    const material = changed.some((k) => MR_MATERIAL.includes(k));
    const lines = changed.map((k) => "<b>" + esc(MR_LABEL[k]) + ":</b> " +
      (MR_TEXT.includes(k) ? "new wording" : mrValue(k, cur[k]) + " → " + mrValue(k, next[k])));
    const ok = await ask({
      title: "Save these changes?",
      text: lines.join("<br>") + "<br><br>" + (material
        ? "Players will be asked to accept the updated rules before their next deposit. "
        : "Wording only: players are not asked to accept again. ") +
        "No balance is ever deducted by these rules.",
      yes: "Save",
      danger: next.bet_rule_enabled && !cur.bet_rule_enabled,
    });
    if (ok === null) return;
    mr.saving = true;
    const body = {};
    changed.forEach((k) => (body[k] = next[k]));
    const r = await api("/money-rules", body);
    mr.saving = false;
    if (!r.ok) return flash("error", errText(r, "Couldn't save the settings."));
    flash("ok", "Betting &amp; withdrawal settings saved" + (r.data.version_bumped ? " (rules version " + r.data.settings.rules_version + ": players accept again before depositing)." : "."));
    loadMoneyRules(false);
  }

  /* ================= Blocked, Banned and Deleted users ================= */
  /* three menus, one shape: find a player and act, the list with its reasons and dates, and the history. A restriction
     never touches a balance, a bet or a record; banning or deleting also stops log-in (the accounts server is told). */
  const AC = {
    blocked: { title: "Blocked users", act: "block", actLabel: "Block", empty: "No blocked accounts.", ico: "bell",
      lead: "Temporarily blocked accounts: they can sign in and look, but can't bet, deposit or withdraw. Set an end date or block until you unblock." },
    banned: { title: "Banned users", act: "ban", actLabel: "Ban", empty: "No banned accounts.", ico: "shield",
      lead: "Permanently banned accounts: they can't log in, bet or make payment requests. Review a ban and lift it here. Every ban keeps its reason and date." },
    deleted: { title: "Deleted users", act: "deactivate", actLabel: "Deactivate", empty: "No deactivated or deleted accounts.", ico: "trash",
      lead: "Deactivated and deleted accounts. They can't log in, but every transaction and audit record is kept, so an account can be restored." },
  };
  const AC_LABEL = { block: "Blocked", unblock: "Unblocked", expire: "Block ended", ban: "Banned", lift_ban: "Ban lifted", deactivate: "Deactivated", delete: "Deleted", restore: "Restored" };
  const ac = { q: {}, timer: 0, found: {}, last: {} };
  const dateOnly = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");

  /* a small form in a dialog: fields of { id, label, type: "text" | "select" | "datetime", options, placeholder, hint } */
  function askForm({ title, text, fields, yes, danger }) {
    return new Promise((resolve) => {
      const dlg = document.createElement("div");
      dlg.className = "me-dialog";
      dlg.setAttribute("role", "alertdialog");
      dlg.setAttribute("aria-modal", "true");
      const field = (f) => '<div class="field adm-ac-field"><label for="acf_' + f.id + '">' + f.label + "</label>" +
        (f.type === "select" ? '<select id="acf_' + f.id + '">' + f.options.map(([v, l]) => '<option value="' + esc(v) + '">' + esc(l) + "</option>").join("") + "</select>"
          : f.type === "datetime" ? '<input id="acf_' + f.id + '" type="datetime-local">'
          : f.type === "textarea" ? '<textarea id="acf_' + f.id + '" class="me-textarea" rows="2" maxlength="300" placeholder="' + esc(f.placeholder || "") + '"></textarea>'
          : '<input id="acf_' + f.id + '" type="text" autocomplete="off" placeholder="' + esc(f.placeholder || "") + '">') +
        (f.hint ? '<small class="adm-note">' + f.hint + "</small>" : "") + "</div>";
      dlg.innerHTML = '<div class="me-dialog-card adm-ac-dialog"><h2>' + title + "</h2>" + (text ? "<p>" + text + "</p>" : "") + fields.map(field).join("") +
        '<p class="adm-ask-err" hidden></p><div class="me-dialog-actions"><button class="btn btn-ghost btn-lg" type="button" data-no>Cancel</button>' +
        '<button class="btn ' + (danger ? "btn-danger" : "btn-primary") + ' btn-lg" type="button" data-yes>' + yes + "</button></div></div>";
      document.body.appendChild(dlg);
      const val = (id) => { const el = dlg.querySelector("#acf_" + id); return el ? el.value.trim() : ""; };
      const done = (v) => { dlg.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
      const onKey = (e) => { if (e.key === "Escape") done(null); };
      document.addEventListener("keydown", onKey);
      const custom = dlg.querySelector("#acf_period");
      const toggleCustom = () => { const w = dlg.querySelector("#acf_until"); if (w) w.closest(".field").hidden = !custom || custom.value !== "custom"; };
      if (custom) { custom.addEventListener("change", toggleCustom); toggleCustom(); }
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg || e.target.closest("[data-no]")) return done(null);
        if (!e.target.closest("[data-yes]")) return;
        const out = {};
        fields.forEach((f) => (out[f.id] = val(f.id)));
        const bad = fields.find((f) => f.check && f.check(out[f.id], out));
        if (bad) {
          const err = dlg.querySelector(".adm-ask-err");
          err.hidden = false;
          err.textContent = bad.check(out[bad.id], out);
          return;
        }
        done(out);
      });
      (dlg.querySelector("input, textarea, select") || dlg.querySelector("[data-yes]")).focus();
    });
  }
  const REASON = (what) => ({ id: "reason", label: "Reason", type: "textarea", placeholder: "Why " + what + "? (kept in the record)",
    check: (v) => (v.length < 4 ? "Write the reason (at least 4 characters)." : "") });

  /* the action itself: asks what's needed, sends it, and says what happened */
  async function accountAction(action, id, name) {
    const who = "<b>" + esc(name || "this player") + "</b>";
    let body = null;
    if (action === "block") {
      const f = await askForm({ title: "Block " + esc(name || "player") + "?", yes: "Block",
        text: who + " can still sign in and look, but can't bet, deposit or withdraw until the block ends.",
        fields: [REASON("block this account"),
          { id: "period", label: "Blocking period", type: "select", options: [["24h", "24 hours"], ["3d", "3 days"], ["7d", "7 days"], ["30d", "30 days"], ["custom", "Until a date I choose"], ["none", "Until I unblock"]] },
          { id: "until", label: "Blocked until", type: "datetime", check: (v, o) => (o.period === "custom" && !v ? "Choose the date the block ends." : "") }] });
      if (!f) return;
      body = { action, reason: f.reason };
      if (f.period === "custom") body.until = new Date(f.until).toISOString();
      else if (f.period !== "none") body[f.period.endsWith("h") ? "hours" : "days"] = parseInt(f.period, 10);
    } else if (action === "ban") {
      const f = await askForm({ title: "Ban " + esc(name || "player") + "?", yes: "Ban permanently", danger: true,
        text: who + " won't be able to log in, bet or make payment requests until an admin lifts the ban. Their records and balance are kept.", fields: [REASON("ban this account")] });
      if (!f) return;
      body = { action, reason: f.reason };
    } else if (action === "lift_ban") {
      const f = await askForm({ title: "Lift the ban on " + esc(name || "player") + "?", yes: "Lift ban",
        text: who + " will be able to log in and play again.", fields: [Object.assign(REASON("lift the ban"), { label: "Your review" })] });
      if (!f) return;
      body = { action, reason: f.reason };
    } else if (action === "deactivate") {
      const f = await askForm({ title: "Deactivate " + esc(name || "player") + "?", yes: "Deactivate", danger: true,
        text: who + " won't be able to log in. Nothing is erased: you can restore the account at any time.", fields: [REASON("deactivate this account")] });
      if (!f) return;
      body = { action, reason: f.reason };
    } else if (action === "delete") {
      const f = await askForm({ title: "Delete " + esc(name || "player") + "?", yes: "Delete account", danger: true,
        text: "<span class='adm-ac-warn'>" + U.icon("bell") + "Warning: " + who + " is signed out everywhere and can't log in again.</span> Transactions, balances and the financial audit history are kept as the law requires, so the account can be restored if needed.",
        fields: [REASON("delete this account"), { id: "confirm", label: "Type DELETE to confirm", placeholder: "DELETE", check: (v) => (v !== "DELETE" ? "Type DELETE (in capitals) to confirm." : "") }] });
      if (!f) return;
      body = { action, reason: f.reason, confirm: f.confirm };
    } else if (action === "unblock" || action === "restore") {
      const ok = await ask({ title: (action === "unblock" ? "Unblock " : "Restore ") + esc(name || "player") + "?",
        text: action === "unblock" ? who + " can bet, deposit and withdraw again." : who + " can log in and use the account again, with the same balance and history.",
        yes: action === "unblock" ? "Unblock" : "Restore" });
      if (ok === null) return;
      body = { action };
    }
    const r = await api("/users/" + encodeURIComponent(id) + "/control", body);
    if (!r.ok) return flash("error", errText(r, "Couldn't change the account."));
    const sync = r.data.login_synced === false ? " <b>Note:</b> the log-in server didn't confirm, so the player is refused on every page but may still see the log-in succeed. Try again in a minute." : "";
    flash(r.data.login_synced === false ? "info" : "ok", esc(name || "The player") + ": " + (AC_LABEL[action] || action).toLowerCase() + "." + sync);
    refreshBadges();
    if (AC[state.tab]) loadAccounts(state.tab);
  }

  function accountsShell(kind) {
    const panel = panelOf(kind);
    if (panel.querySelector(".adm-ac-find")) return;
    const c = AC[kind];
    panel.innerHTML = '<div class="adm-ac-stats" id="acStats_' + kind + '"></div>' +
      '<section class="adm-card adm-ac-find"><h3 class="adm-h">' + c.actLabel + " a player</h3>" +
      '<div class="adm-toolbar"><label class="searchbar adm-search">' + U.icon("search") +
      '<input type="search" data-ac-find="' + kind + '" placeholder="Find a player by name, username or phone" autocomplete="off" aria-label="Find a player"></label></div>' +
      '<div class="adm-ac-found" id="acFound_' + kind + '"></div></section>' +
      '<section class="adm-card"><div class="adm-mines-card-head"><strong>' + c.title + '</strong><label class="searchbar adm-search adm-ac-filter">' + U.icon("search") +
      '<input type="search" data-ac-filter="' + kind + '" placeholder="Search this list" autocomplete="off" aria-label="Search ' + c.title + '"></label></div>' +
      '<div id="acList_' + kind + '">' + loading + "</div></section>" +
      '<section class="adm-card"><h3 class="adm-h">History</h3><div id="acHist_' + kind + '"></div></section>';
  }
  function acRowActions(kind, u) {
    const b = (act, label, cls) => '<button class="btn ' + cls + ' btn-sm" type="button" data-ac-act="' + act + '" data-ac-id="' + esc(u.id) + '" data-ac-name="' + esc(u.full_name || u.username || u.phone || "") + '">' + label + "</button>";
    if (kind === "blocked") return b("unblock", "Unblock", "btn-success") + b("block", "Change period", "btn-ghost") + b("ban", "Ban", "btn-danger");
    if (kind === "banned") return b("lift_ban", "Review &amp; lift ban", "btn-success");
    return b("restore", "Restore", "btn-success") + (u.restriction === "DEACTIVATED" ? b("delete", "Delete", "btn-danger") : "");
  }
  function renderAccounts(kind, d) {
    const c = AC[kind];
    $("acStats_" + kind).innerHTML = ["blocked", "banned", "deleted"].map((k) =>
      '<button type="button" class="adm-ac-stat' + (k === kind ? " on" : "") + '" data-go="' + k + '"><span>' + AC[k].title + "</span><b>" + count(d.counts[k]) + "</b></button>").join("");
    const rows = d.users.map((u) => {
      const status = kind === "blocked" ? (u.until ? pill("Until " + dateOnly(u.until), "warn") : pill("Until unblocked", "warn"))
        : kind === "banned" ? pill("Banned", "bad") : pill(u.restriction === "DELETED" ? "Deleted" : "Deactivated", u.restriction === "DELETED" ? "bad" : "");
      return '<tr><td><button type="button" class="adm-link" data-user="' + esc(u.id) + '">' + esc(u.full_name || u.username || "Player") + "</button>" +
        (u.username ? '<small class="adm-note">@' + esc(u.username) + "</small>" : "") + "</td><td>" + esc(u.phone || "—") +
        '</td><td class="adm-wrapcell">' + esc(u.reason || "—") + "</td><td>" + dateOnly(u.since) + '<small class="adm-note">by ' + esc(u.by || "—") + "</small></td><td>" + status +
        "</td>" + (kind === "deleted" ? "<td>" + money(u.balance) + "</td>" : "") + '<td class="lta-act">' + acRowActions(kind, u) + "</td></tr>";
    }).join("");
    $("acList_" + kind).innerHTML = rows
      ? '<div class="adm-table-wrap"><table class="adm-table adm-ac-table"><thead><tr><th>Player</th><th>Phone</th><th>Reason</th><th>Date</th><th>Status</th>' +
        (kind === "deleted" ? "<th>Balance kept</th>" : "") + "<th></th></tr></thead><tbody>" + rows + "</tbody></table></div>"
      : empty(c.empty, c.ico);
    $("acHist_" + kind).innerHTML = d.history.length ? '<ul class="adm-ac-hist">' + d.history.map((h) =>
      "<li>" + pill(AC_LABEL[h.action] || h.action, h.action === "ban" || h.action === "delete" ? "bad" : h.action === "block" || h.action === "deactivate" ? "warn" : "ok") +
      "<span><b>" + esc(h.name) + "</b> " + esc(h.phone || "") + (h.reason ? " — " + esc(h.reason) : "") + (h.until ? " · until " + dateOnly(h.until) : "") +
      (h.login_synced === false ? ' <small class="adm-tp-missing">(log-in server not confirmed)</small>' : "") +
      '</span><small class="adm-note">' + dateOnly(h.at) + " · " + esc(h.admin) + "</small></li>").join("") + "</ul>"
      : '<p class="adm-note">Nothing yet.</p>';
  }
  async function loadAccounts(kind, quiet) {
    accountsShell(kind);
    if (!quiet) $("acList_" + kind).innerHTML = loading;
    const r = await api("/accounts/" + kind + "?" + new URLSearchParams({ q: ac.q[kind] || "" }));
    if (state.tab !== kind) return;
    if (!r.ok) return flash("error", errText(r, "Couldn't load the list."));
    ac.last[kind] = r.data;
    renderAccounts(kind, r.data);
  }
  async function findForAccounts(kind, q) {
    const box = $("acFound_" + kind);
    if (q.length < 2) { box.innerHTML = ""; return; }
    const r = await api("/users?" + new URLSearchParams({ q }));
    if (!r.ok) { box.innerHTML = ""; return; }
    const users = r.data.users.slice(0, 8);
    const act = AC[kind].act;
    box.innerHTML = users.length ? '<ul class="adm-ac-results">' + users.map((u) => {
      const name = u.full_name || u.username || u.phone || "Player";
      const b = (a, label, cls) => '<button class="btn ' + cls + ' btn-sm" type="button" data-ac-act="' + a + '" data-ac-id="' + esc(u.id) + '" data-ac-name="' + esc(name) + '">' + label + "</button>";
      const buttons = kind === "deleted" ? b("deactivate", "Deactivate", "btn-ghost") + b("delete", "Delete", "btn-danger")
        : b(act, AC[kind].actLabel, kind === "banned" ? "btn-danger" : "btn-primary");
      return "<li><span><b>" + esc(name) + "</b><small>" + esc(u.phone || "—") + " · " + esc(u.status === "SUSPENDED" ? "blocked" : u.status === "CLOSED" ? "closed" : "active") +
        " · " + money(u.balance) + "</small></span><span class='lta-act'>" + buttons + "</span></li>";
    }).join("") + "</ul>" : '<p class="adm-note">No player matches “' + esc(q) + "”.</p>";
  }
  document.querySelector(".adm-wrap").addEventListener("input", (e) => {
    const find = e.target.closest("[data-ac-find]");
    const filter = e.target.closest("[data-ac-filter]");
    if (!find && !filter) return;
    clearTimeout(ac.timer);
    ac.timer = setTimeout(() => {
      if (find) return findForAccounts(find.dataset.acFind, find.value.trim());
      ac.q[filter.dataset.acFilter] = filter.value.trim();
      loadAccounts(filter.dataset.acFilter, true);
    }, 300);
  });

  /* ================= Lotto Key ================= */
  /* closed draws' winning numbers, drawn by the server from each draw's seed the moment betting closed (nobody types or
     changes them), with the proof they're locked; PUBLISH RESULT makes them public and pays the winners */
  async function loadLottoKey() {
    const box = $("ltaKey");
    if (!box) return;
    const r = await api("/lotto/key");
    if (!r.ok || state.tab !== "lotto" || !$("ltaKey")) return;
    const d = r.data;
    const big = (ns) => '<span class="lta-key-balls">' + ns.map((n) => '<span class="lta-key-ball lt-c' + Math.min(8, Math.floor((n - 1) / 10)) + '"><i>' + n + "</i></span>").join("") + "</span>";
    const pend = d.pending.map((x) =>
      '<div class="lta-key-draw"><div class="lta-key-top"><div><strong>Draw #' + x.id + " · " + esc(x.name || "") + "</strong><small>Betting closed " + when(x.closed_at) + " · draw " + when(x.draw_at) + "</small></div>" +
      (x.locked ? pill("Numbers locked", "ok") : pill("Check failed — don't publish", "bad")) + "</div>" + big(x.numbers) +
      '<div class="lta-key-meta"><span>' + count(x.tickets) + " ticket(s) · " + money(x.staked) + " staked</span><span>" +
      (x.projected ? count(x.projected.winners) + " winner(s) · " + money(x.projected.payout) + " to pay" : "") + "</span></div>" +
      '<p class="adm-note">Fingerprint <code>' + esc(x.hash.slice(0, 20)) + "…</code> — shown to players before betting closed; the secret seed behind it gives exactly these numbers.</p>" +
      '<button class="btn btn-success lta-publish" type="button" data-lt-release="' + x.id + '"' + (x.locked ? "" : " disabled") + ">PUBLISH RESULT</button></div>").join("");
    const pub = d.published.map((x) => "<li><b>#" + x.id + " " + esc(x.name || "") + "</b>" + ltBalls(x.numbers || []) +
      '<small class="adm-note">' + when(x.published_at) + " by " + esc(x.published_by || "—") + " · " + count(x.winners) + " won · " + money(x.paid) + "</small></li>").join("");
    const LABEL = { "lotto.preview": "Previewed", "lotto.publish": "Published", "lotto.cancel": "Cancelled", "lotto.draw_create": "Created", "lotto.draw_pause": "Paused", "lotto.draw_resume": "Resumed" };
    const audit = d.audit.map((a) => "<li>" + pill(LABEL[a.action] || a.action, a.action === "lotto.publish" ? "ok" : a.action === "lotto.cancel" ? "bad" : "") +
      "<span>Draw #" + a.draw + '</span><small class="adm-note">' + when(a.at) + " · " + esc(a.admin) + "</small></li>").join("");
    box.innerHTML = '<section class="adm-card lta-key"><div class="adm-mines-card-head"><strong>' + U.icon("shield") + "Lotto Key</strong>" + pill("Admin only", "warn") + "</div>" +
      '<p class="adm-note">When betting closes, the server draws the 5 winning numbers from the draw\'s secret seed — independent of every ticket — and locks them. ' +
      "Preview them here; players see nothing until you press <b>PUBLISH RESULT</b>. Nobody can type or change the numbers.</p>" +
      (pend || '<p class="adm-note lta-key-none">No draw is waiting: numbers appear here as soon as a draw\'s betting closes.</p>') +
      (pub ? '<h4 class="lta-key-h">Published results</h4><ul class="lta-key-list">' + pub + "</ul>" : "") +
      (audit ? '<h4 class="lta-key-h">Audit trail</h4><ul class="lta-key-list lta-key-audit">' + audit + "</ul>" : "") + "</section>";
  }

  /* ================= sections, menu, events, badges ================= */
  /* ================= Recent deposits ================= */
  const dep = { status: "all", q: "", timer: 0 };
  const DEP_STATUS = [["all", "All"], ["successful", "Successful"], ["pending", "Pending"], ["failed", "Failed"]];
  const DEP_TONE = { successful: "in", pending: "warn", failed: "bad", reversed: "bad" };
  function depositsShell() {
    const panel = panelOf("deposits");
    if (panel.querySelector("#dpQ")) return;
    panel.innerHTML = '<div class="adm-feed-head">' + chips("dstatus", DEP_STATUS, dep.status) +
      '<span class="adm-live-dot" title="Updates every 10 seconds">Live</span></div>' +
      '<div class="adm-toolbar"><label class="searchbar adm-search">' + U.icon("search") +
      '<input id="dpQ" type="search" placeholder="Find a player by name or number" autocomplete="off" aria-label="Find a player"></label></div>' +
      '<div id="dpList"></div>';
    $("dpQ").addEventListener("input", () => {
      clearTimeout(dep.timer);
      dep.timer = setTimeout(() => { dep.q = $("dpQ").value.trim(); loadDeposits(); }, 300);
    });
  }
  async function loadDeposits(quiet) {
    depositsShell();
    if (!quiet) $("dpList").innerHTML = loading;
    const r = await api("/deposits/recent?" + new URLSearchParams({ status: dep.status, q: dep.q }));
    if (state.tab !== "deposits") return;
    if (!r.ok) { $("dpList").innerHTML = ""; return flash("error", errText(r, "Couldn't load deposits.")); }
    const items = r.data.deposits;
    const today = r.data.today || { total: 0, count: 0 };
    const banner = '<div class="apt-overview" style="margin-bottom:12px"><div class="apt-ov in"><i class="apt-ov-ico">' + U.icon("stack") +
      '</i><span>Deposits received today</span><strong>' + money(today.total) + "</strong><small>" + count(today.count) + " successful deposit" + (today.count === 1 ? "" : "s") + "</small></div></div>";
    $("dpList").innerHTML = banner + (items.length
      ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Player</th><th>Amount</th><th>Network</th><th>Status</th><th>Paid from</th><th>Reference</th><th>When</th></tr></thead><tbody>' +
        items.map((d) =>
          "<tr>" +
          "<td><b>" + esc(d.name) + "</b>" + (d.phone ? "<small>" + esc(d.phone) + "</small>" : "") + "</td>" +
          "<td>" + money(d.amount) + "</td>" +
          "<td>" + (d.network ? esc(d.network) : "—") + "</td>" +
          '<td>' + pill(d.status, DEP_TONE[d.status] || "") + (d.note ? "<small class='adm-wrapcell'>" + esc(d.note) + "</small>" : "") + "</td>" +
          "<td>" + (d.payer ? esc(d.payer) : "—") + "</td>" +
          "<td>" + (d.reference ? esc(d.reference) : "—") + "</td>" +
          "<td>" + when(d.at) + "</td></tr>").join("") +
        "</tbody></table></div>"
      : empty(dep.q ? "No deposits match." : "No deposits yet.", "stack"));
  }

  /* ================= Risk management ================= */
  const rk = { range: "30d", q: "", timer: 0 };
  const RK_RANGE = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["all", "All time"]];
  async function loadRisk(quiet) {
    const panel = panelOf("risk");
    if (!quiet) panel.innerHTML = loading;
    const [r, pl, lim] = await Promise.all([api("/risk"), api("/risk/players?" + new URLSearchParams({ range: rk.range, q: rk.q })), api("/risk/limits")]);
    if (state.tab !== "risk") return;
    if (!r.ok || !pl.ok || !lim.ok) { panel.innerHTML = ""; return flash("error", errText(r.ok ? (pl.ok ? lim : pl) : r, "Couldn't load risk management.")); }
    const s = r.data.settings;
    const a = r.data.alerts;
    const alertCount = a.payouts.length + a.winners.length + a.failedDeposits.length;
    const section = (title, n, html) => '<h3 class="me-sheet-sub">' + title + (n ? ' <span class="adm-chip-count">' + count(n) + "</span>" : "") + "</h3>" + html;
    panel.innerHTML =
      /* alert thresholds */
      '<form class="adm-adjust agm-reward" data-act="risk-settings">' +
        '<div class="field"><label for="rsPayout">Alert on a payout of (GHS)</label><input id="rsPayout" type="number" step="0.01" min="1" value="' + s.big_payout + '"></div>' +
        '<div class="field"><label for="rsMult">Alert on a multiplier of (x)</label><input id="rsMult" type="number" step="0.01" min="2" value="' + s.big_multiplier + '"></div>' +
        '<div class="field"><label for="rsNet">Alert on a player up in a day (GHS)</label><input id="rsNet" type="number" step="0.01" min="1" value="' + s.daily_net_win + '"></div>' +
        '<div class="field"><label for="rsFail">Alert on failed deposits in an hour</label><input id="rsFail" type="number" step="1" min="2" value="' + s.failed_deposits + '"></div>' +
        '<button class="btn btn-primary btn-sm" type="submit">Save alert settings</button></form>' +
      '<p class="hint">Alerts only flag activity for you to look at. They never block a player or touch a balance, a win or a result.</p>' +
      /* live alerts */
      (alertCount ? "" : '<div class="alert alert-info">Nothing is over your alert thresholds right now.</div>') +
      (a.payouts.length ? section("Big payouts (last 24 hours)", a.payouts.length,
        table(["Game", "Player", "Stake", "Payout", "Multiplier", "When"], a.payouts.map((p) =>
          "<tr><td>" + esc(p.game) + "</td><td>" + esc(p.player) + "</td><td>" + money(p.stake) + '</td><td class="in"><b>' + money(p.payout) + "</b></td><td>" + p.x + "x</td><td>" + when(p.at) + "</td></tr>"))) : "") +
      (a.winners.length ? section("Players up a lot today", a.winners.length,
        table(["Player", "Net up", "Bets", ""], a.winners.map((w) =>
          '<tr class="adm-rowlink" data-user="' + esc(w.user_id) + '" tabindex="0" role="button"><td>' + esc(w.name) + "</td><td class='in'><b>" + money(w.net) + "</b></td><td>" + count(w.bets) + "</td><td>Open</td></tr>"))) : "") +
      (a.failedDeposits.length ? section("Failed-deposit bursts (last hour)", a.failedDeposits.length,
        table(["Player", "Failed", "Tried", ""], a.failedDeposits.map((f) =>
          '<tr class="adm-rowlink" data-user="' + esc(f.user_id) + '" tabindex="0" role="button"><td>' + esc(f.name) + "</td><td class='bad'><b>" + count(f.fails) + "</b></td><td>" + money(f.amount) + "</td><td>Open</td></tr>"))) : "") +
      /* players' money */
      section("Players' money", null,
        '<div class="adm-feed-head">' + chips("rrange", RK_RANGE, rk.range) + "</div>" +
        '<div class="adm-toolbar"><label class="searchbar adm-search">' + U.icon("search") +
        '<input id="rkQ" type="search" placeholder="Find a player by name or number" autocomplete="off" aria-label="Find a player" value="' + esc(rk.q) + '"></label></div>' +
        (pl.data.players.length
          ? table(["Player", "Deposited", "Withdrawn", "Staked", "Won", "Player net", "House net"], pl.data.players.map((p) =>
              '<tr class="adm-rowlink" data-user="' + esc(p.id) + '" tabindex="0" role="button"><td><b>' + esc(p.name) + "</b>" + (p.phone ? "<small>" + esc(p.phone) + "</small>" : "") + "</td><td>" + money(p.deposited) +
              "</td><td>" + money(p.withdrawn) + "</td><td>" + money(p.staked) + "</td><td>" + money(p.won) + '</td><td class="' + tone(p.playerNet) + '"><b>' + money(p.playerNet) + '</b></td><td class="' + tone(p.houseNet) + '">' + money(p.houseNet) + "</td></tr>"))
          : empty(rk.q ? "No players match." : "No player money activity in this period.", "users"))) +
      /* players with limits set */
      section("Players with limits set", lim.data.players.length,
        lim.data.players.length
          ? table(["Player", "Type", "Min deposit", "Max deposit", "Max bet", "Set by", "When"], lim.data.players.map((p) =>
              '<tr class="adm-rowlink" data-user="' + esc(p.id) + '" tabindex="0" role="button"><td><b>' + esc(p.name) + "</b>" + (p.phone ? "<small>" + esc(p.phone) + "</small>" : "") + "</td><td>" + esc(p.type) +
              "</td><td>" + (p.min_deposit === null ? "—" : money(p.min_deposit)) + "</td><td>" + (p.max_deposit === null ? "—" : money(p.max_deposit)) + "</td><td>" + (p.max_bet === null ? "—" : money(p.max_bet)) +
              "</td><td>" + esc(p.updated_by || "") + "</td><td>" + when(p.updated_at) + "</td></tr>"))
          : '<p class="me-sheet-note">No player has a deposit or bet limit set. Open a player to set one.</p>');
    const q = $("rkQ");
    q.addEventListener("input", () => { clearTimeout(rk.timer); rk.timer = setTimeout(() => { rk.q = q.value.trim(); loadRisk(true); }, 300); });
  }

  /* ================= Withdrawal reviews ================= */
  const rv = { status: "pending" };
  const RV_STATUS = [["pending", "Waiting"], ["approved", "Approved"], ["published", "Published"], ["rejected", "Rejected"], ["all", "All"]];
  const stars = (n) => '<span class="rv-stars" aria-label="' + n + ' out of 5 stars">' + "★".repeat(n) + "☆".repeat(5 - n) + "</span>";
  const RV_TONE = { pending: "warn", approved: "", published: "in", rejected: "bad" };
  async function loadReviews(quiet) {
    const panel = panelOf("reviews");
    if (!quiet) panel.innerHTML = chips("rvstatus", RV_STATUS, rv.status) + loading;
    const r = await api("/reviews?status=" + rv.status);
    if (state.tab !== "reviews") return;
    if (!r.ok) { panel.innerHTML = chips("rvstatus", RV_STATUS, rv.status); return flash("error", errText(r, "Couldn't load reviews.")); }
    const items = r.data.reviews;
    panel.innerHTML = chips("rvstatus", RV_STATUS, rv.status) +
      (items.length
        ? '<div class="rv-list">' + items.map((v) => {
          const can = (a) =>
            (a === "approve" && v.status === "pending") ||
            (a === "publish" && (v.status === "pending" || v.status === "approved")) ||
            (a === "reject" && v.status !== "rejected");
          const btn = (a, label, cls) => can(a) ? '<button class="btn ' + cls + ' btn-sm" type="button" data-review="' + a + '" data-id="' + esc(v.id) + '">' + label + "</button>" : "";
          return '<article class="rv-card">' +
            '<div class="rv-top">' + stars(v.rating) + pill(v.status, RV_TONE[v.status] || "") + "</div>" +
            (v.feedback ? '<p class="rv-text">' + esc(v.feedback) + "</p>" : '<p class="rv-text rv-none">No written feedback.</p>') +
            '<div class="rv-who"><b>' + esc(v.name) + "</b>" + (v.phone ? " · " + esc(v.phone) : "") + " · withdrawal " + money(v.amount) + " · " + when(v.at) +
              (v.decided_by ? " · by " + esc(v.decided_by) : "") + "</div>" +
            '<div class="rv-actions">' + btn("approve", "Approve", "btn-ghost") + btn("publish", "Publish", "btn-primary") + btn("reject", "Reject", "btn-danger") + "</div>" +
          "</article>";
        }).join("") + "</div>"
        : empty(rv.status === "pending" ? "No reviews waiting." : "No reviews here.", "star"));
  }
  async function reviewAction(btn) {
    const action = btn.dataset.review;
    if (action === "reject") {
      const ok = await ask({ title: "Reject this review?", text: "It won't be shown to anyone.", yes: "Reject", danger: true });
      if (ok === null) return;
    } else if (action === "publish") {
      const ok = await ask({ title: "Publish this review?", text: "It will show on players' profile pages with the reviewer's username, stars and feedback.", yes: "Publish" });
      if (ok === null) return;
    }
    btn.disabled = true;
    const r = await api("/reviews/" + encodeURIComponent(btn.dataset.id), { action });
    flash(r.ok ? "ok" : "error", r.ok ? "Review " + (action === "approve" ? "approved" : action === "publish" ? "published" : "rejected") + "." : errText(r, "Couldn't update the review."));
    loadReviews();
    refreshBadges();
  }

  async function saveRiskSettings(form) {
    const n = (sel) => Number(form.querySelector(sel).value);
    const r = await api("/risk/settings", { big_payout: n("#rsPayout"), big_multiplier: n("#rsMult"), daily_net_win: n("#rsNet"), failed_deposits: n("#rsFail") });
    flash(r.ok ? "ok" : "error", r.ok ? "Alert settings saved." : errText(r, "Couldn't save the settings."));
    if (r.ok) loadRisk(true);
  }

  const LOADERS = { overview: loadOverview, players: () => loadPlayers(), money: loadMoney, deposits: loadDeposits, payments: () => loadPaymentSettings(true), moneyrules: () => loadMoneyRules(true), blocked: () => loadAccounts("blocked"), banned: () => loadAccounts("banned"), deleted: () => loadAccounts("deleted"), games: loadGames, mines: loadMinesSignals, aviator: () => loadAviator(true), lotto: () => loadLotto(true), partners: loadPartners, withdrawals: loadWithdrawals, risk: loadRisk, reviews: loadReviews, support: () => loadSupport() };
  const ADD_MONEY = '<button class="btn btn-primary btn-sm" type="button" data-credit>' + U.icon("plus") + "Add / take money</button>";
  /* each section's title, a line on what it's for, and its buttons */
  const SECTIONS = {
    overview: { title: "Overview", lead: "How the casino is doing, and anything waiting for you.", actions: ADD_MONEY },
    players: { title: "Players", lead: "Find a player by name, number or id to see their money, bets and account.", actions: ADD_MONEY },
    money: { title: "Money", lead: "Every deposit, withdrawal, bet and adjustment as it happens." },
    deposits: { title: "Recent deposits", lead: "Every deposit attempt — successful, pending and failed — newest first. Search by player, and filter by status. Separate from withdrawals." },
    blocked: { title: AC.blocked.title, lead: AC.blocked.lead },
    banned: { title: AC.banned.title, lead: AC.banned.lead },
    deleted: { title: AC.deleted.title, lead: AC.deleted.lead },
    payments: { title: "TheTeller Payment Settings", lead: "Switch TheTeller payments ON or OFF for the whole website, and check the merchant ID and the connection. OFF stops new payments only; payments already started are still verified and credited. API keys and passwords stay hidden." },
    moneyrules: { title: "Betting & withdrawal settings", lead: "The minimum deposit, the betting eligibility rule and the withdrawal play-through rule, with the messages players see. Both rules are OFF by default, never deduct money and never hold winnings. Every change is confirmed, logged and shown in the history below." },
    withdrawals: { title: "Withdrawals", lead: "Players' requests to cash out. Send the money by hand, then Approve marks it paid; Reject returns it to the player's balance." },
    games: { title: "Games", lead: "Manage every game: switch it on or off, choose whether it offers free play (same odds as real money) and a strip of real big wins, pause and resume it, set bet limits and round timing, and watch live play, statistics and players' wins and losses. Results are drawn by the server and can't be seen or changed before a round ends." },
    risk: { title: "Risk management", lead: "Each player's deposits, winnings, withdrawals and net; per-player deposit tiers and bet limits (set from a player's profile); and alerts for big payouts, big winners and failed-deposit bursts. Limits are told to the player and never touch a balance, a win or a result." },
    reviews: { title: "Withdrawal reviews", lead: "What players said about their withdrawals, after an admin approved them. Approve a review, then Publish it to show it on players' profile pages (username, stars and feedback). Only genuine reviews players chose to submit appear here." },
    mines: { title: "Mines Signal", lead: "Admin only: where the hidden mines are in the rounds being played." },
    aviator: { title: "Aviator", lead: "Watch rounds and bets live, pause the game, and set its published RTP and bet limits." },
    lotto: { title: "Lotto", lead: "The daily 5/90 draw: set the draw time and payouts, see every draw and ticket, check the numbers once betting closes, then release the results to pay the winners." },
    partners: { title: "Partners", lead: "Add partners with a secure setup link, approve applications, pay commission and choose what partners can use.", actions: '<button class="btn btn-primary btn-sm" type="button" data-add-partner>' + U.icon("plus") + "Add partner</button>" },
    support: { title: "Support", lead: "Players write from the chat button on every page; your replies show in their chat as “WIN B casino Support”. Unread conversations come first." },
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
    set("reviews", w.reviews || 0);
    set("lotto", w.lotto || 0);
    set("support", w.support || 0);
    set("blocked", w.blocked || 0);
    set("banned", w.banned || 0);
    set("deleted", w.deleted || 0);
    /* payments switched off: the menu says so */
    const pb = document.querySelector('[data-badge="payments"]');
    pb.hidden = r.data.paymentsOn !== false;
    pb.textContent = "OFF";
    /* on a phone the menu button carries a dot while anything is waiting */
    $("admMenuDot").hidden = !((w.withdrawals || 0) + (w.partners || 0) + (w.partnerPayouts || 0) + (w.support || 0));
    /* the overview's "needs your attention" cards follow the same counts */
    if (state.tab === "overview" && $("ovAttn")) $("ovAttn").innerHTML = attention();
    /* unread support messages show in the browser tab's title too, for an admin working in another tab */
    document.title = (w.support ? "(" + w.support + ") " : "") + "Admin | WIN B WIN";
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
  $("admActions").addEventListener("click", (e) => {
    if (e.target.closest("[data-credit]")) openCredit();
    if (e.target.closest("[data-add-partner]")) openAddPartner();
  });
  $("admReload").addEventListener("click", () => { flash("", ""); refreshBadges(); LOADERS[state.tab](); });

  document.querySelector(".adm-wrap").addEventListener("submit", (e) => {
    if (e.target.matches('form[data-act="risk-settings"]')) { e.preventDefault(); saveRiskSettings(e.target); }
    if (e.target.matches('form[data-form="moneyrules"]')) { e.preventDefault(); saveMoneyRules(e.target); }
    if (e.target.matches('form[data-form="aviator"]')) { e.preventDefault(); saveAviator(e.target); }
    if (e.target.matches('form[data-form="lotto"]')) { e.preventDefault(); saveLotto(e.target); }
    if (e.target.matches('form[data-form="psettings"]')) { e.preventDefault(); savePartnerSettings(e.target); }
    if (e.target.matches('form[data-form="pperms"]')) { e.preventDefault(); savePartnerPermissions(e.target); }
    if (e.target.matches('form[data-form="flupload"]')) { e.preventDefault(); uploadFlyerAsset(e.target); }
    if (e.target.matches('form[data-form="pstats"]')) {
      e.preventDefault();
      pt.from = e.target.querySelector("#pstFrom").value;
      pt.to = e.target.querySelector("#pstTo").value;
      loadPartnerStats();
    }
  });

  document.querySelector(".adm-wrap").addEventListener("click", (e) => {
    if (e.target.closest("[data-av-toggle]")) return aviatorToggle();
    const acb = e.target.closest("[data-ac-act]");
    if (acb) return accountAction(acb.dataset.acAct, acb.dataset.acId, acb.dataset.acName);
    const tpt = e.target.closest("[data-tp-test]");
    if (tpt) return paymentTest(tpt);
    if (e.target.closest("[data-lt-toggle]")) return lottoToggle();
    if (e.target.closest("[data-lt-sales]")) return lottoSales();
    const ltRel = e.target.closest("[data-lt-release]");
    if (ltRel) return lottoRelease(ltRel.dataset.ltRelease);
    const ltCan = e.target.closest("[data-lt-cancel]");
    if (ltCan) return lottoCancel(ltCan.dataset.ltCancel);
    const ltTix = e.target.closest("[data-lt-tickets]");
    if (ltTix) return lottoTickets(ltTix.dataset.ltTickets);
    if (e.target.closest("[data-lt-tickets-close]")) { lt.tickets = null; return renderLottoTickets(); }
    const copy = e.target.closest("[data-copy]");
    if (copy) return copyText(copy.dataset.copy);
    const gopen = e.target.closest("[data-game-open]");
    if (gopen) return openGame(gopen.dataset.gameOpen);
    const psec = e.target.closest("[data-psec]");
    if (psec) return showPtSection(psec.dataset.psec, psec.dataset.pv);
    const inv = e.target.closest("[data-inv-renew], [data-inv-cancel]");
    if (inv) return inviteAction(inv);
    if (e.target.closest(".adm-panel [data-add-partner]")) return openAddPartner();
    const pact = e.target.closest("[data-pact]");
    if (pact) return partnerQuick(pact);
    const settle = e.target.closest("[data-psettle]");
    if (settle) return settleNow(settle);
    const fl = e.target.closest("button[data-fl]");
    if (fl) return flyerAction(fl);
    const chip = e.target.closest("[data-chips] [data-v]");
    if (chip) {
      const group = chip.closest("[data-chips]").dataset.chips;
      const v = chip.dataset.v;
      if (group === "range") { ov.range = v; return loadOverview(); }
      if (group === "feed") { mf.type = v; return loadMoney(); }
      if (group === "grange") { gm.range = v; return loadGames(); }
      if (group === "gfilter") {
        gm.filter = v;
        chip.parentElement.querySelectorAll("[data-v]").forEach((x) => { x.classList.toggle("on", x === chip); x.setAttribute("aria-pressed", String(x === chip)); });
        return drawGameList();
      }
      if (group === "pview") { pt.view = v; pt.status = v; return loadPartners(); }
      if (group === "pset") { pt.view = v; pt.setView = v; return loadPartners(); }
      if (group === "ppay") { pt.pay = v; return loadPartners(); }
      if (group === "prange") { pt.range = v; return loadPartners(); }
      if (group === "wstatus") { wd.status = v; return loadWithdrawals(); }
      if (group === "dstatus") { dep.status = v; return loadDeposits(); }
      if (group === "rrange") { rk.range = v; return loadRisk(true); }
      if (group === "rvstatus") { rv.status = v; return loadReviews(); }
      if (group === "sview") { sp.view = v; return loadSupport(); }
    }
    /* the overview's "needs your attention" cards open their section, on the right view */
    const go = e.target.closest("[data-go]");
    if (go) {
      const view = go.dataset.view;
      if (go.dataset.go === "partners" && view) pt.view = view;
      if (go.dataset.go === "partners" && view === "payouts") pt.pay = "OPEN";
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
    const rvb = e.target.closest("[data-review]");
    if (rvb) return reviewAction(rvb);
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
    const flsw = e.target.closest("input[data-fltpl-on], input[data-flcamp-on]");
    if (flsw) return flyerToggle(flsw);
    const gf = e.target.closest("input[data-gflag]");
    if (gf) return gameFlag(gf);
    const psw = e.target.closest("input[data-pay-switch]");
    if (psw) return paymentSwitch(psw);
    const sw = e.target.closest(".adm-switch input[data-kind]");
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
      setInterval(() => { if (state.tab === "deposits" && !document.hidden) loadDeposits(true); }, 10000),
      setInterval(() => { if (state.tab === "risk" && !document.hidden && !document.querySelector(".adm-sheet")) loadRisk(true); }, 20000),
      setInterval(() => { if (state.tab === "reviews" && !document.hidden) loadReviews(true); }, 20000),
      setInterval(() => { if (state.tab === "lotto" && !document.hidden && !document.querySelector(".adm-sheet, .me-dialog")) loadLotto(false); }, 20000),
      setInterval(() => { if (state.tab === "support" && !document.hidden && !document.querySelector(".adm-sheet")) loadSupport(true); }, 15000),
      setInterval(() => { if (state.tab === "mines" && !document.hidden) loadMinesSignals(); }, 2000),
      setInterval(() => { if (state.tab === "aviator" && !document.hidden && !document.querySelector(".adm-sheet")) loadAviator(false); }, 2000));
    /* the round countdowns tick every second between refreshes */
    setInterval(() => { if (state.tab === "mines" && !document.hidden && minesSignals.last.some((s) => s.source === "live")) renderMinesSignals(minesSignals.last); }, 1000);
  })();
})();
