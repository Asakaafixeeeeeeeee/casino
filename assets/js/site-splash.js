/* The site's splash screen — shown the moment RendoWin opens: the R mark pulsing on a dark gold-lit backdrop, the
   wordmark, a line about the lobby and a loading bar. It fades into the home page once the page has loaded (and at
   least SHOW_MS has passed, so it never just flickers); a tap skips it. Shown once per visit: moving between pages
   or coming back within the session doesn't repeat it.
   Loaded in <head> before the page body exists, so the lobby never shows through first. */
(function () {
  "use strict";
  const KEY = "vb.splash.seen";
  try {
    if (sessionStorage.getItem(KEY)) return;
    sessionStorage.setItem(KEY, "1");
  } catch (e) { /* storage unavailable: show it anyway */ }

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const SHOW_MS = reduce ? 500 : 1700;
  const GIVE_UP_MS = 7000;
  const FADE_MS = reduce ? 0 : 520;
  const t0 = performance.now();

  const css = document.createElement("style");
  css.textContent = `
    html.vb-splashing, html.vb-splashing body { overflow: hidden; }
    .vb-site-splash {
      position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; overflow: hidden;
      background: radial-gradient(50% 40% at 50% 42%, rgba(255, 204, 0, .2), transparent 70%), radial-gradient(120% 90% at 50% 100%, rgba(255, 106, 42, .18), transparent 60%), #07070c;
      color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      transition: opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease; cursor: pointer;
    }
    .vb-site-splash.out { opacity: 0; transform: scale(1.04); pointer-events: none; }
    .vb-site-splash::before {
      content: ""; position: absolute; inset: -20%; pointer-events: none;
      background: conic-gradient(from 0deg, transparent 0 40%, rgba(255, 214, 10, .08) 50%, transparent 60% 100%);
      animation: vb-ss-spin 9s linear infinite;
    }
    @keyframes vb-ss-spin { to { transform: rotate(360deg); } }
    .vb-site-splash::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(80% 70% at 50% 45%, transparent 40%, rgba(0, 0, 0, .75)); }
    .vb-ss-in { position: relative; z-index: 1; display: grid; justify-items: center; gap: 12px; width: min(60vw, 220px); text-align: center; }
    .vb-ss-mark {
      position: relative; width: min(22vw, 84px); aspect-ratio: 1; display: grid; place-items: center;
      animation: vb-ss-pop .7s cubic-bezier(.2, 1.3, .4, 1) both;
    }
    .vb-ss-mark::before {
      content: ""; position: absolute; inset: -18%; border-radius: 50%;
      background: radial-gradient(circle, rgba(255, 214, 10, .45), rgba(255, 214, 10, 0) 65%);
      animation: vb-ss-pulse 2.2s ease-in-out .7s infinite alternate;
    }
    .vb-ss-mark img { position: relative; width: 100%; height: 100%; filter: drop-shadow(0 10px 24px rgba(0, 0, 0, .7)); }
    @keyframes vb-ss-pop { from { opacity: 0; transform: scale(.6); } to { opacity: 1; transform: none; } }
    @keyframes vb-ss-pulse { from { transform: scale(.9); opacity: .7; } to { transform: scale(1.15); opacity: 1; } }
    .vb-ss-word { width: min(40vw, 150px); animation: vb-ss-up .6s ease both; }
    .vb-ss-word img { display: block; width: 100%; height: auto; filter: drop-shadow(0 4px 14px rgba(0, 0, 0, .7)); }
    .vb-ss-line { margin: -4px 0 4px; font-size: .62rem; font-weight: 700; letter-spacing: .2em; text-transform: uppercase; color: rgba(255, 236, 170, .78); animation: vb-ss-up .6s ease both; }
    @keyframes vb-ss-up { from { opacity: 0; transform: translateY(10px); } }
    .vb-ss-bar { width: 100%; height: 4px; border-radius: 999px; background: rgba(255, 255, 255, .14); overflow: hidden; }
    .vb-ss-bar i { display: block; width: 0; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #ffb703, #ffd60a, #fff3b0); box-shadow: 0 0 12px rgba(255, 214, 10, .8); }
    .vb-ss-row { display: flex; justify-content: space-between; width: 100%; margin-top: -6px; font-size: .64rem; font-weight: 700; color: rgba(255, 255, 255, .6); letter-spacing: .06em; }
    .vb-ss-note { position: absolute; z-index: 1; left: 0; right: 0; bottom: calc(18px + env(safe-area-inset-bottom, 0px)); text-align: center; font-size: .7rem; color: rgba(255, 255, 255, .45); }
    .vb-ss-age { position: absolute; z-index: 1; left: 0; right: 0; top: calc(16px + env(safe-area-inset-top, 0px)); text-align: center; font-size: .66rem; font-weight: 800; letter-spacing: .14em; color: rgba(255, 255, 255, .5); }
    @media (prefers-reduced-motion: reduce) { .vb-site-splash *, .vb-site-splash::before { animation: none !important; } }
  `;
  document.head.appendChild(css);

  const root = document.createElement("div");
  root.className = "vb-site-splash";
  root.setAttribute("role", "status");
  root.setAttribute("aria-label", "Loading RendoWin");
  root.innerHTML =
    '<div class="vb-ss-age">18+ · PLAY RESPONSIBLY</div>' +
    '<div class="vb-ss-in">' +
      '<div class="vb-ss-mark"><img src="assets/img/rendowin-mark.svg" alt=""></div>' +
      '<div class="vb-ss-word"><img src="assets/img/rendowin-wordmark.svg" alt="RendoWin"></div>' +
      '<p class="vb-ss-line">Instant games · Real money</p>' +
      '<div class="vb-ss-bar"><i></i></div>' +
      '<div class="vb-ss-row"><span class="vb-ss-msg">Loading…</span><span class="vb-ss-pct">0%</span></div>' +
    "</div>" +
    '<div class="vb-ss-note">Tap to skip</div>';
  document.documentElement.classList.add("vb-splashing");
  document.documentElement.appendChild(root);

  const bar = root.querySelector(".vb-ss-bar i");
  const pct = root.querySelector(".vb-ss-pct");
  const msg = root.querySelector(".vb-ss-msg");
  let loaded = document.readyState === "complete";
  let shown = 0;
  let gone = false;
  window.addEventListener("load", () => (loaded = true), { once: true });

  /* the bar eases toward 90% while the page loads, then fills to 100% */
  (function tick() {
    if (gone) return;
    const t = performance.now() - t0;
    const target = loaded ? 100 : 90 * (1 - Math.exp(-t / 900));
    const timeCap = Math.min(100, (t / SHOW_MS) * 100);
    shown += (Math.min(target, timeCap) - shown) * 0.12;
    if (loaded && t >= SHOW_MS) shown = Math.max(shown, 99.5);
    bar.style.width = shown.toFixed(1) + "%";
    pct.textContent = Math.round(shown) + "%";
    if (loaded && t >= SHOW_MS && shown >= 99.5) {
      msg.textContent = "Welcome!";
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
