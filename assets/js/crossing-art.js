/* Rendo Crossing — the road scene, drawn on a canvas at the screen's full resolution.
   A night road seen from above: textured asphalt under street lamps, worn lane paint, cast-iron manhole covers, glossy
   traffic with headlight beams, blue-and-white barricades, a sidewalk with a working traffic light, and the hen.
   The scene only shows what the game tells it to (crossing.js decides every outcome); it owns the ambient traffic and
   makes sure no ambient car ever reaches the hen.
   API: VBCrossingArt.create(canvas, { reduceMotion, onScreech, onHonk }) → scene */
(function (global) {
  "use strict";

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const backOut = (t) => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);

  /* a small seeded random, so the textures and decor come out the same on every resize */
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function canvasOf(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  /* ---------------- textures (tileable) ---------------- */
  /* per-pixel noise from fn(rand) → [r, g, b] */
  function noiseTile(size, seed, fn) {
    const c = canvasOf(size, size);
    const g = c.getContext("2d");
    const img = g.createImageData(c.width, c.height);
    const r = rng(seed);
    for (let i = 0; i < img.data.length; i += 4) {
      const [a, b, d] = fn(r);
      img.data[i] = a;
      img.data[i + 1] = b;
      img.data[i + 2] = d;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /* draws something at (x, y) and again wrapped across the edges, so the tile stays seamless */
  function wrapDraw(size, x, y, draw) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) draw(x + dx * size, y + dy * size);
  }

  function asphaltTile(px) {
    const S = Math.round(256 * px);
    const c = noiseTile(S, 11, (r) => {
      const v = r();
      let base = 36 + (r() - 0.5) * 14;
      if (v < 0.035) base += 26 + r() * 40;      /* pale aggregate */
      else if (v < 0.07) base -= 14;             /* pits */
      return [base * 0.92, base * 0.97, base * 1.1];   /* a cool, bluish night tint */
    });
    const g = c.getContext("2d");
    const r = rng(7);
    /* blotches: patched and worn areas */
    for (let i = 0; i < 26; i++) {
      const x = r() * S, y = r() * S, rad = (20 + r() * 70) * px, dark = r() < 0.6;
      wrapDraw(S, x, y, (cx, cy) => {
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
        gr.addColorStop(0, dark ? "rgba(0,0,0,.16)" : "rgba(170,180,200,.05)");
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      });
    }
    /* hairline cracks */
    g.lineCap = "round";
    for (let i = 0; i < 7; i++) {
      let x = r() * S, y = r() * S, a = r() * TAU;
      const pts = [[x, y]];
      for (let k = 0; k < 14; k++) {
        a += (r() - 0.5) * 1.1;
        x += Math.cos(a) * 7 * px;
        y += Math.sin(a) * 7 * px;
        pts.push([x, y]);
      }
      wrapDraw(S, 0, 0, (ox, oy) => {
        g.beginPath();
        pts.forEach(([px2, py], k) => g[k ? "lineTo" : "moveTo"](px2 + ox, py + oy));
        g.strokeStyle = "rgba(0,0,0,.45)";
        g.lineWidth = 1.1 * px;
        g.stroke();
        g.strokeStyle = "rgba(150,160,180,.07)";
        g.lineWidth = 0.6 * px;
        g.translate(0.8 * px, 0.8 * px);
        g.stroke();
        g.setTransform(1, 0, 0, 1, 0, 0);
      });
    }
    /* an oil stain or two, with a faint sheen */
    for (let i = 0; i < 2; i++) {
      const x = r() * S, y = r() * S, rad = (16 + r() * 16) * px;
      wrapDraw(S, x, y, (cx, cy) => {
        g.save();
        g.translate(cx, cy);
        g.scale(1, 1.6);
        const gr = g.createRadialGradient(0, 0, 0, 0, 0, rad);
        gr.addColorStop(0, "rgba(5,6,10,.42)");
        gr.addColorStop(0.7, "rgba(40,30,70,.12)");
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.beginPath();
        g.arc(0, 0, rad, 0, TAU);
        g.fill();
        g.restore();
      });
    }
    return c;
  }

  function grassTile(px) {
    const S = Math.round(160 * px);
    const c = noiseTile(S, 21, (r) => {
      const v = 0.75 + r() * 0.5;
      return [18 * v, 40 * v, 22 * v];
    });
    const g = c.getContext("2d");
    const r = rng(5);
    g.lineCap = "round";
    for (let i = 0; i < 1500; i++) {
      const x = r() * S, y = r() * S;
      const len = (3 + r() * 6) * px;
      const a = -Math.PI / 2 + (r() - 0.5) * 1.3;
      const l = 0.5 + r() * 0.8;
      const col = "rgba(" + Math.round(40 * l) + "," + Math.round(95 * l) + "," + Math.round(42 * l) + "," + (0.35 + r() * 0.5).toFixed(2) + ")";
      wrapDraw(S, x, y, (cx, cy) => {
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        g.strokeStyle = col;
        g.lineWidth = (0.7 + r() * 0.6) * px;
        g.stroke();
      });
    }
    /* clover and dark tufts */
    for (let i = 0; i < 40; i++) {
      const x = r() * S, y = r() * S, rad = (4 + r() * 9) * px;
      wrapDraw(S, x, y, (cx, cy) => {
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
        gr.addColorStop(0, r() < 0.5 ? "rgba(0,0,0,.25)" : "rgba(90,140,70,.18)");
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      });
    }
    return c;
  }

  function concreteTile(px, slab) {
    const S = Math.round(slab * px);
    const c = noiseTile(S, 31, (r) => {
      const v = 84 + (r() - 0.5) * 18 + (r() < 0.02 ? -20 : 0);
      return [v, v * 1.01, v * 1.05];
    });
    const g = c.getContext("2d");
    const r = rng(9);
    for (let i = 0; i < 10; i++) {
      const x = r() * S, y = r() * S, rad = (10 + r() * 30) * px;
      wrapDraw(S, x, y, (cx, cy) => {
        const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
        gr.addColorStop(0, r() < 0.6 ? "rgba(0,0,0,.1)" : "rgba(255,255,255,.04)");
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      });
    }
    /* the joint between slabs: a dark groove with a lit lip */
    g.fillStyle = "rgba(0,0,0,.5)";
    g.fillRect(0, 0, S, 1.6 * px);
    g.fillStyle = "rgba(255,255,255,.08)";
    g.fillRect(0, 1.6 * px, S, 1 * px);
    return c;
  }

  /* a worn paint dash: paint with the asphalt grain showing through */
  function dashSprite(px, w, h) {
    const c = canvasOf(w * px, h * px);
    const g = c.getContext("2d");
    const img = g.createImageData(c.width, c.height);
    const r = rng(41);
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const edge = Math.min(x, c.width - 1 - x, y, c.height - 1 - y) / px;
        const wear = r();
        let a = wear < 0.18 ? 0.25 : 0.85 - r() * 0.15;
        if (edge < 1) a *= 0.5 + r() * 0.4;
        const v = 222 + r() * 25;
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v * 0.97;
        img.data[i + 3] = a * 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /* ---------------- sprites ---------------- */
  /* a cast-iron manhole cover set in the road, diameter D */
  function manholeSprite(px, D) {
    const pad = 6;
    const S = (D + pad * 2) * px;
    const c = canvasOf(S, S);
    const g = c.getContext("2d");
    g.scale(px, px);
    g.translate(D / 2 + pad, D / 2 + pad);
    const R = D / 2;
    /* the frame sunk into the asphalt: a dark seam, then a worn steel ring */
    g.beginPath();
    g.arc(0, 0, R + 3, 0, TAU);
    g.fillStyle = "rgba(0,0,0,.6)";
    g.fill();
    let gr = g.createLinearGradient(-R, -R, R, R);
    gr.addColorStop(0, "#7c828d");
    gr.addColorStop(0.45, "#3d424b");
    gr.addColorStop(1, "#1e2127");
    g.beginPath();
    g.arc(0, 0, R, 0, TAU);
    g.fillStyle = gr;
    g.fill();
    /* the lid */
    const r2 = R * 0.86;
    gr = g.createRadialGradient(-r2 * 0.35, -r2 * 0.4, r2 * 0.1, 0, 0, r2 * 1.05);
    gr.addColorStop(0, "#5a5f68");
    gr.addColorStop(0.6, "#33373e");
    gr.addColorStop(1, "#1b1d22");
    g.beginPath();
    g.arc(0, 0, r2, 0, TAU);
    g.fillStyle = gr;
    g.fill();
    g.save();
    g.clip();
    /* the raised diamond grip pattern: each stud has a lit top-left and a shadowed bottom-right */
    const step = Math.max(4, R * 0.16);
    g.rotate(Math.PI / 4);
    for (let x = -R; x <= R; x += step) {
      for (let y = -R; y <= R; y += step) {
        const s = step * 0.42;
        g.fillStyle = "rgba(0,0,0,.45)";
        g.fillRect(x - s / 2 + 0.8, y - s / 2 + 0.8, s, s);
        g.fillStyle = "rgba(160,168,180,.28)";
        g.fillRect(x - s / 2 - 0.4, y - s / 2 - 0.4, s, s);
        g.fillStyle = "#3b3f46";
        g.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
    g.rotate(-Math.PI / 4);
    /* rust bloom and road grime */
    const rr = rng(77);
    for (let i = 0; i < 5; i++) {
      const x = (rr() - 0.5) * R * 1.4, y = (rr() - 0.5) * R * 1.4, rad = R * (0.2 + rr() * 0.35);
      gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, "rgba(120,62,24,.32)");
      gr.addColorStop(1, "rgba(120,62,24,0)");
      g.fillStyle = gr;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    g.restore();
    /* the plain centre plate with its two lifting slots */
    g.beginPath();
    g.arc(0, 0, R * 0.34, 0, TAU);
    gr = g.createRadialGradient(-R * 0.1, -R * 0.12, 0, 0, 0, R * 0.36);
    gr.addColorStop(0, "#6b707a");
    gr.addColorStop(1, "#30343a");
    g.fillStyle = gr;
    g.fill();
    g.strokeStyle = "rgba(0,0,0,.5)";
    g.lineWidth = 1;
    g.stroke();
    [-1, 1].forEach((s) => {
      g.fillStyle = "#0b0c0f";
      g.beginPath();
      g.ellipse(s * R * 0.62, 0, R * 0.09, R * 0.04, 0, 0, TAU);
      g.fill();
    });
    /* the lid's bevel: lit along the top-left edge */
    g.beginPath();
    g.arc(0, 0, r2, Math.PI * 0.95, Math.PI * 1.75);
    g.strokeStyle = "rgba(220,226,235,.35)";
    g.lineWidth = 1.2;
    g.stroke();
    g.beginPath();
    g.arc(0, 0, r2, Math.PI * 1.95, Math.PI * 0.75);
    g.strokeStyle = "rgba(0,0,0,.55)";
    g.stroke();
    return { canvas: c, size: D + pad * 2 };
  }

  /* ---- the cars, seen from above with the front facing down the screen ---- */
  const CAR_TYPES = {
    sedan:  { paint: ["#081d4d", "#1e56c4", "#7fb0ff"], len: 1.95, kind: "sedan" },     /* blue saloon */
    suv:    { paint: ["#4a0808", "#b91c1c", "#ff7a6b"], len: 2.05, kind: "suv" },       /* red SUV */
    van:    { paint: ["#7c838d", "#dde1e7", "#ffffff"], len: 2.35, kind: "van" },       /* white van */
    taxi:   { paint: ["#704a00", "#efb103", "#ffe382"], len: 1.95, kind: "taxi" },      /* yellow taxi */
    sports: { paint: ["#22093f", "#6527c9", "#c1a1ff"], len: 1.85, kind: "sports" }     /* purple sports car */
  };
  const CAR_KEYS = Object.keys(CAR_TYPES);

  function glass(g, x0, y0, x1, y1) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, "#0a0f1a");
    gr.addColorStop(0.55, "#16233a");
    gr.addColorStop(1, "#33476b");
    return gr;
  }

  function carSprite(px, type, w) {
    const T = CAR_TYPES[type];
    const l = w * T.len;
    const pad = 14;
    const c = canvasOf((w + pad * 2) * px, (l + pad * 2) * px);
    const g = c.getContext("2d");
    g.scale(px, px);
    g.translate(w / 2 + pad, l / 2 + pad);
    const [dark, mid, light] = T.paint;
    const sports = T.kind === "sports", van = T.kind === "van", suv = T.kind === "suv";
    const rf = sports ? w * 0.36 : van ? w * 0.18 : w * 0.3;   /* front corner radius */
    const rb = suv || van ? w * 0.14 : w * 0.24;               /* rear corner radius */
    const body = () => {
      g.beginPath();
      g.roundRect(-w / 2, -l / 2, w, l, [rb, rb, rf, rf]);
    };

    /* the shadow cast on the road (the lamps are high and a little behind) */
    g.save();
    g.shadowColor = "rgba(0,0,0,.75)";
    g.shadowBlur = 9 * px;
    g.shadowOffsetY = 5 * px;
    body();
    g.fillStyle = "#000";
    g.fill();
    g.restore();

    /* tyres peeking out under the wheel arches */
    g.fillStyle = "#08090b";
    [-1, 1].forEach((sx) => [-0.31, 0.3].forEach((fy) => {
      g.beginPath();
      g.roundRect(sx * (w / 2 + 1) - 3, fy * l - l * 0.085, 6, l * 0.17, 2);
      g.fill();
    }));

    /* the paint: rounded across the car, with a cool sky reflection down the middle */
    let gr = g.createLinearGradient(-w / 2, 0, w / 2, 0);
    gr.addColorStop(0, dark);
    gr.addColorStop(0.16, mid);
    gr.addColorStop(0.42, light);
    gr.addColorStop(0.58, mid);
    gr.addColorStop(0.88, mid);
    gr.addColorStop(1, dark);
    body();
    g.fillStyle = gr;
    g.fill();
    gr = g.createLinearGradient(0, -l / 2, 0, l / 2);
    gr.addColorStop(0, "rgba(0,0,0,.25)");
    gr.addColorStop(0.3, "rgba(255,255,255,0)");
    gr.addColorStop(0.75, "rgba(255,255,255,.06)");
    gr.addColorStop(1, "rgba(0,0,0,.3)");
    body();
    g.fillStyle = gr;
    g.fill();
    /* sharp edge of the body side catching light */
    body();
    g.strokeStyle = "rgba(0,0,0,.55)";
    g.lineWidth = 1;
    g.stroke();

    if (sports) {
      /* twin racing stripes from nose to tail */
      g.save();
      body();
      g.clip();
      g.fillStyle = "rgba(10,8,18,.82)";
      g.fillRect(-w * 0.16, -l / 2, w * 0.1, l);
      g.fillRect(w * 0.06, -l / 2, w * 0.1, l);
      g.restore();
    }

    /* the cabin: glass all round, roof on top (so the side windows show as a band) */
    let ws0, ws1, roof0, roof1, rear1;   /* y of: windscreen front edge, roof front, roof back, rear glass back */
    if (van) { ws0 = l * 0.36; roof1 = l * 0.24; roof0 = -l * 0.47; rear1 = -l * 0.47; }
    else if (sports) { ws0 = l * 0.1; roof1 = -l * 0.04; roof0 = -l * 0.22; rear1 = -l * 0.32; }
    else if (suv) { ws0 = l * 0.2; roof1 = l * 0.08; roof0 = -l * 0.34; rear1 = -l * 0.42; }
    else { ws0 = l * 0.17; roof1 = l * 0.03; roof0 = -l * 0.22; rear1 = -l * 0.34; }
    const gw = w * (van ? 0.9 : 0.82);
    g.beginPath();
    g.roundRect(-gw / 2, rear1, gw, ws0 - rear1, w * 0.16);
    g.fillStyle = glass(g, -gw / 2, rear1, gw / 2, ws0);
    g.fill();
    /* the reflection streak across the windscreen */
    g.save();
    g.clip();
    g.globalAlpha = 0.3;
    g.fillStyle = "#cfe0ff";
    g.beginPath();
    g.moveTo(-gw / 2, ws0 - l * 0.02);
    g.lineTo(-gw / 2 + w * 0.22, ws0 - l * 0.02);
    g.lineTo(-gw / 2 + w * 0.5, roof1);
    g.lineTo(-gw / 2 + w * 0.36, roof1);
    g.closePath();
    g.fill();
    g.restore();

    const rw = w * (van ? 0.86 : 0.7);
    g.beginPath();
    g.roundRect(-rw / 2, roof0, rw, roof1 - roof0, w * 0.12);
    gr = g.createLinearGradient(-rw / 2, 0, rw / 2, 0);
    gr.addColorStop(0, dark);
    gr.addColorStop(0.35, light);
    gr.addColorStop(0.65, mid);
    gr.addColorStop(1, dark);
    g.fillStyle = gr;
    g.fill();
    g.strokeStyle = "rgba(0,0,0,.35)";
    g.stroke();
    /* the gloss: a soft highlight on the roof */
    gr = g.createRadialGradient(-rw * 0.15, (roof0 + roof1) / 2, 0, -rw * 0.15, (roof0 + roof1) / 2, rw * 0.6);
    gr.addColorStop(0, "rgba(255,255,255,.35)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fill();

    if (van) {
      /* a box body: stiffening ribs across the roof */
      g.strokeStyle = "rgba(0,0,0,.14)";
      g.lineWidth = 1.2;
      for (let y = roof0 + l * 0.08; y < roof1 - 2; y += l * 0.08) {
        g.beginPath();
        g.moveTo(-rw / 2 + 3, y);
        g.lineTo(rw / 2 - 3, y);
        g.stroke();
      }
    }
    if (suv) {
      /* roof rails */
      g.strokeStyle = "rgba(210,215,225,.75)";
      g.lineWidth = 1.6;
      [-1, 1].forEach((s) => {
        g.beginPath();
        g.moveTo(s * rw * 0.38, roof0 + 4);
        g.lineTo(s * rw * 0.38, roof1 - 4);
        g.stroke();
      });
    }
    if (T.kind === "taxi") {
      /* the roof sign */
      const sw = w * 0.42, sh = l * 0.07, sy = (roof0 + roof1) / 2;
      g.beginPath();
      g.roundRect(-sw / 2, sy - sh / 2, sw, sh, 2);
      g.fillStyle = "#fff7d6";
      g.fill();
      g.strokeStyle = "rgba(0,0,0,.5)";
      g.stroke();
      g.fillStyle = "#1a1a1a";
      g.font = "900 " + Math.max(5, sh * 0.72) + "px Arial, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("TAXI", 0, sy + 0.5);
      /* checker strip down each side */
      [-1, 1].forEach((s) => {
        for (let k = 0; k < 8; k++) {
          g.fillStyle = k % 2 ? "#111" : "#f5f5f5";
          g.fillRect(s * (w / 2 - 3.2) - 1.6, -l * 0.18 + k * l * 0.045, 3.2, l * 0.045);
        }
      });
    }

    /* bonnet creases and the clear-coat glint on the bonnet */
    g.strokeStyle = "rgba(0,0,0,.18)";
    g.lineWidth = 1;
    [-1, 1].forEach((s) => {
      g.beginPath();
      g.moveTo(s * w * 0.22, ws0 + 4);
      g.quadraticCurveTo(s * w * 0.2, (ws0 + l / 2) / 2, s * w * 0.26, l / 2 - 6);
      g.stroke();
    });
    gr = g.createRadialGradient(-w * 0.12, (ws0 + l / 2) / 2, 0, -w * 0.12, (ws0 + l / 2) / 2, w * 0.45);
    gr.addColorStop(0, "rgba(255,255,255,.28)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.beginPath();
    g.ellipse(-w * 0.12, (ws0 + l / 2) / 2, w * 0.3, (l / 2 - ws0) * 0.4, 0, 0, TAU);
    g.fill();

    /* mirrors */
    [-1, 1].forEach((s) => {
      g.beginPath();
      g.ellipse(s * (w / 2 + 2.5), ws0 - l * 0.04, 3.2, 2.2, s * 0.4, 0, TAU);
      g.fillStyle = mid;
      g.fill();
      g.strokeStyle = "rgba(0,0,0,.6)";
      g.stroke();
    });

    /* lamps: headlights at the front corners, tail lights at the back */
    [-1, 1].forEach((s) => {
      const hx = s * w * 0.32, hy = l / 2 - 3.5;
      gr = g.createRadialGradient(hx, hy, 0, hx, hy, w * 0.16);
      gr.addColorStop(0, "#ffffff");
      gr.addColorStop(0.45, "#fff1c4");
      gr.addColorStop(1, "rgba(255,230,160,0)");
      g.fillStyle = gr;
      g.beginPath();
      g.ellipse(hx, hy, w * 0.14, 3.6, 0, 0, TAU);
      g.fill();
      g.fillStyle = "#ff2a2a";
      g.beginPath();
      g.roundRect(s * w * 0.33 - w * 0.09, -l / 2 + 0.8, w * 0.18, 3, 1.5);
      g.fill();
      gr = g.createRadialGradient(s * w * 0.33, -l / 2 + 2, 0, s * w * 0.33, -l / 2 + 2, w * 0.18);
      gr.addColorStop(0, "rgba(255,40,40,.5)");
      gr.addColorStop(1, "rgba(255,40,40,0)");
      g.fillStyle = gr;
      g.fillRect(s * w * 0.33 - w * 0.2, -l / 2 - w * 0.2, w * 0.4, w * 0.4);
    });
    /* grille */
    g.fillStyle = "rgba(8,8,10,.85)";
    g.beginPath();
    g.roundRect(-w * 0.18, l / 2 - 4, w * 0.36, 3, 1);
    g.fill();
    if (sports) {
      /* a rear wing, a touch wider than the body */
      g.fillStyle = "#121018";
      g.beginPath();
      g.roundRect(-w * 0.5, -l / 2 + 2, w, 4, 2);
      g.fill();
      g.fillStyle = "rgba(255,255,255,.18)";
      g.fillRect(-w * 0.48, -l / 2 + 2.4, w * 0.96, 1);
    }
    return { canvas: c, w: w + pad * 2, h: l + pad * 2, len: l };
  }

  /* the traffic light on the corner: a pole with a three-lamp head, seen from the front */
  function drawTrafficLight(g, x, baseY, h, state, t) {
    const pw = Math.max(4, h * 0.035);
    /* the base plate and the pole's shadow */
    g.fillStyle = "rgba(0,0,0,.45)";
    g.beginPath();
    g.ellipse(x + 6, baseY + 3, pw * 3, pw * 1.1, 0, 0, TAU);
    g.fill();
    let gr = g.createLinearGradient(x - pw, 0, x + pw, 0);
    gr.addColorStop(0, "#2c3038");
    gr.addColorStop(0.35, "#9aa1ab");
    gr.addColorStop(0.6, "#4a4f58");
    gr.addColorStop(1, "#1a1c21");
    g.fillStyle = gr;
    g.fillRect(x - pw / 2, baseY - h, pw, h);
    g.beginPath();
    g.ellipse(x, baseY, pw * 1.6, pw * 0.6, 0, 0, TAU);
    g.fill();
    /* the head */
    const hw = h * 0.2, hh = h * 0.5, hx = x - hw / 2, hy = baseY - h - hh * 0.15;
    gr = g.createLinearGradient(hx, 0, hx + hw, 0);
    gr.addColorStop(0, "#15171c");
    gr.addColorStop(0.4, "#2e323a");
    gr.addColorStop(1, "#0b0c0f");
    g.fillStyle = gr;
    g.beginPath();
    g.roundRect(hx, hy, hw, hh, hw * 0.18);
    g.fill();
    g.strokeStyle = "rgba(255,255,255,.12)";
    g.lineWidth = 1;
    g.stroke();
    const lamps = [["red", "#ff2d2d"], ["amber", "#ffb21f"], ["green", "#2ef07a"]];
    const blink = state === "amber" ? Math.sin(t * 9) > 0 : true;
    lamps.forEach(([name, col], i) => {
      const cy = hy + hh * (0.19 + i * 0.31), r = hw * 0.3;
      const on = state === name && blink;
      /* the visor */
      g.fillStyle = "#07080a";
      g.beginPath();
      g.ellipse(x, cy - r * 0.9, r * 1.15, r * 0.4, 0, Math.PI, TAU);
      g.fill();
      gr = g.createRadialGradient(x - r * 0.3, cy - r * 0.3, 0, x, cy, r);
      if (on) {
        gr.addColorStop(0, "#ffffff");
        gr.addColorStop(0.3, col);
        gr.addColorStop(1, col);
      } else {
        gr.addColorStop(0, "rgba(255,255,255,.12)");
        gr.addColorStop(1, "rgba(30,30,30,1)");
      }
      g.fillStyle = on ? gr : gr;
      g.beginPath();
      g.arc(x, cy, r, 0, TAU);
      g.fill();
      if (!on) {
        g.fillStyle = col;
        g.globalAlpha = 0.14;
        g.fill();
        g.globalAlpha = 1;
      } else {
        /* the glow it throws */
        g.save();
        g.globalCompositeOperation = "lighter";
        gr = g.createRadialGradient(x, cy, 0, x, cy, r * 6);
        gr.addColorStop(0, col + "88");
        gr.addColorStop(1, col + "00");
        g.fillStyle = gr;
        g.fillRect(x - r * 6, cy - r * 6, r * 12, r * 12);
        g.restore();
      }
    });
  }

  /* a shrub: clustered leaf masses, lit from the street lamp above-left */
  function bushSprite(px, R, seed) {
    const S = R * 2.6;
    const c = canvasOf(S * px, S * px);
    const g = c.getContext("2d");
    g.scale(px, px);
    g.translate(S / 2, S / 2);
    const r = rng(seed);
    g.fillStyle = "rgba(0,0,0,.45)";
    g.beginPath();
    g.ellipse(R * 0.18, R * 0.3, R * 1.1, R * 0.85, 0, 0, TAU);
    g.fill();
    for (let i = 0; i < 9; i++) {
      const a = r() * TAU, d = r() * R * 0.5, rad = R * (0.42 + r() * 0.3);
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      const gr = g.createRadialGradient(x - rad * 0.35, y - rad * 0.4, rad * 0.1, x, y, rad);
      gr.addColorStop(0, "#4f8a3c");
      gr.addColorStop(0.55, "#22512a");
      gr.addColorStop(1, "#0b2212");
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, rad, 0, TAU);
      g.fill();
    }
    /* individual leaves */
    for (let i = 0; i < 260; i++) {
      const a = r() * TAU, d = Math.sqrt(r()) * R * 0.95;
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      const lit = clamp(0.6 - (x + y) / (R * 2.2) + (r() - 0.5) * 0.4, 0.1, 1);
      g.fillStyle = "rgb(" + Math.round(30 + 70 * lit) + "," + Math.round(60 + 100 * lit) + "," + Math.round(30 + 45 * lit) + ")";
      g.globalAlpha = 0.55 + r() * 0.4;
      g.beginPath();
      g.ellipse(x, y, R * 0.07, R * 0.035, r() * TAU, 0, TAU);
      g.fill();
    }
    g.globalAlpha = 1;
    return { canvas: c, size: S };
  }

  /* ---------------- the hen ---------------- */
  /* drawn live so it can squash, flap and blink. Side view, facing right; (0, 0) is between its feet, units are
     at scale 1 (about 74px tall). pose: { wing 0..1, blink, flat 0..1, look } */
  const FEATHER_ROWS = (() => {
    const r = rng(91);
    const out = [];
    for (let i = 0; i < 70; i++) out.push([-20 + r() * 38, -46 + r() * 30, 2.2 + r() * 1.6, r()]);
    return out;
  })();

  function drawHen(g, pose) {
    const flat = pose.flat || 0;
    const wing = pose.wing || 0;
    const light = (x, y, r, c0, c1, c2) => {
      const gr = g.createRadialGradient(x, y, r * 0.05, x + r * 0.3, y + r * 0.35, r);
      gr.addColorStop(0, c0);
      gr.addColorStop(0.55, c1);
      gr.addColorStop(1, c2);
      return gr;
    };
    const WHITE = ["#ffffff", "#ece7de", "#a59d90"];

    /* legs and feet: scaled yellow-orange, the far leg in shade */
    if (flat < 0.5) {
      g.lineCap = "round";
      g.lineJoin = "round";
      [[-4, "#b4731f", 0.7], [3, "#efa53a", 1]].forEach(([lx, col, k]) => {
        g.strokeStyle = col;
        g.lineWidth = 3.2;
        g.beginPath();
        g.moveTo(lx - 1, -17);
        g.lineTo(lx, -8);
        g.lineTo(lx + 1, -1);
        g.stroke();
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(lx + 1, -1);
        g.lineTo(lx + 8, 0.5);
        g.moveTo(lx + 1, -1);
        g.lineTo(lx + 5, 1.5);
        g.moveTo(lx + 1, -1);
        g.lineTo(lx - 4, 0.5);
        g.stroke();
        g.strokeStyle = "rgba(90,40,0," + 0.35 * k + ")";
        g.lineWidth = 0.7;
        for (let y = -15; y < -3; y += 2.5) {
          g.beginPath();
          g.moveTo(lx - 1.6, y);
          g.lineTo(lx + 1.4, y + 0.6);
          g.stroke();
        }
      });
    }

    /* tail: layered feathers sweeping up and back */
    [[-0.9, "#d8d1c4"], [-0.6, "#efe9df"], [-0.35, "#fbf8f2"]].forEach(([a, col], i) => {
      g.save();
      g.translate(-14, -33);
      g.rotate(a - wing * 0.1);
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(-10, -6, -16 - i * 2, -20);
      g.quadraticCurveTo(-6, -16, 6, -4);
      g.closePath();
      const gr = g.createLinearGradient(-16, -20, 6, 0);
      gr.addColorStop(0, "#fff");
      gr.addColorStop(0.5, col);
      gr.addColorStop(1, "#9c9487");
      g.fillStyle = gr;
      g.fill();
      g.strokeStyle = "rgba(70,60,45,.25)";
      g.lineWidth = 0.6;
      g.stroke();
      g.beginPath();
      g.moveTo(2, -2);
      g.quadraticCurveTo(-6, -8, -14 - i * 2, -18);
      g.strokeStyle = "rgba(120,110,95,.3)";
      g.stroke();
      g.restore();
    });

    /* body */
    g.save();
    g.beginPath();
    g.ellipse(-1, -31, 22, 16.5, -0.18, 0, TAU);
    g.fillStyle = light(-9, -42, 30, ...WHITE);
    g.fill();
    /* the plumage: rows of small overlapping feathers, shaded */
    g.clip();
    FEATHER_ROWS.forEach(([x, y, s, k]) => {
      g.beginPath();
      g.arc(x, y, s, 0.15 * Math.PI, 0.85 * Math.PI);
      g.strokeStyle = "rgba(110,100,85," + (0.12 + k * 0.16).toFixed(2) + ")";
      g.lineWidth = 0.7;
      g.stroke();
    });
    /* belly shade and a soft fluff at the underside */
    const bs = g.createLinearGradient(0, -36, 0, -14);
    bs.addColorStop(0, "rgba(0,0,0,0)");
    bs.addColorStop(1, "rgba(60,50,40,.35)");
    g.fillStyle = bs;
    g.fillRect(-24, -48, 48, 34);
    g.restore();

    /* breast, pushed forward */
    g.beginPath();
    g.ellipse(11, -33, 11, 13, 0.2, 0, TAU);
    g.fillStyle = light(8, -42, 18, "#ffffff", "#f3efe8", "#b8b0a3");
    g.fill();

    /* neck and head */
    g.beginPath();
    g.moveTo(4, -38);
    g.quadraticCurveTo(7, -50, 13, -57);
    g.quadraticCurveTo(24, -62, 25, -51);
    g.quadraticCurveTo(24, -42, 19, -35);
    g.closePath();
    g.fillStyle = light(12, -56, 22, ...WHITE);
    g.fill();
    g.beginPath();
    g.arc(18, -53, 8.6, 0, TAU);
    g.fillStyle = light(14, -58, 12, "#ffffff", "#f4f0ea", "#c4bcae");
    g.fill();
    /* neck hackles: fine strokes */
    g.strokeStyle = "rgba(120,110,95,.22)";
    g.lineWidth = 0.6;
    for (let i = 0; i < 9; i++) {
      g.beginPath();
      g.moveTo(8 + i * 1.3, -44 + i * 0.4);
      g.quadraticCurveTo(9 + i * 1.4, -40, 7 + i * 1.6, -36);
      g.stroke();
    }

    /* comb: fleshy lobes, wet-looking */
    g.beginPath();
    g.moveTo(11, -58);
    g.arc(12.5, -62, 3.4, Math.PI * 0.8, Math.PI * 1.9);
    g.arc(17, -64.5, 3.9, Math.PI * 1.05, Math.PI * 1.95);
    g.arc(21.5, -62.5, 3.4, Math.PI * 1.15, Math.PI * 0.2);
    g.lineTo(22, -58);
    g.closePath();
    let gr = g.createLinearGradient(12, -68, 22, -56);
    gr.addColorStop(0, "#ff5a48");
    gr.addColorStop(0.5, "#df1f23");
    gr.addColorStop(1, "#8e0c14");
    g.fillStyle = gr;
    g.fill();
    g.fillStyle = "rgba(255,255,255,.4)";
    g.beginPath();
    g.ellipse(16, -66, 1.6, 0.8, -0.3, 0, TAU);
    g.fill();

    /* beak */
    g.beginPath();
    g.moveTo(24.5, -55.5);
    g.quadraticCurveTo(30, -54.5, 32.5, -51.8);
    g.lineTo(24.8, -51.2);
    g.closePath();
    gr = g.createLinearGradient(25, -56, 31, -51);
    gr.addColorStop(0, "#ffd06a");
    gr.addColorStop(1, "#d98613");
    g.fillStyle = gr;
    g.fill();
    g.beginPath();
    g.moveTo(24.8, -51.2);
    g.lineTo(31, -51.4);
    g.quadraticCurveTo(28, -48.8, 24.8, -49.2);
    g.closePath();
    g.fillStyle = "#b86b0d";
    g.fill();

    /* wattle and ear lobe */
    g.beginPath();
    g.moveTo(24, -49.5);
    g.quadraticCurveTo(27.5, -44, 24.5, -42.5);
    g.quadraticCurveTo(21, -43.5, 22.5, -49);
    g.closePath();
    gr = g.createRadialGradient(24, -47, 0, 24, -45, 5);
    gr.addColorStop(0, "#ff4b3e");
    gr.addColorStop(1, "#a50f17");
    g.fillStyle = gr;
    g.fill();
    g.fillStyle = "rgba(205,30,35,.75)";
    g.beginPath();
    g.ellipse(17.5, -51.5, 1.7, 2.3, 0, 0, TAU);
    g.fill();

    /* the eye */
    if (flat > 0.5) {
      g.strokeStyle = "#2a1a10";
      g.lineWidth = 1.1;
      g.beginPath();
      g.moveTo(19, -56.5); g.lineTo(23, -52.5);
      g.moveTo(23, -56.5); g.lineTo(19, -52.5);
      g.stroke();
    } else if (pose.blink) {
      g.strokeStyle = "#3a2410";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(19, -54.5);
      g.quadraticCurveTo(21, -53.5, 23, -54.5);
      g.stroke();
    } else {
      g.fillStyle = "#e39a2c";
      g.beginPath();
      g.arc(21, -54.6, 2.6, 0, TAU);
      g.fill();
      g.fillStyle = "#120a05";
      g.beginPath();
      g.arc(21.3 + (pose.look || 0) * 0.5, -54.6, 1.7, 0, TAU);
      g.fill();
      g.fillStyle = "#fff";
      g.beginPath();
      g.arc(21.9, -55.4, 0.6, 0, TAU);
      g.fill();
    }

    /* the wing: folded against the body, lifting from the shoulder when it flaps */
    g.save();
    g.translate(6, -38);
    g.rotate(-wing * 1.05);
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(-2, 10, -16, 10);
    g.quadraticCurveTo(-26, 8, -27, 2);
    g.quadraticCurveTo(-18, -4, 0, 0);
    g.closePath();
    gr = g.createLinearGradient(0, -2, -6, 12);
    gr.addColorStop(0, "#ffffff");
    gr.addColorStop(0.6, "#e7e1d6");
    gr.addColorStop(1, "#a9a093");
    g.fillStyle = gr;
    g.fill();
    g.strokeStyle = "rgba(80,70,55,.3)";
    g.lineWidth = 0.7;
    g.stroke();
    /* flight feathers along the trailing edge */
    for (let i = 0; i < 5; i++) {
      g.beginPath();
      g.moveTo(-6 - i * 4, 3 + i * 0.4);
      g.quadraticCurveTo(-9 - i * 4, 8, -12 - i * 3.4, 9.5 - i * 0.6);
      g.strokeStyle = "rgba(90,80,65,.32)";
      g.stroke();
    }
    g.restore();
  }

  /* a single feather, for the burst */
  function drawFeather(g, len) {
    g.beginPath();
    g.moveTo(-len / 2, 0);
    g.quadraticCurveTo(0, -len * 0.28, len / 2, 0);
    g.quadraticCurveTo(0, len * 0.22, -len / 2, 0);
    g.fillStyle = "#f6f2ea";
    g.fill();
    g.strokeStyle = "rgba(120,110,95,.6)";
    g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(-len / 2 - 2, 0.5);
    g.lineTo(len / 2, 0);
    g.stroke();
  }

  /* ---------------- the scene ---------------- */
  function create(canvas, opts) {
    const o = opts || {};
    const g = canvas.getContext("2d");
    const reduce = !!o.reduceMotion;
    const FONT = getComputedStyle(document.body).fontFamily;

    let W = 0, H = 0, px = 1;
    let LW = 100;           /* lane width */
    let ROAD_X = 0;         /* world x where the road starts */
    let GY = 0;             /* ground line: the hen's feet, the manhole centres */
    let BADGE_Y = 0;
    let worldW = 0;
    let tex = null;         /* patterns and sprites, rebuilt on resize */

    let mults = [];         /* the multiplier on each lane */
    let labels = [];
    let lanes = [];         /* per lane: { cars:[], hold, barred, barT, nextSpawn, speed, state } */
    let camX = 0, camTarget = 0;
    let trafficRate = 1;
    let light = "red";
    let shake = 0;
    let flash = 0;
    let particles = [];
    let decals = [];        /* feathers settled on the road, skid marks */
    let pending = null;     /* a hop waiting for its lane to clear */
    let t0 = performance.now(), now = 0;

    const hen = { lane: -1, x: 0, y: 0, hop: null, flat: 0, wing: 0, blink: 0, nextBlink: 2, jump: null, fade: 1, visible: true };

    const laneX = (i) => (i < 0 ? ROAD_X - LW * 0.62 * 0.5 - 6 : ROAD_X + (i + 0.5) * LW);
    const barrierY = () => GY - LW * 0.9;

    function resize() {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      px = Math.min(2.5, global.devicePixelRatio || 1);
      W = r.width;
      H = r.height;
      canvas.width = Math.round(W * px);
      canvas.height = Math.round(H * px);
      LW = clamp(W / 3.35, 88, 150);
      const grassL = LW * 0.78, walk = LW * 0.62;
      ROAD_X = grassL + walk + 6;
      GY = Math.round(H * 0.58);
      BADGE_Y = H - 22;
      worldW = ROAD_X + mults.length * LW + 6 + walk + LW * 1.3;
      tex = {
        asphalt: g.createPattern(asphaltTile(px), "repeat"),
        grass: g.createPattern(grassTile(px), "repeat"),
        concrete: g.createPattern(concreteTile(px, Math.round(LW * 0.55)), "repeat"),
        dash: dashSprite(px, 4, 30),
        manhole: manholeSprite(px, LW * 0.5),
        bush: bushSprite(px, LW * 0.36, 3),
        bush2: bushSprite(px, LW * 0.26, 8),
        cars: {}
      };
      const unscale = new DOMMatrix().scale(1 / px);
      ["asphalt", "grass", "concrete"].forEach((k) => tex[k].setTransform(unscale));
      const cw = LW * 0.5;
      CAR_KEYS.forEach((k) => (tex.cars[k] = carSprite(px, k, k === "van" ? cw * 1.06 : k === "sports" ? cw * 1.02 : cw)));
      /* cars keep their lane, re-size their sprites */
      lanes.forEach((L) => L.cars.forEach((c) => (c.sp = tex.cars[c.type])));
      hen.x = laneX(hen.lane);
      hen.y = GY;
      camX = camTarget = camFor(hen.lane);
    }

    function camFor(lane) {
      const target = laneX(lane) - W * (W < 520 ? 0.3 : 0.34);
      return clamp(target, 0, Math.max(0, worldW - W));
    }

    function newLane() {
      return { cars: [], hold: false, barred: false, barT: 0, nextSpawn: now + Math.random() * 2, speed: 0, state: "" };
    }

    function setLanes(list, fmt) {
      mults = list.slice();
      labels = list.map(fmt);
      lanes = list.map(newLane);
      reset();
      resize();
    }

    function reset() {
      lanes.forEach((L) => {
        L.hold = false;
        L.barred = false;
        L.barT = 0;
        L.state = "";
        L.cars = L.cars.filter((c) => !c.killer);
      });
      particles = [];
      decals = [];
      pending = null;
      Object.assign(hen, { lane: -1, hop: null, flat: 0, wing: 0, jump: null, visible: true });
      hen.x = laneX(-1);
      hen.y = GY;
      camTarget = camFor(-1);
      light = "red";
    }

    /* ---------------- traffic ---------------- */
    const baseSpeed = () => H * 1.15 * trafficRate;   /* px per second */

    function spawn(L, i, type, opts2) {
      const sp = tex.cars[type];
      const c = { type, sp, y: -sp.len / 2 - 12, v: (opts2 && opts2.v) || L.speed, stopAt: null, killer: !!(opts2 && opts2.killer), honk: false };
      L.cars.push(c);
      return c;
    }

    function laneSpeed() {
      return baseSpeed() * (0.85 + Math.random() * 0.45);
    }

    /* the lanes ahead of the hen run traffic; a lane she has crossed queues behind its barricade */
    function traffic(dt) {
      const firstVisible = Math.floor((camX - ROAD_X) / LW) - 1;
      const lastVisible = Math.ceil((camX + W - ROAD_X) / LW) + 1;
      lanes.forEach((L, i) => {
        if (!L.speed) L.speed = laneSpeed();
        const visible = i >= firstVisible && i <= lastVisible;
        if (visible && !L.hold && now >= L.nextSpawn) {
          const last = L.cars[L.cars.length - 1];
          const room = !last || last.y - last.sp.len / 2 > 30;
          const queueFull = L.barred && L.cars.filter((c) => c.stopAt !== null).length >= 2;
          if (room && !queueFull) spawn(L, i, CAR_KEYS[Math.floor(Math.random() * CAR_KEYS.length)]);
          L.nextSpawn = now + (L.barred ? 3 + Math.random() * 5 : 0.9 + Math.random() * 2.4) / Math.sqrt(trafficRate);
        }
        /* move, braking for the barricade and for the car ahead */
        for (let k = 0; k < L.cars.length; k++) {
          const c = L.cars[k];
          const half = c.sp.len / 2;
          let limit = Infinity;   /* the furthest the car's front may go */
          if (L.barred && c.y + half <= barrierY() - 4 + 1) limit = barrierY() - 8;
          const ahead = L.cars[k - 1];
          if (ahead && !c.killer) limit = Math.min(limit, ahead.y - ahead.sp.len / 2 - 10);
          c.stopAt = limit < Infinity && L.barred && limit < H ? limit : null;
          let v = c.killer ? c.v : L.speed;
          if (limit < Infinity) {
            const gap = limit - (c.y + half);
            const brake = H * 3.2;                       /* braking power */
            const vmax = Math.sqrt(Math.max(0, 2 * brake * gap));
            if (vmax < v) {
              if (!c.skid && v > H * 0.6 && gap < H * 0.25) {
                c.skid = true;
                if (o.onScreech && i === hen.lane) o.onScreech();   /* only the car pulling up behind her */
              }
              v = vmax;
            }
          }
          const before = c.y;
          c.y += v * dt;
          /* a car driving past the hen's row: tell the game, so it can play the pass-by */
          if (o.onPass && before < GY && c.y >= GY && i >= firstVisible && i <= lastVisible) {
            o.onPass({ near: Math.abs(laneX(i) - hen.x) / LW, speed: v / H, pan: clamp((laneX(i) - camX) / W * 2 - 1, -1, 1) });
          }
          c.speedNow = v;
          if (c.killer && !c.hit && c.y + half >= hen.y - 16) {
            c.hit = true;
            splat(c);
          }
        }
        L.cars = L.cars.filter((c) => c.y - c.sp.len / 2 < H + 30);
      });
    }

    /* is the lane empty above the hen (and just below her)? */
    const clear = (L) => !L.cars.some((c) => c.y - c.sp.len / 2 < GY + 30);

    /* ---------------- the hen moving ---------------- */
    const HOP_MS = reduce ? 160 : 430;

    function hop(lane, onLand) {
      const L = lanes[lane];
      if (!L) return;
      L.hold = true;   /* no new cars while she steps in */
      pending = { lane, onLand };
      camTarget = camFor(lane);
    }

    function startHop() {
      const p = pending;
      pending = null;
      hen.hop = { from: hen.x, to: laneX(p.lane), t: 0, lane: p.lane, onLand: p.onLand };
    }

    function barricade(lane) {
      const L = lanes[lane];
      L.barred = true;
      L.barT = 0;
      L.hold = false;
      L.nextSpawn = now + 0.8 + Math.random() * 2;
    }

    /* puts her on a lane at once, with the lanes behind her barred — a round carried on after a reload */
    function place(lane) {
      reset();
      for (let i = 0; i <= lane; i++) barricade(i);
      Object.assign(hen, { lane, hop: null });
      hen.x = laneX(lane);
      camX = camTarget = camFor(lane);
    }

    /* the car that hits her: comes in fast with a horn */
    function strike(lane, onHit) {
      const L = lanes[lane];
      const type = CAR_KEYS[Math.floor(Math.random() * CAR_KEYS.length)];
      const c = spawn(L, lane, type, { killer: true, v: Math.max(H * 2.4, L.speed * 1.8) });
      c.onHit = onHit;
      if (o.onHonk) o.onHonk();
    }

    function splat(car) {
      hen.flat = 1;
      shake = reduce ? 0 : 1;
      flash = 1;
      const s = LW / 110;
      if (!reduce) {
        for (let i = 0; i < 34; i++) {
          const a = Math.random() * TAU;
          const sp = (90 + Math.random() * 260) * s;
          particles.push({
            kind: "feather", x: hen.x + (Math.random() - 0.5) * 16 * s, y: hen.y - 28 * s,
            vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120 * s + car.v * 0.25,
            rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 9, len: (7 + Math.random() * 8) * s,
            life: 0, max: 1.4 + Math.random() * 1.3, ground: hen.y + (Math.random() - 0.3) * 40 * s
          });
        }
        for (let i = 0; i < 9; i++) {
          particles.push({ kind: "dust", x: hen.x + (Math.random() - 0.5) * 30 * s, y: hen.y - Math.random() * 12 * s,
            vx: (Math.random() - 0.5) * 60 * s, vy: -Math.random() * 40 * s, r: (8 + Math.random() * 10) * s, life: 0, max: 0.9 + Math.random() * 0.6 });
        }
      }
      /* the car leaves skid marks through where she stood */
      decals.push({ kind: "skid", x: hen.x, y0: hen.y - car.sp.len * 0.8, y1: hen.y + car.sp.len * 0.4, w: car.sp.w });
      const cb = car.onHit;
      car.onHit = null;
      if (cb) cb();
    }

    /* cash-out: a happy flap and hop on the spot */
    function cheer() {
      hen.jump = { t: 0 };
    }

    /* ---------------- painting ---------------- */
    function drawGround() {
      const x0 = camX, x1 = camX + W;
      const grassL = LW * 0.78, walk = LW * 0.62;
      const roadEnd = ROAD_X + mults.length * LW;
      /* grass and sidewalk on both sides */
      g.fillStyle = tex.grass;
      g.fillRect(x0, 0, Math.max(0, grassL - x0), H);
      g.fillRect(roadEnd + 6 + walk, 0, Math.max(0, x1 - (roadEnd + 6 + walk)), H);
      g.fillStyle = tex.concrete;
      g.fillRect(grassL, 0, walk, H);
      g.fillRect(roadEnd + 6, 0, walk, H);
      /* the grass meets the sidewalk with a darker soil line */
      [[grassL, 1], [roadEnd + 6 + walk, -1]].forEach(([x, d]) => {
        const gr = g.createLinearGradient(x, 0, x - d * 10, 0);
        gr.addColorStop(0, "rgba(0,0,0,.45)");
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.fillRect(d > 0 ? x - 10 : x, 0, 10, H);
      });
      /* asphalt */
      g.fillStyle = tex.asphalt;
      g.fillRect(ROAD_X, 0, roadEnd - ROAD_X, H);
      /* curbs: a granite kerb with a lit top face and a shadow onto the road */
      [[ROAD_X - 6, 1], [roadEnd, -1]].forEach(([x, d]) => {
        let gr = g.createLinearGradient(x, 0, x + 6, 0);
        gr.addColorStop(0, d > 0 ? "#b9bcc2" : "#5c6068");
        gr.addColorStop(1, d > 0 ? "#5c6068" : "#b9bcc2");
        g.fillStyle = gr;
        g.fillRect(x, 0, 6, H);
        g.fillStyle = "rgba(0,0,0,.35)";
        for (let y = 0; y < H; y += LW * 0.55) g.fillRect(x, y, 6, 1);
        gr = g.createLinearGradient(d > 0 ? x + 6 : x, 0, d > 0 ? x + 18 : x - 12, 0);
        gr.addColorStop(0, "rgba(0,0,0,.5)");
        gr.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = gr;
        g.fillRect(d > 0 ? x + 6 : x - 12, 0, 12, H);
      });
      /* the finish: a gold chequered strip on the far kerb */
      const fx = roadEnd + 6 + walk * 0.5;
      for (let y = 0, k = 0; y < H; y += 10, k++) {
        g.fillStyle = k % 2 ? "rgba(255,206,84,.85)" : "rgba(20,20,20,.85)";
        g.fillRect(fx - 10, y, 10, 10);
        g.fillStyle = k % 2 ? "rgba(20,20,20,.85)" : "rgba(255,206,84,.85)";
        g.fillRect(fx, y, 10, 10);
      }
      /* paint: solid edge lines and dashed lane lines */
      g.fillStyle = "rgba(225,225,215,.72)";
      g.fillRect(ROAD_X + 4, 0, 3, H);
      g.fillRect(roadEnd - 7, 0, 3, H);
      const dashLen = 30, period = 54;
      for (let i = 1; i < mults.length; i++) {
        const x = ROAD_X + i * LW;
        if (x < x0 - 10 || x > x1 + 10) continue;
        for (let y = -period + 12; y < H; y += period) g.drawImage(tex.dash, x - 2, y, 4, dashLen);
      }
    }

    function drawLamps() {
      /* sodium street lamps pool light on the road at intervals */
      g.save();
      g.globalCompositeOperation = "screen";
      const roadEnd = ROAD_X + mults.length * LW;
      for (let x = ROAD_X + LW * 0.2, k = 0; x < roadEnd + LW; x += LW * 2.6, k++) {
        if (x < camX - LW * 2 || x > camX + W + LW * 2) continue;
        const y = k % 2 ? H * 0.22 : H * 0.78;
        const R = LW * 1.6;
        const gr = g.createRadialGradient(x, y, 0, x, y, R);
        gr.addColorStop(0, "rgba(255,196,120,.16)");
        gr.addColorStop(0.5, "rgba(255,180,100,.06)");
        gr.addColorStop(1, "rgba(255,180,100,0)");
        g.fillStyle = gr;
        g.fillRect(x - R, y - R, R * 2, R * 2);
      }
      g.restore();
    }

    function drawManholes(t) {
      const M = tex.manhole;
      const next = hen.lane + 1;
      lanes.forEach((L, i) => {
        const x = laneX(i);
        if (x < camX - LW || x > camX + W + LW) return;
        g.drawImage(M.canvas, x - M.size / 2, GY - M.size / 2, M.size, M.size);
        const R = LW * 0.25;
        /* the next step pulses blue while a round is on */
        if (i === next && light === "green" && !hen.hop && !pending && !hen.flat) {
          const p = (Math.sin(t * 4) + 1) / 2;
          g.save();
          g.strokeStyle = "rgba(96,165,250," + (0.45 + p * 0.45).toFixed(2) + ")";
          g.lineWidth = 2.5;
          g.shadowColor = "rgba(59,130,246,.9)";
          g.shadowBlur = 12 * px;
          g.beginPath();
          g.arc(x, GY, R + 5 + p * 4, 0, TAU);
          g.stroke();
          g.restore();
        }
      });
    }

    function drawCar(c, i) {
      const x = laneX(i), sp = c.sp;
      /* the headlights throw a warm cone down the road ahead */
      g.save();
      g.globalCompositeOperation = "screen";
      const fy = c.y + sp.len / 2;
      g.translate(x, fy + LW * 0.55);
      g.scale(1, 2.1);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, LW * 0.42);
      gr.addColorStop(0, "rgba(255,238,200,.22)");
      gr.addColorStop(1, "rgba(255,238,200,0)");
      g.fillStyle = gr;
      g.fillRect(-LW * 0.5, -LW * 0.42, LW, LW * 0.84);
      g.restore();
      /* brake lights flare as it stops */
      if (c.stopAt !== null && c.speedNow < LW * 2) {
        g.save();
        g.globalCompositeOperation = "screen";
        const by = c.y - sp.len / 2;
        const gr2 = g.createRadialGradient(x, by, 0, x, by, LW * 0.4);
        gr2.addColorStop(0, "rgba(255,40,30,.4)");
        gr2.addColorStop(1, "rgba(255,40,30,0)");
        g.fillStyle = gr2;
        g.fillRect(x - LW * 0.4, by - LW * 0.4, LW * 0.8, LW * 0.8);
        g.restore();
      }
      g.drawImage(sp.canvas, x - sp.w / 2, c.y - sp.h / 2, sp.w, sp.h);
    }

    function drawBarricade(i, L, dt) {
      L.barT = Math.min(1, L.barT + dt / (reduce ? 0.05 : 0.38));
      const k = backOut(L.barT);
      const x = laneX(i), y = barrierY(), w = LW * 0.86;
      const left = x - w / 2;
      const len = w * clamp(k, 0, 1.06);
      /* shadow */
      g.fillStyle = "rgba(0,0,0,.45)";
      g.beginPath();
      g.roundRect(left + 2, y + 4, len, 9, 4);
      g.fill();
      /* the bar: blue and white reflective bands on a round tube */
      g.save();
      g.beginPath();
      g.roundRect(left, y - 5, len, 10, 5);
      g.clip();
      for (let s = 0; s < w * 1.2; s += 14) {
        g.fillStyle = (s / 14) % 2 ? "#f1f5f9" : "#1d4ed8";
        g.beginPath();
        g.moveTo(left + s, y - 5);
        g.lineTo(left + s + 14, y - 5);
        g.lineTo(left + s + 4, y + 5);
        g.lineTo(left + s - 10, y + 5);
        g.closePath();
        g.fill();
      }
      const gr = g.createLinearGradient(0, y - 5, 0, y + 5);
      gr.addColorStop(0, "rgba(255,255,255,.55)");
      gr.addColorStop(0.35, "rgba(255,255,255,0)");
      gr.addColorStop(1, "rgba(0,0,0,.45)");
      g.fillStyle = gr;
      g.fillRect(left, y - 5, len, 10);
      g.restore();
      /* the two weighted feet, each with an amber lamp that blinks */
      [left, left + len].forEach((fx, n) => {
        if (n === 1 && L.barT < 1) return;
        g.fillStyle = "#111827";
        g.beginPath();
        g.roundRect(fx - 5, y - 8, 10, 16, 3);
        g.fill();
        g.fillStyle = "rgba(255,255,255,.12)";
        g.fillRect(fx - 4, y - 7, 8, 2);
        const on = Math.sin(now * 6 + i + n * 3) > 0;
        g.fillStyle = on ? "#ffb020" : "#5a3c08";
        g.beginPath();
        g.arc(fx, y, 2.6, 0, TAU);
        g.fill();
        if (on) {
          g.save();
          g.globalCompositeOperation = "screen";
          const lg = g.createRadialGradient(fx, y, 0, fx, y, 16);
          lg.addColorStop(0, "rgba(255,176,32,.55)");
          lg.addColorStop(1, "rgba(255,176,32,0)");
          g.fillStyle = lg;
          g.fillRect(fx - 16, y - 16, 32, 32);
          g.restore();
        }
      });
    }

    function drawHenNow(dt, t) {
      const s = LW / 110;
      let x = hen.x, y = hen.y, sx = 1, sy = 1, lift = 0, wing = 0;
      if (hen.hop) {
        const h = hen.hop;
        h.t = Math.min(1, h.t + (dt * 1000) / HOP_MS);
        const e = easeInOut(h.t);
        x = hen.x = lerp(h.from, h.to, e);
        lift = Math.sin(Math.PI * h.t) * LW * 0.42;
        wing = Math.sin(h.t * Math.PI * 4) * 0.5 + 0.5;
        /* stretch in the air, squash on take-off and landing */
        const q = h.t < 0.12 ? (0.12 - h.t) * 1.6 : h.t > 0.88 ? (h.t - 0.88) * 1.6 : -Math.sin(Math.PI * h.t) * 0.08;
        sx = 1 + q;
        sy = 1 - q;
        if (h.t >= 1) {
          hen.hop = null;
          hen.lane = h.lane;
          hen.land = 1;
          if (h.onLand) h.onLand();
        }
      }
      if (hen.land) {
        hen.land = Math.max(0, hen.land - dt * 5);
        sx = 1 + hen.land * 0.14;
        sy = 1 - hen.land * 0.14;
      }
      if (hen.jump) {
        hen.jump.t += dt;
        const jt = hen.jump.t;
        const n = Math.floor(jt / 0.42);
        const f = (jt % 0.42) / 0.42;
        if (n < 3) {
          lift = Math.sin(Math.PI * f) * LW * 0.26;
          wing = Math.abs(Math.sin(f * Math.PI * 3));
        } else hen.jump = null;
      }
      /* idle: breathing and the odd blink */
      if (!hen.hop && !hen.flat && !hen.jump) {
        sy *= 1 + Math.sin(t * 2.6) * 0.012;
        if (t > hen.nextBlink) {
          hen.blink = 0.14;
          hen.nextBlink = t + 2 + Math.random() * 3;
        }
      }
      hen.blink = Math.max(0, hen.blink - dt);

      /* the shadow on the ground shrinks as she rises */
      const sh = 1 - clamp(lift / (LW * 0.6), 0, 0.6);
      g.save();
      g.translate(x, y + 1);
      g.scale(1, 0.32);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, 24 * s * sh);
      gr.addColorStop(0, "rgba(0,0,0,.55)");
      gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr;
      g.beginPath();
      g.arc(0, 0, 24 * s * sh, 0, TAU);
      g.fill();
      g.restore();

      g.save();
      g.translate(x, y - lift);
      if (hen.flat) {
        /* knocked flat: squashed onto the road, spread wide */
        g.scale(s * 1.12, s * 0.42);
        drawHen(g, { flat: 1, wing: 0.6 });
      } else {
        g.scale(s * sx, s * sy);
        drawHen(g, { wing, blink: hen.blink > 0, look: hen.hop ? 1 : 0 });
      }
      g.restore();
    }

    function drawParticles(dt) {
      particles.forEach((p) => {
        p.life += dt;
        if (p.kind === "feather") {
          if (p.y < p.ground) {
            p.vy += 420 * dt * (LW / 110);
            p.vx *= 1 - 2.2 * dt;
            p.vy *= 1 - 2.6 * dt;   /* air drag: feathers float */
            p.x += (p.vx + Math.sin(p.life * 7 + p.rot) * 30) * dt;
            p.y += p.vy * dt;
            p.rot += p.vr * dt;
          } else if (!p.settled) {
            p.settled = true;
            decals.push({ kind: "feather", x: p.x, y: p.ground, rot: p.rot, len: p.len });
          }
          if (p.settled) return;
          g.save();
          g.translate(p.x, p.y);
          g.rotate(p.rot);
          g.globalAlpha = 0.95;
          drawFeather(g, p.len);
          g.restore();
        } else if (p.kind === "dust") {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          const k = p.life / p.max;
          const r = p.r * (1 + k * 1.6);
          const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          gr.addColorStop(0, "rgba(200,205,215," + (0.32 * (1 - k)).toFixed(3) + ")");
          gr.addColorStop(1, "rgba(200,205,215,0)");
          g.fillStyle = gr;
          g.fillRect(p.x - r, p.y - r, r * 2, r * 2);
        }
      });
      particles = particles.filter((p) => (p.kind === "feather" ? !p.settled : p.life < p.max));
    }

    function drawDecals() {
      decals.forEach((d) => {
        if (d.kind === "skid") {
          const gr = g.createLinearGradient(0, d.y0, 0, d.y1);
          gr.addColorStop(0, "rgba(0,0,0,0)");
          gr.addColorStop(0.5, "rgba(0,0,0,.4)");
          gr.addColorStop(1, "rgba(0,0,0,.12)");
          g.fillStyle = gr;
          [-1, 1].forEach((s2) => g.fillRect(d.x + s2 * d.w * 0.27 - 3, d.y0, 6, d.y1 - d.y0));
        } else {
          g.save();
          g.translate(d.x, d.y);
          g.rotate(d.rot);
          g.globalAlpha = 0.85;
          drawFeather(g, d.len);
          g.restore();
        }
      });
    }

    function badgeStyle(i) {
      const st = lanes[i].state;
      if (st === "lost") return ["#b91c1c", "#ef4444", "#fff", "rgba(239,68,68,.8)"];
      if (st === "win") return ["#15803d", "#22c55e", "#fff", "rgba(34,197,94,.85)"];
      if (st === "current") return ["#1d4ed8", "#3b82f6", "#fff", "rgba(59,130,246,.85)"];
      if (st === "passed") return ["#1e3a8a", "#2563eb", "#dbeafe", null];
      if (st === "next") return ["#0f172a", "#0f172a", "#fff", null, "#60a5fa"];
      return ["#0f172a", "#111a2e", "#94a3b8", null, "rgba(148,163,184,.35)"];
    }

    function drawBadges() {
      const bw = Math.min(LW * 0.7, 84), bh = 24;
      g.font = "800 " + (LW < 100 ? 11.5 : 12.5) + "px " + FONT;
      g.textAlign = "center";
      g.textBaseline = "middle";
      lanes.forEach((L, i) => {
        const x = laneX(i);
        if (x < camX - LW || x > camX + W + LW) return;
        const [c0, c1, ink, glow, ring] = badgeStyle(i);
        g.save();
        if (glow) {
          g.shadowColor = glow;
          g.shadowBlur = 14 * px;
        }
        const gr = g.createLinearGradient(0, BADGE_Y - bh / 2, 0, BADGE_Y + bh / 2);
        gr.addColorStop(0, c1);
        gr.addColorStop(1, c0);
        g.fillStyle = gr;
        g.beginPath();
        g.roundRect(x - bw / 2, BADGE_Y - bh / 2, bw, bh, bh / 2);
        g.fill();
        g.restore();
        if (ring) {
          g.strokeStyle = ring;
          g.lineWidth = 1.2;
          g.stroke();
        }
        g.fillStyle = "rgba(255,255,255,.14)";
        g.fillRect(x - bw / 2 + bh / 2, BADGE_Y - bh / 2 + 1, bw - bh, 1);
        g.fillStyle = ink;
        g.fillText(labels[i], x, BADGE_Y + 0.5);
      });
    }

    function frame(ts) {
      const tNow = (ts - t0) / 1000;
      const dt = Math.min(0.05, tNow - now);
      now = tNow;
      if (!W) resize();
      if (!W || !tex) {
        requestAnimationFrame(frame);
        return;
      }

      if (pending && clear(lanes[pending.lane])) startHop();
      traffic(dt);
      camX = lerp(camX, camTarget, 1 - Math.pow(0.0025, dt));
      if (Math.abs(camX - camTarget) < 0.3) camX = camTarget;

      g.setTransform(px, 0, 0, px, 0, 0);
      g.fillStyle = "#0b1120";
      g.fillRect(0, 0, W, H);
      let ox = 0, oy = 0;
      if (shake > 0) {
        ox = (Math.random() - 0.5) * 10 * shake;
        oy = (Math.random() - 0.5) * 10 * shake;
        shake = Math.max(0, shake - dt * 2.5);
      }
      g.save();
      g.translate(-camX + ox, oy);
      drawGround();
      drawLamps();
      drawManholes(now);
      drawDecals();
      /* the bush and traffic light on the starting corner */
      const grassL = LW * 0.78;
      g.drawImage(tex.bush.canvas, grassL * 0.42 - tex.bush.size / 2, H * 0.84 - tex.bush.size / 2, tex.bush.size, tex.bush.size);
      g.drawImage(tex.bush2.canvas, grassL * 0.3 - tex.bush2.size / 2, H * 0.16 - tex.bush2.size / 2, tex.bush2.size, tex.bush2.size);
      const roadEnd = ROAD_X + mults.length * LW;
      g.drawImage(tex.bush.canvas, roadEnd + LW * 1.3 - tex.bush.size / 2, H * 0.3 - tex.bush.size / 2, tex.bush.size, tex.bush.size);
      lanes.forEach((L, i) => {
        if (laneX(i) < camX - LW || laneX(i) > camX + W + LW) {
          if (L.barred) L.barT = 1;
          return;
        }
        if (L.barred) drawBarricade(i, L, dt);
      });
      /* cars above the hen are drawn behind her, cars below in front */
      lanes.forEach((L, i) => L.cars.forEach((c) => { if (c.y < hen.y) drawCar(c, i); }));
      drawTrafficLight(g, ROAD_X - LW * 0.62 - 6 + LW * 0.14, GY - LW * 0.5, Math.min(H * 0.34, LW * 1.05), light, now);
      if (hen.visible) drawHenNow(dt, now);
      lanes.forEach((L, i) => L.cars.forEach((c) => { if (c.y >= hen.y) drawCar(c, i); }));
      drawParticles(dt);
      if (flash > 0) {
        const gr = g.createRadialGradient(hen.x, hen.y - 20, 0, hen.x, hen.y - 20, LW * 1.2);
        gr.addColorStop(0, "rgba(255,255,255," + (0.85 * flash).toFixed(3) + ")");
        gr.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = gr;
        g.fillRect(hen.x - LW * 1.2, hen.y - 20 - LW * 1.2, LW * 2.4, LW * 2.4);
        flash = Math.max(0, flash - dt * 3.5);
      }
      drawBadges();
      g.restore();

      /* night: a cool vignette, darker at the top and bottom edges */
      const vg = g.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.35, W * 0.5, H * 0.5, Math.max(W, H) * 0.8);
      vg.addColorStop(0, "rgba(5,10,25,0)");
      vg.addColorStop(1, "rgba(5,10,25,.55)");
      g.fillStyle = vg;
      g.fillRect(0, 0, W, H);

      requestAnimationFrame(frame);
    }

    new ResizeObserver(resize).observe(canvas);
    requestAnimationFrame(frame);

    return {
      setLanes,
      reset,
      hop,
      place,
      barricade,
      strike,
      cheer,
      setTraffic: (r) => (trafficRate = r),
      setLight: (s) => (light = s),
      setBadges: (fn) => lanes.forEach((L, i) => (L.state = fn(i))),
      busy: () => !!(pending || hen.hop),
      /* which lane is under a point on the canvas (−1 for the sidewalk, null for none) */
      laneAt(clientX) {
        const r = canvas.getBoundingClientRect();
        const wx = clientX - r.left + camX;
        if (wx < ROAD_X) return -1;
        const i = Math.floor((wx - ROAD_X) / LW);
        return i < lanes.length ? i : null;
      },
      /* the on-screen x of a lane's centre, and the space under the hen's feet, for the win pop-up */
      laneScreen(i) {
        return { x: laneX(i) - camTarget, y: GY + LW * 0.16, w: LW };
      }
    };
  }

  global.VBCrossingArt = { create };
})(window);
