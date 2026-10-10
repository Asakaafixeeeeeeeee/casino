/* Runs the real migrations against a real Postgres (PGlite = Postgres compiled to
   WASM) so schema errors surface here, not in production. */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = ["001_schema.sql", "002_seed_currencies.sql"];

export async function boot() {
  const db = await PGlite.create();
  for (const file of migrations) {
    const sql = readFileSync(join(here, "..", "migrations", file), "utf8");
    try {
      await db.exec(sql);
      console.log(`  applied ${file}`);
    } catch (err) {
      console.error(`\n  MIGRATION FAILED: ${file}\n  ${err.message}\n`);
      await db.close();
      throw err;
    }
  }
  return db;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await boot();
  const { rows } = await db.query(`
    SELECT kind, count(*)::int AS n,
           string_agg(code, ', ' ORDER BY code) AS codes
      FROM currencies WHERE is_active OR code = 'XCD'
     GROUP BY kind ORDER BY kind`);
  console.log("\n  seeded assets:");
  for (const r of rows) console.log(`    ${r.kind.padEnd(7)} ${String(r.n).padStart(2)}  ${r.codes}`);
  const c = await db.query(`SELECT count(*)::int AS n FROM countries WHERE is_supported`);
  console.log(`    countries supported: ${c.rows[0].n}`);
  await db.close();
}