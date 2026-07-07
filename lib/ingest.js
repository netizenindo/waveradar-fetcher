/**
 * WaveRadar Fetcher — Helper kirim data ke ingest.php (InfinityFree)
 *
 * InfinityFree memasang bot-challenge JavaScript (cookie __test, AES-128-CBC)
 * di semua request. Browser lolos otomatis; request server-ke-server tidak.
 * Helper ini mendeteksi halaman challenge, memecahkan cookie-nya dengan
 * Node crypto, lalu mengulang request dengan cookie tersebut.
 * Jika hosting tidak memakai challenge, request pertama langsung berhasil.
 */
import crypto from 'crypto';

function solveChallenge(html) {
  const m = html.match(
    /toNumbers\("([0-9a-f]+)"\)[\s\S]*?toNumbers\("([0-9a-f]+)"\)[\s\S]*?toNumbers\("([0-9a-f]+)"\)/
  );
  if (!m) return null;
  const key = Buffer.from(m[1], 'hex');
  const iv = Buffer.from(m[2], 'hex');
  const data = Buffer.from(m[3], 'hex');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const out = Buffer.concat([decipher.update(data), decipher.final()]);
  return '__test=' + out.toString('hex');
}

function isChallengePage(status, body) {
  return (
    typeof body === 'string' &&
    (body.includes('aes.js') || body.includes('slowAES') || body.includes('toNumbers'))
  );
}

/**
 * POST JSON ke endpoint PHP, otomatis menangani bot-challenge.
 * @returns {Promise<{status:number, body:any, challengeSolved:boolean}>}
 */
export async function postToIngest(url, payload, secret) {
  const doPost = (cookie) =>
    fetch(cookie ? url + (url.includes('?') ? '&' : '?') + 'i=1' : url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ingest-Secret': secret,
        'User-Agent': 'Mozilla/5.0 (compatible; WaveRadarBot/1.0)',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(payload),
    });

  let resp = await doPost(null);
  let text = await resp.text();
  let challengeSolved = false;

  if (isChallengePage(resp.status, text)) {
    const cookie = solveChallenge(text);
    if (!cookie) {
      return { status: 502, body: { error: 'Challenge terdeteksi tapi gagal dipecahkan' }, challengeSolved };
    }
    challengeSolved = true;
    resp = await doPost(cookie);
    text = await resp.text();
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: 'Respons bukan JSON', raw: text.slice(0, 300) };
  }
  return { status: resp.status, body, challengeSolved };
}
