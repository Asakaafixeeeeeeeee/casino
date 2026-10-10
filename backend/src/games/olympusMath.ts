import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The parts of olympus-math.js the server uses — the very maths the page plays. */
export interface OlympusMath {
  MAX_X: number;
  ANTE_COST: number;
  BUY_COST: number;
  MEASURED: { rtp: number; ante: number; buy: number; margin: number };
  seeded(words: number[]): () => number;
  round(rng: () => number, kind: "spin" | "ante" | "buy"): { cost: number; win: number; capped: boolean; free: unknown[] };
}

/* the server's copy sits in backend/shared (a service only sees its own folder on Render); a test keeps it
   byte-for-byte the same as the page's assets/js/olympus-math.js. Look upward from here and from the working directory. */
function locate(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const start of [here, process.cwd()]) {
    let dir = start;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, "shared", "olympus-math.cjs");
      if (existsSync(candidate)) return candidate;
      dir = path.dirname(dir);
    }
  }
  return null;
}

let loaded: OlympusMath | null | undefined;
/** null when the file isn't deployed alongside the server (Olympus then stays free-credits only). */
export function olympusMath(): OlympusMath | null {
  if (loaded !== undefined) return loaded;
  const file = locate();
  try {
    loaded = file ? (createRequire(import.meta.url)(file) as OlympusMath) : null;
  } catch (e) {
    console.error("[olympus] couldn't load the shared maths:", (e as Error).message);
    loaded = null;
  }
  if (!loaded) console.error("[olympus] shared/olympus-math.cjs not found; Olympus can't be played for real money");
  return loaded;
}
