/* The accounts server over HTTP on an in-memory database: sessions, lockouts, password reset and the rate limit's
   client address (the audit found it read from a header the client controls). Each test gets its own server. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function server(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(here, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), PGLITE_DIR: "memory://", DATABASE_URL: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/health")).ok) break; } catch { /* starting */ }
    await sleep(100);
  }
  /* every call carries its own CF-Connecting-IP unless told otherwise, so tests don't share a rate-limit bucket */
  const ip = "198.51.100." + (1 + Math.floor(Math.random() * 250));
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { base, call, stop: () => proc.kill() };
}
const PW = "Sup3r-secret!";
const player = (n) => ({ phone: "024" + String(1000000 + n).slice(-7), password: PW, dob: "1990-05-17", country: "GH", currency: "GHS", full_name: "Ama Mensah" });

test("Sign up, log in, log out: a logged-out token is dead", async (t) => {
  const s = await server(); t.after(s.stop);
  const reg = await s.call("POST", "/api/register", player(1));
  assert.equal(reg.status, 201);
  assert.equal((await s.call("GET", "/api/me", null, { authorization: "Bearer " + reg.body.token })).status, 200);
  const login = await s.call("POST", "/api/login", { phone: player(1).phone, password: PW });
  assert.equal(login.status, 200);
  assert.notEqual(login.body.token, reg.body.token);
  assert.equal((await s.call("POST", "/api/logout", {}, { authorization: "Bearer " + login.body.token })).status, 200);
  assert.equal((await s.call("GET", "/api/me", null, { authorization: "Bearer " + login.body.token })).status, 401);
  assert.equal((await s.call("GET", "/api/me", null, { authorization: "Bearer " + reg.body.token })).status, 200, "other sessions live on");
  assert.equal((await s.call("GET", "/api/me", null, { authorization: "Bearer forged-token-0123456789" })).status, 401);
});

test("Sign-up input is checked: bad number, country or age, and duplicates", async (t) => {
  const s = await server(); t.after(s.stop);
  assert.equal((await s.call("POST", "/api/register", { ...player(2), phone: "12345" })).status, 400);
  assert.equal((await s.call("POST", "/api/register", { ...player(2), country: "ZZ" })).status, 400);
  assert.equal((await s.call("POST", "/api/register", { ...player(2), dob: "2015-01-01" })).status, 400);
  assert.equal((await s.call("POST", "/api/register", { ...player(2), password: "12345678" })).status, 400);
  assert.equal((await s.call("POST", "/api/register", player(2))).status, 201);
  assert.equal((await s.call("POST", "/api/register", player(2))).status, 409);
});

test("Sign-up takes the player's full name: checked, tidied, and handed to the balance service", async (t) => {
  const s = await server(); t.after(s.stop);
  const { full_name: _none, ...noName } = player(6);
  const missing = await s.call("POST", "/api/register", noName);
  assert.deepEqual([missing.status, missing.body.field, missing.body.error], [400, "fullName", "Enter your full name."], "a name is required");
  for (const [name, why] of [["   ", "Enter your full name"], ["Ama", "first and last"], ["Ama 2Mensah", "letters only"], ["Ama <b>Mensah</b>", "letters only"], ["A".repeat(40) + " " + "B".repeat(30), "at most 60"]]) {
    const r = await s.call("POST", "/api/register", { ...player(6), full_name: name });
    assert.equal(r.status, 400, name);
    assert.equal(r.body.field, "fullName", name);
    assert.match(r.body.error, new RegExp(why), name);
  }
  const reg = await s.call("POST", "/api/register", { ...player(6), full_name: "  Akosua   Ɔbɛng-Darko " });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.full_name, "Akosua Ɔbɛng-Darko");
  const auth = { authorization: "Bearer " + reg.body.token };
  assert.equal((await s.call("GET", "/api/me", null, auth)).body.user.full_name, "Akosua Ɔbɛng-Darko");
  assert.equal((await s.call("GET", "/api/session/verify", null, auth)).body.user.full_name, "Akosua Ɔbɛng-Darko");
  const login = await s.call("POST", "/api/login", { phone: player(6).phone, password: PW });
  assert.equal(login.body.user.full_name, "Akosua Ɔbɛng-Darko");
});

test("Five wrong passwords pause log-in", async (t) => {
  const s = await server(); t.after(s.stop);
  await s.call("POST", "/api/register", player(3));
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await s.call("POST", "/api/login", { phone: player(3).phone, password: "wrong-" + i })).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 429]);
  assert.equal((await s.call("POST", "/api/login", { phone: player(3).phone, password: PW })).status, 429, "paused even with the right password");
});

