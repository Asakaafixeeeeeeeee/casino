/* RendoWin accounts server: register, log in, log out and reset a password, so an account works on any device.
   It stores sign-in details only — no balances or payments; the site's fun-credit wallet stays in each browser.
   No framework — Node's http module and Postgres (see db.js).

   Passwords are stored as salted scrypt hashes, never as text. A log-in returns a random session token; only its
   SHA-256 is stored, so a leaked database can't be used to sign in. Five wrong passwords lock the account for 30 s,
   doubling with every further five (up to an hour), and each IP address is rate-limited. */
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { open } = require("./db");

const PORT = Number(process.env.PORT) || 8792;
/* origins allowed to call the API from a browser; "*" (the default) is safe here because sign-in uses a bearer token,
   not cookies, so another site can't act as a signed-in player */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean);

const MAX_TRIES = 5;
const LOCK_BASE_S = 30;
const LOCK_MAX_S = 3600;
const RESET_TRIES = 3;                    /* wrong dates of birth before a password reset is paused */
const RESET_LOCK_BASE_S = 24 * 3600;       /* the first pause: a day */
const RESET_LOCK_MAX_S = 7 * 24 * 3600;    /* doubling up to a week */
const REMEMBER_MS = 30 * 24 * 3600 * 1000;
const SESSION_MS = 12 * 3600 * 1000;

const USER_RE = /^[A-Za-z0-9]{4,16}$/;
const RESERVED = ["admin", "support", "rendowin", "voltabet", "test", "demo", "root", "system", "moderator"];
const MOBILE_PREFIXES = ["020", "023", "024", "025", "026", "027", "050", "053", "054", "055", "056", "057", "059"];

/* ---------------- passwords: scrypt ---------------- */
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 32, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

async function checkPassword(pw, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split("$");
  if (kind !== "scrypt") return false;
  const want = Buffer.from(hash, "base64");
  const got = await scrypt(pw, Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, want);
}
/* used when the number isn't registered, so a missing account takes as long to answer as a wrong password */
let DUMMY_HASH = "";

/* ---------------- checks ---------------- */
/* the countries a player can register from, with their dialling codes (the same list as the site's data.js) */
const COUNTRIES = [
  { code: "GH", name: "Ghana", dial: "233", flag: "🇬🇭" },
  { code: "NG", name: "Nigeria", dial: "234", flag: "🇳🇬" },
  { code: "KE", name: "Kenya", dial: "254", flag: "🇰🇪" },
  { code: "ZA", name: "South Africa", dial: "27", flag: "🇿🇦" },
  { code: "EG", name: "Egypt", dial: "20", flag: "🇪🇬" },
  { code: "US", name: "United States", dial: "1", flag: "🇺🇸" },
  { code: "CA", name: "Canada", dial: "1", flag: "🇨🇦" },
  { code: "GB", name: "United Kingdom", dial: "44", flag: "🇬🇧" },
  { code: "DE", name: "Germany", dial: "49", flag: "🇩🇪" },
  { code: "FR", name: "France", dial: "33", flag: "🇫🇷" },
  { code: "ES", name: "Spain", dial: "34", flag: "🇪🇸" },
  { code: "IT", name: "Italy", dial: "39", flag: "🇮🇹" },
  { code: "IN", name: "India", dial: "91", flag: "🇮🇳" },
  { code: "BR", name: "Brazil", dial: "55", flag: "🇧🇷" },
  { code: "AE", name: "United Arab Emirates", dial: "971", flag: "🇦🇪" },
  { code: "JP", name: "Japan", dial: "81", flag: "🇯🇵" },
  { code: "AU", name: "Australia", dial: "61", flag: "🇦🇺" }
];
const countryOf = (v) => COUNTRIES.find((c) => c.code === String(v || "").toUpperCase()) || null;
/* a Ghana number is kept the way it was always stored (0241234567); any other number is kept as +<code><number> */
const normalizePhone = (v) => {
  const s = String(v || "").replace(/[\s().-]/g, "");
  if (/^(?:\+|00)?2330?\d{9}$/.test(s)) return s.replace(/^(?:\+|00)?2330?/, "0");
  return s.replace(/^00/, "+");
};
const isGhanaMobile = (p) => /^0\d{9}$/.test(p) && MOBILE_PREFIXES.includes(p.slice(0, 3));
const isIntlMobile = (p) => /^\+[1-9]\d{7,14}$/.test(p);
/* a number as the chosen country stores it, or "" when it isn't a number of that country */
function phoneFor(country, raw) {
  const s = String(raw || "").replace(/[\s().-]/g, "");
  if (country.code === "GH") { const p = normalizePhone(s); return isGhanaMobile(p) ? p : ""; }
  let p = s.replace(/^00/, "+");
  if (/^0\d+$/.test(p)) p = "+" + country.dial + p.slice(1);               /* a local number: add the country's code */
  else if (/^\d+$/.test(p)) p = "+" + (p.startsWith(country.dial) ? p : country.dial + p);
  return p.startsWith("+" + country.dial) && isIntlMobile(p) ? p : "";
}

