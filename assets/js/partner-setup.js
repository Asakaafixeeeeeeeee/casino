/* WIN B casino partner setup: the page a new partner opens from the secret link an admin sent them
   (partner-setup.html#<secret>). It shows their invitation (number and commission), then they register their own
   account (name, username, password, date of birth; email and promo code optional) and land on their partner
   dashboard. A number that already has an account logs in to that account and accepts instead. The balance service
   checks the link every time: it works once, for that number only, until it expires. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);
  const esc = U.esc;
  const view = $("psView");
  const token = (location.hash.slice(1) || new URLSearchParams(location.search).get("invite") || "").trim();
  const pct = (n) => Number(n || 0).toLocaleString("en-GH", { maximumFractionDigits: 2 }) + "%";
  const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  let info = null;

  function say(kind, html) {
    $("formMsg").innerHTML = html ? '<div class="alert alert-' + kind + '">' + html + "</div>" : "";
  }
  const errText = (r, fallback) => esc((r.data && (r.data.message || r.data.error)) || fallback);

  const head = (title, lead) =>
    '<img class="auth-logo" src="assets/img/winb-mark.svg" alt="" width="56" height="56">' +
    '<h1 class="auth-title">' + title + '</h1><p class="auth-lead">' + lead + "</p>";

  function stopped(title, text) {
    view.innerHTML = head(title, text) +
      '<a class="btn btn-primary btn-lg btn-block" href="register.html#login">Log in</a>' +
      '<a class="btn btn-ghost btn-lg btn-block" href="index.html">Go to WIN B casino</a>';
  }

  /* the terms the admin set, so the partner knows what they're joining */
  const offer = (i) =>
    '<div class="ps-offer">' +
      '<div class="ps-offer-rate"><b>' + pct(i.revshare_pct) + "</b><span>revenue share</span></div>" +
      '<ul class="ps-offer-list">' +
        "<li>" + U.icon("star") + "<span>Earn <b>" + pct(i.revshare_pct) + "</b> of what the players you bring lose from their deposits.</span></li>" +
        "<li>" + U.icon("user") + "<span>Your own referral link, promo code and partner dashboard.</span></li>" +
        "<li>" + U.icon("wallet") + "<span>Withdraw your commission to mobile money, bank or crypto.</span></li>" +
      "</ul></div>";

  const field = (id, label, input, hint) =>
    '<div class="field"><label for="' + id + '">' + label + "</label>" + input +
    (hint ? '<span class="hint">' + hint + "</span>" : "") + '<span class="err" id="' + id + 'Err"></span></div>';
  const adultBy = () => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 18);
    return d.toISOString().slice(0, 10);
  };
  const pwInput = (id, ac, ph) => '<div class="input-wrap"><input id="' + id + '" type="password" autocomplete="' + ac + '" placeholder="' + ph + '" maxlength="128">' +
    '<button type="button" class="eye" data-eye="' + id + '" aria-label="Show password">👁</button></div>';
  const promoField = () => field("psPromo", 'Your promo code <span class="opt">(optional)</span>',
    '<input id="psPromo" type="text" maxlength="16" autocapitalize="characters" spellcheck="false" autocomplete="off" placeholder="e.g. AMA2026">',
    "4–16 letters and numbers. Players type it when they sign up. You can also choose it later in Settings.");

  function drawRegister() {
    const i = info;
    const signedIn = U.session.get();
    view.innerHTML = head("Set up your partner account", "You've been invited to join WIN B casino Partners. Create your account to get your link and dashboard.") +
      offer(i) +
      (signedIn ? '<div class="alert alert-info">You\'re signed in as <b>' + esc(signedIn.name || signedIn.phone || "") + "</b>. Creating this partner account signs you into it instead.</div>" : "") +
      '<form id="psForm" novalidate>' +
        field("psPhone", "Mobile number", '<input id="psPhone" type="text" value="' + esc(i.phone) + '" readonly aria-readonly="true">',
          "This invitation is for this number. It becomes your account's number.") +
        field("psName", "Full name", '<input id="psName" type="text" maxlength="60" autocomplete="name" autocapitalize="words" spellcheck="false" placeholder="e.g. Ama Mensah">') +
        field("psUser", "Username", '<input id="psUser" type="text" maxlength="16" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="4–16 letters or numbers">',
          "You can log in with it, your number or your email.") +
        field("psPw", "Password", pwInput("psPw", "new-password", "At least 8 characters")) +
        field("psPw2", "Confirm password", pwInput("psPw2", "new-password", "Type it again")) +
        field("psDob", "Date of birth", '<input id="psDob" type="date" autocomplete="bday" max="' + adultBy() + '">', "Partners must be 18 or older.") +
        field("psEmail", 'Email <span class="opt">(optional)</span>', '<input id="psEmail" type="email" maxlength="254" autocomplete="email" spellcheck="false" autocapitalize="off" placeholder="you@example.com">') +
        promoField() +
        '<label class="checkbox auth-terms"><input type="checkbox" id="psTerms"><span>I\'m 18 or older, I accept the <a href="terms.html" target="_blank" rel="noopener">terms</a>, ' +
          "and I'll promote WIN B casino honestly: to adults only, with no promises of winning.</span></label>" +
        '<span class="err" id="psTermsErr"></span>' +
        '<button class="btn btn-primary btn-lg btn-block" type="submit" id="psBtn">Create partner account</button>' +
      "</form>" +
      '<p class="ps-small">Link valid until ' + esc(day(i.expires_at)) + ". Already have an account with this number? " +
        '<a href="#" data-show="login">Log in to accept instead</a>.</p>';
    $("psName").focus();
  }

  /* a number that already has an account: log in to it (or, signed in already, just accept) */
  function drawLogin() {
    const i = info;
    const s = U.session.get();
    view.innerHTML = head("Become a partner", "The number " + esc(i.phone_masked) + " already has a WIN B casino account. " +
        (s ? "Accept the invitation to make it a partner account." : "Log in to it to accept the invitation.")) +
      offer(i) +
      '<form id="psAccept" novalidate>' +
        (s ? '<div class="alert alert-info">Signed in as <b>' + esc(s.name || s.phone || "") + '</b>. Not you? <a href="#" data-signout>Log out</a>.</div>'
           : field("psLogin", "Mobile number, username or email", '<input id="psLogin" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="254" value="' + esc(i.phone) + '">') +
             field("psLpw", "Password", pwInput("psLpw", "current-password", "")) +
             '<a class="auth-forgot" href="register.html#forgot">Forgot password?</a>') +
        promoField() +
        '<button class="btn btn-primary btn-lg btn-block" type="submit" id="psBtn">' + (s ? "Accept and open my dashboard" : "Log in and accept") + "</button>" +
      "</form>" +
      (i.existing_account ? "" : '<p class="ps-small"><a href="#" data-show="register">Create a new account instead</a></p>');
  }

  const FIELD_OF = { fullName: "psName", username: "psUser", pw: "psPw", age: "psDob", email: "psEmail", phone: "psPhone", promo: "psPromo" };
  function setErr(id, msg) {
    const e = $(id + "Err");
    if (e) e.textContent = msg || "";
    const input = $(id);
    if (input) input.setAttribute("aria-invalid", msg ? "true" : "false");
    return !msg;
  }
  /* the server's answer about one field, under that field */
  function fieldError(r) {
    const code = (r.data && r.data.error) || "";
    const m = /^(?:invalid_(\w+)|(\w+)_taken)$/.exec(code);
    const key = m ? m[1] || m[2] : "";
    const id = FIELD_OF[key] || (key === "promo" ? "psPromo" : "");
    if (id && $(id)) {
      setErr(id, (r.data && r.data.message) || "Check this.");
      $(id).focus();
      return true;
    }
    return false;
  }

  async function busy(fn) {
    const b = $("psBtn");
    const label = b.textContent;
    b.disabled = true;
    b.textContent = "Please wait…";
    try {
      return await fn();
    } finally {
      if (b.isConnected) {
        b.disabled = false;
        b.textContent = label;
      }
    }
  }

  /* signed in as the partner: their dashboard */
  function toDashboard() {
    try { sessionStorage.setItem("vb.partner", "1"); } catch (e) { /* storage unavailable */ }
    location.replace("partners.html#dashboard");
  }
  async function logIn(login, password) {
    const r = await U.api("/api/login", { body: { login, password, remember: true } });
    if (!r.ok) return r;
    U.session.set({ phone: r.data.user.phone, name: r.data.user.username, token: r.data.token, currency: r.data.user.currency }, { remember: true });
    return r;
  }

  async function submitRegister() {
    say("", "");
    ["psName", "psUser", "psPw", "psPw2", "psDob", "psEmail", "psPromo", "psTerms"].forEach((id) => setErr(id, ""));
    const v = (id) => $(id).value.trim();
    const body = { token, full_name: v("psName").replace(/\s+/g, " "), username: v("psUser"), password: $("psPw").value, dob: v("psDob"), email: v("psEmail"), promo_code: v("psPromo").toUpperCase() };
    const ok = [
      setErr("psName", body.full_name.split(" ").length < 2 ? "Enter your first and last name." : ""),
      setErr("psUser", /^[A-Za-z0-9]{4,16}$/.test(body.username) ? "" : "Use 4–16 letters or numbers, no spaces."),
      setErr("psPw", body.password.length >= 8 ? "" : "Use at least 8 characters."),
      setErr("psPw2", $("psPw2").value === body.password ? "" : "The passwords don't match."),
      setErr("psDob", !body.dob ? "Enter your date of birth." : body.dob > adultBy() ? "Partners must be 18 or older." : ""),
      setErr("psEmail", !body.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) ? "" : "That email address doesn't look right."),
      setErr("psPromo", !body.promo_code || /^[A-Z0-9]{4,16}$/.test(body.promo_code) ? "" : "Use 4–16 letters and numbers."),
      setErr("psTerms", $("psTerms").checked ? "" : "Please tick to agree."),
    ].every(Boolean);
    if (!ok) return view.querySelector('[aria-invalid="true"]') && view.querySelector('[aria-invalid="true"]').focus();
    if (!body.email) delete body.email;
    await busy(async () => {
      const r = await U.paymentApi("/api/partners/invite/register", { body, timeout: 30000 });
      if (!r.ok) {
        if (r.data && r.data.error === "already_registered") {
          info.existing_account = true;
          drawLogin();
          return say("info", errText(r, "This number already has an account. Log in with it to accept."));
        }
        if (fieldError(r)) return;
        return say("err", errText(r, "Couldn't create your partner account. Try again in a moment."));
      }
      say("ok", "Your partner account is ready. Opening your dashboard…");
      const li = await logIn(body.username, body.password);
      if (!li.ok) return say("info", "Your partner account is ready. <a href=\"register.html#login\">Log in</a> with your username and password to open your dashboard.");
      if (r.data.promo_error) try { sessionStorage.setItem("vb.partnerNote", r.data.promo_error); } catch (e) { /* storage unavailable */ }
      toDashboard();
    });
  }

  async function submitAccept() {
    say("", "");
    const promo = $("psPromo").value.trim().toUpperCase();
    if (!setErr("psPromo", !promo || /^[A-Z0-9]{4,16}$/.test(promo) ? "" : "Use 4–16 letters and numbers.")) return;
    await busy(async () => {
      if (!U.session.get()) {
        const login = $("psLogin").value.trim();
        const pw = $("psLpw").value;
        if (!setErr("psLogin", login ? "" : "Enter your number, username or email.") | !setErr("psLpw", pw ? "" : "Enter your password.")) return;
        const li = await logIn(/^[\d\s+()-]+$/.test(login) ? U.normalizePhone(login) : login, pw);
        if (!li.ok) return say("err", errText(li, "Couldn't log you in. Check your details."));
      }
      const r = await U.paymentApi("/api/partners/invite/accept", { body: { token, promo_code: promo }, timeout: 20000 });
      if (!r.ok) {
        if (fieldError(r)) return;
        if (r.data && r.data.error === "wrong_account") drawLogin();
        return say("err", errText(r, "Couldn't accept the invitation."));
      }
      if (r.data.promo_error) try { sessionStorage.setItem("vb.partnerNote", r.data.promo_error); } catch (e) { /* storage unavailable */ }
      toDashboard();
    });
  }

  view.addEventListener("submit", (e) => {
    e.preventDefault();
    if (e.target.id === "psForm") return submitRegister();
    if (e.target.id === "psAccept") return submitAccept();
  });
  view.addEventListener("click", (e) => {
    const eye = e.target.closest("[data-eye]");
    if (eye) {
      const i = $(eye.dataset.eye);
      i.type = i.type === "password" ? "text" : "password";
      return;
    }
    const sh = e.target.closest("[data-show]");
    if (sh) {
      e.preventDefault();
      say("", "");
      return sh.dataset.show === "login" ? drawLogin() : drawRegister();
    }
    if (e.target.closest("[data-signout]")) {
      e.preventDefault();
      U.session.logout();
      return drawLogin();
    }
  });
  view.addEventListener("input", (e) => {
    if (e.target.id === "psPromo" || e.target.id === "psUser") {
      const v = e.target.id === "psPromo" ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") : e.target.value.replace(/\s/g, "");
      if (v !== e.target.value) e.target.value = v;
    }
  });

  async function start() {
    if (!token) return stopped("Partner setup link needed", "Open the full link the WIN B casino team sent you. If it doesn't work, ask them for a new one.");
    const r = await U.paymentApi("/api/partners/invite/info", { body: { token }, timeout: 20000 });
    if (!r.ok) {
      const code = r.data && r.data.error;
      const title = code === "invite_used" ? "This link has been used" : code === "invite_expired" ? "This link has expired"
        : code === "invite_cancelled" ? "This link was cancelled" : r.status === 429 ? "Too many tries" : r.status === 0 || r.status >= 500 ? "Can't reach WIN B casino" : "Link not valid";
      return stopped(title, errText(r, "Check your connection and try again."));
    }
    info = r.data;
    return info.existing_account ? drawLogin() : drawRegister();
  }
  start();
})();
