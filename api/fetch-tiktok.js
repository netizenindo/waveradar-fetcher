/**
 * WaveRadar Fetcher — TikTok Creative Center v2
 *
 * v2 (berdasarkan diagnosa lapangan):
 *  - API hashtag menolak dengan code 40101 (butuh signature) -> ditambah
 *    fallback: parse JSON tertanam di HTML halaman publik (__NEXT_DATA__ dll.)
 *  - Endpoint musik diganti ke sound/rank_list (yang lama 404)
 *
 * Strategi per dataset: coba API (beberapa kandidat) -> coba HTML.
 * Semua percobaan tercatat di diagnostics.
 */
import { postToIngest } from '../lib/ingest.js';

const BASE = () => process.env.TIKTOK_BASE_URL || 'https://ads.tiktok.com';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
  Referer: 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en',
};

const API_CANDIDATES = {
  hashtag: [
    '/creative_radar_api/v1/popular_trend/hashtag/list?page=1&limit=20&period=7&country_code=ID&sort_by=popular',
  ],
  sound: [
    '/creative_radar_api/v1/popular_trend/sound/rank_list?page=1&limit=20&period=7&rank_type=popular&country_code=ID',
    '/creative_radar_api/v1/popular_trend/music/list?page=1&limit=20&period=7&country_code=ID&rank_type=popular',
  ],
};

const HTML_PAGES = {
  hashtag: '/business/creativecenter/inspiration/popular/hashtag/pc/en',
  sound: '/business/creativecenter/inspiration/popular/music/pc/en',
};

function humanize(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' M views';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' jt views';
  if (n >= 1e3) return Math.round(n / 1e3) + ' rb views';
  return String(n);
}

/**
 * Cari rekursif di objek/array: array-of-objects yang tiap itemnya
 * mengandung SEMUA kunci wajib. Dipakai untuk menambang __NEXT_DATA__.
 */
