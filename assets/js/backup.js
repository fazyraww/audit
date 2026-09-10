/* ============================================================
   FinAudit Backup & Restore
   ============================================================ */
(function (global) {
  'use strict';

  var BACKUP_KEY = 'FINAUDIT_BACKUP_META';

  /* ─── Inject sidebar buttons ─── */
  function injectSidebarButtons() {
    // Wait for sidebar to be ready
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
      if (parent.querySelector('[onclick="exportBackup()"]')) return; // already injected

      // Backup button
      var btnBackup = document.createElement('button');
      btnBackup.className = 'nav-item-btn';
      btnBackup.setAttribute('onclick', 'exportBackup()');
      btnBackup.title = 'Cadangkan semua data ke file JSON';
      btnBackup.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />' +
        '<polyline points="7 10 12 15 17 10" />' +
        '<line x1="12" y1="15" x2="12" y2="3" />' +
        '</svg> Backup Data';

      // Restore button
      var btnRestore = document.createElement('button');
      btnRestore.className = 'nav-item-btn';
      btnRestore.setAttribute('onclick', 'document.getElementById(\'restoreFile\').click()');
      btnRestore.title = 'Pulihkan data dari file JSON';
      btnRestore.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />' +
        '<polyline points="17 8 12 3 7 8" />' +
        '<line x1="12" y1="3" x2="12" y2="15" />' +
        '</svg> Restore Data';

      // Hidden file input
      var input = document.createElement('input');
      input.type = 'file';
      input.id = 'restoreFile';
      input.accept = '.json';
      input.style.display = 'none';
      input.setAttribute('onchange', 'importBackup(event)');

      parent.appendChild(btnBackup);
      parent.appendChild(btnRestore);
      parent.appendChild(input);
    }, 200);
  }

  /* ─── Wait for DOM ─── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSidebarButtons);
  } else {
    injectSidebarButtons();
  }

  function collectBackupData() {
    var data = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      app: 'FinAudit Dashboard',
      // BCA data
      bcaData: window.bcaData || { statements: [], transactions: [] },
      // Master transactions
      allMasterTransactions: window.allMasterTransactions || [],
      // Xbet data (if loaded)
      xbetData: window.XBET_DATA || null,
      // Theme
      theme: localStorage.getItem('AUDIT_THEME') || 'light',
      // Manual labels from mutasibca (if available)
      manualLabels: (window.FinAuditAuth && window.FinAuditAuth.getManualLabels) ? window.FinAuditAuth.getManualLabels() : {},
      // Safe/risk words
      customSafeWords: (window.FinAuditAuth && window.FinAuditAuth.getCustomSafeWords) ? window.FinAuditAuth.getCustomSafeWords() : [],
      customRiskWords: (window.FinAuditAuth && window.FinAuditAuth.getCustomRiskWords) ? window.FinAuditAuth.getCustomRiskWords() : []
    };
    return data;
  }

  function exportBackup() {
    try {
      var data = collectBackupData();
      var json = JSON.stringify(data, null, 2);
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      var ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      a.download = 'finaudit-backup-' + ts + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      // Save meta for auto-restore hint
      try {
        localStorage.setItem(BACKUP_KEY, JSON.stringify({
          exportedAt: data.exportedAt,
          version: data.version,
          txCount: data.allMasterTransactions ? data.allMasterTransactions.length : 0,
          stmtCount: data.bcaData ? data.bcaData.statements.length : 0
        }));
      } catch (e) { /* ignore */ }

      if (window.showToast) window.showToast('Backup berhasil: ' + (data.allMasterTransactions ? data.allMasterTransactions.length : 0) + ' transaksi', 'success');
      console.log('[FinAudit] Backup exported:', a.download);
    } catch (err) {
      if (window.showToast) window.showToast('Backup gagal: ' + err.message, 'error');
      console.error('[FinAudit] Backup error:', err);
    }
  }

  function importBackup(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = JSON.parse(e.target.result);

        // Validate structure
        if (!data.version || !data.exportedAt) {
          throw new Error('File backup tidak valid (versi/tanggal hilang).');
        }

        // Restore BCA data
        if (data.bcaData && typeof data.bcaData === 'object') {
          window.bcaData = data.bcaData;
        }

        // Restore master transactions
        if (Array.isArray(data.allMasterTransactions)) {
          window.allMasterTransactions = data.allMasterTransactions;
        }

        // Restore theme
        if (data.theme) {
          localStorage.setItem('AUDIT_THEME', data.theme);
          if (window.setTheme) window.setTheme(data.theme);
        }

        // Restore manual labels
        if (data.manualLabels && typeof data.manualLabels === 'object') {
          // Store in a way that detectRisk can access
          window._manualLabels = data.manualLabels;
        }

        // Save meta
        try {
          localStorage.setItem(BACKUP_KEY, JSON.stringify({
            restoredAt: new Date().toISOString(),
            version: data.version,
            txCount: data.allMasterTransactions ? data.allMasterTransactions.length : 0,
            stmtCount: data.bcaData ? data.bcaData.statements.length : 0
          }));
        } catch (e) { /* ignore */ }

        if (window.showToast) window.showToast('Restore berhasil: ' + (data.allMasterTransactions ? data.allMasterTransactions.length : 0) + ' transaksi', 'success');

        // Reload dashboard if on BCA tab
        if (window.switchTab) window.switchTab('bca');
        console.log('[FinAudit] Backup restored from:', file.name);
      } catch (err) {
        if (window.showToast) window.showToast('Restore gagal: ' + err.message, 'error');
        console.error('[FinAudit] Restore error:', err);
      }
    };
    reader.readAsText(file);
    // Reset input so same file can be re-imported
    event.target.value = '';
  }

  function getBackupMeta() {
    try {
      var raw = localStorage.getItem(BACKUP_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  global.FinAuditBackup = {
    exportBackup: exportBackup,
    importBackup: importBackup,
    getBackupMeta: getBackupMeta,
    collectBackupData: collectBackupData
  };
})(window);