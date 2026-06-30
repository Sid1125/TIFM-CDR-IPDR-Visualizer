/**
 * export-worker.js — off-main-thread CSV export
 *
 * Receives:
 *   { type: 'csv', rows: [...], headers: [...], filename: 'foo.csv' }
 *
 * Posts back:
 *   { type: 'done', blobUrl: 'blob:...', filename: 'foo.csv' }
 *   { type: 'error', message: string }
 *
 * Workers cannot access the DOM but can use Blob/URL APIs. XLSX export is handled
 * server-side (POST /export/xlsx via openpyxl) — there is no client-side xlsx path,
 * so this worker only builds CSV and vendors no JS spreadsheet library.
 */

self.onmessage = function (e) {
  const msg = e.data;
  try {
    if (msg.type === 'csv') {
      const csv = _buildCsv(msg.headers || [], msg.rows || []);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      self.postMessage({ type: 'done', blobUrl: url, filename: msg.filename || 'export.csv' });
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
