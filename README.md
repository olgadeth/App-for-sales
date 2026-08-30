# FieldSales CRM — with real cross-device sync

Your CRM used to store everything in the browser's `localStorage`, which is why
it only ever showed up on one device. This version adds a small Node.js +
Express server with a real database (SQLite), so the same data follows you
between your phone and your laptop.

## How it works

- `server.js` — the backend. It stores your whole CRM (facilities, visits,
  quotes, orders) as one record in a local database file (`data.db`), behind a
  password.
- `public/index.html` — your CRM, mostly unchanged, but it now talks to the
  server instead of only saving to the browser. It still keeps a local copy
  too, so it keeps working for a few seconds if your connection drops.

## 1. Run it on your own computer first

You'll need [Node.js](https://nodejs.org) installed (v18 or newer).

```bash
cd fieldsales-crm
npm install
cp .env.example .env
```

Open `.env` and set `AUTH_PASSWORD` to a password only you know. Then:

```bash
npm start
```

Open `http://localhost:3000` in your browser, log in with that password, and
your CRM loads exactly as before — except now it's backed by the server.

## 2. Put it online so your phone and laptop both reach it

Running it only on your laptop means your phone still can't see it unless
they're on the same network. To access it from anywhere, deploy it — both of
these have free tiers and don't need a credit card to start:

### Option A: Render.com
1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), click **New → Web Service**, connect
   the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Under **Environment**, add `AUTH_PASSWORD` and `JWT_SECRET` (same as your
   `.env`, but never commit `.env` itself — it's already git-ignored).
5. Deploy. Render gives you a URL like `https://fieldsales-crm.onrender.com`.

### Option B: Railway.app
1. Push this folder to GitHub.
2. On [railway.app](https://railway.app), **New Project → Deploy from GitHub**.
3. Add the same two environment variables in the Railway dashboard.
4. Railway auto-detects Node.js and deploys; it gives you a public URL too.

Either way: once deployed, open that URL on your phone and your laptop, log in
with your password on both, and you'll see the same data on both — add a
facility visit on your phone, refresh on your laptop, and it's there.

## Notes

- This is a single-user app — one password, one shared dataset. That matches
  how you're using it today (your own Sharjah territory data), so there's no
  separate login per person.
- The database is a single file (`data.db`) inside the server. On Render or
  Railway's free tiers this file can reset if the service restarts/redeploys —
  fine for testing, but for anything you can't afford to lose, use the
  **Export backup** button inside the CRM every so often (top of the app) —
  it downloads a JSON file exactly like before.
- If you ever want to upgrade from SQLite to a hosted database (e.g. if you
  add more users later), the API surface (`/api/state`) stays the same — only
  `server.js` would need to change internally.
