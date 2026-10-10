/* Blaze Fruits — the maths. A classic 5×3 fruit slot with 20 fixed paylines, a wild Seven and a Star scatter.
   Pure functions, no DOM: the page plays spins through it, the server plays the same file for real money, and under
   Node it prints the exact return to player (every payline outcome is enumerated, nothing is simulated).

   How a spin works:
   - each of the 15 cells is drawn independently from its reel's weighted symbol list (WEIGHTS, one row per reel);
   - the 20 paylines (LINES, a row index per reel) pay left to right from reel 1 for 3, 4 or 5 matching symbols —
     the best way to read each line counts (a line with cherries and wilds can pay as cherries or as sevens);
   - the Seven is wild: it stands in for every symbol but the Star, and five Sevens is the top line win;
   - the Star is a scatter: 3, 4 or 5 anywhere on the grid pay SCATTER_PAYS × the total bet, on top of the lines;
   - the total bet is LINES.length × the line bet; line pays are × the line bet; a spin pays at most MAX_X × the total bet. */
(function (root) {
  "use strict";

  const COLS = 5;
  const ROWS = 3;
  const MAX_X = 2500;     /* 15 Sevens: every line pays its top, 20 × 2,500 line bets = 2,500 × the total bet */

  /* symbols: index, name. The Seven is 0 (wild), the Star is 7 (scatter). */
  const SYMBOLS = ["seven", "watermelon", "grapes", "plum", "orange", "lemon", "cherry", "star"];
  const WILD = 0;
  const SCATTER = 7;

  /* pays × the line bet for 3, 4 and 5 of a kind, left to right */
  const PAYS = [
    [50, 250, 2500],   /* seven */
    [20, 65, 320],     /* watermelon */
    [20, 65, 320],     /* grapes */
    [8, 30, 150],      /* plum */
    [8, 30, 150],      /* orange */
    [3, 15, 60],       /* lemon */
    [3, 15, 60],       /* cherry */
    [0, 0, 0]          /* star: pays as a scatter, below */
  ];
  /* the Star, anywhere: 3, 4 or 5 of them pay × the TOTAL bet */
  const SCATTER_PAYS = [2, 10, 50];

  /* the 20 paylines: the row each reel's symbol sits on (0 top, 1 middle, 2 bottom) */
  const LINES = [
    [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
    [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 1, 1, 1, 0],
    [2, 1, 1, 1, 2], [1, 0, 1, 2, 1], [1, 2, 1, 0, 1], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2],
    [1, 1, 0, 1, 1], [1, 1, 2, 1, 1], [0, 0, 2, 0, 0], [2, 2, 0, 2, 2], [0, 2, 0, 2, 0]
  ];

  /* how often each symbol lands on each reel (seven, melon, grapes, plum, orange, lemon, cherry, star) */
  const WEIGHTS = [
    [4, 7, 7, 10, 10, 14, 14, 2],
    [4, 7, 7, 10, 10, 14, 14, 2],
    [4, 7, 7, 10, 10, 14, 14, 2],
    [4, 7, 7, 10, 10, 14, 14, 2],
    [4, 7, 7, 10, 10, 14, 14, 2]
  ];

  const pickers = WEIGHTS.map((w) => {
    const total = w.reduce((a, b) => a + b, 0);
    return (rng) => {
      let r = rng() * total;
      for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; }
      return w.length - 1;
    };
  });

  /* a grid: COLS reels of ROWS symbols, grid[col][row] */
  function draw(rng) {
    return pickers.map((pick) => [pick(rng), pick(rng), pick(rng)]);
  }

  /* the best pay for one line of five symbols (× the line bet), and how many symbols and which symbol it reads as */
  function lineWin(syms) {
    let best = { pay: 0, count: 0, symbol: -1 };
    /* as the first non-wild symbol, with wilds standing in */
    const first = syms.find((s) => s !== WILD);
    if (first !== undefined && first !== SCATTER) {
      let n = 0;
      while (n < COLS && (syms[n] === first || syms[n] === WILD)) n++;
      if (n >= 3 && PAYS[first][n - 3] > best.pay) best = { pay: PAYS[first][n - 3], count: n, symbol: first };
    }
    /* as a run of sevens */
    let w = 0;
    while (w < COLS && syms[w] === WILD) w++;
    if (w >= 3 && PAYS[WILD][w - 3] > best.pay) best = { pay: PAYS[WILD][w - 3], count: w, symbol: WILD };
    return best;
  }

  /* everything a grid pays, × the line bet (scatters are converted: × total bet = × LINES.length line bets) */
  function evaluate(grid) {
    const lines = [];
    let total = 0;
    LINES.forEach((rows, i) => {
      const syms = rows.map((row, col) => grid[col][row]);
      const w = lineWin(syms);
      if (w.pay > 0) {
        lines.push({ line: i, symbol: w.symbol, count: w.count, pay: w.pay, cells: rows.slice(0, w.count).map((row, col) => [col, row]) });
        total += w.pay;
      }
    });
    const scatterCells = [];
    grid.forEach((reel, col) => reel.forEach((s, row) => { if (s === SCATTER) scatterCells.push([col, row]); }));
    let scatterPay = 0;
    if (scatterCells.length >= 3) scatterPay = SCATTER_PAYS[Math.min(5, scatterCells.length) - 3] * LINES.length;
    total += scatterPay;
    const capped = total > MAX_X * LINES.length;
    if (capped) total = MAX_X * LINES.length;
    return { lines, scatterCells, scatterPay, total, capped };
  }

  /* one spin: the grid and its wins. `win` is × the line bet; the page multiplies by the line bet it played. */
  function spin(rng) {
    const grid = draw(rng);
    const r = evaluate(grid);
    return { grid, lines: r.lines, scatterCells: r.scatterCells, scatterPay: r.scatterPay, win: r.total, capped: r.capped };
  }

  /* ---------------- the exact return ---------------- */
  /* Every cell on a reel shares that reel's distribution, so every payline has the same expected pay: enumerate the
     8^5 five-symbol combinations once. Scatters: the count of stars over 15 independent cells. */
  function exactRtp() {
    const probs = WEIGHTS.map((w) => { const t = w.reduce((a, b) => a + b, 0); return w.map((x) => x / t); });
    let linePay = 0;
    const n = SYMBOLS.length;
    const syms = [0, 0, 0, 0, 0];
    const rec = (col, p) => {
      if (col === COLS) { linePay += p * lineWin(syms).pay; return; }
      for (let s = 0; s < n; s++) { syms[col] = s; rec(col + 1, p * probs[col][s]); }
    };
    rec(0, 1);
    /* P(k stars on the grid) */
    let dist = [1];
    for (let col = 0; col < COLS; col++) {
      const p = probs[col][SCATTER];
      for (let cell = 0; cell < ROWS; cell++) {
        const next = new Array(dist.length + 1).fill(0);
        dist.forEach((q, k) => { next[k] += q * (1 - p); next[k + 1] += q * p; });
        dist = next;
      }
    }
    let scatterPay = 0;
    dist.forEach((q, k) => { if (k >= 3) scatterPay += q * SCATTER_PAYS[Math.min(5, k) - 3] * LINES.length; });
    const perLine = linePay * LINES.length;        /* × line bet, all lines */
    const total = perLine + scatterPay;             /* × line bet */
    const bet = LINES.length;                       /* the total bet, × line bet */
    return { rtp: total / bet, lines: perLine / bet, scatters: scatterPay / bet, hitLine: null };
  }

  /* the figure the page and the server disclose (exactRtp() recomputes it; a test checks they agree) */
  const RTP = 96.05;

  /* A seeded generator (sfc32, 128-bit state). For real money the server draws four random 32-bit words, plays the
     spin from them and pays it; the page replays the identical spin from the same words to animate it. */
  function seeded(words) {
    let a = words[0] >>> 0, b = words[1] >>> 0, c = words[2] >>> 0, d = words[3] >>> 0;
    const next = () => {
      const t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 15; i++) next();   /* mix the seed in before the first draw */
    return next;
  }

  const api = { COLS, ROWS, MAX_X, SYMBOLS, WILD, SCATTER, PAYS, SCATTER_PAYS, LINES, WEIGHTS, RTP, draw, lineWin, evaluate, spin, exactRtp, seeded };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.VBFruitsMath = api;

  /* node fruits-math.js → the exact return, and a quick simulation to show the two agree */
  if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
    const e = exactRtp();
    console.log("exact RTP", (e.rtp * 100).toFixed(3) + "%", "lines", (e.lines * 100).toFixed(2) + "%", "scatters", (e.scatters * 100).toFixed(2) + "%");
    const N = Number(process.argv[2] || 1000000);
    let s = 0x9e3779b9 ^ Date.now();
    const rng = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    let won = 0, hits = 0, big = 0;
    for (let i = 0; i < N; i++) { const r = spin(rng); won += r.win; if (r.win > 0) hits++; if (r.win >= 50 * LINES.length) big++; }
    console.log("simulated", N, "spins: RTP", (won / (N * LINES.length) * 100).toFixed(2) + "%", "hit rate", (hits / N * 100).toFixed(1) + "%", "50x+ wins 1 in", big ? Math.round(N / big) : "-");
  }
})(typeof window !== "undefined" ? window : globalThis);
