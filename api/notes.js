const JSONBIN_BASE = 'https://api.jsonbin.io/v3/b';
const ALLOWED_ORIGINS = [
  'https://edwin-sal.github.io',
];
const LOCALHOST_RE = /^http:\/\/localhost(:\d+)?$/;
const MAX_NOTES = 100;
const MAX_LEN = 20;
const STRIP_RE = /[\x00-\x1F\x7F\u200B-\u200D\uFEFF]/g;

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readBin(binId, key) {
  const r = await fetch(`${JSONBIN_BASE}/${binId}/latest`, {
    headers: { 'X-Access-Key': key },
  });
  if (!r.ok) throw new Error(`jsonbin read ${r.status}`);
  const data = await r.json();
  return Array.isArray(data?.record?.notes) ? data.record.notes : [];
}

async function writeBin(binId, key, notes) {
  const r = await fetch(`${JSONBIN_BASE}/${binId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Access-Key': key,
    },
    body: JSON.stringify({ notes }),
  });
  if (!r.ok) throw new Error(`jsonbin write ${r.status}`);
}

module.exports = async (req, res) => {
  const origin = pickOrigin(req.headers.origin);
  setCors(res, origin);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const binId = process.env.JSONBIN_BIN_ID;
  const key = process.env.JSONBIN_API_KEY;
  if (!binId || !key) {
    res.statusCode = 500;
    return res.json({ error: 'server not configured' });
  }

  // TODO(rate-limit): before prod, gate POST by IP using an in-memory
  // Map<ip, lastPostTs> keyed off req.headers['x-forwarded-for'].
  // 1 post / minute / IP, return 429 on excess.

  try {
    if (req.method === 'GET') {
      const notes = await readBin(binId, key);
      return res.json(notes);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const raw = body?.text;
      if (typeof raw !== 'string') {
        res.statusCode = 400;
        return res.json({ error: 'text required' });
      }
      const text = raw.replace(STRIP_RE, '').trim();
      if (!text || text.length > MAX_LEN) {
        res.statusCode = 400;
        return res.json({ error: 'invalid length' });
      }
      const notes = await readBin(binId, key);
      notes.push({ text, ts: Date.now() });
      const trimmed = notes.slice(-MAX_NOTES);
      await writeBin(binId, key, trimmed);
      return res.json({ ok: true });
    }

    res.statusCode = 405;
    return res.json({ error: 'method not allowed' });
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'upstream error' });
  }
};
