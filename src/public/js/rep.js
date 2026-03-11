/* =================================================================
   Field Rep — Full PRD Map-Centric Mobile Controller
   ================================================================= */

let map;
let currentAssignment = null;
let stops = [];
let trackingOn = false;
let trackingTimer = null;
let lastPosition = null;
const GOOGLE_MAPS_MAX_POINTS = 10;
let routeMotionFrame = null;
let demoDatasetHydration = null;
let gpsPingIntervalMs = 30000;
let segments = [];
let currentSegmentIdx = 0;

async function ensureDemoDatasetLoaded() {
  if (!DEMO.active) return null;
  if ((DEMO.STORE.pharmacies || []).length > 100) return DEMO.STORE;

  if (!demoDatasetHydration) {
    demoDatasetHydration = fetch('/data/ecatepec-demo.json', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((dataset) => {
        if (!dataset?.pharmacies?.length) return null;
        DEMO.STORE.pharmacies = dataset.pharmacies;
        DEMO.STORE.assignments = dataset.assignments || [];
        DEMO.STORE.reps = dataset.reps || [];
        DEMO.STORE.reviewItems = dataset.reviewItems || [];
        DEMO.STORE.visits = dataset.visits || [];
        DEMO.STORE.commercialLeads = dataset.commercialLeads || [];
        DEMO.STORE.auditEvents = dataset.auditEvents || [];
        DEMO.STORE.breadcrumbsByRep = dataset.breadcrumbsByRep || {};
        return DEMO.STORE;
      })
      .catch(() => null);
  }

  return demoDatasetHydration;
}

document.addEventListener('DOMContentLoaded', async () => {
  const isDemo = localStorage.getItem('marzam_demo') === '1';
  let user = API.user();
  if (isDemo && (!user || user.role !== 'field_rep')) {
    const fallbackUser = {
      id: 'rep1',
      email: 'carlos@marzam.mx',
      full_name: 'Carlos Lopez',
      role: 'field_rep',
    };
    localStorage.setItem('user', JSON.stringify(fallbackUser));
    user = fallbackUser;
  }
  if (!isDemo && (!API.isAuth() || user?.role !== 'field_rep')) { location.href = '/'; return; }

  if (isDemo) await DEMO.ready;
  if (isDemo) await ensureDemoDatasetLoaded();
  if (!isDemo) await loadRuntimeConfig();

  const impersonating = user?.impersonated_by || localStorage.getItem('marzam_impersonating');
  document.getElementById('rep-name').textContent = (user?.full_name || 'Representante Demo') + (isDemo ? ' (Demo)' : '');
  document.getElementById('btn-logout').onclick = isDemo
    ? () => { localStorage.clear(); location.href = '/'; }
    : API.logout;

  if (impersonating) {
    const banner = document.getElementById('demo-banner');
    banner.textContent = `Viendo como ${user?.full_name || 'Representante'} — Haz clic para volver al Gerente`;
    banner.classList.remove('hidden');
    banner.style.cursor = 'pointer';
    banner.onclick = async () => {
      try {
        const result = await API.post('/auth/impersonate/stop', {});
        localStorage.setItem('token', result.token);
        localStorage.setItem('user', JSON.stringify(result.user));
        localStorage.removeItem('marzam_impersonating');
      } catch { localStorage.removeItem('marzam_impersonating'); }
      location.href = '/manager.html';
    };
    const header = document.getElementById('header-bar');
    if (header) header.style.top = '28px';
  }

  if (isDemo) {
    DEMO.patchAPI();
    const banner = document.getElementById('demo-banner');
    if (!impersonating && banner) banner.classList.remove('hidden');
    const header = document.getElementById('header-bar');
    if (header) header.style.top = '28px';
  }

  initMap();
  loadAssignments();
  setupSheetDrag();

  document.getElementById('sel-assignment').addEventListener('change', onAssignmentChange);
  document.getElementById('btn-tracking').addEventListener('click', toggleTracking);
  document.getElementById('v-outcome').addEventListener('change', onOutcomeChange);
  document.getElementById('visit-form').addEventListener('submit', submitVisit);
  document.getElementById('new-pharmacy-form').addEventListener('submit', submitNewPharmacy);
  document.getElementById('skip-form').addEventListener('submit', submitSkip);
});

async function loadRuntimeConfig() {
  try {
    const health = await fetch('/api/health', { cache: 'no-store' }).then((response) => response.json());
    const seconds = Number(health?.gps_ping_interval_seconds || 30);
    gpsPingIntervalMs = Math.max(15, seconds) * 1000;
  } catch {}
}

function initMap() {
  map = new maplibregl.Map({ container: 'map', style: MAP_STYLE, center: CDMX_CENTER, zoom: 13 });

  map.on('load', () => {
    map.addSource('route-line', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'route-line', type: 'line', source: 'route-line', paint: { 'line-color': '#1b365d', 'line-width': 2, 'line-opacity': 0.25, 'line-dasharray': [2, 2] } });

    map.addSource('segment-line', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'segment-line', type: 'line', source: 'segment-line', paint: { 'line-color': '#3b82f6', 'line-width': 4, 'line-opacity': 0.8 } });

    map.addSource('stops', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'stop-dots', type: 'circle', source: 'stops', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 7, 16, 12],
      'circle-color': ['match', ['get', 'status'], 'completed', '#10b981', 'skipped', '#e11d48', '#1b365d'],
      'circle-stroke-width': ['case', ['coalesce', ['get', 'inSegment'], true], 3, 1.5],
      'circle-stroke-color': ['case', ['coalesce', ['get', 'inSegment'], true], '#3b82f6', '#fff'],
      'circle-opacity': ['case', ['coalesce', ['get', 'inSegment'], true], 1, 0.5],
    }});
    map.addLayer({ id: 'stop-labels', type: 'symbol', source: 'stops', layout: { 'text-field': ['get', 'order'], 'text-size': 12 }, paint: { 'text-color': '#fff' } });

    map.addSource('me', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'me-ring', type: 'circle', source: 'me', paint: { 'circle-radius': 18, 'circle-color': '#dc2626', 'circle-opacity': 0.15 } });
    map.addLayer({ id: 'me-dot', type: 'circle', source: 'me', paint: { 'circle-radius': 8, 'circle-color': '#dc2626', 'circle-stroke-width': 3, 'circle-stroke-color': '#fff' } });

    map.addSource('next-link', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'next-link', type: 'line', source: 'next-link', paint: {
      'line-color': '#f97316',
      'line-width': 2.5,
      'line-opacity': 0.75,
      'line-dasharray': [1.3, 1.7],
    }});

    map.addSource('sim-rep', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'sim-rep-ring', type: 'circle', source: 'sim-rep', layout: { visibility: 'none' }, paint: {
      'circle-radius': 16,
      'circle-color': '#f97316',
      'circle-opacity': 0.16,
    }});
    map.addLayer({ id: 'sim-rep-dot', type: 'circle', source: 'sim-rep', layout: { visibility: 'none' }, paint: {
      'circle-radius': 6,
      'circle-color': '#f97316',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    }});

    map.on('click', 'stop-dots', onStopClick);
    map.on('mouseenter', 'stop-dots', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'stop-dots', () => map.getCanvas().style.cursor = '');
  });
}

