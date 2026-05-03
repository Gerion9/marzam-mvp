/**
 * Reads an .xlsx/.csv buffer into an array of raw row objects keyed by the
 * literal header strings from the file. Header normalization happens in
 * columnAliases.applyAliasMap — keep this layer dumb so the same parser is
 * reusable across every import kind.
 */

const XLSX = require('xlsx');

function readSheetRows(buffer, { sheetIndex = 0 } = {}) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: false });
  const sheetName = wb.SheetNames[sheetIndex] || wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(sheet, {
    raw: true,
    defval: null,
    blankrows: false,
  });
}

function rowCount(buffer, { sheetIndex = 0 } = {}) {
  return readSheetRows(buffer, { sheetIndex }).length;
}

module.exports = {
  readSheetRows,
  rowCount,
};
