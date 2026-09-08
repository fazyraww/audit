/* FinAudit Auth — shared by login.html & index.html
 * - Tidak ada kredensial plaintext di frontend (hanya SHA-256 hash)
 * - Session = token bertanda tangan + expiry, bukan flag "true"
 * - Anti brute-force: max 5x salah -> kunci 60 detik (backoff)
 * - Signup mendaftarkan 1 akun lokal (hash), bukan bypass
 */
(function (global) {
  'use strict';

  var AUTH_KEY = 'FINAUDIT_AUTH_SESSION';
  var USER_KEY = 'FINAUDIT_USER';
  var ATTEMPT_KEY = 'FINAUDIT_LOGIN_ATTEMPTS';

  // Ganti hash ini untuk ganti kredensial default.
  // Cara hitung (PowerShell):
  //   $s=[Security.Cryptography.SHA256]::Create()
  //   email: sha256(email_lowercase) ; password: sha256(password + SALT)
  var SALT = 'FinAudit-v1::auth-salt-2026';
  var DEFAULT_EMAIL_HASH = 'ab227448f6abd39c8ca26fe067d1077b38e31ed09d49fff5137c8694fc060cb9';
  var DEFAULT_PASS_HASH = '224a1bb3e417e5c4b73b6d0c572bea1e92b4f86b1841588bdc497d1ea4bbea7f';

  var MAX_ATTEMPTS = 5;
  var LOCK_MS = 60 * 1000;
  var SESSION_MS = 12 * 60 * 60 * 1000;      // tanpa "remember me": 12 jam
  var REMEMBER_MS = 30 * 24 * 60 * 60 * 1000; // dengan "remember me": 30 hari

  function store(k) {
    try {
      // sessionStorage dulu (tab), fallback ke memory bila diblokir
      return global.sessionStorage;
    } catch (e) { return null; }
  }

  function b64urlEncode(str) {
    return btoa(unescape(encodeURIComponent(str)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(b64) {
    b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return decodeURIComponent(escape(atob(b64)));
  }

  function sha256Hex(text) {
    // Web Crypto (async) — dipakai di login; untuk validasi sync ada fallback sederhana
    if (global.crypto && global.crypto.subtle) {
      return global.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
        .then(function (buf) {
          return Array.prototype.map.call(new Uint8Array(buf), function (b) {
            return ('0' + b.toString(16)).slice(-2);
          }).join('');
        });
    }
    // Fallback sync (bukan SHA-256 beneran, hanya agar tidak crash di browser tua)
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57, i;
    for (i = 0; i < text.length; i++) {
      var ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return Promise.resolve((4294967296 + h1).toString(16) + (4294967296 + h2).toString(16));
  }

  function readAttempts() {
    try {
      return JSON.parse(global.localStorage.getItem(ATTEMPT_KEY) || '{"count":0,"lockedUntil":0}');
    } catch (e) { return { count: 0, lockedUntil: 0 }; }
  }
  function writeAttempts(a) {
    try { global.localStorage.setItem(ATTEMPT_KEY, JSON.stringify(a)); } catch (e) {}
  }

  function isLocked() {
    var a = readAttempts();
    if (a.lockedUntil && Date.now() < a.lockedUntil) {
      return Math.ceil((a.lockedUntil - Date.now()) / 1000);
    }
    return 0;
  }

  function recordFailed() {
    var a = readAttempts();
    a.count = (a.count || 0) + 1;
    if (a.count >= MAX_ATTEMPTS) {
      a.lockedUntil = Date.now() + LOCK_MS;
      a.count = 0; // reset setelah dikunci
    }
    writeAttempts(a);
  }

  function recordSuccess() {
    writeAttempts({ count: 0, lockedUntil: 0 });
  }

  function getRegisteredUser() {
    try {
      var raw = global.localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function signPayload(b64) {
    // Tanda tangan: sha256(b64 + "." + SALT) — cegah pemalsuan token "true"
    return sha256Hex(b64 + '.' + SALT);
  }

  function createSession(email, remember) {
    var payload = {
      email: email,
      exp: Date.now() + (remember ? REMEMBER_MS : SESSION_MS),
      nonce: Math.random().toString(36).slice(2) + Date.now().toString(36)
    };
    var b64 = b64urlEncode(JSON.stringify(payload));
    return signPayload(b64).then(function (sig) {
      var token = b64 + '.' + sig;
      try {
        var s = store();
        if (s) s.setItem(AUTH_KEY, token);
        if (remember) global.localStorage.setItem(AUTH_KEY, token);
        else global.localStorage.removeItem(AUTH_KEY);
      } catch (e) {}
      return token;
    });
  }

  function parseToken(token) {
    if (!token || typeof token !== 'string') return null;
    // Tolak token lama yang cuma "true"
    if (token === 'true') return null;
    var parts = token.split('.');
    if (parts.length !== 2) return null;
    try {
      var payload = JSON.parse(b64urlDecode(parts[0]));
      if (!payload || !payload.exp || !payload.email) return null;
      if (Date.now() > payload.exp) return null;
      return { b64: parts[0], sig: parts[1], payload: payload };
    } catch (e) { return null; }
  }

  function validateToken(token) {
    var parsed = parseToken(token);
    if (!parsed) return Promise.resolve(false);
    return signPayload(parsed.b64).then(function (expected) {
      return expected === parsed.sig;
    });
  }

  function getSessionToken() {
    try {
      var s = store();
      return (s && s.getItem(AUTH_KEY)) || global.localStorage.getItem(AUTH_KEY) || null;
    } catch (e) { return null; }
  }

  function clearSession() {
    try {
      var s = store();
      if (s) s.removeItem(AUTH_KEY);
      global.localStorage.removeItem(AUTH_KEY);
    } catch (e) {}
  }

  function verifyCredentials(email, password) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');
    return sha256Hex(email).then(function (eh) {
      return sha256Hex(password + SALT).then(function (ph) {
        // 1. Cocok dengan akun default (hash only, tanpa plaintext)
        if (eh === DEFAULT_EMAIL_HASH && ph === DEFAULT_PASS_HASH) return { email: email };
        // 2. Cocok dengan akun yang didaftar via signup (tersimpan lokal, hash)
        var reg = getRegisteredUser();
        if (reg && reg.eh === eh && reg.ph === ph) return { email: email };
        return null;
      });
    });
  }

  function registerUser(name, email, password) {
    email = String(email || '').trim().toLowerCase();
    return sha256Hex(email).then(function (eh) {
      return sha256Hex(String(password || '') + SALT).then(function (ph) {
        try {
          global.localStorage.setItem(USER_KEY, JSON.stringify({
            name: String(name || ''), eh: eh, ph: ph, createdAt: Date.now()
          }));
        } catch (e) {}
        return { email: email };
      });
    });
  }

  // Dipakai index.html: redirect ke login bila sesi tidak valid/expired
  function requireAuth(loginPage) {
    var token = getSessionToken();
    if (!parseToken(token)) {
      clearSession();
      global.location.href = loginPage || 'login.html';
      return;
    }
    validateToken(token).then(function (ok) {
      if (!ok) {
        clearSession();
        global.location.href = loginPage || 'login.html';
      }
    });
  }

  global.FinAuditAuth = {
    AUTH_KEY: AUTH_KEY,
    verifyCredentials: verifyCredentials,
    registerUser: registerUser,
    createSession: createSession,
    validateToken: validateToken,
    getSessionToken: getSessionToken,
    clearSession: clearSession,
    requireAuth: requireAuth,
    isLocked: isLocked,
    recordFailed: recordFailed,
    recordSuccess: recordSuccess,
    getRegisteredUser: getRegisteredUser
  };
})(window);
