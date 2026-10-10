/* Rendo Wings — the artwork, drawn to look real: golden hour over the sea. A low sun and its glow, the first stars
   overhead, three layers of cloud lit from below; a dark sea with a perspective swell, the sun's glitter path and the
   ships' reflections; two haze-grey aircraft carriers with lit islands, radar, parked jets, hangar bays, wakes and bow
   waves; a glossy red biplane with a spinning propeller and a pilot in a leather helmet; missiles with exhaust flames
   and smoke trails; gold and emerald pickup coins; and the effects — a fireball (the pre-rendered sheet
   mines-blast.webp), smoke, sparks, debris, spray and floating text.
   The world is measured in units, 136 tall (the width follows the screen), and drawn at the screen's full resolution;
   everything that doesn't change by itself is rendered once per size and cached. The game (wings.js) owns the
   flight; this file only draws it. */
(function (global) {
  "use strict";
  const WORLD_H = 136;          // world height in units
  const SEA_Y = 112;            // the water line at the ships
  const DECK_Y = 99;            // the flight deck of both carriers
  const CARRIER_L = 150;        // carrier length
  const HORIZON = 95;           // where sky meets sea: the eye is a little above the flight deck
  const WHEEL_X = 3.4;          // the main wheels touch down this far ahead of the plane's centre…
  const WHEEL_Y = 6;            // …and this far below it, so a plane centred at DECK_Y − 6 stands on the deck
  const GROUND_PITCH = -0.25;   // a tail-dragger sits nose-high on the deck (radians; negative is nose up)
  const SUN_FX = 0.67;          // the sun: this far across the screen…
  const SUN_Y = 87.6;           // …and this high, just above the horizon
  const SUN_R = 4.2;
  const ISLAND = 0.58 * CARRIER_L;
  const PLANE_BOX = { x: -18, y: -10.5, w: 33, h: 17.5 };   // the plane's sprite, in plane units…
  const PS = 1.2;               // …which are this many world units (it is scaled about its wheels)
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const TAU = Math.PI * 2;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const mix = (a, b, t) => a + (b - a) * t;
  function mk(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  function seeded(seed) {
    let v = seed >>> 0 || 1;
    return () => ((v = (Math.imul(v, 1664525) + 1013904223) >>> 0) / 4294967296);
  }
  /* a repeatable random number in [0, 1) for the pair (i, k) */
  function hash(i, k) {
    let h = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((k | 0) + 0x632be5ab, 0xc2b2ae35);
    h ^= h >>> 13;
    h = Math.imul(h, 0x27d4eb2f);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  /* 2-D gradient noise in about [0, 1]; `period` makes it repeat across x, for textures that tile sideways */
  function perlin(seed) {
    const rnd = seeded(seed);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = perm[i];
      perm[i] = perm[j];
      perm[j] = tmp;
    }
    const p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
    const GX = [1, -1, 1, -1, 1, -1, 0, 0];
    const GY = [1, 1, -1, -1, 0, 0, 1, -1];
    return (x, y, period) => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const xf = x - xi;
      const yf = y - yi;
      let x0 = xi;
      let x1 = xi + 1;
      if (period) {
        x0 = ((x0 % period) + period) % period;
        x1 = ((x1 % period) + period) % period;
      }
      x0 &= 255;
      x1 &= 255;
      const y0 = yi & 255;
      const y1 = (yi + 1) & 255;
      const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
      const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
      const a = p[p[x0] + y0] & 7;
      const b = p[p[x1] + y0] & 7;
      const c = p[p[x0] + y1] & 7;
      const d = p[p[x1] + y1] & 7;
      const n00 = GX[a] * xf + GY[a] * yf;
      const n10 = GX[b] * (xf - 1) + GY[b] * yf;
      const n01 = GX[c] * xf + GY[c] * (yf - 1);
      const n11 = GX[d] * (xf - 1) + GY[d] * (yf - 1);
      const top = n00 + u * (n10 - n00);
      const bot = n01 + u * (n11 - n01);
      return 0.5 + 0.5 * (top + v * (bot - top));
    };
  }
  /* fractal noise: octaves of detail, each half the size and half the strength of the one before */
  function fbm(n, x, y, octaves, period) {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * n(x * f, y * f, period ? period * f : 0);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }
  function lin(g, x0, y0, x1, y1, stops) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([o, c]) => gr.addColorStop(o, c));
    return gr;
  }
  function rad(g, x0, y0, r0, x1, y1, r1, stops) {
    const gr = g.createRadialGradient(x0, y0, r0, x1, y1, r1);
    stops.forEach(([o, c]) => gr.addColorStop(o, c));
    return gr;
  }
  function pill(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  /* a wing or tailplane seen from the side: round leading edge to the right, sharp trailing edge to the left */
  function airfoil(cx, cy, chord, thick) {
    const le = cx + chord / 2;
    const te = cx - chord / 2;
    const p = new Path2D();
    p.moveTo(te, cy);
    p.bezierCurveTo(te + chord * 0.3, cy - thick * 0.95, le - chord * 0.22, cy - thick * 1.05, le, cy - thick * 0.15);
    p.bezierCurveTo(le + chord * 0.03, cy + thick * 0.35, le - chord * 0.2, cy + thick * 0.55, te + chord * 0.42, cy + thick * 0.3);
    p.closePath();
    return p;
  }
  function airfoilTop(cx, cy, chord, thick) {
    const le = cx + chord / 2;
    const te = cx - chord / 2;
    const p = new Path2D();
    p.moveTo(te, cy);
    p.bezierCurveTo(te + chord * 0.3, cy - thick * 0.95, le - chord * 0.22, cy - thick * 1.05, le, cy - thick * 0.15);
    return p;
  }

  /* how the thin cloud kinds are made (cumulus are heaped from puffs — see makeCumulus): feature size (fx × fy units), how much noise breaks up the soft envelope,
     how far the light reaches into them, and their colours — shadowed body, cool top, and the warm lit edge */
  const CLOUD = {
    stratus: { fx: 26, fy: 2.4, env: 0.8, noise: 1.8, cut: 0.2, soft: 0.3, alpha: 0.9, reach: 1.2, litGain: 2.2, litBias: 0.35,
      body: [112, 82, 108], top: [138, 104, 128], lit: [255, 196, 140] },
    cirrus: { fx: 30, fy: 3.5, env: 0.7, noise: 2.0, cut: 0.32, soft: 0.4, alpha: 0.55, reach: 1.5, litGain: 1.6, litBias: 0.25,
      body: [80, 82, 130], top: [96, 98, 150], lit: [236, 150, 150] }
  };
  /* the cloud layers, back to front: n sprites each, spaced sp apart, sliding past at pf of the camera's speed and
     drifting dr units a second, their tops between y[0] and y[1] */
  const LAYERS = [
    { kind: "cirrus", seed: 11, n: 3, wu: [120, 150], hu: 14, sp: 140, pf: 0.06, dr: 0.5, y: [3, 22] },
    { kind: "stratus", seed: 23, n: 4, wu: [90, 130], hu: 8, sp: 85, pf: 0.03, dr: 0.25, y: [74, 87] },
    { kind: "cumulus", seed: 41, n: 4, wu: [72, 100], hu: 32, sp: 112, pf: 0.16, dr: 1, y: [20, 46] }
  ];

  function createRenderer(canvas) {
    const ctx = canvas.getContext("2d");
    const reduce = global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const blast = new Image();
    blast.src = "assets/img/mines-blast.webp";
    let s = 4;          // device pixels per world unit
    let Wd = 0;         // canvas size in device pixels
    let Hd = 0;
    let W = 160;        // visible world width, in units
    let key = "";
    let C = null;       // the cached artwork
    let parts = [];
    let pops = [];
    let shake = 0;
    let smokeT = 0;
    let fireT = 0;
    let WX = 0;         // this frame's world → device offset
    let WY = 0;
    let camL = 0;
    const rnd = (a, b) => a + Math.random() * (b - a);

    /* ---------------- the sky: twilight overhead, the warm glow of the low sun along the horizon ---------------- */
    function makeSky() {
      const h = Math.ceil(HORIZON * s) + 2;
      const c = mk(Wd, h);
      const g = c.getContext("2d");
      g.fillStyle = lin(g, 0, 0, 0, h, [[0, "#050c1f"], [0.3, "#0b1a3a"], [0.56, "#1a3563"], [0.74, "#33487a"],
        [0.86, "#6c6789"], [0.95, "#c08a80"], [1, "#efb27c"]]);
      g.fillRect(0, 0, Wd, h);
      const sx = SUN_FX * Wd;
      const sy = SUN_Y * s;
      /* stars: thick overhead, fading out toward the glow */
      const r = seeded(7);
      const count = Math.round((Wd * h) / 2600);
      for (let i = 0; i < count; i++) {
        const x = r() * Wd;
        const y = Math.pow(r(), 1.8) * h * 0.62;
        const a = (0.15 + r() * 0.75) * (1 - y / (h * 0.62));
        const rr = Math.max(0.5, (0.06 + r() * r() * 0.22) * s);
        g.fillStyle = "rgba(" + (215 + Math.round(r() * 40)) + "," + (222 + Math.round(r() * 33)) + ",255," + a.toFixed(2) + ")";
        g.beginPath();
        g.arc(x, y, rr, 0, TAU);
        g.fill();
      }
      /* the title, faint, high in the sky */
      g.font = "900 " + (6.2 * s).toFixed(1) + "px " + FONT;
      g.textAlign = "center";
      g.textBaseline = "middle";
      if ("letterSpacing" in g) g.letterSpacing = (1.3 * s).toFixed(1) + "px";
      g.fillStyle = "rgba(225,232,255,.07)";
      g.fillText("WINGS", Wd / 2, 9.5 * s);
      g.strokeStyle = "rgba(225,232,255,.06)";
      g.lineWidth = Math.max(1, s * 0.12);
      g.strokeText("WINGS", Wd / 2, 9.5 * s);
      if ("letterSpacing" in g) g.letterSpacing = "0px";
      /* the sun's glow: a wide warm wash along the horizon, then a tighter halo */
      g.save();
      g.translate(sx, sy);
      g.scale(1, 0.34);
      g.fillStyle = rad(g, 0, 0, 0, 0, 0, Wd * 0.8, [[0, "rgba(255,214,150,.9)"], [0.07, "rgba(255,178,112,.62)"],
        [0.22, "rgba(236,128,98,.3)"], [0.5, "rgba(150,96,140,.12)"], [1, "rgba(150,96,140,0)"]]);
      g.fillRect(-Wd * 2, -h * 4, Wd * 4, h * 8);
      g.restore();
      g.fillStyle = rad(g, sx, sy, SUN_R * s * 0.9, sx, sy, SUN_R * s * 6, [[0, "rgba(255,238,200,.7)"],
        [0.35, "rgba(255,200,140,.22)"], [1, "rgba(255,190,130,0)"]]);
      g.fillRect(0, 0, Wd, h);
      /* the sun itself, a little flattened by the thick air at the horizon */
      g.save();
      g.translate(sx, sy);
      g.scale(1, 0.93);
      g.fillStyle = rad(g, 0, -SUN_R * s * 0.15, 0, 0, 0, SUN_R * s, [[0, "#fffef8"], [0.55, "#fff6dc"], [0.85, "#ffdc98"], [1, "#ffbf6e"]]);
      g.beginPath();
      g.arc(0, 0, SUN_R * s, 0, TAU);
      g.fill();
      g.restore();
      /* a fine film grain, so the long gradients never band */
      const img = g.getImageData(0, 0, Wd, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const nse = (r() - 0.5) * 7;
        d[i] += nse;
        d[i + 1] += nse;
        d[i + 2] += nse;
      }
      g.putImageData(img, 0, 0);
      return { canvas: c, sunX: sx };
    }

    /* ---------------- clouds, from noise ----------------
       Streaks of stratus and cirrus: a soft envelope broken up by fractal noise. The light comes from below and a little to the right,
       where the low sun is: wherever the density falls away toward the sun, the cloud's edge glows warm, and the rest
       stays in cool shade. Made at half resolution — clouds are soft anyway. */
    function makeCloud(kind, seed, wu, hu) {
      const K = CLOUD[kind];
      const res = Math.max(1.2, s * 0.55);
      const w = Math.ceil(wu * res);
      const h = Math.ceil(hu * res);
      const n = perlin(seed);
      const D = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        const v = (y + 0.5) / h;
        for (let x = 0; x < w; x++) {
          const u = (x + 0.5) / w;
          const ex = (u - 0.5) / 0.5;
          const ey = (v - 0.5) / 0.5;
          const env = 1 - ex * ex * ex * ex - ey * ey;
          const f = fbm(n, (u * wu) / K.fx, (v * hu) / K.fy, 5);
          D[y * w + x] = env * K.env + (f - 0.5) * K.noise - K.cut;
        }
      }
      const c = mk(w, h);
      const g = c.getContext("2d");
      const img = g.createImageData(w, h);
      const d = img.data;
      const ox = Math.round(0.33 * K.reach * res);
      const oy = Math.round(0.94 * K.reach * res);
      for (let y = 0; y < h; y++) {
        const top = 1 - y / h;
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const dd = D[i];
          if (dd <= 0) continue;
          const xs = x + ox;
          const ys = y + oy;
          const dl = xs < w && ys < h ? D[ys * w + xs] : 0;
          const lit = Math.pow(clamp((dd - dl) * K.litGain + K.litBias, 0, 1), 1.5);
          const thick = 1 - clamp(dd, 0, 1) * 0.15;
          const k = i * 4;
          for (let ch = 0; ch < 3; ch++) d[k + ch] = mix(mix(K.body[ch], K.top[ch], top * 0.7), K.lit[ch], lit) * thick;
          d[k + 3] = smooth(0, K.soft, dd) * K.alpha * 255;
        }
      }
      g.putImageData(img, 0, 0);
      return { canvas: c, wu, hu };
    }

    /* a cumulus: soft puffs heaped into a dome over a flat base, its edges broken up by noise. Each point is lit by
       how much cloud lies between it and the sun (light that gets through glows gold, the thick of the cloud stays
       slate blue), and the open sky above adds a cool sheen to the tops. Made twice — lit from the lower right and the
       lower left — so a cloud can change sides as it passes the sun. */
    function makeCumulus(seed, wu, hu) {
      const res = Math.max(1.2, s * 0.55);
      const w = Math.ceil(wu * res);
      const h = Math.ceil(hu * res);
      const r = seeded(seed);
      const n = perlin(seed + 1);
      const base = hu * 0.84;
      const puffs = [];
      const count = 16 + Math.floor(r() * 6);
      for (let i = 0; i < count; i++) {
        const u = 0.1 + 0.8 * r();
        const dome = Math.sin(((u - 0.1) / 0.8) * Math.PI);
        const pr = hu * (0.12 + 0.22 * dome) * (0.75 + r() * 0.5);
        puffs.push({ x: u * wu, y: base - pr * 0.55 - dome * hu * (0.22 + r() * 0.24), r: pr });
      }
      const D = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        const Y = y / res;
        const floor = smooth(base + 1.2, base - 1.4, Y);
        for (let x = 0; x < w; x++) {
          const X = x / res;
          let d = 0;
          for (const p of puffs) {
            const dx = X - p.x;
            const dy = Y - p.y;
            const q = 1 - (dx * dx + dy * dy) / (p.r * p.r);
            if (q > 0) d += q * q;
          }
          if (d > 0.01) d += (fbm(n, X / 3.2, Y / 3.2, 4) - 0.5) * 0.7;
          D[y * w + x] = d * floor;
        }
      }
      const sample = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : D[(y | 0) * w + (x | 0)]);
      /* billows: the lumpy texture inside a cloud, brighter on the tops of the lumps */
      const bn = perlin(seed + 2);
      const B = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (D[y * w + x] <= 0.08) continue;
          const X = x / res;
          const Y = y / res;
          const a = fbm(bn, X / 3.2, Y / 3.2, 3);
          B[y * w + x] = (a - fbm(bn, X / 3.2, (Y + 0.8) / 3.2, 3)) * 6 + (a - 0.5);
        }
      }
      const paint = (side) => {
        const c = mk(w, h);
        const g = c.getContext("2d");
        const img = g.createImageData(w, h);
        const d = img.data;
        const lx = 0.42 * side;
        const ly = 0.9;
        const step = 1.2 * res;
        for (let y = 0; y < h; y++) {
          const top = 1 - y / h;
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const dd = D[i];
            if (dd <= 0.08) continue;
            let acc = 0;
            for (let k = 1; k <= 10; k++) acc += Math.max(0, sample(x + lx * step * k, y + ly * step * k));
            const T = Math.exp(-acc * 0.17);
            const core = clamp(dd / 2.4, 0, 1);
            const mid = clamp(T * 1.6, 0, 1);
            const hi = Math.pow(clamp(T * 1.6 - 0.6, 0, 1), 1.4);
            const lump = 1 + clamp(B[i], -0.6, 0.6) * 0.27;
            const sky = top * (1 - T) * 0.9;
            const k4 = i * 4;
            /* slate blue in the thick of it → dusky mauve → gold where the low sun gets through; lumps catch a little
               more light on their tops, and the open sky lays a cool sheen over the upper parts */
            d[k4] = (mix(mix(30, 104, mid), 255, hi) * (1 - core * 0.2) + sky * 26) * lump;
            d[k4 + 1] = (mix(mix(38, 80, mid), 182, hi) * (1 - core * 0.2) + sky * 34) * lump;
            d[k4 + 2] = (mix(mix(70, 116, mid), 138, hi) * (1 - core * 0.15) + sky * 52) * lump;
            d[k4 + 3] = smooth(0.08, 0.42, dd) * 250;
          }
        }
        g.putImageData(img, 0, 0);
        return c;
      };
      return { canvas: paint(1), left: paint(-1), wu, hu };
    }

    function cloudLayer(L, camX, t) {
      const off = camX * L.pf + t * L.dr;
      const first = Math.floor((off - 160) / L.sp);
      const last = Math.ceil((off + W + 10) / L.sp);
      const sun = SUN_FX * W;
      for (let i = first; i <= last; i++) {
        const spr = L.sprites[Math.floor(hash(i, L.seed) * L.sprites.length)];
        const x = i * L.sp + hash(i, L.seed + 1) * L.sp * 0.6 - off;
        if (x > W || x + spr.wu < 0) continue;
        const y = L.y[0] + hash(i, L.seed + 2) * (L.y[1] - L.y[0]);
        ctx.drawImage(spr.canvas, x * s, y * s, spr.wu * s, spr.hu * s);
        if (spr.left) {   /* past the sun, the light comes from its other side */
          const f = smooth(-12, 12, x + spr.wu / 2 - sun);
          if (f > 0.01) {
            ctx.globalAlpha = f;
            ctx.drawImage(spr.left, x * s, y * s, spr.wu * s, spr.hu * s);
            ctx.globalAlpha = 1;
          }
        }
      }
    }

    /* a few brighter stars that twinkle */
    function twinkle(t) {
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 14; i++) {
        const a = 0.5 + 0.5 * Math.sin(t * (1.3 + hash(i, 1) * 2) + hash(i, 2) * 10);
        const x = hash(i, 3) * Wd;
        const y = Math.pow(hash(i, 4), 1.6) * HORIZON * s * 0.45;
        const r = s * (0.6 + hash(i, 5) * 0.6);
        ctx.globalAlpha = a * a * 0.8;
        ctx.drawImage(C.glow.white, x - r, y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    /* ---------------- the sea ---------------- */
    function makeSea() {
      const top = Math.floor(HORIZON * s);
      const h = Hd - top + 2;
      const c = mk(Wd, h);
      const g = c.getContext("2d");
      g.fillStyle = lin(g, 0, 0, 0, h, [[0, "#c7928a"], [0.025, "#6a6488"], [0.08, "#34446c"], [0.22, "#1a2d50"],
        [0.5, "#0d1b34"], [1, "#050c1a"]]);
      g.fillRect(0, 0, Wd, h);
      /* the sun's path: a warm column on the water, narrow at the horizon and spreading toward us */
      g.globalCompositeOperation = "lighter";
      const sx = SUN_FX * Wd;
      for (let y = 0; y < h; y++) {
        const f = y / h;
        const half = Wd * (0.016 + 0.17 * Math.pow(f, 0.85));
        const a = 0.05 + 0.42 * Math.pow(1 - f, 2.2);
        g.fillStyle = lin(g, sx - half, 0, sx + half, 0, [[0, "rgba(255,160,90,0)"], [0.5, "rgba(255,186,120," + a.toFixed(3) + ")"],
          [1, "rgba(255,160,90,0)"]]);
        g.fillRect(sx - half, y, half * 2, 1);
      }
      /* haze over the far water */
      g.fillStyle = lin(g, 0, 0, 0, h * 0.18, [[0, "rgba(255,190,150,.25)"], [1, "rgba(255,190,150,0)"]]);
      g.fillRect(0, 0, Wd, h * 0.18);
      g.globalCompositeOperation = "source-over";
      return { canvas: c, top };
    }

    /* the swell: bands of wave crests (lit by the sky) over dark troughs. In perspective the waves shrink and crowd
       together toward the horizon, and each band slides past at the speed of its distance (the ships' band at 1).
       Every band is a strip that tiles sideways. */
    function dash(g, x, y, len, lw, T) {
      for (const ox of [0, -T]) {
        if (x + ox + len < 0 || x + ox > T) continue;
        g.beginPath();
        g.moveTo(x + ox, y + lw / 2);
        g.quadraticCurveTo(x + ox + len / 2, y - lw * 0.6, x + ox + len, y + lw / 2);
        g.quadraticCurveTo(x + ox + len / 2, y + lw * 1.1, x + ox, y + lw / 2);
        g.fill();
      }
    }
    function makeWaves() {
      const top = HORIZON * s;
      const N = 16;
      const T = Math.ceil(Wd * 1.3);
      const bands = [];
      for (let i = 0; i < N; i++) {
        const y0 = top + ((Hd - top) * i) / N;
        const y1 = top + ((Hd - top) * (i + 1)) / N;
        const h = Math.ceil(y1 - y0) + 2;
        const c = mk(T, h);
        const g = c.getContext("2d");
        const k = ((y0 + y1) / 2 / s - HORIZON) / (SEA_Y - HORIZON);
        const r = seeded(71 + i * 13);
        const len0 = Math.max(1.5, 3.2 * k * s);
        const th = Math.max(1, 0.22 * k * s);
        const count = Math.min(900, Math.round((T * h) / (len0 * th * 4)));
        for (let j = 0; j < count; j++) {
          const len = len0 * (0.4 + r() * 1.3);
          const lw = th * (0.6 + r() * 0.8);
          const x = r() * T;
          const y = 1 + r() * Math.max(0, h - 2 - lw * 2.2);
          g.fillStyle = "rgba(2,6,16," + (0.18 + r() * 0.22).toFixed(2) + ")";
          dash(g, x, y + lw * 0.9, len * 1.1, lw * 1.2, T);
          g.fillStyle = "rgba(170,192,232," + (0.05 + r() * 0.16 * (1 - Math.min(1, k) * 0.3)).toFixed(3) + ")";
          dash(g, x, y, len, lw, T);
        }
        bands.push({ canvas: c, y: y0 - 1, k, T, drift: 0.8 + k * 1.2 });
      }
      return bands;
    }

    /* the sun's glitter: sparks on the water under the sun that flash and fade, each time somewhere new */
    function glitter(t) {
      const top = HORIZON * s;
      const h = Hd - top;
      const sx = C.sky.sunX;
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = "#ffe3b8";
      for (let i = 0; i < 110; i++) {
        const ph = t * (0.7 + hash(i, 1) * 1.6) + hash(i, 2) * 10;
        const cyc = Math.floor(ph);
        const id = i * 7 + cyc;
        const f = Math.pow(hash(id, 3), 1.7);
        const spread = Wd * (0.012 + 0.16 * Math.pow(f, 0.9));
        const bell = (hash(id, 4) + hash(id, 5) + hash(id, 6)) / 3 - 0.5;
        const tw = Math.sin((ph - cyc) * Math.PI);
        const len = (1 + f * 7) * s * 0.35 * (0.6 + hash(i, 8));
        ctx.globalAlpha = tw * tw * (0.95 - f * 0.45);
        ctx.fillRect(sx + bell * 3.2 * spread - len / 2, top + f * h, len, Math.max(1, s * (0.08 + f * 0.25)));
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    /* white water from noise — the wake behind a stern, the wave heaped against a bow — in three frames to
       cross-fade between, so it churns */
    function makeFoam(kind, seed) {
      const wake = kind === "wake";
      const wu = wake ? 56 : 34;
      const hu = wake ? 6 : 7;
      const res = Math.max(1, s * 0.7);
      const w = Math.ceil(wu * res);
      const h = Math.ceil(hu * res);
      const frames = [];
      for (let f = 0; f < 3; f++) {
        const n = perlin(seed + f * 31);
        const c = mk(w, h);
        const g = c.getContext("2d");
        const img = g.createImageData(w, h);
        const d = img.data;
        for (let y = 0; y < h; y++) {
          const v = y / h;
          for (let x = 0; x < w; x++) {
            const u = x / w;
            let m;
            if (wake) {
              /* u = 1 at the stern: churned white water there, thinning into streaks further back; a low band on the
                 water, hugging the waterline (v ≈ .22) and a little wider close to the ship */
              m = Math.exp(-(1 - u) * 2.6) * smooth(0, 0.25, u) * (1 - smooth(0.975, 1, u)) *
                Math.exp(-Math.pow((v - 0.24) / (0.06 + 0.13 * u), 2));
            } else {
              /* water heaped against the stem (u ≈ .82) and peeling back along the hull */
              const mid = 0.38 - 0.12 * smooth(0.5, 0.82, u);
              m = smooth(0, 0.75, u) * (1 - smooth(0.82, 0.9, u)) * Math.exp(-Math.pow((v - mid) / (0.08 + 0.18 * u), 2));
            }
            if (m < 0.01) continue;
            /* foam in streaks drawn out along the water, broken into lacy patches */
            const foam = smooth(0.45, 0.66, fbm(n, (u * wu) / 3.4, (v * hu) / 0.55, 4));
            const i = (y * w + x) * 4;
            const lum = 196 + foam * 54;
            d[i] = lum;
            d[i + 1] = lum + 5;
            d[i + 2] = Math.min(255, lum + 12);
            d[i + 3] = clamp(m * (0.12 + foam * 0.95), 0, 1) * 235;
          }
        }
        g.putImageData(img, 0, 0);
        frames.push(c);
      }
      return { frames, wu, hu };
    }

    /* ---------------- small textures: glows, smoke puffs, grime, the vignette ---------------- */
    function glowSprite(rgb) {
      const c = mk(64, 64);
      const g = c.getContext("2d");
      g.fillStyle = rad(g, 32, 32, 0, 32, 32, 32, [[0, "rgba(" + rgb + ",1)"], [0.18, "rgba(" + rgb + ",.55)"],
        [0.45, "rgba(" + rgb + ",.16)"], [1, "rgba(" + rgb + ",0)"]]);
      g.fillRect(0, 0, 64, 64);
      return c;
    }
    /* a puff of smoke: a noisy, soft-edged ball, lighter on top */
    function puffMask(seed) {
      const N = 96;
      const c = mk(N, N);
      const g = c.getContext("2d");
      const img = g.createImageData(N, N);
      const d = img.data;
      const n = perlin(seed);
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const dx = ((x + 0.5) / N) * 2 - 1;
          const dy = ((y + 0.5) / N) * 2 - 1;
          const f = fbm(n, x / 22, y / 22, 4);
          const a = clamp((1 - Math.sqrt(dx * dx + dy * dy)) * 1.6 - 0.25 + (f - 0.5) * 1.6, 0, 1);
          const k = (y * N + x) * 4;
          d[k] = d[k + 1] = d[k + 2] = clamp(0.78 + (f - 0.5) * 0.7 - dy * 0.15, 0, 1) * 255;
          d[k + 3] = a * a * 255;
        }
      }
      g.putImageData(img, 0, 0);
      return c;
    }
    function tint(mask, rgb) {
      const c = mk(mask.width, mask.height);
      const g = c.getContext("2d");
      g.drawImage(mask, 0, 0);
      g.globalCompositeOperation = "multiply";
      g.fillStyle = "rgb(" + rgb + ")";
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = "destination-in";
      g.drawImage(mask, 0, 0);
      return c;
    }
    function makePuffs() {
      const masks = [puffMask(5), puffMask(11)];
      const tones = { dark: "58,52,50", grey: "176,180,188", light: "222,224,228", white: "240,245,252", fire: "255,150,70" };
      const out = {};
      Object.keys(tones).forEach((k) => (out[k] = masks.map((m) => tint(m, tones[k]))));
      return out;
    }
    /* weathered steel: mottled plates and vertical streaks, around mid grey (laid over the ships with "overlay") */
    function makeGrime() {
      const wu = CARRIER_L + 16;
      const hu = SEA_Y + 0.4 - 66;
      const res = Math.max(1, s * 0.5);
      const w = Math.ceil(wu * res);
      const h = Math.ceil(hu * res);
      const c = mk(w, h);
      const g = c.getContext("2d");
      const img = g.createImageData(w, h);
      const d = img.data;
      const n = perlin(77);
      const m = perlin(78);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const X = x / res;
          const Y = y / res;
          const v = 128 + (fbm(n, X / 3, Y / 3, 4) - 0.5) * 120 + (fbm(m, X / 0.6, Y / 9, 3) - 0.5) * 90;
          const i = (y * w + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      return c;
    }
    function makeVignette() {
      const c = mk(Wd, Hd);
      const g = c.getContext("2d");
      g.fillStyle = rad(g, Wd / 2, Hd * 0.48, Math.min(Wd, Hd) * 0.32, Wd / 2, Hd * 0.48, Math.hypot(Wd, Hd) * 0.62,
        [[0, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,.5)"]]);
      g.fillRect(0, 0, Wd, Hd);
      return c;
    }

    /* ---------------- the aircraft carriers ----------------
       Seen side on with the low sun behind them to the right: haze-grey plating in shade, warm light catching the
       edges that face the sun. Drawn in world units, the stern at x = 0. */
    function jet(g, x, base, dir) {
      /* a parked fighter, wings folded: dir 1 = nose right, −1 = nose left; base = the deck */
      g.save();
      g.translate(x, base);
      g.scale(dir, 1);
      g.fillStyle = "#454e5a";   /* the folded outer wing, standing up behind the fuselage */
      g.beginPath();
      g.moveTo(-1.6, -2.4);
      g.lineTo(-0.6, -5.2);
      g.lineTo(1, -5);
      g.lineTo(1.4, -2.4);
      g.closePath();
      g.fill();
      g.fillStyle = "#3d4550";   /* twin fins, the far one darker */
      g.beginPath();
      g.moveTo(-6.2, -2.5);
      g.lineTo(-5.4, -5.9);
      g.lineTo(-4.2, -5.9);
      g.lineTo(-3.2, -2.6);
      g.closePath();
      g.fill();
      g.fillStyle = "#5b6471";
      g.beginPath();
      g.moveTo(-6.6, -2.4);
      g.lineTo(-5.9, -5.6);
      g.lineTo(-4.7, -5.6);
      g.lineTo(-3.7, -2.5);
      g.closePath();
      g.fill();
      g.fillStyle = lin(g, 0, -4.1, 0, -1.4, [[0, "#7f8996"], [0.45, "#5d6673"], [1, "#363c45"]]);
      g.beginPath();
      g.moveTo(-7, -2.1);
      g.lineTo(-7, -2.9);
      g.lineTo(-3, -3.05);
      g.lineTo(1.6, -3.1);
      g.bezierCurveTo(2.6, -3.15, 3, -4.15, 4.2, -4.1);
      g.bezierCurveTo(5, -4.05, 5.4, -3.4, 5.8, -3.2);
      g.bezierCurveTo(6.6, -3, 7.2, -2.6, 7.6, -2.35);
      g.bezierCurveTo(7, -2, 6, -1.6, 4.5, -1.55);
      g.lineTo(-4, -1.5);
      g.lineTo(-6.2, -1.7);
      g.closePath();
      g.fill();
      g.fillStyle = lin(g, 2.4, -4.1, 5.4, -3.2, [[0, "#1d2733"], [0.5, "#41607a"], [1, "#16202b"]]);   /* canopy */
      g.beginPath();
      g.moveTo(2.2, -3.12);
      g.bezierCurveTo(2.9, -3.2, 3.2, -4, 4.2, -3.98);
      g.bezierCurveTo(4.9, -3.95, 5.2, -3.45, 5.5, -3.18);
      g.closePath();
      g.fill();
      g.strokeStyle = "rgba(255,210,170,.55)";
      g.lineWidth = 0.1;
      g.beginPath();
      g.moveTo(3.2, -3.75);
      g.quadraticCurveTo(3.9, -4, 4.6, -3.85);
      g.stroke();
      g.fillStyle = "rgba(10,12,16,.6)";   /* intake */
      g.fillRect(-0.4, -2.55, 2.4, 0.9);
      g.fillStyle = "#2a2e35";   /* nozzles */
      g.fillRect(-7.3, -2.8, 0.5, 0.9);
      g.fillStyle = "#4b535f";   /* tailplane */
      g.beginPath();
      g.moveTo(-7.6, -2.3);
      g.lineTo(-5.2, -2.6);
      g.lineTo(-4.6, -2.25);
      g.lineTo(-7.4, -2);
      g.closePath();
      g.fill();
      g.strokeStyle = "#2b3038";
      g.lineWidth = 0.22;
      g.beginPath();
      g.moveTo(-1.2, -1.5);
      g.lineTo(-1.2, -0.5);
      g.moveTo(5, -1.55);
      g.lineTo(5, -0.4);
      g.stroke();
      g.fillStyle = "#141619";
      g.beginPath();
      g.arc(-1.2, -0.42, 0.42, 0, TAU);
      g.arc(5, -0.32, 0.32, 0, TAU);
      g.fill();
      g.strokeStyle = "rgba(255,196,150,.4)";   /* the sun along its spine */
      g.lineWidth = 0.12;
      g.beginPath();
      g.moveTo(-6.8, -2.95);
      g.lineTo(1.6, -3.16);
      g.stroke();
      g.restore();
    }

    function makeCarrier(landing) {
      const L = CARRIER_L;
      const X0 = -8;
      const TOP = 66;
      const BOT = SEA_Y + 0.4;
      const c = mk((L - 2 * X0) * s, (BOT - TOP) * s);
      const g = c.getContext("2d");
      g.scale(s, s);
      g.translate(-X0, -TOP);
      const r = seeded(landing ? 202 : 101);
      const I0 = ISLAND;

      /* the hull: raked bow, transom stern */
      const hull = new Path2D();
      hull.moveTo(-0.6, 100.5);
      hull.lineTo(L - 2, 100.5);
      hull.bezierCurveTo(L - 4.6, 104.8, L - 13.6, 110.1, L - 24, BOT);
      hull.lineTo(4.6, BOT);
      hull.bezierCurveTo(3.1, 108.4, 1.7, 104.6, 1.2, 102.3);
      hull.lineTo(-0.6, 101.7);
      hull.closePath();
      g.fillStyle = lin(g, 0, 100.5, 0, SEA_Y, [[0, "#66717f"], [0.15, "#5a6574"], [0.55, "#4c5664"], [0.92, "#3d4551"], [1, "#30363f"]]);
      g.fill(hull);
      g.save();
      g.clip(hull);
      g.fillStyle = lin(g, L * 0.45, 0, L, 0, [[0, "rgba(255,186,130,0)"], [1, "rgba(255,186,130,.14)"]]);   /* warmer toward the sun */
      g.fillRect(0, 100, L, 13);
      for (let x = 4; x < L - 6; x += 5.5) {   /* the plates, each a shade different */
        for (const [y0, y1] of [[101, 103.4], [103.4, 105.9], [105.9, 108.3], [108.3, 110.8]]) {
          const v = r();
          g.fillStyle = v < 0.5 ? "rgba(0,0,0," + (0.09 * (0.5 - v)).toFixed(3) + ")" : "rgba(200,215,235," + (0.08 * (v - 0.5)).toFixed(3) + ")";
          g.fillRect(x, y0, 5.5, y1 - y0);
        }
      }
      g.strokeStyle = "rgba(15,20,28,.24)";
      g.lineWidth = 0.09;
      for (const y of [103.4, 105.9, 108.3]) {
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(L, y);
        g.stroke();
      }
      g.strokeStyle = "rgba(15,20,28,.08)";
      for (let x = 4; x < L; x += 5.5) {
        g.beginPath();
        g.moveTo(x, 101);
        g.lineTo(x, SEA_Y);
        g.stroke();
      }
      g.fillStyle = lin(g, 0, 100.5, 0, 103.2, [[0, "rgba(5,8,14,.62)"], [1, "rgba(5,8,14,0)"]]);   /* shadow of the deck overhang */
      g.fillRect(-2, 100.5, L + 4, 2.7);
      /* hangar bays, lit inside, with a jet's tail in the shadows */
      const bays = landing ? [[28, 13], [60, 12]] : [[30, 13], [62, 12]];
      for (const [bx, bw] of bays) {
        g.fillStyle = "#0b0d11";
        g.fillRect(bx, 100.6, bw, 4.6);
        g.fillStyle = lin(g, 0, 100.6, 0, 105.2, [[0, "rgba(255,196,120,.05)"], [0.6, "rgba(255,196,120,.26)"], [1, "rgba(255,210,150,.5)"]]);
        g.fillRect(bx, 100.6, bw, 4.6);
        g.fillStyle = "rgba(255,236,200,.85)";
        for (let x = bx + 1.2; x < bx + bw - 0.5; x += 2.4) g.fillRect(x, 100.9, 1.1, 0.18);
        g.fillStyle = "rgba(20,24,30,.92)";
        g.beginPath();
        g.moveTo(bx + 2, 105.2);
        g.lineTo(bx + 3, 102.2);
        g.lineTo(bx + 4.4, 102.2);
        g.lineTo(bx + 5.6, 104.2);
        g.lineTo(bx + bw - 2, 104.4);
        g.lineTo(bx + bw - 1.4, 105.2);
        g.closePath();
        g.fill();
        g.fillStyle = "rgba(255,220,170,.45)";
        g.fillRect(bx, 105.05, bw, 0.15);
        g.strokeStyle = "rgba(150,165,185,.35)";
        g.lineWidth = 0.14;
        g.strokeRect(bx, 100.6, bw, 4.6);
      }
      /* the stern's open fantail */
      g.fillStyle = "#101318";
      g.fillRect(1.2, 101.2, 5.2, 2.2);
      g.fillStyle = "rgba(255,200,140,.18)";
      g.fillRect(1.2, 102.9, 5.2, 0.5);
      /* small openings and scuttles */
      g.fillStyle = "rgba(10,12,16,.75)";
      for (let x = 8; x < L - 30; x += 2.2 + r() * 2.6) {
        if (bays.some(([bx, bw]) => x > bx - 1 && x < bx + bw + 1)) continue;
        g.fillRect(x, 106.6, 0.5, 0.42);
      }
      /* life-raft canisters in racks under the deck edge */
      for (const [x0, n] of [[12, 6], [84, 5], [112, 6]]) {
        for (let i = 0; i < n; i++) {
          const x = x0 + i * 1.1;
          g.fillStyle = "#d9dde2";
          pill(g, x, 101.1, 0.8, 0.55, 0.27);
          g.fill();
          g.fillStyle = "rgba(0,0,0,.35)";
          g.fillRect(x, 101.5, 0.8, 0.15);
        }
      }
      /* rust running down from openings and drains */
      for (let i = 0; i < 24; i++) {
        const x = 3 + r() * (L - 30);
        const y = 101.5 + r() * 6;
        const len = 1.5 + r() * 4.5;
        g.fillStyle = lin(g, 0, y, 0, y + len, [[0, "rgba(120,70,40,.34)"], [1, "rgba(120,70,40,0)"]]);
        g.fillRect(x, y, 0.16 + r() * 0.22, len);
      }
      g.fillStyle = lin(g, 0, 106, 0, SEA_Y, [[0, "rgba(30,40,30,0)"], [1, "rgba(30,40,30,.24)"]]);   /* grime toward the water */
      g.fillRect(0, 106, L, 6);
      /* the anchor in its hawse pipe, with its rust stain */
      const ax = L - 19;
      g.fillStyle = "#15181d";
      g.beginPath();
      g.ellipse(ax, 102.4, 0.8, 0.55, 0, 0, TAU);
      g.fill();
      g.fillStyle = "#2a2f36";
      g.beginPath();
      g.moveTo(ax - 0.5, 102.6);
      g.lineTo(ax + 0.5, 102.6);
      g.lineTo(ax + 0.35, 104.4);
      g.lineTo(ax + 1.2, 104.1);
      g.lineTo(ax, 105);
      g.lineTo(ax - 1.2, 104.1);
      g.lineTo(ax - 0.35, 104.4);
      g.closePath();
      g.fill();
      g.fillStyle = lin(g, 0, 104.6, 0, 110, [[0, "rgba(130,70,35,.45)"], [1, "rgba(130,70,35,0)"]]);
      g.fillRect(ax - 0.5, 104.6, 1, 5.4);
      /* black boot-topping at the waterline */
      g.fillStyle = "#17191d";
      g.fillRect(-2, 110.7, L + 4, 2);
      g.fillStyle = "rgba(160,175,195,.18)";
      g.fillRect(-2, 110.7, L + 4, 0.12);
      g.restore();
      /* the bow's edge catches the sun */
      g.strokeStyle = "rgba(255,196,140,.5)";
      g.lineWidth = 0.25;
      g.beginPath();
      g.moveTo(L - 2, 100.6);
      g.bezierCurveTo(L - 4.6, 104.8, L - 13.6, 110.1, L - 24, SEA_Y - 0.4);
      g.stroke();
      /* the gallery under the deck edge, its railings */
      g.fillStyle = "#2a3039";
      g.fillRect(-0.6, 100.5, L - 1.6, 0.6);
      g.strokeStyle = "rgba(170,182,198,.45)";
      g.lineWidth = 0.07;
      g.beginPath();
      for (let x = 0; x < L - 3; x += 0.9) {
        g.moveTo(x, 100.55);
        g.lineTo(x, 101.1);
      }
      g.stroke();
      /* close-in weapons: white domes on sponsons at the stern and the bow */
      for (const x of [3.2, L - 12]) {
        g.fillStyle = "#3a414b";
        g.fillRect(x - 1.6, 101.1, 3.2, 0.5);
        g.fillStyle = lin(g, x - 0.8, 0, x + 0.8, 0, [[0, "#aab2bd"], [0.6, "#eef1f5"], [1, "#c3cad3"]]);
        g.fillRect(x - 0.7, 98.9, 1.4, 2.2);
        g.beginPath();
        g.arc(x, 98.9, 0.7, Math.PI, 0);
        g.fill();
      }

      /* the flight deck: its edge, and a sliver of its dark surface seen from just above */
      g.beginPath();
      g.moveTo(-1.4, 99.2);
      g.lineTo(L + 0.4, 99.2);
      g.lineTo(L - 0.6, 100.6);
      g.lineTo(-1.4, 100.6);
      g.closePath();
      g.fillStyle = lin(g, 0, 99.2, 0, 100.6, [[0, "#6f7a88"], [0.25, "#59636f"], [1, "#3c434d"]]);
      g.fill();
      g.beginPath();
      g.moveTo(-1.4, 99.2);
      g.lineTo(L + 0.4, 99.2);
      g.lineTo(L - 1.2, 98.3);
      g.lineTo(0.2, 98.3);
      g.closePath();
      g.fillStyle = lin(g, 0, 98.3, 0, 99.2, [[0, "#2a2d33"], [1, "#3b3f46"]]);
      g.fill();
      g.fillStyle = "rgba(235,238,242,.55)";
      g.fillRect(0, 99, L - 1, 0.07);
      g.fillStyle = "rgba(240,200,80,.6)";
      for (let x = 4; x < L - 6; x += 4.4) g.fillRect(x, 98.72, 2.2, 0.06);
      g.fillStyle = "rgba(255,200,150,.5)";
      g.fillRect(-1.4, 99.2, L + 1.8, 0.1);

      /* parked aircraft (clear of the stretch the biplane uses) */
      if (landing) {
        jet(g, 114, 98.6, -1);
        jet(g, 129, 98.6, 1);
      } else {
        jet(g, 116, 98.6, -1);
        jet(g, 131, 98.6, -1);
        jet(g, 66, 98.6, 1);
      }

      /* the island: five levels, the bridge overhanging forward, windows lit warm */
      const levels = [[I0, I0 + 20, 92, 98.4], [I0 + 1.2, I0 + 19.2, 87.8, 92], [I0 + 2, I0 + 20.4, 84.9, 87.8],
        [I0 + 3, I0 + 17.2, 82.2, 84.9], [I0 + 4.2, I0 + 15.4, 81.1, 82.2]];
      levels.forEach(([x0, x1, y0, y1]) => {
        g.fillStyle = lin(g, 0, y0, 0, y1, [[0, "#6c7786"], [0.5, "#5c6776"], [1, "#4d5664"]]);
        g.fillRect(x0, y0, x1 - x0, y1 - y0);
        g.fillStyle = lin(g, x1 - 1.4, 0, x1, 0, [[0, "rgba(255,190,135,0)"], [1, "rgba(255,190,135,.4)"]]);
        g.fillRect(x1 - 1.4, y0, 1.4, y1 - y0);
        g.fillStyle = "rgba(255,212,165,.5)";
        g.fillRect(x0, y0, x1 - x0, 0.1);
      });
      g.fillStyle = "rgba(8,10,14,.55)";   /* the bridge's underside */
      g.fillRect(I0 + 19.2, 87.8, 1.2, 0.5);
      const windows = (x0, x1, y0, y1, slant, lit) => {
        g.fillStyle = "#14171c";
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y0);
        g.lineTo(x1 - slant, y1);
        g.lineTo(x0, y1);
        g.closePath();
        g.fill();
        for (let x = x0 + 0.35; x < x1 - slant - 0.4; x += 1.25) {
          g.fillStyle = r() < lit ? "rgba(255," + (198 + Math.round(r() * 30)) + "," + (128 + Math.round(r() * 40)) + "," + (0.55 + r() * 0.35).toFixed(2) + ")"
            : "rgba(80,100,130,.35)";
          g.fillRect(x, y0 + 0.15, 0.95, y1 - y0 - 0.3);
        }
      };
      windows(I0 + 2.2, I0 + 20.4, 85.6, 87, 0.4, 0.75);
      windows(I0 + 3.3, I0 + 17.2, 82.9, 84.2, 0.3, 0.6);
      g.fillStyle = "rgba(255,214,150,.7)";
      for (const [x, y] of [[I0 + 3, 89.3], [I0 + 7.5, 89.3], [I0 + 15, 89.3], [I0 + 2.2, 93.4]]) g.fillRect(x, y, 0.7, 0.7);
      /* the hull number, big and white with a black shadow, as carriers wear it */
      g.font = "800 5.6px " + FONT;
      g.textAlign = "center";
      g.textBaseline = "alphabetic";
      const num = landing ? "02" : "01";
      g.fillStyle = "rgba(0,0,0,.7)";
      g.fillText(num, I0 + 10.4, 97.6);
      g.fillStyle = "#e9edf2";
      g.fillText(num, I0 + 10, 97.2);
      /* the mast, its yardarm and aerials */
      const mx = I0 + 10.5;
      g.strokeStyle = "#6d7886";
      g.lineWidth = 0.42;
      g.beginPath();
      g.moveTo(mx - 2.4, 81.2);
      g.lineTo(mx, 72.5);
      g.lineTo(mx + 2.4, 81.2);
      g.stroke();
      g.lineWidth = 0.3;
      g.beginPath();
      g.moveTo(mx, 81.2);
      g.lineTo(mx, 67.8);
      g.stroke();
      g.lineWidth = 0.22;
      g.beginPath();
      g.moveTo(mx - 3.4, 74.2);
      g.lineTo(mx + 3.4, 74.2);
      g.stroke();
      g.strokeStyle = "rgba(170,180,195,.7)";
      g.lineWidth = 0.08;
      for (const dx of [-3, -1.6, 1.6, 3]) {
        g.beginPath();
        g.moveTo(mx + dx, 74.2);
        g.lineTo(mx + dx, 76);
        g.stroke();
      }
      for (const [x0, x1] of [[I0 + 5, I0 + 4.2], [I0 + 15.5, I0 + 16.6]]) {
        g.beginPath();
        g.moveTo(x0, 81.1);
        g.lineTo(x1, 76.5);
        g.stroke();
      }
      /* the big air-search radar: a flat grid antenna on a platform aft */
      g.fillStyle = "#3e4652";
      g.fillRect(I0 + 3.2, 79.4, 4.6, 0.4);
      g.fillRect(I0 + 5.3, 78.2, 0.4, 1.3);
      g.save();
      g.translate(I0 + 5.5, 77);
      g.rotate(-0.12);
      g.fillStyle = lin(g, -2.3, 0, 2.3, 0, [[0, "#4f5967"], [1, "#6c7888"]]);
      g.fillRect(-2.3, -2.1, 4.6, 3.4);
      g.strokeStyle = "rgba(20,25,32,.55)";
      g.lineWidth = 0.06;
      g.beginPath();
      for (let i = -2.3; i <= 2.31; i += 0.46) {
        g.moveTo(i, -2.1);
        g.lineTo(i, 1.3);
      }
      for (let j = -2.1; j <= 1.31; j += 0.425) {
        g.moveTo(-2.3, j);
        g.lineTo(2.3, j);
      }
      g.stroke();
      g.fillStyle = "rgba(255,196,140,.45)";
      g.fillRect(2.1, -2.1, 0.2, 3.4);
      g.restore();
      /* radomes */
      for (const [x, y, rr] of [[I0 + 15.4, 80.3, 0.95], [I0 + 13.2, 80.6, 0.7]]) {
        g.fillStyle = "#4c5563";
        g.fillRect(x - 0.18, y, 0.36, 81.2 - y);
        g.fillStyle = rad(g, x - rr * 0.3, y - rr, 0, x, y - rr * 0.6, rr, [[0, "#f3f5f8"], [0.7, "#c9cfd8"], [1, "#8e97a5"]]);
        g.beginPath();
        g.arc(x, y - rr * 0.6, rr, 0, TAU);
        g.fill();
      }

      /* weathering over everything grey: mottled, streaky grime, kept to the ship's own shape */
      const gm = mk(c.width, c.height);
      const gg = gm.getContext("2d");
      gg.drawImage(C.grime, 0, 0, c.width, c.height);
      gg.globalCompositeOperation = "destination-in";
      gg.drawImage(c, 0, 0);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "overlay";
      g.globalAlpha = 0.5;
      g.drawImage(gm, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
      return { canvas: c, x0: X0, top: TOP, w: L - 2 * X0, h: BOT - TOP };
    }

    /* ---------------- the biplane ----------------
       A glossy red two-seat biplane, side on, nose to the right (plane units: the centre at 0,0, the main wheels
       touching down at WHEEL_X, WHEEL_Y). Lit from above by the sky, with the low sun putting a warm rim on the edges
       that face it; seen from a touch below, so the undersides of the wings show. The propeller is drawn per frame. */
    function wheel(g, x, y, r, light) {
      g.fillStyle = rad(g, x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r, [[0, light ? "#3d3d40" : "#2a2a2c"], [0.7, "#161618"], [1, "#0a0a0b"]]);
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
      g.strokeStyle = "rgba(255,255,255," + (light ? 0.14 : 0.07) + ")";
      g.lineWidth = r * 0.08;
      g.beginPath();
      g.arc(x, y, r * 0.82, -2.6, -1);
      g.stroke();
      g.fillStyle = rad(g, x - r * 0.15, y - r * 0.2, 0, x, y, r * 0.5, light ? [[0, "#ff7466"], [0.6, "#c41926"], [1, "#6d0710"]]
        : [[0, "#a33a33"], [1, "#4a050b"]]);
      g.beginPath();
      g.arc(x, y, r * 0.5, 0, TAU);
      g.fill();
      g.fillStyle = rad(g, x - r * 0.08, y - r * 0.1, 0, x, y, r * 0.2, [[0, light ? "#ffffff" : "#9aa1aa"], [1, "#6f7782"]]);
      g.beginPath();
      g.arc(x, y, r * 0.2, 0, TAU);
      g.fill();
    }
    function strut(g, x0, y0, x1, y1, w) {
      g.lineCap = "round";
      g.strokeStyle = "#353a42";
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      g.strokeStyle = "rgba(225,230,238,.55)";
      g.lineWidth = w * 0.3;
      g.beginPath();
      g.moveTo(x0 + w * 0.2, y0);
      g.lineTo(x1 + w * 0.2, y1);
      g.stroke();
      g.lineCap = "butt";
    }
    function wing(g, cx, cy, chord, thick, paint, under) {
      g.save();   /* the underside, seen from a little below */
      g.translate(0.12, under);
      g.fillStyle = "#4e070d";
      g.fill(airfoil(cx, cy, chord, thick));
      g.restore();
      const p = airfoil(cx, cy, chord, thick);
      g.fillStyle = paint(cy - thick, cy + thick * 0.5);
      g.fill(p);
      g.save();
      g.clip(p);
      g.translate(0, thick * 0.32);
      g.strokeStyle = "rgba(255,228,218,.3)";
      g.lineWidth = thick * 0.4;
      g.stroke(airfoilTop(cx, cy, chord, thick));
      g.restore();
      g.strokeStyle = "rgba(70,4,10,.7)";
      g.lineWidth = 0.1;
      g.stroke(p);
      g.fillStyle = "rgba(255,206,160,.6)";   /* the leading edge catching the sun */
      g.beginPath();
      g.ellipse(cx + chord / 2 - chord * 0.05, cy - thick * 0.32, chord * 0.05, thick * 0.32, 0, 0, TAU);
      g.fill();
    }

    function makePlane(hit) {
      const B = PLANE_BOX;
      const c = mk(B.w * s * PS, B.h * s * PS);
      const g = c.getContext("2d");
      g.scale(s * PS, s * PS);
      g.translate(-B.x, -B.y);
      const paint = (y0, y1) => lin(g, 0, y0, 0, y1, [[0, "#ff8c7c"], [0.16, "#f2433f"], [0.48, "#d01d2c"], [0.8, "#930d19"], [1, "#5c060e"]]);
      const edge = "rgba(70,4,10,.75)";

      /* the far wheel, a little higher and darker: it is further away */
      g.save();
      g.translate(0.4, -0.35);
      wheel(g, WHEEL_X, WHEEL_Y - 1.45, 1.45, false);
      g.restore();
      /* the upper wing and its cabane struts */
      wing(g, 3.7, -8, 9.2, 1.45, paint, 0.55);
      strut(g, 2.6, -2.78, 3.3, -7.3, 0.34);
      strut(g, 5.5, -2.66, 6.3, -7.3, 0.34);

      /* the fuselage */
      const body = new Path2D();
      body.moveTo(7.4, -2.62);
      body.lineTo(0.8, -2.8);
      body.lineTo(-3.2, -2.92);
      body.bezierCurveTo(-3.9, -3.35, -5, -3.35, -5.8, -3.05);
      body.bezierCurveTo(-9, -2.45, -12.2, -1.75, -15.4, -1.05);
      body.lineTo(-15.6, 0.1);
      body.bezierCurveTo(-11, 0.95, -5, 2.15, 0, 2.62);
      body.lineTo(7.4, 2.7);
      body.closePath();
      g.fillStyle = paint(-3.35, 2.7);
      g.fill(body);
      g.save();
      g.clip(body);
      g.fillStyle = "#f4efe6";   /* a cream flash down the side, edged in gold */
      g.beginPath();
      g.moveTo(7.6, -0.75);
      g.bezierCurveTo(2, -0.62, -8, -0.72, -15.6, -0.42);
      g.lineTo(-15.6, -0.12);
      g.bezierCurveTo(-8, -0.22, 2, 0.05, 7.6, 0.42);
      g.closePath();
      g.fill();
      g.strokeStyle = "#e0b04a";
      g.lineWidth = 0.12;
      g.stroke();
      /* shading that follows the body's curve: a soft sheen under the top line, the belly in shadow, a warm bounce */
      const topLine = new Path2D();
      topLine.moveTo(7.4, -2.2);
      topLine.lineTo(0.8, -2.38);
      topLine.lineTo(-3.2, -2.5);
      topLine.bezierCurveTo(-3.9, -2.93, -5, -2.93, -5.8, -2.63);
      topLine.bezierCurveTo(-9, -2.03, -12.2, -1.33, -15.4, -0.68);
      [[2.6, 0.06], [1.8, 0.08], [1.1, 0.1], [0.55, 0.16], [0.24, 0.32]].forEach(([w, a]) => {
        g.strokeStyle = "rgba(226,226,255," + a + ")";   /* the glossy top mirrors the evening sky */
        g.lineWidth = w;
        g.stroke(topLine);
      });
      const belly = new Path2D();
      belly.moveTo(7.6, 2.75);
      belly.lineTo(0, 2.66);
      belly.bezierCurveTo(-5, 2.2, -11, 1, -15.6, 0.16);
      [[3.4, 0.1], [2.2, 0.13], [1.2, 0.17]].forEach(([w, a]) => {
        g.strokeStyle = "rgba(40,0,6," + a + ")";
        g.lineWidth = w;
        g.stroke(belly);
      });
      g.strokeStyle = "rgba(255,150,110,.25)";
      g.lineWidth = 0.28;
      g.stroke(belly);
      g.save();   /* and low on its flank, the bright line of the horizon */
      g.translate(0, -1.25);
      g.strokeStyle = "rgba(255,196,150,.22)";
      g.lineWidth = 0.32;
      g.stroke(belly);
      g.restore();
      g.strokeStyle = "rgba(60,0,8,.5)";   /* panel seams, an access panel and its fasteners */
      g.lineWidth = 0.07;
      [4.9, -2.2, -7.4, -11.6].forEach((x) => {
        g.beginPath();
        g.moveTo(x, -3.6);
        g.quadraticCurveTo(x + 0.22, 0, x, 3);
        g.stroke();
      });
      g.strokeRect(-1.7, 0.75, 2.6, 1.15);
      g.fillStyle = "rgba(255,210,200,.4)";
      for (let x = -1.5; x < 0.9; x += 0.5) {
        g.fillRect(x, 0.82, 0.1, 0.1);
        g.fillRect(x, 1.78, 0.1, 0.1);
      }
      g.fillStyle = lin(g, 6, 0, -4, 0, [[0, "rgba(20,10,8,.55)"], [1, "rgba(20,10,8,0)"]]);   /* exhaust soot */
      g.beginPath();
      g.moveTo(6, 1.9);
      g.quadraticCurveTo(1, 2, -4, 2.3);
      g.lineTo(-4, 2.8);
      g.lineTo(6, 2.9);
      g.closePath();
      g.fill();
      g.restore();
      g.strokeStyle = edge;
      g.lineWidth = 0.12;
      g.stroke(body);

      /* the cockpit: the pilot in a leather jacket and helmet, goggles, a white scarf streaming back */
      g.fillStyle = "#1a0b08";
      g.beginPath();
      g.ellipse(-1.2, -2.88, 2.1, 0.42, 0, 0, TAU);
      g.fill();
      g.fillStyle = lin(g, 0, -3.9, 0, -2.85, [[0, "#6a4527"], [1, "#2a160a"]]);
      g.beginPath();
      g.moveTo(-2.8, -2.88);
      g.quadraticCurveTo(-2.4, -3.85, -1.2, -3.92);
      g.quadraticCurveTo(0, -3.85, 0.35, -2.88);
      g.closePath();
      g.fill();
      g.fillStyle = lin(g, -6.4, 0, -0.6, 0, [[0, "rgba(246,242,234,0)"], [0.35, "rgba(246,242,234,.92)"], [1, "#fffbf2"]]);
      g.beginPath();
      g.moveTo(-0.7, -3.92);
      g.bezierCurveTo(-2.4, -4.25, -3.8, -3.75, -6.4, -4.45);
      g.bezierCurveTo(-4.6, -3.55, -2.6, -3.55, -0.9, -3.5);
      g.closePath();
      g.fill();
      g.fillStyle = rad(g, -1.55, -4.95, 0.1, -1.2, -4.55, 1.05, [[0, "#b07a48"], [0.55, "#704525"], [1, "#3b210e"]]);
      g.beginPath();
      g.ellipse(-1.2, -4.55, 0.98, 1, 0, 0, TAU);
      g.fill();
      g.fillStyle = "#e0a983";
      g.beginPath();
      g.moveTo(-0.55, -4.35);
      g.quadraticCurveTo(-0.05, -4.05, -0.25, -3.62);
      g.lineTo(-0.75, -3.6);
      g.closePath();
      g.fill();
      g.fillStyle = "#2a1a0e";
      g.fillRect(-2.15, -4.98, 1.9, 0.36);
      g.fillStyle = rad(g, -0.5, -4.9, 0.05, -0.45, -4.82, 0.42, [[0, "#f2fbff"], [0.4, "#94cbe9"], [1, "#2a5372"]]);
      g.beginPath();
      g.ellipse(-0.42, -4.82, 0.36, 0.4, 0, 0, TAU);
      g.fill();
      g.strokeStyle = "#b8925a";
      g.lineWidth = 0.1;
      g.stroke();
      g.fillStyle = "rgba(30,16,6,.55)";
      g.beginPath();
      g.ellipse(-1.45, -4.22, 0.36, 0.48, 0, 0, TAU);
      g.fill();
      g.fillStyle = "rgba(195,225,245,.3)";   /* the windscreen */
      g.beginPath();
      g.moveTo(0.6, -2.8);
      g.lineTo(1.05, -4.3);
      g.lineTo(1.7, -4.26);
      g.lineTo(1.98, -2.78);
      g.closePath();
      g.fill();
      g.strokeStyle = "rgba(255,240,222,.75)";
      g.lineWidth = 0.09;
      g.beginPath();
      g.moveTo(1.05, -4.3);
      g.lineTo(1.7, -4.26);
      g.lineTo(1.98, -2.78);
      g.stroke();

      /* the fin and rudder, with a lightning bolt */
      const fin = new Path2D();
      fin.moveTo(-10.4, -1.78);
      fin.bezierCurveTo(-11.7, -3.3, -12.8, -5.5, -13.5, -6.55);
      fin.bezierCurveTo(-14.1, -7.4, -15.3, -7.6, -16, -6.9);
      fin.bezierCurveTo(-16.7, -6.1, -16.8, -3.3, -16.45, -1.1);
      fin.lineTo(-15.95, 0.45);
      fin.lineTo(-15.45, -1);
      fin.closePath();
      g.fillStyle = paint(-7.6, 0.5);
      g.fill(fin);
      g.save();
      g.clip(fin);
      g.strokeStyle = "rgba(60,0,8,.6)";
      g.lineWidth = 0.09;
      g.beginPath();
      g.moveTo(-14.55, -7.5);
      g.lineTo(-14.8, 0.5);
      g.stroke();
      g.fillStyle = lin(g, 0, -6.4, 0, -1.2, [[0, "#fff1a6"], [0.5, "#ffd23a"], [1, "#e0a300"]]);
      g.beginPath();
      g.moveTo(-15, -6.3);
      g.lineTo(-16.05, -3.6);
      g.lineTo(-15.45, -3.6);
      g.lineTo(-15.95, -1.3);
      g.lineTo(-14.95, -4.2);
      g.lineTo(-15.55, -4.2);
      g.closePath();
      g.fill();
      g.strokeStyle = "rgba(255,225,215,.35)";
      g.lineWidth = 0.5;
      g.beginPath();
      g.moveTo(-10.6, -1.9);
      g.bezierCurveTo(-11.8, -3.3, -12.9, -5.4, -13.6, -6.4);
      g.stroke();
      g.restore();
      g.strokeStyle = edge;
      g.lineWidth = 0.12;
      g.stroke(fin);

      /* the engine cowling, with louvres, a polished top and its front ring catching the sun */
      const cowl = new Path2D();
      cowl.moveTo(7.2, -2.75);
      cowl.bezierCurveTo(8.2, -3.05, 9.6, -3.12, 10.5, -2.95);
      cowl.bezierCurveTo(11, -2.6, 11.15, -1.6, 11.15, 0);
      cowl.bezierCurveTo(11.15, 1.6, 11, 2.55, 10.5, 2.85);
      cowl.bezierCurveTo(9.6, 3.02, 8.2, 2.98, 7.2, 2.75);
      cowl.closePath();
      g.fillStyle = paint(-3.15, 3);
      g.fill(cowl);
      g.save();
      g.clip(cowl);
      g.strokeStyle = "rgba(50,0,6,.55)";
      g.lineWidth = 0.08;
      for (let x = 7.9; x < 10.4; x += 0.42) {
        g.beginPath();
        g.moveTo(x, 0.6);
        g.lineTo(x, 2.4);
        g.stroke();
      }
      g.strokeStyle = "rgba(255,240,232,.6)";
      g.lineWidth = 0.32;
      g.beginPath();
      g.moveTo(7.4, -2.45);
      g.bezierCurveTo(8.4, -2.75, 9.6, -2.8, 10.4, -2.65);
      g.stroke();
      g.strokeStyle = "rgba(255,200,150,.65)";
      g.lineWidth = 0.35;
      g.beginPath();
      g.moveTo(10.55, -2.85);
      g.bezierCurveTo(11, -2.5, 11.12, -1.5, 11.12, 0);
      g.stroke();
      g.restore();
      g.strokeStyle = edge;
      g.lineWidth = 0.12;
      g.stroke(cowl);
      g.strokeStyle = "rgba(40,0,6,.7)";
      g.lineWidth = 0.1;
      g.beginPath();
      g.moveTo(7.25, -2.7);
      g.lineTo(7.25, 2.72);
      g.stroke();
      /* the polished spinner */
      g.fillStyle = lin(g, 0, -1.35, 0, 1.15, [[0, "#f5f7fa"], [0.32, "#c4cad3"], [0.66, "#7d8590"], [1, "#454c56"]]);
      g.beginPath();
      g.moveTo(11.1, -1.4);
      g.bezierCurveTo(12.3, -1.35, 13.3, -0.55, 13.6, -0.1);
      g.bezierCurveTo(13.3, 0.35, 12.3, 1.15, 11.1, 1.2);
      g.closePath();
      g.fill();
      g.fillStyle = "rgba(255,255,255,.75)";
      g.beginPath();
      g.ellipse(12, -0.85, 0.7, 0.18, -0.25, 0, TAU);
      g.fill();
      /* the exhaust stack under the cowling */
      g.lineCap = "round";
      g.strokeStyle = "#2c2725";
      g.lineWidth = 0.5;
      g.beginPath();
      g.moveTo(8.4, 2.85);
      g.quadraticCurveTo(7.2, 3.35, 5.5, 3.25);
      g.stroke();
      g.strokeStyle = "rgba(200,170,150,.45)";
      g.lineWidth = 0.14;
      g.beginPath();
      g.moveTo(8.2, 2.72);
      g.quadraticCurveTo(7.1, 3.15, 5.6, 3.08);
      g.stroke();
      g.lineCap = "butt";

      /* nearer than the fuselage: the lower wing, the tailplane, the outer struts and their bracing wires */
      wing(g, 1.6, 2.35, 8.6, 1.3, paint, 0.5);
      wing(g, -14, -0.55, 5.8, 0.72, paint, 0.3);
      strut(g, 0.3, 1.9, 1, -7.35, 0.4);
      strut(g, 5.7, 1.6, 7, -7.35, 0.4);
      g.strokeStyle = "rgba(220,226,232,.75)";
      g.lineWidth = 0.08;
      g.beginPath();
      g.moveTo(1, -7.2);
      g.lineTo(5.7, 1.5);
      g.moveTo(7, -7.2);
      g.lineTo(0.3, 1.8);
      g.stroke();
      /* the undercarriage: legs, the near wheel, the tail wheel */
      strut(g, 1.4, 2.7, 3.3, 4.5, 0.38);
      strut(g, 5.5, 2.6, 3.5, 4.5, 0.38);
      wheel(g, WHEEL_X, WHEEL_Y - 1.45, 1.45, true);
      strut(g, -13.9, 0.2, -14.4, 0.9, 0.22);
      wheel(g, -14.4, 0.9, 0.5, true);

      if (hit) {   /* the flash when a rocket hits */
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalCompositeOperation = "source-atop";
        g.fillStyle = "rgba(255,244,232,.78)";
        g.fillRect(0, 0, c.width, c.height);
      }
      return c;
    }

    /* ---------------- a missile (nose to the left, its tip at 0,0) ---------------- */
    /* a floating bomb: a cast-iron sphere lit from the sun above, a cool sky bounce underneath, a steel cap and a
       short fuse (the burning spark is drawn live) */
    function makeBomb() {
      const R = 4.4;
      const c = mk(14 * s, 14 * s);
      const g = c.getContext("2d");
      g.scale(s, s);
      g.translate(7, 8);
      g.fillStyle = rad(g, -1.5, -1.8, 0.2, 0, 0, R, [[0, "#9aa3b2"], [0.25, "#4a5160"], [0.62, "#1a1d24"], [1, "#050608"]]);
      g.beginPath();
      g.arc(0, 0, R, 0, TAU);
      g.fill();
      g.fillStyle = lin(g, 0, 1, 0, R, [[0, "rgba(120,170,230,0)"], [1, "rgba(120,170,230,.32)"]]);   /* sky bounce below */
      g.beginPath();
      g.arc(0, 0, R, 0, TAU);
      g.fill();
      g.fillStyle = "rgba(255,255,255,.75)";   /* the sun's highlight */
      g.beginPath();
      g.ellipse(-1.6, -1.9, 1.1, 0.6, -0.6, 0, TAU);
      g.fill();
      g.strokeStyle = "rgba(0,0,0,.6)";   /* a cast seam round it */
      g.lineWidth = 0.18;
      g.beginPath();
      g.ellipse(0, 0, R * 0.98, R * 0.32, 0.35, 0, TAU);
      g.stroke();
      g.fillStyle = lin(g, -1.1, 0, 1.1, 0, [[0, "#2e333b"], [0.4, "#c9d0d9"], [1, "#22262c"]]);   /* the cap */
      g.fillRect(0.9, -R - 0.9, 2.2, 1.6);
      g.strokeStyle = "#c2a06a";   /* the fuse */
      g.lineWidth = 0.45;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(2, -R - 0.9);
      g.quadraticCurveTo(3.1, -R - 2.4, 4.2, -R - 2.6);
      g.stroke();
      return c;
    }

    function makeRocket() {
      const c = mk(16 * s, 7 * s);
      const g = c.getContext("2d");
      g.scale(s, s);
      g.translate(0.5, 3.5);
      const shade = (stops) => lin(g, 0, -0.9, 0, 0.9, stops);
      g.fillStyle = "#3c434c";   /* the far fins, behind the body */
      g.beginPath();
      g.moveTo(10.6, -0.6);
      g.lineTo(12.4, -2.1);
      g.lineTo(13.2, -2.1);
      g.lineTo(13, -0.6);
      g.closePath();
      g.fill();
      g.fillStyle = shade([[0, "#ffffff"], [0.35, "#e3e7ec"], [0.75, "#a3abb6"], [1, "#5d6570"]]);
      g.fillRect(2.4, -0.85, 11, 1.7);
      g.beginPath();
      g.moveTo(0, 0);
      g.bezierCurveTo(0.4, -0.75, 1.4, -0.85, 2.5, -0.85);
      g.lineTo(2.5, 0.85);
      g.bezierCurveTo(1.4, 0.85, 0.4, 0.75, 0, 0);
      g.fill();
      g.fillStyle = rad(g, 0.3, -0.12, 0.02, 0.4, 0, 0.42, [[0, "#9fb4c8"], [0.5, "#33414f"], [1, "#11161c"]]);   /* seeker window */
      g.beginPath();
      g.ellipse(0.45, 0, 0.42, 0.34, 0, 0, TAU);
      g.fill();
      g.fillStyle = "#e6b62c";   /* bands: yellow for the warhead, brown for the motor */
      g.fillRect(3.2, -0.85, 0.45, 1.7);
      g.fillStyle = "#7a5230";
      g.fillRect(8.6, -0.85, 0.45, 1.7);
      g.fillStyle = shade([[0, "rgba(255,255,255,.25)"], [0.5, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,.35)"]]);
      g.fillRect(3.2, -0.85, 0.45, 1.7);
      g.fillRect(8.6, -0.85, 0.45, 1.7);
      g.fillStyle = "#5a626d";   /* canards and the near tail fins */
      g.beginPath();
      g.moveTo(4, 0.5);
      g.lineTo(5.1, 1.7);
      g.lineTo(5.5, 1.7);
      g.lineTo(5.2, 0.5);
      g.closePath();
      g.moveTo(10.4, 0.6);
      g.lineTo(12.3, 2.5);
      g.lineTo(13.2, 2.5);
      g.lineTo(13, 0.6);
      g.closePath();
      g.fill();
      g.fillStyle = "#2b2f35";   /* the nozzle */
      g.fillRect(13.3, -0.7, 0.7, 1.4);
      g.fillStyle = "rgba(255,200,150,.5)";
      g.fillRect(2.4, -0.85, 11, 0.12);
      return c;
    }

    /* ---------------- a pickup coin: gold for ×, emerald for + ---------------- */
    function makeCoin(label, kind) {
      const R = 5;
      const pad = 0.6;
      const c = mk((R + pad) * 2 * s, (R + pad) * 2 * s);
      const g = c.getContext("2d");
      g.scale(s, s);
      g.translate(R + pad, R + pad);
      const P = kind === "add"
        ? { hi: "#e9fff6", mid: "#62c99d", lo: "#0f4a33", f0: "#9af3c9", f1: "#22b67c", f2: "#0b6a45", ink: "#ffffff", inkHi: "rgba(0,70,45,.8)" }
        : { hi: "#fff6cf", mid: "#e0a92a", lo: "#6e4504", f0: "#ffeaa8", f1: "#f0b830", f2: "#a8730a", ink: "#5a3600", inkHi: "rgba(255,248,215,.9)" };
      g.fillStyle = lin(g, -R, -R, R, R, [[0, P.hi], [0.45, P.mid], [1, P.lo]]);   /* the milled rim */
      g.beginPath();
      g.arc(0, 0, R, 0, TAU);
      g.fill();
      g.strokeStyle = "rgba(0,0,0,.2)";
      g.lineWidth = 0.08;
      g.beginPath();
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * TAU;
        g.moveTo(Math.cos(a) * R * 0.86, Math.sin(a) * R * 0.86);
        g.lineTo(Math.cos(a) * R * 0.99, Math.sin(a) * R * 0.99);
      }
      g.stroke();
      g.fillStyle = lin(g, -R, -R, R, R, [[0, P.lo], [1, P.hi]]);   /* the face, sunk a little into the rim */
      g.beginPath();
      g.arc(0, 0, R * 0.8, 0, TAU);
      g.fill();
      g.fillStyle = rad(g, -R * 0.25, -R * 0.3, 0, 0, 0, R * 0.78, [[0, P.f0], [0.55, P.f1], [1, P.f2]]);
      g.beginPath();
      g.arc(0, 0, R * 0.75, 0, TAU);
      g.fill();
      g.font = "900 " + (label.length > 2 ? 3.5 : 4.3) + "px " + FONT;   /* the value, struck in relief */
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "rgba(0,0,0,.38)";
      g.fillText(label, 0.22, 0.42);
      g.fillStyle = P.inkHi;
      g.fillText(label, -0.12, -0.04);
      g.fillStyle = P.ink;
      g.fillText(label, 0, 0.16);
      g.save();   /* the gloss */
      g.beginPath();
      g.arc(0, 0, R, 0, TAU);
      g.clip();
      g.fillStyle = lin(g, -R, -R, R * 0.2, R * 0.4, [[0, "rgba(255,255,255,.55)"], [0.5, "rgba(255,255,255,.12)"], [0.52, "rgba(255,255,255,0)"]]);
      g.fillRect(-R, -R, R * 2, R * 2);
      g.restore();
      return { canvas: c, r: R + pad };
    }
    function coinArt(label, kind) {
      const k = kind + label;
      return C.coins[k] || (C.coins[k] = makeCoin(label, kind));
    }

    /* ---------------- (re)building the artwork for the canvas's size ---------------- */
    function build() {
      C = { coins: {} };
      C.glow = {
        white: glowSprite("255,250,240"), warm: glowSprite("255,200,130"), red: glowSprite("255,60,50"),
        green: glowSprite("90,255,140"), amber: glowSprite("255,170,40"), fire: glowSprite("255,140,50"),
        gold: glowSprite("255,206,90"), emerald: glowSprite("80,240,170"), shadow: glowSprite("0,0,0")
      };
      C.sky = makeSky();
      C.sea = makeSea();
      C.waves = makeWaves();
      C.clouds = LAYERS.map((L) => Object.assign({}, L, {
        sprites: Array.from({ length: L.n }, (_, i) => {
          const wu = mix(L.wu[0], L.wu[1], i / Math.max(1, L.n - 1));
          return L.kind === "cumulus" ? makeCumulus(L.seed + i * 17, wu, L.hu) : makeCloud(L.kind, L.seed + i * 17, wu, L.hu);
        })
      }));
      C.puffs = makePuffs();
      C.wake = makeFoam("wake", 401);
      C.bow = makeFoam("bow", 503);
      C.grime = makeGrime();
      C.ship1 = makeCarrier(false);
      C.ship2 = makeCarrier(true);
      C.plane = makePlane(false);
      C.planeHit = makePlane(true);
      C.rocket = makeRocket();
      C.bomb = makeBomb();
      C.vignette = makeVignette();
    }

    function resize() {
      const dpr = Math.min(2.5, global.devicePixelRatio || 1);
      const cssW = canvas.parentElement.clientWidth;
      const cssH = Math.round(Math.min(cssW * 0.86, 420));
      const k = cssW + "x" + cssH + "@" + dpr;
      if (k === key && C) return W;
      key = k;
      canvas.style.width = cssW + "px";
      canvas.style.height = cssH + "px";
      Wd = Math.round(cssW * dpr);
      Hd = Math.round(cssH * dpr);
      canvas.width = Wd;
      canvas.height = Hd;
      s = Hd / WORLD_H;
      W = Wd / s;
      build();
      return W;
    }

    /* ---------------- effects the game triggers ---------------- */
    /* a smoke puff: tone (dark/grey/light/white/fire), growing from r0 to r1 as it fades; layer 0 is behind the plane */
    function smoke(o) {
      parts.push(Object.assign({ kind: "smoke", layer: 0, age: 0, rot: rnd(0, TAU), v: Math.random() < 0.5 ? 0 : 1, a0: 0.75 }, o));
    }
    function explode(x, y) {
      parts.push({ kind: "flash", layer: 1, x, y, life: 0.32, age: 0, r: 26, tone: "warm" });
      parts.push({ kind: "fireball", layer: 1, x, y: y - 1.5, life: 0.85, age: 0, size: 26, rot: rnd(0, TAU) });
      parts.push({ kind: "ring", layer: 1, x, y, life: 0.42, age: 0 });
      for (let i = 0; i < (reduce ? 8 : 24); i++) {
        const a = rnd(0, TAU);
        const v = rnd(16, 48);
        parts.push({ kind: "spark", layer: 1, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 8, life: rnd(0.4, 0.9), age: 0 });
      }
      for (let i = 0; i < (reduce ? 3 : 9); i++) {
        parts.push({ kind: "debris", layer: 1, x, y, vx: rnd(-26, 26), vy: rnd(-30, -6), rot: rnd(0, TAU), vr: rnd(-12, 12),
          w: rnd(0.5, 1.4), h: rnd(0.25, 0.6), life: rnd(0.9, 1.5), age: 0 });
      }
      for (let i = 0; i < (reduce ? 3 : 7); i++) {
        smoke({ tone: "dark", x: x + rnd(-3, 3), y: y + rnd(-3, 2), vx: rnd(-8, 4), vy: rnd(-8, -2), r0: 3, r1: rnd(9, 14), life: rnd(1.4, 2.2), delay: 0.18 });
      }
      if (!reduce) shake = 0.35;
      fireT = 1.3;
      smokeT = 2.8;
    }
    function sparkle(x, y, color) {
      const gold = parseInt(color.slice(1, 3), 16) > parseInt(color.slice(3, 5), 16) * 0.9;   /* warm colour: a gold coin */
      parts.push({ kind: "flash", layer: 1, x, y, life: 0.28, age: 0, r: 11, tone: gold ? "gold" : "emerald" });
      parts.push({ kind: "halo", layer: 1, x, y, life: 0.5, age: 0, color });
      for (let i = 0; i < (reduce ? 6 : 14); i++) {
        const a = (i / 14) * TAU + rnd(-0.2, 0.2);
        const v = rnd(14, 30);
        parts.push({ kind: "glint", layer: 1, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rnd(0.45, 0.7), age: 0, color, size: rnd(0.8, 1.5) });
      }
    }
    function splash(x) {
      for (let i = 0; i < (reduce ? 14 : 46); i++) {
        const a = -Math.PI / 2 + rnd(-0.9, 0.9);
        const v = rnd(16, 52);
        parts.push({ kind: "drop", layer: 1, x: x + rnd(-3, 3), y: SEA_Y - 0.5, vx: Math.cos(a) * v * 0.7, vy: Math.sin(a) * v, r: rnd(0.25, 0.75), life: rnd(0.8, 1.4), age: 0 });
      }
      for (let i = 0; i < (reduce ? 4 : 10); i++) {
        smoke({ layer: 1, tone: "white", x: x + rnd(-4, 4), y: SEA_Y - rnd(1, 5), vx: rnd(-5, 5), vy: rnd(-8, -2), r0: 2.5, r1: rnd(7, 12), life: rnd(1, 1.8), a0: 0.7 });
      }
      parts.push({ kind: "column", layer: 1, x, life: 0.95, age: 0 });
      parts.push({ kind: "foam", layer: 1, x, life: 2.4, age: 0 });
      if (!reduce) shake = 0.25;
    }
    function dust(x, y) {
      for (let i = 0; i < (reduce ? 4 : 10); i++) {
        smoke({ layer: 1, tone: "light", x: x + rnd(-1, 1), y: y - rnd(0.3, 1.2), vx: rnd(-14, -3), vy: rnd(-3, -0.5), r0: 0.8, r1: rnd(3, 5), life: rnd(0.6, 1.1), a0: 0.6 });
      }
    }
    function pop(x, y, text, color) {
      pops.push({ x, y, text, color, age: 0, life: 1.25 });
    }
    function clear() {
      parts = [];
      pops = [];
      smokeT = fireT = shake = 0;
    }

    /* ---------------- per-frame pieces (world units, under the world transform) ---------------- */
    function worldT() {
      ctx.setTransform(s, 0, 0, s, WX, WY);
    }
    /* an image centred at (x, y), w × h units, turned by rot */
    function drawRot(img, sx, sy, sw, sh, x, y, w, h, rot, alpha) {
      const c = Math.cos(rot) * s;
      const n = Math.sin(rot) * s;
      ctx.setTransform(c, n, -n, c, x * s + WX, y * s + WY);
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
      ctx.globalAlpha = 1;
      worldT();
    }
    function light(x, y, r, tone, a) {
      ctx.globalAlpha = a;
      ctx.drawImage(C.glow[tone], x - r, y - r, r * 2, r * 2);
    }
    /* a plane-local point (see makePlane) in world units, for a plane at (pl.x, pl.y) turned about its wheels */
    function local(pl, lx, ly) {
      const a = pl.angle || 0;
      const c = Math.cos(a);
      const n = Math.sin(a);
      const dx = (lx - WHEEL_X) * PS;
      const dy = (ly - WHEEL_Y) * PS;
      return [pl.x + WHEEL_X + c * dx - n * dy, pl.y + WHEEL_Y + n * dx + c * dy];
    }
    const onScreen = (x0, x1) => x1 > camL - 4 && x0 < camL + W + 4;

    /* a ship's reflection: thin slices of it, mirrored under the waterline, each wobbled by the swell */
    function reflection(c, t) {
      const art = c.landing ? C.ship2 : C.ship1;
      if (!onScreen(c.x + art.x0, c.x + art.x0 + art.w)) return;
      const dh = 0.8;
      const n = Math.ceil((WORLD_H - SEA_Y) / dh);
      for (let k = 0; k < n; k++) {
        const ySrc = SEA_Y - (k + 1) * dh;
        if (ySrc < art.top) break;
        const wob = Math.sin(t * 1.6 + k * 1.3 + c.x * 0.01) * (0.25 + k * 0.06);
        ctx.globalAlpha = 0.3 * (1 - k / n);
        ctx.drawImage(art.canvas, 0, (ySrc - art.top) * s, art.canvas.width, dh * s, c.x + art.x0 + wob, SEA_Y + k * dh, art.w, dh + 0.05);
      }
      ctx.globalAlpha = 1;
    }
    function crossfade(set, x, y, w, h, t, rate) {
      const ph = t * rate;
      const i = Math.floor(ph);
      const f = ph - i;
      ctx.globalAlpha = 1 - f;
      ctx.drawImage(set[i % 3], x, y, w, h);
      ctx.globalAlpha = f;
      ctx.drawImage(set[(i + 1) % 3], x, y, w, h);
      ctx.globalAlpha = 1;
    }
    function ship(c, t) {
      const art = c.landing ? C.ship2 : C.ship1;
      const x = c.x;
      if (!onScreen(x - 56, x + CARRIER_L + 8)) return;
      ctx.drawImage(art.canvas, x + art.x0, art.top, art.w, art.h);
      crossfade(C.wake.frames, x + 4.4 - 0.965 * C.wake.wu, SEA_Y - 0.22 * C.wake.hu, C.wake.wu, C.wake.hu, t, 2.2);
      crossfade(C.bow.frames, x + CARRIER_L - 24 - 0.82 * C.bow.wu, SEA_Y - 0.38 * C.bow.hu, C.bow.wu, C.bow.hu, t + 0.5, 2.6);
      ctx.fillStyle = "rgba(225,236,250,.35)";   /* a thin line of foam where the hull meets the water */
      ctx.fillRect(x + 4.6, SEA_Y - 0.15, CARRIER_L - 28.6, 0.3);
      /* lights: along the deck edge, floodlights pooling round the island, the windows, the mast */
      const I0 = x + ISLAND;
      const mast = I0 + 10.5;
      ctx.globalCompositeOperation = "lighter";
      for (let lx = x + 3; lx < x + CARRIER_L - 4; lx += 8) light(lx, 99.1, 0.75, "warm", 0.55);
      ctx.globalAlpha = 0.22;
      ctx.drawImage(C.glow.warm, I0 - 12, 96.2, 44, 4.6);
      ctx.globalAlpha = 0.22;
      ctx.drawImage(C.glow.warm, I0 + 1, 84.4, 21, 3.6);
      light(mast, 67.6, 1.2, "white", 0.9);
      if (Math.floor(t * 1.25 + (c.landing ? 0.5 : 0)) % 2 === 0) {
        light(mast - 3.4, 74.1, 1.6, "red", 0.95);
        light(mast + 3.4, 74.1, 1.6, "red", 0.95);
      }
      if (c.landing) {
        /* the landing aid: an amber "meatball" between rows of green datum lights; red drop lights down the stern */
        light(x + 42, 98.2, 1.3, "amber", 0.95);
        for (let i = 1; i <= 3; i++) {
          light(x + 42 - i * 0.9, 98.2, 0.6, "green", 0.9);
          light(x + 42 + i * 0.9, 98.2, 0.6, "green", 0.9);
        }
        for (let y = 100.6; y < 107; y += 1.1) light(x + 0.8, y, 0.6, "red", 0.85);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      /* the surface-search radar turning on the masthead */
      const a = t * 2.1 + (c.landing ? 1.3 : 0);
      const cw = 3.2 * Math.abs(Math.cos(a)) + 0.35;
      ctx.fillStyle = Math.cos(a) > 0 ? "#7d8796" : "#56606d";
      ctx.fillRect(mast - cw / 2, 69.6, cw, 0.45);
    }

    function coin(pk, t) {
      if (pk.taken || !onScreen(pk.x - 12, pk.x + 12)) return;
      const art = coinArt(pk.label, pk.kind);
      const gold = pk.kind !== "add";
      const y = pk.y + Math.sin(t * 2.4 + pk.x * 0.7) * 0.7;
      const turn = 0.8 + 0.2 * Math.cos(t * 1.9 + pk.x * 0.31);   /* it turns a little, showing its edge */
      const x = pk.x;
      const R = art.r;
      ctx.globalCompositeOperation = "lighter";
      light(x, y, 10.5, gold ? "gold" : "emerald", 0.3 + 0.08 * Math.sin(t * 4 + pk.x));
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      const edge = (1 - turn) * 2.6 + 0.25;
      ctx.fillStyle = gold ? "#6e4504" : "#0f4a33";
      ctx.beginPath();
      ctx.ellipse(x + edge * 0.5, y, (R - 0.6) * turn, R - 0.6, 0, 0, TAU);
      ctx.fill();
      ctx.drawImage(art.canvas, x - edge * 0.5 - R * turn, y - R, R * 2 * turn, R * 2);
      /* now and then a glint runs over it */
      const g = (t * 0.45 + hash(Math.round(pk.x), 9)) % 1;
      if (g < 0.12) {
        const k = g / 0.12;
        const r = 2.2 * Math.sin(k * Math.PI);
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = "rgba(255,255,245,.9)";
        const gx = x - 2 * turn;
        const gy = y - 2.2;
        ctx.beginPath();
        ctx.moveTo(gx, gy - r);
        ctx.lineTo(gx + r * 0.16, gy);
        ctx.lineTo(gx, gy + r);
        ctx.lineTo(gx - r * 0.16, gy);
        ctx.closePath();
        ctx.moveTo(gx - r, gy);
        ctx.lineTo(gx, gy + r * 0.16);
        ctx.lineTo(gx + r, gy);
        ctx.lineTo(gx, gy - r * 0.16);
        ctx.closePath();
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
    }

    function bomb(b, t) {
      if (b.gone || !onScreen(b.x - 10, b.x + 10)) return;
      const y = b.y + Math.sin(t * 1.8 + b.x * 0.5) * 0.9;
      ctx.drawImage(C.bomb, b.x - 7, y - 8, 14, 14);
      /* the burning fuse: a flickering spark and its glow */
      const fx = b.x + 4.2, fy = y - 4.4 - 2.6;
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.7 + Math.random() * 0.3;
      ctx.drawImage(C.glow.fire, fx - 2.4, fy - 2.4, 4.8, 4.8);
      ctx.drawImage(C.glow.white, fx - 0.9, fy - 0.9, 1.8, 1.8);
      ctx.fillStyle = "rgba(255,230,150,.9)";
      for (let k = 0; k < 3; k++) {
        const a = Math.random() * TAU, d = 0.6 + Math.random() * 1.6;
        ctx.fillRect(fx + Math.cos(a) * d, fy + Math.sin(a) * d, 0.3, 0.3);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    function rocket(r, dt) {
      if (!r.live) return;
      const a = r.angle || 0;
      const c = Math.cos(a);
      const n = Math.sin(a);
      /* its smoke: puffs laid back along the stretch it covered since the last frame, so the trail is unbroken */
      const run = 190 * dt;
      const count = Math.min(8, Math.ceil(run / 0.8));
      for (let j = 0; j < count; j++) {
        const back = 13.8 + (run * (j + Math.random())) / count;
        smoke({ tone: "grey", x: r.x + back * c + rnd(-0.3, 0.3), y: r.y + back * n + rnd(-0.3, 0.3), vx: rnd(-1.5, 1.5), vy: rnd(-2, 0.5),
          r0: 1, r1: rnd(3.6, 5.6), life: rnd(1.3, 2), a0: 0.42, age: (j / count) * dt });
      }
      ctx.setTransform(s * c, s * n, -s * n, s * c, r.x * s + WX, r.y * s + WY);
      ctx.drawImage(C.rocket, -0.5, -3.5, 16, 7);
      ctx.globalCompositeOperation = "lighter";   /* the exhaust: a white-hot core in an orange flame, and its glow */
      const len = 5 + Math.random() * 2.5;
      ctx.globalAlpha = 0.95;
      ctx.drawImage(C.glow.fire, 13.6, -1.7, len * 1.5, 3.4);
      ctx.drawImage(C.glow.white, 13.6, -0.8, len * 0.7, 1.6);
      ctx.globalAlpha = 0.45;
      ctx.drawImage(C.glow.warm, 9.5, -5, 12, 10);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      worldT();
    }

    /* the propeller, in plane units: a running one is a faint, edge-on disc with blurred blades and yellow tips;
       an idling one shows its blade turning */
    function propeller(spin, t) {
      const X = 11.7;
      const Y = -0.1;
      const R = 5.9;
      const a = t * spin;
      if (spin > 12) {
        ctx.fillStyle = "rgba(40,36,34,.16)";
        ctx.beginPath();
        ctx.ellipse(X, Y, 0.55, R, 0, 0, TAU);
        ctx.fill();
        for (let k = 0; k < 2; k++) {
          const len = R * Math.abs(Math.cos(a + k * 1.7));
          ctx.fillStyle = "rgba(30,26,24," + (0.22 - k * 0.08) + ")";
          ctx.fillRect(X - 0.2, Y - len, 0.4, len * 2);
        }
        ctx.fillStyle = "rgba(255,206,40,.42)";
        ctx.fillRect(X - 0.28, Y - R, 0.56, 0.8);
        ctx.fillRect(X - 0.28, Y + R - 0.8, 0.56, 0.8);
      } else {
        const len = R * Math.cos(a);
        const h = Math.abs(len) * 2;
        const top = Y - Math.abs(len);
        ctx.fillStyle = "#2a2420";
        ctx.fillRect(X - 0.32, top, 0.64, h);
        ctx.fillStyle = "rgba(255,220,190,.25)";
        ctx.fillRect(X + 0.1, top, 0.14, h);
        if (h > 1.8) {
          ctx.fillStyle = "#f2c230";
          ctx.fillRect(X - 0.32, top, 0.64, 0.75);
          ctx.fillRect(X - 0.32, top + h - 0.75, 0.64, 0.75);
        }
      }
    }

    function drawPlane(pl, t) {
      const a = pl.angle || 0;
      const c = Math.cos(a);
      const n = Math.sin(a);
      const wet = pl.y + WHEEL_Y > SEA_Y - 0.6;
      if (wet) {   /* in the water: the sea closes over it */
        ctx.save();
        ctx.beginPath();
        ctx.rect(camL - 10, -20, W + 20, SEA_Y + 20.25);
        ctx.clip();
      }
      const k = s * PS;
      ctx.setTransform(k * c, k * n, -k * n, k * c, (pl.x + WHEEL_X) * s + WX, (pl.y + WHEEL_Y) * s + WY);
      ctx.translate(-WHEEL_X, -WHEEL_Y);
      propeller(pl.spin || 0, t);
      ctx.drawImage(pl.flash > 0 && Math.floor(t * 18) % 2 ? C.planeHit : C.plane, PLANE_BOX.x, PLANE_BOX.y, PLANE_BOX.w, PLANE_BOX.h);
      ctx.globalCompositeOperation = "lighter";
      if (!wet) {
        light(7.9, -8.2, 0.9, "red", 0.75);   /* the port navigation light, steady */
        const ph = (t * 0.9) % 1;
        if (ph < 0.07) light(-15.3, -7.2, 2.6, "white", 1 - ph / 0.07);   /* the tail strobe */
      }
      if (fireT > 0 && !wet) {   /* flames licking back from a hit engine */
        const k = Math.min(1, fireT);
        for (let i = 0; i < 3; i++) {
          const len = 2.2 + Math.random() * 2.2;
          ctx.globalAlpha = 0.8 * k;
          ctx.drawImage(C.glow.fire, 8.4 - len - i * 0.8, 1.2 + rnd(-0.6, 0.4), len * 1.6, 2.2);
        }
        light(9, 2, 2.4 + Math.random(), "warm", 0.6 * k);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (wet) ctx.restore();
      worldT();
    }

    /* smoke from a hit engine, exhaust haze, spray where it meets the water */
    function planeTrail(pl) {
      if (!pl.visible) return;
      if (pl.y < SEA_Y - 8) {
        if (smokeT > 0 && Math.random() < 0.8) {
          const [x, y] = local(pl, 8.6, 1.8);
          smoke({ tone: Math.random() < 0.3 ? "fire" : "dark", x, y, vx: rnd(-10, -4), vy: rnd(-5, -1), r0: 1, r1: rnd(3.5, 6), life: rnd(1.1, 1.7), a0: 0.8 * Math.min(1, smokeT) });
        }
        if (pl.spin > 12 && Math.random() < 0.35) {
          const [x, y] = local(pl, 5.2, 3.3);
          smoke({ tone: "grey", x, y, vx: rnd(-6, -2), vy: rnd(-1, 0.5), r0: 0.4, r1: rnd(1.4, 2.2), life: rnd(0.4, 0.7), a0: 0.18 });
        }
      }
      if (pl.y + WHEEL_Y > SEA_Y - 0.4 && pl.y < SEA_Y + 4 && Math.random() < 0.9) {
        const [x] = local(pl, 9, 0);
        for (let i = 0; i < 2; i++) {
          parts.push({ kind: "drop", layer: 1, x: x + rnd(-4, 2), y: SEA_Y - 0.3, vx: rnd(-10, 6), vy: rnd(-26, -8), r: rnd(0.2, 0.55), life: rnd(0.5, 0.9), age: 0 });
        }
        if (Math.random() < 0.4) smoke({ layer: 1, tone: "white", x: x + rnd(-4, 3), y: SEA_Y - rnd(0.5, 2), vx: rnd(-4, 2), vy: rnd(-4, -1), r0: 1.2, r1: rnd(4, 6), life: rnd(0.6, 1), a0: 0.6 });
      }
    }

    function particle(p, dt) {
      if (p.delay && p.age < p.delay) return;
      const k = p.age / p.life;
      if (p.kind === "flash") {
        ctx.globalCompositeOperation = "lighter";
        light(p.x, p.y, p.r * (0.55 + k * 0.6), p.tone || "white", (1 - k) * (1 - k));
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        return;
      }
      if (p.kind === "fireball") {
        if (!blast.complete || !blast.naturalWidth) return;
        const f = Math.min(9, Math.floor(k * 10));
        const size = p.size * (0.9 + k * 0.3);
        drawRot(blast, f * 200, 0, 200, 200, p.x, p.y - k * 3, size, size, p.rot, 1);
        return;
      }
      if (p.kind === "ring" || p.kind === "halo") {
        ctx.strokeStyle = p.kind === "ring" ? "rgba(255,226,180," + (0.6 * (1 - k)).toFixed(2) + ")" : p.color;
        ctx.globalAlpha = p.kind === "halo" ? 0.7 * (1 - k) : 1;
        ctx.lineWidth = p.kind === "ring" ? 0.5 : 0.35;
        ctx.beginPath();
        if (p.kind === "ring") ctx.ellipse(p.x, p.y, 3 + k * 17, 2.4 + k * 12, 0, 0, TAU);
        else ctx.arc(p.x, p.y, 4 + k * 7, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
        return;
      }
      if (p.kind === "column") {
        /* the central spout of a splash: shoots up, hangs, falls back */
        const h = 17 * Math.sin(Math.min(1, k * 1.5) * Math.PI) + 0.5;
        const w = 2.4 + k * 3;
        ctx.globalAlpha = 0.85 * (1 - k * k);
        ctx.fillStyle = lin(ctx, 0, SEA_Y - h, 0, SEA_Y, [[0, "rgba(255,255,255,0)"], [0.25, "rgba(236,244,255,.85)"], [1, "rgba(205,225,245,.95)"]]);
        ctx.beginPath();
        ctx.moveTo(p.x - w, SEA_Y + 0.2);
        ctx.quadraticCurveTo(p.x - w * 0.35, SEA_Y - h * 0.5, p.x - w * 0.12, SEA_Y - h);
        ctx.lineTo(p.x + w * 0.12, SEA_Y - h);
        ctx.quadraticCurveTo(p.x + w * 0.35, SEA_Y - h * 0.5, p.x + w, SEA_Y + 0.2);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        return;
      }
      if (p.kind === "foam") {
        ctx.strokeStyle = "rgba(235,245,255," + (0.65 * (1 - k)).toFixed(2) + ")";
        ctx.lineWidth = 0.4;
        ctx.beginPath();
        ctx.ellipse(p.x, SEA_Y + 0.6, 2 + k * 18, 0.5 + k * 2.6, 0, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = "rgba(225,238,252," + (0.3 * (1 - k)).toFixed(2) + ")";
        ctx.beginPath();
        ctx.ellipse(p.x, SEA_Y + 0.6, 1.5 + k * 12, 0.4 + k * 1.6, 0, 0, TAU);
        ctx.fill();
        return;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === "spark") {
        p.vy += 40 * dt;
        ctx.globalCompositeOperation = "lighter";
        ctx.strokeStyle = "rgba(255," + Math.round(225 - k * 120) + "," + Math.round(150 - k * 130) + "," + (1 - k).toFixed(2) + ")";
        ctx.lineWidth = 0.3;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
        ctx.stroke();
        ctx.globalCompositeOperation = "source-over";
        return;
      }
      if (p.kind === "debris") {
        p.vy += 50 * dt;
        p.rot += p.vr * dt;
        const c = Math.cos(p.rot) * s;
        const n = Math.sin(p.rot) * s;
        ctx.setTransform(c, n, -n, c, p.x * s + WX, p.y * s + WY);
        ctx.globalAlpha = k < 0.75 ? 1 : (1 - k) / 0.25;
        ctx.fillStyle = "#1d1a1a";
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.fillStyle = "rgba(255,150,60," + (0.9 * (1 - k)).toFixed(2) + ")";   /* still glowing */
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w * 0.35, p.h);
        ctx.globalAlpha = 1;
        worldT();
        return;
      }
      if (p.kind === "glint") {
        p.vx *= 1 - dt * 5;
        p.vy *= 1 - dt * 5;
        const r = p.size * (1 - k);
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - r * 1.6);
        ctx.lineTo(p.x + r * 0.3, p.y);
        ctx.lineTo(p.x, p.y + r * 1.6);
        ctx.lineTo(p.x - r * 0.3, p.y);
        ctx.closePath();
        ctx.moveTo(p.x - r * 1.6, p.y);
        ctx.lineTo(p.x, p.y + r * 0.3);
        ctx.lineTo(p.x + r * 1.6, p.y);
        ctx.lineTo(p.x, p.y - r * 0.3);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        return;
      }
      if (p.kind === "drop") {
        p.vy += 70 * dt;
        if (p.y > SEA_Y + 0.5 && p.vy > 0) {
          p.age = p.life;
          return;
        }
        ctx.globalAlpha = 0.9 * (1 - k * 0.6);
        ctx.fillStyle = "#e8f2ff";
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
        return;
      }
      if (p.kind === "smoke") {
        p.vx *= 1 - dt * 0.8;
        p.vy -= 2 * dt;
        const r = p.r0 + (p.r1 - p.r0) * Math.sqrt(k);
        const img = C.puffs[p.tone || "grey"][p.v || 0];
        drawRot(img, 0, 0, img.width, img.height, p.x, p.y, r * 2, r * 2, p.rot + k * 0.6, (p.a0 || 0.75) * (1 - k) * smooth(0, 0.06, k));
      }
    }

    /* text in the sky: a pop for each pickup or hit, and the win counter riding above the plane */
    function label(text, x, y, size, color, glow) {
      ctx.font = "900 " + size + "px " + FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = size * 0.2;
      ctx.strokeStyle = "rgba(4,8,20,.85)";
      ctx.strokeText(text, x, y);
      if (glow) {
        ctx.shadowColor = glow;
        ctx.shadowBlur = size * 0.6 * s;
      }
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
    }
    function tag(text, x, y) {
      const size = 3.2;
      ctx.font = "800 " + size + "px " + FONT;
      const w = ctx.measureText(text).width + size * 1.6;
      const h = size * 1.75;
      pill(ctx, x - w / 2, y - h / 2, w, h, h / 2);
      ctx.fillStyle = "rgba(6,10,24,.74)";
      ctx.fill();
      ctx.lineWidth = 0.16;
      ctx.strokeStyle = "rgba(255,210,110,.62)";
      ctx.stroke();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffd76a";
      ctx.fillText(text, x, y + size * 0.05);
    }

    /* ---------------- one frame ---------------- */
    function draw(sc, dt) {
      if (!C) return;
      const t = sc.time;
      shake = Math.max(0, shake - dt);
      smokeT = Math.max(0, smokeT - dt);
      fireT = Math.max(0, fireT - dt);
      const amp = shake / 0.35;
      const ox = amp ? rnd(-1, 1) * s * 1.1 * amp : 0;
      const oy = amp ? rnd(-1, 1) * s * 0.7 * amp : 0;
      const camX = sc.camX;
      camL = camX;
      const pl = sc.plane;

      /* 1. the sky and its clouds: they drift, and slide by slower than the sea, being further away */
      ctx.setTransform(1, 0, 0, 1, ox, oy);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(C.sky.canvas, 0, 0);
      twinkle(t);
      C.clouds.forEach((L) => cloudLayer(L, camX, t));

      /* 2. the sea: depth, the swell (each band at the speed of its distance), the sun's glitter */
      ctx.drawImage(C.sea.canvas, 0, C.sea.top);
      for (const b of C.waves) {
        const off = ((((camX * b.k + t * b.drift) * s) % b.T) + b.T) % b.T;
        ctx.drawImage(b.canvas, -off, b.y);
        if (b.T - off < Wd) ctx.drawImage(b.canvas, b.T - off, b.y);
      }
      glitter(t);

      /* 3. the world */
      WX = -camX * s + ox;
      WY = oy;
      worldT();
      sc.carriers.forEach((c) => reflection(c, t));
      sc.carriers.forEach((c) => ship(c, t));
      sc.pickups.forEach((pk) => coin(pk, t));
      sc.rockets.forEach((r) => rocket(r, dt));
      (sc.bombs || []).forEach((b) => bomb(b, t));
      planeTrail(pl);
      parts = parts.filter((p) => (p.age += dt) < p.life);
      parts.forEach((p) => p.layer === 0 && particle(p, dt));
      if (pl.visible) {
        /* its shadow on the deck while it's down there */
        const hgt = DECK_Y - (pl.y + WHEEL_Y);
        if (hgt > -0.5 && hgt < 12 && sc.carriers.some((c) => pl.x > c.x - 6 && pl.x < c.x + CARRIER_L + 4)) {
          ctx.globalAlpha = 0.55 * (1 - hgt / 12);
          ctx.drawImage(C.glow.shadow, pl.x - 15 + hgt * 0.6, 98.1, 33 - hgt, 1.6);
          ctx.globalAlpha = 1;
        }
        drawPlane(pl, t);
      }
      parts.forEach((p) => p.layer === 1 && particle(p, dt));
      pops = pops.filter((p) => (p.age += dt) < p.life);
      pops.forEach((p) => {
        const k = p.age / p.life;
        ctx.globalAlpha = k < 0.65 ? 1 : 1 - (k - 0.65) / 0.35;
        const grow = k < 0.15 ? 0.7 + (k / 0.15) * 0.45 : k < 0.3 ? 1.15 - ((k - 0.15) / 0.15) * 0.15 : 1;
        label(p.text, p.x, p.y - 23 - p.age * 9, 4.6 * grow, p.color, p.color);
      });
      ctx.globalAlpha = 1;
      if (pl.visible && sc.counter && pl.y < SEA_Y - 4) tag(sc.counter, pl.x + 1, pl.y - 15.8);

      /* 4. the lens: a soft vignette */
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(C.vignette, 0, 0);
    }

    /* engine trouble: a long trail of dark smoke from the cowling (no flames) */
    function engineTrouble(secs) {
      smokeT = Math.max(smokeT, secs || 8);
    }

    return { resize, draw, explode, sparkle, splash, dust, pop, clear, engineTrouble, width: () => W };
  }

  global.VBWingsArt = { createRenderer, WORLD_H, SEA_Y, DECK_Y, CARRIER_L, HORIZON, WHEEL_X, WHEEL_Y, GROUND_PITCH };
})(window);
