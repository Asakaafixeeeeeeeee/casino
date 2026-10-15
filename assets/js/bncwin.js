/* BNC WIN (bncwin.html). Real-money races are drawn and settled by the server; free races use virtual credits in this
   page and never contact the wagering endpoints. This page also runs the TV graphics, commentary and stadium sound. */
(function () {
  "use strict";
  const U = window.VBUtil;
  const $ = (id) => document.getElementById(id);
  const esc = U.esc;
  const API = "/api/games/bnc-win";
  const params = new URLSearchParams(location.search);
  let mode = params.get("mode") === "real" ? "real" : "fun";
  const isDemo = () => mode === "fun";
  const ghs = (n) => isDemo()
    ? Number(n || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " credits"
    : "GHS " + Number(n || 0).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + ghs(Math.abs(n));
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  const st = {
    rules: { rtp: 0.97, up: 1.08, down: 0.93, bust: 0.01, up_chance: 0.528667, down_chance: 0.461333, steps: 60, step_ms: 500, start_ms: 3000, max_win: 50000, min_bet: 1, max_bet: 1000 },
    race: null, offset: 0, shownX: 1, last: 0, polling: false, busy: false, history: [],
  };
  let demoCredits = [1000, 2000, 3000][Math.floor(Math.random() * 3)];
  const stage = $("bnStage");
  window.BNC_VIEW = { phase: "idle", lead: 0, prog: 0, ended: null, raceId: null };

  /* ---------------- sound: stadium crowd, footsteps, beeps, and the commentary voice ---------------- */
  let audio = null, crowdGain = null, crowdLevel = 0, stepBuf = null;
  let soundOn = (() => { try { return localStorage.getItem("bnc.sound") !== "off"; } catch (e) { return true; } })();
  let voiceOn = (() => { try { return localStorage.getItem("bnc.voice") !== "off"; } catch (e) { return true; } })();
  function paintSound() {
    $("bnSound").setAttribute("aria-pressed", String(soundOn));
    $("bnSound").setAttribute("aria-label", soundOn ? "Sound on" : "Sound off");
    $("bnSound").classList.toggle("is-off", !soundOn);
    $("bnVoice").setAttribute("aria-pressed", String(voiceOn));
    $("bnVoice").textContent = "🎙 Commentary voice: " + (voiceOn ? "on" : "off");
    $("bnVoice").classList.toggle("is-off", !voiceOn || !soundOn);
  }
  function ctx() {
    if (!soundOn) return null;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
      if (!crowdGain) startCrowd();
      return audio;
    } catch (e) { return null; }
  }
  function noiseBuffer(sec, color) {
    const len = Math.floor(audio.sampleRate * sec), buf = audio.createBuffer(1, len, audio.sampleRate), d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (color === "pink") { b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048; d[i] = (b0 + b1 + b2) * 0.9; }
      else d[i] = w;
    }
    return buf;
  }
  /* the crowd: a loop of murmur that swells with the race (bncwin-stage.js sets the level) */
  function startCrowd() {
    try {
      const src = audio.createBufferSource(); src.buffer = noiseBuffer(3, "pink"); src.loop = true;
      const bp = audio.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 850; bp.Q.value = 0.5;
      const lfo = audio.createOscillator(), lg = audio.createGain(); lfo.frequency.value = 0.23; lg.gain.value = 260; lfo.connect(lg).connect(bp.frequency); lfo.start();
      crowdGain = audio.createGain(); crowdGain.gain.value = 0;
      src.connect(bp).connect(crowdGain).connect(audio.destination); src.start();
    } catch (e) { crowdGain = null; }
  }
  function setCrowd(level) {
    crowdLevel = level;
    if (!crowdGain || !audio) return;
    const g = soundOn ? 0.03 + Math.min(1, level) * 0.13 : 0;
    crowdGain.gain.setTargetAtTime(g, audio.currentTime, 0.4);
  }
  function tone(freq, dur, type, vol, slide) {
    const a = ctx(); if (!a) return;
    try {
      const o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
      o.type = type || "sine";
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(vol || 0.08, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(a.destination);
      o.start(t); o.stop(t + dur);
    } catch (e) { /* no audio */ }
  }
  function roar(strength) {
    const a = ctx(); if (!a) return;
    try {
      const s = a.createBufferSource(); s.buffer = noiseBuffer(2.2, "pink");
      const f = a.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1100; f.Q.value = 0.7;
      const g = a.createGain(), t = a.currentTime;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35 * strength, t + 0.35); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
      s.connect(f).connect(g).connect(a.destination); s.start();
    } catch (e) { /* no audio */ }
  }
  let lastStep = 0;
  function step(kind, speed) {
    if (!soundOn || !audio || !crowdGain) return;
    const t0 = performance.now(); if (t0 - lastStep < 70) return; lastStep = t0;
    try {
      const s = audio.createBufferSource(); s.buffer = stepBuf || (stepBuf = noiseBuffer(0.06));
      const f = audio.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = kind === "green" ? 420 : 340;
      const g = audio.createGain(), t = audio.currentTime;
      g.gain.setValueAtTime(0.12 * Math.min(1, (speed || 6) / 6), t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      s.connect(f).connect(g).connect(audio.destination); s.start();
    } catch (e) { /* no audio */ }
  }
  window.BNCSound = { crowd: setCrowd, step };

  $("bnSound").addEventListener("click", () => {
    soundOn = !soundOn;
    try { localStorage.setItem("bnc.sound", soundOn ? "on" : "off"); } catch (e) { /* storage unavailable */ }
    if (!soundOn && window.speechSynthesis) window.speechSynthesis.cancel();
    if (soundOn) ctx();
    setCrowd(crowdLevel);
    paintSound();
  });
  $("bnVoice").addEventListener("click", () => {
    voiceOn = !voiceOn;
    try { localStorage.setItem("bnc.voice", voiceOn ? "on" : "off"); } catch (e) { /* storage unavailable */ }
    if (!voiceOn && window.speechSynthesis) window.speechSynthesis.cancel();
    paintSound();
  });
  paintSound();

  /* ---------------- commentary: describes only what has already happened in the race ---------------- */
  const comm = { at: 0, text: "" };
  let voice = null;
  /* the best voice this device has: the natural/neural voices sound far more human than the basic ones */
  function chooseVoice() {
    if (!window.speechSynthesis) return;
    const vs = window.speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
    const score = (v) => (/natural|neural|online/i.test(v.name) ? 50 : 0) + (/google uk english male|daniel|ryan|guy|davis|george|thomas/i.test(v.name) ? 20 : 0) +
      (/google/i.test(v.name) ? 10 : 0) + (/en[-_](GB|NG|GH)/i.test(v.lang) ? 6 : /en[-_](US|AU)/i.test(v.lang) ? 3 : 0) + (v.localService ? 0 : 2);
    voice = vs.sort((a, b) => score(b) - score(a))[0] || null;
  }
  if (window.speechSynthesis) { chooseVoice(); window.speechSynthesis.onvoiceschanged = chooseVoice; }
  /* heat 0–2: how excited the line is — louder, quicker and higher when it matters */
  function say(text, urgent, heat) {
    const t = Date.now();
    if (!urgent && t - comm.at < 3200) return;
    if (text === comm.text && t - comm.at < 9000) return;
    comm.at = t; comm.text = text;
    const box = $("bnComm");
    $("bnCommText").textContent = text;
    box.classList.toggle("hot", (heat || 0) >= 2);
    box.classList.remove("new"); void box.offsetWidth; box.classList.add("new");
    if (soundOn && voiceOn && window.speechSynthesis && !navigator.webdriver) {
      try {
        const ss = window.speechSynthesis;
        if (urgent) ss.cancel(); else if (ss.speaking) return;
        /* spoken in sentence case (capitals can be read out letter by letter), with natural pauses */
        const spoken = text.toLowerCase().replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase())
          .replace(/×/g, " times").replace(/ghs/gi, "cedis").replace(/—/g, ", ").replace(/\.\.\./g, ", ");
        const h = heat || 0;
        const u = new SpeechSynthesisUtterance(spoken);
        if (voice) u.voice = voice;
        u.lang = voice ? voice.lang : "en-GB";
        u.rate = [1.02, 1.1, 1.18][h]; u.pitch = [1, 1.08, 1.18][h]; u.volume = 1;
        ss.speak(u);
      } catch (e) { /* no voice */ }
    }
  }
  const L = (x) => Math.log(Math.max(x, 1e-6));
  /* green is ahead exactly when the cash-out value is above the stake (stake × rtp × score > stake) */
  const edge = (x) => L(x * st.rules.rtp);
  const story = { sign: 0, half: false, final: false, far: false, behind: false, close: 0 };
  function narrate(r, prev) {
    if (!prev || prev.race_id !== r.race_id || !r.xs || r.xs.length < 2 || r.step <= (prev.step || 0)) return;
    const xs = r.xs, n = xs.length - 1, x = xs[n], lead = edge(x);
    const sign = lead > 0.02 ? 1 : lead < -0.02 ? -1 : story.sign;
    const steps = st.rules.steps;
    const trend = n >= 3 ? Math.sign(xs[n] - xs[n - 1]) + Math.sign(xs[n - 1] - xs[n - 2]) + Math.sign(xs[n - 2] - xs[n - 3]) : 0;
    const late = n >= steps * 0.8;
    if (sign !== story.sign && sign !== 0) {
      const first = story.sign === 0;
      story.sign = sign;
      if (sign > 0) { say(pick(first ? ["GREEN SETS THE PACE!", "Green is quickest away — green leads!"] : ["GREEN GOES PAST! GREEN TAKES THE LEAD!", "LOOK AT THAT! Green is back in front!", "AND GREEN HITS THE FRONT!"]), true, 2); roar(0.9); }
      else { say(pick(first ? ["Red is quickest away — red leads!", "RED SETS THE PACE!"] : ["WOW! RED IS TAKING THE LEAD!", "RED GOES PAST! Green has work to do!", "RED IS FIGHTING BACK! WHAT AN AMAZING RACE!"]), true, 2); roar(0.6); }
      return;
    }
    if (!story.half && n >= steps / 2) { story.half = true; say(pick(["Halfway there, and the race is getting intense!", "We're at halfway... and this is a real contest!"]), false, 1); return; }
    if (!story.final && late) { story.final = true; say(lead > 0 ? "Into the final stretch... GREEN IS PUSHING HARD!" : "Into the final stretch... can green find something?", true, 2); roar(0.7); return; }
    if (!story.far && lead >= L(1.55)) { story.far = true; say(pick(["Green is well clear! What a run!", "GREEN IS FLYING! She's opened up a big gap!"]), false, 1); return; }
    if (!story.behind && lead <= L(0.62)) { story.behind = true; say(pick(["Red is well clear... can green respond?", "Red has opened a big gap here!"]), false, 1); return; }
    if (Math.abs(lead) < 0.03 && n > 4) {
      if (late) say(pick(["LET'S GO! LET'S GO! WHAT A FINISH THIS IS!", "IT'S TOO CLOSE TO CALL!"]), true, 2);
      else say(pick(["OH MY GOODNESS! THEY'RE NECK AND NECK!", "Nothing between them!", "Side by side down the straight!"]), false, 2);
      return;
    }
    if (trend === 3 && lead > 0) say(pick(["GREEN IS PUSHING HARD! She's pulling away!", "Green is stretching her legs now!"]), false, 1);
    else if (trend === -3 && lead > 0) say(pick(["The red runner is catching up!", "Red is closing the gap!", "Here comes red!"]), false, 1);
    else if (trend === 3 && lead < 0) say(pick(["LOOK AT THAT! GREEN IS CLOSING THE GAP!", "GREEN IS PUSHING HARD! SHE'S NOT GIVING UP!"]), false, 2);
    else if (trend === -3 && lead < 0) say(pick(["Red is stretching the lead!", "Red pulls further ahead!"]), false, 1);
  }

  /* ---------------- the numbers and the graphics ---------------- */
  const stakeIn = $("bnStake");
  const race = () => st.race;
  const running = () => race() && race().status === "ACTIVE";
  const now = () => Date.now() + st.offset;
  const startsAt = () => race() ? race()._startsAt : 0;
  const targetX = () => (race() ? (race().status === "BUSTED" ? 0 : race().x) : 1);

  function paintMode() {
    $("bnBalanceLabel").textContent = isDemo() ? "CREDITS" : "GHS";
    $("bnStakeUnit").textContent = isDemo() ? "CREDITS" : "GHS";
    $("bnBalance").textContent = Number(isDemo() ? demoCredits : U.wallet.balance()).toLocaleString("en-GH", {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
    $("bnMode").textContent = isDemo() ? "Play for real" : "Try free";
    $("bnMode").setAttribute("aria-label", isDemo() ? "Switch to real-money play" : "Switch to free demo play");
  }

  function paintBoard() {
    const r = race();
    const stake = r ? r.stake : Number(stakeIn.value) || 0;
    const value = r ? (r.status === "BUSTED" ? 0 : r.status === "ACTIVE" ? r.value : r.payout) : 0; /* the server's figure, to the pesewa */
    $("bnStakeShow").textContent = ghs(stake);
    $("bnValue").textContent = ghs(value);
    $("bnCashVal").textContent = ghs(r && r.status === "ACTIVE" ? r.value : 0);
    const pl = r ? value - stake : 0;
    $("bnPl").textContent = r ? signed(Math.round(pl * 100) / 100) : ghs(0);
    $("bnPl").className = pl > 0 ? "up" : pl < 0 ? "down" : "";
    $("bnValue").className = r && value > r.stake ? "up" : r && value < r.stake ? "down" : "";
    $("bnX").textContent = (r && r.status === "BUSTED" ? 0 : st.shownX).toFixed(2) + "×";
  }
  function setStatus(text, lead) {
    if ($("bnStatus").textContent !== text) $("bnStatus").textContent = text;
    if (lead) stage.dataset.lead = lead; else delete stage.dataset.lead;
  }

  /* every frame: ease the shown score toward the latest step, publish the view for the 3D stage, update the graphics */
  function frame(ts) {
    const dt = Math.min(0.1, (ts - (st.last || ts)) / 1000);
    st.last = ts;
    const r = race();
    const t = now();
    const busted = r && r.status === "BUSTED";
    const tx = busted ? Math.min(st.shownX, targetX() || st.shownX) : targetX();
    st.shownX += (tx - st.shownX) * Math.min(1, dt * (reduce ? 20 : 5));
    if (busted) st.shownX = Math.max(0.0001, st.shownX);
    const lead = r ? Math.max(-1, Math.min(1, edge(Math.max(st.shownX, 0.05)) / Math.log(2.4))) : 0;
    const phase = !r ? "idle" : r.status !== "ACTIVE" ? "ended" : t < startsAt() ? "countdown" : "running";
    const prog = !r ? 0 : r.status !== "ACTIVE" ? Math.min(1, (r.ended_step || 0) / st.rules.steps) : Math.max(0, Math.min(1, (t - startsAt()) / (st.rules.steps * st.rules.step_ms)));
    window.BNC_VIEW = { phase, lead: busted ? Math.min(lead, -0.6) : lead, prog, ended: r && r.status !== "ACTIVE" ? r.status : null, raceId: r ? r.race_id : null };
    stage.dataset.phase = phase;
    /* tug of war: green's share of the bar */
    const share = 50 + (busted ? -50 : lead * 50);
    $("bnTugG").style.width = share.toFixed(1) + "%";
    $("bnTugR").style.width = (100 - share).toFixed(1) + "%";
    $("bnTugMark").style.left = share.toFixed(1) + "%";
    $("bnProgress").style.width = (prog * 100).toFixed(1) + "%";
    $("bnDist").textContent = Math.round(prog * 160) + " m";
    if (phase === "running") setStatus(lead > 0.01 ? "Green leads · you're up" : lead < -0.01 ? "Red leads · you're down" : "Neck and neck", lead > 0.01 ? "green" : lead < -0.01 ? "red" : "");
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
      tone(up ? 760 : 300, 0.07, "triangle", 0.025);
    }
    st.race = r;
    if (r.status === "ACTIVE") narrate(r, prev);
    $("bnHashRow").hidden = !!r.is_demo;
    if (!r.is_demo) {
      $("bnHash").textContent = r.hash.slice(0, 18) + "…" + r.hash.slice(-6);
      $("bnHash").title = r.seed ? "Seed: " + r.seed : r.hash;
    }
    if (r.status !== "ACTIVE") ended(r);
  }
  function ended(r) {
    if (st.shownResult === r.race_id) return;
    st.shownResult = r.race_id;
    st.polling = false;
    const res = $("bnResult");
    res.hidden = false;
    if (r.status === "BUSTED") {
      res.className = "bn-result lose";
      res.innerHTML = "<small>RACE RESULT</small><b>Red broke away</b><span>The stake of " + ghs(r.stake) + " is lost.</span>";
      setStatus("Red won the race", "red");
      say("OH NO! RED BREAKS AWAY! That's the end of the race.", true, 2);
      tone(220, 0.5, "sawtooth", 0.05, 110);
      roar(0.5);
    } else {
      const profit = Math.round((r.payout - r.stake) * 100) / 100;
      const x = Number(r.x).toFixed(2);
      res.className = "bn-result " + (r.payout >= r.stake ? "win" : "lose");
      res.innerHTML = "<small>" + (r.status === "CASHED" ? "CASHED OUT" : "FINISH") + "</small><b>" + ghs(r.payout) + "</b><span>" + (r.status === "CASHED" ? "Cashed out at " + x + "×" : "Finish line at " + x + "×") +
        " · " + signed(profit) + "</span>";
      setStatus(r.status === "CASHED" ? "Cashed out" : "Race finished", r.payout >= r.stake ? "green" : "red");
      say(r.status === "CASHED" ? (r.payout >= r.stake ? "CASHED OUT! " + ghs(r.payout) + " banked at " + x + "×!" : "Cashed out at " + x + "× — " + ghs(r.payout) + " back.")
        : (r.payout >= r.stake ? "GREEN CROSSES THE LINE IN FRONT! WHAT A FINISH!" : "Red takes it at the line! Finished at " + x + "×."), true, 2);
      roar(1);
      [523, 659, 784, 1046].forEach((fq, i) => setTimeout(() => tone(fq, 0.22, "triangle", 0.05), i * 90));
    }
    st.shownX = r.status === "BUSTED" ? st.shownX : Number(r.x) || st.shownX;
    $("bnCash").hidden = true;
    $("bnGo").hidden = false;
    $("bnGo").disabled = false;
    $("bnGo").querySelector("span").textContent = "GO";
    stakeIn.disabled = false;
    if (isDemo()) {
      $("bnHistory").innerHTML = '<p class="bn-none">Free-play races use virtual credits and are not saved.</p>';
      paintMode();
    } else loadState(true);
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
        if (r.data.balance !== undefined) {
          U.wallet.setBalance(r.data.balance);
          paintMode();
        }
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
        tone(label === "GO!" ? 880 : 440, label === "GO!" ? 0.45 : 0.18, "square", 0.05);
        if (label === "3") say("On your marks...", true, 0);
        if (label === "1") say("Get set...", true, 0);
        if (label === "GO!") { setStatus("They're off!", ""); say(pick(["AND THEY'RE OFF! What an incredible start!", "AND THEY'RE AWAY! Here we go!"]), true, 2); roar(0.9); }
      }
      requestAnimationFrame(tick);
    };
    tick();
  }
  function begin(r) {
    st.shownResult = null;
    st.shownX = 1;
    Object.assign(story, { sign: 0, half: false, final: false, far: false, behind: false });
    $("bnResult").hidden = true;
    adopt(r);
    if (r.status === "ACTIVE") {
      const started = r.starts_in_ms <= 0;
      setStatus(started ? "Racing" : "On your marks…", "");
      if (!started) say("The runners are getting ready... they step up to the line.", true, 0);
      $("bnGo").hidden = true;
      $("bnCash").hidden = false;
      $("bnCash").disabled = false;
      stakeIn.disabled = true;
      countdown();
      if (r.is_demo) demoLoop(r);
      else poll();
    }
  }

  function demoLoop(r) {
    const next = () => {
      if (!running() || race() !== r) return;
      const left = startsAt() - now();
      if (left > 0) {
        setTimeout(next, Math.min(left, 250));
        return;
      }
      const stepNo = r.step + 1;
      if (stepNo > r._path.length) return;
      const event = r._path[stepNo - 1];
      r.step = stepNo;
      if (event === "B") {
        r.status = "BUSTED";
        r.x = 0;
        r.value = 0;
        r.payout = 0;
        r.ended_step = stepNo;
      } else {
        r.xs.push(r.xs[r.xs.length - 1] * (event === "U" ? st.rules.up : st.rules.down));
        r.x = r.xs[r.xs.length - 1];
        r.value = Math.floor(Math.min(r.stake * st.rules.rtp * r.x, st.rules.max_win) * 100 + 1e-6) / 100;
        if (r.value >= st.rules.max_win || stepNo >= st.rules.steps) {
          r.status = "FINISHED";
          r.payout = r.value;
          r.ended_step = stepNo;
        }
      }
      if (r.status !== "ACTIVE") settleDemoPayout(r);
      r.starts_in_ms = r._startsAt - Date.now();
      r.server_now = new Date().toISOString();
      adopt(r);
      if (running()) setTimeout(next, st.rules.step_ms);
    };
    setTimeout(next, Math.max(0, startsAt() - now()));
  }

  function settleDemoPayout(r) {
    if (r._demoSettled) return;
    r._demoSettled = true;
    if (r.payout > 0) demoCredits = Math.round((demoCredits + r.payout) * 100) / 100;
    paintMode();
  }

  function makeDemoRace(stake) {
    const demoBustChance = 0.001;
    const demoUpChance = 0.5;
    const path = Array.from({ length: st.rules.steps }, () => {
      const n = Math.random();
      return n < demoBustChance ? "B" : n < demoBustChance + (1 - demoBustChance) * demoUpChance ? "U" : "D";
    });
    const startedAt = Date.now() + st.rules.start_ms;
    const id = "demo-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    return {
      race_id: id, is_demo: true, status: "ACTIVE", stake, hash: "", starts_in_ms: st.rules.start_ms,
      step_ms: st.rules.step_ms, steps: st.rules.steps, xs: [1], step: 0, x: 1,
      value: Math.floor(stake * st.rules.rtp * 100 + 1e-6) / 100, payout: 0,
      server_now: new Date().toISOString(), _startsAt: startedAt, _path: path,
    };
  }

  $("bnMode").addEventListener("click", async () => {
    if (st.busy || running()) {
      U.toast("Finish the current race before switching play mode.");
      return;
    }
    if (isDemo()) {
      if (!U.session.get()) {
        U.toast("Log in to play for real money.");
        location.href = "register.html#login";
        return;
      }
      mode = "real";
      history.replaceState(null, "", "?mode=real");
      st.race = null;
      st.shownResult = null;
      st.shownX = 1;
      $("bnResult").hidden = true;
      $("bnHashRow").hidden = true;
      $("bnCash").hidden = true;
      $("bnGo").hidden = false;
      await loadState(false);
    } else {
      mode = "fun";
      history.replaceState(null, "", "?mode=fun");
      demoCredits = [1000, 2000, 3000][Math.floor(Math.random() * 3)];
      st.race = null;
      st.shownResult = null;
      st.shownX = 1;
      st.history = [];
      $("bnResult").hidden = true;
      $("bnHashRow").hidden = true;
      $("bnCash").hidden = true;
      $("bnGo").hidden = false;
      $("bnHistory").innerHTML = '<p class="bn-none">Free-play races use virtual credits and are not saved.</p>';
    }
    paintMode();
    paintBoard();
  });

  $("bnGo").addEventListener("click", async () => {
    if (st.busy || running()) return;
    clampStake();
    const stake = Number(stakeIn.value);
    if (!(stake >= st.rules.min_bet && stake <= st.rules.max_bet)) { U.toast("Stake between " + ghs(st.rules.min_bet) + " and " + ghs(st.rules.max_bet) + ".", "error"); return; }
    if (isDemo()) {
      if (!U.freePlay.allowed("bnc-win")) { U.toast("Free play is not available for BNC WIN right now.", "error"); return; }
      if (stake > demoCredits) { U.toast("Not enough free credits for that stake.", "error"); return; }
      ctx();
      tone(520, 0.08, "square", 0.04);
      demoCredits = Math.round((demoCredits - stake) * 100) / 100;
      begin(makeDemoRace(stake));
      paintMode();
      return;
    }
    if (!U.session.get()) { U.toast("Log in to race for real money."); location.href = "register.html#login"; return; }
    st.busy = true;
    $("bnGo").disabled = true;
    $("bnGo").querySelector("span").textContent = "…";
    ctx(); /* the stadium sound starts on the player's press */
    tone(520, 0.08, "square", 0.04);
    const r = await U.paymentApi(API + "/race", { body: { stake, idempotency_key: "bnc:" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2)) } });
    st.busy = false;
    if (!r.ok || !r.data || !r.data.race) {
      $("bnGo").disabled = false;
      $("bnGo").querySelector("span").textContent = "GO";
      const msg = (r.data && (r.data.message || r.data.error)) || "Couldn't start the race — try again.";
      U.toast(msg, "error");
      if (r.data && r.data.error === "race_running") loadState(false);
      return;
    }
    U.wallet.setBalance(r.data.balance);
    paintMode();
    begin(r.data.race);
  });

  $("bnCash").addEventListener("click", async () => {
    if (!running() || $("bnCash").disabled) return;
    if (now() < startsAt()) { U.toast("Wait for the start — the race begins on GO."); return; }
    if (race().is_demo) {
      const r = race();
      const reached = Math.max(0, Math.min(r.steps, Math.floor((Date.now() - r._startsAt) / r.step_ms)));
      const event = r._path.slice(r.step, reached);
      for (const tick of event) {
        const no = r.step + 1;
        r.step = no;
        if (tick === "B") {
          r.status = "BUSTED"; r.x = 0; r.value = 0; r.payout = 0; r.ended_step = no;
          break;
        }
        r.xs.push(r.xs[r.xs.length - 1] * (tick === "U" ? st.rules.up : st.rules.down));
        r.x = r.xs[r.xs.length - 1];
        r.value = Math.floor(Math.min(r.stake * st.rules.rtp * r.x, st.rules.max_win) * 100 + 1e-6) / 100;
        if (r.value >= st.rules.max_win || no >= r.steps) {
          r.status = "FINISHED"; r.payout = r.value; r.ended_step = no;
          break;
        }
      }
      if (r.status === "ACTIVE") {
        r.status = "CASHED"; r.payout = r.value; r.ended_step = r.step;
      }
      settleDemoPayout(r);
      r.starts_in_ms = r._startsAt - Date.now();
      r.server_now = new Date().toISOString();
      adopt(r);
      paintMode();
      return;
    }
    $("bnCash").disabled = true; /* one press is one cash-out; the server also pays a race only once */
    const r = await U.paymentApi(API + "/race/cashout", { body: { race_id: race().race_id, idempotency_key: "bnc-cash:" + race().race_id } });
    if (r.ok && r.data && r.data.race) {
      U.wallet.setBalance(r.data.balance);
      paintMode();
      adopt(r.data.race);
    } else {
      $("bnCash").disabled = false;
      U.toast((r.data && (r.data.message || r.data.error)) || "Couldn't cash out — try again.", "error");
    }
  });

  /* stake */
  function paintChips() { document.querySelectorAll("[data-chip]").forEach((b) => b.classList.toggle("on", Number(b.dataset.chip) === Number(stakeIn.value))); }
  function clampStake() {
    let v = Math.round((Number(stakeIn.value) || 0) * 100) / 100;
    v = Math.min(Math.max(v, st.rules.min_bet), st.rules.max_bet);
    stakeIn.value = String(v);
    paintChips();
    paintBoard();
  }
  stakeIn.addEventListener("change", clampStake);
  stakeIn.addEventListener("input", () => { paintChips(); paintBoard(); });
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
      "<p><b>A virtual race.</b> BNC WIN Racing is a computer-drawn race shown in the style of a TV broadcast, with commentary. It is not a real-world event and the athletes are not real people. " +
      (isDemo() ? "Free play uses virtual credits only and does not affect your wallet." : "") + "</p>" +
      "<ol>" +
      "<li>Enter your stake and press <b>GO</b>. " + (isDemo() ? "The stake is taken from your virtual credits." : "The stake is taken from your balance once.") +
      " The race starts after a 3-second countdown.</li>" +
      "<li>The race lasts " + (R.steps * R.step_ms / 1000) + " seconds, in " + R.steps + " steps of half a second. Your runner is <b style='color:#6ff0a4'>green</b>. Green is shown ahead exactly while your cash-out value is above your stake, and <b style='color:#ff8a84'>red</b> ahead while it's below; the gap between them is how far above or below.</li>" +
      "<li>Press <b>CASH OUT</b> whenever you like: " + (isDemo() ? "the cash-out value is returned to your virtual credits." : "the server pays the cash-out value to your balance when it receives your request.") +
      " A race can be cashed out only once.</li>" +
      "<li>If you don't cash out, the race pays the value at the finish line. If red breaks away, the race ends at once and the stake is lost.</li>" +
      "</ol>" +
      "<p><b>How the value is worked out.</b> The race score starts at 1.00×. " +
      (isDemo() ? "Every free-play step is randomly simulated in your browser." : "Every real-money step is drawn by the server.") + "</p>" +
      "<table><tr><th>Step</th><th>Chance</th><th>Race score</th></tr>" +
      "<tr><td>Green surges</td><td>" + pct(R.up_chance) + "</td><td>× " + R.up + "</td></tr>" +
      "<tr><td>Red surges</td><td>" + pct(R.down_chance) + "</td><td>× " + R.down + "</td></tr>" +
      "<tr><td>Red breaks away</td><td>" + pct(R.bust) + "</td><td>race lost</td></tr></table>" +
      "<p><b>Cash-out value = stake × " + Math.round(R.rtp * 100) + "% × race score</b>, rounded down to the pesewa, up to the top win of " + ghs(R.max_win) +
      " (a race that gets there cashes itself out). So at the start, before any step, the value is " + Math.round(R.rtp * 100) + "% of the stake.</p>" +
      "<p><b>Return to player: " + Math.round(R.rtp * 100) + "%.</b> The steps are balanced, so on average a race returns " + Math.round(R.rtp * 100) +
      "% of the stake whenever you cash out — no timing does better in the long run. Results vary a lot from race to race: about " +
      Math.round((1 - Math.pow(1 - R.bust, R.steps)) * 100) + "% of races that run to the end have red break away, and you can lose your whole stake.</p>" +
      (isDemo()
        ? "<p>Demo outcomes are for trying the game only. They are not server-verified and cannot win real money.</p>"
        : "<p><b>Fairness.</b> The whole race is drawn from a secret seed the moment you press GO — never from your stake, your balance, your account or when you cash out. " +
          "Its fingerprint (SHA-256) is shown during the race; the seed is shown in your race history afterwards, so the steps can be checked. " +
          "The athletes, the cameras and the commentary only show the race score the server has already drawn; they can't change it.</p>") +
      "<p>18+ only. Play only with money you can afford to lose. You can set limits or take a break from My account.</p>";
  }
  const openRules = () => $("bnRules").showModal();
  $("bnRulesBtn").addEventListener("click", openRules);
  $("bnRulesLink").addEventListener("click", openRules);

  async function loadState(quiet) {
    if (isDemo()) {
      $("bnHistory").innerHTML = '<p class="bn-none">Free-play races use virtual credits and are not saved.</p>';
      const r = await U.paymentApi(API + "/rules");
      if (r.ok && r.data) Object.assign(st.rules, r.data);
      paintRules();
      paintMode();
      return;
    }
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
    paintMode();
    if (r.data.race && r.data.race.status === "ACTIVE" && !running()) begin(r.data.race); /* a reload carries on */
  }

  U.freePlay.enforce("bnc-win", { mode, canReal: !!U.session.get() });
  if (mode === "real" && !U.session.get()) {
    mode = "fun";
    history.replaceState(null, "", "?mode=fun");
  }
  setStatus("Ready to race", "");
  $("bnCommText").textContent = "Welcome to BNC WIN Racing! The athletes are warming up — set your stake and press GO.";
  paintRules();
  paintChips();
  paintMode();
  loadState(false);
  U.refreshBalance().then(paintMode);
  requestAnimationFrame(frame);
})();
