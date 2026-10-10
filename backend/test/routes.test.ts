import assert from "node:assert/strict";
import test from "node:test";
import { balancesRouter } from "../src/routes/balances.js";

type Layer = { route?: { path: string; methods: Record<string, boolean> } };
const routesOf = (router: unknown) =>
  (router as { stack: Layer[] }).stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`));

test("No player endpoint credits a balance directly or moves money between players", () => {
  const routes = routesOf(balancesRouter({} as never));
  // money only enters through a TheTeller deposit confirmed server-side, and only leaves through an approved withdrawal
  assert.ok(!routes.some((r) => /\/(deposit|transfer|credit|adjust)$/.test(r)), routes.join(", "));
  // every write a player can make here; adding one should be a deliberate change to this list
  assert.deepEqual(routes.filter((r) => r.startsWith("POST")).sort(),
    ["POST /convert", "POST /feedback", "POST /limits", "POST /self-exclusion", "POST /withdraw"]);
  // a conversion moves money between one player's own accounts only (services/conversions.ts); it's listed here on purpose
});