test("Wrong dates of birth pause password reset (3 tries) but never lock the owner out of log-in", async (t) => {
  const s = await server(); t.after(s.stop);
  const reg = await s.call("POST", "/api/register", player(4));
  const reset = (dob) => s.call("POST", "/api/reset", { phone: player(4).phone, dob, password: "N3w-secret!" });
  const first = await reset("1991-01-01");
  assert.equal(first.status, 403);
  assert.equal(first.body.triesLeft, 2);
  assert.equal((await reset("1992-02-02")).status, 403);
  assert.equal((await reset("1993-03-03")).status, 429, "paused after three");
  assert.equal((await reset("1990-05-17")).status, 429, "even the right date waits now");
  /* the owner's log-in is untouched by someone guessing at the reset form */
  assert.equal((await s.call("POST", "/api/login", { phone: player(4).phone, password: PW })).status, 200);
  assert.equal((await s.call("GET", "/api/me", null, { authorization: "Bearer " + reg.body.token })).status, 200);
});

test("A successful reset signs every device out", async (t) => {
  const s = await server(); t.after(s.stop);
  const reg = await s.call("POST", "/api/register", player(5));
  assert.equal((await s.call("POST", "/api/reset", { phone: player(5).phone, dob: "1990-05-17", password: "N3w-secret!" })).status, 200);
  assert.equal((await s.call("GET", "/api/me", null, { authorization: "Bearer " + reg.body.token })).status, 401);
  assert.equal((await s.call("POST", "/api/login", { phone: player(5).phone, password: "N3w-secret!" })).status, 200);
});

