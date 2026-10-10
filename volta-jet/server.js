/* Rendo Jet local server: serves the game files for playing on your own machine.
   No dependencies — run it with `node server.js` (Node 18+). Real-money rounds come from the RendoWin balance service. */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".md": "text/markdown; charset=utf-8"
};

function send(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");

  let rel;
  let raw;
  try {
    rel = decodeURIComponent(url.pathname);
    raw = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    return send(res, 400, "Bad request");
  }
  /* the URL parser already folds "/../" away; a request that tried to climb out is still refused outright */
  if (raw.split(/[\\/]/).includes("..")) return send(res, 403, "Forbidden");
  const file = path.resolve(ROOT, "." + (rel.endsWith("/") ? rel + "index.html" : rel));
  /* nothing outside the game folder is ever served */
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, "Forbidden");

  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, req.method === "HEAD" ? "" : data, TYPES[path.extname(file)] || "application/octet-stream");
  });
});

server.listen(PORT, () => {
  console.log(`Rendo Jet on http://localhost:${PORT}`);
});
