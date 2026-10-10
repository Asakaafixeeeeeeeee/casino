/* Magic Ball Live — storage. One interface, two backends: memory (the default, nothing to install) and PostgreSQL
   (set DATABASE_URL). The tables: users, wallets, game_rounds and bets. Every write goes through here so the game
   engine and the wallet never care which backend is behind them. */
"use strict";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance     NUMERIC(14,2) NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS game_rounds (
  id               BIGSERIAL PRIMARY KEY,
  round_id         TEXT NOT NULL UNIQUE,
  start_time       TIMESTAMPTZ NOT NULL,
  end_time         TIMESTAMPTZ NOT NULL,
  state            TEXT NOT NULL,
  hidden_position  SMALLINT NOT NULL,
  seed             TEXT NOT NULL,
  seed_hash        TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  result_time      TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS bets (
  id          BIGSERIAL PRIMARY KEY,
  round_id    TEXT NOT NULL REFERENCES game_rounds(round_id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  spot        SMALLINT NOT NULL,
  amount      NUMERIC(14,2) NOT NULL,
  result      TEXT,
  payout      NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (round_id, user_id)
);
CREATE INDEX IF NOT EXISTS bets_round ON bets (round_id);
`;

/* ---------------- memory ---------------- */
const MAX_PLAYERS = 50000;
function memoryStore() {
  const users = new Map(), wallets = new Map(), rounds = new Map(), bets = new Map();   /* bets: roundId → Map(userId → bet) */
  let betSeq = 0;
  const order = [];   /* round ids, oldest first */
  return {
    kind: "memory",
    /* bounded: past MAX_PLAYERS the longest-known player is forgotten (demo credits only; a returning player starts afresh) */
    async ensureUser(id, name) {
      if (!users.has(id)) {
        users.set(id, { id, name, created_at: new Date() });
        if (users.size > MAX_PLAYERS) { const old = users.keys().next().value; users.delete(old); wallets.delete(old); }
      }
      return users.get(id);
    },
    async renameUser(id, name) { const u = users.get(id); if (u) u.name = name; },
    async getWallet(id) { return wallets.has(id) ? wallets.get(id) : null; },
    async setWallet(id, balance) { wallets.set(id, { user_id: id, balance, updated_at: new Date() }); },
    /* bounded: the oldest rounds (and their bets) go once 500 are kept */
    async saveRound(r) { if (!rounds.has(r.round_id)) { rounds.set(r.round_id, { ...r }); order.push(r.round_id); if (order.length > 500) { const old = order.shift(); rounds.delete(old); bets.delete(old); } } },
    async updateRound(roundId, patch) { const r = rounds.get(roundId); if (r) Object.assign(r, patch); },
    async getRound(roundId) { return rounds.get(roundId) || null; },
    async saveBet(b) { if (!bets.has(b.round_id)) bets.set(b.round_id, new Map()); const m = bets.get(b.round_id); if (m.has(b.user_id)) return null; const row = { id: ++betSeq, created_at: new Date(), result: null, payout: 0, ...b }; m.set(b.user_id, row); return row; },
    async deleteBet(roundId, userId) { const m = bets.get(roundId); if (!m || !m.has(userId)) return null; const b = m.get(userId); m.delete(userId); return b; },
    async getBet(roundId, userId) { const m = bets.get(roundId); return (m && m.get(userId)) || null; },
    async listBets(roundId) { const m = bets.get(roundId); return m ? [...m.values()] : []; },
    async settleBet(id, result, payout) { for (const m of bets.values()) for (const b of m.values()) if (b.id === id) { b.result = result; b.payout = payout; return; } },
    async history(limit) { return order.slice(-limit).reverse().map((id) => rounds.get(id)).filter((r) => r.state === "RESULT"); },
    async stats(roundId) { const list = await this.listBets(roundId); return { bets: list.length, wagered: list.reduce((a, b) => a + Number(b.amount), 0) }; }
  };
}

/* ---------------- PostgreSQL ---------------- */
async function pgStore(url) {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: url, max: 5 });
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await pool.query(stmt);
  const q = (text, params) => pool.query(text, params);
  const row = async (text, params) => (await q(text, params)).rows[0] || null;
  return {
    kind: "postgres",
    async ensureUser(id, name) { return row("INSERT INTO users (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id RETURNING *", [id, name]); },
    async renameUser(id, name) { await q("UPDATE users SET name = $2 WHERE id = $1", [id, name]); },
    async getWallet(id) { const w = await row("SELECT * FROM wallets WHERE user_id = $1", [id]); return w ? { ...w, balance: Number(w.balance) } : null; },
    async setWallet(id, balance) { await q("INSERT INTO wallets (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = now()", [id, balance]); },
    async saveRound(r) {
      await q(`INSERT INTO game_rounds (round_id, start_time, end_time, state, hidden_position, seed, seed_hash, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (round_id) DO NOTHING`,
        [r.round_id, r.start_time, r.end_time, r.state, r.hidden_position, r.seed, r.seed_hash, r.created_at]);
    },
    async updateRound(roundId, patch) {
      const sets = [], vals = [roundId];
      for (const [k, v] of Object.entries(patch)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
      if (sets.length) await q(`UPDATE game_rounds SET ${sets.join(", ")} WHERE round_id = $1`, vals);
    },
    async getRound(roundId) { return row("SELECT * FROM game_rounds WHERE round_id = $1", [roundId]); },
    async saveBet(b) {
      const r = await row("INSERT INTO bets (round_id, user_id, spot, amount) VALUES ($1, $2, $3, $4) ON CONFLICT (round_id, user_id) DO NOTHING RETURNING *", [b.round_id, b.user_id, b.spot, b.amount]);
      return r ? { ...r, amount: Number(r.amount), payout: Number(r.payout) } : null;
    },
    async deleteBet(roundId, userId) { const r = await row("DELETE FROM bets WHERE round_id = $1 AND user_id = $2 RETURNING *", [roundId, userId]); return r ? { ...r, amount: Number(r.amount) } : null; },
    async getBet(roundId, userId) { const r = await row("SELECT * FROM bets WHERE round_id = $1 AND user_id = $2", [roundId, userId]); return r ? { ...r, amount: Number(r.amount), payout: Number(r.payout) } : null; },
    async listBets(roundId) { return (await q("SELECT * FROM bets WHERE round_id = $1 ORDER BY id", [roundId])).rows.map((r) => ({ ...r, amount: Number(r.amount), payout: Number(r.payout) })); },
    async settleBet(id, result, payout) { await q("UPDATE bets SET result = $2, payout = $3 WHERE id = $1", [id, result, payout]); },
    async history(limit) { return (await q("SELECT * FROM game_rounds WHERE state = 'RESULT' ORDER BY start_time DESC LIMIT $1", [limit])).rows; },
    async stats(roundId) { const r = await row("SELECT COUNT(*)::int AS bets, COALESCE(SUM(amount), 0)::float AS wagered FROM bets WHERE round_id = $1", [roundId]); return r || { bets: 0, wagered: 0 }; }
  };
}

async function open() {
  if (process.env.DATABASE_URL) {
    try {
      return await pgStore(process.env.DATABASE_URL);
    } catch (e) {
      console.error("[db] PostgreSQL unavailable (" + e.message + "); using memory");
    }
  }
  return memoryStore();
}

module.exports = { open, SCHEMA };