function onStopClick(e) {
  const p = e.features[0].properties;
  if (p.status === 'completed' || p.status === 'skipped') return;

  map.flyTo({ center: e.lngLat, zoom: Math.max(map.getZoom(), 16), duration: 500 });

  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${e.lngLat.lat},${e.lngLat.lng}`;
  
  new maplibregl.Popup({ offset: 14, closeButton: true })
    .setLngLat(e.lngLat)
    .setHTML(`
      <div class="peek-card">
        <h4 class="font-bold text-sm mb-2">${esc(p.name)}</h4>
        <div class="flex gap-1.5">
          <button class="btn btn-sm btn-primary flex-1" onclick="checkInAndVisit('${p.id}','${p.pharmacy_id}','${esc(p.name)}')">Visitar</button>
          <button class="btn btn-sm btn-danger flex-1" onclick="openSkipSheet('${p.id}','${p.pharmacy_id}','${esc(p.name)}')">Omitir</button>
          <a href="${mapsUrl}" target="_blank" class="btn btn-sm btn-ghost border border-slate-200 flex-1">Mapa</a>
        </div>
      </div>`)
    .addTo(map);
}

function setupSheetDrag() {
  const sheet = document.getElementById('main-sheet');
  const handle = document.getElementById('sheet-handle');

  handle.addEventListener('click', () => {
    const current = sheet.dataset.snap;
    if (current === 'peek') sheet.dataset.snap = 'half';
    else if (current === 'half') sheet.dataset.snap = 'full';
    else sheet.dataset.snap = 'half';
  });

  let startY = 0;
  let startSnap = '';

  handle.addEventListener('touchstart', (e) => {
    startY = e.touches[0].clientY;
    startSnap = sheet.dataset.snap;
    sheet.style.transition = 'none';
  }, { passive: true });

  handle.addEventListener('touchend', (e) => {
    sheet.style.transition = '';
    const dy = (e.changedTouches[0]?.clientY || startY) - startY;
    if (Math.abs(dy) < 30) return;

    if (dy > 0) {
      sheet.dataset.snap = startSnap === 'full' ? 'half' : 'peek';
    } else {
      sheet.dataset.snap = startSnap === 'peek' ? 'half' : 'full';
    }
  }, { passive: true });
}

function setSheetSnap(snap) { document.getElementById('main-sheet').dataset.snap = snap; }

function toggleMainSheet() {
  const sheet = document.getElementById('main-sheet');
  const current = sheet.dataset.snap;
  sheet.dataset.snap = (current === 'half' || current === 'full') ? 'peek' : 'half';
}

/* ─── Assignments ─────────────────────────────────────────────── */
async function loadAssignments() {
  try {
    let user = API.user();
    const sel = document.getElementById('sel-assignment');
    sel.innerHTML = '<option value="">Seleccionar asignación...</option>';

    let list;
    if (DEMO.active && user) {
      await ensureDemoDatasetLoaded();
      const demoAssignments = DEMO.STORE.assignments || [];
      list = demoAssignments.filter(a => a.rep_id === user.id);
      if (!list.length) {
        const fallbackAssignment = demoAssignments.find(a => a.rep_id);
        const fallbackRep = DEMO.STORE.reps.find(rep => rep.user_id === fallbackAssignment?.rep_id) || DEMO.STORE.reps[0];
        if (fallbackRep) {
          user = {
            id: fallbackRep.user_id,
            email: fallbackRep.email,
            full_name: fallbackRep.full_name,
            role: 'field_rep',
          };
          localStorage.setItem('user', JSON.stringify(user));
          document.getElementById('rep-name').textContent = `${user.full_name} (Demo)`;
          list = demoAssignments.filter(a => a.rep_id === user.id);
        }
      }
    } else {
      list = await API.get('/assignments');
    }

    const pending = list.filter(a => a.status !== 'completed');
    const completed = list.filter(a => a.status === 'completed');

    pending.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.campaign_objective} — ${statusEs(a.status)} (${a.completed_stops || 0}/${a.total_stops || a.pharmacy_count || 0})`;
      sel.appendChild(opt);
    });

    if (completed.length) {
      const group = document.createElement('optgroup');
      group.label = 'Completadas';
      completed.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = `${a.campaign_objective} (${a.completed_stops || 0}/${a.total_stops || a.pharmacy_count || 0})`;
        group.appendChild(opt);
      });
      sel.appendChild(group);
    }

    if (pending.length === 1) {
      sel.value = pending[0].id;
      await onAssignmentChange();
    }
  } catch {}
}

