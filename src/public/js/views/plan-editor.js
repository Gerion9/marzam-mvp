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
  const SRC_OVERLAY_CAUTION = 'plan-editor-overlay-caution';
  const SRC_OVERLAY_BLOCKED = 'plan-editor-overlay-blocked';

  function colorFor(idx) { return REP_COLORS[idx % REP_COLORS.length]; }

  // Helper: ¿hay al menos UN target > 0 en el snapshot?
  // Estructura per-day desde mig 074: { userId: { dayIso: { marzam: {A,B,C}, prospecto: {A,B,C,D} } } }.
  // Antes había un bug que iteraba un nivel arriba y siempre devolvía false,
  // disparando "sin metas de visita" aunque la matriz 1.B sí tuviera valores.
  function _anyTargetInSnap(snap) {
    if (!snap || typeof snap !== 'object') return false;
    for (const byDay of Object.values(snap)) {
      if (!byDay || typeof byDay !== 'object') continue;
      for (const t of Object.values(byDay)) {
        const m = t?.marzam || {};
        const p = t?.prospecto || {};
        if ((m.A || 0) + (m.B || 0) + (m.C || 0) > 0) return true;
        if ((p.A || 0) + (p.B || 0) + (p.C || 0) + (p.D || 0) > 0) return true;
      }
    }
    return false;
  }

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

  function clearOverlays() {
    const map = APP.map; if (!map) return;
    [SRC_OVERLAY_CAUTION, SRC_OVERLAY_BLOCKED].forEach((srcId) => {
      ['fill', 'line'].forEach((kind) => {
        const id = `${srcId}-${kind}`;
        if (map.getLayer(id)) map.removeLayer(id);
      });
      if (map.getSource(srcId)) map.removeSource(srcId);
    });
  }

  async function drawSecurityOverlays(map) {
    clearOverlays();
    if (!map) return;
    // Use the current map bounds as bbox.
    const b = map.getBounds();
    const bbox = `${b.getWest().toFixed(5)},${b.getSouth().toFixed(5)},${b.getEast().toFixed(5)},${b.getNorth().toFixed(5)}`;
    try {
      const [caution, blocked] = await Promise.all([
        API.get(`/colonias/geojson?security_level=caution&bbox=${bbox}`),
        API.get(`/colonias/geojson?security_level=not_acceptable&bbox=${bbox}`),
      ]);
      if (caution?.features?.length) {
        map.addSource(SRC_OVERLAY_CAUTION, { type: 'geojson', data: caution });
        map.addLayer({ id: `${SRC_OVERLAY_CAUTION}-fill`, type: 'fill', source: SRC_OVERLAY_CAUTION,
          paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.18 } });
        map.addLayer({ id: `${SRC_OVERLAY_CAUTION}-line`, type: 'line', source: SRC_OVERLAY_CAUTION,
          paint: { 'line-color': '#d97706', 'line-width': 1.4, 'line-opacity': 0.7 } });
      }
      if (blocked?.features?.length) {
        map.addSource(SRC_OVERLAY_BLOCKED, { type: 'geojson', data: blocked });
        map.addLayer({ id: `${SRC_OVERLAY_BLOCKED}-fill`, type: 'fill', source: SRC_OVERLAY_BLOCKED,
          paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.22 } });
        map.addLayer({ id: `${SRC_OVERLAY_BLOCKED}-line`, type: 'line', source: SRC_OVERLAY_BLOCKED,
          paint: { 'line-color': '#991b1b', 'line-width': 1.6, 'line-opacity': 0.8 } });
      }
    } catch (err) {
      console.warn('[plan-editor] security overlays failed', err);
    }
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
  // Total time across all reps formatted for the hero card. Days
  // assumption: if > 8h*60min we surface "X días-rep equivalentes" as
  // a secondary read so the manager sees "no es 50h corridas, son 6
  // reps × 8h aprox".
  function fmtTimeTotal(min) {
    if (!min || isNaN(min)) return '0 min';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    if (h < 1) return `${m} min`;
    if (h < 24) return `${h}h ${m}m`;
    const d = (h / 8).toFixed(1);
    return `${h}h (~${d} jornadas-rep)`;
  }
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
        <!-- Header del paso 2 -->
        <div class="plan-substep-header" style="margin-bottom: 0.5rem;">
          <span class="plan-substep-badge" style="background:#fed7aa; color:#c2410c;">2</span>
          <div class="plan-substep-text">
            <h3 class="plan-substep-title">Generar plan: asignar farmacias y fechas</h3>
            <p class="plan-substep-hint">Selecciona el equipo, define el período y revisa la previsualización en el mapa antes de publicar.</p>
          </div>
        </div>

        <!-- ── Banda 1: Antes de generar (pre-flight checklist) ──── -->
        <div class="plan-band plan-band--preflight">
          <div class="plan-band__header">
            <span class="plan-band__num">1</span>
            <div>
              <div class="plan-band__title">Antes de generar</div>
              <div class="plan-band__hint">Revisa que todo esté listo. Las advertencias en ámbar no bloquean, las rojas sí.</div>
            </div>
          </div>
          <ul class="plan-preflight">
            <li class="plan-preflight__item" :class="zoneFilter ? 'is-ok' : 'is-warn'">
              <span class="plan-preflight__check" x-text="zoneFilter ? '✓' : '○'"></span>
              <span class="plan-preflight__text">
                <b>Zona</b>: <span x-text="zoneFilter || 'Toda la sucursal (sin filtro)'"></span>
              </span>
            </li>
            <li class="plan-preflight__item" :class="(periodStart && periodEnd) ? 'is-ok' : 'is-bad'">
              <span class="plan-preflight__check" x-text="(periodStart && periodEnd) ? '✓' : '✗'"></span>
              <span class="plan-preflight__text">
                <b>Período</b>: <span x-text="(periodStart && periodEnd) ? (periodStart + ' → ' + periodEnd) : 'Falta seleccionar fechas'"></span>
              </span>
            </li>
            <li class="plan-preflight__item" :class="scopeUserIds.length > 0 ? 'is-ok' : 'is-bad'">
              <span class="plan-preflight__check" x-text="scopeUserIds.length > 0 ? '✓' : '✗'"></span>
              <span class="plan-preflight__text">
                <b>Equipo</b>: <span x-text="scopeUserIds.length > 0 ? (scopeUserIds.length + ' rep(s) seleccionado(s)') : 'Selecciona al menos un rep abajo'"></span>
              </span>
            </li>
            <li class="plan-preflight__item" :class="repsWithoutHomeCount > 0 ? 'is-warn' : 'is-ok'" x-show="scopeUserIds.length > 0">
              <span class="plan-preflight__check" x-text="repsWithoutHomeCount > 0 ? '⚠' : '✓'"></span>
              <span class="plan-preflight__text">
                <b>Domicilio rep</b>: <span x-text="repsWithoutHomeCount > 0 ? (repsWithoutHomeCount + ' sin domicilio · usaré primer GPS') : 'Todos con domicilio guardado'"></span>
              </span>
            </li>
          </ul>
        </div>

        <!-- ── Banda 2: Configuración + Generar ──── -->
        <div class="plan-band plan-band--config">
          <div class="plan-band__header">
            <span class="plan-band__num">2</span>
            <div>
              <div class="plan-band__title">Configurar y generar</div>
              <div class="plan-band__hint">Ajusta período y selección, luego presiona Generar para ver la previsualización.</div>
            </div>
          </div>

          <!-- Status chips: quota / budget / cost estimate. Visible siempre.
               Colores: gris = sin data, verde = OK, amber = atención, rose = crítico. -->
          <div class="mz-plan-chips" role="status">
            <span class="mz-status-chip" :class="'mz-status-chip--' + quotaChipColor()"
                  :title="planQuota ? ('Restantes: ' + planQuota.remaining + ' · Resetea ' + (planQuota.reset_at||'').slice(11,16) + ' UTC') : ''"
                  x-text="quotaChipText()"></span>
            <span class="mz-status-chip" :class="'mz-status-chip--' + budgetChipColor()"
                  :title="budgetStatus ? 'Presupuesto Routes API · ' + budgetChipColor() : ''"
                  x-text="budgetChipText()"></span>
            <span class="mz-status-chip mz-status-chip--slate"
                  :title="costEstimate ? ('Elementos billables: ' + (costEstimate.matrix_elements||0)) : ''"
                  x-text="costChipText()"></span>
          </div>

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

            <!-- Mobile: trigger button to open full-screen bottom-sheet -->
            <button type="button" class="md:hidden mt-2 w-full px-4 py-3 bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2"
                    @click="pickerOpen = true" x-show="!loadingTeam">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              Seleccionar equipo (<span x-text="scopeUserIds.length"></span>)
            </button>

            <!-- Bottom-sheet overlay backdrop (móvil cuando abierto) -->
            <div x-show="isMobile && pickerOpen" class="fixed inset-0 z-40 bg-slate-900/40" @click="pickerOpen = false" style="display:none"></div>

            <!-- Tree container:
                   - desktop: inline scrollable list (estado original)
                   - mobile cerrado: oculto (trigger button mostrado arriba)
                   - mobile abierto: full-screen bottom-sheet con header/footer fijos -->
            <div :class="{
                   'fixed inset-x-0 bottom-0 top-12 z-50 bg-white rounded-t-2xl flex flex-col': isMobile && pickerOpen,
                   'hidden': isMobile && !pickerOpen,
                   'mt-2': !isMobile
                 }">
              <!-- Mobile sheet header -->
              <div x-show="isMobile && pickerOpen" class="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-white sticky top-0" style="display:none">
                <div>
                  <div class="text-sm font-bold text-slate-800">Seleccionar equipo</div>
                  <div class="text-[11px] text-slate-500" x-text="scopeUserIds.length + ' rep(s) seleccionado(s)'"></div>
                </div>
                <button @click="pickerOpen = false" class="px-3 py-1.5 text-sm font-bold text-slate-600 hover:bg-slate-100 rounded-lg">✕ Cerrar</button>
              </div>

              <div :class="{
                     'flex-1 overflow-y-auto p-4 space-y-1.5': isMobile && pickerOpen,
                     'max-h-72 overflow-y-auto pr-1 space-y-1.5': !(isMobile && pickerOpen)
                   }">
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
                          <span class="mz-chip" style="background:#fef3c7;color:#92400e"
                            x-text="actorIsGerente ? 'Sin supervisor (reportan a ti)' : 'Reportan directo al gerente'"></span>
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

              <!-- Mobile sheet footer: confirm button -->
              <div x-show="isMobile && pickerOpen" class="border-t border-slate-200 bg-white px-4 py-3 sticky bottom-0" style="display:none">
                <button @click="pickerOpen = false" class="w-full px-4 py-3 bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-sm font-bold">
                  Listo (<span x-text="scopeUserIds.length"></span> seleccionados)
                </button>
              </div>
            </div>
          </div>

          <!-- Pre-flight warnings -->
          <template x-if="scopeUserIds.length > 0 && repsWithoutHomeCount > 0">
            <div class="mt-3 bg-amber-50 border border-amber-200 rounded-xl p-2.5 text-[11px]">
              <div class="font-bold text-amber-700">⚠ <span x-text="repsWithoutHomeCount"></span> rep(s) sin domicilio guardado</div>
              <div class="text-amber-600 mt-0.5">Se usará su primera ubicación GPS al abrir la app. La asignación geográfica para esos reps caerá en round-robin hasta que tengan home.</div>
            </div>
          </template>

          <!-- Filtros avanzados (Fase 7) — colapsable. Skill picker filtra
               localmente el scope antes de generar; Pareto weight y hard
               windows quedan como placeholders UX (backend recibe wiring
               cuando el cliente confirme los valores exactos). -->
          <div class="mt-3 border-t border-slate-100 pt-3">
            <button type="button" @click="advFiltersOpen = !advFiltersOpen"
              class="text-[11px] font-bold uppercase tracking-wide text-slate-500 hover:text-slate-700 flex items-center gap-1.5">
              <span x-text="advFiltersOpen ? '▼' : '▶'"></span>
              Filtros avanzados
              <span class="text-[10px] font-normal text-slate-400 normal-case" x-show="!advFiltersOpen">— skills / Pareto / horarios</span>
            </button>
            <div x-show="advFiltersOpen" x-cloak class="mt-2 space-y-2.5">
              <div>
                <label class="text-[10px] font-bold uppercase tracking-wide text-slate-500 block mb-1">Skill requerida</label>
                <div class="flex gap-1.5 flex-wrap">
                  <button type="button" @click="skillFilter = 'any'"
                    class="text-[11px] px-2 py-1 rounded-full border"
                    :class="skillFilter === 'any' ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-slate-600 border-slate-200'">
                    Cualquiera
                  </button>
                  <button type="button" @click="skillFilter = 'new_pharmacy_capture'"
                    class="text-[11px] px-2 py-1 rounded-full border"
                    :class="skillFilter === 'new_pharmacy_capture' ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-slate-600 border-slate-200'">
                    Captación nuevas
                  </button>
                  <button type="button" @click="skillFilter = 'marzam_maintenance'"
                    class="text-[11px] px-2 py-1 rounded-full border"
                    :class="skillFilter === 'marzam_maintenance' ? 'bg-orange-500 text-white border-orange-500' : 'bg-white text-slate-600 border-slate-200'">
                    Mantenimiento Marzam
                  </button>
                </div>
                <p class="text-[10px] text-slate-400 mt-1 italic" x-show="skillFilter !== 'any'">
                  Solo se considerarán reps cuyo perfil tenga esta skill (o sin skills declaradas).
                </p>
              </div>
              <div>
                <label class="text-[10px] font-bold uppercase tracking-wide text-slate-500 block mb-1">Peso Pareto</label>
                <select x-model="paretoWeight" class="text-[11px] bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 outline-none">
                  <option value="pareto-first">Priorizar A&gt;B&gt;C&gt;D (sacrificar manejo)</option>
                  <option value="balanced">Balanceado (default)</option>
                  <option value="shortest-drive">Minimizar manejo (sacrificar Pareto)</option>
                </select>
                <p class="text-[10px] text-slate-400 mt-1 italic">Solo aplica con Optimization API activo. El solver clásico usa balanced.</p>
              </div>
              <label class="flex items-center gap-2 text-[11px]">
                <input type="checkbox" x-model="hardWindowsEnforced" class="accent-orange-500">
                <span>Respetar horarios duros de farmacia</span>
                <span class="text-[10px] text-slate-400 italic">(requiere PLAN_HARD_WINDOWS_ENFORCED en backend)</span>
              </label>
            </div>
          </div>

          <div class="mt-3 flex items-center gap-2">
            <button @click="generatePreview()" :disabled="loading || !canGenerate() || (planQuota && planQuota.exceeded)"
              class="flex-1 bg-gradient-to-r from-[#e5730a] to-orange-400 text-white text-xs font-bold py-2.5 rounded-xl shadow disabled:opacity-50 disabled:cursor-not-allowed">
              <span x-show="!loading">Generar plan</span>
              <span x-show="loading" class="flex items-center justify-center gap-2">
                <svg class="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 12a9 9 0 1 1-6.2-8.5"/></svg>
                <span x-text="phase"></span>
              </span>
            </button>
          </div>
          <p class="text-[10px] text-slate-400 mt-1.5 italic" x-show="planQuota && planQuota.exceeded">
            Alcanzaste tu límite diario de planes — espera al reset para generar otro.
          </p>
        </div>

        <!-- Quota exceeded modal — surfaces the 429 backend response with
             reset_at + admin contact hint. -->
        <template x-if="quotaModal">
          <div class="mz-quota-modal-overlay" @click="closeQuotaModal()">
            <div class="mz-quota-modal" @click.stop>
              <div class="mz-quota-modal__title">⛔ Límite diario de planes alcanzado</div>
              <p class="mz-quota-modal__body">
                Has generado <strong x-text="quotaModal.used_today"></strong> de
                <strong x-text="quotaModal.daily_limit"></strong> planes permitidos hoy.
                <br><br>
                Las cuotas se resetean a las <strong x-text="(quotaModal.reset_at || '').slice(11, 16)"></strong> UTC.
                Si necesitas más planes hoy, contacta a un administrador para ajustar el límite de tu sucursal.
              </p>
              <button @click="closeQuotaModal()" class="mz-quota-modal__btn">Entendido</button>
            </div>
          </div>
        </template>
        </div><!-- end plan-band--config -->

        <!-- ── Banda 3: Publicar (solo cuando hay preview) ──── -->
        <template x-if="preview">
          <div class="plan-band plan-band--publish">
            <div class="plan-band__header">
              <span class="plan-band__num">3</span>
              <div>
                <div class="plan-band__title">Revisar y publicar</div>
                <div class="plan-band__hint">Antes de publicar, revisa el resumen abajo. Una vez publicado los reps lo verán en su app.</div>
              </div>
            </div>

            <!-- Hero card de métricas (antes 3 KPIs minúsculos) -->
            <div class="plan-hero">
              <div class="plan-hero__main">
                <div class="plan-hero__num" x-text="(preview.metrics?.assignments_count || 0).toLocaleString()"></div>
                <div class="plan-hero__label">visitas planificadas</div>
              </div>
              <div class="plan-hero__grid">
                <div>
                  <div class="plan-hero__sub" x-text="fmtTimeTotal((preview.metrics?.total_drive_minutes||0) + (preview.metrics?.total_service_minutes||0))"></div>
                  <div class="plan-hero__sublabel">tiempo total estimado</div>
                </div>
                <div>
                  <div class="plan-hero__sub" x-text="(preview.metrics?.unique_pharmacies || preview.metrics?.assignments_count || 0)"></div>
                  <div class="plan-hero__sublabel">farmacias distintas</div>
                </div>
                <div>
                  <div class="plan-hero__sub" :class="(preview.metrics?.caution_arcs || 0) > 0 ? 'text-rose-600' : ''" x-text="preview.metrics?.caution_arcs || 0"></div>
                  <div class="plan-hero__sublabel">arcos con cautela</div>
                </div>
              </div>
              <button @click="publish()" :disabled="!preview || publishing"
                class="plan-hero__publish">
                <span x-show="!publishing">Publicar plan ahora</span>
                <span x-show="publishing" class="flex items-center justify-center gap-2">
                  <svg class="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M21 12a9 9 0 1 1-6.2-8.5"/></svg>
                  Publicando…
                </span>
              </button>
              <p class="plan-hero__caveat">Una vez publicado, los reps reciben sus rutas en la app móvil.</p>
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

        <!-- ── PR8: Emergency button (only when plan is published) ───────── -->
        <template x-if="preview?.plan?.status === 'published'">
          <div class="flex items-center gap-2">
            <button @click="openEmergencyPanel('breakdown')"
              class="flex-1 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 text-xs font-bold py-2 rounded-xl">
              🚨 Reportar avería
            </button>
            <button @click="openEmergencyPanel('urgent')"
              class="flex-1 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-700 text-xs font-bold py-2 rounded-xl">
              ⚡ Pedido urgente
            </button>
          </div>
        </template>

        <!-- ── PR8: Cost meta chip (extended) ────────────────────────────── -->
        <template x-if="preview && costMeta.cache_hit_rate !== null">
          <div class="bg-slate-50 border border-slate-200 rounded-xl p-2 text-[11px] text-slate-600 flex flex-wrap gap-x-3 gap-y-1"
               :title="'Cache hit ' + costMeta.cache_hit_rate + '%, modo ' + costMeta.traffic_mode + ', solver ' + costMeta.solver_strategy">
            <span><b>Cache:</b> <span x-text="costMeta.cache_hit_rate + '%'"></span></span>
            <span><b>Tráfico:</b> <span x-text="costMeta.traffic_mode"></span></span>
            <span><b>Solver:</b> <span x-text="costMeta.solver_strategy"></span></span>
            <template x-if="costMeta.variance_minutes !== null">
              <span :class="costMeta.variance_minutes > (costMeta.gap_threshold_min || 90) ? 'text-amber-700 font-bold' : ''">
                <b>Δ inter-rep:</b> <span x-text="costMeta.variance_minutes + ' min'"></span>
              </span>
            </template>
          </div>
        </template>

        <!-- ── PR8: cap_exceeded modal ───────────────────────────────────── -->
        <template x-if="capModal.open">
          <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" @click.self="capModal.open = false">
            <div class="bg-white rounded-2xl p-5 max-w-md w-full mx-4 shadow-xl space-y-3">
              <h3 class="text-lg font-black text-rose-700">⚠ Cap excedido</h3>
              <div class="text-xs text-slate-600">
                <div>El rep <b x-text="capModal.payload?.rep?.full_name || capModal.payload?.rep?.id"></b> ya tiene
                  <b x-text="capModal.payload?.rep?.current_minutes"></b> min asignados.</div>
                <div>Esta reasignación lo llevaría a <b x-text="capModal.payload?.rep?.projected_minutes"></b> min (cap <span x-text="capModal.payload?.rep?.cap_minutes"></span>).</div>
              </div>
              <div class="text-xs font-bold text-slate-700 pt-2">Alternativas con headroom:</div>
              <div class="space-y-1.5">
                <template x-for="alt in (capModal.payload?.alternatives || [])" :key="alt.user_id">
                  <button @click="pickCapAlternative(alt.user_id)"
                    class="w-full text-left flex items-center justify-between bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg px-3 py-2 text-xs">
                    <span class="font-bold text-emerald-800" x-text="alt.full_name"></span>
                    <span class="text-emerald-600">
                      <span x-text="alt.headroom_min + ' min libres'"></span> · <span x-text="alt.distance_km + ' km'"></span>
                    </span>
                  </button>
                </template>
                <template x-if="!capModal.payload?.alternatives?.length">
                  <div class="text-xs text-slate-400 italic">Ningún rep con capacidad disponible.</div>
                </template>
              </div>
              <div class="flex gap-2 pt-2">
                <button @click="capModal.open = false"
                  class="flex-1 text-xs font-bold py-2 rounded-xl bg-slate-100 text-slate-700">Cancelar</button>
                <button @click="forceCapReassign()"
                  class="flex-1 text-xs font-bold py-2 rounded-xl bg-rose-600 text-white">Forzar reasignación</button>
              </div>
            </div>
          </div>
        </template>

        <!-- ── PR8: Emergency drawer (breakdown / urgent) ────────────────── -->
        <template x-if="emergency.open">
          <div class="fixed inset-0 z-50 flex items-stretch justify-end bg-black/40" @click.self="closeEmergencyPanel()">
            <div class="bg-white w-full max-w-md h-full overflow-y-auto p-5 space-y-3 shadow-xl">
              <div class="flex items-center justify-between">
                <h3 class="text-lg font-black" x-text="emergency.kind === 'breakdown' ? '🚨 Reportar avería' : '⚡ Pedido urgente'"></h3>
                <button @click="closeEmergencyPanel()" class="text-slate-400 hover:text-slate-600">✕</button>
              </div>

              <label class="block text-xs font-bold text-slate-700">Fecha
                <input type="date" x-model="emergency.date"
                  class="mt-1 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5"/>
              </label>

              <template x-if="emergency.kind === 'breakdown'">
                <label class="block text-xs font-bold text-slate-700">Rep con avería
                  <select x-model="emergency.broken_user_id"
                    class="mt-1 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5">
                    <option value="">— Selecciona —</option>
                    <template x-for="rep in repCards" :key="rep.user_id">
                      <option :value="rep.user_id" x-text="rep.full_name"></option>
                    </template>
                  </select>
                </label>
              </template>

              <template x-if="emergency.kind === 'urgent'">
                <div class="space-y-2">
                  <label class="block text-xs font-bold text-slate-700">Pharmacy ID o Marzam Client ID
                    <input type="text" x-model="emergency.urgent_stop.pharmacy_id" placeholder="pharmacy_id"
                      class="mt-1 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5"/>
                    <input type="text" x-model="emergency.urgent_stop.marzam_client_id" placeholder="marzam_client_id"
                      class="mt-1 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5"/>
                  </label>
                  <label class="block text-xs font-bold text-slate-700">Rep preferido (opcional)
                    <select x-model="emergency.urgent_stop.preferred_user_id"
                      class="mt-1 w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5">
                      <option value="">— Cualquiera con capacidad —</option>
                      <template x-for="rep in repCards" :key="rep.user_id">
                        <option :value="rep.user_id" x-text="rep.full_name"></option>
                      </template>
                    </select>
                  </label>
                </div>
              </template>

              <button @click="submitEmergency()" :disabled="emergency.loading"
                class="w-full bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-bold py-2.5 rounded-xl">
                <span x-show="!emergency.loading">Reoptimizar día</span>
                <span x-show="emergency.loading">Reoptimizando…</span>
              </button>

              <template x-if="emergency.error">
                <div class="bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg p-2" x-text="emergency.error"></div>
              </template>

              <template x-if="emergency.summary">
                <div class="bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-lg p-2 space-y-1">
                  <div class="font-bold">✓ Reoptimización aplicada</div>
                  <div>Locked hard: <b x-text="emergency.summary.locked_hard"></b></div>
                  <div>Locked soft: <b x-text="emergency.summary.locked_soft"></b></div>
                  <div>Movidos: <b x-text="emergency.summary.moved"></b></div>
                  <div x-show="emergency.summary.no_capacity > 0" class="text-amber-700 font-bold">⚠ Sin capacidad: <span x-text="emergency.summary.no_capacity"></span></div>
                  <div class="text-emerald-600 italic"><span x-text="emergency.summary.ms_elapsed"></span> ms</div>
                </div>
              </template>

              <template x-if="emergency.diff && emergency.diff.length">
                <div class="space-y-1.5">
                  <div class="text-xs font-bold text-slate-700">Diff antes/después</div>
                  <template x-for="d in emergency.diff" :key="d.assignment_id">
                    <div class="text-[11px] border border-slate-100 rounded p-1.5 bg-slate-50">
                      <div class="font-bold text-slate-700"><span x-text="d.kind"></span></div>
                      <div class="text-slate-500" x-text="(d.was?.visitor_user_id || '?') + ' → ' + (d.now?.visitor_user_id || '?')"></div>
                      <div class="text-slate-400" x-text="'order ' + (d.was?.route_order || '?') + ' → ' + (d.now?.route_order || '?')"></div>
                    </div>
                  </template>
                </div>
              </template>
            </div>
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
      // Mobile bottom-sheet picker — el árbol jerárquico no cabe en 375 px
      // como inline tree; en móvil se abre full-screen vía botón.
      pickerOpen: false,
      isMobile: (typeof window !== 'undefined' && window.matchMedia)
        ? window.matchMedia('(max-width: 767px)').matches
        : false,
      actorIsGerente: (() => {
        try {
          const role = (window.APP?.user?.role || '').toLowerCase();
          return role === 'gerente_ventas' || role === 'regional_manager' || role === 'gerencia' || role === 'gerente';
        } catch { return false; }
      })(),
      // Inherits the zone selected in Capacidad (or topbar pill) so jumping
      // tabs preserves context. Empty string = sin filtro.
      // '__all__' is a sentinel meaning "no filter" in the analytics layer — normalize to ''.
      zoneFilter: (() => { const z = window.MarzamPlanZone || window.APP?.poblacion || ''; return (z && z !== '__all__') ? z : ''; })(),
      availableZones: [],
      preview: null,
      repCards: [],
      expanded: {},
      _repMeta: new Map(),
      costEstimate: null,
      budgetStatus: null,
      planQuota: null,           // { daily_limit, used_today, remaining, reset_at, exceeded }
      quotaModal: null,          // { daily_limit, used_today, reset_at } when 429 hit
      timeoutWarning: false,     // surfaced when the optimizer fell back to multiStart
      // Advanced filters panel (Fase 7 — UX-only state; backend wiring lands
      // as it gets validated by the client).
      advFiltersOpen: false,
      skillFilter: 'any',        // 'any' | 'new_pharmacy_capture' | 'marzam_maintenance'
      paretoWeight: 'balanced',  // 'pareto-first' | 'balanced' | 'shortest-drive'
      hardWindowsEnforced: false,
      showOverlays: false,
      // PR8: cache hit/miss + solver telemetry shown in the chip tooltip.
      costMeta: {
        cache_hit_rate: null,
        traffic_mode: null,
        solver_strategy: null,
        variance_minutes: null,
      },
      // PR8: emergency drawer state (rep breakdown / urgent insert).
      emergency: {
        open: false,
        kind: 'breakdown',
        broken_user_id: null,
        urgent_stop: { pharmacy_id: null, marzam_client_id: null, preferred_user_id: null, after_assignment_id: null },
        date: null,
        diff: null,
        summary: null,
        loading: false,
        error: null,
      },
      // PR8: cap_exceeded modal with alternatives surfaced from 409 reassign-stop.
      capModal: { open: false, payload: null, originalDrop: null },
      reoptHistory: [],

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
          // En móvil mantenemos gerentes expandidos pero supervisores colapsados:
          // el árbol es demasiado denso para 375 px y el usuario decide qué abrir.
          const supTotal = this.hierarchy.gerentes.reduce((s, g) => s + g.supervisors.length, 0)
            + this.hierarchy.ungrouped_supervisors.length;
          if (supTotal <= 4) {
            this.hierarchy.gerentes.forEach((g) => {
              this.expandedGerentes[g.id] = true;
              g.supervisors.forEach((s) => { this.expandedSupervisors[s.id] = !this.isMobile; });
            });
            this.hierarchy.ungrouped_supervisors.forEach((s) => { this.expandedSupervisors[s.id] = !this.isMobile; });
          }

          // Auto-selección defensiva: si llegamos al editor sin scope precargado
          // (típico al venir del sticky CTA "Listo · Generar plan ahora" del
          // paso 1), pre-seleccionamos todos los reps válidos de la zona activa.
          // Esto refleja la intención natural del usuario ("configuré para esta
          // sucursal → quiero generar plan para esta sucursal") y evita que dé
          // click a Generar con scope vacío y reciba "alcance llegó vacío".
          if (this.scopeUserIds.length === 0 && this.teamUsers.length > 0) {
            this.selectAll();
            if (this.scopeUserIds.length > 0) {
              console.info('[plan-editor] auto-select reps de zona:', {
                zone: this.zoneFilter || '(toda la sucursal)',
                count: this.scopeUserIds.length,
              });
            }
          }
        } catch (err) {
          console.warn('[plan-editor] init failed', err);
        } finally {
          this.loadingTeam = false;
        }

        // Quota + budget chips se cargan en paralelo, no bloquean al user.
        this.loadQuota();
        try { this.budgetStatus = await API.get('/admin/routes-budget'); } catch { /* optional */ }
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
        return _anyTargetInSnap(this.preview?.plan?.config?.targets_snapshot);
      },
      hasClients() {
        const counts = this.preview?.plan?.config?.candidate_counts || {};
        return (counts.A || 0) + (counts.B || 0) + (counts.C || 0) + (counts.prospects || 0) > 0;
      },
      async generatePreview() {
        // Hard-guard reactivo: aunque el botón está :disabled cuando el scope
        // está vacío, Alpine.js puede tener race conditions si el usuario hace
        // click antes que termine de cargar teamUsers o si la lista cambió por
        // un cambio de zona. En lugar de fallar silenciosamente al backend con
        // "el alcance llegó vacío", intentamos auto-seleccionar reps de zona.
        if (!Array.isArray(this.scopeUserIds) || !this.scopeUserIds.length) {
          if (this.teamUsers.length > 0) {
            this.selectAll();
          }
          if (!this.scopeUserIds.length) {
            window.MarzamToast?.show(
              `Selecciona al menos un rep abajo · no hay candidatos en ${this.zoneFilter || 'la sucursal actual'}`,
              'warning'
            );
            return;
          }
          window.MarzamToast?.show(
            `Pre-seleccionados ${this.scopeUserIds.length} rep(s) de ${this.zoneFilter || 'toda la sucursal'} · puedes ajustar abajo o regenerar`,
            'info'
          );
        }
        if (!this.canGenerate()) return;

        // Pre-flight: validar que los IDs sean UUIDs reales antes de pegar al
        // backend. En MODO DEMO el endpoint /team/descendants devuelve usuarios
        // sintéticos (u-rep-001, u-rep-real-N, code:UEA01) que NO existen en
        // la tabla `users` de la BD real. Pegarle al backend con esos IDs es
        // un round-trip inútil que termina en "0 resolved → 0 assignments".
        // En vez de eso, detectamos el caso aquí y damos un diagnóstico claro
        // (incluido si APP está en modo demo, para confirmar el síntoma).
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const realUuidIds = this.scopeUserIds.filter((id) => UUID_RE.test(String(id)));
        const syntheticIds = this.scopeUserIds.filter((id) => !UUID_RE.test(String(id)));
        if (realUuidIds.length === 0 && syntheticIds.length > 0) {
          const isDemo = !!window.APP?.isDemo
            || localStorage.getItem('marzam_demo') === '1';
          console.warn('[plan-editor] scope sin UUIDs reales — abortando POST al backend:', {
            isDemo,
            sample_ids: syntheticIds.slice(0, 5),
            total_synthetic: syntheticIds.length,
            user: window.APP?.user ? {
              id: window.APP.user.id,
              email: window.APP.user.email,
              role: window.APP.user.role,
              data_scope: window.APP.user.data_scope,
            } : null,
          });
          if (isDemo) {
            window.MarzamToast?.show(
              `Modo demo: el generador de plan necesita usuarios reales (UUIDs) en BD. Los ${syntheticIds.length} reps que ves son sintéticos del demo y no se pueden enviar al solver. Para probar el plan, usa una cuenta no-demo.`,
              'danger'
            );
          } else {
            window.MarzamToast?.show(
              `Los ${syntheticIds.length} reps seleccionados no tienen UUID en BD (probablemente están solo en marzam_clients por código). Pídele a IT que dé de alta a estos reps en la tabla users para poder generar plan.`,
              'danger'
            );
          }
          return;
        }
        if (syntheticIds.length > 0 && realUuidIds.length > 0) {
          // Mezclados: avisar pero seguir con los reales.
          console.info('[plan-editor] scope mezclado — usando solo IDs UUID:', {
            real: realUuidIds.length,
            synthetic: syntheticIds.length,
            synthetic_sample: syntheticIds.slice(0, 3),
          });
          window.MarzamToast?.show(
            `Solo se enviarán ${realUuidIds.length}/${this.scopeUserIds.length} reps al backend (los demás son sintéticos sin UUID en BD)`,
            'warning'
          );
          this.scopeUserIds = realUuidIds;
        }

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
          // PR8: surface solver/cache telemetry from result.metrics for the tooltip.
          this._captureCostMeta(result.metrics);
          const cost = result._cost;
          const costNote = (cost && cost.estimated_usd != null)
            ? ` · ~$${Number(cost.estimated_usd).toFixed(4)} USD Google API`
            : '';
          // Load budget + cost estimate (best-effort; OK to fail silently).
          try { this.budgetStatus = await API.get('/admin/routes-budget'); } catch { this.budgetStatus = null; }
          this.loadCostEstimate();
          if (!assignments.length) {
            const snap = result.plan?.config?.targets_snapshot || {};
            const counts = result.plan?.config?.candidate_counts || {};
            const unassigned = result.plan?.config?.unassigned || [];
            // PR: scope_resolution viene del backend (planGenerator) — distingue
            // "el frontend no mandó IDs" de "el backend no encontró usuarios
            // activos para esos IDs en `users` (modo demo / IDs sintéticos /
            // usuarios inactivos)". Sin esto el toast era ambiguo.
            const scopeRes = result.plan?.config?.scope_resolution || {};
            const requestedCount = scopeRes.requested_count ?? (this.scopeUserIds?.length || 0);
            const resolvedCount = scopeRes.resolved_count ?? Object.keys(snap).length;
            const unresolvedSample = Array.isArray(scopeRes.unresolved_sample) ? scopeRes.unresolved_sample : [];

            // Diagnóstico granular: no nos quedamos con un boolean. Contamos
            // cuántos usuarios del scope tienen al menos un target > 0 PARA
            // SU PROPIO ROL. Esto distingue:
            //   • "scope no se resolvió en BD" → IDs sintéticos / inactivos
            //   • "matriz vacía"               → ningún user tiene targets activos
            //   • "matriz OK pero rol-mismatch"→ la matriz tiene cosas pero
            //     no para los roles del scope
            //   • "matriz OK + roles OK"       → problema de farmacias o ventana
            const totalUsers = Object.keys(snap).length;
            let usersWithTargets = 0;
            const perUserDetail = {};
            for (const [uid, byDay] of Object.entries(snap)) {
              let userHas = false;
              for (const t of Object.values(byDay || {})) {
                const m = t?.marzam || {};
                const p = t?.prospecto || {};
                const sumM = (m.A || 0) + (m.B || 0) + (m.C || 0);
                const sumP = (p.A || 0) + (p.B || 0) + (p.C || 0) + (p.D || 0);
                if (sumM + sumP > 0) { userHas = true; break; }
              }
              perUserDetail[uid] = userHas;
              if (userHas) usersWithTargets += 1;
            }
            const anyTarget = usersWithTargets > 0;
            const totalClients = (counts.A || 0) + (counts.B || 0) + (counts.C || 0);
            const totalProspects = counts.prospects || 0;
            const anyClient = totalClients + totalProspects > 0;

            // Diagnóstico completo a consola — pega esto si necesitas ayuda.
            console.warn('[plan-editor] Sin visitas generadas — diagnóstico:', {
              scope_sent_from_frontend: this.scopeUserIds?.length || 0,
              scope_resolution_backend: { requestedCount, resolvedCount, unresolvedSample },
              snapshot_users: totalUsers,
              users_with_targets: usersWithTargets,
              candidate_counts: counts,
              unassigned_count: Array.isArray(unassigned) ? unassigned.length : 0,
              per_user_has_targets: perUserDetail,
              targets_snapshot: snap,
              first_scope_id_sample: this.scopeUserIds?.slice(0, 3) || [],
            });

            let hint; let toastKind = 'warning';
            if (requestedCount === 0) {
              hint = ' · el frontend no envió IDs — selecciona al menos un rep en la lista de abajo';
            } else if (resolvedCount === 0) {
              // Caso CRÍTICO: el frontend mandó IDs pero el backend no encontró
              // ningún usuario activo en la tabla `users`. Típico del modo demo
              // donde los reps son sintéticos y no están persistidos.
              hint = ` · enviaste ${requestedCount} ID(s) pero la BD no encontró ninguno (probablemente son usuarios sintéticos del demo o están inactivos). Muestra: ${unresolvedSample.slice(0, 2).join(', ')}…`;
              toastKind = 'danger';
            } else if (resolvedCount < requestedCount) {
              // Algunos sí, otros no. Avisamos pero seguimos diagnosticando.
              const lost = requestedCount - resolvedCount;
              hint = ` · solo ${resolvedCount}/${requestedCount} usuarios existen activos en BD (${lost} no se encontraron) y ninguno generó visitas — revisa que tus reps estén activos`;
            } else if (!anyTarget) {
              hint = ` · 0 de ${totalUsers} usuarios del alcance tienen metas configuradas — ve a Plan & Metas → 1.B Tu cuota diaria y pon celdas > 0 para los roles que estás incluyendo`;
            } else if (!anyClient) {
              hint = ` · ${usersWithTargets}/${totalUsers} usuarios sí tienen metas, pero 0 farmacias/prospectos elegibles en el período (Marzam=${totalClients}, prospectos=${totalProspects}) — verifica el padrón o amplía el período`;
            } else {
              hint = ` · ${usersWithTargets}/${totalUsers} usuarios con metas, ${totalClients + totalProspects} farmacias candidatas, pero el solver no asignó nada — revisa que los reps tengan home_lat o que el período tenga días laborales`;
            }
            window.MarzamToast?.show(`Sin visitas generadas${hint}`, toastKind);
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
      fmtTimeTotal,
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

        // Two paths:
        //  1) preview-only (no plan id) — mutate in memory, redraw, no server call
        //  2) edit on a draft/published plan — call /:id/reassign-stop, refetch
        const planId = this.preview?.plan?.id;
        if (planId && a.id) {
          await this._reassignStopOrAlternatives(planId, a.id, destUserId, false);
        } else {
          a.visitor_user_id = destUserId;
          this.repCards = this._buildRepCards();
          drawPreview(APP.map, this.preview, this._repMeta);
          window.MarzamToast?.show('Stop reasignado (preview)', 'info');
        }
      },
      /**
       * Helper used by onDropRep and the cap-exceeded modal "Forzar" button.
       * Catches 409 cap_exceeded and shows the alternatives modal; on force=true
       * accepts the reassignment unconditionally.
       */
      async _reassignStopOrAlternatives(planId, assignmentId, destUserId, force) {
        try {
          await API.post(`/visit-plans/${planId}/reassign-stop${force ? '?force=true' : ''}`, {
            assignment_id: assignmentId,
            new_visitor_user_id: destUserId,
            force: !!force,
          });
          const fresh = await API.get(`/visit-plans/${planId}`);
          this.preview = {
            ...this.preview,
            plan: fresh,
            assignments: (fresh.assignments || []).map((x, i) => ({
              ...x,
              __key: `${x.visitor_user_id}|${x.scheduled_date}|${x.route_order}|${i}`,
              __lat: null, __lng: null,
            })),
          };
          this.repCards = this._buildRepCards();
          drawPreview(APP.map, this.preview, this._repMeta);
          this.capModal.open = false;
          window.MarzamToast?.show(force ? 'Stop reasignado (forzado, sobre cap)' : 'Stop reasignado y persistido', force ? 'warning' : 'success');
        } catch (err) {
          // 409 cap_exceeded surfaces the alternatives modal.
          if (err?.code === 'cap_exceeded' || err?.error?.code === 'cap_exceeded' || err?.alternatives) {
            const payload = err.alternatives ? err : (err.error || err);
            this.capModal = {
              open: true,
              payload,
              originalDrop: { planId, assignmentId, destUserId },
            };
            return;
          }
          const msg = err?.error || err?.message || 'Error';
          window.MarzamToast?.show(`No se pudo reasignar: ${msg}`, 'danger');
        }
      },
      /** User picked an alternative rep from the cap-exceeded modal. */
      async pickCapAlternative(altUserId) {
        const od = this.capModal.originalDrop;
        if (!od) { this.capModal.open = false; return; }
        await this._reassignStopOrAlternatives(od.planId, od.assignmentId, altUserId, false);
      },
      /** User chose to force the original reassignment despite cap_exceeded. */
      async forceCapReassign() {
        const od = this.capModal.originalDrop;
        if (!od) { this.capModal.open = false; return; }
        await this._reassignStopOrAlternatives(od.planId, od.assignmentId, od.destUserId, true);
      },
      _captureCostMeta(metrics) {
        if (!metrics) return;
        const cb = metrics.cost_breakdown || {};
        const total = (cb.fresh || 0) + (cb.cached || 0) + (cb.estimated_fallback || 0);
        this.costMeta = {
          cache_hit_rate: total ? +((cb.cached || 0) / total * 100).toFixed(1) : null,
          traffic_mode: cb.traffic_aware_used ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
          solver_strategy: metrics.solver?.strategy || 'legacy',
          variance_minutes: metrics.balance?.gap_after ?? null,
          gap_threshold_min: metrics.balance?.gap_threshold_min ?? null,
          n_max_per_route: metrics.solver?.n_max_per_route ?? null,
        };
      },
      // ── Emergency drawer (PR8 / migrations 074-075) ──────────────────────
      openEmergencyPanel(kind = 'breakdown') {
        if (!this.preview?.plan?.id) {
          window.MarzamToast?.show('Publica el plan antes de usar emergencia', 'info');
          return;
        }
        this.emergency = {
          open: true,
          kind,
          broken_user_id: null,
          urgent_stop: { pharmacy_id: null, marzam_client_id: null, preferred_user_id: null, after_assignment_id: null },
          date: new Date().toISOString().slice(0, 10),
          diff: null, summary: null, loading: false, error: null,
        };
      },
      closeEmergencyPanel() { this.emergency.open = false; },
      async submitEmergency() {
        const planId = this.preview?.plan?.id;
        if (!planId) return;
        this.emergency.loading = true;
        this.emergency.error = null;
        try {
          const body = { date: this.emergency.date };
          if (this.emergency.kind === 'breakdown') {
            if (!this.emergency.broken_user_id) throw new Error('Selecciona el rep con avería');
            body.broken_user_id = this.emergency.broken_user_id;
          } else {
            const us = this.emergency.urgent_stop;
            if (!us.pharmacy_id && !us.marzam_client_id) {
              throw new Error('Selecciona la farmacia o el cliente urgente');
            }
            body.urgent_stop = us;
          }
          const r = await API.post(`/visit-plans/${planId}/reoptimize-day`, body);
          this.emergency.diff = r.diff || [];
          this.emergency.summary = r.summary || null;
          // Refresh plan view.
          const fresh = await API.get(`/visit-plans/${planId}`);
          this.preview = {
            ...this.preview,
            plan: fresh,
            assignments: (fresh.assignments || []).map((x, i) => ({
              ...x,
              __key: `${x.visitor_user_id}|${x.scheduled_date}|${x.route_order}|${i}`,
              __lat: null, __lng: null,
            })),
          };
          this.repCards = this._buildRepCards();
          drawPreview(APP.map, this.preview, this._repMeta);
          window.MarzamToast?.show(`Reoptimización aplicada (${r.summary?.moved || 0} stops movidos, ${r.summary?.no_capacity || 0} sin capacidad)`, 'success');
          this.loadReoptHistory();
        } catch (err) {
          this.emergency.error = err?.error || err?.message || 'Error';
        } finally {
          this.emergency.loading = false;
        }
      },
      async loadReoptHistory() {
        const planId = this.preview?.plan?.id;
        if (!planId) return;
        try {
          this.reoptHistory = await API.get(`/visit-plans/${planId}/reoptimizations`);
        } catch (err) {
          console.warn('[plan-editor] reopt history fetch failed', err);
          this.reoptHistory = [];
        }
      },
      async recalculateRep(userId) {
        const planId = this.preview?.plan?.id;
        if (!planId) {
          window.MarzamToast?.show('Publica el plan antes de recalcular', 'info');
          return;
        }
        try {
          const result = await API.post(`/visit-plans/${planId}/users/${userId}/resequence`, {});
          window.MarzamToast?.show(`Re-secuenciados ${result.resequenced_days} día(s)`, 'success');
          const fresh = await API.get(`/visit-plans/${planId}`);
          this.preview = {
            ...this.preview,
            plan: fresh,
            assignments: (fresh.assignments || []).map((x, i) => ({
              ...x,
              __key: `${x.visitor_user_id}|${x.scheduled_date}|${x.route_order}|${i}`,
              __lat: null, __lng: null,
            })),
          };
          this.repCards = this._buildRepCards();
          drawPreview(APP.map, this.preview, this._repMeta);
        } catch (err) {
          const msg = err?.error || err?.message || 'Error';
          window.MarzamToast?.show(`No se pudo recalcular: ${msg}`, 'danger');
        }
      },
      async loadCostEstimate() {
        if (!this.canGenerate()) return;
        try {
          const r = await API.post('/visit-plans/preview/cost-estimate', {
            scope_user_ids: this.scopeUserIds,
            period_start: this.periodStart,
            period_end: this.periodEnd,
            granularity: 'weekly',
          });
          this.costEstimate = r;
        } catch (err) {
          this.costEstimate = null;
          console.warn('[plan-editor] cost-estimate failed', err);
        }
      },
      async loadQuota() {
        try {
          this.planQuota = await API.get('/visit-plans/quota');
        } catch (err) {
          this.planQuota = null;
          console.warn('[plan-editor] quota load failed', err);
        }
      },
      // Helpers para el template — el ciclo de Alpine evalúa cada uno
      // muchas veces, así que se mantienen O(1).
      quotaChipText() {
        const q = this.planQuota;
        if (!q || q.daily_limit == null) return 'Planes hoy: —';
        return `Planes hoy: ${q.used_today}/${q.daily_limit}`;
      },
      quotaChipColor() {
        const q = this.planQuota;
        if (!q || q.daily_limit == null) return 'slate';
        if (q.remaining === 0) return 'rose';
        if (q.remaining <= 1) return 'amber';
        return 'emerald';
      },
      budgetChipText() {
        // Mostramos solo semáforo (sin USD) porque el costo de Routes API es
        // información financiera de BlackPrint (no del cliente Marzam). El
        // endpoint /api/admin/routes-budget además filtra el payload por rol:
        // managers Marzam reciben { severity, ... } sin spent_usd/budget_usd.
        const b = this.budgetStatus;
        if (!b) return 'Budget: —';
        const color = this.budgetChipColor();
        if (color === 'rose')    return 'Budget: crítico';
        if (color === 'amber')   return 'Budget: atención';
        if (color === 'emerald') return 'Budget: OK';
        return 'Budget: —';
      },
      budgetChipColor() {
        const b = this.budgetStatus;
        if (!b) return 'slate';
        // Managers Marzam reciben { severity, daily_limit, used_today } sin USD.
        if (b.severity) {
          if (b.severity === 'critical') return 'rose';
          if (b.severity === 'warning')  return 'amber';
          if (b.severity === 'ok')       return 'emerald';
          return 'slate';
        }
        // BP admin (o legacy callers): payload completo con USD.
        if (!b.budget_usd) return 'slate';
        const pct = b.spent_usd / b.budget_usd;
        if (pct >= 0.95) return 'rose';
        if (pct >= 0.8)  return 'amber';
        return 'emerald';
      },
      costChipText() {
        const c = this.costEstimate;
        if (!c || c.est_cost_usd == null) return 'Costo plan: —';
        return `Costo plan: ~$${Number(c.est_cost_usd).toFixed(4)}`;
      },
      // Filtra el scope de reps por skill seleccionada antes de generar. El
      // backend NO recibe el skillFilter como argumento hoy — el resultado es
      // mostrar/ocultar reps localmente sin que el usuario tenga que destildar
      // cada uno. Cuando se desea "any" no filtra nada.
      effectiveScopeUserIds() {
        if (!this.skillFilter || this.skillFilter === 'any') return this.scopeUserIds;
        return this.scopeUserIds.filter((id) => {
          const u = this.teamUsers.find((x) => x.id === id);
          const skills = u?.user_skills;
          if (!Array.isArray(skills) || skills.length === 0) return true; // sin skills = elegible
          return skills.includes(this.skillFilter);
        });
      },
      closeQuotaModal() { this.quotaModal = null; },
      async toggleOverlays() {
        this.showOverlays = !this.showOverlays;
        if (this.showOverlays) await drawSecurityOverlays(APP.map);
        else clearOverlays();
      },
      get unassignedSummary() {
        const u = this.preview?.plan?.config?.unassigned || [];
        const byReason = {};
        for (const item of u) {
          const k = item.reason || 'unknown';
          byReason[k] = (byReason[k] || 0) + (item.shortfall || 1);
        }
        return { total: u.length, byReason };
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
          // Refrescamos quota — acabamos de gastar 1 plan del día.
          this.loadQuota();
        } catch (err) {
          // 429 daily_plan_quota_exceeded → modal explícito (no toast genérico).
          if (err?.status === 429 && err?.body?.error === 'daily_plan_quota_exceeded') {
            this.quotaModal = err.body;
            this.loadQuota();
          } else if (err?.error === 'daily_plan_quota_exceeded') {
            this.quotaModal = err;
            this.loadQuota();
          } else {
            const msg = err?.error || err?.message || 'Error desconocido';
            window.MarzamToast?.show('No se pudo publicar: ' + msg, 'danger');
          }
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
