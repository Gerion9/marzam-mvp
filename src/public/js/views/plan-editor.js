/* =============================================================
   Plan Editor view (manager) — interactive draft generation
   on top of the live MapLibre map. Calls /api/visit-plans/preview-full
   to get a tentative plan with polylines, lets the manager iterate
   visually (drag a stop to a different rep), then publishes.

   UX features (post hierarchy redesign):
     - Hierarchical rep picker: reps grouped under their supervisor,
       supervisors grouped under their gerente. Bulk-select per group.
     - Branch / zone / manager chips on each rep row.
     - Inline warnings for reps without home_lat (picks up first GPS),
       without address (employee_profiles.domicilio_particular empty),
       and total minutes vs capacity per rep card.
   ============================================================= */
(function () {
  'use strict';

  const APP = window.MarzamApp.state;
  const REP_COLORS = [
    '#6366f1','#ec4899','#14b8a6','#f97316','#10b981','#8b5cf6',
    '#f43f5e','#06b6d4','#84cc16','#eab308','#d946ef','#0ea5e9',
    '#ef4444','#22c55e','#a855f7','#f59e0b',
  ];

  const SRC_POLY = 'plan-editor-polylines';
  const SRC_STOPS = 'plan-editor-stops';
  const SRC_HOMES = 'plan-editor-homes';

  function colorFor(idx) { return REP_COLORS[idx % REP_COLORS.length]; }

  function decodePolyline(str, precision = 5) {
    if (!str) return [];
    const factor = 10 ** precision;
    let index = 0, lat = 0, lng = 0;
    const coords = [];
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

  function clearLayers() {
    const map = APP.map;
    if (!map) return;
    [SRC_POLY, SRC_STOPS, SRC_HOMES].forEach((srcId) => {
      ['line','circle','symbol'].forEach((kind) => {
        const id = `${srcId}-${kind}`;
        if (map.getLayer(id)) map.removeLayer(id);
      });
      if (map.getSource(srcId)) map.removeSource(srcId);
    });
  }

  function drawPreview(map, preview, repMeta) {
    clearLayers();
    if (!preview?.assignments?.length) return;
    const byVisitor = new Map();
    for (const a of preview.assignments) {
      if (!byVisitor.has(a.visitor_user_id)) byVisitor.set(a.visitor_user_id, []);
      byVisitor.get(a.visitor_user_id).push(a);
    }
    const polyFeatures = [];
    const stopFeatures = [];
    let repIdx = 0;
    for (const [visitorId, list] of byVisitor.entries()) {
      list.sort((a, b) => (a.scheduled_date < b.scheduled_date ? -1 : a.scheduled_date > b.scheduled_date ? 1 : a.route_order - b.route_order));
      const meta = repMeta.get(visitorId) || {};
      meta.color = colorFor(repIdx);
      repMeta.set(visitorId, meta);
      repIdx += 1;
      for (const a of list) {
        if (a.polyline_to_next) {
          const coords = decodePolyline(a.polyline_to_next);
          if (coords.length > 1) {
            polyFeatures.push({
              type: 'Feature',
              properties: { color: meta.color, visitor: visitorId },
              geometry: { type: 'LineString', coordinates: coords },
            });
          }
        }
        // __lat/__lng are set to null by generatePreview(); fall back to lat/lng
        // from the backend (e.g. the demo preview-routing path returns them directly).
        const stopLat = a.__lat ?? a.lat;
        const stopLng = a.__lng ?? a.lng;
        if (stopLat != null && stopLng != null) {
          stopFeatures.push({
            type: 'Feature',
            properties: { color: meta.color, route_order: a.route_order, name: a.farmacia_nombre || '' },
            geometry: { type: 'Point', coordinates: [Number(stopLng), Number(stopLat)] },
          });
        }
      }
    }
    if (polyFeatures.length) {
      map.addSource(SRC_POLY, { type: 'geojson', data: { type: 'FeatureCollection', features: polyFeatures } });
      map.addLayer({ id: `${SRC_POLY}-line`, type: 'line', source: SRC_POLY,
        paint: { 'line-color': ['get', 'color'], 'line-width': 3.4, 'line-opacity': 0.78 } });
    }
    if (stopFeatures.length) {
      map.addSource(SRC_STOPS, { type: 'geojson', data: { type: 'FeatureCollection', features: stopFeatures } });
      map.addLayer({ id: `${SRC_STOPS}-circle`, type: 'circle', source: SRC_STOPS,
        paint: {
          'circle-radius': 6, 'circle-color': ['get', 'color'],
          'circle-stroke-width': 2, 'circle-stroke-color': '#fff',
        } });
    }
    const homeFeatures = [];
    for (const [, meta] of repMeta.entries()) {
      if (meta.home_lat != null && meta.home_lng != null) {
        homeFeatures.push({
          type: 'Feature',
          properties: { color: meta.color },
          geometry: { type: 'Point', coordinates: [Number(meta.home_lng), Number(meta.home_lat)] },
        });
      }
    }
    if (homeFeatures.length) {
      map.addSource(SRC_HOMES, { type: 'geojson', data: { type: 'FeatureCollection', features: homeFeatures } });
      map.addLayer({ id: `${SRC_HOMES}-circle`, type: 'circle', source: SRC_HOMES,
        paint: {
          'circle-radius': 9, 'circle-color': ['get', 'color'],
          'circle-stroke-width': 3, 'circle-stroke-color': '#0f172a',
        } });
    }
    if (stopFeatures.length) {
      const bounds = new maplibregl.LngLatBounds();
      stopFeatures.forEach((f) => bounds.extend(f.geometry.coordinates));
      map.fitBounds(bounds, { padding: 80, duration: 600 });
    }
  }

  function fmtMin(min) { if (!min || isNaN(min)) return '0m'; const h = Math.floor(min/60); const m = min%60; return h ? `${h}h ${m}m` : `${m}m`; }
  function initials(name) { return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join(''); }

  /**
   * Build the hierarchy tree for the picker:
   *   gerente -> supervisor -> reps  (all three levels are checkable)
   *
   *   - Reps without a supervisor go in `orphan_reps`.
   *   - Supervisors without a gerente (e.g. actor IS the gerente) go in
   *     `ungrouped_supervisors`.
   *   - Gerentes without a parent (top of the actor's tree) become roots.
   *
   * Every level is selectable as a planning target (Pareto A → gerente,
   * B → supervisor, B/C → rep). Synthetic ids (no underlying users.uuid)
   * are flagged so the UI can disable them.
   */
  function buildHierarchy(users) {
    // Resolve the effective role from (1) the explicit `role` field when
    // it's a known value, or (2) the employee_code pattern as a fallback:
    //   length 2 (e.g. 'UE')      → gerente_ventas
    //   length 5 ending in '00'   → supervisor (e.g. 'UEA00')
    //   length 5 otherwise        → representante (e.g. 'UEA01')
    // This guarantees even users that arrive without a role still land in
    // the correct bucket (we saw cases where role came back as
    // 'director_sucursal' or empty for the actor's subtree).
    const KNOWN = { gerente_ventas: 1, supervisor: 1, representante: 1 };
    function effectiveRole(u) {
      const r = String(u.role || '').toLowerCase();
      if (KNOWN[r]) return r;
      const code = String(u.employee_code || '');
      if (code.length === 2) return 'gerente_ventas';
      if (code.length === 5 && code.endsWith('00')) return 'supervisor';
      if (code.length === 5) return 'representante';
      return 'representante'; // safest default — surface as rep so the manager can still pick
    }
    // Annotate users in-place so the templates can read u.role uniformly.
    users.forEach((u) => { u.role = effectiveRole(u); });
    const reps = users.filter((u) => u.role === 'representante');
    const sups = users.filter((u) => u.role === 'supervisor');
    const gers = users.filter((u) => u.role === 'gerente_ventas');

    const supById = new Map(sups.map((s) => [s.id, { ...s, reps: [] }]));
    const gerById = new Map(gers.map((g) => [g.id, { ...g, supervisors: [], directReps: [] }]));

    // Place reps. Backend resolves manager_id with this preference order:
    //   1) the rep's supervisor (UEAxx → UEA00)
    //   2) the rep's gerente   (UEAxx → UE)  if there is no supervisor row
    // So manager_id may point to either a supervisor OR a gerente. We honor
    // both so reps without a supervisor still appear under the right gerente
    // — never lost in an "orphans" bucket if the gerente is known.
    const orphanReps = [];
    for (const r of reps) {
      if (r.manager_id && supById.has(r.manager_id)) {
        supById.get(r.manager_id).reps.push(r);
      } else if (r.manager_id && gerById.has(r.manager_id)) {
        gerById.get(r.manager_id).directReps.push(r);
      } else {
        orphanReps.push(r);
      }
    }

    // Place supervisors under their gerente.
    const ungroupedSupervisors = [];
    for (const supEntry of supById.values()) {
      if (supEntry.manager_id && gerById.has(supEntry.manager_id)) {
        gerById.get(supEntry.manager_id).supervisors.push(supEntry);
      } else {
        ungroupedSupervisors.push(supEntry);
      }
    }

    const gerentes = [...gerById.values()]
      .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
    return { gerentes, ungrouped_supervisors: ungroupedSupervisors, orphan_reps: orphanReps };
  }

  function isUserVacant(u) {
    const name = String(u?.full_name || '').trim();
    return !name || /^vacante$/i.test(name);
  }

  // Collect all selectable IDs under a node. Vacant / synthetic / inactive
  // rows are NOT added (they can't be planning targets), but the recursion
  // still descends through them so a vacant supervisor's checkbox bulk-picks
  // all valid reps below.
  function idsUnder(entry) {
    const out = [];
    const valid = (e) => e?.id && !e.synthetic_id && e.is_active !== false && !isUserVacant(e);
    if (valid(entry)) out.push(entry.id);
    if (entry.supervisors) for (const s of entry.supervisors) out.push(...idsUnder(s));
    if (entry.directReps) for (const r of entry.directReps) if (valid(r)) out.push(r.id);
    if (entry.reps) for (const r of entry.reps) if (valid(r)) out.push(r.id);
    return out;
  }

  async function renderPlanEditor(body) {
    body.innerHTML = `
      <div x-data="planEditor()" x-init="init()" class="space-y-3">
        <!-- Configuration -->
        <div class="bg-white rounded-2xl shadow-sm border border-slate-100 p-4">
          <div class="grid grid-cols-2 gap-3 text-xs">
            <div>
              <label class="block font-bold text-slate-600 mb-1">Desde</label>
              <input type="date" x-model="periodStart" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 outline-none">
            </div>
            <div>
              <label class="block font-bold text-slate-600 mb-1">Hasta</label>
              <input type="date" x-model="periodEnd" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 outline-none">
            </div>
          </div>

          <!-- Filtro por Entidad Federativa — heredado del sub-tab Cuotas
               (window.MarzamPlanZone) y editable aquí también. La fuente
               es la columna marzam_clients.poblacion: cada usuario llega
               del backend con un array poblaciones (las EFs donde tiene
               farmacias asignadas). Filtra reps que NO sirven a la EF. -->
          <div class="mt-3">
            <label class="text-xs font-bold text-slate-600 block mb-1">Entidad federativa</label>
            <select x-model="zoneFilter" @change="window.MarzamPlanZone = zoneFilter || null"
              class="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 outline-none text-xs">
              <option value="">Toda la sucursal</option>
              <template x-for="z in availableZones" :key="z">
                <option :value="z" x-text="z"></option>
              </template>
            </select>
            <p class="text-[10px] text-slate-400 mt-1 italic" x-show="zoneFilter">Mostrando solo el equipo con cobertura en <b x-text="zoneFilter"></b>.</p>
          </div>

          <!-- Hierarchical picker -->
          <div class="mt-3">
            <div class="flex items-center justify-between">
              <label class="text-xs font-bold text-slate-600">Equipo</label>
              <div class="flex items-center gap-1.5">
                <input type="text" x-model="search" placeholder="Buscar…"
                  class="text-[11px] bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 outline-none w-28">
                <button @click="selectAll()" class="text-[10px] font-bold uppercase tracking-wide text-orange-600 hover:underline">Todos</button>
                <button @click="clearAll()" class="text-[10px] font-bold uppercase tracking-wide text-slate-400 hover:underline">Limpiar</button>
              </div>
            </div>
            <div class="text-[11px] text-slate-500 mt-0.5" x-text="selectionLabel"></div>

            <div class="mt-2 max-h-72 overflow-y-auto pr-1 space-y-1.5">
              <template x-if="loadingTeam">
                <div class="space-y-1.5">
                  <div class="mz-skel h-12"></div>
                  <div class="mz-skel h-12"></div>
                  <div class="mz-skel h-12"></div>
                </div>
              </template>

              <!-- Per gerente -->
              <template x-for="g in visibleHierarchy.gerentes" :key="g.id">
                <div class="border border-slate-100 rounded-xl overflow-hidden">
                  <!-- Gerente row -->
                  <div class="flex items-center gap-2 px-2 py-1.5 bg-violet-50 hover:bg-violet-100 text-left"
                       :class="isVacancy(g) ? 'opacity-70' : ''">
                    <button @click="toggleGerente(g.id)" class="text-[10px] w-3 text-slate-500"
                      x-text="expandedGerentes[g.id] === false ? '▸' : '▾'"></button>
                    <input type="checkbox" :checked="checkboxState(idsUnder(g)) === 'all'"
                      :indeterminate.camel="checkboxState(idsUnder(g)) === 'some'"
                      :disabled="idsUnder(g).length === 0"
                      @change="bulkToggle(idsUnder(g), $event.target.checked)"
                      class="accent-orange-500">
                    <span class="mz-chip" style="background:#ede9fe;color:#5b21b6">Gerente</span>
                    <div class="flex-1 min-w-0">
                      <div class="text-xs font-bold truncate" :class="isVacancy(g) ? 'text-slate-400 italic' : 'text-slate-800'"
                           x-text="isVacancy(g) ? 'Plaza vacante' : g.full_name"></div>
                      <div class="text-[10px] text-slate-500 truncate" x-text="g.employee_code + (g.branch_name ? ' · ' + g.branch_name : '')"></div>
                    </div>
                    <span x-show="isVacancy(g)" class="mz-chip" style="background:#fef3c7;color:#92400e">VACANTE</span>
                    <span x-show="!isVacancy(g)" class="text-[10px] text-slate-400 font-semibold" x-text="totalUnder(g) + ' total'"></span>
                  </div>

                  <div x-show="expandedGerentes[g.id] !== false">
                    <template x-for="s in g.supervisors" :key="s.id">
                      <div>
                        <!-- Supervisor row -->
                        <div class="flex items-center gap-2 px-2 py-1 bg-blue-50 hover:bg-blue-100 border-t border-slate-100"
                             :class="isVacancy(s) ? 'opacity-70' : ''">
                          <span class="w-3"></span>
                          <button @click="toggleSupervisor(s.id)" class="text-[10px] w-3 text-slate-500"
                            x-text="expandedSupervisors[s.id] === false ? '▸' : '▾'"></button>
                          <input type="checkbox" :checked="checkboxState(idsUnder(s)) === 'all'"
                            :indeterminate.camel="checkboxState(idsUnder(s)) === 'some'"
                            :disabled="idsUnder(s).length === 0"
                            @change="bulkToggle(idsUnder(s), $event.target.checked)"
                            class="accent-orange-500">
                          <span class="mz-chip" style="background:#dbeafe;color:#1d4ed8">Supervisor</span>
                          <div class="flex-1 min-w-0">
                            <div class="text-xs font-semibold truncate" :class="isVacancy(s) ? 'text-slate-400 italic' : 'text-slate-800'"
                                 x-text="isVacancy(s) ? 'Plaza vacante' : s.full_name"></div>
                            <div class="text-[10px] text-slate-500 truncate" x-text="s.employee_code + ((s.poblaciones && s.poblaciones.length) ? ' · ' + s.poblaciones.join(', ') : '')"></div>
                          </div>
                          <span x-show="isVacancy(s)" class="mz-chip" style="background:#fef3c7;color:#92400e">VACANTE</span>
                          <span x-show="!isVacancy(s)" class="text-[10px] text-slate-400 font-semibold" x-text="s.reps.length + ' reps'"></span>
                        </div>
                        <!-- Reps -->
                        <div x-show="expandedSupervisors[s.id] !== false">
                          <template x-for="r in s.reps" :key="r.id">
                            <label class="flex items-center gap-2 px-2 py-1.5 hover:bg-orange-50 cursor-pointer border-t border-slate-50"
                                   :class="(r.synthetic_id || isVacancy(r)) ? 'opacity-60 cursor-not-allowed' : ''">
                              <span class="w-3"></span>
                              <span class="w-3"></span>
                              <input type="checkbox" :value="r.id" x-model="scopeUserIds"
                                :disabled="r.synthetic_id || r.is_active === false || isVacancy(r)"
                                class="accent-orange-500">
                              <span x-show="!isVacancy(r)" class="mz-avatar text-[9px]" :style="'width:22px;height:22px;background:#0ea5e9'" x-text="initials(r.full_name)"></span>
                              <span x-show="isVacancy(r)" class="w-[22px] h-[22px] rounded-full border-2 border-dashed border-amber-400 flex items-center justify-center text-[10px] text-amber-600">✕</span>
                              <div class="flex-1 min-w-0">
                                <div class="text-[12px] font-semibold truncate" :class="isVacancy(r) ? 'text-slate-400 italic' : 'text-slate-800'"
                                     x-text="isVacancy(r) ? 'Plaza vacante' : r.full_name"></div>
                                <div class="text-[10px] text-slate-500 truncate" x-text="r.employee_code + ((r.poblaciones && r.poblaciones.length) ? ' · ' + r.poblaciones.join(', ') : '')"></div>
                              </div>
                              <span x-show="isVacancy(r)" class="mz-chip" style="background:#fef3c7;color:#92400e">VACANTE</span>
                              <span x-show="!isVacancy(r) && !r.has_home" class="mz-chip mz-chip-late text-[9px]" title="Sin home — se usará primer GPS">⚠</span>
                              <span x-show="!isVacancy(r) && r.has_home" class="text-[10px] text-emerald-600 font-bold">✓</span>
                            </label>
                          </template>
                          <template x-if="s.reps.length === 0">
                            <div class="px-7 py-1.5 text-[10px] text-slate-400 italic border-t border-slate-50">Sin representantes</div>
                          </template>
                        </div>
                      </div>
                    </template>
                    <template x-if="g.supervisors.length === 0 && (g.directReps || []).length === 0">
                      <div class="px-5 py-1.5 text-[10px] text-slate-400 italic border-t border-slate-50">Sin supervisores ni reps directos</div>
                    </template>
                    <!-- Reps que reportan DIRECTAMENTE al gerente (porque su
                         supervisor no existe en el padrón). El backend ya
                         resolvió manager_id a la gerencia. -->
                    <template x-if="(g.directReps || []).length > 0">
                      <div class="border-t border-slate-100">
                        <div class="flex items-center gap-2 px-2 py-1 bg-amber-50">
                          <span class="w-3"></span>
                          <span class="w-3"></span>
                          <span class="mz-chip" style="background:#fef3c7;color:#92400e">Reportan directo al gerente</span>
                          <span class="ml-auto text-[10px] text-slate-500" x-text="g.directReps.length + ' reps'"></span>
                        </div>
                        <template x-for="r in g.directReps" :key="r.id">
                          <label class="flex items-center gap-2 px-2 py-1.5 hover:bg-orange-50 cursor-pointer border-t border-slate-50"
                                 :class="(r.synthetic_id || isVacancy(r)) ? 'opacity-60 cursor-not-allowed' : ''">
                            <span class="w-3"></span>
                            <span class="w-3"></span>
                            <input type="checkbox" :value="r.id" x-model="scopeUserIds"
                              :disabled="r.synthetic_id || r.is_active === false || isVacancy(r)"
                              class="accent-orange-500">
                            <span x-show="!isVacancy(r)" class="mz-avatar text-[9px]" :style="'width:22px;height:22px;background:#0ea5e9'" x-text="initials(r.full_name)"></span>
                            <span x-show="isVacancy(r)" class="w-[22px] h-[22px] rounded-full border-2 border-dashed border-amber-400 flex items-center justify-center text-[10px] text-amber-600">✕</span>
                            <div class="flex-1 min-w-0">
                              <div class="text-[12px] font-semibold truncate" :class="isVacancy(r) ? 'text-slate-400 italic' : 'text-slate-800'"
                                   x-text="isVacancy(r) ? 'Plaza vacante' : r.full_name"></div>
                              <div class="text-[10px] text-slate-500 truncate" x-text="r.employee_code + ((r.poblaciones && r.poblaciones.length) ? ' · ' + r.poblaciones.join(', ') : '')"></div>
                            </div>
                            <span x-show="isVacancy(r)" class="mz-chip" style="background:#fef3c7;color:#92400e">VACANTE</span>
                            <span x-show="!isVacancy(r) && !r.has_home" class="mz-chip mz-chip-late text-[9px]">⚠</span>
                            <span x-show="!isVacancy(r) && r.has_home" class="text-[10px] text-emerald-600 font-bold">✓</span>
                          </label>
                        </template>
                      </div>
                    </template>
                  </div>
                </div>
              </template>

              <!-- Ungrouped supervisors (actor IS the gerente) -->
              <template x-for="s in visibleHierarchy.ungrouped_supervisors" :key="s.id">
                <div class="border border-slate-100 rounded-xl overflow-hidden">
                  <div class="flex items-center gap-2 px-2 py-1.5 bg-blue-50 hover:bg-blue-100"
                       :class="isVacancy(s) ? 'opacity-70' : ''">
                    <button @click="toggleSupervisor(s.id)" class="text-[10px] w-3 text-slate-500"
                      x-text="expandedSupervisors[s.id] === false ? '▸' : '▾'"></button>
                    <input type="checkbox" :checked="checkboxState(idsUnder(s)) === 'all'"
                      :indeterminate.camel="checkboxState(idsUnder(s)) === 'some'"
                      :disabled="s.synthetic_id || s.is_active === false || isVacancy(s)"
                      @change="bulkToggle(idsUnder(s), $event.target.checked)"
                      class="accent-orange-500">
                    <span class="mz-chip" style="background:#dbeafe;color:#1d4ed8">Supervisor</span>
                    <div class="flex-1 min-w-0">
                      <div class="text-xs font-bold truncate" :class="isVacancy(s) ? 'text-slate-400 italic' : 'text-slate-800'"
                           x-text="isVacancy(s) ? 'Plaza vacante' : s.full_name"></div>
                      <div class="text-[10px] text-slate-500 truncate" x-text="s.employee_code"></div>
                    </div>
                    <span x-show="isVacancy(s)" class="mz-chip" style="background:#fef3c7;color:#92400e">VACANTE</span>
                    <span x-show="!isVacancy(s)" class="text-[10px] text-slate-400 font-semibold" x-text="s.reps.length + ' reps'"></span>
                  </div>
                  <div x-show="expandedSupervisors[s.id] !== false">
                    <template x-for="r in s.reps" :key="r.id">
                      <label class="flex items-center gap-2 px-2 py-1.5 hover:bg-orange-50 cursor-pointer border-t border-slate-50"
                             :class="(r.synthetic_id || isVacancy(r)) ? 'opacity-60 cursor-not-allowed' : ''">
                        <span class="w-3"></span>
                        <input type="checkbox" :value="r.id" x-model="scopeUserIds"
                          :disabled="r.synthetic_id || r.is_active === false || isVacancy(r)"
                          class="accent-orange-500">
                        <span x-show="!isVacancy(r)" class="mz-avatar text-[9px]" :style="'width:22px;height:22px;background:#0ea5e9'" x-text="initials(r.full_name)"></span>
                        <span x-show="isVacancy(r)" class="w-[22px] h-[22px] rounded-full border-2 border-dashed border-amber-400 flex items-center justify-center text-[10px] text-amber-600">✕</span>
                        <div class="flex-1 min-w-0">
                          <div class="text-[12px] font-semibold truncate" :class="isVacancy(r) ? 'text-slate-400 italic' : 'text-slate-800'"
                               x-text="isVacancy(r) ? 'Plaza vacante' : r.full_name"></div>
                          <div class="text-[10px] text-slate-500 truncate" x-text="r.employee_code + ((r.poblaciones && r.poblaciones.length) ? ' · ' + r.poblaciones.join(', ') : '')"></div>
                        </div>
                        <span x-show="isVacancy(r)" class="mz-chip" style="background:#fef3c7;color:#92400e">VACANTE</span>
                        <span x-show="!isVacancy(r) && !r.has_home" class="mz-chip mz-chip-late text-[9px]">⚠</span>
                        <span x-show="!isVacancy(r) && r.has_home" class="text-[10px] text-emerald-600 font-bold">✓</span>
                      </label>
                    </template>
                  </div>
                </div>
              </template>

              <template x-if="visibleHierarchy.orphan_reps.length > 0">
                <div class="border border-amber-200 rounded-xl overflow-hidden">
                  <div class="px-2 py-1.5 bg-amber-50 text-[11px] font-bold text-amber-700">⚠ Reps sin supervisor</div>
                  <template x-for="r in visibleHierarchy.orphan_reps" :key="r.id">
                    <label class="flex items-center gap-2 px-2 py-1.5 hover:bg-orange-50 cursor-pointer border-t border-slate-50">
                      <input type="checkbox" :value="r.id" x-model="scopeUserIds"
                        :disabled="r.synthetic_id || r.is_active === false" class="accent-orange-500">
                      <span class="mz-avatar text-[9px]" :style="'width:22px;height:22px;background:#94a3b8'" x-text="initials(r.full_name)"></span>
                      <div class="flex-1 min-w-0">
                        <div class="text-[12px] font-semibold text-slate-800 truncate" x-text="r.full_name"></div>
                        <div class="text-[10px] text-slate-500" x-text="r.employee_code"></div>
                      </div>
                    </label>
                  </template>
                </div>
              </template>

              <template x-if="!loadingTeam && visibleHierarchy.gerentes.length === 0 && visibleHierarchy.ungrouped_supervisors.length === 0 && visibleHierarchy.orphan_reps.length === 0">
                <div class="text-center text-xs text-slate-400 py-4">No hay miembros en tu equipo.</div>
              </template>
            </div>
          </div>

          <!-- Pre-flight warnings -->
          <template x-if="scopeUserIds.length > 0 && repsWithoutHomeCount > 0">
            <div class="mt-3 bg-amber-50 border border-amber-200 rounded-xl p-2.5 text-[11px]">
              <div class="font-bold text-amber-700">⚠ <span x-text="repsWithoutHomeCount"></span> rep(s) sin domicilio guardado</div>
              <div class="text-amber-600 mt-0.5">Se usará su primera ubicación GPS al abrir la app. La asignación geográfica para esos reps caerá en round-robin hasta que tengan home.</div>
            </div>
          </template>

          <div class="mt-3 flex items-center gap-2">
            <button @click="generatePreview()" :disabled="loading || !canGenerate()"
              class="flex-1 bg-gradient-to-r from-[#e5730a] to-orange-400 text-white text-xs font-bold py-2.5 rounded-xl shadow disabled:opacity-50 disabled:cursor-not-allowed">
              <span x-show="!loading">Generar plan</span>
              <span x-show="loading" class="flex items-center justify-center gap-2">
                <svg class="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 12a9 9 0 1 1-6.2-8.5"/></svg>
                <span x-text="phase"></span>
              </span>
            </button>
            <button @click="publish()" :disabled="!preview || publishing"
              class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold py-2.5 px-4 rounded-xl shadow disabled:opacity-40">
              <span x-show="!publishing">Publicar</span>
              <span x-show="publishing">Publicando…</span>
            </button>
          </div>
        </div>

        <!-- Top-level metrics -->
        <template x-if="preview">
          <div class="grid grid-cols-3 gap-2 text-center text-xs">
            <div class="bg-white rounded-xl p-2 border border-slate-100">
              <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Visitas</div>
              <div class="text-lg font-black text-slate-800" x-text="preview.metrics?.assignments_count || 0"></div>
            </div>
            <div class="bg-white rounded-xl p-2 border border-slate-100">
              <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Min ruta</div>
              <div class="text-lg font-black text-slate-800" x-text="(preview.metrics?.total_drive_minutes||0) + (preview.metrics?.total_service_minutes||0)"></div>
            </div>
            <div class="bg-white rounded-xl p-2 border border-slate-100">
              <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">⚠ Caution</div>
              <div class="text-lg font-black text-rose-600" x-text="preview.metrics?.caution_arcs || 0"></div>
            </div>
          </div>
        </template>

        <!-- Per-rep cards (post-generate) -->
        <template x-if="preview">
          <div class="space-y-2">
            <template x-for="(rep, idx) in repCards" :key="rep.user_id">
              <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-3 mz-slide-in"
                   @dragover.prevent="$el.classList.add('mz-drop-target')"
                   @dragleave="$el.classList.remove('mz-drop-target')"
                   @drop="onDropRep($event, rep.user_id, $el)">
                <div class="flex items-center gap-3">
                  <span class="mz-avatar flex-shrink-0" :style="'background:' + repColor(idx)" x-text="initials(rep.full_name)"></span>
                  <div class="flex-1 min-w-0">
                    <div class="font-bold text-sm text-slate-800 truncate" x-text="rep.full_name || 'Rep'"></div>
                    <div class="text-[10px] text-slate-500 truncate" x-text="(rep.manager_name ? 'Sup: ' + rep.manager_name : '') + (rep.branch_name ? ' · ' + rep.branch_name : '')"></div>
                    <div class="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
                      <span x-text="rep.stops + ' visitas'"></span>
                      <span>·</span>
                      <span x-text="fmtMin(rep.minutes)"></span>
                      <span x-show="rep.over_cap" class="mz-chip mz-chip-late">+capacidad</span>
                      <span x-show="!rep.has_home" class="mz-chip mz-chip-late">sin home</span>
                    </div>
                    <div class="mt-1 h-1 bg-slate-100 rounded-full overflow-hidden">
                      <div class="h-full" :class="rep.over_cap ? 'bg-rose-500' : 'bg-emerald-500'" :style="'width:' + Math.min(100, rep.minutes / Math.max(1, rep.cap * (preview.plan?.config?.working_days || 1)) * 100) + '%'"></div>
                    </div>
                  </div>
                  <button class="text-[10px] font-bold uppercase tracking-wide text-slate-500" @click="toggleExpand(rep.user_id)">
                    <span x-text="expanded[rep.user_id] ? 'Ocultar' : 'Stops'"></span>
                  </button>
                </div>
                <div x-show="expanded[rep.user_id]" class="mt-3 pl-1 space-y-1.5 max-h-64 overflow-y-auto pr-1">
                  <template x-for="(a, i) in rep.assignments" :key="a.__key">
                    <div class="flex items-center gap-2 text-[11px] py-1 px-2 rounded-lg hover:bg-slate-50 cursor-grab"
                         draggable="true"
                         @dragstart="onDragStop($event, a)"
                         @dragend="$el.classList.remove('mz-drag-ghost')">
                      <span class="mz-chip mz-chip-planned" x-text="(i+1)"></span>
                      <span class="flex-1 truncate" x-text="a.farmacia_nombre || a.cpadre || a.pharmacy_id"></span>
                      <span class="text-slate-400" x-text="fmtMin(a.expected_travel_minutes || 0)"></span>
                    </div>
                  </template>
                </div>
              </div>
            </template>
          </div>
        </template>

        <!-- Empty state: never generated -->
        <template x-if="!preview && !loading">
          <div class="text-center text-xs text-slate-400 py-6 border-2 border-dashed border-slate-200 rounded-2xl">
            Selecciona reps de la jerarquía y presiona <b>Generar plan</b> para ver la previsualización en el mapa.
          </div>
        </template>

        <!-- Empty state: generated but 0 assignments -->
        <template x-if="preview && !preview.assignments?.length">
          <div class="bg-rose-50 border border-rose-200 rounded-2xl p-4 text-xs">
            <div class="font-bold text-rose-700 mb-1">⚠ No se generaron visitas</div>
            <template x-if="!hasTargets()">
              <div class="text-rose-600">Los reps seleccionados no tienen <b>metas de visita</b> configuradas para este período. Ve a la pestaña <b>Cuotas</b> y define las metas diarias por pareto.</div>
            </template>
            <template x-if="hasTargets() && !hasClients()">
              <div class="text-rose-600">Hay metas configuradas pero <b>no hay clientes/prospectos disponibles</b> para el período seleccionado (quizá ya están asignados en otro plan publicado).</div>
            </template>
            <template x-if="hasTargets() && hasClients()">
              <div class="text-rose-600">Las metas y los clientes existen pero ningún rep quedó con pasos asignados. Revisa que los reps seleccionados tengan el rol correcto y visitas permitidas para el pareto disponible.</div>
            </template>
          </div>
        </template>

        <template x-if="preview?.plan?.config?.unassigned?.length">
          <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs">
            <div class="font-bold text-amber-700">⚠ <span x-text="preview.plan.config.unassigned.length"></span> objetivos sin cubrir</div>
            <div class="text-amber-600 mt-1">Algunos reps no alcanzan su cuota Pareto con el pool actual. Revisa capacidad o filtra por sucursal.</div>
          </div>
        </template>
      </div>
    `;
  }

  function planEditorComponent() {
    return {
      loading: false,
      loadingTeam: true,
      publishing: false,
      phase: 'Calculando…',
      periodStart: nextMonday(),
      periodEnd: nextFridayAfter(nextMonday()),
      scopeUserIds: [],
      teamUsers: [],
      hierarchy: { gerentes: [], ungrouped_supervisors: [], orphan_reps: [] },
      expandedGerentes: {},
      expandedSupervisors: {},
      search: '',
      // Inherits the zone selected in Capacidad (or topbar pill) so jumping
      // tabs preserves context. Empty string = sin filtro.
      // '__all__' is a sentinel meaning "no filter" in the analytics layer — normalize to ''.
      zoneFilter: (() => { const z = window.MarzamPlanZone || window.APP?.poblacion || ''; return (z && z !== '__all__') ? z : ''; })(),
      availableZones: [],
      preview: null,
      repCards: [],
      expanded: {},
      _repMeta: new Map(),

      async init() {
        // ── Read preload config from Cuotas tab (if any) ──────────────────
        const preload = window.MarzamPlanPreloadConfig;
        if (preload) {
          window.MarzamPlanPreloadConfig = null; // consume once
          if (preload.poblacion && preload.poblacion !== '__all__') this.zoneFilter = preload.poblacion;
          if (preload.period_start) this.periodStart = preload.period_start;
          if (preload.period_end) this.periodEnd = preload.period_end;
          if (Array.isArray(preload.scope_user_ids) && preload.scope_user_ids.length) {
            this.scopeUserIds = [...preload.scope_user_ids];
          }
        }

        this.loadingTeam = true;
        try {
          // Cargamos team + clients + EFs canónicas en paralelo. Los
          // clientes alimentan dos cosas: (1) la hidratación per-user
          // de poblaciones cuando el backend no la enriquece, y
          // (2) la cobertura de la lista de EFs disponibles.
          const [users, clients, pob] = await Promise.all([
            API.get('/team/descendants').catch(() => API.get('/users?role=representante').catch(() => [])),
            API.get('/marzam/clients?limit=2000').catch(() => []),
            API.get('/poblaciones').catch(() => null),
          ]);
          this.teamUsers = (users || []);
          const clientList = Array.isArray(clients) ? clients : (clients?.clients || clients?.rows || clients?.data || []);
          // Hidrata u.poblaciones desde rep_code/supervisor_code/gerencia_code
          // de cada cliente cuando el backend no pudo (gap de assigned_*_id).
          if (window.MarzamEF?.hydrateTeam) window.MarzamEF.hydrateTeam(this.teamUsers, clientList);
          this.hierarchy = buildHierarchy(this.teamUsers);
          // Universo de EFs: une lo que CADA usuario sirve hoy (post-hidratación)
          // con la lista canónica del padrón. Display deduplicado preservando
          // acentos canónicos vía window.MarzamEF.dedup.
          const raw = [];
          for (const u of this.teamUsers) for (const z of (u.poblaciones || [])) raw.push(z);
          for (const c of clientList) if (c.poblacion) raw.push(c.poblacion);
          if (pob?.options) for (const o of pob.options) if (o?.value && o.value !== '__all__') raw.push(o.value);
          this.availableZones = window.MarzamEF?.dedup ? window.MarzamEF.dedup(raw) : [...new Set(raw.filter(Boolean))].sort();
          // Auto-expand if few groups so the user immediately sees the tree.
          const supTotal = this.hierarchy.gerentes.reduce((s, g) => s + g.supervisors.length, 0)
            + this.hierarchy.ungrouped_supervisors.length;
          if (supTotal <= 4) {
            this.hierarchy.gerentes.forEach((g) => {
              this.expandedGerentes[g.id] = true;
              g.supervisors.forEach((s) => { this.expandedSupervisors[s.id] = true; });
            });
            this.hierarchy.ungrouped_supervisors.forEach((s) => { this.expandedSupervisors[s.id] = true; });
          }
        } catch (err) {
          console.warn('[plan-editor] init failed', err);
        } finally {
          this.loadingTeam = false;
        }
      },

      // True cuando el usuario sirve la Entidad Federativa seleccionada.
      // Fuente: array `poblaciones` (de `marzam_clients.poblacion` join via
      // assigned_rep_id / supervisor / gerente). Un usuario sin farmacias
      // asignadas en la EF activa se oculta — no tendría sentido asignarle
      // visitas en una zona donde no tiene cartera.
      _userInZone(u) {
        if (!this.zoneFilter || this.zoneFilter === '__all__') return true;
        const efKey = window.MarzamEF ? window.MarzamEF.key : ((s) => String(s || '').trim().toLowerCase());
        const target = efKey(this.zoneFilter);
        const list = Array.isArray(u.poblaciones) ? u.poblaciones : [];
        // Strict: when a zone filter is active and the backend has already
        // populated poblaciones from detalle_mostrador, users with no zone
        // data are excluded so that the cascade hides off-zone branches.
        if (!list.length) return false;
        return list.map(efKey).includes(target);
      },

      // Make idsUnder accessible from the template.
      idsUnder,

      get visibleHierarchy() {
        // Cascade zone filter: every node (rep, supervisor, gerente) is tested
        // individually against _userInZone.  A manager stays visible only if
        // it has at least one descendant that survives the zone filter.
        // All nodes with empty poblaciones are hidden while a filter is active
        // (strict mode) so off-zone branches don't bleed into the view.
        const q = (this.search || '').toLowerCase();
        const matchesText = (u) => !q
          || (u.full_name || '').toLowerCase().includes(q)
          || (u.employee_code || '').toLowerCase().includes(q)
          || (u.branch_name || '').toLowerCase().includes(q)
          || ((u.poblaciones || []).join(' ').toLowerCase().includes(q));
        const inZone = (u) => this._userInZone(u);

        // A rep is kept if it matches the text search AND its own zone.
        const keepRep = (u) => matchesText(u) && inZone(u);

        // Filter a supervisor's rep list; the supervisor itself is kept only
        // if it is in zone OR if it has surviving reps in zone.
        const filterSup = (sup) => {
          const reps = sup.reps.filter(keepRep);
          return { ...sup, reps };
        };
        const keepSup = (s) => s.reps.length > 0 || (matchesText(s) && inZone(s));

        const gerentes = this.hierarchy.gerentes.map((g) => {
          const supervisors = g.supervisors.map(filterSup).filter(keepSup);
          const directReps = (g.directReps || []).filter(keepRep);
          return { ...g, supervisors, directReps };
        }).filter((g) => g.supervisors.length > 0
          || (g.directReps || []).length > 0
          || (matchesText(g) && (inZone(g) || !this.zoneFilter)));

        const ungrouped_supervisors = this.hierarchy.ungrouped_supervisors
          .map(filterSup).filter(keepSup);
        const orphan_reps = this.hierarchy.orphan_reps.filter(keepRep);
        return { gerentes, ungrouped_supervisors, orphan_reps };
      },
      get selectionLabel() {
        const sel = this.scopeUserIds.length;
        const total = this.teamUsers.filter((u) => u.is_active !== false && !u.synthetic_id && !this.isVacancy(u)).length;
        return `${sel} seleccionado${sel === 1 ? '' : 's'} de ${total}`;
      },
      get repsWithoutHomeCount() {
        const set = new Set(this.scopeUserIds);
        return this.teamUsers
          .filter((u) => set.has(u.id) && (u.role || '').toLowerCase() === 'representante' && !u.has_home)
          .length;
      },
      isVacancy(u) {
        const name = String(u?.full_name || '').trim();
        return !name || /^vacante$/i.test(name);
      },
      totalUnder(g) {
        return 1 // gerente itself
          + g.supervisors.length
          + g.supervisors.reduce((s, sup) => s + sup.reps.length, 0)
          + (g.directReps?.length || 0);
      },
      toggleGerente(id) {
        const cur = this.expandedGerentes[id];
        this.expandedGerentes = { ...this.expandedGerentes, [id]: cur === false ? true : false };
      },
      toggleSupervisor(id) {
        const cur = this.expandedSupervisors[id];
        this.expandedSupervisors = { ...this.expandedSupervisors, [id]: cur === false ? true : false };
      },
      // Returns 'all', 'some', or 'none' based on which of `ids` are in scope.
      checkboxState(ids) {
        if (!ids.length) return 'none';
        const set = new Set(this.scopeUserIds);
        const inScope = ids.filter((id) => set.has(id)).length;
        if (inScope === 0) return 'none';
        if (inScope === ids.length) return 'all';
        return 'some';
      },
      bulkToggle(ids, shouldCheck) {
        const set = new Set(this.scopeUserIds);
        if (shouldCheck) ids.forEach((id) => set.add(id));
        else ids.forEach((id) => set.delete(id));
        this.scopeUserIds = [...set];
      },
      selectAll() {
        // Honor the zone filter: "Todos" picks all valid users IN the
        // currently visible scope, not the entire team. Otherwise users
        // would unexpectedly bulk-select people from other zones.
        this.scopeUserIds = this.teamUsers
          .filter((u) => u.is_active !== false && !u.synthetic_id && !this.isVacancy(u) && this._userInZone(u))
          .map((u) => u.id);
      },
      clearAll() { this.scopeUserIds = []; },

      canGenerate() {
        return Array.isArray(this.scopeUserIds) && this.scopeUserIds.length > 0
          && this.periodStart && this.periodEnd && this.periodStart <= this.periodEnd;
      },
      hasTargets() {
        const snap = this.preview?.plan?.config?.targets_snapshot || {};
        return Object.values(snap).some(
          (t) => ['A', 'B', 'C'].some((p) => (t?.marzam?.[p] || 0) > 0)
              || ['A', 'B', 'C', 'D'].some((p) => (t?.prospecto?.[p] || 0) > 0),
        );
      },
      hasClients() {
        const counts = this.preview?.plan?.config?.candidate_counts || {};
        return (counts.A || 0) + (counts.B || 0) + (counts.C || 0) + (counts.prospects || 0) > 0;
      },
      async generatePreview() {
        if (!this.canGenerate()) return;
        this.loading = true;
        this.phase = 'Resolviendo metas…';
        try {
          const result = await API.post('/visit-plans/preview-full', {
            scope_user_ids: this.scopeUserIds,
            period_start: this.periodStart,
            period_end: this.periodEnd,
            granularity: 'weekly',
          });
          this.phase = 'Calculando rutas…';
          const assignments = (result.assignments || []).map((a, i) => ({
            ...a,
            __key: `${a.visitor_user_id}|${a.scheduled_date}|${a.route_order}|${i}`,
            __lat: null, __lng: null,
          }));
          this.preview = { ...result, assignments };
          this._repMeta = new Map();
          for (const u of this.teamUsers) {
            this._repMeta.set(u.id, {
              full_name: u.full_name,
              home_lat: u.home_lat,
              home_lng: u.home_lng,
              has_home: u.has_home,
              manager_name: u.manager_name,
              branch_name: u.branch_name,
              daily_minutes_cap: u.daily_minutes_cap || 480,
              service_minutes_per_stop: u.service_minutes_per_stop || 45,
            });
          }
          this.repCards = this._buildRepCards();
          this.phase = 'Dibujando mapa…';
          drawPreview(APP.map, this.preview, this._repMeta);
          const cost = result._cost;
          const costNote = (cost && cost.estimated_usd != null)
            ? ` · ~$${Number(cost.estimated_usd).toFixed(4)} USD Google API`
            : '';
          if (!assignments.length) {
            const snap = result.plan?.config?.targets_snapshot || {};
            const counts = result.plan?.config?.candidate_counts || {};
            const anyTarget = Object.values(snap).some(
              (t) => ['A', 'B', 'C'].some((p) => (t?.marzam?.[p] || 0) > 0)
                  || ['A', 'B', 'C', 'D'].some((p) => (t?.prospecto?.[p] || 0) > 0),
            );
            const anyClient = (counts.A || 0) + (counts.B || 0) + (counts.C || 0) + (counts.prospects || 0) > 0;
            const hint = !anyTarget
              ? ' · sin metas de visita — configúralas en la pestaña Cuotas'
              : !anyClient
                ? ' · sin clientes/prospectos disponibles para el período'
                : '';
            window.MarzamToast?.show(`Sin visitas generadas${hint}`, 'danger');
          } else {
            window.MarzamToast?.show(`Plan tentativo listo · revisa el mapa${costNote}`, 'success');
          }
        } catch (err) {
          console.error(err);
          const msg = err?.error || err?.message || (typeof err === 'string' ? err : 'Error desconocido');
          window.MarzamToast?.show('No se pudo generar la previsualización: ' + msg, 'danger');
        } finally {
          this.loading = false;
          this.phase = 'Calculando…';
        }
      },
      _buildRepCards() {
        const byUser = new Map();
        for (const a of this.preview.assignments) {
          if (!byUser.has(a.visitor_user_id)) byUser.set(a.visitor_user_id, []);
          byUser.get(a.visitor_user_id).push(a);
        }
        const cards = [];
        for (const [userId, list] of byUser.entries()) {
          const meta = this._repMeta.get(userId) || {};
          const minutes = list.reduce((s, a) => s + (a.expected_travel_minutes || 0) + (a.expected_service_minutes || 0), 0);
          const cap = meta.daily_minutes_cap || 480;
          const workingDays = this.preview.plan?.config?.working_days || 1;
          cards.push({
            user_id: userId,
            full_name: meta.full_name || 'Rep',
            manager_name: meta.manager_name,
            branch_name: meta.branch_name,
            has_home: meta.has_home !== false,
            stops: list.length,
            minutes,
            cap,
            over_cap: minutes > cap * workingDays,
            assignments: list.sort((a, b) => (a.scheduled_date < b.scheduled_date ? -1 : a.scheduled_date > b.scheduled_date ? 1 : a.route_order - b.route_order)),
          });
        }
        return cards.sort((a, b) => b.stops - a.stops);
      },
      repColor(idx) { return colorFor(idx); },
      initials,
      fmtMin,
      toggleExpand(userId) { this.expanded = { ...this.expanded, [userId]: !this.expanded[userId] }; },
      onDragStop(ev, assignment) {
        ev.dataTransfer.setData('text/plain', JSON.stringify({ key: assignment.__key, id: assignment.id, src: assignment.visitor_user_id }));
        ev.target.classList.add('mz-drag-ghost');
      },
      async onDropRep(ev, destUserId, el) {
        ev.preventDefault();
        el.classList.remove('mz-drop-target');
        let payload;
        try { payload = JSON.parse(ev.dataTransfer.getData('text/plain') || '{}'); } catch { return; }
        if (!payload || payload.src === destUserId) return;
        const a = this.preview.assignments.find((x) => x.__key === payload.key);
        if (!a) return;
        a.visitor_user_id = destUserId;
        this.repCards = this._buildRepCards();
        drawPreview(APP.map, this.preview, this._repMeta);
        window.MarzamToast?.show('Stop reasignado (preview)', 'info');
      },
      async publish() {
        if (!this.preview) return;
        this.publishing = true;
        try {
          const created = await API.post('/visit-plans', {
            scope_user_ids: this.scopeUserIds,
            granularity: 'weekly',
            period_start: this.periodStart,
            period_end: this.periodEnd,
            name: `Plan ${this.periodStart} → ${this.periodEnd}`,
          });
          await API.patch(`/visit-plans/${created.plan.id}/publish`, {});
          window.MarzamToast?.show('Plan publicado · reps lo verán en su app', 'success');
          this.preview = null;
          this.repCards = [];
          clearLayers();
        } catch (err) {
          const msg = err?.error || err?.message || 'Error desconocido';
          window.MarzamToast?.show('No se pudo publicar: ' + msg, 'danger');
        } finally {
          this.publishing = false;
        }
      },
    };
  }

  function nextMonday() {
    const d = new Date();
    const dow = d.getDay();
    const delta = ((1 - dow) + 7) % 7 || 7;
    d.setDate(d.getDate() + delta);
    return d.toISOString().slice(0, 10);
  }
  function nextFridayAfter(monIso) {
    const d = new Date(monIso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 4);
    return d.toISOString().slice(0, 10);
  }

  document.addEventListener('alpine:init', () => {
    if (window.Alpine?.data) window.Alpine.data('planEditor', planEditorComponent);
  });
  if (window.Alpine?.data) window.Alpine.data('planEditor', planEditorComponent);

  window.MarzamViews = window.MarzamViews || {};
  window.MarzamViews.renderPlanEditor = renderPlanEditor;
})();