async function onAssignmentChange() {
  const id = document.getElementById('sel-assignment').value;
  if (!id) { clearRoute(); return; }

  try {
    if (DEMO.active) await ensureDemoDatasetLoaded();
    currentAssignment = await API.get(`/assignments/${id}`);
    stops = currentAssignment.stops || [];
    await renderRoute();
    if (currentAssignment.status === 'assigned') {
      await API.patch(`/assignments/${id}/status`, { status: 'in_progress' }).catch(() => {});
    }
  } catch (err) { showToast(err.error || 'No se pudo cargar la asignación', 'error'); }
}

async function resolveRouteOrigin() {
  if (lastPosition && Number.isFinite(lastPosition.lng) && Number.isFinite(lastPosition.lat)) {
    return [lastPosition.lng, lastPosition.lat];
  }

  const user = API.user();
  if (DEMO.active && user) {
    await ensureDemoDatasetLoaded();
    const demoRep = DEMO.STORE.reps.find((rep) => rep.user_id === user.id);
    if (demoRep && Number.isFinite(Number(demoRep.last_lng)) && Number.isFinite(Number(demoRep.last_lat))) {
      return [Number(demoRep.last_lng), Number(demoRep.last_lat)];
    }
  }

  try {
    const positions = await API.get('/tracking/positions');
    const repPosition = positions.find((position) => position.rep_id === user?.id);
    if (repPosition) {
      const lng = Number(repPosition.lng || repPosition.last_lng || repPosition.home_lng);
      const lat = Number(repPosition.lat || repPosition.last_lat || repPosition.home_lat);
      if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
    }
  } catch {}

  const firstStop = stops[0];
  if (!firstStop) return null;
  return [Number(firstStop.lng), Number(firstStop.lat)];
}

