/* BNC WIN (bncwin.html). The server (backend games/bncWin.ts) draws each race when the player presses GO and runs it
   on its clock; this page shows the countdown, asks the server for each half-second step as it happens (it never
   knows a step before it's run), moves the runners to match the race score (green ahead while it's above 1), and
   sends CASH OUT, which the server pays at the moment it receives it. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);
  const esc = U.esc;
  const API = "/api/games/bnc-win";
  const ghs = (n) => "GHS " + Number(n || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + ghs(Math.abs(n));
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const st = {
    rules: { rtp: 0.97, up: 1.08, down: 0.93, bust: 0.01, up_chance: 0.528667, down_chance: 0.461333, steps: 60, step_ms: 500, start_ms: 3000, max_win: 50000, min_bet: 1, max_bet: 1000 },
    race: null, offset: 0, shownX: 1, valueShown: 0, off: 0, last: 0, polling: false, busy: false, lastStep: 0, history: [],
  };
  const stage = $("bnStage");

  /* ---------------- the runners ---------------- */
  function limb(cls, parts) { return '<g class="' + cls + '">' + parts + "</g>"; }
  function runnerSvg(kind) {
    const g = kind === "green";
    const id = kind;
    const skin = g ? ["#b06c40", "#7a4224"] : ["#d79a68", "#a5683e"];
    const cloth = g ? ["#6ff0a4", "#18b257", "#0a5c2c"] : ["#ff9a94", "#e01f2d", "#6d0710"];
    const shoe = g ? "#18b257" : "#e01f2d";
    const leg = (back) => limb("leg " + (back ? "back" : "front"),
      limb("thigh", '<rect class="limb" x="61" y="124" width="18" height="42" rx="9" fill="url(#sk-' + id + ')"/>' +
        '<path d="M58 120 h24 v22 a6 6 0 0 1 -6 6 h-12 a6 6 0 0 1 -6 -6z" fill="url(#cl-' + id + ')"/>' +
        limb("shin", '<rect class="limb" x="63" y="158" width="14" height="40" rx="7" fill="url(#sk-' + id + ')"/>' +
          '<path d="M60 196 q2 -6 10 -6 h6 q12 2 16 8 q1 4 -3 5 h-26 q-4 0 -3 -7z" fill="#fafafa"/><path d="M66 199 h22" stroke="' + shoe + '" stroke-width="3" stroke-linecap="round"/>')));
    const arm = (back) => limb("arm " + (back ? "back" : "front"),
      limb("uarm", '<rect class="limb" x="63" y="82" width="14" height="30" rx="7" fill="url(#sk-' + id + ')"/>' +
        limb("farm", '<rect class="limb" x="64" y="104" width="12" height="27" rx="6" fill="url(#sk-' + id + ')"/><circle cx="70" cy="132" r="6.5" fill="url(#sk-' + id + ')"/>')));
    const head = g
      ? '<image href="assets/img/bnc/face.webp" x="31" y="-4" width="82" height="80" preserveAspectRatio="xMidYMid meet"/>'
      : /* the red runner: her own look — a high puff with a red headband, gold earrings */
        '<circle cx="66" cy="2" r="21" fill="#1c0f0a"/><circle cx="58" cy="-6" r="10" fill="#2a1710"/><circle cx="76" cy="-4" r="9" fill="#24130c"/>' +
        '<ellipse cx="72" cy="40" rx="28" ry="31" fill="url(#fs-red)"/>' +
        '<path d="M44 30 q4 -26 28 -27 q24 1 28 27 q-8 -12 -28 -13 q-20 1 -28 13z" fill="#1c0f0a"/>' +
        '<path d="M45 24 q27 -16 54 0" stroke="#e01f2d" stroke-width="6" fill="none" stroke-linecap="round"/>' +
        '<circle cx="44" cy="44" r="5" fill="#c98b5c"/><circle cx="100" cy="44" r="5" fill="#c98b5c"/>' +
        '<circle cx="44" cy="52" r="2.6" fill="#ffd34d"/><circle cx="100" cy="52" r="2.6" fill="#ffd34d"/>' +
        '<path d="M56 32 q6 -4 12 -1" stroke="#2a1710" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M78 31 q6 -3 12 1" stroke="#2a1710" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
        '<ellipse cx="62" cy="41" rx="6.2" ry="5" fill="#fff"/><ellipse cx="83" cy="41" rx="6.2" ry="5" fill="#fff"/>' +
        '<circle cx="63" cy="41.5" r="3.6" fill="#3b1f10"/><circle cx="84" cy="41.5" r="3.6" fill="#3b1f10"/>' +
        '<circle cx="63" cy="41.5" r="1.7" fill="#000"/><circle cx="84" cy="41.5" r="1.7" fill="#000"/><circle cx="64.3" cy="40.2" r="1.1" fill="#fff"/><circle cx="85.3" cy="40.2" r="1.1" fill="#fff"/>' +
        '<path d="M55.5 38 q6 -5 13 -1" stroke="#111" stroke-width="1.6" fill="none"/><path d="M76.5 37 q7 -4 13 1" stroke="#111" stroke-width="1.6" fill="none"/>' +
        '<path d="M71 44 q-3 8 1 10 q3 1 5 -1" stroke="#8a5530" stroke-width="1.8" fill="none" stroke-linecap="round"/>' +
        '<circle cx="56" cy="53" r="5" fill="#e0707a" opacity=".28"/><circle cx="89" cy="53" r="5" fill="#e0707a" opacity=".28"/>' +
        '<path d="M62 59 q10 8 21 0 q-10 4 -21 0z" fill="#b5524f"/><path d="M63 59.5 q10 3 19 0" stroke="#fff" stroke-width="1.2" opacity=".6" fill="none"/>' +
        '<ellipse cx="62" cy="27" rx="9" ry="4" fill="#fff" opacity=".12"/>';
    return '<svg viewBox="0 0 140 220" aria-hidden="true"><defs>' +
      '<linearGradient id="sk-' + id + '" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="' + skin[0] + '"/><stop offset="1" stop-color="' + skin[1] + '"/></linearGradient>' +
      '<linearGradient id="cl-' + id + '" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + cloth[0] + '"/><stop offset=".45" stop-color="' + cloth[1] + '"/><stop offset="1" stop-color="' + cloth[2] + '"/></linearGradient>' +
      '<radialGradient id="fs-red" cx="40%" cy="35%" r="75%"><stop offset="0" stop-color="#e8b282"/><stop offset=".7" stop-color="#c88a58"/><stop offset="1" stop-color="#9a5f36"/></radialGradient>' +
      '</defs><g class="bob">' + arm(true) + leg(true) +
      '<rect x="64" y="68" width="12" height="16" rx="5" fill="url(#sk-' + id + ')"/>' +
      '<path d="M54 82 q16 -8 32 0 l4 40 q-20 6 -40 0z" fill="url(#cl-' + id + ')"/>' +
      '<path d="M57 86 l-1 34 M83 86 l1 34" stroke="#fff" stroke-width="2.4" opacity=".8"/>' +
      '<rect x="60" y="96" width="20" height="14" rx="2" fill="#fff"/><text class="tag" x="70" y="108" text-anchor="middle" fill="' + cloth[2] + '">' + (g ? "1" : "2") + "</text>" +
      leg(false) + arm(false) + "<g class=\"head\">" + head + "</g></g></svg>";
  }
  $("bnGreen").innerHTML = runnerSvg("green");
  $("bnRed").innerHTML = runnerSvg("red");

  /* ---------------- sound (optional; made in the browser, nothing downloaded) ---------------- */
  let audio = null;
  let soundOn = (() => { try { return localStorage.getItem("bnc.sound") !== "off"; } catch (e) { return true; } })();
  function paintSound() {
    $("bnSound").setAttribute("aria-pressed", String(soundOn));
    $("bnSound").setAttribute("aria-label", soundOn ? "Sound on" : "Sound off");
    $("bnSound").classList.toggle("is-off", !soundOn);
    $("bnSound").style.opacity = soundOn ? "1" : ".45";
  }
  $("bnSound").addEventListener("click", () => {
    soundOn = !soundOn;
    try { localStorage.setItem("bnc.sound", soundOn ? "on" : "off"); } catch (e) { /* storage unavailable */ }
    paintSound();
  });
  paintSound();
  function tone(freq, dur, type, vol, slide) {
    if (!soundOn) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
      o.type = type || "sine";
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(vol || 0.08, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + dur);
    } catch (e) { /* no audio */ }
  }
  function cheer() {
    if (!soundOn) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const len = audio.sampleRate * 1.2, buf = audio.createBuffer(1, len, audio.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.5) * 0.35;
      const s = audio.createBufferSource(), f = audio.createBiquadFilter();
      f.type = "bandpass"; f.frequency.value = 1400;
      s.buffer = buf; s.connect(f).connect(audio.destination); s.start();
    } catch (e) { /* no audio */ }
    [523, 659, 784, 1046].forEach((fq, i) => setTimeout(() => tone(fq, 0.22, "triangle", 0.07), i * 90));
  }

  /* ---------------- the numbers and the scene ---------------- */
  const stakeIn = $("bnStake");
  const race = () => st.race;
  const running = () => race() && race().status === "ACTIVE";
  const now = () => Date.now() + st.offset;
  const startsAt = () => race() ? race()._startsAt : 0;
  const targetX = () => (race() ? (race().status === "BUSTED" ? 0 : race().x) : 1);

  function paintBoard() {
    const r = race();
    const stake = r ? r.stake : Number(stakeIn.value) || 0;
    const value = r ? (r.status === "BUSTED" ? 0 : r.status === "ACTIVE" ? r.value : r.payout) : 0; /* the server's figure, to the pesewa */
    $("bnStakeShow").textContent = ghs(r ? r.stake : stake);
    $("bnValue").textContent = ghs(value);
    $("bnCashVal").textContent = ghs(r && r.status === "ACTIVE" ? r.value : 0);
    const pl = r ? value - stake : 0;
    $("bnPl").textContent = r ? signed(Math.round(pl * 100) / 100) : ghs(0);
    $("bnPl").className = pl > 0 ? "up" : pl < 0 ? "down" : "";
    $("bnValue").className = r && st.shownX > 1 ? "up" : r && st.shownX < 1 ? "down" : "";
    $("bnX").textContent = (r && r.status === "BUSTED" ? 0 : st.shownX).toFixed(2) + "×";
  }
  function setStatus(text, lead) {
    $("bnStatus").textContent = text;
    if (lead) stage.dataset.lead = lead; else delete stage.dataset.lead;
  }

  /* every frame: runners, track, crowd and camera follow the race score */
  function frame(ts) {
    const dt = Math.min(0.1, (ts - (st.last || ts)) / 1000);
    st.last = ts;
    const r = race();
    const t = now();
    const isRunning = r && r.status === "ACTIVE" && t >= startsAt();
    const ended = r && r.status !== "ACTIVE";
    /* the score shown eases toward the latest step */
    const tx = r && r.status === "BUSTED" ? Math.min(st.shownX, targetX() || st.shownX) : targetX();
    st.shownX += (tx - st.shownX) * Math.min(1, dt * (reduce ? 20 : 6));
    if (r && r.status === "BUSTED") st.shownX = Math.max(0.0001, st.shownX);
    const lead = r ? Math.max(-1, Math.min(1, Math.log(Math.max(st.shownX, 0.05)) / Math.log(2.6))) : 0;
    const busted = r && r.status === "BUSTED";
    /* positions, in % of the stage width */
    const base = 46;
    let gx = base + lead * 15, rx = base - lead * 15;
    if (busted) { rx = Math.min(108, (st.bustRx = (st.bustRx || rx) + dt * 45)); gx = Math.max(18, gx - 4); }
    else st.bustRx = 0;
    $("bnGreen").style.left = gx + "%";
    $("bnRed").style.left = rx + "%";
    $("bnGreen").classList.toggle("lead", !!r && lead > 0.02 && !busted);
    $("bnRed").classList.toggle("lead", !!r && (lead < -0.02 || busted));
    /* stride: running fast; the leader a touch faster; stop a moment after the end */
    const play = isRunning || (ended && Date.now() - (st.endedAt || 0) < 1400) ? "running" : "paused";
    $("bnGreen").style.setProperty("--play", play);
    $("bnRed").style.setProperty("--play", play);
    $("bnGreen").style.setProperty("--pace", (busted ? 0.7 : 0.44 - lead * 0.06).toFixed(3) + "s");
    $("bnRed").style.setProperty("--pace", (busted ? 0.3 : 0.44 + lead * 0.06).toFixed(3) + "s");
    /* the track and crowd slide by while they run */
    if (play === "running" && !reduce) st.off += dt * 420;
    $("bnLanes").style.backgroundPosition = "0 0, " + (-st.off % 300) + "px 0, " + (-st.off % 12) + "px 0";
    document.querySelectorAll(".bn-crowd").forEach((c, i) => (c.style.backgroundPosition = (-st.off * (i ? 0.08 : 0.16)) + "px 0"));
    document.querySelector(".bn-banner").style.transform = "translateX(" + (-(st.off * 0.16) % 600) + "px)";
    /* the finish line comes in over the last stretch */
    const prog = r ? Math.max(0, Math.min(1, (t - startsAt()) / (st.rules.steps * st.rules.step_ms))) : 0;
    const shownProg = r && ended ? Math.min(1, (r.ended_step || 0) / st.rules.steps) : prog;
    $("bnProgress").style.width = (shownProg * 100).toFixed(1) + "%";
    if (r && shownProg > 0.85 && !busted) {
      stage.dataset.nearFinish = "1";
      $("bnFinish").style.left = (140 - ((shownProg - 0.85) / 0.15) * 75).toFixed(1) + "%";
    } else delete stage.dataset.nearFinish;
    /* the camera leans toward whoever leads and zooms in while they run */
    const cam = isRunning && !reduce ? "scale(1.06) translateX(" + (-(Math.max(gx, rx) - 50) * 0.25).toFixed(2) + "%)" : "none";
    if ($("bnWorld").dataset.cam !== cam) { $("bnWorld").style.transform = cam; $("bnWorld").dataset.cam = cam; }
    if (isRunning) setStatus(lead > 0.01 ? "Green leads — value rising" : lead < -0.01 ? "Red leads — value falling" : "Neck and neck", lead > 0.01 ? "green" : lead < -0.01 ? "red" : "");
    paintBoard();
    requestAnimationFrame(frame);
  }

  /* ---------------- the race on the server ---------------- */
  function adopt(r) {
    const prev = st.race;
    /* times are on the server's clock; offset maps this device's clock onto it */
    const serverNow = new Date(r.server_now).getTime();
    st.offset = serverNow - Date.now();
    r._startsAt = serverNow + r.starts_in_ms;
    if (prev && prev.race_id === r.race_id && r.step > (prev.step || 0)) {
      const up = r.xs[r.xs.length - 1] > r.xs[r.xs.length - 2];
      tone(up ? 760 : 300, 0.09, "square", 0.035);
    }
    st.race = r;
    $("bnHashRow").hidden = false;
    $("bnHash").textContent = r.hash.slice(0, 18) + "…" + r.hash.slice(-6);
    $("bnHash").title = r.seed ? "Seed: " + r.seed : r.hash;
    if (r.status !== "ACTIVE") ended(r);
  }
  function ended(r) {
    if (st.shownResult === r.race_id) return;
    st.shownResult = r.race_id;
    st.endedAt = Date.now();
    st.polling = false;
    const res = $("bnResult");
    res.hidden = false;
    if (r.status === "BUSTED") {
      res.className = "bn-result lose";
      res.innerHTML = "<b>Red broke away</b><span>The stake of " + ghs(r.stake) + " is lost.</span>";
      setStatus("Red won the race", "red");
      tone(220, 0.5, "sawtooth", 0.06, 110);
    } else {
      const profit = Math.round((r.payout - r.stake) * 100) / 100;
      res.className = "bn-result " + (r.payout >= r.stake ? "win" : "lose");
      res.innerHTML = "<b>" + ghs(r.payout) + "</b><span>" + (r.status === "CASHED" ? "Cashed out at " + Number(r.x).toFixed(2) + "×" : "Finish line at " + Number(r.x).toFixed(2) + "×") +
        " · " + signed(profit) + "</span>";
      setStatus(r.status === "CASHED" ? "Cashed out" : "Race finished", r.payout >= r.stake ? "green" : "red");
      cheer();
    }
    st.shownX = r.status === "BUSTED" ? st.shownX : Number(r.x) || st.shownX;
    $("bnCash").hidden = true;
    $("bnGo").hidden = false;
    $("bnGo").disabled = false;
    $("bnGo").textContent = "GO";
    stakeIn.disabled = false;
    loadState(true);
  }
  async function poll() {
    if (st.polling) return;
    st.polling = true;
    while (st.polling && running()) {
      const wait = Math.max(120, Math.min(450, startsAt() - now() + 60));
      await new Promise((res) => setTimeout(res, startsAt() > now() ? wait : 420));
      if (!st.polling || !running()) break;
      const r = await U.paymentApi(API + "/race/" + encodeURIComponent(race().race_id));
      if (r.ok && r.data && r.data.race) {
        adopt(r.data.race);
        if (r.data.balance !== undefined) U.wallet.setBalance(r.data.balance);
      }
    }
    st.polling = false;
  }
  function countdown() {
    const box = $("bnCount");
    const tick = () => {
      if (!running()) { box.hidden = true; return; }
      const left = startsAt() - now();
      if (left <= -700) { box.hidden = true; return; }
      const label = left > 2000 ? "3" : left > 1000 ? "2" : left > 0 ? "1" : "GO!";
      if (box.textContent !== label) {
        box.textContent = label;
        box.hidden = false;
        box.classList.remove("pop");
        void box.offsetWidth;
        box.classList.add("pop");
        tone(label === "GO!" ? 880 : 440, label === "GO!" ? 0.45 : 0.18, "square", 0.06);
        if (label === "GO!") setStatus("They're off!", "");
      }
      requestAnimationFrame(tick);
    };
    tick();
  }
  function begin(r) {
    st.shownResult = null;
    st.shownX = 1;
    $("bnResult").hidden = true;
    adopt(r);
    if (r.status === "ACTIVE") {
      setStatus(r.starts_in_ms > 0 ? "On your marks…" : "Racing", "");
      $("bnGo").hidden = true;
      $("bnCash").hidden = false;
      $("bnCash").disabled = false;
      stakeIn.disabled = true;
      countdown();
      poll();
    }
  }

  $("bnGo").addEventListener("click", async () => {
    if (!U.session.get()) { U.toast("Log in to race for real money."); location.href = "register.html#login"; return; }
    if (st.busy || running()) return;
    clampStake();
    const stake = Number(stakeIn.value);
    if (!(stake >= st.rules.min_bet && stake <= st.rules.max_bet)) { U.toast("Stake between " + ghs(st.rules.min_bet) + " and " + ghs(st.rules.max_bet) + ".", "error"); return; }
    st.busy = true;
    $("bnGo").disabled = true;
    $("bnGo").textContent = "…";
    tone(520, 0.08, "square", 0.04);
    const r = await U.paymentApi(API + "/race", { body: { stake, idempotency_key: "bnc:" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2)) } });
    st.busy = false;
    if (!r.ok || !r.data || !r.data.race) {
      $("bnGo").disabled = false;
      $("bnGo").textContent = "GO";
      const msg = (r.data && (r.data.message || r.data.error)) || "Couldn't start the race — try again.";
      U.toast(msg, "error");
      if (r.data && r.data.error === "race_running") loadState(false);
      return;
    }
    U.wallet.setBalance(r.data.balance);
    begin(r.data.race);
  });

  $("bnCash").addEventListener("click", async () => {
    if (!running() || $("bnCash").disabled) return;
    if (now() < startsAt()) { U.toast("Wait for the start — the race begins on GO."); return; }
    $("bnCash").disabled = true; /* one press is one cash-out; the server also pays a race only once */
    const r = await U.paymentApi(API + "/race/cashout", { body: { race_id: race().race_id, idempotency_key: "bnc-cash:" + race().race_id } });
    if (r.ok && r.data && r.data.race) {
      U.wallet.setBalance(r.data.balance);
      adopt(r.data.race);
    } else {
      $("bnCash").disabled = false;
      U.toast((r.data && (r.data.message || r.data.error)) || "Couldn't cash out — try again.", "error");
    }
  });

  /* stake */
  function clampStake() {
    let v = Math.round((Number(stakeIn.value) || 0) * 100) / 100;
    v = Math.min(Math.max(v, st.rules.min_bet), st.rules.max_bet);
    stakeIn.value = String(v);
    paintBoard();
  }
  stakeIn.addEventListener("change", clampStake);
  stakeIn.addEventListener("input", paintBoard);
  document.querySelectorAll(".bn-step").forEach((b) => b.addEventListener("click", () => {
    if (stakeIn.disabled) return;
    stakeIn.value = String(Math.max(0, (Number(stakeIn.value) || 0) + Number(b.dataset.step)));
    clampStake();
  }));
  document.querySelectorAll("[data-chip]").forEach((b) => b.addEventListener("click", () => {
    if (stakeIn.disabled) return;
    stakeIn.value = b.dataset.chip;
    clampStake();
  }));

  /* ---------------- history, rules, start ---------------- */
  const LABEL = { CASHED: "Cashed out", FINISHED: "Finished", BUSTED: "Red broke away" };
  function paintHistory() {
    const h = st.history;
    $("bnHistory").innerHTML = h.length ? h.map((x) => {
      const win = x.payout >= x.stake;
      const when = new Date(x.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      return '<div class="bn-row ' + (win ? "win" : "lose") + '"><span class="dot"></span><span><b>' + (LABEL[x.status] || x.status) +
        (x.x ? " · " + Number(x.x).toFixed(2) + "×" : "") + "</b><small>" + esc(when) + " · stake " + ghs(x.stake) +
        ' · seed <code title="SHA-256 of this seed is the fingerprint shown during the race">' + esc(String(x.seed || "").slice(0, 16)) + "…</code></small></span>" +
        '<b class="' + (x.payout >= x.stake ? "win" : "lose") + '">' + (x.payout > 0 ? ghs(x.payout) : "−" + ghs(x.stake)) + "</b></div>";
    }).join("") : '<p class="bn-none">No races yet. Set your stake and press GO.</p>';
  }
  function paintRules() {
    const R = st.rules;
    const pct = (p) => (p * 100).toFixed(2) + "%";
    $("bnLimits").textContent = "Stake " + ghs(R.min_bet) + " – " + ghs(R.max_bet) + " · top win " + ghs(R.max_win) + " · return to player " + Math.round(R.rtp * 100) + "%";
    stakeIn.min = String(R.min_bet);
    stakeIn.max = String(R.max_bet);
    $("bnRulesBody").innerHTML =
      "<ol>" +
      "<li>Enter your stake and press <b>GO</b>. The stake is taken from your balance once, and the race starts after a 3-second countdown.</li>" +
      "<li>The race lasts " + (R.steps * R.step_ms / 1000) + " seconds, in " + R.steps + " steps of half a second. Your runner is <b style='color:#6ff0a4'>green</b>. While green is ahead, your cash-out value is above where it started and rising; while <b style='color:#ff8a84'>red</b> is ahead it's falling.</li>" +
      "<li>Press <b>CASH OUT</b> whenever you like: you're paid the cash-out value at the moment the server receives it, straight to your balance. A race can be cashed out only once.</li>" +
      "<li>If you don't cash out, the race pays the value at the finish line. If red breaks away, the race ends at once and the stake is lost.</li>" +
      "</ol>" +
      "<p><b>How the value is worked out.</b> The race score starts at 1.00×. Every step is drawn by the server:</p>" +
      "<table><tr><th>Step</th><th>Chance</th><th>Race score</th></tr>" +
      "<tr><td>Green surges</td><td>" + pct(R.up_chance) + "</td><td>× " + R.up + "</td></tr>" +
      "<tr><td>Red surges</td><td>" + pct(R.down_chance) + "</td><td>× " + R.down + "</td></tr>" +
      "<tr><td>Red breaks away</td><td>" + pct(R.bust) + "</td><td>race lost</td></tr></table>" +
      "<p><b>Cash-out value = stake × " + Math.round(R.rtp * 100) + "% × race score</b>, rounded down to the pesewa, up to the top win of " + ghs(R.max_win) +
      " (a race that gets there cashes itself out). So at the start, before any step, the value is " + Math.round(R.rtp * 100) + "% of the stake.</p>" +
      "<p><b>Return to player: " + Math.round(R.rtp * 100) + "%.</b> The steps are balanced, so on average a race returns " + Math.round(R.rtp * 100) +
      "% of the stake whenever you cash out — no timing does better in the long run. Results vary a lot from race to race: about " +
      Math.round((1 - Math.pow(1 - R.bust, R.steps)) * 100) + "% of races that run to the end have red break away, and you can lose your whole stake.</p>" +
      "<p><b>Fairness.</b> The whole race is drawn from a secret seed the moment you press GO — never from your stake, your account or when you cash out. " +
      "Its fingerprint (SHA-256) is shown during the race; the seed is shown in your race history afterwards, so the steps can be checked. The runners only show the race score.</p>" +
      "<p>18+ only. Play only with money you can afford to lose. You can set limits or take a break from My account.</p>";
  }
  const openRules = () => $("bnRules").showModal();
  $("bnRulesBtn").addEventListener("click", openRules);
  $("bnRulesLink").addEventListener("click", openRules);

  async function loadState(quiet) {
    if (!U.session.get()) {
      const r = await U.paymentApi(API + "/rules");
      if (r.ok && r.data) Object.assign(st.rules, r.data);
      paintRules();
      $("bnHistory").innerHTML = '<p class="bn-none"><a href="register.html#login">Log in</a> to race and see your races here.</p>';
      return;
    }
    const r = await U.paymentApi(API + "/state");
    if (!r.ok || !r.data) { if (!quiet) U.toast((r.data && r.data.message) || "BNC WIN is unavailable right now.", "error"); return; }
    Object.assign(st.rules, { rtp: r.data.rtp, up: r.data.up, down: r.data.down, bust: r.data.bust, up_chance: r.data.up_chance, down_chance: r.data.down_chance,
      steps: r.data.steps, step_ms: r.data.step_ms, start_ms: r.data.start_ms, max_win: r.data.max_win, min_bet: r.data.min_bet, max_bet: r.data.max_bet });
    st.history = r.data.history || [];
    U.wallet.setBalance(r.data.balance);
    paintRules();
    paintHistory();
    if (r.data.race && r.data.race.status === "ACTIVE" && !running()) begin(r.data.race); /* a reload carries on */
  }

  setStatus("Ready to race", "");
  paintRules();
  loadState(false);
  U.refreshBalance();
  requestAnimationFrame(frame);
})();
