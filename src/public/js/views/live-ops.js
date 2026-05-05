/* =============================================================
   Live Ops view (manager) — real-time positions, alerts, status.
   Subscribes to /api/live/stream (Server-Sent Events) and updates
   the MapLibre map + a side feed in the panel.
   ============================================================= */
(function () {
  'use strict';

  const APP = window.MarzamApp.state;
  const SRC_REPS = 'live-reps';
  const SRC_TRAIL = 'live-trail';

  function clearLayers() {
    const map = APP.map;
    if (!map) return;
    [SRC_REPS, SRC_TRAIL].forEach((srcId) => {
      const layerLine = `${srcId}-line`;
      const layerCircle = `${srcId}-circle`;
      const layerLabel = `${srcId}-label`;
      [layerLine, layerCircle, layerLabel].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource(srcId)) map.removeSource(srcId);
    });
  }

  function statusFor(lastSeenMs) {
    const ageMin = (Date.now() - lastSeenMs) / 60_000;
    if (ageMin < 5) return 'active';
    if (ageMin < 25) return 'idle';
    return 'offline';
  }

  function colorForStatus(s) {
    if (s === 'active') return '#10b981';
    if (s === 'idle')   return '#f59e0b';
    return '#94a3b8';
  }

  function fmtTimeAgo(ms) {
    const min = Math.round((Date.now() - ms) / 60_000);
    if (min < 1) return 'ahora';
    if (min < 60) return `${min}m`;
    return `${Math.floor(min/60)}h`;
  }

  /**
   * Maintains a Map<rep_id, {lat, lng, name, lastSeen, trail: [[lng,lat,ts],…], alerts: 0}>
   * updated as SSE events arrive. `redraw()` flushes state to the map.
   */
  function makeStore() {
    const reps = new Map();
    const TRAIL_MAX = 60; // last ~30 minutes at 30s/ping
    return {
      onPosition({ rep_id, rep_name, lat, lng, recorded_at }) {
        const ts = recorded_at ? Date.parse(recorded_at) : Date.now();
        let rec = reps.get(rep_id);
        if (!rec) {
          rec = { rep_id, name: rep_name, lat, lng, lastSeen: ts, trail: [], alerts: 0 };
          reps.set(rep_id, rec);
        }
        rec.name = rep_name || rec.name;
        rec.lat = lat; rec.lng = lng; rec.lastSeen = ts;
        rec.trail.push([lng, lat, ts]);
        if (rec.trail.length > TRAIL_MAX) rec.trail.shift();
      },
      onAlert({ subject_user_id }) {
        const rec = reps.get(subject_user_id);
        if (rec) rec.alerts = (rec.alerts || 0) + 1;
      },
      list() { return [...reps.values()]; },
      get(repId) { return reps.get(repId); },
      clear() { reps.clear(); },
    };
  }

  function redrawMap(store) {
    const map = APP.map;
    if (!map) return;
    const reps = store.list();
    const repFeatures = [];
    const trailFeatures = [];
    for (const r of reps) {
      const status = statusFor(r.lastSeen);
      const color = r.alerts > 0 ? '#ef4444' : colorForStatus(status);
      if (Number.isFinite(r.lat) && Number.isFinite(r.lng)) {
        repFeatures.push({
          type: 'Feature',
          properties: { rep_id: r.rep_id, name: r.name || '', color, status, alerts: r.alerts || 0 },
          geometry: { type: 'Point', coordinates: [Number(r.lng), Number(r.lat)] },
        });
      }
      if (r.trail.length > 1) {
        trailFeatures.push({
          type: 'Feature',
          properties: { rep_id: r.rep_id, color },
          geometry: { type: 'LineString', coordinates: r.trail.map(([lng, lat]) => [lng, lat]) },
        });
      }
    }
    upsertSource(map, SRC_TRAIL, { type: 'FeatureCollection', features: trailFeatures });
    if (!map.getLayer(`${SRC_TRAIL}-line`)) {
      map.addLayer({
        id: `${SRC_TRAIL}-line`,
        type: 'line',
        source: SRC_TRAIL,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 3,
          'line-opacity': 0.6,
        },
      });
    }
    upsertSource(map, SRC_REPS, { type: 'FeatureCollection', features: repFeatures });
    if (!map.getLayer(`${SRC_REPS}-circle`)) {
      map.addLayer({
        id: `${SRC_REPS}-circle`,
        type: 'circle',
        source: SRC_REPS,
        paint: {
          'circle-radius': 9,
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 3,
          'circle-stroke-color': '#fff',
        },
      });
      map.addLayer({
        id: `${SRC_REPS}-label`,
        type: 'symbol',
        source: SRC_REPS,
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-offset': [0, 1.4],
          'text-anchor': 'top',
        },
        paint: {
          'text-color': '#0f172a',
          'text-halo-color': '#fff',
          'text-halo-width': 1.4,
        },
      });
    }
  }

  function upsertSource(map, srcId, data) {
    if (map.getSource(srcId)) {
      map.getSource(srcId).setData(data);
    } else {
      map.addSource(srcId, { type: 'geojson', data });
    }
  }

  /**
   * Open the SSE connection. Returns an `EventSource`-like object with
   * `close()`. Reconnects with exponential backoff on `error` events.
   */
  function openStream(token, onEvent) {
    let es;
    let backoff = 1000;
    let lastEventId = null;
    const ctrl = { closed: false, reconnects: 0 };

    function connect() {
      if (ctrl.closed) return;
      const url = new URL('/api/live/stream', location.origin);
      // EventSource doesn't support custom headers; pass token via query.
      url.searchParams.set('token', token);
      if (lastEventId) url.searchParams.set('last_event_id', lastEventId);
      es = new EventSource(url.toString(), { withCredentials: true });
      es.addEventListener('open', () => { backoff = 1000; });
      ['position', 'alert', 'assignment_status'].forEach((type) => {
        es.addEventListener(type, (e) => {
          lastEventId = e.lastEventId || lastEventId;
          let data = {};
          try { data = JSON.parse(e.data || '{}'); } catch { /* noop */ }
          onEvent({ type, data });
        });
      });
      es.addEventListener('error', () => {
        try { es.close(); } catch { /* noop */ }
        if (ctrl.closed) return;
        ctrl.reconnects += 1;
        setTimeout(connect, Math.min(backoff, 30000));
        backoff = Math.min(backoff * 2, 30000);
      });
    }

    connect();
    return {
      close() { ctrl.closed = true; try { es?.close(); } catch { /* noop */ } },
    };
  }

  let _activeStream = null;
  let _refreshTimer = null;

  async function renderLiveOps(body) {
    // Tear down any prior live session before re-rendering.
    if (_activeStream) { _activeStream.close(); _activeStream = null; }
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
    clearLayers();

    body.innerHTML = `
      <div x-data="liveOps()" x-init="init()" class="space-y-3">
        <!-- Top KPIs -->
        <div class="grid grid-cols-3 gap-2 text-center text-xs">
          <div class="bg-white rounded-xl p-2 border border-slate-100">
            <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Activos</div>
            <div class="text-lg font-black text-emerald-600" x-text="kpis.active"></div>
          </div>
          <div class="bg-white rounded-xl p-2 border border-slate-100">
            <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Inactivos</div>
            <div class="text-lg font-black text-amber-600" x-text="kpis.idle"></div>
          </div>
          <div class="bg-white rounded-xl p-2 border border-slate-100">
            <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Alertas</div>
            <div class="text-lg font-black text-rose-600" x-text="kpis.alerts"></div>
          </div>
        </div>

        <!-- Connection status -->
        <div class="flex items-center gap-2 text-[11px]" :class="connected ? 'text-emerald-600' : 'text-amber-600'">
          <span class="inline-block w-2 h-2 rounded-full" :class="connected ? 'bg-emerald-500 mz-pulse-active' : 'bg-amber-500'"></span>
          <span x-text="connected ? 'Conectado en vivo' : 'Reconectando…'"></span>
        </div>

        <!-- Reps list -->
        <div class="space-y-1.5 max-h-[42vh] overflow-y-auto pr-1">
          <template x-for="r in reps" :key="r.rep_id">
            <button @click="focusRep(r)"
              class="w-full flex items-center gap-3 bg-white rounded-xl border border-slate-100 px-3 py-2 text-left hover:border-orange-200 transition">
              <span class="mz-avatar flex-shrink-0" :style="'background:' + r.color" x-text="initials(r.name)"></span>
              <div class="flex-1 min-w-0">
                <div class="font-bold text-sm text-slate-800 truncate" x-text="r.name || 'Rep'"></div>
                <div class="text-[11px] text-slate-500" x-text="r.statusLabel + ' · hace ' + r.timeAgo"></div>
              </div>
              <span x-show="r.alerts > 0" class="mz-chip mz-chip-skipped mz-pulse-alert" x-text="'⚠ ' + r.alerts"></span>
            </button>
          </template>
          <template x-if="reps.length === 0">
            <div class="text-center text-xs text-slate-400 py-4">Esperando pings…</div>
          </template>
        </div>

        <!-- Event feed -->
        <div class="bg-white rounded-2xl border border-slate-100 p-2">
          <div class="text-[10px] font-bold uppercase text-slate-400 px-1 pb-1">Feed</div>
          <div class="space-y-1 max-h-44 overflow-y-auto pr-1">
            <template x-for="e in events" :key="e.id">
              <div class="mz-event-card text-[11px] px-2 py-1 rounded-lg" :class="eventClass(e)">
                <span x-text="e.icon"></span> <span class="font-semibold" x-text="e.title"></span>
                <span class="text-slate-400" x-text="' · ' + e.timeAgo"></span>
              </div>
            </template>
            <template x-if="events.length === 0">
              <div class="text-center text-xs text-slate-400 py-3">Sin eventos aún</div>
            </template>
          </div>
        </div>
      </div>
    `;
  }

  function liveOpsComponent() {
    return {
      reps: [],
      events: [],
      kpis: { active: 0, idle: 0, alerts: 0 },
      connected: false,
      _store: makeStore(),

      async init() {
        const token = localStorage.getItem('token') || '';
        if (!token) {
          window.MarzamToast?.show('Sesión expirada', 'danger');
          return;
        }
        _activeStream = openStream(token, ({ type, data }) => {
          this.connected = true;
          if (type === 'position') {
            this._store.onPosition(data);
          } else if (type === 'alert') {
            this._store.onAlert(data);
            this._pushEvent({ icon: '⚠', title: `Alerta · ${data.rule_key || ''}`, severity: data.severity || 'warn' });
          } else if (type === 'assignment_status') {
            this._pushEvent({ icon: '✓', title: `Stop ${data.status || ''}`, severity: 'info' });
          }
          this._refreshDerivedState();
        });
        // Tick once per second to update relative times even with no events.
        _refreshTimer = setInterval(() => this._refreshDerivedState(), 5000);
      },
      _pushEvent(e) {
        const id = `${Date.now()}-${Math.random()}`;
        const ts = Date.now();
        this.events = [{ id, ts, ...e, timeAgo: 'ahora' }, ...this.events].slice(0, 50);
      },
      _refreshDerivedState() {
        const list = this._store.list();
        const enriched = list.map((r) => {
          const status = statusFor(r.lastSeen);
          return {
            ...r,
            color: r.alerts > 0 ? '#ef4444' : colorForStatus(status),
            statusLabel: status === 'active' ? 'Activo' : status === 'idle' ? 'Inactivo' : 'Offline',
            timeAgo: fmtTimeAgo(r.lastSeen),
          };
        });
        this.reps = enriched.sort((a, b) => b.lastSeen - a.lastSeen);
        this.kpis = {
          active: enriched.filter((r) => statusFor(r.lastSeen) === 'active').length,
          idle: enriched.filter((r) => statusFor(r.lastSeen) === 'idle').length,
          alerts: enriched.reduce((s, r) => s + (r.alerts || 0), 0),
        };
        this.events = this.events.map((e) => ({ ...e, timeAgo: fmtTimeAgo(e.ts) }));
        redrawMap(this._store);
      },
      focusRep(r) {
        if (!APP.map || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return;
        APP.map.flyTo({ center: [r.lng, r.lat], zoom: 14, duration: 700 });
      },
      eventClass(e) {
        if (e.severity === 'critical') return 'bg-rose-50 text-rose-700';
        if (e.severity === 'warn') return 'bg-amber-50 text-amber-700';
        return 'bg-slate-50 text-slate-700';
      },
      initials(n) { return (n || '?').split(/\s+/).filter(Boolean).slice(0,2).map((s)=>s[0].toUpperCase()).join(''); },
    };
  }

  document.addEventListener('alpine:init', () => {
    if (window.Alpine?.data) window.Alpine.data('liveOps', liveOpsComponent);
  });
  if (window.Alpine?.data) window.Alpine.data('liveOps', liveOpsComponent);

  window.MarzamViews = window.MarzamViews || {};
  window.MarzamViews.renderLiveOps = renderLiveOps;
})();