function updateNextStopLink(currentCoord) {
  const nextStop = getPendingStops()[0];
  if (!currentCoord || !nextStop) {
    map.getSource('next-link')?.setData(emptyFC());
    return;
  }

  const nextCoord = [Number(nextStop.lng), Number(nextStop.lat)];
  if (!Number.isFinite(nextCoord[0]) || !Number.isFinite(nextCoord[1])) {
    map.getSource('next-link')?.setData(emptyFC());
    return;
  }

  map.getSource('next-link')?.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [currentCoord, nextCoord] },
    }],
  });
}

function stopRouteSimulation(clear = false) {
  if (routeMotionFrame) cancelAnimationFrame(routeMotionFrame);
  routeMotionFrame = null;
  if (clear) {
    map.getSource('sim-rep')?.setData(emptyFC());
    map.getSource('next-link')?.setData(emptyFC());
  }
}

function startRouteSimulation(routeCoords) {
  stopRouteSimulation(false);
  if (!routeCoords || routeCoords.length < 2) {
    map.getSource('sim-rep')?.setData(emptyFC());
    updateNextStopLink(null);
    return;
  }

  const startedAt = performance.now();
  const durationMs = Math.max(14000, routeCoords.length * 2600);
  const animate = (now) => {
    const rawProgress = ((now - startedAt) % durationMs) / durationMs;
    const easedProgress = rawProgress < 0.5
      ? 2 * rawProgress * rawProgress
      : 1 - ((-2 * rawProgress + 2) ** 2) / 2;
    const coordinate = samplePolylineCoordinate(routeCoords, easedProgress);

    if (coordinate) {
      map.getSource('sim-rep')?.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: coordinate } }],
      });
      updateNextStopLink(coordinate);
    }

    routeMotionFrame = requestAnimationFrame(animate);
  };

  routeMotionFrame = requestAnimationFrame(animate);
}

async function renderRoute() {
  document.getElementById('header-bar').classList.add('hidden');
  document.getElementById('route-strip').classList.remove('hidden');
  const completed = stops.filter(s => s.stop_status === 'completed').length;
  const skipped = stops.filter(s => s.stop_status === 'skipped').length;
  document.getElementById('strip-progress').textContent = `${completed + skipped}/${stops.length}`;
  document.getElementById('strip-objective').textContent = currentAssignment.campaign_objective;
  rebuildSegments();

  const originCoord = await resolveRouteOrigin();
  const seg = segments[currentSegmentIdx];
  const validStops = stops.filter(s => Number.isFinite(Number(s.lng)) && Number.isFinite(Number(s.lat)));
  const features = validStops.map(s => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(s.lng), Number(s.lat)] },
    properties: {
      id: s.id, name: s.name, order: String(s.route_order),
      status: s.stop_status, pharmacy_id: s.pharmacy_id,
      inSegment: seg ? seg.stopIds.has(s.id) : true,
    },
  }));
  map.getSource('stops')?.setData({ type: 'FeatureCollection', features });

  const routeCoords = validStops.map(s => [Number(s.lng), Number(s.lat)]);
  const visualRoute = originCoord ? [originCoord, ...routeCoords] : routeCoords;

  if (visualRoute.length > 1) {
    map.getSource('route-line')?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: visualRoute } }] });
  } else {
    map.getSource('route-line')?.setData(emptyFC());
    stopRouteSimulation(true);
  }

  if (seg && seg.coords.length) {
    map.fitBounds(boundsFromCoords(seg.coords), { padding: { top: 80, bottom: 200, left: 40, right: 40 }, maxZoom: 16, duration: 800 });
  } else if (visualRoute.length) {
    map.fitBounds(boundsFromCoords(visualRoute), { padding: { top: 80, bottom: 200, left: 40, right: 40 }, maxZoom: 15, duration: 800 });
  }

  renderStopList();
  setSheetSnap('half');
}

function isResolvedStop(stop) {
  return stop?.stop_status === 'completed' || stop?.stop_status === 'skipped';
}

function getPendingStops() {
  return stops.filter((s) => !isResolvedStop(s));
}

