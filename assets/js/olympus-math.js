/* Rendo Olympus — the maths. A 6×5 "pay anywhere" slot with tumbles and multiplier orbs.
   Pure functions, no DOM: the page plays rounds through it, and the same file runs under Node to simulate millions
   of rounds and measure the RTP (see the numbers in MEASURED below; the rules dialog prints them).

   How a spin works:
   - every cell is drawn independently from a weighted symbol list (base game, Ante Bet and free spins each have
     their own weights);
   - 8 or more of one symbol anywhere on the grid win (pay table below, × total bet ÷ 1 … see PAYS);
   - winning symbols vanish, the rest fall, new ones drop in from the top, and this repeats until nothing wins;
   - multiplier orbs never win by themselves and stay on the grid; if the tumble sequence won anything, the orbs on
     the final grid are added up and multiply the whole sequence's win (free spins: they're added to a running total
     multiplier that applies to every later winning spin of the feature);
   - 4+ Zeus scatters on the final grid pay 3×/5×/100× and start 15 free spins; 3+ during free spins add 5 more;
   - one round (a paid spin, plus any free spins it starts) pays at most MAX_X × the bet. */
(function (root) {
  "use strict";

  const COLS = 6;
  const ROWS = 5;
  const MAX_X = 15000;
  const FREE_SPINS = 15;
  const RETRIGGER = 5;
  const ANTE_COST = 1.25;     /* Ante Bet: the spin costs 25% more and scatters land about twice as often */
  const BUY_COST = 100;       /* Buy Free Spins: 100 × the bet (not with Ante Bet) */

  /* the nine paying symbols, best first */
  const SYMBOLS = ["crown", "hourglass", "ring", "chalice", "red", "purple", "yellow", "green", "blue"];
  const SCATTER = 9;
  const ORB = 10;

  /* pays × the bet for 8–9, 10–11 and 12+ of a symbol */
  const PAYS = [
    [15, 35, 75],        /* crown */
    [3.5, 15, 35],       /* hourglass */
    [3, 7.5, 20],        /* ring */
    [2.2, 3, 17.5],      /* chalice */
    [1.5, 2.2, 15],      /* red gem */
    [1.15, 1.75, 11.5],  /* purple gem */
    [0.75, 1.45, 7.5],   /* yellow gem */
    [0.6, 1.3, 6],       /* green gem */
    [0.35, 1.1, 3]       /* blue gem */
  ];
  const SCATTER_PAYS = { 4: 3, 5: 5, 6: 100 };

  /* symbol weights: the nine symbols, then scatter, then orb */
  const WEIGHTS = {
    base: [4, 5, 6, 7, 9, 10, 11, 12, 13, 1.3, 0.6],
    ante: [4, 5, 6, 7, 9, 10, 11, 12, 13, 1.64, 0.6],
    free: [4, 5, 6, 7, 9, 10, 11, 12, 13, 0.6, 3.7]
  };

  /* multiplier orb values and how often each lands */
  const ORBS = [
    [2, 300], [3, 200], [4, 120], [5, 100], [6, 60], [8, 40], [10, 30], [12, 16], [15, 12], [20, 8],
    [25, 6], [50, 3], [100, 1.2], [250, 0.4], [500, 0.15], [1000, 0.05]
  ];

  function picker(weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    const cum = [];
    let s = 0;
    weights.forEach((w) => cum.push((s += w) / total));
    return (rng) => {
      const u = rng();
      for (let i = 0; i < cum.length; i++) if (u < cum[i]) return i;
      return cum.length - 1;
    };
  }
  let PICK, PICK_ORB;
  /* (re)builds the weighted pickers — the tuning script calls it after changing the tables */
  function rebuild() {
    PICK = { base: picker(WEIGHTS.base), ante: picker(WEIGHTS.ante), free: picker(WEIGHTS.free) };
    PICK_ORB = picker(ORBS.map((o) => o[1]));
  }
  rebuild();

  /* a cell: { s: symbol index, m: orb value (orbs only), id: unique, for the animation } */
  let nextId = 1;
  function cell(rng, mode) {
    const s = PICK[mode](rng);
    const c = { s, id: nextId++ };
    if (s === ORB) c.m = ORBS[PICK_ORB(rng)][0];
    return c;
  }

  /* grid[c][r], row 0 at the top */
  function freshGrid(rng, mode) {
    const g = [];
    for (let c = 0; c < COLS; c++) {
      g.push([]);
      for (let r = 0; r < ROWS; r++) g[c].push(cell(rng, mode));
    }
    return g;
  }

  const tier = (n) => (n >= 12 ? 2 : n >= 10 ? 1 : 0);

  /* the winning symbols on a grid: [{ sym, count, pay, cells:[[c, r]] }] */
  function wins(grid) {
    const at = SYMBOLS.map(() => []);
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      const s = grid[c][r].s;
      if (s < SCATTER) at[s].push([c, r]);
    }
    const out = [];
    at.forEach((cells, sym) => {
      if (cells.length >= 8) out.push({ sym, count: cells.length, pay: PAYS[sym][tier(cells.length)], cells });
    });
    return out;
  }

  /* removes the winning cells, lets the rest fall and fills from the top */
  function tumble(grid, cells, rng, mode) {
    const gone = new Set(cells.map(([c, r]) => c * ROWS + r));
    return grid.map((col, c) => {
      const keep = col.filter((_, r) => !gone.has(c * ROWS + r));
      const add = [];
      while (add.length + keep.length < ROWS) add.push(cell(rng, mode));
      return add.concat(keep);
    });
  }

  const count = (grid, s) => grid.reduce((n, col) => n + col.filter((x) => x.s === s).length, 0);
  const orbSum = (grid) => grid.reduce((n, col) => n + col.reduce((k, x) => k + (x.s === ORB ? x.m : 0), 0), 0);

  /* one spin with all its tumbles. Returns the steps for the animation and the totals (× bet, before the round cap):
     { steps:[{ grid, wins, pay }], grid (final), win (symbol wins before orbs), orbs, scatters, scatterPay } */
  function spin(rng, mode, startGrid) {
    let grid = startGrid || freshGrid(rng, mode);
    const steps = [];
    let win = 0;
    for (;;) {
      const w = wins(grid);
      const pay = w.reduce((a, x) => a + x.pay, 0);
      steps.push({ grid, wins: w, pay });
      if (!w.length) break;
      win += pay;
      grid = tumble(grid, [].concat(...w.map((x) => x.cells)), rng, mode);
    }
    const scatters = count(grid, SCATTER);
    return { steps, grid, win, orbs: win > 0 ? orbSum(grid) : 0, scatters, scatterPay: SCATTER_PAYS[Math.min(6, scatters)] || 0 };
  }

  /* a whole round. kind: "spin" | "ante" | "buy". Returns { cost, base (the paid spin or null for a buy),
     free:[{ spin, total multiplier after it, pay }], win (× bet, capped), capped } */
  function round(rng, kind) {
    const cost = kind === "ante" ? ANTE_COST : kind === "buy" ? BUY_COST : 1;
    let total = 0;
    let capped = false;
    const add = (x) => {
      total += x;
      if (total >= MAX_X) {
        total = MAX_X;
        capped = true;
      }
    };
    let base = null;
    let triggered = kind === "buy";
    if (kind !== "buy") {
      base = spin(rng, kind === "ante" ? "ante" : "base");
      add(base.win * (base.orbs || 1) + base.scatterPay);
      triggered = base.scatters >= 4;
    } else {
      /* a bought feature starts on a grid with 4–6 scatters, which pay as usual */
      const sc = 4 + (rng() < 0.12 ? 1 : 0) + (rng() < 0.01 ? 1 : 0);
      base = spin(rng, "base", buyGrid(rng, sc));
      add(base.win * (base.orbs || 1) + base.scatterPay);
    }
    const free = [];
    if (triggered && !capped) {
      let left = FREE_SPINS;
      let mult = 0;
      while (left > 0 && !capped) {
        left--;
        const s = spin(rng, "free");
        if (s.win > 0 && s.orbs > 0) mult += s.orbs;
        const pay = s.win * (s.win > 0 && mult > 0 ? mult : 1) + s.scatterPay;
        add(pay);
        if (s.scatters >= 3) left += RETRIGGER;
        free.push({ spin: s, mult, pay, left });
      }
    }
    return { kind, cost, base, free, win: total, capped };
  }

  /* a base-game grid with exactly n scatters dropped in random cells (for Buy Free Spins) */
  function buyGrid(rng, n) {
    const g = freshGrid(rng, "base");
    g.forEach((col) => col.forEach((x) => { if (x.s === SCATTER) x.s = 8; }));   /* no stray scatters */
    const spots = [];
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) spots.push([c, r]);
    for (let i = 0; i < n; i++) {
      const k = i + Math.floor(rng() * (spots.length - i));
      [spots[i], spots[k]] = [spots[k], spots[i]];
      const [c, r] = spots[i];
      g[c][r] = { s: SCATTER, id: nextId++ };
    }
    return g;
  }

  /* measured with these tables the way real money plays them (crypto-random words → seeded → round): 50M paid
     spins each for the base game and Ante Bet, 1M bought features; ± is a 95% margin. One bought feature in the
     million reached the MAX_X cap. Re-measure and update after changing any table (node assets/js/olympus-math.js N
     gives a quick check). */
  const MEASURED = { rtp: 96.0, ante: 95.03, buy: 96.18, margin: 0.3, rounds: 50000000, buyRounds: 1000000 };

  /* A seeded generator (sfc32, 128-bit state). For real money the server draws four random 32-bit words, plays the
     round from them and pays it; the page replays the identical round from the same words to animate it. */
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

  const api = { COLS, ROWS, MAX_X, FREE_SPINS, RETRIGGER, ANTE_COST, BUY_COST, SYMBOLS, SCATTER, ORB, PAYS, SCATTER_PAYS,
    WEIGHTS, ORBS, MEASURED, rebuild, spin, round, wins, tumble, freshGrid, seeded };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VBOlympusMath = api;

  /* ---------------- simulation (Node only) ---------------- */
  if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
    let s = 0x9e3779b9 ^ Date.now();
    const rng = () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    const N = Number(process.argv[2] || 200000);
    const kinds = (process.argv[3] || "spin,ante,buy").split(",");
    kinds.forEach((kind) => {
      const n = kind === "buy" ? Math.max(2000, Math.round(N / 40)) : N;
      let paid = 0, won = 0, hits = 0, trig = 0, sq = 0, big = 0;
      for (let i = 0; i < n; i++) {
        const r = round(rng, kind);
        paid += r.cost;
        won += r.win;
        sq += r.win * r.win;
        if (r.win > 0) hits++;
        if (r.free.length) trig++;
        if (r.capped) big++;
      }
      const mean = won / n;
      const sd = Math.sqrt(sq / n - mean * mean);
      const rtp = won / paid;
      const se = sd / Math.sqrt(n) / (paid / n);
      console.log(kind.padEnd(5), "rounds", n, "RTP", (rtp * 100).toFixed(2) + "% ±" + (se * 196).toFixed(2),
        "hit", (hits / n * 100).toFixed(1) + "%", "feature 1 in", trig ? Math.round(n / trig) : "-", "capped", big);
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
