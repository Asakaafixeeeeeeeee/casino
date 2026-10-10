/* Live Mines over real sockets: the server is started on a free port with short local fun-credit rounds and no demo
   players, and scripted clients act as players. Covers the audit findings: no action flood, no broadcast storm,
   type-checked names, and that malformed input never takes the process down. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { io } from "socket.io-client";

const here = path.dirname(fileURLToPath(import.meta.url));
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server, port;
test.before(async () => {
  port = await freePort();
  server = spawn(process.execPath, [path.join(here, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), LOCAL_ROUND_MS: "60000", DEMO_PLAYERS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("Live Mines didn't start");
});
test.after(() => server && server.kill());

const connect = (playerId) => new Promise((resolve, reject) => {
  const s = io(`http://127.0.0.1:${port}`, { auth: { playerId }, transports: ["websocket"], forceNew: true });
  s.once("state", (state) => resolve({ s, state }));
  s.once("connect_error", reject);
});
const ask = (s, ev, arg) => new Promise((resolve) => s.emit(ev, arg, resolve));

test("A flood of actions is cut off after the allowance, and the server stays up", async () => {
  const { s } = await connect("flooder-0000000001");
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => ask(s, "set_name", { name: "Name" + i })));
  const ok = results.filter((r) => r && r.ok).length;
  const slowed = results.filter((r) => r && /Slow down/.test(r.error || "")).length;
  assert.ok(ok <= 12, `${ok} renames got through`);
  assert.ok(slowed >= 28, `${slowed} were slowed down`);
  s.close();
  assert.ok((await fetch(`http://127.0.0.1:${port}/`)).ok, "still serving");
});

test("A burst of actions sends the other players one list, not one per action", async () => {
  const { s: watcher } = await connect("watcher-000000001");
  let lists = 0;
  watcher.on("bets", () => lists++);
  await sleep(400);
  lists = 0;
  const { s: actor } = await connect("renamer-000000001");
  for (let i = 0; i < 10; i++) actor.emit("set_name", { name: "Renamer" + i }, () => {});
  await sleep(1200);
  assert.ok(lists <= 4, `the watcher got ${lists} lists for 10 renames`);
  watcher.close();
  actor.close();
});

test("A name must be text: an object is refused, not turned into \"object Object\"", async () => {
  const { s } = await connect("namecheck-000000001");
  assert.match((await ask(s, "set_name", { name: { a: 1 } })).error, /Names need/);
  assert.match((await ask(s, "set_name", { name: ["Ama"] })).error, /Names need/);
  assert.equal((await ask(s, "set_name", { name: "Ama K" })).ok, true);
  s.close();
});

test("Bets: one per round, stake and tiles checked, malformed payloads refused without a crash", async () => {
  const { s, state } = await connect("bettor-00000000001");
  for (const bad of [null, 5, "x", { stake: "lots", picks: [1] }, { stake: 1, picks: "1,2" }, { stake: 1, picks: [1, 1] },
    { stake: 1, picks: [99] }, { stake: 1, picks: Array.from({ length: 20 }, (_, i) => i) }, { stake: -1, picks: [1] }, { stake: 1e9, picks: [1] }]) {
    const r = await ask(s, "bet", bad);
    assert.ok(r && r.error, `refused: ${JSON.stringify(bad)}`);
  }
  if (state.round.endsAt - Date.now() > 15000) {
    assert.equal((await ask(s, "bet", { stake: 1, picks: [0, 1] })).ok, true);
    assert.match((await ask(s, "bet", { stake: 1, picks: [2] })).error, /already bet/);
  }
  s.close();
  assert.ok((await fetch(`http://127.0.0.1:${port}/`)).ok, "still serving");
});
