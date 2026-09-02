const GEMINI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash-latest', 'gemini-flash-latest'];

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

  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    try {
      const parts = image
        ? [{ text: prompt }, { inlineData: { mimeType: mime || 'image/jpeg', data: image } }]
        : [{ text: prompt }];

      const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json'
        }
      };

      const resp = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(apiKey),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      );

      if (!resp.ok) {
        let msg = 'HTTP ' + resp.status;
        try { const e = await resp.json(); msg = (e.error && e.error.message) || msg; } catch (_) { }
        lastErr = new Error(msg);
        if (/not found|model/i.test(msg) && model !== GEMINI_MODELS[GEMINI_MODELS.length - 1]) continue;
        throw lastErr;
      }

      const data = await resp.json();
      const text = (data && data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts.map(p => p.text || '').join('')) || '';

      if (!text) {
        lastErr = new Error('AI tidak mengembalikan hasil.');
        continue;
      }

      res.status(200).json({ text });
      return;
    } catch (err) {
      lastErr = err;
      if (model !== GEMINI_MODELS[GEMINI_MODELS.length - 1]) continue;
    }
  }

  res.status(500).json({ error: (lastErr && lastErr.message) || 'Gagal memanggil Gemini.' });
}
