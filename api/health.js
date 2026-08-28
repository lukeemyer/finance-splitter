import { createClient } from 'redis';

// The unauthenticated response stays cheap: it only proves the function is alive.
// The Redis probe sits behind the same bearer token as the sync routes so an open
// endpoint can't burn command quota on a metered plan.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const base = { ok: true, app: 'finance-splitter' };

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.SHARED_SECRET}`) {
    return res.status(200).json(base);
  }

  if (!process.env.REDIS_URL) {
    return res.status(503).json({ ...base, ok: false, redis: 'unconfigured' });
  }

  let client;
  try {
    client = createClient({ url: (process.env.REDIS_URL || '').trim() });
    await client.connect();
    await client.ping();
    return res.status(200).json({ ...base, redis: 'ok' });
  } catch (err) {
    // Shape only, never the credential: enough to spot a stray newline or bad scheme.
    const raw = process.env.REDIS_URL || '';
    return res.status(503).json({
      ...base,
      ok: false,
      redis: 'unreachable',
      detail: `${err?.name}: ${err?.message}`,
      urlShape: {
        length: raw.length,
        trimmedLength: raw.trim().length,
        scheme: raw.trim().split('://')[0] || null,
        endsWith: raw.slice(-6).replace(/[^\x20-\x7e]/g, '?'),
      },
    });
  } finally {
    client?.disconnect().catch(() => {});
  }
}
