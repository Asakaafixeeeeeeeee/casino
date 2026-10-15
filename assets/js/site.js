/* WIN B casino shared code: storage, wallet, session, favourites, phone numbers, icons, game cards, toasts,
   and the app shell every page uses — header, category bar, bottom nav, live chat and footer. */
(function (global) {
  "use strict";

  const KEY = "voltabet.wallet";
  const FAV = "voltabet.favourites";
  const RECENT = "voltabet.recent";
  const SESSION = "voltabet.session";

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* private mode — session-only */
    }
  }
  function remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      /* storage unavailable */
    }
  }

  const cents = (n) => Math.round(n * 100) / 100;
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- wallet (client cache; server-authoritative balance) ---------------- */
  const wallet = {
    /* always returns a well-formed state, even if storage holds something unexpected */
    all() {
      const s = read(KEY, null) || {};
      return {
        balance: Number(s.balance) || 0,
        transactions: Array.isArray(s.transactions) ? s.transactions : []
      };
    },
    balance() {
      return this.all().balance;
    },
    setBalance(v) {
      const s = this.all();
      s.balance = Math.max(0, cents(v));
      this.save(s);
      return s.balance;
    },
    save(state) {
      write(KEY, state);
      this.paint();
      return state;
    },
    deposit(amount, method) {
      return this.record("deposit", amount, method);
    },
    withdraw(amount, method) {
      return this.record("withdrawal", amount, method);
    },
    /* logs a transaction, moves the balance and returns the new entry */
    record(type, amount, method) {
      const s = this.all();
      const tx = {
        type,
        amount,
        method,
        ref: "RW-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        date: new Date().toISOString()
      };
      s.balance = Math.max(0, cents(s.balance + (type === "deposit" ? amount : -amount)));
      s.transactions.unshift(tx);
      s.transactions = s.transactions.slice(0, 25);
      this.save(s);
      return tx;
    },
    reset() {
      remove(KEY);
      this.paint();
    },
    paint() {
      const bal = this.balance();
      document.querySelectorAll("[data-wallet-balance]").forEach((el) => {
        el.textContent = format(bal);
      });
      document.querySelectorAll("[data-wallet-balance-num]").forEach((el) => {
        el.textContent = Number(bal || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      });
      accounts.paintChip();
      document.dispatchEvent(new CustomEvent("vb:balance")); /* games repaint their own balance display */
    }
  };

  function format(n) {
    return "₵ " + Number(n || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* ---------------- the accounts behind the header chip ---------------- */
  /* the full balances view (the primary account, the US dollar account and WIN B Points) as the server last gave it, and
     which of them the player has chosen to see in the header. Games always bet from the primary account; the choice
     only changes what the chip shows. */
  const ACCOUNTS = "vb.accounts";
  const SHOWN = "vb.account.shown";
  const accounts = {
    all() {
      const a = read(ACCOUNTS, null) || {};
      return { primary: a.primary || null, others: Array.isArray(a.others) ? a.others : [], points: Number(a.points) || 0 };
    },
    save(view) {
      write(ACCOUNTS, {
        primary: view.primary ? { code: view.primary.currencyCode, symbol: view.primary.symbol, name: view.primary.name, available: Number(view.primary.available) || 0 } : null,
        others: (view.otherAccounts || []).map((o) => ({ code: o.currencyCode, symbol: o.symbol, name: o.name, network: o.network || "", kind: o.kind, available: Number(o.available) || 0 })),
        points: Number(view.loyaltyPoints && view.loyaltyPoints.available) || 0
      });
      this.paintChip();
    },
    /* the view is the account's currency, chosen at sign-up and changed from the balance menu (kept on the account, so
       it's the same on every device). Points are a per-device view on top of it. A "$ 0.00" chip over a cedi balance
       would hide the player's money, so an empty dollar account falls back to the cedis they hold. */
    shown() {
      const s = session.get();
      const view = read(SHOWN, null);
      if (view === "points") return view;
      const pref = (s && s.currency) || "USD";
      if (pref === "USD") {
        const usd = this.all().others.find((o) => o.code === "USD");
        return (!usd || !(usd.available > 0)) && wallet.balance() > 0 ? "primary" : "USD";
      }
      return "primary";
    },
    show(code) {
      write(SHOWN, code === "points" ? "points" : null);
      if (code !== "points") {
        const currency = code === "primary" ? primaryCode() : code;
        const s = session.get();
        if (s && s.currency !== currency) {
          session.set(Object.assign({}, s, { currency }), { remember: !!read(SESSION, null) });
          api("/api/me/currency", { body: { currency } });
        }
      }
      this.paintChip();
    },
    /* the list the chip's menu offers: the primary account first, then points, then every crypto sub-balance */
    list() {
      const a = this.all();
      const amount = (n, max) => Number(n || 0).toLocaleString("en-GH", { minimumFractionDigits: 0, maximumFractionDigits: max });
      /* dollars first (the default), then the cedi account, then points */
      const out = [];
      const others = a.others.length ? a.others : [{ code: "USD", name: "US Dollar", symbol: "$", kind: "FIAT", available: 0 }];
      others.forEach((o) => out.push({ code: o.code, label: o.name, sub: o.code + (o.kind === "FIAT" ? " account" : ""),
        short: o.kind === "FIAT" ? (o.symbol || "") + " " + Number(o.available || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : amount(o.available, 8) + " " + o.code,
        symbol: o.symbol || o.code }));
      out.push({ code: "primary", label: a.primary ? a.primary.name : "Ghanaian Cedi", sub: (a.primary ? a.primary.code : "GHS") + " · deposits & games",
        short: format(wallet.balance()), symbol: a.primary ? a.primary.symbol : "₵" });
      out.push({ code: "points", label: "WIN B Points", sub: "Loyalty rewards", short: amount(a.points, 0) + " pts", symbol: "★" });
      return out;
    },
    current() {
      const list = this.list();
      return list.find((x) => x.code === this.shown()) || list[0];
    },
    paintChip() {
      const cur = this.current();
      document.querySelectorAll("[data-account-balance]").forEach((el) => { el.textContent = cur.short; });
    }
  };

  /* ---------------- session (who is signed in; decides what the header shows) ---------------- */
  /* accounts live on the WIN B casino accounts server (accounts-api/), so they work on any device; the session holds the
     player's phone, username and sign-in token. Balances are not on the server — the wallet stays in this browser. */
  /* "Keep me signed in" keeps the session in localStorage (it survives closing the browser); otherwise it lives in
     sessionStorage and ends when the browser closes */
  const readTab = () => {
    try {
      const raw = sessionStorage.getItem(SESSION);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  };
  const session = {
    get() {
      const s = readTab() || read(SESSION, null);
      return s && s.phone ? s : null;
    },
    set(s, opts) {
      const keep = !opts || opts.remember !== false;
      if (keep) {
        write(SESSION, s);
        try { sessionStorage.removeItem(SESSION); } catch (e) { /* storage unavailable */ }
      } else {
        remove(SESSION);
        try { sessionStorage.setItem(SESSION, JSON.stringify(s)); } catch (e) { write(SESSION, s); }
      }
      document.dispatchEvent(new CustomEvent("vb:session"));
    },
    clear() {
      remove(SESSION);
      try { sessionStorage.removeItem(SESSION); } catch (e) { /* storage unavailable */ }
      document.dispatchEvent(new CustomEvent("vb:session"));
    },
    /* ends the session on the server too (the request goes out before the token is forgotten) */
    logout() {
      const s = this.get();
      if (s && s.token) api("/api/logout", { body: {}, keepalive: true });
      wallet.reset(); // the cached balance belongs to the account that just left
      this.clear();
    }
  };

  /* ---------------- accounts server ---------------- */
  const API = global.VB_ACCOUNTS_API ||
    (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://localhost:8792" : "https://asakaa-accounts.onrender.com");
  const PAYMENT_API = global.VB_PAYMENT_API ||
    (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? "http://localhost:8781" : "https://asakaa-balance.onrender.com");

  /* → { ok, status, data }; status 0 means the server couldn't be reached. On Render's free plan the server sleeps
     when idle and takes up to a minute to wake, hence the long timeout. */
  async function api(path, opts) {
    opts = opts || {};
    const s = session.get();
    const headers = { "Content-Type": "application/json" };
    if (s && s.token) headers.Authorization = "Bearer " + s.token;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 75000);
    try {
      const res = await fetch(API + path, {
        method: opts.method || (opts.body ? "POST" : "GET"),
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
        keepalive: !!opts.keepalive
      });
      let data = {};
      try { data = await res.json(); } catch (e) { /* empty or non-JSON reply */ }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: "Can't reach the account server. Check your connection and try again." } };
    } finally {
      clearTimeout(timer);
    }
  }

  async function paymentApi(path, opts) {
    opts = opts || {};
    const s = session.get();
    const headers = { "Content-Type": "application/json" };
    if (s && s.token) headers.Authorization = "Bearer " + s.token;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 75000);
    try {
      const res = await fetch(PAYMENT_API + path, {
        method: opts.method || (opts.body ? "POST" : "GET"),
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
        keepalive: !!opts.keepalive
      });
      let data = {};
      try { data = await res.json(); } catch (e) { /* empty or non-JSON reply */ }
      /* banned or closed by the main admin: the account can't be used any more, so this device signs out */
      if (res.status === 403 && data && (data.error === "account_banned" || data.error === "account_closed") && session.get()) {
        session.clear();
        toast(data.message || "This account can't be used. Contact customer care.", "error");
      }
      /* the betting rule (Admin -> Betting & withdrawal settings): every game's refused bet explains itself here */
      if (res.status === 403 && data && data.error === "deposit_required") depositRequired(data.message);
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: "Can't reach the payment server. Check your connection and try again." } };
    } finally {
      clearTimeout(timer);
    }
  }

  /* A bet refused by the betting rule: the admin's message (filled with the minimum and the days) and a way to the
     deposit page. Nothing was taken; the balance stays visible and withdrawable. Shown once per refusal burst. */
  let depositRequiredAt = 0;
  function depositRequired(message) {
    if (Date.now() - depositRequiredAt < 4000 || document.getElementById("vbDepositRequired")) return;
    depositRequiredAt = Date.now();
    const dlg = document.createElement("div");
    dlg.className = "me-dialog";
    dlg.id = "vbDepositRequired";
    dlg.setAttribute("role", "alertdialog");
    dlg.setAttribute("aria-modal", "true");
    dlg.setAttribute("aria-labelledby", "vbDepositRequiredTitle");
    dlg.innerHTML = '<div class="me-dialog-card vb-depreq"><span class="me-dialog-ico">' + icon("wallet") + "</span>" +
      '<h2 id="vbDepositRequiredTitle">A deposit is needed to bet</h2><p>' +
      esc(message || "A recent deposit is needed to place casino bets. Your balance is not affected.") + "</p>" +
      '<div class="me-dialog-actions"><button class="btn btn-ghost btn-lg" type="button" data-no>Not now</button>' +
      '<a class="btn btn-primary btn-lg" href="wallet.html">Deposit</a></div></div>';
    const close = () => { dlg.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest("[data-no]")) close(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(dlg);
    dlg.querySelector("[data-no]").focus();
  }

  /* The live minimum deposit and the betting and withdrawal rules (Admin -> Betting & withdrawal settings), read once
     per page from /api/payments/config. The last minimum seen is kept so help texts read right before it arrives. */
  const MIN_DEP_KEY = "vb.minDeposit";
  let rulesFetch = null;
  function minDepositNow() {
    const n = Number(read(MIN_DEP_KEY, 0));
    return n > 0 ? n : 135;
  }
  const cedis = (n) => Number(n).toLocaleString("en-GH", { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });
  function moneyRules() {
    if (!rulesFetch) {
      rulesFetch = paymentApi("/api/payments/config", { timeout: 20000 }).then((r) => {
        if (!r.ok || !r.data || !r.data.rules) { rulesFetch = null; return null; }
        write(MIN_DEP_KEY, r.data.rules.min_deposit);
        return r.data.rules;
      });
    }
    return rulesFetch;
  }
  /* any page: [data-rule="min-deposit"] and friends are filled with the live values (the markup holds a fallback) */
  function fillLiveRules() {
    const els = document.querySelectorAll("[data-rule]");
    if (!els.length) return;
    moneyRules().then((rules) => {
      if (!rules) return;
      const days = String(rules.bet_rule.days);
      const set = {
        "min-deposit": cedis(rules.min_deposit), "max-deposit": cedis(rules.max_deposit), "bet-days": days,
        "multiple": cedis(rules.withdraw_rule.multiple), "withdraw-info": rules.withdraw_info,
      };
      document.querySelectorAll("[data-rule]").forEach((el) => {
        const k = el.dataset.rule;
        if (k in set) el.textContent = set[k];
        if (k === "bet-on") el.hidden = !rules.bet_rule.enabled;
        if (k === "bet-off") el.hidden = rules.bet_rule.enabled;
        if (k === "withdraw-on") el.hidden = !rules.withdraw_rule.enabled;
        if (k === "withdraw-off") el.hidden = rules.withdraw_rule.enabled;
      });
    });
  }

  /* on each page: a session from before accounts moved to the server (no token) is dropped, and one the server no
     longer knows (logged out elsewhere, password reset, expired) ends here too */
  function checkSession() {
    const s = session.get();
    if (!s) return;
    if (!s.token) return session.clear();
    api("/api/me").then((r) => {
      if (r.status === 401 && session.get() && session.get().token === s.token) {
        session.clear();
        const why = r.data && typeof r.data.error === "string" && /banned|closed/.test(r.data.error) ? r.data.error : "";
        toast(why || "Your session has ended — please log in again.", why ? "error" : undefined);
        return;
      }
      /* the account's currency (chosen at sign-up, changed from the balance menu) follows the player to this device */
      const cur = r.ok && r.data && r.data.user && r.data.user.currency;
      const now = session.get();
      if (cur && now && now.currency !== cur) {
        session.set(Object.assign({}, now, { currency: cur }), { remember: !!read(SESSION, null) });
        accounts.paintChip();
      }
    });
  }

  /* fetches the server-held wallet balance and mirrors it into the local cache so the header chip,
     wallet page and any [data-wallet-balance] element show the same number. */
  async function refreshBalance() {
    if (!session.get()) return 0;
    const r = await paymentApi("/api/user/balances");
    if (!r.ok || !r.data || !r.data.primary) return wallet.balance();
    const amount = Number(r.data.primary.available) || 0;
    wallet.setBalance(amount);
    accounts.save(r.data);
    return amount;
  }

  /* ---------------- daily streak ---------------- */
  /* consecutive days a signed-in player has opened WIN B casino on this device */
  const STREAK = "vb.streak";
  const dayKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const streak = {
    get() {
      const s = read(STREAK, null);
      if (!s || !s.last) return 0;
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      return s.last === dayKey(new Date()) || s.last === dayKey(yesterday) ? Number(s.count) || 0 : 0;
    },
    best() {
      const s = read(STREAK, null);
      return (s && Number(s.best)) || 0;
    },
    touch() {
      if (!session.get()) return;
      const today = dayKey(new Date());
      const s = read(STREAK, null) || {};
      if (s.last === today) return;
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const count = s.last === dayKey(yesterday) ? (Number(s.count) || 0) + 1 : 1;
      write(STREAK, { last: today, count, best: Math.max(count, Number(s.best) || 0) });
    }
  };

  /* ---------------- favourites & recently played ---------------- */
  const favs = {
    all() {
      const list = read(FAV, []);
      return Array.isArray(list) ? list : [];
    },
    has(id) {
      return this.all().includes(id);
    },
    toggle(id) {
      const list = this.all();
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1);
      else list.push(id);
      write(FAV, list);
      const on = i < 0;
      document.dispatchEvent(new CustomEvent("vb:favourites", { detail: { id, on } }));
      return on;
    }
  };

  /* keep every heart for the same game in step — a title can appear twice on one page */
  document.addEventListener("vb:favourites", (e) => {
    document.querySelectorAll(".fav-btn").forEach((b) => {
      if (b.dataset.fav !== e.detail.id) return;
      b.classList.toggle("on", e.detail.on);
      b.setAttribute("aria-pressed", String(e.detail.on));
    });
  });

  const recent = {
    all() {
      const list = read(RECENT, []);
      return Array.isArray(list) ? list : [];
    },
    add(id) {
      write(RECENT, [id].concat(this.all().filter((x) => x !== id)).slice(0, 12));
    }
  };

  /* ---------------- free-play mode ---------------- */
  /* Free-play uses local credits for try-before-you-deposit demos; enabled on
     local dev or when VB_TEST_MODE is explicitly set by the deployment. */
  const testMode = global.VB_TEST_MODE === true ||
    (global.VB_TEST_MODE !== false &&
     (location.hostname === "localhost" || location.hostname === "127.0.0.1"));

  /* ---------------- Ghanaian mobile numbers ---------------- */
  /* MTN 024/025/053/054/055/059 · Telecel 020/050 · AirtelTigo 026/027/056/057 · Glo 023 */
  const MOBILE_PREFIXES = ["020", "023", "024", "025", "026", "027", "050", "053", "054", "055", "056", "057", "059"];

  /* drops spaces and dashes, and turns +233 / 00233 / 233 into the local leading 0 */
  function normalizePhone(v) {
    return String(v || "").replace(/[\s().-]/g, "").replace(/^(?:\+|00)?2330?/, "0");
  }

  function isGhanaMobile(phone) {
    return /^0\d{9}$/.test(phone) && MOBILE_PREFIXES.includes(phone.slice(0, 3));
  }

  /* ---------------- icons (inline SVG, 24×24; strokes use currentColor, class "f" paths are filled) ---------------- */
  const ICONS = {
    home: '<path d="M3.5 11 12 4l8.5 7"/><path d="M6 9.5V20h4.5v-5.5h3V20H18V9.5"/>',
    gift: '<rect x="3.5" y="8" width="17" height="4.5" rx="1"/><path d="M5.5 12.5V20h13v-7.5M12 8v12"/>' +
      '<path d="M12 8C10.5 4.5 7 4.6 7 6.6 7 8 9.4 8 12 8zm0 0c1.5-3.5 5-3.4 5-1.4C17 8 14.6 8 12 8z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/><path d="M10 10.5v6M14 10.5v6"/>',
    refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5"/><path d="M19.5 4.5v4.8h-4.8"/>',
    stack: '<ellipse cx="12" cy="6.5" rx="7.5" ry="2.8"/><path d="M4.5 6.5v5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-5"/>' +
      '<path d="M4.5 11.5v5c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-5"/>',
    withdraw: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4.5 14.5V19a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-4.5"/>',
    ball: '<circle cx="12" cy="12" r="8.5"/><path d="m12 8 3.3 2.4-1.3 3.9h-4l-1.3-3.9z"/>' +
      '<path d="M12 8V3.5M15.3 10.4l4.2-1.4M14 14.3l2.6 3.6M10 14.3l-2.6 3.6M8.7 10.4 4.5 9"/>',
    flame: '<path class="f" d="M12.5 2.5c.4 2.9 2.2 4.6 3.7 6.2 1.6 1.7 2.8 3.4 2.8 5.8A7 7 0 0 1 12 21.5a7 7 0 0 1-7-7' +
      'c0-2.6 1.3-4.4 2.9-5.6-.1 1.6.4 3 1.6 3.8-.2-3.9 1.2-7.4 3-10.2z"/>',
    sparkle: '<path class="f" d="m10 3.5 1.7 4.8 4.8 1.7-4.8 1.7L10 16.5l-1.7-4.8L3.5 10l4.8-1.7z"/>' +
      '<path class="f" d="m18 13.5.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
    heart: '<path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/>',
    chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
    chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
    chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
    phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6.5L20.5 7"/>',
    handset: '<path d="M5 4h3.5l1.8 4.5-2.3 1.6a12 12 0 0 0 6 6l1.6-2.3L20 15.5V19a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 3 6.2 2 2 0 0 1 5 4z"/>',
    bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
    receipt: '<path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 8.5h6M9 12h6M9 15.5h3.5"/>',
    bulb: '<path d="M9 17.5h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2v1.5h5V16c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
    logout: '<path d="M14.5 4.5h-8a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5h8"/><path d="M11 12h9.5M17 8.5l3.5 3.5-3.5 3.5"/>',
    history: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4.5v3.8h3.8"/><path d="M12 8v4.5l3 2"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.4 2.4 0 0 1 4.7.6c0 1.6-2.3 2-2.3 3.4"/><path d="M12 17h.01"/>',
    arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    chat: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7' +
      'A1.5 1.5 0 0 1 5 5.5z"/><path d="M8.5 11.2h.01M12 11.2h.01M15.5 11.2h.01"/>',
    slots: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M9.2 5v14M14.8 5v14"/>',
    live: '<circle class="f" cx="12" cy="12" r="2.2"/>' +
      '<path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"/>',
    crash: '<path d="m3.5 17 6-6 4 4 7-7"/><path d="M15 8h5.5v5.5"/>',
    crown: '<path d="m3.5 8 4.5 4 4-6.5 4 6.5 4.5-4-1.8 10.5H5.3z"/>',
    cards: '<rect x="4" y="3.5" width="11" height="15" rx="2"/><path d="M15 7h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-.5"/>',
    bolt: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/>' +
      '<rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    play: '<path class="f" d="M8 5.5v13l10.5-6.5z"/>',
    pause: '<path d="M9 6v12M15 6v12"/>',
    filters: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    wallet: '<path d="M4 7.5h14.5A1.5 1.5 0 0 1 20 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/>' +
      '<path d="M4 7.5v-1A1.5 1.5 0 0 1 5.5 5H16v2.5"/><path d="M16 13.7h.01"/>',
    share: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.6-3.8 3.8-5.8 7.5-5.8s6.9 2 7.5 5.8"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
    sound: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
    star: '<path d="m12 3.8 2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.4l-5.1 2.8L8 13.6 3.8 9.7l5.7-.7z"/>',
    chart: '<path d="M4 20h16"/><path d="M7 16.5v-5M12 16.5V7M17 16.5v-8"/>',
    trend: '<path d="m4 16.5 5.5-5.5 4 4L20 8.5"/><path d="M15 8.5h5v5"/>',
    users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3.3 2.8-5.2 5.5-5.2s4.9 1.9 5.5 5.2"/>' +
      '<path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.4 14.6c1.6.7 2.7 2.3 3.1 4.9"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.1 1.1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.1-1.1"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
    download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 15.5V19a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-3.5"/>',
    megaphone: '<path d="M4 10v4a1 1 0 0 0 1 1h2.5l7 4V5l-7 4H5a1 1 0 0 0-1 1z"/><path d="M8 15l1.2 4.5M18 9.5a3.5 3.5 0 0 1 0 5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>',
    tools: '<path d="M14.5 6.5a3.5 3.5 0 0 0 4.4 4.4l-7.7 7.7a2 2 0 0 1-2.8-2.8l7.7-7.7a3.5 3.5 0 0 0-1.6-1.6z"/><path d="m16 5 1.5-1.5 3 3L19 8"/>'
  };

  function icon(name, cls) {
    return '<svg class="ic' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      (ICONS[name] || "") + "</svg>";
  }

  /* ---------------- toasts ---------------- */
  function toast(message, kind) {
    let host = document.querySelector(".toast-host");
    if (!host) {
      host = document.createElement("div");
      host.className = "toast-host";
      host.setAttribute("role", "status");
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  /* ---------------- game cards ---------------- */
  /* one pill on the artwork: LIVE, NEW or HOT, when the game has it */
  function cardTag(game) {
    const t = ["LIVE", "NEW", "HOT"].find((x) => game.tags.includes(x));
    return t ? '<span class="card-tag tag-' + t.toLowerCase() + '">' + t + "</span>" : "";
  }

  /* what fills a game's tile: its picture when it has one (assets/img/thumbs), else its emoji on the hue backdrop */
  function thumbFace(game) {
    return game.thumb
      ? '<img class="thumb-img" src="' + game.thumb + '" alt="" loading="lazy" decoding="async">'
      : '<span class="thumb-emoji" aria-hidden="true">' + game.icon + "</span>";
  }

  function art(game, extra) {
    return '<span class="thumb' + (game.thumb ? " has-img" : "") + '" style="--h:' + game.hue + '">' + thumbFace(game) + (extra || "") + "</span>";
  }

  /* grid card — the heart sits beside the link, not inside it (a button nested in a link is invalid HTML) */
  function gameCard(game) {
    const card = document.createElement("div");
    card.className = "game-card";
    const on = favs.has(game.id);

    card.innerHTML =
      '<a class="game-link" href="game.html?game=' + encodeURIComponent(game.id) + '" aria-label="' +
      game.name + " — " + game.category + '">' +
      art(game, cardTag(game) + (game.players > 0 ? '<span class="players" title="Players in the last 15 minutes">' + icon("flame") + game.players + "</span>" : "")) +
      '<span class="game-title">' + game.name + "</span>" +
      "</a>" +
      '<button class="fav-btn' + (on ? " on" : "") + '" type="button" data-fav="' + game.id +
      '" aria-pressed="' + on + '" aria-label="Favourite ' + game.name + '">' + icon("heart") + "</button>";

    card.querySelector(".fav-btn").addEventListener("click", () => {
      const now = favs.toggle(game.id);
      toast(now ? game.name + " added to My Games" : game.name + " removed from My Games", now ? "ok" : "");
    });

    return card;
  }

  /* small square card with the title underneath — the "For You" row */
  function miniCard(game) {
    const a = document.createElement("a");
    a.className = "mini-card";
    a.href = "game.html?game=" + encodeURIComponent(game.id);
    a.innerHTML = art(game) + '<span class="mini-title">' + game.name + "</span>";
    return a;
  }

  /* ---------------- app shell ---------------- */
  const currentPage = () => (location.pathname.split("/").pop() || "index.html").toLowerCase();

  const TOP_LINKS = [
    { label: "Home", href: "index.html" },
    { label: "Casino", href: "games.html" },
    { label: "Promotions", href: "promotions.html" },
    { label: "Sports", href: "sports.html" },
    { label: "Wallet", href: "wallet.html" }
  ];

  const BOTTOM_LINKS = [
    { id: "home", label: "Home", icon: "home", href: "index.html" },
    { id: "promotion", label: "Promotion", icon: "gift", href: "promotions.html" },
    { id: "deposit", label: "Deposit", icon: "plus", href: "wallet.html" },
    { id: "sport", label: "Sport", icon: "ball", href: "sports.html" },
    { id: "me", label: "Me", icon: "user", href: "me.html" }
  ];

  const CATEGORY_TABS = [
    { id: "home", label: "Home", icon: "home", href: "index.html" },
    { id: "hot", label: "Hot", icon: "flame", href: "games.html?tag=hot" },
    { id: "live", label: "Live Casino", icon: "live", category: "Live Casino" },
    { id: "sports", label: "Sports", icon: "ball", href: "sports.html" },
    { id: "mine", label: "My Games", icon: "heart", href: "games.html?fav=1" },
    { id: "slots", label: "Slots", icon: "slots", category: "Slots" },
    { id: "jackpots", label: "Jackpots", icon: "crown", category: "Jackpots" },
    { id: "table", label: "Table", icon: "cards", category: "Table Games" },
    { id: "instant", label: "Instant", icon: "bolt", category: "Instant Win" },
    { id: "all", label: "All Games", icon: "grid", href: "games.html" }
  ];
  const tabHref = (t) => t.href || "games.html?category=" + encodeURIComponent(t.category);

  const CATEGORY_ICONS = {};
  CATEGORY_TABS.forEach((t) => {
    if (t.category) CATEGORY_ICONS[t.category] = t.icon;
  });

  /* customer care contact details (data.js → VB.contact): the email, the numbers to call, WhatsApp and the hours */
  const CONTACT = Object.assign({ email: "", phones: [], whatsapp: "", hours: "" }, global.VB.contact || {});
  const telHref = (n) => "tel:" + String(n).replace(/[^\d+]/g, "");
  /* "Email us at … or call …" — only the details that are filled in */
  const contactLine = () => {
    const parts = [];
    if (CONTACT.email) parts.push('email <a href="mailto:' + esc(CONTACT.email) + '">' + esc(CONTACT.email) + "</a>");
    if (CONTACT.phones.length) parts.push("call " + CONTACT.phones.map((p) => '<a href="' + telHref(p.number) + '">' + esc(p.number) + "</a>").join(" or "));
    if (CONTACT.whatsapp) parts.push('<a href="https://wa.me/' + esc(CONTACT.whatsapp.replace(/\D/g, "")) + '" target="_blank" rel="noopener">WhatsApp us</a>');
    if (!parts.length) return "";
    return "You can also " + parts.join(", ") + (CONTACT.hours ? " (" + esc(CONTACT.hours) + ")" : "") + ".";
  };

  const FAQ = [
    { q: "How do I deposit?",
      /* the live minimum deposit (Admin -> Betting & withdrawal settings) */
      get a() { return 'Open the <a href="wallet.html">wallet</a>, pick MTN MoMo, Telecel Cash, AirtelTigo Money, a bank transfer or a card, and enter ₵ ' + cedis(minDepositNow()) + ' or more. The deposit page shows the deposit, betting and withdrawal rules to accept first; see also the <a href="terms.html#money-rules">terms</a>.'; } },
    { q: "How fast are withdrawals?",
      a: 'Mobile money withdrawals are approved in about two minutes during business hours. The minimum is ₵ 20 — start from the <a href="withdraw.html">withdraw page</a>.' },
    { q: "Is this real money?",
      a: "Yes. Deposit via mobile money, bank or card, and your balance is available for play and withdrawal." },
    { q: "Responsible play",
      a: "Set a budget before you play and stop when you reach it. Gambling is entertainment, not income — if it stops being fun, take a break and contact a support service in your country." }
  ];

  /* the logo: the R emblem plus the WIN B CASINO wordmark (both SVG, in assets/img) */
  const brand = () =>
    '<a class="brand" href="index.html" aria-label="WIN B casino home">' +
    '<img class="brand-mark" src="assets/img/winb-mark.svg" alt="" width="32" height="32">' +
    '<img class="brand-word" src="assets/img/winb-wordmark.svg" alt="" width="125" height="18"></a>';

  /* Shows the wallet chip + Deposit CTA for signed-in users. */
  function headerActions() {
    if (!session.get()) {
      return '<a class="btn btn-accent btn-sm" href="register.html#login">Login</a>' +
        '<a class="btn btn-primary btn-sm" href="register.html">Register</a>';
    }
    return '<div class="account-switch">' +
      '<button class="balance-chip" type="button" data-account-menu aria-haspopup="true" aria-expanded="false" aria-controls="accountMenu">' +
      icon("wallet") + '<span class="sr-only">Account balance: </span>' +
      '<span data-account-balance>' + accounts.current().short + "</span>" + icon("chevronDown") + "</button>" +
      '<div class="account-menu" id="accountMenu" role="menu" hidden></div></div>' +
      '<a class="btn btn-primary btn-sm btn-deposit" href="wallet.html">Deposit</a>';
  }

  /* ---------------- changing currency: the whole balance moves with it ---------------- */
  /* Picking cedis or dollars in the header menu is a change of currency: everything in the other account is converted
     at the current rate (after a confirmation that shows the quote), and the chip then shows the new currency. Points
     are only a different view. Balances too small to convert (under ₵ 1 worth) just switch the view. */
  const primaryCode = () => (accounts.all().primary || {}).code || "GHS";
  const fiatHeld = (code) => (code === primaryCode() ? wallet.balance() : Number((accounts.all().others.find((o) => o.code === code) || {}).available) || 0);
  async function switchCurrency(code) {
    const target = code === "primary" ? primaryCode() : code;
    if (code === "points" || target === (accounts.shown() === "primary" ? primaryCode() : accounts.shown())) return accounts.show(code);
    const from = target === primaryCode() ? "USD" : primaryCode();
    const held = fiatHeld(from);
    const tooSmall = from === "USD" ? held < 0.1 : held < 1;
    if (!(held > 0) || tooSmall) return accounts.show(code);
    const q = await paymentApi("/api/user/convert/quote?from=" + from + "&to=" + target + "&amount=" + encodeURIComponent(held));
    if (!q.ok) { toast(q.data && q.data.message || "Couldn't get today's rate — try again in a moment.", "err"); return; }
    const money2 = (n, c) => (c === "USD" ? "$ " : "₵ ") + Number(n || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const el = document.createElement("div");
    el.className = "me-sheet";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "switchTitle");
    el.innerHTML =
      '<div class="me-sheet-panel"><div class="me-sheet-grip" aria-hidden="true"></div>' +
      '<div class="me-sheet-head"><h2 id="switchTitle">Switch to ' + (target === "USD" ? "US dollars" : "cedis") + "?</h2>" +
      '<button class="me-sheet-close" type="button" aria-label="Close">' + icon("close") + "</button></div>" +
      '<div class="convert-quote"><p class="convert-receive">' + money2(held, from) + " becomes <b>" + money2(q.data.receive, target) + "</b></p>" +
      '<p class="dim">1 ' + esc(from) + " = " + Number(q.data.rate).toLocaleString("en-GH", { maximumFractionDigits: 4 }) + " " + esc(target) + " · includes " + (Number(q.data.spread) * 100).toFixed(1).replace(/\.0$/, "") + "% spread</p></div>" +
      '<p class="convert-note">Your whole balance is converted and the header shows ' + (target === "USD" ? "dollars" : "cedis") + ". " +
      (target === "USD" ? "Games, deposits and withdrawals are in cedis, so switch back before you play. " : "") + "A conversion can\'t be undone.</p>" +
      '<div class="switch-actions"><button class="btn btn-ghost btn-lg" type="button" data-close>Keep ' + (from === "USD" ? "dollars" : "cedis") + '</button>' +
      '<button class="btn btn-primary btn-lg" type="button" data-switch-go>Convert &amp; switch</button></div></div>';
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    const closeIt = () => { el.classList.remove("show"); setTimeout(() => el.remove(), 220); document.removeEventListener("keydown", onKey); };
    const onKey = (ev) => { if (ev.key === "Escape") closeIt(); };
    document.addEventListener("keydown", onKey);
    el.addEventListener("click", async (ev) => {
      if (ev.target === el || ev.target.closest(".me-sheet-close") || ev.target.closest("[data-close]")) return closeIt();
      const go = ev.target.closest("[data-switch-go]");
      if (!go) return;
      go.disabled = true;
      go.textContent = "Converting…";
      const r = await paymentApi("/api/user/convert", { body: { from, to: target, amount: held, idempotency_key: "sw:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) } });
      if (!r.ok) {
        go.disabled = false; go.textContent = "Convert & switch";
        toast(r.data && r.data.message || "The conversion didn\'t go through — try again.", "err");
        return;
      }
      wallet.setBalance(Number(r.data.primary.available) || 0);
      accounts.save(r.data);
      accounts.show(code);
      closeIt();
      toast("Switched to " + (target === "USD" ? "US dollars" : "cedis") + ": " + money2(r.data.quote.receive, target) + ".");
    });
  }
  /* games ask this when a stake can't be covered: the dollars the player holds, if their cedi account is empty */
  const moneyInDollars = () => (wallet.balance() < 0.1 ? fiatHeld("USD") : 0);

  /* ---------------- Convert: move money between the player's own accounts at the current rate ---------------- */
  /* cedis ↔ US dollars. The server quotes at the live exchange rate less its spread and the conversion executes at
     that quote; both balances come back updated. */
  const CONVERTIBLE = ["GHS", "USD"];
  let convertSheet = null;
  function openConvert(preset) {
    if (!session.get()) return (location.href = "register.html#login");
    if (convertSheet) convertSheet.close(true);
    const a = accounts.all();
    const held = (code) => (code === (a.primary ? a.primary.code : "GHS") ? wallet.balance() : (a.others.find((o) => o.code === code) || {}).available || 0);
    const label = (code) => (code === "GHS" ? "Ghanaian Cedi (GHS)" : code === "USD" ? "US Dollar (USD)" : ((a.others.find((o) => o.code === code) || {}).name || code) + " (" + code + ")");
    const options = (sel) => CONVERTIBLE.map((c) => '<option value="' + c + '"' + (c === sel ? " selected" : "") + ">" + esc(label(c)) + "</option>").join("");
    const from = preset && preset.from || "GHS";
    const to = preset && preset.to || (from === "GHS" ? "USD" : "GHS");
    const el = document.createElement("div");
    el.className = "me-sheet";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "convertTitle");
    el.innerHTML =
      '<div class="me-sheet-panel"><div class="me-sheet-grip" aria-hidden="true"></div>' +
      '<div class="me-sheet-head"><h2 id="convertTitle">Convert</h2><button class="me-sheet-close" type="button" aria-label="Close">' + icon("close") + "</button></div>" +
      '<form class="convert-form" autocomplete="off">' +
      '<label class="convert-field"><span>From</span><select id="cvFrom">' + options(from) + "</select><small id=\"cvHeld\"></small></label>" +
      '<button class="convert-swap" type="button" aria-label="Swap accounts">' + icon("chevronDown") + "</button>" +
      '<label class="convert-field"><span>To</span><select id="cvTo">' + options(to) + "</select></label>" +
      '<label class="convert-field"><span>Amount</span><div class="convert-amount"><input id="cvAmount" type="number" inputmode="decimal" min="0" step="any" placeholder="0.00"><button type="button" id="cvMax">Max</button></div></label>' +
      '<div class="convert-quote" id="cvQuote" aria-live="polite"><p class="dim">Enter an amount to see the rate.</p></div>' +
      '<button class="btn btn-primary btn-lg convert-go" type="submit" id="cvGo" disabled>Convert</button>' +
      '<p class="convert-note">Rates come from the market price less a small spread and are refreshed each minute. A conversion can\'t be undone.</p>' +
      "</form></div>";
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    const $ = (id) => el.querySelector("#" + id);
    const fromSel = $("cvFrom"), toSel = $("cvTo"), amount = $("cvAmount"), quoteBox = $("cvQuote"), go = $("cvGo");
    const fmtAmt = (n, code) => Number(n || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: code === "GHS" || code === "USD" ? 2 : 8 });
    let quote = null, timer = 0, seq = 0;
    const paintHeld = () => { $("cvHeld").textContent = "You have " + fmtAmt(held(fromSel.value), fromSel.value) + " " + fromSel.value; };
    const getQuote = () => {
      clearTimeout(timer);
      quote = null;
      go.disabled = true;
      const amt = Number(amount.value);
      if (!(amt > 0)) { quoteBox.innerHTML = '<p class="dim">Enter an amount to see the rate.</p>'; return; }
      if (fromSel.value === toSel.value) { quoteBox.innerHTML = '<p class="err">Choose two different accounts.</p>'; return; }
      quoteBox.innerHTML = '<p class="dim">Getting the rate…</p>';
      const mine = ++seq;
      timer = setTimeout(async () => {
        const r = await paymentApi("/api/user/convert/quote?from=" + fromSel.value + "&to=" + toSel.value + "&amount=" + encodeURIComponent(amt));
        if (mine !== seq) return;
        if (!r.ok) { quoteBox.innerHTML = '<p class="err">' + esc(r.data && r.data.message || "Couldn\'t get a rate right now.") + "</p>"; return; }
        quote = r.data;
        quoteBox.innerHTML = '<p class="convert-receive">You get <b>' + fmtAmt(quote.receive, quote.to) + " " + esc(quote.to) + "</b></p>" +
          '<p class="dim">1 ' + esc(quote.from) + " = " + fmtAmt(quote.rate, quote.to) + " " + esc(quote.to) + " · includes " + (Number(quote.spread) * 100).toFixed(1).replace(/\.0$/, "") + "% spread" + (quote.source === "snapshot" ? " · last known price" : "") + "</p>";
        go.disabled = amt > held(fromSel.value) + 1e-9;
        if (go.disabled) quoteBox.insertAdjacentHTML("beforeend", '<p class="err">That\'s more than you have in that account.</p>');
      }, 350);
    };
    fromSel.addEventListener("change", () => { paintHeld(); getQuote(); });
    toSel.addEventListener("change", getQuote);
    amount.addEventListener("input", getQuote);
    $("cvMax").addEventListener("click", () => { amount.value = held(fromSel.value); getQuote(); });
    el.querySelector(".convert-swap").addEventListener("click", () => {
      const f = fromSel.value; fromSel.value = toSel.value; toSel.value = f;
      amount.value = ""; paintHeld(); getQuote();
    });
    el.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!quote || go.disabled) return;
      go.disabled = true;
      go.textContent = "Converting…";
      const r = await paymentApi("/api/user/convert", { body: { from: quote.from, to: quote.to, amount: quote.amount, idempotency_key: "cv:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10) } });
      if (!r.ok) {
        go.disabled = false; go.textContent = "Convert";
        quoteBox.innerHTML = '<p class="err">' + esc(r.data && r.data.message || "The conversion didn\'t go through — try again.") + "</p>";
        return;
      }
      wallet.setBalance(Number(r.data.primary.available) || 0);
      accounts.save(r.data);
      quoteBox.innerHTML = '<p class="convert-receive">Done — <b>' + fmtAmt(r.data.quote.receive, r.data.quote.to) + " " + esc(r.data.quote.to) + "</b> added to your " + esc(label(r.data.quote.to)) + " account.</p>";
      go.textContent = "Convert more";
      go.disabled = false;
      amount.value = ""; quote = null; paintHeld();
      go.onclick = (ev) => { if (go.textContent === "Convert more") { ev.preventDefault(); go.textContent = "Convert"; go.disabled = true; quoteBox.innerHTML = '<p class="dim">Enter an amount to see the rate.</p>'; go.onclick = null; } };
      toast("Converted to " + r.data.quote.to + ".");
    });
    const onKey = (ev) => { if (ev.key === "Escape") api.close(); };
    const api = { close(instant) { document.removeEventListener("keydown", onKey); el.classList.remove("show"); setTimeout(() => el.remove(), instant ? 0 : 220); if (convertSheet === api) convertSheet = null; } };
    el.addEventListener("click", (ev) => { if (ev.target === el || ev.target.closest(".me-sheet-close")) api.close(); });
    document.addEventListener("keydown", onKey);
    convertSheet = api;
    paintHeld();
    if (preset && preset.amount) { amount.value = preset.amount; getQuote(); }
    amount.focus({ preventScroll: true });
    return api;
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-open-convert]");
    if (b) { e.preventDefault(); openConvert({ from: b.dataset.openConvert || undefined }); }
  });

  /* set at log-in when the account is a partner's (register.js) */
  const isPartner = () => { try { return sessionStorage.getItem("vb.partner") === "1"; } catch (e) { return false; } };

  /* the account menu under the chip: every account with its balance; the chosen one is what the chip shows */
  function bindAccountMenu(root) {
    const btn = root.querySelector("[data-account-menu]");
    const menu = root.querySelector("#accountMenu");
    if (!btn || !menu) return;
    const paint = () => {
      const shown = accounts.shown();
      menu.innerHTML = '<div class="account-menu-head">Accounts</div>' +
        accounts.list().map((a) =>
          '<button type="button" role="menuitemradio" aria-checked="' + (a.code === shown) + '" data-account="' + esc(a.code) + '">' +
          '<i class="account-sym">' + esc(a.symbol) + "</i><span><b>" + esc(a.label) + "</b><small>" + esc(a.sub) + "</small></span><em>" + esc(a.short) + "</em></button>").join("") +
        '<div class="account-menu-foot"><button type="button" data-convert>Convert</button><a href="wallet.html">Deposit &amp; withdraw</a>' +
        (isPartner() ? '<a href="partners.html">Partner dashboard</a>' : "") + "</div>";
    };
    const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
    btn.addEventListener("click", () => {
      if (!menu.hidden) return close();
      paint();
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
    });
    menu.addEventListener("click", (e) => {
      if (e.target.closest("[data-convert]")) { close(); return openConvert(); }
      const b = e.target.closest("[data-account]");
      if (!b) return;
      close();
      switchCurrency(b.dataset.account);
    });
    document.addEventListener("click", (e) => { if (!root.contains(e.target)) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  }

  function renderHeader(el) {
    el.innerHTML =
      '<div class="container header-inner">' + brand() +
      '<nav class="top-nav" aria-label="Main">' +
      TOP_LINKS.map((l) => '<a href="' + l.href + '" data-page="' + l.href + '">' + l.label + "</a>").join("") +
      "</nav>" +
      '<div class="header-actions">' + headerActions() + "</div>" +
      "</div>";
    bindAccountMenu(el);
  }

  /* a category gets a tab only while the lobby has games in it, so no tab opens an empty page */
  const hasGames = (category) => global.VB.games.some((g) => g.category === category);

  function renderCategories(el) {
    el.innerHTML =
      '<div class="container"><div class="cat-scroll">' +
      CATEGORY_TABS.filter((t) => !t.category || hasGames(t.category)).map((t) =>
        '<a class="cat-tab cat-' + t.id + '" href="' + tabHref(t) + '" data-cat="' + t.id + '">' +
        icon(t.icon) + "<span>" + t.label + "</span></a>").join("") +
      "</div></div>";
  }

  function renderBottomNav() {
    const nav = document.createElement("nav");
    nav.className = "bottom-nav";
    nav.setAttribute("aria-label", "Quick links");
    nav.innerHTML = BOTTOM_LINKS.map((l) =>
      '<a class="bn-item' + (l.id === "deposit" ? " bn-deposit" : "") + '" href="' + l.href + '" data-bn="' + l.id + '">' +
      (l.id === "deposit" ? '<span class="bn-fab">' + icon(l.icon) + "</span>" : icon(l.icon)) +
      "<span>" + l.label + "</span></a>").join("");
    document.body.appendChild(nav);
  }

  function renderFooter(el) {
    const s = session.get();
    el.innerHTML =
      '<div class="container">' +
      '<div class="footer-grid">' +
      '<div class="footer-brand">' + brand() +
      "<p>An independent online casino lobby built for players in Ghana, with mobile money at the centre of the experience.</p>" +
      '<span class="age-badge">18+ · Play responsibly</span></div>' +
      "<div><h4>Casino</h4><ul>" +
      '<li><a href="games.html">All games</a></li><li><a href="games.html?tag=hot">Hot games</a></li>' +
      '<li><a href="games.html?category=Live%20Casino">Live casino</a></li><li><a href="games.html?category=Instant%20Win">Instant games</a></li></ul></div>' +
      "<div><h4>Account</h4><ul>" +
      (s
        ? (testMode ? '<li><a href="wallet.html">Wallet</a></li>' : '') +
          '<li><button class="link-btn" type="button" data-logout>Log out</button></li>'
        : '<li><a href="register.html#login">Log in</a></li><li><a href="register.html">Register</a></li>') +
      (testMode
        ? '<li><a href="wallet.html">Deposit</a></li><li><a href="withdraw.html">Withdraw</a></li>'
        : '') +
      '<li><a href="promotions.html">Promotions</a></li></ul></div>' +
      "<div><h4>Customer care</h4><ul>" +
      '<li><a href="support.html">Help &amp; contact</a></li>' +
      '<li><button class="link-btn" type="button" data-open-chat>Live chat</button></li>' +
      (CONTACT.email ? '<li><a href="mailto:' + esc(CONTACT.email) + '">' + esc(CONTACT.email) + "</a></li>" : "") +
      CONTACT.phones.map((ph) => '<li><a href="' + telHref(ph.number) + '">Call ' + esc(ph.number) + "</a></li>").join("") +
      '<li><button class="link-btn" type="button" data-open-chat="3">Responsible play</button></li>' +
      '<li><a href="terms.html">Terms of use</a></li><li><a href="privacy.html">Privacy policy</a></li></ul></div>' +
      "</div>" +
      '<p class="disclaimer">WIN B casino is for adults 18 and over. Gambling involves risk — if you ' +
      "or someone you know is affected, contact a support service in your country.</p>" +
      '<div class="footer-bottom"><span>© ' + new Date().getFullYear() + " WIN B casino. Play responsibly, 18+.</span>" +
      '<span class="footer-legal"><a href="terms.html">Terms</a><a href="privacy.html">Privacy</a></span>' +
      (s ? "<span>Signed in as " + esc(s.name || s.phone) + "</span>" : "") + "</div>" +
      "</div>";
  }

  /* live chat: a floating button above the bottom nav. A signed-in player's messages go to the WIN B casino team (admin
     dashboard → Support) and the team's replies come back here; the quick-answer topics stay instant. Signed out,
     it's an automated assistant. Full-screen games skip the floating button and open the chat from their own header. */
  const chat = { open() {} };

  function renderChat(withButton) {
    let fab = null;
    if (withButton) {
      fab = document.createElement("button");
      fab.className = "chat-fab";
      fab.type = "button";
      fab.setAttribute("aria-label", "Live chat");
      fab.setAttribute("aria-controls", "chatSheet");
      fab.setAttribute("aria-expanded", "false");
      fab.innerHTML = icon("chat");
    }

    const sheet = document.createElement("section");
    sheet.className = "chat-sheet";
    sheet.id = "chatSheet";
    sheet.hidden = true;
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-labelledby", "chatTitle");
    sheet.innerHTML =
      '<div class="chat-head"><span class="chat-avatar">' + icon("chat") + "</span>" +
      '<div class="chat-who"><strong id="chatTitle">Customer service</strong><span id="chatSub"><i class="chat-dot"></i>Automated assistant · 24/7</span></div>' +
      '<button class="chat-close" type="button" aria-label="Close chat">' + icon("close") + "</button></div>" +
      '<div class="chat-log" aria-live="polite"></div>' +
      '<div class="chat-replies">' +
      FAQ.map((f, i) => '<button class="chip" type="button" data-faq="' + i + '">' + f.q + "</button>").join("") +
      "</div>" +
      '<form class="chat-form" autocomplete="off">' +
      '<label class="sr-only" for="chatInput">Type your question</label>' +
      '<input id="chatInput" class="chat-input" type="text" maxlength="200" placeholder="Type your question…">' +
      '<button class="chat-send" type="submit" aria-label="Send">' + icon("chevronRight") + "</button></form>";
    if (fab) document.body.append(fab);
    document.body.append(sheet);

    const log = sheet.querySelector(".chat-log");
    const say = (who, html) => {
      log.insertAdjacentHTML("beforeend", '<p class="bubble ' + who + '">' + html + "</p>");
      log.scrollTop = log.scrollHeight;
    };
    const answer = (i) => {
      say("me", esc(FAQ[i].q));
      say("bot", FAQ[i].a);
    };

    /* typed questions: matched by keywords; anything unknown gets an honest "not sure" with topics to try */
    const REPLIES = [
      [/\b(hi|hello|hey|good (morning|afternoon|evening))\b/i,
        "Hello 👋 I can help with deposits, withdrawals, bonuses and your account. What do you need?"],
      [/thank/i, "You're welcome! Anything else I can help with?"],
      [/withdraw|cash ?out|payout|pay out/i,
        'Withdrawals go to the mobile money number you registered with. The minimum is ₵ 20 — start from the <a href="withdraw.html">Withdraw</a> page. Requests show as pending in <a href="transactions.html">Transaction records</a> until they are paid out.'],
      [/(not|n't) (reflect|show|appear|credit|receiv)|deducted|missing|where is my|still pending|pending/i,
        'Open the <a href="wallet.html">Deposit</a> page — your recent deposits are listed there, and each visit asks TheTeller again about any still pending, crediting it as soon as it\'s confirmed. Keep the reference number shown for that deposit; it\'s how a payment is traced.'],
      [/fail|declin|denied|error|not approved|unsuccessful/i,
        'A failed deposit never takes money. The reason from our payment partner is shown under it on the <a href="wallet.html">Deposit</a> page. Check your wallet balance and that you approved the PIN prompt, then try again.'],
      [/deposit|top ?up|fund|add money|momo|mobile money|pay in/i,
        () => 'Go to <a href="wallet.html">Deposit</a>, enter ₵ ' + cedis(minDepositNow()) + ' or more and tap Top Up Now. A payment prompt is sent to your registered number — approve it with your MoMo PIN. MTN users without a prompt can dial *170#, then 6 and 3.'],
      [/\bpin\b|otp|password|hack|scam|someone (called|asked)/i,
        'Never share your MoMo PIN, an OTP or your password with anyone — WIN B casino will never ask for them. To change a forgotten password, use “Forgot password” on the <a href="register.html#login">log-in page</a>.'],
      [/bonus|promo|cashback|cash back|reward|free spin|offer/i,
        'Cashback, VIP perks and a welcome bonus are coming soon but aren\'t live yet, so no bonus is paid on deposits for now. See what\'s planned on the <a href="promotions.html">Promotions</a> page.'],
      [/limit|minimum|maximum|\bmin\b|\bmax\b|how much/i,
        () => "Deposits: ₵ " + cedis(minDepositNow()) + " to ₵ 50,000 per transaction. Withdrawals: from ₵ 20, paid to your registered number."],
      [/addict|stop gambling|self.?exclu|responsib|too much|problem/i, FAQ[3].a],
      [/human|agent|person|call (you|me)|phone number|email|talk to|contact|customer care|whatsapp/i,
        'To message our team, <a href="register.html#login">log in</a> — then write here and a member of our team will reply in this chat. ' +
        (contactLine() || 'Our contact details are on the <a href="support.html">Customer care</a> page.')],
      [/real money|is this real|legit/i, FAQ[2].a]
    ];
    const reply = (text) => {
      const hit = REPLIES.find(([re]) => re.test(text));
      return hit ? (typeof hit[1] === "function" ? hit[1]() : hit[1]) :
        "I'm not sure about that one. Try asking about deposits, withdrawals, bonuses or your account — or pick a topic below.";
    };
    const form = sheet.querySelector(".chat-form");
    const input = sheet.querySelector(".chat-input");
    const text2html = (t) => esc(t).replace(/\n/g, "<br>");

    /* ---------- live support (signed in): messages to and from the WIN B casino team ---------- */
    const live = { loaded: false, lastId: 0, timer: 0, noted: false, shown: new Set() };
    const note = (text) => {
      log.insertAdjacentHTML("beforeend", '<p class="chat-note">' + text + "</p>");
      log.scrollTop = log.scrollHeight;
    };
    function showMessage(m) {
      if (live.shown.has(m.id)) return; /* a poll and a send can both return the same message */
      live.shown.add(m.id);
      live.lastId = Math.max(live.lastId, m.id);
      if (m.from === "you") say("me", text2html(m.body));
      else say("agent", '<b class="bubble-who">WIN B casino Support</b>' + text2html(m.body));
    }
    function setUnread(n) {
      if (!fab) return;
      fab.classList.toggle("has-unread", n > 0);
      fab.setAttribute("aria-label", n > 0 ? "Live chat — new reply from our team" : "Live chat");
    }
    async function loadLive() {
      const r = await paymentApi("/api/support/thread" + (live.lastId ? "?after=" + live.lastId : ""));
      if (!r.ok || !r.data) return;
      if (!live.loaded) {
        live.loaded = true;
        if (r.data.messages.length) note("Your conversation with our team");
      }
      r.data.messages.forEach(showMessage);
      setUnread(0); /* fetching the conversation marks the team's replies as seen */
    }
    async function checkUnread() {
      if (!session.get() || !sheet.hidden) return;
      const r = await paymentApi("/api/support/unread");
      if (r.ok && r.data) setUnread(r.data.unread);
    }
    if (session.get() && fab) {
      checkUnread();
      setInterval(checkUnread, 60000);
    }

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      if (session.get()) {
        input.disabled = true;
        const r = await paymentApi("/api/support/messages", { body: { body: text } });
        input.disabled = false;
        input.focus({ preventScroll: true });
        if (!r.ok) {
          input.value = text; /* nothing lost: they can send it again */
          say("bot", esc((r.data && r.data.message) || "Couldn't send that — check your connection and try again."));
          return;
        }
        showMessage(r.data.message);
        if (!live.noted) {
          live.noted = true;
          note("Sent to our team — we'll reply right here. If you close the chat, a dot on the chat button shows when we have.");
        }
        return;
      }
      say("me", esc(text));
      log.insertAdjacentHTML("beforeend", '<p class="bubble bot typing" aria-label="Typing"><i></i><i></i><i></i></p>');
      log.scrollTop = log.scrollHeight;
      setTimeout(() => {
        const dots = log.querySelector(".typing");
        if (dots) dots.remove();
        say("bot", reply(text));
      }, 550 + Math.min(900, text.length * 12));
    });
    const setOpen = (open) => {
      sheet.hidden = !open;
      if (fab) {
        fab.setAttribute("aria-expanded", String(open));
        fab.classList.toggle("open", open);
      }
      const signedIn = !!session.get();
      sheet.querySelector("#chatSub").innerHTML = '<i class="chat-dot"></i>' + (signedIn ? "Our team replies here" : "Automated assistant · log in to reach our team");
      input.placeholder = signedIn ? "Write to our team…" : "Type your question…";
      input.maxLength = signedIn ? 1000 : 200;
      if (open && !log.childElementCount) {
        say("bot", signedIn
          ? "Hi 👋 Write to us here and a member of our team will reply in this chat. For instant answers, pick a topic below. " + contactLine()
          : 'Hi 👋 I\'m WIN B casino\'s automated assistant. Type a question or pick a topic below. To message our team, <a href="register.html#login">log in</a>. ' + contactLine());
      }
      clearInterval(live.timer);
      if (open && signedIn) {
        loadLive();
        live.timer = setInterval(() => { if (!sheet.hidden) loadLive(); }, 5000); /* the team's replies, while it's open */
      }
    };

    let opener = null; /* whatever opened the chat gets focus back when it closes */
    chat.open = (topic) => {
      moneyRules(); /* the live minimum deposit for the answers below (cached for the next ones) */
      if (sheet.hidden) opener = document.activeElement;
      setOpen(true);
      if (topic !== undefined && FAQ[topic]) answer(topic);
      sheet.querySelector(".chat-input").focus({ preventScroll: true });
    };
    const close = () => {
      setOpen(false);
      const back = fab || opener;
      if (back && back.focus) back.focus();
    };

    if (fab) fab.addEventListener("click", () => (sheet.hidden ? chat.open() : close()));
    sheet.querySelector(".chat-close").addEventListener("click", close);
    sheet.addEventListener("click", (e) => {
      const b = e.target.closest("[data-faq]");
      if (b) answer(Number(b.dataset.faq));
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !sheet.hidden) close();
    });
  }

  /* which category tab matches this URL — null when none does */
  function currentTab() {
    const here = currentPage();
    if (here === "index.html") return "home";
    if (here === "sports.html") return "sports";
    if (here !== "games.html") return null;
    const p = new URLSearchParams(location.search);
    if (p.get("fav") === "1") return "mine";
    const tag = (p.get("tag") || "").toLowerCase();
    if (tag) return tag === "hot" ? "hot" : null;
    /* crash games are listed under Live Casino; old ?category=Crash links still land there */
    const cat = (p.get("category") || "").toLowerCase().replace(/^crash$/, "live casino");
    if (!cat) return "all";
    const tab = CATEGORY_TABS.find((t) => t.category && t.category.toLowerCase() === cat);
    return tab ? tab.id : null;
  }

  /* marks the current page in the top nav, bottom nav and category bar */
  function markActiveNav() {
    const here = currentPage();
    const set = (a, on) => (on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current"));

    const top = here === "game.html" ? "games.html" : here;
    document.querySelectorAll(".top-nav a").forEach((a) => set(a, a.dataset.page === top));

    const bottom =
      here === "wallet.html" ? "deposit" :
      ["me.html", "transactions.html", "withdraw.html"].includes(here) ? "me" :
      here === "promotions.html" ? "promotion" :
      here === "sports.html" ? "sport" :
      ["index.html", "games.html", "game.html"].includes(here) ? "home" : null;
    document.querySelectorAll(".bn-item").forEach((a) => set(a, a.dataset.bn === bottom));

    const tab = currentTab();
    document.querySelectorAll(".cat-tab").forEach((a) => {
      set(a, a.dataset.cat === tab);
      /* bring the active tab into view if it sits off the edge of the scroller */
      if (a.dataset.cat !== tab) return;
      const bar = a.parentElement;
      if (a.offsetLeft < bar.scrollLeft || a.offsetLeft + a.offsetWidth > bar.scrollLeft + bar.clientWidth) {
        bar.scrollLeft = a.offsetLeft - (bar.clientWidth - a.offsetWidth) / 2;
      }
    });
  }

  function refreshSession() {
    document.querySelectorAll(".header-actions").forEach((el) => (el.innerHTML = headerActions()));
    document.querySelectorAll('[data-shell="footer"]').forEach(renderFooter);
    wallet.paint();
  }

  let shellReady = false;
  function initShell() {
    if (shellReady) return;
    shellReady = true;

    document.querySelectorAll('[data-shell="header"]').forEach(renderHeader);
    document.querySelectorAll('[data-shell="categories"]').forEach(renderCategories);
    document.querySelectorAll('[data-shell="footer"]').forEach(renderFooter);
    /* <body data-shell="game"> is a full-screen game: no bottom nav, and chat opens from the game's header */
    const gameScreen = document.body.dataset.shell === "game";
    if (!gameScreen) renderBottomNav();
    /* the admin dashboard answers chats from its Support tab; its own chat button would write to the team as a player */
    if (!document.body.classList.contains("adm-body")) renderChat(!gameScreen);

    /* <i data-icon="search"></i> in page markup becomes the inline SVG */
    document.querySelectorAll("[data-icon]").forEach((el) => {
      el.insertAdjacentHTML("beforebegin", icon(el.dataset.icon, el.className));
      el.remove();
    });

    markActiveNav();
    wallet.paint();
    checkSession();
    streak.touch();

    document.addEventListener("vb:session", refreshSession);
    document.addEventListener("click", (e) => {
      const opener = e.target.closest("[data-open-chat]");
      if (opener) chat.open(opener.dataset.openChat ? Number(opener.dataset.openChat) : undefined);
      if (e.target.closest("[data-logout]")) {
        session.logout();
        toast("You have been logged out");
      }
    });

    /* another tab may have deposited, played or signed in since this page loaded */
    window.addEventListener("storage", (e) => {
      if (e.key === KEY || e.key === null) wallet.paint();
      if (e.key === SESSION || e.key === null) refreshSession();
    });
  }

  /* ---------------- countdown ---------------- */
  function countdown(el, targetTime) {
    function tick() {
      const diff = Math.max(0, targetTime - Date.now());
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      const pad = (n) => String(n).padStart(2, "0");
      el.innerHTML =
        '<div class="cd-box"><b>' + pad(d) + "</b><span>days</span></div>" +
        '<div class="cd-box"><b>' + pad(h) + "</b><span>hrs</span></div>" +
        '<div class="cd-box"><b>' + pad(m) + "</b><span>min</span></div>" +
        '<div class="cd-box"><b>' + pad(s) + "</b><span>sec</span></div>";
    }
    tick();
    setInterval(tick, 1000);
  }

  /* end of this Sunday 23:59 local time (today, if it is Sunday) */
  function nextSundayEnd() {
    const now = new Date();
    const end = new Date(now);
    end.setDate(now.getDate() + ((7 - now.getDay()) % 7));
    end.setHours(23, 59, 0, 0);
    if (end <= now) end.setDate(end.getDate() + 7);
    return end.getTime();
  }

  /* the legal pages' "[contact email to be added]" placeholders, once an email is set in data.js */
  document.querySelectorAll("[data-contact]").forEach((el) => {
    if (CONTACT.email) el.innerHTML = '<a href="mailto:' + esc(CONTACT.email) + '">' + esc(CONTACT.email) + "</a>";
  });

  /* ---------------- per-game switches from Admin -> Games: free play and the big-wins showcase ---------------- */
  /* The server's public catalogue (GET /api/games/visibility) lists, by lobby id AND server id, the games whose free
     play an admin turned off and the games showing real big wins. The last answer is kept with the hidden games, so a
     page can decide at once; the fresh answer follows and wins. Neither switch has anything to do with how results are
     drawn — free play uses the same odds as real money. */
  const CATALOG_KEY = "vb.catalog.hidden";
  let catalogFetch = null;
  function catalogNow() {
    const h = read(CATALOG_KEY, null) || {};
    return { freePlayOff: Array.isArray(h.free_play_off) ? h.free_play_off : [], showcase: Array.isArray(h.showcase) ? h.showcase : [] };
  }
  function catalogFresh() {
    if (!catalogFetch) {
      catalogFetch = paymentApi("/api/games/visibility", { timeout: 15000 }).then((r) => {
        if (r.ok && r.data && Array.isArray(r.data.games)) {
          write(CATALOG_KEY, {
            games: r.data.games, providers: r.data.providers || [],
            free_play_off: r.data.free_play_off || [], showcase: r.data.showcase || []
          });
        }
        return catalogNow();
      }).catch(() => catalogNow());
    }
    return catalogFetch;
  }

  /* Real activity, in place of made-up players: per game, the latest settled bets, biggest wins and players now
     (GET /api/games/feed/:id); for the site, players per game and the latest wins (GET /api/games/activity, kept for
     the lobby cards' next draw). Players are shown by a masked number only. */
  const activity = {
    site() {
      return paymentApi("/api/games/activity", { timeout: 15000 }).then((r) => {
        if (!r.ok || !r.data || !r.data.playing) return null;
        write("vb.live.activity", { playing: r.data.playing, at: Date.now() });
        return r.data;
      }).catch(() => null);
    },
    game(id) {
      return paymentApi("/api/games/feed/" + encodeURIComponent(id), { timeout: 15000 })
        .then((r) => (r.ok && r.data && Array.isArray(r.data.recent) ? r.data : null)).catch(() => null);
    }
  };

  /* Free play off for this game: the Credits choice goes away. A signed-in player moves to their wallet (the page
     reloads with ?mode=real); someone signed out is asked to sign in. ids: the page's lobby and/or server id. */
  const freePlay = {
    ready: () => catalogFresh(),
    allowed(ids) {
      const off = catalogNow().freePlayOff;
      return ![].concat(ids).some((id) => off.includes(id));
    },
    /* opts.mode: the page's current mode ("fun" / "real"); opts.canReal: real money is possible here (signed in) */
    enforce(ids, opts) {
      /* the last answer decides at once, but only in ways the fresh one can undo (the gate, the hidden Credits);
         moving a player to the wallet waits for the fresh answer */
      const apply = (fresh) => {
        const on = freePlay.allowed(ids);
        document.documentElement.classList.toggle("vb-no-free-play", !on);
        const gate = document.getElementById("vbFreeGate");
        if (on) {
          if (gate) gate.remove();
          return;
        }
        if (opts.mode !== "fun") return;
        if (!opts.canReal) showFreePlayGate();
        else if (fresh) {
          const url = new URL(location.href);
          url.searchParams.set("mode", "real");
          location.replace(url.href);
        }
      };
      apply(false);
      catalogFresh().then(() => apply(true));
    }
  };
  function showFreePlayGate() {
    if (document.getElementById("vbFreeGate")) return;
    const gate = document.createElement("div");
    gate.className = "vb-free-gate";
    gate.id = "vbFreeGate";
    gate.setAttribute("role", "dialog");
    gate.setAttribute("aria-modal", "true");
    gate.setAttribute("aria-labelledby", "vbFreeGateTitle");
    gate.innerHTML =
      '<div class="vb-free-gate-card">' +
        '<span class="vb-free-gate-ico">' + icon("user") + "</span>" +
        '<h2 id="vbFreeGateTitle">Sign in to play</h2>' +
        "<p>Free play isn't available on this game right now. Sign in to play with your wallet.</p>" +
        '<a class="btn btn-primary btn-block" href="register.html#login">Sign in</a>' +
        '<a class="btn btn-ghost btn-block" href="register.html#register">Create an account</a>' +
        '<a class="vb-free-gate-back" href="games.html">Back to the lobby</a>' +
      "</div>";
    document.body.appendChild(gate);
    const first = gate.querySelector("a");
    if (first) first.focus();
  }

  /* The big-wins strip: under the page header, the highest multipliers players really won on this game in the last
     7 days (masked numbers), when the admin has switched the showcase on. Nothing is shown when there are none. */
  const showcase = {
    mount(lobbyId, opts) {
      opts = opts || {};
      catalogFresh().then((c) => {
        if (!c.showcase.includes(lobbyId)) return;
        return paymentApi("/api/games/big-wins/" + encodeURIComponent(lobbyId), { timeout: 15000 }).then((r) => {
          const wins = r.ok && r.data && r.data.showcase ? r.data.wins || [] : [];
          if (!wins.length || document.getElementById("vbBigWins")) return;
          const num2 = (n) => Number(n || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const ago = (t) => {
            const m = Math.max(1, Math.round((Date.now() - new Date(t).getTime()) / 60000));
            return m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago";
          };
          const strip = document.createElement("section");
          strip.className = "vb-bigwins";
          strip.id = "vbBigWins";
          strip.setAttribute("aria-label", "Big wins this week");
          strip.innerHTML =
            '<span class="vb-bigwins-label">' + icon("trend") + "<b>Big wins</b><small>this week</small></span>" +
            '<ul class="vb-bigwins-list">' + wins.map((w) =>
              "<li><b>" + num2(w.x) + "x</b><span>GHS " + num2(w.payout) + "</span><small>" + esc(w.player) + " · " + ago(w.at) + "</small></li>"
            ).join("") + "</ul>";
          const anchor = opts.after || document.querySelector("body > header");
          if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(strip, anchor.nextSibling);
          else document.body.prepend(strip);
        });
      }).catch(() => { /* no strip, the game plays as usual */ });
    }
  };

  global.VBUtil = {
    contact: CONTACT, telHref, faq: FAQ,
    wallet, session, api, paymentApi, refreshBalance, favs, recent, streak, toast, icon, gameCard, miniCard, markActiveNav, countdown, nextSundayEnd,
    format, money: format, esc, normalizePhone, isGhanaMobile, categoryIcon: (c) => CATEGORY_ICONS[c] || "grid", thumbFace,
    testMode, openChat: (topic) => chat.open(topic), openConvert, switchCurrency, moneyInDollars, attributeRef,
    referral: { get: storedRef, setPromo: setRefPromo }, freePlay, showcase, activity,
    paymentBase: PAYMENT_API, moneyRules, minDeposit: minDepositNow
  };

  /* Leaving a game must not trap the browser Back button. A "back to the lobby" control is a plain <a href>, which
     PUSHES a new lobby entry on top of the game — so after lobby → game → (tap back) the history is
     [lobby][game][lobby], and the browser Back button then lands on the game again. The player feels stuck bouncing
     between the game and the lobby. For an exit control we REPLACE the game's history entry with the lobby instead,
     so Back cleanly leaves. Only exit controls (a lobby link marked "back", or the crash brand) are touched;
     ordinary links — "browse all games", similar games, the bottom nav — still push as normal. */
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href*="games.html"]');
    if (!a || a.target === "_blank") return;
    const exit = a.classList.contains("cg-brand") || /\bback\b/i.test((a.getAttribute("aria-label") || "") + " " + a.textContent);
    if (!exit) return;
    e.preventDefault();
    location.replace(a.href);
  });

  /* scripts load at the end of <body>, so the page markup is already parsed */
  initShell();
  /* the live minimum deposit and rules in any [data-rule] element (terms, help); also refreshes the cached minimum */
  fillLiveRules();
  /* mirror the server-held wallet balance into the UI when signed in */
  refreshBalance();

  /* keep it fresh so a deposit, win or withdrawal shows up on its own — no reopening the page:
     the moment the tab is shown again, and gently (every 20 s) while it's open and signed in.
     refreshBalance() fires vb:balance, which the header chip and every game already listen for. */
  (function keepBalanceFresh() {
    let timer = 0;
    const tick = () => { if (session.get() && document.visibilityState === "visible") refreshBalance(); };
    const start = () => { clearInterval(timer); if (session.get()) timer = setInterval(tick, 20000); };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { tick(); start(); } else clearInterval(timer);
    });
    window.addEventListener("focus", tick);
    start();
  })();

  /* games and studios an admin has switched off: data.js leaves them out using the last answer, and this keeps it
     fresh for the next page (the server refuses real-money bets on them either way) */
  catalogFresh();
  /* real players per game, for the lobby cards on the next page */
  if (!document.getElementById("winner")) activity.site();

  /* ---------------- withdrawal review popup ---------------- */
  /* after an admin approves a withdrawal, ask the player to rate it. The server gives at most one pending prompt per
     withdrawal, and records a submit or a dismissal, so the popup never returns for that withdrawal. */
  function askWithdrawalReview() {
    if (!session.get() || document.getElementById("vbReview")) return;
    paymentApi("/api/user/withdraw/review-prompt", { timeout: 15000 }).then((r) => {
      const p = r.ok && r.data ? r.data.prompt : null;
      if (!p) return;
      let rating = 0;
      const el = document.createElement("div");
      el.className = "vb-review";
      el.id = "vbReview";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      el.setAttribute("aria-label", "Rate your withdrawal");
      el.innerHTML =
        '<div class="vb-review-card">' +
          '<button class="vb-review-x" type="button" data-rv="close" aria-label="Close">' + icon("close") + "</button>" +
          "<h2>How was your withdrawal?</h2>" +
          "<p>Your " + format(p.amount) + " withdrawal was approved. Tell us how it went.</p>" +
          '<div class="vb-stars" role="radiogroup" aria-label="Stars">' +
            [1, 2, 3, 4, 5].map((n) => '<button type="button" class="vb-star" data-star="' + n + '" role="radio" aria-checked="false" aria-label="' + n + ' star' + (n > 1 ? "s" : "") + '">★</button>').join("") + "</div>" +
          '<textarea class="vb-review-text" maxlength="500" rows="3" placeholder="Describe your experience (optional)"></textarea>' +
          '<button class="btn btn-primary btn-block" type="button" data-rv="submit" disabled>Submit review</button>' +
          '<div class="vb-review-foot"><button type="button" class="vb-review-link" data-rv="close">Satisfied</button>' +
            '<button type="button" class="vb-review-link" data-rv="close">Close</button></div>' +
        "</div>";
      document.body.appendChild(el);
      const stars = [...el.querySelectorAll(".vb-star")];
      const submit = el.querySelector('[data-rv="submit"]');
      const paint = () => stars.forEach((s, i) => {
        s.classList.toggle("on", i < rating);
        s.setAttribute("aria-checked", String(i + 1 === rating));
      });
      el.addEventListener("click", async (e) => {
        const star = e.target.closest("[data-star]");
        if (star) { rating = Number(star.dataset.star); submit.disabled = rating < 1; return paint(); }
        const act = e.target.closest("[data-rv]");
        if (!act) return;
        if (act.dataset.rv === "close") {
          paymentApi("/api/user/withdraw/" + encodeURIComponent(p.withdrawal_id) + "/review/dismiss", { body: { idempotency_key: "rvd:" + p.withdrawal_id }, timeout: 15000 });
          el.remove();
          return;
        }
        if (rating < 1) return;
        act.disabled = true;
        const res = await paymentApi("/api/user/withdraw/" + encodeURIComponent(p.withdrawal_id) + "/review",
          { body: { rating, feedback: el.querySelector(".vb-review-text").value.trim(), idempotency_key: "rv:" + p.withdrawal_id }, timeout: 15000 });
        el.remove();
        toast(res.ok ? "Thanks for your review!" : "Couldn't send your review.", res.ok ? "ok" : "err");
      });
    }).catch(() => { /* no popup if it can't be fetched */ });
  }
  setTimeout(askWithdrawalReview, 1500);

  /* ---------------- partner links ---------------- */
  /* ?ref=CODE (and &sub=campaign) on any page: remembered for 30 days on this device, the visit counted once, and
     kept while the visitor moves between pages. A promo code typed at sign-up is stored with it. Once someone is
     signed in, their account is credited to the partner — the server only accepts newly opened accounts, so an
     existing player can't be claimed, and refuses a link and a promo code of two different partners. The link is
     kept until an account is actually credited: if the account signed in is the partner's own or an older one, a
     new account opened here later still counts. */
  const REF = "vb.ref";
  function storedRef() {
    const ref = read(REF, null);
    return ref && Date.now() - ref.at <= 30 * 864e5 ? ref : null;
  }
  function setRefPromo(promo) {
    const p = String(promo || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    const ref = storedRef();
    if (!p && !ref) return;
    write(REF, Object.assign({ code: "", sub: "", at: Date.now() }, ref || {}, { promo: p, tried: [] }));
  }
  async function attributeRef() {
    const ref = read(REF, null);
    const s = session.get();
    if (!ref || !s) return;
    if (Date.now() - ref.at > 30 * 864e5) return remove(REF);
    const who = s.phone || "";
    if ((ref.tried || []).includes(who)) return; /* this account was already checked against this link */
    const r = await paymentApi("/api/partners/attribute", { body: { code: ref.code, promo: ref.promo || "", sub_id: ref.sub }, timeout: 15000 });
    /* a code that's no longer valid, or a link and promo code of two partners: nothing to retry */
    if (r.status === 404 || r.status === 409) return remove(REF);
    if (!r.ok || !r.data) return; /* try again on the next page */
    if (r.data.attributed) return remove(REF);
    const now = read(REF, null);
    if (now && now.code === ref.code) write(REF, Object.assign({}, now, { tried: (now.tried || []).concat(who).slice(-10) }));
  }
  (function partnerLink() {
    const p = new URLSearchParams(location.search);
    const code = (p.get("ref") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    /* a partner's link is an invitation to join: a visitor who isn't signed in goes straight to the sign-up form, with
       the link (and its promo code) carried along and counted there */
    if (code.length >= 4 && !session.get() && /^\/(?:index\.html)?$/.test(location.pathname)) {
      location.replace("register.html" + location.search + "#register");
      return;
    }
    if (code.length >= 4) {
      const sub = (p.get("sub") || p.get("utm_campaign") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      const prev = read(REF, null);
      if (!prev || prev.code !== code) {
        write(REF, { code, sub, promo: (prev && prev.promo) || "", at: Date.now() });
        paymentApi("/api/partners/click", { body: { code, sub } });
      }
    }
    attributeRef();
  })();

  /* game promotions and the Lotto results popup, on every page (assets/js/promos.js decides where they may show) */
  (function loadPromos() {
    if (global.VB_NO_PROMOS || document.querySelector("script[data-promos]")) return;
    const me = document.currentScript && document.currentScript.src;
    const base = me ? new URL(".", me).href : "assets/js/";
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = new URL("../css/promos.css?v=2", base).href;
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = new URL("promos.js?v=3", base).href;
    js.defer = true;
    js.dataset.promos = "1";
    document.head.appendChild(js);
  })();
})(window);
