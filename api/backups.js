import { createClient } from 'redis';

// Read-only view of the timestamped backups save-state.js writes. Without `key` it
// lists every backup with a per-statement summary; with `key` it returns that backup.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.SHARED_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let client;
  try {
    client = createClient({ url: (process.env.REDIS_URL || '').trim() });
    await client.connect();

    const key = typeof req.query?.key === 'string' ? req.query.key : null;
    if (key) {
      if (!key.startsWith('finance-splitter:backup:')) return res.status(400).json({ error: 'Not a backup key' });
      const raw = await client.get(key);
      if (!raw) return res.status(404).json({ error: 'No such backup' });
      return res.status(200).json({ key, state: JSON.parse(raw) });
    }

    const keys = await client.zRange('finance-splitter:backup-index', 0, -1);
    const backups = [];
    for (const k of keys) {
      const raw = await client.get(k);
      if (!raw) { backups.push({ key: k, missing: true }); continue; }
      const s = JSON.parse(raw);
      const app = s.appState || {};
      backups.push({
        key: k,
        updatedAt: s.updatedAt,
        deviceId: s.deviceId,
        inProgress: (app.transactions || []).length,
        deleted: app.deletedStatementIds || [],
        statements: (app.pastStatements || []).map(st => ({
          id: st.id, name: st.name, period: `${st.periodStart} → ${st.periodEnd}`, processed: st.processedDate,
          txns: (st.transactions || []).length, owed: st.hannahOwed, total: st.includedTotal,
        })),
      });
    }
    return res.status(200).json({ count: backups.length, backups });
  } catch (err) {
    console.error('backups failed | %s: %s', err?.name, err?.message);
    return res.status(500).json({ error: 'Failed to read backups' });
  } finally {
    client?.disconnect().catch(() => {});
  }
}