function ageFrom(dob) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob || "");
  if (!m) return NaN;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d)) age--;
  return age;
}

function passwordProblem(pw) {
  if (typeof pw !== "string" || !pw) return "Choose a password.";
  if (pw.length < 8) return "Use at least 8 characters.";
  if (pw.length > 128) return "Use at most 128 characters.";
  if (/^\d+$/.test(pw)) return "Use more than digits alone.";
  return "";
}

/* the player's full name from sign-up: a first and a last name at least, in any alphabet, each word starting with a
   letter and otherwise letters, apostrophes, dots or hyphens (O'Neil, Anne-Marie, St. John, Ɔbɛng). Spaces are tidied. */
const tidyName = (v) => String(v || "").normalize("NFC").replace(/\s+/g, " ").trim();
const NAME_WORD = /^\p{L}[\p{L}\p{M}'’.-]*$/u;
function fullNameProblem(name) {
  if (!name) return "Enter your full name.";
  if (name.length > 60) return "Use at most 60 characters.";
  const words = name.split(" ");
  if (!words.every((w) => NAME_WORD.test(w))) return "Use letters only — no numbers or symbols.";
  if (words.length < 2) return "Enter your first and last name.";
  return "";
}

/* the currency the player chose at sign-up (the balance their header shows by default): US dollars or Ghana cedis */
const CURRENCIES = ["USD", "GHS"];
const currencyOf = (v) => (CURRENCIES.includes(String(v || "").toUpperCase()) ? String(v).toUpperCase() : "");
const publicUser = (u) => ({ phone: u.phone, username: u.username, full_name: u.full_name || null, email: u.email || null, currency: u.currency || "USD", country: u.country || "GH" });

/* an optional email address: "" when none was given, null when it isn't a valid address */
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$/;
function emailOf(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}
/* the device a session was opened on, for the "login sessions" list: browser and system, never the full string */
function deviceOf(req) {
  const ua = String(req.headers["user-agent"] || "");
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? browser + " on " + os : browser;
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/* ---------------- per-IP rate limit for the sign-in endpoints ---------------- */
/* 40 sign-up, log-in and reset attempts per address per 10 minutes. SIGNIN_RATE_LIMIT raises it for the end-to-end
   test stack, whose whole suite signs in from one address; production leaves it unset. */
const SIGNIN_LIMIT = Math.max(1, Math.floor(Number(process.env.SIGNIN_RATE_LIMIT)) || 40);
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) {
    hits.set(ip, { n: 1, reset: now + 10 * 60 * 1000 });
    return false;
  }
  h.n++;
  return h.n > SIGNIN_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (h.reset < now) hits.delete(ip);
}, 60 * 1000).unref();

