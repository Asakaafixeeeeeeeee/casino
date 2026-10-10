# RendoWin accounts

A small Node server that lets a player register once and log in from any phone or computer. It stores **sign-in
details only**: phone number, username, date of birth and a salted scrypt hash of the password (never the password).
Balances aren't stored here — the fun-credit wallet stays in each browser.

## What it does

| Request | What it does |
|---|---|
| `POST /api/register` `{phone, username, password, dob, news}` | Creates the account (18+, Ghanaian mobile, 4–16 letter/number username) and signs in |
| `POST /api/login` `{phone, password, remember}` | Signs in. Five wrong passwords pause log-in for 30 s, doubling with every further five (up to an hour) |
| `POST /api/reset` `{phone, dob, password}` | New password, confirmed with the date of birth; signs out every device |
| `POST /api/logout` | Ends this session |
| `GET /api/me` | Who is signed in (the site checks this on each page) |
| `GET /health` | For Render's health check |

A sign-in returns a random token that the site sends as `Authorization: Bearer …`. Only the token's SHA-256 is kept
in the database. Sessions last 30 days with "Keep me signed in", otherwise 12 hours. Sign-up, log-in and reset are
also limited to 40 requests per IP address every 10 minutes.

**Note:** resetting a password with a date of birth is weak — anyone who knows a player's number and birthday can do
it. A real site would send a code by SMS instead.

## Run it on your computer

```bash
cd "casino site/accounts-api"
npm install
npm start          # http://localhost:8792
```

Without `DATABASE_URL` it uses PGlite (Postgres running inside Node) and keeps its files in `accounts-api/.data`.
The site uses `http://localhost:8792` when it's opened from localhost, and `https://asakaa-accounts.onrender.com`
otherwise.

## On Render

`render.yaml` creates the `volta-accounts` web service and the `volta-db` Postgres database and connects them
(`DATABASE_URL`). Free Render databases are deleted about 30 days after they're created unless upgraded to a paid
plan; upgrading keeps the data. The free web service sleeps when idle, so the first log-in after a quiet spell can
take up to a minute (the button says "Waking the server…").
