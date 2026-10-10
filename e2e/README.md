# End-to-end tests

The real site, accounts server and balance service, wired together on this machine and driven in Google Chrome by
Playwright. Nothing touches production or the real payment gateway.

| Piece | Where | Runs as |
| --- | --- | --- |
| Site | http://localhost:8808 | `stack/static.mjs` serving the repository root |
| Accounts server | http://localhost:8792 | `accounts-api/server.js` on an in-memory database |
| Balance service | http://localhost:8781 | `backend/src/server.ts` after `migrate-production.mjs`, on a throwaway real Postgres |
| Payment gateway | http://127.0.0.1:8796 | `stack/teller-stub.mjs` |

The gateway stub approves every payment, declines a number ending `0000`, and never answers for a number ending
`9999`. `GET /requests` lists what it was sent.

## Run

```
cd e2e
npm install
npx playwright test                       # all specs, ~8 minutes
npx playwright test tests/money-flow.spec.ts
npx playwright test --headed              # watch it in a browser window
npx playwright show-report                # the HTML report from the last run
```

It needs Node 18+ and Google Chrome. Playwright drives the installed Chrome, so no browser is downloaded. The first
run downloads a Postgres binary for `embedded-postgres`.

`E2E_DB=pglite npx playwright test` swaps the real Postgres for the backend's in-memory PGlite. That is faster, but
PGlite serves every connection from one session, so `races.spec.ts` refuses to run on it.

## Specs

- `money-flow.spec.ts`: sign up, deposit, bet, win or lose, and every balance agrees; withdrawal holds.
- `auth.spec.ts`: log-out and reset revoke sessions; wrong passwords; admin routes refuse players.
- `wallet-safety.spec.ts`: duplicate and burst bets, concurrent withdrawals, bad stakes, declined and double-clicked deposits.
- `races.spec.ts`: concurrency on real Postgres, each test ending with SQL ledger checks.
- `persistence.spec.ts`: a Mines round across a reload; a Hi-Lo bet reloaded mid-flip.
- `resilience.spec.ts`: services down or slow; clear messages, no double money, recovery.
- `responsive.spec.ts`: every page at phone, tablet and desktop width, with no sideways scroll and no page errors.
