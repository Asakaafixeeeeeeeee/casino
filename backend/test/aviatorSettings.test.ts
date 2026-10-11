import assert from "node:assert/strict";
import test from "node:test";
import { GameError } from "../src/games/catalog.js";
import { currentSkyRound, placeSkyBet, saveSkySettings, skyCrashFromSeed } from "../src/games/skyRush.js";
import { aviatorOverview } from "../src/services/aviatorAdmin.js";
import { setupWalletDb } from "./helpers/walletDb.js";

test("Aviator settings: a new round is drawn with the saved RTP and keeps it; limits apply to new bets", async () => {
  const { db, userId } = await setupWalletDb();
  await saveSkySettings(db, "0200000001", { rtp: 95, min_bet: 2, max_bet: 500, max_win: 10000 });

  const r = await currentSkyRound(db);
  assert.equal(Number(r.rtp), 0.95);
  assert.equal(Number(r.crash), skyCrashFromSeed(r.seed, Number(r.no), 0.95), "the crash point comes from the seed and the round's RTP");

  await assert.rejects(() => placeSkyBet(db, userId, { round_no: r.no, panel: 0, stake: 1, idempotency_key: "sky-low-stake" }),
    (e: unknown) => e instanceof GameError && e.code === "invalid_stake" && /GHS 2\.00/.test(e.message));
  await assert.rejects(() => placeSkyBet(db, userId, { round_no: r.no, panel: 0, stake: 600, idempotency_key: "sky-high-stake" }),
    (e: unknown) => e instanceof GameError && e.code === "invalid_stake");
});

test("Aviator settings refuse values out of range", async () => {
  const { db } = await setupWalletDb();
  for (const bad of [{ rtp: 70 }, { rtp: 100 }, { min_bet: 0.01 }, { min_bet: 10, max_bet: 5 }, { max_bet: 500, max_win: 100 }]) {
    await assert.rejects(() => saveSkySettings(db, "admin", bad), (e: unknown) => e instanceof GameError, JSON.stringify(bad));
  }
});

test("The admin monitor never shows the crash point of a round still in play", async () => {
  const { db } = await setupWalletDb();
  const r = await currentSkyRound(db);
  const view = await aviatorOverview(db, new Date(r.starts_at).getTime() - 1000);
  assert.equal((view.round as { phase: string }).phase, "betting");
  assert.equal("crash" in (view.round as object), false);
  const later = await aviatorOverview(db, new Date(r.ends_at).getTime() + 1000);
  assert.equal((later.round as { crash: number }).crash, Number(r.crash));
});
