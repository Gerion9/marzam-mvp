/**
 * Parser perezoso de pharmacies.opening_hours/closing_hours (string) → opening_hours_v2 (jsonb).
 *
 * El schema de la fuente es simple: dos strings sueltos en pharmacies (opening_hours,
 * closing_hours). Suelen ser formato "08:00" / "20:00" pero llegan ruidosos:
 *   - "9:00 AM"
 *   - "8 hrs"
 *   - "24 horas"
 *   - ""
 *   - null
 *
 * Schema canónico de salida (jsonb):
 *   {
 *     "mon": [{"open":"09:00","close":"19:00"}],
 *     ..., "sun": [],
 *     "default_assumed": true  // si caímos a fallback porque no parseamos
 *   }
 *
 * Estrategia:
 *   1. Si ambos strings parsean a HH:MM → usar como ventana mon-sat. Domingo cerrado por default.
 *   2. Si "24 horas" / "24h" detectado → 00:00-23:59 todos los días.
 *   3. Si no parsea pero el string no está vacío → 'unparseable', deja v2 con default_assumed:true.
 *   4. NULL/empty → 'unparseable', default 09:00-19:00 mon-sat.
 *
 * Plan generator usa default_assumed=true como señal de que la ventana es laxa
 * (penalty de soft-window se aplica con coef reducido para evitar ruido sintético).
 */

const HHMM_RE = /^(\d{1,2})[:.h](\d{2})?\s*(am|pm)?$/i;
const HOUR_ONLY_RE = /^(\d{1,2})\s*(am|pm)?$/i;

const DEFAULT_OPEN = '09:00';
const DEFAULT_CLOSE = '19:00';
const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAYS_NO_SUN = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parseSingleTime(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  if (s.includes('24') && (s.includes('hora') || s.includes('hrs') || s === '24h' || s === '24:00')) {
    return { allDay: true };
  }

  let m = s.match(HHMM_RE);
  if (m) {
    let h = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3];
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
    return { time: `${pad2(h)}:${pad2(mm)}` };
  }

  m = s.match(HOUR_ONLY_RE);
  if (m) {
    let h = parseInt(m[1], 10);
    const ampm = m[2];
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h < 0 || h > 23) return null;
    return { time: `${pad2(h)}:00` };
  }

  return null;
}

function defaultSchedule({ assumed }) {
  const out = {};
  for (const d of ALL_DAYS) out[d] = [];
  for (const d of WEEKDAYS_NO_SUN) {
    out[d] = [{ open: DEFAULT_OPEN, close: DEFAULT_CLOSE }];
  }
  out.default_assumed = !!assumed;
  return out;
}

function allDaySchedule() {
  const out = {};
  for (const d of ALL_DAYS) out[d] = [{ open: '00:00', close: '23:59' }];
  out.default_assumed = false;
  return out;
}

/**
 * Parse the opening/closing strings for a single pharmacy.
 * Returns:
 *   {
 *     v2:           jsonb canónico (siempre devuelto, fallback default si no parsea)
 *     parseStatus:  'parsed' | 'unparseable'
 *   }
 */
function parseOpeningHours(openingRaw, closingRaw) {
  const openParsed = parseSingleTime(openingRaw);
  const closeParsed = parseSingleTime(closingRaw);

  if (openParsed && openParsed.allDay) {
    return { v2: allDaySchedule(), parseStatus: 'parsed' };
  }

  if (openParsed && openParsed.time && closeParsed && closeParsed.time) {
    if (openParsed.time >= closeParsed.time) {
      return { v2: defaultSchedule({ assumed: true }), parseStatus: 'unparseable' };
    }
    const v2 = {};
    for (const d of ALL_DAYS) v2[d] = [];
    for (const d of WEEKDAYS_NO_SUN) {
      v2[d] = [{ open: openParsed.time, close: closeParsed.time }];
    }
    v2.default_assumed = false;
    return { v2, parseStatus: 'parsed' };
  }

  if (openParsed && openParsed.time && !closeParsed) {
    const v2 = {};
    for (const d of ALL_DAYS) v2[d] = [];
    for (const d of WEEKDAYS_NO_SUN) {
      v2[d] = [{ open: openParsed.time, close: DEFAULT_CLOSE }];
    }
    v2.default_assumed = true;
    return { v2, parseStatus: 'parsed' };
  }

  return { v2: defaultSchedule({ assumed: true }), parseStatus: 'unparseable' };
}

/**
 * Bulk processor — recibe rows {id, opening_hours, closing_hours}, devuelve
 * un array de updates {id, opening_hours_v2, opening_hours_parse_status} listos
 * para batch UPSERT. No toca DB; el cron job orquesta la persistencia.
 */
function parseBatch(rows) {
  return rows.map((r) => {
    const { v2, parseStatus } = parseOpeningHours(r.opening_hours, r.closing_hours);
    return {
      id: r.id,
      opening_hours_v2: v2,
      opening_hours_parse_status: parseStatus,
    };
  });
}

/**
 * Lookup helper para planGenerator: dada una pharmacy row con opening_hours_v2 +
 * parse_status, devuelve la ventana del día que aplica al dayIso.
 *
 * Returns null cuando la farmacia está cerrada ese día.
 */
const DOW_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function windowForDay(pharmacy, dayIso) {
  if (!pharmacy || !pharmacy.opening_hours_v2) {
    return { open: DEFAULT_OPEN, close: DEFAULT_CLOSE, defaultAssumed: true };
  }
  const dt = new Date(`${dayIso}T12:00:00Z`);
  const key = DOW_KEYS[dt.getUTCDay()];
  const slots = pharmacy.opening_hours_v2[key];
  if (!Array.isArray(slots) || slots.length === 0) {
    return null;
  }
  const first = slots[0];
  const last = slots[slots.length - 1];
  return {
    open: first.open,
    close: last.close,
    defaultAssumed: !!pharmacy.opening_hours_v2.default_assumed,
    slots,
  };
}

module.exports = {
  parseOpeningHours,
  parseBatch,
  windowForDay,
  DEFAULT_OPEN,
  DEFAULT_CLOSE,
};
