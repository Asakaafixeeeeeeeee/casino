/* Log in, register and reset a password against the WIN B casino accounts server (accounts-api/).
   Sign-up asks for the player's full name, a mobile number, a password and a date of birth (the 18+ check, also used
   to reset a forgotten password); the server picks a username. Sessions are kept until the player logs out. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);

  const formMsg = $("formMsg");
  const forms = { register: $("regForm"), login: $("loginForm"), forgot: $("forgotForm") };
  const OLD_ACCOUNTS_NOTE = "Accounts made before 6 October 2026 were saved only on the device they were made on — please register again.";

  /* ---------------- talking to the accounts server ---------------- */
  /* if the server is slow (asleep on Render's free plan) the button says so */
  async function call(btn, label, path, body) {
    busy(btn, true, label);
    const slow = setTimeout(() => { btn.textContent = "Waking the server…"; }, 4000);
    try {
      return await U.api(path, { body });
    } finally {
      clearTimeout(slow);
      busy(btn, false);
    }
  }
  /* a server error that names a field is shown under that field */
  function fieldError(r) {
    const field = r.data && r.data.field;
    const message = (r.data && r.data.error) || "Something went wrong. Try again.";
    if (field && $(field)) setError(field, field + "Err", message);
    else say("err", U.esc(message));
  }

  /* the same rule the server applies */
  function passwordProblem(pw) {
    if (!pw) return "Choose a password.";
    if (pw.length < 8) return "Use at least 8 characters.";
    if (/^\d+$/.test(pw)) return "Use more than numbers alone.";
    return "";
  }
  /* the full name, by the server's rule: a first and a last name at least, in any alphabet, each word starting with a
     letter and otherwise letters, apostrophes, dots or hyphens (O'Neil, Anne-Marie, Ɔbɛng) */
  const tidyName = (v) => String(v || "").normalize("NFC").replace(/\s+/g, " ").trim();
  const NAME_WORD = (() => {
    try { return new RegExp("^\\p{L}[\\p{L}\\p{M}'’.-]*$", "u"); } catch (e) { return /^[A-Za-zÀ-ɏɛɔ][A-Za-zÀ-ɏɛɔ\u0300-\u036f'’.-]*$/; }
  })();
  function fullNameProblem(name) {
    if (!name) return "Enter your full name.";
    if (name.length > 60) return "Use at most 60 characters.";
    const words = name.split(" ");
    if (!words.every((w) => NAME_WORD.test(w))) return "Use letters only — no numbers or symbols.";
    if (words.length < 2) return "Enter your first and last name.";
    return "";
  }

  /* log-in and reset take any registered number: a Ghana number as 024…, any other as +<code>… */
  /* what was typed to log in: a number (tidied the usual way), a username or an email */
  const loginOf = (raw) => {
    const v = String(raw || "").trim();
    return /^[\d\s+()-]+$/.test(v) ? U.normalizePhone(v) : v;
  };
  const phoneProblem = (phone) =>
    !phone ? "Enter your mobile number." : !U.isGhanaMobile(phone) && !/^\+[1-9]\d{7,14}$/.test(phone) ? "That is not a valid mobile number." : "";

  /* ---------------- country ---------------- */
  const COUNTRIES = (window.VB && window.VB.countries) || [{ code: "GH", name: "Ghana", dial: "233", flag: "🇬🇭" }];
  const countryEl = $("country");
  countryEl.innerHTML = COUNTRIES.map((c) => '<option value="' + c.code + '">' + c.flag + " " + c.name + " (+" + c.dial + ")</option>").join("");
  const country = () => COUNTRIES.find((c) => c.code === countryEl.value) || COUNTRIES[0];
  /* the number as the chosen country stores it, or "" when it isn't one of that country's numbers */
  function phoneForCountry(c, raw) {
    const s = String(raw || "").replace(/[\s().-]/g, "");
    if (c.code === "GH") { const p = U.normalizePhone(s); return U.isGhanaMobile(p) ? p : ""; }
    let p = s.replace(/^00/, "+");
    if (/^0\d+$/.test(p)) p = "+" + c.dial + p.slice(1);
    else if (/^\d+$/.test(p)) p = "+" + (p.startsWith(c.dial) ? p : c.dial + p);
    return p.startsWith("+" + c.dial) && /^\+[1-9]\d{7,14}$/.test(p) ? p : "";
  }
  const registerPhoneProblem = (raw) => {
    const c = country();
    if (!raw) return "Enter your mobile number.";
    return phoneForCountry(c, raw) ? "" : c.code === "GH" ? "That is not a valid Ghanaian mobile number." : "Enter a valid " + c.name + " mobile number, e.g. +" + c.dial + " …";
  };
  function paintCountry() {
    const c = country();
    $("phonePrefix").textContent = c.flag + (c.code === "GH" ? "" : " +" + c.dial);
    $("phone").placeholder = c.code === "GH" ? "024 123 4567" : "Mobile number";
    $("phoneNet").hidden = true;
  }
  countryEl.addEventListener("change", () => { paintCountry(); $("phone").value = ""; });
  paintCountry();

  /* ---------------- phone numbers ---------------- */
  const NETWORKS = (window.VB && window.VB.payments || []).filter((p) => p.prefixes)
    .map((p) => ({ name: p.name.replace(/ MoMo| Cash| Money/, ""), prefixes: p.prefixes }));
  const networkOf = (phone) => (NETWORKS.find((n) => n.prefixes.includes(phone.slice(0, 3))) || {}).name;
  /* shows the number as 024 123 4567 while typing (a +233 number is left as typed) */
  function formatPhone(input) {
    const raw = input.value;
    if (/[^\d\s+()-]/.test(raw)) return;   /* a username or an email (log in and reset take those too) */
    if (/^\+|^00/.test(raw.trim())) return;
    if (input.id === "phone" && country().code !== "GH") return;   /* other countries: typed as they are */
    const d = raw.replace(/\D/g, "").slice(0, 10);
    const f = d.length > 6 ? d.slice(0, 3) + " " + d.slice(3, 6) + " " + d.slice(6) : d.length > 3 ? d.slice(0, 3) + " " + d.slice(3) : d;
    if (f !== raw) input.value = f;
  }
  ["phone", "lphone", "fphone"].forEach((id) => $(id).addEventListener("input", () => formatPhone($(id))));
  $("phone").addEventListener("input", () => {
    const p = U.normalizePhone($("phone").value);
    const net = country().code === "GH" && p.length === 10 && U.isGhanaMobile(p) ? networkOf(p) : "";
    $("phoneNet").hidden = !net;
    $("phoneNet").textContent = net || "";
  });

  /* ---------------- form helpers ---------------- */
  function setError(inputId, errId, message) {
    const input = $(inputId);
    const err = $(errId);
    if (err) err.textContent = message;
    const field = input && input.closest(".field");
    if (field) field.classList.toggle("invalid", !!message);
    if (input) input.setAttribute("aria-invalid", String(!!message));
    return !message;
  }
  const say = (kind, html) => (formMsg.innerHTML = "<div class='alert alert-" + kind + "'>" + html + "</div>");
  function busy(btn, on, label) {
    btn.disabled = on;
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.textContent = label;
    } else if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }

  document.querySelectorAll("[data-eye]").forEach((b) => {
    b.addEventListener("click", () => {
      const input = $(b.dataset.eye);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      b.classList.toggle("on", show);
      b.setAttribute("aria-label", show ? "Hide password" : "Show password");
      input.focus();
    });
  });

  /* the latest birthday that is 18 today, so the date pickers never go stale */
  const pad = (n) => String(n).padStart(2, "0");
  const today = new Date();
  $("age").max = $("fdob").max = (today.getFullYear() - 18) + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate());
  /* parsed by hand: new Date("yyyy-mm-dd") is UTC midnight, which shifts the day in some timezones */
  function ageFrom(dob) {
    const [y, m, d] = dob.split("-").map(Number);
    if (!y || !m || !d) return NaN;
    const now = new Date();
    let age = now.getFullYear() - y;
    if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age--;
    return age;
  }

  /* after signing in, return to the page the player came from (on this site), else the lobby.
     replace (not assign) so the login page drops out of history — pressing Back from the destination doesn't
     return to the login form. */
  function leave(to) {
    const ref = document.referrer && new URL(document.referrer);
    const back = to || (ref && ref.origin === location.origin && !/register\.html/.test(ref.pathname) ? ref.href : "index.html");
    /* an account opened through a partner's link is credited now, before leaving (in case the next page never loads) */
    const credited = Promise.race([Promise.resolve(U.attributeRef && U.attributeRef()).catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
    Promise.all([credited, new Promise((r) => setTimeout(r, 900))]).then(() => location.replace(back));
  }

  /* ---------------- modes: register, log in, forgot password — and "already signed in" ---------------- */
  const HEAD = {
    register: ["Create your account", "It takes less than a minute."],
    login: ["Welcome back", "Log in with your mobile number."],
    forgot: ["Reset your password", "Confirm it's you with your date of birth."]
  };
  let mode = "register";
  function setMode(m) {
    mode = HEAD[m] ? m : "register";
    document.querySelectorAll("[data-mode]").forEach((b) => {
      const on = b.dataset.mode === (mode === "forgot" ? "login" : mode);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    Object.keys(forms).forEach((k) => (forms[k].hidden = k !== mode));
    formMsg.innerHTML = "";
    paintHead();
  }
  function go(m) {
    setMode(m);
    history.replaceState(null, "", m === "register" ? location.pathname + location.search : "#" + m);
    const first = forms[mode].querySelector("input");
    if (first && matchMedia("(hover: hover)").matches) first.focus();
  }
  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => go(b.dataset.mode)));
  document.querySelectorAll("[data-goto]").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    go(a.dataset.goto);
  }));
  window.addEventListener("hashchange", () => setMode(location.hash.slice(1) || "register"));

  function paintHead() {
    const s = U.session.get();
    $("signedIn").hidden = !s;
    $("authForms").hidden = !!s;
    if (s) {
      $("authTitle").textContent = "You're logged in";
      $("authLead").textContent = "";
      $("signedInAs").textContent = (s.name || "Player") + " · " + s.phone;
    } else [$("authTitle").textContent, $("authLead").textContent] = HEAD[mode];
  }
  $("signOutBtn").addEventListener("click", () => {
    U.session.logout();
    U.toast("Logged out", "ok");
    go("login");
  });
  document.addEventListener("vb:session", paintHead);

  /* clear an error as soon as its field is edited */
  ["fullName", "phone", "email", "promo", "pw", "age", "lphone", "lpw", "fphone", "fdob", "fpw"].forEach((id) =>
    $(id).addEventListener("input", () => setError(id, id + "Err", "")));
  $("terms").addEventListener("change", () => { if ($("terms").checked) $("termsErr").textContent = ""; });
  $("depositTerms").addEventListener("change", () => { if ($("depositTerms").checked) $("depositTermsErr").textContent = ""; });

  /* ---------------- partner link and promo code ---------------- */
  /* a promo code from the link (?promo=CODE) or remembered from earlier fills the field; a partner link is noted */
  const normPromo = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
  (function prefillPromo() {
    const ref = U.referral.get();
    const fromUrl = normPromo(new URLSearchParams(location.search).get("promo"));
    if (fromUrl || (ref && ref.promo)) $("promo").value = fromUrl || ref.promo;
    if (ref && ref.code) $("promoHint").textContent = "You came through a partner's link — it's linked to your account automatically. A promo code is optional.";
  })();
  $("promo").addEventListener("input", () => {
    const v = normPromo($("promo").value);
    if (v !== $("promo").value) $("promo").value = v;
  });
  /* checks the promo code (and that it's the same partner as the link) before the account is opened. If the server
     can't be reached the sign-up goes ahead; the code is checked again when the account is linked. */
  async function promoProblem(promo) {
    const ref = U.referral.get();
    const code = ref && ref.code ? ref.code : "";
    if (!promo) return "";
    if (promo.length < 4) return "Promo codes have at least 4 letters or numbers.";
    const q = "?promo=" + encodeURIComponent(promo) + (code ? "&code=" + encodeURIComponent(code) : "");
    const r = await U.paymentApi("/api/partners/check" + q, { timeout: 20000 });
    if (r.ok || !r.status || r.status >= 500 || r.status === 429) return "";
    return (r.data && r.data.message) || "That promo code isn't valid.";
  }
  const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;

  /* ---------------- register ---------------- */
  forms.register.addEventListener("submit", async (e) => {
    e.preventDefault();
    formMsg.innerHTML = "";
    const fullName = tidyName($("fullName").value);
    const phone = phoneForCountry(country(), $("phone").value);
    const pw = $("pw").value;
    const dob = $("age").value;
    const age = dob ? ageFrom(dob) : NaN;
    const email = $("email").value.trim();
    const promo = normPromo($("promo").value);

    const ok = [
      setError("email", "emailErr", email && !EMAIL_RE.test(email) ? "That email address doesn't look right — check it, or leave it empty." : ""),
      setError("fullName", "fullNameErr", fullNameProblem(fullName)),
      setError("phone", "phoneErr", registerPhoneProblem($("phone").value)),
      setError("pw", "pwErr", passwordProblem(pw)),
      setError("age", "ageErr",
        !dob ? "Enter your date of birth." :
        !(age >= 18) ? "You must be 18 or older to register." :
        age > 120 ? "Check your date of birth." : "")
    ];
    $("termsErr").textContent = $("terms").checked ? "" : "Please confirm you're 18+ and accept the terms.";
    ok.push($("terms").checked);
    $("depositTermsErr").textContent = $("depositTerms").checked ? "" : "Please accept the deposit phone number rule to register.";
    ok.push($("depositTerms").checked);
    if (ok.includes(false)) {
      const first = forms.register.querySelector(".field.invalid input") || (!$("terms").checked ? $("terms") : !$("depositTerms").checked ? $("depositTerms") : null);
      if (first) first.focus();
      return;
    }

    if (promo) {
      busy($("regBtn"), true, "Checking promo code…");
      const problem = await promoProblem(promo);
      busy($("regBtn"), false);
      if (!setError("promo", "promoErr", problem)) return $("promo").focus();
    }
    const r = await call($("regBtn"), "Creating account…", "/api/register", { full_name: fullName, phone, email, password: pw, dob, currency: $("currency").value, country: country().code, accept_deposit_terms: true });
    if (!r.ok) return fieldError(r);
    /* the promo code goes with the account to the partner it belongs to (credited in leave()) */
    if (promo) U.referral.setPromo(promo);
    U.session.set({ phone: r.data.user.phone, name: r.data.user.username, token: r.data.token, currency: r.data.user.currency }, { remember: true });
    forms.register.reset();
    $("phoneNet").hidden = true;
    say("ok", "Welcome to WIN B casino! Your account is ready.");
    leave();
  });

  /* ---------------- log in ---------------- */
  forms.login.addEventListener("submit", async (e) => {
    e.preventDefault();
    formMsg.innerHTML = "";
    const login = loginOf($("lphone").value);
    const pw = $("lpw").value;
    const okA = setError("lphone", "lphoneErr", login ? "" : "Enter your mobile number, username or email.");
    const okB = setError("lpw", "lpwErr", !pw ? "Enter your password." : "");
    if (!okA || !okB) return;

    const r = await call($("loginBtn"), "Logging in…", "/api/login", { login, password: pw, remember: true });
    if (r.status === 404) {
      setError("lphone", "lphoneErr", "No account with that number, username or email.");
      say("err", 'No account found. <a href="#register" data-goto-inline="register">Register</a> — it takes a minute.' +
        "<br><small>" + OLD_ACCOUNTS_NOTE + "</small>");
      return;
    }
    if (r.status === 401) {
      const left = r.data.triesLeft;
      setError("lpw", "lpwErr", "Wrong password." + (left !== undefined ? " " + left + " tr" + (left === 1 ? "y" : "ies") + " left." : ""));
      $("lpw").select();
      return;
    }
    if (!r.ok) return fieldError(r);
    U.session.set({ phone: r.data.user.phone, name: r.data.user.username, token: r.data.token, currency: r.data.user.currency }, { remember: true });
    forms.login.reset();
    say("ok", "Welcome back, " + U.esc(r.data.user.username) + "!");
    /* a partner's account opens their partner dashboard */
    const p = await Promise.race([U.paymentApi("/api/partners/me", { timeout: 8000 }), new Promise((res) => setTimeout(() => res(null), 8000))]);
    const partner = p && p.ok && p.data && p.data.partner;
    const isPartner = !!partner && (partner.status === "ACTIVE" || partner.status === "SUSPENDED");
    try { sessionStorage.setItem("vb.partner", isPartner ? "1" : "0"); } catch (e) { /* storage unavailable */ }
    leave(isPartner ? "partners.html" : "");
  });

  /* ---------------- forgot password ---------------- */
  forms.forgot.addEventListener("submit", async (e) => {
    e.preventDefault();
    formMsg.innerHTML = "";
    const login = loginOf($("fphone").value);
    const dob = $("fdob").value;
    const pw = $("fpw").value;
    const ok = [
      setError("fphone", "fphoneErr", login ? "" : "Enter your mobile number, username or email."),
      setError("fdob", "fdobErr", !dob ? "Enter your date of birth." : ""),
      setError("fpw", "fpwErr", passwordProblem(pw))
    ];
    if (ok.includes(false)) return;
    const r = await call($("forgotBtn"), "Saving…", "/api/reset", { login, dob, password: pw });
    if (r.status === 404) {
      setError("fphone", "fphoneErr", "No account with that number, username or email.");
      say("err", OLD_ACCOUNTS_NOTE);
      return;
    }
    if (!r.ok) return fieldError(r);
    const typed = $("fphone").value;
    forms.forgot.reset();
    go("login");
    $("lphone").value = typed;
    say("ok", "Password changed — log in with your new password.");
  });

  /* links inside messages ("Register") */
  formMsg.addEventListener("click", (e) => {
    const a = e.target.closest("[data-goto-inline]");
    if (!a) return;
    e.preventDefault();
    const typed = $("lphone").value;
    go(a.dataset.gotoInline);
    if (a.dataset.gotoInline === "register") $("phone").value = typed;
  });

  setMode(location.hash.slice(1) || "register");
})();
