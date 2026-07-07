/**
 * WaveRadar Fetcher — Siklus analisis AI (Fase 3)
 *
 * Dipanggil cron-job.org tiap 30 menit (offset ±10 menit setelah fetch):
 *   GET https://<project>.vercel.app/api/analyze-trends?key=<INGEST_SECRET>
 *
 * Arah aliran DIBALIK karena InfinityFree tidak bisa outbound HTTP:
 *   Vercel AMBIL tren pending dari PHP -> panggil Groq -> SETOR hasil ke PHP.
 */
import { fetchWithChallenge } from '../lib/ingest.js';
import { analyzeTrend } from '../lib/groq.js';

const BATCH_LIMIT = 5;

function phpApiBase() {
  if (process.env.PHP_API_BASE) return process.env.PHP_API_BASE.replace(/\/$/, '');
  // fallback: turunkan dari INGEST_URL (…/api/ingest.php -> …/api)
  if (process.env.INGEST_URL) return process.env.INGEST_URL.replace(/\/ingest\.php$/, '');
  return null;
}

export default async function handler(req, res) {
  const key = req.query.key || req.headers['x-cron-key'] || '';
  if (!process.env.INGEST_SECRET || key !== process.env.INGEST_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY belum diisi di env Vercel' });
  }
  const base = phpApiBase();
  if (!base) {
    return res.status(500).json({ error: 'PHP_API_BASE / INGEST_URL belum diisi di env Vercel' });
  }

  const secret = process.env.INGEST_SECRET;

  // 1) Ambil tren yang belum dianalisis
  const pending = await fetchWithChallenge(
    `${base}/pending-analysis.php?limit=${BATCH_LIMIT}`,
    { headers: { 'X-Ingest-Secret': secret } }
  );
  if (pending.status !== 200 || !Array.isArray(pending.body?.trends)) {
    return res.status(502).json({ error: 'Gagal mengambil daftar pending', detail: pending.body });
  }
  const trends = pending.body.trends;
  if (trends.length === 0) {
    return res.status(200).json({ ok: true, pending: 0, message: 'Tidak ada tren menunggu analisis' });
  }

  // 2) Analisis satu per satu via Groq
  const results = [];
  for (const t of trends) {
    const analysis = await analyzeTrend(t.keyword, t.context || '');
    results.push({
      id: t.id,
      summary: analysis.summary,
      safety: analysis.safety,
      safety_reason: analysis.safety_reason,
      relevance: analysis.relevance,
      ai_ok: analysis.ok,
    });
  }

  // 3) Setor hasil kembali ke PHP
  const save = await fetchWithChallenge(`${base}/save-analysis.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': secret },
    body: JSON.stringify({ results }),
  });

  return res.status(save.status === 200 ? 200 : 502).json({
    ok: save.status === 200,
    analyzed: results.length,
    ai_failed: results.filter((r) => !r.ai_ok).length,
    save_response: save.body,
    challenge_solved: pending.challengeSolved || save.challengeSolved,
  });
}
