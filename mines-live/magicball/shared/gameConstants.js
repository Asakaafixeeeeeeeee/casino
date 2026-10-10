/* Magic Ball Live — the numbers the server and the page share. Loaded by Node (module.exports) and by the browser
   (window.MB_CONSTANTS), so the two never disagree about a round's timing or the pay. */
(function (root) {
  "use strict";
  const C = {
    /* a round is exactly three minutes, aligned to the clock: round n runs from n × 180 s to (n + 1) × 180 s */
    ROUND_MS: 180000,
    /* inside a round: bets for the first 165 s, the cups shuffle for 9 s, they lift (REVEALING) for 2 s, and the
       result stays up for the last 4 s before the next round starts */
    BETTING_MS: 165000,
    SHUFFLE_MS: 9000,
    REVEAL_MS: 2000,
    /* the states a round goes through */
    STATES: ["WAITING", "BETTING", "SHUFFLING", "REVEALING", "RESULT"],
    SPOTS: 3,
    /* a right spot pays 2.9 × the bet: one spot in three wins, so a bet returns 96.7% on average */
    PAYOUT: 2.9,
    /* demo credits */
    START_BALANCE: 10000,
    MIN_BET: 1,
    MAX_BET: 1000,
    /* how many finished rounds the history keeps */
    HISTORY: 30,
    /* the swaps in a shuffle: [cupA, cupB, durationMs] — the same list for everyone, played from shuffleStart */
    SHUFFLE_SWAPS: 8
  };
  C.RESULT_MS = C.ROUND_MS - C.BETTING_MS - C.SHUFFLE_MS - C.REVEAL_MS;
  if (typeof module !== "undefined" && module.exports) module.exports = C;
  root.MB_CONSTANTS = C;
})(typeof window !== "undefined" ? window : globalThis);
