/* Me (account) page: profile + balance, quick actions, menu sheets, log-out confirmation */
(function () {
  "use strict";
  const U = window.VBUtil;
  const VB = window.VB;
  const $ = (id) => document.getElementById(id);
  const session = U.session.get();
  const NOTIF_SEEN = "vb.notifSeen";

  /* 0241234194 → 02*****194 */
  function maskId(phone) {
    const p = U.normalizePhone(phone || "");
    return /^0\d{9}$/.test(p) ? p.slice(0, 2) + "*****" + p.slice(7) : "—";
  }

  function fmtWhen(iso) {
    const d = new Date(iso);
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today " + time;
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday " + time;
    return d.toLocaleDateString("en-GB") + " " + time;
  }

  const readSeen = () => {
    try { return Number(localStorage.getItem(NOTIF_SEEN)) || 0; } catch (e) { return 0; }
  };
  const writeSeen = (v) => {
    try { localStorage.setItem(NOTIF_SEEN, String(v)); } catch (e) { /* storage unavailable */ }
  };

  /* ---------------- signed in or not ---------------- */
  $("meHero").hidden = !session;
  $("meGuest").hidden = !!session;
  document.querySelectorAll("[data-auth]").forEach((el) => (el.hidden = !session));
  $("meYear").textContent = new Date().getFullYear();

  /* ---------------- payment partners (the methods the wallet actually accepts) ---------------- */
  $("mePartners").innerHTML = VB.payments.map((m) =>
    '<span class="me-partner"><i style="background:' + m.color + (m.ink ? ";color:" + m.ink : ";color:#fff") + '">' +
    m.initials + "</i>" + U.esc(m.name) + "</span>").join("");

  /* ---------------- other accounts: the US dollar account and WIN B Points ---------------- */
  function paintAccounts(data, points) {
    const others = Array.isArray(data.otherAccounts) ? data.otherAccounts : [];
    const fmt = (v, code) => Number(v || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: code === "GHS" || code === "USD" ? 2 : 8 });
    const rows = others.map((a) =>
      '<div class="me-account"><span class="me-acc-sym">' + U.esc(a.symbol || a.currencyCode) + '</span><span class="me-acc-name">' + U.esc(a.name) +
      "<small>" + U.esc(a.currencyCode) + " account</small></span><b>" + U.esc(a.symbol || "") + " " + fmt(a.available, a.currencyCode) + "</b></div>")
      .concat(['<div class="me-account"><span class="me-acc-sym">★</span><span class="me-acc-name">WIN B Points<small>Loyalty rewards</small></span><b>' + points.toLocaleString("en-GB") + " pts</b></div>"]);
    $("meAccountsList").innerHTML = rows.join("") +
      '<p class="me-acc-note">Use Convert to move money between your cedi and dollar accounts. Deposits and withdrawals are in cedis.</p>';
    const usd = others.find((a) => a.currencyCode === "USD");
    $("meAccountsSummary").textContent = (usd ? "$ " + fmt(usd.available, "USD") + " · " : "") + points.toLocaleString("en-GB") + " pts";
    $("meAccounts").hidden = false;
  }
  $("meAccountsToggle").addEventListener("click", () => {
    const open = $("meAccountsList").hidden;
    $("meAccountsList").hidden = !open;
    $("meAccountsToggle").setAttribute("aria-expanded", String(open));
  });

  /* ---------------- the "How to play" and "Update app" sheets work signed out too ---------------- */
  const TIERS = [[0, 1], [1000, 2], [5000, 3], [20000, 4]];
  let transactions = [];

  if (session) {
    const name = session.name || "Player";
    $("meName").textContent = name;
    $("meAvatar").textContent = name.trim().charAt(0).toUpperCase() || "V";
    $("meAcct").textContent = maskId(session.phone);

    const next = new Date();
    next.setMonth(next.getMonth() + 1, 1);
    $("meTierNext").textContent = next.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

    U.paymentApi("/api/user/balances").then((r) => {
      if (!r.ok || !r.data.primary) return;
      U.wallet.setBalance(Number(r.data.primary.available) || 0);
      /* the primary account is in the currency of the player's country, fixed at registration */
      $("meCurrencyCode").textContent = r.data.primary.currencyCode || "GHS";
      $("meCurrencyName").textContent = r.data.primary.name || "";
      const points = Number(r.data.loyaltyPoints && r.data.loyaltyPoints.available) || 0;
      $("meTier").textContent = TIERS.filter(([min]) => points >= min).pop()[1];
      paintAccounts(r.data, points);
    });

    const played = U.recent.all().length;
    $("qGames").textContent = played ? played + " played" : "None yet";

    const days = U.streak.get();
    $("mStreak").textContent = days === 1 ? "1 day" : days + " days";

    U.paymentApi("/api/admin/me").then((r) => { if (r.ok && r.data.admin) $("meAdmin").hidden = false; });
    U.paymentApi("/api/user/limits").then((r) => { if (r.ok) paintLimitsRow(r.data); });

    U.paymentApi("/api/user/transactions").then((r) => {
      if (!r.ok || !Array.isArray(r.data.transactions)) return;
      transactions = r.data.transactions;
      const seen = readSeen();
      const unread = transactions.filter((t) => new Date(t.created_at).getTime() > seen).length;
      $("mNotif").textContent = unread > 9 ? "9+" : unread;
      $("mNotif").hidden = !unread;
    });
  }

  /* ---------------- responsible gaming ---------------- */
  const PERIODS = [["daily", "Daily", "last 24 hours"], ["weekly", "Weekly", "last 7 days"], ["monthly", "Monthly", "last 30 days"]];
  const BREAKS = [[1, "24 hours", "24-hour"], [7, "7 days", "7-day"], [30, "30 days", "30-day"], [180, "6 months", "6-month"]];
  const fmtDate = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  function paintLimitsRow(v) {
    const set = Object.values(v.limits).some((x) => x !== null);
    $("mLimits").textContent = v.excludedUntil ? "On a break" : set ? "Limits on" : "";
  }

  function limitsBody(v) {
    const pend = v.pending || {};
    const fields = PERIODS.map(([p, label, span]) => {
      const lim = v.limits[p];
      const waiting = p in pend
        ? "<span class='rg-pending'>" + (pend[p] === null ? "Removed" : "Rises to " + U.money(pend[p])) + " on " + fmtDate(v.pendingFrom) + "</span>" : "";
      return '<div class="rg-field"><label for="rg-' + p + '">' + label + " <small>" + span + "</small></label>" +
        '<div class="rg-input"><span>₵</span><input id="rg-' + p + '" type="number" inputmode="decimal" min="1" step="1" placeholder="No limit" value="' +
        (lim === null ? "" : lim) + '"></div>' +
        '<span class="rg-used">' + U.money(v.used[p]) + " deposited" + (lim !== null ? " of " + U.money(lim) : "") + "</span>" + waiting + "</div>";
    }).join("");
    return (v.excludedUntil
      ? '<div class="alert alert-info rg-break-on">You\'re taking a break until <b>' + fmtDate(v.excludedUntil) + "</b>. Deposits are paused; withdrawals still work.</div>" : "") +
      '<h3 class="me-sheet-sub">Deposit limits</h3>' +
      '<p class="me-sheet-note">Lowering a limit works straight away. Raising or removing one takes 24 hours.</p>' +
      fields + '<p class="me-sheet-status" aria-live="polite"></p>' +
      '<button class="btn btn-primary btn-lg btn-block" type="button" id="rgSave">Save limits</button>' +
      '<h3 class="me-sheet-sub">Take a break</h3>' +
      '<p class="me-sheet-note">Pause deposits for a while. Once started, a break can\'t be shortened.</p>' +
      '<div class="rg-breaks">' + BREAKS.map(([d, l, adj]) => '<button class="btn btn-ghost" type="button" data-break="' + d + '" data-adj="' + adj + '">' + l + "</button>").join("") + "</div>";
  }

  function confirmBox(title, text, yes) {
    return new Promise((resolve) => {
      const dlg = document.createElement("div");
      dlg.className = "me-dialog";
      dlg.setAttribute("role", "alertdialog");
      dlg.setAttribute("aria-modal", "true");
      dlg.innerHTML = '<div class="me-dialog-card"><span class="me-dialog-ico rg-ico">' + U.icon("shield") + "</span><h2>" + title + "</h2><p>" + text + "</p>" +
        '<div class="me-dialog-actions"><button class="btn btn-ghost btn-lg" type="button" data-no>Cancel</button>' +
        '<button class="btn btn-primary btn-lg" type="button" data-yes>' + yes + "</button></div></div>";
      document.body.appendChild(dlg);
      dlg.addEventListener("click", (e) => {
        if (e.target === dlg || e.target.closest("[data-no]")) { dlg.remove(); resolve(false); }
        if (e.target.closest("[data-yes]")) { dlg.remove(); resolve(true); }
      });
      dlg.querySelector("[data-no]").focus();
    });
  }

  function mountLimits(body, v) {
    body.innerHTML = limitsBody(v);
    paintLimitsRow(v);
    const status = body.querySelector(".me-sheet-status");
    body.querySelector("#rgSave").addEventListener("click", async (e) => {
      const pend = v.pending || {};
      const changes = {};
      PERIODS.forEach(([p]) => {
        const raw = body.querySelector("#rg-" + p).value.trim();
        const val = raw === "" ? null : Math.round(Number(raw) * 100) / 100;
        const target = p in pend ? pend[p] : v.limits[p];
        if (val !== target) changes[p] = val;
      });
      if (!Object.keys(changes).length) { status.textContent = "Nothing to change."; return; }
      e.currentTarget.disabled = true;
      const r = await U.paymentApi("/api/user/limits", { body: Object.assign({ idempotency_key: "limits:" + crypto.randomUUID() }, changes) });
      if (!r.ok) {
        e.currentTarget.disabled = false;
        status.textContent = (r.data && r.data.message) || "Couldn't save your limits.";
        return;
      }
      mountLimits(body, r.data);
      const saved = body.querySelector(".me-sheet-status");
      saved.classList.add("ok");
      saved.textContent = r.data.pending ? "Saved. Raised or removed limits apply in 24 hours." : "Saved.";
    });
    body.querySelectorAll("[data-break]").forEach((b) => b.addEventListener("click", async () => {
      const label = b.textContent;
      const ok = await confirmBox("Take a " + b.dataset.adj + " break?",
        "You won't be able to deposit for " + label + ". This can't be undone or shortened. Withdrawals still work.", "Start break");
      if (!ok) return;
      const r = await U.paymentApi("/api/user/self-exclusion", { body: { days: Number(b.dataset.break), idempotency_key: "break:" + crypto.randomUUID() } });
      if (!r.ok) { status.textContent = (r.data && r.data.message) || "Couldn't start your break."; return; }
      mountLimits(body, r.data);
    }));
  }

  /* ---------------- bottom sheet ---------------- */
  let openSheet = null;
  function sheet(title, html, mount) {
    if (openSheet) openSheet.close(true);
    const opener = document.activeElement;
    const el = document.createElement("div");
    el.className = "me-sheet";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "meSheetTitle");
    el.innerHTML =
      '<div class="me-sheet-panel"><div class="me-sheet-grip" aria-hidden="true"></div>' +
      '<div class="me-sheet-head"><h2 id="meSheetTitle">' + title + "</h2>" +
      '<button class="me-sheet-close" type="button" aria-label="Close">' + U.icon("close") + "</button></div>" +
      '<div class="me-sheet-body">' + html + "</div></div>";
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));

    const onKey = (e) => { if (e.key === "Escape") api.close(); };
    const api = {
      body: el.querySelector(".me-sheet-body"),
      close(instant) {
        document.removeEventListener("keydown", onKey);
        el.classList.remove("show");
        setTimeout(() => el.remove(), instant ? 0 : 220);
        if (openSheet === api) openSheet = null;
        if (opener && opener.focus) opener.focus({ preventScroll: true });
      }
    };
    el.addEventListener("click", (e) => {
      if (e.target === el || e.target.closest(".me-sheet-close") || e.target.closest("[data-close]")) api.close();
    });
    document.addEventListener("keydown", onKey);
    openSheet = api;
    el.querySelector(".me-sheet-close").focus({ preventScroll: true });
    if (mount) mount(api.body, api);
    return api;
  }

  async function sendFeedback(body, statusEl) {
    statusEl.textContent = "Sending…";
    const r = await U.paymentApi("/api/user/feedback", {
      body: Object.assign({ idempotency_key: "feedback:" + crypto.randomUUID() }, body)
    });
    if (!r.ok) {
      statusEl.textContent = (r.data && (r.data.message || r.data.error)) || "Couldn't send that. Try again in a moment.";
      return false;
    }
    return true;
  }

  const thanks = (text) =>
    '<div class="me-done"><span class="me-done-ico">' + U.icon("star") + "</span><h3>Thank you!</h3><p>" + text + "</p>" +
    '<button class="btn btn-primary btn-lg btn-block" type="button" data-close>Close</button></div>';

  const SHEETS = {
    limits() {
      sheet("Responsible gaming", '<div class="txr-loading">' + "<i></i>".repeat(3) + "</div>", async (body) => {
        const r = await U.paymentApi("/api/user/limits");
        if (!r.ok) {
          body.innerHTML = '<p class="me-sheet-status">' + U.esc((r.data && r.data.message) || "Couldn't load your limits.") + "</p>";
          return;
        }
        mountLimits(body, r.data);
      });
    },

    games() {
      const games = U.recent.all().map((id) => VB.games.find((g) => g.id === id)).filter(Boolean);
      sheet("Game history", games.length
        ? '<p class="me-sheet-note">Recently played on this device</p><div class="me-games"></div>'
        : '<div class="me-empty"><p>You haven\'t played any games yet.</p><a class="btn btn-primary" href="games.html">Browse games</a></div>',
      (body) => {
        const grid = body.querySelector(".me-games");
        if (grid) games.forEach((g) => grid.appendChild(U.miniCard(g)));
      });
    },

    notifications() {
      const NOTE = {
        "deposit:success": ["ok", "Deposit successful", (t) => U.money(t.amount) + " was added to your balance."],
        "deposit:failed": ["bad", "Deposit not completed", (t) => U.money(t.amount) + " — no money was taken."],
        "deposit:pending": ["wait", "Deposit pending", (t) => U.money(t.amount) + " is waiting for confirmation."],
        "withdrawal:pending": ["wait", "Withdrawal requested", (t) =>
          U.money(t.amount) + (t.destination ? " to " + maskId(t.destination) : "") + " — awaiting payout."],
        "withdrawal:success": ["ok", "Withdrawal paid", (t) =>
          U.money(t.amount) + " was sent" + (t.destination ? " to " + maskId(t.destination) : "") + "."],
        "withdrawal:failed": ["bad", "Withdrawal returned", (t) =>
          U.money(t.amount) + " is back in your balance" + (t.reason ? " — " + t.reason : "") + "."]
      };
      const seen = readSeen();
      const items = transactions.slice(0, 20).map((t) => {
        const [tone, title, text] = NOTE[t.kind + ":" + t.status] || NOTE["deposit:pending"];
        const fresh = new Date(t.created_at).getTime() > seen;
        return '<li class="me-note' + (fresh ? " fresh" : "") + '"><span class="me-note-dot ' + tone + '"></span>' +
          "<span><strong>" + title + "</strong><span>" + U.esc(text(t)) + "</span><small>" + fmtWhen(t.created_at) + "</small></span></li>";
      }).join("");
      const offers = VB.promos.map((p) =>
        '<li class="me-note"><span class="me-note-dot offer"></span><span><strong>' + U.esc(p.title) + "</strong><span>" +
        U.esc(p.sub) + '</span><small>' + (p.soon ? "Coming soon · " : "") + '<a href="promotions.html">See what\'s planned</a></small></span></li>').join("");
      sheet("Notifications",
        (items ? '<h3 class="me-sheet-sub">Your account</h3><ul class="me-notes">' + items + "</ul>"
          : '<p class="me-sheet-note">No account activity yet. Deposits and withdrawals will show here.</p>') +
        (offers ? '<h3 class="me-sheet-sub">Coming soon</h3><ul class="me-notes">' + offers + "</ul>" : ""));
      writeSeen(Date.now());
      $("mNotif").hidden = true;
    },

    streak() {
      const days = U.streak.get();
      const best = Math.max(U.streak.best(), days);
      const week = Array.from({ length: 7 }, (_, i) => {
        const back = 6 - i; // oldest first; today last
        const d = new Date();
        d.setDate(d.getDate() - back);
        const label = d.toLocaleDateString("en-GB", { weekday: "narrow" });
        return '<span class="me-day' + (back < days ? " on" : "") + '"><i></i>' + label + "</span>";
      }).join("");
      sheet("Daily streak",
        '<div class="me-streak"><span class="me-streak-flame">' + U.icon("flame") + "</span>" +
        '<strong>' + days + (days === 1 ? " day" : " days") + "</strong><span>in a row</span></div>" +
        '<div class="me-week">' + week + "</div>" +
        '<p class="me-sheet-note">Best streak: <b>' + best + (best === 1 ? " day" : " days") + "</b>. Open WIN B casino every day to keep it going — " +
        "days are counted on this device.</p>");
    },

    howto() {
      const step = (icon, title, text) =>
        '<li><span class="me-step-ico">' + U.icon(icon) + "</span><span><strong>" + title + "</strong><span>" + text + "</span></span></li>";
      sheet("How to play",
        '<ol class="me-steps">' +
        step("plus", "Deposit", 'Top up from <a href="wallet.html">Deposit</a> with mobile money — approve the prompt with your PIN.') +
        step("grid", "Pick a game", 'Crash, instant wins, slots and tables are in the <a href="games.html">lobby</a>.') +
        step("stack", "Set your stake", "Choose how much to bet each round. Every game shows its rules and its return to player.") +
        step("bolt", "Cash out", "In crash-style games, cash out before the round ends to lock in your multiplier.") +
        step("withdraw", "Withdraw", 'Send winnings to your registered number from <a href="withdraw.html">Withdraw</a>.') +
        "</ol>" +
        '<p class="me-sheet-note">Play for fun, set a budget and stop when you reach it.</p>');
    },

    rate() {
      sheet("Rate WIN B casino",
        '<p class="me-sheet-note">How are you enjoying WIN B casino?</p>' +
        '<div class="me-stars" role="radiogroup" aria-label="Rating">' +
        [1, 2, 3, 4, 5].map((n) => '<button type="button" role="radio" aria-checked="false" aria-label="' + n + " star" + (n > 1 ? "s" : "") +
          '" data-star="' + n + '">' + U.icon("star") + "</button>").join("") +
        "</div>" +
        '<label class="sr-only" for="meRateText">Tell us more (optional)</label>' +
        '<textarea id="meRateText" class="me-textarea" maxlength="500" rows="3" placeholder="Tell us more (optional)"></textarea>' +
        '<p class="me-sheet-status" aria-live="polite"></p>' +
        '<button class="btn btn-primary btn-lg btn-block" type="button" id="meRateSend" disabled>Submit rating</button>',
      (body) => {
        let rating = 0;
        const stars = Array.from(body.querySelectorAll("[data-star]"));
        const paint = (n) => stars.forEach((s) => s.classList.toggle("on", Number(s.dataset.star) <= n));
        stars.forEach((s) => {
          s.addEventListener("click", () => {
            rating = Number(s.dataset.star);
            stars.forEach((x) => x.setAttribute("aria-checked", String(x === s)));
            paint(rating);
            body.querySelector("#meRateSend").disabled = false;
          });
          s.addEventListener("mouseenter", () => paint(Number(s.dataset.star)));
          s.addEventListener("mouseleave", () => paint(rating));
        });
        body.querySelector("#meRateSend").addEventListener("click", async (e) => {
          e.currentTarget.disabled = true;
          const ok = await sendFeedback({ kind: "rating", rating, message: body.querySelector("#meRateText").value },
            body.querySelector(".me-sheet-status"));
          if (ok) body.innerHTML = thanks("Your rating helps us make WIN B casino better.");
          else e.currentTarget.disabled = false;
        });
      });
    },

    idea() {
      sheet("Share an idea",
        '<p class="me-sheet-note">A game you\'d like, something to fix, a feature that would help — we read every one.</p>' +
        '<label class="sr-only" for="meIdeaText">Your idea</label>' +
        '<textarea id="meIdeaText" class="me-textarea" maxlength="500" rows="5" placeholder="Your idea…"></textarea>' +
        '<div class="me-counter"><span id="meIdeaCount">0</span>/500</div>' +
        '<p class="me-sheet-status" aria-live="polite"></p>' +
        '<button class="btn btn-primary btn-lg btn-block" type="button" id="meIdeaSend" disabled>Send idea</button>',
      (body) => {
        const text = body.querySelector("#meIdeaText");
        const send = body.querySelector("#meIdeaSend");
        text.addEventListener("input", () => {
          body.querySelector("#meIdeaCount").textContent = text.value.length;
          send.disabled = !text.value.trim();
        });
        send.addEventListener("click", async () => {
          send.disabled = true;
          const ok = await sendFeedback({ kind: "idea", message: text.value }, body.querySelector(".me-sheet-status"));
          if (ok) body.innerHTML = thanks("Thanks for the idea — it's been sent to the WIN B casino team.");
          else send.disabled = false;
        });
        text.focus();
      });
    },

    update() {
      const script = document.querySelector('script[src*="site.js"]');
      const version = script ? new URL(script.src, location.href).searchParams.get("v") : null;
      sheet("Update app",
        '<div class="me-done"><span class="me-done-ico">' + U.icon("refresh") + "</span><h3>You're up to date</h3>" +
        "<p>WIN B casino runs in your browser and updates itself" + (version ? " (version " + U.esc(version) + ")" : "") +
        ". If something looks out of date, reload to fetch the newest version.</p>" +
        '<button class="btn btn-primary btn-lg btn-block" type="button" id="meReload">Reload now</button></div>',
      (body) => body.querySelector("#meReload").addEventListener("click", () => location.reload()));
    }
  };

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sheet]");
    if (b && SHEETS[b.dataset.sheet]) SHEETS[b.dataset.sheet]();
  });

  /* ---------------- log out, with confirmation ---------------- */
  const logoutBtn = $("meLogout");
  if (logoutBtn) logoutBtn.addEventListener("click", () => {
    const opener = document.activeElement;
    const dlg = document.createElement("div");
    dlg.className = "me-dialog";
    dlg.setAttribute("role", "alertdialog");
    dlg.setAttribute("aria-modal", "true");
    dlg.setAttribute("aria-labelledby", "meDlgTitle");
    dlg.setAttribute("aria-describedby", "meDlgText");
    dlg.innerHTML =
      '<div class="me-dialog-card"><span class="me-dialog-ico">' + U.icon("logout") + "</span>" +
      '<h2 id="meDlgTitle">Log out?</h2><p id="meDlgText">Are you sure you want to log out of WIN B casino?</p>' +
      '<div class="me-dialog-actions"><button class="btn btn-ghost btn-lg" type="button" data-no>Cancel</button>' +
      '<button class="btn btn-danger btn-lg" type="button" data-yes>Log out</button></div></div>';
    document.body.appendChild(dlg);
    const close = () => {
      dlg.remove();
      document.removeEventListener("keydown", onKey);
      if (opener && opener.focus) opener.focus();
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg || e.target.closest("[data-no]")) close();
      if (e.target.closest("[data-yes]")) {
        U.session.logout();
        /* replace: Back shouldn't return to the now-signed-out account page */
        location.replace("register.html#login");
      }
    });
    dlg.querySelector("[data-no]").focus();
  });
})();
