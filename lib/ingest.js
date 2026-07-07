/**
 * WaveRadar Fetcher — HTTP helper dengan penanganan bot-challenge InfinityFree
 * (v2 — Fase 3: fetchWithChallenge generik untuk GET & POST)
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

function isChallengePage(body) {
  return (
    typeof body === 'string' &&
    (body.includes('aes.js') || body.includes('slowAES') || body.includes('toNumbers'))
  );
}

/**
 * fetch() JSON dengan penanganan bot-challenge otomatis.
 * @returns {Promise<{status:number, body:any, challengeSolved:boolean}>}
 */
export async function fetchWithChallenge(url, options = {}) {
  const doFetch = (cookie) =>
    fetch(cookie ? url + (url.includes('?') ? '&' : '?') + 'i=1' : url, {
      ...options,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WaveRadarBot/1.0)',
        ...(options.headers || {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });

  let resp = await doFetch(null);
  let text = await resp.text();
  let challengeSolved = false;

  if (isChallengePage(text)) {
    const cookie = solveChallenge(text);
    if (!cookie) {
      return {
        status: 502,
        body: { error: 'Challenge terdeteksi tapi gagal dipecahkan' },
        challengeSolved,
      };
    }
    challengeSolved = true;
    resp = await doFetch(cookie);
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

/** POST JSON ke endpoint PHP WaveRadar (dipakai fetch-google-trends). */
export async function postToIngest(url, payload, secret) {
  return fetchWithChallenge(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ingest-Secret': secret,
    },
    body: JSON.stringify(payload),
  });
}
