# RendoWin pre-launch QA and security audit

**Date:** 8 October 2026. **Scope:** the static site, the balance service (`backend/`), the accounts server (`accounts-api/`), and the live game servers (`mines-live/`, including Magic Ball Live).

29 issues were found and fixed, each with a regression test. 17 remain open. One of the open items is a launch blocker that needs your decision: the admin Mines signal (A1). The full test suite now runs 295 tests, and all of them pass. That count includes 18 server tests and 9 end-to-end checks for Sky Rush, the shared-round game added after the audit.

No test suite can prove a site is bug-free. What this audit can show is that every high-risk money path is now covered by tests that fail if it breaks. That includes running on a real Postgres database under concurrent load.

## Test frameworks

| Suite | Where | How it runs | Tests |
| --- | --- | --- | --- |
| Balance service | `backend/test/` | Node's built-in test runner + tsx, on in-memory Postgres (PGlite) | 175 |
| Accounts server | `accounts-api/test/` | Node test runner against the real server on an in-memory database | 8 |
| Live game servers | `mines-live/test/`, `mines-live/magicball/test/` | Node test runner, real Socket.IO clients, controlled clocks | 7 |
| End to end | `e2e/tests/` | Playwright in the installed Google Chrome, against the real services on a real throwaway Postgres | 126 |

The backend already had a good unit harness: Node's test runner with PGlite. Playwright is the recommended addition for end-to-end and layout tests, and it is now set up in `e2e/`. One caveat about the PGlite helper: every connection shares a single database session, so race tests run on it can't exercise real row locks. The race tests therefore run in the end-to-end stack, which boots a real Postgres (`embedded-postgres`) and the production entry point.

From the repository folder, paste this whole block. Each line runs in brackets, so the terminal goes back to the
repository folder after each suite.

```
(cd backend && npm test)                         # 175 tests, ~1 min
(cd accounts-api && npm test)                    # 8 tests
(cd mines-live && npm test)                      # 7 tests
(cd e2e && npm install && npx playwright test)   # 126 tests, ~12 min; uses Google Chrome
```

Lines such as `[mines-live] round 4000 failed to settle` or a TheTeller `404 ... failed` in the output are expected:
those tests break things on purpose to check the code copes. A real failure is marked ✖ and counted under `fail`.

## Open: needs your decision or outside work

| # | Severity | Issue | Recommendation |
| --- | --- | --- | --- |
| A1 | **Critical (integrity)** | The admin "Mines signal" shows the hidden mines of every open Mines round, the current Live Mines round, and the **next** Live round before it opens (`backend/src/services/minesSignal.ts`). Anyone with an admin login, or a stolen admin token, can win every round: the auditor won GHS 10,000 on a GHS 0.10 bet in a test. Regulators treat staff access to outcomes as a rigged game. | Remove the signal before launch. If you keep it, at minimum bar admin numbers from real-money play and log every view. |
| A2 | High | No proof of phone ownership at sign-up, and password reset relies on date of birth. Anyone can register a number they don't own. An `ADMIN_PHONES` number that hasn't been registered yet can be claimed by whoever registers it first. | Make sure every number in `ADMIN_PHONES` is already registered by its owner. Add SMS one-time codes for sign-up and reset (needs an SMS provider). |
| A3 | High | Admin money controls rely on one person. | Require two-person approval above a threshold, set a daily cap on manual credits, and add MFA for admins. |
| A4 | Medium | The 30-day, full-access session token is passed to the Live Mines service in the URL fragment and held in its memory. | Issue a short-lived token scoped to Live Mines bets only. |
| A5 | Medium | Sessions last 30 days in `localStorage`, and the site sends no Content-Security-Policy. | Add a CSP (test it against the inline styles first) and shorten sessions. |
| A6 | Medium | Log-in, reset and sign-up reveal whether a number has an account. | Use one neutral message, accepting a slightly less helpful UX. |
| A7 | Low | CORS allows any origin. This is safe with bearer tokens. | Pin `ALLOWED_ORIGINS` once the domain is final. |
| A8 | Low | Hi-Lo's base card is dealt in the browser. The server prices whatever card it is sent fairly, at 96.47–96.94% a call. | Deal the base card on the server. |
| A9 | Low | Mines returns 96.14–96.96% depending on mine count and stop point, against 96.5% shown. Crossing's GHS 100,000 cap starts to bite from small stakes on the hard levels. | Show the RTP range and the cap on the game pages. |
| A10 | Medium | Since 8 October partners earn a percentage of every deposit their players make. A partner could sign up fake players, deposit, withdraw and keep the commission. | Before paying a partner, compare their players' deposits with their withdrawals on the admin partner page. Hold payouts where most deposits came straight back out. |
| A11 | Low | The exchange-rate feed has no sanity bounds. | Reject a rate that moves more than a few percent from the last one. |
| A12 | Low | Balances in retired currencies (the crypto removed in migration 018) are hidden and can't be moved. | Check production for any non-zero crypto balances. |
| A13 | Low | Ledger rows can be updated or deleted, and nothing alerts on `balance_reconciliation`. | Revoke UPDATE/DELETE from the app role and alert daily on that view. |
| A14 | Low | `toDbAmount` parses strings loosely ("1e2" becomes 12). No current caller passes strings. | Tighten the parser if a caller ever does. |
| A15 | Low | A gateway approval for a short or zero amount is confirmed with only a log line. | Flag it to admins. |
| A16 | Low | Live Mines keys real players by token hash, and Magic Ball's Redis adapter isn't installed. This only matters for multiple server instances. | Key by user id, and install the adapter before scaling out. |
| A17 | Info | The PGlite test helper can't test races (see above). | Keep race tests in `e2e/races.spec.ts`. |
| A18 | Medium | Ghana admins (added 10 October) sign in with a username and a 6-digit PIN, which has only a million values. It is guarded by a salted PBKDF2 hash, a 15-minute lock after 5 wrong PINs and a 24-hour lock from the 10th, 10 attempts per address per 10 minutes, and 12-hour sign-ins. A leaked PIN still opens Ghana's payments and players' numbers. | Give the PIN to one person, privately; replace it if it may have leaked. A second factor, such as an SMS code, would need an SMS provider. |

