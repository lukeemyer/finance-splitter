import { createClient } from 'redis';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

export default async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.SHARED_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let client;
  try {
    client = createClient({ url: (process.env.REDIS_URL || '').trim() });
    await client.connect();
    const raw = await client.get('finance-splitter:state');
    const state = raw ? JSON.parse(raw) : null;
    return res.status(200).json({ state });
  } catch (err) {
    const u = process.env.REDIS_URL;
    let host = 'unset';
    if (u) { try { const p = new URL(u); host = `${p.protocol}//${p.hostname}:${p.port || '(default)'}`; } catch { host = 'unparseable'; } }
    console.error('%s failed | redis=%s | %s: %s (code=%s)', 'get-state', host, err?.name, err?.message, err?.code);
    return res.status(500).json({ error: 'Failed to read state' });
  } finally {
    client?.disconnect().catch(() => {});
  }
}
