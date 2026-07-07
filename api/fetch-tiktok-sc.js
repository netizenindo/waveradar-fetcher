/**
 * WaveRadar Fetcher — TikTok via ScrapeCreators (Sumber #2, final)
 *
 * Menggantikan pendekatan scraping langsung (buntu karena butuh signature).
 * 3 panggilan berbayar per refresh (1 kredit each):
 *   1. Hashtag populer Indonesia (umum)          -> type 'hashtag'
 *   2. Hashtag Indonesia baru naik (newOnBoard)  -> type 'hashtag_new'
 *   3. Trending feed video (lintas negara)       -> type 'video'
 *
 * Guard: cek kuota harian di PHP SEBELUM memanggil API berbayar,
 * catat pemakaian SESUDAH sukses. Melindungi kredit dari cron dobel.
 *
 * Dipanggil cron-job.org 4x/hari:
 *   GET https://<project>.vercel.app/api/fetch-tiktok-sc?key=<INGEST_SECRET>
 *
 * Env: SCRAPECREATORS_KEY, INGEST_SECRET, INGEST_URL, PHP_API_BASE
 *      SC_BASE_URL (opsional, testing)
 */
import { postToIngest, fetchWithChallenge } from '../lib/ingest.js';

const SC_BASE = () => process.env.SC_BASE_URL || 'https://api.scrapecreators.com';

function phpApiBase() {
  if (process.env.PHP_API_BASE) return process.env.PHP_API_BASE.replace(/\/$/, '');
  if (process.env.INGEST_URL) return process.env.INGEST_URL.replace(/\/ingest\.php$/, '');
  return null;
}

function humanize(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',') + ' M views';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' jt views';
  if (n >= 1e3) return Math.round(n / 1e3) + ' rb views';
  return String(n);
}

