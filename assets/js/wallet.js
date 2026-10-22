/* Deposit (wallet.html) and Withdraw (withdraw.html) — app-style mobile money flow.
   One file serves both; each section wires up only when its elements are present. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const payments = (window.VB && window.VB.payments) || [];
  const MOMO = payments.filter((m) => m.type === "momo");

  /* the live minimum (Admin -> Betting & withdrawal settings) replaces this as soon as the rules arrive */
  let DEPOSIT_MIN = (U.minDeposit && U.minDeposit()) || 135;
  let DEPOSIT_MAX = 50000;
  const WITHDRAW_MIN = 20;

  const $ = (id) => document.getElementById(id);
  const msg = $("msg");

  U.refreshBalance();

  function maskPhone(phone) {
    const p = U.normalizePhone(phone || "");
    if (!/^0\d{9}$/.test(p)) return phone || "—";
    const sub = p.slice(1); // 9 digits after the leading 0
    return "+233 " + sub.slice(0, 2) + "****" + sub.slice(6);
  }

  const session = U.session.get();
  const regPhone = session && session.phone ? session.phone : "";

  function requireSignIn(submit) {
    if (session) return true;
    if (msg) {
      msg.innerHTML = "<div class='alert alert-error'>Please <a href='register.html#login'>sign in</a> to use your wallet.</div>";
    }
    if (submit) submit.disabled = true;
    return false;
  }

  /* ---------------- provider switch (shared) ---------------- */
  /* TheTeller's r-switch codes for each network */
  const NETWORK_CODE = { mtn: "MTN", telecel: "VDF", airteltigo: "ATL" };

  /* returns a getter for the chosen network; starts on the one that matches the registered number */
  function initProvider() {
    const btn = $("provBtn");
    const menu = $("provMenu");
    if (!btn || !menu || !MOMO.length) return () => null;

    const local = U.normalizePhone(regPhone);
    let current = MOMO.find((m) => m.prefixes.includes(local.slice(0, 3))) || MOMO[0];

    function paint() {
      $("provLogo").textContent = current.initials;
      $("provLogo").style.background = current.color;
      if (current.ink) $("provLogo").style.color = current.ink;
      $("provName").textContent = current.name;
    }
    menu.innerHTML = MOMO.map((m) =>
      '<button type="button" data-prov="' + m.id + '">' +
      '<span class="prov-logo" style="background:' + m.color + (m.ink ? ";color:" + m.ink : "") + '">' + m.initials + "</span>" +
      '<span class="prov-name">' + m.name + "</span></button>"
    ).join("");

    btn.addEventListener("click", () => {
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    });
    menu.addEventListener("click", (e) => {
      const b = e.target.closest("[data-prov]");
      if (!b) return;
      current = MOMO.find((m) => m.id === b.dataset.prov) || current;
      paint();
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    });
    paint();
    const get = () => current;
    /* switches to the network a number usually belongs to (numbers can be ported, so the player can still switch) */
    get.match = (phone) => {
      const local = U.normalizePhone(phone || "");
      const m = MOMO.find((x) => x.prefixes.includes(local.slice(0, 3)));
      if (m && m !== current) {
        current = m;
        paint();
      }
    };
    return get;
  }

  /* increment chips add to the amount; "max" fills the balance */
  function wireIncrements(hostId, input, onChange) {
    const host = $(hostId);
    if (!host) return;
    host.addEventListener("click", (e) => {
      const b = e.target.closest("[data-add]");
      if (!b) return;
      if (b.dataset.add === "max") {
        const bal = U.wallet.balance();
        input.value = bal > 0 ? bal.toFixed(2) : "";
      } else {
        const cur = Number(input.value) || 0;
        input.value = String(Math.round((cur + Number(b.dataset.add)) * 100) / 100);
      }
      onChange();
    });
  }

  function showError(errId, message) {
    const el = $(errId);
    if (el) el.textContent = message || "";
    return !message;
  }

  /* =====================================================================
     DEPOSIT
     ===================================================================== */
  function initDeposit() {
    const submit = $("depSubmit");
    if (!submit) return; // not the deposit page

    /* The server checks the registered number before checkout; remind players to use that number on Payteller. */
    const regLocal = U.normalizePhone(regPhone);
    const phoneIn = $("depPhone");
    const pretty = (p) => (/^0\d{9}$/.test(p) ? p.slice(0, 3) + " " + p.slice(3, 6) + " " + p.slice(6) : p);
    const payPhone = () => regLocal;
    phoneIn.value = pretty(regLocal);

    const provider = initProvider();
    provider.match(payPhone());
    function phoneHint() {
      const p = payPhone();
      const net = provider();
      const usual = MOMO.find((m) => m.prefixes.includes(p.slice(0, 3)));
      $("depPhoneHint").textContent = !U.isGhanaMobile(p) ? "Your registered number isn't a Ghanaian mobile money number, so mobile money deposits aren't available. Contact support."
        : usual && net && usual !== net ? "Numbers starting " + p.slice(0, 3) + " are usually " + usual.name + ". Keep " + net.name + " only if your number moved there."
        : "Use your registered number on Payteller checkout. It is not prefilled, so check it before paying.";
    }
    $("provMenu").addEventListener("click", () => setTimeout(phoneHint, 0));
    phoneHint();

    /* the live minimum deposit on every payment method: the amount fields, the "min." labels and the notes */
    const fixed = (n) => Number(n).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    function applyMinimum(rules) {
      if (!rules) return;
      DEPOSIT_MIN = Number(rules.min_deposit) || DEPOSIT_MIN;
      DEPOSIT_MAX = Number(rules.max_deposit) || DEPOSIT_MAX;
      document.querySelectorAll("[data-dep-min]").forEach((el) => (el.textContent = fixed(DEPOSIT_MIN)));
      ["depAmount", "pbAmount", "cdAmount"].forEach((id) => { if ($(id)) $(id).min = String(DEPOSIT_MIN); });
      showMinUsd();
      if (resync) resync();
    }
    let resync = null; /* the Top Up button's state, once the signed-in form is wired */
    if (U.moneyRules) U.moneyRules().then(applyMinimum);
    if (!requireSignIn(submit)) return;

    const showMsg = (kind, text) => { msg.innerHTML = "<div class='alert alert-" + kind + "'>" + text + "</div>"; };
    const amountError = (amt) =>
      !amt ? "Enter an amount." :
      amt < DEPOSIT_MIN ? "Minimum deposit is GHS " + DEPOSIT_MIN.toFixed(2) + "." :
      amt > DEPOSIT_MAX ? "Maximum deposit is GHS " + DEPOSIT_MAX.toLocaleString() + "." : "";
    const newKey = () => "deposit:" + crypto.randomUUID() + ":" + Date.now();

    /* ---------------- registered number lock ---------------- */
    const guard = { confirmed: null, phone: regLocal };
    let closeDialog = null;

    function openDialog(title, html, buttons, onClose) {
      if (closeDialog) closeDialog();
      const wrap = document.createElement("div");
      wrap.className = "dep-modal";
      wrap.innerHTML = '<div class="dep-modal-box" role="dialog" aria-modal="true" aria-labelledby="depModalTitle" tabindex="-1">' +
        '<h2 id="depModalTitle"></h2><div class="dep-modal-body"></div><p class="dep-modal-err" role="alert" hidden></p><div class="dep-modal-actions"></div></div>';
      wrap.querySelector("h2").textContent = title;
      wrap.querySelector(".dep-modal-body").innerHTML = html;
      const actions = wrap.querySelector(".dep-modal-actions");
      const els = buttons.map((b) => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "btn btn-lg btn-block " + (b.primary ? "btn-primary" : "btn-ghost");
        el.textContent = b.label;
        el.addEventListener("click", () => b.onClick(el, wrap));
        actions.appendChild(el);
        return el;
      });
      const previous = document.activeElement;
      const close = () => {
        wrap.remove();
        document.removeEventListener("keydown", onKey);
        if (closeDialog === close) closeDialog = null;
        if (onClose) onClose();
        if (previous && previous.focus) previous.focus();
      };
      const onKey = (e) => { if (e.key === "Escape") close(); };
      document.addEventListener("keydown", onKey);
      closeDialog = close;
      document.body.appendChild(wrap);
      (els[0] || wrap.firstChild).focus();
      return close;
    }

    function showConfirm() {
      const shown = guard.phone || regLocal;
      openDialog("CONFIRM YOUR REGISTERED PHONE NUMBER",
        "<p><b>Is this your correct phone number?</b></p><div class='dep-phone-show'>" + U.esc(pretty(shown)) + "</div>" +
        "<p>This phone number will be used exclusively for all future deposits. Once confirmed, it will be permanently linked to your account and cannot be changed.</p>" +
        "<p>Please verify your number carefully before proceeding.</p>",
        [{
          label: "CONFIRM & LOCK NUMBER", primary: true,
          onClick: async (btn, wrap) => {
            const err = wrap.querySelector(".dep-modal-err");
            wrap.querySelectorAll("button").forEach((b) => (b.disabled = true));
            err.hidden = true;
            const r = await U.paymentApi("/api/payments/confirm-phone", { body: { phone: shown, idempotency_key: "confirm-phone:" + crypto.randomUUID() } });
            if (!r.ok) {
              wrap.querySelectorAll("button").forEach((b) => (b.disabled = false));
              err.textContent = (r.data && r.data.message) || "Couldn't save your confirmation. Try again in a moment.";
              err.hidden = false;
              return;
            }
            guard.confirmed = true;
            closeDialog();
            U.toast("Phone number confirmed and locked", "ok");
          }
        }, { label: "CANCEL", onClick: () => closeDialog() }]);
    }
    async function loadGuard(quiet) {
      const r = await U.paymentApi("/api/payments/deposit-status");
      if (!r.ok || !r.data) return;
      guard.confirmed = !!r.data.confirmed;
      if (r.data.phone) guard.phone = U.normalizePhone(r.data.phone);
      if (!guard.confirmed && !quiet) showConfirm();
    }
    /* true when a deposit may be sent now; otherwise the matching notice is shown */
    function guardOk() {
      if (guard.confirmed === false) { showConfirm(); return false; }
      return true;
    }
    /* The server also checks phone confirmation. */
    function guardRefusal(data) {
      if (!data) return false;
      if (data.error === "phone_not_confirmed") { guard.confirmed = false; showConfirm(); return true; }
      return false;
    }
    loadGuard();

    /* ---------------- "Before you deposit": the rules, accepted once per version ---------------- */
    const rulesBox = $("depRules");
    const rulesAccept = $("depRulesAccept");
    const rulesErr = $("depRulesErr");
    const rs = { rules: null, accepted: false, sending: false, funds: null, prompt: false };
    const ruleItem = (label, text) => "<li><b>" + U.esc(label) + "</b> " + U.esc(text) + "</li>";
    function rulesHtml(r) {
      const items = (r.policy ? r.policy.items : []).map((it) => ruleItem(it.label + ":", it.text));
      if (r.withdraw_rule.enabled) {
        items.push(ruleItem("Deposit Play-Through:", "money you deposit while this rule is on has to be staked " + r.withdraw_rule.multiple +
          " time(s) before that deposited money can be withdrawn. Winnings are never held, and nothing is ever deducted from your balance."));
      }
      return items.join("");
    }
    /* the player's balance in its two parts, so they can see what can be staked and what can be withdrawn */
    function fundsHtml(f, r) {
      if (!f || !r.bet_rule.enabled) return "";
      return '<div class="dep-funds"><div><span>Session funds <small>(can be staked)</small></span><b>GHS ' + fixed(f.session) + "</b></div>" +
        '<div><span>Winnings <small>(withdrawable, can\u2019t be staked)</small></span><b>GHS ' + fixed(f.winnings) + "</b></div></div>";
    }
    function renderRules() {
      const r = rs.rules;
      if (!r || !rulesBox) return;
      $("depRulesList").innerHTML = rulesHtml(r);
      if (r.policy) {
        $("depRulesHeading").textContent = r.policy.heading;
        $("depRulesAcceptText").textContent = r.policy.accept;
      }
      $("depFunds").innerHTML = fundsHtml(rs.funds, r);
      rulesAccept.checked = rs.accepted;
      rulesAccept.disabled = rs.sending;
      rulesBox.hidden = !rs.prompt;
      rulesBox.classList.toggle("accepted", rs.accepted);
    }
    function rulesError(text) {
      if (!rulesErr) return;
      rulesErr.textContent = text || "";
      rulesErr.hidden = !text;
    }
    async function loadRules() {
      const r = await U.paymentApi("/api/payments/rules");
      if (!r.ok || !r.data || !r.data.rules) return;
      rs.rules = r.data.rules;
      rs.accepted = !!r.data.accepted;
      rs.funds = r.data.funds || null;
      applyMinimum(rs.rules);
      renderRules();
    }
    /* asks the player to tick the box first (the server refuses a deposit until the current rules are accepted) */
    function needAcceptance(text) {
      if (!rs.rules) loadRules(); /* the rules didn't arrive earlier: ask again */
      rs.accepted = false;
      rs.prompt = true;
      renderRules();
      rulesError(text || "Please read the rules above and tick the box to accept them before depositing.");
      if (rulesBox) {
        rulesBox.hidden = false;
        rulesBox.scrollIntoView({ block: "center", behavior: "smooth" });
        rulesAccept.focus({ preventScroll: true });
      }
      return false;
    }
    const rulesOk = () => (rs.accepted ? true : needAcceptance());
    if (rulesAccept) {
      rulesAccept.addEventListener("change", async () => {
        if (!rulesAccept.checked || !rs.rules) { rulesAccept.checked = rs.accepted; return; }
        rs.sending = true;
        rulesError("");
        renderRules();
        rulesAccept.checked = true;
        const r = await U.paymentApi("/api/payments/accept-rules", {
          body: { rules_version: rs.rules.rules_version, idempotency_key: "accept-rules:" + crypto.randomUUID() }
        });
        rs.sending = false;
        if (r.data && r.data.rules) rs.rules = r.data.rules;
        if (!r.ok) {
          rs.accepted = false;
          applyMinimum(rs.rules);
          renderRules();
          rulesError((r.data && r.data.message) || "Couldn't save your acceptance. Try again in a moment.");
          return;
        }
        rs.accepted = true;
        rs.prompt = false;
        applyMinimum(rs.rules);
        renderRules();
        U.toast("Rules accepted", "ok");
      });
    }
    loadRules();
    /* the balance changed (a deposit landed, a bet, a withdrawal): show the session funds and winnings as they are now */
    let fundsTimer = 0;
    document.addEventListener("vb:balance", () => { clearTimeout(fundsTimer); fundsTimer = setTimeout(loadRules, 400); });

    /* asks our server every 4 s for up to 4 minutes; leaving the page doesn't cancel the payment */
    async function waitForPayment(txId) {
      let last = { status: "pending", reason: null };
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const s = await U.paymentApi("/api/payments/teller/status/" + encodeURIComponent(txId));
        if (s.ok && s.data.status && s.data.status !== "pending") return s.data;
        if (s.ok) last = s.data;
      }
      return last;
    }

    /* result = { status, reason } from the authenticated provider status route */
    async function reportResult(result, fallbackAmount) {
      const status = result && result.status;
      const amount = (result && result.amount) || fallbackAmount || 0;
      const why = result && result.reason ? " The payment provider said: \u201c" + U.esc(result.reason) + "\u201d." : "";
      if (status === "approved") {
        const balance = await U.refreshBalance();
        loadGuard(true);
        showMsg("ok", "Deposit of " + U.money(amount) + " successful. Your balance has been updated.");
        PayFX.success({ amount, balance });
      } else if (status === "declined") {
        showMsg("error", "The payment was not approved. No money was taken." + why);
        PayFX.fail({ reason: result && result.reason, onRetry: () => depAmount.focus() });
      } else {
        showMsg("info", "Still waiting for confirmation. Your balance will update as soon as it's confirmed." + why);
        PayFX.pending({});
      }
    }

    /* ---------------- recent deposits ---------------- */
    const BADGE = { approved: ["ok", "Successful"], pending: ["wait", "Pending"], declined: ["bad", "Failed"] };
    function renderHistory(list) {
      const wrap = $("depHistoryWrap");
      const host = $("depHistory");
      if (!wrap || !host) return;
      wrap.hidden = !list.length;
      host.innerHTML = list.map((d) => {
        const [cls, label] = BADGE[d.status] || BADGE.pending;
        const when = new Date(d.created_at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
        return "<div class='tx'><span class='tx-ico' style='background:rgba(52,215,122,.15)'>↓</span>" +
          "<span class='tx-body'><strong>Deposit<span class='tx-badge " + cls + "'>" + label + "</span></strong>" +
          "<span class='dim'>" + when + " · ref " + U.esc(d.reference || d.transaction_id) + "</span>" +
          (d.reason && d.status !== "approved" ? "<span class='tx-note'>" + U.esc(d.reason) + "</span>" : "") +
          "</span><span class='amt in'>+ " + U.money(d.amount) + "</span></div>";
      }).join("");
    }

    /* lists recent deposits; anything pending (or failed in the last 6 h) is asked about again, so a
       payment the provider confirmed late is credited the next time this page opens */
    async function loadHistory(recheck) {
      const r = await U.paymentApi("/api/payments/teller/deposits");
      if (!r.ok || !Array.isArray(r.data.deposits)) return;
      renderHistory(r.data.deposits);
      if (!recheck) return;
      const stuck = r.data.deposits.filter((d) => d.status === "pending" ||
        (d.status === "declined" && Date.now() - new Date(d.created_at).getTime() < 6 * 3600 * 1000));
      if (!stuck.length) return;
      let arrived = 0;
      for (const d of stuck) {
        const s = await U.paymentApi("/api/payments/teller/status/" + encodeURIComponent(d.transaction_id));
        if (s.ok && s.data.status === "approved") arrived += d.amount;
      }
      const balance = await U.refreshBalance();
      await loadHistory(false);
      if (arrived > 0) {
        loadGuard(true);
        showMsg("ok", "Your deposit of " + U.money(arrived) + " has arrived.");
        PayFX.success({ amount: arrived, balance, title: "Your deposit has arrived" });
      }
    }

    /* back from the hosted checkout: wallet.html?transaction_id=… */
    (function handleReturn() {
      const txId = new URLSearchParams(location.search).get("transaction_id");
      history.replaceState({}, "", location.pathname);
      if (!txId) {
        loadHistory(true);
        return;
      }
      showMsg("info", "Checking your payment…");
      PayFX.waiting({ title: "Confirming your payment", text: "This only takes a moment." });
      waitForPayment(txId).then((r) => reportResult(r)).then(() => loadHistory(true));
    })();

    /* Other payment methods: hand over to Payteller's secure checkout */
    async function startCheckout(amt, errId, btn) {
      if (!showError(errId, amountError(amt))) return;
      if (paused) return showPaused();
      if (paymentsOff) return paymentsUnavailable();
      if (!guardOk()) return;
      if (!rulesOk()) return;
      btn.disabled = true;
      showMsg("info", "Starting secure payment…");
      const result = await U.paymentApi("/api/payments/teller/checkout", {
        body: { amount: amt, currency: "GHS", idempotency_key: newKey() }
      });
      if (isOff(result.data)) {
        btn.disabled = false;
        return paymentsUnavailable();
      }
      if (guardRefusal(result.data)) {
        btn.disabled = false;
        msg.innerHTML = "";
        return;
      }
      if (result.data && result.data.error === "rules_not_accepted") {
        btn.disabled = false;
        msg.innerHTML = "";
        loadRules().then(() => needAcceptance(result.data.message));
        return;
      }
      if (!result.ok || !result.data.checkout_url) {
        btn.disabled = false;
        showMsg("error", "Payment could not start. " + U.esc(result.data.message || result.data.error || "Try again in a moment."));
        return;
      }
      location.assign(result.data.checkout_url);
    }

    /* Payteller collects the selected payment method in its secure hosted checkout. */
    const depAmount = $("depAmount");
    let waiting = false;
    let paused = false; // on a self-imposed break: deposits are blocked by the server too
    let paymentsOff = false; // payments switched off by the admin, or the gateway isn't set up yet: the server refuses new payments too
    let pausedText = "";
    /* the button follows the amount only; a blocked account is told why when it taps, never left with a dead grey button */
    const sync = () => {
      const amt = Number(depAmount.value);
      showError("depAmountErr", depAmount.value === "" ? "" : amountError(amt));
      submit.disabled = waiting || !(amt >= DEPOSIT_MIN && amt <= DEPOSIT_MAX);
    };
    resync = sync;
    const OFF_TITLE = "💳 PAYMENT SERVICE UNAVAILABLE";
    const OFF_TEXT = "Mobile Money deposits are currently being configured. Please try again when our payment service becomes available.";
    function paymentsUnavailable() {
      paymentsOff = true;
      sync();
      msg.innerHTML = "";
      openDialog(OFF_TITLE, "<p>" + OFF_TEXT + "</p>", [{ label: "OK", primary: true, onClick: () => closeDialog() }]);
    }
    const isOff = (data) => !!data && (data.error === "payments_off" || data.error === "payments_unavailable");
    function showPaused() {
      openDialog("DEPOSITS PAUSED", "<p>" + pausedText + "</p>", [{ label: "OK", primary: true, onClick: () => closeDialog() }]);
    }
    /* the admin's ON/OFF switch (Admin -> Payteller Payment Settings) and whether the gateway is set up at all;
       payments already made are still checked and credited */
    U.paymentApi("/api/payments/config").then((r) => {
      if (r.ok && r.data && (r.data.paymentsOn === false || r.data.enabled === false)) paymentsOff = true;
    });
    U.paymentApi("/api/user/limits").then((r) => {
      if (!r.ok || !r.data.excludedUntil) return;
      paused = true;
      pausedText = "You're taking a break until <b>" + new Date(r.data.excludedUntil).toLocaleString("en-GB",
        { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + "</b>. Deposits are paused until then; withdrawals still work.";
      showMsg("info", pausedText);
    });
    depAmount.addEventListener("input", sync);
    wireIncrements("quick", depAmount, sync);

    submit.addEventListener("click", async () => {
      if (paused) return showPaused();
      if (paymentsOff) return paymentsUnavailable();
      const amt = Math.round(Number(depAmount.value) * 100) / 100;
      if (!showError("depAmountErr", amountError(amt))) return;
      const net = provider();
      const local = payPhone();
      if (!U.isGhanaMobile(local)) {
        showError("depPhoneErr", "Your registered number isn't a valid Ghanaian mobile money number, so it can't receive a payment prompt. Contact support.");
        phoneIn.focus();
        return;
      }
      if (!net) {
        showMsg("error", "Choose the mobile money network.");
        return;
      }
      if (!guardOk()) return;
      if (!rulesOk()) return;

      waiting = true;
      sync();
      msg.innerHTML = "";
      PayFX.waiting({ title: "Opening secure checkout", text: "Connecting to Payteller…", amount: amt });
      const result = await U.paymentApi("/api/payments/teller/momo", {
        body: {
          amount: amt,
          currency: "GHS",
          network: NETWORK_CODE[net.id],
          account_number: "233" + local.slice(1),
          idempotency_key: newKey()
        }
      });
      if (guardRefusal(result.data)) {
        waiting = false;
        sync();
        PayFX.close();
        return;
      }
      if (isOff(result.data)) {
        waiting = false;
        PayFX.close();
        return paymentsUnavailable();
      }
      if (result.data && result.data.error === "rules_not_accepted") {
        waiting = false;
        sync();
        PayFX.close();
        loadRules().then(() => needAcceptance(result.data.message));
        return;
      }
      if (result.ok && result.data.checkout_url) {
        PayFX.close();
        location.assign(result.data.checkout_url);
        return;
      }
      if (!result.ok || !result.data.transaction_id) {
        waiting = false;
        sync();
        const reason = result.data.message || result.data.error || "Try again in a moment.";
        showMsg("error", "Payment could not start. " + U.esc(reason));
        PayFX.fail({ reason, onRetry: () => depAmount.focus() });
        return;
      }
      PayFX.waiting({
        amount: amt,
        text: "Continue in Payteller’s secure checkout to complete your " + U.esc(net.name) + " payment.",
        onHide: () => showMsg("info", "Waiting for you to complete the payment in Payteller…")
      });
      loadHistory(false);
      const outcome = await waitForPayment(result.data.transaction_id);
      await reportResult(outcome, amt);
      loadHistory(false);
      waiting = false;
      if (outcome.status === "approved") depAmount.value = "";
      sync();
    });
    sync();

  }

  /* =====================================================================
     WITHDRAW
     ===================================================================== */
  function initWithdraw() {
    const submit = $("wdSubmit");
    if (!submit) return; // not the withdraw page

    const masked = $("wdPhoneMasked");
    if (masked) masked.textContent = maskPhone(regPhone);

    initProvider();
    if (!requireSignIn(submit)) return;

    const wdAmount = $("wdAmount");
    const sync = () => {
      showError("wdAmountErr", "");
      submit.disabled = !(Number(wdAmount.value) >= WITHDRAW_MIN);
    };
    wdAmount.addEventListener("input", sync);
    wireIncrements("wquick", wdAmount, sync);

    /* only winnings can be withdrawn: say how much of the balance that is, when part of it is deposited money; and,
       while the play-through rule is on (Admin -> Betting & withdrawal settings), how much deposited money is held
       and how much more must be bet. Winnings are never held; nothing is ever deducted. */
    const showWithdrawable = async () => {
      const r = await U.paymentApi("/api/user/withdraw/available");
      if (!r.ok || !r.data) return;
      const d = r.data;
      const info = $("wdInfo");
      if (info && d.withdraw_info) { info.textContent = d.withdraw_info; info.hidden = false; }
      const pt = d.playthrough || {};
      const deposits = d.deposit_requirement || {};
      const depositBox = $("wdDepositRequirement");
      if (depositBox) {
        depositBox.hidden = !deposits.enabled || !deposits.show_notice;
        if (!depositBox.hidden) {
          const explanation = deposits.triggered
            ? (deposits.eligible
              ? "You have completed the required qualifying deposits. Withdrawal deposit eligibility is unlocked."
              : (deposits.message || "Complete the required qualifying deposits before withdrawing."))
            : (deposits.policy_message || "The requirement activates after a qualifying deposit, casino bet and win.");
          depositBox.innerHTML = "<strong>Withdrawal deposit requirement</strong><p>" + U.esc(explanation) + "</p>" +
            "<p>Qualifying deposits completed: " + U.esc(String(deposits.completed)) + " of " +
            U.esc(String(deposits.required)) + " (minimum GHS " + U.money(deposits.min_deposit) + " each).</p>" +
            (!deposits.triggered ? "<p>This restriction applies after your first qualifying deposit, casino bet and win.</p>" : "");
        }
      }
      if (deposits.enabled && deposits.triggered && !deposits.eligible) {
        msg.innerHTML = "";
        return;
      }
      const box = $("wdRule");
      if (box) {
        box.hidden = !pt.enabled;
        if (pt.enabled) {
          box.innerHTML = "<strong>Play-through rule</strong>" +
            (d.held > 0
              ? "<p>" + U.esc(pt.message || "") + "</p><dl class='wd-rule-nums'><div><dt>Withdrawable now</dt><dd>" + U.money(d.withdrawable) +
                "</dd></div><div><dt>Held (deposits not yet bet)</dt><dd>" + U.money(d.held) + "</dd></div><div><dt>Still to bet</dt><dd>" + U.money(d.to_bet) + "</dd></div></dl>"
              : "<p>Nothing in your balance is held by the play-through rule. Money you deposit has to be bet " + U.esc(String(pt.multiple)) +
                " time(s) before that deposited money can be withdrawn; winnings are never held.</p>");
        }
      }
      if (!(d.balance > d.withdrawable)) return;
      msg.innerHTML = "<div class='alert alert-info'>You can withdraw " + U.money(d.withdrawable) +
        " (your winnings). Deposited money can't be withdrawn; it stays in your balance for betting.</div>";
    };
    showWithdrawable();

    submit.addEventListener("click", async () => {
      const amt = Math.round(Number(wdAmount.value) * 100) / 100;
      const bal = U.wallet.balance();
      const ok = showError("wdAmountErr",
        !amt ? "Enter an amount." :
        amt < WITHDRAW_MIN ? "Minimum withdrawal is GHS " + WITHDRAW_MIN.toFixed(2) + "." :
        amt > bal ? "Amount exceeds your balance of " + U.money(bal) + "." : "");
      if (!ok) return;

      msg.innerHTML = "<div class='alert alert-info'>Requesting withdrawal…</div>";
      const idempotencyKey = "withdraw:" + crypto.randomUUID() + ":" + Date.now();
      const result = await U.paymentApi("/api/user/withdraw", {
        body: { amount: amt, idempotency_key: idempotencyKey }
      });
      if (!result.ok) {
        msg.innerHTML = "<div class='alert alert-error'>Withdrawal could not be processed. " +
          U.esc(result.data.message || result.data.error || "Try again in a moment.") + "</div>";
        U.toast("Withdrawal failed", "error");
        return;
      }
      await U.refreshBalance();
      msg.innerHTML = "<div class='alert alert-ok'>Withdrawal of " + U.money(amt) +
        " requested. It will be sent to " + U.esc(maskPhone(regPhone)) + " once it's approved — follow it in " +
        "<a href='transactions.html'>Transaction records</a>.</div>";
      U.toast("Withdrawal requested: " + U.money(amt), "ok");
      wdAmount.value = "";
      sync();
    });

    sync();
  }

  initDeposit();
  initWithdraw();

  /* "about $X" next to the minimum, from the live USD rate (the mid rate, before any conversion spread); asked again
     when the live minimum arrives */
  async function showMinUsd() {
    const el = document.getElementById("depMinUsd");
    if (!el || !U.session.get()) return;
    const r = await U.paymentApi("/api/user/convert/quote?from=GHS&to=USD&amount=" + DEPOSIT_MIN);
    if (!r.ok || !r.data || !(r.data.mid > 0)) return;
    el.textContent = " (about $ " + (DEPOSIT_MIN * r.data.mid).toFixed(2) + " at today's rate)";
  }
})();
