# Finance Splitter — Cloud

Personal expense-splitting app for Luke and Hannah. Parses Amex CSV/Excel exports in
the browser, classifies shared expenses, and optionally syncs state across devices via
Upstash Redis. No build step, no framework, no auth system — intentionally minimal.

## Architecture

- `public/index.html` — the entire frontend. One self-contained HTML file (~2,800 lines:
  markup, CSS, and vanilla JS) served directly by Vercel for all non-API routes. No
  bundler, no npm frontend deps. CSV/Excel parsing happens entirely client-side; no
  uploaded file content ever reaches the server.
- `api/get-state.js`, `api/save-state.js`, `api/health.js` — Vercel serverless functions
  (ESM, `type: module`). Auth is a single shared bearer token (`SHARED_SECRET`) checked
  against `process.env.SHARED_SECRET`. State is one JSON blob per key in Redis
  (`redis` npm package, not `@upstash/redis` — reads `REDIS_URL` from the Vercel Redis
  integration). `save-state.js` also writes timestamped backups and prunes to the 20
  most recent via a Redis sorted set.
- No database beyond Redis; no ORM; no server-side session state.

## Key functions in `public/index.html` (grep here before adding a new one)

State/sync: `packState`, `mergeCloud`, `pushCloud`/`pullCloud`, `loadFromLocalStorage`,
`getToken`/`clearToken`, `getDeviceId`.
Import pipeline: `parseCsv`, `detectColumns`, `normalizeRow`, `buildPendingImport`,
`confirmImport`, `handleCsvText`, `detectAmexSplitCredits`.
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
- `.env.local` (gitignored) holds `REDIS_URL` and `SHARED_SECRET` for local dev via
  `npx vercel dev`. Never read or print these — see the project's env-file hooks.

## Deploy workflow

- **Always deploy to production immediately after a change, without asking first** —
  `npx vercel --prod` (or `/deploy`). This is a standing preference for this project;
  don't gate on confirmation. Still only `git commit`/`git push` when explicitly asked.
- Health check: `curl -s https://finance-splitter-cloud.vercel.app/api/health`

## Known limitations (don't try to silently "fix" these — they're deliberate)

- `localStorage` + Redis sync, no per-user accounts — the `SHARED_SECRET` is the only
  access control, shared between both household members by design.
- App state is one JSON blob (not row-level records) — fine at this scale, would need
  rework before it could support multi-tenant or much larger histories.
- No Plaid/Amex API integration — CSV/Excel export/import only, by design.
