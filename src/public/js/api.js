/**
 * Shared API client + lightweight client state store.
 */
const API = (() => {
  const BASE = '/api';

  function token() { return localStorage.getItem('token'); }

  function headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    const t = token();
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  }

  async function request(method, path, body) {
    const opts = { method, headers: headers() };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE}${path}`, opts);
    if (res.status === 401) { localStorage.clear(); location.href = '/'; return; }
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw { status: res.status, ...(typeof data === 'object' ? data : { error: data }) };
    return data;
  }

  async function upload(path, formData) {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}` },
      body: formData,
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw { status: res.status, ...err }; }
    return res.json();
  }

  async function download(path, filename) {
    const res = await fetch(`${BASE}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token()}` },
    });
    if (res.status === 401) { localStorage.clear(); location.href = '/'; return; }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw { status: res.status, ...errBody };
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return {
    get:    (p)    => request('GET', p),
    post:   (p, b) => request('POST', p, b),
    patch:  (p, b) => request('PATCH', p, b),
    delete: (p)    => request('DELETE', p),
    upload,
    download,
    login: async (email, password) => {
      const data = await request('POST', '/auth/login', { email, password });
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      return data.user;
    },
    logout: () => { localStorage.clear(); location.href = '/'; },
    user:   () => { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } },
    isAuth: () => !!token(),
  };
})();

/* ─── Utilities shared across pages ─────────────────────────────── */
function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
function num(n) { return Number(n || 0).toLocaleString(); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
function haversineKm(lat1, lng1, lat2, lng2) {
  const radiusKm = 6371;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function samplePolylineCoordinate(coords, progress) {
  if (!Array.isArray(coords) || !coords.length) return null;
  if (coords.length === 1) return coords[0];

  const segments = [];
  let totalDistance = 0;
  for (let index = 1; index < coords.length; index += 1) {
    const start = coords[index - 1];
    const end = coords[index];
    const distance = haversineKm(start[1], start[0], end[1], end[0]);
    segments.push({ start, end, distance });
    totalDistance += distance;
  }

  if (totalDistance === 0) return coords[coords.length - 1];

  let remaining = Math.min(Math.max(progress, 0), 1) * totalDistance;
  for (const segment of segments) {
    if (remaining <= segment.distance) {
      const localProgress = segment.distance === 0 ? 0 : remaining / segment.distance;
      return [
        Number((segment.start[0] + (segment.end[0] - segment.start[0]) * localProgress).toFixed(6)),
        Number((segment.start[1] + (segment.end[1] - segment.start[1]) * localProgress).toFixed(6)),
      ];
    }
    remaining -= segment.distance;
  }

  return coords[coords.length - 1];
}
function boundsFromCoords(coords) {
  const bounds = new maplibregl.LngLatBounds();
  coords.forEach((coord) => bounds.extend(coord));
  return bounds;
}

const STATUS_ES = {
  active: 'Activa', assigned: 'Asignada', in_progress: 'En progreso',
  completed: 'Completada', reassigned: 'Reasignada', cancelled: 'Cancelada',
  pending: 'Pendiente', pending_review: 'En revisión', closed: 'Cerrada',
  invalid: 'Inválida', duplicate: 'Duplicada', moved: 'Se mudó',
  wrong_category: 'Categoría incorrecta', chain_not_independent: 'Cadena',
  interested: 'Interesado', visited: 'Visitado', needs_follow_up: 'Seguimiento',
  follow_up_required: 'Seguimiento requerido', requires_follow_up: 'Requiere seguimiento',
  verified: 'Verificado', rejected: 'Rechazado',
  contact_made: 'Contacto realizado', contact_captured: 'Contacto capturado',
  not_interested: 'No interesado',
  unassigned: 'Sin asignar', skipped: 'Omitida',
  converted: 'Convertido', lost: 'Perdido',
  candidate: 'Candidato', new_pharmacy: 'Nueva farmacia',
  low: 'Baja', normal: 'Normal', high: 'Alta', urgent: 'Urgente',
  manager: 'Gerente', field_rep: 'Representante',
};
function statusEs(s) { return STATUS_ES[s] || s || ''; }

function badgeColor(s) {
  const m = {
    active:'badge-blue',
    assigned:'badge-blue',
    in_progress:'badge-yellow',
    completed:'badge-green',
    reassigned:'badge-yellow',
    cancelled:'badge-red',
    pending:'badge-gray',
    pending_review:'badge-yellow',
    closed:'badge-red',
    invalid:'badge-red',
    duplicate:'badge-red',
    moved:'badge-red',
    wrong_category:'badge-red',
    chain_not_independent:'badge-red',
    interested:'badge-green',
    visited:'badge-green',
    needs_follow_up:'badge-yellow',
    follow_up_required:'badge-yellow',
    verified:'badge-green',
    rejected:'badge-red',
    contact_made:'badge-blue',
    not_interested:'badge-gray',
    unassigned:'badge-gray',
  };
  return m[s] || 'badge-gray';
}

function showToast(msg, type = 'info') {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.background = type === 'success' ? '#059669' : type === 'error' ? '#dc2626' : '#1e293b';
  toast.style.color = '#fff';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const CDMX_CENTER = [-99.133, 19.432];
