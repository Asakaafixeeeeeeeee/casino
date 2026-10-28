# whyareyoubroke

## Football data and wagering status

The Sports page is an original WIN B interface informed by public sportsbook navigation patterns (football, live, results, leagues and bet history). It does not copy SportyBet assets or use its private APIs. It contains no fabricated fixtures or prices.

The optional fixture adapter uses the documented football-data.org v4 `/matches` endpoint. Its coverage page lists competitions available on different plans, including a free tier, but plan availability alone does **not** establish permission for a commercial sportsbook, redistribution, or live betting display. Confirm those rights in writing for WIN B's jurisdictions and use case before setting `FOOTBALL_DATA_COMMERCIAL_RIGHTS_CONFIRMED=true`; then set `FOOTBALL_DATA_API_KEY` on the backend only (for example, in the backend hosting provider's environment settings). Never paste the API token into chat, source code, browser JavaScript, or a public `.env` file. The key is never sent to browsers. The provider refresh is cached server-side for 60 seconds.

Official provider references:

- [football-data.org coverage](https://www.football-data.org/coverage)
- [football-data.org pricing](https://www.football-data.org/pricing)
- [football-data.org API quickstart](https://www.football-data.org/documentation/quickstart)

No odds provider is configured. A fixture/scores plan is not an odds license: obtain a separate written commercial odds-feed agreement covering operator display/redistribution, territories, permitted markets, update rates and retention before enabling odds. Real-money football wagering is hard-disabled in the database and has no bet submission or wallet debit API.

Custom fixtures created in Admin are drafts until published and are always labeled `CUSTOM EVENT`; they are not provider-imported fixtures. Admins can upload PNG, JPEG, or WebP custom team logos (maximum 512 KB), edit scores, and publish final scores to the Results view. These are manually administered events and results, not provider-verified or wagerable outcomes. Provider team crests are displayed only with the gated feed. The football banner photograph is Volksparkstadion by Mario Klassen, available under CC0 via [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Well_lit_soccer_stadium_(Unsplash).jpg). Apply backend migrations `054_deposit_failure_restrictions.sql`, `055_football_foundation.sql`, and `056_football_team_logos.sql` through the normal production migration command before deploying the new pages.

## Failed-deposit restriction

The default 30-hour restriction is started only when the authenticated payment provider returns a final declined result through the settlement path. A request creation error, network failure, pending result or unknown status does not activate it. Existing restrictions continue to the stored expiry if the feature is switched off; an admin can remove an active restriction with a required reason. The backend is authoritative for all deposit methods and remains the enforcement point regardless of browser state.
