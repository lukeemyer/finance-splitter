# Finance Splitter

A personal finance expense-splitting app for Luke and Hannah. Parses Amex CSV exports
in the browser, classifies shared expenses, and syncs normalized app state across
devices via Upstash Redis.

---

## What it does

- Drag-and-drop an Amex statement CSV to import transactions
- Classify expenses as shared, personal, or skip
- Assign split percentages (50/50, custom %, or custom $)
- Calculate what Hannah owes per statement
- Track past statements and detect already-processed transactions
- Manage classification rules so recurring merchants are handled automatically
- Export summaries as CSV or JSON
- **Sync app state across devices** using a private Upstash Redis key–value store

---

## How the static app works

`public/index.html` is a single self-contained HTML file. No build step. Vercel serves
it directly from the `public/` directory for all non-API routes.

CSV parsing happens entirely in the browser. No CSV data is ever sent to a server.

App state (transactions, rules, settings, past statements, processed hashes) is kept
in browser `localStorage` and optionally synced to Upstash Redis.

---

## How cloud sync works

1. The user pastes their `SHARED_SECRET` token into **Settings → Cloud Sync**.
2. The token is stored only in `localStorage` — never transmitted except as an
   `Authorization` header to the app's own API routes.
3. On page load, the app calls `GET /api/get-state` to fetch the latest synced state.
4. After each state change, a debounced `POST /api/save-state` pushes updated state.
5. Manual **Push** and **Pull** buttons are available for conflict resolution.
6. If sync fails for any reason, the app continues in local-only mode.

**What is synced:** transactions, split decisions, rules, settings, past statements,
processed transaction hashes, and import metadata.

**What is never synced:** the original uploaded CSV file contents.

---

## Running locally

### Prerequisites

- Node.js 18+
- A Vercel account (free tier works)
- An Upstash account with a Redis database (free tier works)

### Steps

```bash
cd finance-splitter-cloud
npm install

# Create your local environment file (gitignored):
cp .env.local.example .env.local   # then fill in values
# — or create it manually (see "Environment variables" below)

npx vercel dev
```

The app will be available at `http://localhost:3000`.

---

## Environment variables

| Variable            | Description                                      |
|---------------------|--------------------------------------------------|
| `KV_REST_API_URL`   | Upstash Redis REST URL (from Upstash dashboard)  |
| `KV_REST_API_TOKEN` | Upstash Redis REST token (from Upstash dashboard)|
| `SHARED_SECRET`     | 64-char hex secret — acts as the sync token      |

### `.env.local` format

```
KV_REST_API_URL=https://your-db.upstash.io
KV_REST_API_TOKEN=your-upstash-token
SHARED_SECRET=your-64-char-hex-secret
```

---

## Setting up Upstash Redis

1. Go to [console.upstash.com](https://console.upstash.com) and create a new Redis database.
2. Choose **US East 1** (or the region closest to your Vercel deployment).
3. Open the database → **REST API** tab.
4. Copy the **UPSTASH_REDIS_REST_URL** → this is your `KV_REST_API_URL`.
5. Copy the **UPSTASH_REDIS_REST_TOKEN** → this is your `KV_REST_API_TOKEN`.
6. Add both to your `.env.local` and to Vercel environment variables.

---

## Deploying to Vercel

### First deploy

```bash
npx vercel login          # opens browser for auth
npx vercel link           # links to a Vercel project named finance-splitter
npx vercel env add KV_REST_API_URL
npx vercel env add KV_REST_API_TOKEN
npx vercel env add SHARED_SECRET
npx vercel --prod
```

### Subsequent deploys

```bash
git push origin main      # triggers auto-deploy if connected to GitHub
# — or —
npx vercel --prod
```

---

## Setting Vercel environment variables (CLI)

```bash
npx vercel env add KV_REST_API_URL production
npx vercel env add KV_REST_API_TOKEN production
npx vercel env add SHARED_SECRET production
```

Or via the Vercel dashboard: **Project → Settings → Environment Variables**.

---

## Entering the sync token in the app

1. Open the deployed Finance Splitter URL in your browser.
2. Navigate to **Settings → Cloud Sync**.
3. Paste your `SHARED_SECRET` value into the **Sync Token** field.
4. Click **Save Token**.
5. Click **Test Connection** to verify.
6. The badge will show **Connected** when working correctly.

The token is stored only in your browser's `localStorage`. It is masked in the UI
after saving and is never logged or stored anywhere else.

---

## Rotating SHARED_SECRET

1. Generate a new secret: `openssl rand -hex 32`
2. Update `.env.local` locally.
3. Update the Vercel env var: `npx vercel env rm SHARED_SECRET && npx vercel env add SHARED_SECRET`
4. Redeploy: `npx vercel --prod`
5. Open the app on each device → Settings → Cloud Sync → clear the old token and paste the new one.

---

## Project structure

```
finance-splitter-cloud/
  public/
    index.html        Static app (served for all non-API routes)
  api/
    health.js         GET  /api/health      — liveness check
    get-state.js      GET  /api/get-state   — read synced state (auth required)
    save-state.js     POST /api/save-state  — write synced state (auth required)
  package.json
  vercel.json
  .gitignore
  README.md
```

---

## Privacy notes

- No CSV files are ever uploaded or stored. All CSV parsing is browser-only.
- App state is stored as a single JSON blob in Upstash Redis, keyed at
  `finance-splitter:state`. Up to 20 timestamped backups are also retained.
- The `SHARED_SECRET` token is the only access control mechanism. Anyone who has
  it can read and write your synced state. Keep it private.
- Redis is secured by Upstash's own access controls in addition to the token.
- No authentication system, user accounts, or multi-user support. This is a
  personal tool for one household.

---

## Known limitations

- App state is stored as one JSON blob. Large transaction histories may approach
  Upstash's 1 MB per-value limit (the API enforces a 1 MB request cap).
- No per-user account system. The sync token acts as a shared password.
- Browser `localStorage` persists independently on each device until synced.
- Original CSV files are not stored and cannot be recovered from the cloud state.
- This is a lightweight personal app — not designed for public or multi-user use.
- Backup cleanup uses a Redis sorted set. If the sorted set is ever deleted manually,
  old backup keys will accumulate until pruned.

---

## API reference

### `GET /api/health`

Returns `{ ok: true, app: "finance-splitter" }`. No auth required.

### `GET /api/get-state`

Headers: `Authorization: Bearer <SHARED_SECRET>`

Returns `{ state: <object|null> }`.

### `POST /api/save-state`

Headers: `Authorization: Bearer <SHARED_SECRET>`, `Content-Type: application/json`

Body: JSON object (max 1 MB)

Returns `{ ok: true, savedAt: "<ISO timestamp>" }`.
