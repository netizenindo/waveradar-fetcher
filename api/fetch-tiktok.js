/**
 * WaveRadar Fetcher — TikTok Creative Center (Sumber #2)
 *
 * Mengambil hashtag & audio trending Indonesia dari endpoint internal
 * halaman publik TikTok Creative Center (TIDAK ada API resmi).
 *
 * Dipanggil cron-job.org tiap 30-60 menit:
 *   GET https://<project>.vercel.app/api/fetch-tiktok?key=<INGEST_SECRET>
 *
 * PERINGATAN: endpoint internal bisa berubah/memblokir kapan saja.
 * Desain: gagal dengan diagnosa jelas, tidak mengganggu sumber lain.
 * TIKTOK_BASE_URL bisa di-override untuk testing.
 */
import { postToIngest } from '../lib/ingest.js';

const BASE = () => process.env.TIKTOK_BASE_URL || 'https://ads.tiktok.com';

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
  Referer: 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en',
};

/** Angka besar -> "12,3 jt views" */
function humanize(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' M views';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' jt views';
  if (n >= 1e3) return Math.round(n / 1e3) + ' rb views';
  return String(n);
}

async function fetchJson(path) {
  const url = BASE() + path;
  try {
    const r = await fetch(url, { headers: COMMON_HEADERS });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* bukan JSON */ }
    return { httpStatus: r.status, json, snippet: json ? null : text.slice(0, 200) };
  } catch (e) {
    return { httpStatus: 0, json: null, snippet: e.message };
  }
}

/** Parser defensif: struktur field TikTok CC berubah-ubah antar versi. */
export function parseHashtags(json) {
  const list = json?.data?.list || json?.data?.hashtag_list || [];
  return list
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

export function parseMusic(json) {
  const list = json?.data?.music_list || json?.data?.list || json?.data?.sound_list || [];
  return list
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

export default async function handler(req, res) {
  const key = req.query.key || req.headers['x-cron-key'] || '';
  if (!process.env.INGEST_SECRET || key !== process.env.INGEST_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.INGEST_URL) {
    return res.status(500).json({ error: 'INGEST_URL belum diisi di env Vercel' });
  }

  const diagnostics = {};

  // Hashtag trending ID (7 hari terakhir)
  const ht = await fetchJson(
    '/creative_radar_api/v1/popular_trend/hashtag/list?page=1&limit=20&period=7&country_code=ID&sort_by=popular'
  );
  diagnostics.hashtag = {
    http: ht.httpStatus,
    api_code: ht.json?.code ?? null,
    snippet: ht.snippet,
  };
  const hashtags = ht.json?.code === 0 ? parseHashtags(ht.json) : [];

  // Audio/musik trending ID
  const mu = await fetchJson(
    '/creative_radar_api/v1/popular_trend/music/list?page=1&limit=20&period=7&country_code=ID&rank_type=popular'
  );
  diagnostics.music = {
    http: mu.httpStatus,
    api_code: mu.json?.code ?? null,
    snippet: mu.snippet,
  };
  const music = mu.json?.code === 0 ? parseMusic(mu.json) : [];

  const trends = [...hashtags, ...music];
  if (trends.length === 0) {
    // Gagal total — laporkan diagnosa selengkap mungkin untuk debugging
    return res.status(502).json({
      error: 'TikTok CC tidak mengembalikan data',
      hint:
        'Kemungkinan: (a) IP Vercel diblokir TikTok, (b) struktur endpoint berubah, ' +
        '(c) butuh header/sign tambahan. Kirim JSON ini ke Claude untuk dianalisis.',
      diagnostics,
    });
  }

  const result = await postToIngest(
    process.env.INGEST_URL,
    { source: 'tiktok', captured_at: new Date().toISOString(), trends },
    process.env.INGEST_SECRET
  );

  return res.status(result.status === 200 ? 200 : 502).json({
    hashtags_parsed: hashtags.length,
    music_parsed: music.length,
    ingest_status: result.status,
    ingest_response: result.body,
    diagnostics,
  });
}
