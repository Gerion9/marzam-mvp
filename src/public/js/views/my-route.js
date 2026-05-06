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

  function deepLinkWaze(stop) {
    if (stop.lat == null || stop.lng == null) return null;
    return `https://waze.com/ul?ll=${stop.lat},${stop.lng}&navigate=yes`;
  }

  /**
   * GPS permission UX. Prompts the user when permission is in 'prompt' state;
   * resolves true if granted, false otherwise.
   */
  async function ensureGpsPermission() {
    if (!navigator.permissions || !navigator.permissions.query) return true;
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state === 'denied') {
        window.MarzamToast?.show('GPS bloqueado. Activa la ubicación en tu navegador para registrar visitas.', 'danger');
        return false;
      }
      if (status.state === 'prompt') {
        // Wrap a one-shot getCurrentPosition to trigger the browser prompt.
        return new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(() => resolve(true), () => resolve(false), { enableHighAccuracy: true, timeout: 8000 });
        });
      }
      return true;
    } catch { return true; }
  }

  let _watchId = null;
  let _etaTimer = null;
  let _liveStream = null;
  let _liveReconnect = null;

  function closeLiveStream() {
    if (_liveStream) { try { _liveStream.close(); } catch { /* noop */ } _liveStream = null; }
    if (_liveReconnect) { clearTimeout(_liveReconnect); _liveReconnect = null; }
  }

  /**
   * Open an SSE connection to /api/live/stream (EventSource cannot set
   * Authorization headers — we pass the token via query string, which the
   * route accepts). On `plan_published` events we toast and trigger an
   * assignments reload via the supplied callback. The connection auto-reconnects
   * with a 5-second backoff if the proxy or the serverless gateway closes it
   * (Vercel SSE timeout is ~15 min).
   */
  function startLiveStream({ onPlanPublished }) {
    closeLiveStream();
    const token = localStorage.getItem('token');
    if (!token) return;
    const url = `/api/live/stream?token=${encodeURIComponent(token)}`;
    let es;
    try { es = new EventSource(url); } catch { return; }
    _liveStream = es;
    es.addEventListener('plan_published', (ev) => {
      let data = {};
      try { data = JSON.parse(ev.data || '{}'); } catch { /* keep empty */ }
      const stops = data.stops || 0;
      const day = data.first_day || data.period_start || '';
      const msg = stops
        ? `Te asignaron una nueva ruta (${stops} parada${stops === 1 ? '' : 's'}${day ? ' · ' + day : ''})`
        : 'Te asignaron una nueva ruta';
      window.MarzamToast?.show(msg, 'success');
      if (typeof onPlanPublished === 'function') onPlanPublished(data);
    });
    es.onerror = () => {
      // Schedule a single reconnect; native EventSource also retries internally,
      // but Vercel sometimes closes the upstream and the browser stays in
      // CONNECTING forever — so we explicitly reopen after a backoff.
      try { es.close(); } catch { /* noop */ }
      _liveStream = null;
      _liveReconnect = setTimeout(() => startLiveStream({ onPlanPublished }), 5000);
    };
  }

  async function renderMyRouteRich(body) {
    if (_watchId) { try { navigator.geolocation.clearWatch(_watchId); } catch { /* noop */ } _watchId = null; }
    if (_etaTimer) { clearInterval(_etaTimer); _etaTimer = null; }
    closeLiveStream();
    clearLayers();

    body.innerHTML = `
      <div x-data="myRoute()" x-init="init()" class="space-y-3">
        <!-- Persistent offline banner -->
        <template x-if="isOffline">
          <div class="bg-amber-100 border border-amber-300 text-amber-800 text-xs font-bold px-3 py-2 rounded-lg flex items-center gap-2">
            <span class="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
            Sin conexión — tus acciones se guardan y se enviarán al recuperar la red.
            <span class="text-[10px] font-normal text-amber-700 ml-auto" x-show="pendingOps > 0" x-text="'(' + pendingOps + ' pendiente' + (pendingOps === 1 ? '' : 's') + ')'"></span>
          </div>
        </template>
        <!-- Deviation modal -->
        <template x-if="deviationOpen">
          <div class="fixed inset-0 z-50 bg-slate-900/60 flex items-end sm:items-center justify-center p-4" @click.self="closeDeviation()">
            <div class="bg-white rounded-2xl w-full max-w-sm shadow-xl">
              <div class="px-4 py-3 border-b border-slate-100">
                <div class="font-bold text-slate-800 text-sm">¿Por qué desviar esta parada?</div>
                <div class="text-[11px] text-slate-500 mt-0.5" x-text="deviationStop?.farmacia_nombre || ''"></div>
              </div>
              <div class="p-4">
                <textarea x-model="deviationReason" rows="3" maxlength="280"
                  class="w-full text-sm rounded-lg border border-slate-200 p-2 focus:outline-none focus:ring-2 focus:ring-rose-300"
                  placeholder="Motivo del desvío (requerido)…"></textarea>
                <div class="flex justify-between items-center mt-2 text-[10px] text-slate-400">
                  <span x-text="deviationReason.length + '/280'"></span>
                </div>
              </div>
              <div class="px-4 pb-4 flex gap-2">
                <button @click="closeDeviation()" class="flex-1 text-xs font-bold uppercase px-3 py-2 rounded-lg bg-slate-100 text-slate-700">Cancelar</button>
                <button @click="confirmDeviation()" :disabled="!deviationReason.trim()"
                  class="flex-1 text-xs font-bold uppercase px-3 py-2 rounded-lg bg-rose-600 text-white disabled:bg-rose-300">Registrar desvío</button>
              </div>
            </div>
          </div>
        </template>
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
              <div class="text-right text-[11px] flex flex-col items-end gap-1">
                <div class="font-semibold text-slate-700" x-text="timeOf(s.expected_arrival_time)"></div>
                <span class="mz-chip" :class="statusClass(s)" x-text="statusLabel(s)"></span>
                <div class="flex items-center gap-1 mt-0.5" x-show="s.status !== 'done' && s.status !== 'deviated' && s.status !== 'skipped'">
                  <a :href="wazeUrl(s)" target="_blank" rel="noopener"
                     class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-violet-100 text-violet-700">Waze</a>
                  <button @click="deviateStop(s)"
                     class="text-[10px] font-bold uppercase px-2 py-0.5 rounded bg-rose-100 text-rose-700">Desviar</button>
                </div>
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
      isOffline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
      pendingOps: 0,
      deviationOpen: false,
      deviationStop: null,
      deviationReason: '',

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
        // Online/offline reactivity for the persistent banner + auto-drain.
        // We bind handlers via addEventListener but tag them on the component
        // so a re-init (SPA route swap) doesn't stack duplicates.
        if (!this._onlineHandler) {
          this._onlineHandler = () => {
            this.isOffline = false;
            if (window.MarzamOfflineQueue?.drain) {
              window.MarzamOfflineQueue.drain().then(() => this._refreshPendingCount());
            }
          };
          this._offlineHandler = () => { this.isOffline = true; };
          window.addEventListener('online', this._onlineHandler);
          window.addEventListener('offline', this._offlineHandler);
        }
        this._refreshPendingCount();
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
          this._startLive();
        } catch (err) {
          console.error('[my-route] init failed', err);
        } finally {
          this.loading = false;
        }
      },
      _startLive() {
        const self = this;
        startLiveStream({
          onPlanPublished: async () => {
            try {
              const today = todayIso();
              const data = await API.get(`/visit-plans/assignments?from=${today}&to=${today}`);
              self.stops = (data || []).map((s) => ({
                ...s,
                lat: s.lat != null ? Number(s.lat) : null,
                lng: s.lng != null ? Number(s.lng) : null,
              })).sort((a, b) => (a.route_order || 0) - (b.route_order || 0));
              self.nextIdx = Math.max(0, self.stops.findIndex((s) => s.status !== 'done' && s.status !== 'skipped'));
              if (self.nextIdx < 0) self.nextIdx = 0;
              self._refreshMap();
              self._refreshEta();
            } catch (err) {
              console.warn('[my-route] reload after plan_published failed', err);
            }
          },
        });
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
        // Try to ensure we have GPS — non-blocking; rep can still start without it.
        ensureGpsPermission();
        // Use offlineQueue if present so a flaky connection doesn't lose the action.
        const queue = window.MarzamOfflineQueue;
        const op = { method: 'POST', path: `/visit-plans/assignments/${a.id}/start`, body: {} };
        try {
          if (queue?.enqueue && !navigator.onLine) {
            await queue.enqueue(op);
            a.status = 'in_progress';
            window.MarzamToast?.show('Iniciada (offline) — se sincronizará al recuperar la red', 'info');
          } else {
            await API.post(op.path, {});
            a.status = 'in_progress';
            window.MarzamToast?.show('Visita iniciada', 'success');
          }
          this._refreshMap();
          this._refreshPendingCount();
        } catch (err) {
          window.MarzamToast?.show('No se pudo iniciar: ' + (err.message || err), 'danger');
        }
      },
      deviateStop(stop) {
        // Open the modal; submission flows through confirmDeviation().
        this.deviationStop = stop;
        this.deviationReason = '';
        this.deviationOpen = true;
      },
      closeDeviation() {
        this.deviationOpen = false;
        this.deviationStop = null;
        this.deviationReason = '';
      },
      async confirmDeviation() {
        const stop = this.deviationStop;
        const reason = (this.deviationReason || '').trim();
        if (!stop || !reason) return;
        const queue = window.MarzamOfflineQueue;
        const op = {
          method: 'POST',
          path: `/visit-plans/assignments/${stop.id}/deviate`,
          body: { reason },
        };
        try {
          if (queue?.enqueue && !navigator.onLine) {
            await queue.enqueue(op);
            stop.status = 'deviated';
            window.MarzamToast?.show('Desvío encolado offline', 'info');
          } else {
            await API.post(op.path, op.body);
            stop.status = 'deviated';
            window.MarzamToast?.show('Desvío registrado', 'success');
          }
          if (stop === this.next) {
            this.nextIdx = Math.min(this.nextIdx + 1, this.stops.length - 1);
          }
          this._refreshMap();
          this._refreshPendingCount();
          this.closeDeviation();
        } catch (err) {
          window.MarzamToast?.show('No se pudo registrar desvío: ' + (err.message || err), 'danger');
        }
      },
      async _refreshPendingCount() {
        try {
          const q = window.MarzamOfflineQueue;
          if (q?.pendingOpsCount) this.pendingOps = await q.pendingOpsCount();
        } catch { /* ignore */ }
      },
      wazeUrl(s) { return deepLinkWaze(s); },
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
