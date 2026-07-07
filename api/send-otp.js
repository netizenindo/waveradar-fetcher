/**
 * WaveRadar Fetcher — Kirim OTP WhatsApp (Fase 4)
 *
 * Dipanggil LANGSUNG dari browser user (register/reset password):
 *   POST https://<project>.vercel.app/api/send-otp   body: {phone, purpose}
 *
 * Alur: generate kode 6 digit di sini (tidak pernah dikirim balik ke browser)
 *   -> setor hash ke PHP otp-store.php (yang menegakkan cooldown & limit harian)
 *   -> kirim WA via Fonnte.
 *
 * Env yang dibutuhkan: INGEST_SECRET, PHP_API_BASE / INGEST_URL, FONNTE_TOKEN,
 * ALLOWED_ORIGIN (mis. https://waveradar.freedev.app), FONNTE_BASE_URL (opsional, testing).
 */
import crypto from 'crypto';
import { fetchWithChallenge } from '../lib/ingest.js';

function phpApiBase() {
  if (process.env.PHP_API_BASE) return process.env.PHP_API_BASE.replace(/\/$/, '');
  if (process.env.INGEST_URL) return process.env.INGEST_URL.replace(/\/ingest\.php$/, '');
  return null;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function sendFonnte(phone, message) {
  const base = process.env.FONNTE_BASE_URL || 'https://api.fonnte.com';
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: {
      Authorization: process.env.FONNTE_TOKEN,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ target: phone, message }).toString(),
  });
  let body;
  try { body = await r.json(); } catch { body = { status: false, reason: 'respons Fonnte bukan JSON' }; }
  return { httpOk: r.ok, body };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'gunakan POST' });

  if (!process.env.FONNTE_TOKEN) {
    return res.status(500).json({ error: 'FONNTE_TOKEN belum diisi di env Vercel' });
  }
  const base = phpApiBase();
  if (!base || !process.env.INGEST_SECRET) {
    return res.status(500).json({ error: 'PHP_API_BASE / INGEST_SECRET belum diisi di env Vercel' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const phone = String(body?.phone || '').trim();
  const purpose = String(body?.purpose || '').trim();
  if (!phone || !['register', 'reset'].includes(purpose)) {
    return res.status(400).json({ error: 'invalid_request', message: 'phone dan purpose (register/reset) wajib diisi' });
  }

  // Kode dibuat DI SINI — tidak pernah menyentuh browser
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');

  // 1) Setor ke PHP — PHP yang memvalidasi nomor, cooldown, limit harian
  const store = await fetchWithChallenge(`${base}/otp-store.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ingest-Secret': process.env.INGEST_SECRET },
    body: JSON.stringify({ phone, purpose, code }),
  });

  if (store.status !== 200 || !store.body?.ok) {
    // Teruskan pesan error PHP (cooldown, sudah terdaftar, dll) ke browser
    return res.status(store.status >= 400 && store.status < 500 ? store.status : 502).json({
      error: store.body?.error || 'store_failed',
      message: store.body?.message || 'Gagal menyiapkan kode. Coba lagi.',
    });
  }

  const normalizedPhone = store.body.phone; // sudah dinormalisasi PHP (628…)

  // 2) Kirim via Fonnte
  const message =
    `WaveRadar: kode verifikasi kamu ${code}\n` +
    `Berlaku ${5} menit. Jangan bagikan kode ini ke siapa pun.`;
  const wa = await sendFonnte(normalizedPhone, message);

  if (!wa.httpOk || wa.body?.status === false) {
    return res.status(502).json({
      error: 'wa_send_failed',
      message: 'Gagal mengirim WhatsApp. Tunggu 60 detik lalu coba lagi.',
      detail: wa.body?.reason || null,
    });
  }

  return res.status(200).json({ ok: true, message: 'Kode terkirim via WhatsApp' });
}