function toPoint(stop) {
  const lat = Number(stop?.lat);
  const lng = Number(stop?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildGoogleMapsDirectionsUrl(points) {
  if (!points?.length) return null;
  if (points.length === 1) {
    return `https://www.google.com/maps/search/?api=1&query=${points[0].lat},${points[0].lng}`;
  }

  const origin = `${points[0].lat},${points[0].lng}`;
  const destination = `${points[points.length - 1].lat},${points[points.length - 1].lng}`;
  const waypoints = points.slice(1, -1).map((p) => `${p.lat},${p.lng}`).join('|');

  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
  if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}&dir_action=navigate`;
  return url;
}

/* ─── Segment Navigation ──────────────────────────────────────── */

function buildSegments() {
  const validStops = stops.filter(s =>
    Number.isFinite(Number(s.lng)) && Number.isFinite(Number(s.lat))
  );
  if (!validStops.length) return [];

  const max = GOOGLE_MAPS_MAX_POINTS;
  const result = [];
  for (let i = 0; i < validStops.length; i += max) {
    const segStops = validStops.slice(i, i + max);
    const pending = segStops.filter(s => !isResolvedStop(s));
    const pts = pending.map(toPoint).filter(Boolean);
    const url = pts.length ? buildGoogleMapsDirectionsUrl(pts) : null;
    const coords = segStops.map(s => [Number(s.lng), Number(s.lat)]);

    result.push({
      index: result.length,
      stops: segStops,
      stopIds: new Set(segStops.map(s => s.id)),
      startOrder: segStops[0]?.route_order || (i + 1),
      endOrder: segStops[segStops.length - 1]?.route_order || (i + segStops.length),
      pendingCount: pending.length,
      url,
      coords,
    });
  }
  return result;
}

function segmentStorageKey() {
  return currentAssignment ? `marzam_seg_${currentAssignment.id}` : null;
}

function saveSegmentState() {
  const key = segmentStorageKey();
  if (key) localStorage.setItem(key, String(currentSegmentIdx));
}

function loadSegmentState() {
  const key = segmentStorageKey();
  if (!key) return 0;
  const saved = parseInt(localStorage.getItem(key), 10);
  return Number.isFinite(saved) ? saved : 0;
}

function rebuildSegments() {
  segments = buildSegments();
  if (!segments.length) {
    currentSegmentIdx = 0;
    renderSegmentControls();
    updateSegmentMapHighlight();
    return;
  }

  let idx = loadSegmentState();
  if (idx >= segments.length) idx = 0;

  if (segments[idx] && segments[idx].pendingCount === 0) {
    const better = segments.findIndex(s => s.pendingCount > 0);
    if (better >= 0) idx = better;
  }

  currentSegmentIdx = idx;
  saveSegmentState();
  renderSegmentControls();
  updateSegmentMapHighlight();
}

function renderSegmentControls() {
  const nav = document.getElementById('segment-nav');
  if (!nav) return;

  if (!segments.length) { nav.classList.add('hidden'); return; }
  nav.classList.remove('hidden');

  const seg = segments[currentSegmentIdx];
  const label = document.getElementById('seg-label');
  const detail = document.getElementById('seg-detail');
  const prevBtn = document.getElementById('btn-seg-prev');
  const nextBtn = document.getElementById('btn-seg-next');
  const gmapsBtn = document.getElementById('btn-seg-gmaps');

  if (label) label.textContent = segments.length > 1
    ? `Tramo ${currentSegmentIdx + 1} de ${segments.length}`
    : 'Ruta completa';
  if (detail && seg) {
    detail.textContent = `Paradas ${seg.startOrder}\u2013${seg.endOrder} \u00b7 ${seg.pendingCount} pendiente${seg.pendingCount !== 1 ? 's' : ''}`;
  }
  if (prevBtn) prevBtn.disabled = currentSegmentIdx <= 0;
  if (nextBtn) nextBtn.disabled = currentSegmentIdx >= segments.length - 1;
  if (gmapsBtn) {
    gmapsBtn.disabled = !seg?.url;
    gmapsBtn.textContent = seg?.url ? 'Abrir Tramo' : 'Sin pendientes';
  }
}

function updateSegmentMapHighlight() {
  const seg = segments[currentSegmentIdx];
  if (!seg || seg.coords.length < 2) {
    map.getSource('segment-line')?.setData(emptyFC());
    return;
  }
  map.getSource('segment-line')?.setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: seg.coords } }],
  });
}

function focusCurrentSegment() {
  const seg = segments[currentSegmentIdx];
  if (!seg || !seg.coords.length) return;
  map.fitBounds(boundsFromCoords(seg.coords), { padding: { top: 80, bottom: 200, left: 40, right: 40 }, maxZoom: 16, duration: 600 });
}

function updateStopSegmentHighlight() {
  const seg = segments[currentSegmentIdx];
  if (!seg) return;
  const validStops = stops.filter(s => Number.isFinite(Number(s.lng)) && Number.isFinite(Number(s.lat)));
  const features = validStops.map(s => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(s.lng), Number(s.lat)] },
    properties: {
      id: s.id, name: s.name, order: String(s.route_order),
      status: s.stop_status, pharmacy_id: s.pharmacy_id,
      inSegment: seg.stopIds.has(s.id),
    },
  }));
  map.getSource('stops')?.setData({ type: 'FeatureCollection', features });

  document.querySelectorAll('.stop-card[data-stop-id]').forEach(card => {
    const inSeg = seg.stopIds.has(card.dataset.stopId);
    card.classList.toggle('in-segment', inSeg);
    card.classList.toggle('not-in-segment', !inSeg);
  });
}

function goToSegment(idx) {
  if (idx < 0 || idx >= segments.length) return;
  currentSegmentIdx = idx;
  saveSegmentState();
  renderSegmentControls();
  updateSegmentMapHighlight();
  updateStopSegmentHighlight();
  focusCurrentSegment();
}

function prevSegment() { goToSegment(currentSegmentIdx - 1); }
function nextSegment() { goToSegment(currentSegmentIdx + 1); }

function openSegmentInGMaps() {
  const seg = segments[currentSegmentIdx];
  if (!seg?.url) {
    showToast('No hay paradas pendientes en este tramo', 'info');
    return;
  }
  window.open(seg.url, '_blank', 'noopener,noreferrer');
  if (segments.length > 1) {
    showToast(`Tramo ${currentSegmentIdx + 1} de ${segments.length} abierto en Google Maps`, 'success');
  } else {
    showToast(`Ruta abierta con ${seg.pendingCount} parada(s)`, 'success');
  }
}

function renderStopList() {
  const el = document.getElementById('stop-list');
  document.getElementById('stop-empty')?.classList.add('hidden');

  const pendingCount = stops.filter(s => s.stop_status !== 'completed' && s.stop_status !== 'skipped').length;
  const doneCount = stops.filter(s => s.stop_status === 'completed').length;
  const seg = segments[currentSegmentIdx];
  const multiSeg = segments.length > 1;

  let html = `<div class="flex items-center justify-between mb-2 px-1">
    <p class="text-xs font-bold text-slate-500">${stops.length} paradas total</p>
    <div class="flex gap-2 text-[10px]">
      <span class="text-emerald-600 font-bold">${doneCount} completadas</span>
      <span class="text-slate-500 font-bold">${pendingCount} pendientes</span>
    </div>
  </div>`;

  let lastSegIdx = -1;
  stops.forEach((s) => {
    if (multiSeg) {
      const sIdx = segments.findIndex(sg => sg.stopIds.has(s.id));
      if (sIdx >= 0 && sIdx !== lastSegIdx) {
        lastSegIdx = sIdx;
        const isCurrent = sIdx === currentSegmentIdx;
        const sg = segments[sIdx];
        html += `<div class="seg-divider ${isCurrent ? 'seg-divider-active' : ''}" onclick="goToSegment(${sIdx})">
          <span>Tramo ${sIdx + 1}</span>
          <span>${sg.pendingCount} pendiente${sg.pendingCount !== 1 ? 's' : ''}</span>
        </div>`;
      }
    }

    const done = s.stop_status === 'completed';
    const skipped = s.stop_status === 'skipped';
    const inSeg = seg ? seg.stopIds.has(s.id) : true;

    html += `
    <div class="stop-card ${done ? 'completed' : ''} ${skipped ? 'completed' : ''} ${multiSeg && inSeg ? 'in-segment' : ''} ${multiSeg && !inSeg ? 'not-in-segment' : ''}" data-stop-id="${s.id}" onclick="focusStop(${s.lng},${s.lat},'${esc(s.name)}')">
      <div class="stop-num ${done ? 'bg-emerald-100 text-emerald-700' : skipped ? 'bg-rose-100 text-rose-700' : 'bg-[#1b365d]/10 text-[#1b365d]'}">${s.route_order}</div>
      <div class="flex-1 min-w-0">
        <p class="font-medium text-sm truncate">${esc(s.name)}</p>
        <p class="text-xs text-slate-400 truncate">${esc(s.address || '')}</p>
      </div>
      <div class="flex items-center gap-1 flex-shrink-0">
        ${done ? '<span class="badge badge-green" style="font-size:10px">Hecho</span>'
          : skipped ? '<span class="badge badge-red" style="font-size:10px">Omitido</span>'
          : `<button onclick="event.stopPropagation(); checkInAndVisit('${s.id}','${s.pharmacy_id}','${esc(s.name)}')" class="btn btn-sm btn-primary" style="font-size:10px;padding:4px 8px">Visitar</button>
            <button onclick="event.stopPropagation(); openSkipSheet('${s.id}','${s.pharmacy_id}','${esc(s.name)}')" class="btn btn-sm btn-ghost text-rose-500 border border-rose-200" style="font-size:9px;padding:4px 6px">Omitir</button>`
        }
      </div>
    </div>`;
  });

  el.innerHTML = html;
}

function focusStop(lng, lat, name) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
  setSheetSnap('peek');
  map.flyTo({ center: [lng, lat], zoom: 17, duration: 600 });
}

function clearRoute() {
  currentAssignment = null; stops = [];
  segments = []; currentSegmentIdx = 0;
  document.getElementById('route-strip').classList.add('hidden');
  document.getElementById('header-bar').classList.remove('hidden');
  document.getElementById('stop-list').innerHTML = '';
  document.getElementById('stop-empty')?.classList.remove('hidden');
  map.getSource('stops')?.setData(emptyFC());
  map.getSource('route-line')?.setData(emptyFC());
  map.getSource('segment-line')?.setData(emptyFC());
  stopRouteSimulation(true);
  setSheetSnap('peek');
}

/* ─── Visit Flow ──────────────────────────────────────────────── */
async function checkInAndVisit(stopId, pharmacyId, name) {
  try {
    const pos = await getPosition();
    lastPosition = pos;
    const checkinResult = await API.post('/tracking/checkin', { pharmacy_id: pharmacyId, assignment_stop_id: stopId, lat: pos.lat, lng: pos.lng });
    updateMyPosition(pos);
    if (checkinResult.distance_warning) {
      const dist = Math.round(checkinResult.distance_to_pharmacy_m || 500);
      showToast(`Advertencia: Estás a ${dist}m de la farmacia (>500m)`, 'error');
    }
  } catch {}
  document.getElementById('v-pharmacy-id').value = pharmacyId;
  document.getElementById('v-stop-id').value = stopId;
  document.getElementById('visit-pharmacy-name').textContent = name;
  document.getElementById('visit-sheet').classList.remove('hidden');
  document.getElementById('fab-new').classList.add('hidden');
}

function closeVisitSheet() {
  document.getElementById('visit-sheet').classList.add('hidden');
  document.getElementById('fab-new').classList.remove('hidden');
}

function onOutcomeChange() {
  const o = document.getElementById('v-outcome').value;
  document.getElementById('v-followup-fields').classList.toggle('hidden', o !== 'needs_follow_up');
  document.getElementById('v-flag-fields').classList.toggle('hidden',
    !['closed','invalid','duplicate','moved','wrong_category','chain_not_independent'].includes(o));
}

async function submitVisit(e) {
  e.preventDefault();
  const photoInput = document.getElementById('v-photo');
  const outcome = document.getElementById('v-outcome').value;
  const stopId = document.getElementById('v-stop-id').value;
  if (!photoInput.files[0] && !DEMO.active && !['closed','invalid','duplicate','moved','wrong_category','chain_not_independent','not_interested'].includes(outcome)) {
    showToast('La foto de evidencia es obligatoria', 'error');
    return;
  }
  const btn = document.getElementById('btn-submit-visit');
  btn.disabled = true; btn.textContent = 'Enviando...';
  const pos = lastPosition || {};

  try {
    const visit = await API.post('/visits', {
      pharmacy_id: document.getElementById('v-pharmacy-id').value,
      assignment_stop_id: stopId || undefined,
      outcome,
      notes: document.getElementById('v-notes').value,
      order_potential: Number(document.getElementById('v-potential').value) || undefined,
      competitor_products: document.getElementById('v-competitors').value || undefined,
      stock_observations: document.getElementById('v-stock').value || undefined,
      contact_person: document.getElementById('v-contact').value || undefined,
      contact_phone: document.getElementById('v-phone').value || undefined,
      follow_up_date: document.getElementById('v-followup-date')?.value || undefined,
      follow_up_reason: document.getElementById('v-followup-reason')?.value || undefined,
      flag_reason: document.getElementById('v-flag-reason')?.value || undefined,
      checkin_lat: pos.lat, checkin_lng: pos.lng,
    });

    if (photoInput.files[0] && !DEMO.active) {
      const fd = new FormData();
      fd.append('photo', photoInput.files[0]);
      await API.upload(`/visits/${visit.id}/photos`, fd);
    }

    closeVisitSheet();
    document.getElementById('visit-form').reset();
    showToast('Visita enviada', 'success');

    const flagOutcomes = ['closed','invalid','duplicate','moved','wrong_category','chain_not_independent'];
    const stop = stops.find(s => s.id === stopId);
    if (stop) stop.stop_status = flagOutcomes.includes(outcome) ? 'skipped' : 'completed';
    if (currentAssignment) renderRoute();
  } catch (err) {
    showToast(err.error || err.errors?.join(', ') || 'Error al enviar', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Enviar Visita';
  }
}

/* ─── Skip Flow ───────────────────────────────────────────────── */
function openSkipSheet(stopId, pharmacyId, name) {
  document.getElementById('skip-stop-id').value = stopId;
  document.getElementById('skip-pharmacy-id').value = pharmacyId;
  document.getElementById('skip-pharmacy-name').textContent = name;
  document.getElementById('skip-sheet').classList.remove('hidden');
  document.getElementById('fab-new').classList.add('hidden');
}
function closeSkipSheet() {
  document.getElementById('skip-sheet').classList.add('hidden');
  document.getElementById('fab-new').classList.remove('hidden');
}

async function submitSkip(e) {
  e.preventDefault();
  const stopId = document.getElementById('skip-stop-id').value;
  const reason = document.getElementById('skip-reason').value;
  const notes = document.getElementById('skip-notes').value;
  const photoInput = document.getElementById('skip-photo');

  if (!reason) { showToast('Selecciona un motivo', 'error'); return; }

  try {
    const visit = await API.post('/visits', {
      pharmacy_id: document.getElementById('skip-pharmacy-id').value,
      assignment_stop_id: stopId,
      outcome: reason === 'closed' ? 'closed' : 'invalid',
      notes: notes || `Omitido: ${reason}`,
      flag_reason: `Parada omitida - ${reason}`,
    });

    if (photoInput.files[0] && !DEMO.active) {
      const fd = new FormData();
      fd.append('photo', photoInput.files[0]);
      await API.upload(`/visits/${visit.id}/photos`, fd);
    }

    const stop = stops.find(s => s.id === stopId);
    if (stop) stop.stop_status = 'skipped';
    
    closeSkipSheet();
    document.getElementById('skip-form').reset();
    showToast('Parada omitida', 'success');
    if (currentAssignment) renderRoute();
  } catch (err) {
    showToast(err.error || 'Error al omitir', 'error');
  }
}

/* ─── New Pharmacy ────────────────────────────────────────────── */
function openNewSheet() {
  document.getElementById('new-pharmacy-sheet').classList.remove('hidden');
  document.getElementById('fab-new').classList.add('hidden');
}
function closeNewSheet() {
  document.getElementById('new-pharmacy-sheet').classList.add('hidden');
  document.getElementById('fab-new').classList.remove('hidden');
}

async function submitNewPharmacy(e) {
  e.preventDefault();
  try {
    const pos = await getPosition();
    await API.post('/pharmacies', {
      name: document.getElementById('np-name').value,
      lat: pos.lat, lng: pos.lng,
      address: document.getElementById('np-address').value || undefined,
      contact_person: document.getElementById('np-contact').value || undefined,
      contact_phone: document.getElementById('np-phone').value || undefined,
      is_independent: document.getElementById('np-independent').value === 'true',
      notes: document.getElementById('np-notes').value || undefined,
    });
    closeNewSheet();
    document.getElementById('new-pharmacy-form').reset();
    showToast('Enviado para revisión', 'success');
  } catch (err) { showToast(err.error || 'Error', 'error'); }
}

/* ─── GPS Tracking ────────────────────────────────────────────── */
function toggleTracking() {
  const btn = document.getElementById('btn-tracking');
  if (trackingOn) {
    clearInterval(trackingTimer); trackingOn = false;
    btn.textContent = 'GPS Apagado'; btn.style.background = 'rgba(255 255 255 / .15)';
  } else {
    trackingOn = true;
    btn.textContent = 'GPS Activo'; btn.style.background = '#059669';
    sendPing();
    trackingTimer = setInterval(sendPing, gpsPingIntervalMs);
  }
}

async function sendPing() {
  try {
    const pos = await getPosition();
    lastPosition = pos;
    await API.post('/tracking/ping', { lat: pos.lat, lng: pos.lng, accuracy_meters: pos.accuracy, assignment_id: currentAssignment?.id || undefined });
    updateMyPosition(pos);
  } catch {}
}

function updateMyPosition(pos) {
  map.getSource('me')?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] } }] });
}

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Geolocalización no compatible')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 },
    );
  });
}
