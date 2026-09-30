# Finance Splitter

A personal expense-splitting app for Luke and Hannah. Import an Amex statement (CSV or
Excel), decide how each charge is split, and get a settlement total plus a ready-to-send
Venmo message. App state syncs across devices through a private Redis store.

Live at **https://finance-splitter-cloud.vercel.app**.

---

## What it does

- **Import** an Amex `.csv`, `.xlsx`, or `.xls` export by drag-and-drop — drop or select
  the Amex and Chase files together and they're combined into one preview. Columns are
  auto-detected, with a manual column-mapping fallback. A preview shows duplicates,
  already-processed rows, and credits/refunds/payments before anything is added.
- **Chase import** — upload a Chase activity CSV alongside the Amex statement. Only
  Amazon and Costco purchases are kept, and only those dated after the last processed
  statement's end date, so already-settled months aren't pulled in again. The preview
  shows how many rows were skipped for each reason.
- **Manual entry** for charges that aren't on the statement.
- **Review** transactions in a table (split buttons, custom %, bulk actions, filters,
  search) or **One at a Time**, a swipe-style queue with undo.
- **Add Receipt** — photograph a receipt, have each line item read automatically,
  assign items to Luke / Shared / Hannah, and apportion tax and tip proportionally.
  Available from both the queue and the Review table.
- **Rules** auto-classify recurring merchants (e.g. Trader Joe's = 50/50, Spotify = Luke
  only, payments/refunds/credits = exclude) when you press Auto-assign.
- **Dashboard** with what Hannah owes, the statement total, the unreviewed amount,
  review progress, a Venmo message, and CSV / printable-report exports.
- **Past statements** — mark a statement processed; its transactions are remembered so
  they're auto-excluded from future imports. Statements can be reopened or deleted.
- **Sync** app state across devices, with a shareable pairing link.

## Split math

- `Hannah owes = |amount| × hannahPercent / 100`
- `Luke pays = |amount| − Hannah owes`
- Only **reviewed expenses** count toward the settlement. Credits, refunds, payments,
  excluded rows, and already-processed rows never increase the amount owed.

Each transaction's identity is a hash of `date + amount + description + reference +
account number`, used to detect duplicates and previously processed charges.

---

## How it works

```
public/index.html  ──  the entire frontend (HTML + CSS + vanilla JS, no build step)
        │
        ├── GET  /api/get-state      read synced state  ─┐
        ├── POST /api/save-state     write synced state ─┼─ Redis (Upstash)
        ├── GET  /api/health         liveness / Redis   ─┘
        └── POST /api/parse-receipt  receipt photo ──────── Anthropic API (Claude Haiku)
```

- **Statement files never leave the browser.** CSV is parsed in-page; Excel files are
  converted to CSV in-page with SheetJS.
- **State** (transactions, splits, rules, settings, past statements, processed hashes)
  lives in `localStorage` and is pushed to Redis as one JSON blob, debounced ~2.5 s
  after each change. Every save also writes a timestamped backup; the 20 most recent
  are kept.
- **Processed statements are never lost to sync.** Both the server and each device merge
  statement history (union, minus deliberate deletes) instead of replacing it, so a
  stale device can't erase a statement another device processed. Processing a statement
  uploads it immediately and keeps retrying if the connection is down.
- **On load and whenever the app returns to the foreground**, it pulls the cloud copy.
  The in-progress statement, settings and rules follow whichever copy is newer — avoid
  editing the same in-progress statement on two devices at the same moment.
- **Receipt photos** are downscaled in the browser, sent to `/api/parse-receipt`, and
  discarded. Only the parsed line items, tax, and tip are saved on the transaction. The
  receipt total must match the charge within $0.02 before items can be assigned.

---

## Running locally

Prerequisites: Node.js 18+, the Vercel CLI (via `npx`), and access to the linked Vercel
project.

```bash
cd finance-splitter-cloud
npm install
npx vercel link    # first time only — links to lukeemyers-projects/finance-splitter-cloud
npx vercel dev     # http://localhost:3000
```

`vercel dev` pulls the project's **Development** environment variables from Vercel. A
variable placed only in `.env.local` may not be picked up, so add secrets on Vercel
(see below) and restart `vercel dev`.

The app works without any env vars in local-only mode — sync and Add Receipt just stay
disabled until a sync token is set.

---

## Environment variables

| Variable            | Used by                          | Description |
|---------------------|----------------------------------|-------------|
| `SHARED_SECRET`     | all API routes                   | 64-char hex token; the only access control. Generate with `openssl rand -hex 32`. |
| `REDIS_URL`         | get-state, save-state, health    | Redis connection string. For Upstash it **must** start with `rediss://` (TLS). |
| `ANTHROPIC_API_KEY` | parse-receipt                    | Anthropic API key for receipt reading. |

