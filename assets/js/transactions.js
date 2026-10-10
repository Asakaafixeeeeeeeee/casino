/* Transaction records: deposits and withdrawals from the server, filtered by type and status, grouped by day */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);
  const list = $("txrList");
  const filter = { kind: "all", status: "all" };
  let all = [];

  const STATUS = { success: ["ok", "Success"], pending: ["wait", "Pending"], failed: ["bad", "Failed"] };

  function maskId(phone) {
    const p = U.normalizePhone(phone || "");
    return /^0\d{9}$/.test(p) ? p.slice(0, 2) + "*****" + p.slice(7) : "";
  }

  function dayLabel(d) {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }

  function row(t) {
    const d = new Date(t.created_at);
    const dep = t.kind === "deposit";
    const [tone, label] = STATUS[t.status] || STATUS.pending;
    const ref = dep ? t.ref : t.ref.slice(0, 8).toUpperCase();
    const to = t.destination ? maskId(t.destination) : "";
    const detail = !dep ?
      (t.status === "success" ? "Paid to " + to :
       t.status === "failed" ? "Returned to your balance" + (t.reason ? " · " + t.reason : "") :
       "To " + to + " · awaiting payout") :
      t.status === "failed" && t.reason ? t.reason :
      t.status === "pending" ? "Waiting for confirmation" : "";
    return '<div class="txr-row">' +
      '<span class="txr-ico ' + (dep ? "in" : "out") + '">' + U.icon(dep ? "plus" : "withdraw") + "</span>" +
      '<span class="txr-main"><strong>' + (dep ? "Deposit" : "Withdrawal") + "</strong>" +
      "<small>" + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + " · Ref " + U.esc(ref) + "</small>" +
      (detail ? '<small class="txr-detail ' + (t.status === "failed" ? "bad" : "") + '">' + U.esc(detail) + "</small>" : "") +
      "</span>" +
      '<span class="txr-end"><b class="' + (dep ? "in" : "out") + '">' + (dep ? "+ " : "− ") + U.money(t.amount) + "</b>" +
      '<span class="tx-badge ' + tone + '">' + label + "</span></span></div>";
  }

  function render() {
    const shown = all.filter((t) =>
      (filter.kind === "all" || t.kind === filter.kind) && (filter.status === "all" || t.status === filter.status));
    $("txrCount").textContent = all.length ? shown.length + (shown.length === 1 ? " record" : " records") : "";
    if (!shown.length) {
      list.innerHTML = '<div class="me-empty"><span class="me-done-ico">' + U.icon("receipt") + "</span>" +
        "<p>" + (all.length ? "No records match these filters." : "No transactions yet. Your deposits and withdrawals will appear here.") + "</p>" +
        (all.length ? "" : '<a class="btn btn-primary" href="wallet.html">Make a deposit</a>') + "</div>";
      return;
    }
    let html = "";
    let day = "";
    shown.forEach((t) => {
      const label = dayLabel(new Date(t.created_at));
      if (label !== day) {
        if (day) html += "</div>";
        html += '<h2 class="txr-day">' + label + '</h2><div class="txr-group">';
        day = label;
      }
      html += row(t);
    });
    list.innerHTML = html + "</div>";
  }

  document.querySelectorAll("[data-kind]").forEach((b) => b.addEventListener("click", () => {
    filter.kind = b.dataset.kind;
    document.querySelectorAll("[data-kind]").forEach((x) => {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-selected", String(x === b));
    });
    render();
  }));
  document.querySelectorAll("[data-status]").forEach((b) => b.addEventListener("click", () => {
    filter.status = b.dataset.status;
    document.querySelectorAll("[data-status]").forEach((x) => {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    });
    render();
  }));

  if (!U.session.get()) {
    $("msg").innerHTML = "<div class='alert alert-error'>Please <a href='register.html#login'>log in</a> to see your transactions.</div>";
    return;
  }
  list.innerHTML = '<div class="txr-loading" aria-label="Loading">' + "<i></i>".repeat(4) + "</div>";
  U.paymentApi("/api/user/transactions").then((r) => {
    if (!r.ok || !Array.isArray(r.data.transactions)) {
      list.innerHTML = "";
      $("msg").innerHTML = "<div class='alert alert-error'>Couldn't load your transactions. " +
        U.esc((r.data && (r.data.message || r.data.error)) || "Try again in a moment.") + "</div>";
      return;
    }
    all = r.data.transactions;
    render();
  });
})();
