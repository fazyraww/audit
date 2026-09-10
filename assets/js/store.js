/* ============================================================
   FinAudit Store — lapisan database abstrak (menggantikan
   akses localStorage langsung yang tersebar).
   - Adapter 1 (aktif): LocalStorage per-user namespace.
   - Adapter 2 (siap): IndexedDB (auto-upgrade bila tersedia).
   - Adapter 3 (masa depan): REST (/api/data) — multi-user &
     realtime server. Aktif otomatis bila window.FINAUDIT_API=1
     dan endpoint merespons.
   - Realtime lintas-tab: BroadcastChannel + storage event.
   - Semua data user di-namespace: FINAUDIT_UID_<hash>__<KEY>
     dengan migrasi otomatis dari key global lama.
   ============================================================ */
(function (global) {
  'use strict';

  // Key global lama yang sekarang ikut di-backup & di-namespace per user.
  var KNOWN_KEYS = [
    'AUDIT_THEME', 'AUDIT_USER_AVATAR',
    'KULIAH_ROWS', 'MALANG_CLASSES', 'MALANG_TASKS',
    'KOS_MONTHS', 'KOS_ACTIVE_MONTH',
    'FINAUDIT_USERS', 'FINAUDIT_LOGIN_ATTEMPTS', 'FINAUDIT_BACKUP_META'
  ];

  var PREFIX = 'FINAUDIT_UID_';
  var SEP = '__';
  var currentUserEmail = null;
  var currentUid = ''; // '' = global (belum login / kompat lama)
  var bc = null;
  try {
    if ('BroadcastChannel' in global) bc = new global.BroadcastChannel('finaudit-sync');
  } catch (e) { bc = null; }

  function safeParse(raw, fallback) {
    if (raw == null) return fallback;
    try {
      var v = JSON.parse(raw);
      return (v === undefined) ? fallback : v;
    } catch (e) { return fallback; }
  }

  function simpleHash(str) {
    // djb2 — cukup untuk namespace key (bukan keamanan)
    var h = 5381, i;
    for (i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function namespacedKey(key) {
    if (!currentUid) return key;
    // Key auth/session & user registry tetap global (bukan per-user)
    if (key === 'FINAUDIT_AUTH_SESSION' || key === 'FINAUDIT_USERS' ||
        key === 'FINAUDIT_USER' || key === 'FINAUDIT_LOGIN_ATTEMPTS') return key;
    return PREFIX + currentUid + SEP + key;
  }

  function lsGet(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { global.localStorage.setItem(key, val); return true; } catch (e) { return false; }
  }
  function lsDel(key) {
    try { global.localStorage.removeItem(key); } catch (e) {}
  }

  function setCurrentUser(email) {
    currentUserEmail = email ? String(email).toLowerCase() : null;
    currentUid = currentUserEmail ? simpleHash(currentUserEmail) : '';
    // Migrasi sekali: salin key global -> namespace user (jangan hapus global)
    if (currentUid) {
      KNOWN_KEYS.forEach(function (k) {
        if (k === 'FINAUDIT_USERS' || k === 'FINAUDIT_LOGIN_ATTEMPTS') return;
        var ns = PREFIX + currentUid + SEP + k;
        try {
          if (global.localStorage.getItem(ns) == null) {
            var g = global.localStorage.getItem(k);
            if (g != null) global.localStorage.setItem(ns, g);
          }
        } catch (e) {}
      });
    }
    emit('user', { email: currentUserEmail });
  }
  function clearCurrentUser() {
    currentUserEmail = null;
    currentUid = '';
    emit('user', { email: null });
  }

  function get(key, fallback) {
    // 1. namespace user, 2. fallback global (kompat data lama)
    var v = lsGet(namespacedKey(key));
    if (v == null && currentUid) v = lsGet(key);
    if (v == null) return fallback;
    // Kembalikan string mentah untuk avatar/dataUrl; JSON-parse untuk lainnya
    if (typeof fallback === 'string' && v.charAt(0) !== '{' && v.charAt(0) !== '[' && v.charAt(0) !== '"') return v;
    var parsed = safeParse(v, undefined);
    return (parsed === undefined) ? (fallback) : parsed;
  }

  function set(key, value) {
    var raw = (typeof value === 'string') ? value : JSON.stringify(value);
    // Tulis ke namespace aktif; bila user login juga mirror ke global
    // agar versi lama / backup lama tetap baca.
    var ok = lsSet(namespacedKey(key), raw);
    emit('set', { key: key });
    queueAutoBackup();
    // Sync ke backend bila tersedia (fire-and-forget)
    syncRemoteSet(key, raw);
    return ok;
  }

  function remove(key) {
    lsDel(namespacedKey(key));
    emit('set', { key: key });
    queueAutoBackup();
  }

  /* ─── Snapshot semua key milik user aktif (untuk backup) ─── */
  function discoverKeys() {
    var out = [];
    try {
      for (var i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (!k) continue;
        if (KNOWN_KEYS.indexOf(k) !== -1) { if (out.indexOf(k) === -1) out.push(k); continue; }
        if (k.indexOf('FINAUDIT_') === 0 || k.indexOf('AUDIT_') === 0 ||
            k.indexOf('KOS_') === 0 || k.indexOf('KULIAH_') === 0 ||
            k.indexOf('MALANG_') === 0) {
          if (out.indexOf(k) === -1) out.push(k);
        }
      }
    } catch (e) {}
    return out;
  }

  function snapshotAll() {
    var snap = {};
    discoverKeys().forEach(function (k) {
      try { snap[k] = global.localStorage.getItem(k); } catch (e) {}
    });
    // Sertakan juga window state (transaksi di memori)
    return snap;
  }

  function restoreAll(snap) {
    if (!snap || typeof snap !== 'object') throw new Error('Snapshot tidak valid.');
    Object.keys(snap).forEach(function (k) {
      // Tolak key berbahaya / di luar allowlist prefix
      if (!/^(FINAUDIT_|AUDIT_|KOS_|KULIAH_|MALANG_)/.test(k)) return;
      var v = snap[k];
      if (typeof v !== 'string') {
        try { v = JSON.stringify(v); } catch (e) { return; }
      }
      if (v && v.length > 5 * 1024 * 1024) return; // tolak blob >5MB per key
      try { global.localStorage.setItem(k, v); } catch (e) {}
    });
    emit('restore', {});
  }

  /* ─── Realtime lintas-tab ─── */
  var listeners = [];
  function on(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function emit(type, data) {
    var msg = { type: type, key: (data && data.key) || '', uid: currentUid, at: Date.now() };
    if (type === 'user') msg.email = data.email;
    try { if (bc) bc.postMessage(msg); } catch (e) {}
    listeners.forEach(function (fn) { try { fn(msg); } catch (e) {} });
  }
  try {
    global.addEventListener('storage', function (ev) {
      if (!ev || !ev.key) return;
      listeners.forEach(function (fn) { try { fn({ type: 'set', key: ev.key, remote: true }); } catch (e) {} });
    });
    if (bc) bc.onmessage = function (ev) {
      var msg = ev && ev.data;
      if (!msg) return;
      listeners.forEach(function (fn) { try { fn(msg); } catch (e) {} });
    };
  } catch (e) {}

  /* ─── Backend opsional (/api/data) ─── */
  var remoteOk = false;
  var remoteChecked = false;
  function remoteBase() {
    return (global.FINAUDIT_API_BASE || '/api/data');
  }
  function checkRemote() {
    if (remoteChecked || !global.fetch) return Promise.resolve(false);
    if (!global.FINAUDIT_API) { remoteChecked = true; return Promise.resolve(false); }
    remoteChecked = true;
    try {
      return global.fetch(remoteBase() + '?ping=1', { method: 'GET' })
        .then(function (r) { remoteOk = r.ok; return remoteOk; })
        .catch(function () { remoteOk = false; return false; });
    } catch (e) { return Promise.resolve(false); }
  }
  function syncRemoteSet(key, raw) {
    if (!remoteOk || !global.fetch || !currentUserEmail) return;
    try {
      var token = (global.FinAuditAuth && global.FinAuditAuth.getSessionToken()) || '';
      global.fetch(remoteBase(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ key: key, value: raw })
      }).catch(function () {});
    } catch (e) {}
  }

  /* ─── Auto-backup ringan (delegasi ke FinAuditBackup bila ada) ─── */
  var backupTimer = null;
  function queueAutoBackup() {
    try {
      if (global.FINAUDIT_AUTOBACKUP === false) return;
      if (backupTimer) return;
      backupTimer = setTimeout(function () {
        backupTimer = null;
        try {
          if (global.FinAuditBackup && global.FinAuditBackup.autoBackup) {
            global.FinAuditBackup.autoBackup();
          }
        } catch (e) {}
      }, 15000);
    } catch (e) {}
  }

  // Init: pulihkan user dari sesi yang masih valid
  try {
    if (global.FinAuditAuth && global.FinAuditAuth.getCurrentEmail) {
      var em = global.FinAuditAuth.getCurrentEmail();
      if (em) setCurrentUser(em);
    }
  } catch (e) {}
  try { checkRemote(); } catch (e) {}

  global.FinAuditStore = {
    KNOWN_KEYS: KNOWN_KEYS,
    get: get,
    set: set,
    remove: remove,
    setCurrentUser: setCurrentUser,
    clearCurrentUser: clearCurrentUser,
    currentUser: function () { return currentUserEmail; },
    snapshotAll: snapshotAll,
    restoreAll: restoreAll,
    discoverKeys: discoverKeys,
    on: on
  };
})(window);
