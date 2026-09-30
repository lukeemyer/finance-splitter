import { createClient, WatchError } from 'redis';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const MAX_BACKUPS = 500; // raised from 20 on 2026-09-29 while recovering lost statements
const STATE_KEY = 'finance-splitter:state';
const MAX_ATTEMPTS = 8;

// Processed statements are history and must survive a push from a device that never
// saw them (a stale tab, a phone whose earlier push failed). So statements and their
// processed hashes are unioned with what's already stored, minus statements some
// device deleted or reopened (tombstoned in deletedStatementIds). Everything else in
// the payload (the in-progress statement, settings, rules) stays last-write-wins.
// Keep in sync with mergeHistory() in public/index.html.
function mergeHistory(incoming, existing) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const deleted = new Set([...(existing.deletedStatementIds || []), ...(incoming.deletedStatementIds || [])]);
  const byId = new Map();
  for (const s of [...(existing.pastStatements || []), ...(incoming.pastStatements || [])]) {
    if (s && s.id && !deleted.has(s.id)) byId.set(s.id, s);
  }
  const processedHashes = {};
  const allHashes = { ...(existing.processedHashes || {}), ...(incoming.processedHashes || {}) };
  for (const [hash, statementId] of Object.entries(allHashes)) {
    if (!deleted.has(statementId)) processedHashes[hash] = statementId;
  }
  return { ...incoming, pastStatements: [...byId.values()], processedHashes, deletedStatementIds: [...deleted] };
}

export default async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.SHARED_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body must be JSON' });
  }

  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Request body too large' });
  }

  let client;
  try {
    client = createClient({ url: (process.env.REDIS_URL || '').trim() });
    await client.connect();

    // Read-merge-write under WATCH so two devices saving at once can't drop each
    // other's statements; retry if the key changed underneath us.
    let merged, bodyStr, savedAt;
    for (let attempt = 1; ; attempt++) {
      await client.watch(STATE_KEY);
      const raw = await client.get(STATE_KEY);
      const existing = raw ? JSON.parse(raw) : null;
      savedAt = new Date().toISOString();
      // Server clock stamps updatedAt so it compares cleanly with each device's
      // last-synced time (also server-issued).
      merged = { ...body, updatedAt: savedAt, appState: mergeHistory(body.appState, existing?.appState) };
      bodyStr = JSON.stringify(merged);
      if (bodyStr.length > MAX_BODY_BYTES) {
        await client.unwatch();
        return res.status(413).json({ error: 'State too large' });
      }
      try {
        await client.multi().set(STATE_KEY, bodyStr).exec();
        break;
      } catch (err) {
        if (!(err instanceof WatchError) || attempt >= MAX_ATTEMPTS) throw err;
        await new Promise(r => setTimeout(r, 20 + Math.random() * 80 * attempt));
      }
    }

    const backupKey = `finance-splitter:backup:${savedAt}`;
    await client.set(backupKey, bodyStr);

    // Track backup keys in a sorted set by timestamp; prune oldest beyond MAX_BACKUPS
    await client.zAdd('finance-splitter:backup-index', { score: Date.now(), value: backupKey });

    const backupCount = await client.zCard('finance-splitter:backup-index');
    if (backupCount > MAX_BACKUPS) {
      const excess = backupCount - MAX_BACKUPS;
      const oldKeys = await client.zRange('finance-splitter:backup-index', 0, excess - 1);
      if (oldKeys.length > 0) {
        await client.del(oldKeys);
        await client.zRemRangeByRank('finance-splitter:backup-index', 0, excess - 1);
      }
    }

    return res.status(200).json({ ok: true, savedAt, state: merged });
  } catch (err) {
    const u = process.env.REDIS_URL;
    let host = 'unset';
    if (u) { try { const p = new URL(u); host = `${p.protocol}//${p.hostname}:${p.port || '(default)'}`; } catch { host = 'unparseable'; } }
    console.error('%s failed | redis=%s | %s: %s (code=%s)', 'save-state', host, err?.name, err?.message, err?.code);
    return res.status(500).json({ error: 'Failed to save state' });
  } finally {
    client?.disconnect().catch(() => {});
  }
}
