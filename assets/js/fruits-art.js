/* Blaze Fruits — the art: the eight symbols as SVG (data URLs), each a glossy, lit fruit with a warm rim light, plus
   the ember canvas behind the reels. API: VBFruitsArt.symbols() → { seven, watermelon, … } (data URLs),
   VBFruitsArt.embers(canvas) → { stop }. */
(function (root) {
  "use strict";
  const url = (svg) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  const wrap = (defs, body) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">' +
    "<defs>" + defs +
    '<filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>' +
    '<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.2"/></filter>' +
    "</defs>" + body + "</svg>";
  /* a drop shadow and a warm rim under every symbol */
  const shadow = '<ellipse cx="60" cy="104" rx="34" ry="7" fill="rgba(0,0,0,.45)" filter="url(#soft)"/>';

  const seven = wrap(
    '<linearGradient id="s7" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8a80"/><stop offset=".3" stop-color="#ff1f2e"/><stop offset=".7" stop-color="#b3000f"/><stop offset="1" stop-color="#6a0008"/></linearGradient>' +
    '<linearGradient id="s7g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff2b0"/><stop offset=".5" stop-color="#f4b63a"/><stop offset="1" stop-color="#9c5e08"/></linearGradient>' +
    '<linearGradient id="s7h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>',
    shadow +
    '<path d="M26 20h70l-32 86H42l26-70H26z" fill="url(#s7g)" transform="translate(0 4)" opacity=".9"/>' +
    '<path d="M26 16h70l-32 86H42l26-70H26z" fill="url(#s7g)"/>' +
    '<path d="M31 21h58l-28 76H49l24-62H31z" fill="url(#s7)" stroke="#5a0008" stroke-width="1.5"/>' +
    '<path d="M33 23h54l-5 12H38z" fill="url(#s7h)"/>' +
    '<path d="M34 25h50" stroke="#fff" stroke-opacity=".5" stroke-width="2" stroke-linecap="round"/>'
  );

  const star = wrap(
    '<radialGradient id="st" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#fff8c8"/><stop offset=".4" stop-color="#ffd23c"/><stop offset=".8" stop-color="#e58f00"/><stop offset="1" stop-color="#8a4d00"/></radialGradient>' +
    '<radialGradient id="stg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#ffd23c" stop-opacity=".55"/><stop offset="1" stop-color="#ffd23c" stop-opacity="0"/></radialGradient>',
    '<circle cx="60" cy="60" r="56" fill="url(#stg)"/>' +
    '<path d="M60 10l14.5 31.5L109 46l-25 23.5 6.5 34.5L60 87.5 29.5 104 36 69.5 11 46l34.5-4.5z" fill="url(#st)" stroke="#7a4200" stroke-width="2" stroke-linejoin="round" filter="url(#glow)"/>' +
    '<path d="M60 22l9 20-19 1z" fill="#fff" opacity=".45"/>'
  );

  const watermelon = wrap(
    '<linearGradient id="wm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6b7a"/><stop offset=".55" stop-color="#e8203a"/><stop offset="1" stop-color="#9b0a20"/></linearGradient>' +
    '<linearGradient id="wr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8fe36b"/><stop offset=".5" stop-color="#2f9a2c"/><stop offset="1" stop-color="#0f5a14"/></linearGradient>',
    shadow +
    '<path d="M10 44a50 50 0 0 0 100 0z" fill="url(#wr)"/>' +
    '<path d="M18 44a42 42 0 0 0 84 0z" fill="#f2f7d8"/>' +
    '<path d="M23 44a37 37 0 0 0 74 0z" fill="url(#wm)"/>' +
    '<g fill="#1d1313"><ellipse cx="45" cy="56" rx="2.6" ry="4" transform="rotate(-20 45 56)"/><ellipse cx="60" cy="66" rx="2.6" ry="4"/><ellipse cx="75" cy="56" rx="2.6" ry="4" transform="rotate(20 75 56)"/><ellipse cx="52" cy="50" rx="2" ry="3.2" transform="rotate(-30 52 50)"/><ellipse cx="68" cy="50" rx="2" ry="3.2" transform="rotate(30 68 50)"/></g>' +
    '<path d="M30 48c8 10 18 16 30 18" stroke="#fff" stroke-opacity=".35" stroke-width="3" fill="none" stroke-linecap="round"/>'
  );

  const grapes = wrap(
    '<radialGradient id="gp" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#c79cff"/><stop offset=".45" stop-color="#7a2fd6"/><stop offset="1" stop-color="#2e0b63"/></radialGradient>' +
    '<linearGradient id="gl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8fe36b"/><stop offset="1" stop-color="#1e6b1c"/></linearGradient>',
    shadow +
    '<path d="M60 10c4 6 4 14 0 22" stroke="#6b3b12" stroke-width="4" fill="none" stroke-linecap="round"/>' +
    '<path d="M62 20c12-10 26-6 30 6-12 6-24 2-30-6z" fill="url(#gl)"/>' +
    [[44, 40], [60, 36], [76, 40], [36, 56], [52, 54], [68, 54], [84, 56], [44, 70], [60, 70], [76, 70], [52, 85], [68, 85], [60, 98]]
      .map(([x, y]) => '<circle cx="' + x + '" cy="' + y + '" r="10" fill="url(#gp)" stroke="#1d0640" stroke-width=".8"/><circle cx="' + (x - 3) + '" cy="' + (y - 3.5) + '" r="2.6" fill="#fff" opacity=".55"/>').join("")
  );

  const plum = wrap(
    '<radialGradient id="pl" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#b48cff"/><stop offset=".45" stop-color="#5a1aa8"/><stop offset="1" stop-color="#1f0545"/></radialGradient>',
    shadow +
    '<path d="M60 14c3 6 3 12 0 18" stroke="#6b3b12" stroke-width="4" fill="none" stroke-linecap="round"/>' +
    '<path d="M62 24c10-9 22-6 26 4-10 6-20 3-26-4z" fill="#3f9a2a"/>' +
    '<path d="M60 30c-24 0-36 18-36 38s16 34 36 34 36-14 36-34S84 30 60 30z" fill="url(#pl)" stroke="#170334" stroke-width="1.2"/>' +
    '<path d="M60 32c-4 12-4 48 0 70" stroke="#2a0a52" stroke-opacity=".6" stroke-width="2.5" fill="none"/>' +
    '<ellipse cx="46" cy="50" rx="8" ry="12" fill="#fff" opacity=".28" transform="rotate(-20 46 50)"/>'
  );

  const orange = wrap(
    '<radialGradient id="or" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#ffd27a"/><stop offset=".45" stop-color="#ff8a00"/><stop offset="1" stop-color="#9a3d00"/></radialGradient>' +
    '<pattern id="orp" width="4" height="4" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r=".7" fill="#000" opacity=".12"/></pattern>',
    shadow +
    '<circle cx="60" cy="64" r="40" fill="url(#or)" stroke="#6a2600" stroke-width="1.2"/>' +
    '<circle cx="60" cy="64" r="40" fill="url(#orp)"/>' +
    '<path d="M56 24c-10-10-24-8-30 4 12 6 22 4 30-4z" fill="#3f9a2a"/>' +
    '<circle cx="60" cy="26" r="3.5" fill="#6b3b12"/>' +
    '<ellipse cx="46" cy="48" rx="9" ry="12" fill="#fff" opacity=".3" transform="rotate(-25 46 48)"/>'
  );

  const lemon = wrap(
    '<radialGradient id="le" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#fff8a8"/><stop offset=".45" stop-color="#ffd400"/><stop offset="1" stop-color="#a87a00"/></radialGradient>',
    shadow +
    '<path d="M22 64c0-22 16-36 38-36s38 14 38 36-16 36-38 36S22 86 22 64z" fill="url(#le)" stroke="#7a5400" stroke-width="1.2" transform="rotate(-18 60 64)"/>' +
    '<path d="M92 40l10-6-4 12z" fill="#e3b800"/><path d="M28 86l-10 6 4-12z" fill="#e3b800"/>' +
    '<path d="M72 28c-8-12-24-10-30 2 12 5 22 2 30-2z" fill="#3f9a2a"/>' +
    '<ellipse cx="44" cy="52" rx="9" ry="12" fill="#fff" opacity=".35" transform="rotate(-25 44 52)"/>'
  );

  const cherry = wrap(
    '<radialGradient id="ch" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#ff8c99"/><stop offset=".45" stop-color="#e3112d"/><stop offset="1" stop-color="#5c0010"/></radialGradient>',
    shadow +
    '<path d="M40 76C44 50 56 30 76 16" stroke="#5e3410" stroke-width="4" fill="none" stroke-linecap="round"/>' +
    '<path d="M84 72C82 48 80 30 76 16" stroke="#5e3410" stroke-width="4" fill="none" stroke-linecap="round"/>' +
    '<path d="M76 16c12-6 26 0 30 12-14 4-24 0-30-12z" fill="#3f9a2a"/>' +
    '<circle cx="40" cy="82" r="20" fill="url(#ch)" stroke="#3a0008" stroke-width="1.2"/>' +
    '<circle cx="84" cy="78" r="20" fill="url(#ch)" stroke="#3a0008" stroke-width="1.2"/>' +
    '<ellipse cx="33" cy="74" rx="5" ry="7" fill="#fff" opacity=".45" transform="rotate(-25 33 74)"/>' +
    '<ellipse cx="77" cy="70" rx="5" ry="7" fill="#fff" opacity=".45" transform="rotate(-25 77 70)"/>'
  );

  const cache = {};
  function symbols() {
    if (!cache.seven) Object.assign(cache, { seven: url(seven), star: url(star), watermelon: url(watermelon), grapes: url(grapes), plum: url(plum), orange: url(orange), lemon: url(lemon), cherry: url(cherry) });
    return cache;
  }

  /* embers drifting up behind the reels: small warm sparks on the crimson backdrop */
  function embers(canvas) {
    const ctx = canvas.getContext("2d");
    let w = 0, h = 0, raf = 0, last = 0;
    const sparks = [];
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const resize = () => {
      const r = window.devicePixelRatio > 1 ? 1.5 : 1;
      w = canvas.width = Math.floor(canvas.clientWidth * r);
      h = canvas.height = Math.floor(canvas.clientHeight * r);
    };
    const spawn = () => sparks.push({ x: Math.random() * w, y: h + 10, r: 1 + Math.random() * 2.2, vy: 18 + Math.random() * 30, vx: (Math.random() - 0.5) * 12, life: 0, max: 5 + Math.random() * 5, hue: 20 + Math.random() * 25 });
    const frame = (t) => {
      const dt = Math.min(0.05, (t - last) / 1000 || 0.016);
      last = t;
      ctx.clearRect(0, 0, w, h);
      if (sparks.length < 70 && Math.random() < 0.5) spawn();
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.life += dt;
        s.y -= s.vy * dt;
        s.x += (s.vx + Math.sin(s.life * 3 + s.r) * 8) * dt;
        const a = Math.min(1, s.life * 2) * Math.max(0, 1 - s.life / s.max);
        if (a <= 0 || s.y < -10) { sparks.splice(i, 1); continue; }
        ctx.beginPath();
        ctx.fillStyle = "hsla(" + s.hue + ", 100%, 62%, " + (a * 0.9).toFixed(3) + ")";
        ctx.shadowColor = "hsla(" + s.hue + ", 100%, 55%, .9)";
        ctx.shadowBlur = 8;
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    resize();
    window.addEventListener("resize", resize);
    if (!reduce) raf = requestAnimationFrame(frame);
    return { stop() { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); } };
  }

  root.VBFruitsArt = { symbols, embers };
})(window);
