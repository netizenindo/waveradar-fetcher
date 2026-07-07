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

const BATCH_LIMIT = 8;

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

  // Mode kejar-ketertinggalan: ?rounds=N memproses beberapa batch dalam 1 panggilan
  // (untuk membersihkan tunggakan sekali waktu). Default 1 = perilaku cron normal.
  // Dibatasi 6 agar tetap dalam batas durasi function Vercel.
  const rounds = Math.max(1, Math.min(6, parseInt(req.query.rounds, 10) || 1));

  let totalAnalyzed = 0;
  let totalAiFailed = 0;
  let totalSaved = 0;
  let roundsRun = 0;
  let challengeSeen = false;

  for (let round = 0; round < rounds; round++) {
    // 1) Ambil tren yang belum dianalisis
    const pending = await fetchWithChallenge(
      `${base}/pending-analysis.php?limit=${BATCH_LIMIT}`,
      { headers: { 'X-Ingest-Secret': secret } }
    );
    if (pending.status !== 200 || !Array.isArray(pending.body?.trends)) {
      if (round === 0) {
        return res.status(502).json({ error: 'Gagal mengambil daftar pending', detail: pending.body });
      }
      break; // sudah ada progres di ronde sebelumnya
    }
    const trends = pending.body.trends;
    challengeSeen = challengeSeen || pending.challengeSolved;
    if (trends.length === 0) break; // tunggakan habis

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
    challengeSeen = challengeSeen || save.challengeSolved;

    totalAnalyzed += results.length;
    totalAiFailed += results.filter((r) => !r.ai_ok).length;
    totalSaved += Number(save.body?.saved || 0);
    roundsRun++;

    if (save.status !== 200) break;
  }

  return res.status(200).json({
    ok: true,
    analyzed: totalAnalyzed,
    ai_failed: totalAiFailed,
    saved: totalSaved,
    rounds_run: roundsRun,
    challenge_solved: challengeSeen,
    message: totalAnalyzed === 0 ? 'Tidak ada tren menunggu analisis' : undefined,
  });
}
