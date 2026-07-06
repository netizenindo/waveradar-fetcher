/**
 * WaveRadar Fetcher — Health check (Fase 0)
 * Setelah deploy, buka: https://<project>.vercel.app/api/health
 * Harus mengembalikan status ok + konfirmasi env var terpasang.
 */
export default function handler(req, res) {
  res.status(200).json({
    app: 'waveradar-fetcher',
    status: 'ok',
    time: new Date().toISOString(),
    env: {
      INGEST_SECRET: process.env.INGEST_SECRET ? 'terpasang' : 'BELUM DIISI',
      INGEST_URL: process.env.INGEST_URL ? 'terpasang' : 'BELUM DIISI',
      GROQ_API_KEY: process.env.GROQ_API_KEY ? 'terpasang' : 'BELUM DIISI',
      FONNTE_TOKEN: process.env.FONNTE_TOKEN ? 'terpasang' : 'BELUM DIISI (opsional sampai Fase 4)',
    },
  });
}
