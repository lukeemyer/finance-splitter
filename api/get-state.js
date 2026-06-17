import { Redis } from '@upstash/redis';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

// Supports two env var shapes:
//   1. KV_REST_API_URL + KV_REST_API_TOKEN  (explicitly set)
//   2. REDIS_URL  (set by Vercel's Upstash marketplace integration)
//      Format: rediss://default:TOKEN@hostname.upstash.io:PORT
function getRedisClient() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  }
  if (process.env.REDIS_URL) {
    const u = new URL(process.env.REDIS_URL);
    return new Redis({ url: `https://${u.hostname}`, token: u.password });
  }
  throw new Error('No Redis credentials configured');
}

export default async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.SHARED_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let redis;
  try {
    redis = getRedisClient();
  } catch {
    return res.status(500).json({ error: 'Storage unavailable' });
  }

  try {
    const state = await redis.get('finance-splitter:state');
    return res.status(200).json({ state: state ?? null });
  } catch {
    return res.status(500).json({ error: 'Failed to read state' });
  }
}