async function scGet(path) {
  const r = await fetch(SC_BASE() + path, {
    headers: { 'x-api-key': process.env.SCRAPECREATORS_KEY },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { http: r.status, json, snippet: json ? null : text.slice(0, 200) };
}

/** Hashtag populer -> normalisasi. type: 'hashtag' | 'hashtag_new' */
export function parseHashtags(json, type) {
  const list = json?.list || json?.data?.list || [];
  return list
    .map((h, i) => {
      const name = h.hashtag_name || h.name || '';
      if (!name) return null;
      // array trend 7-hari (nilai 0..1) -> konteks momentum ringkas
      let momentum = '';
      if (Array.isArray(h.trend) && h.trend.length >= 2) {
        const first = h.trend[0]?.value ?? 0;
        const last = h.trend[h.trend.length - 1]?.value ?? 0;
        momentum = last >= first ? 'Momentum naik di TikTok (7 hari).' : 'Momentum menurun di TikTok (7 hari).';
      }
      const news = momentum ? [{ title: momentum, url: '', snippet: '', source: 'TikTok Creative Center' }] : [];
      return {
        keyword: '#' + String(name).replace(/^#/, ''),
        type,
        rank: Number(h.rank) || i + 1,
        volume: humanize(h.video_views ?? h.publish_cnt),
        news,
      };
    })
    .filter(Boolean);
}

/** Trending feed -> video individual (aweme_list). type: 'video' */
export function parseTrendingVideos(json) {
  const list = json?.aweme_list || json?.data?.aweme_list || json?.list || [];
  return list
    .map((v, i) => {
      const desc = (v.desc || v.description || '').trim();
      const author = v.author?.nickname || v.author?.unique_id || '';
      if (!desc && !author) return null;
      // Judul kartu: caption dipangkas, fallback ke nama kreator
      let title = desc || `Video oleh ${author}`;
      if (title.length > 80) title = title.slice(0, 77) + '…';
      const stats = v.statistics || {};
      return {
        keyword: title,
        type: 'video',
        rank: i + 1,
        volume: humanize(stats.play_count ?? stats.digg_count),
        news: author ? [{ title: `Kreator: ${author}`, url: '', snippet: '', source: 'TikTok' }] : [],
      };
    })
    .filter(Boolean);
}

export default async function handler(req, res) {
  const key = req.query.key || req.headers['x-cron-key'] || '';
  if (!process.env.INGEST_SECRET || key !== process.env.INGEST_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.SCRAPECREATORS_KEY) {
    return res.status(500).json({ error: 'SCRAPECREATORS_KEY belum diisi di env Vercel' });
  }
  const base = phpApiBase();
  if (!base || !process.env.INGEST_URL) {
    return res.status(500).json({ error: 'PHP_API_BASE / INGEST_URL belum diisi' });
  }
  const secret = process.env.INGEST_SECRET;

  // 1) GUARD: cek kuota harian sebelum membakar kredit
  const guard = await fetchWithChallenge(`${base}/fetch-guard.php?action=check`, {
    headers: { 'X-Ingest-Secret': secret },
  });
  if (guard.status !== 200 || !guard.body?.ok) {
    return res.status(502).json({ error: 'Guard tidak bisa dihubungi', detail: guard.body });
  }
  if (!guard.body.allowed) {
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: 'Kuota fetch harian tercapai — melindungi kredit.',
      fetches_24h: guard.body.fetches_24h,
      max_per_day: guard.body.max_per_day,
    });
  }

  // 2) Panggil ScrapeCreators (3 request = 3 kredit)
  const diagnostics = {};
  let creditsUsed = 0;

  const h1 = await scGet('/v1/tiktok/hashtags/popular?countryCode=ID');
  diagnostics.hashtag = { http: h1.http, success: h1.json?.success ?? null, snippet: h1.snippet };
  const hashtags = h1.json?.success ? parseHashtags(h1.json, 'hashtag') : [];
  if (h1.http === 200) creditsUsed++;

  const h2 = await scGet('/v1/tiktok/hashtags/popular?countryCode=ID&newOnBoard=true');
  diagnostics.hashtag_new = { http: h2.http, success: h2.json?.success ?? null, snippet: h2.snippet };
  const hashtagsNew = h2.json?.success ? parseHashtags(h2.json, 'hashtag_new') : [];
  if (h2.http === 200) creditsUsed++;

  const v1 = await scGet('/v1/tiktok/get-trending-feed');
  diagnostics.video = { http: v1.http, snippet: v1.snippet };
  const videos = (v1.json && (v1.json.aweme_list || v1.json.list)) ? parseTrendingVideos(v1.json) : [];
  if (v1.http === 200) creditsUsed++;

  const trends = [...hashtags, ...hashtagsNew, ...videos];

  if (trends.length === 0) {
    // Tetap catat kredit yang terpakai (request tetap ditagih walau hasil kosong)
    if (creditsUsed > 0) {
      await fetchWithChallenge(`${base}/fetch-guard.php?action=record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': secret },
        body: JSON.stringify({ credits: creditsUsed, note: 'hasil kosong' }),
      });
    }
    return res.status(502).json({ error: 'ScrapeCreators tidak mengembalikan data', diagnostics });
  }

  // 3) Kirim ke ingest
  const result = await postToIngest(
    process.env.INGEST_URL,
    { source: 'tiktok', captured_at: new Date().toISOString(), trends },
    secret
  );

  // 4) Catat pemakaian kredit (guard)
  await fetchWithChallenge(`${base}/fetch-guard.php?action=record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': secret },
    body: JSON.stringify({ credits: creditsUsed, note: `${trends.length} tren` }),
  });

  return res.status(result.status === 200 ? 200 : 502).json({
    hashtags: hashtags.length,
    hashtags_new: hashtagsNew.length,
    videos: videos.length,
    credits_used: creditsUsed,
    fetches_24h: guard.body.fetches_24h + 1,
    ingest_status: result.status,
    ingest_response: result.body,
    diagnostics,
  });
}
