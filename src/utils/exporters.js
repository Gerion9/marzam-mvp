const XLSX = require('xlsx');

/**
 * Convert an array of flat objects to CSV string.
 */
function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    const values = headers.map((h) => {
      const v = row[h];
      if (v === null || v === undefined) return '';
      const str = String(v).replace(/"/g, '""');
      return `"${str}"`;
    });
    lines.push(values.join(','));
  }
  return lines.join('\n');
}

/**
 * Convert an array of flat objects to an XLSX buffer.
 */
function toXlsx(rows, sheetName = 'Data') {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { toCsv, toXlsx };
