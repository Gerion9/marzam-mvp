/* =============================================================
   Marzam Views — myRoutes, myTeam, analytics, targets, sessions.
   Loaded by app.js into the unified shell.
   ============================================================= */
(function () {
  'use strict';

  const { ROLES, normalizeRole, ROLE_LABEL, ROLE_RANK } = window.MarzamApp;
  const APP = window.MarzamApp.state;

  // ──────────────────────────────────────────────────────────
  // Shared helpers
  // ──────────────────────────────────────────────────────────
  function initials(name) {
    return (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('');
  }

  function timeAgo(iso) {
    if (!iso) return 'sin actividad';
    const diffMin = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    if (diffMin < 1) return 'ahora mismo';
    if (diffMin < 60) return `hace ${diffMin} min`;
    const h = Math.floor(diffMin / 60);
    if (h < 24) return `hace ${h} h`;
    return `hace ${Math.floor(h / 24)} d`;
  }

  function fmtPct(n) {
    if (n == null || isNaN(n)) return '—';
    return `${Math.round(n)}%`;
  }

  function fmtDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '0m';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Detecta plazas vacantes en la jerarquía (placeholder rows en `users`).
  // El backend devuelve estas plazas con full_name 'VACANTE' (o vacío) para
  // que el árbol organizacional no se rompa cuando hay un hueco.  Las
  // filtramos en cualquier lista donde el manager debería ver solo personas
  // reales con quién trabajar (overrides, metas, asignaciones).
  function isVacancy(u) {
    const name = String(u?.full_name || '').trim();
    return !name || /^vacante$/i.test(name);
  }

  function presenceLabel(status) {
    if (status === 'live') return { txt: 'En visita', dot: 'live' };
    if (status === 'idle') return { txt: 'Inactivo', dot: 'idle' };
    return { txt: 'Offline', dot: 'offline' };
  }

  function sparkline(values) {
    if (!Array.isArray(values) || !values.length) return '<div class="sparkline"></div>';
    const max = Math.max(100, ...values);
    return '<div class="sparkline">' + values.map((v) => {
      const h = Math.max(2, Math.round((v / max) * 22));
      const cls = v < 50 ? 'danger' : v < 70 ? 'warn' : v >= 90 ? 'good' : '';
      return `<i class="${cls}" style="height:${h}px"></i>`;
    }).join('') + '</div>';
  }

  // ──────────────────────────────────────────────────────────
  // Map layer helpers
  // ──────────────────────────────────────────────────────────
  function clearMapLayer(id) {
    const map = APP.map;
    if (!map) return;
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getLayer(`${id}-labels`)) map.removeLayer(`${id}-labels`);
    if (map.getLayer(`${id}-trail`)) map.removeLayer(`${id}-trail`);
    if (map.getSource(id)) map.removeSource(id);
    if (map.getSource(`${id}-trail`)) map.removeSource(`${id}-trail`);
  }

  function drawTeamLive(positions, breadcrumbsByUser) {
    const map = APP.map;
    if (!map) return;
    const apply = () => {
      clearMapLayer('team-live');
      const features = positions.map((p) => ({
        type: 'Feature',
        properties: {
          rep_id: p.rep_id,
          full_name: p.full_name,
          role: p.role,
          presence: p.presence_status,
          color: p.color || '#1b365d',
          current_pharmacy: p.current_pharmacy || '',
        },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      }));
      map.addSource('team-live', { type: 'geojson', data: { type: 'FeatureCollection', features } });
      map.addLayer({
        id: 'team-live',
        type: 'circle',
        source: 'team-live',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'presence'], 'live'], 11, 8],
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 3,
          'circle-stroke-color': '#fff',
          'circle-opacity': ['case', ['==', ['get', 'presence'], 'offline'], 0.5, 1],
        },
      });
      map.addLayer({
        id: 'team-live-labels',
        type: 'symbol',
        source: 'team-live',
        layout: {
          'text-field': ['get', 'full_name'],
          'text-size': 10,
          'text-offset': [0, 1.5],
          'text-anchor': 'top',
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#1b365d',
          'text-halo-color': '#fff',
          'text-halo-width': 2,
        },
      });

      // Breadcrumb trails
      const lineFeatures = [];
      Object.keys(breadcrumbsByUser || {}).forEach((uid) => {
        const trail = breadcrumbsByUser[uid];
        if (!trail || trail.length < 2) return;
        const pos = positions.find((p) => p.rep_id === uid);
        if (!pos || pos.presence_status === 'offline') return;
        lineFeatures.push({
          type: 'Feature',
          properties: { color: pos.color || '#1b365d' },
          geometry: { type: 'LineString', coordinates: trail.map((p) => [p.lng, p.lat]) },
        });
      });
      if (lineFeatures.length) {
        map.addSource('team-live-trail', { type: 'geojson', data: { type: 'FeatureCollection', features: lineFeatures } });
        map.addLayer({
          id: 'team-live-trail',
          type: 'line',
          source: 'team-live-trail',
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 2.5,
            'line-opacity': 0.55,
            'line-blur': 0.5,
          },
        }, 'team-live');
      }

      map.on('click', 'team-live', (e) => {
        const p = e.features[0].properties;
        new maplibregl.Popup({ closeButton: true, offset: 14 })
          .setLngLat(e.features[0].geometry.coordinates)
          .setHTML(`
            <div class="text-xs font-semibold text-slate-700">${p.full_name}</div>
            <div class="text-[10px] text-slate-500">${p.role}</div>
            ${p.current_pharmacy ? `<div class="text-[11px] text-emerald-700 mt-1">📍 ${p.current_pharmacy}</div>` : ''}
            <button onclick="window.MarzamApp.pushDrill('${p.rep_id}')" class="mt-2 text-[11px] font-bold text-[#1b365d] underline">Drill-down →</button>
          `).addTo(map);
      });
    };
    if (map.loaded()) apply(); else map.once('load', apply);
  }

  function fitMapToPositions(positions) {
    if (!APP.map || !positions.length) return;
    const bounds = positions.reduce((b, p) => b.extend([p.lng, p.lat]), new maplibregl.LngLatBounds([positions[0].lng, positions[0].lat], [positions[0].lng, positions[0].lat]));
    APP.map.fitBounds(bounds, { padding: 80, maxZoom: 14 });
  }

  // ──────────────────────────────────────────────────────────
  // VIEW: Mis rutas
  // ──────────────────────────────────────────────────────────
  async function renderMyRoutes(body) {
    const today = new Date().toISOString().slice(0, 10);
    const meId = APP.user && APP.user.id;
    const role = normalizeRole(APP.user && APP.user.role);
    const inStore = APP.isDemo && DEMO_H && DEMO_H.STORE;
    const userInDemo = inStore ? DEMO_H.STORE.users.find((u) => u.id === meId) : null;
    const dayTarget = inStore ? (DEMO_H.STORE.day_targets[role] || 5) : 5;
    const seed = (inStore && DEMO_H.STORE.compliance_seeds[meId]) || { today: 0, month: 0, trend: [] };
    const visitedToday = Math.round((seed.today / 100) * dayTarget);
    const monthDone = Math.round((seed.month / 100) * dayTarget * 22);
    const monthTarget = dayTarget * 22;

    const session = APP.activeSession;
    const stops = buildSyntheticStops(dayTarget, visitedToday);

    body.innerHTML = `
      <!-- KPIs hero -->
      <div class="grid grid-cols-3 gap-2 mb-4">
        <div class="kpi-mini">
          <div class="kpi-mini__value">${visitedToday}/${dayTarget}</div>
          <div class="kpi-mini__label">HOY</div>
        </div>
        <div class="kpi-mini">
          <div class="kpi-mini__value">${monthDone}/${monthTarget}</div>
          <div class="kpi-mini__label">MES</div>
        </div>
        <div class="kpi-mini">
          <div class="kpi-mini__value">${fmtPct(seed.month)}</div>
          <div class="kpi-mini__label">CUMPLIM.</div>
        </div>
      </div>

      <!-- Active session card or CTA -->
      ${session ? `
        <div class="bg-gradient-to-br from-emerald-50 to-emerald-100 border border-emerald-200 rounded-2xl p-4 mb-4">
          <div class="flex items-center gap-3 mb-2">
            <div class="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center text-white">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            </div>
            <div class="flex-1">
              <div class="text-xs font-bold text-emerald-700 uppercase tracking-wider">Modo Visita activo</div>
              <div class="text-sm font-bold text-slate-800">${session.current_pharmacy || 'En ruta'}</div>
            </div>
          </div>
          <div class="text-[10px] text-emerald-700 font-semibold">${session.pharmacies_visited}/${session.pharmacies_planned} farmacias · iniciado ${timeAgo(session.started_at)}</div>
        </div>
      ` : `
        <div class="bg-gradient-to-br from-orange-50 to-amber-50 border border-orange-100 rounded-2xl p-4 mb-4 flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-orange-500 flex items-center justify-center text-white flex-shrink-0">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 2L4 22h16L12 2z"/></svg>
          </div>
          <div class="flex-1">
            <div class="text-sm font-bold text-slate-800">¿Sales a campo hoy?</div>
            <div class="text-[11px] text-slate-500 mt-0.5">Inicia Modo Visita para cronometrar tu ruta y registrar KPIs.</div>
          </div>
        </div>
      `}

      <!-- Trend / Heatmap mini -->
      <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
        <div class="flex items-center justify-between mb-2">
          <div class="text-xs font-bold text-slate-600 uppercase tracking-wider">Cumplimiento últimos 14 días</div>
          <span class="text-[10px] font-bold text-emerald-600">${fmtPct(seed.month)}</span>
        </div>
        ${sparkline(seed.trend)}
      </div>

      <!-- Stops list -->
      <div class="flex items-center justify-between mb-2">
        <h4 class="text-xs font-bold text-slate-500 uppercase tracking-wider">Plan de hoy · ${stops.length} farmacias</h4>
        <button id="btn-toggle-visit" class="text-[11px] font-bold ${session ? 'text-rose-600' : 'text-emerald-600'} hover:underline">
          ${session ? 'Cerrar visita' : 'Iniciar Modo Visita'}
        </button>
      </div>
      <div id="stops-list">
        ${stops.length === 0
          ? `<div class="text-center py-8 text-xs text-slate-400">No hay un plan vigente para hoy.<br/>Genera o publica un plan desde "Plan Editor" para ver las farmacias asignadas.</div>`
          : stops.map((s, i) => stopCardHtml(s, i)).join('')}
      </div>
    `;

    document.getElementById('btn-toggle-visit').addEventListener('click', () => {
      document.getElementById('fab-start-visit').click();
    });

    // Hookear los botones "Iniciar proceso" / "Registrar visita" de cada
    // stop card al modal MarzamVisitClient (decide Marzam vs prospecto).
    wireStopVisitButtons(stops);

    drawRouteOnMap(stops);

    // Pinta TODAS las farmacias visibles (padrón A/B/C + prospectos) en el
    // mapa, con leyenda flotante para filtrar. La capa se mantiene mientras
    // estemos en la vista de rutas; se oculta al cambiar de tab.
    if (window.MarzamPharmaciesMap) {
      window.MarzamPharmaciesMap.render();
    }
  }

  function buildSyntheticStops(target, visitedSoFar) {
    const userInDemo = APP.isDemo && DEMO_H && DEMO_H.STORE
      ? DEMO_H.STORE.users.find((u) => u.id === APP.user.id)
      : null;
    const role = normalizeRole(APP.user && APP.user.role);
    const defaultPareto = role === ROLES.DIRECTOR || role === ROLES.GERENTE ? 'A' : role === ROLES.SUPERVISOR ? 'B' : 'C';
    const cap = Math.min(target, 12);

    // Source order of preference:
    //   1) /api/marzam/clients (real source) — enrichment.STORE.real_clients
    //   2) STORE.pharmacies — real-named ecatepec pharmacies bundled in demo
    //   3) Synthetic placeholder names (last resort).
    let pool = [];
    const realClients = APP.isDemo && DEMO_H && DEMO_H.STORE && DEMO_H.STORE.real_clients;
    const realPharmacies = APP.isDemo && DEMO_H && DEMO_H.STORE && DEMO_H.STORE.pharmacies;
    if (Array.isArray(realClients) && realClients.length) {
      const filtered = realClients.filter((c) => c.pareto === defaultPareto);
      pool = (filtered.length ? filtered : realClients).map((c) => ({
        name: c.farmacia_nombre,
        address: `${c.direccion || ''}${c.delegacion_municipio ? ' · ' + c.delegacion_municipio : ''}`.trim() || 'Ecatepec',
        lat: c.lat || (userInDemo ? userInDemo.lat : 19.605),
        lng: c.lng || (userInDemo ? userInDemo.lng : -99.060),
        pareto: c.pareto || defaultPareto,
        cpadre: c.cpadre,
      }));
    } else if (Array.isArray(realPharmacies) && realPharmacies.length) {
      // Prefer pharmacies assigned to this user (rep), fall back to nearest by zone.
      let rePool = realPharmacies.filter((p) =>
        p.assigned_rep_id === APP.user.id && p.pareto === defaultPareto,
      );
      if (rePool.length < cap) {
        rePool = realPharmacies.filter((p) => p.assigned_rep_id === APP.user.id);
      }
      if (rePool.length < cap) {
        // Director/gerente: take A-PARETO from anywhere; nearest by lat/lng to user.
        const baseLat = userInDemo?.lat || 19.605;
        const baseLng = userInDemo?.lng || -99.060;
        rePool = realPharmacies
          .filter((p) => p.pareto === defaultPareto)
          .slice()
          .sort((a, b) => Math.hypot(a.lat - baseLat, a.lng - baseLng) - Math.hypot(b.lat - baseLat, b.lng - baseLng));
      }
      pool = rePool.slice(0, cap).map((p) => ({
        name: p.name,
        address: p.address || `${p.neighborhood || ''}${p.postal_code ? ' · CP ' + p.postal_code : ''}`.trim() || 'Ecatepec',
        lat: p.lat,
        lng: p.lng,
        pareto: p.pareto,
        cpadre: p.id,
      }));
    }

    const fallbackNames = [
      'Farmacia del Ahorro', 'Farmacias Benavides', 'Farmacias Similares', 'Farmacia Guadalajara',
      'Farmacia San Pablo', 'Farmacia del Carmen', 'Farmacia Klyns', 'Farmacia YZA',
    ];
    const baseLat = userInDemo?.lat || 19.605;
    const baseLng = userInDemo?.lng || -99.060;

    // Reserve the last 2 slots of the daily plan for PROSPECTOS (nuevas
    // farmacias).  Sin esto, el rep nunca ve el flow de "Iniciar proceso"
    // para no-clientes y todo el wizard largo (RESULTADO + persona física/
    // moral + observaciones) queda inalcanzable en demo.
    const prospectsPool = APP.isDemo && DEMO_H?.STORE?.prospects ? DEMO_H.STORE.prospects : [];
    const prospectSlots = Math.min(2, prospectsPool.length, cap);
    const marzamCap = cap - prospectSlots;

    const out = [];
    // Outside demo mode, never fabricate placeholder pharmacies — if the data
    // pool is empty, return an empty list so the view renders the real "no
    // hay plan vigente" empty state instead of cards titled "Farmacia del
    // Ahorro · #1" with synthetic addresses.
    const allowSyntheticNames = APP.isDemo === true;
    const realStopCount = allowSyntheticNames ? marzamCap : Math.min(marzamCap, pool.length);
    for (let i = 0; i < realStopCount; i++) {
      const real = pool[i];
      let stop;
      if (real) {
        stop = {
          id: `stop-${i}`, order: i + 1,
          name: real.name, address: real.address,
          lat: real.lat, lng: real.lng, pareto: real.pareto,
          cpadre: real.cpadre,
          is_marzam: true,
          source: 'marzam',
        };
      } else {
        const angle = (i / cap) * 2 * Math.PI;
        const radius = 0.005 + (i % 3) * 0.003;
        stop = {
          id: `stop-${i}`, order: i + 1,
          name: `${fallbackNames[i % fallbackNames.length]} · #${i + 1}`,
          address: `Calle ${i + 1} · Col. ${userInDemo?.zone || 'Ecatepec'}`,
          lat: baseLat + Math.sin(angle) * radius,
          lng: baseLng + Math.cos(angle) * radius,
          pareto: defaultPareto,
          cpadre: null,
          is_marzam: true,
          source: 'marzam',
        };
      }
      stop.status = i < visitedSoFar ? 'done' : i === visitedSoFar ? 'active' : 'pending';
      out.push(stop);
    }

    // Inyectar prospectos al final de la ruta — los más cercanos al usuario.
    if (prospectSlots > 0) {
      const sortedProspects = prospectsPool.slice().sort((a, b) =>
        Math.hypot(a.lat - baseLat, a.lng - baseLng) - Math.hypot(b.lat - baseLat, b.lng - baseLng),
      );
      for (let k = 0; k < prospectSlots; k++) {
        const p = sortedProspects[k];
        const i = marzamCap + k;
        const stop = {
          id: p.id || `prosp-${i}`,
          order: i + 1,
          name: p.name || `Prospecto #${i + 1}`,
          address: p.address || `${p.neighborhood || ''}${p.municipality ? ', ' + p.municipality : ''}`.trim() || 'Sin dirección',
          lat: p.lat,
          lng: p.lng,
          pareto: null,
          cpadre: null,
          is_marzam: false,
          is_new: true,
          source: 'blackprint',
          tier: p.tier || null,
          potential_score: p.potential_score || 0,
        };
        stop.status = i < visitedSoFar ? 'done' : i === visitedSoFar ? 'active' : 'pending';
        out.push(stop);
      }
    }

    // Continúa el bucle original cuando ya no hay reserva para prospectos
    // (caso límite: prospectsPool vacío y cap alto).
    for (let i = marzamCap + prospectSlots; i < cap; i++) {
      const real = pool[i];
      let stop;
      if (real) {
        stop = {
          id: `stop-${i}`, order: i + 1,
          name: real.name, address: real.address,
          lat: real.lat, lng: real.lng, pareto: real.pareto,
          cpadre: real.cpadre,
          is_marzam: true,
          source: 'marzam',
        };
      } else {
        const angle = (i / cap) * 2 * Math.PI;
        const radius = 0.005 + (i % 3) * 0.003;
        stop = {
          id: `stop-${i}`, order: i + 1,
          name: `${fallbackNames[i % fallbackNames.length]} · #${i + 1}`,
          address: `Calle ${i + 1} · Col. ${userInDemo?.zone || 'Ecatepec'}`,
          lat: baseLat + Math.sin(angle) * radius,
          lng: baseLng + Math.cos(angle) * radius,
          pareto: defaultPareto,
          cpadre: null,
          is_marzam: true,
          source: 'marzam',
        };
      }
      stop.status = i < visitedSoFar ? 'done' : i === visitedSoFar ? 'active' : 'pending';
      out.push(stop);
    }
    return out;
  }

  function stopCardHtml(s, _i) {
    const pareto = s.pareto || 'C';
    const statusBadge = s.status === 'done'
      ? '<span class="badge badge-green">Completado</span>'
      : s.status === 'active'
      ? '<span class="badge badge-orange animate-pulse-live">En curso</span>'
      : '<span class="badge badge-gray">Pendiente</span>';
    // Marca de "nueva" cuando la parada NO es cliente Marzam — el botón
    // "Iniciar proceso" abre el wizard largo con resultado + persona física/
    // moral + observaciones.  Para clientes Marzam abre el wizard corto.
    const isNew = !!s.is_new || s.source === 'blackprint' || s.source === 'prospect' || s.is_marzam === false;
    const newBadge = isNew
      ? '<span class="badge" style="background:#fff7ed; color:#c2410c; border:1px solid #fed7aa;">Nueva</span>'
      : '';
    const ctaLabel = s.status === 'done'
      ? 'Visita registrada'
      : (isNew ? 'Iniciar proceso' : 'Registrar visita');
    const ctaDisabled = s.status === 'done';
    return `
      <div class="visit-stop-card" data-status="${s.status}" data-stop-id="${escapeAttr(s.id)}">
        <div class="stop-order-badge" data-pareto="${pareto}">${s.order}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="pareto-tag" data-pareto="${pareto}">${pareto}</span>
            ${newBadge}
            ${statusBadge}
          </div>
          <div class="text-sm font-bold text-slate-800 mt-1 truncate">${window.MarzamUI?.titleCaseEs ? window.MarzamUI.titleCaseEs(s.name) : s.name}</div>
          <div class="text-[11px] text-slate-500 truncate">${window.MarzamUI?.titleCaseEs ? window.MarzamUI.titleCaseEs(s.address || '') : (s.address || '')}</div>
          <button type="button" class="btn-stop-visit mt-2 text-[11px] font-bold rounded-lg px-2.5 py-1.5 transition ${ctaDisabled
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : isNew
                ? 'bg-orange-50 text-[#c2410c] hover:bg-orange-100 border border-orange-200'
                : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200'}"
            ${ctaDisabled ? 'disabled' : ''}>
            ${ctaLabel}
          </button>
        </div>
      </div>
    `;
  }

  function escapeAttr(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /**
   * Hook el listener del botón "Iniciar proceso" / "Registrar visita" en
   * cada stop card.  Llamamos a window.MarzamVisitClient.open con el
   * objeto del stop, que ya trae `is_marzam`/`source`/`pareto` para que el
   * modal decida la rama (Marzam vs prospecto) y muestre el wizard
   * correspondiente.
   */
  function wireStopVisitButtons(stops) {
    const root = document.getElementById('stops-list');
    if (!root) return;
    root.querySelectorAll('.btn-stop-visit').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.disabled) return;
        const card = btn.closest('[data-stop-id]');
        const stopId = card?.dataset.stopId;
        const stop = stops.find((s) => String(s.id) === String(stopId));
        if (!stop) {
          window.MarzamToast?.show('No se encontró la parada', 'error');
          return;
        }
        if (!window.MarzamVisitClient?.open) {
          console.warn('MarzamVisitClient no está disponible');
          return;
        }
        window.MarzamVisitClient.open({ pharmacy: stop });
      });
    });
  }

  function drawRouteOnMap(stops) {
    const map = APP.map;
    if (!map || !stops.length) return;
    const apply = () => {
      clearMapLayer('my-route');
      clearMapLayer('my-stops');
      const lineCoords = stops.map((s) => [s.lng, s.lat]);
      map.addSource('my-route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: lineCoords } } });
      map.addLayer({
        id: 'my-route',
        type: 'line',
        source: 'my-route',
        paint: { 'line-color': '#1b365d', 'line-width': 3, 'line-opacity': 0.65, 'line-dasharray': [2, 2] },
      });
      const features = stops.map((s) => ({
        type: 'Feature',
        properties: {
          order: s.order, pareto: s.pareto, status: s.status, name: s.name,
          // Marca "nueva farmacia" — pharmacies.source <> 'marzam' = prospecto no cliente.
          is_new: !!s.is_new || s.source === 'blackprint' || s.source === 'prospect',
        },
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
      }));
      map.addSource('my-stops', { type: 'geojson', data: { type: 'FeatureCollection', features } });
      map.addLayer({
        id: 'my-stops',
        type: 'circle',
        source: 'my-stops',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'is_new'], true], 13, 12],
          'circle-color': [
            'case',
            ['==', ['get', 'is_new'], true], '#e5730a',
            ['match', ['get', 'pareto'], 'A', '#dc2626', 'B', '#f59e0b', 'C', '#2563eb', '#1b365d'],
          ],
          'circle-stroke-width': ['case', ['==', ['get', 'is_new'], true], 4, 3],
          'circle-stroke-color': [
            'case',
            ['==', ['get', 'is_new'], true], '#fff7ed',
            ['==', ['get', 'status'], 'active'], '#fcd34d',
            '#fff',
          ],
          'circle-opacity': ['case', ['==', ['get', 'status'], 'done'], 0.55, 1],
        },
      });
      map.addLayer({
        id: 'my-stops-labels',
        type: 'symbol',
        source: 'my-stops',
        layout: { 'text-field': ['to-string', ['get', 'order']], 'text-size': 12, 'text-allow-overlap': true },
        paint: { 'text-color': '#fff' },
      });
      const bounds = lineCoords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(lineCoords[0], lineCoords[0]));
      map.fitBounds(bounds, { padding: 80, maxZoom: 14 });
    };
    if (map.loaded()) apply(); else map.once('load', apply);
  }

  // ──────────────────────────────────────────────────────────
  // VIEW: Mi equipo
  // ──────────────────────────────────────────────────────────
  // Module state for the team view (persists across re-renders)
  const TEAM_FILTERS = { search: '', role: 'all' };

  async function renderMyTeam(body) {
    // Oculta el overlay de farmacias cuando salimos de "Mis rutas".
    if (window.MarzamPharmaciesMap) window.MarzamPharmaciesMap.hide();
    if (APP.role === ROLES.REPRESENTANTE) {
      body.innerHTML = '<div class="text-center py-12 text-sm text-slate-400">No tienes equipo a tu cargo.</div>';
      return;
    }

    const targetUserId = APP.drillStack && APP.drillStack.length ? APP.drillStack[APP.drillStack.length - 1] : null;

    let cascade = { descendants: [], by_role: {}, direct_reports: [] };
    let positions = [];
    let breadcrumbs = {};
    try {
      cascade = targetUserId
        ? await API.get(`/team/${targetUserId}`)
        : await API.get('/team');
    } catch (err) {
      console.warn('[myTeam] /team failed, using empty cascade:', err);
    }

    // Demo safety net: if the API returned an empty cascade but we have
    // hierarchy data locally, build the cascade directly from STORE.
    const subsRaw = (cascade.descendants || cascade.direct_reports || []);
    if (APP.isDemo && DEMO_H && DEMO_H.STORE && (!subsRaw || !subsRaw.length)) {
      const helpers = DEMO_H.helpers || {};
      const seedUserId = targetUserId || APP.user.id;
      const desc = helpers.getDescendants ? helpers.getDescendants(seedUserId) : [];
      cascade.descendants = desc.map((u) => helpers.userWithExtras ? helpers.userWithExtras(u) : u);
    }

    // Hidrata `u.poblaciones` desde el padrón. Sin esto, el banner de
    // filtro EF + el filtro client-side no podrían distinguir qué EF
    // sirve cada user cuando el backend no enriquece.
    try {
      const clientsRaw = await API.get('/marzam/clients?limit=2000');
      const clientList = Array.isArray(clientsRaw) ? clientsRaw : (clientsRaw?.clients || clientsRaw?.rows || clientsRaw?.data || []);
      if (window.MarzamEF?.hydrateTeam) {
        window.MarzamEF.hydrateTeam(cascade.descendants || [], clientList);
      }
    } catch { /* sin clients, el filtro EF dependerá solo del backend */ }

    try {
      positions = await API.get('/tracking/positions') || [];
    } catch { positions = []; }
    if (APP.isDemo) {
      breadcrumbs = (DEMO_H && DEMO_H.STORE && DEMO_H.STORE.breadcrumbs) || {};
    } else {
      try {
        const liveIds = (positions || []).filter((p) => p.presence_status === 'live').map((p) => p.rep_id);
        for (const id of liveIds) {
          breadcrumbs[id] = await API.get(`/tracking/breadcrumbs/${id}`).catch(() => []);
        }
      } catch { /* no-op */ }
    }
    drawTeamLive(positions || [], breadcrumbs);
    fitMapToPositions(positions || []);

    const subordinates = (cascade.descendants || cascade.direct_reports || []).slice();

    // Apply filters (search + role chips + Entidad Federativa, all client-side
    // for instant feedback). The EF filter comes from window.MarzamPlanZone
    // (sincronizado desde Cuotas / Crear plan / Avance / Análisis) y se
    // basa en `u.poblaciones` (las EFs que el usuario sirve via clientes
    // asignados — enriquecido por el backend desde marzam_clients.poblacion).
    const headerLevelFilter = document.getElementById('team-level-filter')?.value;
    if (headerLevelFilter && headerLevelFilter !== 'all') TEAM_FILTERS.role = headerLevelFilter;
    const search = (TEAM_FILTERS.search || '').trim().toLowerCase();
    const efFilter = window.MarzamPlanZone || (APP.poblacion && APP.poblacion !== '__all__' ? APP.poblacion : '');
    let filtered = subordinates;
    if (TEAM_FILTERS.role !== 'all') filtered = filtered.filter((u) => u.role === TEAM_FILTERS.role);
    if (efFilter) {
      const target = efKey(efFilter);
      // Strict post-hidratación: si el user no tiene EFs ni en backend ni
      // en padrón, no atiende esa zona y queda fuera del listado.
      filtered = filtered.filter((u) => {
        const list = Array.isArray(u.poblaciones) ? u.poblaciones : [];
        return list.map(efKey).includes(target);
      });
    }
    if (search) {
      filtered = filtered.filter((u) => {
        // Match against name, email, all code variants (employee, agente,
        // supervisor, gerencia, clave_cuadro_basico), and zone. Also match
        // prefix-based: typing "UE" returns everyone in gerencia UE, "UEA"
        // everyone under that supervisor — mirrors the real Marzam clave
        // hierarchy. Searching "GERENTE" finds all gerentes (their clave
        // literal in cuadro_basico).
        const hay = [
          u.full_name, u.email, u.zone,
          u.employee_code, u.clave_cuadro_basico,
          u.agente_code, u.supervisor_code, u.gerencia_code,
        ].filter(Boolean).map((s) => String(s).toLowerCase()).join(' ');
        if (hay.includes(search)) return true;
        // Prefix match: 'uea' matches UEA, UEA00, UEA01, UEA02, etc.
        const codes = [
          u.employee_code, u.clave_cuadro_basico,
          u.agente_code, u.supervisor_code, u.gerencia_code,
        ].filter(Boolean).map((c) => String(c).toLowerCase());
        return codes.some((c) => c.startsWith(search));
      });
    }

    const live = filtered.filter((u) => u.presence?.status === 'live').length;
    const idle = filtered.filter((u) => u.presence?.status === 'idle').length;

    const stack = APP.drillStack;
    const drillTarget = stack.length ? (APP.isDemo && DEMO_H.STORE.users.find((x) => x.id === stack[stack.length - 1])) : null;
    const breadcrumbHtml = stack.length ? `
      <div class="bg-white border border-slate-200 rounded-2xl p-3 mb-3 flex items-center gap-2">
        <button id="bc-back" class="bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg px-2.5 py-1.5 flex items-center gap-1 transition" title="Subir un nivel">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>
          <span class="text-[11px] font-bold">Volver</span>
        </button>
        <div class="flex-1 min-w-0">
          <div class="drilldown-bc">
            <a id="bc-root">${ROLE_LABEL[APP.role]} (yo)</a>
            ${stack.map((id, i) => {
              const u = APP.isDemo ? DEMO_H.STORE.users.find((x) => x.id === id) : null;
              const last = i === stack.length - 1;
              const code = u && u.employee_code ? ` · ${u.employee_code}` : '';
              return `
                <span>›</span>
                ${last ? `<span class="font-bold text-slate-800">${u ? escapeHtml(u.full_name) : id}${code}</span>` : `<a data-bc-pop="${id}">${u ? escapeHtml(u.full_name) : id}${code}</a>`}
              `;
            }).join('')}
          </div>
          ${drillTarget ? `<div class="text-[10px] text-slate-400 mt-0.5">Viendo el equipo de <b>${escapeHtml(drillTarget.full_name)}</b> (${drillTarget.employee_code || ''})</div>` : ''}
        </div>
      </div>
    ` : '';

    // Available role chips depend on the actor's role (RBAC).
    const roleChips = [];
    roleChips.push({ id: 'all', label: 'Todos', count: subordinates.length });
    if (APP.role === ROLES.DIRECTOR) {
      roleChips.push({ id: 'gerente_ventas', label: 'Gerentes', count: subordinates.filter((u) => u.role === 'gerente_ventas').length });
    }
    if ([ROLES.DIRECTOR, ROLES.GERENTE].includes(APP.role)) {
      roleChips.push({ id: 'supervisor', label: 'Supervisores', count: subordinates.filter((u) => u.role === 'supervisor').length });
    }
    roleChips.push({ id: 'representante', label: 'Representantes', count: subordinates.filter((u) => u.role === 'representante').length });

    // Banner visible cuando hay filtro de Entidad Federativa heredado de
    // otra vista (Cuotas / Crear plan / Avance / Análisis) o del topbar pill.
    // Permite al manager ver el filtro activo y limpiarlo desde aquí.
    const efBannerHtml = efFilter ? `
      <div class="bg-blue-50 border border-blue-200 rounded-2xl px-3 py-2 mb-3 flex items-center gap-2">
        <svg class="w-4 h-4 text-blue-600 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <span class="text-[11px] text-blue-900">
          Filtrando por <b>${escapeHtml(efDisplay(efFilter))}</b>
        </span>
        <span class="text-[10px] text-blue-600 ml-1">${filtered.length} de ${subordinates.length} miembros</span>
        <button id="ef-banner-clear" class="ml-auto text-[10px] font-bold uppercase tracking-wide text-blue-700 hover:underline">Quitar filtro</button>
      </div>
    ` : '';

    body.innerHTML = `
      ${breadcrumbHtml}
      ${efBannerHtml}

      <!-- Search + role chips -->
      <div class="bg-white border border-slate-200 rounded-2xl p-3 mb-3">
        <div class="relative mb-2">
          <svg class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="team-search" type="text" placeholder="Buscar por nombre, clave o zona..."
            value="${escapeHtml(TEAM_FILTERS.search)}"
            class="w-full bg-slate-50 border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-[#1b365d] focus:ring-2 focus:ring-blue-100" />
        </div>
        <div class="flex flex-wrap gap-1.5">
          ${roleChips.map((c) => `
            <button data-role-chip="${c.id}" class="role-chip ${TEAM_FILTERS.role === c.id ? 'active' : ''}">
              ${c.label} <span class="role-chip-count">${c.count}</span>
            </button>
          `).join('')}
        </div>
      </div>

      <!-- KPIs -->
      <div class="grid grid-cols-3 gap-2 mb-3">
        <div class="kpi-mini">
          <div class="kpi-mini__value text-emerald-600">${live}</div>
          <div class="kpi-mini__label">EN VISITA</div>
        </div>
        <div class="kpi-mini">
          <div class="kpi-mini__value text-amber-600">${idle}</div>
          <div class="kpi-mini__label">INACTIVOS</div>
        </div>
        <div class="kpi-mini">
          <div class="kpi-mini__value text-slate-700">${filtered.length}</div>
          <div class="kpi-mini__label">${filtered.length === subordinates.length ? 'TOTAL' : `DE ${subordinates.length}`}</div>
        </div>
      </div>

      <div id="team-cards-list" class="space-y-2.5"></div>
    `;

    // Wire EF banner (limpia el filtro y vuelve a renderizar).
    const efClear = body.querySelector('#ef-banner-clear');
    if (efClear) {
      efClear.addEventListener('click', () => {
        window.MarzamPlanZone = null;
        if (APP.poblacion && APP.poblacion !== '__all__') APP.poblacion = '__all__';
        renderMyTeam(body);
      });
    }

    // Wire search + chips
    const searchInput = body.querySelector('#team-search');
    let searchTimer = null;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        TEAM_FILTERS.search = e.target.value;
        renderMyTeam(body);
      }, 200);
    });
    body.querySelectorAll('[data-role-chip]').forEach((b) => {
      b.addEventListener('click', () => {
        TEAM_FILTERS.role = b.dataset.roleChip;
        renderMyTeam(body);
      });
    });

    if (stack.length) {
      document.getElementById('bc-root').addEventListener('click', () => {
        APP.drillStack.length = 0;
        window.MarzamApp.selectTab('team');
      });
      const backBtn = document.getElementById('bc-back');
      if (backBtn) {
        backBtn.addEventListener('click', () => {
          APP.drillStack.pop();
          window.MarzamApp.selectTab('team');
        });
      }
      body.querySelectorAll('[data-bc-pop]').forEach((el) => {
        el.addEventListener('click', () => {
          const id = el.dataset.bcPop;
          const idx = APP.drillStack.indexOf(id);
          if (idx >= 0) APP.drillStack.splice(idx + 1);
          window.MarzamApp.selectTab('team');
        });
      });
    }

    const list = document.getElementById('team-cards-list');
    if (!filtered.length) {
      const reason = TEAM_FILTERS.search
        ? `No se encontró nadie que coincida con "<b>${escapeHtml(TEAM_FILTERS.search)}</b>".`
        : (TEAM_FILTERS.role !== 'all'
          ? `No hay miembros con rol "<b>${ROLE_LABEL[TEAM_FILTERS.role] || TEAM_FILTERS.role}</b>" en tu cascada.`
          : '<b>Tu cascada está vacía.</b> Si crees que esto es un error, recarga la página (Ctrl+Shift+R).');
      list.innerHTML = `<div class="text-center py-10 text-sm text-slate-500">${reason}</div>`;
      return;
    }
    // Render mode: when the user is showing "Todos" with no search,
    // group by hierarchy (UE → UEA00 → UEAxx) so the org structure is
    // visible at a glance — same visual language as the Plan Editor.
    // Any active filter or search collapses back to the flat card list
    // because filtering inside a tree is jarring.
    const useTreeView = TEAM_FILTERS.role === 'all' && !search && filtered.length > 4;
    if (useTreeView) {
      list.innerHTML = renderTeamTree(filtered);
      // Wire collapse handlers for both gerencia headers (data-team-section)
      // and supervisor sub-headers (data-team-subsection). Both follow the
      // same convention: nextElementSibling is the collapse target and
      // .team-section__chev is the rotating arrow.
      list.querySelectorAll('[data-team-section], [data-team-subsection]').forEach((header) => {
        header.addEventListener('click', () => {
          const wrap = header.nextElementSibling;
          if (!wrap) return;
          const collapsed = wrap.classList.toggle('hidden');
          const chev = header.querySelector('.team-section__chev');
          if (chev) chev.textContent = collapsed ? '▸' : '▾';
        });
      });
    } else {
      list.innerHTML = filtered.map(teamCardHtml).join('');
    }
    list.querySelectorAll('[data-action="drill"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        APP.drillStack.push(btn.dataset.userId);
        window.MarzamApp.selectTab('team');
      });
    });
    list.querySelectorAll('[data-action="map"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pos = positions.find((p) => p.rep_id === btn.dataset.userId);
        if (pos && APP.map) APP.map.flyTo({ center: [pos.lng, pos.lat], zoom: 15 });
      });
    });
    list.querySelectorAll('[data-action="impersonate"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const targetId = btn.dataset.userId;
        try {
          const result = await API.post('/auth/impersonate', { target_user_id: targetId });
          if (result && result.user) {
            // Save original to restore
            localStorage.setItem('marzam_original_user', localStorage.getItem('user'));
            if (result.token) localStorage.setItem('token', result.token);
            localStorage.setItem('user', JSON.stringify(result.user));
            window.MarzamToast.show(`Viendo como ${result.user.full_name}`, 'info');
            location.reload();
          }
        } catch {
          window.MarzamToast.show('No se pudo impersonar', 'error');
        }
      });
    });
  }

  /**
   * Group a flat list of subordinates into the canonical hierarchy
   *   gerencia → supervisor → reps
   * using employee_code conventions (UE → UEA00 → UEAxx).
   *
   *   - Director-level rows (no gerencia_code) end up in `topLevel`.
   *   - Supervisors render as section sub-headers under their gerencia.
   *   - Reps render as compact cards under their supervisor.
   *   - VACANTE rows are kept so plazas vacías are visible.
   */
  function groupByHierarchy(users) {
    const groups = new Map(); // gerencia_code -> { gerente, supervisors: Map<sup_code, {sup, reps:[]}>, looseReps: [] }
    const topLevel = []; // directors / unmatched
    for (const u of users) {
      const role = normalizeRole(u.role);
      const ger = u.gerencia_code || u.employee_code;
      const sup = u.supervisor_code || (role === ROLES.SUPERVISOR ? u.employee_code?.slice(0, 3) : null);
      if (!ger) { topLevel.push(u); continue; }
      if (!groups.has(ger)) groups.set(ger, { code: ger, gerente: null, supervisors: new Map(), looseReps: [] });
      const bucket = groups.get(ger);
      if (role === ROLES.GERENTE) {
        bucket.gerente = u;
      } else if (role === ROLES.SUPERVISOR) {
        const sCode = u.employee_code?.slice(0, 3) || sup;
        if (!bucket.supervisors.has(sCode)) bucket.supervisors.set(sCode, { code: sCode, sup: null, reps: [] });
        bucket.supervisors.get(sCode).sup = u;
      } else if (role === ROLES.REPRESENTANTE) {
        if (sup) {
          if (!bucket.supervisors.has(sup)) bucket.supervisors.set(sup, { code: sup, sup: null, reps: [] });
          bucket.supervisors.get(sup).reps.push(u);
        } else {
          bucket.looseReps.push(u);
        }
      }
    }
    return { groups, topLevel };
  }

  function renderTeamTree(users) {
    const { groups, topLevel } = groupByHierarchy(users);
    const blocks = [];
    if (topLevel.length) blocks.push(`<div class="space-y-2">${topLevel.map(teamCardHtml).join('')}</div>`);
    for (const [, bucket] of groups.entries()) {
      const ger = bucket.gerente;
      const totalUnder = (ger ? 1 : 0) + bucket.supervisors.size
        + [...bucket.supervisors.values()].reduce((s, e) => s + e.reps.length, 0)
        + bucket.looseReps.length;

      const gerHeader = ger
        ? `<div class="flex items-center gap-2 truncate">
             <span class="mz-chip" style="background:#ede9fe;color:#5b21b6">G</span>
             <span class="font-bold text-sm text-slate-800 truncate">${escapeHtml(ger.full_name)}</span>
             <span class="text-[10px] text-slate-400 font-mono">${escapeHtml(bucket.code)}</span>
           </div>`
        : `<div class="flex items-center gap-2 truncate">
             <span class="mz-chip" style="background:#fef3c7;color:#92400e">SIN TITULAR</span>
             <span class="font-semibold text-sm text-slate-400 italic truncate">Gerencia ${escapeHtml(bucket.code)}</span>
           </div>`;
      const headerHtml = `
        <button data-team-section="${bucket.code}" class="w-full flex items-center justify-between gap-2 bg-violet-50 hover:bg-violet-100 px-3 py-2 rounded-xl border border-violet-100">
          ${gerHeader}
          <div class="flex items-center gap-2 flex-shrink-0">
            <span class="text-[10px] text-slate-500 font-semibold">${totalUnder} miembros</span>
            <span class="team-section__chev text-[10px] text-slate-500">▾</span>
          </div>
        </button>
      `;

      // Build inner content: gerente card (if present) + supervisor sections.
      const inner = [];
      if (ger) inner.push(`<div class="ml-3">${teamCardHtml(ger)}</div>`);
      for (const [, supEntry] of bucket.supervisors.entries()) {
        const sup = supEntry.sup;
        // Phase 3: kill the duplicate "Plaza vacante VACANTE" pattern.
        // The badge already conveys vacancy; the title just shows the code.
        const supTitle = sup
          ? `<span class="font-semibold text-xs text-slate-700 truncate">${escapeHtml(sup.full_name)}</span><span class="text-[10px] text-slate-400 font-mono ml-1">${escapeHtml(supEntry.code + '00')}</span>`
          : `<span class="text-xs italic text-slate-400 truncate">Plaza ${escapeHtml(supEntry.code + '00')}</span>`;
        const supChip = sup ? '' : '<span class="mz-chip" style="background:#fef3c7;color:#92400e">SIN TITULAR</span>';
        // Each supervisor block is its own accordion (data-team-subsection)
        // so the manager can collapse a whole supervisor's reps when scanning
        // a big tree. Default state: expanded; click toggles.
        inner.push(`
          <div class="ml-5 mt-2 space-y-1">
            <button data-team-subsection="${escapeHtml(bucket.code + '-' + supEntry.code)}" class="w-full flex items-center gap-2 bg-blue-50 hover:bg-blue-100 px-2.5 py-1.5 rounded-lg border border-blue-100 text-left">
              <span class="team-section__chev text-[10px] text-slate-500">▾</span>
              <span class="mz-chip" style="background:#dbeafe;color:#1d4ed8">S</span>
              ${supTitle}
              ${supChip}
              <span class="ml-auto text-[10px] text-slate-400 font-semibold">${supEntry.reps.length} reps</span>
            </button>
            <div class="border-l-2 border-blue-100 pl-3 ml-3 space-y-2">
              ${sup ? teamCardHtml(sup) : ''}
              ${supEntry.reps.length === 0 ? '<div class="text-[10px] text-slate-400 italic px-2 py-1">Sin representantes</div>' : ''}
              ${supEntry.reps.map(teamCardHtml).join('')}
            </div>
          </div>
        `);
      }
      if (bucket.looseReps.length) {
        inner.push(`
          <div class="ml-5 mt-2 border-l-2 border-amber-100 pl-3 space-y-2">
            <div class="flex items-center gap-2"><span class="mz-chip" style="background:#fef3c7;color:#92400e">⚠ Sin supervisor</span></div>
            ${bucket.looseReps.map(teamCardHtml).join('')}
          </div>
        `);
      }
      blocks.push(`
        <div class="space-y-1">
          ${headerHtml}
          <div class="space-y-2 mt-1">${inner.join('')}</div>
        </div>
      `);
    }
    return blocks.join('');
  }

  function teamCardHtml(u) {
    const presence = u.presence || { status: 'offline', last_seen: null };
    const m = u.metrics || { planned: 0, done: 0, planned_today: 0, done_today: 0, compliance_pct: null };
    const presenceTxt = presenceLabel(presence.status);
    const role = normalizeRole(u.role);
    const monthlyPct = Math.round(m.compliance_pct || 0);
    const todayPct = m.planned_today > 0 ? Math.round((m.done_today / m.planned_today) * 100) : 0;
    const vacant = isVacancy(u);

    // Build the hierarchy code chain: e.g., "UE › UEA › UEA01" for a rep.
    // (gerencia 2 letras → supervisor 3 letras → agente 5 chars).
    const chain = [];
    if (u.gerencia_code) chain.push({ code: u.gerencia_code, label: 'Gerencia' });
    if (u.supervisor_code && u.supervisor_code !== u.gerencia_code) chain.push({ code: u.supervisor_code, label: 'Supervisor' });
    if (u.agente_code && u.agente_code !== u.supervisor_code) chain.push({ code: u.agente_code, label: 'Agente' });
    const chainHtml = chain.length
      ? chain.map((c, i) => `
          <span class="font-mono text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-600" title="${c.label}">${escapeHtml(c.code)}</span>
          ${i < chain.length - 1 ? '<span class="text-slate-300 text-[10px]">›</span>' : ''}
        `).join('')
      : (u.employee_code ? `<span class="font-mono text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-600">${escapeHtml(u.employee_code)}</span>` : '');

    // Literal clave from cuadro_basico — surfaces 'GERENTE' for managers,
    // 'UEA00' for supervisors, 'UEA01' for reps. Tiny + gray so it doesn't
    // compete visually with the more meaningful chain.
    const claveLiteral = u.clave_cuadro_basico || (role === ROLES.DIRECTOR ? null : u.employee_code);
    const claveHtml = claveLiteral
      ? `<span class="text-[9px] text-slate-400 font-mono">clave: <b class="text-slate-500">${escapeHtml(claveLiteral)}</b></span>`
      : (role === ROLES.DIRECTOR ? `<span class="text-[9px] text-slate-400 font-mono italic">no aplica clave</span>` : '');

    if (vacant) {
      // Plaza vacante card: distinct dashed border, no metrics, no actions.
      return `
        <div class="team-card border-dashed border-2 border-amber-200 bg-amber-50/40" data-user-id="${u.id}">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full border-2 border-dashed border-amber-400 flex items-center justify-center text-amber-500 text-lg">✕</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-bold text-sm text-slate-500 italic truncate">Plaza sin titular</span>
              </div>
              <div class="flex items-center gap-1.5 text-[11px] text-slate-500 mt-1 flex-wrap">
                <span class="role-badge role-badge--${role}" style="font-size:9px;padding:1px 6px">${ROLE_LABEL[role] || ''}</span>
                ${chainHtml}
              </div>
              <div class="text-[10px] text-slate-400 mt-0.5 italic">No se asignan visitas hasta que se cubra la plaza.</div>
            </div>
          </div>
        </div>
      `;
    }

    return `
      <div class="team-card team-card--${presence.status}" data-user-id="${u.id}">
        <div class="flex items-start gap-3">
          <div class="team-avatar team-avatar--${role}">${initials(u.full_name)}</div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="font-bold text-sm text-slate-800 truncate">${escapeHtml(u.full_name)}</span>
              <span class="presence-dot presence-dot--${presence.status}"></span>
              <span class="text-[10px] font-semibold ${presence.status === 'live' ? 'text-emerald-600' : presence.status === 'idle' ? 'text-amber-600' : 'text-slate-400'}">${presenceTxt.txt}</span>
            </div>
            <div class="flex items-center gap-1.5 text-[11px] text-slate-500 mt-1 flex-wrap">
              <span class="role-badge role-badge--${role}" style="font-size:9px;padding:1px 6px">${ROLE_LABEL[role]}</span>
              ${chainHtml}
            </div>
            <div class="flex items-center gap-2 mt-0.5 flex-wrap">
              ${claveHtml}
              <span class="text-[10px] text-slate-400 truncate">${escapeHtml(u.zone || '')}</span>
            </div>
          </div>
          <div class="text-right flex-shrink-0">
            <div class="text-lg font-black text-slate-800 tabular-nums">${monthlyPct}%</div>
            <div class="text-[9px] text-slate-400 uppercase font-bold tracking-wider">mes</div>
          </div>
        </div>

        <div class="grid grid-cols-3 gap-2 mt-3">
          <div class="kpi-mini">
            <div class="kpi-mini__value">${m.done_today || 0}/${m.planned_today || 0}</div>
            <div class="kpi-mini__label">HOY · ${todayPct}%</div>
          </div>
          <div class="kpi-mini">
            <div class="kpi-mini__value">${m.done || 0}/${m.planned || 0}</div>
            <div class="kpi-mini__label">MES</div>
          </div>
          <div class="kpi-mini">
            ${sparkline(u.sparkline || [])}
            <div class="kpi-mini__label">14 DÍAS</div>
          </div>
        </div>

        <div class="flex items-center gap-2 mt-3 pt-3 border-t border-slate-100">
          <button data-action="map" data-user-id="${u.id}" class="flex-1 text-[11px] font-bold text-[#1b365d] bg-slate-100 hover:bg-slate-200 transition rounded-lg py-2">Ver en mapa</button>
          ${u.role !== ROLES.REPRESENTANTE ? `<button data-action="drill" data-user-id="${u.id}" class="flex-1 text-[11px] font-bold text-white bg-[#1b365d] hover:bg-[#152845] transition rounded-lg py-2" title="Explorar el equipo a su cargo">Ver su equipo →</button>` : ''}
          <button data-action="impersonate" data-user-id="${u.id}" class="text-[11px] font-bold text-violet-600 hover:bg-violet-50 transition rounded-lg px-3 py-2" title="Ver la app como este usuario">Ver como</button>
        </div>
      </div>
    `;
  }

  // ──────────────────────────────────────────────────────────
  // VIEW: Analytics — rich
  // ──────────────────────────────────────────────────────────
  const ANALYTICS_FILTERS = {
    scopeUserId: null,    // null = "Yo + mi equipo"
    role: null,           // 'gerente_ventas' | 'supervisor' | 'representante' | null
    userId: null,         // single-user filter
    days: 30,             // 7 | 14 | 30 | 60
    poblacion: null,      // Entidad Federativa (col. marzam_clients.poblacion)
  };

  // ──────────────────────────────────────────────────────────
  // Rep personal scorecard (Phase 2). Replaces the role/person filtered
  // dashboard for reps — that view shows "Top performers" / "Necesitan
  // apoyo" relative to peers, which is meaningless when scope is self.
  //
  // Layout: 4 plain-text KPIs, one horizontal progress bar (cumplimiento),
  // one sparkline (14 days). Per Plan agent recommendation (text-heavy >
  // chart-heavy at 5-second glance distance for field reps).
  // ──────────────────────────────────────────────────────────
  async function renderRepScorecard(body) {
    if (window.MarzamPharmaciesMap) window.MarzamPharmaciesMap.hide();
    body.innerHTML = `<div class="space-y-3">${window.MarzamSkeleton ? window.MarzamSkeleton() : ''}${window.MarzamSkeleton ? window.MarzamSkeleton() : ''}</div>`;

    const meId = APP.user && APP.user.id;
    const role = normalizeRole(APP.user && APP.user.role);
    const inStore = APP.isDemo && DEMO_H && DEMO_H.STORE;
    const dayTarget = inStore ? (DEMO_H.STORE.day_targets[role] || 5) : 5;
    const seed = (inStore && DEMO_H.STORE.compliance_seeds[meId]) || { today: 0, month: 0, trend: [] };

    // Real data first; fall back to seed for empty pre-launch state.
    let visits = [];
    try { visits = await API.get(`/visits/by-user/${meId}?days=30`); } catch { /* keep empty */ }
    const total = Array.isArray(visits) ? visits.length : 0;
    const interested = Array.isArray(visits)
      ? visits.filter((v) => v.outcome === 'interested').length
      : 0;
    const monthTarget = dayTarget * 22;
    const monthDone = total || Math.round((seed.month / 100) * monthTarget);
    const monthPct = monthTarget ? Math.min(100, Math.round((monthDone / monthTarget) * 100)) : 0;
    const interestedPct = total ? Math.round((interested / total) * 100) : 0;

    // Km — best-effort, may be unavailable pre-launch
    let kmWeek = 0, kmMonth = 0;
    try {
      const k = await API.get(`/tracking/km-summary/${meId}`).catch(() => null);
      if (k) { kmWeek = Number(k.week_km || 0); kmMonth = Number(k.month_km || 0); }
    } catch { /* ignore */ }

    // Ranking — only show if top-3 or bottom-3 (motivational filter per plan).
    let myRankRow = null;
    try {
      const team = await API.get('/reporting/reps').catch(() => []);
      if (Array.isArray(team) && team.length) {
        const sorted = team.slice().sort((a, b) => (b.total_visits || 0) - (a.total_visits || 0));
        const myIdx = sorted.findIndex((r) => r.rep_id === meId);
        if (myIdx >= 0) {
          const isTop3 = myIdx < 3;
          const isBottom3 = myIdx >= sorted.length - 3 && sorted.length > 3;
          if (isTop3 || isBottom3) myRankRow = { rank: myIdx + 1, total: sorted.length, isTop3, isBottom3 };
        }
      }
    } catch { /* ignore */ }

    // Trend sparkline data — last 14 days.
    const trend = Array.isArray(seed.trend) && seed.trend.length
      ? seed.trend.slice(-14)
      : Array.from({ length: 14 }, () => 0);

    body.innerHTML = `
      <div class="space-y-3">
        <!-- Cumplimiento del mes (most prominent — visit goal) -->
        <div class="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
          <div class="flex items-center justify-between mb-2">
            <div>
              <div class="text-[10px] font-bold uppercase tracking-widest text-slate-500">Cumplimiento del mes</div>
              <div class="text-xl font-black text-slate-800 mt-0.5">${monthDone}<span class="text-base text-slate-400">/${monthTarget}</span> visitas</div>
            </div>
            <div class="text-2xl font-black ${monthPct >= 80 ? 'text-emerald-600' : monthPct >= 50 ? 'text-amber-600' : 'text-rose-600'}">
              ${monthPct}%
            </div>
          </div>
          <div class="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div class="h-full rounded-full transition-all duration-500 ${monthPct >= 80 ? 'bg-emerald-500' : monthPct >= 50 ? 'bg-amber-500' : 'bg-rose-500'}"
                 style="width:${monthPct}%"></div>
          </div>
          <div class="text-[10px] text-slate-400 mt-2">Meta: ${monthTarget} visitas (${dayTarget}/día × 22 días hábiles)</div>
        </div>

        <!-- Mi tasa de interesados — competitive metric, prominent -->
        <div class="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-[10px] font-bold uppercase tracking-widest text-slate-500">Mi tasa de interesados</div>
              <div class="text-lg font-black text-slate-800 mt-0.5">${interested}<span class="text-sm text-slate-400">/${total}</span> prospectos</div>
              <div class="text-[11px] text-slate-500 mt-0.5">Visitas con outcome "Interesado"</div>
            </div>
            <div class="text-3xl font-black text-orange-600">${interestedPct}%</div>
          </div>
        </div>

        <!-- Km recorridos -->
        <div class="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm grid grid-cols-2 gap-4">
          <div>
            <div class="text-[10px] font-bold uppercase tracking-widest text-slate-500">Km esta semana</div>
            <div class="text-lg font-black text-slate-800 mt-0.5">${kmWeek.toFixed(0)} km</div>
          </div>
          <div>
            <div class="text-[10px] font-bold uppercase tracking-widest text-slate-500">Km este mes</div>
            <div class="text-lg font-black text-slate-800 mt-0.5">${kmMonth.toFixed(0)} km</div>
          </div>
        </div>

        <!-- Ranking — solo si está en top-3 o bottom-3 -->
        ${myRankRow ? `
          <div class="bg-gradient-to-br ${myRankRow.isTop3 ? 'from-amber-50 to-orange-50 border-amber-200' : 'from-slate-50 to-slate-100 border-slate-200'} border rounded-2xl p-4">
            <div class="flex items-center gap-3">
              <div class="w-12 h-12 rounded-full ${myRankRow.isTop3 ? 'bg-amber-500' : 'bg-slate-400'} text-white flex items-center justify-center font-black text-lg">
                #${myRankRow.rank}
              </div>
              <div>
                <div class="text-[10px] font-bold uppercase tracking-widest ${myRankRow.isTop3 ? 'text-amber-700' : 'text-slate-600'}">${myRankRow.isTop3 ? '🏆 Top performers' : 'Sigue empujando'}</div>
                <div class="text-sm font-bold text-slate-800 mt-0.5">Posición ${myRankRow.rank} de ${myRankRow.total} en tu equipo</div>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- Trend sparkline -->
        <div class="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
          <div class="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-2">Visitas últimos 14 días</div>
          ${sparkline(trend)}
        </div>

        <!-- Empty hint when no data yet -->
        ${total === 0 && monthDone === 0 ? `
          <div class="text-center py-4 text-[12px] text-slate-400">
            Aún no tienes visitas registradas. Tu progreso se llenará automáticamente conforme trabajes en campo.
          </div>
        ` : ''}
      </div>
    `;
  }

  async function renderAnalytics(body) {
    if (window.MarzamPharmaciesMap) window.MarzamPharmaciesMap.hide();
    // Phase 2: Reps see a personal scorecard, not the manager dashboard with
    // role/person filters and Top performers / Necesitan apoyo. The latter is
    // demoralizing on a one-rep view ("you are #5 of 7") and the filters are
    // useless when scope = self.
    if (APP.role === ROLES.REPRESENTANTE) {
      return renderRepScorecard(body);
    }
    // Pre-load EF list (canonical + per-user) for the filter dropdown.
    let efOptions = [];
    let _teamForAnalytics = [];
    try {
      const [team, clientsRaw, pob] = await Promise.all([
        API.get('/team/descendants').catch(() => []),
        API.get('/marzam/clients?limit=2000').catch(() => []),
        API.get('/poblaciones').catch(() => null),
      ]);
      _teamForAnalytics = team || [];
      const clientList = Array.isArray(clientsRaw) ? clientsRaw : (clientsRaw?.clients || clientsRaw?.rows || clientsRaw?.data || []);
      // Hidrata `u.poblaciones` desde el padrón cuando el backend no lo hizo.
      if (window.MarzamEF?.hydrateTeam) window.MarzamEF.hydrateTeam(_teamForAnalytics, clientList);
      const raw = [];
      _teamForAnalytics.forEach((u) => (Array.isArray(u.poblaciones) ? u.poblaciones : []).forEach((p) => raw.push(p)));
      for (const c of clientList) if (c.poblacion) raw.push(c.poblacion);
      if (pob?.options) for (const o of pob.options) if (o?.value && o.value !== '__all__') raw.push(o.value);
      efOptions = efDedup(raw);
    } catch { /* keep empty */ }
    // Inherit the active EF filter from sibling tabs.
    if (!ANALYTICS_FILTERS.poblacion) {
      ANALYTICS_FILTERS.poblacion = window.MarzamPlanZone || (APP.poblacion && APP.poblacion !== '__all__' ? APP.poblacion : null);
    }

    body.innerHTML = `
      <div class="analytics-layout">
        <details class="analytics-filters" open>
          <summary class="text-sm font-semibold text-slate-600 bg-slate-100 rounded-xl px-3 py-2 mb-2 cursor-pointer select-none list-none flex items-center justify-between gap-1.5">
            <span>Filtros</span>
            <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7"/></svg>
          </summary>
          <div class="bg-white border border-slate-200 rounded-2xl p-3 mb-4">
            <div class="filter-grid grid grid-cols-2 gap-2">
              <select id="filter-period" class="text-xs font-semibold bg-slate-100 border-0 rounded-lg px-2 py-2 outline-none">
                <option value="7">Últimos 7 días</option>
                <option value="14">Últimos 14 días</option>
                <option value="30" selected>Últimos 30 días</option>
                <option value="60">Últimos 60 días</option>
              </select>
              <select id="filter-role" class="text-xs font-semibold bg-slate-100 border-0 rounded-lg px-2 py-2 outline-none">
                <option value="">Todos los roles</option>
                ${APP.role === ROLES.DIRECTOR ? '<option value="gerente_ventas">Gerentes</option>' : ''}
                ${[ROLES.DIRECTOR, ROLES.GERENTE].includes(APP.role) ? '<option value="supervisor">Supervisores</option>' : ''}
                <option value="representante">Representantes</option>
              </select>
              <select id="filter-person" class="text-xs font-semibold bg-slate-100 border-0 rounded-lg px-2 py-2 outline-none">
                <option value="">Todas las personas</option>
              </select>
              <select id="filter-poblacion" class="text-xs font-semibold bg-slate-100 border-0 rounded-lg px-2 py-2 outline-none col-span-2 md:col-span-1">
                <option value="">Todas las EF</option>
                ${efOptions.map((p) => `<option value="${escapeHtml(p)}" ${ANALYTICS_FILTERS.poblacion && efKey(ANALYTICS_FILTERS.poblacion) === efKey(p) ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
              </select>
              <button id="filter-reset" class="col-span-2 text-xs font-semibold bg-slate-100 hover:bg-slate-200 rounded-lg px-2 py-2 outline-none">Limpiar</button>
            </div>
          </div>
        </details>

        <div id="analytics-content"></div>
      </div>
    `;
    window._analyticsTeam = _teamForAnalytics;

    // Populate person filter from team
    try {
      const team = await API.get('/team');
      const subs = team.descendants || [];
      const sel = document.getElementById('filter-person');
      subs.forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.full_name} · ${ROLE_LABEL[normalizeRole(s.role)] || s.role}`;
        sel.appendChild(opt);
      });
    } catch { /* silent */ }

    const wireFilter = (id, key, parser = (v) => v || null) => {
      const el = document.getElementById(id);
      el.addEventListener('change', () => { ANALYTICS_FILTERS[key] = parser(el.value); renderAnalyticsContent(); });
    };
    wireFilter('filter-period', 'days', (v) => Number(v) || 30);
    wireFilter('filter-role', 'role');
    wireFilter('filter-person', 'userId');
    // EF filter: also sincroniza con window.MarzamPlanZone para que las
    // pestañas hermanas (Cuotas, Crear plan, Avance, Análisis) lo hereden.
    const efSel = document.getElementById('filter-poblacion');
    if (efSel) {
      efSel.addEventListener('change', () => {
        ANALYTICS_FILTERS.poblacion = efSel.value || null;
        window.MarzamPlanZone = ANALYTICS_FILTERS.poblacion;
        renderAnalyticsContent();
      });
    }
    document.getElementById('filter-reset').addEventListener('click', () => {
      ANALYTICS_FILTERS.role = null; ANALYTICS_FILTERS.userId = null;
      ANALYTICS_FILTERS.days = 30; ANALYTICS_FILTERS.poblacion = null;
      window.MarzamPlanZone = null;
      document.getElementById('filter-role').value = '';
      document.getElementById('filter-person').value = '';
      document.getElementById('filter-period').value = '30';
      if (efSel) efSel.value = '';
      renderAnalyticsContent();
    });

    await renderAnalyticsContent();
  }

  async function renderAnalyticsContent() {
    const wrap = document.getElementById('analytics-content');
    wrap.innerHTML = window.MarzamSkeleton() + window.MarzamSkeleton() + window.MarzamSkeleton();

    const qs = new URLSearchParams();
    if (ANALYTICS_FILTERS.scopeUserId) qs.set('scope_user_id', ANALYTICS_FILTERS.scopeUserId);
    if (ANALYTICS_FILTERS.role) qs.set('role', ANALYTICS_FILTERS.role);
    if (ANALYTICS_FILTERS.userId) qs.set('user_id', ANALYTICS_FILTERS.userId);
    if (ANALYTICS_FILTERS.days) qs.set('days', String(ANALYTICS_FILTERS.days));
    // Pasamos `poblacion` por si el backend la soporta; si no, filtraremos
    // client-side cruzando contra el team enriquecido.
    if (ANALYTICS_FILTERS.poblacion) qs.set('poblacion', ANALYTICS_FILTERS.poblacion);
    const qStr = qs.toString() ? `?${qs.toString()}` : '';

    const [funnelRaw, heatmap, paretoMix, untouched] = await Promise.all([
      API.get(`/analytics/funnel${qStr}`).catch((e) => { console.warn(e); return null; }),
      API.get(`/analytics/team${qStr.replace(/days=\d+&?/, '')}`).catch(() => ({ rows: [], users: [] })),
      API.get(`/analytics/pareto-mix${qStr.replace(/days=\d+&?/, '')}`).catch(() => []),
      API.get(`/analytics/untouched${ANALYTICS_FILTERS.poblacion ? '?poblacion=' + encodeURIComponent(ANALYTICS_FILTERS.poblacion) : ''}`).catch(() => []),
    ]);

    // Filtro client-side por Entidad Federativa: cruza arrays per_user /
    // top_performers / underperformers contra `_analyticsTeam[*].poblaciones`.
    // Tolerancia data-gap: si team[*].poblaciones está vacío, el user pasa
    // (cobertura desconocida).
    if (ANALYTICS_FILTERS.poblacion && funnelRaw) {
      const target = efKey(ANALYTICS_FILTERS.poblacion);
      const teamMap = new Map();
      for (const u of (window._analyticsTeam || [])) teamMap.set(u.id, Array.isArray(u.poblaciones) ? u.poblaciones : []);
      const userInEF = (uid) => {
        const list = teamMap.get(uid);
        if (!list || list.length === 0) return false; // strict post-hidratación
        return list.map(efKey).includes(target);
      };
      ['per_user', 'top_performers', 'underperformers'].forEach((k) => {
        if (Array.isArray(funnelRaw[k])) funnelRaw[k] = funnelRaw[k].filter((row) => userInEF(row.user_id));
      });
      // Recompute totals from the filtered per_user when available so the
      // funnel hero matches the EF cut.
      if (Array.isArray(funnelRaw.per_user)) {
        const t = funnelRaw.totals || {};
        const visits = funnelRaw.per_user.reduce((s, u) => s + (u.total || 0), 0);
        const farChk = funnelRaw.per_user.reduce((s, u) => s + (u.far_checkins || 0), 0);
        const inv = funnelRaw.per_user.reduce((s, u) => s + (u.invalid_count || 0), 0);
        funnelRaw.totals = { ...t, visits, far_checkins: farChk, invalid_pharmacies: inv };
        funnelRaw.scope = { ...(funnelRaw.scope || {}), size: funnelRaw.per_user.length };
      }
    }

    // Always render the dashboard scaffolding so the user sees the FULL
    // layout (cards, axes, headers) even when there's no data yet. Empty
    // states surface as overlays on each panel — this matches the user's
    // ask: "que se vea como se vería cuando hubiera datos".
    const funnel = funnelRaw || emptyFunnel(ANALYTICS_FILTERS.days);
    const isEmpty = !funnelRaw;

    wrap.innerHTML = `
      ${isEmpty ? `
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 flex items-center gap-2 text-[12px]">
          <svg class="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          <span class="text-amber-700"><b>Vista previa.</b> Aún no hay visitas registradas con los filtros actuales — el dashboard se llenará automáticamente conforme los reps trabajen.</span>
        </div>` : ''}
      ${renderFunnelHero(funnel)}
      ${renderOutcomeAndDistance(funnel)}
      ${renderTopPerformers(funnel)}
      ${renderAnomaliesFeed(funnel)}
      ${renderHourlyDistribution(funnel)}
      ${renderHeatmap(heatmap || { rows: [], users: [] })}
      ${renderParetoMix(paretoMix || [])}
      ${renderUntouched(untouched || [])}
      ${renderPerUserTable(funnel)}
    `;

    mountAnalyticsCharts(funnel, paretoMix || []);
  }

  /**
   * Empty-but-shaped funnel: every key the renderers read is present so the
   * layout draws unchanged. Charts get zero-filled series so axes still
   * appear. Distance buckets are pre-populated with the four canonical bins
   * so the bar chart frame is drawn. Hourly distribution covers 8h–20h.
   */
  function emptyFunnel(days = 30) {
    const hours = [];
    for (let h = 8; h <= 20; h += 1) hours.push({ hour: h, count: 0 });
    return {
      period: { days },
      scope: { size: 0 },
      totals: {
        visits: 0,
        coverage_pct: 0,
        unique_pharmacies_covered: 0,
        padron_size: 0,
        far_checkins: 0,
        invalid_pharmacies: 0,
      },
      outcome_breakdown: [
        { outcome: 'visited', count: 0 },
        { outcome: 'interested', count: 0 },
        { outcome: 'not_interested', count: 0 },
        { outcome: 'needs_follow_up', count: 0 },
        { outcome: 'closed', count: 0 },
      ],
      distance_buckets: [
        { bucket: '0-50', count: 0 },
        { bucket: '50-200', count: 0 },
        { bucket: '200-500', count: 0 },
        { bucket: '500+', count: 0 },
      ],
      hourly_distribution: hours,
      top_performers: [],
      underperformers: [],
      anomalies: [],
      per_user: [],
    };
  }

  function mountAnalyticsCharts(funnel, paretoMix) {
    if (!window.MarzamCharts) return;
    // 1) Donut de outcomes
    const outcomes = (funnel && funnel.outcome_breakdown) || [];
    const outcomeCanvas = document.getElementById('chart-outcome-doughnut');
    if (outcomeCanvas && outcomes.length) {
      MarzamCharts.outcomeDoughnut(outcomeCanvas, outcomes);
    }
    // 2) Bar horario
    const hourly = (funnel && funnel.hourly_distribution) || [];
    const hourlyCanvas = document.getElementById('chart-hourly-bar');
    if (hourlyCanvas && hourly.length) {
      MarzamCharts.hourlyBar(hourlyCanvas, hourly);
    }
    // 3) Bar Pareto plan vs done
    const paretoCanvas = document.getElementById('chart-pareto-bar');
    if (paretoCanvas && Array.isArray(paretoMix) && paretoMix.length) {
      MarzamCharts.paretoBar(paretoCanvas, paretoMix);
    }
    // 4) Línea de tendencia (cumplimiento del scope)
    const trendCanvas = document.getElementById('chart-trend-line');
    if (trendCanvas && APP.isDemo && DEMO_H && DEMO_H.STORE) {
      const me = (DEMO_H.helpers && DEMO_H.helpers.getCurrentUser && DEMO_H.helpers.getCurrentUser()) || APP.user;
      const seed = me && DEMO_H.STORE.compliance_seeds[me.id];
      const values = (seed && seed.trend) || [];
      if (values.length) {
        MarzamCharts.trendLine(trendCanvas, {
          labels: values.map((_, i) => `D-${values.length - i}`),
          values,
          target: 85,
        });
      }
    }
  }

  function renderFunnelHero(f) {
    const t = f.totals || {};
    const farPct = t.visits > 0 ? Math.round((t.far_checkins / t.visits) * 100) : 0;
    return `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div class="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-4">
          <div class="text-[10px] font-bold uppercase tracking-wider text-blue-700">Visitas registradas</div>
          <div class="text-3xl font-black text-blue-900 tabular-nums mt-1">${(t.visits || 0).toLocaleString()}</div>
          <div class="text-[10px] text-blue-600 mt-1">en ${f.period?.days || 30} días · ${f.scope?.size || 0} personas</div>
        </div>
        <div class="bg-gradient-to-br from-emerald-50 to-green-50 border border-emerald-200 rounded-2xl p-4">
          <div class="text-[10px] font-bold uppercase tracking-wider text-emerald-700">Cobertura padrón</div>
          <div class="text-3xl font-black text-emerald-900 tabular-nums mt-1">${t.coverage_pct || 0}%</div>
          <div class="text-[10px] text-emerald-600 mt-1">${(t.unique_pharmacies_covered || 0).toLocaleString()} de ${(t.padron_size || 0).toLocaleString()}</div>
        </div>
        <div class="bg-gradient-to-br from-rose-50 to-pink-50 border border-rose-200 rounded-2xl p-4">
          <div class="text-[10px] font-bold uppercase tracking-wider text-rose-700">Checkins lejanos</div>
          <div class="text-3xl font-black text-rose-900 tabular-nums mt-1">${(t.far_checkins || 0).toLocaleString()}</div>
          <div class="text-[10px] text-rose-600 mt-1">${farPct}% del total · &gt;200m</div>
        </div>
        <div class="bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-4">
          <div class="text-[10px] font-bold uppercase tracking-wider text-amber-700">Sin existir / inválidas</div>
          <div class="text-3xl font-black text-amber-900 tabular-nums mt-1">${(t.invalid_pharmacies || 0).toLocaleString()}</div>
          <div class="text-[10px] text-amber-600 mt-1">reportadas como inválidas</div>
        </div>
      </div>
    `;
  }

  function renderOutcomeAndDistance(f) {
    const outcomes = f.outcome_breakdown || [];
    const realTotal = outcomes.reduce((s, o) => s + o.count, 0);
    const total = realTotal || 1; // for the "Total: X" copy line

    const dist = f.distance_buckets || [];
    const distTotal = dist.reduce((s, d) => s + d.count, 0);
    const distMax = Math.max(1, ...dist.map((d) => d.count));
    const distColors = { '0-50': '#10b981', '50-200': '#3b82f6', '200-500': '#f59e0b', '500+': '#ef4444' };
    const distLabels = { '0-50': '< 50 m', '50-200': '50–200 m', '200-500': '200–500 m', '500+': '> 500 m' };
    const distRows = dist.map((d) => `
      <div class="flex items-center gap-2">
        <span class="text-[10px] font-bold text-slate-600 w-20">${distLabels[d.bucket] || d.bucket}</span>
        <div class="flex-1 h-5 bg-slate-100 rounded overflow-hidden relative">
          <div class="h-full" style="width:${(d.count / distMax) * 100}%; background:${distColors[d.bucket] || '#94a3b8'}"></div>
          <span class="absolute right-2 top-0 leading-5 text-[10px] font-bold text-slate-700">${d.count}</span>
        </div>
      </div>
    `).join('');

    return `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div class="bg-white border border-slate-200 rounded-2xl p-4">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Distribución de resultados</h4>
          <div class="relative" style="height:200px">
            <canvas id="chart-outcome-doughnut" aria-label="Donut de outcomes"></canvas>
            ${realTotal === 0 ? emptyOverlay('Sin visitas en el periodo') : ''}
          </div>
          <p class="text-[10px] text-slate-400 mt-2 text-center">Total: <b class="text-slate-700 tabular-nums">${realTotal.toLocaleString()}</b> visitas</p>
        </div>
        <div class="bg-white border border-slate-200 rounded-2xl p-4">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">Distancia del checkin a la farmacia</h4>
          <p class="text-[10px] text-slate-400 mb-3">Mide qué tan cerca estuvo el rep al registrar la visita.</p>
          <div class="relative space-y-2 ${distTotal === 0 ? 'opacity-50' : ''}">${distRows}</div>
          ${distTotal === 0 ? '<div class="text-[10px] text-center text-slate-400 italic mt-2">Las barras se llenarán cuando los reps registren checkins.</div>' : ''}
        </div>
      </div>
    `;
  }

  function renderTopPerformers(f) {
    const top = (f.top_performers || []).slice(0, 5);
    const bot = (f.underperformers || []).slice(0, 5);
    const card = (u, kind) => {
      const role = normalizeRole(u.role);
      return `
        <div class="flex items-center gap-2 py-1.5 border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50 -mx-3 px-3 rounded transition" onclick="window.MarzamApp.pushDrill('${u.user_id}')">
          <div class="team-avatar team-avatar--${role}" style="width:28px;height:28px;font-size:10px">${(u.full_name || '?').split(/\s+/).slice(0,2).map((s)=>s[0]).join('').toUpperCase()}</div>
          <div class="flex-1 min-w-0">
            <div class="text-xs font-bold text-slate-800 truncate">${u.full_name}</div>
            <div class="text-[10px] text-slate-400 truncate">${ROLE_LABEL[role]} · ${u.zone || ''}</div>
          </div>
          <div class="text-right flex-shrink-0">
            <div class="text-sm font-black ${kind === 'top' ? 'text-emerald-600' : 'text-rose-600'} tabular-nums">${kind === 'top' ? u.total : (u.compliance_pct ?? '—') + '%'}</div>
            <div class="text-[9px] text-slate-400 uppercase font-bold">${kind === 'top' ? 'visitas' : 'cumplim.'}</div>
          </div>
        </div>
      `;
    };
    return `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div class="bg-white border border-emerald-200 rounded-2xl p-4">
          <div class="flex items-center gap-2 mb-3">
            <div class="w-7 h-7 rounded-lg bg-emerald-100 flex items-center justify-center text-emerald-600">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path d="M12 15l-3.5-3.5L4 16l4 4 4-4-4-4z"/><path d="M5 3l3 3"/><path d="M21 21l-3-3"/><path d="M16 16h6v-6"/></svg>
            </div>
            <h4 class="text-xs font-bold text-emerald-700 uppercase tracking-wider">Top performers</h4>
          </div>
          ${top.length ? top.map((u) => card(u, 'top')).join('') : '<p class="text-xs text-slate-400 py-4 text-center">Sin datos</p>'}
        </div>
        <div class="bg-white border border-rose-200 rounded-2xl p-4">
          <div class="flex items-center gap-2 mb-3">
            <div class="w-7 h-7 rounded-lg bg-rose-100 flex items-center justify-center text-rose-600">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
            </div>
            <h4 class="text-xs font-bold text-rose-700 uppercase tracking-wider">Necesitan apoyo</h4>
          </div>
          ${bot.length ? bot.map((u) => card(u, 'bottom')).join('') : '<p class="text-xs text-slate-400 py-4 text-center">Sin datos</p>'}
        </div>
      </div>
    `;
  }

  function emptyOverlay(msg) {
    return `<div class="absolute inset-0 flex items-center justify-center pointer-events-none bg-white/75 backdrop-blur-sm rounded">
      <div class="text-center">
        <svg class="w-7 h-7 text-slate-300 mx-auto mb-1" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path d="M3 3v18h18"/><circle cx="9" cy="14" r="1.5"/><circle cx="14" cy="9" r="1.5"/><circle cx="18" cy="13" r="1.5"/></svg>
        <div class="text-[11px] font-semibold text-slate-400">${msg || 'Aún sin datos'}</div>
      </div>
    </div>`;
  }

  function renderAnomaliesFeed(f) {
    const a = f.anomalies || [];
    const SEVERITY_BG = { high: 'bg-rose-50 border-rose-200', medium: 'bg-amber-50 border-amber-200', low: 'bg-slate-50 border-slate-200' };
    const SEVERITY_DOT = { high: 'bg-rose-500', medium: 'bg-amber-500', low: 'bg-slate-400' };
    const empty = !a.length;
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
        <div class="flex items-center justify-between mb-3">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider">Feed de anomalías</h4>
          <span class="text-[10px] text-slate-400">${empty ? 'sin eventos' : a.length + ' eventos'}</span>
        </div>
        <div class="space-y-2 ${empty ? '' : 'max-h-[280px] overflow-y-auto'}">
          ${empty ? `<div class="text-center py-6 text-[12px] text-slate-400">
            <svg class="w-6 h-6 mx-auto mb-1 text-emerald-300" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>
            Sin anomalías detectadas en el periodo.
          </div>` : ''}
          ${a.map((ev) => `
            <div class="flex items-start gap-2 p-2 ${SEVERITY_BG[ev.severity] || SEVERITY_BG.low} border rounded-xl cursor-pointer hover:opacity-80 transition" onclick="window.MarzamApp.pushDrill('${ev.user_id}')">
              <div class="w-2 h-2 rounded-full ${SEVERITY_DOT[ev.severity] || SEVERITY_DOT.low} mt-1.5 flex-shrink-0"></div>
              <div class="flex-1 min-w-0">
                <div class="text-xs font-bold text-slate-800">${ev.title}</div>
                <div class="text-[10px] text-slate-500 truncate">${ev.detail || ''}</div>
              </div>
              <span class="text-[10px] text-slate-400 flex-shrink-0">${timeAgo(ev.recorded_at)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderHourlyDistribution(f) {
    const hourly = f.hourly_distribution || [];
    const total = hourly.reduce((s, h) => s + (h.count || 0), 0);
    return `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div class="bg-white border border-slate-200 rounded-2xl p-4">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Distribución horaria de visitas</h4>
          <div class="relative" style="height:160px">
            <canvas id="chart-hourly-bar"></canvas>
            ${total === 0 ? emptyOverlay('Sin visitas en el periodo') : ''}
          </div>
        </div>
        <div class="bg-white border border-slate-200 rounded-2xl p-4">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Tendencia de cumplimiento</h4>
          <div class="relative" style="height:160px">
            <canvas id="chart-trend-line"></canvas>
            <div id="trend-empty-overlay" class="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div class="text-center">
                <div class="text-[11px] font-semibold text-slate-400">Se llenará con datos diarios</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderPerUserTable(f) {
    const users = (f.per_user || []).slice(0, 12);
    if (!users.length) {
      return `
      <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
        <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Detalle por persona</h4>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-[10px] uppercase text-slate-500 font-bold border-b border-slate-200">
                <th class="text-left py-2 px-2">Persona</th>
                <th class="text-right py-2 px-2">Visitas</th>
                <th class="text-right py-2 px-2">Lejanos</th>
                <th class="text-right py-2 px-2">Inválidas</th>
                <th class="text-right py-2 px-2">Interesados</th>
                <th class="text-right py-2 px-2">Cumplim.</th>
              </tr>
            </thead>
            <tbody>
              <tr><td colspan="6" class="text-center py-6 text-[11px] text-slate-400 italic">Aún no hay personas con visitas registradas. Los nombres aparecerán aquí en cuanto los reps comiencen su jornada.</td></tr>
            </tbody>
          </table>
        </div>
      </div>`;
    }
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
        <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Detalle por persona</h4>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-[10px] uppercase text-slate-500 font-bold border-b border-slate-200">
                <th class="text-left py-2 px-2">Persona</th>
                <th class="text-right py-2 px-2">Visitas</th>
                <th class="text-right py-2 px-2">Lejanos</th>
                <th class="text-right py-2 px-2">Inválidas</th>
                <th class="text-right py-2 px-2">Interesados</th>
                <th class="text-right py-2 px-2">Cumplim.</th>
              </tr>
            </thead>
            <tbody>
              ${users.map((u) => {
                const role = normalizeRole(u.role);
                return `
                <tr class="border-b border-slate-100 hover:bg-slate-50 cursor-pointer" onclick="window.MarzamApp.pushDrill('${u.user_id}')">
                  <td class="py-2 px-2">
                    <div class="flex items-center gap-2">
                      <div class="team-avatar team-avatar--${role}" style="width:24px;height:24px;font-size:9px">${(u.full_name||'?').split(/\s+/).slice(0,2).map((s)=>s[0]).join('').toUpperCase()}</div>
                      <div class="min-w-0">
                        <div class="font-bold text-slate-800 truncate">${u.full_name}</div>
                        <div class="text-[10px] text-slate-400 truncate">${ROLE_LABEL[role]}</div>
                      </div>
                    </div>
                  </td>
                  <td class="text-right py-2 px-2 font-bold tabular-nums">${u.total}</td>
                  <td class="text-right py-2 px-2 ${u.far_checkins > 0 ? 'text-rose-600 font-bold' : 'text-slate-400'} tabular-nums">${u.far_checkins}</td>
                  <td class="text-right py-2 px-2 ${u.invalid_count > 0 ? 'text-amber-600 font-bold' : 'text-slate-400'} tabular-nums">${u.invalid_count}</td>
                  <td class="text-right py-2 px-2 text-emerald-600 font-bold tabular-nums">${u.interested_count}</td>
                  <td class="text-right py-2 px-2 tabular-nums">${u.compliance_pct != null ? u.compliance_pct + '%' : '—'}</td>
                </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderHeatmap(data) {
    const users = data.users || [];
    if (!users.length) {
      // Empty placeholder grid: 5 fake rows × 14 cells so the manager sees
      // the visual structure and knows what will render when data arrives.
      const placeholderCells = Array.from({ length: 14 }, () => `<div class="w-5 h-5 rounded bg-slate-100"></div>`).join('');
      const rows = Array.from({ length: 5 }, () => `
        <div class="flex items-center gap-2">
          <div class="w-32 mz-skel h-4"></div>
          <div class="flex gap-1">${placeholderCells}</div>
        </div>
      `).join('');
      return `
        <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4 relative">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Heatmap de cumplimiento (últimos 14 días)</h4>
          <div class="space-y-2 opacity-50">${rows}</div>
          ${emptyOverlay('Aún sin visitas — el heatmap se irá llenando día a día')}
        </div>`;
    }
    const rowsByUser = {};
    (data.rows || []).forEach((r) => {
      if (!rowsByUser[r.user_id]) rowsByUser[r.user_id] = {};
      rowsByUser[r.user_id][r.date] = r;
    });
    const dates = Array.from(new Set((data.rows || []).map((r) => r.date))).sort();
    const colorBucket = (pct) => {
      if (pct == null) return 0;
      if (pct < 30) return 1;
      if (pct < 50) return 2;
      if (pct < 70) return 3;
      if (pct < 85) return 4;
      if (pct < 95) return 5;
      return 6;
    };
    const rowsHtml = users.slice(0, 12).map((u) => {
      const cells = dates.map((d) => {
        const r = rowsByUser[u.user_id]?.[d];
        const pct = r?.compliance_pct;
        const bucket = colorBucket(pct);
        const title = r ? `${u.full_name} · ${d}\n${r.done}/${r.planned} (${fmtPct(pct)})` : `${u.full_name} · ${d} (sin datos)`;
        return `<div class="heatmap-cell" data-bucket="${bucket}" title="${title}"></div>`;
      }).join('');
      return `
        <div class="flex items-center gap-2 mb-1.5">
          <div class="w-32 text-[11px] truncate text-slate-700 font-semibold">${u.full_name}</div>
          <div class="flex gap-[2px]">${cells}</div>
        </div>
      `;
    }).join('');
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
        <div class="flex items-center justify-between mb-3">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider">Heatmap de cumplimiento</h4>
          <span class="text-[10px] text-slate-400">${data.period?.from} → ${data.period?.to}</span>
        </div>
        <div class="overflow-x-auto">${rowsHtml}</div>
        <div class="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-slate-100">
          <span class="text-[10px] text-slate-400">Bajo</span>
          ${[1,2,3,4,5,6].map((b) => `<div class="heatmap-cell" data-bucket="${b}" style="width:14px;height:14px"></div>`).join('')}
          <span class="text-[10px] text-slate-400">Alto</span>
        </div>
      </div>
    `;
  }

  function renderParetoMix(data) {
    const total = (data || []).reduce((s, x) => s + (x.planned || 0), 0);
    const COLORS = { A: '#dc2626', B: '#f59e0b', C: '#2563eb' };
    // When the API returns nothing, fabricate the 3 PARETO buckets so the
    // tile renders the structure (chart frame + 3 mini-cards) and the
    // manager sees what will be there.
    const buckets = (data && data.length) ? data : [
      { pareto: 'A', planned: 0, done: 0 },
      { pareto: 'B', planned: 0, done: 0 },
      { pareto: 'C', planned: 0, done: 0 },
    ];
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
        <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Mix PARETO · ${total.toLocaleString()} visitas planeadas</h4>
        <div class="relative" style="height:200px">
          <canvas id="chart-pareto-bar"></canvas>
          ${total === 0 ? emptyOverlay('Configura metas en Plan & Metas') : ''}
        </div>
        <div class="grid grid-cols-3 gap-2 mt-3">
          ${buckets.map((x) => {
            const donePct = x.planned > 0 ? Math.round((x.done / x.planned) * 100) : 0;
            return `
              <div class="text-center p-2 bg-slate-50 rounded-lg">
                <div class="text-[10px] uppercase font-bold tracking-wider" style="color:${COLORS[x.pareto] || '#64748b'}">PARETO ${x.pareto}</div>
                <div class="text-base font-black text-slate-800 mt-0.5 tabular-nums">${donePct}%</div>
                <div class="text-[10px] text-slate-500">${x.done}/${x.planned}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  function renderUntouched(rows) {
    const list = rows || [];
    return `
      <div class="bg-white border border-rose-200 rounded-2xl p-4 mb-4">
        <div class="flex items-center gap-2 mb-3">
          <div class="w-7 h-7 rounded-lg bg-rose-100 flex items-center justify-center text-rose-600">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
          </div>
          <h4 class="text-xs font-bold text-rose-700 uppercase tracking-wider">Top sin visitar 30+ días</h4>
          <span class="ml-auto text-[10px] text-slate-400">${list.length ? list.length + ' farmacias' : 'sin alertas'}</span>
        </div>
        ${list.length === 0 ? `
          <div class="text-center py-5 text-[12px] text-slate-400">
            <svg class="w-6 h-6 mx-auto mb-1 text-emerald-300" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
            Todas las farmacias han sido visitadas en los últimos 30 días.
          </div>
        ` : `
        <div class="space-y-2">
          ${list.slice(0, 5).map((r) => `
            <div class="flex items-center gap-2 py-1.5 border-b border-slate-100 last:border-0">
              <span class="pareto-tag" data-pareto="${r.pareto}">${r.pareto}</span>
              <div class="flex-1 min-w-0">
                <div class="text-xs font-bold text-slate-800 truncate">${window.MarzamUI?.titleCaseEs ? window.MarzamUI.titleCaseEs(r.farmacia_nombre) : r.farmacia_nombre}</div>
                <div class="text-[10px] text-slate-400">${r.delegacion_municipio} · ${r.cpadre}</div>
              </div>
              <span class="text-[11px] font-bold text-rose-600">${r.days_without ?? 0}d</span>
            </div>
          `).join('')}
        </div>`}
      </div>
    `;
  }

  function renderSessionsKPIs(sessions) {
    if (!sessions || !sessions.length) return '';
    const ended = sessions.filter((s) => s.status === 'ended');
    if (!ended.length) return '';
    const avgDuration = ended.reduce((sum, s) => sum + (Date.parse(s.ended_at) - Date.parse(s.started_at)) / 1000, 0) / ended.length;
    const avgVisits = ended.reduce((sum, s) => sum + (s.pharmacies_visited || 0), 0) / ended.length;
    const avgDistance = ended.reduce((sum, s) => sum + (s.total_distance_m || 0), 0) / ended.length;
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
        <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Sesiones de Visita · promedio últimas ${ended.length}</h4>
        <div class="grid grid-cols-3 gap-2">
          <div class="kpi-mini">
            <div class="kpi-mini__value">${fmtDuration(avgDuration)}</div>
            <div class="kpi-mini__label">DURACIÓN</div>
          </div>
          <div class="kpi-mini">
            <div class="kpi-mini__value">${avgVisits.toFixed(1)}</div>
            <div class="kpi-mini__label">FARMACIAS</div>
          </div>
          <div class="kpi-mini">
            <div class="kpi-mini__value">${(avgDistance / 1000).toFixed(1)}km</div>
            <div class="kpi-mini__label">DISTANCIA</div>
          </div>
        </div>
      </div>
    `;
  }

  // ──────────────────────────────────────────────────────────
  // VIEW: Plan & Metas (Frecuencia / Efecto Espejo + Cumplimiento)
  //
  // Sección unificada que reemplaza las antiguas vistas separadas
  // "Targets" y "Distribución".  Tres sub-tabs en una sola fila:
  //
  //   1) Defaults    → sliders por (PARETO × rol) — config estructural.
  //                    Genera/regenera el plan de visitas.  Las farmacias
  //                    nuevas (prospectos) se incluyen automáticamente
  //                    en el bucket C para representantes y supervisores.
  //   2) Por persona → overrides individuales sobre el target diario.
  //   3) Cumplimiento → meta mensual por subordinado + actuals + bloqueos.
  //
  // Encima de los tabs, la matriz de elegibilidad/frecuencia y un banner
  // que une las dos vistas con un mensaje único.
  // ──────────────────────────────────────────────────────────
  // Persistimos el sub-tab activo para que volver a la sección desde otro
  // tab no resetee al usuario al primer sub-tab.
  // ──────────────────────────────────────────────────────────
  // Entidad Federativa — normalización compartida por todas las
  // vistas (Cuotas, Crear plan, Avance, Análisis, Mi Equipo) para que
  // "ESTADO DE MEXICO", "Estado de México" y "estado de mexico" se
  // colapsen a una sola entrada con accent + Title Case correctos.
  //
  // - efKey(s):       clave de comparación (lowercase + sin acentos +
  //                   espacios colapsados). Úsala para `Map`s y filtros.
  // - efDisplay(s):   forma preferida para mostrar (Title Case
  //                   preservando acentos cuando los haya).
  // - efDedup(list):  recibe array de strings, devuelve array único
  //                   ordenado, eligiendo el variant con más acentos
  //                   como display canónico.
  // ──────────────────────────────────────────────────────────
  function efKey(s) {
    if (s == null) return '';
    // Alias map — keeps identical logic with src/utils/efKey.js
    const EF_ALIASES = {
      'edomex':           'estado de mexico',
      'edo mex':          'estado de mexico',
      'edo. mex.':        'estado de mexico',
      'edo.mex.':         'estado de mexico',
      'estado de mex':    'estado de mexico',
      'estado de mex.':   'estado de mexico',
      'cdmx':             'ciudad de mexico',
      'df':               'ciudad de mexico',
      'd.f.':             'ciudad de mexico',
      'distrito federal': 'ciudad de mexico',
    };
    const n = String(s).trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ');
    return EF_ALIASES[n] ?? n;
  }
  function efDisplay(s) {
    if (s == null) return '';
    const trimmed = String(s).trim().replace(/\s+/g, ' ');
    if (!trimmed) return '';
    // Spanish-aware title case: capitaliza la primera letra de cada palabra
    // EXCEPTO conectores cortos comunes ("de", "del", "la", "y") que deben
    // ir en minúscula en topónimos ("Estado de México", no "Estado De México").
    // La primera palabra siempre se capitaliza aunque sea un conector.
    const STOP = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'e', 'o', 'u']);
    return trimmed.toLowerCase().split(' ').map((word, i) => {
      if (i > 0 && STOP.has(word)) return word;
      // Preserva acentos. \p{L} = cualquier letra Unicode.
      return word.replace(/^(\p{L})/u, (c) => c.toUpperCase());
    }).join(' ');
  }
  function _accentScore(s) {
    // Cuenta diacríticos en el original para preferir variantes con
    // acentos (México) sobre variantes sin (Mexico).
    return (String(s || '').normalize('NFD').match(/[̀-ͯ]/g) || []).length;
  }
  function efDedup(values) {
    const byKey = new Map(); // key → { display, score }
    for (const v of (values || [])) {
      const k = efKey(v);
      if (!k) continue;
      const original = String(v).trim();
      const score = _accentScore(original);
      const candidate = score > 0 ? efDisplay(original) : efDisplay(original);
      const existing = byKey.get(k);
      if (!existing || score > existing.score) byKey.set(k, { display: candidate, score });
    }
    return [...byKey.values()].map((x) => x.display).sort((a, b) => a.localeCompare(b));
  }
  // Reconstruye user.poblaciones desde la lista de clientes del padrón.
  // Cuando el backend no pudo enriquecer (assigned_*_id vacíos), este
  // fallback usa los códigos del padrón mismo: cada client tiene
  // rep_code (UEA01), supervisor_code (UEA) y gerencia_code (UE), que
  // mapean al employee_code de cada user (rep = rep_code; supervisor =
  // supervisor_code + '00'; gerente = gerencia_code).
  function efBuildUserMap(clientList) {
    const efByEmpCode = new Map();
    const add = (code, ef) => {
      if (!code || !ef) return;
      if (!efByEmpCode.has(code)) efByEmpCode.set(code, new Set());
      efByEmpCode.get(code).add(ef);
    };
    for (const c of (clientList || [])) {
      const ef = c.poblacion;
      if (!ef) continue;
      add(c.rep_code, ef);
      if (c.supervisor_code) add(c.supervisor_code + '00', ef);
      add(c.gerencia_code, ef);
    }
    return efByEmpCode;
  }
  function efHydrateTeam(team, clientList) {
    const map = efBuildUserMap(clientList);
    for (const u of (team || [])) {
      const existing = Array.isArray(u.poblaciones) ? u.poblaciones : [];
      if (existing.length === 0) {
        const derived = map.get(u.employee_code);
        u.poblaciones = derived ? [...derived] : [];
      }
    }
    return team;
  }
  // Expose globally so plan-editor.js / distribution.js / post-mortem.js
  // (que viven en archivos separados) puedan reutilizar la misma lógica
  // sin duplicar la normalización.
  window.MarzamEF = {
    key: efKey,
    display: efDisplay,
    dedup: efDedup,
    hydrateTeam: efHydrateTeam,
    buildUserMap: efBuildUserMap,
  };

  let _planActiveSubtab = 'defaults';
  let _selectedSubordinateId = null;
  // Zone filter shared between Capacidad (estimación) and Crear plan (picker).
  // null = "Toda la sucursal". Set via `#capacity-zone` selector or the
  // topbar #poblacion-pill (which already updates APP.poblacion).
  let _capacityZone = null;
  // Working days per month assumed by the client-side estimation. Five
  // weekdays × 4.4 weeks ≈ 22 jornadas operativas. Centralizado para que el
  // tooltip del breakdown lo cite y no se desvíe entre lugares.
  const WORKING_DAYS_PER_MONTH = 22;

  // El nombre `renderTargets` se mantiene por compatibilidad con app.js
  // y llamadas internas (regenerar plan).  Internamente delega a renderPlan.
  async function renderTargets(body) { return renderPlan(body); }

  async function renderPlan(body) {
    if (window.MarzamPharmaciesMap) window.MarzamPharmaciesMap.hide();
    if (APP.role === ROLES.REPRESENTANTE) {
      body.innerHTML = '<div class="text-center py-12 text-sm text-slate-400">Solo lectura para tu rol.</div>';
      return;
    }

    // Stepper PDCA de 4 pasos (Plan-Do-Check-Act). Cada paso agrupa 1+
    // sub-tabs internos para preservar `_planActiveSubtab` y el branching
    // existente (defaults/overrides/generar/compliance/resultados). El paso
    // 1 fusiona Cuotas+Ajustes con un sub-toggle interno porque son dos
    // vistas del mismo concepto (cuotas de visitas/día).
    const STEPS = [
      {
        n: 1, id: 'configurar', label: 'Configurar',
        hint: 'Cuántas visitas, cuánta gente',
        children: ['defaults', 'overrides'],
        tip: 'Define las reglas base: cuántas visitas/día por rol y categoría de farmacia, más ajustes individuales por persona. Es la BASE de todo lo que viene después.',
      },
      {
        n: 2, id: 'generar', label: 'Generar',
        hint: 'Asignar farmacias y fechas',
        children: ['generar'],
        tip: 'Crea el plan operativo: selecciona reps, define el rango de fechas, revisa la previsualización en mapa con rutas reales y publícalo.',
      },
      {
        n: 3, id: 'seguir', label: 'Seguir',
        hint: 'Cómo va el mes',
        children: ['compliance'],
        tip: 'Monitoreo del mes en curso: meta de cada persona vs lo que lleva ejecutado. Edita el target inline si necesitas ajustar.',
      },
      {
        n: 4, id: 'cerrar', label: 'Cerrar',
        hint: 'Qué pasó al final',
        children: ['resultados'],
        tip: 'Auditoría de planes cerrados: cumplimiento real, ranking por rep, replay GPS minuto a minuto del día seleccionado.',
      },
    ];

    // Helper: qué paso visual contiene el sub-tab activo.
    const activeStep = STEPS.find((s) => s.children.includes(_planActiveSubtab)) || STEPS[0];

    const stepperHtml = STEPS.map((s, i) => {
      const isActive = activeStep.id === s.id;
      const isPast = activeStep.n > s.n;
      const stateCls = isActive ? 'plan-step--active' : (isPast ? 'plan-step--past' : '');
      const numContent = isPast ? '✓' : s.n;
      return `
        <button class="plan-step ${stateCls} group" data-step="${s.id}" title="${escapeHtml(s.tip)}">
          <span class="plan-step__num">${numContent}</span>
          <span class="plan-step__label">
            <span class="plan-step__title">${s.label}</span>
            <span class="plan-step__hint">${escapeHtml(s.hint)}</span>
          </span>
          ${i < STEPS.length - 1 ? '<span class="plan-step__connector" aria-hidden="true"></span>' : ''}
          <span class="hidden group-hover:block pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-2 z-[60] w-60 bg-slate-800 text-slate-100 text-[11px] font-medium leading-snug rounded-lg shadow-xl p-2.5 text-left">
            <span class="block font-bold text-white mb-1">${s.n}. ${s.label}</span>
            ${escapeHtml(s.tip)}
            <span class="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-slate-800 rotate-45"></span>
          </span>
        </button>
      `;
    }).join('');

    // Sub-toggle interno solo en paso 1 (Configurar): conmuta entre Cuotas
    // base (defaults) y Ajustes individuales (overrides). En el resto de
    // pasos no aplica porque cada uno tiene un solo child.
    const subToggleHtml = (activeStep.id === 'configurar') ? `
      <div class="plan-substoggle">
        <button class="plan-substoggle__btn ${_planActiveSubtab === 'defaults' ? 'active' : ''}" data-subtab="defaults" title="Cuotas que aplican a TODA la sucursal por defecto">
          <span class="plan-substoggle__title">Cuotas base</span>
          <span class="plan-substoggle__hint">aplica a toda la sucursal</span>
        </button>
        <button class="plan-substoggle__btn ${_planActiveSubtab === 'overrides' ? 'active' : ''}" data-subtab="overrides" title="Sobrescribe las cuotas de una persona específica (vacaciones, capacitación, push)">
          <span class="plan-substoggle__title">Ajustes individuales</span>
          <span class="plan-substoggle__hint">override por persona</span>
        </button>
      </div>
    ` : '';

    // Matriz read-only de cadencia: antes vivía al top, abrumando al user.
    // Ahora va como `<details>` colapsado al PIE del paso 1 — sigue siendo
    // referencia accesible pero no compite con la matriz editable de abajo.
    const cadenceReferenceHtml = (activeStep.id === 'configurar') ? `
      <details class="bg-white border border-slate-200 rounded-2xl mt-4 overflow-hidden">
        <summary class="px-4 py-3 cursor-pointer text-xs font-bold text-slate-700 uppercase tracking-wider select-none flex items-center justify-between hover:bg-slate-50">
          <span class="flex items-center gap-2">
            <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
            Reglas de cadencia base (referencia)
          </span>
          <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7"/></svg>
        </summary>
        <div class="p-3">
          <p class="text-[11px] text-slate-500 mb-2 leading-snug">
            Quién visita qué tipo de farmacia y cada cuánto. Esta tabla es <b>solo informativa</b> — para ajustar valores, edita la matriz "Tu cuota diaria" arriba.
          </p>
          ${rulesMatrixHtml()}
        </div>
      </details>
    ` : '';

    body.innerHTML = `
      <!-- Stepper de navegación PDCA -->
      <nav class="plan-stepper" role="tablist" aria-label="Pasos del flujo Plan & Metas">
        ${stepperHtml}
      </nav>

      ${subToggleHtml}

      <div id="plan-subbody"></div>

      ${cadenceReferenceHtml}
    `;

    body.querySelectorAll('.plan-step').forEach((btn) => {
      btn.addEventListener('click', () => {
        const stepId = btn.dataset.step;
        const step = STEPS.find((s) => s.id === stepId);
        if (!step) return;
        if (activeStep.id === stepId) return; // ya activo
        // Al cambiar de paso, cae al primer child del paso (típicamente
        // defaults para configurar, generar para generar, etc.).
        _planActiveSubtab = step.children[0];
        renderPlan(body);
      });
    });

    body.querySelectorAll('.plan-substoggle__btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        _planActiveSubtab = btn.dataset.subtab;
        renderPlan(body);
      });
    });

    const sub = document.getElementById('plan-subbody');
    if (_planActiveSubtab === 'defaults') {
      await renderDefaultsTab(sub);
    } else if (_planActiveSubtab === 'overrides') {
      await renderOverridesTab(sub);
    } else if (_planActiveSubtab === 'generar') {
      if (window.MarzamViews?.renderPlanEditor) await window.MarzamViews.renderPlanEditor(sub);
      else sub.innerHTML = '<div class="text-center py-8 text-xs text-slate-400">Plan editor no cargado.</div>';
    } else if (_planActiveSubtab === 'resultados') {
      if (window.MarzamViews?.renderPostMortem) await window.MarzamViews.renderPostMortem(sub);
      else sub.innerHTML = '<div class="text-center py-8 text-xs text-slate-400">Post-mortem no cargado.</div>';
    } else {
      // Cumplimiento — delega al módulo Distribución, embebido sin guardia
      // adicional (el sidebar ya filtró el rol).
      if (window.MarzamDistribution && window.MarzamDistribution.renderEmbedded) {
        await window.MarzamDistribution.renderEmbedded(sub);
      } else {
        sub.innerHTML = '<div class="text-center py-8 text-xs text-slate-400">Módulo de cumplimiento no cargado.</div>';
      }
    }
  }

  function rulesMatrixHtml() {
    const RULES = (window.DEMO_H && DEMO_H.VISIT_RULES) || {
      A: { eligible_roles: ['director_sucursal','gerente_ventas','supervisor','representante'], cadence_per_role: 'weekly', visits_per_role_per_month: 4 },
      B: { eligible_roles: ['supervisor','representante'], cadence_per_role: 'biweekly', visits_per_role_per_month: 2 },
      C: { eligible_roles: ['representante'], cadence_per_role: 'monthly', visits_per_role_per_month: 1 },
    };
    const ROLES_ORDER = [ROLES.DIRECTOR, ROLES.GERENTE, ROLES.SUPERVISOR, ROLES.REPRESENTANTE];
    const CADENCE_LABEL = { weekly: '1×/semana', biweekly: '1×/2 sem', monthly: '1×/mes' };
    const FREQ_BADGE = { weekly: 'bg-emerald-50 text-emerald-700 border-emerald-200', biweekly: 'bg-amber-50 text-amber-700 border-amber-200', monthly: 'bg-blue-50 text-blue-700 border-blue-200' };

    const headerCells = ROLES_ORDER.map((r) => `<th class="text-[10px] font-bold uppercase tracking-wider text-slate-500 py-2 px-1 text-center">${ROLE_LABEL[r]}</th>`).join('');
    const rows = Object.entries(RULES).map(([pareto, rule]) => {
      const cells = ROLES_ORDER.map((r) => {
        const eligible = rule.eligible_roles.includes(r);
        return eligible
          ? `<td class="py-2 px-1 text-center"><span class="inline-block w-5 h-5 rounded-full bg-emerald-500 text-white text-[12px] font-bold leading-5">✓</span></td>`
          : `<td class="py-2 px-1 text-center text-slate-300 text-lg">—</td>`;
      }).join('');
      const cad = CADENCE_LABEL[rule.cadence_per_role] || rule.cadence_per_role;
      return `
        <tr class="border-t border-slate-100">
          <td class="py-2 px-2"><span class="pareto-tag" data-pareto="${pareto}">${pareto}</span></td>
          ${cells}
          <td class="py-2 px-2 text-right"><span class="text-[10px] font-bold px-2 py-1 rounded-md border ${FREQ_BADGE[rule.cadence_per_role]}">${cad}</span></td>
        </tr>
      `;
    }).join('');

    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-3 mb-4">
        <div class="flex items-center justify-between mb-2 px-2">
          <h4 class="text-[11px] font-black uppercase tracking-wider text-slate-700">Frecuencia y Efecto Espejo</h4>
          <span class="text-[9px] text-slate-400 font-semibold">Quién visita qué · cadencia base</span>
        </div>
        <table class="w-full">
          <thead><tr><th class="py-1 px-2 text-left text-[10px] font-bold text-slate-500 uppercase">Cliente</th>${headerCells}<th class="py-1 px-2 text-right text-[10px] font-bold text-slate-500 uppercase">Cadencia</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // ── Cadence constants (mirrors src/utils/visitCadence.js) ─────────────────
  const CADENCE = { A: 4, B: 2, C: 1, D: 0.5 };
  const MARZAM_COLS = ['A', 'B', 'C'];
  const NUEVAS_COLS = ['A', 'B', 'C', 'D'];
  const MATRIX_COLS = [
    { kind: 'marzam', p: 'A' }, { kind: 'marzam', p: 'B' }, { kind: 'marzam', p: 'C' },
    { kind: 'prospecto', p: 'A' }, { kind: 'prospecto', p: 'B' }, { kind: 'prospecto', p: 'C' }, { kind: 'prospecto', p: 'D' },
  ];
  const ROLES_DEF = ['director_sucursal', 'gerente_ventas', 'supervisor', 'representante'];

  // All role × category combinations are editable — no artificial restrictions
  function cellAllowed(role, kind, pareto) { return true; }

  const PARETO_COLORS = {
    marzam: { A: '#1e40af', B: '#1d4ed8', C: '#3b82f6' },
    prospecto: { A: '#7c3aed', B: '#8b5cf6', C: '#a78bfa', D: '#c4b5fd' },
  };

  function cellBg(kind, pareto) {
    const c = (PARETO_COLORS[kind] || {})[pareto] || '#94a3b8';
    return `background:${c}`;
  }

  async function renderDefaultsTab(wrap) {
    // ── 1. Fetch data in parallel ──────────────────────────────────────────
    const [matrixRes, team, clients, pobCanonical, capacityRows, universeRes] = await Promise.all([
      API.get('/visit-targets/expanded').catch(() => ({ matrix: [] })),
      API.get('/team/descendants').catch(() => []),
      API.get('/marzam/clients?limit=2000').catch(() => []),
      API.get('/poblaciones').catch(() => null),
      API.get('/quotas/role-capacity').catch(() => []),
      API.get('/marzam/universe?limit=10000').catch(() => ({})),
    ]);

    const prospectList = universeRes?.prospects || [];

    const matrix = matrixRes?.matrix || [];
    // Build local lookup: [role][kind][pareto] → cell object
    const matrixLookup = {};
    for (const c of matrix) {
      if (!matrixLookup[c.role]) matrixLookup[c.role] = {};
      if (!matrixLookup[c.role][c.category_kind]) matrixLookup[c.role][c.category_kind] = {};
      matrixLookup[c.role][c.category_kind][c.pareto_class] = c;
    }

    const clientList = Array.isArray(clients) ? clients : (clients?.clients || clients?.rows || clients?.data || []);
    efHydrateTeam(team, clientList);

    // Build zones dropdown
    const zonesRaw = [];
    (team || []).forEach((u) => (Array.isArray(u.poblaciones) ? u.poblaciones : []).forEach((z) => zonesRaw.push(z)));
    clientList.forEach((c) => { if (c.poblacion) zonesRaw.push(c.poblacion); });
    if (pobCanonical?.options) {
      for (const opt of pobCanonical.options) {
        if (opt?.value && opt.value !== '__all__') zonesRaw.push(opt.value);
      }
    }
    const zones = efDedup(zonesRaw);
    if (_capacityZone) {
      const k = efKey(_capacityZone);
      const canonical = zones.find((z) => efKey(z) === k);
      if (canonical) _capacityZone = canonical;
    }
    if (!_capacityZone && APP.poblacion && APP.poblacion !== '__all__') _capacityZone = APP.poblacion;

    // Role capacity lookup
    const capByRole = {};
    for (const r of (capacityRows || [])) capByRole[r.role] = r;
    // Ensure real_headcount is populated from team data when API returns 0
    for (const role of ROLES_DEF) {
      if (!capByRole[role]) capByRole[role] = { real_headcount: 0, target_headcount: 0, days_per_month: 22, gap: 0 };
      if (!capByRole[role].real_headcount) {
        capByRole[role].real_headcount = (team || []).filter((u) => u.role === role && !isVacancy(u)).length;
      }
    }

    // repaint() is the single source of truth for the estimation + by-state table
    const repaint = () => computeAndPaintEstimation47(
      matrixLookup, capByRole, clientList, prospectList, team, _capacityZone, wrap,
    );

    // canEditRole: can edit own rank and below (directors can edit their own row too)
    const canEditRole = (role) => {
      const myRank = ROLE_RANK[APP.role];
      const rowRank = ROLE_RANK[role];
      if (rowRank == null) return false;
      return myRank <= rowRank;
    };

    // ── 2. Render HTML ─────────────────────────────────────────────────────
    const activeCount = (team || []).filter((u) => u.is_active !== false && !isVacancy(u)).length;
    const zonesOpts = zones.map((z) => `<option value="${escapeHtml(z)}" ${_capacityZone === z ? 'selected' : ''}>${escapeHtml(z)}</option>`).join('');

    wrap.innerHTML = `
    <div class="cuotas-grid">
      <!-- ── LEFT COLUMN: zone selector + equipo card ─────────────── -->
      <div class="cuotas-left">
        <!-- Zone selector: layout vertical (label arriba + select 100% abajo)
             para evitar que un option largo expanda la columna izquierda
             del grid y se monte sobre la card de la derecha. -->
        <div class="bg-white border border-slate-200 rounded-2xl p-3 mb-4">
          <div class="flex items-center gap-1.5 mb-2">
            <svg class="w-3.5 h-3.5 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <label for="capacity-zone" class="text-[10px] font-bold uppercase tracking-wider text-slate-500">Entidad federativa</label>
            <span class="ml-auto text-[10px] font-semibold text-slate-400 tabular-nums" title="Personas activas en este alcance">${activeCount} pers.</span>
          </div>
          <select id="capacity-zone" class="w-full text-xs font-semibold bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 outline-none truncate">
            <option value="">Toda la sucursal</option>
            ${zonesOpts}
          </select>
        </div>

        <!-- ── Header de sub-paso 1.A ───────────────────────────────── -->
        <div class="plan-substep-header">
          <span class="plan-substep-badge">1.A</span>
          <div class="plan-substep-text">
            <h3 class="plan-substep-title">Tu equipo</h3>
            <p class="plan-substep-hint">Cuánta gente tienes hoy y cuánta deberías tener para cubrir bien la zona.</p>
          </div>
        </div>

        <!-- ── Card Equipo: headcount + días/mes ─────────────────────── -->
        <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <svg class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            Equipo
            <span id="cap-zone-badge" class="ml-auto text-[10px] font-semibold text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full"></span>
          </h4>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="border-b border-slate-100">
                  <th class="text-left py-1.5 px-1 text-[10px] font-bold text-slate-500 uppercase">Rol</th>
                  <th class="th-with-tip text-center py-1.5 px-1 text-[10px] font-bold text-slate-500 uppercase relative group cursor-help" tabindex="0">
                    Hoy
                    <svg class="th-tip-icon inline w-2.5 h-2.5 text-slate-300 ml-0.5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                    <span class="th-tip-card hidden group-hover:block group-focus:block pointer-events-none">
                      <span class="th-tip-card__title">Hoy <span class="th-tip-card__alias">(antes "Real")</span></span>
                      Cuántas personas activas tienes en este rol y zona ahora mismo. Viene del padrón de RH — no se edita aquí.
                    </span>
                  </th>
                  <th class="th-with-tip text-center py-1.5 px-1 text-[10px] font-bold text-slate-500 uppercase relative group cursor-help" tabindex="0">
                    Plantilla ideal
                    <svg class="th-tip-icon inline w-2.5 h-2.5 text-slate-300 ml-0.5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                    <span class="th-tip-card hidden group-hover:block group-focus:block pointer-events-none">
                      <span class="th-tip-card__title">Plantilla ideal <span class="th-tip-card__alias">(antes "Meta")</span></span>
                      Cuántas personas DEBERÍAS tener para cubrir bien la zona. Es tu objetivo de contratación. Subir este número aumenta las visitas/mes posibles.
                    </span>
                  </th>
                  <th class="th-with-tip text-center py-1.5 px-1 text-[10px] font-bold text-slate-500 uppercase relative group cursor-help" tabindex="0">
                    Faltan
                    <svg class="th-tip-icon inline w-2.5 h-2.5 text-slate-300 ml-0.5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                    <span class="th-tip-card hidden group-hover:block group-focus:block pointer-events-none">
                      <span class="th-tip-card__title">Faltan <span class="th-tip-card__alias">(antes "Gap")</span></span>
                      Diferencia entre tu plantilla ideal y lo que tienes hoy. En rojo cuando hay vacantes por cubrir.
                    </span>
                  </th>
                  <th class="th-with-tip text-center py-1.5 px-1 text-[10px] font-bold text-slate-500 uppercase relative group cursor-help" tabindex="0">
                    Días en calle
                    <svg class="th-tip-icon inline w-2.5 h-2.5 text-slate-300 ml-0.5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                    <span class="th-tip-card hidden group-hover:block group-focus:block pointer-events-none">
                      <span class="th-tip-card__title">Días en calle / mes <span class="th-tip-card__alias">(antes "Días")</span></span>
                      Cuántos días al mes cada persona pisa farmacias (no días laborales totales). Default 22. Bajar este número = menos capacidad real.
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody id="cap-team-body"></tbody>
            </table>
          </div>
          <p class="text-[10px] text-slate-400 mt-2 leading-snug">
            Define cuánta gente tienes vs cuánta necesitas. Esto alimenta la <b>estimación de visitas</b> de la derecha.
          </p>
        </div>
      </div><!-- end cuotas-left -->

      <!-- ── RIGHT COLUMN: matrix + estimation + by-state + actions ─ -->
      <div class="cuotas-right">
        <!-- ── Header de sub-paso 1.B ───────────────────────────────── -->
        <div class="plan-substep-header">
          <span class="plan-substep-badge">1.B</span>
          <div class="plan-substep-text">
            <h3 class="plan-substep-title">Tu cuota diaria</h3>
            <p class="plan-substep-hint">Cuántas visitas por día puede hacer cada persona, según el tipo de farmacia (A/B/C de Marzam vs A/B/C/D de prospectos nuevos).</p>
          </div>
        </div>

        <!-- ── Matriz visitas/día 4×7 ────────────────────────────────── -->
        <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Visitas/día por categoría</h4>
          <div class="overflow-x-auto -mx-1">
            <table class="w-full text-[11px] min-w-[500px]" id="matrix-table">
              <thead>
                <tr>
                  <th class="py-1 px-1 text-left text-[10px] font-bold text-slate-400 uppercase w-24">Rol</th>
                  <th colspan="3" class="py-1 px-1 text-center text-[10px] font-bold uppercase tracking-wider" style="color:#1d4ed8;border-bottom:2px solid #1d4ed8">Marzam</th>
                  <th colspan="4" class="py-1 px-1 text-center text-[10px] font-bold uppercase tracking-wider" style="color:#7c3aed;border-bottom:2px solid #7c3aed">Nuevas (prospectos)</th>
                </tr>
                <tr class="border-b border-slate-100">
                  <th class="py-1 px-1"></th>
                  ${MARZAM_COLS.map((p) => `<th class="py-1 px-1 text-center text-[10px] font-bold" style="color:#1d4ed8"><span class="pareto-tag" data-pareto="${p}" style="font-size:9px">${p}</span></th>`).join('')}
                  ${NUEVAS_COLS.map((p) => `<th class="py-1 px-1 text-center text-[10px] font-bold" style="color:#7c3aed"><span class="pareto-tag" data-pareto="C" style="font-size:9px;${cellBg('prospecto', p)};color:#fff">${p}</span></th>`).join('')}
                </tr>
              </thead>
              <tbody id="matrix-body"></tbody>
            </table>
          </div>
          <p class="text-[10px] text-slate-400 mt-2 leading-snug">Todas las celdas son editables. Cambios se guardan automáticamente.</p>
        </div>

        <!-- ── Header de sub-paso 1.C ───────────────────────────────── -->
        <div class="plan-substep-header">
          <span class="plan-substep-badge plan-substep-badge--accent">1.C</span>
          <div class="plan-substep-text">
            <h3 class="plan-substep-title">Resultado estimado</h3>
            <p class="plan-substep-hint">Visitas/día × personas × días = visitas/mes. Se recalcula en vivo con cada cambio que hagas arriba.</p>
          </div>
        </div>

        <!-- ── Card Estimación ────────────────────────────────────────── -->
        <div class="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-4 mb-4">
          <div class="flex items-center justify-between mb-3">
            <h4 class="text-xs font-bold text-blue-700 uppercase tracking-wider">Estimación del plan</h4>
            <span id="capacity-scope-badge" class="text-[10px] font-bold text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full">—</span>
          </div>
          <!-- Pharmacy counts pills -->
          <div id="preview-client-counts" class="mb-3 text-center"></div>
          <!-- KPIs -->
          <div class="grid grid-cols-2 gap-3 text-center mb-3">
            <div>
              <div class="text-2xl font-black text-blue-900 tabular-nums" id="preview-total">—</div>
              <div class="text-[9px] font-bold text-blue-700 uppercase tracking-wider">Visitas / mes</div>
            </div>
            <div>
              <div class="text-2xl font-black tabular-nums" id="preview-coverage">—</div>
              <div class="text-[9px] font-bold text-emerald-700 uppercase tracking-wider">Cobertura padrón</div>
            </div>
            <div>
              <div class="text-xl font-black text-violet-700 tabular-nums" id="preview-nuevas-visits">—</div>
              <div class="text-[9px] font-bold text-violet-700 uppercase tracking-wider">Visitas nuevas / mes</div>
            </div>
            <div>
              <div class="text-xl font-black text-orange-600 tabular-nums" id="preview-freq">—</div>
              <div class="text-[9px] font-bold text-orange-600 uppercase tracking-wider">Frecuencia promedio</div>
            </div>
          </div>
          <!-- Need bar -->
          <div id="preview-need-bar"></div>
          <div id="preview-breakdown" class="grid grid-cols-4 gap-1 mt-2 pt-2 border-t border-blue-200/60"></div>
          <!-- Fórmula viva: variables clickeables/hover apuntan a su origen.
               Los IDs preview-fv-* los actualiza repaint() en tiempo real. -->
          <p class="plan-formula" id="preview-formula">
            ≈
            <span class="plan-formula-var plan-formula-var--blue" id="preview-fv-vd"
                  data-target="visits-per-day" tabindex="0" role="button"
                  title="Visitas/día sumadas en la matriz 1.B. Hover destaca dónde se calcula.">—</span>
            <span class="plan-formula-op">×</span>
            <span class="plan-formula-var plan-formula-var--green" id="preview-fv-pp"
                  data-target="people" tabindex="0" role="button"
                  title="Personas activas en el equipo (Hoy). Viene de la tabla 1.A.">—</span>
            <span class="plan-formula-op">×</span>
            <span class="plan-formula-var plan-formula-var--orange" id="preview-fv-dd"
                  data-target="days" tabindex="0" role="button"
                  title="Días en calle/mes (default 22). Editable en la tabla 1.A columna 'Días en calle'.">—</span>
            <span class="plan-formula-op">=</span>
            <b class="plan-formula-result" id="preview-fv-total">—</b>
            <span class="plan-formula-unit">visitas/mes</span>
          </p>
        </div>

        <!-- ── Tabla por entidad federativa (collapsible) ─────────────── -->
        <details class="bg-white border border-slate-200 rounded-2xl mb-4 overflow-hidden">
          <summary class="px-4 py-3 cursor-pointer text-xs font-bold text-slate-700 uppercase tracking-wider select-none flex items-center justify-between">
            Desglose por entidad federativa
            <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7"/></svg>
          </summary>
          <div class="overflow-x-auto">
            <p class="text-[9px] text-slate-400 px-4 pt-2">Columnas Nuevas: <b>farmacias</b><span class="text-pink-400">/consultorios</span>. Recs calculados sobre capacidad del representante.</p>
            <table class="w-full text-[11px] min-w-[640px]">
              <thead>
                <tr class="bg-slate-50">
                  <th class="py-2 px-3 text-left text-[10px] font-bold text-slate-500 uppercase" rowspan="2">Estado</th>
                  <th colspan="3" class="py-1 px-1 text-center text-[10px] font-bold uppercase" style="color:#1d4ed8;border-bottom:1px solid #bfdbfe">Marzam</th>
                  <th colspan="4" class="py-1 px-1 text-center text-[10px] font-bold uppercase by-state-nuevas-detail" style="color:#7c3aed;border-bottom:1px solid #ddd6fe">Nuevas</th>
                  <th class="py-1 px-1 text-center text-[10px] font-bold uppercase by-state-nuevas-total" style="color:#7c3aed;border-bottom:1px solid #ddd6fe">Nuevas</th>
                  <th class="py-1 px-2 text-center text-[10px] font-bold text-slate-500 uppercase" rowspan="2">Reps<br>real</th>
                  <th class="py-1 px-2 text-center text-[10px] font-bold text-slate-500 uppercase" rowspan="2">Reps<br>rec.</th>
                  <th class="py-1 px-2 text-center text-[10px] font-bold text-slate-500 uppercase" rowspan="2">Gap</th>
                </tr>
                <tr class="border-b border-slate-100 bg-slate-50">
                  <th class="py-1 px-1 text-center text-[10px] font-bold" style="color:#1e40af">A</th>
                  <th class="py-1 px-1 text-center text-[10px] font-bold" style="color:#1d4ed8">B</th>
                  <th class="py-1 px-1 text-center text-[10px] font-bold" style="color:#3b82f6">C</th>
                  <th class="py-1 px-1 text-center text-[10px] font-bold by-state-nuevas-detail" style="color:#7c3aed">A</th>
                  <th class="py-1 px-1 text-center text-[10px] font-bold by-state-nuevas-detail" style="color:#8b5cf6">B</th>
                  <th class="py-1 px-1 text-center text-[10px] font-bold by-state-nuevas-detail" style="color:#a78bfa">C</th>
                  <th class="py-1 px-1 text-center text-[10px] font-bold by-state-nuevas-detail" style="color:#c4b5fd">D</th>
                  <th class="py-1 px-1 text-center text-[10px] font-bold by-state-nuevas-total" style="color:#7c3aed">A–D</th>
                </tr>
              </thead>
              <tbody id="by-pob-body"></tbody>
            </table>
          </div>
        </details>

        <!-- ── Buttons ────────────────────────────────────────────────── -->
        <div class="flex gap-3 mt-2">
          <button id="btn-force-save" class="flex-1 btn btn-secondary py-2.5 text-sm font-semibold hidden">Guardar configuración</button>
          <button id="btn-generate-plan" class="flex-1 btn btn-primary py-3 font-bold text-sm">Listo · Generar plan ahora →</button>
        </div>
        <p class="text-[10px] text-slate-400 text-center mt-2">Las visitas ya completadas se preservan al regenerar.</p>
      </div><!-- end cuotas-right -->
    </div><!-- end cuotas-grid -->

    <!-- ── CTA sticky bottom: visible al hacer scroll en el paso 1 ─── -->
    <div class="plan-cta-sticky" id="plan-cta-sticky">
      <button id="btn-generate-plan-sticky" class="plan-cta-sticky__btn">
        <span>Listo · Generar plan ahora</span>
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </button>
    </div>
    `;

    // ── 3. Populate team card ──────────────────────────────────────────────
    const teamBody = wrap.querySelector('#cap-team-body');
    function renderTeamRows() {
      teamBody.innerHTML = ROLES_DEF.map((role) => {
        const cap = capByRole[role] || { real_headcount: 0, target_headcount: 0, days_per_month: 22, gap: 0, db_id: null };
        const canEdit = canEditRole(role);
        // Default sensato cuando NO hay registro guardado en role_capacity_targets
        // (db_id === null): mostramos real_headcount como Plantilla ideal, no 0.
        // El gap también se ajusta para no decir "+N" cuando todavía no hay meta.
        const hasSavedTarget = cap.db_id != null && (cap.target_headcount || 0) > 0;
        const displayedTarget = hasSavedTarget ? cap.target_headcount : cap.real_headcount;
        const displayedGap = hasSavedTarget ? Math.max(0, cap.target_headcount - cap.real_headcount) : 0;
        const gapColor = displayedGap > 0 ? 'text-red-600 font-bold' : 'text-slate-400';
        const isSuggestion = !hasSavedTarget && cap.real_headcount > 0;
        const inputTitle = isSuggestion
          ? 'Sugerido: igual a tu plantilla actual. Edita para fijar tu meta de contratación.'
          : '';
        const inputCls = isSuggestion ? 'border-dashed text-slate-500' : '';
        return `
          <tr class="border-b border-slate-50 ${canEdit ? '' : 'opacity-60'}">
            <td class="py-1.5 px-1 font-semibold text-slate-700 truncate max-w-[5rem]" title="${ROLE_LABEL[role] || role}">${ROLE_LABEL[role] || role}</td>
            <td class="py-1.5 px-1 text-center tabular-nums text-slate-600">${cap.real_headcount}</td>
            <td class="py-1.5 px-1 text-center">
              <input type="number" min="0" max="999" value="${displayedTarget}"
                class="cap-hc-input w-full text-center border ${inputCls} border-slate-200 rounded px-1 py-0.5 text-xs tabular-nums ${canEdit ? '' : 'bg-slate-50 pointer-events-none'}"
                data-role="${role}" data-suggested="${isSuggestion ? '1' : '0'}"
                title="${inputTitle}" ${canEdit ? '' : 'disabled'}>
            </td>
            <td class="py-1.5 px-1 text-center tabular-nums text-sm ${gapColor}">${displayedGap > 0 ? '+' + displayedGap : '—'}</td>
            <td class="py-1.5 px-1 text-center">
              <input type="number" min="0" max="31" value="${cap.days_per_month}"
                class="cap-days-input w-full text-center border border-slate-200 rounded px-1 py-0.5 text-xs tabular-nums ${canEdit ? '' : 'bg-slate-50 pointer-events-none'}"
                data-role="${role}" ${canEdit ? '' : 'disabled'}>
            </td>
          </tr>
        `;
      }).join('');
      wireTeamInputs();
    }
    renderTeamRows();

    function wireTeamInputs() {
      wrap.querySelectorAll('.cap-hc-input, .cap-days-input').forEach((inp) => {
        let t = null;
        inp.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(async () => {
            const role = inp.dataset.role;
            const body = { role };
            if (inp.classList.contains('cap-hc-input')) body.target_headcount = Math.max(0, +inp.value || 0);
            else body.days_per_month = Math.min(31, Math.max(0, +inp.value || 0));
            if (_capacityZone) body.poblacion = _capacityZone;
            try {
              const updated = await API.post('/quotas/role-capacity', body);
              if (capByRole[role]) {
                if (body.target_headcount !== undefined) capByRole[role].target_headcount = updated.target_headcount ?? body.target_headcount;
                if (body.days_per_month !== undefined) capByRole[role].days_per_month = updated.days_per_month ?? body.days_per_month;
                capByRole[role].gap = Math.max(0, (capByRole[role].target_headcount || 0) - (capByRole[role].real_headcount || 0));
                // El upsert siempre devuelve el row con id; reflejarlo localmente
                // marca la fila como "ya configurada" y quita el estilo dasheado
                // de sugerencia en el próximo renderTeamRows().
                if (updated?.id) capByRole[role].db_id = updated.id;
              }
            } catch { /* silent */ }
            repaint();
            renderTeamRows();
          }, 600);
        });
      });
    }

    // ── 4. Populate 4×7 matrix ─────────────────────────────────────────────
    const matBody = wrap.querySelector('#matrix-body');
    function renderMatrixRows() {
      matBody.innerHTML = ROLES_DEF.map((role) => {
        const canEdit = canEditRole(role);
        const cells = MATRIX_COLS.map((col) => {
          const cell = (matrixLookup[role]?.[col.kind === 'marzam' ? 'marzam' : 'prospecto']?.[col.p]) || null;
          const val = cell?.daily_contacts_per_person ?? 0;
          const borderCol = col.kind === 'marzam' ? 'border-blue-200' : 'border-violet-200';
          return `
            <td class="py-1 px-1 text-center ${canEdit ? '' : 'bg-slate-50/60'}">
              <input type="number" min="0" max="30" value="${val}"
                class="matrix-cell-input w-full min-w-[2.5rem] text-center border ${borderCol} rounded px-1 py-0.5 text-xs tabular-nums ${canEdit ? '' : 'bg-slate-50 text-slate-400 pointer-events-none'}"
                data-role="${role}" data-kind="${col.kind}" data-pareto="${col.p}" ${canEdit ? '' : 'disabled'}
                title="${canEdit ? `${ROLE_LABEL[role] || role} · ${col.kind === 'marzam' ? 'Marzam' : 'Nuevas'} ${col.p}` : `Solo niveles superiores pueden editar la cuota de ${ROLE_LABEL[role] || role}`}">
            </td>
          `;
        }).join('');
        // Phase 3: Read-only rows (above your rank) get a lock icon + muted styling
        // so the manager understands the cascade without being blocked from seeing it.
        const lock = canEdit ? '' : `<svg class="inline-block w-3 h-3 ml-1 text-slate-400" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" aria-label="Solo lectura"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 1 1 8 0v3"/></svg>`;
        return `
          <tr class="border-b border-slate-50 ${canEdit ? '' : 'bg-slate-50/30'}">
            <td class="py-1.5 px-1 text-xs font-semibold ${canEdit ? 'text-slate-600' : 'text-slate-400'} whitespace-nowrap">${ROLE_LABEL[role] || role}${lock}</td>
            ${cells}
          </tr>
        `;
      }).join('');
      wireMatrixInputs();
    }
    renderMatrixRows();

    function wireMatrixInputs() {
      wrap.querySelectorAll('.matrix-cell-input').forEach((inp) => {
        let t = null;
        inp.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(async () => {
            const { role, kind, pareto } = inp.dataset;
            const val = Math.max(0, +inp.value || 0);
            // Update local lookup
            if (!matrixLookup[role]) matrixLookup[role] = {};
            const kindKey = kind === 'marzam' ? 'marzam' : 'prospecto';
            if (!matrixLookup[role][kindKey]) matrixLookup[role][kindKey] = {};
            if (!matrixLookup[role][kindKey][pareto]) matrixLookup[role][kindKey][pareto] = {};
            matrixLookup[role][kindKey][pareto].daily_contacts_per_person = val;
            repaint();
            // Persist debounced
            try {
              await API.post('/visit-targets/bulk', {
                cells: [{ role, category_kind: kindKey, pareto_class: pareto, daily_contacts_per_person: val, channel: 'visit' }],
              });
            } catch { /* silent in demo */ }
          }, 500);
        });
      });
    }

    // ── 5. Populate by-poblacion table ─────────────────────────────────────
    // ── 5. By-state table: event delegation (rows rebuilt by repaint; listener survives)
    wrap.querySelector('#by-pob-body').closest('table').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-pob]');
      if (!tr) return;
      const pob = tr.dataset.pob;
      if (!pob) return;
      _capacityZone = pob;
      window.MarzamPlanZone = pob;
      const sel = wrap.querySelector('#capacity-zone');
      if (sel) sel.value = pob;
      wrap.querySelector('#cap-zone-badge').textContent = pob;
      wrap.querySelector('#capacity-scope-badge').textContent = `Zona: ${pob}`;
      repaint();
    });

    // ── 6. Zone selector ───────────────────────────────────────────────────
    window.MarzamPlanZone = _capacityZone;
    wrap.querySelector('#cap-zone-badge').textContent = _capacityZone || 'Toda la sucursal';
    wrap.querySelector('#capacity-scope-badge').textContent = _capacityZone ? `Zona: ${_capacityZone}` : 'Toda la sucursal';

    wrap.querySelector('#capacity-zone').addEventListener('change', async (e) => {
      _capacityZone = e.target.value || null;
      window.MarzamPlanZone = _capacityZone;
      wrap.querySelector('#cap-zone-badge').textContent = _capacityZone || 'Toda la sucursal';
      wrap.querySelector('#capacity-scope-badge').textContent = _capacityZone ? `Zona: ${_capacityZone}` : 'Toda la sucursal';
      // Reload zone-specific capacity targets
      try {
        const url = _capacityZone ? `/quotas/role-capacity?poblacion=${encodeURIComponent(_capacityZone)}` : '/quotas/role-capacity';
        const freshCap = await API.get(url).catch(() => []);
        for (const r of (freshCap || [])) capByRole[r.role] = r;
        renderTeamRows();
      } catch { /* silent */ }
      repaint();
    });

    // ── 7. Buttons ─────────────────────────────────────────────────────────
    const goToGenerate = () => {
      window.MarzamPlanZone = _capacityZone;
      if (_capacityZone) {
        window.MarzamPlanPreloadConfig = { poblacion: _capacityZone };
      }
      _planActiveSubtab = 'generar';
      renderPlan(document.getElementById('panel-body'));
    };
    wrap.querySelector('#btn-generate-plan').addEventListener('click', goToGenerate);
    // Mismo CTA pero clonado al pie con position:sticky para que esté siempre
    // visible al hacer scroll en la página densa de Configurar.
    const stickyBtn = wrap.querySelector('#btn-generate-plan-sticky');
    if (stickyBtn) stickyBtn.addEventListener('click', goToGenerate);

    // ── 8. Hover handler de la fórmula viva ───────────────────────────────
    // Cada <span class="plan-formula-var" data-target="..."> cuando recibe
    // hover/focus dispara highlight visual en la card o celdas origen para
    // que el usuario entienda DE DÓNDE sale cada número de la fórmula:
    //   visits-per-day → matriz 1.B (#matrix-table)
    //   people         → tabla 1.A columnas Hoy + Plantilla ideal
    //   days           → tabla 1.A columna Días en calle
    // Usamos event delegation sobre el <p#preview-formula> para no fugar
    // listeners cada vez que repaint() reescribe contenido interno.
    const formulaEl = wrap.querySelector('#preview-formula');
    if (formulaEl) {
      const targetMap = {
        'visits-per-day': () => wrap.querySelectorAll('#matrix-table'),
        people: () => wrap.querySelectorAll('#cap-team-body td:nth-child(2), #cap-team-body td:nth-child(3)'),
        days: () => wrap.querySelectorAll('#cap-team-body td:nth-child(5)'),
      };
      const clearHighlight = () => {
        wrap.querySelectorAll('.plan-formula-target--active').forEach((el) => {
          el.classList.remove('plan-formula-target--active');
        });
      };
      const applyHighlight = (key) => {
        clearHighlight();
        const getter = targetMap[key];
        if (!getter) return;
        const els = getter();
        els.forEach((el) => el.classList.add('plan-formula-target--active'));
        if (els.length > 0) {
          els[0].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
      };
      formulaEl.addEventListener('mouseover', (ev) => {
        const v = ev.target.closest('.plan-formula-var');
        if (!v) return;
        applyHighlight(v.dataset.target);
      });
      formulaEl.addEventListener('mouseout', (ev) => {
        const v = ev.target.closest('.plan-formula-var');
        if (!v) return;
        clearHighlight();
      });
      formulaEl.addEventListener('focusin', (ev) => {
        const v = ev.target.closest('.plan-formula-var');
        if (v) applyHighlight(v.dataset.target);
      });
      formulaEl.addEventListener('focusout', clearHighlight);
    }

    // Initial paint
    repaint();
  }

  /**
   * Client-side estimation for the expanded 4×7 matrix.
   * Uses real pharmacy counts (clients A/B/C + prospects by quadrant) for the
   * selected zone, calculates needed vs available visits, and rebuilds the
   * by-state table via _buildByStateTable.
   */
  function computeAndPaintEstimation47(matrixLookup, capByRole, clients, prospects, team, zone, wrap) {
    const QUAD_TO_PARETO = { Q1: 'A', Q2: 'B', Q3: 'C', Q4: 'D' };
    const { clients: tClients } = filterByZone([], clients, zone);
    const tProspects = zone
      ? (prospects || []).filter((p) => efKey(p.state) === efKey(zone))
      : (prospects || []);

    // ── Client counts by Pareto ──────────────────────────────────────────────
    const cbp = { A: 0, B: 0, C: 0 };
    for (const c of tClients) {
      const p = String(c.pareto || '').toUpperCase();
      if (p in cbp) cbp[p]++;
    }

    // ── Prospect counts split: farmacias vs consultorios ────────────────────
    const isFarmacia = (p) => (p.business_type || 'pharmacy') !== 'consultorio';
    const pbpFarm = { A: 0, B: 0, C: 0, D: 0 };
    const pbpCons = { A: 0, B: 0, C: 0, D: 0 };
    for (const p of tProspects) {
      const letra = QUAD_TO_PARETO[String(p.quadrant || '').toUpperCase()];
      if (!letra) continue;
      if (isFarmacia(p)) pbpFarm[letra]++;
      else pbpCons[letra]++;
    }
    // Combined for backward-compat references
    const pbp = { A: pbpFarm.A + pbpCons.A, B: pbpFarm.B + pbpCons.B, C: pbpFarm.C + pbpCons.C, D: pbpFarm.D + pbpCons.D };

    // ── How many visits/month are actually NEEDED at full cadence ───────────
    const marzamNeeded = cbp.A * 4 + cbp.B * 2 + cbp.C * 1;
    const nuevasNeeded = pbpFarm.A * 4 + pbpFarm.B * 2 + pbpFarm.C * 1 + pbpFarm.D * 0.5
                       + pbpCons.A * 4 + pbpCons.B * 2 + pbpCons.C * 1 + pbpCons.D * 0.5;

    // ── Zone-filtered team headcount (live, not API-cached) ─────────────────
    const zoneKey = zone ? efKey(zone) : null;
    const zoneTeam = zoneKey
      ? (team || []).filter((u) => Array.isArray(u.poblaciones)
          && u.poblaciones.some((p) => efKey(p) === zoneKey))
      : (team || []);

    // ── Monthly visits produced by the configured matrix ────────────────────
    let totalMarzam = 0;
    let totalNuevas = 0;
    const breakdown = [];

    for (const role of ROLES_DEF) {
      const cap = capByRole[role] || {};
      const daysPerMonth = Number(cap.days_per_month) || WORKING_DAYS_PER_MONTH;
      // Zone-filtered real headcount; fall back to global capByRole
      const realHC = zoneTeam.filter((u) => u.role === role && !isVacancy(u)).length
        || Number(cap.real_headcount) || 0;
      const headcount = Number(cap.target_headcount) || realHC;

      for (const col of MATRIX_COLS) {
        const kindKey = col.kind === 'marzam' ? 'marzam' : 'prospecto';
        const cell = matrixLookup[role]?.[kindKey]?.[col.p];
        const daily = Number(cell?.daily_contacts_per_person ?? 0);
        const daysShare = cell?.days_share ?? null;
        const dedicated = daysShare != null
          ? daysPerMonth * daysShare / 100
          : daysPerMonth / MATRIX_COLS.length;
        const monthly = daily * headcount * dedicated;
        if (col.kind === 'marzam') totalMarzam += monthly;
        else totalNuevas += monthly;
        breakdown.push({ role, kind: col.kind, pareto: col.p, monthly: Math.round(monthly) });
      }
    }

    const totalVisits = Math.round(totalMarzam + totalNuevas);
    const coveragePct = marzamNeeded > 0 ? Math.min(999, Math.round((totalMarzam / marzamNeeded) * 100)) : 0;
    const totalMarzamClients = cbp.A + cbp.B + cbp.C;
    const avgFreq = totalMarzamClients > 0 ? (totalMarzam / totalMarzamClients).toFixed(1) : '—';

    // ── Paint KPI values ─────────────────────────────────────────────────────
    const qs = (id) => wrap.querySelector('#' + id);
    const set = (id, txt) => { const el = qs(id); if (el) el.textContent = txt; };
    set('preview-total', totalVisits.toLocaleString());
    set('preview-nuevas-visits', Math.round(totalNuevas).toLocaleString());
    set('preview-freq', avgFreq !== '—' ? avgFreq + 'x/mes' : '—');

    // ── Fórmula viva: cada variable es interactiva y refleja el origen.
    //   visitas/día (vd) = avg ponderado de visitas/día por persona del team
    //   personas (pp)   = headcount total efectivo (target o real)
    //   días (dd)       = días/mes promedio ponderado por headcount
    // El producto vd × pp × dd ≈ totalVisits (consistente con la fórmula).
    let totalPersonas = 0;
    let weightedDays = 0;
    for (const role of ROLES_DEF) {
      const cap = capByRole[role] || {};
      const realHC = zoneTeam.filter((u) => u.role === role && !isVacancy(u)).length
        || Number(cap.real_headcount) || 0;
      const hc = Number(cap.target_headcount) || realHC;
      const dpm = Number(cap.days_per_month) || WORKING_DAYS_PER_MONTH;
      totalPersonas += hc;
      weightedDays += hc * dpm;
    }
    const avgDays = totalPersonas > 0 ? Math.round(weightedDays / totalPersonas) : WORKING_DAYS_PER_MONTH;
    const avgVisitsPerDay = (totalPersonas > 0 && avgDays > 0)
      ? (totalVisits / (totalPersonas * avgDays))
      : 0;
    set('preview-fv-vd', avgVisitsPerDay > 0 ? avgVisitsPerDay.toFixed(1) : '0');
    set('preview-fv-pp', totalPersonas.toLocaleString());
    set('preview-fv-dd', avgDays);
    set('preview-fv-total', totalVisits.toLocaleString());

    // Coverage with color
    const covEl = qs('preview-coverage');
    if (covEl) {
      covEl.textContent = coveragePct + '%';
      covEl.className = `text-2xl font-black tabular-nums ${
        coveragePct >= 80 ? 'text-emerald-700' : coveragePct >= 50 ? 'text-amber-600' : 'text-red-600'}`;
    }

    // ── Pharmacy count pills ─────────────────────────────────────────────────
    const countEl = qs('preview-client-counts');
    if (countEl) {
      const totalM = cbp.A + cbp.B + cbp.C;
      const totalF = pbpFarm.A + pbpFarm.B + pbpFarm.C + pbpFarm.D;
      const totalC = pbpCons.A + pbpCons.B + pbpCons.C + pbpCons.D;
      const pill = (label, col, num) =>
        `<span class="px-1.5 py-0.5 rounded font-bold text-white text-[9px]" style="background:${col}">${label} ${num}</span>`;
      countEl.innerHTML = `
        <div class="space-y-1 text-[9px]">
          <div class="flex flex-wrap gap-1 items-center">
            <span class="font-bold text-slate-500 w-[68px] shrink-0">Marzam</span>
            ${pill('A', '#1e40af', cbp.A)}${pill('B', '#1d4ed8', cbp.B)}${pill('C', '#3b82f6', cbp.C)}
            <span class="text-slate-400">${totalM} farmacias</span>
          </div>
          <div class="flex flex-wrap gap-1 items-center">
            <span class="font-bold text-violet-700 w-[68px] shrink-0">Farm. nuevas</span>
            ${pill('A', '#7c3aed', pbpFarm.A)}${pill('B', '#8b5cf6', pbpFarm.B)}${pill('C', '#a78bfa', pbpFarm.C)}${pill('D', '#c4b5fd', pbpFarm.D)}
            <span class="text-slate-400">${totalF}</span>
          </div>
          ${totalC > 0 ? `
          <div class="flex flex-wrap gap-1 items-center">
            <span class="font-bold text-pink-600 w-[68px] shrink-0">Consultorios</span>
            ${pill('A', '#9d174d', pbpCons.A)}${pill('B', '#be185d', pbpCons.B)}${pill('C', '#db2777', pbpCons.C)}${pill('D', '#ec4899', pbpCons.D)}
            <span class="text-slate-400">${totalC}</span>
          </div>` : ''}
        </div>
      `;
    }

    // ── Capacity vs need progress bar ────────────────────────────────────────
    const needEl = qs('preview-need-bar');
    if (needEl) {
      const totalNeeded = marzamNeeded + nuevasNeeded;
      const fillPct = totalNeeded > 0 ? Math.min(100, Math.round(totalVisits / totalNeeded * 100)) : 0;
      const barColor = fillPct >= 80 ? 'bg-emerald-500' : fillPct >= 50 ? 'bg-amber-400' : 'bg-red-400';
      needEl.innerHTML = `
        <div class="flex items-center gap-2 mt-2 mb-1">
          <div class="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
            <div class="h-full rounded-full transition-all duration-300 ${barColor}" style="width:${fillPct}%"></div>
          </div>
          <span class="text-[9px] font-bold tabular-nums w-8 text-right ${
            fillPct >= 80 ? 'text-emerald-700' : fillPct >= 50 ? 'text-amber-600' : 'text-red-600'
          }">${fillPct}%</span>
        </div>
        <div class="text-[9px] text-slate-400 text-center">${totalNeeded.toLocaleString()} visitas/mes necesarias para cobertura total</div>
      `;
    }

    // ── Role breakdown ───────────────────────────────────────────────────────
    const bd = qs('preview-breakdown');
    if (bd) {
      const byRole = {};
      for (const b of breakdown) {
        if (!byRole[b.role]) byRole[b.role] = { marzam: 0, nuevas: 0 };
        if (b.kind === 'marzam') byRole[b.role].marzam += b.monthly;
        else byRole[b.role].nuevas += b.monthly;
      }
      bd.innerHTML = ROLES_DEF
        .filter((r) => (byRole[r]?.marzam || 0) + (byRole[r]?.nuevas || 0) > 0)
        .map((r) => `
          <div class="bg-white/80 rounded-xl p-2 text-center">
            <div class="text-[9px] font-bold text-slate-500 uppercase truncate">${ROLE_LABEL[r] || r}</div>
            <div class="text-sm font-black text-blue-800 tabular-nums">${(byRole[r]?.marzam || 0).toLocaleString()}</div>
            <div class="text-[9px] text-blue-600">marzam</div>
            <div class="text-sm font-black text-violet-700 tabular-nums mt-0.5">${(byRole[r]?.nuevas || 0).toLocaleString()}</div>
            <div class="text-[9px] text-violet-500">nuevas</div>
          </div>
        `).join('');
    }

    // ── By-state table ───────────────────────────────────────────────────────
    _buildByStateTable(matrixLookup, capByRole, clients, prospects, team, zone, wrap);
  }

  /**
   * Builds the by-state breakdown table from client-side data.
   * Aggregates marzam clients (by poblacion + pareto) and prospects
   * (by state + quadrant) to compute recommended headcount vs real.
   */
  function _buildByStateTable(matrixLookup, capByRole, clients, prospects, team, currentZone, wrap) {
    const QUAD_TO_PARETO = { Q1: 'A', Q2: 'B', Q3: 'C', Q4: 'D' };
    const isFarmacia = (p) => (p.business_type || 'pharmacy') !== 'consultorio';
    const zoneMap = new Map();
    const getZ = (key, label) => {
      if (!zoneMap.has(key)) {
        zoneMap.set(key, {
          label,
          marzam: { A: 0, B: 0, C: 0 },
          farm: { A: 0, B: 0, C: 0, D: 0 },
          cons: { A: 0, B: 0, C: 0, D: 0 },
          repsReal: 0,
        });
      }
      return zoneMap.get(key);
    };

    for (const c of (clients || [])) {
      if (!c.poblacion) continue;
      const z = getZ(efKey(c.poblacion), c.poblacion);
      const p = String(c.pareto || '').toUpperCase();
      if (p in z.marzam) z.marzam[p]++;
    }

    for (const p of (prospects || [])) {
      if (!p.state) continue;
      const z = getZ(efKey(p.state), p.state);
      const letra = QUAD_TO_PARETO[String(p.quadrant || '').toUpperCase()];
      if (!letra) continue;
      if (isFarmacia(p)) z.farm[letra]++;
      else z.cons[letra]++;
    }

    // Real representantes per zone
    for (const u of (team || [])) {
      if (u.role !== 'representante' || isVacancy(u)) continue;
      for (const pob of (u.poblaciones || [])) {
        const z = zoneMap.get(efKey(pob));
        if (z) z.repsReal++;
      }
    }

    // Rep monthly capacity
    const repCap = capByRole?.representante || {};
    const repDays = Number(repCap.days_per_month) || WORKING_DAYS_PER_MONTH;
    let repDailySum = 0;
    for (const col of MATRIX_COLS) {
      const kindKey = col.kind === 'marzam' ? 'marzam' : 'prospecto';
      repDailySum += Number(matrixLookup?.representante?.[kindKey]?.[col.p]?.daily_contacts_per_person ?? 0);
    }
    const repMonthlyCapacity = repDays * (repDailySum / MATRIX_COLS.length);

    const sorted = [...zoneMap.values()].sort(
      (a, b) => (b.marzam.A + b.marzam.B + b.marzam.C) - (a.marzam.A + a.marzam.B + a.marzam.C),
    );

    const pobBody = wrap.querySelector('#by-pob-body');
    if (!pobBody) return;

    pobBody.innerHTML = sorted.map((row) => {
      const marzamVis = row.marzam.A * 4 + row.marzam.B * 2 + row.marzam.C * 1;
      const farmVis = row.farm.A * 4 + row.farm.B * 2 + row.farm.C * 1 + row.farm.D * 0.5;
      const consVis = row.cons.A * 4 + row.cons.B * 2 + row.cons.C * 1 + row.cons.D * 0.5;
      const rec = repMonthlyCapacity > 0 ? Math.ceil((marzamVis + farmVis + consVis) / repMonthlyCapacity) : 0;
      const gap = rec - row.repsReal;
      const gapClass = gap > 0 ? 'text-red-600 font-bold' : gap < 0 ? 'text-emerald-600 font-semibold' : 'text-slate-400';
      const isActive = efKey(row.label) === efKey(currentZone || '');
      // Helper: show "x / y" if consultorios exist, else just "x"
      const nv = (f, c) => c > 0 ? `<span title="${f} farm + ${c} cons">${f}<span class="text-pink-400">/${c}</span></span>` : (f || '—');
      const totalFarm = row.farm.A + row.farm.B + row.farm.C + row.farm.D;
      const totalCons = row.cons.A + row.cons.B + row.cons.C + row.cons.D;
      return `
        <tr class="border-b border-slate-50 hover:bg-blue-50/40 cursor-pointer transition-colors ${isActive ? 'bg-blue-50 ring-1 ring-inset ring-blue-200' : ''}"
          data-pob="${escapeHtml(row.label)}">
          <td class="py-1.5 px-3 font-medium text-slate-700 truncate max-w-[110px]" title="${escapeHtml(row.label)}">${escapeHtml(row.label)}</td>
          <td class="py-1 px-1 text-center tabular-nums text-[10px] font-bold" style="color:#1e40af">${row.marzam.A}</td>
          <td class="py-1 px-1 text-center tabular-nums text-[10px]" style="color:#1d4ed8">${row.marzam.B}</td>
          <td class="py-1 px-1 text-center tabular-nums text-[10px]" style="color:#3b82f6">${row.marzam.C}</td>
          <td class="py-1 px-1 text-center tabular-nums text-[10px] font-bold by-state-nuevas-detail" style="color:#7c3aed">${nv(row.farm.A, row.cons.A)}</td>
          <td class="py-1 px-1 text-center tabular-nums text-[10px] by-state-nuevas-detail" style="color:#8b5cf6">${nv(row.farm.B, row.cons.B)}</td>
          <td class="py-1 px-1 text-center tabular-nums text-[10px] by-state-nuevas-detail" style="color:#a78bfa">${nv(row.farm.C, row.cons.C)}</td>
          <td class="py-1 px-1 text-center tabular-nums text-[10px] by-state-nuevas-detail" style="color:#c4b5fd">${nv(row.farm.D, row.cons.D)}</td>
          <td class="py-1 px-1 text-center tabular-nums text-[10px] by-state-nuevas-total" style="color:#7c3aed">${nv(totalFarm, totalCons)}</td>
          <td class="py-1 px-2 text-center tabular-nums text-slate-600">${row.repsReal}</td>
          <td class="py-1 px-2 text-center tabular-nums font-semibold text-slate-800">${rec}</td>
          <td class="py-1 px-2 text-center tabular-nums text-sm ${gapClass}">${gap > 0 ? '+' + gap : gap < 0 ? gap : '✓'}</td>
        </tr>
      `;
    }).join('') || '<tr><td colspan="12" class="text-center py-6 text-slate-400 text-xs">Sin datos de farmacias</td></tr>';
  }

  /**
   * Filtro por Entidad Federativa.
   *
   * Fuente canónica: `marzam_clients.poblacion`.
   *   - Cada cliente vive en UNA poblacion (cardinalidad 1).
   *   - Cada usuario sirve a las poblaciones donde tiene farmacias
   *     asignadas (campo `poblaciones: [...]` enriquecido en el backend
   *     en `team.service.getDescendantsEnriched`).
   */
  function filterByZone(team, clients, zone) {
    if (!zone) return { team, clients };
    // Comparación por efKey (lowercase + sin acentos).
    //
    // Tolerancia de data: si TODOS los users de la sucursal llegan con
    // `poblaciones: []` (la enrichment desde marzam_clients.poblacion no
    // pudo computar nada — gap de assigned_*_id en la BD), no tendría
    // sentido bloquear toda la estimación. En ese caso interpretamos el
    // array vacío como "cobertura desconocida" y los incluimos en
    // cualquier filtro. Una vez que haya datos reales, los users con
    // assignments visibles SÍ se filtran estrictamente.
    const target = efKey(zone);
    // Strict por efKey: el caller hidrata `u.poblaciones` desde
    // marzam_clients antes de llamar (en renderDefaultsTab). Un usuario sin
    // ninguna farmacia en ninguna EF queda fuera — es lo correcto: si su
    // padrón no incluye la EF activa, no hay nada que estimar para él.
    const teamFiltered = (team || []).filter((u) => {
      const list = Array.isArray(u.poblaciones) ? u.poblaciones : [];
      return list.map(efKey).includes(target);
    });
    const clientsFiltered = (clients || []).filter((c) => efKey(c.poblacion) === target);
    return { team: teamFiltered, clients: clientsFiltered };
  }

  /**
   * Pure client-side estimation — no roundtrip per slider move.
   *
   * Visitas/mes  = Σ daily_quota[role][pareto] × N_people[role] × WORKING_DAYS
   * Cobertura %  = visitas_estimadas / visitas_que_el_padrón_requiere
   * visitas_que_el_padrón_requiere = Σ #clientes_pareto × cadencia_mensual_pareto
   *   (A: 4/mes, B: 2/mes, C: 1/mes — coincide con la matriz de reglas arriba)
   */
  function computeEstimation(targets, team, clients) {
    const activePeople = (team || []).filter((u) => u.is_active !== false && !isVacancy(u));
    const peopleByRole = {};
    for (const u of activePeople) {
      const r = normalizeRole(u.role);
      peopleByRole[r] = (peopleByRole[r] || 0) + 1;
    }
    let total = 0;
    const byRolePareto = []; // [{role, pareto, daily, n_people, monthly}]
    for (const t of (targets || [])) {
      const role = normalizeRole(t.role);
      const n = peopleByRole[role] || 0;
      const daily = Number(t.daily_contacts_per_person) || 0;
      const monthly = daily * n * WORKING_DAYS_PER_MONTH;
      total += monthly;
      byRolePareto.push({
        role, pareto: t.pareto_class, daily, n_people: n, monthly,
      });
    }
    // Coverage denominator: how many visits the padron *should* receive.
    const cadence = { A: 4, B: 2, C: 1 };
    let needed = 0;
    for (const c of (clients || [])) {
      const p = String(c.pareto || '').toUpperCase();
      if (cadence[p]) needed += cadence[p];
    }
    const coveragePct = needed > 0 ? Math.round((total / needed) * 100) : 0;
    return {
      total: Math.round(total),
      coverage_pct: coveragePct,
      people_count: activePeople.length,
      clients_count: (clients || []).length,
      needed,
      breakdown: byRolePareto,
    };
  }

  /**
   * Compute + paint the estimation tiles. Called from:
   *   - initial render
   *   - every slider input
   *   - zone selector change
   */
  function computeAndPaintEstimation(targets, team, clients, zone, wrap) {
    const { team: tTeam, clients: tClients } = filterByZone(team, clients, zone);
    const est = computeEstimation(targets, tTeam, tClients);

    const set = (id, txt) => { const el = wrap.querySelector('#' + id); if (el) el.textContent = txt; };
    set('preview-total', est.total.toLocaleString());
    set('preview-coverage', est.coverage_pct + '%');
    set('preview-people', est.people_count.toLocaleString());
    set('capacity-scope-badge', zone ? `Zona: ${zone}` : 'Toda la sucursal');

    // Breakdown — only show rows where there are people AND the role can
    // visit that PARETO. Sort by role rank then pareto so it reads naturally.
    const cells = est.breakdown
      .filter((r) => r.n_people > 0 && r.daily > 0)
      .sort((a, b) => (ROLE_RANK[a.role] || 0) - (ROLE_RANK[b.role] || 0) || a.pareto.localeCompare(b.pareto));
    const wrapBd = wrap.querySelector('#preview-breakdown');
    if (wrapBd) {
      wrapBd.innerHTML = cells.length === 0
        ? '<div class="col-span-3 text-center text-[10px] text-blue-700/60 italic py-1">Mueve los sliders para ver el desglose por rol × PARETO</div>'
        : cells.map((c) => `
          <div class="bg-white/70 rounded-lg px-2 py-1.5 text-left">
            <div class="flex items-center gap-1">
              <span class="pareto-tag" data-pareto="${c.pareto}" style="font-size:9px;padding:0 5px">${c.pareto}</span>
              <span class="text-[9px] font-semibold text-slate-600 truncate">${ROLE_LABEL[c.role] || c.role}</span>
            </div>
            <div class="text-sm font-black text-slate-800 tabular-nums leading-tight">${Math.round(c.monthly).toLocaleString()}</div>
            <div class="text-[9px] text-slate-500 leading-tight">${c.n_people}p × ${c.daily}/d</div>
          </div>
        `).join('');
    }
  }

  async function renderOverridesTab(wrap) {
    // Solo mostramos subordinados que el actor puede gestionar.
    let cascade = { descendants: [] };
    try { cascade = await API.get('/team') || cascade; } catch { /* no-op */ }
    // Vacantes (plazas sin titular) vienen del backend con full_name = 'VACANTE'
    // o vacío.  No tiene sentido configurarles override individual: cuando se
    // ocupe la plaza, el manager configurará al recién llegado desde cero.
    // Filtrarlas aquí evita confusión y avatars sin iniciales.
    const subs = (cascade.descendants || []).filter((s) => !isVacancy(s));

    if (!subs.length) {
      wrap.innerHTML = '<div class="text-center py-12 text-sm text-slate-400">No tienes subordinados activos.<br><span class="text-[11px] text-slate-300">Las plazas vacantes no se muestran.</span></div>';
      return;
    }

    if (!_selectedSubordinateId || !subs.find((s) => s.id === _selectedSubordinateId)) {
      _selectedSubordinateId = subs[0].id;
    }

    wrap.innerHTML = `
      <div class="bg-white border border-slate-200 rounded-2xl p-3 mb-4">
        <label class="text-[10px] font-bold uppercase tracking-wider text-slate-500 block mb-1.5">Subordinado</label>
        <select id="override-sub-select" class="form-input form-select text-sm">
          ${subs.map((s) => `<option value="${s.id}" ${s.id === _selectedSubordinateId ? 'selected' : ''}>${s.full_name} · ${ROLE_LABEL[normalizeRole(s.role)]}</option>`).join('')}
        </select>
      </div>

      <div id="override-detail"></div>
    `;

    wrap.querySelector('#override-sub-select').addEventListener('change', (e) => {
      _selectedSubordinateId = e.target.value;
      renderOverridesTab(wrap);
    });

    await renderOverrideDetail(wrap.querySelector('#override-detail'), _selectedSubordinateId, subs);
  }

  async function renderOverrideDetail(wrap, userId, subs = []) {
    // Resolver el target en este orden: (1) lista de subordinados que ya
    // trajimos del backend (datos reales y frescos), (2) DEMO store como
    // fallback, (3) placeholder mínimo.  El placeholder ya no usa "..." en
    // full_name para evitar avatares raros.
    const target = subs.find((s) => s.id === userId)
      || (DEMO_H && DEMO_H.STORE && DEMO_H.STORE.users.find((u) => u.id === userId))
      || { id: userId, full_name: '—', role: 'representante' };
    const role = normalizeRole(target.role);
    const RULES = (window.DEMO_H && DEMO_H.VISIT_RULES) || {};
    // Solo mostrar PARETOs que el ROL puede visitar (eligibility).
    const eligiblePareto = ['A', 'B', 'C'].filter((p) => (RULES[p]?.eligible_roles || []).includes(role));

    // Resolver effective target por PARETO + listar overrides existentes.
    const resolutions = {};
    for (const p of eligiblePareto) {
      try {
        resolutions[p] = await API.get(`/visit-targets/resolve?user_id=${userId}&pareto=${p}`);
      } catch {
        resolutions[p] = { value: null, source: 'none' };
      }
    }
    let overrides = [];
    try { overrides = await API.get(`/visit-targets/overrides/${userId}`) || []; } catch { /* no-op */ }

    wrap.innerHTML = `
      <div class="bg-gradient-to-br from-slate-50 to-white border border-slate-200 rounded-2xl p-4 mb-4">
        <div class="flex items-center gap-3 mb-1">
          <div class="team-avatar team-avatar--${role}" style="width:36px;height:36px;font-size:12px">${(target.full_name || '?').split(/\s+/).slice(0,2).map((s)=>s[0]).join('').toUpperCase()}</div>
          <div class="flex-1">
            <div class="text-sm font-bold text-slate-800">${target.full_name}</div>
            <div class="text-[11px] text-slate-500">${ROLE_LABEL[role]} · ${target.zone || target.email || ''}</div>
          </div>
        </div>
      </div>

      <div class="space-y-3 mb-4">
        ${eligiblePareto.map((p) => overrideRowHtml(p, resolutions[p], target, role)).join('')}
      </div>

      ${overrides.length ? `
      <div class="bg-white border border-slate-200 rounded-2xl p-3 mb-4">
        <h5 class="text-[10px] font-black uppercase tracking-wider text-slate-500 mb-2">Historial de overrides activos</h5>
        ${overrides.map((o) => `
          <div class="flex items-center gap-2 py-1.5 border-t border-slate-100 first:border-0 first:pt-0">
            <span class="pareto-tag" data-pareto="${o.pareto_class}">${o.pareto_class}</span>
            <span class="text-xs font-bold text-[#1b365d] tabular-nums">${o.daily_contacts_per_person} /día</span>
            <span class="text-[10px] text-slate-400 flex-1 truncate">${o.set_by_name || '—'} · ${(o.effective_from || '').slice(0,10)}</span>
          </div>
        `).join('')}
      </div>
      ` : ''}

      <button id="override-regen" class="w-full btn btn-primary py-2.5 text-sm font-bold">Regenerar ruta de ${target.full_name?.split(' ')[0] || 'subordinado'}</button>
      <p class="text-[10px] text-slate-400 text-center mt-2">Reasigna farmacias del periodo en curso. Las visitas <b>completadas</b> se conservan.</p>
    `;

    wrap.querySelectorAll('[data-action="save-override"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const pareto = btn.dataset.pareto;
        const input = wrap.querySelector(`[data-override-input="${pareto}"]`);
        const value = Number(input.value);
        if (!Number.isFinite(value) || value < 0 || value > 50) {
          window.MarzamToast.show('Valor inválido (0-50)', 'error');
          return;
        }
        btn.disabled = true;
        try {
          await API.post('/visit-targets/overrides', {
            subordinate_user_id: userId,
            pareto_class: pareto,
            channel: 'visit',
            daily_contacts_per_person: value,
            reason: input.dataset.reason || null,
          });
          window.MarzamToast.show(`Override aplicado · ${value} /día para PARETO ${pareto}`, 'success');
          renderOverrideDetail(wrap, userId);
        } catch (err) {
          window.MarzamToast.show(`Error: ${err.message || err}`, 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });

    wrap.querySelector('#override-regen').addEventListener('click', () => {
      regeneratePlanModal(null, { scopeUserId: userId, subordinateName: target.full_name });
    });
  }

  function overrideRowHtml(pareto, resolution, target, role) {
    const value = resolution.value != null ? resolution.value : 0;
    const isOverride = resolution.source === 'override';
    const provenance = resolution.source === 'override'
      ? `<span class="text-[10px] font-semibold text-violet-600">⊕ Override por ${resolution.set_by_name || '—'} (${resolution.set_by_role ? ROLE_LABEL[resolution.set_by_role] : ''})</span>`
      : resolution.source === 'branch_default'
      ? '<span class="text-[10px] font-semibold text-slate-400">Default de sucursal</span>'
      : '<span class="text-[10px] font-semibold text-slate-300">Sin valor configurado</span>';
    return `
      <div class="bg-white border ${isOverride ? 'border-violet-300 ring-1 ring-violet-100' : 'border-slate-200'} rounded-2xl p-3">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="pareto-tag" data-pareto="${pareto}">${pareto}</span>
            <span class="text-xs font-bold text-slate-700">${ROLE_LABEL[role]}</span>
          </div>
          ${provenance}
        </div>
        <div class="flex items-center gap-2">
          <input type="number" min="0" max="50" value="${value}" data-override-input="${pareto}"
                 class="form-input flex-1 text-sm font-black text-[#1b365d] text-center tabular-nums">
          <span class="text-[11px] text-slate-500 font-semibold">/día</span>
          <button data-action="save-override" data-pareto="${pareto}"
                  class="btn btn-primary text-xs py-2 px-3 font-bold">Aplicar</button>
        </div>
      </div>
    `;
  }

  function regeneratePlanModal(targets, opts = {}) {
    const scopeLabel = opts.subordinateName ? `· para ${opts.subordinateName}` : '· toda la sucursal';
    const html = `
      <div class="text-sm text-slate-700 mb-3">
        Vas a regenerar el plan del periodo en curso ${scopeLabel}.
      </div>
      <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-3 mb-3">
        <div class="flex items-start gap-2">
          <div class="text-emerald-600 text-lg">✓</div>
          <div>
            <div class="text-[11px] font-bold text-emerald-700 uppercase tracking-wider">Visitas conservadas</div>
            <p class="text-[11px] text-emerald-700 mt-0.5">Todas las farmacias ya marcadas como <b>completadas</b> se preservan. Solo se reasignan las pendientes según los nuevos targets.</p>
          </div>
        </div>
      </div>
      <div class="bg-amber-50 border border-amber-200 rounded-xl p-3">
        <div class="flex items-start gap-2">
          <div class="text-amber-600 text-lg">!</div>
          <div>
            <div class="text-[11px] font-bold text-amber-700 uppercase tracking-wider">Lo que cambia</div>
            <p class="text-[11px] text-amber-700 mt-0.5">El número de farmacias pendientes y su distribución entre días se recalculan con los nuevos números.</p>
          </div>
        </div>
      </div>
    `;
    const m = window.MarzamModal.show({
      title: 'Regenerar plan',
      html,
      footer: '<button class="modal-close btn btn-ghost text-sm py-1.5 px-3">Cancelar</button><button id="confirm-regen" class="btn btn-primary text-sm py-1.5 px-3 font-bold">Confirmar</button>',
    });
    m.root.querySelector('#confirm-regen').addEventListener('click', async () => {
      const today = new Date();
      const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)).toISOString().slice(0, 10);
      const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      try {
        await API.post('/visit-plans', {
          granularity: 'monthly',
          period_start: monthStart,
          period_end: monthEnd,
          scope_user_id: opts.scopeUserId || null,
          preserve_completed: true,
          config: { targets: targets || [] },
        });
        m.close();
        window.MarzamToast.show('Plan regenerado · visitas completadas conservadas', 'success');
      } catch (err) {
        window.MarzamToast.show(`Error: ${err.message || err}`, 'error');
      }
    });
  }

  // ──────────────────────────────────────────────────────────
  // Visit Session post-summary modal
  // ──────────────────────────────────────────────────────────
  function showSessionSummary(session) {
    const start = Date.parse(session.started_at);
    const end = session.ended_at ? Date.parse(session.ended_at) : Date.now();
    const totalSec = Math.max(1, Math.floor((end - start) / 1000));
    const distance = (session.total_distance_m || 0) / 1000;
    const visited = session.pharmacies_visited || 0;
    const planned = session.pharmacies_planned || 0;
    const onSiteSec = totalSec - (session.idle_seconds || 0);
    const efficiency = planned > 0 ? Math.round((visited / planned) * 100) : 0;
    const avgPerStop = visited > 0 ? Math.round(totalSec / visited / 60) : 0;

    const html = `
      <div class="text-center mb-5">
        <div class="text-[10px] font-bold uppercase tracking-widest text-emerald-600">Modo Visita finalizado</div>
        <div class="text-3xl font-black text-slate-800 mt-1 tabular-nums">${fmtDuration(totalSec)}</div>
        <div class="text-xs text-slate-500 mt-1">Duración total · ${visited}/${planned} farmacias</div>
      </div>

      <div class="grid grid-cols-2 gap-3 mb-4">
        <div class="kpi-mini">
          <div class="kpi-mini__value">${fmtDuration(onSiteSec)}</div>
          <div class="kpi-mini__label">EN CAMPO</div>
        </div>
        <div class="kpi-mini">
          <div class="kpi-mini__value">${fmtDuration(session.idle_seconds || 0)}</div>
          <div class="kpi-mini__label">IDLE</div>
        </div>
        <div class="kpi-mini">
          <div class="kpi-mini__value">${distance.toFixed(1)}km</div>
          <div class="kpi-mini__label">DISTANCIA</div>
        </div>
        <div class="kpi-mini">
          <div class="kpi-mini__value">${avgPerStop}m</div>
          <div class="kpi-mini__label">PROM/STOP</div>
        </div>
      </div>

      <div class="bg-gradient-to-r from-emerald-50 to-blue-50 border border-emerald-200 rounded-xl p-3 text-center">
        <div class="text-[10px] font-bold uppercase tracking-wider text-emerald-700">Eficiencia</div>
        <div class="text-2xl font-black text-emerald-700 mt-1">${efficiency}%</div>
        <div class="text-[10px] text-emerald-600 mt-0.5">${efficiency >= 90 ? '¡Excelente trabajo!' : efficiency >= 70 ? 'Buen ritmo' : 'Hay margen para mejorar'}</div>
      </div>
    `;
    window.MarzamModal.show({
      title: 'Resumen de tu sesión',
      html,
      footer: '<button class="modal-close btn btn-primary text-sm py-1.5 px-4">Listo</button>',
    });
  }

  // ──────────────────────────────────────────────────────────
  // Re-render the active tab when real-data enrichment finishes.
  // ──────────────────────────────────────────────────────────
  window.addEventListener('demoHierarchyEnriched', () => {
    if (!window.MarzamApp || !window.MarzamApp.selectTab) return;
    const tab = APP.activeTab;
    if (!tab) return;
    // Re-run selectTab so the visible view picks up the real names.
    window.MarzamApp.selectTab(tab);
  });

  // ──────────────────────────────────────────────────────────
  // Expose to app.js
  // ──────────────────────────────────────────────────────────
  window.MarzamViews = {
    renderMyRoutes,
    renderMyTeam,
    renderAnalytics,
    renderTargets,
    showSessionSummary,
  };
})();