test("The rate limit follows CF-Connecting-IP: changing X-Forwarded-For doesn't reset it", async (t) => {
  const s = await server(); t.after(s.stop);
  const statuses = [];
  for (let i = 0; i < 41; i++) {
    statuses.push((await s.call("POST", "/api/login", {}, { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": `10.0.0.${i}, 203.0.113.7` })).status);
  }
  assert.equal(statuses.at(-1), 429, "the 41st from one client is refused, whatever X-Forwarded-For says");
  assert.ok(statuses.slice(0, 40).every((c) => c !== 429));
  assert.notEqual((await s.call("POST", "/api/login", {}, { "cf-connecting-ip": "203.0.113.8" })).status, 429, "another client is unaffected");
});

test("Without CF-Connecting-IP, TRUSTED_PROXY_HOPS picks the proxy-appended address, not the client's first entry", async (t) => {
  const s = await server({ TRUSTED_PROXY_HOPS: "1" }); t.after(s.stop);
  const statuses = [];
  for (let i = 0; i < 41; i++) {
    statuses.push((await s.call("POST", "/api/login", {}, { "cf-connecting-ip": "", "x-forwarded-for": `10.9.9.${i}, 203.0.113.9` })).status);
  }
  assert.equal(statuses.at(-1), 429);
  const health = await (await fetch(s.base + "/health", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } })).json();
  assert.deepEqual(health.proxy, { cf: false, xffHops: 2, trustedHops: 1 }, "the shape of the proxy headers, never their values");
});

test("An optional email at sign-up: checked, unique, changeable, and handed to the balance service", async (t) => {
  const s = await server(); t.after(s.stop);
  assert.equal((await s.call("POST", "/api/register", player(40))).status, 201, "no email is fine");
  const bad = await s.call("POST", "/api/register", { ...player(41), email: "not-an-email" });
  assert.deepEqual([bad.status, bad.body.field], [400, "email"]);
  const reg = await s.call("POST", "/api/register", { ...player(41), email: " Ama@Example.COM " });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.email, "ama@example.com");
  const dup = await s.call("POST", "/api/register", { ...player(42), email: "ama@example.com" });
  assert.deepEqual([dup.status, dup.body.field], [409, "email"]);
  const auth = { authorization: "Bearer " + reg.body.token };
  assert.equal((await s.call("GET", "/api/session/verify", null, auth)).body.user.email, "ama@example.com");
  assert.equal((await s.call("POST", "/api/me/email", { email: "new@example.com" }, auth)).body.user.email, "new@example.com");
  assert.equal((await s.call("POST", "/api/me/email", { email: "" }, auth)).body.user.email, null, "empty removes it");
});

test("Change password needs the current one and signs out every other device; sessions can be listed and revoked", async (t) => {
  const s = await server(); t.after(s.stop);
  const reg = await s.call("POST", "/api/register", player(50));
  const other = await s.call("POST", "/api/login", { phone: player(50).phone, password: PW }, { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" });
  const auth = { authorization: "Bearer " + reg.body.token };
  const list = (await s.call("GET", "/api/me/sessions", null, auth)).body.sessions;
  assert.equal(list.length, 2);
  assert.equal(list.filter((x) => x.current).length, 1);
  assert.ok(list.some((x) => x.device === "Safari on iOS"));
  assert.ok(!JSON.stringify(list).includes(reg.body.token), "tokens are never listed");
  const wrong = await s.call("POST", "/api/me/password", { current: "nope-nope-1", password: "Brand-new-pw1" }, auth);
  assert.deepEqual([wrong.status, wrong.body.field], [401, "current"]);
  assert.equal((await s.call("POST", "/api/me/password", { current: PW, password: "123" }, auth)).status, 400);
  assert.equal((await s.call("POST", "/api/me/password", { current: PW, password: "Brand-new-pw1" }, auth)).status, 200);
  assert.equal((await s.call("GET", "/api/me", null, { authorization: "Bearer " + other.body.token })).status, 401, "the other device is out");
  assert.equal((await s.call("GET", "/api/me", null, auth)).status, 200, "this one stays in");
  assert.equal((await s.call("POST", "/api/login", { phone: player(50).phone, password: "Brand-new-pw1" })).status, 200);
  const third = (await s.call("GET", "/api/me/sessions", null, auth)).body.sessions.find((x) => !x.current);
  assert.equal((await s.call("POST", "/api/me/sessions/revoke", { id: third.id }, auth)).status, 200);
  assert.equal((await s.call("GET", "/api/me/sessions", null, auth)).body.sessions.length, 1);
});

test("Log in (and reset) with a mobile number, a username or an email", async (t) => {
  const s = await server(); t.after(s.stop);
  const reg = await s.call("POST", "/api/register", { ...player(60), username: "KwameBoss", email: "kwame@example.com" });
  assert.equal(reg.status, 201);
  for (const login of [player(60).phone, "kwameboss", "KWAME@example.com"]) {
    const r = await s.call("POST", "/api/login", { login, password: PW });
    assert.equal(r.status, 200, login);
    assert.equal(r.body.user.username, "KwameBoss");
  }
  assert.equal((await s.call("POST", "/api/login", { login: "nobody99", password: PW })).status, 404);
  assert.equal((await s.call("POST", "/api/login", { phone: player(60).phone, password: PW })).status, 200, "the old phone field still works");
  const reset = await s.call("POST", "/api/reset", { login: "kwame@example.com", dob: "1990-05-17", password: "Brand-new-pw1" });
  assert.equal(reset.status, 200);
  assert.equal((await s.call("POST", "/api/login", { login: "KwameBoss", password: "Brand-new-pw1" })).status, 200);
});

test("The balance service can open an account for an admin (shared secret only), checked like a sign-up", async (t) => {
  const secret = "test-secret-0123456789abcdef";
  const s = await server({ ACCOUNTS_INTERNAL_SECRET: secret }); t.after(s.stop);
  const body = { full_name: "Ama Partner", phone: "0245550001", username: "AmaPartner", email: "ama.partner@example.com", password: PW, dob: "1992-01-01", country: "GH" };
  assert.equal((await s.call("POST", "/api/internal/accounts", body)).status, 403, "no secret");
  assert.equal((await s.call("POST", "/api/internal/accounts", body, { "x-internal-secret": "wrong-secret-0123456789ab" })).status, 403);
  const young = await s.call("POST", "/api/internal/accounts", { ...body, dob: "2015-01-01" }, { "x-internal-secret": secret });
  assert.equal(young.status, 400);
  const r = await s.call("POST", "/api/internal/accounts", body, { "x-internal-secret": secret });
  assert.equal(r.status, 201);
  assert.ok(r.body.user.id);
  assert.equal(r.body.user.email, "ama.partner@example.com");
  assert.equal((await s.call("POST", "/api/internal/accounts", body, { "x-internal-secret": secret })).status, 409, "a number registers once");
  const login = await s.call("POST", "/api/login", { login: "AmaPartner", password: PW });
  assert.equal(login.status, 200, "the partner logs in on the normal page");
  const off = await server({ ACCOUNTS_INTERNAL_SECRET: "" }); t.after(off.stop);
  assert.equal((await off.call("POST", "/api/internal/accounts", body, { "x-internal-secret": "" })).status, 403, "switched off without a secret");
});

test("The main admin's ban or delete stops log-in and ends every session; restoring lets the player back in", async (t) => {
  const secret = "test-internal-secret-0123456789";
  const s = await server({ ACCOUNTS_INTERNAL_SECRET: secret }); t.after(s.stop);
  const reg = await s.call("POST", "/api/register", player(41));
  const id = (await s.call("GET", "/api/session/verify", null, { authorization: "Bearer " + reg.body.token })).body.user.id;
  const access = (a, h = { "x-internal-secret": secret }) => s.call("POST", "/api/internal/access", { account_id: id, access: a }, h);
  assert.equal((await access("BANNED", { "x-internal-secret": "wrong-secret-0123456789xx" })).status, 403, "only with the secret");
  assert.equal((await access("BANNED")).status, 200);
  assert.equal((await s.call("GET", "/api/session/verify", null, { authorization: "Bearer " + reg.body.token })).status, 401, "sessions ended");
  const banned = await s.call("POST", "/api/login", { phone: player(41).phone, password: PW });
  assert.equal(banned.status, 403);
  assert.match(banned.body.error, /banned/);
  assert.equal((await access("DELETED")).status, 200);
  assert.match((await s.call("POST", "/api/login", { phone: player(41).phone, password: PW })).body.error, /closed/);
  assert.equal((await access("ACTIVE")).status, 200);
  assert.equal((await s.call("POST", "/api/login", { phone: player(41).phone, password: PW })).status, 200, "restored");
});
