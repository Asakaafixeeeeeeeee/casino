/* Rendo Mines Live maths, shared by the live server and (as a check) the RendoWin balance service's copy in
   backend/src/games/minesLive.ts — a backend test keeps the two identical. */
"use strict";
const crypto = require("crypto");

const TILES = 25;
const MINES = 6;

/* 96.5% ÷ P(k stars in a row), rounded to the cent (exact, BigInt) */
const MULT = [1];
{
  let num = 1n, den = 1n;
  for (let k = 1; k <= TILES - MINES; k++) {
    num *= BigInt(TILES - MINES - (k - 1));
    den *= BigInt(TILES - (k - 1));
    /* 100 × 0.965 ÷ (num/den) = 193·den ÷ (2·num); round half up */
    MULT[k] = Number((386n * den + 2n * num) / (4n * num)) / 100;
  }
}

/* a deterministic shuffle driven by HMAC-SHA256(seed, "mines:" + roundId + ":" + counter) — anyone holding the seed
   (published at the end of the round) can re-derive exactly the same mines */
function minesFromSeed(seed, roundId) {
  const order = Array.from({ length: TILES }, (_, i) => i);
  let counter = 0, pool = [];
  const nextInt = (n) => {   /* an unbiased integer in [0, n) */
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      if (pool.length < 4) pool = pool.concat([...crypto.createHmac("sha256", seed).update("mines:" + roundId + ":" + counter++).digest()]);
      const v = ((pool[0] << 24) | (pool[1] << 16) | (pool[2] << 8) | pool[3]) >>> 0;
      pool = pool.slice(4);
      if (v < limit) return v % n;
    }
  };
  for (let i = TILES - 1; i > 0; i--) {
    const j = nextInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.slice(0, MINES).sort((a, b) => a - b);
}

module.exports = { TILES, MINES, MULT, minesFromSeed };
