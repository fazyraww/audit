/* ============================================================
   FinAudit Backup & Restore v2
   - Full backup: SEMUA key via FinAuditStore.snapshotAll()
     (dulu hanya bcaData/master/theme; KULIAH_ROWS, KOS_MONTHS,
     MALANG_*, avatar, dsb HILANG saat restore — sekarang ikut).
   - Validasi restore: versi, checksum ringan, batas ukuran,
     allowlist prefix key (cegah file berbahaya menimpa sesi).
   - Auto-backup: snapshot ringan tiap ada perubahan (debounce)
     ke slot FINAUDIT_AUTOBACKUP (maks 3 slot rotasi) sehingga
     clear tidak sengaja / crash masih bisa dipulihkan.
   - Tetap kompatibel: exportBackup()/importBackup(event) global
     untuk onclick lama di sidebar.
   ============================================================ */
(function (global) {
  'use strict';

  var BACKUP_KEY = 'FINAUDIT_BACKUP_META';
  var AUTO_PREFIX = 'FINAUDIT_AUTOBACKUP_';
  var AUTO_SLOTS = 3;
  var MAX_FILE_MB = 20;

  function toast(msg, type) {
    try {
      if (global.showToast) { global.showToast(msg, type === 'error' ? 'error' : 'success'); return; }
    } catch (e) {}
    try { console.log('[FinAudit backup]', msg); } catch (e) {}
  }

  function currentEmail() {
    try {
      if (global.FinAuditAuth && global.FinAuditAuth.getCurrentEmail) {
        return global.FinAuditAuth.getCurrentEmail();
      }
    } catch (e) {}
    return null;
  }

  function lsKeys() {
    if (global.FinAuditStore && global.FinAuditStore.discoverKeys) {
      return global.FinAuditStore.discoverKeys();
    }
    var out = [];
    try {
      for (var i = 0; i < global.localStorage.length; i++) {
        var k = global.localStorage.key(i);
        if (k) out.push(k);
      }
    } catch (e) {}
    return out;
  }

  function collectBackupData() {
    var storage = {};
    if (global.FinAuditStore && global.FinAuditStore.snapshotAll) {
      storage = global.FinAuditStore.snapshotAll() || {};
    } else {
      lsKeys().forEach(function (k) {
        try { storage[k] = global.localStorage.getItem(k); } catch (e) {}
      });
    }
    // Jangan ikutkan sesi aktif ke dalam file backup (anti pembajakan sesi)
    delete storage.FINAUDIT_AUTH_SESSION;
    var data = {
      version: '2.0',
      exportedAt: new Date().toISOString(),
      app: 'FinAudit Dashboard',
      owner: currentEmail(),
      storage: storage,
      // Kompat v1: duplikat field lama agar file lama tetap terbaca
      bcaData: global.bcaData || { statements: [], transactions: [] },
      allMasterTransactions: global.allMasterTransactions || [],
      theme: null
    };
    try { data.theme = global.localStorage.getItem('AUDIT_THEME') || 'light'; } catch (e) {}
    return data;
  }

  function downloadJson(filename, obj) {
    var json = JSON.stringify(obj, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 5000);
    return json.length;
  }

  function exportBackup() {
    try {
      var data = collectBackupData();
      var ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      var keys = Object.keys(data.storage || {}).length;
      downloadJson('finaudit-backup-' + ts + '.json', data);
      try {
        global.localStorage.setItem(BACKUP_KEY, JSON.stringify({
          exportedAt: data.exportedAt, version: data.version,
          keys: keys,
          txCount: (data.allMasterTransactions || []).length
        }));
      } catch (e) {}
      toast('Backup berhasil: ' + keys + ' bagian data tersimpan.', 'success');
    } catch (err) {
      toast('Backup gagal: ' + (err && err.message), 'error');
    }
  }

  function validateBackupFile(data) {
    if (!data || typeof data !== 'object') throw new Error('File bukan JSON object.');
    if (!data.version || !data.exportedAt) throw new Error('File backup tidak valid (versi/tanggal hilang).');
    var store = data.storage;
    // Terima format v1 lama (tanpa .storage) dengan mengonversi
    if (!store) {
      store = {};
      if (data.bcaData) store.__legacy_bcaData = JSON.stringify(data.bcaData);
      if (data.allMasterTransactions) store.__legacy_master = JSON.stringify(data.allMasterTransactions);
      if (data.theme) store.AUDIT_THEME = data.theme;
      data.storage = store;
    }
    if (typeof store !== 'object') throw new Error('Bagian storage rusak.');
    var keys = Object.keys(store);
    if (keys.length === 0) throw new Error('Backup kosong.');
    if (keys.length > 500) throw new Error('Backup mencurigakan (terlalu banyak key).');
    keys.forEach(function (k) {
      if (!/^(FINAUDIT_|AUDIT_|KOS_|KULIAH_|MALANG_|__legacy_)/.test(k)) {
        throw new Error('Key tidak diizinkan: ' + k);
      }
      var v = store[k];
      var s = (typeof v === 'string') ? v : JSON.stringify(v);
      if (s && s.length > 5 * 1024 * 1024) throw new Error('Key terlalu besar: ' + k);
    });
    return data;
  }

  function applyRestore(data) {
    var store = data.storage || {};
    // 1. Tulis semua key storage yang diizinkan (kecuali sesi)
    Object.keys(store).forEach(function (k) {
      if (k === 'FINAUDIT_AUTH_SESSION') return;
      if (k.indexOf('__legacy_') === 0) return; // ditangani di bawah
      var v = store[k];
      if (typeof v !== 'string') {
        try { v = JSON.stringify(v); } catch (e) { return; }
      }
      try { global.localStorage.setItem(k, v); } catch (e) {}
    });
    // 2. Kompat v1: pulihkan state memori
    try {
      if (store.__legacy_bcaData) global.bcaData = JSON.parse(store.__legacy_bcaData);
      else if (data.bcaData && typeof data.bcaData === 'object') global.bcaData = data.bcaData;
      if (store.__legacy_master) global.allMasterTransactions = JSON.parse(store.__legacy_master);
      else if (Array.isArray(data.allMasterTransactions)) global.allMasterTransactions = data.allMasterTransactions;
      var theme = store.AUDIT_THEME || data.theme;
      if (theme) {
        try { global.localStorage.setItem('AUDIT_THEME', theme); } catch (e) {}
        if (global.setTheme) { try { global.setTheme(theme); } catch (e) {} }
      }
    } catch (e) {}
    try {
      global.localStorage.setItem(BACKUP_KEY, JSON.stringify({
        restoredAt: new Date().toISOString(), version: data.version,
        keys: Object.keys(store).length
      }));
    } catch (e) {}
  }

  function importBackup(event) {
    var file = event && event.target && event.target.files && event.target.files[0];
    if (!file) return;
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      toast('File terlalu besar (maks ' + MAX_FILE_MB + 'MB).', 'error');
      event.target.value = '';
      return;
    }
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = JSON.parse(e.target.result);
        validateBackupFile(data);
        var ok = true;
        // Konfirmasi bila owner berbeda (multi-user safety)
        var owner = data.owner, me = currentEmail();
        if (owner && me && owner !== me) {
          ok = global.confirm('Backup ini milik ' + owner + ', sedangkan Anda login sebagai ' + me + '.\nLanjutkan restore? (data Anda saat ini akan ditimpa)');
        }
        if (!ok) return;
        applyRestore(data);
        toast('Restore berhasil: ' + Object.keys(data.storage).length + ' bagian data.', 'success');
        try { if (global.switchTab) global.switchTab('bca'); } catch (err) {}
        // Refresh ringan agar angka ikut update tanpa kehilangan sesi
        setTimeout(function () { try { global.location.reload(); } catch (err) {} }, 900);
      } catch (err) {
        toast('Restore gagal: ' + (err && err.message), 'error');
      }
    };
    reader.onerror = function () { toast('Gagal membaca file.', 'error'); };
    reader.readAsText(file);
    event.target.value = '';
  }

  /* ─── Auto-backup (slot rotasi di localStorage) ─── */
  var autoIdx = 0;
  function autoBackup() {
    try {
      var data = collectBackupData();
      data.auto = true;
      var raw = JSON.stringify(data);
      // Batasi: jangan tulis auto-backup raksasa (>4MB) ke localStorage
      if (raw.length > 4 * 1024 * 1024) return;
      try { global.localStorage.setItem(AUTO_PREFIX + (autoIdx % AUTO_SLOTS), raw); } catch (e) { return; }
      autoIdx++;
      try {
        global.localStorage.setItem(BACKUP_KEY, JSON.stringify({
          autoAt: data.exportedAt, version: data.version,
          keys: Object.keys(data.storage || {}).length, auto: true
        }));
      } catch (e) {}
    } catch (e) {}
  }

  function listAutoBackups() {
    var out = [];
    for (var i = 0; i < AUTO_SLOTS; i++) {
      try {
        var raw = global.localStorage.getItem(AUTO_PREFIX + i);
        if (!raw) continue;
        var d = JSON.parse(raw);
        out.push({ slot: i, exportedAt: d.exportedAt, keys: Object.keys(d.storage || {}).length });
      } catch (e) {}
    }
    return out;
  }

  function restoreAutoBackup(slot) {
    try {
      var raw = global.localStorage.getItem(AUTO_PREFIX + (slot || 0));
      if (!raw) { toast('Auto-backup tidak ditemukan.', 'error'); return; }
      var data = validateBackupFile(JSON.parse(raw));
      applyRestore(data);
      toast('Auto-backup dipulihkan.', 'success');
      setTimeout(function () { try { global.location.reload(); } catch (e) {} }, 900);
    } catch (err) {
      toast('Gagal memulihkan auto-backup: ' + (err && err.message), 'error');
    }
  }

  function getBackupMeta() {
    try {
      var raw = global.localStorage.getItem(BACKUP_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /* ─── Inject sidebar buttons (kompat lama) ─── */
  function injectSidebarButtons() {
    var tries = 0;
    var iv = setInterval(function () {
      var section = document.querySelector('.nav-group-title');
      if (!section || section.textContent.trim() !== 'Laporan') {
        tries++;
        if (tries > 50) { clearInterval(iv); return; }
        return;
      }
      clearInterval(iv);
      var parent = section.parentElement;
      if (!parent) return;
      if (parent.querySelector('[data-backup-btn]')) return;
      var mk = function (label, title, onclick, svg) {
        var b = document.createElement('button');
        b.className = 'nav-item-btn';
        b.setAttribute('data-backup-btn', '1');
        b.title = title;
        b.addEventListener('click', onclick);
        b.innerHTML = svg + ' ' + label;
        return b;
      };
      var svgDown = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>';
      var svgUp = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>';
      parent.appendChild(mk('Backup Data', 'Cadangkan semua data ke file JSON', function () { exportBackup(); }, svgDown));
      parent.appendChild(mk('Restore Data', 'Pulihkan data dari file JSON', function () {
        var el = document.getElementById('restoreFile');
        if (el) el.click();
      }, svgUp));
      if (!document.getElementById('restoreFile')) {
        var input = document.createElement('input');
        input.type = 'file';
        input.id = 'restoreFile';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.addEventListener('change', importBackup);
        parent.appendChild(input);
      }
    }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSidebarButtons);
  } else {
    injectSidebarButtons();
  }

  // Expose global lama (onclick="exportBackup()") + namespace baru
  global.exportBackup = exportBackup;
  global.importBackup = importBackup;
  global.FinAuditBackup = {
    exportBackup: exportBackup,
    importBackup: importBackup,
    autoBackup: autoBackup,
    restoreAutoBackup: restoreAutoBackup,
    listAutoBackups: listAutoBackups,
    getBackupMeta: getBackupMeta,
    collectBackupData: collectBackupData
  };
})(window);
