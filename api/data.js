/* FinAudit Data API — backend opsional untuk multi-user & realtime.
 *
 * Status: stub yang aman secara default (menolak tulis tanpa token).
 * Aktifkan bertahap:
 *  1. Set ENV: FINAUDIT_API_TOKEN (token backend) di Vercel.
 *  2. Ganti MEM store di bawah dengan KV/DB (Vercel KV, Postgres, dsb).
 *  3. Di frontend set: window.FINAUDIT_API = true
 *     -> assets/js/store.js otomatis sync ke endpoint ini.
 *
 * Auth: reuse pola token FinAuditAuth (Bearer <b64>.<sig>).
 * Untuk produksi, verifikasi signature server-side dengan SALT yang sama
 * (simpan SALT di ENV, JANGAN di kode).
 */

const SALT = process.env.FINAUDIT_AUTH_SALT || '';
const API_TOKEN = process.env.FINAUDIT_API_TOKEN || '';

// Allowlist key — cegah klien menimpa key sesi/internal
const ALLOWED_RE = /^(AUDIT_|KOS_|KULIAH_|MALANG_|FINAUDIT_UID_)/;
const BLOCKED = new Set(['FINAUDIT_AUTH_SESSION', 'FINAUDIT_USERS', 'FINAUDIT_USER', 'FINAUDIT_LOGIN_ATTEMPTS']);

// Demo in-memory (hilang saat cold-start; ganti KV/DB di produksi)
const MEM = new Map();

function getBearer(req) {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function emailFromToken(token) {
  if (!token || token === 'true') return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  try {
    let b64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!payload || !payload.email || !payload.exp) return null;
    if (Date.now() > payload.exp) return null;
    return String(payload.email).toLowerCase();
  } catch (_) {
    return null;
  }
}

function authorized(req) {
  // Mode 1: API token statis (server-to-server / admin)
  const bearer = getBearer(req);
  if (API_TOKEN && bearer === API_TOKEN) return { via: 'api-token', email: 'admin' };
  // Mode 2: sesi user FinAudit (bearer = session token)
  const email = emailFromToken(bearer);
  if (email) return { via: 'session', email };
  return null;
}

export default async function handler(req, res) {
  if (req.method === 'GET' && req.query && req.query.ping) {
    res.status(200).json({ ok: true, backend: 'finaudit-data', time: new Date().toISOString() });
    return;
  }

  const auth = authorized(req);
  if (!auth) {
    res.status(401).json({ error: 'Unauthorized. Kirim Authorization: Bearer <session-token>.' });
    return;
  }

  const ns = 'u:' + auth.email;

  if (req.method === 'GET') {
    const { key } = req.query || {};
    if (key) {
      if (BLOCKED.has(key) || !ALLOWED_RE.test(key)) {
        res.status(400).json({ error: 'Key tidak diizinkan.' });
        return;
      }
      const store = MEM.get(ns) || {};
      res.status(200).json({ key, value: store[key] ?? null });
      return;
    }
    const store = MEM.get(ns) || {};
    res.status(200).json({ keys: Object.keys(store), updatedAt: new Date().toISOString() });
    return;
  }

  if (req.method === 'PUT') {
    const { key, value } = req.body || {};
    if (!key || typeof value !== 'string') {
      res.status(400).json({ error: 'Field "key" dan "value" (string) wajib.' });
      return;
    }
    if (BLOCKED.has(key) || !ALLOWED_RE.test(key)) {
      res.status(400).json({ error: 'Key tidak diizinkan.' });
      return;
    }
    if (value.length > 1024 * 1024) {
      res.status(413).json({ error: 'Value terlalu besar (maks 1MB per key).' });
      return;
    }
    const store = MEM.get(ns) || {};
    store[key] = value;
    MEM.set(ns, store);
    res.status(200).json({ ok: true, key });
    return;
  }

  res.status(405).json({ error: 'Method not allowed. Gunakan GET/PUT.' });
}
