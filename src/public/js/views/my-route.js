/* =============================================================
   My Route — rep view of today's planned visits with dynamic ETA,
   sticky next-stop card, deep-link to navigation app, and live
   "you are here" position tracking.
   Replaces the legacy renderMyRoutes for representante role; keeps
   the original implementation as a fallback for managers viewing
   "Mis rutas" in team mode.
   ============================================================= */
(function () {
  'use strict';

  const APP = window.MarzamApp.state;
  const ROLES = window.MarzamApp.ROLES;
  const SRC_ROUTE = 'my-route-line';
  const SRC_STOPS = 'my-route-stops';
  const SRC_ME = 'my-route-me';

  function clearLayers() {
    const map = APP.map; if (!map) return;
    [SRC_ROUTE, SRC_STOPS, SRC_ME].forEach((id) => {
      ['line','circle','symbol'].forEach((kind) => {
        const layerId = `${id}-${kind}`;
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      });
      if (map.getSource(id)) map.removeSource(id);
    });
  }

  function decodePolyline(str, precision = 5) {
    if (!str) return [];
    const factor = 10 ** precision;
    let index = 0, lat = 0, lng = 0; const coords = [];
    while (index < str.length) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      coords.push([lng / factor, lat / factor]);
    }
    return coords;
  }

  function todayIso() { return new Date().toISOString().slice(0, 10); }
  function fmtMin(min) { if (!min || isNaN(min)) return '—'; const h = Math.floor(min/60); const m = min%60; return h ? `${h}h ${m}m` : `${m}m`; }
  function timeOf(iso) { if (!iso) return '—'; const d = new Date(iso); return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }); }

  function statusOf(a) {
    if (a.status === 'done') return { label: 'Completada', cls: 'mz-chip-done' };
    if (a.status === 'skipped') return { label: 'Omitida', cls: 'mz-chip-skipped' };
    return { label: 'Pendiente', cls: 'mz-chip-planned' };
  }

  function drawRoute(map, assignments, mePos) {
    clearLayers();
    if (!map) return;
    const lineFeats = [];
    const stopFeats = [];
    for (let i = 0; i < assignments.length; i += 1) {
      const a = assignments[i];
      if (a.lat != null && a.lng != null) {
        stopFeats.push({
          type: 'Feature',
          properties: { route_order: a.route_order, name: a.farmacia_nombre || '', status: a.status || 'planned' },
          geometry: { type: 'Point', coordinates: [Number(a.lng), Number(a.lat)] },
        });
      }
      const next = assignments[i + 1];
      if (a.polyline_to_next && next?.lat != null) {
        lineFeats.push({
          type: 'Feature',
          properties: { i },
          geometry: { type: 'LineString', coordinates: decodePolyline(a.polyline_to_next) },
        });
      } else if (next?.lat != null && a.lat != null) {
        // Fallback to a straight line.
        lineFeats.push({
          type: 'Feature',
          properties: { i, dashed: 1 },
          geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], [next.lng, next.lat]] },
        });
      }
    }
    if (lineFeats.length) {
      map.addSource(SRC_ROUTE, { type: 'geojson', data: { type: 'FeatureCollection', features: lineFeats } });
      map.addLayer({
        id: `${SRC_ROUTE}-line`, type: 'line', source: SRC_ROUTE,
        paint: { 'line-color': '#e5730a', 'line-width': 4, 'line-opacity': 0.9 },
      });
    }
    if (stopFeats.length) {
      map.addSource(SRC_STOPS, { type: 'geojson', data: { type: 'FeatureCollection', features: stopFeats } });
      map.addLayer({
        id: `${SRC_STOPS}-circle`, type: 'circle', source: SRC_STOPS,
        paint: {
          'circle-radius': 8,
          'circle-color': [
            'match', ['get', 'status'],
            'done', '#10b981', 'skipped', '#ef4444',
            '#0ea5e9',
          ],
          'circle-stroke-width': 3, 'circle-stroke-color': '#fff',
        },
      });
      map.addLayer({
        id: `${SRC_STOPS}-symbol`, type: 'symbol', source: SRC_STOPS,
        layout: {
          'text-field': ['to-string', ['get', 'route_order']],
          'text-size': 11, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
        },
        paint: { 'text-color': '#fff' },
      });
      const bounds = new maplibregl.LngLatBounds();
      stopFeats.forEach((f) => bounds.extend(f.geometry.coordinates));
      if (mePos) bounds.extend([mePos.lng, mePos.lat]);
      map.fitBounds(bounds, { padding: 80, duration: 600, maxZoom: 14 });
    }
    if (mePos) {
      map.addSource(SRC_ME, { type: 'geojson', data: {
        type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [mePos.lng, mePos.lat] } }],
      } });
      map.addLayer({
        id: `${SRC_ME}-circle`, type: 'circle', source: SRC_ME,
        paint: {
          'circle-radius': 10, 'circle-color': '#0ea5e9',
          'circle-stroke-width': 4, 'circle-stroke-color': '#fff',
        },
      });
    }
  }

  function deepLinkMaps(stop) {
    if (stop.lat == null || stop.lng == null) return null;
    const q = encodeURIComponent(stop.farmacia_nombre || `${stop.lat},${stop.lng}`);
    return `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}&destination_place_id=&travelmode=driving&query=${q}`;
  }

  let _watchId = null;
  let _etaTimer = null;

  async function renderMyRouteRich(body) {
    if (_watchId) { try { navigator.geolocation.clearWatch(_watchId); } catch { /* noop */ } _watchId = null; }
    if (_etaTimer) { clearInterval(_etaTimer); _etaTimer = null; }
    clearLayers();

    body.innerHTML = `
      <div x-data="myRoute()" x-init="init()" class="space-y-3">
        <!-- Sticky next-stop card -->
        <template x-if="next">
          <div class="mz-next-stop-card">
            <div class="flex items-start gap-3">
              <div class="flex-1 min-w-0">
                <div class="text-[10px] font-bold uppercase tracking-widest text-orange-600">Siguiente parada · <span x-text="(nextIdx + 1) + ' de ' + total"></span></div>
                <div class="text-base font-black text-slate-800 truncate mt-0.5" x-text="next.farmacia_nombre || 'Sin nombre'"></div>
                <div class="text-[11px] text-slate-500 truncate" x-text="next.delegacion_municipio || ''"></div>
                <div class="mt-2 flex items-center gap-3 text-xs">
                  <span class="font-bold text-slate-700" x-text="'ETA ' + etaLabel"></span>
                  <span class="text-slate-400">·</span>
                  <span class="text-slate-600" x-text="etaMinutes + ' min'"></span>
                  <span class="text-slate-400">·</span>
                  <span class="mz-chip" :class="etaOnTime ? 'mz-chip-ontime' : 'mz-chip-late'" x-text="etaOnTime ? 'a tiempo' : 'tarde'"></span>
                </div>
              </div>
              <div class="flex flex-col gap-1.5">
                <a :href="navUrl" target="_blank" rel="noopener" class="bg-blue-600 text-white text-[10px] font-bold uppercase px-3 py-1.5 rounded-lg shadow text-center">Abrir</a>
                <button @click="startStop()" class="bg-emerald-600 text-white text-[10px] font-bold uppercase px-3 py-1.5 rounded-lg shadow">Iniciar</button>
              </div>
            </div>
            <!-- Progress bar -->
            <div class="mt-3 h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div class="h-full bg-gradient-to-r from-orange-400 to-orange-600" :style="'width:' + Math.round(progressPct) + '%'"></div>
            </div>
          </div>
        </template>

        <template x-if="!loading && stops.length === 0">
          <div class="text-center py-8 text-xs text-slate-400">No tienes visitas planificadas para hoy.</div>
        </template>

        <!-- Full list -->
        <div class="space-y-1.5">
          <template x-for="(s, i) in stops" :key="s.id">
            <div class="bg-white rounded-xl border px-3 py-2 flex items-center gap-3"
                 :class="i === nextIdx ? 'border-orange-300 ring-1 ring-orange-200' : 'border-slate-100'">
              <span class="mz-avatar flex-shrink-0 text-[11px]"
                    :style="'background:' + colorFor(s)" x-text="s.route_order || (i+1)"></span>
              <div class="flex-1 min-w-0">
                <div class="text-sm font-bold text-slate-800 truncate" x-text="s.farmacia_nombre || 'Sin nombre'"></div>
                <div class="text-[11px] text-slate-500 truncate" x-text="s.delegacion_municipio || ''"></div>
              </div>
              <div class="text-right text-[11px]">
                <div class="font-semibold text-slate-700" x-text="timeOf(s.expected_arrival_time)"></div>
                <span class="mz-chip" :class="statusClass(s)" x-text="statusLabel(s)"></span>
              </div>
            </div>
          </template>
        </div>

        <!-- Footer summary -->
        <template x-if="stops.length > 0">
          <div class="bg-slate-100 rounded-xl p-3 text-center text-xs">
            <span x-text="'Hoy: ' + done + '/' + total + ' visitas'"></span>
            <span class="text-slate-400 mx-2">·</span>
            <span x-text="'Tiempo estimado total: ' + fmtMin(totalMinutes)"></span>
          </div>
        </template>
      </div>
    `;
  }

  function myRouteComponent() {
    return {
      stops: [],
      loading: true,
      nextIdx: 0,
      mePos: null,
      etaSeconds: 0,
      etaOnTime: true,
      etaLabel: '—',

      get next() { return this.stops[this.nextIdx]; },
      get total() { return this.stops.length; },
      get done() { return this.stops.filter((s) => s.status === 'done').length; },
      get progressPct() { return this.total ? (this.done / this.total) * 100 : 0; },
      get totalMinutes() {
        return this.stops.reduce((s, a) => s + (a.expected_travel_minutes || 0) + (a.expected_service_minutes || 0), 0);
      },
      get etaMinutes() { return Math.round(this.etaSeconds / 60); },
      get navUrl() { return this.next ? deepLinkMaps(this.next) : '#'; },

      async init() {
        try {
          const today = todayIso();
          const data = await API.get(`/visit-plans/assignments?from=${today}&to=${today}`);
          this.stops = (data || []).map((s) => ({
            ...s, lat: s.lat != null ? Number(s.lat) : null, lng: s.lng != null ? Number(s.lng) : null,
          })).sort((a, b) => (a.route_order || 0) - (b.route_order || 0));
          this.nextIdx = Math.max(0, this.stops.findIndex((s) => s.status !== 'done' && s.status !== 'skipped'));
          if (this.nextIdx < 0) this.nextIdx = 0;
          this._refreshMap();
          this._watchPosition();
          this._scheduleEtaRefresh();
        } catch (err) {
          console.error('[my-route] init failed', err);
        } finally {
          this.loading = false;
        }
      },
      _refreshMap() { drawRoute(APP.map, this.stops, this.mePos); },
      _watchPosition() {
        if (!navigator.geolocation) return;
        _watchId = navigator.geolocation.watchPosition((pos) => {
          this.mePos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          this._refreshMap();
          this._refreshEta();
        }, () => { /* ignore */ }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 8000 });
      },
      _scheduleEtaRefresh() {
        _etaTimer = setInterval(() => this._refreshEta(), 60_000);
      },
      async _refreshEta() {
        const target = this.next;
        if (!target || !this.mePos) return;
        try {
          const params = new URLSearchParams({
            from: `${this.mePos.lat},${this.mePos.lng}`,
            to_assignment: target.id,
          });
          const r = await API.get(`/live/eta-quick?${params}`);
          this.etaSeconds = r?.duration_seconds || 0;
          // On-time if predicted arrival <= expected_arrival_time.
          if (target.expected_arrival_time) {
            const predicted = new Date(Date.now() + this.etaSeconds * 1000);
            this.etaOnTime = predicted <= new Date(target.expected_arrival_time);
            this.etaLabel = predicted.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
          } else {
            this.etaOnTime = true;
            this.etaLabel = '—';
          }
        } catch { /* keep prior values */ }
      },
      async startStop() {
        const a = this.next; if (!a) return;
        try {
          await API.post(`/visit-plans/assignments/${a.id}/start`, {});
          window.MarzamToast?.show('Visita iniciada', 'success');
        } catch (err) {
          window.MarzamToast?.show('No se pudo iniciar: ' + (err.message || err), 'danger');
        }
      },
      colorFor(s) {
        if (s.status === 'done') return '#10b981';
        if (s.status === 'skipped') return '#ef4444';
        return '#0ea5e9';
      },
      statusClass(s) { return statusOf(s).cls; },
      statusLabel(s) { return statusOf(s).label; },
      timeOf, fmtMin,
    };
  }

  document.addEventListener('alpine:init', () => {
    if (window.Alpine?.data) window.Alpine.data('myRoute', myRouteComponent);
  });
  if (window.Alpine?.data) window.Alpine.data('myRoute', myRouteComponent);

  window.MarzamViews = window.MarzamViews || {};

  // Override renderMyRoutes for representante role; keep manager flow intact.
  const _originalRenderMyRoutes = window.MarzamViews.renderMyRoutes;
  window.MarzamViews.renderMyRoutes = async function (body) {
    if (APP.role === ROLES.REPRESENTANTE && APP.mode !== 'team') {
      return renderMyRouteRich(body);
    }
    if (typeof _originalRenderMyRoutes === 'function') return _originalRenderMyRoutes(body);
  };
  // Also expose direct entry point for testing.
  window.MarzamViews.renderMyRouteRich = renderMyRouteRich;
})();
