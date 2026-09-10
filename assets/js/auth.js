/* FinAudit Auth — shared by login.html & index.html
 * v2 (hardened):
 * - Multi-user: users disimpan sebagai dict {eh: {name, eh, ph, createdAt}} di FINAUDIT_USERS.
 *   Migrasi otomatis dari format lama FINAUDIT_USER (single object).
 * - Session anti-XSS: token disimpan di MEMORY + sessionStorage.
 *   localStorage HANYA dipakai bila user centang "remember me" (persistent, 30 hari).
 *   Tanpa remember-me: tutup tab = sesi hilang (bukan persistent di localStorage).
 * - Token = payload b64 + signature sha256(b64 + SALT), ada expiry + nonce.
 * - Anti brute-force: max 5x salah -> kunci 60 detik (per-email, bukan global saja).
 * - Tidak ada kredensial plaintext di frontend (hanya SHA-256 hash).
 */
(function (global) {
  'use strict';

  var AUTH_KEY = 'FINAUDIT_AUTH_SESSION';
  var USERS_KEY = 'FINAUDIT_USERS';       // v2: dict multi-user
  var LEGACY_USER_KEY = 'FINAUDIT_USER';  // v1: single object (dimigrasi)
  var ATTEMPT_KEY = 'FINAUDIT_LOGIN_ATTEMPTS';

  var SALT = 'FinAudit-v1::auth-salt-2026';
  var DEFAULT_EMAIL_HASH = 'ab227448f6abd39c8ca26fe067d1077b38e31ed09d49fff5137c8694fc060cb9';
  var DEFAULT_PASS_HASH = '224a1bb3e417e5c4b73b6d0c572bea1e92b4f86b1841588bdc497d1ea4bbea7f';

  var MAX_ATTEMPTS = 5;
  var LOCK_MS = 60 * 1000;
  var SESSION_MS = 12 * 60 * 60 * 1000;      // tanpa "remember me": 12 jam
  var REMEMBER_MS = 30 * 24 * 60 * 60 * 1000; // dengan "remember me": 30 hari

  // ─── In-memory session (hilang saat reload -> fallback sessionStorage) ───
  // Ini mitigasi XSS: token tidak selalu tersedia via localStorage yang bisa
  // dibaca script injeksi yang persisten. sessionStorage (per-tab) + memory
  // mempersempit jendela paparan dibanding localStorage permanen.
  var memToken = null;
  try {
    // Coba pulihkan sesi tab ini (bukan cross-tab persistent)
    memToken = (global.sessionStorage && global.sessionStorage.getItem(AUTH_KEY)) || null;
    if (memToken === 'true') { try { global.sessionStorage.removeItem(AUTH_KEY); } catch (e) {} memToken = null; }
  } catch (e) { memToken = null; }

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
    if (global.crypto && global.crypto.subtle) {
      return global.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
        .then(function (buf) {
          return Array.prototype.map.call(new Uint8Array(buf), function (b) {
            return ('0' + b.toString(16)).slice(-2);
          }).join('');
        });
    }
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

  /* ─── Attempts (per-email + global fallback) ─── */
  function readAttempts() {
    try {
      return JSON.parse(global.localStorage.getItem(ATTEMPT_KEY) || '{"count":0,"lockedUntil":0,"byEmail":{}}');
    } catch (e) { return { count: 0, lockedUntil: 0, byEmail: {} }; }
  }
  function writeAttempts(a) {
    try { global.localStorage.setItem(ATTEMPT_KEY, JSON.stringify(a)); } catch (e) {}
  }

  function isLocked(email) {
    var a = readAttempts();
    var now = Date.now();
    if (email) {
      var rec = a.byEmail && a.byEmail[String(email).toLowerCase()];
      if (rec && rec.lockedUntil && now < rec.lockedUntil) {
        return Math.ceil((rec.lockedUntil - now) / 1000);
      }
    }
    if (a.lockedUntil && now < a.lockedUntil) {
      return Math.ceil((a.lockedUntil - now) / 1000);
    }
    return 0;
  }

  function recordFailed(email) {
    var a = readAttempts();
    var key = String(email || '').toLowerCase() || '__global__';
    a.byEmail = a.byEmail || {};
    var rec = a.byEmail[key] || { count: 0, lockedUntil: 0 };
    rec.count = (rec.count || 0) + 1;
    if (rec.count >= MAX_ATTEMPTS) {
      rec.lockedUntil = Date.now() + LOCK_MS * Math.min(4, 1 + Math.floor((rec.strikes || 0) / 1));
      rec.count = 0;
      rec.strikes = (rec.strikes || 0) + 1;
      // Kunci global juga agar brute-force lintas email tetap dibatasi
      a.lockedUntil = rec.lockedUntil;
    }
    a.byEmail[key] = rec;
    writeAttempts(a);
  }

  function recordSuccess(email) {
    var a = readAttempts();
    if (a.byEmail && email) delete a.byEmail[String(email).toLowerCase()];
    a.count = 0; a.lockedUntil = 0;
    writeAttempts(a);
  }

  /* ─── Multi-user store ─── */
  function readUsers() {
    var users = {};
    try {
      users = JSON.parse(global.localStorage.getItem(USERS_KEY) || '{}') || {};
    } catch (e) { users = {}; }
    // Migrasi sekali dari format lama single-user
    try {
      var legacy = global.localStorage.getItem(LEGACY_USER_KEY);
      if (legacy) {
        var obj = JSON.parse(legacy);
        if (obj && obj.eh && obj.ph && !users[obj.eh]) {
          users[obj.eh] = obj;
          global.localStorage.setItem(USERS_KEY, JSON.stringify(users));
        }
        // Jangan hapus dulu agar downgrade tetap aman; tandai sudah migrasi
      }
    } catch (e) {}
    return users;
  }
  function writeUsers(users) {
    try { global.localStorage.setItem(USERS_KEY, JSON.stringify(users || {})); } catch (e) {}
  }
  function getRegisteredUser(email) {
    var users = readUsers();
    if (email) {
      var k = String(email).trim().toLowerCase();
      var found = null;
      Object.keys(users).forEach(function (eh) {
        if (users[eh] && users[eh].emailLower === k) found = users[eh];
      });
      return found;
    }
    // Kompat: tanpa argumen kembalikan user pertama (perilaku lama)
    var keys = Object.keys(users);
    return keys.length ? users[keys[0]] : null;
  }
  function listUsers() {
    var users = readUsers();
    return Object.keys(users).map(function (eh) {
      var u = users[eh] || {};
      return { name: u.name || '', email: u.email || u.emailLower || '', createdAt: u.createdAt || 0 };
    });
  }

  function signPayload(b64) {
    return sha256Hex(b64 + '.' + SALT);
  }

  function createSession(email, remember) {
    email = String(email || '').trim().toLowerCase();
    var payload = {
      email: email,
      exp: Date.now() + (remember ? REMEMBER_MS : SESSION_MS),
      nonce: Math.random().toString(36).slice(2) + Date.now().toString(36)
    };
    var b64 = b64urlEncode(JSON.stringify(payload));
    return signPayload(b64).then(function (sig) {
      var token = b64 + '.' + sig;
      memToken = token;
      try {
        // Selalu simpan di sessionStorage (per-tab, hilang saat tab ditutup)
        if (global.sessionStorage) global.sessionStorage.setItem(AUTH_KEY, token);
        if (remember) {
          global.localStorage.setItem(AUTH_KEY, token);
        } else {
          global.localStorage.removeItem(AUTH_KEY);
        }
      } catch (e) {}
      // Beri tahu store agar namespace per-user aktif
      try {
        if (global.FinAuditStore && global.FinAuditStore.setCurrentUser) {
          global.FinAuditStore.setCurrentUser(email);
        }
      } catch (e) {}
      return token;
    });
  }

  function parseToken(token) {
    if (!token || typeof token !== 'string') return null;
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
    // 1. memory, 2. sessionStorage, 3. localStorage (remember-me saja)
    if (memToken && parseToken(memToken)) return memToken;
    try {
      var s = (global.sessionStorage && global.sessionStorage.getItem(AUTH_KEY)) || null;
      if (s === 'true') { try { global.sessionStorage.removeItem(AUTH_KEY); } catch (e) {} s = null; }
      if (s && parseToken(s)) { memToken = s; return s; }
      var l = global.localStorage.getItem(AUTH_KEY) || null;
      if (l === 'true') { try { global.localStorage.removeItem(AUTH_KEY); } catch (e) {} l = null; }
      if (l && parseToken(l)) { memToken = l; return l; }
    } catch (e) {}
    return null;
  }

  function getCurrentEmail() {
    var t = getSessionToken();
    var p = parseToken(t);
    return p ? p.payload.email : null;
  }

  function clearSession() {
    memToken = null;
    try {
      if (global.sessionStorage) global.sessionStorage.removeItem(AUTH_KEY);
      global.localStorage.removeItem(AUTH_KEY);
    } catch (e) {}
    try {
      if (global.FinAuditStore && global.FinAuditStore.clearCurrentUser) {
        global.FinAuditStore.clearCurrentUser();
      }
    } catch (e) {}
  }

  function verifyCredentials(email, password) {
    email = String(email || '').trim().toLowerCase();
    password = String(password || '');
    return sha256Hex(email).then(function (eh) {
      return sha256Hex(password + SALT).then(function (ph) {
        if (eh === DEFAULT_EMAIL_HASH && ph === DEFAULT_PASS_HASH) return { email: email };
        var users = readUsers();
        var u = users[eh];
        if (u && u.ph === ph) return { email: email, name: u.name || '' };
        // Fallback: cocokkan via emailLower (tahan terhadap perubahan hash impl)
        var keys = Object.keys(users);
        for (var i = 0; i < keys.length; i++) {
          var cand = users[keys[i]];
          if (cand && (cand.emailLower === email || cand.email === email) && cand.ph === ph) {
            return { email: email, name: cand.name || '' };
          }
        }
        return null;
      });
    });
  }

  function registerUser(name, email, password) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return Promise.reject(new Error('Format email tidak valid.'));
    }
    if (!password || String(password).length < 6) {
      return Promise.reject(new Error('Password minimal 6 karakter.'));
    }
    return sha256Hex(email).then(function (eh) {
      return sha256Hex(String(password || '') + SALT).then(function (ph) {
        var users = readUsers();
        if (users[eh]) {
          return Promise.reject(new Error('Email sudah terdaftar. Silakan login.'));
        }
        users[eh] = {
          name: String(name || '').slice(0, 100),
          email: email,
          emailLower: email,
          eh: eh, ph: ph, createdAt: Date.now()
        };
        writeUsers(users);
        return { email: email };
      });
    });
  }

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
      } else {
        try {
          var p = parseToken(token);
          if (p && global.FinAuditStore && global.FinAuditStore.setCurrentUser) {
            global.FinAuditStore.setCurrentUser(p.payload.email);
          }
        } catch (e) {}
      }
    });
  }

  global.FinAuditAuth = {
    AUTH_KEY: AUTH_KEY,
    USERS_KEY: USERS_KEY,
    verifyCredentials: verifyCredentials,
    registerUser: registerUser,
    listUsers: listUsers,
    createSession: createSession,
    validateToken: validateToken,
    getSessionToken: getSessionToken,
    getCurrentEmail: getCurrentEmail,
    clearSession: clearSession,
    requireAuth: requireAuth,
    isLocked: isLocked,
    recordFailed: recordFailed,
    recordSuccess: recordSuccess,
    getRegisteredUser: getRegisteredUser
  };
})(window);
