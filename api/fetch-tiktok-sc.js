/**
 * WaveRadar Fetcher — TikTok via ScrapeCreators v2 (disesuaikan pasar Indonesia)
 *
 * PERUBAHAN dari v1: panggilan #3 (trending feed video lintas-negara — kurang
 * relevan untuk Indonesia) DIGANTI dengan hashtag per-industri Indonesia,
 * dirotasi tiap refresh agar semua industri terwakili tanpa boros kredit.
 *
 * 3 panggilan berbayar per refresh (1 kredit each):
 *   1. Hashtag populer Indonesia (umum)              -> type 'hashtag'
 *   2. Hashtag Indonesia baru naik (newOnBoard)      -> type 'hashtag_new'
 *   3. Hashtag Indonesia 1 industri (rotasi)         -> type 'hashtag', +industry
 *
 * Rotasi industri ditentukan slot 6-jam-an (0..3) dikombinasi hari,
 * sehingga 4 refresh/hari menyentuh industri berbeda dan bergilir antar hari.
 *
 * Env: SCRAPECREATORS_KEY, INGEST_SECRET, INGEST_URL, PHP_API_BASE, SC_BASE_URL(opsional)
 */
import { postToIngest, fetchWithChallenge } from '../lib/ingest.js';

const SC_BASE = () => process.env.SC_BASE_URL || 'https://api.scrapecreators.com';

/**
 * Industri ScrapeCreators yang relevan untuk pasar Indonesia, diurutkan
 * sebagai daftar rotasi. Label dipakai sebagai konteks pada tren.
 * (ScrapeCreators memakai slug industri ini pada parameter `industry`.)
 */
const SC_INDUSTRIES = [
  { slug: 'food-and-beverage', label: 'F&B' },
  { slug: 'beauty-and-personal-care', label: 'Beauty' },
  { slug: 'apparel-and-accessories', label: 'Fashion' },
  { slug: 'tech-and-electronics', label: 'Tech' },
  { slug: 'life-services', label: 'Jasa & Layanan' },
  { slug: 'health', label: 'Kesehatan' },
  { slug: 'education', label: 'Edukasi' },
  { slug: 'travel', label: 'Travel' },
  { slug: 'vehicle-and-transportation', label: 'Otomotif' },
  { slug: 'financial-services', label: 'Keuangan' },
  { slug: 'home-improvement', label: 'Properti & Rumah' },
  { slug: 'games', label: 'Games & Hiburan' },
];

/** Pilih industri berdasarkan slot waktu, bergilir & memutar tiap hari. */
export function pickIndustry(now = new Date()) {
  const daysSinceEpoch = Math.floor(now.getTime() / 86400000);
  const slot = Math.floor(now.getUTCHours() / 6); // 0..3 (4 slot/hari)
  const idx = (daysSinceEpoch * 4 + slot) % SC_INDUSTRIES.length;
  return SC_INDUSTRIES[idx];
}

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

/**
 * Hashtag populer -> normalisasi.
 * @param type 'hashtag' | 'hashtag_new'
 * @param industryLabel opsional -> ditambahkan ke konteks & jadi penanda
 */
export function parseHashtags(json, type, industryLabel = '') {
  const list = json?.list || json?.data?.list || [];
  return list
    .map((h, i) => {
      const name = h.hashtag_name || h.name || '';
      if (!name) return null;

      let momentum = '';
      if (Array.isArray(h.trend) && h.trend.length >= 2) {
        const first = h.trend[0]?.value ?? 0;
        const last = h.trend[h.trend.length - 1]?.value ?? 0;
        momentum = last >= first
          ? 'Momentum naik di TikTok (7 hari).'
          : 'Momentum menurun di TikTok (7 hari).';
      }

      const ctxParts = [];
      if (industryLabel) ctxParts.push(`Hashtag industri ${industryLabel} di TikTok Indonesia.`);
      if (momentum) ctxParts.push(momentum);
      const news = ctxParts.length
        ? [{ title: ctxParts.join(' '), url: '', snippet: '', source: 'TikTok Creative Center' }]
        : [];

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

  // 1) GUARD: cek kuota harian
  const guard = await fetchWithChallenge(`${base}/fetch-guard.php?action=check`, {
    headers: { 'X-Ingest-Secret': secret },
  });
  if (guard.status !== 200 || !guard.body?.ok) {
    return res.status(502).json({ error: 'Guard tidak bisa dihubungi', detail: guard.body });
  }
  if (!guard.body.allowed) {
    return res.status(200).json({
      ok: true, skipped: true,
      reason: 'Kuota fetch harian tercapai — melindungi kredit.',
      fetches_24h: guard.body.fetches_24h, max_per_day: guard.body.max_per_day,
    });
  }

  // 2) Tiga panggilan berbayar
  const diagnostics = {};
  let creditsUsed = 0;
  const industry = pickIndustry(new Date());

  const h1 = await scGet('/v1/tiktok/hashtags/popular?countryCode=ID');
  diagnostics.hashtag = { http: h1.http, success: h1.json?.success ?? null, snippet: h1.snippet };
  const hashtags = h1.json?.success ? parseHashtags(h1.json, 'hashtag') : [];
  if (h1.http === 200) creditsUsed++;

  const h2 = await scGet('/v1/tiktok/hashtags/popular?countryCode=ID&newOnBoard=true');
  diagnostics.hashtag_new = { http: h2.http, success: h2.json?.success ?? null, snippet: h2.snippet };
  const hashtagsNew = h2.json?.success ? parseHashtags(h2.json, 'hashtag_new') : [];
  if (h2.http === 200) creditsUsed++;

  const h3 = await scGet(
    `/v1/tiktok/hashtags/popular?countryCode=ID&industry=${encodeURIComponent(industry.slug)}`
  );
  diagnostics.industry = { slug: industry.slug, http: h3.http, success: h3.json?.success ?? null, snippet: h3.snippet };
  const hashtagsIndustry = h3.json?.success ? parseHashtags(h3.json, 'hashtag', industry.label) : [];
  if (h3.http === 200) creditsUsed++;

  const trends = [...hashtags, ...hashtagsNew, ...hashtagsIndustry];

  if (trends.length === 0) {
    if (creditsUsed > 0) {
      await fetchWithChallenge(`${base}/fetch-guard.php?action=record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': secret },
        body: JSON.stringify({ credits: creditsUsed, note: 'hasil kosong' }),
      });
    }
    return res.status(502).json({ error: 'ScrapeCreators tidak mengembalikan data', diagnostics });
  }

  const result = await postToIngest(
    process.env.INGEST_URL,
    { source: 'tiktok', captured_at: new Date().toISOString(), trends },
    secret
  );

  await fetchWithChallenge(`${base}/fetch-guard.php?action=record`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': secret },
    body: JSON.stringify({ credits: creditsUsed, note: `${trends.length} tren (industri: ${industry.label})` }),
  });

  return res.status(result.status === 200 ? 200 : 502).json({
    hashtags: hashtags.length,
    hashtags_new: hashtagsNew.length,
    hashtags_industry: hashtagsIndustry.length,
    industry_this_run: industry.label,
    credits_used: creditsUsed,
    fetches_24h: guard.body.fetches_24h + 1,
    ingest_status: result.status,
    ingest_response: result.body,
    diagnostics,
  });
}
