/* Rendo Knockout — the fight, drawn on a canvas at the screen's resolution. A dark arena with a crowd and camera
   flashes, overhead lights on a blue canvas ring, three ropes, and two boxers built from jointed limbs (torso, head,
   arms, legs, gloves) that bounce in their stance, throw jabs, crosses and hooks, snap back when hit, and — when the
   round ends — one lands an uppercut and the other goes down.
   The game decides everything (knockout.js); this only shows it.
   API: VBKnockoutArt.create(canvas, { onPunch(power), reduceMotion }) → { draw(now, s) }
     s = { state: "WAITING" | "IN_FLIGHT" | "CRASHED", x: multiplier, ms: time in this state } */
(function (global) {
  "use strict";
  const TAU = Math.PI * 2;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

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

  /* ---------------- poses: joint positions in a boxer's own space (facing right, feet at 0,0, up is −y) ---------------- */
  const STANCE = {
    hip: [0, -96], neck: [8, -160], head: [16, -180],
    sF: [12, -153], sB: [0, -151],          /* front (lead) and back (rear) shoulders */
    eF: [30, -136], gF: [44, -156],         /* lead elbow, lead glove: up, a little forward */
    eB: [10, -128], gB: [28, -158],         /* rear elbow tucked, rear glove at the chin */
    kF: [20, -50], fF: [26, 0],             /* lead knee, foot */
    kB: [-16, -52], fB: [-28, 0]            /* rear knee, foot */
  };
  const PUNCH = {
    jab: { gF: [100, -166], eF: [66, -160], neck: [14, -160], head: [23, -180] },
    cross: { gB: [104, -168], eB: [66, -158], sB: [14, -152], neck: [16, -160], head: [26, -179], hip: [6, -96] },
    hook: { gF: [92, -176], eF: [66, -172], neck: [14, -159], head: [22, -178] },
    upper: { gB: [92, -196], eB: [62, -166], sB: [16, -154], neck: [18, -164], head: [28, -184], hip: [8, -98], kB: [-6, -56] }
  };
  /* knocked out: slumped down on his knees, head hanging, gloves down */
  const KO = {
    hip: [-14, -58], neck: [10, -112], head: [26, -98], sF: [14, -106], sB: [0, -104],
    eF: [24, -78], gF: [36, -56], eB: [8, -76], gB: [20, -52],
    kF: [16, -6], fF: [-22, 0], kB: [-6, -6], fB: [-40, 0]
  };
  /* snapped back by a punch */
  const HIT = { neck: [0, -158], head: [2, -176], hip: [-6, -95], gF: [36, -150], gB: [22, -150] };

  function pose(base, over, k) {
    const out = {};
    for (const j in base) {
      const o = over && over[j];
      out[j] = o ? [lerp(base[j][0], o[0], k), lerp(base[j][1], o[1], k)] : base[j].slice();
    }
    return out;
  }

  /* ---------------- a boxer ---------------- */
  /* skin: deep shadow, base, lit, and the warm rim-light colour; kit colours */
  const LOOKS = [
    { skin: ["#080504", "#1c120c", "#3c2618", "#ffcf9a"], hair: ["#030202", "#0c0806"],
      trunks: ["#1a0003", "#5e0610", "#c8303a"], band: ["#5a4206", "#c99a1e"], glove: ["#1e0103", "#7a0910", "#ff6a5a"], shoe: ["#1a1a1c", "#3a3a3e"] },
    { skin: ["#050405", "#120d0c", "#2a1e18", "#bcd6ff"], hair: ["#020202", "#080808"],
      trunks: ["#010616", "#0a2464", "#4a7ad8"], band: ["#44484e", "#a8adb5"], glove: ["#010a22", "#0d2f8a", "#7aa8ff"], shoe: ["#0a0a0a", "#202022"] }
  ];

  /* a muscled segment from joint a to b: radius r0 → r1 with a muscle belly that swells the middle (and sits a little
     toward one side), filled as a rounded form lit from above, with a warm rim light on its upper edge */
  function seg(g, a, b, r0, r1, belly, S, bias) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const N = 8, L = [], R = [];
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const sw = Math.sin(Math.PI * Math.pow(t, 0.85)) * belly;
      const r = lerp(r0, r1, t);
      const px = a[0] + dx * t, py = a[1] + dy * t;
      L.push([px + nx * (r + sw * (1 + (bias || 0))), py + ny * (r + sw * (1 + (bias || 0)))]);
      R.push([px - nx * (r + sw * (1 - (bias || 0))), py - ny * (r + sw * (1 - (bias || 0)))]);
    }
    const path = () => {
      g.beginPath();
      g.moveTo(L[0][0], L[0][1]);
      for (let k = 1; k < L.length - 1; k++) g.quadraticCurveTo(L[k][0], L[k][1], (L[k][0] + L[k + 1][0]) / 2, (L[k][1] + L[k + 1][1]) / 2);
      g.lineTo(L[N][0], L[N][1]);
      g.arc(b[0], b[1], r1, Math.atan2(ny, nx), Math.atan2(-ny, -nx), false);
      for (let k = N - 1; k > 0; k--) g.quadraticCurveTo(R[k][0], R[k][1], (R[k][0] + R[k - 1][0]) / 2, (R[k][1] + R[k - 1][1]) / 2);
      g.lineTo(R[0][0], R[0][1]);
      g.arc(a[0], a[1], r0, Math.atan2(-ny, -nx), Math.atan2(ny, nx), false);
      g.closePath();
    };
    /* the side whose normal points up catches the light */
    const up = ny < 0 ? 1 : -1;
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], rm = Math.max(r0, r1) + belly;
    const gr = g.createLinearGradient(m[0] + nx * rm * up, m[1] + ny * rm * up, m[0] - nx * rm * up, m[1] - ny * rm * up);
    gr.addColorStop(0, S[2]);
    gr.addColorStop(0.28, S[2]);
    gr.addColorStop(0.55, S[1]);
    gr.addColorStop(0.85, S[0]);
    gr.addColorStop(1, S[0]);
    path();
    g.fillStyle = gr;
    g.fill();
    /* rim light: a soft bright line just inside the lit edge */
    g.save();
    path();
    g.clip();
    g.strokeStyle = S[3];
    g.globalAlpha = 0.95;
    g.lineWidth = 2.4;
    g.shadowColor = S[3];
    g.shadowBlur = 9;
    g.beginPath();
    const E = up > 0 ? L : R;
    E.forEach((p, k) => g[k ? "lineTo" : "moveTo"](p[0] + nx * up * -0.6, p[1] + ny * up * -0.6));
    g.stroke();
    g.restore();
  }

  /* a soft blob of light or shade (muscle definition, sheen) */
  function blob(g, x, y, rx, ry, rot, col, a) {
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.scale(1, ry / rx);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    gr.addColorStop(0, col.replace("A", a));
    gr.addColorStop(1, col.replace("A", 0));
    g.fillStyle = gr;
    g.fillRect(-rx, -rx, rx * 2, rx * 2);
    g.restore();
  }

  function glove(g, p, from, look, big) {
    const r = big ? 13 : 12;
    const ang = Math.atan2(p[1] - from[1], p[0] - from[0]);
    g.save();
    g.translate(p[0], p[1]);
    g.rotate(ang);
    /* white tape round the wrist, with wrap lines */
    g.fillStyle = "#e8e6e0";
    g.beginPath();
    g.roundRect(-r * 1.55, -r * 0.55, r * 0.7, r * 1.1, 2);
    g.fill();
    g.strokeStyle = "rgba(0,0,0,.18)";
    g.lineWidth = 0.6;
    for (let k = 1; k < 3; k++) {
      g.beginPath();
      g.moveTo(-r * 1.55 + k * r * 0.23, -r * 0.55);
      g.lineTo(-r * 1.55 + k * r * 0.23 + 2, r * 0.55);
      g.stroke();
    }
    /* the padded fist: a fat rounded shape, leather sheen */
    const gr = g.createRadialGradient(-r * 0.15, -r * 0.5, r * 0.05, 0, 0, r * 1.25);
    gr.addColorStop(0, look.glove[2]);
    gr.addColorStop(0.35, look.glove[1]);
    gr.addColorStop(1, look.glove[0]);
    g.fillStyle = gr;
    g.beginPath();
    g.moveTo(-r * 0.9, -r * 0.7);
    g.bezierCurveTo(-r * 0.2, -r * 1.25, r * 1.25, -r * 1.05, r * 1.15, 0);
    g.bezierCurveTo(r * 1.1, r * 0.95, -r * 0.1, r * 1.1, -r * 0.9, r * 0.65);
    g.closePath();
    g.fill();
    /* the thumb, stitched to the side */
    g.beginPath();
    g.ellipse(-r * 0.05, -r * 0.62, r * 0.48, r * 0.28, -0.35, 0, TAU);
    g.fill();
    g.strokeStyle = "rgba(0,0,0,.28)";
    g.lineWidth = 0.7;
    g.beginPath();
    g.moveTo(-r * 0.55, -r * 0.42);
    g.quadraticCurveTo(r * 0.2, -r * 0.3, r * 0.5, -r * 0.62);
    g.stroke();
    /* specular: a sharp streak and a soft bloom */
    blob(g, r * 0.25, -r * 0.45, r * 0.55, r * 0.22, -0.2, "rgba(255,255,255,A)", 0.75);
    g.fillStyle = "rgba(255,255,255,.85)";
    g.beginPath();
    g.ellipse(r * 0.2, -r * 0.55, r * 0.28, r * 0.07, -0.25, 0, TAU);
    g.fill();
    g.restore();
  }

  function boot(g, knee, f, look, S) {
    /* a high-top boxing boot: laced shaft up the shin, a slim sole */
    const top = [lerp(knee[0], f[0], 0.55), lerp(knee[1], f[1], 0.55)];
    seg(g, top, [f[0] + 1, f[1] - 6], 7.5, 7, 0, [look.shoe[0], look.shoe[1], look.shoe[1], "#ffffff"]);
    g.fillStyle = look.shoe[1];
    g.beginPath();
    g.roundRect(f[0] - 7, f[1] - 9, 21, 9, [5, 7, 2, 2]);
    g.fill();
    g.fillStyle = "rgba(0,0,0,.55)";
    g.fillRect(f[0] - 7, f[1] - 2, 21, 2);
    g.strokeStyle = "rgba(0,0,0,.35)";
    g.lineWidth = 0.8;
    for (let k = 0; k < 4; k++) {
      const y = lerp(top[1], f[1] - 8, k / 4);
      const x = lerp(top[0], f[0] + 1, k / 4) + 4;
      g.beginPath();
      g.moveTo(x - 2, y);
      g.lineTo(x + 2, y + 2);
      g.stroke();
    }
  }

  function drawBoxer(g, P, look) {
    const S = look.skin;
    /* far side: rear leg and rear arm, a shade darker */
    const far = [S[0], S[0], S[1], S[3]];
    seg(g, P.hip, P.kB, 11, 7.5, 3.5, far, 0.3);
    seg(g, P.kB, P.fB, 7, 4.5, 2.6, far, -0.4);
    boot(g, P.kB, P.fB, look, far);
    seg(g, P.sB, P.eB, 8, 5.5, 2.6, far, 0.2);
    seg(g, P.eB, P.gB, 5.5, 4, 1.8, far, 0.2);
    glove(g, P.gB, P.eB, look, false);

    /* torso: broad shoulders tapering to a narrow waist, lit from above */
    const sx = (P.sF[0] + P.sB[0]) / 2, sy = (P.sF[1] + P.sB[1]) / 2;
    const tp = () => {
      g.beginPath();
      g.moveTo(P.sB[0] - 13, P.sB[1] + 2);
      g.bezierCurveTo(P.sB[0] - 8, P.sB[1] - 9, P.sF[0] + 4, P.sF[1] - 10, P.sF[0] + 13, P.sF[1] + 1);
      g.bezierCurveTo(P.sF[0] + 18, P.sF[1] + 18, P.hip[0] + 15, P.hip[1] - 22, P.hip[0] + 12, P.hip[1] - 4);
      g.lineTo(P.hip[0] - 13, P.hip[1] - 4);
      g.bezierCurveTo(P.hip[0] - 16, P.hip[1] - 26, P.sB[0] - 19, P.sB[1] + 22, P.sB[0] - 13, P.sB[1] + 2);
      g.closePath();
    };
    let gr = g.createLinearGradient(sx - 16, sy - 12, P.hip[0] + 10, P.hip[1]);
    gr.addColorStop(0, S[2]);
    gr.addColorStop(0.5, S[1]);
    gr.addColorStop(1, S[0]);
    tp();
    g.fillStyle = gr;
    g.fill();
    g.save();
    tp();
    g.clip();
    /* the back in shadow, the chest catching the light */
    gr = g.createLinearGradient(P.sB[0] - 16, 0, P.sF[0] + 16, 0);
    gr.addColorStop(0, "rgba(0,0,0,.45)");
    gr.addColorStop(0.45, "rgba(0,0,0,0)");
    g.fillStyle = gr;
    g.fillRect(P.sB[0] - 30, P.sB[1] - 20, 80, 100);
    /* pec, abs and oblique shading as soft forms, not lines */
    blob(g, P.sF[0] + 2, P.sF[1] + 14, 13, 8, 0.25, "rgba(255,230,200,A)", 0.12);
    blob(g, P.sF[0] + 2, P.sF[1] + 23, 13, 4, 0.2, "rgba(0,0,0,A)", 0.3);
    for (let k = 0; k < 3; k++) {
      const y = lerp(P.sF[1] + 32, P.hip[1] - 14, k / 2);
      const x = lerp(P.sF[0] + 4, P.hip[0] + 7, k / 2);
      blob(g, x, y, 6, 4, 0, "rgba(255,225,190,A)", 0.08);
      blob(g, x, y + 5, 6, 2, 0, "rgba(0,0,0,A)", 0.22);
    }
    blob(g, P.hip[0] - 4, P.hip[1] - 18, 9, 16, 0.2, "rgba(0,0,0,A)", 0.25);
    /* sweat sheen on the shoulder and chest */
    blob(g, P.sF[0] + 4, P.sF[1] + 3, 7, 3, -0.4, "rgba(255,255,255,A)", 0.45);
    blob(g, P.sF[0] + 8, P.sF[1] + 18, 4, 2, 0.3, "rgba(255,255,255,A)", 0.35);
    g.restore();
    /* rim light along the top of the shoulders */
    g.save();
    g.strokeStyle = S[3];
    g.globalAlpha = 1;
    g.lineWidth = 2.4;
    g.shadowColor = S[3];
    g.shadowBlur = 10;
    g.beginPath();
    g.moveTo(P.sB[0] - 11, P.sB[1] - 1);
    g.bezierCurveTo(P.sB[0] - 6, P.sB[1] - 8, P.sF[0] + 4, P.sF[1] - 9, P.sF[0] + 11, P.sF[1]);
    g.stroke();
    g.restore();

    /* satin trunks: folds and a sheen, a two-tone waistband */
    const hp = () => {
      g.beginPath();
      g.moveTo(P.hip[0] - 15, P.hip[1] - 9);
      g.lineTo(P.hip[0] + 14, P.hip[1] - 9);
      g.quadraticCurveTo(P.hip[0] + 21, P.hip[1] + 10, P.hip[0] + 22, P.hip[1] + 26);
      g.lineTo(P.hip[0] + 1, P.hip[1] + 28);
      g.lineTo(P.hip[0] - 3, P.hip[1] + 18);
      g.lineTo(P.hip[0] - 21, P.hip[1] + 25);
      g.quadraticCurveTo(P.hip[0] - 20, P.hip[1] + 6, P.hip[0] - 15, P.hip[1] - 9);
      g.closePath();
    };
    gr = g.createLinearGradient(P.hip[0] - 21, 0, P.hip[0] + 22, 0);
    gr.addColorStop(0, look.trunks[0]);
    gr.addColorStop(0.35, look.trunks[1]);
    gr.addColorStop(0.55, look.trunks[2]);
    gr.addColorStop(0.7, look.trunks[1]);
    gr.addColorStop(1, look.trunks[0]);
    hp();
    g.fillStyle = gr;
    g.fill();
    g.save();
    hp();
    g.clip();
    [[-8, 0.25], [6, 0.2]].forEach(([dx, a]) => blob(g, P.hip[0] + dx, P.hip[1] + 12, 3, 14, 0.15, "rgba(0,0,0,A)", a));
    blob(g, P.hip[0] + 4, P.hip[1] + 6, 4, 12, 0.1, "rgba(255,255,255,A)", 0.3);
    g.restore();
    gr = g.createLinearGradient(0, P.hip[1] - 11, 0, P.hip[1] - 3);
    gr.addColorStop(0, look.band[1]);
    gr.addColorStop(1, look.band[0]);
    g.fillStyle = gr;
    g.beginPath();
    g.roundRect(P.hip[0] - 15.5, P.hip[1] - 11, 30, 7, 2);
    g.fill();

    /* near side: lead leg, head, lead arm */
    seg(g, P.hip, P.kF, 11.5, 8, 4, S, 0.3);
    seg(g, P.kF, P.fF, 7.5, 4.8, 2.8, S, -0.4);
    boot(g, P.kF, P.fF, look, S);
    head(g, P, look);
    seg(g, P.sF, P.eF, 8.5, 5.8, 3, S, 0.25);     /* shoulder, biceps */
    seg(g, P.eF, P.gF, 6, 4.2, 2.2, S, 0.2);       /* forearm */
    blob(g, (P.sF[0] + P.eF[0]) / 2, (P.sF[1] + P.eF[1]) / 2 - 3, 5, 2, Math.atan2(P.eF[1] - P.sF[1], P.eF[0] - P.sF[0]), "rgba(255,255,255,A)", 0.35);
    glove(g, P.gF, P.eF, look, true);
  }

  function head(g, P, look) {
    const S = look.skin;
    const h = P.head;
    /* neck and trapezius */
    seg(g, [P.neck[0] - 2, P.neck[1] + 8], [h[0] - 1, h[1] + 7], 8.5, 6.5, 1, S, 0);
    const hp = () => {
      g.beginPath();
      g.moveTo(h[0] - 10, h[1] - 4);
      g.bezierCurveTo(h[0] - 11, h[1] - 16, h[0] + 6, h[1] - 18, h[0] + 10, h[1] - 8);   /* crown */
      g.lineTo(h[0] + 11.5, h[1] - 3);                                                  /* brow */
      g.lineTo(h[0] + 14, h[1] + 2);                                                    /* nose */
      g.lineTo(h[0] + 11, h[1] + 4);
      g.lineTo(h[0] + 11.5, h[1] + 8);                                                  /* lips */
      g.quadraticCurveTo(h[0] + 10, h[1] + 13, h[0] + 4, h[1] + 13);                    /* chin */
      g.quadraticCurveTo(h[0] - 4, h[1] + 12, h[0] - 8, h[1] + 6);                      /* jaw */
      g.closePath();
    };
    const gr = g.createRadialGradient(h[0] + 2, h[1] - 6, 1, h[0], h[1], 16);
    gr.addColorStop(0, S[2]);
    gr.addColorStop(0.55, S[1]);
    gr.addColorStop(1, S[0]);
    hp();
    g.fillStyle = gr;
    g.fill();
    g.save();
    hp();
    g.clip();
    /* the eye socket in the shadow of the brow, the cheekbone lit */
    blob(g, h[0] + 8, h[1] + 1, 5, 7, 0, "rgba(255,210,160,A)", 0.08);
    blob(g, h[0] + 2, h[1] + 10, 7, 3, 0, "rgba(0,0,0,A)", 0.3);
    /* close-cropped hair: a dark cap with stubble texture */
    g.fillStyle = look.hair[0];
    g.beginPath();
    g.ellipse(h[0] - 1, h[1] - 9, 11.5, 8, 0.12, Math.PI * 0.92, Math.PI * 2.04);
    g.fill();
    const r = rng(Math.round(h[0] * 7 + 3));
    g.fillStyle = look.hair[1];
    for (let k = 0; k < 40; k++) g.fillRect(h[0] - 11 + r() * 20, h[1] - 16 + r() * 8, 0.8, 0.8);
    g.restore();
    /* ear, rim light on the crown */
    g.fillStyle = S[0];
    g.beginPath();
    g.ellipse(h[0] - 3, h[1] + 1, 2.6, 3.8, 0.1, 0, TAU);
    g.fill();
    g.save();
    g.strokeStyle = S[3];
    g.globalAlpha = 0.95;
    g.lineWidth = 2;
    g.shadowColor = S[3];
    g.shadowBlur = 9;
    g.beginPath();
    g.moveTo(h[0] - 10, h[1] - 6);
    g.bezierCurveTo(h[0] - 10, h[1] - 16, h[0] + 6, h[1] - 18, h[0] + 10, h[1] - 8);
    g.stroke();
    g.restore();
  }

  /* ---------------- the scene ---------------- */
  function create(canvas, opts) {
    const o = opts || {};
    const g = canvas.getContext("2d");
    let W = 0, H = 0, px = 1, crowd = null;
    const reduce = !!o.reduceMotion;

    function resize() {
      px = Math.min(2, global.devicePixelRatio || 1);
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      if (!W || !H) return;
      canvas.width = Math.round(W * px);
      canvas.height = Math.round(H * px);
      crowd = paintCrowd();
    }
    new ResizeObserver(resize).observe(canvas);

    /* the crowd: rows of dim heads and shoulders, lit faintly by the ring, painted once */
    function paintCrowd() {
      const c = document.createElement("canvas");
      c.width = Math.round(W * px);
      c.height = Math.round(H * 0.62 * px);
      const k = c.getContext("2d");
      k.scale(px, px);
      const h = H * 0.62;
      const bg = k.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, "#05040a");
      bg.addColorStop(1, "#1b1424");
      k.fillStyle = bg;
      k.fillRect(0, 0, W, h);
      const r = rng(5);
      for (let row = 0; row < 9; row++) {
        const y = h * (0.18 + row * 0.1);
        const size = 6 + row * 2.2;
        const lit = 0.12 + row * 0.07;
        for (let x = -10; x < W + 10; x += size * 1.7 + r() * 6) {
          const tone = 30 + r() * 50;
          const col = "rgb(" + Math.round(tone * (1 + lit) + 20) + "," + Math.round(tone * (0.8 + lit)) + "," + Math.round(tone * (0.9 + lit) + 10) + ")";
          k.fillStyle = col;
          k.beginPath();
          k.ellipse(x, y + r() * 4, size * 0.55, size * 0.62, 0, 0, TAU);
          k.fill();
          k.beginPath();
          k.ellipse(x, y + size * 1.3, size * 0.95, size * 0.6, 0, Math.PI, TAU);
          k.fill();
          if (r() < 0.06) {   /* a raised arm */
            k.fillRect(x + size * 0.6, y - size * 1.4, size * 0.3, size * 1.5);
          }
        }
      }
      /* haze over the far rows */
      const haze = k.createLinearGradient(0, 0, 0, h);
      haze.addColorStop(0, "rgba(10,8,20,.75)");
      haze.addColorStop(0.6, "rgba(10,8,20,.2)");
      haze.addColorStop(1, "rgba(10,8,20,0)");
      k.fillStyle = haze;
      k.fillRect(0, 0, W, h);
      /* out of focus, as a camera on the fighters sees it: shrink to an eighth and scale back up, twice */
      const sm = document.createElement("canvas");
      sm.width = Math.max(1, Math.round(c.width / 8));
      sm.height = Math.max(1, Math.round(c.height / 8));
      const sk = sm.getContext("2d");
      sk.imageSmoothingQuality = "high";
      for (let pass = 0; pass < 2; pass++) {
        sk.clearRect(0, 0, sm.width, sm.height);
        sk.drawImage(c, 0, 0, sm.width, sm.height);
        k.setTransform(1, 0, 0, 1, 0, 0);
        k.imageSmoothingQuality = "high";
        k.clearRect(0, 0, c.width, c.height);
        k.drawImage(sm, 0, 0, c.width, c.height);
      }
      /* and much darker: the stands are unlit */
      k.fillStyle = "rgba(4,3,8,.62)";
      k.fillRect(0, 0, c.width, c.height);
      return c;
    }

    /* ---------------- the fight ---------------- */
    const fighters = [
      { look: LOOKS[0], dir: 1, act: null, hit: 0, down: 0 },
      { look: LOOKS[1], dir: -1, act: null, hit: 0, down: 0 }
    ];
    let lastState = "";
    let nextPunch = 0;
    let winner = 0;
    let flashes = [];
    let impacts = [];
    let shake = 0;
    let gapNow = 0;

    function throwPunch(i, kind, now) {
      const f = fighters[i];
      f.act = { kind, t0: now, dur: kind === "upper" ? 520 : kind === "cross" ? 380 : 320 };
    }

    function frameState(now, s) {
      if (s.state !== lastState) {
        if (s.state === "IN_FLIGHT") {
          fighters.forEach((f) => (f.down = 0));
          nextPunch = now + 600;
        }
        if (s.state === "CRASHED") {
          /* the knockout: one throws an uppercut, the other goes down */
          winner = Math.random() < 0.5 ? 0 : 1;
          throwPunch(winner, "upper", now);
          fighters[1 - winner].koAt = now + 230;
        }
        if (s.state === "WAITING") fighters.forEach((f) => { f.down = 0; f.koAt = 0; f.act = null; });
        lastState = s.state;
      }
      /* punches come faster as the multiplier climbs */
      if (s.state === "IN_FLIGHT" && now >= nextPunch) {
        const i = Math.random() < 0.5 ? 0 : 1;
        if (!fighters[i].act) {
          const kinds = ["jab", "jab", "cross", "hook"];
          throwPunch(i, kinds[Math.floor(Math.random() * kinds.length)], now);
        }
        const gap = clamp(950 / Math.sqrt(s.x), 260, 950);
        nextPunch = now + gap * (0.6 + Math.random() * 0.8);
      }
    }

    function poseOf(f, i, now, s) {
      let P = pose(STANCE);
      /* stance bounce */
      const bob = reduce ? 0 : Math.sin(now / 160 + i * 1.7) * 3;
      if (f.act) {
        const t = (now - f.act.t0) / f.act.dur;
        if (t >= 1) f.act = null;
        else {
          const k = t < 0.4 ? ease(t / 0.4) : 1 - ease((t - 0.4) / 0.6);
          P = pose(STANCE, PUNCH[f.act.kind], k);
          /* the moment it lands: the other boxer snaps back, a flash, a thud */
          if (t >= 0.38 && !f.act.landed) {
            f.act.landed = true;
            const other = fighters[1 - i];
            other.hit = now;
            const power = f.act.kind === "upper" ? 1 : f.act.kind === "cross" ? 0.75 : f.act.kind === "hook" ? 0.65 : 0.45;
            impacts.push({ i: 1 - i, t0: now, power });
            shake = Math.max(shake, power * (s.state === "CRASHED" ? 1.4 : 0.6));
            if (o.onPunch) o.onPunch(power);
          }
        }
      }
      if (f.koAt && now >= f.koAt) {
        const k = 1 - Math.pow(1 - clamp((now - f.koAt) / 600, 0, 1), 3);
        return pose(P, KO, k);
      }
      if (f.hit && now - f.hit < 260) {
        const k = 1 - (now - f.hit) / 260;
        P = pose(P, HIT, k * 0.9);
      }
      for (const j in P) P[j][1] += bob * (j[0] === "f" ? 0 : 1);
      return P;
    }

    function draw(now, s) {
      if (!W) resize();
      if (!W || !crowd) return;
      frameState(now, s);
      g.setTransform(px, 0, 0, px, 0, 0);
      let ox = 0, oy = 0;
      if (shake > 0.01 && !reduce) {
        ox = (Math.random() - 0.5) * 10 * shake;
        oy = (Math.random() - 0.5) * 8 * shake;
        shake *= 0.86;
      }
      g.save();
      g.translate(ox, oy);

      /* crowd and camera flashes */
      g.drawImage(crowd, 0, 0, W, H * 0.62);
      if (!reduce && Math.random() < (s.state === "IN_FLIGHT" ? 0.12 : 0.04)) flashes.push({ x: Math.random() * W, y: H * (0.2 + Math.random() * 0.35), t0: now });
      flashes = flashes.filter((f) => now - f.t0 < 180);
      flashes.forEach((f) => {
        const a = 1 - (now - f.t0) / 180;
        const gr = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, 26);
        gr.addColorStop(0, "rgba(255,255,255," + a + ")");
        gr.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = gr;
        g.fillRect(f.x - 26, f.y - 26, 52, 52);
      });

      /* the backlight: the ring's light rig glaring through the haze behind the fighters */
      const glare = g.createRadialGradient(W / 2, H * 0.36, 4, W / 2, H * 0.36, W * 0.55);
      glare.addColorStop(0, "rgba(255,248,235,.95)");
      glare.addColorStop(0.12, "rgba(255,225,180,.55)");
      glare.addColorStop(0.4, "rgba(150,140,190,.18)");
      glare.addColorStop(1, "rgba(40,30,60,0)");
      g.fillStyle = glare;
      g.fillRect(0, 0, W, H * 0.75);

      /* the ring floor: canvas mat in perspective, the apron below it */
      const back = H * 0.56, front = H * 0.9;
      const bl = W * 0.08, br = W * 0.92;
      g.beginPath();
      g.moveTo(bl, back);
      g.lineTo(br, back);
      g.lineTo(W + 40, front);
      g.lineTo(-40, front);
      g.closePath();
      let gr = g.createLinearGradient(0, back, 0, front);
      gr.addColorStop(0, "#0c1a36");
      gr.addColorStop(1, "#1b3466");
      g.fillStyle = gr;
      g.fill();
      /* the overhead lights pool on the mat */
      gr = g.createRadialGradient(W / 2, H * 0.74, 10, W / 2, H * 0.74, W * 0.45);
      gr.addColorStop(0, "rgba(255,245,225,.42)");
      gr.addColorStop(1, "rgba(255,245,225,0)");
      g.fillStyle = gr;
      g.fill();
      /* centre logo printed on the canvas */
      g.save();
      g.translate(W / 2, H * 0.74);
      g.scale(1, 0.32);
      g.strokeStyle = "rgba(255,255,255,.18)";
      g.lineWidth = 6;
      g.beginPath();
      g.arc(0, 0, W * 0.15, 0, TAU);
      g.stroke();
      g.restore();
      g.fillStyle = "rgba(255,255,255,.14)";
      g.font = "900 " + Math.round(H * 0.05) + "px Arial Black, Arial, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("KNOCKOUT", W / 2, H * 0.74);
      /* apron */
      gr = g.createLinearGradient(0, front, 0, H);
      gr.addColorStop(0, "#8a0f17");
      gr.addColorStop(1, "#3a0408");
      g.fillStyle = gr;
      g.fillRect(-40, front, W + 80, H - front + 10);
      g.fillStyle = "rgba(255,255,255,.85)";
      g.font = "900 italic " + Math.round(H * 0.055) + "px Arial Black, Arial, sans-serif";
      g.fillText("KNOCKOUTBET", W / 2, (front + H) / 2 + 2);

      /* back ropes and posts */
      ropes(back, bl, br, H * 0.07, 0.6);

      /* the boxers */
      const s1 = H / 390;
      const feet = H * 0.83;
      const fightGap = 104 * s1;
      const restGap = W * 0.42;
      const want = s.state === "WAITING" ? restGap : fightGap;
      gapNow = gapNow ? lerp(gapNow, want, 0.06) : want;
      const xs = [W / 2 - gapNow / 2 - 8 * s1, W / 2 + gapNow / 2 + 8 * s1];
      fighters.forEach((f, i) => {
        let P = poseOf(f, i, now, s);
        g.save();
        g.translate(xs[i], feet);
        /* shadow on the mat */
        g.fillStyle = "rgba(0,0,0,.4)";
        g.beginPath();
        g.ellipse(0, 2, 36 * s1, 7 * s1, 0, 0, TAU);
        g.fill();
        g.scale(f.dir * s1, s1);
        drawBoxer(g, P, f.look);
        g.restore();
        /* stars over the fallen boxer */
        if (f.koAt && now >= f.koAt + 500) {
          const hx = xs[i] + f.dir * 26 * s1, hy = feet - 128 * s1;
          for (let k = 0; k < 4; k++) {
            const a = now / 300 + (k * TAU) / 4;
            star(hx + Math.cos(a) * 22 * s1, hy + Math.sin(a) * 7 * s1, 5 * s1);
          }
        }
      });

      /* punch impacts: a white burst and sweat spray at the head of the boxer hit */
      impacts = impacts.filter((m) => now - m.t0 < 260);
      impacts.forEach((m) => {
        const k = (now - m.t0) / 260;
        const f = fighters[m.i];
        const hx = xs[m.i] + f.dir * 10 * s1, hy = feet - 178 * s1;
        const r = (16 + m.power * 30) * s1 * (0.6 + k);
        const gr2 = g.createRadialGradient(hx, hy, 0, hx, hy, r);
        gr2.addColorStop(0, "rgba(255,255,255," + (0.9 * (1 - k)) + ")");
        gr2.addColorStop(0.4, "rgba(255,230,160," + (0.5 * (1 - k)) + ")");
        gr2.addColorStop(1, "rgba(255,200,100,0)");
        g.fillStyle = gr2;
        g.fillRect(hx - r, hy - r, r * 2, r * 2);
        g.fillStyle = "rgba(220,235,255," + (1 - k) + ")";
        for (let d = 0; d < 6; d++) {
          const a = -Math.PI / 2 + (d - 2.5) * 0.4;
          const dist = (8 + k * 40) * s1;
          g.beginPath();
          g.arc(hx - f.dir * Math.cos(a) * dist * 0.5, hy + Math.sin(a) * dist, 1.6 * s1, 0, TAU);
          g.fill();
        }
      });

      /* front ropes, in front of the fighters' legs */
      ropes(front, -40, W + 40, H * 0.1, 1);

      /* light cones from the rig above */
      g.globalCompositeOperation = "screen";
      [0.3, 0.7].forEach((cx) => {
        gr = g.createLinearGradient(0, 0, 0, H * 0.8);
        gr.addColorStop(0, "rgba(255,250,230,.16)");
        gr.addColorStop(1, "rgba(255,250,230,0)");
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(W * cx - 14, 0);
        g.lineTo(W * cx + 14, 0);
        g.lineTo(W * (cx + (cx < 0.5 ? 0.22 : -0.02)), H * 0.8);
        g.lineTo(W * (cx - (cx < 0.5 ? 0.02 : 0.22)), H * 0.8);
        g.closePath();
        g.fill();
      });
      g.globalCompositeOperation = "source-over";
      g.restore();

      /* haze hanging in the light beams over the ring */
    gr = g.createRadialGradient(W / 2, H * 0.38, 10, W / 2, H * 0.38, W * 0.6);
    gr.addColorStop(0, "rgba(200,210,255,.07)");
    gr.addColorStop(1, "rgba(200,210,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);

    /* vignette */
      gr = g.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.3, W / 2, H * 0.55, Math.max(W, H) * 0.75);
      gr.addColorStop(0, "rgba(0,0,0,0)");
      gr.addColorStop(1, "rgba(0,0,0,.6)");
      g.fillStyle = gr;
      g.fillRect(0, 0, W, H);
      /* film grain, shifting every frame, so it reads as camera footage rather than a drawing */
      if (!grain) grain = makeGrain();
      g.save();
      g.globalAlpha = 0.09;
      g.globalCompositeOperation = "overlay";
      g.translate(-Math.random() * 128, -Math.random() * 128);
      g.fillStyle = grain;
      g.fillRect(0, 0, W + 128, H + 128);
      g.restore();
    }

    let grain = null;
    function makeGrain() {
      const c = document.createElement("canvas");
      c.width = c.height = 128;
      const k = c.getContext("2d");
      const img = k.createImageData(128, 128);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
      k.putImageData(img, 0, 0);
      return g.createPattern(c, "repeat");
    }

    /* three ropes (red, white, blue) above an edge, with corner posts */
    function ropes(edge, x0, x1, step, scale) {
      const cols = [["#7a0710", "#e8202b"], ["#9aa0a8", "#ffffff"], ["#0b2a72", "#2f6bff"]];
      cols.forEach(([dark, lit], k) => {
        const y = edge - step * (k + 1);
        g.strokeStyle = dark;
        g.lineWidth = 5 * scale;
        g.beginPath();
        g.moveTo(x0, y);
        g.quadraticCurveTo((x0 + x1) / 2, y + 4 * scale, x1, y);
        g.stroke();
        g.strokeStyle = lit;
        g.lineWidth = 2.2 * scale;
        g.beginPath();
        g.moveTo(x0, y - 1.2 * scale);
        g.quadraticCurveTo((x0 + x1) / 2, y + 2.8 * scale, x1, y - 1.2 * scale);
        g.stroke();
      });
      [x0 + 6 * scale, x1 - 6 * scale].forEach((x) => {
        const top = edge - step * 3.4;
        const gr = g.createLinearGradient(x - 6 * scale, 0, x + 6 * scale, 0);
        gr.addColorStop(0, "#3a3f48");
        gr.addColorStop(0.4, "#d0d5dc");
        gr.addColorStop(1, "#2a2e35");
        g.fillStyle = gr;
        g.fillRect(x - 5 * scale, top, 10 * scale, edge - top);
        g.fillStyle = "#c8141f";
        g.fillRect(x - 8 * scale, top + step * 0.3, 16 * scale, step * 2.8);
      });
    }

    function star(x, y, r) {
      g.fillStyle = "#ffd60a";
      g.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        const rr = k % 2 ? r * 0.45 : r;
        g[k ? "lineTo" : "moveTo"](x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
    }

    resize();
    return { draw };
  }

  global.VBKnockoutArt = { create };
})(window);
