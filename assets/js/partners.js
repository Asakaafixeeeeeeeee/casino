/* WIN B casino Partners: apply, then (once an admin approves you) a revenue-share portal: dashboard, referrals,
   statistics, wallet and settings. Access is enforced by the balance service: partner data only comes back for an
   approved partner's own account. With ?preview=<user id> an admin sees that partner's portal, read only. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);
  const esc = U.esc;
  const money = (n) => U.money(n);
  const count = (n) => Number(n || 0).toLocaleString("en-GH");
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
  const whenTime = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  const ago = (iso) => {
    if (!iso) return "—";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + " min ago" : s < 86400 ? Math.floor(s / 3600) + " h ago" : when(iso);
  };
  /* signed money: negatives in red with a real minus sign */
  const smoney = (n) => (Number(n) < 0 ? '<span class="prt-neg">−' + money(-n) + "</span>" : money(n));
  const tone = (n) => (Number(n) < 0 ? "bad" : "");
  const pct = (n) => Number(n || 0).toLocaleString("en-GH", { maximumFractionDigits: 2 }) + "%";

  const PREVIEW = new URLSearchParams(location.search).get("preview") || "";
  /* reads go to the partner's own routes, or (admin preview) to the admin's read-only copy of them */
  const get = (view, qs) => U.paymentApi(
    (PREVIEW ? "/api/admin/partners/" + encodeURIComponent(PREVIEW) + "/view/" : "/api/partners/") + view + (qs ? "?" + qs : ""));
  const post = (path, body) => U.paymentApi("/api/partners" + path, { body });
  const acct = (path, body) => U.api(path, body ? { body } : {});
  const errText = (r, fallback) => esc((r.data && (r.data.message || r.data.error)) || fallback);
  const view = $("prtView");
  const REFRESH_MS = 60000;
  const TODAY = () => new Date().toISOString().slice(0, 10);

  const state = {
    partner: null, tab: "dashboard", readOnly: !!PREVIEW,
    ranges: { referrals: { range: "all" }, statistics: { range: "30d" } },
    payMethod: "", saveMethod: "", settings: null,
  };

  let msgTimer = 0;
  function flash(kind, html) {
    clearTimeout(msgTimer);
    $("msg").innerHTML = html ? "<div class='alert alert-" + (kind === "error" ? "err" : kind) + "'>" + html + "</div>" : "";
    if (html && kind !== "error") msgTimer = setTimeout(() => ($("msg").innerHTML = ""), 6000);
    if (html) $("msg").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  const RULES =
    '<ul class="prt-rules">' +
    "<li>Promote to adults only (18+). Never aim at children or students, or post where they gather.</li>" +
    "<li>Be honest: no promises of winning, “easy money” or guaranteed profits, and no fake wins or screenshots.</li>" +
    "<li>No spam, and no bidding on the WIN B casino name in search ads.</li>" +
    "<li>Always show <b>18+ · Play responsibly</b> with your link (our banners already do).</li>" +
    "<li>Your own accounts, fake accounts and accounts shared between people don't count, and commission from them is withheld.</li></ul>";
  const PITCH = "Share your link with your audience. You earn a share of the net gaming revenue the players you bring generate — what they stake minus what they win.";
  const LOADING = '<div class="txr-loading"><i></i><i></i><i></i></div>';

  /* ---------------- not signed in / not a partner yet ---------------- */
  const hero = (title, text) => '<section class="prt-hero"><span class="prt-hero-ico">' + U.icon("star") + "</span><h1>" + title + "</h1><p>" + text + "</p></section>";
  const step = (n, title, text) => '<div class="prt-step"><b>' + n + "</b><div><strong>" + title + "</strong><p>" + text + "</p></div></div>";

  function drawSignedOut() {
    view.innerHTML = hero("WIN B casino Partners", PITCH) +
      '<div class="prt-steps">' +
        step(1, "Apply", "Tell us where you'll promote WIN B casino — your page, channel, group or website.") +
        step(2, "Get approved", "We review every partner and set your revenue share.") +
        step(3, "Share and earn", "Use your link and promo code; follow your players, revenue and commission here.") +
      "</div>" +
      '<a class="btn btn-primary btn-block btn-lg" href="register.html#login">Log in or register to apply</a>';
  }

  function drawApply() {
    view.innerHTML = hero("Become a WIN B casino partner", PITCH + " Your revenue share is set when we approve you.") +
      '<form class="panel prt-apply" id="applyForm">' +
        '<div class="field"><label for="apChannel">Where will you promote WIN B casino?</label>' +
        '<textarea id="apChannel" class="me-textarea" rows="3" maxlength="300" required placeholder="e.g. My football page on Facebook (12k followers) and a WhatsApp sports group"></textarea>' +
        '<span class="hint">Links help us review faster.</span></div>' +
        '<h3 class="me-sheet-sub">Marketing rules</h3>' + RULES +
        '<label class="checkbox"><input type="checkbox" id="apAgree" required> I agree to promote WIN B casino by these rules.</label>' +
        '<button class="btn btn-primary btn-block" type="submit">Send application</button></form>';
  }

  function drawWaiting() {
    const p = state.partner;
    const msgs = {
      PENDING: ["Application received", "We're reviewing your application. You'll see your link and dashboard here once you're approved."],
      REJECTED: ["Not approved this time", "We couldn't approve this application. If something has changed, contact support through the chat."],
      DISABLED: ["Partner account closed", "This partner account has been closed. Contact support through the chat if you think this is a mistake."],
    };
    const [title, text] = msgs[p.status] || msgs.PENDING;
    view.innerHTML = hero(title, text) +
      '<div class="panel prt-code"><span>Your partner code</span><b>' + esc(p.code) + "</b>" + "<small>Applied " + when(p.created_at) + "</small></div>";
  }

  /* ---------------- the portal shell ---------------- */
  const TABS = [["dashboard", "Dashboard"], ["referrals", "My Referrals"], ["statistics", "Statistics"], ["wallet", "Wallet"], ["settings", "Settings"]];
  const link = () => location.origin + "/?ref=" + encodeURIComponent(state.partner.code);

  function drawPortal() {
    const p = state.partner;
    view.innerHTML =
      (PREVIEW ? '<div class="prt-preview">' + U.icon("shield") + "<span><b>Admin preview — read only</b> (partner " + esc(p.code) + ", " + esc(p.status) + ")</span></div>" : "") +
      (!PREVIEW && p.status === "SUSPENDED"
        ? '<div class="alert alert-info prt-notice">Your partner account is suspended: your link isn\'t counting new players, and payouts and changes are on hold. You can still see your figures. Contact support through the chat to find out more.</div>' : "") +
      '<nav class="adm-tabs prt-tabs" role="tablist" aria-label="Partner portal">' +
        TABS.map(([id, label]) => '<button type="button" role="tab" data-tab="' + id + '" aria-selected="false">' + label + "</button>").join("") +
      '</nav><div id="prtTab" role="tabpanel"></div>';
    const h = location.hash.slice(1);
    show(TABS.some((t) => t[0] === h) ? h : "dashboard");
  }

  /* a tab is drawn from scratch each time it's shown; a newer load makes an older one's answer stale */
  let loadSeq = 0;
  let lastLoad = 0;
  function show(tab) {
    state.tab = tab;
    view.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    if (location.hash.slice(1) !== tab) history.replaceState(null, "", "#" + tab);
    const ranged = tab === "referrals" || tab === "statistics";
    $("prtTab").innerHTML = (ranged ? '<div id="rangeBox">' + rangeBar(tab) + "</div>" : "") + '<div id="tabBody">' + LOADING + "</div>";
    lastLoad = Date.now();
    return LOADERS[tab](++loadSeq, false);
  }

  /* a failed load: the account may have stopped being a partner; otherwise say so with a retry */
  function failed(r, fallback, quiet) {
    if (r.status === 403 && !PREVIEW && r.data && r.data.error === "not_a_partner") return start();
    if (quiet) return;
    $("tabBody").innerHTML = '<div class="alert alert-err">' + errText(r, fallback) + '</div><button class="btn btn-ghost btn-sm" type="button" data-retry>' + U.icon("refresh") + "Try again</button>";
  }

  const kpi = (label, value, sub, cls) =>
    '<div class="adm-kpi' + (cls ? " " + cls : "") + '"><span>' + label + "</span><strong>" + value + "</strong>" + (sub ? "<small>" + sub + "</small>" : "") + "</div>";
  const terms = (s) => "You earn <b>" + pct(s.rate.pct) + "</b> of what your players lose; when a player wins, <b>" + pct(s.winDeductionPct) + "</b> of their net winnings is deducted.";
  const scheduled = (rate) => (rate.scheduled ? '<p class="hint">Your share changes to <b>' + pct(rate.scheduled.pct) + "</b> from " + whenTime(rate.scheduled.effective_from) + ".</p>" : "");
  const linkRow = (id, value, what) =>
    '<div class="prt-linkrow"><input id="' + id + '" readonly value="' + esc(value) + '" aria-label="' + what + '">' +
    '<button class="btn btn-primary btn-sm" type="button" data-copy="' + id + '" data-what="' + what + '">Copy</button></div>';

  /* ---------------- Dashboard ---------------- */
  const STATUS_WORD = { ACTIVE: ["ok", "Active"], SUSPENDED: ["bad", "Suspended"], PENDING: ["warn", "Pending"], REJECTED: ["bad", "Rejected"], DISABLED: ["bad", "Disabled"] };
  const VIA = { link: "Referral link", promo: "Promo code", "link+promo": "Link + promo code", admin: "Added by admin" };
  async function loadDashboard(seq, quiet) {
    const [sum, set, wal, refs, com] = await Promise.all([
      get("summary"), get("settings"), get("wallet"), get("referrals", "range=all"), get("commissions", "limit=20"),
    ]);
    if (seq !== loadSeq || state.tab !== "dashboard") return;
    for (const r of [sum, set, wal, refs, com]) if (!r.ok) return failed(r, "Couldn't load your dashboard.", quiet);
    const s = sum.data;
    const w = s.wallet;
    const rs = s.revenueShare;
    const st = set.data;
    state.partner = Object.assign({}, state.partner, s.partner);
    const p = state.partner;
    const [stCls, stTxt] = STATUS_WORD[p.status] || ["", p.status];
    const canPay = !state.readOnly && w.available >= w.minPayout;
    const signups = refs.data.referrals.slice(0, 10);
    const payouts = wal.data.payouts.slice(0, 5);
    const commissions = com.data.commissions;
    $("tabBody").innerHTML =
      /* the partner's unique link first: it's what they share */
      '<section class="panel prt-linkbox prt-mainlink">' +
        '<span class="prt-label">Your unique referral link</span>' + linkRow("lnk", link(), "Your referral link") +
        (p.link_live ? "" : '<p class="alert alert-info">Your link is switched off at the moment — new visitors through it won\'t become your players.</p>') +
        '<div class="prt-idrow"><span>Partner ID <b>' + esc(p.code) + "</b></span>" +
          "<span>Promo code <b>" + (p.promo_code ? esc(p.promo_code) : "—") + "</b></span>" +
          '<span>Status <span class="adm-pill ' + stCls + '">' + esc(stTxt) + "</span></span>" +
          "<span>Commission <b>" + pct(st.rate.pct) + "</b></span></div>" +
        '<p class="prt-terms">' + terms(st) + "</p>" + scheduled(st.rate) +
        '<p class="hint">Anyone who opens an account through this link (or with your promo code) becomes your player for good.</p>' +
      "</section>" +

      '<section class="prt-top">' +
        '<div><span class="prt-label">Total commission earned</span><b class="prt-codeval">' + money(w.totalEarned) + "</b>" +
        "<small>lifetime, before deductions</small></div>" +
        '<div class="prt-avail"><span class="prt-label">Available</span><b' + (w.available < 0 ? ' class="prt-neg"' : "") + ">" + smoney(w.available) + "</b>" +
        (state.readOnly ? "" : '<button class="btn btn-primary btn-sm" type="button" data-go="wallet"' + (canPay ? "" : " disabled") + ">Request withdrawal</button>") +
        (!state.readOnly && !canPay ? "<small>Withdrawals from " + money(w.minPayout) + "</small>" : "") + "</div></section>" +

      '<div class="adm-feed-head"><h3 class="adm-h">Players</h3>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-refresh>' + U.icon("refresh") + "Refresh</button></div>" +
      '<div class="adm-kpis">' +
        kpi("Total referrals", count(s.totalReferrals), count(s.referrals30) + " in the last 30 days") +
        kpi("Active referrals", count(s.activePlayers), "played in the last 30 days") +
        kpi("Link clicks", count(s.clicks), "all time") +
      "</div>" +
      '<h3 class="adm-h">Commission wallet</h3><div class="adm-kpis">' +
        kpi("Total commission earned", money(w.totalEarned), "lifetime", "in") +
        kpi("Available balance", smoney(w.available), "ready to withdraw", w.available < 0 ? "bad" : "in") +
        kpi("Pending commission", smoney(w.pending), "until the " + periodWord(w.settlementPeriod) + " period closes", tone(w.pending)) +
        kpi("Total withdrawn", money(w.withdrawn)) +
        kpi("Negative adjustments", smoney(w.negativeAdjustments), "from player wins", w.negativeAdjustments < 0 ? "bad" : "") +
        kpi("Pending withdrawals", money(w.pendingWithdrawals), "", w.pendingWithdrawals ? "warn" : "") +
        (w.carriedNegative ? kpi("Carried negative", smoney(w.carriedNegative), "set against your next earnings", "bad") : "") +
      "</div>" +
      '<h3 class="adm-h">Revenue share</h3><div class="adm-kpis">' +
        kpi("Today", smoney(rs.today), "", tone(rs.today)) +
        kpi("Yesterday", smoney(rs.yesterday), "", tone(rs.yesterday)) +
        kpi("This week", smoney(rs.week), "since Monday", tone(rs.week)) +
        kpi("This month", smoney(rs.month), "", tone(rs.month)) +
        kpi("Lifetime", smoney(rs.lifetime), "", tone(rs.lifetime) || (rs.lifetime > 0 ? "in" : "")) +
      "</div>" +

      '<h3 class="adm-h">Commission history</h3>' +
      (commissions.length
        ? '<div class="adm-table-wrap"><table class="adm-table prt-table" id="prtCommissions"><thead><tr><th>Date</th><th>Player</th><th>Game</th><th>Stake</th><th>Payout</th>' +
          "<th>Rate</th><th>Commission</th><th>Status</th></tr></thead><tbody>" +
          commissions.map((c) => "<tr><td>" + whenTime(c.settled_at) + "</td><td>" + esc(c.id) + "</td><td>" + esc(c.game) + "</td><td>" + money(c.stake) +
            "</td><td>" + money(c.payout) + "</td><td>" + pct(c.pct) + "</td><td>" + smoney(c.amount) + "</td><td>" +
            '<span class="adm-pill ' + (c.status === "settled" ? "ok" : "warn") + '">' + (c.status === "settled" ? "Settled" : "Pending") + "</span></td></tr>").join("") +
          "</tbody></table></div>"
        : '<p class="me-sheet-note">No commission yet — it appears here as soon as your players\' bets settle.</p>') +

      '<div class="adm-feed-head"><h3 class="adm-h">Referral registrations</h3>' +
        (s.totalReferrals > signups.length ? '<a href="#referrals" data-go="referrals">See all ' + count(s.totalReferrals) + "</a>" : "") + "</div>" +
      (signups.length
        ? '<div class="adm-table-wrap"><table class="adm-table prt-table" id="prtSignups"><thead><tr><th>Registered</th><th>User ID</th><th>Joined through</th><th>Last activity</th></tr></thead><tbody>' +
          signups.map((r) => "<tr><td>" + whenTime(r.joined) + "</td><td>" + esc(r.id) + "</td><td>" + esc(VIA[r.via] || r.via || "—") +
            (r.sub_id ? " <small>" + esc(r.sub_id) + "</small>" : "") + "</td><td>" + (r.last_activity ? ago(r.last_activity) : "—") + "</td></tr>").join("") +
          "</tbody></table></div>"
        : '<p class="me-sheet-note">No one has registered through your link yet. Share it to get started.</p>') +

      '<div class="adm-feed-head"><h3 class="adm-h">Payout requests</h3>' + (payouts.length ? '<a href="#wallet" data-go="wallet">Wallet</a>' : "") + "</div>" +
      (payouts.length
        ? '<div class="adm-table-wrap"><table class="adm-table" id="prtPayouts"><thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Reference / note</th></tr></thead><tbody>' +
          payouts.map((x) => {
            const [cls, txt] = PAY_STATUS[x.status] || ["", x.status];
            return "<tr><td>" + whenTime(x.created_at) + "</td><td>" + money(x.amount) + '</td><td><span class="adm-pill ' + cls + '">' + esc(txt) + "</span></td><td>" +
              (x.reference ? "<b>" + esc(x.reference) + "</b> " : "") + (x.note ? "<small>" + esc(x.note) + "</small>" : "") + (x.reference || x.note ? "" : "—") + "</td></tr>";
          }).join("") + "</tbody></table></div>"
        : '<p class="me-sheet-note">No payout requests yet.</p>') +

      '<p class="hint prt-dimnote">Figures in GHS, from our records, counted by UTC day. This page updates itself every minute.</p>' +
      banners();
  }
  const periodWord = (p) => ({ DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly" })[p] || "settlement";

  /* ready-made banners, each linked to the partner (tagged with its size) */
  const BANNERS = [
    { file: "winb-728x90.png", w: 728, h: 90, label: "Leaderboard · 728 × 90", web: true },
    { file: "winb-300x250.png", w: 300, h: 250, label: "Rectangle · 300 × 250", web: true },
    { file: "winb-320x100.png", w: 320, h: 100, label: "Mobile · 320 × 100", web: true },
    { file: "winb-1080x1080.jpg", w: 1080, h: 1080, label: "Social post · 1080 × 1080" },
    { file: "winb-1080x1920.jpg", w: 1080, h: 1920, label: "Story / Status · 1080 × 1920" },
  ];
  const bannerLink = (b) => link() + "&sub=banner_" + b.w + "x" + b.h;
  const embed = (b) => '<a href="' + bannerLink(b) + '" target="_blank" rel="sponsored noopener"><img src="' + location.origin + "/assets/img/partners/" + b.file +
    '" width="' + b.w + '" height="' + b.h + '" alt="WIN B casino — Olympus, Mines and more. 18+ Play responsibly."></a>';
  const caption = (b) => "Play Olympus, Mines, Roulette & more on WIN B casino — deposit and withdraw with mobile money. 18+ · Play responsibly. " + bannerLink(b);
  const banners = () =>
    '<h3 class="adm-h">Banners</h3><div class="prt-banners">' +
      BANNERS.map((b, i) => '<figure class="prt-banner"><div class="prt-banner-img"><img src="assets/img/partners/' + b.file + '" alt="' + esc(b.label) + ' banner" loading="lazy"></div>' +
        "<figcaption><strong>" + b.label + "</strong><span>" +
        '<a class="btn btn-ghost btn-sm" href="assets/img/partners/' + b.file + '" download="' + b.file + '">Download</a>' +
        (b.web ? '<button class="btn btn-ghost btn-sm" type="button" data-embed="' + i + '">Copy HTML</button>'
               : '<button class="btn btn-ghost btn-sm" type="button" data-caption="' + i + '">Copy caption</button>') +
        "</span></figcaption></figure>").join("") +
    "</div>" +
    '<h3 class="adm-h">Marketing rules</h3><div class="panel prt-how">' + RULES + "</div>";

  /* ---------------- range filter (referrals and statistics) ---------------- */
  const RANGES = {
    referrals: [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "Last 7 days"], ["this_month", "This month"], ["last_month", "Last month"], ["custom", "Custom dates"], ["all", "All time"]],
    statistics: [["today", "Today"], ["yesterday", "Yesterday"], ["7d", "7 days"], ["30d", "30 days"], ["this_month", "This month"], ["last_month", "Last month"], ["custom", "Custom dates"], ["all", "All time"]],
  };
  function rangeBar(tab) {
    const r = state.ranges[tab];
    return '<div class="prt-range"><div class="chip-list" role="group" aria-label="Date range">' +
      RANGES[tab].map(([v, l]) => '<button type="button" class="chip' + ((r.open ? "custom" : r.range) === v ? " on" : "") + '" data-range="' + v + '" aria-pressed="' + ((r.open ? "custom" : r.range) === v) + '">' + l + "</button>").join("") +
      "</div>" +
      (r.open || r.range === "custom"
        ? '<form class="prt-custom" id="customForm"><div class="field"><label for="rgFrom">From</label><input id="rgFrom" type="date" required max="' + TODAY() + '" value="' + esc(r.from || "") + '"></div>' +
          '<div class="field"><label for="rgTo">To</label><input id="rgTo" type="date" required max="' + TODAY() + '" value="' + esc(r.to || "") + '"></div>' +
          '<button class="btn btn-primary btn-sm" type="submit">Apply</button></form>'
        : "") + "</div>";
  }
  const rangeQs = (tab) => {
    const r = state.ranges[tab];
    return "range=" + encodeURIComponent(r.range) + (r.range === "custom" ? "&from=" + encodeURIComponent(r.from) + "&to=" + encodeURIComponent(r.to) : "");
  };

  /* ---------------- My Referrals ---------------- */
  async function loadReferrals(seq) {
    const r = await get("referrals", rangeQs("referrals"));
    if (seq !== loadSeq) return;
    if (!r.ok) return failed(r, "Couldn't load your referrals.");
    const d = r.data;
    const t = d.totals;
    $("tabBody").innerHTML =
      '<h3 class="adm-h">' + esc(d.range.label) + " · " + count(t.players) + " player" + (t.players === 1 ? "" : "s") + "</h3>" +
      (d.referrals.length
        ? '<div class="adm-table-wrap"><table class="adm-table prt-table"><thead><tr><th>User ID</th><th>Registered</th><th>Total stakes</th><th>Player payouts</th>' +
          "<th>Net gaming revenue</th><th>Your commission</th><th>Last activity</th></tr></thead><tbody>" +
          d.referrals.map((x) => "<tr><td><b>" + esc(x.id) + "</b><small> " + esc(x.player) + (x.via === "promo" ? " · promo" : "") + (x.sub_id ? " · " + esc(x.sub_id) : "") + "</small></td>" +
            "<td>" + when(x.joined) + "</td><td>" + money(x.stakes) + "</td><td>" + money(x.payouts) + "</td><td>" + smoney(x.ngr) + "</td>" +
            "<td>" + smoney(x.commission) + "</td><td>" + ago(x.last_activity) + "</td></tr>").join("") +
          "</tbody><tfoot><tr><td>Total</td><td>" + count(t.players) + "</td><td>" + money(t.stakes) + "</td><td>" + money(t.payouts) + "</td><td>" + smoney(t.ngr) +
          "</td><td>" + smoney(t.commission) + "</td><td></td></tr></tfoot></table></div>" +
          '<p class="hint prt-dimnote">Players registered at any time; stakes, payouts and commission are for ' + esc(d.range.label.toLowerCase()) + ". Last activity is their latest settled bet.</p>"
        : '<div class="panel prt-empty"><p class="me-sheet-note">No referred players yet. Share your link or promo code to get started.</p></div>');
  }

  /* ---------------- Statistics: inline SVG charts ---------------- */
  const W = 600;
  const H = 170;
  const PAD = 10;
  const label = (date, unit) => {
    const d = new Date(date + (unit === "month" ? "-01" : "") + "T00:00:00Z");
    return d.toLocaleDateString("en-GB", unit === "month" ? { month: "short", year: "numeric", timeZone: "UTC" } : { day: "numeric", month: "short", timeZone: "UTC" });
  };
  /* bars from a zero line: positives above, negatives below */
  function bars(series, key, unit, fmt, cls) {
    const vals = series.map((d) => d[key]);
    const max = Math.max(0, ...vals);
    const min = Math.min(0, ...vals);
    const span = max - min || 1;
    const y = (v) => PAD + ((max - v) / span) * (H - 2 * PAD);
    const zero = y(0);
    const bw = W / Math.max(1, series.length);
    const gap = Math.min(2, bw * 0.25);
    return svg(series.map((d, i) => {
      const v = d[key];
      const top = Math.min(y(v), zero);
      const h = Math.max(v ? 1 : 0, Math.abs(y(v) - zero));
      return '<rect class="' + (v < 0 ? "neg" : cls) + '" x="' + (i * bw + gap / 2).toFixed(2) + '" y="' + top.toFixed(2) + '" width="' + Math.max(1, bw - gap).toFixed(2) +
        '" height="' + h.toFixed(2) + '" rx="' + Math.min(3, bw / 4).toFixed(1) + '"><title>' + esc(label(d.date, unit)) + ": " + esc(fmt(v)) + "</title></rect>";
    }).join("") + '<line class="zero" x1="0" x2="' + W + '" y1="' + zero.toFixed(2) + '" y2="' + zero.toFixed(2) + '"/>', max, min, fmt);
  }
  function line(series, key, unit, fmt) {
    const vals = series.map((d) => d[key]);
    const max = Math.max(1, ...vals);
    const min = Math.min(0, ...vals);
    const span = max - min || 1;
    const x = (i) => (series.length < 2 ? W / 2 : (i / (series.length - 1)) * W);
    const y = (v) => PAD + ((max - v) / span) * (H - 2 * PAD);
    const pts = series.map((d, i) => x(i).toFixed(2) + "," + y(d[key]).toFixed(2));
    const bw = W / Math.max(1, series.length);
    return svg('<polygon class="area" points="0,' + y(min).toFixed(2) + " " + pts.join(" ") + " " + W + "," + y(min).toFixed(2) + '"/>' +
      '<polyline class="line" points="' + pts.join(" ") + '"/>' +
      '<line class="zero" x1="0" x2="' + W + '" y1="' + y(min).toFixed(2) + '" y2="' + y(min).toFixed(2) + '"/>' +
      series.map((d, i) => '<rect class="hit" x="' + (x(i) - bw / 2).toFixed(2) + '" y="0" width="' + bw.toFixed(2) + '" height="' + H + '"><title>' +
        esc(label(d.date, unit)) + ": " + esc(fmt(d[key])) + "</title></rect>").join(""), max, min, fmt);
  }
  const svg = (inner, max, min, fmt) =>
    '<div class="prt-plot"><span class="prt-ax top">' + esc(fmt(max)) + "</span>" + (min < 0 ? '<span class="prt-ax bot">' + esc(fmt(min)) + "</span>" : "") +
    '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' + inner + "</svg></div>";
  const plainMoney = (v) => (v < 0 ? "−" + money(-v) : money(v));
  const chartCard = (title, total, body, d) =>
    '<figure class="panel prt-chartcard"><figcaption><span class="prt-label">' + title + "</span><b>" + total + "</b></figcaption>" + body +
    '<div class="prt-axis"><span>' + esc(label(d.series[0].date, d.unit)) + "</span><span>" + esc(label(d.series[d.series.length - 1].date, d.unit)) + "</span></div></figure>";

  async function loadStatistics(seq) {
    const r = await get("statistics", rangeQs("statistics"));
    if (seq !== loadSeq) return;
    if (!r.ok) return failed(r, "Couldn't load your statistics.");
    const d = r.data;
    const t = d.totals;
    const s = d.series;
    const last = s.length ? s[s.length - 1].totalReferrals : 0;
    $("tabBody").innerHTML =
      '<h3 class="adm-h">' + esc(d.range.label) + " · by " + d.unit + "</h3>" +
      (s.length
        ? '<div class="prt-charts">' +
            chartCard("Net gaming revenue", smoney(t.ngr), bars(s, "ngr", d.unit, plainMoney, "pos"), d) +
            chartCard("Commission", smoney(t.earnings), bars(s, "earnings", d.unit, plainMoney, "gain"), d) +
            chartCard("Referral growth", count(last) + " <small>(+" + count(t.signups) + ")</small>", line(s, "totalReferrals", d.unit, count), d) +
            chartCard("Active players", count(t.activePlayers), bars(s, "activePlayers", d.unit, count, "pos"), d) +
          "</div>" +
          '<div class="adm-table-wrap"><table class="adm-table prt-table"><thead><tr><th>Date</th><th>Total stakes</th><th>Player payouts</th><th>Net gaming revenue</th>' +
          "<th>Commission</th><th>Negative adjustments</th><th>Final earnings</th></tr></thead><tbody>" +
          s.slice().reverse().map((x) => "<tr><td>" + esc(label(x.date, d.unit)) + "</td><td>" + money(x.stakes) + "</td><td>" + money(x.payouts) + "</td><td>" + smoney(x.ngr) +
            "</td><td>" + money(x.commission) + "</td><td>" + smoney(x.negative) + "</td><td><b>" + smoney(x.earnings) + "</b></td></tr>").join("") +
          "</tbody><tfoot><tr><td>Total</td><td>" + money(t.stakes) + "</td><td>" + money(t.payouts) + "</td><td>" + smoney(t.ngr) + "</td><td>" + money(t.commission) +
          "</td><td>" + smoney(t.negative) + "</td><td>" + smoney(t.earnings) + "</td></tr></tfoot></table></div>" +
          '<p class="hint prt-dimnote">Net gaming revenue = stakes − payouts. Days are UTC. Hover or tap a bar to see its value.</p>'
        : '<div class="panel prt-empty"><p class="me-sheet-note">No data for this range.</p></div>');
  }

  /* ---------------- payout details (wallet request form and saved details in Settings) ---------------- */
  const METHODS = [["MOMO", "Mobile Money"], ["BANK", "Bank transfer"], ["CRYPTO", "Crypto"]];
  const methodName = (m) => (METHODS.find((x) => x[0] === m) || [m, m])[1];
  const fld = (id, label, type, ph, value) =>
    '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + type + '" placeholder="' + esc(ph) + '" value="' + esc(value || "") + '" required></div>';
  /* the fields one method needs, filled from saved details when they're for the same method */
  function methodFields(pre, m, saved) {
    const v = saved && saved.method === m ? saved : {};
    if (m === "MOMO") return fld(pre + "Phone", "Mobile money number", "tel", "e.g. 024 123 4567", v.phone) + fld(pre + "Name", "Name on the account", "text", "", v.name);
    if (m === "BANK") return fld(pre + "Bank", "Bank", "text", "e.g. GCB Bank", v.bank) + fld(pre + "Acct", "Account number", "text", "", v.account_number) + fld(pre + "AcctName", "Account name", "text", "", v.account_name);
    const opt = (val, l, cur) => '<option value="' + val + '"' + (val === cur ? " selected" : "") + ">" + l + "</option>";
    return '<div class="prt-2col"><div class="field"><label for="' + pre + 'Asset">Currency</label><select class="select" id="' + pre + 'Asset">' +
        opt("USDT", "USDT", v.asset) + opt("BTC", "Bitcoin (BTC)", v.asset) + "</select></div>" +
      '<div class="field"><label for="' + pre + 'Net">Network</label><select class="select" id="' + pre + 'Net">' +
        opt("TRC20", "TRC20 (Tron)", v.network) + opt("ERC20", "ERC20 (Ethereum)", v.network) + opt("BEP20", "BEP20 (BNB Chain)", v.network) + opt("BTC", "Bitcoin", v.network) + "</select></div></div>" +
      fld(pre + "Addr", "Wallet address", "text", "Double-check it — crypto can't be recalled", v.address);
  }
  function readDetails(pre, m) {
    const v = (id) => ($(pre + id) ? $(pre + id).value.trim() : "");
    return m === "MOMO" ? { phone: v("Phone"), name: v("Name") }
      : m === "BANK" ? { bank: v("Bank"), account_number: v("Acct"), account_name: v("AcctName") }
      : { asset: v("Asset"), network: v("Net"), address: v("Addr") };
  }
  const methodChips = (key, m) => '<div class="field"><span class="prt-label">Pay me by</span><div class="chip-list" role="radiogroup" aria-label="Payment method">' +
    METHODS.map(([v, l]) => '<button type="button" class="chip' + (v === m ? " on" : "") + '" role="radio" aria-checked="' + (v === m) + '" data-method="' + v + '" data-for="' + key + '">' + l + "</button>").join("") +
    "</div></div>";

  /* ---------------- Wallet ---------------- */
  const PAY_STATUS = { REQUESTED: ["warn", "Requested"], APPROVED: ["brand", "Approved"], PAID: ["ok", "Paid"], REJECTED: ["bad", "Rejected"] };
  const ENTRY = { OPENING: "Opening balance", SETTLEMENT: "Settlement", PAYOUT_HOLD: "Withdrawal requested", PAYOUT_RELEASE: "Withdrawal returned", CORRECTION: "Correction" };

  async function loadWallet(seq) {
    const r = await get("wallet");
    if (seq !== loadSeq) return;
    if (!r.ok) return failed(r, "Couldn't load your wallet.");
    const d = r.data;
    const w = d.wallet;
    state.walletData = d;
    $("tabBody").innerHTML =
      '<div class="adm-kpis">' +
        kpi("Total commission earned", money(w.totalEarned), "lifetime, before deductions", "in") +
        kpi("Available balance", smoney(w.available), "ready to withdraw", w.available < 0 ? "bad" : "in") +
        kpi("Pending commission", smoney(w.pending), "period still open", tone(w.pending)) +
        kpi("Negative adjustments", smoney(w.negativeAdjustments), "from player wins", w.negativeAdjustments < 0 ? "bad" : "") +
        kpi("Total withdrawn", money(w.withdrawn)) +
        kpi("Pending withdrawals", money(w.pendingWithdrawals), "", w.pendingWithdrawals ? "warn" : "") +
        (w.carriedNegative ? kpi("Carried negative", smoney(w.carriedNegative), "set against your next earnings", "bad") : "") +
        (w.corrections ? kpi("Corrections", smoney(w.corrections), "made by our team", tone(w.corrections)) : "") +
      "</div>" +
      '<p class="hint prt-dimnote">Commission is pending until its period (' + periodWord(w.settlementPeriod) + ") closes, then moves to your available balance. " +
        "Withdrawals: " + money(w.minPayout) + " to " + money(w.maxPayout) + ", one request at a time.</p>" +
      '<h3 class="adm-h" id="payHead">Request withdrawal</h3><div id="payBox">' + payoutForm(d) + "</div>" +

      '<h3 class="adm-h">Withdrawal history</h3>' +
      (d.payouts.length
        ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Date</th><th>Amount</th><th>Method</th><th>Status</th><th>Reference / note</th></tr></thead><tbody>' +
          d.payouts.map((x) => {
            const [cls, txt] = PAY_STATUS[x.status] || ["", x.status];
            return "<tr><td>" + whenTime(x.created_at) + "</td><td>" + money(x.amount) + "</td><td>" + esc(methodName(x.method)) + "</td>" +
              '<td><span class="adm-pill ' + cls + '">' + esc(txt) + "</span></td><td>" + (x.reference ? "<b>" + esc(x.reference) + "</b> " : "") +
              (x.note ? "<small>" + esc(x.note) + "</small>" : "") + (x.reference || x.note ? "" : "—") + "</td></tr>";
          }).join("") + "</tbody></table></div>"
        : '<p class="me-sheet-note">No withdrawals yet.</p>') +

      '<h3 class="adm-h">Wallet history</h3>' +
      (d.entries.length
        ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Note</th></tr></thead><tbody>' +
          d.entries.map((e) => "<tr><td>" + whenTime(e.created_at) + "</td><td>" + esc(ENTRY[e.kind] || e.kind) + "</td><td>" + (e.amount > 0 ? '<span class="prt-pos">+' + money(e.amount) + "</span>" : smoney(e.amount)) +
            "</td><td>" + esc(e.note || "—") + "</td></tr>").join("") + "</tbody></table></div>"
        : '<p class="me-sheet-note">Nothing has reached your wallet yet.</p>') +

      '<h3 class="adm-h">Settlements</h3>' +
      (d.settlements.length
        ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Period</th><th>Commission</th><th>Deductions</th><th>Carried in</th><th>Credited</th><th>Carried out</th></tr></thead><tbody>' +
          d.settlements.map((x) => "<tr><td>" + when(x.period_start) + (x.period === "DAILY" ? "" : " – " + when(new Date(new Date(x.period_end).getTime() - 1))) + " <small>" + esc(periodWord(x.period)) + "</small></td>" +
            "<td>" + money(x.positive) + "</td><td>" + smoney(x.negative) + "</td><td>" + smoney(x.carried_in) + "</td><td><b>" + smoney(x.credited) + "</b></td><td>" + smoney(x.carried_out) + "</td></tr>").join("") +
          "</tbody></table></div>"
        : '<p class="me-sheet-note">No periods have closed yet.</p>');
    wireMethod("pay");
  }

  function payoutForm(d) {
    const w = d.wallet;
    if (PREVIEW) return '<p class="me-sheet-note">Read only — withdrawals are requested by the partner.</p>';
    if (state.readOnly) return '<p class="me-sheet-note">Withdrawals are on hold while your partner account is suspended.</p>';
    if (d.payouts.some((p) => p.status === "REQUESTED" || p.status === "APPROVED")) {
      return '<div class="alert alert-info">Your withdrawal request is with our team. You can ask for another once it\'s been dealt with.</div>';
    }
    const max = Math.floor(Math.min(w.maxPayout, w.available) * 100) / 100;
    if (max < w.minPayout) return '<p class="me-sheet-note">You can request a withdrawal once you have at least ' + money(w.minPayout) + " available.</p>";
    const saved = d.payoutDetails;
    const m = state.payMethod || (saved && saved.method) || "MOMO";
    state.payMethod = m;
    return '<form class="panel prt-payout" id="payForm">' +
      '<div class="field"><label for="pdAmt">Amount (GHS)</label><input id="pdAmt" type="number" inputmode="decimal" step="0.01" min="' + w.minPayout + '" max="' + max + '" value="' + max + '" required>' +
      '<span class="hint">Between ' + money(w.minPayout) + " and " + money(max) + ".</span></div>" +
      methodChips("pay", m) + '<div id="payFields">' + methodFields("pd", m, saved) + "</div>" +
      '<button class="btn btn-primary btn-block" type="submit">Request withdrawal</button></form>';
  }

  /* switching method redraws only that form's fields (the amount stays) */
  function wireMethod(key) {
    const box = $(key === "pay" ? "payFields" : "saveFields");
    if (!box) return;
    const saved = key === "pay" ? state.walletData && state.walletData.payoutDetails : state.settings && state.settings.payoutDetails;
    const m = key === "pay" ? state.payMethod : state.saveMethod;
    box.innerHTML = methodFields(key === "pay" ? "pd" : "sd", m, saved);
    view.querySelectorAll('[data-method][data-for="' + key + '"]').forEach((b) => {
      b.classList.toggle("on", b.dataset.method === m);
      b.setAttribute("aria-checked", String(b.dataset.method === m));
    });
  }

  /* ---------------- Settings ---------------- */
  const row = (k, v) => "<div><dt>" + k + "</dt><dd>" + v + "</dd></div>";
  const STATUS_PILL = { ACTIVE: "ok", SUSPENDED: "warn", PENDING: "warn", REJECTED: "bad", DISABLED: "bad" };

  async function loadSettings(seq) {
    const [set, sum] = await Promise.all([get("settings"), get("summary")]);
    if (seq !== loadSeq) return;
    if (!set.ok) return failed(set, "Couldn't load your settings.");
    const s = set.data;
    const a = s.account;
    state.settings = s;
    state.partner = Object.assign({}, state.partner, s.partner);
    const p = state.partner;
    const sm = sum.ok ? sum.data : null;
    const ro = state.readOnly;
    state.saveMethod = state.saveMethod || (s.payoutDetails && s.payoutDetails.method) || "MOMO";
    $("tabBody").innerHTML =
      '<h3 class="adm-h">Account information</h3><div class="panel"><dl class="prt-dl">' +
        row("Full name", esc(a.full_name || "—")) +
        row("Email", '<span id="emailVal">' + esc(a.email || "—") + "</span>" + (PREVIEW ? "" : ' <button class="btn btn-ghost btn-sm" type="button" data-edit-email>Edit</button>')) +
        row("Phone", esc(a.phone || "—")) +
        row("Partner ID", "<b class='prt-mono'>" + esc(a.partner_id) + "</b>") +
        row("Registered as partner", when(a.registered)) +
        row("Account status", '<span class="adm-pill ' + (STATUS_PILL[a.status] || "") + '">' + esc(a.status) + "</span>") +
        row("Commission percentage", "<b>" + pct(s.rate.pct) + "</b> revenue share · " + pct(s.winDeductionPct) + " win deduction") +
      "</dl>" +
      (PREVIEW ? "" : '<form id="emailForm" class="prt-inline" hidden><div class="field"><label for="emailIn">Email (optional — leave empty to remove)</label>' +
        '<input id="emailIn" type="email" maxlength="120" value="' + esc(a.email || "") + '"></div><button class="btn btn-primary btn-sm" type="submit">Save email</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-edit-email>Cancel</button></form>') +
      scheduled(s.rate) +
      '<p class="hint">Your commission percentage is set by the WIN B casino team and can only be changed by an admin. Settlement: ' + periodWord(s.settlementPeriod) + ".</p></div>" +

      '<h3 class="adm-h">Referral settings</h3><div class="panel prt-linkbox">' +
        '<span class="prt-label">Referral link</span>' + linkRow("lnk", link(), "Your link") +
        '<span class="prt-label">Promo code</span>' +
        (p.promo_code ? linkRow("promo", p.promo_code, "Your promo code") : '<p class="me-sheet-note">No promo code yet.</p>') +
        (p.promo_request ? '<div class="alert alert-info">Requested promo code <b>' + esc(p.promo_request) + "</b> is waiting for the admin's approval.</div>" : "") +
        (ro ? ""
          : s.promoCodesEnabled === false ? '<p class="hint">Promo codes are switched off at the moment.</p>'
          : '<form id="promoForm" class="prt-inline"><div class="field"><label for="promoIn">' + (p.promo_code ? "Change promo code" : "Choose a promo code") + "</label>" +
            '<input id="promoIn" maxlength="16" autocapitalize="characters" placeholder="4–16 letters and numbers"></div>' +
            '<button class="btn btn-primary btn-sm" type="submit">' + (s.promoEditable ? "Save" : "Send request") + "</button></form>" +
            (s.promoEditable ? "" : '<p class="hint">Ask support to change your promo code, or send a request here — the admin approves it.</p>')) +
        '<div class="adm-kpis prt-mini">' +
          kpi("Total referrals", sm ? count(sm.totalReferrals) : "—") + kpi("Link clicks", sm ? count(sm.clicks) : "—") +
        "</div></div>" +

      '<h3 class="adm-h">Payment settings</h3><div class="panel">' +
        (s.payoutDetails ? '<p class="me-sheet-note">Saved: <b>' + esc(methodName(s.payoutDetails.method)) + "</b> · " + esc(detailsText(s.payoutDetails)) + "</p>" : '<p class="me-sheet-note">No payment details saved yet.</p>') +
        (ro ? ""
          : '<form id="saveForm" class="prt-payout">' + methodChips("save", state.saveMethod) + '<div id="saveFields"></div>' +
            '<button class="btn btn-primary btn-block" type="submit">Save payment details</button></form>') +
        '<p class="hint"><a href="#wallet" data-go="wallet">Withdrawal history →</a></p></div>' +

      (PREVIEW ? ""
        : '<h3 class="adm-h">Security</h3><div class="panel">' +
          '<form id="pwForm" class="prt-pw"><h4 class="prt-sub-h">Change password</h4>' +
            '<div class="field"><label for="pwCur">Current password</label><input id="pwCur" type="password" autocomplete="current-password" required></div>' +
            '<div class="field"><label for="pwNew">New password</label><input id="pwNew" type="password" autocomplete="new-password" required></div>' +
            '<div class="field"><label for="pwNew2">Confirm new password</label><input id="pwNew2" type="password" autocomplete="new-password" required></div>' +
            '<button class="btn btn-primary btn-sm" type="submit">Change password</button></form>' +
          '<h4 class="prt-sub-h">Login sessions</h4><div id="sessBox">' + LOADING + "</div>" +
          '<button class="btn btn-danger btn-sm prt-logout" type="button" data-logout>' + U.icon("logout") + "Log out</button></div>");
    wireMethod("save");
    if (!PREVIEW) loadSessions();
  }
  const detailsText = (d) => (d.method === "MOMO" ? [d.phone, d.name] : d.method === "BANK" ? [d.bank, d.account_number, d.account_name] : [d.asset, d.network, d.address]).filter(Boolean).join(" · ");

  async function loadSessions() {
    const r = await acct("/api/me/sessions");
    const box = $("sessBox");
    if (!box) return;
    if (!r.ok) return (box.innerHTML = '<p class="alert alert-err">' + errText(r, "Couldn't load your sessions.") + "</p>");
    const list = r.data.sessions || [];
    box.innerHTML = '<ul class="prt-sessions">' + list.map((x) =>
      "<li><span>" + U.icon(x.current ? "user" : "phone") + "</span><div><b>" + esc(x.device) + "</b>" + (x.current ? ' <span class="adm-pill ok">This device</span>' : "") +
      "<small>Signed in " + when(x.created_at) + " · last active " + ago(x.last_seen_at || x.created_at) + "</small></div>" +
      (x.current ? "" : '<button class="btn btn-ghost btn-sm" type="button" data-revoke="' + esc(x.id) + '">Sign out</button>') + "</li>").join("") + "</ul>" +
      (list.some((x) => !x.current) ? '<button class="btn btn-ghost btn-sm" type="button" data-revoke-all>Sign out all other devices</button>' : "");
  }

  const LOADERS = { dashboard: loadDashboard, referrals: loadReferrals, statistics: loadStatistics, wallet: loadWallet, settings: loadSettings };

  /* ---------------- actions ---------------- */
  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      flash("ok", esc(what) + " copied.");
    } catch (e) {
      flash("info", "Copy this:<br><code class='prt-copytext'>" + esc(text) + "</code>");
    }
  }
  const busy = async (btn, fn) => {
    if (btn) btn.disabled = true;
    try {
      return await fn();
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  view.addEventListener("click", async (e) => {
    const t = e.target;
    const tab = t.closest("[data-tab]");
    if (tab) return show(tab.dataset.tab);
    const go = t.closest("[data-go]");
    if (go) {
      e.preventDefault();
      return show(go.dataset.go).then(() => { if (go.dataset.go === "wallet" && $("payHead")) $("payHead").scrollIntoView({ behavior: "smooth", block: "start" }); });
    }
    const cp = t.closest("[data-copy]");
    if (cp) return copy($(cp.dataset.copy).value, cp.dataset.what);
    const em = t.closest("[data-embed]");
    if (em) return copy(embed(BANNERS[Number(em.dataset.embed)]), "Banner code");
    const cap = t.closest("[data-caption]");
    if (cap) return copy(caption(BANNERS[Number(cap.dataset.caption)]), "Caption");
    if (t.closest("[data-retry]")) return show(state.tab);
    const rf = t.closest("[data-refresh]");
    if (rf) return busy(rf, () => loadDashboard(loadSeq, false));

    const rg = t.closest("[data-range]");
    if (rg) {
      const key = state.tab;
      const r = state.ranges[key];
      if (rg.dataset.range === "custom") {
        r.open = true;
        $("rangeBox").innerHTML = rangeBar(key);
        return $("rgFrom").focus();
      }
      state.ranges[key] = { range: rg.dataset.range, from: r.from, to: r.to };
      return show(key);
    }
    const mt = t.closest("[data-method]");
    if (mt) {
      if (mt.dataset.for === "pay") state.payMethod = mt.dataset.method;
      else state.saveMethod = mt.dataset.method;
      return wireMethod(mt.dataset.for);
    }
    if (t.closest("[data-edit-email]")) {
      const f = $("emailForm");
      f.hidden = !f.hidden;
      if (!f.hidden) $("emailIn").focus();
      return;
    }
    const rv = t.closest("[data-revoke]");
    if (rv) {
      const r = await busy(rv, () => acct("/api/me/sessions/revoke", { id: rv.dataset.revoke }));
      if (!r.ok) return flash("error", errText(r, "Couldn't sign that device out."));
      flash("ok", "That device was signed out.");
      return loadSessions();
    }
    const ra = t.closest("[data-revoke-all]");
    if (ra) {
      const r = await busy(ra, () => acct("/api/me/sessions/revoke", { all: true }));
      if (!r.ok) return flash("error", errText(r, "Couldn't sign the other devices out."));
      flash("ok", "Every other device was signed out.");
      return loadSessions();
    }
    if (t.closest("[data-logout]")) {
      U.session.logout();
      location.replace("register.html#login");
    }
  });

  view.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector("button[type=submit]");
    if (f.id === "applyForm") {
      const channel = $("apChannel").value.trim();
      if (channel.length < 10) return flash("error", "Tell us where you'll promote WIN B casino (at least 10 characters).");
      if (!$("apAgree").checked) return flash("error", "Please agree to the marketing rules.");
      const r = await busy(btn, () => post("/apply", { channel }));
      if (!r.ok) return flash("error", errText(r, "Couldn't send your application."));
      state.partner = r.data.partner;
      drawWaiting();
      return flash("ok", "Application sent — we'll review it soon.");
    }
    if (f.id === "customForm") {
      const from = $("rgFrom").value;
      const to = $("rgTo").value;
      if (!from || !to) return flash("error", "Choose a start and an end date.");
      if (to < from) return flash("error", "The end date can't be before the start date.");
      state.ranges[state.tab] = { range: "custom", from, to, open: true };
      return show(state.tab);
    }
    if (f.id === "payForm") {
      const m = state.payMethod;
      const r = await busy(btn, () => post("/payouts", { amount: Number($("pdAmt").value), method: m, details: readDetails("pd", m) }));
      if (!r.ok) return flash("error", errText(r, "Couldn't request the withdrawal."));
      flash("ok", "Withdrawal of " + money(r.data.amount) + " requested. We'll send it and record the reference here.");
      return show("wallet");
    }
    if (f.id === "saveForm") {
      const m = state.saveMethod;
      const r = await busy(btn, () => post("/settings/payout-details", { method: m, details: readDetails("sd", m) }));
      if (!r.ok) return flash("error", errText(r, "Couldn't save your payment details."));
      flash("ok", "Payment details saved. They'll be filled in when you request a withdrawal.");
      state.payMethod = "";
      return show("settings");
    }
    if (f.id === "promoForm") {
      const code = $("promoIn").value.trim();
      if (!code) return flash("error", "Enter a promo code.");
      const r = await busy(btn, () => post("/settings/promo", { promo_code: code }));
      if (!r.ok) return flash("error", errText(r, "Couldn't save the promo code."));
      flash("ok", r.data.requested ? "Sent to the admin for approval." : "Promo code saved: <b>" + esc(r.data.promo_code) + "</b>");
      return show("settings");
    }
    if (f.id === "emailForm") {
      const email = $("emailIn").value.trim();
      const r = await busy(btn, () => acct("/api/me/email", { email }));
      if (!r.ok) return flash("error", errText(r, "Couldn't save your email."));
      $("emailVal").textContent = (r.data.user && r.data.user.email) || "—";
      f.hidden = true;
      return flash("ok", email ? "Email saved." : "Email removed.");
    }
    if (f.id === "pwForm") {
      if ($("pwNew").value !== $("pwNew2").value) return flash("error", "The new passwords don't match.");
      const r = await busy(btn, () => acct("/api/me/password", { current: $("pwCur").value, password: $("pwNew").value }));
      if (!r.ok) return flash("error", errText(r, "Couldn't change your password."));
      f.reset();
      flash("ok", "Password changed. Every other device was signed out.");
      return loadSessions();
    }
  });

  window.addEventListener("hashchange", () => {
    const h = location.hash.slice(1);
    if ($("prtTab") && h !== state.tab && LOADERS[h]) show(h);
  });

  /* ---------------- start ---------------- */
  async function start() {
    if (PREVIEW) {
      const back = document.querySelector(".pt-back");
      if (back) {
        back.href = "admin.html";
        if (back.lastChild && back.lastChild.nodeType === 3) back.lastChild.textContent = "Admin";
      }
      if (!U.session.get()) return (view.innerHTML = hero("Admins only", "Please <a href='register.html#login'>log in</a> with an admin account."));
    } else if (!U.session.get()) return drawSignedOut();
    const me = await get("me");
    if (!me.ok) {
      view.innerHTML = "";
      return flash("error", errText(me, "Couldn't reach the server. Try again in a moment."));
    }
    state.partner = me.data.partner;
    if (PREVIEW) return drawPortal();
    if (!state.partner) return drawApply();
    state.readOnly = state.partner.status !== "ACTIVE";
    if (state.partner.status !== "ACTIVE" && state.partner.status !== "SUSPENDED") return drawWaiting();
    drawPortal();
  }

  /* the dashboard keeps itself current: every minute, and on coming back to the browser tab */
  let refreshing = false;
  async function refresh() {
    if (refreshing || document.hidden || state.tab !== "dashboard" || !$("prtTab") || Date.now() - lastLoad < REFRESH_MS / 3) return;
    refreshing = true;
    lastLoad = Date.now();
    try {
      await loadDashboard(loadSeq, true);
    } finally {
      refreshing = false;
    }
  }
  start();
  setInterval(refresh, REFRESH_MS);
  document.addEventListener("visibilitychange", refresh);
})();