export function deepFindList(node, requiredKeys, depth = 0) {
  if (depth > 12 || node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    if (
      node.length > 0 &&
      typeof node[0] === 'object' &&
      node[0] !== null &&
      requiredKeys.every((k) => k in node[0])
    ) {
      return node;
    }
    for (const item of node) {
      const found = deepFindList(item, requiredKeys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(node)) {
    const found = deepFindList(node[key], requiredKeys, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Ekstrak kandidat JSON tertanam dari HTML (__NEXT_DATA__, __UNIVERSAL_DATA_*, dsb.) */
export function extractEmbeddedJson(html) {
  const blobs = [];
  const patterns = [
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/,
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      try { blobs.push(JSON.parse(m[1])); } catch { /* lanjut */ }
    }
  }
  return blobs;
}

export function normalizeHashtags(list) {
  return (list || [])
    .map((h, i) => {
      const name = h.hashtag_name || h.hashtag || h.name || '';
      if (!name) return null;
      return {
        keyword: '#' + String(name).replace(/^#/, ''),
        type: 'hashtag',
        rank: Number(h.rank) || i + 1,
        volume: humanize(h.video_views ?? h.view_count ?? h.publish_cnt),
        news: [],
      };
    })
    .filter(Boolean);
}

export function normalizeSounds(list) {
  return (list || [])
    .map((m, i) => {
      const title = m.title || m.song_name || m.name || '';
      if (!title) return null;
      const author = m.author || m.author_name || m.artist || '';
      return {
        keyword: author ? `${title} — ${author}` : title,
        type: 'audio',
        rank: Number(m.rank) || i + 1,
        volume: humanize(m.user_count ?? m.video_count ?? m.use_count),
        news: [],
      };
    })
    .filter(Boolean);
}

const REQUIRED_KEYS = {
  hashtag: [['hashtag_name'], ['hashtag']],
  sound: [['title', 'author'], ['song_name'], ['title', 'clip_id']],
};

async function tryApi(kind, attempts) {
  for (const path of API_CANDIDATES[kind]) {
    try {
      const r = await fetch(BASE() + path, {
        headers: { ...BROWSER_HEADERS, Accept: 'application/json, text/plain, */*' },
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* bukan JSON */ }
      const rec = { via: 'api', path, http: r.status, api_code: json?.code ?? null, found: 0 };
      if (json?.code === 0) {
        const list =
          json?.data?.list || json?.data?.hashtag_list || json?.data?.music_list ||
          json?.data?.sound_list || json?.data?.rank_list || [];
        const items = kind === 'hashtag' ? normalizeHashtags(list) : normalizeSounds(list);
        rec.found = items.length;
        attempts.push(rec);
        if (items.length > 0) return items;
      } else {
        attempts.push(rec);
      }
    } catch (e) {
      attempts.push({ via: 'api', path, http: 0, error: e.message });
    }
  }
  return null;
}

async function tryHtml(kind, attempts) {
  const path = HTML_PAGES[kind];
  try {
    const r = await fetch(BASE() + path, { headers: BROWSER_HEADERS });
    const html = await r.text();
    const rec = { via: 'html', path, http: r.status, blobs: 0, found: 0 };
    if (!r.ok) { attempts.push(rec); return null; }

    const blobs = extractEmbeddedJson(html);
    rec.blobs = blobs.length;
    for (const blob of blobs) {
      for (const keys of REQUIRED_KEYS[kind]) {
        const list = deepFindList(blob, keys);
        if (list) {
          const items = kind === 'hashtag' ? normalizeHashtags(list) : normalizeSounds(list);
          if (items.length > 0) {
            rec.found = items.length;
            attempts.push(rec);
            return items;
          }
        }
      }
    }
    // Fallback terakhir: regex mentah di HTML
    if (kind === 'hashtag') {
      const names = [...html.matchAll(/"hashtag_name"\s*:\s*"([^"]{1,80})"/g)]
        .map((m) => m[1]);
      const unique = [...new Set(names)].slice(0, 20);
      if (unique.length > 0) {
        rec.via = 'html-regex';
        rec.found = unique.length;
        attempts.push(rec);
        return unique.map((name, i) => ({
          keyword: '#' + name.replace(/^#/, ''),
          type: 'hashtag',
          rank: i + 1,
          volume: null,
          news: [],
        }));
      }
    }
    rec.html_snippet = html.slice(0, 300);
    attempts.push(rec);
    return null;
  } catch (e) {
    attempts.push({ via: 'html', path, http: 0, error: e.message });
    return null;
  }
}

export default async function handler(req, res) {
  const key = req.query.key || req.headers['x-cron-key'] || '';
  if (!process.env.INGEST_SECRET || key !== process.env.INGEST_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.INGEST_URL) {
    return res.status(500).json({ error: 'INGEST_URL belum diisi di env Vercel' });
  }

  const attempts = { hashtag: [], sound: [] };

  const hashtags = (await tryApi('hashtag', attempts.hashtag)) ||
                   (await tryHtml('hashtag', attempts.hashtag)) || [];
  const sounds = (await tryApi('sound', attempts.sound)) ||
                 (await tryHtml('sound', attempts.sound)) || [];

  const trends = [...hashtags, ...sounds];
  if (trends.length === 0) {
    return res.status(502).json({
      error: 'TikTok CC tidak mengembalikan data (v2: API + HTML fallback gagal)',
      hint: 'Kirim JSON ini ke Claude — field attempts merinci tiap percobaan.',
      attempts,
    });
  }

  const result = await postToIngest(
    process.env.INGEST_URL,
    { source: 'tiktok', captured_at: new Date().toISOString(), trends },
    process.env.INGEST_SECRET
  );

  return res.status(result.status === 200 ? 200 : 502).json({
    hashtags_parsed: hashtags.length,
    sounds_parsed: sounds.length,
    ingest_status: result.status,
    ingest_response: result.body,
    attempts,
  });
}
