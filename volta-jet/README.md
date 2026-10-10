# Rendo Jet

A browser crash game. A jet takes off, a multiplier climbs from 1.00x, and you cash out before it flies away. Play
with **free credits** (GHS 3,000 each session) or, signed in to RendoWin, with **real money** from your wallet.

## A round

1. **Place your bet** — an 8-second pause between rounds. Type a stake (no more than your balance) and press **Bet**.
   The button turns into **Cash Out**.
2. **Take-off** — the multiplier rises by 0.001 every 1/60 of a second (0.06 a second, so 2.00x takes about 17
   seconds), on the clock rather than per screen frame, so it climbs at the same speed on every screen.
3. **Cash Out** at any moment before the crash to win stake × the multiplier, rounded down to the cent.
4. **Flies away** at the crash point. Any stake still in play is lost, the crash point joins the history strip, and the
   8-second "Place your bet" pause starts at once (it also shows where the last jet flew away). At **10.70x**, the top,
   every bet still flying is paid 10.70x.

| Action                | Allowed when                                    | Result                                   |
|-----------------------|-------------------------------------------------|------------------------------------------|
| Bet                   | Between rounds, stake no more than the balance  | Stake leaves the balance; button → Cash Out |
| Cash Out              | During the round, before the crash              | Balance gains stake × current multiplier |
| Bet during a round    | Never                                           | "Wait for the next round"                |
| Cash Out after crash  | Never                                           | "Can't cash out now"                     |

**History strip:** blue under 2x, purple from 2x to under 10x, burgundy for 10x and above.
**Stake box:** numbers only — the `-`, `+` and `e` keys are blocked. Real-money stakes are GHS 0.10 to GHS 1,000.

## Odds

The crash point is set before each round and isn't shown until the jet flies away. The chance the jet passes x is
98% ÷ x, capped at the 10.70x top: about 3 rounds in 100 end at take-off, and every way of cashing out returns at
most 98% of stakes on average (exactly 98% at any whole-cent target). Free credits and real money use the same odds.

- **Free credits:** the page draws each crash point with `crypto.getRandomValues`.
- **Real money:** the RendoWin balance service runs the player's rounds (`backend/src/games/flights.ts`, game
  `volta-jet`). It draws the crash point when the round opens and keeps it to itself, takes bets only before take-off,
  judges a cash-out on its own clock the moment the request arrives, and pays from the wallet ledger. The page holds
  a long poll open to learn where the round ended.

## Run it

Needs [Node.js](https://nodejs.org) 18 or newer, and nothing else.

```bash
cd "casino site/volta-jet"
node server.js        # http://localhost:3000, free credits
```

`PORT` sets the port (default 3000). The server only serves the game files; paths outside the game folder are refused
with 403. On the RendoWin site the page is served with the rest of the site, and real-money rounds go to the balance
service.

## Files

```
volta-jet/
├── index.html   the page
├── style.css
├── script.js    canvas, bets, multiplier, cash-out, sounds, real-money rounds
├── server.js    static files for local play
└── jet.svg      the jet (side view; the afterburner is drawn live by script.js)
```

## How this differs from the document it was based on

- **Name:** "Aviator" is Spribe's trademark, so the game is called Rendo Jet, and there's no Spribe copyright or
  licence file.
- **Odds:** the document's crash points came from an outside odds page, or a uniform draw between 0.8 and 10.7 that
  returned up to 289% of stakes. Neither can be offered for real money, so both modes use the house-edge odds above.
- **Speed:** the document climbs 0.001 per animation frame, which runs twice as fast on a 120 Hz screen; Jet follows
  the clock instead, so the server and every screen agree on the multiplier.
- **Currency:** cedis (GHS) instead of euros.
