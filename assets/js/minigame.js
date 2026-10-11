/* WIN B casino mini-games: what the house games share. The balance (fun credits or the demo wallet), the bet slider and
   chips, the header menu (mode, top-up, sound, rules, chat), sounds, confetti and screen-reader announcements.
   Each game page uses the same markup with its own id prefix (sbBalance, rbBalance, …) and calls VBMini.create(). */
(function (global) {
  "use strict";
  const U = global.VBUtil;
  const SOUND_KEY = "voltabet.sound";
  const CHIP_COLORS = { 0.1: "#78909c", 0.2: "#78909c", 0.5: "#78909c", 1: "#1e88e5", 5: "#e53935", 10: "#2e7d32", 50: "#ef6c00", 100: "#263238", 500: "#7b1fa2", 1000: "#b8860b" };
  const reduceMotion = global.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const money = (n) => n.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const round2 = (n) => Math.round(n * 100) / 100;

  /* a dialog that closes when its dimmed backdrop is tapped (a click outside the dialog's own box) */
  function backdropClose(dialog) {
    dialog.addEventListener("click", (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    });
  }

  /* opts: prefix, gameId, minBet, tableMax, chips, funCredits,
     busy() — true while a round is being settled (no switching modes then), busyText,
     onChange() — repaint the game after the balance or mode changes from the menu or another tab,
     confettiFrom() — the element the confetti bursts from */
  function create(opts) {
    const $ = (name) => document.getElementById(opts.prefix + name);
    const params = new URLSearchParams(location.search);
    const FUN_CREDITS = opts.funCredits || 3000;
    const MIN_BET = opts.minBet;
    const menu = $("Menu");
    const menuBtn = $("MenuBtn");
    U.recent.add(opts.gameId);

    const announce = (msg) => ($("Live").textContent = msg);

    /* ---------------- balance: free credits, or real money settled by the server ---------------- */
    /* real money needs a signed-in player and a game the server can play (opts.server); local test builds keep
       the old browser-only test wallet for games that aren't on the server yet */
    const signedIn = !!U.session.get();
    const serverPlay = !!opts.server && signedIn;
    const realAllowed = serverPlay || U.testMode;
    let mode = realAllowed && params.get("mode") === "real" ? "real" : "fun";
    let fun = FUN_CREDITS;
    const balance = () => (mode === "real" ? U.wallet.balance() : fun);

    /* moves money in or out; anything coming in floats up under the balance, and a new stake clears it */
    function move(delta) {
      if (mode === "real") U.wallet.setBalance(U.wallet.balance() + delta);
      else fun = round2(fun + delta);
      paintBalance();
      if (delta > 0) flashDelta(delta);
      else clearDelta();
    }

    function paintBalance() {
      $("Balance").textContent = money(balance());
      $("BalLabel").textContent = mode === "fun" ? "Credits" : "Wallet";
      $("BalLabel").classList.toggle("is-fun", mode === "fun");
      $("TopUp").hidden = mode !== "fun";
      menu.querySelectorAll("[data-mode]").forEach((b) => {
        b.hidden = b.dataset.mode === "real" && !realAllowed;
        b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
      });
      menu.querySelectorAll('a[href^="wallet.html"]').forEach((a) => (a.hidden = !signedIn));
    }

    /* A round's stake. With free credits (or the local test wallet) it's taken here and the game draws the result;
       for real money the server draws it and settles the ledger, and this returns its answer: { outcome, payout,
       balance }. null = the game decides; false = the bet didn't go through (a message has been shown). */
    let pendingBalance = null;
    async function place(stake, choice) {
      if (!(mode === "real" && serverPlay)) {
        move(-stake);
        return null;
      }
      const r = await U.paymentApi("/api/games/" + encodeURIComponent(opts.gameId) + "/play", {
        body: { stake, choice, idempotency_key: "round:" + crypto.randomUUID() }
      });
      if (!r.ok) {
        U.toast((r.data && (r.data.message || r.data.error)) || "Couldn't place the bet. Try again.", "err");
        U.refreshBalance().then(() => { paintBalance(); opts.onChange(); });
        return false;
      }
      pendingBalance = r.data.balance;
      U.wallet.setBalance(round2(r.data.balance - r.data.payout)); /* the stake has gone; a win shows at collect() */
      clearDelta();
      paintBalance();
      return r.data;
    }
    /* pays a round's win: free credits locally; for real money the server already did, so show its balance */
    function collect(win) {
      if (mode === "real" && serverPlay) {
        if (pendingBalance !== null) U.wallet.setBalance(pendingBalance);
        pendingBalance = null;
        paintBalance();
        if (win > 0) flashDelta(win);
        return;
      }
      if (win > 0) move(win);
    }

    /* step-by-step games (Mines, Crossing, Goal): "start", "step", "cashout" or "open" on the server. Resolves with
       its answer, or false when it didn't go through (a message has been shown and the balance re-read). */
    async function request(action, body) {
      const r = await U.paymentApi("/api/games/" + encodeURIComponent(opts.gameId) + "/" + action, body === undefined ? {} : { body });
      if (!r.ok) {
        U.toast((r.data && (r.data.message || r.data.error)) || "Couldn't reach the game server. Try again.", "err");
        U.refreshBalance().then(() => { paintBalance(); opts.onChange(); });
        return false;
      }
      return r.data;
    }
    /* shows the balance the server reported, floating up any win */
    function showBalance(balance, win) {
      U.wallet.setBalance(balance);
      paintBalance();
      if (win > 0) flashDelta(win);
      else clearDelta();
    }

    let deltaTimer = 0;
    function flashDelta(delta) {
      const el = $("Delta");   /* optional: a game can skip the pill and just bump the balance */
      const bal = $("Balance").parentElement;
      bal.classList.remove("bump");
      if (el) {
        el.textContent = "+GHS " + money(delta);
        el.classList.remove("show");
      }
      void bal.offsetWidth; /* restart the animations */
      bal.classList.add("bump");
      if (el) el.classList.add("show");
      clearTimeout(deltaTimer);
      deltaTimer = setTimeout(clearDelta, 1800);
    }

    function clearDelta() {
      clearTimeout(deltaTimer);
      const el = $("Delta");
      if (el) el.classList.remove("show");
      $("Balance").parentElement.classList.remove("bump");
    }

    /* refuses a stake the balance can't cover, with a hint on what to do */
    function canAfford(stake) {
      if (stake <= balance() + 1e-9) return true;
      if (mode !== "fun" && U.moneyInDollars && U.moneyInDollars() > 0) {
        U.toast("Your money is in US dollars — switch to cedis from the balance menu at the top to play.", "err");
        return false;
      }
      U.toast(mode === "fun"
        ? "Not enough credits — top up from the menu."
        : "Not enough in your wallet — please deposit from the wallet.", "err");
      return false;
    }

    /* ---------------- bet amount: a log-scale slider plus chips ---------------- */
    const slider = $("Slider");   /* optional: a game can offer chips and its own − / + instead */
    const chipHost = $("Chips");
    let amount = MIN_BET;
    let lastBusy = false;

    const maxBet = () => Math.max(MIN_BET, Math.min(opts.tableMax, Math.floor(balance() * 100) / 100));
    const clampBet = (v) => Math.min(maxBet(), Math.max(MIN_BET, round2(v)));
    /* round slider values to steps that feel natural at each size */
    const nice = (v) => {
      const step = v < 10 ? 0.1 : v < 100 ? 1 : v < 1000 ? 5 : 50;
      return Math.round(v / step) * step;
    };
    const span = () => Math.log(maxBet() / MIN_BET);
    const toSlider = (v) => (span() > 0 ? Math.round((1000 * Math.log(v / MIN_BET)) / span()) : 0);
    const fromSlider = (s) => clampBet(nice(MIN_BET * Math.exp((span() * s) / 1000)));

    (chipHost ? opts.chips : []).forEach((v) => {   /* optional: a game can have no chips at all */
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mg-chip";
      b.dataset.chip = v;
      b.style.setProperty("--c", CHIP_COLORS[v] || "#546e7a");
      b.textContent = v;
      b.setAttribute("aria-label", "Bet GHS " + money(v));
      chipHost.appendChild(b);
    });
    const chips = chipHost ? Array.from(chipHost.children) : [];

    function paintBet(busy) {
      lastBusy = !!busy;
      amount = clampBet(amount);
      if ($("Amount")) $("Amount").textContent = money(amount);   /* optional: some games show chips, not an amount */
      if (slider) {
        const s = toSlider(amount);
        slider.value = s;
        slider.style.setProperty("--fill", s / 10 + "%");
        slider.setAttribute("aria-valuetext", "GHS " + money(amount));
        slider.disabled = busy;
      }
      chips.forEach((c) => {
        const v = Number(c.dataset.chip);
        c.classList.toggle("on", v === amount);
        c.disabled = busy || v > maxBet();
      });
    }

    if (slider) {
      slider.addEventListener("input", () => {
        amount = fromSlider(Number(slider.value));
        paintBet(false);
      });
    }
    if (chipHost) {
      chipHost.addEventListener("click", (e) => {
        const chip = e.target.closest("[data-chip]");
        if (!chip || chip.disabled) return;
        amount = clampBet(Number(chip.dataset.chip));
        paintBet(false);
      });
    }

    /* sets the bet from code (a game's own − / + buttons), kept within the limits */
    function setBet(v) {
      amount = clampBet(v);
      paintBet(lastBusy);
    }

    /* ---------------- sound ---------------- */
    let soundOn = true;
    try {
      soundOn = localStorage.getItem(SOUND_KEY) !== "off";
    } catch (e) { /* storage unavailable */ }
    let audio = null;

    /* browsers only allow sound after a tap, so the audio context starts on the bet click */
    function unlockAudio() {
      if (!soundOn) return;
      try {
        audio = audio || new (global.AudioContext || global.webkitAudioContext)();
        if (audio.state === "suspended") audio.resume();
      } catch (e) {
        audio = null;
      }
    }

    /* a rising four-note arpeggio for a win */
    function chime() {
      if (!soundOn || !audio) return;
      const t = audio.currentTime;
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        const at = t + i * 0.09;
        osc.type = "triangle";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.18, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, at + 0.5);
        osc.connect(gain).connect(audio.destination);
        osc.start(at);
        osc.stop(at + 0.55);
      });
    }

    /* the snap of a card being turned: a short burst of filtered noise */
    function flick() {
      if (!soundOn || !audio) return;
      const len = Math.floor(audio.sampleRate * 0.09);
      const buf = audio.createBuffer(1, len, audio.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      const src = audio.createBufferSource();
      const band = audio.createBiquadFilter();
      const gain = audio.createGain();
      src.buffer = buf;
      band.type = "bandpass";
      band.frequency.value = 2600;
      band.Q.value = 0.8;
      gain.gain.value = 0.5;
      src.connect(band).connect(gain).connect(audio.destination);
      src.start();
    }

    /* a bright ping for a safe pick; `step` raises the pitch a semitone at a time as a streak builds */
    function ping(step) {
      if (!soundOn || !audio) return;
      const t = audio.currentTime;
      const freq = 660 * Math.pow(2, Math.min(step, 24) / 12);
      [freq, freq * 2].forEach((f, i) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = i ? "sine" : "triangle";
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(i ? 0.05 : 0.16, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
        osc.connect(gain).connect(audio.destination);
        osc.start(t);
        osc.stop(t + 0.3);
      });
    }

    /* an explosion: a low thump under a burst of noise that closes down */
    function boom() {
      if (!soundOn || !audio) return;
      const t = audio.currentTime;
      const len = Math.floor(audio.sampleRate * 0.6);
      const buf = audio.createBuffer(1, len, audio.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      const src = audio.createBufferSource();
      const low = audio.createBiquadFilter();
      const noiseGain = audio.createGain();
      src.buffer = buf;
      low.type = "lowpass";
      low.frequency.setValueAtTime(2400, t);
      low.frequency.exponentialRampToValueAtTime(140, t + 0.5);
      noiseGain.gain.value = 0.55;
      src.connect(low).connect(noiseGain).connect(audio.destination);
      src.start(t);
      const thump = audio.createOscillator();
      const thumpGain = audio.createGain();
      thump.type = "sine";
      thump.frequency.setValueAtTime(120, t);
      thump.frequency.exponentialRampToValueAtTime(38, t + 0.35);
      thumpGain.gain.setValueAtTime(0.5, t);
      thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      thump.connect(thumpGain).connect(audio.destination);
      thump.start(t);
      thump.stop(t + 0.42);
    }

    /* ---------------- win feedback: confetti (or a shower of gold coins), a chime, a buzz ---------------- */
    /* a gold coin drawn once, then reused for every coin in the shower (face = the brighter side) */
    function coinImage(face) {
      const S = 48;
      const c = document.createElement("canvas");
      c.width = c.height = S;
      const g = c.getContext("2d");
      const fill = g.createRadialGradient(S * 0.36, S * 0.3, S * 0.04, S * 0.5, S * 0.5, S * 0.5);
      fill.addColorStop(0, face ? "#fff7cc" : "#ffe28f");
      fill.addColorStop(0.45, face ? "#ffcf33" : "#efb300");
      fill.addColorStop(1, face ? "#b77800" : "#8f5d00");
      g.fillStyle = fill;
      g.beginPath();
      g.arc(S / 2, S / 2, S / 2 - 1.5, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 2.5;
      g.strokeStyle = "#7a4f00";
      g.stroke();
      g.beginPath();
      g.arc(S / 2, S / 2, S * 0.32, 0, Math.PI * 2);
      g.lineWidth = 1.6;
      g.strokeStyle = "rgba(255, 250, 220, .6)";
      g.stroke();
      /* a small star stamped in the middle */
      g.beginPath();
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? S * 0.08 : S * 0.19;
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        g[k ? "lineTo" : "moveTo"](S / 2 + r * Math.cos(a), S / 2 + r * Math.sin(a));
      }
      g.closePath();
      g.fillStyle = face ? "#c48600" : "#a06d00";
      g.fill();
      return c;
    }

    function confetti() {
      if (reduceMotion) return;
      const canvas = $("Confetti");
      const ctx = canvas.getContext("2d");
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      const W = canvas.clientWidth;
      const H = canvas.clientHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const colors = opts.confettiColors || ["#4caf50", "#ff9800", "#ffcc00", "#ffffff", "#e91e63", "#29b6f6"];
      const coins = opts.confettiStyle === "coins" ? [coinImage(true), coinImage(false)] : null;
      const origin = opts.confettiFrom().getBoundingClientRect();
      const bits = Array.from({ length: coins ? 90 : 160 }, () => ({
        x: origin.left + origin.width / 2 + (Math.random() - 0.5) * origin.width * 0.5,
        y: origin.top + origin.height * 0.45,
        vx: (Math.random() - 0.5) * 11,
        vy: -Math.random() * 12 - 4,
        size: Math.random() * 6 + 5,
        spin: Math.random() * Math.PI,
        turn: (Math.random() - 0.5) * 0.35,
        color: colors[Math.floor(Math.random() * colors.length)],
        round: Math.random() < 0.3
      }));
      const start = performance.now();
      (function step(now) {
        ctx.clearRect(0, 0, W, H);
        bits.forEach((b) => {
          b.vy += 0.3;
          b.vx *= 0.99;
          b.x += b.vx;
          b.y += b.vy;
          b.spin += b.turn;
          ctx.save();
          ctx.translate(b.x, b.y);
          if (coins) {
            /* a coin flips over as it falls: squeeze it sideways by the cosine of its turn */
            const r = b.size * 0.85;
            const c = Math.cos(b.spin * 3);
            ctx.rotate(b.turn * 2);
            ctx.scale(Math.max(0.12, Math.abs(c)), 1);
            ctx.drawImage(coins[c >= 0 ? 0 : 1], -r, -r, r * 2, r * 2);
            ctx.restore();
            return;
          }
          ctx.rotate(b.spin);
          ctx.fillStyle = b.color;
          if (b.round) {
            ctx.beginPath();
            ctx.arc(0, 0, b.size / 2, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2);
          }
          ctx.restore();
        });
        if (now - start < 2600) requestAnimationFrame(step);
        else ctx.clearRect(0, 0, W, H);
      })(start);
    }

    /* ---------------- themed sounds: each game picks the ones that fit it ---------------- */
    /* a tone with an envelope; glide moves the pitch to `to` over the note */
    function tone(f, type, at, dur, vol, to, attack) {
      const t = audio.currentTime + (at || 0);
      const osc = audio.createOscillator();
      const g = audio.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f, t);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + (attack || 0.008));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(audio.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      return { osc, g };
    }
    /* filtered noise; the filter sweeps from f0 to f1 */
    function noise(at, dur, kind, f0, f1, vol, q, curve) {
      const t = audio.currentTime + (at || 0);
      const len = Math.max(1, Math.floor(audio.sampleRate * dur));
      const buf = audio.createBuffer(1, len, audio.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, curve || 2);
      const src = audio.createBufferSource();
      src.buffer = buf;
      const f = audio.createBiquadFilter();
      f.type = kind;
      f.Q.value = q || 1;
      f.frequency.setValueAtTime(f0, t);
      f.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = audio.createGain();
      g.gain.value = vol;
      src.connect(f).connect(g).connect(audio.destination);
      src.start(t);
    }
    /* a struck metal or glass partial: several inharmonic sines that ring and fade */
    function ring(at, freqs, dur, vol) {
      freqs.forEach((f, i) => tone(f, "sine", at, dur * (1 - i * 0.15), vol / (1 + i * 0.6), null, 0.002));
    }
    const SFX = {
      /* a cash register and coins pouring out (Mines) */
      coins() {
        noise(0, 0.08, "highpass", 3000, 6000, 0.25);
        ring(0.02, [2637, 3520, 5274], 0.5, 0.12);
        for (let i = 0; i < 12; i++) ring(0.12 + i * 0.05 + Math.random() * 0.03, [3200 + Math.random() * 1600, 6100 + Math.random() * 900], 0.18, 0.06);
      },
      /* two glasses touching — cheers (Rendo Bottle) */
      clink() {
        ring(0, [2093, 2960, 4186, 5700], 1.2, 0.16);
        ring(0.14, [2349, 3322, 4699, 6100], 1.1, 0.13);
      },
      /* a glass bottle rolling round on a wooden table, slowing (Rendo Bottle spin) */
      bottleRoll(ms) {
        const dur = ms / 1000;
        noise(0, dur, "bandpass", 900, 260, 0.22, 2.5, 0.7);
        const n = Math.floor(dur * 7);
        for (let i = 0; i < n; i++) ring(Math.pow(i / n, 0.6) * dur, [1600 + Math.random() * 300], 0.05, 0.02);
      },
      /* a hand of cards fanned out, then a warm piano chord (Red Black) */
      cardFan() {
        for (let i = 0; i < 4; i++) noise(i * 0.06, 0.06, "bandpass", 3200, 1800, 0.35, 0.9);
        [261.6, 329.6, 392, 523.3].forEach((f, i) => { tone(f, "triangle", 0.26 + i * 0.03, 1.4, 0.12); tone(f * 2, "sine", 0.26 + i * 0.03, 0.9, 0.04); });
      },
      /* chips pushed across the felt and stacked, and the table bell (Roulette) */
      chipsPayout() {
        for (let i = 0; i < 10; i++) {
          const at = Math.pow(i / 10, 0.8) * 0.55;
          noise(at, 0.035, "bandpass", 2600 + Math.random() * 900, 2200, 0.32, 5);
          tone(1100 + Math.random() * 400, "triangle", at, 0.04, 0.05);
        }
        ring(0.65, [1568, 2349, 3951], 1.4, 0.1);
        ring(0.95, [1568, 2349, 3951], 1.4, 0.08);
      },
      /* dice rattled in a cup, then a short brass "ta-da" (Even-Odd) */
      tada() {
        for (let i = 0; i < 7; i++) noise(i * 0.035, 0.03, "bandpass", 2800 + Math.random() * 1200, 2400, 0.25, 7);
        [[392, 0.32, 0.14], [523.3, 0.46, 0.5]].forEach(([f, at, dur]) => {
          [1, 1.5, 2].forEach((k, j) => tone(f * k, "sawtooth", at, dur, 0.05 / (j + 1), null, 0.02));
        });
      },
      /* a magic shimmer: a fast rising run of bells (Magic Ball) */
      sparkle() {
        [1047, 1175, 1319, 1568, 1760, 2093, 2349, 2637, 3136, 3520].forEach((f, i) => ring(i * 0.045, [f, f * 2.76], 0.6, 0.07));
        noise(0, 0.6, "highpass", 6000, 9000, 0.05);
      },
      /* a cup slid across wood and set down (Magic Ball shuffle) */
      cupSlide() {
        noise(0, 0.16, "lowpass", 900, 300, 0.4, 1, 1);
        tone(160, "sine", 0.14, 0.09, 0.25, 90);
      },
      /* a brass fanfare (Rendo Wings) — big = the full flourish */
      fanfare(big) {
        const notes = big ? [[523.3, 0, 0.14], [659.3, 0.15, 0.14], [784, 0.3, 0.14], [1046.5, 0.45, 0.7]] : [[784, 0, 0.12], [1046.5, 0.13, 0.4]];
        notes.forEach(([f, at, dur]) => [1, 2, 3].forEach((k, j) => tone(f * k, "sawtooth", at, dur, 0.06 / (j + 1.5), null, 0.025)));
      },
      /* tyres touching the deck (Rendo Wings landing) */
      chirp() {
        noise(0, 0.12, "bandpass", 1800, 900, 0.3, 4);
        noise(0.18, 0.1, "bandpass", 1600, 800, 0.2, 4);
      },
      /* a plane going into the sea: a heavy splash and bubbles (Rendo Wings) */
      splash() {
        noise(0, 0.9, "lowpass", 2400, 200, 0.6, 0.7, 1.5);
        for (let i = 0; i < 10; i++) tone(300 + Math.random() * 500, "sine", 0.35 + i * 0.07, 0.07, 0.05, 900 + Math.random() * 600);
      },
      /* flying through a pickup: a rising whoosh with a bright tail, higher for bigger pickups (Rendo Wings) */
      pickup(step) {
        const f = 500 * Math.pow(2, Math.min(step || 0, 12) / 12);
        tone(f, "sine", 0, 0.25, 0.12, f * 3);
        noise(0, 0.22, "bandpass", 1200, 5000, 0.12, 1.5);
        ring(0.18, [f * 4, f * 6.1], 0.35, 0.04);
      },
      /* a boot striking a leather ball: a soft low thud with a slap on top, a touch higher each column (Rendo Goal) */
      kick(step) {
        tone(140 + (step || 0) * 8, "sine", 0, 0.16, 0.45, 60);
        noise(0, 0.05, "bandpass", 1800, 900, 0.35, 1.2);
      },
      /* the referee's two-blast whistle, then the crowd roaring (Rendo Goal) — big = a longer, louder roar */
      crowd(big) {
        [0, 0.28].forEach((at) => {
          const w = tone(2900, "square", at, 0.2, 0.05, null, 0.01);
          const lfo = audio.createOscillator();
          const dep = audio.createGain();
          lfo.frequency.value = 38;   /* the pea rattling in the whistle */
          dep.gain.value = 140;
          lfo.connect(dep).connect(w.osc.frequency);
          lfo.start(audio.currentTime + at);
          lfo.stop(audio.currentTime + at + 0.22);
        });
        const dur = big ? 2.6 : 1.4;
        const t = audio.currentTime + 0.35;
        const len = Math.floor(audio.sampleRate * dur);
        const buf = audio.createBuffer(1, len, audio.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        const src = audio.createBufferSource();
        src.buffer = buf;
        const bp = audio.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 900;
        bp.Q.value = 0.6;
        const g = audio.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(big ? 0.35 : 0.2, t + 0.5);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        src.connect(bp).connect(g).connect(audio.destination);
        src.start(t);
      },
      /* a coin flicked off the thumb: a bright metallic ping and the whirr of it spinning (Rendo Coin) */
      coinFlip() {
        ring(0, [2800, 4100, 6200], 0.7, 0.12);
        for (let i = 0; i < 14; i++) noise(0.05 + i * 0.07, 0.04, "bandpass", 3000, 3800, 0.05 * (1 - i / 16), 6);
      },
      /* the coin landing on the table: a ringing clink, softer on each bounce (Rendo Coin) */
      coinLand(k) {
        const v = Math.max(0.15, k || 1);
        ring(0, [3100, 4700, 7300], 0.35 * v + 0.1, 0.12 * v);
        noise(0, 0.03, "highpass", 4000, 6000, 0.2 * v, 1);
      },
      /* a win: a shower of coins on wood and a bright bell (Rendo Coin) */
      coinWin() {
        ring(0, [1568, 2349, 3136], 1.1, 0.12);
        for (let i = 0; i < 16; i++) ring(0.1 + i * 0.045 + Math.random() * 0.03, [2400 + Math.random() * 2600, 5200 + Math.random() * 1500], 0.2, 0.05);
      },
      /* an engine coughing and dying: a few rough bangs, slowing, then a whine winding down (Rendo Wings) */
      sputter() {
        [0, 0.16, 0.38, 0.66].forEach((at, i) => {
          noise(at, 0.09, "lowpass", 900, 200, 0.4 - i * 0.07, 1);
          tone(70 - i * 8, "sawtooth", at, 0.08, 0.08);
        });
        tone(240, "triangle", 0.7, 1.4, 0.05, 60);
      },
      /* a hen's "bok" as she hops (Rendo Crossing) */
      cluck(step) {
        const f = 520 + Math.min(step || 0, 10) * 12;
        const { osc } = tone(f, "square", 0, 0.09, 0.06, f * 0.62);
        void osc;
        noise(0, 0.05, "bandpass", 1400, 900, 0.12, 3);
      },
      /* a car hitting something soft: a dull thump and a little rattle of the bumper (Rendo Crossing) */
      thump() {
        tone(110, "sine", 0, 0.25, 0.5, 45);
        noise(0, 0.18, "lowpass", 1200, 200, 0.45);
        noise(0.04, 0.12, "highpass", 2500, 4000, 0.08);
      },
      /* a cheerful whistled tune (Rendo Crossing cash-out) */
      whistle(big) {
        const tune = big ? [784, 988, 1175, 1568, 1175, 1568] : [988, 1319];
        tune.forEach((f, i) => {
          const n = tone(f, "sine", i * 0.11, 0.16, 0.12, null, 0.02);
          const lfo = audio.createOscillator();
          const dep = audio.createGain();
          lfo.frequency.value = 7;
          dep.gain.value = f * 0.015;
          lfo.connect(dep).connect(n.osc.frequency);
          lfo.start(audio.currentTime + i * 0.11);
          lfo.stop(audio.currentTime + i * 0.11 + 0.2);
        });
      },
      /* a crystal harp pluck, climbing with each tumble (Rendo Olympus) */
      harp(step) {
        const scale = [523.3, 587.3, 659.3, 784, 880, 1046.5, 1174.7, 1318.5, 1568, 1760, 2093, 2349, 2637];
        const f = scale[Math.min(step || 0, scale.length - 1)];
        tone(f, "triangle", 0, 0.9, 0.14, null, 0.003);
        tone(f * 2, "sine", 0, 0.6, 0.05, null, 0.003);
      },
      /* Zeus's thunder: a sharp crack and a long rolling rumble (Rendo Olympus orbs) */
      thunder() {
        noise(0, 0.12, "highpass", 1500, 5000, 0.5, 0.8, 1);
        noise(0.05, 2.2, "lowpass", 900, 60, 0.7, 0.8, 1.2);
        tone(55, "sine", 0.05, 1.6, 0.3, 32);
      },
      /* a temple bell (Rendo Olympus scatters) */
      bell() {
        ring(0, [523.3, 1046.5, 1318.5, 1567, 2093], 2.2, 0.14);
      },
      /* heavenly: a harp glissando over a choir-like pad (Rendo Olympus wins) */
      heavenly(big) {
        [523.3, 659.3, 784, 1046.5, 1318.5, 1568, 2093].forEach((f, i) => tone(f, "triangle", i * 0.05, 1, 0.08, null, 0.003));
        if (!big) return;
        [261.6, 329.6, 392, 523.3].forEach((f) => [0.996, 1.004].forEach((d) => tone(f * d, "sawtooth", 0.2, 2.4, 0.025, null, 0.6)));
      }
    };
    /* plays a named sound (only once the player's tap has started the audio, and only with sound on) */
    function play(name, arg) {
      if (!soundOn || !audio || !SFX[name]) return;
      try {
        SFX[name](arg);
      } catch (e) {
        console.warn("sound " + name + " failed:", e);   /* a missing audio feature shouldn't stop the game */
      }
    }

    /* confetti or coins, the game's own win sound (opts.winSound, else the arpeggio), and a buzz */
    function celebrate(sound) {
      confetti();
      if (sound || opts.winSound) play(sound || opts.winSound, true);
      else chime();
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    }

    /* ---------------- header: menu, chat, rules, sound ---------------- */
    const setMenu = (open) => {
      menu.hidden = !open;
      menuBtn.setAttribute("aria-expanded", String(open));
    };
    menuBtn.addEventListener("click", () => setMenu(menu.hidden));
    document.addEventListener("click", (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) setMenu(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) {
        setMenu(false);
        menuBtn.focus();
      }
    });
    menu.addEventListener("click", (e) => {
      const m = e.target.closest("[data-mode]");
      if (!m || m.dataset.mode === mode) return;
      if (opts.busy()) {
        U.toast(opts.busyText, "err");
        return;
      }
      mode = m.dataset.mode;
      paintBalance();
      opts.onChange();
      U.toast(mode === "fun" ? "Playing with free credits" : "Playing for real money", "ok");
    });
    $("TopUp").addEventListener("click", () => {
      const before = fun;
      fun = Math.max(fun, FUN_CREDITS);
      paintBalance();
      if (fun > before) flashDelta(round2(fun - before));
      opts.onChange();
      setMenu(false);
      U.toast("Credits topped up to " + money(fun) + " GHS", "ok");
    });
    const paintSound = () => {
      $("Sound").setAttribute("aria-pressed", String(soundOn));
      $("Sound").querySelector("span").textContent = "Sound: " + (soundOn ? "on" : "off");
    };
    $("Sound").addEventListener("click", () => {
      soundOn = !soundOn;
      try {
        localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
      } catch (e) { /* storage unavailable */ }
      paintSound();
    });
    $("RulesBtn").addEventListener("click", () => {
      setMenu(false);
      $("Rules").showModal();
    });
    $("Chat").addEventListener("click", () => U.openChat());
    /* another tab may have deposited or played since */
    global.addEventListener("storage", () => {
      paintBalance();
      opts.onChange();
    });
    /* the real balance arrives from the server after the page loads */
    document.addEventListener("vb:balance", () => {
      if (mode !== "real") return;
      paintBalance();
      opts.onChange();
    });

    paintBalance();
    paintSound();
    if (mode === "real" && balance() < MIN_BET) {
      U.toast("Your wallet is empty — please deposit from the wallet.", "err");
    }

    return {
      money, round2, announce, balance, move, place, collect, request, showBalance, canAfford, paintBet, setBet, maxBet, unlockAudio, chime, flick, ping, boom,
      celebrate, play,
      bet: () => amount,
      isReal: () => mode === "real" && serverPlay,
      mode: () => mode,
      audio: () => (soundOn ? audio : null),   /* the sound context, once a tap has started it (null when muted) */
      reduceMotion
    };
  }

  global.VBMini = { create, backdropClose };
})(window);
