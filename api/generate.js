const { Redis } = require('@upstash/redis');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const POSTS_KEY = 'posts';
const TOPICS_KEY = 'topics';
const TOPICS_USED_KEY = 'topics:used';
const MAX_TITLE_LEN = 120;
const MAX_HTML_LEN = 200_000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';

const STYLE_GUIDE = readFileSync(join(__dirname, 'prompt.md'), 'utf8');

let redis;
function getRedis() {
  if (redis) return redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildUserTurn(topic) {
  return `Write a blog post in this style about: ${topic}

Output format (overrides any Markdown examples in the style guide — the site renders HTML, not Markdown):
- The "title" field: the post title only, lowercase, no ending punctuation, under 80 characters. Do NOT wrap it in an <h1> and do NOT repeat it inside "html".
- The "html" field: the body only, as an HTML fragment. No <html>, <head>, <body>, <h1>, <style>, or <script>. Allowed tags: <p>, <h3>, <h4>, <h5>, <ul>, <ol>, <li>, <em>, <strong>, <code>, <hr>, <a>, <blockquote>. No inline styles. No images.
- Heading levels: use <h3> where the style guide calls for H2 (major sections), <h4> for subsections, <h5> for minor notes. The Summary section is an <h3>.
- Use <hr> between major sections where the style guide suggests "---".
- Do not include a "Summary", "TL;DR", or recap section at the end. Close on a single one-line dare and stop. A wrap-up that restates the points reads like AI slop.
- Do not mention that you are an AI. Do not include a byline, date, or author line — the site adds those.`;
}

async function callGemini(apiKey, userTurn) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: STYLE_GUIDE }] },
    contents: [{ role: 'user', parts: [{ text: userTurn }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          html: { type: 'string' },
        },
        required: ['title', 'html'],
      },
    },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`gemini ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('gemini: no text in response');
  const parsed = JSON.parse(text);
  if (typeof parsed?.title !== 'string' || typeof parsed?.html !== 'string') {
    throw new Error('gemini: bad shape');
  }
  return parsed;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.json({ error: 'method not allowed' });
  }

  const secret = process.env.CRON_SECRET;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!secret || !geminiKey) {
    res.statusCode = 500;
    return res.json({ error: 'server not configured' });
  }

  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${secret}`) {
    res.statusCode = 401;
    return res.json({ error: 'unauthorized' });
  }

  if (process.env.CRON_ENABLED !== 'true') {
    return res.json({ ok: false, disabled: true });
  }

  const client = getRedis();
  if (!client) {
    res.statusCode = 500;
    return res.json({ error: 'server not configured' });
  }

  try {
    const topic = await client.srandmember(TOPICS_KEY);
    if (typeof topic !== 'string' || !topic.trim()) {
      res.statusCode = 500;
      return res.json({ error: 'topics exhausted' });
    }

    const existing = await client.zrange(POSTS_KEY, 0, -1);
    const userTurn = buildUserTurn(topic);
    const generated = await callGemini(geminiKey, userTurn);
    const title = generated.title.trim();
    const html = generated.html;

    if (!title || title.length > MAX_TITLE_LEN) {
      res.statusCode = 502;
      return res.json({ error: 'invalid title from gemini' });
    }
    if (!html || html.length > MAX_HTML_LEN) {
      res.statusCode = 502;
      return res.json({ error: 'invalid html from gemini' });
    }
    const slug = slugify(title);
    if (!slug) {
      res.statusCode = 502;
      return res.json({ error: 'invalid slug' });
    }
    if (existing.some((p) => p && p.slug === slug)) {
      res.statusCode = 409;
      return res.json({ error: 'slug exists', slug });
    }

    const ts = Date.now();
    const post = {
      slug,
      title,
      date: new Date(ts).toISOString().slice(0, 10),
      html,
      ts,
    };
    await client.zadd(POSTS_KEY, { score: ts, member: post });
    await client.smove(TOPICS_KEY, TOPICS_USED_KEY, topic);
    return res.json({ ok: true, post });
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: e.message || 'upstream error' });
  }
};
