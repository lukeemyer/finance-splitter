import { Redis } from '@upstash/redis';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const MAX_BACKUPS = 20;

export default async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.SHARED_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body must be JSON' });
  }

  const bodyStr = JSON.stringify(body);
  if (bodyStr.length > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Request body too large' });
  }

  let redis;
  try {
    redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  } catch {
    return res.status(500).json({ error: 'Storage unavailable' });
  }

  const savedAt = new Date().toISOString();
  const backupKey = `finance-splitter:backup:${savedAt}`;

  try {
    await redis.set('finance-splitter:state', body);
    await redis.set(backupKey, body);

    // Track backup keys in a sorted set by timestamp; prune oldest beyond MAX_BACKUPS
    await redis.zadd('finance-splitter:backup-index', {
      score: Date.now(),
      member: backupKey,
    });

    const backupCount = await redis.zcard('finance-splitter:backup-index');
    if (backupCount > MAX_BACKUPS) {
      const excess = backupCount - MAX_BACKUPS;
      const oldKeys = await redis.zrange('finance-splitter:backup-index', 0, excess - 1);
      if (oldKeys.length > 0) {
        await Promise.all(oldKeys.map((k) => redis.del(k)));
        await redis.zremrangebyrank('finance-splitter:backup-index', 0, excess - 1);
      }
    }

    return res.status(200).json({ ok: true, savedAt });
  } catch {
    return res.status(500).json({ error: 'Failed to save state' });
  }
}