## Fixed, with regression tests

### Money and wallet

| # | Severity | What was wrong | Fix | Test |
| --- | --- | --- | --- | --- |
| F1 | Critical | A withdrawal used the client's own key in the ledger's shared key space. A player could take `win:live:<their bet>` and make a whole Live Mines round, plus every later sweep, fail to settle for everyone. | Withdrawal keys are namespaced per player, and the sweeps skip a failing round. | `backend/test/audit.test.ts` |
| F2 | High | A suspended account could still bet, convert and withdraw by adding `#/cashout` to the request line (proved over HTTP: GHS 25 withdrawn). | The gate checks the path Express routed. | `backend/test/security.test.ts` |
| F3 | High | An admin's Reject racing another admin's Pay could both refund and pay out the same withdrawal. | A rejection only declines an unsent request. | `audit.test.ts`, `e2e/tests/races.spec.ts` |
| F4 | High | Deposits started at the same time all passed a daily deposit limit (5 × GHS 200 against a GHS 200 limit). | One per-player lock covers the check and the new deposit, and in-flight deposits count toward the limit. | `races.spec.ts` |
| F5 | High | An admin "Add money" for a delayed deposit, followed by TheTeller's late approval, credited the deposit twice. The form's placeholder suggested exactly that. | New "Deposits waiting for TheTeller" list with a Recheck button that credits at most once. The form warns against hand-crediting deposits and can't double-credit on a resend. | `audit.test.ts` |
| F6 | High | One admin could credit their own account and approve their own withdrawal. | Both are blocked, and withdrawal decisions are now audit-logged. Two-person rules remain open (A3). | `audit.test.ts` |
| F7 | High | Two copies of the same bet arriving at once returned HTTP 500 to the second copy. A player who then tapped again placed a second bet. Found by the end-to-end suite on real Postgres. | A duplicate now returns the original result, for bets, step-game starts, conversions and withdrawals. | `e2e/tests/wallet-safety.spec.ts`, `races.spec.ts` |
| F8 | Medium | A gateway status check answered with a 4xx counted as a decline, so a payout could be refunded after it had been paid. | Any non-2xx answer is "no answer", as the TheTeller guide requires. | `audit.test.ts` |
| F9 | Medium | Retrying a deposit with the same key could start a second, untracked charge, and a deposit key wasn't tied to its player. | The transaction id is set exactly once, and keys belong to their player. | `audit.test.ts` |
| F10 | Medium | A signed-in player could push unlimited mobile-money PIN prompts to any number. | At most 3 payments can be waiting per player per 10 minutes. | `races.spec.ts` |
| F11 | Low | A conversion to a fraction of a cent returned HTTP 500. | It now returns a clear 400. | `audit.test.ts` |

### Games and fairness

