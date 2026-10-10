/* Rendo Olympus — the artwork, drawn once on canvases at the screen's resolution and handed to the page as images:
   faceted gemstones, the gold crown, hourglass, ring and chalice, the Zeus scatter medallion, glass multiplier orbs,
   the sunset sky over the mountain, the fluted gold pillars, and Zeus himself (a marble statue wreathed in cloud).
   API: VBOlympusArt.symbols(size) → { crown, …, blue, scatter } (data URLs), .orb(value, size), .pillar(w, h),
        .sky(canvas), .zeus(canvas) → { strike() } */
(function (global) {
  "use strict";

  const TAU = Math.PI * 2;
  const DPR = Math.min(2, global.devicePixelRatio || 1);

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

  function surface(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.round(w * DPR);
    c.height = Math.round(h * DPR);
    const g = c.getContext("2d");
    g.scale(DPR, DPR);
    return { c, g };
  }

  /* colour helpers */
  function hex(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function shade(h, k) {   /* k < 0 darkens toward black, k > 0 lightens toward white */
    const [r, g, b] = hex(h);
    const f = (v) => Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k);
    return "rgb(" + f(r) + "," + f(g) + "," + f(b) + ")";
  }

  /* polished gold: bright and dark bands like a reflective metal surface */
  function gold(g, x0, y0, x1, y1) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, "#fff6c9");
    gr.addColorStop(0.18, "#f7cf55");
    gr.addColorStop(0.36, "#a86f12");
    gr.addColorStop(0.5, "#ffe28a");
    gr.addColorStop(0.66, "#c88d1c");
    gr.addColorStop(0.84, "#6e4306");
    gr.addColorStop(1, "#e2a93a");
    return gr;
  }

  function sparkle(g, x, y, r, a) {
    g.save();
    g.globalCompositeOperation = "lighter";
    g.globalAlpha = a == null ? 1 : a;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.25, "rgba(255,255,255,.5)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
    g.fillStyle = "rgba(255,255,255,.9)";
    g.beginPath();
    g.moveTo(x - r * 1.4, y);
    g.quadraticCurveTo(x, y - r * 0.08, x + r * 1.4, y);
    g.quadraticCurveTo(x, y + r * 0.08, x - r * 1.4, y);
    g.moveTo(x, y - r * 1.4);
    g.quadraticCurveTo(x + r * 0.08, y, x, y + r * 1.4);
    g.quadraticCurveTo(x - r * 0.08, y, x, y - r * 1.4);
    g.fill();
    g.restore();
  }

  /* ---------------- gemstones ---------------- */
  /* a cut stone: the outline (girdle), a smaller table on top, and the facets between them, each lit by how it
     faces the light (top left). Also inner fire (refraction), the dark rim, a glint. pts: outline, centred, unit size */
  function gem(g, cx, cy, R, pts, color, opts) {
    const o = opts || {};
    const P = pts.map(([x, y]) => [cx + x * R, cy + y * R]);
    const T = pts.map(([x, y]) => [cx + x * R * (o.table || 0.52) + (o.tx || 0) * R, cy + y * R * (o.table || 0.52) + (o.ty || -0.05) * R]);
    /* the shadow it casts */
    g.save();
    g.shadowColor = "rgba(0,0,0,.6)";
    g.shadowBlur = R * 0.25;
    g.shadowOffsetY = R * 0.08;
    g.beginPath();
    P.forEach(([x, y], i) => g[i ? "lineTo" : "moveTo"](x, y));
    g.closePath();
    g.fillStyle = shade(color, -0.6);
    g.fill();
    g.restore();
    const light = -Math.PI * 0.75;   /* from the top left */
    const n = P.length;
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n], ta = T[i], tb = T[(i + 1) % n];
      const mx = (a[0] + b[0]) / 2 - cx, my = (a[1] + b[1]) / 2 - cy;
      const ang = Math.atan2(my, mx);
      const lit = Math.cos(ang - light);   /* −1 … 1 */
      /* two triangles per facet band, a little apart in tone, like a brilliant's star and girdle facets */
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      [[a, mid, ta, 0.05], [mid, b, tb, -0.05], [ta, mid, tb, 0.18]].forEach(([p1, p2, p3, d]) => {
        const k = lit * 0.55 + d;
        const gr = g.createLinearGradient(p1[0], p1[1], p3[0], p3[1]);
        gr.addColorStop(0, shade(color, k > 0 ? Math.min(0.85, k) : Math.max(-0.75, k)));
        gr.addColorStop(1, shade(color, k > 0 ? Math.min(0.85, k * 0.5) : Math.max(-0.75, k - 0.15)));
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(p1[0], p1[1]);
        g.lineTo(p2[0], p2[1]);
        g.lineTo(p3[0], p3[1]);
        g.closePath();
        g.fill();
        g.strokeStyle = "rgba(255,255,255,.12)";
        g.lineWidth = 0.6;
        g.stroke();
      });
    }
    /* the table, with the light refracted through the stone below it */
    g.beginPath();
    T.forEach(([x, y], i) => g[i ? "lineTo" : "moveTo"](x, y));
    g.closePath();
    let gr = g.createLinearGradient(cx - R * 0.5, cy - R * 0.5, cx + R * 0.5, cy + R * 0.5);
    gr.addColorStop(0, shade(color, 0.45));
    gr.addColorStop(0.45, shade(color, 0.05));
    gr.addColorStop(0.7, shade(color, -0.35));
    gr.addColorStop(1, shade(color, 0.2));
    g.fillStyle = gr;
    g.fill();
    g.save();
    g.clip();
    /* inner fire: a soft glow under the table, brighter toward the light */
    g.globalCompositeOperation = "lighter";
    const fire = g.createRadialGradient(cx - R * 0.15, cy - R * 0.2, 0, cx, cy, R * 0.6);
    fire.addColorStop(0, "rgba(255,255,255,.22)");
    fire.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = fire;
    g.fillRect(cx - R, cy - R, R * 2, R * 2);
    g.restore();
    g.strokeStyle = "rgba(255,255,255,.5)";
    g.lineWidth = 0.9;
    g.stroke();
    /* the girdle edge */
    g.beginPath();
    P.forEach(([x, y], i) => g[i ? "lineTo" : "moveTo"](x, y));
    g.closePath();
    g.strokeStyle = shade(color, -0.7);
    g.lineWidth = Math.max(1, R * 0.03);
    g.stroke();
    sparkle(g, T[0][0] + (T[1][0] - T[0][0]) * 0.3, T[0][1] + (T[1][1] - T[0][1]) * 0.3, R * 0.2, 0.95);
  }

  const poly = (n, rot, sx, sy) => Array.from({ length: n }, (_, i) => {
    const a = rot + (i * TAU) / n;
    return [Math.cos(a) * (sx || 1), Math.sin(a) * (sy || 1)];
  });
  /* outlines, unit size, centred */
  const CUTS = {
    blue: poly(12, -Math.PI / 2, 0.9, 0.9),                                                  /* round brilliant */
    green: [[-0.5, -0.82], [0.5, -0.82], [0.78, -0.5], [0.78, 0.5], [0.5, 0.82], [-0.5, 0.82], [-0.78, 0.5], [-0.78, -0.5]],   /* emerald cut */
    yellow: [[-0.62, -0.86], [0.62, -0.86], [0.86, -0.62], [0.86, 0.62], [0.62, 0.86], [-0.62, 0.86], [-0.86, 0.62], [-0.86, -0.62]], /* cushion */
    purple: [[0, -0.92], [0.42, -0.62], [0.7, -0.1], [0.62, 0.45], [0.3, 0.8], [-0.3, 0.8], [-0.62, 0.45], [-0.7, -0.1], [-0.42, -0.62]], /* pear */
    red: (() => {   /* heart */
      const out = [];
      for (let i = 0; i < 16; i++) {
        const t = (i / 16) * TAU;
        const x = 16 * Math.pow(Math.sin(t), 3);
        const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        out.push([x / 17.5, y / 17.5 + 0.06]);
      }
      return out;
    })()
  };
  const GEM_COLORS = { blue: "#1e6bff", green: "#12b04a", yellow: "#f2b80c", purple: "#9b2cf0", red: "#e3122e" };

  /* ---------------- the gold pieces ---------------- */
  function crown(g, S) {
    const cx = S / 2, base = S * 0.78, w = S * 0.76;
    g.save();
    g.shadowColor = "rgba(0,0,0,.6)";
    g.shadowBlur = S * 0.06;
    g.shadowOffsetY = S * 0.03;
    /* the five points */
    g.beginPath();
    g.moveTo(cx - w / 2, base);
    g.lineTo(cx - w / 2 - S * 0.03, S * 0.36);
    g.lineTo(cx - w * 0.27, S * 0.55);
    g.lineTo(cx - w * 0.18, S * 0.24);
    g.lineTo(cx - w * 0.06, S * 0.5);
    g.lineTo(cx, S * 0.16);
    g.lineTo(cx + w * 0.06, S * 0.5);
    g.lineTo(cx + w * 0.18, S * 0.24);
    g.lineTo(cx + w * 0.27, S * 0.55);
    g.lineTo(cx + w / 2 + S * 0.03, S * 0.36);
    g.lineTo(cx + w / 2, base);
    g.closePath();
    g.fillStyle = gold(g, cx - w / 2, S * 0.15, cx + w / 2, base);
    g.fill();
    g.restore();
    g.strokeStyle = "#5a3605";
    g.lineWidth = S * 0.012;
    g.stroke();
    /* red velvet cap showing between the points */
    g.save();
    g.clip();
    const cap = g.createRadialGradient(cx - S * 0.1, S * 0.45, 0, cx, S * 0.55, S * 0.4);
    cap.addColorStop(0, "rgba(220,30,50,.0)");
    cap.addColorStop(1, "rgba(80,0,10,.0)");
    g.fillStyle = cap;
    g.fillRect(0, 0, S, S);
    /* inner edge of each point, darker */
    g.fillStyle = "rgba(90,50,0,.28)";
    g.fillRect(cx - w / 2, S * 0.58, w, S * 0.03);
    g.restore();
    /* pearls on the tips */
    [[cx - w / 2 - S * 0.03, S * 0.36], [cx - w * 0.18, S * 0.24], [cx, S * 0.16], [cx + w * 0.18, S * 0.24], [cx + w / 2 + S * 0.03, S * 0.36]].forEach(([x, y]) => {
      const r = S * 0.045;
      const gr = g.createRadialGradient(x - r * 0.4, y - r * 0.4, 0, x, y, r);
      gr.addColorStop(0, "#ffffff");
      gr.addColorStop(0.6, "#e9e2d6");
      gr.addColorStop(1, "#8d8478");
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    });
    /* the band, with jewels */
    const by = S * 0.6, bh = S * 0.2;
    g.beginPath();
    g.roundRect(cx - w / 2 - S * 0.01, by, w + S * 0.02, bh, S * 0.03);
    g.fillStyle = gold(g, cx, by, cx, by + bh);
    g.fill();
    g.strokeStyle = "#5a3605";
    g.stroke();
    g.fillStyle = "rgba(255,255,255,.45)";
    g.fillRect(cx - w / 2 + S * 0.02, by + S * 0.015, w - S * 0.04, S * 0.012);
    gem(g, cx, by + bh / 2, S * 0.075, CUTS.blue, "#e3122e", { table: 0.5 });
    gem(g, cx - w * 0.3, by + bh / 2, S * 0.055, CUTS.blue, "#1e6bff", { table: 0.5 });
    gem(g, cx + w * 0.3, by + bh / 2, S * 0.055, CUTS.blue, "#12b04a", { table: 0.5 });
    sparkle(g, cx - w * 0.2, S * 0.3, S * 0.07, 0.8);
  }

  function hourglass(g, S) {
    const cx = S / 2, top = S * 0.12, bot = S * 0.88, w = S * 0.6;
    g.save();
    g.shadowColor = "rgba(0,0,0,.6)";
    g.shadowBlur = S * 0.06;
    g.shadowOffsetY = S * 0.03;
    /* the glass bulbs */
    const glass = () => {
      g.beginPath();
      g.moveTo(cx - w * 0.36, top + S * 0.08);
      g.bezierCurveTo(cx - w * 0.42, S * 0.4, cx - w * 0.04, S * 0.44, cx - w * 0.04, S * 0.5);
      g.bezierCurveTo(cx - w * 0.04, S * 0.56, cx - w * 0.42, S * 0.6, cx - w * 0.36, bot - S * 0.08);
      g.lineTo(cx + w * 0.36, bot - S * 0.08);
      g.bezierCurveTo(cx + w * 0.42, S * 0.6, cx + w * 0.04, S * 0.56, cx + w * 0.04, S * 0.5);
      g.bezierCurveTo(cx + w * 0.04, S * 0.44, cx + w * 0.42, S * 0.4, cx + w * 0.36, top + S * 0.08);
      g.closePath();
    };
    glass();
    g.fillStyle = "rgba(170,210,255,.22)";
    g.fill();
    g.restore();
    g.save();
    glass();
    g.clip();
    /* sand: a pile in the bottom, a little left on top, a thin stream between */
    const sand = g.createLinearGradient(0, S * 0.5, 0, bot);
    sand.addColorStop(0, "#ffd27a");
    sand.addColorStop(1, "#c46d14");
    g.fillStyle = sand;
    g.beginPath();
    g.moveTo(cx - w * 0.4, bot);
    g.quadraticCurveTo(cx, S * 0.56, cx + w * 0.4, bot);
    g.fill();
    g.beginPath();
    g.moveTo(cx - w * 0.2, S * 0.33);
    g.quadraticCurveTo(cx, S * 0.37, cx + w * 0.2, S * 0.33);
    g.lineTo(cx + w * 0.04, S * 0.48);
    g.lineTo(cx - w * 0.04, S * 0.48);
    g.closePath();
    g.fill();
    g.fillRect(cx - S * 0.006, S * 0.48, S * 0.012, S * 0.3);
    /* the glass: reflections down the left of each bulb */
    g.fillStyle = "rgba(255,255,255,.35)";
    g.beginPath();
    g.ellipse(cx - w * 0.2, S * 0.28, S * 0.025, S * 0.1, 0.25, 0, TAU);
    g.ellipse(cx - w * 0.22, S * 0.72, S * 0.025, S * 0.08, -0.25, 0, TAU);
    g.fill();
    g.restore();
    glass();
    g.strokeStyle = "rgba(220,240,255,.6)";
    g.lineWidth = S * 0.01;
    g.stroke();
    /* the gold frame: two discs and three turned posts */
    [[top, 1], [bot, -1]].forEach(([y, d]) => {
      g.beginPath();
      g.roundRect(cx - w / 2, d > 0 ? y : y - S * 0.09, w, S * 0.09, S * 0.03);
      g.fillStyle = gold(g, cx - w / 2, y - S * 0.05, cx + w / 2, y + S * 0.05);
      g.fill();
      g.strokeStyle = "#5a3605";
      g.lineWidth = S * 0.01;
      g.stroke();
    });
    [-0.44, 0.44].forEach((k) => {
      g.beginPath();
      g.roundRect(cx + k * w - S * 0.025, top + S * 0.06, S * 0.05, bot - top - S * 0.12, S * 0.02);
      g.fillStyle = gold(g, cx + k * w - S * 0.03, 0, cx + k * w + S * 0.03, 0);
      g.fill();
      g.strokeStyle = "#5a3605";
      g.stroke();
    });
    sparkle(g, cx - w * 0.3, top + S * 0.04, S * 0.06, 0.8);
  }

  function ring(g, S) {
    const cx = S / 2, cy = S * 0.6, rx = S * 0.32, ry = S * 0.2, t = S * 0.07;
    g.save();
    g.shadowColor = "rgba(0,0,0,.6)";
    g.shadowBlur = S * 0.06;
    g.shadowOffsetY = S * 0.03;
    /* the band: a torus seen at an angle — the outer ellipse minus the inner, lit as a rounded bar */
    g.beginPath();
    g.ellipse(cx, cy, rx + t / 2, ry + t / 2, 0, 0, TAU);
    g.ellipse(cx, cy + t * 0.25, rx - t / 2, ry - t / 2, 0, 0, TAU, true);
    g.fillStyle = gold(g, cx - rx, cy - ry, cx + rx, cy + ry);
    g.fill("evenodd");
    g.restore();
    g.strokeStyle = "rgba(80,45,0,.6)";
    g.lineWidth = S * 0.01;
    g.beginPath();
    g.ellipse(cx, cy, rx + t / 2, ry + t / 2, 0, 0, TAU);
    g.stroke();
    g.beginPath();
    g.ellipse(cx, cy + t * 0.25, rx - t / 2, ry - t / 2, 0, 0, TAU);
    g.stroke();
    /* highlight running round the near side */
    g.strokeStyle = "rgba(255,250,220,.75)";
    g.lineWidth = S * 0.012;
    g.beginPath();
    g.ellipse(cx, cy + t * 0.12, rx, ry, 0, Math.PI * 0.15, Math.PI * 0.85);
    g.stroke();
    /* the setting: four prongs holding an emerald */
    const sy = cy - ry - S * 0.07;
    g.beginPath();
    g.moveTo(cx - S * 0.13, cy - ry + S * 0.02);
    g.lineTo(cx - S * 0.17, sy);
    g.lineTo(cx + S * 0.17, sy);
    g.lineTo(cx + S * 0.13, cy - ry + S * 0.02);
    g.closePath();
    g.fillStyle = gold(g, cx - S * 0.17, sy, cx + S * 0.17, cy - ry);
    g.fill();
    g.strokeStyle = "#5a3605";
    g.stroke();
    gem(g, cx, sy - S * 0.07, S * 0.19, CUTS.green, "#0fb45a", { table: 0.5 });
    sparkle(g, cx + rx * 0.7, cy + ry * 0.2, S * 0.05, 0.7);
  }

  function chalice(g, S) {
    const cx = S / 2;
    g.save();
    g.shadowColor = "rgba(0,0,0,.6)";
    g.shadowBlur = S * 0.06;
    g.shadowOffsetY = S * 0.03;
    g.beginPath();
    /* cup */
    g.moveTo(cx - S * 0.3, S * 0.14);
    g.lineTo(cx + S * 0.3, S * 0.14);
    g.bezierCurveTo(cx + S * 0.3, S * 0.4, cx + S * 0.16, S * 0.5, cx + S * 0.05, S * 0.52);
    /* stem with a knop */
    g.lineTo(cx + S * 0.04, S * 0.6);
    g.bezierCurveTo(cx + S * 0.1, S * 0.62, cx + S * 0.1, S * 0.68, cx + S * 0.04, S * 0.7);
    g.lineTo(cx + S * 0.05, S * 0.77);
    /* foot */
    g.bezierCurveTo(cx + S * 0.12, S * 0.8, cx + S * 0.24, S * 0.82, cx + S * 0.25, S * 0.88);
    g.lineTo(cx - S * 0.25, S * 0.88);
    g.bezierCurveTo(cx - S * 0.24, S * 0.82, cx - S * 0.12, S * 0.8, cx - S * 0.05, S * 0.77);
    g.lineTo(cx - S * 0.04, S * 0.7);
    g.bezierCurveTo(cx - S * 0.1, S * 0.68, cx - S * 0.1, S * 0.62, cx - S * 0.04, S * 0.6);
    g.lineTo(cx - S * 0.05, S * 0.52);
    g.bezierCurveTo(cx - S * 0.16, S * 0.5, cx - S * 0.3, S * 0.4, cx - S * 0.3, S * 0.14);
    g.closePath();
    g.fillStyle = gold(g, cx - S * 0.3, S * 0.1, cx + S * 0.3, S * 0.9);
    g.fill();
    g.restore();
    g.strokeStyle = "#5a3605";
    g.lineWidth = S * 0.012;
    g.stroke();
    /* the rim, an ellipse showing the dark wine inside */
    g.beginPath();
    g.ellipse(cx, S * 0.14, S * 0.3, S * 0.055, 0, 0, TAU);
    g.fillStyle = gold(g, cx - S * 0.3, S * 0.1, cx + S * 0.3, S * 0.18);
    g.fill();
    g.stroke();
    g.beginPath();
    g.ellipse(cx, S * 0.145, S * 0.26, S * 0.04, 0, 0, TAU);
    const wine = g.createRadialGradient(cx - S * 0.05, S * 0.14, 0, cx, S * 0.145, S * 0.26);
    wine.addColorStop(0, "#9b1030");
    wine.addColorStop(1, "#2a020a");
    g.fillStyle = wine;
    g.fill();
    /* the vertical sheen down the cup, and a band of gems */
    g.fillStyle = "rgba(255,255,240,.5)";
    g.beginPath();
    g.ellipse(cx - S * 0.13, S * 0.3, S * 0.025, S * 0.1, 0.25, 0, TAU);
    g.fill();
    gem(g, cx, S * 0.3, S * 0.07, CUTS.blue, "#e3122e", { table: 0.5 });
    gem(g, cx - S * 0.15, S * 0.27, S * 0.045, CUTS.blue, "#1e6bff", { table: 0.5 });
    gem(g, cx + S * 0.15, S * 0.27, S * 0.045, CUTS.blue, "#1e6bff", { table: 0.5 });
    sparkle(g, cx + S * 0.2, S * 0.17, S * 0.06, 0.8);
  }

  /* the scatter: a heavy gold medallion, the thunderbolt struck in relief and glowing, "ZEUS" on a ribbon */
  function scatter(g, S) {
    const cx = S / 2, cy = S * 0.47, R = S * 0.42;
    g.save();
    g.shadowColor = "rgba(80,160,255,.85)";
    g.shadowBlur = S * 0.12;
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.fillStyle = gold(g, cx - R, cy - R, cx + R, cy + R);
    g.fill();
    g.restore();
    /* the rim: beaded edge */
    for (let i = 0; i < 36; i++) {
      const a = (i * TAU) / 36;
      const x = cx + Math.cos(a) * R * 0.9, y = cy + Math.sin(a) * R * 0.9;
      const gr = g.createRadialGradient(x - 1, y - 1, 0, x, y, R * 0.05);
      gr.addColorStop(0, "#fff6c9");
      gr.addColorStop(1, "#7a4b07");
      g.fillStyle = gr;
      g.beginPath();
      g.arc(x, y, R * 0.045, 0, TAU);
      g.fill();
    }
    /* the field: deep blue enamel with a starry sky */
    g.beginPath();
    g.arc(cx, cy, R * 0.8, 0, TAU);
    const field = g.createRadialGradient(cx - R * 0.2, cy - R * 0.3, 0, cx, cy, R * 0.8);
    field.addColorStop(0, "#3d6fd6");
    field.addColorStop(0.6, "#122a73");
    field.addColorStop(1, "#060c2a");
    g.fillStyle = field;
    g.fill();
    g.strokeStyle = "#5a3605";
    g.lineWidth = S * 0.015;
    g.stroke();
    const r = rng(4);
    for (let i = 0; i < 26; i++) {
      const a = r() * TAU, d = Math.sqrt(r()) * R * 0.75;
      g.fillStyle = "rgba(255,255,255," + (0.3 + r() * 0.6).toFixed(2) + ")";
      g.beginPath();
      g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0.6 + r() * 1.1, 0, TAU);
      g.fill();
    }
    /* the thunderbolt */
    const bolt = () => {
      g.beginPath();
      g.moveTo(cx + R * 0.12, cy - R * 0.62);
      g.lineTo(cx - R * 0.3, cy + R * 0.06);
      g.lineTo(cx - R * 0.02, cy + R * 0.06);
      g.lineTo(cx - R * 0.16, cy + R * 0.62);
      g.lineTo(cx + R * 0.32, cy - R * 0.12);
      g.lineTo(cx + R * 0.04, cy - R * 0.12);
      g.closePath();
    };
    g.save();
    g.shadowColor = "rgba(120,200,255,1)";
    g.shadowBlur = S * 0.08;
    bolt();
    g.fillStyle = gold(g, cx - R * 0.3, cy - R * 0.6, cx + R * 0.3, cy + R * 0.6);
    g.fill();
    g.restore();
    bolt();
    g.strokeStyle = "#fff8d0";
    g.lineWidth = S * 0.01;
    g.stroke();
    /* the ribbon */
    const ry = S * 0.82;
    g.beginPath();
    g.moveTo(cx - S * 0.36, ry - S * 0.06);
    g.lineTo(cx + S * 0.36, ry - S * 0.06);
    g.lineTo(cx + S * 0.31, ry);
    g.lineTo(cx + S * 0.36, ry + S * 0.06);
    g.lineTo(cx - S * 0.36, ry + S * 0.06);
    g.lineTo(cx - S * 0.31, ry);
    g.closePath();
    const rb = g.createLinearGradient(0, ry - S * 0.06, 0, ry + S * 0.06);
    rb.addColorStop(0, "#ff4a5c");
    rb.addColorStop(0.5, "#b00a22");
    rb.addColorStop(1, "#5c0010");
    g.fillStyle = rb;
    g.fill();
    g.strokeStyle = "#f7cf55";
    g.lineWidth = S * 0.012;
    g.stroke();
    g.font = "900 " + S * 0.1 + "px Georgia, 'Times New Roman', serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = gold(g, 0, ry - S * 0.05, 0, ry + S * 0.05);
    g.strokeStyle = "rgba(60,0,0,.8)";
    g.lineWidth = S * 0.012;
    g.strokeText("ZEUS", cx, ry + S * 0.005);
    g.fillText("ZEUS", cx, ry + S * 0.005);
    sparkle(g, cx - R * 0.55, cy - R * 0.55, S * 0.07, 0.9);
  }

  /* ---------------- public: the symbol sheet ---------------- */
  const cache = {};
  function symbols(size) {
    const key = "s" + size;
    if (cache[key]) return cache[key];
    const out = {};
    const draw = {
      crown, hourglass, ring, chalice, scatter,
      red: (g, S) => gem(g, S / 2, S / 2, S * 0.4, CUTS.red, GEM_COLORS.red, { table: 0.5, ty: -0.08 }),
      purple: (g, S) => gem(g, S / 2, S / 2, S * 0.42, CUTS.purple, GEM_COLORS.purple, { table: 0.5, ty: 0.02 }),
      yellow: (g, S) => gem(g, S / 2, S / 2, S * 0.4, CUTS.yellow, GEM_COLORS.yellow, { table: 0.56 }),
      green: (g, S) => gem(g, S / 2, S / 2, S * 0.42, CUTS.green, GEM_COLORS.green, { table: 0.56 }),
      blue: (g, S) => gem(g, S / 2, S / 2, S * 0.44, CUTS.blue, GEM_COLORS.blue, { table: 0.5 })
    };
    Object.keys(draw).forEach((k) => {
      const { c, g } = surface(size, size);
      draw[k](g, size);
      out[k] = c.toDataURL();
    });
    return (cache[key] = out);
  }

  /* a multiplier orb: a glass sphere, its colour by value, the number floating inside */
  function orb(value, size) {
    const key = "o" + value + "_" + size;
    if (cache[key]) return cache[key];
    const S = size;
    const { c, g } = surface(S, S);
    const col = value >= 500 ? "#ffb300" : value >= 100 ? "#ff2d55" : value >= 20 ? "#a33cff" : value >= 6 ? "#1e8bff" : "#18c45a";
    const cx = S / 2, cy = S / 2, R = S * 0.42;
    g.save();
    g.shadowColor = col;
    g.shadowBlur = S * 0.18;
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    const body = g.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R);
    body.addColorStop(0, shade(col, 0.75));
    body.addColorStop(0.35, shade(col, 0.15));
    body.addColorStop(0.8, shade(col, -0.45));
    body.addColorStop(1, shade(col, -0.75));
    g.fillStyle = body;
    g.fill();
    g.restore();
    /* inner swirl of energy */
    g.save();
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.clip();
    g.globalCompositeOperation = "lighter";
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.ellipse(cx, cy + R * 0.1, R * (0.9 - k * 0.2), R * (0.3 - k * 0.05), 0.4 + k * 0.7, 0, TAU);
      g.strokeStyle = "rgba(255,255,255," + (0.18 - k * 0.04) + ")";
      g.lineWidth = S * 0.02;
      g.stroke();
    }
    /* the rim light at the bottom, as through glass */
    const rim = g.createRadialGradient(cx, cy + R * 0.9, 0, cx, cy + R * 0.9, R * 0.8);
    rim.addColorStop(0, "rgba(255,255,255,.35)");
    rim.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = rim;
    g.fillRect(0, 0, S, S);
    g.restore();
    /* the gold ring around it */
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.strokeStyle = gold(g, cx - R, cy - R, cx + R, cy + R);
    g.lineWidth = S * 0.045;
    g.stroke();
    /* window highlight */
    g.fillStyle = "rgba(255,255,255,.55)";
    g.beginPath();
    g.ellipse(cx - R * 0.32, cy - R * 0.5, R * 0.32, R * 0.15, -0.6, 0, TAU);
    g.fill();
    /* the number */
    const txt = value + "x";
    g.font = "900 " + S * (txt.length > 4 ? 0.24 : txt.length > 3 ? 0.29 : 0.34) + "px Georgia, 'Times New Roman', serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineJoin = "round";
    g.strokeStyle = "rgba(40,10,0,.9)";
    g.lineWidth = S * 0.05;
    g.strokeText(txt, cx, cy + S * 0.02);
    g.fillStyle = gold(g, 0, cy - S * 0.15, 0, cy + S * 0.15);
    g.fillText(txt, cx, cy + S * 0.02);
    return (cache[key] = c.toDataURL());
  }

  /* a fluted gold column with a capital and base, as a tall image */
  function pillar(w, h) {
    const { c, g } = surface(w, h);
    const capH = w * 0.55, baseH = w * 0.5;
    /* the shaft: fluting = repeated vertical light/dark bands */
    const sx = w * 0.12, sw = w * 0.76;
    const gr = g.createLinearGradient(sx, 0, sx + sw, 0);
    const flutes = 6;
    for (let i = 0; i <= flutes; i++) {
      const t = i / flutes;
      gr.addColorStop(Math.min(1, t), i % 2 ? "#7a4a08" : "#ffe08a");
      if (i < flutes) gr.addColorStop(Math.min(1, t + 0.5 / flutes), "#c8901f");
    }
    g.fillStyle = gr;
    g.fillRect(sx, capH, sw, h - capH - baseH);
    /* the column is round: darken the sides */
    const round = g.createLinearGradient(sx, 0, sx + sw, 0);
    round.addColorStop(0, "rgba(40,20,0,.6)");
    round.addColorStop(0.3, "rgba(0,0,0,0)");
    round.addColorStop(0.7, "rgba(0,0,0,0)");
    round.addColorStop(1, "rgba(40,20,0,.7)");
    g.fillStyle = round;
    g.fillRect(sx, capH, sw, h - capH - baseH);
    /* capital (Ionic scrolls) and base mouldings */
    const block = (y, hh, inset) => {
      g.beginPath();
      g.roundRect(inset, y, w - inset * 2, hh, hh * 0.3);
      g.fillStyle = gold(g, 0, y, w, y + hh);
      g.fill();
      g.strokeStyle = "#5a3605";
      g.lineWidth = 1;
      g.stroke();
    };
    block(0, capH * 0.28, 0);
    block(capH * 0.28, capH * 0.42, w * 0.04);
    [w * 0.2, w * 0.8].forEach((x) => {
      g.beginPath();
      g.arc(x, capH * 0.5, capH * 0.18, 0, TAU);
      g.fillStyle = gold(g, x - 8, capH * 0.35, x + 8, capH * 0.65);
      g.fill();
      g.strokeStyle = "#5a3605";
      g.stroke();
      g.beginPath();
      g.arc(x, capH * 0.5, capH * 0.08, 0, TAU);
      g.stroke();
    });
    block(capH * 0.7, capH * 0.3, w * 0.08);
    block(h - baseH, baseH * 0.35, w * 0.06);
    block(h - baseH * 0.65, baseH * 0.65, 0);
    return c.toDataURL();
  }

  /* ---------------- the sky: sunset over the mountain, drawn to fill a canvas ---------------- */
  function sky(canvas) {
    const paint = () => {
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (!W || !H) return;
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
      const g = canvas.getContext("2d");
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      let gr = g.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, "#1b0f3a");
      gr.addColorStop(0.35, "#5a2a6e");
      gr.addColorStop(0.6, "#d4603f");
      gr.addColorStop(0.78, "#f6a54a");
      gr.addColorStop(1, "#ffd98a");
      g.fillStyle = gr;
      g.fillRect(0, 0, W, H);
      /* the sun behind the clouds */
      const sx = W * 0.3, sy = H * 0.7;
      gr = g.createRadialGradient(sx, sy, 0, sx, sy, Math.max(W, H) * 0.6);
      gr.addColorStop(0, "rgba(255,245,200,.95)");
      gr.addColorStop(0.08, "rgba(255,210,120,.7)");
      gr.addColorStop(0.35, "rgba(255,140,60,.25)");
      gr.addColorStop(1, "rgba(255,120,60,0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, W, H);
      /* distant mountains, hazy */
      const r = rng(17);
      [[0.74, "rgba(110,50,90,.55)"], [0.82, "rgba(70,30,70,.7)"]].forEach(([base, col], k) => {
        g.beginPath();
        g.moveTo(0, H);
        let y = H * base;
        g.lineTo(0, y);
        for (let x = 0; x <= W; x += W / 18) {
          y = H * base - (Math.sin(x / W * 5 + k * 2) * 0.05 + r() * 0.05) * H;
          g.lineTo(x, y);
        }
        g.lineTo(W, H);
        g.closePath();
        g.fillStyle = col;
        g.fill();
      });
      /* clouds: soft puffs, lit warm from below, cool on top */
      const cloud = (cx, cy, w, n, seed) => {
        const rr = rng(seed);
        for (let i = 0; i < n; i++) {
          const x = cx + (rr() - 0.5) * w, y = cy + (rr() - 0.5) * w * 0.18, rad = w * (0.08 + rr() * 0.1);
          const c2 = g.createRadialGradient(x, y + rad * 0.4, 0, x, y, rad);
          c2.addColorStop(0, "rgba(255,200,150,.55)");
          c2.addColorStop(0.5, "rgba(230,140,140,.35)");
          c2.addColorStop(1, "rgba(120,70,130,0)");
          g.fillStyle = c2;
          g.beginPath();
          g.arc(x, y, rad, 0, TAU);
          g.fill();
        }
      };
      cloud(W * 0.2, H * 0.32, W * 0.7, 26, 3);
      cloud(W * 0.85, H * 0.5, W * 0.6, 22, 5);
      cloud(W * 0.5, H * 0.86, W * 1.2, 40, 9);
      /* a few early stars at the top */
      for (let i = 0; i < 60; i++) {
        g.fillStyle = "rgba(255,255,255," + (r() * 0.6).toFixed(2) + ")";
        g.fillRect(r() * W, r() * H * 0.3, 1, 1);
      }
    };
    paint();
    new ResizeObserver(paint).observe(canvas);
  }

  /* ---------------- Zeus: a marble statue in the clouds, eyes and hands alive with lightning ---------------- */
  function zeus(canvas) {
    const g = canvas.getContext("2d");
    let W = 0, H = 0, strikeT = -10, t0 = performance.now();
    const fit = () => {
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = Math.round(W * DPR);
      canvas.height = Math.round(H * DPR);
    };
    fit();
    new ResizeObserver(fit).observe(canvas);

    const marble = (x0, y0, x1, y1) => {
      const gr = g.createLinearGradient(x0, y0, x1, y1);
      gr.addColorStop(0, "#fbf7f0");
      gr.addColorStop(0.5, "#d9d2c6");
      gr.addColorStop(1, "#8f877c");
      return gr;
    };
    /* hair or beard carved in marble: one solid mass, then curls cut into it (a shadowed groove with a lit lip) */
    function curls(cx, cy, w, h, n, seed, shape) {
      const r = rng(seed);
      g.save();
      g.beginPath();
      shape();
      g.fillStyle = marble(cx - w / 2, cy, cx + w / 2, cy + h);
      g.fill();
      g.clip();
      /* soft occlusion toward the bottom and sides of the mass */
      const occ = g.createRadialGradient(cx - w * 0.15, cy + h * 0.25, h * 0.1, cx, cy + h * 0.5, Math.max(w, h) * 0.75);
      occ.addColorStop(0, "rgba(255,255,255,.12)");
      occ.addColorStop(1, "rgba(70,60,50,.45)");
      g.fillStyle = occ;
      g.fillRect(cx - w, cy - h * 0.2, w * 2, h * 1.5);
      g.lineCap = "round";
      for (let i = 0; i < n; i++) {
        const x = cx + (r() - 0.5) * w * 0.95, y = cy + r() * h;
        const rad = w * (0.045 + r() * 0.035);
        const a0 = r() * Math.PI * 2;
        g.beginPath();
        g.arc(x, y, rad, a0, a0 + Math.PI * 1.4);
        g.strokeStyle = "rgba(60,52,44,.5)";
        g.lineWidth = 1.5;
        g.stroke();
        g.beginPath();
        g.arc(x - 0.7, y - 0.9, rad, a0, a0 + Math.PI * 1.1);
        g.strokeStyle = "rgba(255,255,255,.55)";
        g.lineWidth = 0.8;
        g.stroke();
      }
      g.restore();
    }
    function bolt(x0, y0, x1, y1, seed, w) {
      const r = rng(seed);
      const pts = [[x0, y0]];
      const n = 7;
      for (let i = 1; i < n; i++) {
        const t = i / n;
        pts.push([x0 + (x1 - x0) * t + (r() - 0.5) * 22, y0 + (y1 - y0) * t + (r() - 0.5) * 8]);
      }
      pts.push([x1, y1]);
      g.save();
      g.globalCompositeOperation = "lighter";
      [[w * 4, "rgba(120,180,255,.25)"], [w * 1.6, "rgba(170,210,255,.7)"], [w * 0.6, "#ffffff"]].forEach(([lw, col]) => {
        g.beginPath();
        pts.forEach(([x, y], i) => g[i ? "lineTo" : "moveTo"](x, y));
        g.strokeStyle = col;
        g.lineWidth = lw;
        g.lineJoin = "round";
        g.stroke();
      });
      g.restore();
    }

    function frame(ts) {
      const t = (ts - t0) / 1000;
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.clearRect(0, 0, W, H);
      const s = Math.min(W / 200, H / 220);
      g.save();
      g.translate(W * 0.5, H * 0.08 + Math.sin(t * 1.1) * 3 * s);
      g.scale(s, s);
      /* aura */
      const struck = t - strikeT < 0.6;
      const aura = g.createRadialGradient(0, 70, 10, 0, 80, 120);
      aura.addColorStop(0, struck ? "rgba(190,220,255,.65)" : "rgba(255,220,160,.35)");
      aura.addColorStop(1, "rgba(255,200,150,0)");
      g.fillStyle = aura;
      g.beginPath();
      g.arc(0, 80, 120, 0, TAU);
      g.fill();
      /* shoulders and a draped himation over the left shoulder */
      g.beginPath();
      g.moveTo(-95, 200);
      g.bezierCurveTo(-92, 150, -70, 128, -30, 122);
      g.lineTo(30, 122);
      g.bezierCurveTo(70, 128, 92, 150, 95, 200);
      g.closePath();
      g.fillStyle = marble(-60, 120, 60, 200);
      g.fill();
      g.beginPath();
      g.moveTo(-90, 200);
      g.bezierCurveTo(-80, 150, -40, 128, 10, 150);
      g.bezierCurveTo(30, 170, 40, 190, 45, 200);
      g.closePath();
      g.fillStyle = marble(-80, 130, 40, 200);
      g.fill();
      g.strokeStyle = "rgba(90,80,70,.35)";
      g.lineWidth = 1.2;
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        g.moveTo(-78 + i * 14, 196);
        g.quadraticCurveTo(-60 + i * 12, 165, -20 + i * 8, 145 + i * 3);
        g.stroke();
      }
      /* neck */
      g.fillStyle = marble(-20, 90, 20, 130);
      g.fillRect(-18, 92, 36, 36);
      /* head */
      g.beginPath();
      g.ellipse(0, 60, 34, 42, 0, 0, TAU);
      g.fillStyle = marble(-30, 20, 30, 100);
      g.fill();
      /* hair: a cap of curls over the brow; beard: a full mass from the cheeks down to a rounded point */
      curls(0, 14, 80, 26, 34, 11, () => {
        g.moveTo(-38, 44);
        g.bezierCurveTo(-44, 10, -20, 8, 0, 10);
        g.bezierCurveTo(20, 8, 44, 10, 38, 44);
        g.bezierCurveTo(30, 34, 18, 32, 0, 34);
        g.bezierCurveTo(-18, 32, -30, 34, -38, 44);
      });
      curls(0, 60, 76, 70, 90, 12, () => {
        g.moveTo(-33, 56);
        g.bezierCurveTo(-36, 90, -26, 118, 0, 128);
        g.bezierCurveTo(26, 118, 36, 90, 33, 56);
        g.bezierCurveTo(26, 72, 16, 80, 0, 80);
        g.bezierCurveTo(-16, 80, -26, 72, -33, 56);
      });
      /* moustache */
      g.fillStyle = marble(-14, 74, 14, 82);
      g.beginPath();
      g.ellipse(-9, 78, 12, 4.5, 0.25, 0, TAU);
      g.ellipse(9, 78, 12, 4.5, -0.25, 0, TAU);
      g.fill();
      /* face: brow, nose and eyes carved in shadow */
      g.fillStyle = "rgba(70,60,50,.35)";
      g.beginPath();
      g.ellipse(-12, 50, 9, 4, 0, 0, TAU);
      g.ellipse(12, 50, 9, 4, 0, 0, TAU);
      g.fill();
      g.fillStyle = marble(-4, 48, 6, 72);
      g.beginPath();
      g.moveTo(-3, 46);
      g.lineTo(3, 46);
      g.lineTo(6, 70);
      g.lineTo(-6, 70);
      g.closePath();
      g.fill();
      g.fillStyle = "rgba(60,50,40,.4)";
      g.fillRect(-6, 69, 12, 2);
      /* glowing eyes */
      const glow = 0.55 + Math.sin(t * 3) * 0.2 + (struck ? 0.4 : 0);
      [-12, 12].forEach((x) => {
        const e = g.createRadialGradient(x, 51, 0, x, 51, 9);
        e.addColorStop(0, "rgba(255,255,255," + glow.toFixed(2) + ")");
        e.addColorStop(0.3, "rgba(140,200,255," + (glow * 0.8).toFixed(2) + ")");
        e.addColorStop(1, "rgba(80,150,255,0)");
        g.fillStyle = e;
        g.fillRect(x - 9, 42, 18, 18);
      });
      /* golden laurel wreath */
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < 7; i++) {
          const a = Math.PI * (0.15 + i * 0.1);
          const x = side * Math.cos(a) * 36, y = 40 - Math.sin(a) * 34;
          g.save();
          g.translate(x, y);
          g.rotate(side * (a - Math.PI / 2) + side * 0.6);
          g.beginPath();
          g.ellipse(0, 0, 8, 3.4, 0, 0, TAU);
          g.fillStyle = gold(g, -8, -3, 8, 3);
          g.fill();
          g.strokeStyle = "rgba(90,55,0,.6)";
          g.lineWidth = 0.6;
          g.stroke();
          g.restore();
        }
      }
      /* lightning crackling across the shoulders now and then, and hard when he strikes */
      const crackle = Math.sin(t * 0.9) > 0.92 || struck;
      if (crackle) {
        const seed = Math.floor(t * 18);
        bolt(-70, 150, -20, 120, seed, struck ? 2.2 : 1.2);
        bolt(70, 160, 30, 125, seed + 5, struck ? 2.2 : 1.2);
        if (struck) bolt(0, 200, 0, 420, seed + 9, 3);
      }
      g.restore();
      /* cloud bank in front of his chest */
      const r = rng(23);
      for (let i = 0; i < 24; i++) {
        const x = W * (r()), y = H * (0.82 + r() * 0.2) + Math.sin(t * 0.6 + i) * 2, rad = W * (0.08 + r() * 0.1);
        const c = g.createRadialGradient(x, y - rad * 0.3, 0, x, y, rad);
        c.addColorStop(0, "rgba(255,236,220,.95)");
        c.addColorStop(0.55, "rgba(240,180,170,.65)");
        c.addColorStop(1, "rgba(170,110,150,0)");
        g.fillStyle = c;
        g.beginPath();
        g.arc(x, y, rad, 0, TAU);
        g.fill();
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { strike: () => (strikeT = (performance.now() - t0) / 1000) };
  }

  global.VBOlympusArt = { symbols, orb, pillar, sky, zeus };
})(window);
