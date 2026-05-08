/**
 * Pure value parsers used by the row processors.
 *
 * Kept side-effect free and DB-free so they're trivially unit-testable
 * (see tests/imports/*). Anything Marzam-specific that needs to grow
 * (date formats, boolean idioms, alias edge cases) belongs here, not
 * inline in processors.js.
 */

const SPANISH_MONTHS = {
  ene: 1, enero: 1,
  feb: 2, febrero: 2,
  mar: 3, marzo: 3,
  abr: 4, abril: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6,
  jul: 7, julio: 7,
  ago: 8, agosto: 8,
  sep: 9, sept: 9, septiembre: 9, set: 9, setiembre: 9,
  oct: 10, octubre: 10,
  nov: 11, noviembre: 11,
  dic: 12, diciembre: 12,
};

const NOISE_HEADERS = new Set([
  'total', 'totales', 'total_mes', 'totalmes', 'gran_total',
  'suma', 'subtotal', 'sub_total',
  'promedio', 'media', 'avg', 'average',
  'observaciones', 'observacion', 'comentarios', 'notas',
]);

function asBool(value, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'si', 'sí', 'yes', 'y', 'x', 'verdadero', 'v'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'falso', 'f'].includes(s)) return false;
  return fallback;
}

function asInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = String(value).replace(/[^\d.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asNumeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // Strip currency symbols, spaces, and Mexican thousands separators (",").
  // Treat '$1,234.56' and '1.234,56' both as 1234.56.
  let s = String(value).trim();
  if (!s) return null;
  s = s.replace(/[$\s]/g, '');
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      // European: 1.234,56
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // US/MX: 1,234.56
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Could be either thousands ('1,234') or decimal ('12,34').
    // Heuristic: if exactly 3 digits after the last comma → thousands.
    const after = s.split(',').pop();
    if (after.length === 3 && !s.startsWith(',')) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(',', '.');
    }
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Legacy null markers that some Marzam Excel files use in place of empty
// cells. Treated as null so downstream UPSERTs don't store the literal
// strings.
const NULL_MARKERS = new Set(['null', 'n/a', '#n/a', 'na', '-', '--']);

function asString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;
  if (NULL_MARKERS.has(s.toLowerCase())) return null;
  return s;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function expandTwoDigitYear(yy) {
  const n = Number(yy);
  if (!Number.isFinite(n)) return null;
  // 00-79 → 2000-2079, 80-99 → 1980-1999
  if (n >= 0 && n <= 79) return 2000 + n;
  if (n >= 80 && n <= 99) return 1900 + n;
  return n; // already 4-digit
}

/**
 * Coerce a wide variety of Marzam Excel date inputs to ISO yyyy-mm-dd.
 * Returns null when no shape matches — caller decides whether that's fatal.
 *
 * Supported shapes (case-insensitive, accent-insensitive):
 *   - Date object (cellDates: true) → yyyy-mm-dd
 *   - Excel serial number (e.g. 45413) → yyyy-mm-dd
 *   - 2026-04-01, 2026/04/01, 2026-04
 *   - 01/04/2026, 1-4-2026, 04-2026
 *   - 202604, 04-2026
 *   - "Abril 2026", "ABR 26", "abr-2026", "1 de abril de 2026"
 */
function asDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = value.getUTCMonth() + 1;
    const d = value.getUTCDate();
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial: days since 1899-12-30 (with leap year bug already accounted for).
    const epoch = Date.UTC(1899, 11, 30);
    const ms = epoch + value * 86400 * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    return null;
  }
  let s = String(value).trim().toLowerCase();
  if (!s) return null;
  // Strip accents + collapse separators.
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/\s+de\s+/g, ' ');

  // 2026-04-01 / 2026/04/01 / 2026.04.01
  let m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/);
  if (m) {
    const [, y, mo, d = '01'] = m;
    return `${y}-${pad2(mo)}-${pad2(d)}`;
  }
  // 01/04/2026 / 1-4-2026 (DMY)
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const yyyy = String(y).length === 2 ? expandTwoDigitYear(y) : Number(y);
    return `${yyyy}-${pad2(mo)}-${pad2(d)}`;
  }
  // 04-2026 / 4/26
  m = s.match(/^(\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const [, mo, y] = m;
    const yyyy = String(y).length === 2 ? expandTwoDigitYear(y) : Number(y);
    return `${yyyy}-${pad2(mo)}-01`;
  }
  // 202604
  m = s.match(/^(\d{4})(\d{2})$/);
  if (m) {
    const [, y, mo] = m;
    return `${y}-${pad2(mo)}-01`;
  }
  // "abril 2026" / "abril-2026" / "abril/26" / "1 abril 2026" / "abr 2026"
  m = s.match(/^(?:(\d{1,2})\s+)?([a-z]+)[\s\-/.](\d{2,4})$/);
  if (m) {
    const [, dRaw, monthName, y] = m;
    const month = SPANISH_MONTHS[monthName] || SPANISH_MONTHS[monthName.slice(0, 3)];
    if (month) {
      const yyyy = String(y).length === 2 ? expandTwoDigitYear(y) : Number(y);
      const day = dRaw ? Number(dRaw) : 1;
      return `${yyyy}-${pad2(month)}-${pad2(day)}`;
    }
  }
  // bare month name — assume current year, day 1 (rare but seen in some files)
  m = s.match(/^([a-z]+)$/);
  if (m) {
    const month = SPANISH_MONTHS[m[1]] || SPANISH_MONTHS[m[1].slice(0, 3)];
    if (month) {
      const yyyy = new Date().getUTCFullYear();
      return `${yyyy}-${pad2(month)}-01`;
    }
  }
  return null;
}

function isNoiseHeader(normalizedHeader) {
  return NOISE_HEADERS.has(normalizedHeader);
}

module.exports = {
  asBool,
  asInt,
  asNumeric,
  asString,
  asDate,
  isNoiseHeader,
  SPANISH_MONTHS,
  NOISE_HEADERS,
};
