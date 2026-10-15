/* The database: Postgres from DATABASE_URL (Render), or — when that isn't set, e.g. on your own computer — PGlite,
   a Postgres that runs inside Node and keeps its files in ./.data. Both answer query(text, params) → { rows }. */
"use strict";

const path = require("node:path");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             BIGSERIAL PRIMARY KEY,
  phone          TEXT        NOT NULL UNIQUE,
  username       TEXT        NOT NULL,
  password_hash  TEXT        NOT NULL,
  dob            DATE        NOT NULL,
  news           BOOLEAN     NOT NULL DEFAULT FALSE,
  failed_logins  INT         NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));
ALTER TABLE users ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT 'GH';
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_failures INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email)) WHERE email IS NOT NULL;
-- set by the main admin from the balance service: BANNED and DELETED accounts can't log in (records are kept)
ALTER TABLE users ADD COLUMN IF NOT EXISTS access TEXT NOT NULL DEFAULT 'ACTIVE';

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT        PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
`;

async function open() {
  let db;
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    db = { query: (text, params) => pool.query(text, params), kind: "postgres" };
  } else {
    let PGlite;
    try {
      ({ PGlite } = await import("@electric-sql/pglite"));
    } catch {
      throw new Error("No DATABASE_URL is set and PGlite isn't installed — set DATABASE_URL to a Postgres database.");
    }
    const lite = await PGlite.create(process.env.PGLITE_DIR || path.join(__dirname, ".data"));
    db = { query: (text, params) => lite.query(text, params), kind: "pglite" };
  }
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  return db;
}

module.exports = { open };