/* ---------------- HTTP plumbing ---------------- */
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*")) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "600");
}

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 32 * 1024) {
        reject(new HttpError(413, "That request is too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {});
      } catch {
        reject(new HttpError(400, "That request isn't valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

/* The client's address, for the per-address rate limit. Render sits behind Cloudflare and APPENDS the real address to
   X-Forwarded-For, so its first entry is whatever the client typed (proved: changing it reset the limit). Cloudflare's
   CF-Connecting-IP can't be forged through Cloudflare, so it comes first; TRUSTED_PROXY_HOPS (how many proxies append
   to X-Forwarded-For in front of this server) picks the right hop otherwise; failing both, the old behaviour. */
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;
function clientIp(req) {
  const cf = String(req.headers["cf-connecting-ip"] || "").trim();
  if (IP_RE.test(cf)) return cf;
  const hops = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const trusted = Number(process.env.TRUSTED_PROXY_HOPS) || 0;
  if (hops.length && trusted > 0) return hops[Math.max(0, hops.length - trusted)];
  return hops[0] || req.socket.remoteAddress || "";
}
/* which of those headers arrive (never their values): /health reports it so the setup above can be checked live */
const proxyShape = (req) => ({
  cf: IP_RE.test(String(req.headers["cf-connecting-ip"] || "").trim()),
  xffHops: String(req.headers["x-forwarded-for"] || "").split(",").filter((s) => s.trim()).length,
  trustedHops: Number(process.env.TRUSTED_PROXY_HOPS) || 0
});

/* ---------------- the API ---------------- */
async function main() {
  const db = await open();
  DUMMY_HASH = await hashPassword(crypto.randomBytes(12).toString("hex"));

  async function newSession(userId, remember, req) {
    const token = crypto.randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + (remember ? REMEMBER_MS : SESSION_MS));
    await db.query("INSERT INTO sessions (token_hash, user_id, expires_at, device, last_seen_at) VALUES ($1, $2, $3, $4, now())",
      [sha256(token), userId, expires, req ? deviceOf(req) : null]);
    return token;
  }

  async function signedIn(req) {
    const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || "");
    if (!m) throw new HttpError(401, "Please log in.");
    const { rows } = await db.query(
      `SELECT u.*, s.token_hash, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`, [sha256(m[1])]);
    if (!rows.length) throw new HttpError(401, "Your session has ended. Please log in again.");
    /* "last active" for the sessions list, at most every 5 minutes */
    const seen = rows[0].last_seen_at ? new Date(rows[0].last_seen_at).getTime() : 0;
    if (Date.now() - seen > 5 * 60 * 1000) await db.query("UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1", [rows[0].token_hash]);
    return rows[0];
  }

  /* a wrong password (or date of birth) counts towards the lock */
  async function failedAttempt(user) {
    const failed = user.failed_logins + 1;
    const lockS = failed % MAX_TRIES === 0 ? Math.min(LOCK_MAX_S, LOCK_BASE_S * 2 ** (failed / MAX_TRIES - 1)) : 0;
    await db.query(
      "UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3::int > 0 THEN now() + make_interval(secs => $3::int) ELSE locked_until END WHERE id = $1",
      [user.id, failed, lockS]);
    return { lockS, triesLeft: MAX_TRIES - (failed % MAX_TRIES) };
  }

  /* a wrong date of birth on a password reset counts towards a lock of its own: much stricter than log-in's (3 tries,
     then a day, doubling to a week), and it never locks log-in — so knowing someone's number can't lock them out of
     their account, and guessing a date of birth takes months instead of days. */
  async function failedReset(user) {
    const failed = (user.reset_failures || 0) + 1;
    const lockS = failed % RESET_TRIES === 0 ? Math.min(RESET_LOCK_MAX_S, RESET_LOCK_BASE_S * 2 ** (failed / RESET_TRIES - 1)) : 0;
    await db.query(
      "UPDATE users SET reset_failures = $2, reset_locked_until = CASE WHEN $3::int > 0 THEN now() + make_interval(secs => $3::int) ELSE reset_locked_until END WHERE id = $1",
      [user.id, failed, lockS]);
    return { lockS, triesLeft: RESET_TRIES - (failed % RESET_TRIES) };
  }
  function resetLockedFor(user) {
    const until = user.reset_locked_until ? new Date(user.reset_locked_until).getTime() : 0;
    return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
  }

  function lockedFor(user) {
    const until = user.locked_until ? new Date(user.locked_until).getTime() : 0;
    return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
  }

  /* sign-up doesn't ask for a username; each player gets a free one like Player482193 */
  async function freeUsername() {
    for (let i = 0; i < 8; i++) {
      const name = "Player" + crypto.randomInt(100000, 1000000);
      const { rows } = await db.query("SELECT 1 FROM users WHERE lower(username) = lower($1)", [name]);
      if (!rows.length) return name;
    }
    return "Player" + crypto.randomInt(10000000, 100000000);
  }

  const routes = {
    "GET /health": async (req) => ({ ok: true, db: db.kind, proxy: proxyShape(req) }),

    "POST /api/register": async (req, body) => {
      const fullName = tidyName(body.full_name);
      const country = countryOf(body.country || "GH");
      const phone = country ? phoneFor(country, body.phone) : "";
      const username = String(body.username || "").trim() || await freeUsername();
      const dob = String(body.dob || "");
      const age = ageFrom(dob);
      const currency = currencyOf(body.currency || "USD");
      const email = emailOf(body.email);
      const problem =
        fullNameProblem(fullName) ? ["fullName", fullNameProblem(fullName)] :
        !country ? ["country", "Choose your country."] :
        !phone ? ["phone", country.code === "GH" ? "That is not a valid Ghanaian mobile number." : "Enter a valid " + country.name + " mobile number (+" + country.dial + " …)."] :
        !currency ? ["currency", "Choose US dollars or Ghana cedis."] :
        email === null ? ["email", "That email address doesn't look right — check it, or leave it empty."] :
        !USER_RE.test(username) ? ["username", "Use 4–16 letters or numbers, no spaces."] :
        RESERVED.includes(username.toLowerCase()) ? ["username", "That username is taken."] :
        passwordProblem(body.password) ? ["pw", passwordProblem(body.password)] :
        !(age >= 18) ? ["age", "You must be 18 or older to register."] :
        age > 120 ? ["age", "Check your date of birth."] : null;
      if (problem) throw new HttpError(400, problem[1], { field: problem[0] });

      const taken = await db.query("SELECT phone, lower(username) = lower($2) AS same_name FROM users WHERE phone = $1 OR lower(username) = lower($2)", [phone, username]);
      if (taken.rows.some((r) => r.phone === phone)) throw new HttpError(409, "An account already exists for this number — log in instead.", { field: "phone" });
      if (taken.rows.length) throw new HttpError(409, "That username is taken.", { field: "username" });
      if (email && (await db.query("SELECT 1 FROM users WHERE lower(email) = $1", [email])).rows.length) {
        throw new HttpError(409, "That email address is already used by another account.", { field: "email" });
      }

      const hash = await hashPassword(body.password);
      let user;
      try {
        ({ rows: [user] } = await db.query(
          "INSERT INTO users (phone, username, password_hash, dob, news, currency, country, full_name, email) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *",
          [phone, username, hash, dob, !!body.news, currency, country.code, fullName || null, email || null]));
      } catch (err) {
        /* two sign-ups for the same number or name at the same moment: the unique index decides */
        if (err.code === "23505") throw new HttpError(409, "That number, username or email was just taken. Try again.");
        throw err;
      }
      const token = await newSession(user.id, true, req);
      return { status: 201, body: { token, user: publicUser(user) } };
    },

    "POST /api/login": async (req, body) => {
      const phone = normalizePhone(body.phone);
      const pw = String(body.password || "");
      if (!isGhanaMobile(phone) && !isIntlMobile(phone)) throw new HttpError(400, "That is not a valid mobile number.", { field: "lphone" });
      const { rows: [user] } = await db.query("SELECT * FROM users WHERE phone = $1", [phone]);
      if (!user) {
        await checkPassword(pw, DUMMY_HASH);
        throw new HttpError(404, "No account found for this number.", { field: "lphone" });
      }
      const wait = lockedFor(user);
      if (wait) throw new HttpError(429, "Too many wrong attempts. Try again in " + wait + " seconds.", { retryIn: wait });
      if (!(await checkPassword(pw, user.password_hash))) {
        const { lockS, triesLeft } = await failedAttempt(user);
        if (lockS) throw new HttpError(429, "Too many wrong attempts — log-in is paused for " + lockS + " seconds.", { retryIn: lockS });
        throw new HttpError(401, "Wrong password.", { field: "lpw", triesLeft });
      }
      await db.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [user.id]);
      await db.query("DELETE FROM sessions WHERE expires_at < now()");
      const token = await newSession(user.id, body.remember !== false, req);
      return { body: { token, user: publicUser(user) } };
    },

    "POST /api/logout": async (req) => {
      const user = await signedIn(req);
      await db.query("DELETE FROM sessions WHERE token_hash = $1", [user.token_hash]);
      return { body: { ok: true } };
    },

    "GET /api/me": async (req) => {
      const user = await signedIn(req);
      return { body: { user: publicUser(user) } };
    },

    /* the player's default currency, changed from the balance menu on the site */
    "POST /api/me/currency": async (req, body) => {
      const user = await signedIn(req);
      const currency = currencyOf(body.currency);
      if (!currency) throw new HttpError(400, "Choose US dollars or Ghana cedis.", { field: "currency" });
      await db.query("UPDATE users SET currency = $2 WHERE id = $1", [user.id, currency]);
      return { body: { user: publicUser({ ...user, currency }) } };
    },

    "GET /api/session/verify": async (req) => {
      const user = await signedIn(req);
      return { body: { user: { id: user.id, phone: user.phone, username: user.username, full_name: user.full_name || null, email: user.email || null, currency: user.currency || "USD", country: user.country || "GH" } } };
    },

    /* the optional email address, added or changed from the account settings (empty removes it) */
    "POST /api/me/email": async (req, body) => {
      const user = await signedIn(req);
      const email = emailOf(body.email);
      if (email === null) throw new HttpError(400, "That email address doesn't look right.", { field: "email" });
      if (email && (await db.query("SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2", [email, user.id])).rows.length) {
        throw new HttpError(409, "That email address is already used by another account.", { field: "email" });
      }
      try {
        await db.query("UPDATE users SET email = $2 WHERE id = $1", [user.id, email || null]);
      } catch (err) {
        if (err.code === "23505") throw new HttpError(409, "That email address is already used by another account.", { field: "email" });
        throw err;
      }
      return { body: { user: publicUser({ ...user, email: email || null }) } };
    },

    /* change the password: the current one confirms it's you; every other device is signed out */
    "POST /api/me/password": async (req, body) => {
      const user = await signedIn(req);
      const wait = lockedFor(user);
      if (wait) throw new HttpError(429, "Too many wrong attempts. Try again in " + wait + " seconds.", { retryIn: wait });
      if (!(await checkPassword(String(body.current || ""), user.password_hash))) {
        const { lockS, triesLeft } = await failedAttempt(user);
        if (lockS) throw new HttpError(429, "Too many wrong attempts — paused for " + lockS + " seconds.", { retryIn: lockS });
        throw new HttpError(401, "Your current password is wrong.", { field: "current", triesLeft });
      }
      const problem = passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem, { field: "password" });
      await db.query("UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1",
        [user.id, await hashPassword(body.password)]);
      await db.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [user.id, user.token_hash]);
      return { body: { ok: true } };
    },

    /* the devices signed in to this account (a session's id is a prefix of its stored hash, never the token) */
    "GET /api/me/sessions": async (req) => {
      const user = await signedIn(req);
      const { rows } = await db.query(
        "SELECT token_hash, device, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = $1 AND expires_at > now() ORDER BY coalesce(last_seen_at, created_at) DESC LIMIT 50",
        [user.id]);
      return { body: { sessions: rows.map((r) => ({
        id: r.token_hash.slice(0, 16), device: r.device || "Unknown device", created_at: r.created_at,
        last_seen_at: r.last_seen_at, expires_at: r.expires_at, current: r.token_hash === user.token_hash
      })) } };
    },

    /* sign out one other device ({ id }) or every other device ({ all: true }) */
    "POST /api/me/sessions/revoke": async (req, body) => {
      const user = await signedIn(req);
      if (body.all === true) {
        await db.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [user.id, user.token_hash]);
        return { body: { ok: true } };
      }
      const id = String(body.id || "");
      if (!/^[0-9a-f]{16}$/.test(id)) throw new HttpError(400, "Choose a session.");
      await db.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2 AND left(token_hash, 16) = $3", [user.id, user.token_hash, id]);
      return { body: { ok: true } };
    },

    /* forgot password: the date of birth given at sign-up confirms it's you */
    "POST /api/reset": async (req, body) => {
      const phone = normalizePhone(body.phone);
      if (!isGhanaMobile(phone) && !isIntlMobile(phone)) throw new HttpError(400, "That is not a valid mobile number.", { field: "fphone" });
      const pwProblem = passwordProblem(body.password);
      if (pwProblem) throw new HttpError(400, pwProblem, { field: "fpw" });
      const { rows: [user] } = await db.query("SELECT *, to_char(dob, 'YYYY-MM-DD') AS dob_text FROM users WHERE phone = $1", [phone]);
      if (!user) throw new HttpError(404, "No account found for this number.", { field: "fphone" });
      const wait = resetLockedFor(user);
      if (wait) throw new HttpError(429, "Password reset is paused on this account after too many wrong dates of birth. Try again in " + Math.ceil(wait / 3600) + " hours, or contact support.", { retryIn: wait });
      if (String(body.dob || "") !== user.dob_text) {
        const { lockS, triesLeft } = await failedReset(user);
        if (lockS) throw new HttpError(429, "Too many wrong dates of birth — password reset is paused for " + Math.ceil(lockS / 3600) + " hours. Contact support if you need help.", { retryIn: lockS });
        throw new HttpError(403, "That date of birth doesn't match this account.", { field: "fdob", triesLeft });
      }
      await db.query("UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, reset_failures = 0, reset_locked_until = NULL WHERE id = $1",
        [user.id, await hashPassword(body.password)]);
      /* every device signed in with the old password is signed out */
      await db.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
      return { body: { ok: true } };
    }
  };
  const RATE_LIMITED = new Set(["POST /api/register", "POST /api/login", "POST /api/reset", "POST /api/me/password"]);

  const server = http.createServer(async (req, res) => {
    cors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const key = req.method + " " + new URL(req.url, "http://x").pathname;
    const route = routes[key];
    try {
      if (!route) throw new HttpError(404, "Not found.");
      if (RATE_LIMITED.has(key) && limited(clientIp(req))) throw new HttpError(429, "Too many requests. Wait a few minutes and try again.", { retryIn: 600 });
      const body = req.method === "GET" ? {} : await readJson(req);
      const out = await route(req, body);
      send(res, out.status || 200, out.body || out);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, Object.assign({ error: err.message }, err.extra));
      console.error(key, err);
      send(res, 500, { error: "Something went wrong on our side. Try again in a moment." });
    }
  });
  server.listen(PORT, () => console.log(`RendoWin accounts on http://localhost:${PORT} (${db.kind})`));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
