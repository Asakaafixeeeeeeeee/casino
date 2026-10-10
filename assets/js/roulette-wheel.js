/* Roulette — the wheel: a 13-pocket mini-roulette wheel in polished wood and brass, seen tilted for depth, drawn on a
   canvas at the screen's resolution. The bowl and rotor are painted once to offscreen canvases; each frame turns the
   rotor and rolls the ball. spin(n) plays a spin that ends with the ball in pocket n (the game has already drawn n).
   API: VBRouletteWheel.create(canvas, { onTick, reduceMotion }) → { spin(n) → Promise, idle() } */
(function (global) {
  "use strict";

  const TAU = Math.PI * 2;
  /* pocket order round the wheel, colours alternating red/black after the 0 */
  const ORDER = [0, 1, 8, 3, 10, 5, 2, 9, 6, 7, 4, 12, 11];
  const RED = new Set([1, 3, 5, 7, 9, 12]);
  const N = ORDER.length;
  const SEG = TAU / N;
  const TILT = 0.6;        /* how flat the wheel looks: 1 = straight down from above */

  const colorOf = (n) => (n === 0 ? "green" : RED.has(n) ? "red" : "black");

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

  function brass(g, x0, y0, x1, y1) {
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, "#fff1b8");
    gr.addColorStop(0.25, "#d9a93b");
    gr.addColorStop(0.5, "#7a5210");
    gr.addColorStop(0.72, "#f3cd6a");
    gr.addColorStop(1, "#8d6114");
    return gr;
  }

  /* polished wood: a warm base, concentric grain, flecks, and a lacquer sheen */
  function woodRing(g, R0, R1, base, seed) {
    const r = rng(seed);
    g.save();
    g.beginPath();
    g.arc(0, 0, R1, 0, TAU);
    g.arc(0, 0, R0, 0, TAU, true);
    g.clip("evenodd");
    const gr = g.createRadialGradient(0, 0, R0, 0, 0, R1);
    gr.addColorStop(0, base[0]);
    gr.addColorStop(0.5, base[1]);
    gr.addColorStop(1, base[2]);
    g.fillStyle = gr;
    g.fillRect(-R1, -R1, R1 * 2, R1 * 2);
    for (let i = 0; i < 90; i++) {
      const rad = R0 + r() * (R1 - R0);
      const a0 = r() * TAU, len = 0.4 + r() * 2.2;
      g.beginPath();
      g.arc(0, 0, rad, a0, a0 + len);
      g.strokeStyle = r() < 0.5 ? "rgba(40,15,0," + (0.12 + r() * 0.2).toFixed(2) + ")" : "rgba(255,200,140," + (0.05 + r() * 0.08).toFixed(2) + ")";
      g.lineWidth = 0.4 + r() * 1.4;
      g.stroke();
    }
    /* lacquer: a broad soft sheen from the top left */
    const sh = g.createLinearGradient(-R1, -R1, R1, R1);
    sh.addColorStop(0, "rgba(255,235,200,.32)");
    sh.addColorStop(0.4, "rgba(255,235,200,.04)");
    sh.addColorStop(0.6, "rgba(0,0,0,.05)");
    sh.addColorStop(1, "rgba(0,0,0,.35)");
    g.fillStyle = sh;
    g.fillRect(-R1, -R1, R1 * 2, R1 * 2);
    g.restore();
  }

  function create(canvas, opts) {
    const o = opts || {};
    const g = canvas.getContext("2d");
    let W = 0, H = 0, px = 1, R = 100, cx = 0, cy = 0;
    let bowl = null, rotor = null;

    let rotorA = 0;           /* rotor angle */
    let ball = null;          /* { a: absolute angle, r: radius as a fraction of R } or null when not on the wheel */
    let anim = null;
    let lastTick = 0;

    /* ---------------- painting the parts ---------------- */
    function paintBowl(D) {
      const c = document.createElement("canvas");
      c.width = c.height = Math.round(D * px);
      const b = c.getContext("2d");
      b.scale(px, px);
      b.translate(D / 2, D / 2);
      const Rr = D / 2;
      /* outer rim, then the ball track sloping in */
      woodRing(b, Rr * 0.86, Rr, ["#5a2a0c", "#8a4a1c", "#3a1606"], 3);
      b.beginPath();
      b.arc(0, 0, Rr * 0.86, 0, TAU);
      b.strokeStyle = brass(b, -Rr, -Rr, Rr, Rr);
      b.lineWidth = Rr * 0.018;
      b.stroke();
      woodRing(b, Rr * 0.72, Rr * 0.86, ["#2a0f04", "#4a200a", "#1a0802"], 9);
      /* the track's polished lip */
      b.beginPath();
      b.arc(0, 0, Rr * 0.845, Math.PI * 0.9, Math.PI * 1.7);
      b.strokeStyle = "rgba(255,230,190,.35)";
      b.lineWidth = Rr * 0.01;
      b.stroke();
      /* brass deflectors on the track */
      for (let i = 0; i < 8; i++) {
        const a = (i * TAU) / 8 + 0.2;
        b.save();
        b.rotate(a);
        b.translate(Rr * 0.765, 0);
        b.beginPath();
        b.moveTo(-Rr * 0.025, 0);
        b.lineTo(0, -Rr * 0.012);
        b.lineTo(Rr * 0.025, 0);
        b.lineTo(0, Rr * 0.012);
        b.closePath();
        b.fillStyle = brass(b, -Rr * 0.03, -Rr * 0.01, Rr * 0.03, Rr * 0.01);
        b.fill();
        b.restore();
      }
      return c;
    }

    function paintRotor(D) {
      const c = document.createElement("canvas");
      c.width = c.height = Math.round(D * px);
      const r = c.getContext("2d");
      r.scale(px, px);
      r.translate(D / 2, D / 2);
      const Rr = D / 2;   /* = 0.72 of the wheel */
      const outer = Rr, numIn = Rr * 0.8, pockIn = Rr * 0.64;
      const fill = { red: ["#e0242f", "#8e0d14"], black: ["#2b2b2e", "#08080a"], green: ["#16a34a", "#06451e"] };
      ORDER.forEach((n, i) => {
        const a = -Math.PI / 2 + i * SEG;
        const [c0, c1] = fill[colorOf(n)];
        /* the number band */
        r.beginPath();
        r.arc(0, 0, outer, a - SEG / 2, a + SEG / 2);
        r.arc(0, 0, numIn, a + SEG / 2, a - SEG / 2, true);
        r.closePath();
        let gr = r.createRadialGradient(0, 0, numIn, 0, 0, outer);
        gr.addColorStop(0, c1);
        gr.addColorStop(0.6, c0);
        gr.addColorStop(1, c1);
        r.fillStyle = gr;
        r.fill();
        /* the pocket floor: deeper, shadowed toward the outside wall */
        r.beginPath();
        r.arc(0, 0, numIn, a - SEG / 2, a + SEG / 2);
        r.arc(0, 0, pockIn, a + SEG / 2, a - SEG / 2, true);
        r.closePath();
        gr = r.createRadialGradient(0, 0, pockIn, 0, 0, numIn);
        gr.addColorStop(0, c0);
        gr.addColorStop(0.7, c1);
        gr.addColorStop(1, "#000");
        r.fillStyle = gr;
        r.fill();
        /* the number, reading outward */
        r.save();
        r.rotate(a + Math.PI / 2);
        r.fillStyle = "#fff";
        r.font = "800 " + Rr * 0.12 + "px Georgia, 'Times New Roman', serif";
        r.textAlign = "center";
        r.textBaseline = "middle";
        r.shadowColor = "rgba(0,0,0,.6)";
        r.shadowBlur = 2 * px;
        r.fillText(String(n), 0, -(outer + numIn) / 2);
        r.restore();
      });
      /* frets: chrome dividers between pockets, and the rings */
      for (let i = 0; i < N; i++) {
        const a = -Math.PI / 2 + i * SEG + SEG / 2;
        r.beginPath();
        r.moveTo(Math.cos(a) * pockIn, Math.sin(a) * pockIn);
        r.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
        r.strokeStyle = "#e9edf2";
        r.lineWidth = Rr * 0.016;
        r.stroke();
        r.strokeStyle = "rgba(0,0,0,.5)";
        r.lineWidth = Rr * 0.005;
        r.stroke();
      }
      [[outer, 0.02], [numIn, 0.014], [pockIn, 0.02]].forEach(([rad, w]) => {
        r.beginPath();
        r.arc(0, 0, rad, 0, TAU);
        r.strokeStyle = brass(r, -Rr, -Rr, Rr, Rr);
        r.lineWidth = Rr * w;
        r.stroke();
      });
      /* the cone, rising to the turret */
      woodRing(r, Rr * 0.16, pockIn - Rr * 0.01, ["#c27a3e", "#8a4a1c", "#4a200a"], 21);
      const cone = r.createRadialGradient(-Rr * 0.12, -Rr * 0.14, Rr * 0.05, 0, 0, pockIn);
      cone.addColorStop(0, "rgba(255,220,170,.35)");
      cone.addColorStop(1, "rgba(0,0,0,.35)");
      r.fillStyle = cone;
      r.beginPath();
      r.arc(0, 0, pockIn - Rr * 0.01, 0, TAU);
      r.fill();
      /* turret: a brass dome with a four-armed handle */
      for (let k = 0; k < 4; k++) {
        r.save();
        r.rotate((k * TAU) / 4 + Math.PI / 4);
        r.fillStyle = brass(r, 0, -Rr * 0.03, 0, Rr * 0.03);
        r.beginPath();
        r.roundRect(0, -Rr * 0.025, Rr * 0.34, Rr * 0.05, Rr * 0.025);
        r.fill();
        const bx = Rr * 0.36;
        const bg = r.createRadialGradient(bx - Rr * 0.015, -Rr * 0.015, 0, bx, 0, Rr * 0.05);
        bg.addColorStop(0, "#fff6d0");
        bg.addColorStop(0.5, "#d9a93b");
        bg.addColorStop(1, "#5a3a08");
        r.fillStyle = bg;
        r.beginPath();
        r.arc(bx, 0, Rr * 0.05, 0, TAU);
        r.fill();
        r.restore();
      }
      const dome = r.createRadialGradient(-Rr * 0.04, -Rr * 0.05, 0, 0, 0, Rr * 0.14);
      dome.addColorStop(0, "#fff6d0");
      dome.addColorStop(0.45, "#d9a93b");
      dome.addColorStop(1, "#4a3006");
      r.fillStyle = dome;
      r.beginPath();
      r.arc(0, 0, Rr * 0.13, 0, TAU);
      r.fill();
      return c;
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      px = Math.min(2.5, global.devicePixelRatio || 1);
      W = rect.width;
      H = rect.height;
      canvas.width = Math.round(W * px);
      canvas.height = Math.round(H * px);
      R = Math.min(W / 2 - 6, (H - 30) / (2 * TILT + 0.16));
      cx = W / 2;
      cy = H / 2 - R * 0.05;
      bowl = paintBowl(R * 2);
      rotor = paintRotor(R * 2 * 0.72);
    }

    /* ---------------- each frame ---------------- */
    function draw() {
      if (!bowl) return;
      g.setTransform(px, 0, 0, px, 0, 0);
      g.clearRect(0, 0, W, H);
      const depth = R * 0.14;
      /* the shadow on the table, then the wheel's wooden side */
      g.save();
      g.translate(cx, cy + depth);
      g.scale(1, TILT);
      const sh = g.createRadialGradient(0, R * 0.2, R * 0.6, 0, R * 0.2, R * 1.15);
      sh.addColorStop(0, "rgba(0,0,0,.55)");
      sh.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = sh;
      g.beginPath();
      g.arc(0, R * 0.2, R * 1.15, 0, TAU);
      g.fill();
      g.restore();
      g.save();
      g.translate(cx, cy);
      g.beginPath();
      g.ellipse(0, 0, R, R * TILT, 0, 0, Math.PI);
      g.lineTo(-R, depth);
      g.ellipse(0, depth, R, R * TILT, 0, Math.PI, 0, true);
      g.closePath();
      const side = g.createLinearGradient(-R, 0, R, 0);
      side.addColorStop(0, "#1e0a02");
      side.addColorStop(0.35, "#6a3212");
      side.addColorStop(0.5, "#8a4a1c");
      side.addColorStop(1, "#1e0a02");
      g.fillStyle = side;
      g.fill();
      g.strokeStyle = brass(g, -R, 0, R, 0);
      g.lineWidth = 2;
      g.beginPath();
      g.ellipse(0, depth * 0.5, R, R * TILT, 0, 0.05, Math.PI - 0.05);
      g.stroke();
      /* the top: the bowl, then the rotor turned to its angle */
      g.scale(1, TILT);
      g.drawImage(bowl, -R, -R, R * 2, R * 2);
      const rr = R * 0.72;
      g.save();
      g.rotate(rotorA);
      g.drawImage(rotor, -rr, -rr, rr * 2, rr * 2);
      g.restore();
      /* overhead light: a soft glare across the far side */
      const glare = g.createRadialGradient(-R * 0.3, -R * 0.55, 0, -R * 0.3, -R * 0.55, R * 0.9);
      glare.addColorStop(0, "rgba(255,245,225,.16)");
      glare.addColorStop(1, "rgba(255,245,225,0)");
      g.fillStyle = glare;
      g.beginPath();
      g.arc(0, 0, R, 0, TAU);
      g.fill();
      g.restore();

      /* the ball: drawn round (not squashed), with its contact shadow */
      if (ball) {
        const bx = cx + Math.cos(ball.a) * ball.r * R;
        const by = cy + Math.sin(ball.a) * ball.r * R * TILT;
        const br = R * 0.032;
        g.fillStyle = "rgba(0,0,0,.45)";
        g.beginPath();
        g.ellipse(bx + br * 0.3, by + br * 0.55, br * 1.05, br * 0.55, 0, 0, TAU);
        g.fill();
        const bg = g.createRadialGradient(bx - br * 0.35, by - br * 0.4, br * 0.1, bx, by, br);
        bg.addColorStop(0, "#ffffff");
        bg.addColorStop(0.6, "#e3e6ea");
        bg.addColorStop(1, "#8a9099");
        g.fillStyle = bg;
        g.beginPath();
        g.arc(bx, by, br, 0, TAU);
        g.fill();
      }
    }

    let t0 = performance.now();
    function frame(now) {
      const dt = Math.min(0.05, (now - t0) / 1000);
      t0 = now;
      if (anim) anim(now);
      else rotorA += dt * 0.25;   /* idle: the rotor turns slowly */
      draw();
      requestAnimationFrame(frame);
    }

    /* ---------------- a spin ---------------- */
    /* the rotor spins one way and slows; the ball runs the other way round the track, loses speed, spirals in,
       bounces over a few frets and settles in pocket n, then rides the rotor round */
    function spin(n) {
      const idx = ORDER.indexOf(n);
      const pocketA = -Math.PI / 2 + idx * SEG;   /* the pocket's angle on the rotor */
      const T = o.reduceMotion ? 1500 : 7000;     /* rotor slowing */
      const TB = o.reduceMotion ? 1100 : 5200;    /* the ball's run, until it sits in the pocket */
      const start = performance.now();
      const w0 = rotorA;
      const wTurns = TAU * 3.2;                   /* how far the rotor turns in T */
      const wheelAt = (t) => w0 + wTurns * (1 - Math.pow(1 - Math.min(1, t / T), 2.2));
      /* the ball relative to the rotor: it starts somewhere, runs backwards ~9 turns, and ends exactly on the pocket */
      const rel0 = Math.random() * TAU;
      let run = rel0 - pocketA;
      run = ((run % TAU) + TAU) % TAU + TAU * 9;
      const relAt = (t) => rel0 - run * (1 - Math.pow(1 - Math.min(1, t / TB), 3));
      return new Promise((resolve) => {
        let told = false;
        anim = (now) => {
          const t = now - start;
          rotorA = wheelAt(t);
          const k = t / TB;
          /* radius: on the track, then dropping in over the last 30%, hopping over frets */
          let r = 0.8;
          if (k > 0.7) {
            const d = Math.min(1, (k - 0.7) / 0.3);
            r = 0.8 - 0.21 * d + Math.abs(Math.sin(d * Math.PI * 3)) * 0.05 * (1 - d);
            if (o.onTick && now - lastTick > 90 + d * 120 && d < 0.95) {
              lastTick = now;
              o.onTick(1 - d);
            }
          }
          ball = { a: rotorA + relAt(t), r };
          /* the ball has settled: the result can show while the rotor slows on */
          if (!told && t >= TB + 400) {
            told = true;
            resolve();
          }
          if (t >= T) rest(pocketA);
        };
      });
    }

    /* idle with the ball sitting in its pocket */
    function rest(pocketA) {
      anim = () => {
        rotorA += 0.004;
        ball = { a: rotorA + pocketA, r: 0.59 };
      };
    }

    /* back to an empty wheel turning slowly */
    function idle() {
      anim = null;
      ball = null;
    }

    new ResizeObserver(resize).observe(canvas);
    resize();
    requestAnimationFrame(frame);
    return { spin, idle, ORDER, colorOf };
  }

  global.VBRouletteWheel = { create, ORDER, RED, colorOf };
})(window);
