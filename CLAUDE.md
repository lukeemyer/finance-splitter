# Finance Splitter — Cloud

Personal expense-splitting app for Luke and Hannah. Parses Amex CSV/Excel exports (plus
Amazon/Costco rows from Chase CSV exports) in the browser, classifies shared expenses, and optionally syncs state across devices via
Upstash Redis. No build step, no framework, no auth system — intentionally minimal.

## Architecture

- `public/index.html` — the entire frontend. One self-contained HTML file (~3,100 lines:
  markup, CSS, and vanilla JS) served directly by Vercel for all non-API routes. No
  bundler, no npm frontend deps. CSV/Excel parsing happens entirely client-side; no
  uploaded file content ever reaches the server. Excel files go through SheetJS loaded
  from cdnjs (`xlsx/0.18.5`) and are converted to CSV text before hitting `handleCsvText`
  (`readFile` strips Amex's metadata rows above the header). The `xlsx` entry in
  `package.json` is not imported by anything.
- `api/get-state.js`, `api/save-state.js`, `api/health.js` — Vercel serverless functions
  (ESM, `type: module`). Auth is a single shared bearer token (`SHARED_SECRET`) checked
  against `process.env.SHARED_SECRET`. State is one JSON blob per key in Redis
  (`redis` npm package, not `@upstash/redis` — reads `REDIS_URL` from the Vercel Redis
  integration). `save-state.js` does a WATCH/MULTI read-merge-write (see Sync below),
  stamps `updatedAt` with server time, returns the merged state, and writes timestamped
  backups pruned to the 20 most recent via a Redis sorted set.
- `api/parse-receipt.js` — receipt OCR for the "Add Receipt" flow. Takes a base64 JPEG
  data URL (6 MB cap), calls the Anthropic Messages API via plain `fetch` (no SDK) with
  forced tool-use (`record_receipt`) and returns `{items, subtotal, tax, tip, total}`.
  Model is `claude-haiku-4-5-20251001` (switched from Sonnet for cost). Needs
  `ANTHROPIC_API_KEY`; `maxDuration: 30` is set in `vercel.json`.
- No database beyond Redis; no ORM; no server-side session state.

## Key functions in `public/index.html` (grep here before adding a new one)

State/sync: `packState`, `mergeCloud`, `pushCloud`/`pullCloud`, `loadFromLocalStorage`,
`getToken`/`clearToken`, `getDeviceId`.
Import pipeline: `importFiles` (multi-file drop/select) → `readFileText` (Excel → CSV)
→ `parseImportText` → `buildPendingImport` (Amex) or `buildChaseImport`, each returning a
per-file "part" → `stagePendingImport(parts)` (combined dedupe + one preview) →
`confirmImport`. `handleCsvText` is the single-text shortcut used by demo data.
`showColumnMapping` returns a Promise; dismissing the modal resolves null through
`modalCloseHook` in `closeModal`. Also `parseCsv`, `detectColumns`, `normalizeRow`,
`detectAmexSplitCredits`.
Chase import: `handleCsvText` routes files whose headers match `isChaseExport` to
`buildChaseImport`. It flips the sign (Chase exports purchases as negatives), keeps only
`CHASE_MERCHANT_RX` (Amazon/Costco), skips rows dated on or before
`lastProcessedPeriodEnd()` (Chase rows were never settled, so the processed-hash check
can't catch old ones), and sets `reference` to `chase#N` so identical same-day charges
get distinct hashes.
Classification/splits: `classifyTransaction`, `classifyOnIntake`, `applyRuleToTransaction`,
`applyRulesToCurrent`, `applySplitType`, `calculateTransactionSplit`,
`calculateDashboardTotals`, `defaultRules`.
Transaction identity: `createTransactionHash` — stable hash of
`date + amount + description + reference + account number`, used for in-file dupes,
already-in-set rows, and already-processed rows from past statements.
Statements: `markStatementProcessed`, `doMarkProcessed`, `loadPastStatements`,
`deleteStatement`, `clearCurrentStatement`.
Export: `exportStatementCsv`, `exportSummaryCsv`, `exportAllDataJson`,
`importAllDataJson`, `printableReport`.
Views: `showView`, `renderDashboard`, `renderReview`, `renderQueue` (One at a Time),
`renderManualEntry`, `renderPast`, `renderRules`, `renderSettings`, `refreshAll`.
Receipts: `openReceiptModal`, `handleReceiptFile`, `resizeImageForUpload`,
`renderReceiptItems`, `computeReceiptSplitPercent`, `applyReceiptSplit`. The photo is
never persisted — only `t.receiptItems`/`t.receiptTax`/`t.receiptTip` are stored, to stay
under the 1 MB sync cap.
Sync lives in its own IIFE at the bottom of the file and talks to the app only through
`localStorage` (`financeSplitter:v1`) and `window.fsSyncTrigger` (called from
`saveToLocalStorage`, debounced 2.5 s).

**Sync invariant: a processed statement is never dropped by sync.** `mergeHistory` (in
both `api/save-state.js` and the sync IIFE; keep them identical) unions `pastStatements`
by id and `processedHashes`, minus ids in `deletedStatementIds` (tombstones written by
`tombstoneStatement` on delete/reopen). Everything else (in-progress transactions,
settings, rules) is last-write-wins: on pull, `mergeCloud` takes the cloud copy if its
`updatedAt` is newer than `fs_last_synced`, then unions history either way and pushes if
the cloud was missing any. The server applies the same union on every save, so even an
old cached client can't erase history. `doMarkProcessed` pushes immediately and warns if
it failed; failed pushes retry every 60 s; the app re-pulls on `visibilitychange`.
Background: in Sep 2026 a statement processed during a Redis outage was lost because the
old whole-blob replace let one device's copy overwrite another's.

## Split math

- `Hannah owes = |amount| × hannahPercent / 100`
- `Luke pays = |amount| − Hannah owes`
- Credits, refunds, payments, and already-processed rows never increase the amount owed.
- Only reviewed expenses count toward the settlement total.
- Money math is plain floating point — acceptable at this scale, don't over-engineer
  precision handling here.

## Conventions

- Keep it a single-file static app on purpose. Don't introduce a bundler, framework, or
  build step without an explicit ask — that's a deliberate simplicity trade-off, not an
  oversight.
- New API routes follow the existing handler shape: set CORS headers, check method,
  check `Authorization: Bearer <SHARED_SECRET>`, then act. Keep the 1 MB body cap
  (`MAX_BODY_BYTES`) in mind for anything that writes to Redis.
- Env vars: `SHARED_SECRET`, `REDIS_URL` (must be `rediss://` for Upstash TLS),
  `ANTHROPIC_API_KEY`. `vercel dev` reads Vercel's linked **Development** env vars, not
  just `.env.local` — add new secrets with `vercel env add <NAME> development|production`.
  Never read or print env files — see the project's env-file hooks.

## Deploy workflow

- **Always deploy to production immediately after a change, without asking first** —
  `npx vercel --prod` (or `/deploy`). This is a standing preference for this project;
  don't gate on confirmation. Still only `git commit`/`git push` when explicitly asked.
- Health check: `curl -s https://finance-splitter-cloud.vercel.app/api/health` (liveness
  only; with `Authorization: Bearer <SHARED_SECRET>` it also pings Redis and returns
  `redis: ok|unreachable|unconfigured`).

## Known limitations (don't try to silently "fix" these — they're deliberate)

- `localStorage` + Redis sync, no per-user accounts — the `SHARED_SECRET` is the only
  access control, shared between both household members by design.
- App state is one JSON blob (not row-level records) — fine at this scale, would need
  rework before it could support multi-tenant or much larger histories.
- No Plaid/Amex API integration — CSV/Excel export/import only, by design.
