/* Serves the site (the repository root) on localhost, where site.js talks to the local accounts server (:8792) and
   balance service (:8781) instead of the live ones. */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.PORT || 8808);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".json": "application/json", ".ico": "image/x-icon", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".txt": "text/plain" };

http.createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(new URL(req.url, "http://site").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || /node_modules|\/\.|\/e2e\//.test(file.slice(ROOT.length))) throw Object.assign(new Error("no"), { code: "ENOENT" });
    if (!(await stat(file)).isFile()) throw Object.assign(new Error("no"), { code: "ENOENT" });
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}).listen(PORT, () => console.log(`[e2e] site on http://localhost:${PORT}`));
