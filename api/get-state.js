import { Redis } from '@upstash/redis';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

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
    redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
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
