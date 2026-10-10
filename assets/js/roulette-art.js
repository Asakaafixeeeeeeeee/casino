/* Roulette — the realistic pieces, drawn once on canvases: woven felt, clay casino chips (edge inserts, printed inlay,
   thickness), and polished gold trophy cups. Handed to the page as data URLs / drawn into given canvases.
   API: VBRouletteArt.felt() → url, .chip(value, color, size, opts) → url, .cups(canvas) */
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
  function hex(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function shade(h, k) {
    const [r, g, b] = hex(h);
    const f = (v) => Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k);
    return "rgb(" + f(r) + "," + f(g) + "," + f(b) + ")";
  }

  /* ---------------- felt: a tileable weave of fine fibres ---------------- */
  let feltUrl = null;
  function felt() {
    if (feltUrl) return feltUrl;
    const S = 192;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    const img = g.createImageData(S, S);
    const r = rng(7);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 0.85 + r() * 0.3;
      img.data[i] = 14 * v;
      img.data[i + 1] = 92 * v;
      img.data[i + 2] = 48 * v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    /* fibres: short strands lying every which way, light and dark, wrapped across the edges */
    g.lineCap = "round";
    for (let i = 0; i < 2600; i++) {
      const x = r() * S, y = r() * S, a = r() * TAU, len = 1.5 + r() * 4;
      const light = r() < 0.5;
      g.strokeStyle = light ? "rgba(120,200,140," + (0.08 + r() * 0.12).toFixed(2) + ")" : "rgba(0,30,10," + (0.12 + r() * 0.18).toFixed(2) + ")";
      g.lineWidth = 0.5 + r() * 0.5;
      for (let dx = -S; dx <= S; dx += S) for (let dy = -S; dy <= S; dy += S) {
        g.beginPath();
        g.moveTo(x + dx, y + dy);
        g.lineTo(x + dx + Math.cos(a) * len, y + dy + Math.sin(a) * len);
        g.stroke();
      }
    }
    return (feltUrl = c.toDataURL());
  }

  /* ---------------- a clay chip ---------------- */
  /* seen from above with a little tilt, so its edge (thickness) shows below the face. opts.stack: how many chips
     high (placed bets stack up) */
  const chipCache = {};
  function chip(value, color, size, opts) {
    const o = opts || {};
    const stack = Math.max(1, Math.min(5, o.stack || 1));
    const key = value + color + size + "_" + stack;
    if (chipCache[key]) return chipCache[key];
    const R = size / 2;
    const tilt = 0.86, thick = size * 0.09;
    const H = size * tilt + thick * stack + 6;
    const c = document.createElement("canvas");
    c.width = Math.round((size + 6) * DPR);
    c.height = Math.round(H * DPR);
    const g = c.getContext("2d");
    g.scale(DPR, DPR);
    const cx = size / 2 + 3;
    const edgeStripes = (cy, k) => {
      /* the white inserts round the rim, seen on the side */
      for (let i = 0; i < 8; i++) {
        const a0 = (i / 8) * TAU + Math.PI / 16;
        const x0 = cx + Math.cos(a0) * R, x1 = cx + Math.cos(a0 + TAU / 32) * R;
        if (Math.sin(a0) < 0) continue;   /* only the near half shows */
        g.fillStyle = "rgba(245,245,240," + k + ")";
        g.fillRect(Math.min(x0, x1), cy, Math.abs(x1 - x0) + 0.5, thick);
      }
    };
    /* contact shadow */
    g.fillStyle = "rgba(0,0,0,.45)";
    g.beginPath();
    g.ellipse(cx + 1.5, H - R * tilt - 2 + 2.5, R * 1.02, R * tilt * 1.02, 0, 0, TAU);
    g.fill();
    for (let s = 0; s < stack; s++) {
      const top = H - 3 - thick * (s + 1) - R * tilt;   /* centre of this chip's face */
      /* the side band */
      g.beginPath();
      g.ellipse(cx, top + thick, R, R * tilt, 0, 0, Math.PI);
      g.lineTo(cx - R, top);
      g.ellipse(cx, top, R, R * tilt, 0, Math.PI, 0, true);
      g.closePath();
      const side = g.createLinearGradient(cx - R, 0, cx + R, 0);
      side.addColorStop(0, shade(color, -0.6));
      side.addColorStop(0.35, shade(color, -0.15));
      side.addColorStop(0.6, shade(color, -0.3));
      side.addColorStop(1, shade(color, -0.7));
      g.fillStyle = side;
      g.fill();
      g.save();
      g.clip();
      edgeStripes(top, 0.85);
      g.restore();
      if (s < stack - 1) {
        /* a chip under another: just a sliver of its face rim */
        continue;
      }
      /* the face */
      g.save();
      g.translate(cx, top);
      g.scale(1, tilt);
      const face = g.createRadialGradient(-R * 0.3, -R * 0.35, R * 0.1, 0, 0, R);
      face.addColorStop(0, shade(color, 0.22));
      face.addColorStop(0.7, color);
      face.addColorStop(1, shade(color, -0.35));
      g.fillStyle = face;
      g.beginPath();
      g.arc(0, 0, R, 0, TAU);
      g.fill();
      /* rim inserts on the face */
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU + Math.PI / 16;
        g.save();
        g.rotate(a);
        g.fillStyle = "#f5f3ee";
        g.beginPath();
        g.moveTo(R * 0.98, -R * 0.13);
        g.lineTo(R * 0.98, R * 0.13);
        g.lineTo(R * 0.74, R * 0.1);
        g.lineTo(R * 0.74, -R * 0.1);
        g.closePath();
        g.fill();
        g.restore();
      }
      /* moulded inner ring */
      g.beginPath();
      g.arc(0, 0, R * 0.7, 0, TAU);
      g.strokeStyle = shade(color, -0.35);
      g.lineWidth = R * 0.06;
      g.stroke();
      g.beginPath();
      g.arc(0, 0, R * 0.66, 0, TAU);
      g.strokeStyle = "rgba(255,255,255,.35)";
      g.lineWidth = R * 0.025;
      g.setLineDash([R * 0.07, R * 0.05]);
      g.stroke();
      g.setLineDash([]);
      /* the printed inlay */
      const inlay = g.createRadialGradient(-R * 0.1, -R * 0.12, 0, 0, 0, R * 0.56);
      inlay.addColorStop(0, "#fffdf6");
      inlay.addColorStop(1, "#e4ddcd");
      g.fillStyle = inlay;
      g.beginPath();
      g.arc(0, 0, R * 0.54, 0, TAU);
      g.fill();
      g.strokeStyle = shade(color, -0.2);
      g.lineWidth = R * 0.03;
      g.stroke();
      const txt = String(value);
      g.fillStyle = shade(color, -0.25);
      g.font = "900 " + R * (txt.length >= 3 ? 0.42 : 0.56) + "px Georgia, 'Times New Roman', serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(txt, 0, R * 0.04);
      /* clay grain */
      const rr = rng(value * 100 + 3);
      for (let i = 0; i < 160; i++) {
        const a = rr() * TAU, d = Math.sqrt(rr()) * R;
        g.fillStyle = rr() < 0.5 ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.08)";
        g.fillRect(Math.cos(a) * d, Math.sin(a) * d, 1, 1);
      }
      /* satin sheen */
      const sh = g.createLinearGradient(-R, -R, R, R);
      sh.addColorStop(0, "rgba(255,255,255,.28)");
      sh.addColorStop(0.45, "rgba(255,255,255,0)");
      sh.addColorStop(1, "rgba(0,0,0,.18)");
      g.fillStyle = sh;
      g.beginPath();
      g.arc(0, 0, R, 0, TAU);
      g.fill();
      g.restore();
    }
    return (chipCache[key] = { url: c.toDataURL(), w: size + 6, h: H });
  }

  /* ---------------- two gold trophy cups ---------------- */
  /* each cup is a lathe shape: a profile turned round its axis, shaded with the bands of a polished, reflective
     surface; handles are tubes; it stands on a dark wood plinth with a brass plate */
  function metal(g, x0, x1) {
    const gr = g.createLinearGradient(x0, 0, x1, 0);
    gr.addColorStop(0, "#5a3a06");
    gr.addColorStop(0.12, "#b9821c");
    gr.addColorStop(0.28, "#fff4c4");
    gr.addColorStop(0.36, "#f3c94f");
    gr.addColorStop(0.55, "#8a5c0e");
    gr.addColorStop(0.7, "#e9b640");
    gr.addColorStop(0.85, "#fde8a0");
    gr.addColorStop(1, "#6b4508");
    return gr;
  }
  /* profile: [y, radius] from the rim down to the foot (unit height 1) */
  const PROFILE = [[0, 0.36], [0.06, 0.355], [0.2, 0.33], [0.34, 0.27], [0.44, 0.18], [0.5, 0.09], [0.54, 0.055],
    [0.6, 0.05], [0.63, 0.08], [0.66, 0.05], [0.76, 0.045], [0.8, 0.09], [0.86, 0.16], [0.9, 0.2], [0.93, 0.2]];

  function cup(g, x, y, h, rot) {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    const pt = (p, s) => [s * p[1] * h, p[0] * h];
    /* handles first (behind the bowl's front) */
    [-1, 1].forEach((s) => {
      g.beginPath();
      g.moveTo(s * 0.33 * h, 0.08 * h);
      g.bezierCurveTo(s * 0.62 * h, 0.04 * h, s * 0.62 * h, 0.36 * h, s * 0.22 * h, 0.42 * h);
      g.strokeStyle = "#5a3a06";
      g.lineWidth = h * 0.065;
      g.lineCap = "round";
      g.stroke();
      g.strokeStyle = metal(g, -0.6 * h, 0.6 * h);
      g.lineWidth = h * 0.045;
      g.stroke();
      g.strokeStyle = "rgba(255,250,220,.7)";
      g.lineWidth = h * 0.012;
      g.stroke();
    });
    /* the body */
    g.beginPath();
    PROFILE.forEach((p, i) => g[i ? "lineTo" : "moveTo"](...pt(p, 1)));
    for (let i = PROFILE.length - 1; i >= 0; i--) g.lineTo(...pt(PROFILE[i], -1));
    g.closePath();
    g.fillStyle = metal(g, -0.36 * h, 0.36 * h);
    g.fill();
    g.strokeStyle = "rgba(70,40,0,.7)";
    g.lineWidth = 1;
    g.stroke();
    /* horizon reflection: a dark band across the bowl, as polished metal reflects the room */
    g.save();
    g.clip();
    const band = g.createLinearGradient(0, 0.12 * h, 0, 0.3 * h);
    band.addColorStop(0, "rgba(60,30,0,0)");
    band.addColorStop(0.5, "rgba(60,30,0,.28)");
    band.addColorStop(1, "rgba(60,30,0,0)");
    g.fillStyle = band;
    g.fillRect(-h, 0.12 * h, 2 * h, 0.18 * h);
    /* a sharp window glint */
    g.fillStyle = "rgba(255,255,255,.75)";
    g.beginPath();
    g.ellipse(-0.17 * h, 0.17 * h, 0.025 * h, 0.1 * h, 0.12, 0, TAU);
    g.fill();
    g.restore();
    /* the rim: an ellipse with the darker inside of the bowl */
    g.beginPath();
    g.ellipse(0, 0, 0.36 * h, 0.07 * h, 0, 0, TAU);
    g.fillStyle = metal(g, -0.36 * h, 0.36 * h);
    g.fill();
    g.beginPath();
    g.ellipse(0, 0.008 * h, 0.33 * h, 0.055 * h, 0, 0, TAU);
    const inside = g.createLinearGradient(0, -0.05 * h, 0, 0.06 * h);
    inside.addColorStop(0, "#3a2302");
    inside.addColorStop(1, "#c8901f");
    g.fillStyle = inside;
    g.fill();
    /* plinth */
    const by = 0.93 * h;
    g.fillStyle = "#1c0d05";
    g.beginPath();
    g.roundRect(-0.27 * h, by, 0.54 * h, 0.16 * h, 3);
    g.fill();
    const wood = g.createLinearGradient(-0.27 * h, 0, 0.27 * h, 0);
    wood.addColorStop(0, "#2a1206");
    wood.addColorStop(0.4, "#6a3212");
    wood.addColorStop(1, "#1e0a02");
    g.fillStyle = wood;
    g.beginPath();
    g.roundRect(-0.26 * h, by + 2, 0.52 * h, 0.14 * h - 3, 2);
    g.fill();
    g.fillStyle = metal(g, -0.12 * h, 0.12 * h);
    g.fillRect(-0.12 * h, by + 0.045 * h, 0.24 * h, 0.055 * h);
    g.restore();
  }

  function cups(canvas) {
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    const g = canvas.getContext("2d");
    g.scale(DPR, DPR);
    g.clearRect(0, 0, W, H);
    /* warm glow behind */
    const glow = g.createRadialGradient(W / 2, H * 0.5, 0, W / 2, H * 0.5, H * 0.5);
    glow.addColorStop(0, "rgba(255,210,120,.45)");
    glow.addColorStop(1, "rgba(255,210,120,0)");
    g.fillStyle = glow;
    g.fillRect(0, 0, W, H);
    const h = H * 0.74;
    cup(g, W * 0.29, H * 0.12, h, -0.1);
    cup(g, W * 0.71, H * 0.12, h, 0.1);
  }

  global.VBRouletteArt = { felt, chip, cups };
})(window);
