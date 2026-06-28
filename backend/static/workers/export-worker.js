/**
 * export-worker.js — off-main-thread CSV / XLSX export
 *
 * Receives:
 *   { type: 'csv',  rows: [...], headers: [...], filename: 'foo.csv' }
 *   { type: 'xlsx', rows: [...], headers: [...], filename: 'foo.xlsx' }
 *
 * Posts back:
 *   { type: 'done', dataUrl: 'data:...', filename: 'foo.csv' }
 *   { type: 'error', message: string }
 *
 * For XLSX we importScripts SheetJS (already vendored at /static/vendor/xlsx.full.min.js).
 * Workers cannot access the DOM but can use importScripts and Blob/URL APIs.
 */

self.onmessage = function (e) {
  const msg = e.data;
  try {
    if (msg.type === 'csv') {
      const csv = _buildCsv(msg.headers || [], msg.rows || []);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      self.postMessage({ type: 'done', blobUrl: url, filename: msg.filename || 'export.csv' });

    } else if (msg.type === 'xlsx') {
      importScripts('/static/vendor/xlsx.full.min.js');
      /* global XLSX */
      const wb = XLSX.utils.book_new();
      const wsData = [msg.headers || [], ...(msg.rows || [])];
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      XLSX.utils.book_append_sheet(wb, ws, 'Export');
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      self.postMessage({ type: 'done', blobUrl: url, filename: msg.filename || 'export.xlsx' });

    } else {
      self.postMessage({ type: 'error', message: 'Unknown message type: ' + msg.type });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err) });
  }
};

function _buildCsv(headers, rows) {
  const escape = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) {
    lines.push((Array.isArray(row) ? row : Object.values(row)).map(escape).join(','));
  }
  return lines.join('\r\n');
}
