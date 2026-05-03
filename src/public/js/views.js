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
  const PARETO_COLORS = { A: '#dc2626', B: '#f59e0b', C: '#2563eb' };

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
        ${stops.map((s, i) => stopCardHtml(s, i)).join('')}
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
    for (let i = 0; i < marzamCap; i++) {
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
          <div class="text-sm font-bold text-slate-800 mt-1 truncate">${s.name}</div>
          <div class="text-[11px] text-slate-500 truncate">${s.address || ''}</div>
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

    // Apply filters (search + role chips, all client-side for instant feedback)
    const headerLevelFilter = document.getElementById('team-level-filter')?.value;
    if (headerLevelFilter && headerLevelFilter !== 'all') TEAM_FILTERS.role = headerLevelFilter;
    const search = (TEAM_FILTERS.search || '').trim().toLowerCase();
    let filtered = subordinates;
    if (TEAM_FILTERS.role !== 'all') filtered = filtered.filter((u) => u.role === TEAM_FILTERS.role);
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

    body.innerHTML = `
      ${breadcrumbHtml}

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
    list.innerHTML = filtered.map(teamCardHtml).join('');
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

  function teamCardHtml(u) {
    const presence = u.presence || { status: 'offline', last_seen: null };
    const m = u.metrics || { planned: 0, done: 0, planned_today: 0, done_today: 0, compliance_pct: null };
    const presenceTxt = presenceLabel(presence.status);
    const role = normalizeRole(u.role);
    const monthlyPct = Math.round(m.compliance_pct || 0);
    const todayPct = m.planned_today > 0 ? Math.round((m.done_today / m.planned_today) * 100) : 0;

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
  };

  async function renderAnalytics(body) {
    if (window.MarzamPharmaciesMap) window.MarzamPharmaciesMap.hide();
    body.innerHTML = `
      <div class="bg-white border border-slate-200 rounded-2xl p-3 mb-4 sticky top-0 z-10">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
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
          <select id="filter-person" class="text-xs font-semibold bg-slate-100 border-0 rounded-lg px-2 py-2 outline-none col-span-2 md:col-span-1">
            <option value="">Todas las personas</option>
          </select>
          <button id="filter-reset" class="text-xs font-semibold bg-slate-100 hover:bg-slate-200 rounded-lg px-2 py-2 outline-none">Limpiar</button>
        </div>
      </div>

      <div id="analytics-content"></div>
    `;

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
    document.getElementById('filter-reset').addEventListener('click', () => {
      ANALYTICS_FILTERS.role = null; ANALYTICS_FILTERS.userId = null; ANALYTICS_FILTERS.days = 30;
      document.getElementById('filter-role').value = '';
      document.getElementById('filter-person').value = '';
      document.getElementById('filter-period').value = '30';
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
    const qStr = qs.toString() ? `?${qs.toString()}` : '';

    const [funnel, heatmap, paretoMix, untouched] = await Promise.all([
      API.get(`/analytics/funnel${qStr}`).catch((e) => { console.warn(e); return null; }),
      API.get(`/analytics/team${qStr.replace(/days=\d+&?/, '')}`).catch(() => ({ rows: [], users: [] })),
      API.get(`/analytics/pareto-mix${qStr.replace(/days=\d+&?/, '')}`).catch(() => []),
      API.get('/analytics/untouched').catch(() => []),
    ]);

    if (!funnel) {
      wrap.innerHTML = '<div class="text-center py-12 text-sm text-slate-400">No hay datos para los filtros aplicados.</div>';
      return;
    }

    wrap.innerHTML = `
      ${renderFunnelHero(funnel)}
      ${renderOutcomeAndDistance(funnel)}
      ${renderTopPerformers(funnel)}
      ${renderAnomaliesFeed(funnel)}
      ${renderHourlyDistribution(funnel)}
      ${renderHeatmap(heatmap)}
      ${renderParetoMix(paretoMix)}
      ${renderUntouched(untouched)}
      ${renderPerUserTable(funnel)}
    `;

    // Monta los charts reales (Chart.js) sobre los <canvas> que dejaron
    // los renderers de arriba. Si Chart.js no cargó (offline), los
    // canvas quedan vacíos y la UI sigue mostrando los fallbacks HTML.
    mountAnalyticsCharts(funnel, paretoMix);
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
    const total = outcomes.reduce((s, o) => s + o.count, 0) || 1;

    const dist = f.distance_buckets || [];
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
          </div>
          <p class="text-[10px] text-slate-400 mt-2 text-center">Total: <b class="text-slate-700 tabular-nums">${total.toLocaleString()}</b> visitas</p>
        </div>
        <div class="bg-white border border-slate-200 rounded-2xl p-4">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">Distancia del checkin a la farmacia</h4>
          <p class="text-[10px] text-slate-400 mb-3">Mide qué tan cerca estuvo el rep al registrar la visita.</p>
          <div class="space-y-2">${distRows}</div>
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

  function renderAnomaliesFeed(f) {
    const a = f.anomalies || [];
    if (!a.length) return '';
    const SEVERITY_BG = { high: 'bg-rose-50 border-rose-200', medium: 'bg-amber-50 border-amber-200', low: 'bg-slate-50 border-slate-200' };
    const SEVERITY_DOT = { high: 'bg-rose-500', medium: 'bg-amber-500', low: 'bg-slate-400' };
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
        <div class="flex items-center justify-between mb-3">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider">Feed de anomalías</h4>
          <span class="text-[10px] text-slate-400">${a.length} eventos</span>
        </div>
        <div class="space-y-2 max-h-[280px] overflow-y-auto">
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
    if (!hourly.length) return '';
    return `
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div class="bg-white border border-slate-200 rounded-2xl p-4">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Distribución horaria de visitas</h4>
          <div class="relative" style="height:160px">
            <canvas id="chart-hourly-bar"></canvas>
          </div>
        </div>
        <div class="bg-white border border-slate-200 rounded-2xl p-4">
          <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Tendencia de cumplimiento</h4>
          <div class="relative" style="height:160px">
            <canvas id="chart-trend-line"></canvas>
          </div>
        </div>
      </div>
    `;
  }

  function renderPerUserTable(f) {
    const users = (f.per_user || []).slice(0, 12);
    if (!users.length) return '';
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
    if (!users.length) return '<div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4 text-center text-xs text-slate-400">Sin datos para el periodo seleccionado.</div>';
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
    const total = data.reduce((s, x) => s + (x.planned || 0), 0);
    if (!total) return '<div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4 text-center text-xs text-slate-400">Sin distribución PARETO.</div>';
    const COLORS = { A: '#dc2626', B: '#f59e0b', C: '#2563eb' };
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
        <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Mix PARETO · ${total.toLocaleString()} visitas planeadas</h4>
        <div class="relative" style="height:200px">
          <canvas id="chart-pareto-bar"></canvas>
        </div>
        <div class="grid grid-cols-3 gap-2 mt-3">
          ${data.map((x) => {
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
    if (!rows || !rows.length) return '';
    return `
      <div class="bg-white border border-rose-200 rounded-2xl p-4 mb-4">
        <div class="flex items-center gap-2 mb-3">
          <div class="w-7 h-7 rounded-lg bg-rose-100 flex items-center justify-center text-rose-600">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
          </div>
          <h4 class="text-xs font-bold text-rose-700 uppercase tracking-wider">Top sin visitar 30+ días</h4>
        </div>
        <div class="space-y-2">
          ${rows.slice(0, 5).map((r) => `
            <div class="flex items-center gap-2 py-1.5 border-b border-slate-100 last:border-0">
              <span class="pareto-tag" data-pareto="${r.pareto}">${r.pareto}</span>
              <div class="flex-1 min-w-0">
                <div class="text-xs font-bold text-slate-800 truncate">${r.farmacia_nombre}</div>
                <div class="text-[10px] text-slate-400">${r.delegacion_municipio} · ${r.cpadre}</div>
              </div>
              <span class="text-[11px] font-bold text-rose-600">${r.days_without}d</span>
            </div>
          `).join('')}
        </div>
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
  let _planActiveSubtab = 'defaults';
  let _selectedSubordinateId = null;

  // El nombre `renderTargets` se mantiene por compatibilidad con app.js
  // y llamadas internas (regenerar plan).  Internamente delega a renderPlan.
  async function renderTargets(body) { return renderPlan(body); }

  async function renderPlan(body) {
    if (window.MarzamPharmaciesMap) window.MarzamPharmaciesMap.hide();
    if (APP.role === ROLES.REPRESENTANTE) {
      body.innerHTML = '<div class="text-center py-12 text-sm text-slate-400">Solo lectura para tu rol.</div>';
      return;
    }

    body.innerHTML = `
      ${rulesMatrixHtml()}

      <!-- Tabs internos: scroll horizontal en móvil si no caben los 3 labels.
           overflow-x-auto + flex-shrink-0 en cada botón evita el wrap feo. -->
      <div class="flex bg-slate-100 rounded-xl p-1 mb-4 overflow-x-auto no-scrollbar">
        <button class="subtab-btn ${_planActiveSubtab === 'defaults' ? 'active' : ''} flex-1 flex-shrink-0 min-w-0 py-2 px-2 text-[11px] sm:text-xs font-bold rounded-lg transition whitespace-nowrap" data-subtab="defaults">
          Defaults
        </button>
        <button class="subtab-btn ${_planActiveSubtab === 'overrides' ? 'active' : ''} flex-1 flex-shrink-0 min-w-0 py-2 px-2 text-[11px] sm:text-xs font-bold rounded-lg transition whitespace-nowrap" data-subtab="overrides">
          Por persona
        </button>
        <button class="subtab-btn ${_planActiveSubtab === 'compliance' ? 'active' : ''} flex-1 flex-shrink-0 min-w-0 py-2 px-2 text-[11px] sm:text-xs font-bold rounded-lg transition whitespace-nowrap" data-subtab="compliance">
          Cumplimiento
        </button>
      </div>

      <div id="plan-subbody"></div>
    `;

    body.querySelectorAll('.subtab-btn').forEach((btn) => {
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

  async function renderDefaultsTab(wrap) {
    let targets = [];
    try {
      targets = await API.get('/visit-targets') || [];
    } catch {
      targets = (window.DEMO_H && DEMO_H.STORE && DEMO_H.STORE.visit_targets) || [];
    }
    const visitTargets = targets.filter((t) => (t.channel || 'visit') !== 'contact_center');

    const canEditRow = (row) => {
      // El rol del usuario solo puede tocar roles inferiores. Director puede todos los roles inferiores.
      const myRank = ROLE_RANK[APP.role];
      const rowRank = ROLE_RANK[row.role];
      if (rowRank == null) return false;
      return myRank < rowRank;
    };

    wrap.innerHTML = `
      <div class="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
        <div class="flex items-start justify-between mb-3">
          <div>
            <h4 class="text-xs font-bold text-slate-700 uppercase tracking-wider">Contactos diarios por (PARETO × Rol)</h4>
            <p class="text-[11px] text-slate-500 mt-0.5">Aplica a toda tu sucursal. Override individual en "Por persona".</p>
          </div>
        </div>
        <div id="target-rows" class="space-y-3"></div>
        <!-- Nota de prospección: explicación de cómo entran las farmacias nuevas
             al plan sin meterse en el slider (no abulta la UI con un control extra). -->
        <div class="mt-3 pt-3 border-t border-dashed border-slate-200 flex items-start gap-2">
          <span class="text-base leading-none">🆕</span>
          <p class="text-[11px] text-slate-500 leading-snug">
            <b class="text-slate-700">Farmacias nuevas (prospectos)</b> se tratan como
            <span class="pareto-tag inline-block" data-pareto="C">C</span>
            y se reparten entre <b>supervisores</b> y <b>representantes</b>: rellenan los slots
            de C que no alcanzaron a cubrir clientes existentes, ordenadas por potencial (Q1 primero).
          </p>
        </div>
      </div>

      <div class="bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-4 mb-4">
        <h4 class="text-xs font-bold text-blue-700 uppercase tracking-wider mb-2">Estimación del plan</h4>
        <div class="grid grid-cols-2 gap-3 text-center">
          <div>
            <div class="text-2xl font-black text-blue-900" id="preview-total">—</div>
            <div class="text-[10px] font-bold text-blue-700 uppercase tracking-wider">Visitas estimadas</div>
          </div>
          <div>
            <div class="text-2xl font-black text-emerald-700" id="preview-coverage">—</div>
            <div class="text-[10px] font-bold text-emerald-700 uppercase tracking-wider">Cobertura padrón</div>
          </div>
        </div>
      </div>

      <button id="btn-generate-plan" class="w-full btn btn-primary py-3 font-bold text-sm">Generar / Regenerar plan →</button>
      <p class="text-[10px] text-slate-400 text-center mt-2">Las visitas ya completadas se preservan al regenerar.</p>
    `;

    const rowsWrap = wrap.querySelector('#target-rows');
    rowsWrap.innerHTML = visitTargets.map((t, idx) => {
      const editable = canEditRow(t);
      const max = t.role === ROLES.REPRESENTANTE ? 30 : t.role === ROLES.GERENTE ? 15 : 10;
      const valPct = Math.min(100, (t.daily_contacts_per_person / max) * 100);
      const lockTooltip = !editable ? 'title="Tu rol no puede modificar este target"' : '';
      return `
        <div class="flex items-center gap-3 ${editable ? '' : 'opacity-60'}" ${lockTooltip}>
          <span class="pareto-tag" data-pareto="${t.pareto_class}">${t.pareto_class}</span>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs font-bold text-slate-700">${ROLE_LABEL[t.role] || t.role}${!editable ? ' 🔒' : ''}</span>
              <span class="text-[11px] font-bold text-[#1b365d] tabular-nums" id="target-val-${idx}">${t.daily_contacts_per_person} /día</span>
            </div>
            <input type="range" class="target-slider" min="0" max="${max}" value="${t.daily_contacts_per_person}"
              data-idx="${idx}" data-role="${t.role}" data-pareto="${t.pareto_class}"
              ${editable ? '' : 'disabled'} style="--val:${valPct}%">
          </div>
        </div>
      `;
    }).join('');

    wrap.querySelectorAll('.target-slider').forEach((slider) => {
      let saveTimer = null;
      slider.addEventListener('input', () => {
        const idx = +slider.dataset.idx;
        const target = visitTargets[idx];
        target.daily_contacts_per_person = +slider.value;
        const max = +slider.max;
        slider.style.setProperty('--val', `${(slider.value / max) * 100}%`);
        wrap.querySelector(`#target-val-${idx}`).textContent = `${slider.value} /día`;
        refreshDefaultsPreview(visitTargets);
        // Save debounced
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
          try {
            await API.post('/visit-targets', {
              role: target.role,
              pareto_class: target.pareto_class,
              channel: 'visit',
              daily_contacts_per_person: target.daily_contacts_per_person,
            });
          } catch { /* silent in demo */ }
        }, 400);
      });
    });

    refreshDefaultsPreview(visitTargets);

    wrap.querySelector('#btn-generate-plan').addEventListener('click', () => regeneratePlanModal(visitTargets));
  }

  async function refreshDefaultsPreview(targets) {
    try {
      const r = await API.post('/visit-plans/preview', { targets });
      document.getElementById('preview-total').textContent = (r.total_estimated || 0).toLocaleString();
      document.getElementById('preview-coverage').textContent = `${r.coverage_pct || 0}%`;
    } catch { /* no-op */ }
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
