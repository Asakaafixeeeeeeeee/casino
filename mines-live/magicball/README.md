# Magic Ball Live

In production this game is hosted by the Live Mines service at `/magicball/` (mines-live/server.js mounts it), so
it deploys with that service. Everything below also works on its own with `npm start` in this folder.

One table for everyone: three red cups on a walnut top, a ball under one of them, and a round every three minutes that
every connected player sees at the same moment — the same clock, the same shuffle, the same reveal. The server runs
the game; the page only shows it and sends bets. Demo credits only in this version.

## 1. Install Node.js

Install Node.js 18 or newer from https://nodejs.org (the LTS download). Check it in a terminal:

```
node -v
```

## 2. Install the dependencies

In the VS Code terminal (Terminal → New Terminal), from this folder:

```
cd magicball-live
npm install
```

## 3. Start the server

```
npm run dev
```

`npm run dev` starts the server with the small development box on the page (round, server time, state).
`npm start` starts it without. Either way the server says `Magic Ball Live on http://localhost:3000`.

Optional settings go in a `.env`-style environment (see `.env.example`): `PORT`, `DEV_INDICATOR`, `ADMIN_TOKEN`,
`DATABASE_URL` (PostgreSQL; leave empty to keep everything in memory), `REDIS_URL` (for several server instances).

## 4. Open the game

Open http://localhost:3000 in a browser. The admin dashboard is http://localhost:3000/admin.html?token=… once
`ADMIN_TOKEN` is set.

## 5. How the 3-minute rounds work

Rounds follow the clock. Round *n* runs from `n × 180 s` to `(n + 1) × 180 s` after the Unix epoch, so the round in
play is a pure function of the server's time — every server instance, and every player, agrees on it without being
told. Inside a round (`shared/gameConstants.js`):

| from | to | state |
| --- | --- | --- |
| 0:00 | 2:45 | **BETTING** — spots open, the clock counts down to the result |
| 2:45 | 2:54 | **SHUFFLING** — bets closed, the cups swap about |
| 2:54 | 2:56 | **REVEALING** — the cups lift; every bet is settled against the one hidden position |
| 2:56 | 3:00 | **RESULT** — the result stays up, then the next round starts at once |

Each round has a `roundId` (`ROUND-<n>`), `startTime`, `endTime`, `state`, a `hiddenPosition`, `createdAt` and a
`resultTime`, exactly as the engine keeps them (`server/gameEngine.js`).

## 6. How Socket.IO keeps players in step

- On connect the server sends `game:sync`: its own time, the current round (public form), the countdown, the player's
  wallet, their bet on this round and the history. A player joining at 12:01:20 gets round 100 with 1:25 left, not a
  new game.
- The page works out its clock skew from `serverTime` and draws every countdown from the server's timestamps
  (`bettingEnds`, `shuffleStart`, `revealTime`, `endTime`). No client timer ever decides when anything happens.
- As the engine moves a round along it broadcasts `game:round`, `game:state`, `game:shuffle` (start, end and the swaps),
  `game:reveal` (the position and the seed) and `game:countdown` every second. Each player's own bet comes back as
  `bet:mine`, its outcome as `game:result`; mistakes come back as `game:error`.
- A reconnect is just another connect: `game:sync` puts the page back on the current round in its current state.
- With `REDIS_URL` set, the Socket.IO Redis adapter is attached (`server/socket.js`) so broadcasts reach every
  instance's players; rounds already agree across instances because they follow the clock.

## 7. How the server decides the result

When a round is first needed the engine draws a 32-byte seed with `crypto.randomBytes`. The hidden position is
`HMAC-SHA256(seed, "ball:" + roundNo)` mod 3 + 1 and the shuffle's swaps come from the same seed. The seed's SHA-256
hash is published with the round at the start; the seed itself is published at the reveal, so anyone can check the
position was fixed before any bet was placed. Nothing is drawn with `Math.random()`, on a client, or more than once —
connecting, refreshing or clicking a spot never touches it. Every bet on a round is judged against that one position.

Bets are checked on the server against the server clock: a bet after `bettingEnds`, a second bet on the same round,
a spot that isn't 1–3, an amount outside the limits or more than the wallet holds is refused. Wallets live on the
server (`server/wallet.js`); the page only shows what it's told. Actions are rate-limited per player.

## 8. Testing with several players

Each browser profile is a separate player (a random id kept in `localStorage`). Open the game in:

- Chrome window 1 → http://localhost:3000
- Chrome window 2 → http://localhost:3000 (same player as window 1 — same wallet, same bet)
- a Chrome incognito window → http://localhost:3000 (a different player)
- any other browser or phone on your network → a different player again

## 9. Checking they see the same round

With `npm run dev`, the box at the bottom-left of every window shows `ROUND`, `SERVER TIME` and `STATE`. Put the
windows side by side:

1. The `ROUND` ids match, and the countdowns tick the same second.
2. Place a bet in one window; the other windows' "bets this round" count goes up.
3. At 2:45 every window switches to SHUFFLING together and the cups make the same moves.
4. At 2:54 every window lifts the cups on the same spot, and each player's bet shows WIN or LOSE against it.
5. The new round starts in every window at 3:00, with the same new `ROUND` id.

`/health` shows the round the server is on; the admin page shows the round, state, countdown, players, bets, the
wager total, the hidden position once revealed, and the previous rounds.

## Files

- `client/index.html`, `client/style.css`, `client/app.js` — the page: the table, the clock, the bet, the history.
- `client/admin.html` — the read-only admin dashboard.
- `server/server.js` — Express, the static files, `/health`, `/api/config`, `/api/admin`; starts the engine and sockets.
- `server/gameEngine.js` — rounds on the clock, the seed and hidden position, state changes, settlement.
- `server/socket.js` — Socket.IO: authentication, rate limits, every event in and out, the Redis adapter hook.
- `server/wallet.js` — demo wallets, all arithmetic on the server.
- `server/database.js` — the store: memory, or PostgreSQL with the `users`, `wallets`, `game_rounds` and `bets` tables.
- `shared/gameConstants.js` — the timings, limits and pay, loaded by both the server and the page.
