/* =============================================================
   Post-mortem view (manager) — plan vs executed comparative.
   Shows per-rep KPIs, a side-by-side polyline (plan blue vs real
   amber) and a time scrubber that replays the rep's day.
   ============================================================= */
(function () {
  'use strict';

  const APP = window.MarzamApp.state;
  const SRC_PLAN = 'pm-plan-line';
  const SRC_REAL = 'pm-real-line';
  const SRC_PLAN_STOPS = 'pm-plan-stops';
  const SRC_ME = 'pm-current';

  function clearLayers() {
    const map = APP.map; if (!map) return;
    [SRC_PLAN, SRC_REAL, SRC_PLAN_STOPS, SRC_ME].forEach((id) => {
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

  function fmtPct(n) { if (n == null || isNaN(n)) return '—'; return `${Math.round(n)}%`; }

  function drawReplay(map, replay, scrubberMs) {
    clearLayers();
    if (!map || !replay) return;
    // Plan polyline (concat all stops' polyline_to_next).
    const planLines = [];
    const planStops = [];
    for (let i = 0; i < (replay.stops || []).length; i += 1) {
      const s = replay.stops[i];
      if (s.lat != null) {
        planStops.push({
          type: 'Feature',
          properties: { route_order: s.route_order, status: s.status },
          geometry: { type: 'Point', coordinates: [Number(s.lng), Number(s.lat)] },
        });
      }
      if (s.polyline_to_next) {
        planLines.push({
          type: 'Feature', properties: {},
          geometry: { type: 'LineString', coordinates: decodePolyline(s.polyline_to_next) },
        });
      }
    }
    map.addSource(SRC_PLAN, { type: 'geojson', data: { type: 'FeatureCollection', features: planLines } });
    map.addLayer({ id: `${SRC_PLAN}-line`, type: 'line', source: SRC_PLAN,
      paint: { 'line-color': '#0ea5e9', 'line-width': 4, 'line-opacity': 0.7 } });
    map.addSource(SRC_PLAN_STOPS, { type: 'geojson', data: { type: 'FeatureCollection', features: planStops } });
    map.addLayer({ id: `${SRC_PLAN_STOPS}-circle`, type: 'circle', source: SRC_PLAN_STOPS,
      paint: { 'circle-radius': 7, 'circle-color': [
        'match', ['get','status'],
        'done', '#10b981', 'skipped', '#ef4444',
        '#0ea5e9',
      ], 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });

    // Real breadcrumbs polyline. Filter by scrubberMs if provided.
    const breadcrumbs = (replay.breadcrumbs || [])
      .map((b) => ({ ...b, ts: Date.parse(b.recorded_at) }))
      .filter((b) => Number.isFinite(b.lat) && Number.isFinite(b.lng))
      .sort((a, b) => a.ts - b.ts);
    const realCoords = breadcrumbs
      .filter((b) => !scrubberMs || b.ts <= scrubberMs)
      .map((b) => [Number(b.lng), Number(b.lat)]);
    if (realCoords.length > 1) {
      map.addSource(SRC_REAL, { type: 'geojson', data: {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: realCoords } }],
      } });
      map.addLayer({ id: `${SRC_REAL}-line`, type: 'line', source: SRC_REAL,
        paint: { 'line-color': '#ea580c', 'line-width': 4, 'line-opacity': 0.95 } });
    }
    // Current cursor marker
    if (scrubberMs && breadcrumbs.length) {
      const cursor = [...breadcrumbs].reverse().find((b) => b.ts <= scrubberMs) || breadcrumbs[0];
      if (cursor) {
        map.addSource(SRC_ME, { type: 'geojson', data: {
          type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [Number(cursor.lng), Number(cursor.lat)] } }],
        } });
        map.addLayer({ id: `${SRC_ME}-circle`, type: 'circle', source: SRC_ME,
          paint: { 'circle-radius': 9, 'circle-color': '#ea580c', 'circle-stroke-width': 4, 'circle-stroke-color': '#fff' } });
      }
    }
    // Fit
    const bounds = new maplibregl.LngLatBounds();
    planStops.forEach((f) => bounds.extend(f.geometry.coordinates));
    breadcrumbs.forEach((b) => bounds.extend([Number(b.lng), Number(b.lat)]));
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 80, duration: 600, maxZoom: 14 });
  }

  async function renderPostMortem(body) {
    clearLayers();
    body.innerHTML = `
      <div x-data="postMortem()" x-init="init()" class="space-y-3">
        <!-- Filtro Entidad Federativa: corta el ranking per-rep al subset
             que sirve a la EF activa. Heredado de window.MarzamPlanZone. -->
        <div class="bg-white rounded-2xl border border-slate-100 p-3 text-xs">
          <div class="flex items-center gap-2 mb-2">
            <svg class="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <label class="text-[10px] font-bold uppercase tracking-wider text-slate-500">Entidad federativa</label>
            <select x-model="poblacionFilter"
              @change="window.MarzamPlanZone = poblacionFilter || null; perRep = _applyPoblacionFilter(_perRepRaw)"
              class="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 outline-none text-xs">
              <option value="">Toda la sucursal</option>
              <template x-for="p in availablePoblaciones" :key="p">
                <option :value="p" x-text="p"></option>
              </template>
            </select>
          </div>
          <label class="block font-bold text-slate-600 mb-1 mt-1">Plan</label>
          <select x-model="planId" @change="loadPlan()" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 outline-none">
            <option value="">— elige un plan —</option>
            <template x-for="p in plans" :key="p.id">
              <option :value="p.id" x-text="(p.name || ('Plan ' + p.period_start)) + ' · ' + p.status"></option>
            </template>
          </select>
        </div>

        <template x-if="totals">
          <div class="grid grid-cols-3 gap-2 text-center text-xs">
            <div class="bg-white rounded-xl p-2 border border-slate-100">
              <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Cumplimiento</div>
              <div class="text-lg font-black text-emerald-600" x-text="fmtPct(totals.completion_pct)"></div>
            </div>
            <div class="bg-white rounded-xl p-2 border border-slate-100">
              <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Ejecutadas</div>
              <div class="text-lg font-black text-slate-800" x-text="totals.done + '/' + totals.planned"></div>
            </div>
            <div class="bg-white rounded-xl p-2 border border-slate-100">
              <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Min plan</div>
              <div class="text-lg font-black text-slate-800" x-text="totals.estimated_minutes"></div>
            </div>
          </div>
        </template>

        <!-- Per-rep ranking -->
        <template x-if="perRep && perRep.length">
          <div class="bg-white rounded-2xl border border-slate-100 p-2">
            <div class="text-[10px] font-bold uppercase text-slate-400 px-1 pb-1">Ranking</div>
            <div class="space-y-1 max-h-56 overflow-y-auto pr-1">
              <template x-for="r in perRep" :key="r.visitor_user_id">
                <button @click="selectRep(r.visitor_user_id)"
                  class="w-full flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-orange-50 text-left"
                  :class="selectedRep === r.visitor_user_id ? 'bg-orange-100' : ''">
                  <span class="mz-avatar" style="background:#0ea5e9" x-text="initials(r.visitor_name)"></span>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-bold truncate" x-text="r.visitor_name"></div>
                    <div class="text-[11px] text-slate-500" x-text="r.assignments_done + '/' + r.assignments_planned + ' · ' + fmtPct(r.completion_pct)"></div>
                  </div>
                </button>
              </template>
            </div>
          </div>
        </template>

        <!-- Day picker + scrubber -->
        <template x-if="selectedRep">
          <div class="bg-white rounded-2xl border border-slate-100 p-3 text-xs space-y-3">
            <div>
              <label class="block font-bold text-slate-600 mb-1">Día a reproducir</label>
              <input type="date" x-model="day" @change="loadReplay()"
                class="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 outline-none">
            </div>
            <template x-if="replay && replay.breadcrumbs && replay.breadcrumbs.length">
              <div>
                <input type="range"
                  class="mz-scrubber"
                  :min="scrubberMin" :max="scrubberMax" :step="60_000"
                  x-model.number="scrubberMs" @input="onScrub()" />
                <div class="text-center mt-1.5 font-bold text-slate-700" x-text="scrubberLabel"></div>
              </div>
            </template>
          </div>
        </template>
      </div>
    `;
  }

  function postMortemComponent() {
    return {
      plans: [],
      planId: '',
      totals: null,
      _perRepRaw: [],     // unfiltered ranking from /post-mortem
      perRep: [],         // filtered by poblacionFilter
      selectedRep: null,
      day: new Date().toISOString().slice(0, 10),
      replay: null,
      scrubberMin: 0,
      scrubberMax: 0,
      scrubberMs: 0,
      poblacionFilter: window.MarzamPlanZone || (window.APP?.poblacion && window.APP.poblacion !== '__all__' ? window.APP.poblacion : ''),
      availablePoblaciones: [],
      _userPobMap: new Map(),  // user_id → Set<poblacion>

      async init() {
        // Pre-load team + clients + canonical EF list. clients sirve como
        // fallback para hidratar `u.poblaciones` cuando el backend no
        // enriqueció (rep_code → employee_code de cada cliente).
        try {
          const [team, clientsRaw, pobCanonical] = await Promise.all([
            API.get('/team/descendants').catch(() => []),
            API.get('/marzam/clients?limit=2000').catch(() => []),
            API.get('/poblaciones').catch(() => null),
          ]);
          const clientList = Array.isArray(clientsRaw) ? clientsRaw : (clientsRaw?.clients || clientsRaw?.rows || clientsRaw?.data || []);
          if (window.MarzamEF?.hydrateTeam) window.MarzamEF.hydrateTeam(team, clientList);
          const raw = [];
          (team || []).forEach((u) => {
            const list = Array.isArray(u.poblaciones) ? u.poblaciones : [];
            this._userPobMap.set(u.id, new Set(list.map((p) => String(p).trim())));
            list.forEach((p) => p && raw.push(p));
          });
          for (const c of clientList) if (c.poblacion) raw.push(c.poblacion);
          if (pobCanonical?.options) {
            for (const opt of pobCanonical.options) {
              if (opt?.value && opt.value !== '__all__') raw.push(opt.value);
            }
          }
          this.availablePoblaciones = window.MarzamEF?.dedup ? window.MarzamEF.dedup(raw) : [...new Set(raw.filter(Boolean))].sort();
        } catch { /* keep empty */ }
        try {
          this.plans = await API.get('/visit-plans');
        } catch { this.plans = []; }
      },
      async loadPlan() {
        if (!this.planId) return;
        try {
          const r = await API.get(`/visit-plans/${this.planId}/post-mortem`);
          this.totals = r.totals;
          this._perRepRaw = r.per_rep || [];
          this.perRep = this._applyPoblacionFilter(this._perRepRaw);
        } catch (err) {
          window.MarzamToast?.show('Error: ' + (err.message || err), 'danger');
        }
      },
      _applyPoblacionFilter(rows) {
        if (!this.poblacionFilter) return rows;
        const efKey = window.MarzamEF ? window.MarzamEF.key : ((s) => String(s || '').trim().toLowerCase());
        const target = efKey(this.poblacionFilter);
        // Strict: post-hidratación, un user sin EFs publicadas genuinamente
        // no atiende ninguna farmacia. El ranking varía con la EF activa.
        return rows.filter((r) => {
          const set = this._userPobMap.get(r.visitor_user_id);
          if (!set || set.size === 0) return false;
          for (const v of set) if (efKey(v) === target) return true;
          return false;
        });
      },
      async selectRep(repId) {
        this.selectedRep = repId;
        await this.loadReplay();
      },
      async loadReplay() {
        if (!this.planId || !this.selectedRep || !this.day) return;
        try {
          this.replay = await API.get(`/visit-plans/${this.planId}/replay/${this.selectedRep}/${this.day}`);
          const bcs = (this.replay.breadcrumbs || []).map((b) => Date.parse(b.recorded_at)).filter(Number.isFinite);
          if (bcs.length) {
            this.scrubberMin = Math.min(...bcs);
            this.scrubberMax = Math.max(...bcs);
            this.scrubberMs = this.scrubberMax;
          }
          drawReplay(APP.map, this.replay, this.scrubberMs);
        } catch (err) {
          window.MarzamToast?.show('Error: ' + (err.message || err), 'danger');
        }
      },
      onScrub() { drawReplay(APP.map, this.replay, this.scrubberMs); },
      get scrubberLabel() {
        if (!this.scrubberMs) return '—';
        return new Date(this.scrubberMs).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
      },
      initials(name) { return (name || '?').split(/\s+/).filter(Boolean).slice(0,2).map((s) => s[0].toUpperCase()).join(''); },
      fmtPct,
    };
  }

  document.addEventListener('alpine:init', () => {
    if (window.Alpine?.data) window.Alpine.data('postMortem', postMortemComponent);
  });
  if (window.Alpine?.data) window.Alpine.data('postMortem', postMortemComponent);

  window.MarzamViews = window.MarzamViews || {};
  window.MarzamViews.renderPostMortem = renderPostMortem;
})();
