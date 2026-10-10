import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
const db = await PGlite.create();
const sql = fs.readFileSync("migrations/001_schema.sql","utf8");
// split on statement-ending semicolons at end of line, keeping comments inline
const stmts = sql.split(/\n(?=CREATE|ALTER|COMMENT|INSERT|UPDATE|DELETE|GRANT|REVOKE|SELECT|DO|--|COMMIT|BEGIN|END)/);
let i=0;
for (const s of sql.split(/\n;\s*\n/)) {
  if (s.trim().startsWith("--") || !s.trim()) continue;
  i++;
  try { await db.exec(s + ";"); console.log(`${i} OK  ${s.trim().split('\n')[0].slice(0,70)}`); }
  catch(e){ console.log(`\n=== FAILED stmt ${i} ===`); console.log(s.slice(0,1600)); console.log("-> "+e.message.split("\n")[0]); break; }
}
