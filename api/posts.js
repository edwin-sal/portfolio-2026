const { Redis } = require('@upstash/redis');

const ALLOWED_ORIGINS = [
  'https://edwinsal.vercel.app',
];
const LOCALHOST_RE = /^http:\/\/localhost(:\d+)?$/;
const POSTS_KEY = 'posts';

let redis;
function getRedis() {
  if (redis) return redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

function pickOrigin(origin) {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (LOCALHOST_RE.test(origin)) return origin;
  return null;
}

function setCors(res, origin) {
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  const origin = pickOrigin(req.headers.origin);
  setCors(res, origin);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.json({ error: 'method not allowed' });
  }

  const client = getRedis();
  if (!client) {
    res.statusCode = 500;
    return res.json({ error: 'server not configured' });
  }

  try {
    const url = new URL(req.url, 'http://x');
    const title = url.searchParams.get('title');
    const limit = parseInt(url.searchParams.get('limit') || '', 10);
    const all = await client.zrange(POSTS_KEY, 0, -1);
    const newestFirst = all.slice().reverse();

    if (title) {
      const hit = newestFirst.find((p) => p && p.slug === title);
      if (!hit) {
        res.statusCode = 404;
        return res.json({ error: 'not found' });
      }
      return res.json(hit);
    }

    const list = Number.isFinite(limit) && limit > 0
      ? newestFirst.slice(0, limit)
      : newestFirst;
    return res.json(list);
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'upstream error' });
  }
};
