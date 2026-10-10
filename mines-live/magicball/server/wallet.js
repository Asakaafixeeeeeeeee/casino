/* Magic Ball Live — demo wallets. Every balance lives here, on the server: the page only ever shows what it's told.
   A new player starts with START_BALANCE credits; a bet takes its stake at once; a win is paid when the round settles.
   The amounts are whole cents, rounded the same way everywhere, so balances never drift. */
"use strict";
const C = require("../shared/gameConstants");

const round2 = (n) => Math.round(n * 100) / 100;

function createWallet(db) {
  const cache = new Map();   /* userId → balance; the store is the record, this saves a read per bet */

  async function balance(userId) {
    if (cache.has(userId)) return cache.get(userId);
    const w = await db.getWallet(userId);
    const b = w ? round2(Number(w.balance)) : C.START_BALANCE;
    if (!w) await db.setWallet(userId, b);
    cache.set(userId, b);
    return b;
  }
  async function set(userId, b) {
    b = round2(b);
    cache.set(userId, b);
    if (cache.size > 50000) cache.delete(cache.keys().next().value);   /* bounded: the store keeps the record */
    await db.setWallet(userId, b);
    return b;
  }
  /** Takes a stake. Throws when the balance can't cover it. */
  async function debit(userId, amount) {
    const b = await balance(userId);
    if (amount > b + 1e-9) throw Object.assign(new Error("Not enough credits for that bet."), { code: "insufficient_funds" });
    return set(userId, b - amount);
  }
  async function credit(userId, amount) {
    return set(userId, (await balance(userId)) + amount);
  }
  /** Demo only: a fresh START_BALANCE for a player who's run out. */
  async function topUp(userId) {
    return set(userId, C.START_BALANCE);
  }
  return { balance, debit, credit, topUp, round2 };
}

module.exports = { createWallet, round2 };
