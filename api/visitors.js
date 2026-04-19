const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const ALLOWED_ORIGINS = [
  'https://edwinsal.vercel.app',
];
const LOCALHOST_RE = /^http:\/\/localhost(:\d+)?$/;
const COUNT_KEY = 'visitors:total';
const SEEN_KEY = 'visitors:seen';
const VISITOR_TTL_MS = 24 * 60 * 60 * 1000;

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
}

function hashVisitor(ip, ua) {
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 16);
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
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ua = req.headers['user-agent'] || '';
    let count;
    if (ip) {
      const now = Date.now();
      await client.zremrangebyscore(SEEN_KEY, 0, now - VISITOR_TTL_MS);
      const added = await client.zadd(SEEN_KEY, { nx: true }, { score: now, member: hashVisitor(ip, ua) });
      if (added === 1) {
        count = await client.incr(COUNT_KEY);
      } else {
        count = (await client.get(COUNT_KEY)) ?? 0;
      }
    } else {
      count = (await client.get(COUNT_KEY)) ?? 0;
    }
    return res.json({ count: Number(count) });
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'upstream error' });
  }
};
