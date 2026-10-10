/* Payment status sheet: waiting for the PIN → success (gold check, count-up, coin burst) or failure.
   window.PayFX.waiting(opts) · success(opts) · fail(opts) · pending(opts) · close() */
(function () {
  "use strict";
  const U = window.VBUtil;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let root, card, iconHost, titleEl, amountEl, textEl, actionsEl, canvas, ctx;
  let state = null;
  let returnFocus = null;
  let countRaf = 0;
  let coinRaf = 0;

  const ICONS = {
    waiting:
      '<div class="payfx-rings"><span></span><span></span><span></span></div>' +
      '<svg class="payfx-phone" viewBox="0 0 48 48" aria-hidden="true"><rect x="14" y="5" width="20" height="38" rx="4.5"/>' +
      '<path d="M21 37.5h6"/><path class="payfx-buzz" d="M8 18c-2 3-2 9 0 12M40 18c2 3 2 9 0 12"/></svg>',
    success:
      '<svg class="payfx-mark" viewBox="0 0 120 120" aria-hidden="true"><defs>' +
      '<linearGradient id="payfxGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff2b3"/>' +
      '<stop offset=".45" stop-color="#ffc83d"/><stop offset="1" stop-color="#c88a0c"/></linearGradient></defs>' +
      '<circle class="payfx-disc" cx="60" cy="60" r="50"/>' +
      '<circle class="payfx-ring" cx="60" cy="60" r="50"/>' +
      '<path class="payfx-check" d="M37 62.5 52.5 78 84 45"/></svg>',
    fail:
      '<svg class="payfx-mark payfx-mark-fail" viewBox="0 0 120 120" aria-hidden="true">' +
      '<circle class="payfx-disc" cx="60" cy="60" r="50"/><circle class="payfx-ring" cx="60" cy="60" r="50"/>' +
      '<path class="payfx-x" d="M44 44 76 76"/><path class="payfx-x payfx-x2" d="M76 44 44 76"/></svg>',
    pending:
      '<svg class="payfx-mark payfx-mark-pending" viewBox="0 0 120 120" aria-hidden="true">' +
      '<circle class="payfx-disc" cx="60" cy="60" r="50"/><circle class="payfx-spin" cx="60" cy="60" r="50"/>' +
      '<path class="payfx-clock" d="M60 36v26l16 10"/></svg>'
  };

  function build() {
    if (root) return;
    root = document.createElement("div");
    root.className = "payfx";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "payfxTitle");
    root.innerHTML =
      '<canvas class="payfx-coins" aria-hidden="true"></canvas>' +
      '<div class="payfx-card">' +
      '<div class="payfx-icon"></div>' +
      '<h2 class="payfx-title" id="payfxTitle"></h2>' +
      '<div class="payfx-amount" aria-hidden="true"></div>' +
      '<p class="payfx-text" aria-live="polite"></p>' +
      '<div class="payfx-actions"></div></div>';
    document.body.appendChild(root);
    card = root.querySelector(".payfx-card");
    iconHost = root.querySelector(".payfx-icon");
    titleEl = root.querySelector(".payfx-title");
    amountEl = root.querySelector(".payfx-amount");
    textEl = root.querySelector(".payfx-text");
    actionsEl = root.querySelector(".payfx-actions");
    canvas = root.querySelector(".payfx-coins");
    ctx = canvas.getContext("2d");

    root.addEventListener("click", (e) => {
      if (e.target === root && state !== "waiting") close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !root.hidden) close();
    });
  }

  function setInert(on) {
    document.querySelectorAll("main, .pay-topbar, .bottom-nav, .chat-fab").forEach((el) => (el.inert = on));
  }

  function open() {
    build();
    if (root.hidden) {
      returnFocus = document.activeElement;
      root.hidden = false;
      setInert(true);
      requestAnimationFrame(() => root.classList.add("show"));
    }
  }

  function close() {
    if (!root || root.hidden) return;
    root.classList.remove("show");
    cancelAnimationFrame(countRaf);
    cancelAnimationFrame(coinRaf);
    setInert(false);
    setTimeout(() => {
      root.hidden = true;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }, 220);
    state = null;
    if (returnFocus && returnFocus.focus) returnFocus.focus();
  }

  /* actions: [{ label, kind: "primary" | "ghost", href?, onClick? }] */
  function render(next, { title, text, amount, actions }) {
    open();
    const changed = state !== next;
    state = next;
    root.dataset.state = next;
    if (changed) {
      iconHost.innerHTML = ICONS[next];
      card.classList.remove("pop");
      void card.offsetWidth; // restart the entrance animation
      card.classList.add("pop");
    }
    titleEl.textContent = title;
    textEl.innerHTML = text || "";
    amountEl.textContent = amount ? U.money(amount) : "";
    actionsEl.innerHTML = "";
    (actions || []).forEach((a, i) => {
      const el = document.createElement(a.href ? "a" : "button");
      el.className = "payfx-btn " + (a.kind || "ghost");
      el.textContent = a.label;
      if (a.href) el.href = a.href; else el.type = "button";
      el.addEventListener("click", () => {
        if (!a.href) close();
        if (a.onClick) a.onClick();
      });
      actionsEl.appendChild(el);
      if (i === 0) setTimeout(() => el.focus({ preventScroll: true }), 60);
    });
  }

  /* ---------------- count-up ---------------- */
  function countUp(to) {
    cancelAnimationFrame(countRaf);
    if (reduceMotion) {
      amountEl.textContent = "+ " + U.money(to);
      return;
    }
    const start = performance.now();
    const dur = 1100;
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      amountEl.textContent = "+ " + U.money(Math.round(to * eased * 100) / 100);
      if (t < 1) countRaf = requestAnimationFrame(step);
    };
    amountEl.textContent = "+ " + U.money(0);
    countRaf = requestAnimationFrame(step);
  }

  /* ---------------- gold coin burst ---------------- */
  function burst() {
    if (reduceMotion) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const box = iconHost.getBoundingClientRect();
    const ox = box.left + box.width / 2;
    const oy = box.top + box.height / 2;
    const rand = (a, b) => a + Math.random() * (b - a);
    const small = W < 480;

    const coins = Array.from({ length: small ? 42 : 64 }, () => {
      const ang = rand(-Math.PI * 0.92, -Math.PI * 0.08);
      const speed = rand(520, small ? 980 : 1150);
      return {
        x: ox + rand(-14, 14), y: oy + rand(-10, 10),
        vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
        r: rand(small ? 8 : 9, small ? 14 : 16),
        spin: rand(0, Math.PI * 2), spinV: rand(7, 15) * (Math.random() < 0.5 ? -1 : 1),
        tilt: rand(-0.6, 0.6), tiltV: rand(-2, 2),
        delay: rand(0, 0.12)
      };
    });
    const sparks = Array.from({ length: 26 }, () => ({
      x: ox + rand(-90, 90), y: oy + rand(-80, 60), s: rand(3, 7), life: rand(0.5, 1.1), t: -rand(0, 0.5)
    }));

    let last = performance.now();
    let elapsed = 0;
    const G = 1500;

    const drawCoin = (c) => {
      const face = Math.cos(c.spin);
      const w = Math.max(0.1, Math.abs(face)) * c.r;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.tilt);
      // rim: the coin's thickness, visible as it turns edge-on
      ctx.fillStyle = "#6f5005";
      ctx.beginPath();
      ctx.ellipse(c.r * 0.12 * Math.sign(face || 1), 0, w, c.r, 0, 0, Math.PI * 2);
      ctx.fill();
      // face, with light sweeping across as it spins
      const shine = (Math.sin(c.spin * 2) + 1) / 2;
      const g = ctx.createLinearGradient(-w, -c.r, w, c.r);
      g.addColorStop(0, "#fff7cc");
      g.addColorStop(0.18 + shine * 0.3, "#ffd84f");
      g.addColorStop(0.7, "#d99812");
      g.addColorStop(1, "#9c6704");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0, w, c.r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(111, 80, 5, .6)";
      ctx.lineWidth = Math.max(1, c.r * 0.08);
      ctx.beginPath();
      ctx.ellipse(0, 0, w * 0.76, c.r * 0.76, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (w > c.r * 0.42) {
        ctx.scale(w / c.r, 1);
        ctx.fillStyle = "rgba(124, 86, 6, .8)";
        ctx.font = "800 " + Math.round(c.r * 1.05) + "px system-ui, -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("₵", 0, c.r * 0.06);
        ctx.fillStyle = "rgba(255, 252, 230, .5)";
        ctx.fillText("₵", -c.r * 0.06, 0);
      }
      ctx.restore();
    };

    const drawSpark = (p) => {
      const k = Math.sin(Math.PI * Math.min(1, Math.max(0, p.t / p.life)));
      if (k <= 0) return;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.globalAlpha = k;
      ctx.fillStyle = "#fff6cf";
      ctx.beginPath();
      const s = p.s * (0.6 + k * 0.4);
      ctx.moveTo(0, -s); ctx.quadraticCurveTo(0, 0, s, 0); ctx.quadraticCurveTo(0, 0, 0, s);
      ctx.quadraticCurveTo(0, 0, -s, 0); ctx.quadraticCurveTo(0, 0, 0, -s);
      ctx.fill();
      ctx.restore();
    };

    const frame = (now) => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      elapsed += dt;
      ctx.clearRect(0, 0, W, H);
      let alive = 0;
      for (const p of sparks) {
        p.t += dt;
        if (p.t < p.life) { alive++; drawSpark(p); }
      }
      for (const c of coins) {
        if (elapsed < c.delay) { alive++; continue; }
        c.vy += G * dt;
        c.vx *= 1 - 0.35 * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.spin += c.spinV * dt;
        c.tilt += c.tiltV * dt;
        if (c.y - c.r < H) { alive++; drawCoin(c); }
      }
      if (alive && elapsed < 4) coinRaf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    };
    cancelAnimationFrame(coinRaf);
    coinRaf = requestAnimationFrame(frame);
  }

  /* ---------------- public ---------------- */
  window.PayFX = {
    close,

    waiting({ title, text, amount, onHide }) {
      render("waiting", {
        title: title || "Approve on your phone",
        text,
        amount,
        actions: [{ label: "Hide", kind: "ghost", onClick: onHide }]
      });
    },

    pending({ text }) {
      render("pending", {
        title: "Still confirming",
        text: text || "Your balance updates by itself as soon as the payment is confirmed.",
        actions: [{ label: "OK", kind: "primary" }]
      });
    },

    success({ amount, balance, title }) {
      render("success", {
        title: title || "Deposit successful",
        text: balance === undefined ? "" : "New balance <b>" + U.money(balance) + "</b>",
        actions: [
          { label: "Play now", kind: "primary", href: "games.html" },
          { label: "Done", kind: "ghost" }
        ]
      });
      countUp(amount || 0);
      if (navigator.vibrate) navigator.vibrate([24, 60, 24]);
      setTimeout(burst, reduceMotion ? 0 : 380); // after the check has drawn
    },

    fail({ reason, onRetry }) {
      render("fail", {
        title: "Payment not completed",
        text: "No money was taken." + (reason ? '<span class="payfx-reason">' + U.esc(reason) + "</span>" : ""),
        actions: [
          { label: "Try again", kind: "primary", onClick: onRetry },
          { label: "Close", kind: "ghost" }
        ]
      });
    }
  };
})();
