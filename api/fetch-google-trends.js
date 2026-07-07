/**
 * WaveRadar Fetcher — Google Trends RSS (geo=ID)
 *
 * Dipanggil cron-job.org tiap 30 menit:
 *   GET https://<project>.vercel.app/api/fetch-google-trends?key=<INGEST_SECRET>
 *
 * Alur: fetch RSS -> parse XML -> normalisasi -> POST ke ingest.php
 */
import { postToIngest } from '../lib/ingest.js';

const RSS_URLS = [
  'https://trends.google.com/trending/rss?geo=ID',
  'https://trends.google.com/trends/trendingsearches/daily/rss?geo=ID',
];

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

function decode(str) {
  if (!str) return '';
  let s = str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  s = s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => XML_ENTITIES[m] || m);
  return s.trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
}

function parseRss(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return items.map((m, i) => {
    const block = m[1];
    const newsBlocks = [...block.matchAll(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/g)];
    const news = newsBlocks.slice(0, 3).map((n) => ({
      title: tag(n[1], 'ht:news_item_title'),
      url: tag(n[1], 'ht:news_item_url'),
      snippet: tag(n[1], 'ht:news_item_snippet'),
      source: tag(n[1], 'ht:news_item_source'),
    }));
    return {
      keyword: tag(block, 'title'),
      rank: i + 1,
      volume: tag(block, 'ht:approx_traffic') || null,
      news,
    };
  }).filter((t) => t.keyword);
}

export default async function handler(req, res) {
  const key = req.query.key || req.headers['x-cron-key'] || '';
  if (!process.env.INGEST_SECRET || key !== process.env.INGEST_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.INGEST_URL) {
    return res.status(500).json({ error: 'INGEST_URL belum diisi di env Vercel' });
  }

  let xml = null;
  let usedUrl = null;
  const fetchErrors = [];
  for (const url of RSS_URLS) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      if (r.ok) {
        const text = await r.text();
        if (text.includes('<item>')) { xml = text; usedUrl = url; break; }
        fetchErrors.push({ url, error: 'RSS kosong / tanpa item' });
      } else {
        fetchErrors.push({ url, error: `HTTP ${r.status}` });
      }
    } catch (e) {
      fetchErrors.push({ url, error: e.message });
    }
  }

  if (!xml) {
    return res.status(502).json({ error: 'Semua endpoint RSS gagal', details: fetchErrors });
  }

  const trends = parseRss(xml);
  if (trends.length === 0) {
    return res.status(502).json({ error: 'RSS berhasil di-fetch tapi 0 tren ter-parse', url: usedUrl });
  }

  const payload = {
    source: 'google',
    captured_at: new Date().toISOString(),
    trends,
  };

  const result = await postToIngest(process.env.INGEST_URL, payload, process.env.INGEST_SECRET);

  return res.status(result.status === 200 ? 200 : 502).json({
    fetched_from: usedUrl,
    trends_parsed: trends.length,
    challenge_solved: result.challengeSolved,
    ingest_status: result.status,
    ingest_response: result.body,
  });
}
