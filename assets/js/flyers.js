/* WIN B casino — partner flyer generator.
   window.VBFlyers.render(canvas, opts) draws one promotional flyer (20 built-in layouts, custom templates on top of them)
   into a canvas; window.VBFlyers.mount(el, opts) builds the whole generator UI for the partner portal / admin preview.
   Every flyer carries the WIN B casino logo, the partner's own promo code (or partner code), a QR code of the partner's
   referral link, the site address and "18+ · Play responsibly". Offers and bonus wording only ever come from a campaign;
   without one each layout uses neutral copy. QR codes: qrcode-generator (MIT, assets/js/vendor/qrcode.js). */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- paths & constants */
  var SCRIPT = (document.currentScript && document.currentScript.src) || "";
  var BASE = /\/js\/flyers\.js(\?.*)?$/.test(SCRIPT) ? SCRIPT.replace(/js\/flyers\.js(\?.*)?$/, "") : "assets/";
  var IMG = BASE + "img/";

  var TEMPLATE_IDS = ["welcome", "casino", "sports", "live", "aviator", "mines", "slots", "register", "mobile", "weekend",
    "vip", "new-player", "jackpot", "football", "basketball", "referral", "general", "special", "partner-ad", "premium"];

  var GOLD = "#ffc83d", GOLD2 = "#ffb800", RED = "#f6020c", RED2 = "#ff4b45", WHITE = "#ffffff", BLACK = "#0a0a0b", ORANGE = "#ff6a2a";
  var FF = '"Segoe UI", "Helvetica Neue", Roboto, Arial, sans-serif';

  var THUMBS = {
    olympus: "thumbs/volta-olympus.webp", mines: "thumbs/volta-mines.webp", skyrush: "thumbs/sky-rush.webp",
    crash: "thumbs/volta-crash.webp", roulette: "thumbs/roulette.webp", fruits: "thumbs/volta-fruits.webp",
    live: "thumbs/magic-ball-live.webp", hilo: "thumbs/volta-hilo.webp", knockout: "thumbs/volta-knockout.webp",
    goal: "thumbs/volta-goal.webp", coin: "thumbs/volta-coin.webp", wings: "thumbs/volta-wings.webp",
    jet: "thumbs/volta-jet.webp", crossing: "thumbs/volta-crossing.webp", redblack: "thumbs/red-black.webp",
    plane: "sky-rush-plane.svg", logo: "winb-wordmark.svg", mark: "winb-mark.svg"
  };
  var LOGO_RATIO = 346 / 50;

  /* ---------------------------------------------------------------- small helpers */
  function R(x, y, w, h) { return { x: x, y: y, w: w, h: h }; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function font(px, weight, italic) { return (italic ? "italic " : "") + (weight || 900) + " " + Math.max(1, px).toFixed(1) + "px " + FF; }
  function rr(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath(); c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function hexRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    var n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  /* f < 0 mixes toward black, f > 0 toward white */
  function shade(hex, f) {
    var c = hexRgb(hex); if (!c) return hex;
    var t = f < 0 ? 0 : 255, p = Math.abs(f);
    return "rgb(" + c.map(function (v) { return Math.round(v + (t - v) * p); }).join(",") + ")";
  }
  function alpha(hex, a) { var c = hexRgb(hex); return c ? "rgba(" + c.join(",") + "," + a + ")" : hex; }
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function lin(c, x0, y0, x1, y1, stops) {
    var g = c.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); }); return g;
  }
  function rad(c, x, y, r0, r1, stops) {
    var g = c.createRadialGradient(x, y, r0, x, y, r1);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); }); return g;
  }
  function goldFill(K, y0, y1) {
    if (K.P.primary.toLowerCase() !== GOLD) return K.P.primary;
    return lin(K.c, 0, y0, 0, y1, [[0, "#fff1a6"], [0.45, "#ffc83d"], [1, "#ff9f00"]]);
  }

  /* ---------------------------------------------------------------- images */
  var imgCache = {};
  function loadImg(url, cors) {
    if (!url) return Promise.resolve(null);
    if (imgCache[url]) return imgCache[url];
    var p = new Promise(function (res) {
      var im = new Image();
      if (cors) im.crossOrigin = "anonymous";
      im.decoding = "async";
      im.onload = function () { res(im); };
      im.onerror = function () { delete imgCache[url]; res(null); };
      im.src = url;
    });
    imgCache[url] = p; return p;
  }
  function imgSize(im) { return { w: im.naturalWidth || im.width || 1, h: im.naturalHeight || im.height || 1 }; }
  /* draws an image covering the rect (cropping the overflow) */
  function cover(c, im, x, y, w, h, fx, fy) {
    var s = imgSize(im), sc = Math.max(w / s.w, h / s.h), dw = s.w * sc, dh = s.h * sc;
    c.drawImage(im, x + (w - dw) * (fx == null ? 0.5 : fx), y + (h - dh) * (fy == null ? 0.5 : fy), dw, dh);
  }

  /* ---------------------------------------------------------------- QR code (qrcode-generator, drawn by hand) */
  var qrCache = {}, qrLoading = null;
  function ensureQRLib() {
    if (typeof window.qrcode === "function") return Promise.resolve(true);
    if (!qrLoading) {
      qrLoading = new Promise(function (res) {
        var s = document.createElement("script");
        s.src = BASE + "js/vendor/qrcode.js";
        s.onload = function () { res(typeof window.qrcode === "function"); };
        s.onerror = function () { qrLoading = null; res(false); };
        document.head.appendChild(s);
      });
    }
    return qrLoading;
  }
  function qrMatrix(text) {
    if (qrCache[text]) return qrCache[text];
    if (typeof window.qrcode !== "function") return null;
    var q = window.qrcode(0, "M"); q.addData(text); q.make();
    var n = q.getModuleCount(), m = [];
    for (var r = 0; r < n; r++) { var row = []; for (var col = 0; col < n; col++) row.push(q.isDark(r, col)); m.push(row); }
    qrCache[text] = { n: n, m: m }; return qrCache[text];
  }
  /* the QR modules inside a square (no quiet zone of its own — callers put it on white with a margin) */
  function drawQRModules(c, M, x, y, size) {
    var ms = size / M.n;
    c.fillStyle = "#000";
    for (var r = 0; r < M.n; r++) {
      var y0 = Math.round(y + r * ms), y1 = Math.round(y + (r + 1) * ms), col = 0;
      while (col < M.n) {
        if (!M.m[r][col]) { col++; continue; }
        var start = col; while (col < M.n && M.m[r][col]) col++;
        var x0 = Math.round(x + start * ms), x1 = Math.round(x + col * ms);
        c.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
    }
  }
  /* white card: QR (with a 4-module white quiet zone) + "SCAN TO JOIN". Width q, height q * QR_CARD */
  var QR_CARD = 1.14;
  function qrCard(K, x, y, q, st) {
    var c = K.c, M = qrMatrix(K.link);
    st = st || {};
    c.save();
    if (st.shadow !== false) { c.shadowColor = "rgba(0,0,0,.35)"; c.shadowBlur = q * 0.06; c.shadowOffsetY = q * 0.02; }
    rr(c, x, y, q, q * QR_CARD, q * 0.07); c.fillStyle = "#fff"; c.fill();
    c.restore();
    if (st.cardBorder) { rr(c, x, y, q, q * QR_CARD, q * 0.07); c.lineWidth = Math.max(1, q * 0.012); c.strokeStyle = "rgba(0,0,0,.2)"; c.stroke(); }
    if (M) {
      var inner = q * 0.84, ms = inner / M.n, quiet = Math.max(q * 0.08, ms * 4);
      inner = q - 2 * quiet;
      drawQRModules(c, M, x + quiet, y + quiet, inner);
    }
    c.fillStyle = "#111"; c.textAlign = "center"; c.textBaseline = "middle";
    var fs = q * 0.085; c.font = font(fs, 900);
    var lab = "SCAN TO JOIN", tw = c.measureText(lab).width;
    if (tw > q * 0.86) { fs *= q * 0.86 / tw; c.font = font(fs, 900); }
    c.fillText(lab, x + q / 2, y + q * (QR_CARD - 0.105));
  }

  /* ---------------------------------------------------------------- text: wrap + shrink-to-fit flow */
  function wrap(c, txt, maxW, force) {
    var out = [];
    String(txt).split(/\n/).forEach(function (para) {
      var words = para.split(/\s+/).filter(Boolean), line = "";
      words.forEach(function (wd) {
        var t = line ? line + " " + wd : wd;
        if (c.measureText(t).width <= maxW || !line) {
          line = t;
        } else { out.push(line); line = wd; }
      });
      if (line) out.push(line);
    });
    if (!force) for (var i = 0; i < out.length; i++) if (c.measureText(out[i]).width > maxW) return null;
    return out;
  }
  function ellipsize(c, s, maxW) {
    if (c.measureText(s).width <= maxW) return s;
    while (s.length > 1 && c.measureText(s + "…").width > maxW) s = s.slice(0, -1);
    return s.replace(/\s+$/, "") + "…";
  }
  /* items: {t, s (px at scale 1), w (weight), i (italic), up, c (colour | "gold"), lh, ml (max lines),
     kind: "text" | "pill" | "button" | "box" | "marker", bg, fg, border, gap (px after), glow, stroke, shadow}
     Everything is scaled down together until it fits the rect; never draws outside it. */
  function flow(K, r, items, o) {
    o = o || {};
    var c = K.c, align = o.align || "center";
    items = items.filter(function (it) { return it && it.t; });
    if (!items.length || r.w <= 4 || r.h <= 4) return null;
    function measure(s, force) {
      var out = [], total = 0;
      for (var i = 0; i < items.length; i++) {
        var it = items[i], fs = it.s * s, kind = it.kind || "text";
        var boxed = kind === "pill" || kind === "button" || kind === "box";
        var px = boxed ? fs * (kind === "button" ? 1.0 : kind === "box" ? 0.55 : 0.6) : kind === "marker" ? fs * 0.25 : 0;
        var py = boxed ? fs * (kind === "button" ? 0.5 : kind === "box" ? 0.32 : 0.28) : 0;
        c.font = font(fs, it.w || 900, it.i);
        var txt = it.up ? it.t.toUpperCase() : it.t;
        var slant = it.i ? fs * 0.14 : 0;
        var maxW = r.w - 2 * px - slant;
        var lines = wrap(c, txt, maxW, force);
        if (!lines) return null;
        if (it.ml && lines.length > it.ml) {
          if (!force) return null;
          lines = lines.slice(0, it.ml); lines[it.ml - 1] = ellipsize(c, lines[it.ml - 1] + " …", maxW).replace(/ …$/, "…");
        }
        if (force) lines = lines.map(function (l) { return ellipsize(c, l, maxW); });
        var lw = 0; lines.forEach(function (l) { lw = Math.max(lw, c.measureText(l).width + slant); });
        var lh = fs * (it.lh || 1.1);
        var hgt = lines.length * lh + 2 * py;
        var gap = i < items.length - 1 ? (it.gap == null ? it.s * 0.4 : it.gap) * s : 0;
        out.push({ it: it, fs: fs, lines: lines, lw: lw, lh: lh, px: px, py: py, hgt: hgt, gap: gap, kind: kind });
        total += hgt + gap;
      }
      return { out: out, total: total };
    }
    var s, m, minScale = o.minScale || 0.6;
    for (;;) {
      s = o.scale || 1; m = null;
      while (s > 0.18) { m = measure(s); if (m && m.total <= r.h) break; m = null; s *= 0.95; }
      if (m && s >= minScale) break;
      /* too cramped: drop the least important line (kicker, then sub-line, then button) before shrinking further */
      var di = -1, dv = Infinity;
      items.forEach(function (it, i) { if (it.drop && it.drop < dv) { dv = it.drop; di = i; } });
      if (di < 0) break;
      items = items.slice(0, di).concat(items.slice(di + 1));
    }
    if (!m) { s = 0.18; m = measure(s, true); }
    var y = r.y + (o.valign === "top" ? 0 : o.valign === "bottom" ? r.h - m.total : (r.h - m.total) / 2);
    if (y < r.y) y = r.y;
    c.save(); c.beginPath(); c.rect(r.x - r.w * 0.05, r.y - 2, r.w * 1.1, r.h + 4); c.clip();
    var top = y;
    m.out.forEach(function (L) {
      var it = L.it, bw = L.lw + 2 * L.px;
      var bx = align === "left" ? r.x : align === "right" ? r.x + r.w - bw : r.x + (r.w - bw) / 2;
      if (L.kind === "pill" || L.kind === "button" || L.kind === "box") {
        c.save();
        if (L.kind === "button") { c.shadowColor = "rgba(0,0,0,.35)"; c.shadowBlur = L.fs * 0.5; c.shadowOffsetY = L.fs * 0.15; }
        if (it.glow) { c.shadowColor = it.glow; c.shadowBlur = L.fs * 0.8; c.shadowOffsetY = 0; }
        rr(c, bx, y, bw, L.hgt, L.kind === "box" ? L.fs * 0.28 : L.hgt / 2);
        c.fillStyle = it.bg === "gold" ? goldFill(K, y, y + L.hgt) : (it.bg || "rgba(0,0,0,.4)"); c.fill();
        c.restore();
        if (it.border) { rr(c, bx, y, bw, L.hgt, L.kind === "box" ? L.fs * 0.28 : L.hgt / 2); c.lineWidth = Math.max(1, L.fs * 0.07); c.strokeStyle = it.border; c.stroke(); }
      }
      c.font = font(L.fs, it.w || 900, it.i);
      c.textBaseline = "middle";
      c.textAlign = align === "left" ? "left" : align === "right" ? "right" : "center";
      L.lines.forEach(function (line, k) {
        var ly = y + L.py + L.lh * (k + 0.5) + L.fs * 0.03;
        var lineW = c.measureText(line).width;
        var tx = align === "left" ? bx + L.px : align === "right" ? bx + bw - L.px : bx + bw / 2;
        if (L.kind === "marker") {
          var mx = align === "left" ? bx : align === "right" ? bx + bw - lineW - 2 * L.px : r.x + (r.w - lineW) / 2 - L.px;
          if (align === "left") tx = mx + L.px; else if (align === "center") tx = mx + L.px + lineW / 2;
          c.save(); c.fillStyle = it.bg || RED;
          c.beginPath();
          var sk = L.fs * 0.12, my = y + L.lh * k + L.lh * 0.06, mh = L.lh * 0.92;
          c.moveTo(mx + sk, my); c.lineTo(mx + lineW + 2 * L.px + sk, my); c.lineTo(mx + lineW + 2 * L.px - sk, my + mh); c.lineTo(mx - sk, my + mh);
          c.closePath(); c.fill(); c.restore();
          if (align === "center") { c.textAlign = "center"; }
        }
        var fill = it.c === "gold" ? goldFill(K, ly - L.fs / 2, ly + L.fs / 2) : (it.c || "#fff");
        if (it.shadow) { c.save(); c.shadowColor = it.shadow; c.shadowBlur = L.fs * 0.25; c.shadowOffsetY = L.fs * 0.06; }
        if (it.stroke) { c.lineJoin = "round"; c.lineWidth = L.fs * 0.12; c.strokeStyle = it.stroke; c.strokeText(line, tx, ly); }
        if (it.glow && L.kind === "text") {
          c.save(); c.shadowColor = it.glow; c.shadowBlur = L.fs * 0.45;
          c.fillStyle = fill; c.fillText(line, tx, ly); c.fillText(line, tx, ly); c.restore();
        } else { c.fillStyle = fill; c.fillText(line, tx, ly); }
        if (it.shadow) c.restore();
      });
      y += L.hgt + L.gap;
    });
    c.restore();
    return { top: top, bottom: y, scale: s };
  }
  /* one line of text fitted to a rect (shrinks, never wraps) */
  function fitLine(K, text, r, o) {
    o = o || {};
    var c = K.c, fs = o.size || r.h * 0.8;
    c.font = font(fs, o.w || 900, o.i);
    var tw = c.measureText(text).width + (o.i ? fs * 0.12 : 0);
    if (tw > r.w) { fs *= r.w / tw; c.font = font(fs, o.w || 900, o.i); tw = r.w; }
    c.textBaseline = "middle";
    c.textAlign = o.align || "center";
    var x = o.align === "left" ? r.x : o.align === "right" ? r.x + r.w : r.x + r.w / 2;
    c.fillStyle = o.c === "gold" ? goldFill(K, r.y + r.h / 2 - fs / 2, r.y + r.h / 2 + fs / 2) : (o.c || "#fff");
    if (o.glow) { c.save(); c.shadowColor = o.glow; c.shadowBlur = fs * 0.4; }
    c.fillText(text, x, r.y + r.h / 2 + fs * 0.03);
    if (o.glow) c.restore();
    return { w: tw, fs: fs };
  }

  /* ---------------------------------------------------------------- shared pieces */
  function logo(K, r, align, chip) {
    var c = K.c, im = K.img.logo, lw = Math.min(r.w, r.h * LOGO_RATIO), lh = lw / LOGO_RATIO;
    if (chip) { lw *= 0.8; lh *= 0.8; }
    var x = align === "left" ? r.x : align === "right" ? r.x + r.w - lw : r.x + (r.w - lw) / 2;
    if (chip) x += align === "left" ? lh * 0.6 : align === "right" ? -lh * 0.6 : 0;
    var y = r.y + (r.h - lh) / 2;
    if (chip) {
      c.save(); c.shadowColor = "rgba(0,0,0,.25)"; c.shadowBlur = lh * 0.3;
      rr(c, x - lh * 0.6, y - lh * 0.45, lw + lh * 1.2, lh * 1.9, lh * 0.5); c.fillStyle = chip === true ? "#0b0b0c" : chip; c.fill();
      c.restore();
    }
    if (im) c.drawImage(im, x, y, lw, lh);
    else { fitLine(K, "WIN B CASINO", R(x, y, lw, lh), { c: "gold", i: true }); }
  }
  function codeBlock(K, r, st) {
    var c = K.c, lab = K.code.label + ":", val = K.code.value;
    var ls = Math.min(r.h * 0.19, r.w * 0.095);
    c.font = font(ls, 900); var lw = c.measureText(lab).width;
    if (lw > r.w) { ls *= r.w / lw; }
    var boxH = Math.min(r.h - ls * 1.6, Math.max(ls * 2.6, r.w * 0.3));
    var total = ls * 1.6 + boxH, y = r.y + (r.h - total) / 2;
    var center = st.align === "center";
    c.textBaseline = "middle"; c.textAlign = center ? "center" : "left";
    c.font = font(ls, 900); c.fillStyle = st.label || GOLD;
    c.fillText(lab, center ? r.x + r.w / 2 : r.x + 2, y + ls * 0.6);
    var by = y + ls * 1.6, rad0 = Math.min(boxH * 0.24, r.w * 0.06);
    rr(c, r.x, by, r.w, boxH, rad0);
    if (st.codeStyle === "solid") { c.fillStyle = st.codeBg === "gold" ? goldFill(K, by, by + boxH) : (st.codeBg || GOLD); c.fill(); }
    else {
      if (st.codeBg) { c.fillStyle = st.codeBg; c.fill(); }
      c.save(); c.setLineDash([boxH * 0.11, boxH * 0.07]); c.lineWidth = Math.max(2, boxH * 0.04);
      c.strokeStyle = st.codeLine || st.label || GOLD; rr(c, r.x + c.lineWidth / 2, by + c.lineWidth / 2, r.w - c.lineWidth, boxH - c.lineWidth, rad0); c.stroke(); c.restore();
    }
    var cs = boxH * 0.58; c.font = font(cs, 900);
    var cw = c.measureText(val).width, maxW = r.w - boxH * 0.5;
    if (cw > maxW) { cs *= maxW / cw; c.font = font(cs, 900); }
    c.textAlign = "center"; c.fillStyle = st.codeInk === "gold" ? goldFill(K, by + boxH / 2 - cs / 2, by + boxH / 2 + cs / 2) : (st.codeInk || "#fff");
    c.fillText(val, r.x + r.w / 2, by + boxH / 2 + cs * 0.04);
  }
  /* promo code + QR card. Lays itself out as a row (wide rect) or a column. */
  function ess(K, r, st) {
    st = st || {};
    var c = K.c, rowMode = st.dir ? st.dir === "row" : r.w / r.h >= 1.45;
    var pad = st.panel || st.border ? Math.min(r.w, r.h) * (rowMode ? 0.1 : 0.07) : 0;
    if (!rowMode) {
      var iw = r.w - 2 * pad, need = 2 * pad + Math.min(iw * 0.62, (r.h - 2 * pad) * 0.36) + (r.h - 2 * pad) * 0.05 + iw * 0.86 * QR_CARD;
      if (need < r.h) r = R(r.x, r.y + (r.h - need) * (st.colAlign === "top" ? 0 : st.colAlign === "bottom" ? 1 : 0.5), r.w, need);
    }
    if (st.panel || st.border) {
      var rd = Math.min(r.w, r.h) * (st.radius == null ? 0.09 : st.radius);
      c.save();
      if (st.glow) { c.shadowColor = st.glow; c.shadowBlur = K.u * 2.2; }
      rr(c, r.x, r.y, r.w, r.h, rd);
      if (st.panel) { c.fillStyle = st.panel; c.fill(); }
      if (st.border) { c.lineWidth = Math.max(2, K.u * 0.35); c.strokeStyle = st.border; c.stroke(); }
      c.restore();
    }
    var I = R(r.x + pad, r.y + pad, r.w - 2 * pad, r.h - 2 * pad);
    if (rowMode) {
      var q = Math.min(I.h / QR_CARD, I.w * 0.42), cardH = q * QR_CARD, gap = Math.max(I.h * 0.1, I.w * 0.04);
      var left = st.qrSide === "left";
      var qx = left ? I.x : I.x + I.w - q;
      qrCard(K, qx, I.y + (I.h - cardH) / 2, q, st);
      var cw = I.w - q - gap, cx = left ? I.x + q + gap : I.x;
      var ch = Math.min(I.h, cw * 0.55);
      codeBlock(K, R(cx, I.y + (I.h - ch) / 2, cw, ch), st);
    } else {
      var codeH = Math.min(I.h * 0.36, I.w * 0.62), gap2 = I.h * 0.05;
      var q2 = Math.min((I.h - codeH - gap2) / QR_CARD, I.w * 0.86);
      var used = codeH + gap2 + q2 * QR_CARD, y0 = I.y + (I.h - used) / 2;
      codeBlock(K, R(I.x, y0, I.w, codeH), Object.assign({}, st, { align: "center" }));
      qrCard(K, I.x + (I.w - q2) / 2, y0 + codeH + gap2, q2, st);
    }
  }
  function footer(K, r, st) {
    st = st || {};
    var c = K.c, host = K.host, rg = "18+ · Play responsibly", fs = r.h * 0.78;
    c.font = font(fs, 700);
    var a = c.measureText(host).width, b = c.measureText(rg).width, gap = fs * 1.5;
    if (st.center) {
      var t = host + "   •   " + rg; var tw = c.measureText(t).width;
      if (tw > r.w) fs *= r.w / tw;
      fitLine(K, t, r, { size: fs, w: 700, c: st.ink || "rgba(255,255,255,.8)" });
      return;
    }
    if (a + b + gap > r.w) { fs *= r.w / (a + b + gap); }
    fitLine(K, host, R(r.x, r.y, r.w / 2, r.h), { size: fs, w: 800, align: "left", c: st.hostInk || st.ink || "#fff" });
    fitLine(K, rg, R(r.x + r.w / 2, r.y, r.w / 2, r.h), { size: fs, w: 700, align: "right", c: st.ink || "rgba(255,255,255,.8)" });
  }
  function termsAndFoot(K, S, st) {
    st = st || {};
    if (S.terms && K.copy.terms) {
      flow(K, S.terms, [{ t: K.copy.terms, s: K.u * 1.7, w: 500, c: st.terms || st.ink || "rgba(255,255,255,.7)", lh: 1.2, ml: 3 }], { align: st.center ? "center" : "left", valign: "bottom" });
    }
    footer(K, S.foot, st);
  }
  /* the copy column: kicker, headline, offer (campaign only), body/sub, call-to-action */
  function copyItems(K, st) {
    st = st || {};
    var u = K.u, cp = K.copy, hs = (st.hs || 11) * u;
    var kk = st.kicker || {}, hd = st.head || {}, of = st.offer || {}, sb = st.sub || {}, ct = st.cta || {};
    return [
      cp.kicker && !st.noKicker ? { t: cp.kicker, s: (kk.s || 3.1) * u, kind: kk.kind || "text", bg: kk.bg, c: kk.c || GOLD, up: true, w: 900, ml: 2, gap: (kk.gap || 1.6) * u, glow: kk.glow, border: kk.border, drop: 1 } : null,
      st.noHead ? null : { t: cp.headline, s: hs, i: hd.i !== false, up: hd.up !== false, c: hd.c || "#fff", lh: hd.lh || 1.0, ml: 5, gap: 2.2 * u, kind: hd.kind, bg: hd.bg, stroke: hd.stroke, glow: hd.glow, shadow: hd.shadow, w: 900 },
      cp.offer ? { t: cp.offer, s: (of.s || 6) * u, kind: "box", bg: of.bg || "gold", c: of.c || "#111", ml: 3, lh: 1.08, gap: 2 * u, glow: of.glow, border: of.border } : null,
      cp.sub ? { t: cp.sub, s: (sb.s || 3.5) * u, w: 600, c: sb.c || "rgba(255,255,255,.86)", lh: 1.25, ml: 4, gap: 2.6 * u, drop: K.campaign ? 4 : 2 } : null,
      cp.cta && !st.noCta ? { t: cp.cta, s: (ct.s || 3.9) * u, kind: "button", bg: ct.bg || RED, c: ct.c || "#fff", up: true, ml: 1, glow: ct.glow, border: ct.border, drop: 3 } : null
    ];
  }

  /* the common skeleton: logo / main (art + copy) / promo-code+QR / terms / footer. Returns rects. */
  function skel(K, o) {
    o = o || {};
    var w = K.w, h = K.h, u = K.u, p = (o.pad || 6) * u, S = { pad: p };
    var hasTerms = !!K.copy.terms;
    if (K.wide) {
      var footH = 4 * u, termsH = hasTerms ? 6.5 * u : 0;
      var fb = h - p * 0.75;
      S.foot = R(p, fb - footH, w - 2 * p, footH);
      S.terms = hasTerms ? R(p, S.foot.y - termsH - 1.2 * u, w - 2 * p, termsH) : null;
      var bottom = (S.terms || S.foot).y - 2.5 * u;
      var essW = w * (o.essW || 0.3);
      var essLeft = o.essSide === "left";
      S.ess = R(essLeft ? p : w - p - essW, p, essW, bottom - p);
      var areaX = essLeft ? p + essW + 4 * u : p, areaW = w - 2 * p - essW - 4 * u;
      var logoH = (o.logoH || 8.5) * u;
      var artW = o.wideArt ? areaW * o.wideArt : 0;
      var copyW = areaW - artW - (artW ? 3 * u : 0);
      S.logo = R(areaX, p, Math.min(copyW, logoH * LOGO_RATIO), logoH);
      S.main = R(areaX, p, areaW, bottom - p);
      var artLeft = !!o.wideArtLeft;
      var copyX = artLeft ? areaX + artW + 3 * u : areaX;
      S.logo.x = copyX;
      S.copy = R(copyX, S.logo.y + logoH + 3 * u, copyW, bottom - S.logo.y - logoH - 3 * u);
      S.art = artW ? R(artLeft ? areaX : areaX + copyW + 3 * u, p, artW, bottom - p) : null;
      return S;
    }
    if (K.square && !o.noSquare) {
      var footS = 3.3 * u, termsS = hasTerms ? 5 * u : 0;
      S.foot = R(p, h - p * 0.7 - footS, w - 2 * p, footS);
      S.terms = hasTerms ? R(p, S.foot.y - termsS - 1.2 * u, w - 2 * p, termsS) : null;
      var botS = (S.terms || S.foot).y - 3 * u, logoS = (o.logoH || 7) * u;
      S.logo = R(p, p, (w - 2 * p) * (o.logoW || 1), logoS);
      if (o.logoAlign === "right") S.logo.x = w - p - S.logo.w;
      var topS = p + logoS + 3.5 * u, essWS = w * (o.essWS || 0.34);
      S.ess = R(o.essSide === "left" ? p : w - p - essWS, topS, essWS, botS - topS);
      S.main = R(o.essSide === "left" ? p + essWS + 4 * u : p, topS, w - 2 * p - essWS - 4 * u, botS - topS);
      var fS = o.art == null ? 0.45 : o.art;
      if (!fS) { S.copy = S.main; S.art = null; return S; }
      var cH = S.main.h * (1 - fS) - 1.25 * u, aH = S.main.h * fS - 1.25 * u;
      S.art = R(S.main.x, o.artFirst ? topS : botS - aH, S.main.w, aH);
      S.copy = R(S.main.x, o.artFirst ? botS - cH : topS, S.main.w, cH);
      return S;
    }
    var footH2 = 3.3 * u, termsH2 = hasTerms ? 5.6 * u : 0;
    var fb2 = h - p * 0.7;
    S.foot = R(p, fb2 - footH2, w - 2 * p, footH2);
    S.terms = hasTerms ? R(p, S.foot.y - termsH2 - 1.2 * u, w - 2 * p, termsH2) : null;
    var bottom2 = (S.terms || S.foot).y - 3 * u;
    var essH = Math.min(w * (o.essH || (K.tall ? 0.34 : 0.26)), h * 0.34);
    S.ess = R(p, bottom2 - essH, w - 2 * p, essH);
    var logoH2 = (o.logoH || 7.5) * u;
    S.logo = R(p, p, (w - 2 * p) * (o.logoW || 1), logoH2);
    if (o.logoAlign === "right") S.logo.x = w - p - S.logo.w;
    var mTop = p + logoH2 + 3.5 * u, mBot = S.ess.y - 3.5 * u;
    S.main = R(p, mTop, w - 2 * p, mBot - mTop);
    var frac = o.art == null ? 0.45 : o.art;
    var copyH = Math.min(S.main.h * (1 - frac), w * 0.78);
    if (!frac) copyH = S.main.h;
    var artH = S.main.h - copyH - (frac ? 2.5 * u : 0);
    if (o.artFirst) {
      S.art = frac ? R(p, mTop, w - 2 * p, artH) : null;
      S.copy = R(p, mBot - copyH, w - 2 * p, copyH);
    } else {
      S.copy = R(p, mTop, w - 2 * p, copyH);
      S.art = frac ? R(p, mBot - artH, w - 2 * p, artH) : null;
    }
    return S;
  }

  /* hero art: the campaign's uploaded image when there is one, otherwise the template's own drawing */
  function art(K, r, fallback, shape) {
    if (!r || r.w < 8 || r.h < 8) return;
    var c = K.c;
    if (K.hero) {
      var s = imgSize(K.hero), sc = Math.min(r.w / s.w, r.h / s.h), dw = s.w * sc, dh = s.h * sc;
      var x = r.x + (r.w - dw) / 2, y = r.y + (r.h - dh) / 2;
      c.save();
      if (shape === "circle") {
        var d = Math.min(r.w, r.h), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        c.beginPath(); c.arc(cx, cy, d / 2, 0, Math.PI * 2); c.clip();
        cover(c, K.hero, cx - d / 2, cy - d / 2, d, d);
        c.restore();
        c.beginPath(); c.arc(cx, cy, d / 2, 0, Math.PI * 2); c.lineWidth = K.u * 0.8; c.strokeStyle = K.P.primary; c.stroke();
        return;
      }
      c.shadowColor = "rgba(0,0,0,.45)"; c.shadowBlur = K.u * 3; c.shadowOffsetY = K.u;
      rr(c, x, y, dw, dh, Math.min(dw, dh) * 0.05); c.fillStyle = "#000"; c.fill();
      c.restore(); c.save();
      rr(c, x, y, dw, dh, Math.min(dw, dh) * 0.05); c.clip();
      c.drawImage(K.hero, x, y, dw, dh);
      c.restore();
      rr(c, x, y, dw, dh, Math.min(dw, dh) * 0.05); c.lineWidth = Math.max(2, K.u * 0.4); c.strokeStyle = alpha(K.P.primary, 0.8) || K.P.primary; c.stroke();
      return;
    }
    fallback(r);
  }
  function backdrop(K, fn) {
    if (K.bgImg) {
      var c = K.c;
      cover(c, K.bgImg, 0, 0, K.w, K.h);
      c.fillStyle = lin(c, 0, 0, 0, K.h, [[0, "rgba(0,0,0,.55)"], [0.5, "rgba(0,0,0,.35)"], [1, "rgba(0,0,0,.75)"]]);
      c.fillRect(0, 0, K.w, K.h);
      return false;
    }
    fn(); return true;
  }
  /* a game thumbnail as a rounded tile, optionally rotated about its centre */
  function tile(K, key, cx, cy, s, rot, o) {
    o = o || {};
    var c = K.c, im = typeof key === "string" ? K.img[key] : key, rad0 = s * (o.radius == null ? 0.14 : o.radius), b = o.frame || 0;
    c.save(); c.translate(cx, cy); if (rot) c.rotate(rot * Math.PI / 180);
    c.shadowColor = o.shadowColor || "rgba(0,0,0,.5)"; c.shadowBlur = s * 0.12; c.shadowOffsetY = s * 0.04;
    rr(c, -s / 2 - b, -s / 2 - b, s + 2 * b, s + 2 * b + (o.polaroid ? s * 0.16 : 0), rad0 + b * 0.5);
    c.fillStyle = o.frameColor || "#111"; c.fill();
    c.shadowColor = "transparent";
    c.save(); rr(c, -s / 2, -s / 2, s, s, rad0); c.clip();
    if (im) cover(c, im, -s / 2, -s / 2, s, s);
    else { c.fillStyle = lin(c, 0, -s / 2, 0, s / 2, [[0, "#2a2a2a"], [1, "#111"]]); c.fillRect(-s / 2, -s / 2, s, s); }
    c.restore();
    if (o.border) { rr(c, -s / 2, -s / 2, s, s, rad0); c.lineWidth = Math.max(1.5, s * 0.022); c.strokeStyle = o.border; c.stroke(); }
    c.restore();
  }
  function fan(K, r, keys, o) {
    o = o || {};
    var s = Math.min(r.h * 0.8, r.w / 2.25);
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2 + s * 0.04;
    tile(K, keys[0], cx - s * 0.68, cy + s * 0.07, s * 0.86, -12, { border: o.border || "rgba(255,200,61,.75)" });
    tile(K, keys[2], cx + s * 0.68, cy + s * 0.07, s * 0.86, 12, { border: o.border || "rgba(255,200,61,.75)" });
    tile(K, keys[1], cx, cy, s, 0, { border: o.border || GOLD });
  }
  function grid(K, r, keys, cols, rows, o) {
    o = o || {};
    var gapF = o.gap == null ? 0.08 : o.gap;
    var s = Math.min(r.w / (cols + (cols - 1) * gapF), r.h / (rows + (rows - 1) * gapF));
    var g = s * gapF, tw = cols * s + (cols - 1) * g, th = rows * s + (rows - 1) * g;
    var x0 = r.x + (r.w - tw) / 2, y0 = r.y + (r.h - th) / 2, c = K.c;
    c.save();
    if (o.rot) { c.translate(r.x + r.w / 2, r.y + r.h / 2); c.rotate(o.rot * Math.PI / 180); c.translate(-(r.x + r.w / 2), -(r.y + r.h / 2)); }
    var k = 0;
    for (var yy = 0; yy < rows; yy++) for (var xx = 0; xx < cols; xx++) {
      tile(K, keys[k++ % keys.length], x0 + xx * (s + g) + s / 2, y0 + yy * (s + g) + s / 2, s, 0, { border: o.border, radius: o.radius, shadowColor: o.shadowColor });
    }
    c.restore();
  }

  /* ---------------------------------------------------------------- decorative drawing */
  function rays(K, cx, cy, n, color, a, rot) {
    var c = K.c, L = Math.hypot(K.w, K.h) * 1.2, step = Math.PI * 2 / n;
    c.save(); c.fillStyle = color; c.globalAlpha = a;
    for (var i = 0; i < n; i++) {
      var a0 = i * step + (rot || 0);
      c.beginPath(); c.moveTo(cx, cy);
      c.lineTo(cx + Math.cos(a0) * L, cy + Math.sin(a0) * L);
      c.lineTo(cx + Math.cos(a0 + step / 2) * L, cy + Math.sin(a0 + step / 2) * L);
      c.closePath(); c.fill();
    }
    c.restore();
  }
  function sparkles(K, seed, n, color, a) {
    var c = K.c, rnd = rng(seed);
    c.save(); c.fillStyle = color;
    for (var i = 0; i < n; i++) {
      var x = rnd() * K.w, y = rnd() * K.h, s = (0.2 + rnd() * 0.6) * K.u;
      c.globalAlpha = (a || 0.6) * (0.3 + rnd() * 0.7);
      c.beginPath(); c.moveTo(x, y - s * 2); c.quadraticCurveTo(x, y, x + s * 2, y); c.quadraticCurveTo(x, y, x, y + s * 2);
      c.quadraticCurveTo(x, y, x - s * 2, y); c.quadraticCurveTo(x, y, x, y - s * 2); c.fill();
    }
    c.restore();
  }
  function confetti(K, seed, n, colors, a) {
    var c = K.c, rnd = rng(seed);
    c.save();
    for (var i = 0; i < n; i++) {
      var x = rnd() * K.w, y = rnd() * K.h, s = (0.6 + rnd() * 1.3) * K.u;
      c.globalAlpha = a == null ? 0.9 : a;
      c.fillStyle = colors[Math.floor(rnd() * colors.length)];
      c.save(); c.translate(x, y); c.rotate(rnd() * Math.PI);
      if (rnd() < 0.3) { c.beginPath(); c.arc(0, 0, s * 0.55, 0, Math.PI * 2); c.fill(); }
      else if (rnd() < 0.5) { c.fillRect(-s * 0.25, -s, s * 0.5, s * 2); }
      else { c.beginPath(); c.moveTo(-s, 0); c.quadraticCurveTo(-s / 2, -s * 0.8, 0, 0); c.quadraticCurveTo(s / 2, s * 0.8, s, 0); c.lineWidth = s * 0.35; c.strokeStyle = c.fillStyle; c.stroke(); }
      c.restore();
    }
    c.restore();
  }
  function stripes(K, angle, gapPx, widthPx, color, a, clip) {
    var c = K.c, L = Math.hypot(K.w, K.h);
    c.save();
    if (clip) { c.beginPath(); c.rect(clip.x, clip.y, clip.w, clip.h); c.clip(); }
    c.translate(K.w / 2, K.h / 2); c.rotate(angle * Math.PI / 180);
    c.fillStyle = color; c.globalAlpha = a;
    for (var x = -L; x < L; x += gapPx) c.fillRect(x, -L, widthPx, 2 * L);
    c.restore();
  }
  function dots(K, x0, y0, x1, y1, step, rmax, color, a, fromX, fromY) {
    var c = K.c, D = Math.hypot(x1 - x0, y1 - y0);
    c.save(); c.fillStyle = color; c.globalAlpha = a;
    for (var y = y0; y <= y1; y += step) for (var x = x0; x <= x1; x += step) {
      var d = Math.hypot(x - fromX, y - fromY) / D, rr0 = rmax * (1 - d);
      if (rr0 > 0.4) { c.beginPath(); c.arc(x, y, rr0, 0, Math.PI * 2); c.fill(); }
    }
    c.restore();
  }
  function starburst(c, cx, cy, ro, ri, n, rot) {
    c.beginPath();
    for (var i = 0; i < n * 2; i++) {
      var a = (i / (n * 2)) * Math.PI * 2 + (rot || 0), r0 = i % 2 ? ri : ro;
      c[i ? "lineTo" : "moveTo"](cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    }
    c.closePath();
  }
  function coin(K, x, y, r) {
    var c = K.c;
    c.save();
    c.shadowColor = "rgba(0,0,0,.4)"; c.shadowBlur = r * 0.4; c.shadowOffsetY = r * 0.12;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = rad(c, x - r * 0.35, y - r * 0.4, r * 0.1, r * 1.2, [[0, "#fff4b0"], [0.45, "#ffc83d"], [1, "#b86e00"]]); c.fill();
    c.shadowColor = "transparent";
    c.beginPath(); c.arc(x, y, r * 0.74, 0, Math.PI * 2); c.lineWidth = r * 0.09; c.strokeStyle = "rgba(140,80,0,.55)"; c.stroke();
    c.fillStyle = "rgba(120,64,0,.75)"; c.font = font(r * 0.9, 900, true); c.textAlign = "center"; c.textBaseline = "middle"; c.fillText("W", x, y + r * 0.04);
    c.restore();
  }
  function gem(c, cx, cy, s) {
    c.save();
    c.beginPath(); c.moveTo(cx - s * 0.5, cy - s * 0.15); c.lineTo(cx - s * 0.28, cy - s * 0.45); c.lineTo(cx + s * 0.28, cy - s * 0.45);
    c.lineTo(cx + s * 0.5, cy - s * 0.15); c.lineTo(cx, cy + s * 0.5); c.closePath();
    c.fillStyle = lin(c, cx, cy - s / 2, cx, cy + s / 2, [[0, "#fff6c2"], [0.5, "#ffc83d"], [1, "#e08a00"]]); c.fill();
    c.strokeStyle = "rgba(120,60,0,.6)"; c.lineWidth = s * 0.04;
    c.beginPath(); c.moveTo(cx - s * 0.5, cy - s * 0.15); c.lineTo(cx + s * 0.5, cy - s * 0.15);
    c.moveTo(cx - s * 0.18, cy - s * 0.15); c.lineTo(cx, cy + s * 0.5); c.lineTo(cx + s * 0.18, cy - s * 0.15); c.stroke();
    c.restore();
  }
  function bomb(c, cx, cy, s) {
    c.save();
    c.beginPath(); c.arc(cx, cy + s * 0.08, s * 0.36, 0, Math.PI * 2);
    c.fillStyle = rad(c, cx - s * 0.12, cy - s * 0.05, s * 0.02, s * 0.45, [[0, "#666"], [1, "#0b0b0b"]]); c.fill();
    c.fillStyle = "#333"; c.fillRect(cx - s * 0.08, cy - s * 0.36, s * 0.16, s * 0.1);
    c.beginPath(); c.moveTo(cx, cy - s * 0.36); c.quadraticCurveTo(cx + s * 0.1, cy - s * 0.52, cx + s * 0.24, cy - s * 0.44);
    c.lineWidth = s * 0.04; c.strokeStyle = "#c9a36b"; c.stroke();
    starburst(c, cx + s * 0.26, cy - s * 0.45, s * 0.13, s * 0.05, 7);
    c.fillStyle = "#ffcf3d"; c.fill();
    c.restore();
  }
  function crown(c, cx, cy, s, fill) {
    c.save();
    c.beginPath();
    c.moveTo(cx - s * 0.5, cy + s * 0.3); c.lineTo(cx - s * 0.56, cy - s * 0.28); c.lineTo(cx - s * 0.25, cy);
    c.lineTo(cx, cy - s * 0.42); c.lineTo(cx + s * 0.25, cy); c.lineTo(cx + s * 0.56, cy - s * 0.28); c.lineTo(cx + s * 0.5, cy + s * 0.3);
    c.closePath(); c.fillStyle = fill; c.shadowColor = "rgba(255,190,40,.45)"; c.shadowBlur = s * 0.15; c.fill();
    c.shadowColor = "transparent";
    c.fillRect(cx - s * 0.5, cy + s * 0.36, s, s * 0.12);
    [[-0.56, -0.28], [0, -0.42], [0.56, -0.28]].forEach(function (p) { c.beginPath(); c.arc(cx + p[0] * s, cy + p[1] * s, s * 0.07, 0, Math.PI * 2); c.fill(); });
    c.fillStyle = RED; c.beginPath(); c.arc(cx, cy + s * 0.12, s * 0.07, 0, Math.PI * 2); c.fill();
    c.restore();
  }
  function football(c, cx, cy, r) {
    c.save();
    c.shadowColor = "rgba(0,0,0,.6)"; c.shadowBlur = r * 0.25; c.shadowOffsetY = r * 0.08;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = rad(c, cx - r * 0.35, cy - r * 0.35, r * 0.1, r * 1.1, [[0, "#ffffff"], [0.7, "#e6e6e6"], [1, "#9a9a9a"]]); c.fill();
    c.shadowColor = "transparent";
    c.clip();
    function pent(x, y, s, rot) {
      c.beginPath();
      for (var i = 0; i < 5; i++) { var a = rot + i * Math.PI * 2 / 5; c[i ? "lineTo" : "moveTo"](x + Math.cos(a) * s, y + Math.sin(a) * s); }
      c.closePath(); c.fillStyle = "#151515"; c.fill();
    }
    pent(cx, cy, r * 0.3, -Math.PI / 2);
    c.strokeStyle = "#151515"; c.lineWidth = r * 0.04;
    for (var i = 0; i < 5; i++) {
      var a = -Math.PI / 2 + i * Math.PI * 2 / 5;
      c.beginPath(); c.moveTo(cx + Math.cos(a) * r * 0.3, cy + Math.sin(a) * r * 0.3); c.lineTo(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62); c.stroke();
      pent(cx + Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.92, r * 0.28, a + Math.PI);
    }
    c.restore();
  }
  function basketball(c, cx, cy, r) {
    c.save();
    c.shadowColor = "rgba(0,0,0,.6)"; c.shadowBlur = r * 0.2;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = rad(c, cx - r * 0.35, cy - r * 0.4, r * 0.05, r * 1.15, [[0, "#ffb37a"], [0.45, "#ff6a2a"], [1, "#8a2a00"]]); c.fill();
    c.shadowColor = "transparent"; c.clip();
    c.strokeStyle = "#1a0a02"; c.lineWidth = r * 0.045;
    c.beginPath(); c.moveTo(cx - r, cy); c.lineTo(cx + r, cy); c.stroke();
    c.beginPath(); c.moveTo(cx, cy - r); c.lineTo(cx, cy + r); c.stroke();
    c.beginPath(); c.ellipse(cx - r * 1.05, cy, r * 0.62, r * 1.05, 0, -Math.PI / 2, Math.PI / 2); c.stroke();
    c.beginPath(); c.ellipse(cx + r * 1.05, cy, r * 0.62, r * 1.05, 0, Math.PI / 2, Math.PI * 1.5); c.stroke();
    c.restore();
  }
  function stamp(K, cx, cy, r, l1, l2, color, rot) {
    var c = K.c;
    c.save(); c.translate(cx, cy); c.rotate((rot || -12) * Math.PI / 180);
    c.shadowColor = "rgba(0,0,0,.45)"; c.shadowBlur = r * 0.2;
    c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fillStyle = color; c.fill();
    c.shadowColor = "transparent";
    c.beginPath(); c.arc(0, 0, r * 0.86, 0, Math.PI * 2); c.lineWidth = r * 0.04; c.strokeStyle = "rgba(0,0,0,.6)"; c.setLineDash([r * 0.08, r * 0.06]); c.stroke(); c.setLineDash([]);
    c.restore();
    c.save(); c.translate(cx, cy); c.rotate((rot || -12) * Math.PI / 180);
    var KK = { c: c, P: K.P };
    fitLine(KK, l1, R(-r * 0.7, -r * 0.42, r * 1.4, r * 0.4), { c: "#111", size: r * 0.34 });
    fitLine(KK, l2, R(-r * 0.7, r * 0.02, r * 1.4, r * 0.4), { c: "#111", size: r * 0.4 });
    c.restore();
  }

  /* ---------------------------------------------------------------- the 20 layouts */
  var T = {};

  /* 1. centred hero, light rays, fan of games */
  T.welcome = {
    pal: { bg: "#16030a", primary: GOLD, accent: RED }, img: ["olympus", "mines", "skyrush"],
    copy: { kicker: "Welcome to WIN B casino", headline: "Your new home of instant games", sub: "Slots, crash games, Mines and live games · Deposit & withdraw with mobile money", cta: "Join now" },
    draw: function (K) {
      var S = skel(K, { art: 0.5, wideArt: 0.4 }), c = K.c, P = K.P, al = K.wide ? "left" : "center";
      var cx = S.art.x + S.art.w / 2, cy = S.art.y + S.art.h / 2;
      backdrop(K, function () {
        c.fillStyle = rad(c, cx, cy, 0, Math.max(K.w, K.h) * 0.85, [[0, shade(P.accent, -0.25)], [0.45, P.bg], [1, "#040404"]]);
        c.fillRect(0, 0, K.w, K.h);
        rays(K, cx, cy, 28, P.primary, 0.06);
        sparkles(K, 11, 46, P.primary, 0.7);
      });
      c.save(); c.fillStyle = rad(c, cx, cy, 0, Math.min(S.art.w, S.art.h) * 0.8, [[0, alpha(P.primary, 0.35)], [1, alpha(P.primary, 0)]]); c.fillRect(0, 0, K.w, K.h); c.restore();
      art(K, S.art, function (r) { fan(K, r, ["olympus", "mines", "skyrush"]); });
      logo(K, S.logo, al);
      flow(K, S.copy, copyItems(K, { kicker: { kind: "pill", bg: "gold", c: "#141414" }, head: { c: "#fff", shadow: "rgba(0,0,0,.6)" }, cta: { bg: P.accent } }), { align: al });
      ess(K, S.ess, { panel: "rgba(12,2,6,.78)", border: alpha(P.primary, 0.85), label: P.primary, codeStyle: "dashed", codeInk: "gold" });
      termsAndFoot(K, S, {});
    }
  };

  /* 2. diagonal split: red wedge over black, tilted grid of game tiles */
  T.casino = {
    pal: { bg: "#0b0b0c", primary: GOLD, accent: RED }, img: ["roulette", "olympus", "fruits", "crash"],
    copy: { kicker: "Casino games", headline: "Real casino. Real money.", sub: "Slots · Roulette · Crash · Mines and more, on your phone", cta: "Play now" },
    draw: function (K) {
      var S = skel(K, { art: 0.52, wideArt: 0.42, wideArtLeft: false }), c = K.c, P = K.P, w = K.w, h = K.h;
      backdrop(K, function () {
        c.fillStyle = P.bg; c.fillRect(0, 0, w, h);
        stripes(K, 45, K.u * 4, K.u * 0.25, "#ffffff", 0.035);
      });
      var poly = K.wide ? [[0, 0], [w * 0.6, 0], [w * 0.44, h], [0, h]] : [[0, 0], [w, 0], [w, S.copy.y + S.copy.h * 0.55], [0, S.copy.y + S.copy.h + S.main.h * 0.12]];
      c.save(); c.beginPath(); poly.forEach(function (p, i) { c[i ? "lineTo" : "moveTo"](p[0], p[1]); }); c.closePath();
      c.fillStyle = lin(c, 0, 0, w, h, [[0, shade(P.accent, 0.08)], [1, shade(P.accent, -0.45)]]); c.globalAlpha = K.bgImg ? 0.85 : 1; c.fill(); c.restore();
      // gold edge stripe
      c.save(); c.beginPath();
      var e1 = poly[K.wide ? 1 : 2], e2 = poly[K.wide ? 2 : 3], off = K.u * 1.6;
      c.moveTo(e1[0], e1[1]); c.lineTo(e2[0], e2[1]);
      c.lineTo(e2[0] + (K.wide ? off : 0), e2[1] + (K.wide ? 0 : off)); c.lineTo(e1[0] + (K.wide ? off : 0), e1[1] + (K.wide ? 0 : off)); c.closePath();
      c.fillStyle = P.primary; c.fill(); c.restore();
      art(K, S.art, function (r) { grid(K, r, ["roulette", "olympus", "fruits", "crash"], 2, 2, { rot: -6, border: alpha(P.primary, 0.9), gap: 0.1 }); });
      logo(K, S.logo, "left");
      flow(K, S.copy, copyItems(K, { kicker: { c: P.primary }, head: { c: "#fff", shadow: "rgba(0,0,0,.35)" }, sub: { c: "#fff" }, cta: { bg: "#0b0b0c", c: P.primary, border: P.primary } }), { align: "left" });
      ess(K, S.ess, { panel: "#141414", border: P.primary, label: P.primary, codeStyle: "solid", codeBg: "gold", codeInk: "#111", radius: 0.04 });
      termsAndFoot(K, S, {});
    }
  };

  /* 3. sports: speed stripes, giant outlined word, COMING SOON corner ribbon */
  T.sports = {
    pal: { bg: "#141414", primary: GOLD, accent: RED }, img: ["goal", "knockout"],
    copy: { kicker: "Sports", headline: "Sports coming soon", sub: "Casino open now · Play instant games while you wait", cta: "Play the casino" },
    draw: function (K) {
      var S = skel(K, { art: 0.45, logoW: 0.6, wideArt: 0.36 }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      backdrop(K, function () {
        c.fillStyle = lin(c, 0, 0, 0, h, [[0, shade(P.bg, 0.06)], [1, P.bg]]); c.fillRect(0, 0, w, h);
      });
      // giant outlined word
      c.save(); c.translate(w * 0.5, h * 0.5); c.rotate(-0.14);
      c.font = font(Math.min(w, h) * 0.42, 900, true); c.textAlign = "center"; c.textBaseline = "middle";
      c.lineWidth = u * 0.35; c.strokeStyle = "rgba(255,255,255,.07)"; c.strokeText("SPORTS", 0, 0); c.restore();
      // speed stripes
      c.save(); c.translate(K.wide ? w * 0.4 : 0, h); c.rotate(K.wide ? -0.6 : -0.42);
      [[P.primary, 0, 3.2], [P.accent, 5, 2], ["#ffffff", 8.5, 0.8]].forEach(function (s) {
        c.fillStyle = s[0]; c.fillRect(-w, -u * (14 + s[1] * 1.2), w * 3, u * s[2]);
      });
      c.restore();
      art(K, S.art, function (r) {
        var s = Math.min(r.h * 0.9, r.w / 2.3);
        tile(K, "goal", r.x + r.w / 2 - s * 0.56, r.y + r.h / 2, s, -4, { border: P.primary });
        tile(K, "knockout", r.x + r.w / 2 + s * 0.56, r.y + r.h / 2, s, 4, { border: P.primary });
      });
      function ribbon() { // across the top-right corner
        var L = Math.min(w, h) * (K.square ? 0.42 : 0.5), bw = Math.min(w, h) * (K.square ? 0.07 : 0.085);
        c.save(); c.translate(w, 0); c.rotate(Math.PI / 4);
        c.shadowColor = "rgba(0,0,0,.5)"; c.shadowBlur = u;
        c.fillStyle = P.accent; c.fillRect(-L, L * 0.42, 2 * L, bw);
        c.shadowColor = "transparent";
        fitLine(K, "COMING SOON", R(-L * 0.42, L * 0.42, L * 0.84, bw), { c: "#fff", size: bw * 0.5 });
        c.restore();
      }
      logo(K, S.logo, "left");
      flow(K, S.copy, copyItems(K, { kicker: { kind: "pill", bg: P.accent, c: "#fff" }, head: { c: "#fff" }, cta: { bg: P.primary, c: "#111" } }), { align: K.wide ? "left" : "center" });
      ess(K, S.ess, { panel: "#ffffff", label: P.accent, codeStyle: "solid", codeBg: "#111", codeInk: "gold", qrSide: "left", border: null, radius: 0.06, shadow: false, cardBorder: true, colAlign: "bottom" });
      termsAndFoot(K, S, {});
      if (!K.campaign && !K.wide) ribbon();
      else if (!K.campaign && S.art) stamp(K, S.art.x + S.art.w * 0.82, S.art.y + S.art.h * 0.2, Math.min(S.art.w, S.art.h) * 0.2, "COMING", "SOON", P.primary, -14);
    }
  };

  /* 4. live: spotlight cone, circular framed live game with pulse rings */
  T.live = {
    pal: { bg: "#060608", primary: GOLD, accent: RED }, img: ["live"],
    copy: { kicker: "Live games", headline: "Live games, real moments", sub: "Watch every draw happen live on WIN B casino", cta: "Watch live" },
    draw: function (K) {
      var S = skel(K, { art: 0.55, artFirst: true, wideArt: 0.42, wideArtLeft: true }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      var cx = S.art.x + S.art.w / 2, cy = S.art.y + S.art.h / 2, rr0 = Math.min(S.art.w, S.art.h) * 0.4;
      backdrop(K, function () {
        c.fillStyle = P.bg; c.fillRect(0, 0, w, h);
        c.fillStyle = rad(c, cx, cy + rr0, 0, Math.max(w, h) * 0.7, [[0, alpha(P.accent, 0.35)], [1, "rgba(0,0,0,0)"]]); c.fillRect(0, 0, w, h);
      });
      // spotlight cone
      c.save(); c.beginPath(); c.moveTo(cx - rr0 * 0.25, 0); c.lineTo(cx + rr0 * 0.25, 0); c.lineTo(cx + rr0 * 1.7, cy + rr0 * 1.1); c.lineTo(cx - rr0 * 1.7, cy + rr0 * 1.1); c.closePath();
      c.fillStyle = lin(c, 0, 0, 0, cy + rr0, [[0, "rgba(255,255,255,.22)"], [1, "rgba(255,255,255,0)"]]); c.fill(); c.restore();
      c.save(); c.beginPath(); c.ellipse(cx, cy + rr0 * 1.08, rr0 * 1.4, rr0 * 0.2, 0, 0, Math.PI * 2);
      c.fillStyle = rad(c, cx, cy + rr0 * 1.08, 0, rr0 * 1.4, [[0, alpha(P.primary, 0.45)], [1, alpha(P.primary, 0)]]); c.fill(); c.restore();
      [1.32, 1.2, 1.1].forEach(function (k, i) { c.beginPath(); c.arc(cx, cy, rr0 * k, 0, Math.PI * 2); c.lineWidth = u * (0.3 + i * 0.25); c.strokeStyle = alpha(P.accent, 0.25 + i * 0.25); c.stroke(); });
      art(K, R(cx - rr0, cy - rr0, rr0 * 2, rr0 * 2), function () {
        c.save(); c.beginPath(); c.arc(cx, cy, rr0, 0, Math.PI * 2); c.clip();
        if (K.img.live) cover(c, K.img.live, cx - rr0, cy - rr0, rr0 * 2, rr0 * 2); c.restore();
        c.beginPath(); c.arc(cx, cy, rr0, 0, Math.PI * 2); c.lineWidth = u * 0.9; c.strokeStyle = P.primary; c.stroke();
      }, "circle");
      // LIVE pill
      var ph = rr0 * 0.26, pw = ph * 3.1, px = cx - pw / 2, py = cy + rr0 - ph * 0.55;
      c.save(); c.shadowColor = alpha(P.accent, 0.8); c.shadowBlur = ph * 0.6; rr(c, px, py, pw, ph, ph / 2); c.fillStyle = P.accent; c.fill(); c.restore();
      c.beginPath(); c.arc(px + ph * 0.55, py + ph / 2, ph * 0.17, 0, Math.PI * 2); c.fillStyle = "#fff"; c.fill();
      fitLine(K, "LIVE", R(px + ph * 0.85, py, pw - ph * 1.2, ph), { c: "#fff", size: ph * 0.58 });
      logo(K, S.logo, K.wide ? "left" : "center");
      flow(K, S.copy, copyItems(K, { kicker: { c: P.accent }, head: { c: "#fff" }, cta: { bg: P.accent } }), { align: K.wide ? "left" : "center" });
      ess(K, S.ess, { panel: "rgba(255,255,255,.04)", border: alpha(P.accent, 0.9), label: "#fff", codeStyle: "solid", codeBg: P.accent, codeInk: "#fff", glow: alpha(P.accent, 0.5) });
      termsAndFoot(K, S, {});
    }
  };

  /* 5. aviator: graph-paper sky, rising flight curve, plane at its tip */
  T.aviator = {
    pal: { bg: "#0a0a0c", primary: GOLD, accent: RED }, img: ["plane", "skyrush"],
    copy: { kicker: "Aviator", headline: "Fly higher with Aviator", sub: "Watch the plane climb and cash out whenever you choose", cta: "Play Aviator" },
    draw: function (K) {
      var S = skel(K, { art: 0.52, wideArt: 0.45 }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      backdrop(K, function () {
        c.fillStyle = lin(c, 0, 0, 0, h, [[0, P.bg], [0.65, shade(P.accent, -0.72)], [1, shade(P.accent, -0.5)]]); c.fillRect(0, 0, w, h);
        c.save(); c.strokeStyle = "rgba(255,255,255,.06)"; c.lineWidth = 1;
        for (var x = 0; x < w; x += u * 6) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
        for (var y = 0; y < h; y += u * 6) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
        c.restore();
        sparkles(K, 5, 30, "#ffffff", 0.35);
      });
      art(K, S.art, function (r) {
        var x0 = r.x, y0 = r.y + r.h * 0.96, x1 = r.x + r.w * 0.78, y1 = r.y + r.h * 0.28;
        function pt(t) { return [x0 + (x1 - x0) * t, y0 - (y0 - y1) * Math.pow(t, 2.3)]; }
        c.save(); c.beginPath(); c.moveTo(x0, y0);
        for (var i = 1; i <= 40; i++) { var q = pt(i / 40); c.lineTo(q[0], q[1]); }
        c.lineTo(x1, y0); c.closePath();
        c.fillStyle = lin(c, 0, y1, 0, y0, [[0, alpha(P.accent, 0.55)], [1, alpha(P.accent, 0.05)]]); c.fill();
        c.beginPath(); c.moveTo(x0, y0);
        for (var j = 1; j <= 40; j++) { var q2 = pt(j / 40); c.lineTo(q2[0], q2[1]); }
        c.shadowColor = P.accent; c.shadowBlur = u * 2; c.lineWidth = u * 1.1; c.strokeStyle = P.accent; c.lineCap = "round"; c.stroke();
        c.restore();
        var pw = Math.min(r.w * 0.42, r.h * 0.6), ang = Math.atan2(-(y0 - y1) * 2.3, (x1 - x0));
        if (K.img.plane) {
          c.save(); c.translate(x1, y1); c.rotate(Math.max(ang * 0.55, -0.6));
          c.drawImage(K.img.plane, -pw * 0.45, -pw * 0.3, pw, pw * 110 / 240); c.restore();
        }
      });
      logo(K, S.logo, "left");
      flow(K, S.copy, copyItems(K, { kicker: { kind: "pill", bg: P.accent, c: "#fff" }, head: { c: "#fff" }, cta: { bg: P.primary, c: "#111" } }), { align: "left", valign: "top" });
      ess(K, S.ess, { panel: "rgba(0,0,0,.6)", border: alpha(P.accent, 0.8), label: P.primary, codeStyle: "solid", codeBg: "gold", codeInk: "#111" });
      termsAndFoot(K, S, {});
    }
  };

  /* 6. mines: a 5x5 board of tiles with gems and one mine, Mines art as a sticker */
  T.mines = {
    pal: { bg: "#0c0d12", primary: GOLD, accent: ORANGE }, img: ["mines"],
    copy: { kicker: "Mines", headline: "Play Mines on WIN B casino", sub: "Pick your tiles. Cash out when you choose.", cta: "Play Mines" },
    draw: function (K) {
      var S = skel(K, { art: 0.56, artFirst: true, wideArt: 0.42, wideArtLeft: true }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      var cx = S.art.x + S.art.w / 2, cy = S.art.y + S.art.h / 2;
      backdrop(K, function () {
        c.fillStyle = P.bg; c.fillRect(0, 0, w, h);
        c.fillStyle = rad(c, cx, cy, 0, Math.max(w, h) * 0.7, [[0, alpha(P.accent, 0.35)], [1, "rgba(0,0,0,0)"]]); c.fillRect(0, 0, w, h);
        stripes(K, -30, u * 2.2, u * 0.12, "#ffffff", 0.05);
      });
      art(K, S.art, function (r) {
        var side = Math.min(r.w, r.h) * 0.94, bx = cx - side / 2, by = cy - side / 2;
        c.save(); c.shadowColor = "rgba(0,0,0,.6)"; c.shadowBlur = side * 0.06;
        rr(c, bx, by, side, side, side * 0.06); c.fillStyle = "#171a24"; c.fill(); c.restore();
        rr(c, bx, by, side, side, side * 0.06); c.lineWidth = Math.max(2, side * 0.012); c.strokeStyle = P.primary; c.stroke();
        var n = 5, g = side * 0.025, pad = side * 0.04, ts = (side - 2 * pad - (n - 1) * g) / n;
        var gems = { "0,1": 1, "1,3": 1, "2,0": 1, "2,2": 1, "3,4": 1, "4,1": 1 }, mine = "3,2";
        for (var yy = 0; yy < n; yy++) for (var xx = 0; xx < n; xx++) {
          var tx = bx + pad + xx * (ts + g), ty = by + pad + yy * (ts + g), key = yy + "," + xx;
          rr(c, tx, ty, ts, ts, ts * 0.16);
          if (gems[key]) { c.fillStyle = lin(c, 0, ty, 0, ty + ts, [[0, "#2f2a14"], [1, "#1b1708"]]); c.fill(); c.lineWidth = ts * 0.04; c.strokeStyle = alpha(P.primary, 0.8); c.stroke(); gem(c, tx + ts / 2, ty + ts / 2, ts * 0.62); }
          else if (key === mine) { c.fillStyle = lin(c, 0, ty, 0, ty + ts, [[0, shade(P.accent, -0.2)], [1, shade(P.accent, -0.55)]]); c.fill(); bomb(c, tx + ts / 2, ty + ts / 2, ts * 0.8); }
          else { c.fillStyle = lin(c, 0, ty, 0, ty + ts, [[0, "#323848"], [1, "#222632"]]); c.fill(); c.fillStyle = "rgba(255,255,255,.08)"; rr(c, tx + ts * 0.1, ty + ts * 0.08, ts * 0.8, ts * 0.18, ts * 0.09); c.fill(); }
        }
        if (K.img.mines) tile(K, "mines", bx + side * 0.98, by + side * 0.04, side * 0.34, 10, { border: P.primary, radius: 0.5 });
      });
      logo(K, S.logo, K.wide ? "left" : "center");
      flow(K, S.copy, copyItems(K, { kicker: { c: P.accent }, head: { c: "#fff" }, cta: { bg: P.accent, c: "#fff" } }), { align: K.wide ? "left" : "center" });
      ess(K, S.ess, { panel: "#171a24", border: alpha(P.primary, 0.7), label: P.primary, codeStyle: "dashed", codeInk: "#fff" });
      termsAndFoot(K, S, {});
    }
  };

  /* 7. slots: marquee bulbs around the edge, a slot machine with three reels */
  T.slots = {
    pal: { bg: "#7a0006", primary: GOLD, accent: RED }, img: ["fruits", "olympus", "coin"],
    copy: { kicker: "Slots", headline: "Spin the reels", sub: "Colourful slots, real-money play, on your phone", cta: "Spin now" },
    draw: function (K) {
      var S = skel(K, { art: 0.52, artFirst: true, wideArt: 0.45, pad: 7.5 }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      backdrop(K, function () {
        c.fillStyle = rad(c, w / 2, h * 0.4, 0, Math.max(w, h) * 0.8, [[0, shade(P.bg, 0.25)], [0.55, P.bg], [1, "#1a0002"]]); c.fillRect(0, 0, w, h);
        rays(K, w / 2, S.art.y + S.art.h / 2, 18, "#ffffff", 0.04);
      });
      // marquee bulbs
      var ins = u * 2.6, step = u * 4.2, br = u * 0.75;
      c.save(); rr(c, ins - u * 1.2, ins - u * 1.2, w - 2 * ins + u * 2.4, h - 2 * ins + u * 2.4, u * 3); c.lineWidth = u * 0.5; c.strokeStyle = alpha(P.primary, 0.5); c.stroke();
      function bulb(x, y, on) { c.beginPath(); c.arc(x, y, br, 0, Math.PI * 2); c.fillStyle = on ? "#fff3b0" : P.primary; c.shadowColor = P.primary; c.shadowBlur = on ? br * 3 : br; c.fill(); }
      var i = 0, x, y;
      for (x = ins; x <= w - ins; x += step) { bulb(x, ins, i++ % 2); bulb(x, h - ins, i % 2); }
      for (y = ins + step; y < h - ins; y += step) { bulb(ins, y, i++ % 2); bulb(w - ins, y, i % 2); }
      c.restore();
      art(K, S.art, function (r) {
        var mw = Math.min(r.w, r.h * 1.55), mh = Math.min(r.h, mw / 1.25), mx = r.x + (r.w - mw) / 2, my = r.y + (r.h - mh) / 2;
        c.save(); c.shadowColor = "rgba(0,0,0,.6)"; c.shadowBlur = mw * 0.05;
        rr(c, mx, my, mw, mh, mw * 0.06); c.fillStyle = lin(c, 0, my, 0, my + mh, [[0, "#ffe680"], [0.5, GOLD2], [1, "#b56b00"]]); c.fill(); c.restore();
        var top = mh * 0.2;
        rr(c, mx + mw * 0.04, my + mh * 0.04, mw * 0.92, top - mh * 0.04, mw * 0.03); c.fillStyle = shade(P.accent, -0.3); c.fill();
        fitLine(K, "★  SLOTS  ★", R(mx + mw * 0.08, my + mh * 0.04, mw * 0.84, top - mh * 0.04), { c: "#fff", size: top * 0.55, i: true });
        var wx = mx + mw * 0.05, wy = my + top + mh * 0.03, ww = mw * 0.9, wh = mh - top - mh * 0.08;
        rr(c, wx, wy, ww, wh, mw * 0.03); c.fillStyle = "#120406"; c.fill();
        var g = ww * 0.03, rs = Math.min((ww - 4 * g) / 3, wh - 2 * g);
        ["fruits", "olympus", "coin"].forEach(function (k, j) {
          var rx = wx + g + j * (rs + g) + (ww - 3 * rs - 4 * g) / 2 + 0, ry = wy + (wh - rs) / 2;
          c.save(); rr(c, rx, ry, rs, rs, rs * 0.1); c.clip();
          if (K.img[k]) cover(c, K.img[k], rx, ry, rs, rs);
          c.fillStyle = lin(c, 0, ry, 0, ry + rs, [[0, "rgba(0,0,0,.55)"], [0.25, "rgba(0,0,0,0)"], [0.75, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,.55)"]]); c.fillRect(rx, ry, rs, rs);
          c.restore();
        });
        c.save(); c.strokeStyle = P.accent; c.lineWidth = Math.max(2, mh * 0.012); c.shadowColor = P.accent; c.shadowBlur = mh * 0.03;
        c.beginPath(); c.moveTo(wx + g * 0.3, wy + wh / 2); c.lineTo(wx + ww - g * 0.3, wy + wh / 2); c.stroke(); c.restore();
      });
      logo(K, S.logo, K.wide ? "left" : "center");
      flow(K, S.copy, copyItems(K, { kicker: { c: P.primary }, head: { c: "gold", stroke: "rgba(60,0,0,.85)" }, cta: { bg: "gold", c: "#3a0000" } }), { align: K.wide ? "left" : "center" });
      ess(K, S.ess, { panel: "rgba(20,0,2,.75)", border: P.primary, label: P.primary, codeStyle: "solid", codeBg: "gold", codeInk: "#3a0000" });
      termsAndFoot(K, S, {});
    }
  };

  /* 8. register: white page, black top banner, numbered steps */
  T.register = {
    pal: { bg: "#ffffff", primary: GOLD, accent: RED }, img: [],
    copy: { kicker: "Sign up", headline: "Sign up in under a minute", sub: "Register with your phone number and start playing", cta: "Register now" },
    draw: function (K) {
      var S = skel(K, { art: 0.48, wideArt: 0.42 }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      var light = backdrop(K, function () {
        c.fillStyle = P.bg; c.fillRect(0, 0, w, h);
        stripes(K, -35, u * 3, u * 0.6, "#000", 0.035);
      });
      var ink = light ? "#111" : "#fff", inkSoft = light ? "#3b3b3b" : "rgba(255,255,255,.85)";
      var bandH = S.logo.y + S.logo.h + S.pad * 0.55;
      c.fillStyle = "#0b0b0c"; c.fillRect(0, 0, w, bandH);
      c.fillStyle = P.primary; c.fillRect(0, bandH, w, u * 1.1);
      c.fillStyle = P.accent; c.fillRect(0, bandH + u * 1.1, w, u * 0.5);
      S.copy.y += u * 1.5; S.copy.h -= u * 1.5;
      logo(K, R(S.logo.x, S.logo.y - S.pad * 0.2, K.wide ? S.logo.w : S.logo.w, S.logo.h), K.wide ? "left" : "center");
      art(K, S.art, function (r) {
        var steps = ["Scan the QR code", "Register with your phone number", "Start playing"];
        var rowH = Math.min(r.h / 3, r.w * 0.2), y0 = r.y + (r.h - rowH * 3) / 2;
        steps.forEach(function (t, i) {
          var y = y0 + i * rowH, d = rowH * 0.7, cx = r.x + d / 2 + u;
          c.beginPath(); c.arc(cx, y + rowH / 2, d / 2, 0, Math.PI * 2); c.fillStyle = i === 2 ? P.accent : "#111"; c.fill();
          fitLine(K, String(i + 1), R(cx - d / 2, y + rowH / 2 - d / 2, d, d), { c: i === 2 ? "#fff" : P.primary, size: d * 0.55 });
          flow(K, R(cx + d / 2 + d * 0.35, y + rowH * 0.1, r.w - d - d * 0.35 - u, rowH * 0.8), [{ t: t, s: rowH * 0.36, c: ink, w: 800, ml: 2, lh: 1.1 }], { align: "left" });
          if (i < 2) { c.fillStyle = alpha(light ? "#000000" : "#ffffff", 0.12); c.fillRect(cx - u * 0.15, y + rowH / 2 + d / 2 + u * 0.3, u * 0.3, rowH - d - u * 0.6); }
        });
      });
      flow(K, S.copy, copyItems(K, { kicker: { kind: "pill", bg: P.accent, c: "#fff" }, head: { c: ink }, sub: { c: inkSoft }, offer: { bg: "#111", c: P.primary }, cta: { bg: "#111", c: P.primary } }), { align: K.wide ? "left" : "center" });
      ess(K, S.ess, { panel: "#0b0b0c", label: P.primary, codeStyle: "solid", codeBg: "gold", codeInk: "#111", radius: 0.07 });
      termsAndFoot(K, S, { ink: light ? "#444" : "rgba(255,255,255,.8)", hostInk: ink, terms: light ? "#555" : null });
    }
  };

  /* 9. mobile: orange/red gradient with circles, a tilted phone mock-up beside the copy */
  T.mobile = {
    pal: { bg: "#a30010", primary: GOLD, accent: ORANGE }, img: ["olympus", "mines", "skyrush", "fruits"],
    copy: { kicker: "On your phone", headline: "Your casino in your pocket", sub: "Deposit & withdraw with mobile money", cta: "Play on your phone" },
    draw: function (K) {
      var S = skel(K, { art: 0, wideArt: 0.34, wideArtLeft: true, noSquare: true }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      backdrop(K, function () {
        c.fillStyle = lin(c, 0, 0, w, h, [[0, P.accent], [0.55, P.bg], [1, shade(P.bg, -0.6)]]); c.fillRect(0, 0, w, h);
        c.save(); c.fillStyle = "#fff"; c.globalAlpha = 0.07;
        c.beginPath(); c.arc(w * 0.9, h * 0.15, Math.min(w, h) * 0.45, 0, Math.PI * 2); c.fill();
        c.beginPath(); c.arc(w * 0.05, h * 0.75, Math.min(w, h) * 0.3, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 0.12; c.lineWidth = u * 0.5; c.strokeStyle = "#fff";
        c.beginPath(); c.arc(w * 0.9, h * 0.15, Math.min(w, h) * 0.55, 0, Math.PI * 2); c.stroke();
        c.restore();
      });
      var phoneR, copyR;
      if (K.wide) { phoneR = S.art; copyR = S.copy; }
      else {
        var pw = S.main.w * 0.44;
        phoneR = R(S.main.x, S.main.y, pw, S.main.h);
        copyR = R(S.main.x + pw + 4 * u, S.main.y, S.main.w - pw - 4 * u, S.main.h);
      }
      // the phone
      var ph = Math.min(phoneR.h * 0.98, phoneR.w * 2.05), pww = ph / 2.05, pcx = phoneR.x + phoneR.w / 2, pcy = phoneR.y + phoneR.h / 2;
      c.save(); c.translate(pcx, pcy); c.rotate(-0.07);
      c.shadowColor = "rgba(0,0,0,.55)"; c.shadowBlur = pww * 0.15; c.shadowOffsetY = pww * 0.05;
      rr(c, -pww / 2, -ph / 2, pww, ph, pww * 0.16); c.fillStyle = "#0d0d0f"; c.fill();
      c.shadowColor = "transparent";
      rr(c, -pww / 2, -ph / 2, pww, ph, pww * 0.16); c.lineWidth = pww * 0.015; c.strokeStyle = "#444"; c.stroke();
      var sx = -pww / 2 + pww * 0.05, sy = -ph / 2 + pww * 0.05, sw = pww * 0.9, sh = ph - pww * 0.1;
      c.save(); rr(c, sx, sy, sw, sh, pww * 0.12); c.clip();
      c.fillStyle = lin(c, 0, sy, 0, sy + sh, [[0, "#1a1c22"], [1, "#0b0b0c"]]); c.fillRect(sx, sy, sw, sh);
      if (K.hero) cover(c, K.hero, sx, sy, sw, sh);
      else {
        var lh = sw * 0.8 / LOGO_RATIO;
        if (K.img.logo) c.drawImage(K.img.logo, sx + sw * 0.1, sy + sh * 0.08, sw * 0.8, lh);
        var gs = sw * 0.4, gg = sw * 0.06, gx = sx + (sw - 2 * gs - gg) / 2, gy = sy + sh * 0.08 + lh + sh * 0.05;
        ["olympus", "mines", "skyrush", "fruits"].forEach(function (k, i) {
          var tx = gx + (i % 2) * (gs + gg), ty = gy + Math.floor(i / 2) * (gs + gg);
          c.save(); rr(c, tx, ty, gs, gs, gs * 0.14); c.clip(); if (K.img[k]) cover(c, K.img[k], tx, ty, gs, gs); c.restore();
        });
        var by2 = gy + 2 * gs + gg + sh * 0.04, bh = Math.min(sw * 0.16, sy + sh - by2 - sh * 0.05);
        if (bh > 4) {
          rr(c, sx + sw * 0.08, by2, sw * 0.4, bh, bh / 2); c.fillStyle = P.primary; c.fill();
          fitLine(K, "DEPOSIT", R(sx + sw * 0.1, by2, sw * 0.36, bh), { c: "#111", size: bh * 0.42 });
          rr(c, sx + sw * 0.52, by2, sw * 0.4, bh, bh / 2); c.lineWidth = bh * 0.06; c.strokeStyle = "#fff"; c.stroke();
          fitLine(K, "WITHDRAW", R(sx + sw * 0.54, by2, sw * 0.36, bh), { c: "#fff", size: bh * 0.42 });
        }
      }
      c.restore();
      rr(c, -pww * 0.17, -ph / 2 + pww * 0.07, pww * 0.34, pww * 0.07, pww * 0.035); c.fillStyle = "#000"; c.fill();
      c.restore();
      logo(K, S.logo, "left");
      flow(K, copyR, copyItems(K, { hs: 9.5, kicker: { kind: "pill", bg: "#111", c: P.primary }, head: { c: "#fff", shadow: "rgba(0,0,0,.3)" }, cta: { bg: "#111", c: "#fff" }, offer: { bg: "#fff", c: "#111" } }), { align: "left" });
      ess(K, S.ess, { panel: "rgba(0,0,0,.72)", label: P.primary, codeStyle: "solid", codeBg: "#fff", codeInk: "#111", radius: 0.12 });
      termsAndFoot(K, S, {});
    }
  };

  /* 10. weekend: yellow page, confetti, calendar pages SAT / SUN */
  T.weekend = {
    pal: { bg: GOLD, primary: GOLD, accent: RED }, img: [],
    copy: { kicker: "This weekend", headline: "Weekend game time", sub: "Instant games, real money · all weekend long", cta: "Play this weekend" },
    draw: function (K) {
      var S = skel(K, { art: 0.4, artFirst: true, wideArt: 0.38 }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      var light = backdrop(K, function () {
        c.fillStyle = rad(c, w / 2, h * 0.35, 0, Math.max(w, h) * 0.8, [[0, shade(P.bg, 0.35)], [1, shade(P.bg, -0.08)]]); c.fillRect(0, 0, w, h);
        confetti(K, 7, Math.round(70 * (w * h) / (1080 * 1080)), [P.accent, "#111111", "#ffffff", ORANGE], 0.85);
      });
      var ink = light ? "#111" : "#fff";
      logo(K, S.logo, K.wide ? "left" : "center", true);
      art(K, S.art, function (r) {
        var ch = Math.min(r.h * 0.92, r.w * 0.55), cw = ch * 0.82, gap = cw * 0.12;
        ["SAT", "SUN"].forEach(function (d, i) {
          var x = r.x + r.w / 2 + (i ? gap / 2 : -gap / 2 - cw), y = r.y + (r.h - ch) / 2;
          c.save(); c.translate(x + cw / 2, y + ch / 2); c.rotate((i ? 6 : -6) * Math.PI / 180); c.translate(-cw / 2, -ch / 2);
          c.shadowColor = "rgba(0,0,0,.35)"; c.shadowBlur = cw * 0.08; c.shadowOffsetY = cw * 0.03;
          rr(c, 0, 0, cw, ch, cw * 0.08); c.fillStyle = "#fff"; c.fill(); c.shadowColor = "transparent";
          c.save(); rr(c, 0, 0, cw, ch, cw * 0.08); c.clip(); c.fillStyle = i ? "#111" : P.accent; c.fillRect(0, 0, cw, ch * 0.3); c.restore();
          [0.28, 0.72].forEach(function (f) { rr(c, cw * f - cw * 0.04, -ch * 0.06, cw * 0.08, ch * 0.16, cw * 0.04); c.fillStyle = "#444"; c.fill(); });
          fitLine(K, i ? "SUNDAY" : "SATURDAY", R(cw * 0.1, ch * 0.08, cw * 0.8, ch * 0.2), { c: i ? P.primary : "#fff", size: ch * 0.09 });
          fitLine(K, d, R(cw * 0.06, ch * 0.36, cw * 0.88, ch * 0.56), { c: "#111", size: ch * 0.36, i: true });
          c.restore();
        });
      });
      flow(K, S.copy, copyItems(K, { kicker: { kind: "pill", bg: "#111", c: P.primary }, head: { c: ink }, sub: { c: light ? "#2a2a2a" : "#fff" }, offer: { bg: P.accent, c: "#fff" }, cta: { bg: "#111", c: P.primary } }), { align: K.wide ? "left" : "center" });
      ess(K, S.ess, { panel: "#111", label: P.primary, codeStyle: "dashed", codeInk: "gold", radius: 0.1 });
      termsAndFoot(K, S, { ink: light ? "#1a1a1a" : "#fff", hostInk: ink, terms: light ? "#333" : null });
    }
  };

  /* 11. vip: black art-deco poster, double gold frame with corner fans, crown */
  T.vip = {
    pal: { bg: "#070707", primary: GOLD, accent: RED }, img: [],
    copy: { kicker: "VIP", headline: "Play in style", sub: "Premium casino games for players who know what they like", cta: "Join WIN B" },
    draw: function (K) {
      var S = skel(K, { art: 0.32, artFirst: true, pad: 9.5, wideArt: 0.3 }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      backdrop(K, function () {
        c.fillStyle = rad(c, w / 2, h * 0.3, 0, Math.max(w, h) * 0.9, [[0, "#211907"], [0.6, P.bg], [1, "#000"]]); c.fillRect(0, 0, w, h);
        c.save(); c.strokeStyle = alpha(P.primary, 0.07); c.lineWidth = 1;
        var st = u * 7; for (var x = -h; x < w + h; x += st) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x + h, h); c.stroke(); c.beginPath(); c.moveTo(x, h); c.lineTo(x + h, 0); c.stroke(); }
        c.restore();
      });
      // deco frame
      var i1 = u * 3, i2 = u * 4.4;
      c.save(); c.strokeStyle = P.primary;
      c.lineWidth = u * 0.5; c.strokeRect(i1, i1, w - 2 * i1, h - 2 * i1);
      c.lineWidth = u * 0.18; c.strokeRect(i2, i2, w - 2 * i2, h - 2 * i2);
      [[i2, i2, 0], [w - i2, i2, Math.PI / 2], [w - i2, h - i2, Math.PI], [i2, h - i2, -Math.PI / 2]].forEach(function (k) {
        c.save(); c.translate(k[0], k[1]); c.rotate(k[2]);
        for (var j = 1; j <= 3; j++) { c.beginPath(); c.arc(0, 0, u * 1.05 * j, 0, Math.PI / 2); c.lineWidth = u * 0.2; c.stroke(); }
        c.beginPath(); c.moveTo(0, 0); c.lineTo(u * 3.3, u * 3.3); c.stroke();
        c.restore();
      });
      c.restore();
      art(K, S.art, function (r) {
        var s = Math.min(r.h * 0.95, r.w * 0.5);
        crown(c, r.x + r.w / 2, r.y + r.h / 2 - s * 0.05, s, goldFill(K, r.y, r.y + r.h));
      });
      logo(K, S.logo, K.wide ? "left" : "center");
      flow(K, S.copy, copyItems(K, { kicker: { c: P.primary, s: 3.4 }, head: { c: "gold", i: false }, sub: { c: "#d9cfb2" }, offer: { bg: "rgba(0,0,0,0)", c: P.primary, border: P.primary }, cta: { bg: "gold", c: "#111" } }), { align: K.wide ? "left" : "center" });
      ess(K, S.ess, { panel: alpha(P.primary, 0.06), border: alpha(P.primary, 0.7), label: P.primary, codeStyle: "dashed", codeInk: "gold", radius: 0.02 });
      termsAndFoot(K, S, { ink: "#cbbf9a", hostInk: P.primary });
    }
  };

  /* 12. new player: red page with halftone corners, a fanned stack of polaroid game cards and a NEW sticker */
  T["new-player"] = {
    pal: { bg: RED, primary: GOLD, accent: "#111111" }, img: ["hilo", "crash", "wings"],
    copy: { kicker: "New player", headline: "New here? Start playing today", sub: "Quick sign-up, simple games, mobile money payments", cta: "Get started" },
    draw: function (K) {
      var S = skel(K, { art: 0.56, artFirst: true, wideArt: 0.42 }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      backdrop(K, function () {
        c.fillStyle = lin(c, 0, 0, w * 0.3, h, [[0, shade(P.bg, 0.12)], [1, shade(P.bg, -0.5)]]); c.fillRect(0, 0, w, h);
        dots(K, w * 0.55, 0, w, h * 0.32, u * 2.4, u * 0.9, "#ffffff", 0.25, w, 0);
        dots(K, 0, h * 0.7, w * 0.45, h, u * 2.4, u * 0.9, "#000000", 0.3, 0, h);
      });
      art(K, S.art, function (r) {
        var s = Math.min(r.h * 0.72, r.w * 0.42), cx = r.x + r.w / 2, cy = r.y + r.h / 2 - s * 0.06;
        tile(K, "hilo", cx - s * 0.62, cy + s * 0.06, s, -14, { frame: s * 0.05, frameColor: "#fff", polaroid: true, radius: 0.04 });
        tile(K, "wings", cx + s * 0.62, cy + s * 0.06, s, 12, { frame: s * 0.05, frameColor: "#fff", polaroid: true, radius: 0.04 });
        tile(K, "crash", cx, cy - s * 0.04, s, -2, { frame: s * 0.05, frameColor: "#fff", polaroid: true, radius: 0.04 });
        var sr = s * 0.3, sx = cx + s * 0.95, sy = cy - s * 0.55;
        c.save(); c.shadowColor = "rgba(0,0,0,.4)"; c.shadowBlur = sr * 0.3; starburst(c, sx, sy, sr, sr * 0.82, 18); c.fillStyle = P.primary; c.fill(); c.restore();
        c.save(); c.translate(sx, sy); c.rotate(-0.25); fitLine(K, "NEW", R(-sr * 0.7, -sr * 0.4, sr * 1.4, sr * 0.8), { c: "#111", size: sr * 0.6, i: true }); c.restore();
      });
      logo(K, S.logo, K.wide ? "left" : "center");
      flow(K, S.copy, copyItems(K, { kicker: { kind: "pill", bg: "#111", c: "#fff" }, head: { c: "#fff", shadow: "rgba(0,0,0,.35)" }, sub: { c: "#fff" }, offer: { bg: "#fff", c: shade(P.bg, -0.2) }, cta: { bg: "#111", c: P.primary } }), { align: K.wide ? "left" : "center" });
      ess(K, S.ess, { panel: "#ffffff", label: shade(P.bg, -0.1), codeStyle: "solid", codeBg: "#111", codeInk: "gold", radius: 0.07, border: null, qrSide: "left", cardBorder: true });
      termsAndFoot(K, S, { ink: "rgba(255,255,255,.88)" });
    }
  };

  /* 13. jackpot: rays and coins around a big circular starburst badge with the headline inside */
  T.jackpot = {
    pal: { bg: "#4a0006", primary: GOLD, accent: RED }, img: [],
    copy: { kicker: "Instant games", headline: "Chase the thrill", sub: "Slots, crash games and more on WIN B casino", cta: "Play now" },
    draw: function (K) {
      var S = skel(K, { art: 0.62, artFirst: true, wideArt: 0.5, wideArtLeft: true }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      var bx = S.art.x + S.art.w / 2, by = S.art.y + S.art.h / 2, br = Math.min(S.art.w, S.art.h) / 2 * 0.98;
      backdrop(K, function () {
        c.fillStyle = P.bg; c.fillRect(0, 0, w, h);
        rays(K, bx, by, 32, shade(P.accent, -0.2), 0.55, 0.05);
        c.fillStyle = rad(c, bx, by, br * 0.5, Math.max(w, h), [[0, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,.75)"]]); c.fillRect(0, 0, w, h);
      });
      var rnd = rng(23);
      for (var i = 0; i < 9; i++) {
        var a = rnd() * Math.PI * 2, d = br * (1.05 + rnd() * 0.25);
        var x = bx + Math.cos(a) * d, y = by + Math.sin(a) * d * 0.9, cr = br * (0.09 + rnd() * 0.07);
        if (x > cr && x < w - cr && y > S.logo.y + S.logo.h + cr && y < S.ess.y - cr) coin(K, x, y, cr);
      }
      c.save(); c.shadowColor = "rgba(0,0,0,.5)"; c.shadowBlur = br * 0.1;
      starburst(c, bx, by, br, br * 0.9, 30); c.fillStyle = goldFill(K, by - br, by + br); c.fill(); c.restore();
      c.beginPath(); c.arc(bx, by, br * 0.8, 0, Math.PI * 2); c.fillStyle = lin(c, 0, by - br, 0, by + br, [[0, shade(P.accent, -0.1)], [1, shade(P.accent, -0.6)]]); c.fill();
      c.lineWidth = br * 0.03; c.strokeStyle = "#fff3b0"; c.stroke();
      c.save(); c.setLineDash([br * 0.02, br * 0.035]); c.beginPath(); c.arc(bx, by, br * 0.72, 0, Math.PI * 2); c.lineWidth = br * 0.018; c.strokeStyle = alpha(P.primary, 0.9); c.stroke(); c.restore();
      var inner = R(bx - br * 0.56, by - br * 0.46, br * 1.12, br * 0.92), headInBadge = !K.hero;
      if (K.hero) art(K, R(bx - br * 0.7, by - br * 0.7, br * 1.4, br * 1.4), function () {}, "circle");
      else flow(K, inner, [
        K.copy.kicker ? { t: K.copy.kicker, s: br * 0.08, c: P.primary, up: true, ml: 1, gap: br * 0.05 } : null,
        { t: K.copy.headline, s: br * 0.28, c: "#fff", i: true, up: true, lh: 0.98, ml: 4, shadow: "rgba(0,0,0,.5)" }
      ], { align: "center" });
      logo(K, S.logo, K.wide ? "left" : "center");
      flow(K, S.copy, copyItems(K, { noKicker: true, noHead: headInBadge, head: { c: "#fff" }, cta: { bg: "gold", c: "#3a0000" } }), { align: K.wide ? "left" : "center" });
      ess(K, S.ess, { panel: "rgba(0,0,0,.65)", border: P.primary, label: P.primary, codeStyle: "solid", codeBg: "gold", codeInk: "#3a0000" });
      termsAndFoot(K, S, {});
    }
  };

  /* 14. football: dark pitch markings, a ball with a COMING SOON stamp */
  T.football = {
    pal: { bg: "#080a09", primary: GOLD, accent: RED }, img: ["goal"],
    copy: { kicker: "Football", headline: "Football coming soon", sub: "Sports coming soon · Casino open now", cta: "Play the casino" },
    draw: function (K) {
      var S = skel(K, { art: 0.5, artFirst: true, wideArt: 0.4, wideArtLeft: true }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      backdrop(K, function () {
        c.fillStyle = rad(c, w / 2, h / 2, 0, Math.max(w, h) * 0.75, [[0, "#17201b"], [1, P.bg]]); c.fillRect(0, 0, w, h);
        c.save(); c.strokeStyle = "rgba(255,255,255,.13)"; c.lineWidth = u * 0.4;
        var m = u * 3.5; c.strokeRect(m, m, w - 2 * m, h - 2 * m);
        if (K.wide) {
          c.beginPath(); c.moveTo(w / 2, m); c.lineTo(w / 2, h - m); c.stroke();
          c.beginPath(); c.arc(w / 2, h / 2, h * 0.2, 0, Math.PI * 2); c.stroke();
          c.strokeRect(m, h * 0.25, w * 0.13, h * 0.5); c.strokeRect(w - m - w * 0.13, h * 0.25, w * 0.13, h * 0.5);
        } else {
          c.beginPath(); c.moveTo(m, h / 2); c.lineTo(w - m, h / 2); c.stroke();
          c.beginPath(); c.arc(w / 2, h / 2, w * 0.2, 0, Math.PI * 2); c.stroke();
          c.strokeRect(w * 0.22, m, w * 0.56, h * 0.13); c.strokeRect(w * 0.22, h - m - h * 0.13, w * 0.56, h * 0.13);
        }
        c.restore();
        stripes(K, 60, u * 18, u * 7, "#ffffff", 0.025);
      });
      art(K, S.art, function (r) {
        var br = Math.min(r.w, r.h) * 0.38, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        c.save(); c.beginPath(); c.ellipse(cx, cy + br * 1.05, br * 0.9, br * 0.14, 0, 0, Math.PI * 2); c.fillStyle = "rgba(0,0,0,.55)"; c.fill(); c.restore();
        football(c, cx, cy, br);
        if (K.img.goal) tile(K, "goal", cx - br * 1.15, cy + br * 0.55, br * 0.62, -10, { border: P.primary });
        if (!K.campaign) stamp(K, cx + br * 1.0, cy + br * 0.5, br * 0.48, "COMING", "SOON", P.primary, -14);
      });
      logo(K, S.logo, K.wide ? "left" : "center");
      flow(K, S.copy, copyItems(K, { kicker: { c: P.primary }, head: { c: "#fff" }, cta: { bg: P.primary, c: "#111" } }), { align: K.wide ? "left" : "center" });
      ess(K, S.ess, { panel: "rgba(255,255,255,.06)", border: "rgba(255,255,255,.35)", label: "#fff", codeStyle: "solid", codeBg: "gold", codeInk: "#111" });
      termsAndFoot(K, S, {});
    }
  };

  /* 15. basketball: court arcs, an oversized ball bleeding off the corner, left-aligned type */
  T.basketball = {
    pal: { bg: "#0d0805", primary: GOLD, accent: ORANGE }, img: [],
    copy: { kicker: "Basketball", headline: "Basketball coming soon", sub: "Sports coming soon · Casino open now", cta: "Play the casino" },
    draw: function (K) {
      var S = skel(K, { art: 0.42, artFirst: true, logoW: 0.55, wideArt: 0.36 }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      backdrop(K, function () {
        c.fillStyle = lin(c, 0, 0, 0, h, [[0, shade(P.accent, -0.8)], [1, P.bg]]); c.fillRect(0, 0, w, h);
        c.save(); c.strokeStyle = alpha(P.accent, 0.28); c.lineWidth = u * 0.45;
        c.beginPath(); c.arc(w / 2, h * 1.02, Math.min(w, h) * 0.62, Math.PI, 0); c.stroke();
        c.strokeRect(w / 2 - w * 0.16, h * 1.02 - Math.min(w, h) * 0.45, w * 0.32, Math.min(w, h) * 0.5);
        c.beginPath(); c.arc(w / 2, h * 1.02 - Math.min(w, h) * 0.45, w * 0.16, Math.PI, 0); c.stroke();
        c.restore();
      });
      var br = K.wide ? h * 0.6 : Math.min(w * 0.46, S.art.h * 0.75);
      if (K.square) br = Math.min(S.art.h * 0.62, S.art.w * 0.38);
      if (K.wide) br = Math.min(h * 0.36, S.art.w * 0.48);
      var bcx = K.wide ? S.art.x + S.art.w * 0.5 : K.square ? S.art.x + S.art.w - br * 0.8 : w - br * 0.55, bcy = K.wide ? h * 0.42 : S.art.y + S.art.h * 0.42;
      if (!K.hero) {
        c.save(); c.fillStyle = rad(c, bcx, bcy, br * 0.8, br * 1.5, [[0, alpha(P.accent, 0.35)], [1, alpha(P.accent, 0)]]); c.fillRect(0, 0, w, h); c.restore();
        basketball(c, bcx, bcy, br);
      } else art(K, R(S.art.x + S.art.w * 0.35, S.art.y, S.art.w * 0.65, S.art.h), function () {});
      if (!K.campaign) {
        var sh = Math.min(S.art.h * 0.2, u * 9), sx = K.wide ? S.copy.x : S.art.x, sy = K.wide ? S.copy.y + S.copy.h - sh : S.art.y + S.art.h - sh * 1.2;
        c.save(); c.translate(sx, sy); c.rotate(-0.06);
        rr(c, 0, 0, sh * 4.2, sh, sh * 0.2); c.fillStyle = "#fff"; c.fill();
        fitLine(K, "COMING SOON", R(sh * 0.3, 0, sh * 3.6, sh), { c: "#111", size: sh * 0.5, i: true });
        c.restore();
        if (K.wide) S.copy.h -= sh * 1.4;
      }
      logo(K, S.logo, "left");
      flow(K, S.copy, copyItems(K, { kicker: { kind: "pill", bg: P.accent, c: "#111" }, head: { c: "#fff" }, offer: { bg: P.accent, c: "#111" }, cta: { bg: P.accent, c: "#111" } }), { align: "left", valign: K.wide ? "top" : "center" });
      ess(K, S.ess, { panel: "rgba(0,0,0,.6)", border: P.accent, label: P.accent, codeStyle: "solid", codeBg: P.accent, codeInk: "#111" });
      termsAndFoot(K, S, {});
    }
  };

  /* 16. referral: a big white perforated ticket; the QR stub is the hero */
  T.referral = {
    pal: { bg: "#0b0b0c", primary: GOLD, accent: RED }, img: [],
    copy: { kicker: "Personal invitation", headline: "Join with my link", sub: "Scan the code to sign up on WIN B casino", cta: "Scan to join" },
    draw: function (K) {
      var c = K.c, P = K.P, w = K.w, h = K.h, u = K.u, p = 5.5 * u;
      backdrop(K, function () {
        c.fillStyle = rad(c, w / 2, h / 2, 0, Math.max(w, h) * 0.75, [[0, "#232323"], [1, P.bg]]); c.fillRect(0, 0, w, h);
        stripes(K, -45, u * 5, u * 2.2, P.primary, 0.09);
      });
      var hasTerms = !!K.copy.terms, footH = (K.wide ? 4 : 3.3) * u, termsH = hasTerms ? (K.wide ? 6 : 5.4) * u : 0;
      var foot = R(p, h - p * 0.7 - footH, w - 2 * p, footH), terms = hasTerms ? R(p, foot.y - termsH - u, w - 2 * p, termsH) : null;
      var logoH = (K.wide ? 8 : 7) * u, logoR = R(p, p * 0.8, w - 2 * p, logoH);
      var ty = logoR.y + logoH + 3 * u, tb = (terms || foot).y - 2.5 * u, TK = R(p, ty, w - 2 * p, tb - ty);
      var split = K.wide ? TK.w * 0.6 : TK.h * 0.52, nr = Math.min(TK.w, TK.h) * 0.045;
      // ticket outline with notches at the perforation
      c.save(); c.shadowColor = "rgba(0,0,0,.6)"; c.shadowBlur = u * 3; c.shadowOffsetY = u;
      c.beginPath();
      var x0 = TK.x, y0 = TK.y, x1 = TK.x + TK.w, y1 = TK.y + TK.h, cr = nr * 0.6;
      c.moveTo(x0 + cr, y0);
      if (K.wide) { c.lineTo(x0 + split - nr, y0); c.arc(x0 + split, y0, nr, Math.PI, 0, true); }
      c.lineTo(x1 - cr, y0); c.arcTo(x1, y0, x1, y0 + cr, cr);
      if (!K.wide) { c.lineTo(x1, y0 + split - nr); c.arc(x1, y0 + split, nr, -Math.PI / 2, Math.PI / 2, true); }
      c.lineTo(x1, y1 - cr); c.arcTo(x1, y1, x1 - cr, y1, cr);
      if (K.wide) { c.lineTo(x0 + split + nr, y1); c.arc(x0 + split, y1, nr, 0, Math.PI, true); }
      c.lineTo(x0 + cr, y1); c.arcTo(x0, y1, x0, y1 - cr, cr);
      if (!K.wide) { c.lineTo(x0, y0 + split + nr); c.arc(x0, y0 + split, nr, Math.PI / 2, -Math.PI / 2, true); }
      c.lineTo(x0, y0 + cr); c.arcTo(x0, y0, x0 + cr, y0, cr);
      c.closePath(); c.fillStyle = "#fffdf6"; c.fill(); c.restore();
      // perforation
      c.save(); c.setLineDash([u * 1.2, u * 1]); c.lineWidth = u * 0.35; c.strokeStyle = "rgba(0,0,0,.3)"; c.beginPath();
      if (K.wide) { c.moveTo(x0 + split, y0 + nr * 1.4); c.lineTo(x0 + split, y1 - nr * 1.4); } else { c.moveTo(x0 + nr * 1.4, y0 + split); c.lineTo(x1 - nr * 1.4, y0 + split); }
      c.stroke(); c.restore();
      // head of the ticket
      var head = K.wide ? R(x0, y0, split, TK.h) : R(x0, y0, TK.w, split), hp = Math.min(head.w, head.h) * 0.08;
      var bandH = Math.min(head.h * 0.16, u * 7);
      c.save(); c.beginPath(); c.rect(head.x, head.y, head.w, bandH); c.clip(); rr(c, x0, y0, TK.w, bandH * 2, cr); c.fillStyle = P.accent; c.fill(); c.restore();
      fitLine(K, "★  " + (K.copy.kicker || "Invitation").toUpperCase() + "  ★", R(head.x + hp, head.y, head.w - 2 * hp, bandH), { c: "#fff", size: bandH * 0.42 });
      flow(K, R(head.x + hp, head.y + bandH + hp * 0.6, head.w - 2 * hp, head.h - bandH - hp * 1.4),
        copyItems(K, { noKicker: true, head: { c: "#111" }, sub: { c: "#333" }, offer: { bg: P.accent, c: "#fff" }, cta: { bg: "#111", c: P.primary } }), { align: K.wide ? "left" : "center" });
      // stub: code + QR
      var stub = K.wide ? R(x0 + split, y0, TK.w - split, TK.h) : R(x0, y0 + split, TK.w, TK.h - split);
      var sp = Math.min(stub.w, stub.h) * 0.08;
      ess(K, R(stub.x + sp, stub.y + sp, stub.w - 2 * sp, stub.h - 2 * sp), { label: P.accent, codeStyle: "solid", codeBg: "#111", codeInk: "gold", border: null, panel: null, qrSide: "left", shadow: false, cardBorder: true });
      logo(K, logoR, "center");
      if (terms) flow(K, terms, [{ t: K.copy.terms, s: u * 1.7, w: 500, c: "rgba(255,255,255,.7)", lh: 1.2, ml: 3 }], { align: "left", valign: "bottom" });
      footer(K, foot, {});
    }
  };

  /* 17. general: clean white page, red edge bar, black type, a neat 3x2 grid of games */
  T.general = {
    pal: { bg: "#ffffff", primary: GOLD, accent: RED }, img: ["roulette", "mines", "skyrush", "fruits", "olympus", "live"],
    copy: { kicker: "Instant games", headline: "Instant games, real money", sub: "Deposit & withdraw with mobile money", cta: "Play now" },
    draw: function (K) {
      var S = skel(K, { art: 0.5, wideArt: 0.42, pad: 7 }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      var light = backdrop(K, function () {
        c.fillStyle = P.bg; c.fillRect(0, 0, w, h);
        dots(K, w * 0.6, 0, w, h * 0.25, u * 2, u * 0.4, "#000000", 0.15, w, 0);
      });
      var ink = light ? "#111" : "#fff";
      c.fillStyle = P.accent; c.fillRect(0, 0, u * 2, h);
      c.fillStyle = P.primary; c.fillRect(u * 2, 0, u * 0.7, h);
      logo(K, S.logo, "left", true);
      art(K, S.art, function (r) { grid(K, r, ["roulette", "mines", "skyrush", "fruits", "olympus", "live"], K.wide ? 2 : 3, K.wide ? 3 : 2, { gap: 0.07, radius: 0.12, shadowColor: "rgba(0,0,0,.25)" }); });
      flow(K, S.copy, copyItems(K, { kicker: { c: P.accent }, head: { c: ink }, sub: { c: light ? "#3a3a3a" : "#fff" }, offer: { bg: "#111", c: P.primary }, cta: { bg: "#111", c: P.primary } }), { align: "left" });
      ess(K, S.ess, { panel: light ? "#f1f1f3" : "rgba(0,0,0,.6)", label: P.accent, codeStyle: "solid", codeBg: "#111", codeInk: "gold", radius: 0.05, border: light ? "#e2e2e6" : null, cardBorder: true });
      termsAndFoot(K, S, { ink: light ? "#444" : "#fff", hostInk: ink, terms: light ? "#555" : null });
    }
  };

  /* 18. special: synthwave floor grid, neon tube frame, glowing type */
  T.special = {
    pal: { bg: "#050508", primary: GOLD, accent: RED2 }, img: ["olympus"],
    copy: { kicker: "Something new", headline: "Try something new today", sub: "Fresh instant games on WIN B casino", cta: "Play now" },
    draw: function (K) {
      var S = skel(K, { art: 0.45, artFirst: true, pad: 8, wideArt: 0.36, wideArtLeft: true }), c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      backdrop(K, function () {
        c.fillStyle = P.bg; c.fillRect(0, 0, w, h);
        var hz = h * 0.58;
        c.fillStyle = lin(c, 0, hz - h * 0.2, 0, hz, [[0, "rgba(0,0,0,0)"], [1, alpha(P.accent, 0.35)]]); c.fillRect(0, hz - h * 0.2, w, h * 0.2);
        c.save(); c.strokeStyle = alpha(P.accent, 0.45); c.lineWidth = u * 0.22;
        for (var i = -12; i <= 12; i++) { c.beginPath(); c.moveTo(w / 2 + i * w * 0.02, hz); c.lineTo(w / 2 + i * w * 0.22, h); c.stroke(); }
        for (var j = 0; j < 12; j++) { var y = hz + (h - hz) * Math.pow(j / 11, 1.9); c.globalAlpha = 0.3 + 0.7 * j / 11; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
        c.restore();
        sparkles(K, 3, 50, "#ffffff", 0.5);
      });
      // neon frame
      c.save(); var m = u * 3;
      c.shadowColor = P.accent; c.shadowBlur = u * 2.5; c.lineWidth = u * 0.7; c.strokeStyle = P.accent;
      rr(c, m, m, w - 2 * m, h - 2 * m, u * 4); c.stroke(); c.stroke();
      c.shadowBlur = 0; c.lineWidth = u * 0.18; c.strokeStyle = "#ffd9d9"; rr(c, m, m, w - 2 * m, h - 2 * m, u * 4); c.stroke();
      c.restore();
      art(K, S.art, function (r) {
        var s = Math.min(r.w, r.h) * 0.82, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        c.save(); c.shadowColor = P.primary; c.shadowBlur = u * 3; c.lineWidth = u * 0.7; c.strokeStyle = P.primary;
        rr(c, cx - s / 2 - u, cy - s / 2 - u, s + 2 * u, s + 2 * u, s * 0.14 + u); c.stroke(); c.stroke(); c.restore();
        tile(K, "olympus", cx, cy, s, 0, { radius: 0.14 });
      });
      logo(K, S.logo, K.wide ? "left" : "center");
      flow(K, S.copy, copyItems(K, { kicker: { c: P.accent, glow: P.accent }, head: { c: "#fff", glow: P.primary }, sub: { c: "#f3e9ff" }, offer: { bg: "rgba(0,0,0,.6)", c: P.primary, border: P.primary, glow: P.primary }, cta: { bg: P.accent, c: "#fff", glow: P.accent } }), { align: K.wide ? "left" : "center" });
      ess(K, S.ess, { panel: "rgba(5,5,8,.85)", border: P.primary, glow: alpha(P.primary, 0.7), label: P.primary, codeStyle: "dashed", codeInk: "gold" });
      termsAndFoot(K, S, {});
    }
  };

  /* 19. partner ad: a magazine cover — full-bleed art, big masthead, marker-highlighted cover lines */
  T["partner-ad"] = {
    pal: { bg: "#0b0b0c", primary: GOLD, accent: RED }, img: ["olympus"],
    copy: { kicker: "Partner pick", headline: "Recommended by your WIN B partner", sub: "Use my code when you sign up", cta: "Join now" },
    draw: function (K) {
      var c = K.c, P = K.P, w = K.w, h = K.h, u = K.u;
      var S = skel(K, { art: 0, pad: 5.5, logoH: 11, essW: 0.32 });
      var heroIm = K.hero || K.bgImg || K.img.olympus;
      c.fillStyle = P.bg; c.fillRect(0, 0, w, h);
      if (K.wide) {
        if (heroIm) { c.save(); c.beginPath(); c.rect(w * 0.38, 0, w * 0.62, h); c.clip(); cover(c, heroIm, w * 0.38, 0, w * 0.62, h, 0.5, 0.3); c.restore(); }
        c.fillStyle = lin(c, w * 0.38, 0, w * 0.62, 0, [[0, P.bg], [1, alpha("#0b0b0c", 0)]]); c.fillRect(w * 0.38, 0, w * 0.24, h);
      } else if (heroIm) cover(c, heroIm, 0, 0, w, h, 0.5, 0.25);
      c.fillStyle = lin(c, 0, 0, 0, h, [[0, "rgba(0,0,0,.75)"], [0.22, "rgba(0,0,0,.05)"], [0.45, "rgba(0,0,0,.25)"], [0.68, "rgba(0,0,0,.88)"], [1, "rgba(0,0,0,.96)"]]);
      c.fillRect(0, 0, w, h);
      // masthead
      var mh = S.logo.h, mr = K.wide ? S.logo : R(S.pad, S.pad * 0.7, w - 2 * S.pad, mh);
      logo(K, mr, K.wide ? "left" : "center");
      var ly = mr.y + mh + u * 1.2;
      c.fillStyle = P.primary; c.fillRect(mr.x, ly, K.wide ? S.copy.w : mr.w, u * 0.35);
      var issue = R(mr.x, ly + u * 0.8, K.wide ? S.copy.w : mr.w, u * 3);
      fitLine(K, "PARTNER EDITION", R(issue.x, issue.y, issue.w / 2, issue.h), { align: "left", c: "#fff", size: issue.h * 0.75, w: 800 });
      var mon = new Date().toLocaleString("en", { month: "long", year: "numeric" }).toUpperCase();
      fitLine(K, mon, R(issue.x + issue.w / 2, issue.y, issue.w / 2, issue.h), { align: "right", c: "#fff", size: issue.h * 0.75, w: 800 });
      // cover lines
      var cl = K.wide ? R(S.copy.x, issue.y + issue.h + 3 * u, S.copy.w, S.copy.y + S.copy.h - issue.y - issue.h - 3 * u)
        : R(S.main.x, S.main.y + S.main.h * 0.38, S.main.w, S.main.h * 0.62);
      flow(K, cl, copyItems(K, { hs: 10, kicker: { kind: "pill", bg: P.primary, c: "#111" }, head: { c: "#fff", kind: "marker", bg: P.accent, lh: 1.12 }, sub: { c: "#fff" }, cta: { bg: "#fff", c: "#111" } }), { align: "left", valign: "bottom" });
      ess(K, S.ess, { panel: "#ffffff", label: P.accent, codeStyle: "solid", codeBg: "#111", codeInk: "gold", radius: 0.03, qrSide: "right", shadow: false, cardBorder: true });
      termsAndFoot(K, S, {});
    }
  };

  /* 20. premium: gold chevron border around a black card, the WIN B emblem as the hero */
  T.premium = {
    pal: { bg: "#0b0b0c", primary: GOLD, accent: RED }, img: [],
    copy: { kicker: "Premium", headline: "Premium casino experience", sub: "Slots, live games and crash games — all in one place", cta: "Join now" },
    draw: function (K) {
      var c = K.c, P = K.P, w = K.w, h = K.h, u = K.u, b = 4.2 * u;
      c.fillStyle = lin(c, 0, 0, w, h, [[0, "#fff1a6"], [0.3, P.primary], [0.6, GOLD2], [1, "#b97400"]]); c.fillRect(0, 0, w, h);
      c.save(); c.strokeStyle = "rgba(0,0,0,.18)"; c.lineWidth = u * 0.5;
      for (var y = -u * 4; y < h + u * 4; y += u * 3) { c.beginPath(); for (var x = 0; x <= w + u * 3; x += u * 3) c.lineTo(x, y + ((x / (u * 3)) % 2 ? u * 1.5 : 0)); c.stroke(); }
      c.restore();
      c.save(); c.shadowColor = "rgba(0,0,0,.5)"; c.shadowBlur = u * 2;
      rr(c, b, b, w - 2 * b, h - 2 * b, u * 2.5); c.fillStyle = P.bg; c.fill(); c.restore();
      c.save(); rr(c, b, b, w - 2 * b, h - 2 * b, u * 2.5); c.clip();
      if (K.bgImg) { cover(c, K.bgImg, b, b, w - 2 * b, h - 2 * b); c.fillStyle = "rgba(0,0,0,.6)"; c.fillRect(0, 0, w, h); }
      else { c.fillStyle = rad(c, w / 2, h * 0.3, 0, Math.max(w, h) * 0.6, [[0, "#2a2006"], [1, "rgba(0,0,0,0)"]]); c.fillRect(0, 0, w, h); }
      c.restore();
      rr(c, b + u * 1.3, b + u * 1.3, w - 2 * b - u * 2.6, h - 2 * b - u * 2.6, u * 1.6); c.lineWidth = u * 0.2; c.strokeStyle = alpha(P.primary, 0.75); c.stroke();
      var S = skel(K, { art: 0.4, artFirst: true, pad: 10, wideArt: 0.3, wideArtLeft: true });
      art(K, S.art, function (r) {
        var s = Math.min(r.w, r.h) * 0.8, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        c.save(); c.fillStyle = rad(c, cx, cy, 0, s, [[0, alpha(P.primary, 0.4)], [1, alpha(P.primary, 0)]]); c.fillRect(cx - s, cy - s, 2 * s, 2 * s); c.restore();
        [0.72, 0.84].forEach(function (k) { c.beginPath(); c.arc(cx, cy, s * k, 0, Math.PI * 2); c.lineWidth = u * 0.25; c.strokeStyle = alpha(P.primary, 0.5); c.stroke(); });
        if (K.img.mark) { c.save(); c.shadowColor = "rgba(255,190,40,.5)"; c.shadowBlur = s * 0.12; c.drawImage(K.img.mark, cx - s * 0.5, cy - s * 0.5, s, s); c.restore(); }
      });
      logo(K, S.logo, K.wide ? "left" : "center");
      flow(K, S.copy, copyItems(K, { kicker: { c: P.primary }, head: { c: "#fff", i: false }, sub: { c: "#cfcfcf" }, cta: { bg: "gold", c: "#111" } }), { align: K.wide ? "left" : "center" });
      ess(K, S.ess, { panel: "#161616", border: alpha(P.primary, 0.8), label: P.primary, codeStyle: "solid", codeBg: "gold", codeInk: "#111", radius: 0.05 });
      termsAndFoot(K, S, { ink: "#bdbdbd", hostInk: P.primary });
    }
  };

  /* ---------------------------------------------------------------- render */
  function defaultAssetUrl(id) {
    var base = (window.U && window.U.paymentBase) || "";
    return base + "/api/partners/assets/" + encodeURIComponent(id);
  }
  function str(v) { return v == null ? "" : String(v).trim(); }
  function layoutOf(t) {
    if (!t) return "general";
    if (typeof t === "string") return T[t] ? t : "general";
    if (t.builtin !== false && T[t.id]) return t.id;
    var cfg = t.config || {};
    return T[cfg.layout] ? cfg.layout : T[t.id] ? t.id : "general";
  }

  function render(canvas, opts) {
    opts = opts || {};
    var tpl = opts.template || "general", lay = layoutOf(tpl), def = T[lay];
    var cfg = (tpl && typeof tpl === "object" && tpl.builtin === false && tpl.config) || {};
    var size = opts.size || { w: 1080, h: 1080 }, w = Math.round(size.w || 1080), h = Math.round(size.h || 1080);
    var scale = opts.scale || 1;
    var partner = opts.partner || {}, campaign = opts.campaign || null;
    var assetUrl = typeof opts.assetUrl === "function" ? opts.assetUrl : defaultAssetUrl;
    var promo = str(partner.promo_code), pcode = str(partner.code);
    var link = str(opts.link) || (location.origin + "/?ref=" + encodeURIComponent(pcode) + (promo ? "&promo=" + encodeURIComponent(promo) : ""));

    var P = { bg: def.pal.bg, primary: def.pal.primary, accent: def.pal.accent };
    ["primary", "accent"].forEach(function (k) { if (hexRgb(cfg[k])) P[k] = cfg[k]; });
    if (hexRgb(cfg.background)) P.bg = cfg.background;

    var copy;
    if (campaign) {
      copy = { kicker: def.copy.kicker, headline: str(campaign.headline) || str(campaign.title) || def.copy.headline, offer: str(campaign.offer),
        sub: str(campaign.body), cta: str(campaign.cta) || def.copy.cta, terms: str(campaign.terms) };
      if (lay === "sports" || lay === "football" || lay === "basketball") copy.kicker = def.copy.kicker;
    } else {
      copy = { kicker: def.copy.kicker, headline: str(cfg.headline) || def.copy.headline, offer: "", sub: str(cfg.tagline) || def.copy.sub, cta: str(cfg.cta) || def.copy.cta, terms: "" };
    }

    var keys = ["logo", "mark"].concat(def.img || []), loads = {};
    keys.forEach(function (k) { loads[k] = loadImg(IMG + THUMBS[k]); });
    var heroP = campaign && campaign.asset_id ? loadImg(assetUrl(campaign.asset_id), true) : Promise.resolve(null);
    var bgP = cfg.asset_id ? loadImg(assetUrl(cfg.asset_id), true) : Promise.resolve(null);

    return Promise.all([ensureQRLib(), heroP, bgP].concat(keys.map(function (k) { return loads[k]; }))).then(function (res) {
      var img = {}; keys.forEach(function (k, i) { img[k] = res[3 + i]; });
      canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
      var c = canvas.getContext("2d");
      c.setTransform(scale, 0, 0, scale, 0, 0);
      c.clearRect(0, 0, w, h);
      c.lineJoin = "round";
      var K = {
        c: c, w: w, h: h, u: Math.min(w, h) / 100, wide: w / h > 1.4, tall: h / w > 1.5, square: w / h <= 1.4 && h / w < 1.15, P: P, copy: copy, campaign: campaign,
        img: img, hero: res[1], bgImg: res[2], link: link, host: location.host || "winb.casino",
        code: promo ? { label: "PROMO CODE", value: promo } : { label: "PARTNER CODE", value: pcode || "—" }
      };
      def.draw(K);
      c.setTransform(1, 0, 0, 1, 0, 0);
    });
  }

  /* ---------------------------------------------------------------- the generator UI */
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]; }); }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacy(); });
    return Promise.resolve(legacy());
    function legacy() {
      try {
        var ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); var ok = document.execCommand("copy"); ta.remove(); return ok;
      } catch (e) { return false; }
    }
  }
  var CAT_LABEL = { casino: "Casino", sports: "Sports", games: "Games", promo: "Promo", general: "General", custom: "Custom" };

  function mount(el, opts) {
    opts = opts || {};
    var data = opts.data || {}, readOnly = !!opts.readOnly, api = opts.api, onError = typeof opts.onError === "function" ? opts.onError : function () {};
    var partner = data.partner || {}, templates = (data.templates || []).slice(), campaigns = data.campaigns || [], saved = (data.saved || []).slice();
    var sizes = data.sizes && data.sizes.length ? data.sizes : [
      { id: "story", w: 1080, h: 1920, label: "WhatsApp Status · Instagram Story" }, { id: "post", w: 1080, h: 1080, label: "Instagram post · WhatsApp · Telegram" },
      { id: "portrait", w: 1080, h: 1350, label: "Instagram / Facebook portrait" }, { id: "facebook", w: 1200, h: 630, label: "Facebook · Telegram link post" },
      { id: "banner", w: 1200, h: 1500, label: "General advertisement (print-friendly)" }];
    if (!templates.length) templates = TEMPLATE_IDS.map(function (id) { return { id: id, name: id, category: "general", builtin: true, config: {} }; });
    var promo = str(partner.promo_code), code = str(partner.code);
    var link = str(opts.link) || (location.origin + "/?ref=" + encodeURIComponent(code) + (promo ? "&promo=" + encodeURIComponent(promo) : ""));
    var assetUrl = opts.assetUrl || defaultAssetUrl;
    var st = { tpl: templates[0].id, camp: "", size: (sizes.find(function (s) { return s.id === "story"; }) || sizes[0]).id, cat: "" };
    var U = window.U || {};
    function toast(msg, kind) { if (typeof U.toast === "function") U.toast(msg, kind); else status(msg); }
    function status(msg) { var s = el.querySelector(".fly-status"); if (s) { s.textContent = msg; clearTimeout(status.t); status.t = setTimeout(function () { s.textContent = ""; }, 4000); } }
    function tplById(id) { return templates.find(function (t) { return t.id === id; }); }
    function campById(id) { return campaigns.find(function (c) { return c.id === id; }) || null; }
    function sizeById(id) { return sizes.find(function (s) { return s.id === id; }) || sizes[0]; }
    function campsFor(tid) { return campaigns.filter(function (c) { return !c.template_ids || !c.template_ids.length || c.template_ids.indexOf(tid) >= 0; }); }
    var cats = []; templates.forEach(function (t) { var k = t.builtin === false ? "custom" : (t.category || "general"); if (cats.indexOf(k) < 0) cats.push(k); });

    el.classList.add("fly");
    el.innerHTML =
      '<p class="fly-note">' + (promo ? "Your promo code <b>" + esc(promo) + "</b> and your referral QR are added automatically."
        : "Your partner code <b>" + esc(code) + "</b> and your referral QR are added automatically.") + "</p>" +
      (partner.link_live === false ? '<div class="fly-warn" role="alert"><b>Your referral link is switched off.</b> People who scan these flyers won\'t be linked to you until it is switched back on.</div>' : "") +
      '<div class="fly-grid">' +
        '<section class="fly-pick panel">' +
          '<div class="panel-title">1 · Choose a design</div>' +
          (cats.length > 1 ? '<div class="chip-list fly-cats"><button type="button" class="chip on" data-cat="">All</button>' +
            cats.map(function (k) { return '<button type="button" class="chip" data-cat="' + esc(k) + '">' + esc(CAT_LABEL[k] || k.charAt(0).toUpperCase() + k.slice(1)) + "</button>"; }).join("") + "</div>" : "") +
          '<div class="fly-thumbs" role="listbox" aria-label="Flyer designs"></div>' +
        "</section>" +
        '<section class="fly-stage panel">' +
          '<div class="fly-opts">' +
            '<div class="field"><label for="flyCamp">Campaign</label><select id="flyCamp" class="fly-camp"></select></div>' +
            '<div class="field"><label>Size</label><div class="chip-list fly-sizes">' +
              sizes.map(function (s) { return '<button type="button" class="chip" data-size="' + esc(s.id) + '" title="' + esc(s.label || "") + '">' + esc(s.label ? s.label.split(" · ")[0] : s.id) + ' <span class="fly-dim">' + s.w + "×" + s.h + "</span></button>"; }).join("") +
            "</div></div>" +
          "</div>" +
          '<div class="fly-preview"><canvas class="fly-canvas" aria-label="Flyer preview"></canvas><div class="fly-busy" hidden>Drawing…</div></div>' +
          '<div class="fly-actions">' +
            '<button type="button" class="btn btn-primary btn-sm" data-act="png">Download PNG</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="jpg">Download JPG</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="share">Share</button>' +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="code">Copy ' + (promo ? "promo" : "partner") + " code</button>" +
            '<button type="button" class="btn btn-ghost btn-sm" data-act="link">Copy link</button>' +
          "</div>" +
          (readOnly ? "" : '<div class="fly-save"><input type="text" class="fly-title" maxlength="60" placeholder="Name this flyer (optional)" aria-label="Flyer name"><button type="button" class="btn btn-primary btn-sm" data-act="save">Save flyer</button></div>') +
          '<p class="fly-status" aria-live="polite"></p>' +
        "</section>" +
      "</div>" +
      '<section class="panel fly-savedbox"><div class="panel-title">Saved flyers</div><div class="fly-saved"></div></section>';

    var thumbsBox = el.querySelector(".fly-thumbs"), campSel = el.querySelector(".fly-camp"), canvas = el.querySelector(".fly-canvas"), busy = el.querySelector(".fly-busy");

    /* gallery with lazily drawn thumbnails */
    var queue = [], running = false;
    function pump() {
      if (running || !queue.length) return;
      running = true;
      var job = queue.shift();
      render(job.canvas, { template: job.tpl, campaign: null, size: { w: 1080, h: 1080 }, scale: 0.2, partner: partner, link: link, assetUrl: assetUrl })
        .catch(function () {}).then(function () { running = false; setTimeout(pump, 0); });
    }
    var io = "IntersectionObserver" in window ? new IntersectionObserver(function (ents) {
      ents.forEach(function (e) { if (e.isIntersecting) { io.unobserve(e.target); queue.push(e.target._job); pump(); } });
    }, { rootMargin: "200px" }) : null;
    function drawThumbs() {
      thumbsBox.innerHTML = "";
      templates.forEach(function (t) {
        var k = t.builtin === false ? "custom" : (t.category || "general");
        if (st.cat && k !== st.cat) return;
        var b = document.createElement("button");
        b.type = "button"; b.className = "fly-thumb" + (t.id === st.tpl ? " on" : ""); b.setAttribute("role", "option");
        b.setAttribute("aria-selected", t.id === st.tpl ? "true" : "false"); b.dataset.tpl = t.id;
        var cv = document.createElement("canvas"); cv.width = 216; cv.height = 216;
        var nm = document.createElement("span"); nm.textContent = t.name || t.id;
        b.appendChild(cv); b.appendChild(nm); thumbsBox.appendChild(b);
        var job = { canvas: cv, tpl: t };
        if (io) { b._job = job; io.observe(b); } else { queue.push(job); }
      });
      pump();
    }
    function fillCamps() {
      var list = campsFor(st.tpl);
      if (st.camp && !list.some(function (c) { return c.id === st.camp; })) st.camp = "";
      campSel.innerHTML = '<option value="">No campaign (general)</option>' + list.map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (c.id === st.camp ? " selected" : "") + ">" + esc(c.title || c.headline) + (c.offer ? " — " + esc(c.offer) : "") + "</option>";
      }).join("");
      campSel.disabled = !list.length;
    }
    function syncChips() {
      el.querySelectorAll(".fly-sizes .chip").forEach(function (b) { b.classList.toggle("on", b.dataset.size === st.size); });
      el.querySelectorAll(".fly-thumb").forEach(function (b) { var on = b.dataset.tpl === st.tpl; b.classList.toggle("on", on); b.setAttribute("aria-selected", on ? "true" : "false"); });
      var sz = sizeById(st.size); canvas.style.aspectRatio = sz.w + " / " + sz.h;
      canvas.parentNode.classList.toggle("fly-wide", sz.w > sz.h);
    }
    var token = 0;
    function draw() {
      var my = ++token, sz = sizeById(st.size), off = document.createElement("canvas");
      busy.hidden = false;
      render(off, { template: tplById(st.tpl), campaign: campById(st.camp), size: sz, partner: partner, link: link, assetUrl: assetUrl }).then(function () {
        if (my !== token) return;
        canvas.width = off.width; canvas.height = off.height;
        canvas.getContext("2d").drawImage(off, 0, 0);
        busy.hidden = true;
      }, function (e) { if (my === token) { busy.hidden = true; onError("Couldn't draw the flyer: " + (e && e.message || e)); } });
    }
    function update() { fillCamps(); syncChips(); draw(); }

    function fileName(ext) { return "winb-" + st.tpl + "-" + st.size + "." + ext; }
    function blob(type, q) { return new Promise(function (res) { try { canvas.toBlob(function (b) { res(b); }, type, q); } catch (e) { res(null); } }); }
    function download(type, ext) {
      blob(type, 0.92).then(function (b) {
        if (!b) { onError("Couldn't export the image — one of the pictures may be blocked. Try another design."); return; }
        var url = URL.createObjectURL(b), a = document.createElement("a");
        a.href = url; a.download = fileName(ext); document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      });
    }
    function share() {
      blob("image/png").then(function (b) {
        var file = null;
        try { if (b && typeof File === "function") file = new File([b], fileName("png"), { type: "image/png" }); } catch (e) { file = null; }
        var text = "Join me on WIN B casino" + (promo ? " — promo code " + promo : "") + ": " + link;
        if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
          navigator.share({ files: [file], title: "WIN B casino", text: text }).catch(function (e) { if (!e || e.name !== "AbortError") copyLink(); });
        } else if (navigator.share && !file) {
          navigator.share({ title: "WIN B casino", text: text, url: link }).catch(function () {});
        } else copyLink();
      });
    }
    function copyLink() { copyText(link).then(function (ok) { toast(ok ? "Link copied — paste it anywhere." : "Copy this link: " + link, ok ? "ok" : ""); }); }
    function save() {
      if (readOnly || typeof api !== "function") return;
      var btn = el.querySelector('[data-act="save"]'), title = el.querySelector(".fly-title");
      btn.disabled = true;
      api("/api/partners/flyers/saved", { body: { template_id: st.tpl, campaign_id: st.camp || null, size: st.size, title: title && title.value.trim() || tplName(st.tpl) } }).then(function (r) {
        btn.disabled = false;
        if (!r || !r.ok) { onError((r && r.data && (r.data.message || r.data.error)) || "Couldn't save the flyer."); return; }
        var f = r.data && r.data.flyer;
        if (f) saved.unshift(f);
        if (title) title.value = "";
        drawSaved(); toast("Flyer saved.", "ok");
      }, function () { btn.disabled = false; onError("Couldn't save the flyer."); });
    }
    function tplName(id) { var t = tplById(id); return t ? (t.name || t.id) : id; }
    function drawSaved() {
      var box = el.querySelector(".fly-saved");
      if (!saved.length) { box.innerHTML = '<p class="fly-dim">' + (readOnly ? "No saved flyers." : "Nothing saved yet — pick a design and press Save flyer.") + "</p>"; return; }
      box.innerHTML = '<ul class="fly-list">' + saved.map(function (f) {
        var sz = sizeById(f.size), cp = f.campaign_id ? campById(f.campaign_id) : null, gone = !tplById(f.template_id);
        var when = f.created_at ? new Date(f.created_at) : null;
        return '<li><button type="button" class="fly-open" data-open="' + esc(f.id) + '"' + (gone ? " disabled" : "") + ">" +
          "<b>" + esc(f.title || tplName(f.template_id)) + "</b>" +
          '<span class="fly-dim">' + esc(tplName(f.template_id)) + " · " + esc(sz ? (sz.label || sz.id).split(" · ")[0] : f.size) +
          (cp ? " · " + esc(cp.title || cp.headline) : f.campaign_id ? " · campaign ended" : "") +
          (when && !isNaN(when) ? " · " + esc(when.toLocaleDateString()) : "") + "</span></button>" +
          (readOnly ? "" : '<button type="button" class="btn btn-ghost btn-sm fly-del" data-del="' + esc(f.id) + '" aria-label="Delete saved flyer">Delete</button>') + "</li>";
      }).join("") + "</ul>";
    }
    function del(id, btn) {
      if (readOnly || typeof api !== "function") return;
      if (!window.confirm("Delete this saved flyer?")) return;
      btn.disabled = true;
      api("/api/partners/flyers/saved/" + encodeURIComponent(id) + "/delete", { body: {} }).then(function (r) {
        if (!r || !r.ok) { btn.disabled = false; onError((r && r.data && (r.data.message || r.data.error)) || "Couldn't delete the flyer."); return; }
        saved = saved.filter(function (f) { return f.id !== id; }); drawSaved(); toast("Flyer deleted.", "ok");
      }, function () { btn.disabled = false; onError("Couldn't delete the flyer."); });
    }

    el.addEventListener("click", function (e) {
      var t = e.target.closest("button"); if (!t || !el.contains(t)) return;
      if (t.dataset.cat != null && t.closest(".fly-cats")) {
        st.cat = t.dataset.cat; el.querySelectorAll(".fly-cats .chip").forEach(function (b) { b.classList.toggle("on", b === t); }); drawThumbs(); return;
      }
      if (t.dataset.tpl) { st.tpl = t.dataset.tpl; update(); if (window.innerWidth < 900) canvas.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
      if (t.dataset.size) { st.size = t.dataset.size; update(); return; }
      if (t.dataset.open) {
        var f = saved.find(function (x) { return x.id === t.dataset.open; }); if (!f || !tplById(f.template_id)) return;
        st.tpl = f.template_id; st.size = sizeById(f.size).id; st.camp = f.campaign_id && campById(f.campaign_id) ? f.campaign_id : "";
        if (st.cat) { st.cat = ""; el.querySelectorAll(".fly-cats .chip").forEach(function (b) { b.classList.toggle("on", !b.dataset.cat); }); drawThumbs(); }
        update(); canvas.scrollIntoView({ behavior: "smooth", block: "center" }); return;
      }
      if (t.dataset.del) { del(t.dataset.del, t); return; }
      switch (t.dataset.act) {
        case "png": download("image/png", "png"); break;
        case "jpg": download("image/jpeg", "jpg"); break;
        case "share": share(); break;
        case "code": copyText(promo || code).then(function (ok) { toast(ok ? (promo ? "Promo code copied." : "Partner code copied.") : "Your code: " + (promo || code), ok ? "ok" : ""); }); break;
        case "link": copyLink(); break;
        case "save": save(); break;
      }
    });
    campSel.addEventListener("change", function () { st.camp = campSel.value; draw(); });

    drawThumbs(); drawSaved(); update();
  }

  window.VBFlyers = { TEMPLATE_IDS: TEMPLATE_IDS.slice(), render: render, mount: mount };
})();
