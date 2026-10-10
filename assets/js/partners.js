/* RendoWin Partners: apply, then (once an admin approves you) your link, banners, players, commission and payouts.
   Access is enforced by the balance service: partner data only comes back for an approved partner's own account. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);
  const esc = U.esc;
  const money = (n) => U.money(n);
  const count = (n) => Number(n || 0).toLocaleString("en-GH");
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
  const ago = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    return s < 60 ? "just now" : s < 3600 ? Math.floor(s / 60) + " min ago" : s < 86400 ? Math.floor(s / 3600) + " h ago" : when(iso);
  };
  const api = (path, body) => U.paymentApi("/api/partners" + path, body ? { body } : {});
  const errText = (r, fallback) => esc((r.data && (r.data.message || r.data.error)) || fallback);
  const view = $("prtView");
  /* links point at the live site; the banner images are hosted there too */
  const SITE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? location.origin : "https://asakaa-casino.onrender.com";
  /* draft: what's been typed into the payout form, so a refresh or a change of method doesn't wipe it */
  const state = { partner: null, stats: null, referrals: [], activity: [], payouts: [], sub: "", method: "MOMO", draft: {} };
  const REFRESH_MS = 60000;

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
    "<li>No spam, and no bidding on the RendoWin name in search ads.</li>" +
    "<li>Always show <b>18+ · Play responsibly</b> with your link (our banners already do).</li>" +
    "<li>Your own accounts, fake accounts and accounts shared between people don't count, and commission from them is withheld.</li></ul>";

  /* ---------------- not signed in / not a partner yet ---------------- */
  const hero = (title, text) => '<section class="prt-hero"><span class="prt-hero-ico">' + U.icon("star") + "</span><h1>" + title + "</h1><p>" + text + "</p></section>";

  function drawSignedOut() {
    view.innerHTML = hero("RendoWin Partners", "Share your link with your audience. When the players you bring sign up and deposit, you earn a percentage of every deposit they make.") +
      '<div class="prt-steps">' +
        step(1, "Apply", "Tell us where you'll promote RendoWin — your page, channel, group or website.") +
        step(2, "Get approved", "We review every partner and set your commission rate.") +
        step(3, "Share and earn", "Use your link and our banners; follow your players' deposits and your commission here.") +
      "</div>" +
      '<a class="btn btn-primary btn-block btn-lg" href="register.html#login">Log in or register to apply</a>';
  }
  const step = (n, title, text) => '<div class="prt-step"><b>' + n + "</b><div><strong>" + title + "</strong><p>" + text + "</p></div></div>";

  function drawApply() {
    view.innerHTML = hero("Become a RendoWin partner", "Share your link with your audience. When the players you bring sign up and deposit, you earn a percentage of every deposit they make. Your rate is set when we approve you.") +
      '<form class="panel prt-apply" id="applyForm">' +
        '<div class="field"><label for="apChannel">Where will you promote RendoWin?</label>' +
        '<textarea id="apChannel" class="me-textarea" rows="3" maxlength="300" required placeholder="e.g. My football page on Facebook (12k followers) and a WhatsApp sports group"></textarea>' +
        '<span class="hint">Links help us review faster.</span></div>' +
        '<h3 class="me-sheet-sub">Marketing rules</h3>' + RULES +
        '<label class="checkbox"><input type="checkbox" id="apAgree" required> I agree to promote RendoWin by these rules.</label>' +
        '<button class="btn btn-primary btn-block" type="submit">Send application</button></form>';
    $("applyForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const channel = $("apChannel").value.trim();
      if (channel.length < 10) return flash("error", "Tell us where you'll promote RendoWin (at least 10 characters).");
      if (!$("apAgree").checked) return flash("error", "Please agree to the marketing rules.");
      const btn = e.target.querySelector("button");
      btn.disabled = true;
      const r = await api("/apply", { channel });
      btn.disabled = false;
      if (!r.ok) return flash("error", errText(r, "Couldn't send your application."));
      state.partner = r.data.partner;
      drawWaiting();
      flash("ok", "Application sent — we'll review it soon.");
    });
  }

  function drawWaiting() {
    const p = state.partner;
    const msgs = {
      PENDING: ["Application received", "We're reviewing your application. You'll see your link and banners here once you're approved."],
      REJECTED: ["Not approved this time", "We couldn't approve this application. If something has changed, contact support through the chat."],
      SUSPENDED: ["Partner account paused", "Your link isn't counting right now and payouts are on hold. Contact support through the chat to find out more."],
    };
    const [title, text] = msgs[p.status] || msgs.PENDING;
    view.innerHTML = hero(title, text) +
      '<div class="panel prt-code"><span>Your partner code</span><b>' + esc(p.code) + "</b>" + '<small>Applied ' + when(p.created_at) + "</small></div>";
  }

  /* ---------------- an approved partner's dashboard ---------------- */
  const link = () => SITE + "/?ref=" + encodeURIComponent(state.partner.code) + (state.sub ? "&sub=" + encodeURIComponent(state.sub) : "");
  const kpi = (label, value, sub, tone) =>
    '<div class="adm-kpi' + (tone ? " " + tone : "") + '"><span>' + label + "</span><strong>" + value + "</strong>" + (sub ? "<small>" + sub + "</small>" : "") + "</div>";
  const BANNERS = [
    { file: "rendowin-728x90.png", w: 728, h: 90, label: "Leaderboard · 728 × 90", web: true },
    { file: "rendowin-300x250.png", w: 300, h: 250, label: "Rectangle · 300 × 250", web: true },
    { file: "rendowin-320x100.png", w: 320, h: 100, label: "Mobile · 320 × 100", web: true },
    { file: "rendowin-1080x1080.jpg", w: 1080, h: 1080, label: "Social post · 1080 × 1080" },
    { file: "rendowin-1080x1920.jpg", w: 1080, h: 1920, label: "Story / Status · 1080 × 1920" },
  ];
  const bannerSub = (b) => (state.sub ? state.sub : "banner_" + b.w + "x" + b.h);
  const bannerLink = (b) => SITE + "/?ref=" + encodeURIComponent(state.partner.code) + "&sub=" + encodeURIComponent(bannerSub(b));
  const embed = (b) => '<a href="' + bannerLink(b) + '" target="_blank" rel="sponsored noopener"><img src="' + SITE + "/assets/img/partners/" + b.file +
    '" width="' + b.w + '" height="' + b.h + '" alt="RendoWin — Olympus, Mines and more. 18+ Play responsibly."></a>';
  const caption = (b) => "Play Olympus, Mines, Roulette & more on RendoWin — deposit and withdraw with mobile money. 18+ · Play responsibly. " + bannerLink(b);

  /* the page is drawn once; the numbers, activity and players are repainted on each refresh, while the link
     builder (campaign tag) and the payout form being filled in are left alone */
  function drawDashboard() {
    view.innerHTML =
      '<section class="prt-top" id="prtTop"></section><div id="prtNums"></div><div id="prtAct"></div>' +
      '<h3 class="adm-h" id="prtLink">Your link</h3><div class="panel prt-linkbox">' +
        '<div class="prt-linkrow"><input id="lnk" readonly value="' + esc(link()) + '" aria-label="Your referral link">' +
        '<button class="btn btn-primary btn-sm" type="button" data-copy="lnk">Copy</button>' +
        (navigator.share ? '<button class="btn btn-ghost btn-sm" type="button" data-share>Share</button>' : "") + "</div>" +
        '<div class="field prt-sub"><label for="subIn">Campaign tag (optional)</label>' +
        '<input id="subIn" maxlength="40" placeholder="e.g. whatsapp_march or fb_page" value="' + esc(state.sub) + '">' +
        '<span class="hint">Use a different tag for each place you post, to see which brings players. Letters, numbers, - and _ only.</span></div>' +
        '<p class="hint">Anyone who opens your link and opens a new RendoWin account within 30 days becomes your player. Existing players can\'t be claimed.</p></div>' +

      '<h3 class="adm-h">Banners</h3><div class="prt-banners">' +
        BANNERS.map((b, i) => '<figure class="prt-banner"><div class="prt-banner-img"><img src="assets/img/partners/' + b.file + '" alt="' + esc(b.label) + ' banner" loading="lazy"></div>' +
          "<figcaption><strong>" + b.label + "</strong><span>" +
          '<a class="btn btn-ghost btn-sm" href="assets/img/partners/' + b.file + '" download="' + b.file + '">Download</a>' +
          (b.web ? '<button class="btn btn-ghost btn-sm" type="button" data-embed="' + i + '">Copy HTML</button>'
                 : '<button class="btn btn-ghost btn-sm" type="button" data-caption="' + i + '">Copy caption</button>') +
          "</span></figcaption></figure>").join("") +
      "</div>" +
      '<p class="hint">The HTML code links each banner to your account (tagged with its size, or your campaign tag). For posts and statuses, download the picture and use “Copy caption” for the text with your link.</p>' +
      '<div id="prtPlayers"></div>' +
      '<h3 class="adm-h" id="prtPayouts">Payouts</h3><div id="prtPay"></div>' +
      '<div id="prtHow"></div>';
    paintData();
    paintPayouts();
  }

  /* activity newer than this is highlighted when it arrives */
  let seenUpTo = 0;
  function paintData() {
    const p = state.partner;
    const s = state.stats;
    const c = s.commission;
    const t = s.terms;
    const max = Math.max(1, ...s.series.map((d) => Math.max(d.clicks, d.signups)));
    $("prtTop").innerHTML =
      '<div><span class="prt-label">Your partner code</span><b class="prt-codeval">' + esc(p.code) + "</b>" +
      '<p class="prt-terms">You earn <b>' + t.deposit_pct + "%</b> of every deposit your players make</p></div>" +
      '<div class="prt-avail"><span class="prt-label">Available</span><b>' + money(c.available) + "</b>" +
      '<button class="btn btn-primary btn-sm" type="button" data-go="payouts"' + (c.available < t.min_payout ? " disabled" : "") + ">Request payout</button>" +
      (c.available < t.min_payout ? "<small>Payouts from " + money(t.min_payout) + "</small>" : "") + "</div>";

    const m = s.money;
    $("prtNums").innerHTML =
      '<h3 class="adm-h">Commission</h3><div class="adm-kpis">' +
        kpi("Earned", money(c.earned), c.pct + "% of " + money(m.deposits) + " deposits", "in") +
        kpi("Paid to you", money(c.paid)) +
        kpi("Waiting", money(c.pending), c.pending ? "payout requested" : "", c.pending ? "warn" : "") +
        kpi("Available", money(c.available), "ready to request") +
      "</div>" +
      '<h3 class="adm-h">Your players\' money</h3><div class="adm-kpis">' +
        kpi("Deposits", money(m.deposits), money(m.deposits30) + " in the last 30 days", m.deposits ? "in" : "") +
        kpi("Withdrawals", money(m.withdrawals), "paid out to them") +
        kpi("Bets", money(m.stakes), "staked in games") +
        kpi("Wins", money(m.wins), "paid to them in games") +
      "</div>" +
      '<h3 class="adm-h">Traffic and players</h3><div class="adm-kpis">' +
        kpi("Clicks", count(s.clicks.last30), count(s.clicks.total) + " in total · last 30 days") +
        kpi("Sign-ups", count(s.signups.last30), count(s.signups.total) + " in total · last 30 days") +
        kpi("Active players", count(s.activePlayers), "played in the last 30 days") +
        kpi("Depositors", count(s.depositors), "players who have deposited") +
      "</div>" +
      '<div class="adm-chart prt-chart" role="img" aria-label="Clicks and sign-ups, last 30 days">' +
        s.series.map((d) => '<div class="adm-bar-day" title="' + esc(d.day) + ": " + d.clicks + " clicks, " + d.signups + ' sign-ups"><div class="adm-bars">' +
          '<i class="dep" style="height:' + (d.clicks / max) * 100 + '%"></i><i class="ggr" style="height:' + (d.signups / max) * 100 + '%"></i></div><span></span></div>').join("") +
      '</div><p class="adm-legend"><i class="dep"></i>Clicks <i class="ggr"></i>Sign-ups · last 30 days</p>';

    const act = state.activity;
    $("prtAct").innerHTML =
      '<div class="adm-feed-head"><h3 class="adm-h">Latest activity</h3>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-refresh>' + U.icon("refresh") + "Refresh</button></div>" +
      (act.length
        ? '<ul class="prt-feed">' + act.map((a) => {
            const dep = a.kind === "deposit";
            return '<li class="' + (seenUpTo && new Date(a.at).getTime() > seenUpTo ? "fresh" : "") + '">' +
              '<span class="prt-feed-ico' + (dep ? " dep" : "") + '">' + U.icon(dep ? "wallet" : "user") + "</span>" +
              '<span class="prt-feed-txt"><b>' + esc(a.player) + "</b> " + (dep ? 'deposited <b class="in">' + money(a.amount) + "</b> · you earn " + money(a.commission) : "signed up through your link") +
              "<small>" + ago(a.at) + (a.sub_id ? " · " + esc(a.sub_id) : "") + "</small></span></li>";
          }).join("") + "</ul>"
        : '<p class="me-sheet-note">Nothing yet. Sign-ups and deposits by your players will show here.</p>') +
      '<p class="hint">A deposit shows as soon as the player\'s mobile money payment is confirmed. This page updates itself every minute.</p>';
    if (act.length) seenUpTo = Math.max(seenUpTo, new Date(act[0].at).getTime());

    $("prtPlayers").innerHTML =
      '<h3 class="adm-h">Your players (' + count(state.referrals.length) + ")</h3>" +
      (state.referrals.length
        ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Player</th><th>Joined</th><th>Campaign</th><th>Deposits</th><th>You earned</th><th>Active</th></tr></thead><tbody>' +
          state.referrals.map((x) => "<tr><td>" + esc(x.player) + "</td><td>" + when(x.joined) + "</td><td>" + esc(x.sub_id || "—") + "</td><td>" +
            (x.deposits ? money(x.deposits) : "—") + "</td><td>" + (x.commission ? money(x.commission) : "—") +
            "</td><td>" + (x.active ? "✓" : "—") + "</td></tr>").join("") +
          "</tbody></table></div>"
        : '<p class="me-sheet-note">No sign-ups yet. Share your link to get started.</p>');

    $("prtHow").innerHTML =
      '<h3 class="adm-h">How commission works</h3><div class="panel prt-how">' +
        "<p><b>Commission:</b> " + t.deposit_pct + "% of every deposit your players make, counted as soon as their mobile money payment is confirmed. Their withdrawals, bets and wins don't change it.</p>" +
        "<p><b>Payouts:</b> from " + money(t.min_payout) + ", one request at a time. Our team sends the money by your chosen method and records the payment reference here.</p>" +
        '<h3 class="me-sheet-sub">Marketing rules</h3>' + RULES + "</div>";
  }

  /* the payout form (or where a request stands) and past payouts; anything typed into the form is put back */
  function paintPayouts() {
    const c = state.stats.commission;
    $("prtPay").innerHTML = payoutForm(c.available, state.stats.terms.min_payout) +
      (state.payouts.length
        ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Amount</th><th>Method</th><th>Status</th><th>Requested</th></tr></thead><tbody>' +
          state.payouts.map((x) => "<tr><td>" + money(x.amount) + "</td><td>" + ({ MOMO: "Mobile Money", BANK: "Bank transfer", CRYPTO: "Crypto" })[x.method] + "</td><td>" +
            '<span class="adm-pill ' + ({ PAID: "ok", REQUESTED: "warn", REJECTED: "bad" })[x.status] + '">' + ({ PAID: "Paid", REQUESTED: "Requested", REJECTED: "Rejected" })[x.status] + "</span>" +
            (x.note ? "<small> " + esc(x.note) + "</small>" : "") + "</td><td>" + when(x.created_at) + "</td></tr>").join("") +
          "</tbody></table></div>"
        : "");
    Object.keys(state.draft).forEach((id) => { if ($(id)) $(id).value = state.draft[id]; });
    wirePayoutForm();
  }
  /* someone filling in the payout form: a background refresh doesn't redraw it under their fingers */
  const typingPayout = () => {
    const a = document.activeElement;
    return !!a && $("prtPay").contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
  };

  /* the payout request form, with the details each method needs */
  function payoutForm(available, min) {
    if (state.payouts.some((p) => p.status === "REQUESTED")) {
      return '<div class="alert alert-info">Your payout request is with our team. You can ask for another once it\'s been dealt with.</div>';
    }
    if (available < min) return '<p class="me-sheet-note">You can request a payout once you have at least ' + money(min) + " available.</p>";
    const m = state.method;
    const fields = m === "MOMO"
      ? fld("pdPhone", "Mobile money number", "tel", "e.g. 024 123 4567") + fld("pdName", "Name on the account", "text", "")
      : m === "BANK"
        ? fld("pdBank", "Bank", "text", "e.g. GCB Bank") + fld("pdAcct", "Account number", "text", "") + fld("pdAcctName", "Account name", "text", "")
        : '<div class="field"><label for="pdAsset">Currency and network</label><select class="select" id="pdAsset">' +
            '<option value="USDT|TRC20">USDT · TRC20 (Tron)</option><option value="USDT|BEP20">USDT · BEP20 (BNB Chain)</option>' +
            '<option value="USDT|ERC20">USDT · ERC20 (Ethereum)</option><option value="BTC|BTC">Bitcoin</option></select></div>' +
          fld("pdAddr", "Wallet address", "text", "Double-check it — crypto can't be recalled");
    return '<form class="panel prt-payout" id="payForm">' +
      '<div class="field"><label for="pdAmt">Amount (GHS)</label><input id="pdAmt" type="number" inputmode="decimal" step="0.01" min="' + min + '" max="' + available + '" value="' + Math.floor(available * 100) / 100 + '"></div>' +
      '<div class="field"><span class="prt-label">Pay me by</span><div class="chip-list" role="radiogroup" aria-label="Payout method">' +
        [["MOMO", "Mobile Money"], ["BANK", "Bank transfer"], ["CRYPTO", "Crypto"]].map(([v, l]) =>
          '<button type="button" class="chip' + (v === m ? " on" : "") + '" role="radio" aria-checked="' + (v === m) + '" data-method="' + v + '">' + l + "</button>").join("") +
      "</div></div>" + fields +
      '<button class="btn btn-primary btn-block" type="submit">Request payout</button></form>';
  }
  const fld = (id, label, type, ph) => '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + type + '" placeholder="' + esc(ph) + '" required></div>';

  function wirePayoutForm() {
    const form = $("payForm");
    if (!form) return;
    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-method]");
      if (!b) return;
      state.method = b.dataset.method;
      paintPayouts();
      const chosen = $("prtPay").querySelector('[data-method="' + state.method + '"]');
      if (chosen) chosen.focus();
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = (id) => ($(id) ? $(id).value.trim() : "");
      const m = state.method;
      const details = m === "MOMO" ? { phone: v("pdPhone"), name: v("pdName") }
        : m === "BANK" ? { bank: v("pdBank"), account_number: v("pdAcct"), account_name: v("pdAcctName") }
        : { asset: v("pdAsset").split("|")[0], network: v("pdAsset").split("|")[1], address: v("pdAddr") };
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      const r = await api("/payouts", { amount: Number(v("pdAmt")), method: m, details });
      btn.disabled = false;
      if (!r.ok) return flash("error", errText(r, "Couldn't request the payout."));
      state.draft = {};
      flash("ok", "Payout of " + money(r.data.amount) + " requested. We'll send it and record the reference here.");
      load();
    });
  }

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      flash("ok", what + " copied.");
    } catch (e) {
      flash("info", "Copy this:<br><code class='prt-copytext'>" + esc(text) + "</code>");
    }
  }

  view.addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) return $("prtPayouts").scrollIntoView({ behavior: "smooth", block: "start" });
    if (e.target.closest("[data-copy]")) return copy(link(), "Your link");
    if (e.target.closest("[data-share]")) {
      return navigator.share({ title: "RendoWin", text: "Play Olympus, Mines & more on RendoWin. 18+ · Play responsibly.", url: link() }).catch(() => {});
    }
    const em = e.target.closest("[data-embed]");
    if (em) return copy(embed(BANNERS[Number(em.dataset.embed)]), "Banner code");
    const cap = e.target.closest("[data-caption]");
    if (cap) return copy(caption(BANNERS[Number(cap.dataset.caption)]), "Caption");
    const rf = e.target.closest("[data-refresh]");
    if (rf) {
      rf.disabled = true;
      load().finally(() => (rf.disabled = false));
    }
  });
  view.addEventListener("input", (e) => {
    if (e.target.closest("#payForm")) {
      state.draft[e.target.id] = e.target.value;
      return;
    }
    if (e.target.id !== "subIn") return;
    state.sub = e.target.value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (e.target.value !== state.sub) e.target.value = state.sub;
    $("lnk").value = link();
  });

  /* ---------------- start ---------------- */
  /* quiet: a background refresh — a failure keeps what's on screen, and the payout form isn't redrawn while
     someone is typing in it */
  let lastLoad = 0;
  async function load(quiet) {
    lastLoad = Date.now();
    const [stats, refs, act, pays] = await Promise.all([api("/stats"), api("/referrals"), api("/activity"), api("/payouts")]);
    if (!stats.ok) {
      if (stats.status === 403) return start(); // no longer an approved partner: show where the account stands
      if (quiet) return;
      return flash("error", errText(stats, "Couldn't load your partner dashboard."));
    }
    const payBefore = JSON.stringify([state.payouts, state.stats && state.stats.commission.available]);
    state.stats = stats.data;
    if (refs.ok) state.referrals = refs.data.referrals;
    if (act.ok) state.activity = act.data.activity;
    if (pays.ok) state.payouts = pays.data.payouts;
    if (!$("prtTop")) return drawDashboard();
    paintData();
    const payChanged = JSON.stringify([state.payouts, state.stats.commission.available]) !== payBefore;
    if (!quiet || (payChanged && !typingPayout())) paintPayouts();
  }

  let refreshing = false;
  async function refresh() {
    if (refreshing || document.hidden || !$("prtTop") || Date.now() - lastLoad < REFRESH_MS / 3) return;
    refreshing = true;
    try {
      await load(true);
    } finally {
      refreshing = false;
    }
  }

  async function start() {
    if (!U.session.get()) return drawSignedOut();
    const me = await api("/me");
    if (!me.ok) {
      view.innerHTML = "";
      return flash("error", errText(me, "Couldn't reach the server. Try again in a moment."));
    }
    state.partner = me.data.partner;
    if (!state.partner) return drawApply();
    if (state.partner.status !== "ACTIVE") return drawWaiting();
    load();
  }
  start();
  /* new sign-ups and deposits appear without reloading: every minute, and on coming back to the tab */
  setInterval(refresh, REFRESH_MS);
  document.addEventListener("visibilitychange", refresh);
})();
