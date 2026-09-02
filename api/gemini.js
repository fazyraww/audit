const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash-latest', 'gemini-flash-latest'];

export const config = {
  maxDuration: 60
};

// Skema JSON: AI dipaksa mengembalikan array valid persis bentuk ini (lebih cepat & pasti tidak error parse)
const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      tanggal: { type: 'STRING' },
      jenis: { type: 'STRING', enum: ['pemasukan', 'pengeluaran'] },
      nominal: { type: 'NUMBER' },
      keterangan: { type: 'STRING' },
      kategori: { type: 'STRING' }
    },
    required: ['tanggal', 'jenis', 'nominal', 'keterangan', 'kategori']
  }
};

const QUOTA_RE = /quota|rate.?limit|429/i;

async function readResp(resp) {
  let msg = 'HTTP ' + resp.status;
  let retrySec = 0;
  try {
    const e = await resp.json();
    if (e && e.error && e.error.message) msg = e.error.message;
    const details = (e && e.error && e.error.details) || [];
    for (const d of details) {
      const raw = (d && d.retryDelay) || (d && d.metadata && d.metadata.retryDelay) || '';
      const m = String(raw).match(/(\d+(?:\.\d+)?)/);
      if (m) retrySec = Math.max(retrySec, parseFloat(m[1]));
    }
  } catch (_) { /* ignore */ }
  return { msg, retrySec };
}

function makeBody(prompt, image, mime, withSchema) {
  const parts = image
    ? [{ text: prompt }, { inlineData: { mimeType: mime || 'image/jpeg', data: image } }]
    : [{ text: prompt }];
  const generationConfig = {
    temperature: 0.1,
    maxOutputTokens: 2048,
    responseMimeType: 'application/json'
  };
  if (withSchema) generationConfig.responseSchema = SCHEMA;
  return { contents: [{ role: 'user', parts }], generationConfig };
}

async function callModel(model, body, apiKey) {
  const resp = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );

  if (!resp.ok) {
    const { msg, retrySec } = await readResp(resp);
    const err = new Error(msg);
    err.retrySec = retrySec;
    err.status = resp.status;
    err.isQuota = QUOTA_RE.test(msg) || resp.status === 429;
    err.isSchemaError = /schema|responseMimeType/i.test(msg) && resp.status < 500;
    throw err;
  }

  const data = await resp.json();
  return (data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts.map(p => p.text || '').join('')) || '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Gunakan POST.' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'GEMINI_API_KEY belum diatur. Set Environment Variable di dashboard Vercel.' });
    return;
  }

  const { prompt, image, mime } = req.body || {};
  if (!prompt || !String(prompt).trim()) {
    res.status(400).json({ error: 'Field "prompt" wajib diisi.' });
    return;
  }

  const started = Date.now();
  let lastErr = null;
  let maxRetry = 0;

  for (let pass = 0; pass < 2; pass++) {
    for (const model of GEMINI_MODELS) {
      // Untuk tiap model coba mode schema dulu; kalau ditolak model, otomatis coba tanpa schema
      for (const withSchema of [true, false]) {
        try {
          const text = await callModel(model, makeBody(prompt, image, mime, withSchema), apiKey);
          if (!text) {
            lastErr = new Error('AI tidak mengembalikan hasil.');
            continue;
          }
          res.status(200).json({ text });
          return;
        } catch (err) {
          lastErr = err;
          if (err.retrySec > 0) maxRetry = Math.max(maxRetry, err.retrySec);
          if (err.isSchemaError && withSchema) continue; // coba model yang sama tanpa schema
          if (err.isQuota || /not found|model/i.test(err.message)) break; // ganti model berikutnya
          continue; // error transien -> coba mode lain / model lain
        }
      }
    }

    // Semua model kena kuota -> tunggu sesuai saran Google lalu ulangi sekali
    if (pass === 0 && lastErr && (lastErr.isQuota || QUOTA_RE.test(lastErr.message))) {
      const elapsed = Date.now() - started;
      const waitMs = Math.min(Math.max((maxRetry || 10) * 1000, 8000), 60000 - elapsed - 3000);
      if (waitMs > 1500) {
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
    }
    break;
  }

  const msg = (lastErr && lastErr.message) || 'Gagal memanggil Gemini.';
  const status = (lastErr && lastErr.status) || 500;
  res.status(status).json({
    error: msg,
    hint: 'Kuota gratis Google AI Studio = 20 request/menit. Tunggu ~30 detik lalu coba lagi. Untuk pemakaian rutin gunakan key berbayar di Environment Variable GEMINI_API_KEY.'
  });
}