| # | Severity | What was wrong | Fix | Test |
| --- | --- | --- | --- | --- |
| G1 | High | Wins rounded to the nearest cent. At GHS 0.10, Mines (2 mines, one star) and Knockout (cash-out at 1.05×) paid back 101–102%. | Every fractional payout rounds down to the cent: Mines, Crash, Knockout, Live Mines, Magic Ball and Wings. The game pages preview the same amount. | Brute-force EV check in `audit.test.ts` |
| G2 | Medium | Mines, Crossing and Goal rounds left open were never settled, so the value of stars already won was lost. | After 24 hours, a round with progress is cashed out and a round with no move is refunded (migration 019). | `audit.test.ts` |
| G3 | Medium | A bet that committed after its round had settled stayed open forever with its stake taken. | Bets lock the round row and are refused once it has settled (Live Mines and the crash games). | `audit.test.ts` |
| G4 | Low | Game, level or field names like `constructor` passed validation, took the stake and left the round stuck. | Only real entries are accepted. | `audit.test.ts` |
| G5 | Low | A stake sent as `[5]` or `true` was quietly accepted. | Stakes must be numbers. | `audit.test.ts`, `wallet-safety.spec.ts` |
| G6 | Low | Olympus's Ante cost rounded down, a discount of up to 2.6% at odd bets. | It now rounds up, on the server and in the page. | `backend/test/games.test.ts` |
| G7 | Low | Hi-Lo's lobby said 96.6% RTP; the true average is 96.8%. | The figure is corrected and the per-call range is disclosed. | Exact-RTP test in `games.test.ts` |

### Accounts and access

| # | Severity | What was wrong | Fix | Test |
| --- | --- | --- | --- | --- |
| S1 | High | The log-in, sign-up and reset rate limit keyed on a header the client controls. **Proved on production:** changing `X-Forwarded-For` reset the limit. | The limit keys on Cloudflare's `CF-Connecting-IP`, with configurable proxy hops as a fallback. `/health` reports which headers arrive. | `accounts-api/test/accounts.test.mjs` |
| S2 | High | Wrong dates of birth at the reset form locked the owner out of log-in, and allowed about 5 guesses an hour. | Reset has its own lock: 3 tries, then a day, doubling to a week. It never locks log-in. SMS codes remain open (A2). | `accounts.test.mjs` |
| S3 | Low | Partner clicks counted by a forgeable address. Clicks are never paid. | Same address logic as S1. | — |

### Live game servers

| # | Severity | What was wrong | Fix | Test |
| --- | --- | --- | --- | --- |
| L1 | High | Live Mines had no rate limit. One client renaming in a loop made the server send every player about 3,000 lists a second. | Each player gets an action allowance, and broadcasts are coalesced. | `mines-live/test/live.test.mjs` |
| L2 | Medium | Magic Ball's sync and ping events had no rate limit, in the same process as real-money Live Mines. | Both are rate-limited. | — |
| L3 | Medium | Player maps in Live Mines and in Magic Ball's memory store only ever grew. | Departed players are pruned and the maps are capped. | — |
| L4 | Low | The Magic Ball admin token was compared in non-constant time. | Constant-time comparison. | — |
| L5 | Low | After a failed result fetch, Live Mines showed the balance from before the win. | It refetches the balance. | — |
| L6 | Low | Magic Ball "Top up" could wipe a waiting bet's stake. | Top-up only works when the player is out of credits and has no bet waiting. | — |
| L7 | Low | A name sent as an object became "object Object", and a throw inside an action never answered the client. | Names must be text, and errors are caught and answered. | `live.test.mjs` |

### Layout

| # | Severity | What was wrong | Fix | Test |
| --- | --- | --- | --- | --- |
| U1 | Medium | On a 375px phone, Blaze Fruits' balance strip and bet row ran 36px off screen and cut off the "20 LINES" badge. Olympus's pillars poked 4px past the edge. | The grids shrink to fit, and the pillars are slimmer on narrow phones. | `e2e/tests/responsive.spec.ts`: 28 pages × 3 sizes |

## What the end-to-end suite covers

- **Critical flow:** sign up, deposit GHS 100 through a stand-in TheTeller, bet on Hi-Lo, win or lose, then check that the server, the game page, the header and the account page agree. A withdrawal holds the money at once.
- **Sessions:** log-out revokes the token on both services, a wrong password is refused, and a reset from another device signs every device out. Admin routes refuse players.
- **Money under pressure:** duplicate and concurrent bets, withdrawals and deposits; bad stakes; declined payments; a double-clicked Top Up. Each race ends with SQL checks: no negative balance, every journal balanced, cached balances equal to the ledger.
- **Persistence:** a Mines round survives a reload with its stake intact. A Hi-Lo bet reloaded mid-flip is settled exactly once.
- **Failures:** the balance service down or slow and the accounts server down. Each produces a clear message and no crash, money never moves twice, and the page recovers.
- **Layout:** every page at 375, 768 and 1366 pixels wide, with no sideways scroll and no uncaught errors.
