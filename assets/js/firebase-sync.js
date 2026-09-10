/* ============================================================
   FinAudit Firebase Sync — sinkronisasi antar perangkat (HP ↔ laptop)
   TANPA MENGHILANGKAN DATA:
   - Sync TIDAK PERNAH menghapus key localStorage. Hanya menambah /
     menimpa dengan versi yang lebih baru (berdasarkan updatedAt).
   - Rekonsiliasi pertama: kalau cloud masih kosong → data lokal
     DIUNGGAH (bukan ditimpa). Kalau keduanya berisi dan berbeda →
     muncul KONFIRMASI ke user, tidak ada overwrite diam-diam.
   - FINAUDIT_AUTOBACKUP_* tidak ikut disync (hemat kuota, cegah
     dokumen > 1MB). Key sesi & registry akun lokal juga dikecualikan.
   - Tanpa config (FINAUDIT_FIREBASE_CONFIG = null): semua no-op,
     aplikasi jalan 100% lokal seperti sebelumnya.
   ============================================================ */
(function (global) {
  'use strict';

  var COLLECTION = 'users';
  var META_KEY = 'FINAUDIT_CLOUD_META';
  var PUSH_DEBOUNCE_MS = 5000;
  var MAX_DOC_CHARS = 950000; // di bawah batas 1MB/dokumen Firestore

  // Key yang TIDAK BOLEH keluar/masuk cloud (sesi, registry lokal, auto-backup)
  var SYNC_BLOCK_RE = /^(FINAUDIT_AUTH_SESSION|FINAUDIT_USERS|FINAUDIT_USER|FINAUDIT_LOGIN_ATTEMPTS|FINAUDIT_AUTOBACKUP_)/;
  var SYNC_ALLOW_RE = /^(FINAUDIT_|AUDIT_|KOS_|KULIAH_|MALANG_)/;

  var clientId = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  var db = null, auth = null, fUser = null, unsub = null;
  var pushTimer = null, applyingRemote = false, skipFirstSnap = true;
  var authListeners = [];
  var storeHooked = false;

  /* ─── Helpers ─── */
  function toast(msg, type) {
    try {
      if (global.showToast) { global.showToast(msg, type === 'error' ? 'error' : 'success'); return; }
    } catch (e) {}
    try { console.log('[FinAudit cloud]', msg); } catch (e) {}
  }
  function config() { return global.FINAUDIT_FIREBASE_CONFIG || null; }
  function sdkLoaded() { return !!(global.firebase && global.firebase.firestore && global.firebase.auth); }
  function isConfigured() {
    var c = config();
    return !!(c && c.apiKey && c.projectId && sdkLoaded());
  }
  function ensureInit() {
    if (db && auth) return true;
    if (!isConfigured()) return false;
    try {
      if (!global.firebase.apps.length) global.firebase.initializeApp(config());
      auth = global.firebase.auth();
      db = global.firebase.firestore();
      return true;
    } catch (e) { try { console.warn('[FinAudit cloud] init gagal:', e); } catch (_) {} return false; }
  }
  function docRef() {
    if (!db || !fUser) return null;
    return db.collection(COLLECTION).doc(fUser.uid);
  }
  function readMeta() {
    try {
      var raw = global.localStorage.getItem(META_KEY);
      var m = raw ? JSON.parse(raw) : null;
      if (m && typeof m.updatedAt === 'number') return m;
    } catch (e) {}
    return { updatedAt: 0, by: '' };
  }
  function writeMeta(m) {
    try { global.localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) {}
  }

  /* Kumpulkan snapshot lokal (string per key). TIDAK menyentuh data. */
  function collectLocal() {
    var out = {};
    try {
      if (global.FinAuditStore && global.FinAuditStore.snapshotAll) {
        out = global.FinAuditStore.snapshotAll() || {};
      } else {
        for (var i = 0; i < global.localStorage.length; i++) {
          var k = global.localStorage.key(i);
          if (k) { try { out[k] = global.localStorage.getItem(k); } catch (e) {} }
        }
      }
    } catch (e) {}
    Object.keys(out).forEach(function (k) {
      if (SYNC_BLOCK_RE.test(k) || !SYNC_ALLOW_RE.test(k)) delete out[k];
    });
    return out;
  }

  /* Terapkan data cloud ke lokal. ADDITIVE: tidak menghapus key lokal. */
  function applyRemote(storage, updatedAt, by) {
    if (!storage || typeof storage !== 'object') return 0;
    var n = 0;
    applyingRemote = true;
    try {
      Object.keys(storage).forEach(function (k) {
        if (SYNC_BLOCK_RE.test(k) || !SYNC_ALLOW_RE.test(k)) return;
        var v = storage[k];
        if (typeof v !== 'string') {
          try { v = JSON.stringify(v); } catch (e) { return; }
        }
        if (v && v.length > 5 * 1024 * 1024) return;
        try { global.localStorage.setItem(k, v); n++; } catch (e) {}
      });
      writeMeta({ updatedAt: updatedAt || Date.now(), by: by || '' });
    } finally {
      applyingRemote = false;
    }
    return n;
  }

  /* ─── Push (lokal → cloud), debounce ─── */
  function schedulePush() {
    if (applyingRemote) return; // perubahan akibat apply remote jangan dipush balik
    if (!ensureInit() || !fUser) return;
    if (pushTimer) return;
    pushTimer = setTimeout(function () {
      pushTimer = null;
      pushNow(false);
    }, PUSH_DEBOUNCE_MS);
  }

  function pushNow(force) {
    if (!ensureInit() || !fUser) return Promise.resolve(false);
    var storage = collectLocal();
    var keys = Object.keys(storage);
    if (!keys.length && !force) return Promise.resolve(false);
    var raw;
    try { raw = JSON.stringify(storage); } catch (e) { return Promise.resolve(false); }
    if (raw.length > MAX_DOC_CHARS) {
      toast('Data terlalu besar untuk cloud sync (>900KB). Tetap aman lokal; pakai Backup file.', 'error');
      return Promise.resolve(false);
    }
    var now = Date.now();
    var ref = docRef();
    if (!ref) return Promise.resolve(false);
    return ref.set({ storage: storage, updatedAt: now, by: clientId }, { merge: false })
      .then(function () {
        writeMeta({ updatedAt: now, by: clientId });
        return true;
      })
      .catch(function (err) {
        try { console.warn('[FinAudit cloud] push gagal:', err); } catch (e) {}
        return false;
      });
  }

  /* ─── Rekonsiliasi pertama (SETELAH login). Aman: ───
     cloud kosong → unggah lokal | lokal kosong → unduh cloud |
     keduanya berisi & beda → TANYA USER dulu. */
  function reconcile() {
    var ref = docRef();
    if (!ref) return Promise.resolve();
    return ref.get().then(function (snap) {
      var local = collectLocal();
      var localCount = Object.keys(local).length;
      var meta = readMeta();
      if (!snap.exists) {
        if (localCount > 0) {
          return pushNow(true).then(function (ok) {
            if (ok) toast('Data perangkat ini tersimpan ke cloud.');
          });
        }
        writeMeta({ updatedAt: 0, by: '' });
        return;
      }
      var d = snap.data() || {};
      var cloudCount = d.storage ? Object.keys(d.storage).length : 0;
      if (localCount === 0 && cloudCount > 0) {
        var n = applyRemote(d.storage, d.updatedAt, d.by);
        toast('Data cloud (' + n + ' bagian) dimuat ke perangkat ini.');
        scheduleReload();
        return;
      }
      if (localCount > 0 && cloudCount === 0) {
        return pushNow(true);
      }
      var cloudNewer = (d.updatedAt || 0) > (meta.updatedAt || 0);
      var localNewer = (meta.updatedAt || 0) > (d.updatedAt || 0);
      if (cloudNewer && d.by !== clientId) {
        var me = '';
        try { me = (fUser && fUser.email) || ''; } catch (e) {}
        var ok = true;
        try {
          ok = global.confirm(
            'Ditemukan data cloud yang LEBIH BARU (dari perangkat lain).\n\n' +
            'OK = muat data cloud ke perangkat ini.\n' +
            'Batal = PERTAHANKAN data perangkat ini & unggah ke cloud.\n\n' +
            'Data tidak akan hilang dalam kedua pilihan.');
        } catch (e) { ok = true; }
        if (ok) {
          var n2 = applyRemote(d.storage, d.updatedAt, d.by);
          toast('Data cloud (' + n2 + ' bagian) dimuat.');
          scheduleReload();
        } else {
          pushNow(true).then(function () {
            toast('Data perangkat ini dipertahankan & diunggah ke cloud.');
          });
        }
        return;
      }
      if (localNewer || (d.by === clientId && localCount > 0)) {
        return pushNow(true);
      }
      // Sama-sama baru / tidak ada beda → diam, tidak ada yang ditimpa.
    }).catch(function (err) {
      try { console.warn('[FinAudit cloud] reconcile gagal:', err); } catch (e) {}
    });
  }

  function scheduleReload() {
    // Jangan reload saat user sedang mengetik agar input tidak hilang.
    try {
      var ae = document.activeElement;
      if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) {
        toast('Data baru diterima — refresh manual bila perlu.');
        return;
      }
    } catch (e) {}
    setTimeout(function () { try { global.location.reload(); } catch (e) {} }, 1600);
  }

  function attachListener() {
    if (unsub || !docRef()) return;
    skipFirstSnap = true;
    try {
      unsub = docRef().onSnapshot(function (snap) {
        if (!snap || !snap.exists) return;
        if (skipFirstSnap) { skipFirstSnap = false; return; } // snapshot awal = hasil reconcile
        var d = snap.data() || {};
        if (d.by === clientId) return; // gema dari push sendiri
        var meta = readMeta();
        if ((d.updatedAt || 0) > (meta.updatedAt || 0)) {
          var n = applyRemote(d.storage, d.updatedAt, d.by);
          toast('Data baru dari perangkat lain diterima (' + n + ' bagian).');
          scheduleReload();
        }
      }, function (err) {
        try { console.warn('[FinAudit cloud] listener error:', err); } catch (e) {}
      });
    } catch (e) {}
  }

  function detach() {
    try { if (unsub) unsub(); } catch (e) {}
    unsub = null;
  }

  /* ─── Sesi lokal pendamping (agar requireAuth lama tetap lolos) ─── */
  function ensureLocalSession(email) {
    try {
      if (!global.FinAuditAuth) return Promise.resolve();
      var t = global.FinAuditAuth.getSessionToken();
      return global.FinAuditAuth.validateToken(t).then(function (ok) {
        if (ok) {
          try { if (global.FinAuditStore) global.FinAuditStore.setCurrentUser(email); } catch (e) {}
          return;
        }
        return global.FinAuditAuth.createSession(email, true);
      });
    } catch (e) { return Promise.resolve(); }
  }

  function startSync() {
    if (!ensureInit()) return false;
    hookStore();
    try {
      auth.onAuthStateChanged(function (user) {
        fUser = user || null;
        if (user) {
          var email = '';
          try { email = (user.email || '').toLowerCase(); } catch (e) {}
          ensureLocalSession(email).then(function () {
            attachListener();
            reconcile();
          });
          try {
            if (global.FinAuditStore && email) global.FinAuditStore.setCurrentUser(email);
          } catch (e) {}
        } else {
          detach();
        }
        authListeners.forEach(function (fn) { try { fn(user || null); } catch (e) {} });
      });
    } catch (e) { return false; }
    return true;
  }

  function hookStore() {
    if (storeHooked) return;
    storeHooked = true;
    try {
      if (global.FinAuditStore && global.FinAuditStore.on) {
        global.FinAuditStore.on(function (msg) {
          if (msg && msg.type === 'set') schedulePush();
        });
      }
    } catch (e) {}
    // Fallback: bila store.js belum ada, pantau storage event (tab lain) — tab
    // yang sama tidak memicu event, jadi ini hanya bonus, bukan andalan.
    try {
      global.addEventListener('storage', function () { schedulePush(); });
    } catch (e) {}
  }

  /* ─── Auth API ─── */
  function mapError(err) {
    var code = (err && err.code) || '';
    var map = {
      'auth/email-already-in-use': 'Email sudah terdaftar. Silakan login.',
      'auth/invalid-email': 'Format email tidak valid.',
      'auth/weak-password': 'Password minimal 6 karakter.',
      'auth/user-not-found': 'Email atau password salah.',
      'auth/wrong-password': 'Email atau password salah.',
      'auth/invalid-credential': 'Email atau password salah.',
      'auth/too-many-requests': 'Terlalu banyak percobaan. Coba lagi nanti.',
      'auth/network-request-failed': 'Jaringan bermasalah. Periksa koneksi.',
      'auth/popup-closed-by-user': null, // diam saja
      'auth/cancelled-popup-request': null
    };
    if (code in map) {
      var m = map[code];
      var e2 = new Error(m || '');
      e2.code = 'silent';
      if (m === null) e2.silent = true;
      throw e2;
    }
    var e3 = new Error(((err && err.message) || 'Login cloud gagal.') + (code ? ' [' + code + ']' : ''));
    e3.code = code;
    try { console.error('[FinAudit cloud] auth error:', code, err); } catch (e) {}
    throw e3;
  }

  function afterAuth(fbUser, remember) {
    var email = '';
    try { email = (fbUser.email || '').toLowerCase(); } catch (e) {}
    fUser = fbUser;
    try {
      if (global.FinAuditAuth) {
        return global.FinAuditAuth.createSession(email, remember !== false).then(function () {
          try { global.FinAuditAuth.recordSuccess(email); } catch (e) {}
          try { if (global.FinAuditStore) global.FinAuditStore.setCurrentUser(email); } catch (e) {}
          attachListener();
          reconcile();
          return email;
        });
      }
    } catch (e) {}
    return Promise.resolve(email);
  }

  function needInit() {
    if (!ensureInit()) return Promise.reject(new Error('Cloud belum dikonfigurasi.'));
    return Promise.resolve();
  }

  function signUpEmail(name, email, password) {
    return needInit().then(function () {
      return auth.createUserWithEmailAndPassword(email, password).then(function (cred) {
        var u = cred.user;
        var p = (name && u.updateProfile) ? u.updateProfile({ displayName: String(name).slice(0, 100) }) : Promise.resolve();
        return p.then(function () { return afterAuth(u, true); });
      }).catch(function (err) { mapError(err); });
    });
  }

  function signInEmail(email, password, remember) {
    return needInit().then(function () {
      var mode = remember ? global.firebase.auth.Auth.Persistence.LOCAL
                          : global.firebase.auth.Auth.Persistence.SESSION;
      return auth.setPersistence(mode).then(function () {
        return auth.signInWithEmailAndPassword(email, password);
      }).then(function (cred) {
        return afterAuth(cred.user, remember);
      }).catch(function (err) { mapError(err); });
    });
  }

  function signInGoogle() {
    return needInit().then(function () {
      var provider = new global.firebase.auth.GoogleAuthProvider();
      return auth.setPersistence(global.firebase.auth.Auth.Persistence.LOCAL).then(function () {
        return auth.signInWithPopup(provider).then(function (cred) {
          return afterAuth(cred.user, true);
        }).catch(function (err) {
          var code = (err && err.code) || '';
          // Popup dibatalkan user → diam. Popup gagal karena lingkungan
          // (diblokir / cookie / internal-error) → fallback redirect penuh.
          if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
            mapError(err);
          }
          if (code === 'auth/popup-blocked' || code === 'auth/internal-error' ||
              code === 'auth/unauthorized-domain' || code === 'auth/operation-not-supported') {
            try { toast('Popup terhalang — membuka login Google lewat redirect...'); } catch (e) {}
            return auth.signInWithRedirect(provider); // navigasi pergi; hasil diproses saat kembali
          }
          mapError(err);
        });
      });
    });
  }

  /* Dipanggil halaman login saat boot: memproses hasil kembali dari redirect. */
  function consumeRedirect() {
    if (!ensureInit()) return Promise.resolve(null);
    try {
      return auth.getRedirectResult().then(function (res) {
        if (res && res.user) return afterAuth(res.user, true);
        return null;
      }).catch(function (err) {
        if (err && (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request')) return null;
        try { mapError(err); } catch (mapped) {
          if (mapped && mapped.silent) return null;
          toast((mapped && mapped.message) || 'Login Google gagal.');
          return null;
        }
        return null;
      });
    } catch (e) { return Promise.resolve(null); }
  }

  function signOut() {
    try { detach(); } catch (e) {}
    var p = ensureInit() ? auth.signOut().catch(function () {}) : Promise.resolve();
    return p.then(function () {
      try { if (global.FinAuditAuth) global.FinAuditAuth.clearSession(); } catch (e) {}
      fUser = null;
    });
  }

  global.FinAuditFirebase = {
    isConfigured: isConfigured,
    startSync: startSync,
    signUpEmail: signUpEmail,
    signInEmail: signInEmail,
    signInGoogle: signInGoogle,
    consumeRedirect: consumeRedirect,
    signOut: signOut,
    currentUser: function () { return fUser; },
    pushNow: function () { return pushNow(true); },
    onAuth: function (fn) { if (typeof fn === 'function') authListeners.push(fn); }
  };
})(window);
