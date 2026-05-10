/* =============================================================
   Live Ops view (manager) — real-time positions, alerts, status.

   Subscribes to /api/live/stream (Server-Sent Events) and updates
   the MapLibre map + a hierarchical tree picker on the side panel.

   Hierarchy:
     Director → Gerente → Supervisor → Rep
   The tree is built from /api/team/cascade and rendered with
   tri-state checkboxes (all/none/partial). Selection persists in
   localStorage so the manager keeps their filter on reload.

   Map pins differentiate role: reps render as small circles, sups
   as larger circles with a blue stroke, gerentes as larger still
   with a purple stroke. Trails render with a gradient fade so
   direction is visible. Warm-start hits /api/tracking/positions
   before the SSE opens so the map isn't blank for the first ping.

   Scope is enforced server-side — see live.service.js#allowed and
   teamScope.getDescendants. The frontend tree mirrors that scope
   so the visible hierarchy matches the events the user receives.
   ============================================================= */
(function () {
  'use strict';

  const APP = window.MarzamApp.state;
  const HT = window.MarzamHierarchyTree;
  const SRC_USERS = 'live-users';
  const SRC_TRAIL = 'live-trail';
  // Phase 3: subtle "where the team should be" plan layer beneath live pings.
  const SRC_PLAN = 'live-plan-stops';
  // Estela GPS — full-day breadcrumb trail of the rep clicked in the side panel.
  // Visually distinct from SRC_TRAIL (which is the rolling 30-min in-memory
  // tail). Loaded on demand from /api/tracking/breadcrumbs/:repId/day/:iso.
  const SRC_HISTORICAL_TRAIL = 'live-historical-trail';
  const SRC_HISTORICAL_VISITS = 'live-historical-visits';

  // ── styling helpers ────────────────────────────────────────────
  const ROLE_COLORS = {
    representante: { stroke: '#ffffff', radius: 9 },
    supervisor:    { stroke: '#2563eb', radius: 12 },
    gerente_ventas:{ stroke: '#7c3aed', radius: 14 },
    director_sucursal: { stroke: '#0f172a', radius: 16 },
  };
  const ROLE_LABEL = {
    director_sucursal: 'Director',
    gerente_ventas: 'Gerente',
    supervisor: 'Supervisor',
    representante: 'Rep',
    admin: 'Admin',
  };
  const ROLE_LABEL_PLURAL = {
    director_sucursal: 'directores',
    gerente_ventas: 'gerentes',
    supervisor: 'supervisores',
    representante: 'reps',
  };

  function clearLayers() {
    const map = APP.map;
    if (!map) return;
    [SRC_USERS, SRC_TRAIL, SRC_PLAN, SRC_HISTORICAL_TRAIL, SRC_HISTORICAL_VISITS].forEach((srcId) => {
      ['line', 'circle', 'label'].forEach((kind) => {
        const id = `${srcId}-${kind}`;
        if (map.getLayer(id)) map.removeLayer(id);
      });
      if (map.getSource(srcId)) map.removeSource(srcId);
    });
    // Floating legend chip (Phase 3) — single instance, removed on tab leave.
    const legend = document.getElementById('live-legend-chip');
    if (legend) legend.remove();
  }

  // Phase 3: paint plan stops as subtle gray dotted circles BELOW live positions.
  // Helps the manager spot the gap between "where they should be" (plan) and
  // "where they are" (live). Toggled by the panel switch; default ON.
  function paintPlanLayer(stops) {
    const map = APP.map;
    if (!map) return;
    const features = (stops || [])
      .filter((s) => s.lat != null && s.lng != null)
      .map((s) => ({
        type: 'Feature',
        properties: { name: s.farmacia_nombre || s.pharmacy_name || '', order: s.route_order || 0 },
        geometry: { type: 'Point', coordinates: [Number(s.lng), Number(s.lat)] },
      }));
    upsertSource(map, SRC_PLAN, { type: 'FeatureCollection', features });
    if (!map.getLayer(`${SRC_PLAN}-circle`)) {
      map.addLayer({
        id: `${SRC_PLAN}-circle`,
        type: 'circle',
        source: SRC_PLAN,
        paint: {
          'circle-radius': 6,
          'circle-color': 'rgba(148,163,184,0.15)',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#94a3b8',
          'circle-stroke-opacity': 0.6,
        },
      }, map.getLayer(`${SRC_TRAIL}-line`) ? `${SRC_TRAIL}-line` : undefined);
    }
  }

  function clearPlanLayer() {
    const map = APP.map;
    if (!map) return;
    if (map.getLayer(`${SRC_PLAN}-circle`)) map.removeLayer(`${SRC_PLAN}-circle`);
    if (map.getSource(SRC_PLAN)) map.removeSource(SRC_PLAN);
  }

  function renderLegendChip() {
    if (document.getElementById('live-legend-chip')) return;
    const chip = document.createElement('div');
    chip.id = 'live-legend-chip';
    chip.className = 'fixed z-[55] bg-white/95 backdrop-blur-xl rounded-xl shadow-lg border border-white/60 ring-1 ring-slate-200/50 px-3 py-2 text-[10px] font-semibold text-slate-700 '
      + 'md:top-24 md:right-6 max-md:top-[100px] max-md:right-3';
    chip.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="flex items-center gap-1.5"><span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500"></span>En vivo</span>
        <span class="text-slate-300">·</span>
        <span class="flex items-center gap-1.5"><span class="inline-block w-2.5 h-2.5 rounded-full border border-slate-400 bg-transparent"></span>Plan</span>
        <span class="text-slate-300">·</span>
        <span class="flex items-center gap-1.5"><span class="inline-block w-3 h-0.5 bg-slate-400 opacity-60"></span>Recorrido</span>
      </div>
    `;
    document.body.appendChild(chip);
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

  // ── store: every user with a known position is keyed here ──────
  function makeStore() {
    const users = new Map();
    const TRAIL_MAX = 60; // last ~30 minutes at 30s/ping

    function ensure(userId) {
      let rec = users.get(userId);
      if (!rec) {
        rec = {
          user_id: userId,
          full_name: null,
          role: null,
          employee_code: null,
          manager_id: null,
          manager_name: null,
          branch_id: null,
          branch_name: null,
          lat: null, lng: null,
          lastSeen: 0,
          trail: [],
          alerts: 0,
        };
        users.set(userId, rec);
      }
      return rec;
    }

    return {
      onPosition(p) {
        const id = p.rep_id || p.user_id;
        if (!id) return;
        const ts = p.recorded_at ? Date.parse(p.recorded_at) : Date.now();
        const rec = ensure(id);
        rec.full_name = p.rep_name || p.full_name || rec.full_name;
        rec.role = p.role || rec.role;
        rec.employee_code = p.employee_code || rec.employee_code;
        rec.manager_id = p.manager_id || rec.manager_id;
        rec.manager_name = p.manager_name || rec.manager_name;
        rec.branch_id = p.branch_id || rec.branch_id;
        rec.branch_name = p.branch_name || rec.branch_name;
        if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
          rec.lat = p.lat; rec.lng = p.lng;
          rec.trail.push([p.lng, p.lat, ts]);
          if (rec.trail.length > TRAIL_MAX) rec.trail.shift();
        }
        rec.lastSeen = ts;
      },
      onAlert(a) {
        const id = a.subject_user_id || a.user_id;
        if (!id) return;
        const rec = ensure(id);
        rec.alerts = (rec.alerts || 0) + 1;
      },
      seedFromSnapshot(rows) {
        // Warm-start: server-side latest-per-user from /api/tracking/positions.
        for (const r of rows || []) {
          if (!r || !r.rep_id) continue;
          this.onPosition({ ...r, recorded_at: r.recorded_at });
        }
      },
      list() { return [...users.values()]; },
      get(id) { return users.get(id); },
      clear() { users.clear(); },
    };
  }

  // ── map rendering ──────────────────────────────────────────────
  function redrawMap(store, visibleIds) {
    const map = APP.map;
    if (!map) return;
    const visible = visibleIds || null;
    const list = store.list().filter((u) =>
      Number.isFinite(u.lat) && Number.isFinite(u.lng)
      && (!visible || visible.has(u.user_id)),
    );
    const userFeatures = [];
    const trailFeatures = [];
    for (const u of list) {
      const status = statusFor(u.lastSeen);
      const fill = u.alerts > 0 ? '#ef4444' : colorForStatus(status);
      const role = u.role || 'representante';
      const styling = ROLE_COLORS[role] || ROLE_COLORS.representante;
      userFeatures.push({
        type: 'Feature',
        properties: {
          user_id: u.user_id,
          name: u.full_name || u.employee_code || 'Usuario',
          fill,
          stroke: styling.stroke,
          radius: styling.radius,
          status,
          role,
          alerts: u.alerts || 0,
        },
        geometry: { type: 'Point', coordinates: [Number(u.lng), Number(u.lat)] },
      });
      if (u.trail.length > 1) {
        trailFeatures.push({
          type: 'Feature',
          properties: { user_id: u.user_id, color: fill },
          geometry: { type: 'LineString', coordinates: u.trail.map(([lng, lat]) => [lng, lat]) },
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
          'line-opacity': 0.55,
        },
      });
    }

    upsertSource(map, SRC_USERS, { type: 'FeatureCollection', features: userFeatures });
    if (!map.getLayer(`${SRC_USERS}-circle`)) {
      map.addLayer({
        id: `${SRC_USERS}-circle`,
        type: 'circle',
        source: SRC_USERS,
        paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'fill'],
          'circle-stroke-width': 3,
          'circle-stroke-color': ['get', 'stroke'],
        },
      });
      map.addLayer({
        id: `${SRC_USERS}-label`,
        type: 'symbol',
        source: SRC_USERS,
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

  // ── SSE ────────────────────────────────────────────────────────
  // [P4 + S5] EventSource cannot send Authorization headers, so SSE auth
  // historically used `?token=<JWT>` which leaked the long-lived JWT to access
  // logs. The /api/auth/sse-ticket endpoint exchanges the JWT for a 60s UUID
  // ticket; we fetch a fresh ticket on every (re)connect. If the ticket
  // exchange fails we fall back to ?token= so older deploys keep working.
  async function fetchSseTicket(token) {
    try {
      const r = await fetch('/api/auth/sse-ticket', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j && j.ticket ? j.ticket : null;
    } catch {
      return null;
    }
  }

  function openStream(token, onEvent) {
    let es;
    let backoff = 1000;
    let lastEventId = null;
    const ctrl = { closed: false, reconnects: 0 };

    async function connect() {
      if (ctrl.closed) return;
      const url = new URL('/api/live/stream', location.origin);
      // Prefer ticket; fall back to legacy ?token=.
      const ticket = await fetchSseTicket(token);
      if (ticket) url.searchParams.set('ticket', ticket);
      else url.searchParams.set('token', token);
      if (lastEventId) url.searchParams.set('last_event_id', lastEventId);
      es = new EventSource(url.toString(), { withCredentials: true });
      es.addEventListener('open', () => { backoff = 1000; });
      ['position', 'alert', 'assignment_status', 'plan_published'].forEach((type) => {
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
        // Exponential backoff capped at 30s; lastEventId persists across
        // reconnects so the server replays missed events from outbox.
        setTimeout(() => { connect(); }, Math.min(backoff, 30000));
        backoff = Math.min(backoff * 2, 30000);
      });
    }

    connect();
    return {
      close() { ctrl.closed = true; try { es?.close(); } catch { /* noop */ } },
      reconnects: () => ctrl.reconnects,
    };
  }

  // ── Alpine component ───────────────────────────────────────────
  let _activeStream = null;
  let _refreshTimer = null;
  let _cascadeAbort = null;

  async function renderLiveOps(body) {
    if (_activeStream) { _activeStream.close(); _activeStream = null; }
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
    if (_cascadeAbort) { try { _cascadeAbort.abort(); } catch { /* noop */ } _cascadeAbort = null; }
    clearLayers();

    body.innerHTML = `
      <div x-data="liveOps()" x-init="init()" class="space-y-3">
        <!-- KPIs -->
        <div class="grid grid-cols-4 gap-2 text-center text-xs">
          <div class="bg-white rounded-xl p-2 border border-slate-100">
            <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Activos</div>
            <div class="text-lg font-black text-emerald-600" x-text="kpis.active"></div>
          </div>
          <div class="bg-white rounded-xl p-2 border border-slate-100">
            <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Inactivos</div>
            <div class="text-lg font-black text-amber-600" x-text="kpis.idle"></div>
          </div>
          <div class="bg-white rounded-xl p-2 border border-slate-100">
            <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Offline</div>
            <div class="text-lg font-black text-slate-500" x-text="kpis.offline"></div>
          </div>
          <div class="bg-white rounded-xl p-2 border border-slate-100">
            <div class="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Alertas</div>
            <div class="text-lg font-black text-rose-600" x-text="kpis.alerts"></div>
          </div>
        </div>

        <!-- Connection status -->
        <div class="flex items-center justify-between gap-2 text-[11px]">
          <div class="flex items-center gap-2"
               :class="isDemo ? 'text-violet-600' : (connected ? 'text-emerald-600' : 'text-amber-600')">
            <span class="inline-block w-2 h-2 rounded-full"
                  :class="isDemo ? 'bg-violet-500' : (connected ? 'bg-emerald-500 mz-pulse-active' : 'bg-amber-500')"></span>
            <span x-text="isDemo ? 'Modo demo · sin tracking real' : (connected ? 'Conectado en vivo' : 'Reconectando…')"></span>
          </div>
          <div class="text-slate-400" x-show="!isDemo && reconnects > 0" x-text="'Reconexiones: ' + reconnects"></div>
        </div>

        <!-- Phase 3: Plan-overlay toggle (manager-only signal) -->
        <label class="flex items-center gap-2 text-[11px] text-slate-600 cursor-pointer select-none bg-white rounded-xl border border-slate-100 px-3 py-2">
          <input type="checkbox" x-model="showPlan" @change="onTogglePlan()" class="rounded border-slate-300">
          <span class="font-semibold">Mostrar plan de hoy</span>
          <span class="ml-auto text-[10px] text-slate-400" x-text="planStopsCount + ' paradas planificadas'"></span>
        </label>

        <!-- Per-role counts (clickable filter shortcuts) -->
        <div class="flex items-center gap-2 text-[10px] text-slate-500" x-show="byRole.gerente_ventas + byRole.supervisor + byRole.representante > 0">
          <button @click="onlyRole('gerente_ventas')"
                  class="px-2 py-1 rounded-lg border"
                  :class="roleFilter === 'gerente_ventas' ? 'bg-violet-50 border-violet-300 text-violet-700' : 'border-slate-200 hover:border-violet-200'">
            <span x-text="byRole.gerente_ventas"></span> gerentes
          </button>
          <button @click="onlyRole('supervisor')"
                  class="px-2 py-1 rounded-lg border"
                  :class="roleFilter === 'supervisor' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-slate-200 hover:border-blue-200'">
            <span x-text="byRole.supervisor"></span> sup
          </button>
          <button @click="onlyRole('representante')"
                  class="px-2 py-1 rounded-lg border"
                  :class="roleFilter === 'representante' ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'border-slate-200 hover:border-emerald-200'">
            <span x-text="byRole.representante"></span> reps
          </button>
          <button x-show="roleFilter" @click="onlyRole(null)"
                  class="text-[10px] text-slate-400 hover:text-slate-700 underline">limpiar</button>
        </div>

        <!-- Tree controls -->
        <div class="bg-white rounded-xl border border-slate-100 p-2 space-y-2" x-show="treeReady">
          <div class="flex items-center gap-2">
            <input type="text" x-model="query" @input="onQueryChange()"
                   placeholder="Buscar persona o código…"
                   class="flex-1 text-xs border border-slate-200 rounded-lg px-2 py-1.5 outline-none focus:border-orange-300">
            <button @click="selectAll()" class="text-[10px] font-bold text-slate-600 hover:text-orange-600 px-2 py-1 rounded-lg border border-slate-200">Todos</button>
            <button @click="selectNone()" class="text-[10px] font-bold text-slate-600 hover:text-rose-600 px-2 py-1 rounded-lg border border-slate-200">Ninguno</button>
          </div>
          <div class="text-[10px] text-slate-400 flex items-center justify-between">
            <span x-text="selectedCount + '/' + totalCount + ' seleccionados'"></span>
            <span x-show="visibleCount < totalCount" class="text-orange-500" x-text="visibleCount + ' visibles tras búsqueda'"></span>
          </div>
        </div>

        <!-- Tree (collapsible, scrollable) -->
        <div class="space-y-0.5 max-h-[42vh] overflow-y-auto pr-1" x-show="treeReady">
          <template x-for="row in renderedRows" :key="row.user.id">
            <div class="flex items-center gap-1.5 hover:bg-orange-50 rounded-lg px-1 py-1 group cursor-pointer"
                 :class="row.matched ? 'bg-orange-50/50' : ''"
                 :style="'padding-left: ' + (row.depth * 14 + 4) + 'px;'"
                 @mouseenter="hoverUser = row.user.id" @mouseleave="hoverUser = null">
              <!-- Expand/collapse caret -->
              <button @click="toggleExpand(row.user.id)" class="w-4 flex-shrink-0 text-slate-400 text-xs"
                      x-text="row.hasChildren ? (row.expanded ? '▾' : '▸') : '·'"></button>
              <!-- Tri-state checkbox -->
              <button @click.stop="toggleSelect(row.user.id)"
                      class="w-4 h-4 flex-shrink-0 rounded border flex items-center justify-center text-[9px] font-black"
                      :class="row.state === 'all' ? 'bg-orange-500 border-orange-500 text-white' : (row.state === 'partial' ? 'bg-orange-100 border-orange-400 text-orange-700' : 'bg-white border-slate-300 text-transparent')"
                      x-text="row.state === 'partial' ? '−' : '✓'"></button>
              <!-- Status dot (only for users with positions) -->
              <span class="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                    :class="row.statusClass"></span>
              <!-- Role badge -->
              <span class="text-[9px] font-bold uppercase px-1 py-0.5 rounded flex-shrink-0"
                    :class="row.roleBadgeClass" x-text="row.roleLabel"></span>
              <!-- Name + code -->
              <button @click.stop="focusOn(row.user.id)" class="flex-1 min-w-0 text-left">
                <div class="text-xs font-semibold text-slate-800 truncate" x-text="row.user.full_name || row.user.employee_code || 'Usuario'"></div>
                <div class="text-[10px] text-slate-400 truncate" x-text="row.subtitle"></div>
              </button>
              <!-- Alert chip -->
              <span x-show="row.alerts > 0" class="mz-chip mz-chip-skipped text-[10px]" x-text="'⚠ ' + row.alerts"></span>
            </div>
          </template>
          <template x-if="renderedRows.length === 0 && treeReady">
            <div class="text-center text-xs text-slate-400 py-6" x-text="query ? 'Sin resultados para esa búsqueda' : 'Sin equipo asignado'"></div>
          </template>
        </div>

        <!-- Empty state when no positions yet -->
        <div class="text-center text-xs text-slate-400 py-2" x-show="treeReady && totalCount > 0 && positionedCount === 0">
          Esperando pings… <span x-text="totalCount + ' personas en tu equipo'"></span>
        </div>

        <!-- Alert detail panel -->
        <template x-if="selectedAlert">
          <div class="bg-rose-50 border border-rose-200 rounded-xl p-3 text-xs">
            <div class="flex items-start justify-between gap-2">
              <div class="font-bold text-rose-800" x-text="selectedAlert.title"></div>
              <button @click="closeAlert()" class="text-rose-400 hover:text-rose-700">×</button>
            </div>
            <div class="text-rose-700 mt-1" x-text="'Severidad: ' + (selectedAlert.severity || 'info')"></div>
            <pre class="text-[10px] text-rose-600 mt-2 whitespace-pre-wrap" x-text="JSON.stringify(selectedAlert.payload || selectedAlert, null, 2)"></pre>
          </div>
        </template>

        <!-- Event feed -->
        <div class="bg-white rounded-2xl border border-slate-100 p-2">
          <div class="text-[10px] font-bold uppercase text-slate-400 px-1 pb-1">Feed</div>
          <div class="space-y-1 max-h-44 overflow-y-auto pr-1">
            <template x-for="e in events" :key="e.id">
              <button class="mz-event-card text-[11px] px-2 py-1 rounded-lg w-full text-left hover:opacity-80"
                      :class="eventClass(e)" @click="openAlert(e)">
                <span x-text="e.icon"></span> <span class="font-semibold" x-text="e.title"></span>
                <span class="text-slate-400" x-text="' · ' + e.timeAgo"></span>
              </button>
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
      // KPIs / status
      kpis: { active: 0, idle: 0, offline: 0, alerts: 0 },
      byRole: { gerente_ventas: 0, supervisor: 0, representante: 0 },
      connected: false,
      reconnects: 0,
      isDemo: !!(window.APP && window.APP.isDemo),

      // Tree state
      tree: null,
      treeReady: false,
      query: '',
      _visibleIds: null, // null = no search filter
      expanded: new Set(JSON.parse(localStorage.getItem('liveOps.expanded') || '[]')),
      selected: new Set(JSON.parse(localStorage.getItem('liveOps.selected') || '[]')),
      _hasSavedSelection: !!localStorage.getItem('liveOps.selected'),
      hoverUser: null,
      roleFilter: localStorage.getItem('liveOps.roleFilter') || null,

      // Derived counts
      totalCount: 0,
      selectedCount: 0,
      visibleCount: 0,
      positionedCount: 0,

      // Render rows (flattened from tree per current expansion + search)
      renderedRows: [],

      // Events / alerts
      events: [],
      selectedAlert: null,

      // Phase 3: plan overlay state — default ON, persists in localStorage.
      showPlan: localStorage.getItem('liveOps.showPlan') !== '0',
      planStopsCount: 0,
      _planStops: [],

      // Estela GPS — full-day historical trail for the rep currently focused.
      // Distinct from `_store.trail` (in-memory rolling 30-min tail from SSE).
      historicalTrail: { userId: null, date: null, points: [], visits: [], loading: false, error: null },

      // Internal store
      _store: makeStore(),

      async init() {
        const token = localStorage.getItem('token') || '';
        if (!token) {
          window.MarzamToast?.show('Sesión expirada', 'danger');
          return;
        }
        renderLegendChip();
        // Load today's plan stops (best-effort — empty state is fine).
        this._loadPlanStops();
        // Load the actor's hierarchy (manager + descendants).
        try {
          _cascadeAbort = new AbortController();
          const team = await API.get('/team/cascade');
          const actor = API.user() || { id: 'me', full_name: 'Yo', role: 'admin' };
          this.tree = HT.buildTree(team || { descendants: [] }, actor);
          this.treeReady = true;
          // Default selection: everyone selected (only if user hasn't saved a
          // preference yet).
          const allIds = [];
          HT.walk(this.tree, (n) => allIds.push(String(n.user.id)));
          this.totalCount = allIds.length;
          if (!this._hasSavedSelection) {
            for (const id of allIds) this.selected.add(id);
          }
          // Auto-expand top 2 levels for orientation.
          if (!localStorage.getItem('liveOps.expanded')) {
            HT.walk(this.tree, (n, _p, depth) => {
              if (depth <= 1) this.expanded.add(String(n.user.id));
            });
          }
          this._refreshDerived();
        } catch (err) {
          console.warn('[live-ops] cascade failed:', err);
        }

        if (this.isDemo) {
          // Demo mode: no SSE / no warm-start; show empty tree.
          return;
        }

        // Warm-start: pull the latest known position per user before SSE
        // takes over so the map isn't blank for the first ping.
        try {
          const positions = await API.get('/tracking/positions');
          this._store.seedFromSnapshot(positions || []);
          this._refreshDerived();
        } catch (err) {
          // 403 if the actor isn't authorized for /positions yet — non-fatal.
          if (err?.status !== 403) console.warn('[live-ops] warm-start failed:', err);
        }

        _activeStream = openStream(token, ({ type, data }) => {
          this.connected = true;
          this.reconnects = _activeStream?.reconnects() || 0;
          if (type === 'position') {
            this._store.onPosition(data);
          } else if (type === 'alert') {
            this._store.onAlert(data);
            this._pushEvent({ icon: '⚠', title: `Alerta · ${data.rule_key || ''}`, severity: data.severity || 'warn', payload: data });
          } else if (type === 'assignment_status') {
            this._pushEvent({ icon: '✓', title: `Stop ${data.status || ''}`, severity: 'info', payload: data });
          } else if (type === 'plan_published') {
            this._pushEvent({ icon: '📋', title: 'Plan publicado', severity: 'info', payload: data });
          }
          this._refreshDerived();
        });
        // Tick every 5s so relative times stay fresh.
        _refreshTimer = setInterval(() => this._refreshDerived(), 5000);
      },

      // ── Plan overlay (Phase 3) ───────────────────────────────
      async _loadPlanStops() {
        try {
          const today = new Date().toISOString().slice(0, 10);
          const data = await API.get(`/visit-plans/assignments?from=${today}&to=${today}`);
          this._planStops = Array.isArray(data) ? data : (data?.assignments || []);
          this.planStopsCount = this._planStops.length;
          if (this.showPlan) paintPlanLayer(this._planStops);
        } catch (err) {
          // Backend may not implement aggregate plan endpoint yet — non-fatal.
          this._planStops = [];
          this.planStopsCount = 0;
        }
      },
      onTogglePlan() {
        try { localStorage.setItem('liveOps.showPlan', this.showPlan ? '1' : '0'); } catch { /* ignore */ }
        if (this.showPlan) paintPlanLayer(this._planStops);
        else clearPlanLayer();
      },

      // ── Selection ────────────────────────────────────────────
      toggleSelect(userId) {
        HT.toggleNode(this.tree, userId, this.selected, 'toggle');
        this._persistSelection();
        this._refreshDerived();
      },
      selectAll() {
        HT.walk(this.tree, (n) => this.selected.add(String(n.user.id)));
        this._persistSelection();
        this._refreshDerived();
      },
      selectNone() {
        this.selected.clear();
        this._persistSelection();
        this._refreshDerived();
      },
      _persistSelection() {
        localStorage.setItem('liveOps.selected', JSON.stringify([...this.selected]));
      },

      // ── Expansion ────────────────────────────────────────────
      toggleExpand(userId) {
        const id = String(userId);
        if (this.expanded.has(id)) this.expanded.delete(id);
        else this.expanded.add(id);
        localStorage.setItem('liveOps.expanded', JSON.stringify([...this.expanded]));
        this._rebuildRows();
      },

      // ── Search ───────────────────────────────────────────────
      onQueryChange() {
        this._visibleIds = HT.filterByQuery(this.tree, this.query);
        this._rebuildRows();
      },

      // ── Role filter shortcut ─────────────────────────────────
      onlyRole(role) {
        this.roleFilter = role;
        if (role) localStorage.setItem('liveOps.roleFilter', role);
        else localStorage.removeItem('liveOps.roleFilter');
        this._refreshDerived();
      },

      // ── Map focus ────────────────────────────────────────────
      focusOn(userId) {
        const node = HT.findNode(this.tree, userId);
        if (!node) return;
        // Single user with position → flyTo. Otherwise → fitBounds to all
        // descendants with positions.
        const ids = [];
        HT.walk(node, (n) => ids.push(String(n.user.id)));
        const positioned = ids
          .map((id) => this._store.get(id))
          .filter((u) => u && Number.isFinite(u.lat) && Number.isFinite(u.lng));
        if (!positioned.length) return;
        if (positioned.length === 1) {
          const u = positioned[0];
          APP.map?.flyTo({ center: [u.lng, u.lat], zoom: 14, duration: 700 });
          // Lazy-load today's full breadcrumb trail when focusing a single rep.
          // Other roles (supervisor/gerente/director) don't have meaningful trails
          // because they don't follow a planned route.
          if (node.user.role === 'representante') this.loadHistoricalTrail(String(node.user.id));
          else this.clearHistoricalTrail();
          return;
        }
        const lats = positioned.map((u) => u.lat);
        const lngs = positioned.map((u) => u.lng);
        const bounds = [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ];
        APP.map?.fitBounds(bounds, { padding: 80, duration: 700, maxZoom: 14 });
        // Multi-rep focus → clear single-rep estela so it doesn't leak across views.
        this.clearHistoricalTrail();
      },

      // ── Estela GPS (historical trail) ────────────────────────
      _todayIso() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      },

      async loadHistoricalTrail(userId, isoDate) {
        const date = isoDate || this._todayIso();
        // Cache check: don't re-fetch if we already loaded for the same user+date.
        if (
          this.historicalTrail.userId === userId
          && this.historicalTrail.date === date
          && !this.historicalTrail.loading
          && !this.historicalTrail.error
          && this.historicalTrail.points.length > 0
        ) {
          this._renderHistoricalTrail();
          return;
        }
        this.historicalTrail = { userId, date, points: [], visits: [], loading: true, error: null };
        try {
          const [points, visits] = await Promise.all([
            API.get(`/tracking/breadcrumbs/${encodeURIComponent(userId)}/day/${encodeURIComponent(date)}`).catch((e) => { throw e; }),
            API.get(`/visits?rep_id=${encodeURIComponent(userId)}&date=${encodeURIComponent(date)}`).catch(() => []),
          ]);
          this.historicalTrail.points = Array.isArray(points) ? points : [];
          this.historicalTrail.visits = Array.isArray(visits) ? visits : [];
          this.historicalTrail.loading = false;
          this._renderHistoricalTrail();
        } catch (err) {
          this.historicalTrail.loading = false;
          this.historicalTrail.error = err?.message || 'No se pudo cargar la estela';
          this._renderHistoricalTrail(); // clears any prior render
        }
      },

      _renderHistoricalTrail() {
        const map = APP.map;
        if (!map) return;
        const ht = this.historicalTrail;

        // Trail line.
        if (ht && ht.points && ht.points.length > 1) {
          const lineGeo = {
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              properties: { user_id: ht.userId, date: ht.date },
              geometry: {
                type: 'LineString',
                coordinates: ht.points.map((p) => [Number(p.lng), Number(p.lat)]),
              },
            }],
          };
          upsertSource(map, SRC_HISTORICAL_TRAIL, lineGeo);
          if (!map.getLayer(`${SRC_HISTORICAL_TRAIL}-line`)) {
            map.addLayer({
              id: `${SRC_HISTORICAL_TRAIL}-line`,
              type: 'line',
              source: SRC_HISTORICAL_TRAIL,
              paint: {
                'line-color': '#1d4ed8', // azul oscuro distinto del verde del live trail
                'line-width': 3,
                'line-opacity': 0.75,
                'line-dasharray': [1, 0],
              },
            });
          }
        } else if (map.getLayer(`${SRC_HISTORICAL_TRAIL}-line`)) {
          // Clear when no points.
          upsertSource(map, SRC_HISTORICAL_TRAIL, { type: 'FeatureCollection', features: [] });
        }

        // Visit markers.
        const visitFeatures = (ht.visits || [])
          .filter((v) => Number.isFinite(Number(v.checkin_lat)) && Number.isFinite(Number(v.checkin_lng)))
          .map((v) => ({
            type: 'Feature',
            properties: {
              visit_id: v.id,
              outcome: v.outcome || 'visited',
              pharmacy_name: v.pharmacy_name || v.farmacia_nombre || '',
              recorded_at: v.created_at || v.checkin_time || '',
            },
            geometry: { type: 'Point', coordinates: [Number(v.checkin_lng), Number(v.checkin_lat)] },
          }));
        upsertSource(map, SRC_HISTORICAL_VISITS, { type: 'FeatureCollection', features: visitFeatures });
        if (!map.getLayer(`${SRC_HISTORICAL_VISITS}-circle`)) {
          map.addLayer({
            id: `${SRC_HISTORICAL_VISITS}-circle`,
            type: 'circle',
            source: SRC_HISTORICAL_VISITS,
            paint: {
              'circle-radius': 6,
              'circle-color': '#dc2626',  // rojo: punto de visita confirmada
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 2,
            },
          });
        }
      },

      clearHistoricalTrail() {
        const map = APP.map;
        if (map) {
          ['line', 'circle'].forEach((kind) => {
            const id = `${SRC_HISTORICAL_TRAIL}-${kind}`;
            if (map.getLayer(id)) map.removeLayer(id);
            const idV = `${SRC_HISTORICAL_VISITS}-${kind}`;
            if (map.getLayer(idV)) map.removeLayer(idV);
          });
          if (map.getSource(SRC_HISTORICAL_TRAIL)) map.removeSource(SRC_HISTORICAL_TRAIL);
          if (map.getSource(SRC_HISTORICAL_VISITS)) map.removeSource(SRC_HISTORICAL_VISITS);
        }
        this.historicalTrail = { userId: null, date: null, points: [], visits: [], loading: false, error: null };
      },

      // ── Event feed ───────────────────────────────────────────
      _pushEvent(e) {
        const id = `${Date.now()}-${Math.random()}`;
        const ts = Date.now();
        this.events = [{ id, ts, ...e, timeAgo: 'ahora' }, ...this.events].slice(0, 50);
      },
      openAlert(e) { this.selectedAlert = e; },
      closeAlert() { this.selectedAlert = null; },
      eventClass(e) {
        if (e.severity === 'critical') return 'bg-rose-50 text-rose-700';
        if (e.severity === 'warn') return 'bg-amber-50 text-amber-700';
        return 'bg-slate-50 text-slate-700';
      },

      // ── Derive view-model from tree + store ──────────────────
      _refreshDerived() {
        if (!this.tree) return;
        const all = this._store.list();
        // Filter positions to selected + (optional) roleFilter.
        const visibleIds = new Set();
        for (const u of all) {
          if (!this.selected.has(u.user_id)) continue;
          if (this.roleFilter && u.role !== this.roleFilter) continue;
          visibleIds.add(u.user_id);
        }
        // KPIs derived from VISIBLE users only — so collapsing a branch dims
        // its counters too.
        let active = 0, idle = 0, offline = 0, alerts = 0;
        for (const u of all) {
          if (!visibleIds.has(u.user_id)) continue;
          const s = statusFor(u.lastSeen);
          if (s === 'active') active += 1;
          else if (s === 'idle') idle += 1;
          else offline += 1;
          alerts += u.alerts || 0;
        }
        this.kpis = { active, idle, offline, alerts };

        // Per-role counts of users in tree (regardless of position).
        this.byRole = HT.countByRole(this.tree);

        // Selection / total counts.
        this.totalCount = HT.flattenSelected(this.tree, new Set(this._allTreeIds())).size;
        this.selectedCount = HT.flattenSelected(this.tree, this.selected).size;
        this.positionedCount = all.length;

        // Refresh event feed timeAgo + redraw map.
        this.events = this.events.map((e) => ({ ...e, timeAgo: fmtTimeAgo(e.ts) }));
        redrawMap(this._store, visibleIds);
        this._rebuildRows();
      },

      _allTreeIds() {
        const ids = [];
        HT.walk(this.tree, (n) => ids.push(String(n.user.id)));
        return ids;
      },

      _rebuildRows() {
        if (!this.tree) { this.renderedRows = []; this.visibleCount = 0; return; }
        const rows = [];
        const visibleSet = this._visibleIds; // null = no filter
        const searchActive = !!visibleSet;
        const self = this;
        HT.walk(this.tree, (node, parent, depth) => {
          const id = String(node.user.id);
          // Search filter: skip nodes not in the visible set.
          if (visibleSet && !visibleSet.has(id)) return false;
          // Expansion: only show node if all ancestors are expanded (top is
          // always shown). When search is active, force-expand the matched
          // path so deep matches are visible without manually expanding.
          if (parent && !searchActive) {
            const parentId = String(parent.user.id);
            if (!self.expanded.has(parentId)) {
              // ancestor collapsed — don't render this node, AND don't descend
              return false;
            }
          }
          const state = HT.nodeState(node, self.selected);
          const u = self._store.get(id);
          const hasPos = u && Number.isFinite(u.lat) && Number.isFinite(u.lng);
          const lastSeen = u?.lastSeen || 0;
          const status = hasPos ? statusFor(lastSeen) : 'unknown';
          const counts = HT.countByRole(node);
          let subtitle = '';
          if (node.children.length) {
            const parts = [];
            if (counts.gerente_ventas) parts.push(counts.gerente_ventas + ' g');
            if (counts.supervisor) parts.push(counts.supervisor + ' s');
            if (counts.representante) parts.push(counts.representante + ' r');
            subtitle = parts.join(' · ');
          } else {
            subtitle = (node.user.employee_code || '');
            if (hasPos) subtitle += (subtitle ? ' · ' : '') + 'hace ' + fmtTimeAgo(lastSeen);
            else if (node.user.employee_code) subtitle += ' · sin signal';
          }
          rows.push({
            user: node.user,
            depth,
            hasChildren: node.children.length > 0,
            expanded: self.expanded.has(id),
            state,
            statusClass: status === 'active' ? 'bg-emerald-500' : status === 'idle' ? 'bg-amber-500' : status === 'offline' ? 'bg-slate-300' : 'bg-slate-200',
            roleLabel: ROLE_LABEL[node.user.role] || (node.user.role || ''),
            roleBadgeClass: badgeClassForRole(node.user.role),
            subtitle,
            alerts: u?.alerts || 0,
            matched: visibleSet && visibleSet.has(id) && (self.query || '').length > 0,
          });
          return true;
        });
        this.renderedRows = rows;
        this.visibleCount = visibleSet ? visibleSet.size : this.totalCount;
      },
    };
  }

  function badgeClassForRole(role) {
    if (role === 'director_sucursal') return 'bg-slate-800 text-white';
    if (role === 'gerente_ventas') return 'bg-violet-100 text-violet-700';
    if (role === 'supervisor') return 'bg-blue-100 text-blue-700';
    if (role === 'representante') return 'bg-emerald-100 text-emerald-700';
    return 'bg-slate-100 text-slate-700';
  }

  document.addEventListener('alpine:init', () => {
    if (window.Alpine?.data) window.Alpine.data('liveOps', liveOpsComponent);
  });
  if (window.Alpine?.data) window.Alpine.data('liveOps', liveOpsComponent);

  // Cleanup so leaving the view doesn't keep the SSE open or leave map layers.
  function cleanupLiveOps() {
    if (_activeStream) { try { _activeStream.close(); } catch { /* noop */ } _activeStream = null; }
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
    if (_cascadeAbort) { try { _cascadeAbort.abort(); } catch { /* noop */ } _cascadeAbort = null; }
    clearLayers();
  }

  window.MarzamViews = window.MarzamViews || {};
  window.MarzamViews.renderLiveOps = renderLiveOps;
  window.MarzamViews.cleanupLiveOps = cleanupLiveOps;
})();
