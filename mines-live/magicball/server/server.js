/* Magic Ball Live on its own: an Express app and Socket.IO server with the game mounted at the root. In production
   the Live Mines service mounts the same game at /magicball (mines-live/server.js). */
"use strict";
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { mount } = require("./mount");

const PORT = Number(process.env.PORT) || 3000;
(async () => {
  const app = express();
  app.disable("x-powered-by");
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: true } });
  await mount({ app, io, base: "" });
  server.listen(PORT, () => console.log(`Magic Ball Live on http://localhost:${PORT}`));
})().catch((e) => { console.error(e); process.exit(1); });
