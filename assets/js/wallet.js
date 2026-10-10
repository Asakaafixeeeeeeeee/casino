/* Deposit (wallet.html) and Withdraw (withdraw.html) — app-style mobile money flow.
   One file serves both; each section wires up only when its elements are present. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const payments = (window.VB && window.VB.payments) || [];
  const MOMO = payments.filter((m) => m.type === "momo");

  const DEPOSIT_MIN = 5;
  const DEPOSIT_MAX = 50000;
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

  /* ---------------- tabs ---------------- */
  const tabs = Array.from(document.querySelectorAll(".pay-tab"));
  const panels = Array.from(document.querySelectorAll(".pay-panel"));
  function showTab(name) {
    tabs.forEach((t) => t.classList.toggle("on", t.dataset.paytab === name));
    panels.forEach((p) => (p.hidden = p.dataset.panel !== name));
    if (msg) msg.innerHTML = "";
  }
  tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.paytab)));

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

    /* the number paying: the registered one to start with, or the last one used on this device. Any Ghanaian mobile
       money number works — the prompt goes to that phone — and winnings are still only ever paid to the registered one. */
    const LAST = "vb.depositPhone";
    const regLocal = U.normalizePhone(regPhone);
    const phoneIn = $("depPhone");
    const pretty = (p) => (/^0\d{9}$/.test(p) ? p.slice(0, 3) + " " + p.slice(3, 6) + " " + p.slice(6) : p);
    const payPhone = () => U.normalizePhone(phoneIn.value);
    let last = "";
    try {
      last = localStorage.getItem(LAST) || "";
    } catch (e) { /* storage unavailable */ }
    phoneIn.value = pretty(U.isGhanaMobile(last) ? last : regLocal);

    const provider = initProvider();
    provider.match(payPhone());
    /* a number on an unexpected network is pointed out, never blocked: numbers move between networks */
    function phoneHint() {
      const p = payPhone();
      const net = provider();
      const usual = MOMO.find((m) => m.prefixes.includes(p.slice(0, 3)));
      $("depPhoneHint").textContent = !U.isGhanaMobile(p) ? "Pay from any mobile money number — tap it to change."
        : usual && net && usual !== net ? "Numbers starting " + p.slice(0, 3) + " are usually " + usual.name + ". Keep " + net.name + " only if this number moved there."
        : p === regLocal ? "Your registered number. To pay from another one, tap it to change."
        : "Paying from another number: the prompt goes to that phone. Winnings are still paid to your registered number.";
    }
    function phoneChanged() {
      const p = payPhone();
      showError("depPhoneErr", "");
      $("depPhoneMine").hidden = !regLocal || p === regLocal;
      if (U.isGhanaMobile(p)) provider.match(p);
      phoneHint();
    }
    phoneIn.addEventListener("input", phoneChanged);
    phoneIn.addEventListener("blur", () => {
      const p = payPhone();
      if (U.isGhanaMobile(p)) phoneIn.value = pretty(p);
    });
    $("depPhoneMine").addEventListener("click", () => {
      phoneIn.value = pretty(regLocal);
      phoneChanged();
    });
    $("provMenu").addEventListener("click", () => setTimeout(phoneHint, 0));
    phoneChanged();
    if (!requireSignIn(submit)) return;

    const showMsg = (kind, text) => { msg.innerHTML = "<div class='alert alert-" + kind + "'>" + text + "</div>"; };
    const amountError = (amt) =>
      !amt ? "Enter an amount." :
      amt < DEPOSIT_MIN ? "Minimum deposit is GHS " + DEPOSIT_MIN.toFixed(2) + "." :
      amt > DEPOSIT_MAX ? "Maximum deposit is GHS " + DEPOSIT_MAX.toLocaleString() + "." : "";
    const newKey = () => "deposit:" + crypto.randomUUID() + ":" + Date.now();

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

    /* result = { status, reason } from the status route; the reason is TheTeller's own words */
    async function reportResult(result, fallbackAmount) {
      const status = result && result.status;
      const amount = (result && result.amount) || fallbackAmount || 0;
      const why = result && result.reason ? " TheTeller said: \u201c" + U.esc(result.reason) + "\u201d." : "";
      if (status === "approved") {
        const balance = await U.refreshBalance();
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
       payment TheTeller confirmed late is credited the next time this page opens */
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
        showMsg("ok", "Your deposit of " + U.money(arrived) + " has arrived.");
        PayFX.success({ amount: arrived, balance, title: "Your deposit has arrived" });
      }
    }

    /* back from TheTeller's checkout page: wallet.html?transaction_id=… */
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

    /* Card and Paybill: hand over to TheTeller's secure page */
    async function startCheckout(amt, errId, btn) {
      if (!showError(errId, amountError(amt))) return;
      btn.disabled = true;
      showMsg("info", "Starting secure payment…");
      const result = await U.paymentApi("/api/payments/teller/checkout", {
        body: { amount: amt, currency: "GHS", idempotency_key: newKey() }
      });
      if (!result.ok || !result.data.checkout_url) {
        btn.disabled = false;
        showMsg("error", "Payment could not start. " + U.esc(result.data.message || result.data.error || "Try again in a moment."));
        return;
      }
      location.assign(result.data.checkout_url);
    }

    /* Mobile Money: TheTeller sends a PIN prompt to the phone; we wait for the answer here */
    const depAmount = $("depAmount");
    let waiting = false;
    let paused = false; // on a self-imposed break: deposits are blocked by the server too
    const sync = () => {
      showError("depAmountErr", "");
      submit.disabled = waiting || paused || !(Number(depAmount.value) >= DEPOSIT_MIN);
    };
    U.paymentApi("/api/user/limits").then((r) => {
      if (!r.ok || !r.data.excludedUntil) return;
      paused = true;
      sync();
      ["pbSubmit", "cdSubmit"].forEach((id) => { if ($(id)) $(id).disabled = true; });
      showMsg("info", "You're taking a break until <b>" + new Date(r.data.excludedUntil).toLocaleString("en-GB",
        { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + "</b>. Deposits are paused until then; withdrawals still work.");
    });
    depAmount.addEventListener("input", sync);
    wireIncrements("quick", depAmount, sync);

    submit.addEventListener("click", async () => {
      const amt = Math.round(Number(depAmount.value) * 100) / 100;
      if (!showError("depAmountErr", amountError(amt))) return;
      const net = provider();
      const local = payPhone();
      if (!U.isGhanaMobile(local)) {
        showError("depPhoneErr", "Enter a valid Ghanaian mobile money number, e.g. 024 123 4567.");
        phoneIn.focus();
        return;
      }
      if (!net) {
        showMsg("error", "Choose the mobile money network.");
        return;
      }
      try {
        localStorage.setItem(LAST, local);
      } catch (e) { /* storage unavailable */ }

      waiting = true;
      sync();
      msg.innerHTML = "";
      PayFX.waiting({ title: "Sending payment prompt", text: "Connecting to " + U.esc(net.name) + "…", amount: amt });
      const result = await U.paymentApi("/api/payments/teller/momo", {
        body: {
          amount: amt,
          currency: "GHS",
          network: NETWORK_CODE[net.id],
          account_number: "233" + local.slice(1),
          idempotency_key: newKey()
        }
      });
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
        text: "We sent a prompt to <b>" + U.esc(maskPhone(local)) + "</b>. Enter the mobile money PIN on that phone to confirm." +
          (net.id === "mtn" ? "<span class='payfx-hint'>No prompt? Dial *170#, then select 6 and 3.</span>" : ""),
        onHide: () => showMsg("info", "Waiting for you to approve the payment on your phone…")
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

    /* Paybill + Card tabs reuse the same checkout */
    ["pb", "cd"].forEach((pfx) => {
      const amt = $(pfx + "Amount");
      const btn = $(pfx + "Submit");
      if (!amt || !btn) return;
      amt.addEventListener("input", () => showError(pfx + "AmountErr", ""));
      btn.addEventListener("click", () => startCheckout(Math.round(Number(amt.value) * 100) / 100, pfx + "AmountErr", btn));
    });
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

  /* "about $X" next to the minimum, from the live USD rate (the mid rate, before any conversion spread) */
  (async () => {
    const el = document.getElementById("depMinUsd");
    if (!el || !U.session.get()) return;
    const r = await U.paymentApi("/api/user/convert/quote?from=GHS&to=USD&amount=" + DEPOSIT_MIN);
    if (!r.ok || !r.data || !(r.data.mid > 0)) return;
    el.textContent = " (about $ " + (DEPOSIT_MIN * r.data.mid).toFixed(2) + " at today's rate)";
  })();
})();
