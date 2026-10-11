/* Game splash screen — shown the moment a game page opens: the game's picture (its tile art from data.js) on a
   blurred copy of itself, the game's name, the WIN B casino mark and a loading bar. It fades into the game once the page
   has loaded (and at least SHOW_MS has passed, so it never just flickers); a tap skips it.
   Loaded in <head> right after data.js, before the page body exists, so the game never shows through first. */
(function () {
  "use strict";
  const VB = window.VB;
  const page = (location.pathname.split("/").pop() || "").toLowerCase();
  const game = VB && (VB.allGames || VB.games).find((g) => g.page === page);
  if (!game) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SHOW_MS = reduce ? 500 : 1900;   /* the least time it stays up */
  const GIVE_UP_MS = 7000;               /* never hold the game back longer than this */
  const FADE_MS = reduce ? 0 : 520;
  const t0 = performance.now();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const css = document.createElement("style");
  css.textContent = `
    html.vb-splashing, html.vb-splashing body { overflow: hidden; }
    .vb-splash {
      position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; overflow: hidden;
      background: #07070c; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      transition: opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease; cursor: pointer;
    }
    .vb-splash.out { opacity: 0; transform: scale(1.04); pointer-events: none; }
    .vb-splash-bg {
      position: absolute; inset: -10%; background-position: center; background-size: cover;
      filter: blur(38px) brightness(.45) saturate(1.3); transform: scale(1.1);
      animation: vb-splash-drift 8s ease-in-out infinite alternate;
    }
    .vb-splash-bg.hue {
      filter: none;
      background: radial-gradient(70% 60% at 50% 35%, hsl(var(--h) 90% 45% / .55), transparent 70%), linear-gradient(160deg, hsl(var(--h) 60% 18%), #05050a);
    }
    .vb-splash::after { content: ""; position: absolute; inset: 0; background: radial-gradient(80% 70% at 50% 45%, transparent 40%, rgba(0,0,0,.7)); pointer-events: none; }
    @keyframes vb-splash-drift { to { transform: scale(1.18) translate(2%, -2%); } }
    .vb-splash-in { position: relative; z-index: 1; display: grid; justify-items: center; gap: 18px; width: min(86vw, 360px); text-align: center; }
    .vb-splash-mark { display: flex; align-items: center; gap: 8px; font-weight: 900; font-style: italic; letter-spacing: .12em; font-size: .78rem; color: #ffd60a; opacity: .9; }
    .vb-splash-mark img { width: 22px; height: 22px; }
    .vb-splash-art {
      position: relative; width: min(68vw, 300px); aspect-ratio: 1; border-radius: 28px; overflow: hidden;
      box-shadow: 0 0 0 1px rgba(255,255,255,.18), 0 24px 60px rgba(0,0,0,.65), 0 0 70px var(--glow, rgba(255,200,80,.35));
      animation: vb-splash-pop .7s cubic-bezier(.2, 1.3, .4, 1) both, vb-splash-float 3.2s ease-in-out .7s infinite alternate;
    }
    .vb-splash-art img { display: block; width: 100%; height: 100%; object-fit: cover; }
    .vb-splash-art .emoji {
      display: grid; place-items: center; width: 100%; height: 100%; font-size: 7rem;
      background: radial-gradient(80% 70% at 30% 20%, hsl(var(--h) 95% 62% / .75), transparent 62%), linear-gradient(160deg, hsl(var(--h) 60% 26%), hsl(var(--h) 60% 9%));
    }
    /* a sheen sweeping across the picture */
    .vb-splash-art::after {
      content: ""; position: absolute; inset: 0; transform: translateX(-120%);
      background: linear-gradient(105deg, transparent 35%, rgba(255,255,255,.35) 50%, transparent 65%);
      animation: vb-splash-sheen 2.4s ease-in-out .6s infinite;
    }
    @keyframes vb-splash-pop { from { opacity: 0; transform: scale(.7); } to { opacity: 1; transform: none; } }
    @keyframes vb-splash-float { to { transform: translateY(-8px); } }
    @keyframes vb-splash-sheen { 55%, 100% { transform: translateX(120%); } }
    .vb-splash-name { margin: 0; font-size: 1.5rem; font-weight: 900; letter-spacing: .02em; text-shadow: 0 2px 12px rgba(0,0,0,.6); animation: vb-splash-up .6s ease .25s both; }
    @keyframes vb-splash-up { from { opacity: 0; transform: translateY(10px); } }
    .vb-splash-bar { width: 100%; height: 6px; border-radius: 999px; background: rgba(255,255,255,.14); overflow: hidden; }
    .vb-splash-bar i { display: block; width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #ffb703, #ffd60a, #fff3b0); box-shadow: 0 0 12px rgba(255,214,10,.8); }
    .vb-splash-row { display: flex; justify-content: space-between; width: 100%; margin-top: -10px; font-size: .74rem; font-weight: 700; color: rgba(255,255,255,.6); letter-spacing: .06em; }
    .vb-splash-note { position: absolute; z-index: 1; left: 0; right: 0; bottom: calc(18px + env(safe-area-inset-bottom, 0px)); text-align: center; font-size: .7rem; color: rgba(255,255,255,.45); }
    @media (prefers-reduced-motion: reduce) { .vb-splash *, .vb-splash::after { animation: none !important; } }
  `;
  document.head.appendChild(css);

  const root = document.createElement("div");
  root.className = "vb-splash";
  root.setAttribute("role", "status");
  root.setAttribute("aria-label", "Loading " + game.name);
  root.style.setProperty("--h", game.hue);
  root.innerHTML =
    '<div class="vb-splash-bg' + (game.thumb ? '" style="background-image:url(' + esc(game.thumb) + ')"' : ' hue"') + "></div>" +
    '<div class="vb-splash-in">' +
      '<div class="vb-splash-mark"><img src="assets/img/winb-mark.svg" alt="">WIN B CASINO</div>' +
      '<div class="vb-splash-art" style="--glow:hsl(' + game.hue + ' 90% 55% / .45)">' +
        (game.thumb ? '<img src="' + esc(game.thumb) + '" alt="">' : '<span class="emoji" aria-hidden="true">' + game.icon + "</span>") +
      "</div>" +
      '<h2 class="vb-splash-name">' + esc(game.name) + "</h2>" +
      '<div class="vb-splash-bar"><i></i></div>' +
      '<div class="vb-splash-row"><span class="vb-splash-msg">Loading…</span><span class="vb-splash-pct">0%</span></div>' +
    "</div>" +
    '<div class="vb-splash-note">Tap to skip</div>';
  document.documentElement.classList.add("vb-splashing");
  document.documentElement.appendChild(root);

  const bar = root.querySelector(".vb-splash-bar i");
  const pct = root.querySelector(".vb-splash-pct");
  const msg = root.querySelector(".vb-splash-msg");
  let loaded = document.readyState === "complete";
  let shown = 0;
  let gone = false;
  window.addEventListener("load", () => (loaded = true), { once: true });

  /* the bar eases toward 90% while the page loads, then fills to 100% */
  (function tick() {
    if (gone) return;
    const t = performance.now() - t0;
    const target = loaded ? 100 : 90 * (1 - Math.exp(-t / 900));
    const timeCap = Math.min(100, (t / SHOW_MS) * 100);   /* never runs ahead of the minimum show time */
    shown += (Math.min(target, timeCap) - shown) * 0.12;
    if (loaded && t >= SHOW_MS) shown = Math.max(shown, 99.5);
    bar.style.width = shown.toFixed(1) + "%";
    pct.textContent = Math.round(shown) + "%";
    if (loaded && t >= SHOW_MS && shown >= 99.5) {
      msg.textContent = "Ready!";
      return finish();
    }
    if (t > GIVE_UP_MS) return finish();
    requestAnimationFrame(tick);
  })();

  function finish() {
    if (gone) return;
    gone = true;
    bar.style.width = "100%";
    pct.textContent = "100%";
    root.classList.add("out");
    setTimeout(() => {
      root.remove();
      document.documentElement.classList.remove("vb-splashing");
    }, FADE_MS + 30);
  }
  root.addEventListener("click", finish);
})();