Set them per environment:

```bash
npx vercel env add SHARED_SECRET production
npx vercel env add SHARED_SECRET development
# …same for REDIS_URL and ANTHROPIC_API_KEY
```

Preview deployments intentionally have no `SHARED_SECRET`, so they can't reach the sync
API.

### Setting up Redis (Upstash)

The Vercel Marketplace no longer offers a free Redis plan, so sign up **directly** at
[console.upstash.com](https://console.upstash.com):

1. Create a Redis database in a region near the Vercel deployment (US East).
2. Copy the connection URL from the database page.
3. Change the scheme from `redis://` to **`rediss://`** — node-redis needs the double
   `s` to use TLS, and every connection fails without it.
4. Add it as `REDIS_URL` (`npx vercel env add REDIS_URL production`). Watch for a stray
   carriage return when pasting — the authenticated health check (below) reports the
   URL's shape so this is easy to spot.
5. Redeploy.

---

## Deploying

```bash
npx vercel --prod
```

Then check it:

```bash
# Liveness only
curl -s https://finance-splitter-cloud.vercel.app/api/health

# Liveness + Redis ping
curl -s -H "Authorization: Bearer $SHARED_SECRET" \
  https://finance-splitter-cloud.vercel.app/api/health
```

---

## Using sync in the app

1. Open the app → **Settings → Cloud Sync**.
2. Paste the `SHARED_SECRET` value into **Sync Token** and click **Save**. The
   connection is tested automatically; the badge shows **Connected** when it works.
3. To pair another device, click **Copy shareable link** and open it there. The link
   contains the token in its `#sync=` fragment, so share it only privately.
4. **Push to cloud** and **Pull from cloud** buttons force a sync in either direction.

The token is stored in the browser's `localStorage` and sent only as an `Authorization`
header to this app's own API routes.

### Rotating `SHARED_SECRET`

1. `openssl rand -hex 32`
2. `npx vercel env rm SHARED_SECRET production && npx vercel env add SHARED_SECRET production`
   (repeat for `development`)
3. `npx vercel --prod`
4. On each device: **Settings → Cloud Sync → Clear token**, then paste the new token.

---

## API reference

All authenticated routes take `Authorization: Bearer <SHARED_SECRET>` and return `401`
without it.

| Route | Auth | Request | Response |
|-------|------|---------|----------|
| `GET /api/health` | optional | — | `{ ok, app }`. With auth, also pings Redis: `redis: "ok"` (200), or `"unreachable"` / `"unconfigured"` (503) with diagnostics. |
| `GET /api/get-state` | required | — | `{ state: <object \| null> }` |
| `POST /api/save-state` | required | JSON state blob, ≤ 1 MB | `{ ok: true, savedAt: "<ISO>" }`; `413` if too large |
| `POST /api/parse-receipt` | required | `{ image: "data:image/jpeg;base64,…" }`, ≤ 6 MB | `{ items: [{name, price}], subtotal?, tax?, tip?, total }`; `502` if unreadable |

Redis keys: `finance-splitter:state` (current), `finance-splitter:backup:<ISO>`
(backups), `finance-splitter:backup-index` (sorted set used for pruning).

---

## Project structure

```
finance-splitter-cloud/
  public/
    index.html          the whole frontend
  api/
    health.js           GET  /api/health
    get-state.js        GET  /api/get-state
    save-state.js       POST /api/save-state
    parse-receipt.js    POST /api/parse-receipt
  vercel.json           SPA rewrite + 30 s timeout for parse-receipt
  package.json
  CLAUDE.md             notes for Claude Code (architecture, conventions)
```

---

## Privacy and limitations

- Statement files are never uploaded or stored. Receipt photos are sent to the
  Anthropic API for reading and not stored.
- `SHARED_SECRET` is the only access control — anyone with it can read and write the
  synced state. There are no user accounts; this is a single-household tool by design.
- State is one JSON blob capped at 1 MB. Very long histories would eventually need a
  different storage shape.
- The in-progress statement is last-write-wins across devices (processed statements are
  merged and never dropped).
- No Plaid or Amex API integration — file import only, by design.
- Money math uses plain floating point, which is fine at this scale.
