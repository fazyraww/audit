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
  // Penanda build: dibaca panel ?debug=1 di login.html untuk membuktikan
  // file BARU yang jalan (vs cache Safari). WAJIB diganti tiap ada
  // perubahan file ini, dan query ?v= di <script> ikut di-bump.
  var BUILD = '20260912f';

  // Key yang TIDAK BOLEH keluar/masuk cloud (sesi, registry lokal, meta, auto-backup)
  var SYNC_BLOCK_RE = /^(FINAUDIT_AUTH_SESSION|FINAUDIT_USERS|FINAUDIT_USER|FINAUDIT_LOGIN_ATTEMPTS|FINAUDIT_AUTOBACKUP_|FINAUDIT_CLOUD_META|FINAUDIT_BACKUP_META)/;
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
      try { lastHash = localHash(); } catch (e) {}
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
        try { lastHash = localHash(); } catch (e) {}
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

  /* ─── Sesi lokal pendamping (agar requireAuth lama tetap lolos) ───
     Selalu session-only (tab ditutup = hangus). Sesi Firebase yang
     persisten (remember dicentang) akan membuatnya ulang saat tab baru. */
  function ensureLocalSession(email) {
    try {
      if (!global.FinAuditAuth) return Promise.resolve();
      var t = global.FinAuditAuth.getSessionToken();
      return global.FinAuditAuth.validateToken(t).then(function (ok) {
        if (ok) {
          try { if (global.FinAuditStore) global.FinAuditStore.setCurrentUser(email); } catch (e) {}
          return;
        }
        return global.FinAuditAuth.createSession(email, false);
      });
    } catch (e) { return Promise.resolve(); }
  }

  /* Normalisasi email untuk allowlist: Gmail mengabaikan titik dan
     tag-plus (fahmi.fahrezy823 == fahmifahrezy823 == fahmi+...@gmail). */
  function normalizeEmail(email) {
    try {
      var e = String(email || '').trim().toLowerCase();
      var parts = e.split('@');
      if (parts.length !== 2) return e;
      var local = parts[0], domain = parts[1];
      if (domain === 'gmail.com' || domain === 'googlemail.com') {
        local = local.split('+')[0].replace(/\./g, '');
        domain = 'gmail.com';
      }
      return local + '@' + domain;
    } catch (e2) { return String(email || '').toLowerCase(); }
  }

  function isEmailAllowed(email) {
    try {
      var list = global.FINAUDIT_ALLOWED_EMAILS;
      if (!list || !list.length) return true;
      var norm = normalizeEmail(email);
      return list.some(function (a) { return normalizeEmail(a) === norm; });
    } catch (e) { return true; }
  }

  /* Penanda login segar (sessionStorage, seumur tab): membedakan "baru saja
     login 5 detik lalu" dari "sesi persisten sisa kemarin" agar migrasi
     session-only tidak menendang login yang baru selesai. */
  function markFreshLogin() {
    try { if (global.sessionStorage) global.sessionStorage.setItem('FINAUDIT_FRESH_LOGIN', '1'); } catch (e) {}
  }
  function consumeFreshLogin() {
    try {
      if (global.sessionStorage && global.sessionStorage.getItem('FINAUDIT_FRESH_LOGIN') === '1') {
        global.sessionStorage.removeItem('FINAUDIT_FRESH_LOGIN');
        return true;
      }
    } catch (e) {}
    return false;
  }

  /* Migrasi sekali ke kebijakan session-only: cabut sesi lama yang persisten
     (LOCAL / remember-30-hari) agar perilaku logout-otomatis langsung berlaku
     di semua perangkat. Login SEBELUMNYA yang masih segar (penanda
     FINAUDIT_FRESH_LOGIN) dikecualikan — tanpa ini login yang baru selesai
     ikut ditendang dan user mental kembali ke halaman login. */
  function migrateSessionPolicy() {
    try {
      if (global.localStorage.getItem('FINAUDIT_SESSION_POLICY_V1')) return Promise.resolve(false);
    } catch (e) { return Promise.resolve(false); }
    if (consumeFreshLogin()) {
      // Baru saja login di tab ini → bukan sesi sisa kemarin. Tandai selesai.
      try { global.localStorage.setItem('FINAUDIT_SESSION_POLICY_V1', '1'); } catch (e) {}
      return Promise.resolve(false);
    }
    var p = Promise.resolve();
    try {
      if (auth) p = auth.signOut().catch(function () {});
    } catch (e) {}
    return p.then(function () {
      try { if (global.FinAuditAuth) global.FinAuditAuth.clearSession(); } catch (e) {}
      fUser = null;
      try { global.localStorage.setItem('FINAUDIT_SESSION_POLICY_V1', '1'); } catch (e) {}
      return true;
    });
  }

  function startSync() {
    if (!ensureInit()) return false;
    hookStore();
    patchStorage();
    startPoll();
    migrateSessionPolicy();
    try {
      auth.onAuthStateChanged(function (user) {
        fUser = user || null;
        if (user) {
          var email = '';
          try { email = (user.email || '').toLowerCase(); } catch (e) {}
          if (!isEmailAllowed(email)) {
            // Sesi lama akun tak diizinkan (mis. login sebelum allowlist ada)
            try { auth.signOut().catch(function () {}); } catch (e) {}
            try { if (global.FinAuditAuth) global.FinAuditAuth.clearSession(); } catch (e) {}
            fUser = null;
            toast('Akun ' + (email || 'ini') + ' tidak diizinkan mengakses aplikasi ini.', 'error');
            try { global.location.href = 'login.html'; } catch (e) {}
            return;
          }
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
    try {
      global.addEventListener('storage', function () { schedulePush(); });
    } catch (e) {}
  }

  /* Tangkap tulisan LANGSUNG ke localStorage (jadwal, kos, avatar, tema, …)
     yang tidak lewat FinAuditStore: patch setItem/removeItem + poll hash
     + flush saat halaman disembunyikan/ditutup. Tanpa ini, data yang diisi
     di HP tidak pernah terunggah ke cloud. */
  var storagePatched = false, pollTimer = null, lastHash = '';

  function shouldSyncKey(k) {
    return typeof k === 'string' && SYNC_ALLOW_RE.test(k) && !SYNC_BLOCK_RE.test(k);
  }
  function hashStr(s) {
    var h = 5381, i;
    for (i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + s.length;
  }
  function localHash() {
    try {
      var st = collectLocal();
      var keys = Object.keys(st).sort();
      var parts = [];
      for (var i = 0; i < keys.length; i++) {
        parts.push(keys[i] + '=' + hashStr(String(st[keys[i]])));
      }
      return hashStr(parts.join('|'));
    } catch (e) { return ''; }
  }
  function patchStorage() {
    if (storagePatched) return;
    storagePatched = true;
    try {
      var proto = (global.Storage && global.Storage.prototype) || null;
      var target = (proto && typeof proto.setItem === 'function') ? proto : global.localStorage;
      if (!target || typeof target.setItem !== 'function') return;
      var origSet = target.setItem, origDel = target.removeItem;
      target.setItem = function (k, v) {
        var r = origSet.apply(this, arguments);
        try { if (!applyingRemote && fUser && shouldSyncKey(k)) schedulePush(); } catch (e) {}
        return r;
      };
      target.removeItem = function (k) {
        var r = origDel.apply(this, arguments);
        try { if (!applyingRemote && fUser && shouldSyncKey(k)) schedulePush(); } catch (e) {}
        return r;
      };
    } catch (e) {}
  }
  function startPoll() {
    if (pollTimer) return;
    try { lastHash = localHash(); } catch (e) {}
    pollTimer = setInterval(function () {
      try {
        if (!fUser || !ensureInit()) return;
        var h = localHash();
        if (h && h !== lastHash) { lastHash = h; schedulePush(); }
      } catch (e) {}
    }, 30000);
    try {
      var flush = function () { try { if (fUser && ensureInit()) pushNow(true); } catch (e) {} };
      global.addEventListener('pagehide', flush);
      if (global.document && global.document.addEventListener) {
        global.document.addEventListener('visibilitychange', function () {
          try { if (global.document.hidden) flush(); } catch (e) {}
        });
      }
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
    var suffix = code ? ' [' + code + ']' : '';
    var e3 = new Error(((err && err.message) || 'Login cloud gagal.') + suffix);
    e3.code = code;
    try { console.error('[FinAudit cloud] auth error:', code, err); } catch (e) {}
    throw e3;
  }

  function afterAuth(fbUser, remember) {
    var email = '';
    try { email = (fbUser.email || '').toLowerCase(); } catch (e) {}
    // Allowlist: tolak akun di luar daftar sebelum sesi apa pun dibuat.
    try {
      var list = global.FINAUDIT_ALLOWED_EMAILS;
      if (list && list.length) {
        var ok = list.some(function (a) { return normalizeEmail(a) === normalizeEmail(email); });
        if (!ok) {
          try { if (auth) auth.signOut().catch(function () {}); } catch (e) {}
          try { if (global.FinAuditAuth) global.FinAuditAuth.clearSession(); } catch (e) {}
          fUser = null;
          return Promise.reject(new Error('Akun ' + (email || 'ini') + ' tidak diizinkan mengakses aplikasi ini.'));
        }
      }
    } catch (e) {}
    fUser = fbUser;
    try {
      if (global.FinAuditAuth) {
        return global.FinAuditAuth.createSession(email, remember === true).then(function () {
          markFreshLogin();
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

  function signUpEmail(name, email, password, remember) {
    return needInit().then(function () {
      return auth.createUserWithEmailAndPassword(email, password).then(function (cred) {
        var u = cred.user;
        var p = (name && u.updateProfile) ? u.updateProfile({ displayName: String(name).slice(0, 100) }) : Promise.resolve();
        return p.then(function () { return afterAuth(u, remember === true); });
      }).catch(function (err) { mapError(err); });
    });
  }

  function signInEmail(email, password, remember) {
    return needInit().then(function () {
      var sticky = remember === true;
      var mode = sticky ? global.firebase.auth.Auth.Persistence.LOCAL
                        : global.firebase.auth.Auth.Persistence.SESSION;
      return auth.setPersistence(mode).then(function () {
        return auth.signInWithEmailAndPassword(email, password);
      }).then(function (cred) {
        return afterAuth(cred.user, sticky);
      }).catch(function (err) { mapError(err); });
    });
  }

  /* Safari (terutama iOS) memblokir komunikasi popup lintas-situs (ITP):
     popup terbuka, user setuju, tapi hasilnya tidak pernah kembali → stuck.
     Solusi: browser ini langsung pakai redirect penuh, tanpa popup. */
  function useRedirectFirst() {
    try {
      var nav = global.navigator || {};
      var ua = nav.userAgent || '';
      var isIOS = /iPad|iPhone|iPod/.test(ua) ||
        (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
      var isSafari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR/.test(ua);
      return isIOS || isSafari;
    } catch (e) { return false; }
  }

  function saveRememberFlag(sticky) {
    try {
      if (global.sessionStorage) {
        global.sessionStorage.setItem('FINAUDIT_REMEMBER', sticky ? '1' : '0');
      }
    } catch (e) {}
  }

  function signInGoogle(remember, onStep) {
    var step = function (m) { try { if (typeof onStep === 'function') onStep(m); } catch (e) {} };
    return needInit().then(function () {
      step('needInit ok');
      var sticky = remember === true;
      var provider;
      try {
        provider = new global.firebase.auth.GoogleAuthProvider();
        step('provider ok');
      } catch (e) {
        step('provider GAGAL: ' + ((e && (e.code || e.message)) || e));
        throw e;
      }
      var mode = sticky ? global.firebase.auth.Auth.Persistence.LOCAL
                        : global.firebase.auth.Auth.Persistence.SESSION;
      step('setPersistence mulai (' + (sticky ? 'LOCAL' : 'SESSION') + ')');
      return auth.setPersistence(mode).then(function () {
        step('setPersistence selesai');
        if (useRedirectFirst()) {
          try { toast('Membuka login Google...'); } catch (e) {}
          saveRememberFlag(sticky);
          try { step('mode=' + (useRedirectFirst() ? 'redirect' : 'popup') + ', redirect mulai'); } catch (e) {}
          try {
            setTimeout(function () {
              try { step('WATCHDOG 3dtk: masih di login, belum navigasi. url=' + String(global.location && global.location.href).slice(0, 80)); } catch (e2) {}
            }, 3000);
          } catch (e2) {}
          step('memanggil signInWithRedirect...');
          return auth.signInWithRedirect(provider); // hasil diproses consumeRedirect saat kembali
        }
        step('popup mulai');
        return auth.signInWithPopup(provider).then(function (cred) {
          step('popup sukses');
          return afterAuth(cred.user, sticky);
        }).catch(function (err) {
          var code = (err && err.code) || '';
          step('popup GAGAL: code=' + (code || '(tanpa kode)'));
          // Popup dibatalkan user → diam. Popup gagal karena lingkungan
          // (diblokir / cookie / internal-error) → fallback redirect penuh.
          if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
            mapError(err);
          }
          if (code === 'auth/popup-blocked' || code === 'auth/internal-error' ||
              code === 'auth/unauthorized-domain' || code === 'auth/operation-not-supported') {
            try { toast('Popup terhalang — membuka login Google lewat redirect...'); } catch (e) {}
            saveRememberFlag(sticky);
            step('fallback redirect mulai');
            return auth.signInWithRedirect(provider); // navigasi pergi; hasil diproses saat kembali
          }
          mapError(err);
        });
      }, function (persistErr) {
        step('setPersistence GAGAL: code=' + ((persistErr && persistErr.code) || '(tanpa kode)') + ' msg=' + ((persistErr && persistErr.message) || persistErr));
        throw persistErr;
      });
    });
  }

  /* Dipanggil halaman login saat boot: memproses hasil kembali dari redirect.
     onProgress opsional: menerima string progres (dipakai panel ?debug=1).
     Watchdog 8 detik mencatat bila hasil tak kunjung tiba (kasus iOS) —
     hanya mencatat, tidak membatalkan (hasil yang telat tetap diproses). */
  function consumeRedirect(onProgress) {
    if (!ensureInit()) return Promise.resolve(null);
    var sticky = false;
    try {
      sticky = global.sessionStorage && global.sessionStorage.getItem('FINAUDIT_REMEMBER') === '1';
    } catch (e) {}
    var settled = false;
    var note = function (m) { try { if (typeof onProgress === 'function') onProgress(m); } catch (e) {} };
    try {
      setTimeout(function () {
        if (!settled) note('masih menunggu hasil redirect dari Google (8 dtk, kemungkinan tertahan di Safari)...');
      }, 8000);
    } catch (e) {}
    try {
      return auth.getRedirectResult().then(function (res) {
        settled = true;
        note('hasil diterima: ' + (res && res.user ? res.user.email : '(kosong)'));
        try {
          var cu = auth.currentUser;
          note('firebase user saat ini: ' + (cu ? (cu.email || '(tanpa email)') : '(tidak ada)'));
        } catch (e2) {}
        if (res && res.user) return afterAuth(res.user, sticky);
        return null;
      }).catch(function (err) {
        settled = true;
        note('getRedirectResult ERROR kode=' + ((err && err.code) || '(tanpa kode)'));
        if (err && (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request')) return null;
        try { mapError(err); } catch (mapped) {
          if (mapped && mapped.silent) return null;
          note('GAGAL: ' + ((mapped && mapped.message) || 'Login Google gagal.'));
          toast((mapped && mapped.message) || 'Login Google gagal.');
          return null;
        }
        return null;
      });
    } catch (e) { settled = true; return Promise.resolve(null); }
  }

  function signOut() {
    try { detach(); } catch (e) {}
    var p = ensureInit() ? auth.signOut().catch(function () {}) : Promise.resolve();
    return p.then(function () {
      try { if (global.FinAuditAuth) global.FinAuditAuth.clearSession(); } catch (e) {}
      fUser = null;
    });
  }

  /* Untuk halaman login: pantau sesi Firebase, pastikan sesi lokal
     pendamping ada. Self-heal bila login tercerai (mis. redirect kembali
     tapi sesi lokal gagal dibuat): panggil onUser hanya bila sesi lokal
     valid, sehingga tidak ada loop login↔dashboard. Tanpa reconcile/push. */
  var watchStarted = false;
  function watchAuth(onUser) {
    if (!ensureInit()) return false;
    if (watchStarted) return true;
    watchStarted = true;
    try {
      auth.onAuthStateChanged(function (user) {
        fUser = user || null;
        if (!user) return;
        var email = '';
        try { email = (user.email || '').toLowerCase(); } catch (e) {}
        if (!isEmailAllowed(email)) {
          try { auth.signOut().catch(function () {}); } catch (e) {}
          try { if (global.FinAuditAuth) global.FinAuditAuth.clearSession(); } catch (e) {}
          fUser = null;
          return;
        }
        ensureLocalSession(email).then(function () {
          if (typeof onUser !== 'function') return;
          try {
            if (!global.FinAuditAuth) return;
            global.FinAuditAuth.validateToken(global.FinAuditAuth.getSessionToken()).then(function (ok) {
              if (ok) { try { onUser(email); } catch (e) {} }
            });
          } catch (e) {}
        });
      });
    } catch (e) { return false; }
    return true;
  }

  global.FinAuditFirebase = {
    BUILD: BUILD,
    loginMode: function () { try { return useRedirectFirst() ? 'redirect' : 'popup'; } catch (e) { return 'popup'; } },
    isConfigured: isConfigured,
    startSync: startSync,
    watchAuth: watchAuth,
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
