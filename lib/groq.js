/**
 * WaveRadar Fetcher — Analis tren via Groq (Fase 3)
 *
 * Satu panggilan per tren, hasilnya di-cache di DB oleh PHP —
 * tidak pernah dianalisis dua kali. Output JSON ketat + validasi + retry 1x.
 * GROQ_BASE_URL bisa di-override (dipakai untuk testing dengan mock server).
 */

export const INDUSTRIES = {
  1: 'F&B — Makanan & Minuman',
  2: 'Fashion & Apparel',
  3: 'Beauty & Skincare',
  4: 'Tech & Gadget',
  5: 'Jasa & Layanan Lokal (laundry, cleaning, servis)',
  6: 'Kesehatan & Fitness',
  7: 'Edukasi & Kursus',
  8: 'Travel & Hospitality',
  9: 'Otomotif',
  10: 'Keuangan & Fintech',
  11: 'Properti',
  12: 'Hiburan & Kreator',
};

const MODEL = 'llama-3.3-70b-versatile';

function groqUrl() {
  return (process.env.GROQ_BASE_URL || 'https://api.groq.com') + '/openai/v1/chat/completions';
}

const SYSTEM_PROMPT = `Kamu adalah analis tren untuk tim media sosial brand di Indonesia.
Tugasmu menilai sebuah topik yang sedang trending dari tiga sisi:
1. RINGKASAN: jelaskan singkat (1-2 kalimat, bahasa Indonesia santai-profesional) kenapa topik ini trending, berdasarkan konteks berita yang diberikan.
2. BRAND SAFETY: amankah brand ikut menunggangi tren ini?
   - "safe": netral/positif, bebas kontroversi (hiburan ringan, olahraga, kuliner, meme lucu)
   - "caution": ada sisi sensitif, brand tertentu sebaiknya hati-hati (politik ringan, rumor, persaingan fanbase, isu ekonomi)
   - "danger": jangan disentuh brand (kematian, bencana, kriminal, SARA, politik panas, aib seseorang)
3. RELEVANSI: skor 0-100 untuk tiap kategori industri — seberapa natural brand di kategori itu bisa membuat konten menunggangi tren ini. 0 = tidak nyambung sama sekali, 100 = sangat nyambung.

Balas HANYA dengan JSON valid tanpa markdown, tanpa teks lain, dengan struktur persis:
{"summary": "...", "safety": "safe|caution|danger", "safety_reason": "...", "relevance": {"1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0, "7": 0, "8": 0, "9": 0, "10": 0, "11": 0, "12": 0}}`;

function buildUserPrompt(keyword, context) {
  const industriList = Object.entries(INDUSTRIES)
    .map(([id, name]) => `${id}. ${name}`)
    .join('\n');
  return `TOPIK TRENDING: "${keyword}"

KONTEKS BERITA:
${context && context.trim() !== '' ? context : '(tidak ada konteks berita — nilai dari pengetahuan umummu, dan jika ragu soal safety pilih "caution")'}

KATEGORI INDUSTRI:
${industriList}

Analisis topik ini sekarang. Balas hanya JSON.`;
}

/** Validasi + normalisasi output model. Return null jika tidak valid. */
export function validateAnalysis(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (!['safe', 'caution', 'danger'].includes(obj.safety)) return null;
  const relevance = {};
  for (let i = 1; i <= 12; i++) {
    let v = Number(obj.relevance?.[String(i)] ?? obj.relevance?.[i]);
    if (!Number.isFinite(v)) v = 0;
    relevance[i] = Math.max(0, Math.min(100, Math.round(v)));
  }
  return {
    summary: String(obj.summary || '').slice(0, 600),
    safety: obj.safety,
    safety_reason: String(obj.safety_reason || '').slice(0, 600),
    relevance,
  };
}

/** Hasil default saat analisis gagal total — caution + relevansi netral 50. */
export function fallbackAnalysis(errMsg) {
  return {
    ok: false,
    error: errMsg || 'unknown',
    summary: '',
    safety: 'caution',
    safety_reason: 'Analisis otomatis gagal — ditandai caution untuk kehati-hatian.',
    relevance: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, 50])),
  };
}

/**
 * Analisis satu tren. Retry 1x jika gagal, lalu fallback.
 * @returns {Promise<{ok:boolean, summary, safety, safety_reason, relevance, error?}>}
 */
export async function analyzeTrend(keyword, context) {
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(groqUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.3,
          max_tokens: 1024,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt(keyword, context) },
          ],
        }),
      });
      if (!r.ok) throw new Error(`Groq HTTP ${r.status}`);
      const data = await r.json();
      const text = data.choices?.[0]?.message?.content || '';
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      const valid = validateAnalysis(parsed);
      if (valid) return { ok: true, ...valid };
      throw new Error('Output model tidak lolos validasi');
    } catch (e) {
      lastErr = e.message;
    }
  }
  return fallbackAnalysis(lastErr);
}
