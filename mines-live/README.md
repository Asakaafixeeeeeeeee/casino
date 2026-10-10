# Rendo Mines Live

A shared-board Mines game. Every connected player plays the **same 5×5 board with 6 mines** for a **3-minute round**.
Play with fun credits, or — opened from the RendoWin lobby while signed in — with real money from your wallet.

The rounds follow the clock (round n runs from n × 3 min to (n + 1) × 3 min after the epoch) and come from the RendoWin
balance service (`backend/src/games/minesLive.ts`): it draws each round's seed, keeps it secret until 0:00, takes
real-money bets and pays them. This Node server shows the board, the timer, the live bets and the history, runs the
DEMO players and the fun-credit balances, and passes a real-money player's bet on with their own sign-in. If the balance
service can't be reached, the server waits for it (the board must be the service's round, the one the admin signal
shows) — a round is only drawn here under `LOCAL_ROUND_MS`.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd "casino site/mines-live"
npm install        # installs express and socket.io
npm start          # starts the server on http://localhost:8790
```

Open <http://localhost:8790> in two browsers (or a normal and a private window) to see two players on the same board.

Options, set as environment variables:

| Variable          | Default                               | What it does                                     |
|-------------------|---------------------------------------|--------------------------------------------------|
| `PORT`            | `8790`                                | The port to listen on                            |
| `BALANCE_API_URL` | `https://asakaa-balance.onrender.com` | The RendoWin balance service the rounds come from |
| `LOCAL_ROUND_MS`  | not set                               | Testing only: rounds of this length drawn here, fun credits only |

For example, `LOCAL_ROUND_MS=30000 PORT=8795 npm start` runs 30-second fun-credit rounds on port 8795.

**Real money.** The RendoWin lobby opens the game with the player's sign-in in the address's `#fragment` (never sent
to any server); the page keeps it in the tab's session storage and takes it out of the address at once. The server
checks it with the balance service, which also decides every real-money bet, cancel and result — so a win is paid
even if the page is closed, and a round this server misses is still settled there.

## Files

```
mines-live/
├── server.js         the server: round loop, board, bets, live list, DEMO players, real-money relay
├── maths.js          the multipliers and the mines from a seed (the balance service keeps an identical copy)
├── package.json
└── public/
    ├── index.html    the page (it reuses Rendo Mines' star, bomb and blast art)
    ├── style.css
    ├── app.js        the client: socket connection, shared countdown, board, controls
    └── mines-*.webp/png, favicon.svg
```

## How a round works

1. **Start.** The server makes a secret random seed, works out the 6 mine positions from it, and shows every player
   only the seed's **SHA-256 hash**.
2. **During the round** (`timer_tick` every second to everyone):
   - Choose **1–19 tiles** (tap them, or RANDOM) and press **BET** to lock them in with your stake: one bet per player
     per round, GHS 0.10 – 100. You can **cancel** it (stake back) until the last 10 seconds; after that bets are closed.
   - **Nothing is revealed during the round.** The server records your tiles and says nothing about them.
   - A player who joins mid-round gets the same board and the time left straight away.
   - **Auto Game** places the same tiles and stake again at the start of every round.
3. **0:00.** The board turns over for everyone at once and the server publishes the seed and the mines. Every bet is
   settled: if **all** your tiles are stars you win bet × the multiplier for that many tiles; if any is a mine, the bet
   is lost. A new board starts at once.

**Odds.** The multiplier for k tiles is 96.5% ÷ the chance that k tiles are all safe (1 tile 1.27x, 2 tiles 1.69x,
3 tiles 2.29x, 4 tiles 3.15x, 5 tiles 4.41x …, the same table as Rendo Mines with 6 mines), so every bet returns 96.5% on average.

**Provably fair.** The hash shown at the start lets anyone check, after the round, that the seed wasn't changed.
`GET /api/verify/<seed>/<roundId>` re-derives the mines from a published seed with the same code the server used.

## Live bets, history and names

Under the board:

- **Live bets**: everyone staking in the current round — their name, how many tiles and how much — with the round's
  total. Which tiles they picked is never shown. At 0:00 each bet shows won (and the payout) or lost.
- **History**: the last 30 rounds — a mini map of the mines, how many played, total staked and paid, the top win,
  and a link to verify the round from its seed.
- **My bets**: your own last 30 bets and how they ended.

**Demo players.** To show how a busy round looks, 10–26 simulated players join each round at random times with a
realistic spread of stakes and tiles. They are always tagged **DEMO** (and counted as demo in the totals and history),
their bets settle on the same board by the same rules at 0:00, and they never touch a real player's balance or odds.
Run with `DEMO_PLAYERS=0 npm start` to switch them off. Don't remove the tag: presenting simulated players as real
customers would mislead people about how popular the game is.

Each player gets a name like "Player 7F3A"; tap it in the header to change it (2–16 letters, numbers, spaces, `. _ -`).
The browser's private id is never shown to anyone — other players only see a one-way hash of it.
These lists are kept in the server's memory, like the fun-credit balances, and reset when it restarts (real-money
balances and bets are the balance service's, and don't).

## Shared board, no leaks

Everyone plays the same board, but because nothing is shown until 0:00, nobody can learn the layout from another
player mid-round and pass it on. The layout never leaves the server until the round is over and every bet is locked.
With real money the layout doesn't leave the balance service before 0:00 either.

## Hosting

This is a Node app, so it can't run on the static Render site that hosts the rest of RendoWin. On Render it would be
a separate **Web Service**: root directory `mines-live`, build command `npm install`, start command `npm start`.
Render sets `PORT` itself. Fun-credit balances are kept in the server's memory, so they reset when it restarts.
