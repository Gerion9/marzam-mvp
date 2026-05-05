/* ====================================================================
   Marzam Pharmacies Map — overlay del mapa principal con TODAS las
   farmacias y consultorios visibles para el rol del usuario.

   DOS SEÑALES, COLOR vs FORMA:

   COLOR = clase de prioridad
     Padrón Marzam (clientes actuales) — `pharmacies.pareto` (A/B/C),
     poblado por syncDetalleMostrador via el join de `clave_mostrador`:
       - PARETO A → rojo intenso (#dc2626) · "Cuenta crítica"
       - PARETO B → ámbar         (#f59e0b) · "Cuenta media"
       - PARETO C → azul          (#2563eb) · "Cuenta long-tail"

     Prospectos (NO clientes Marzam) — `pharmacies.quadrant` (Q1..Q4),
     mapeado a A/B/C/D *en este FE* (no se persiste así en BD):
       - Q1 → A · alto potencial (rosa pastel  #f87171)
       - Q2 → B · potencial medio (amarillo    #fbbf24)
       - Q3 → C · potencial bajo  (gris azulado#94a3b8)
       - Q4 → D · descartable     (gris fuerte #64748b)
     El bucket D es un visual; los reps pueden ir y reclasificarlas
     como C en su sistema interno si convierten.

   FORMA = naturaleza del POI
     Farmacia    → círculo
     Consultorio → cruz médica (+) blanca sobre el color
     `business_type` viene del API; default 'pharmacy' si NULL.

   AVISO PARA CLIENTES MARZAM
     Marzam no nos pasó lat/lng — BlackPrint geocodificó la dirección.
     Cuando `geocoded_relevance` está poblado, el popup muestra
     "Ubicación geocodeada · XX% confianza" en rojo para que el rep no
     confíe ciegamente en el dot mientras Marzam no nos mande coords.

   Reglas de visibilidad por rol:
     - Director: TODO el padrón + todos los prospectos
     - Gerente:  padrón de su gerencia + prospectos en su zona
     - Supervisor: padrón asignado a sus reps + prospectos cercanos
     - Representante: padrón asignado a él + prospectos en su polígono

   Leyenda: esquina INFERIOR DERECHA, click en cualquier parte del row.
   ==================================================================== */
(function () {
  'use strict';

  const PARETO_COLORS = { A: '#dc2626', B: '#f59e0b', C: '#2563eb' };
  // Pastel-shifted (lighter) versions of the Pareto palette so prospects
  // sit in the same color family but visually subordinate to the padrón.
  // D extends the gradient with a darker grey since "descartable" deserves
  // a stronger negative signal than C ("potencial bajo").
  const PROSPECT_TIER_COLORS = {
    A: '#f87171',
    B: '#fbbf24',
    C: '#94a3b8',
    D: '#64748b',
  };

  const STATE = {
    visible: false,
    filters: {
      // Padrón Marzam (clients)
      padron_A: true,
      padron_B: true,
      padron_C: true,
      // Prospectos: farmacias
      prosp_farm_A: true,
      prosp_farm_B: true,
      prosp_farm_C: true,
      prosp_farm_D: true,
      // Prospectos: consultorios
      prosp_cons_A: true,
      prosp_cons_B: true,
      prosp_cons_C: true,
      prosp_cons_D: true,
    },
    legendEl: null,
  };

  function getMap() { return window.APP && window.APP.map; }

  function clearLayer(id) {
    const map = getMap();
    if (!map) return;
    const layerIds = [id, `${id}-prospects`, `${id}-prospects-cross`, 'marzam-pharmacies-cross'];
    const sourceIds = [id, `${id}-prospects`, `${id}-prospects-cross`];
    // Layers must all be removed before any source that they reference is removed.
    layerIds.forEach((layerId) => {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    });
    sourceIds.forEach((sourceId) => {
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    });
  }

  function getCurrentUser() {
    if (window.DEMO_H && DEMO_H.helpers && DEMO_H.helpers.getCurrentUser) {
      const u = DEMO_H.helpers.getCurrentUser();
      if (u) return u;
    }
    try { return JSON.parse(localStorage.getItem('user') || 'null'); } catch { return null; }
  }

  function rolesNorm(role) {
    const ALIASES = {
      manager: 'director_sucursal', national_admin: 'director_sucursal',
      regional_manager: 'gerente_ventas', area_coordinator: 'supervisor', field_rep: 'representante',
    };
    return ALIASES[role] || role || 'representante';
  }

  /**
   * Decide qué farmacias mostrar dado el rol y la jerarquía.
   */
  function pharmaciesVisibleToUser(user) {
    if (!window.DEMO_H || !DEMO_H.STORE) return { padron: [], prospects: [] };
    const STORE = DEMO_H.STORE;
    const role = rolesNorm(user && user.role);

    let padron = STORE.pharmacies || [];
    if (role === 'representante' && user) {
      padron = padron.filter((p) => p.assigned_rep_id === user.id);
    } else if (role === 'supervisor' && user) {
      const myRepIds = (STORE.users || [])
        .filter((u) => u.manager_id === user.id)
        .map((u) => u.id);
      const set = new Set(myRepIds);
      padron = padron.filter((p) => set.has(p.assigned_rep_id) || p.assigned_supervisor_id === user.id);
    } else if (role === 'gerente_ventas' && user) {
      const supIds = (STORE.users || []).filter((u) => u.manager_id === user.id).map((u) => u.id);
      const repIds = (STORE.users || []).filter((u) => supIds.includes(u.manager_id)).map((u) => u.id);
      const set = new Set(repIds);
      padron = padron.filter((p) => set.has(p.assigned_rep_id));
    }

    let prospects = STORE.prospects || [];
    if (role === 'representante' && user) {
      prospects = prospects.filter((pr) => {
        const dx = (pr.lat - user.lat) * 111;
        const dy = (pr.lng - user.lng) * 111 * Math.cos(user.lat * Math.PI / 180);
        return Math.hypot(dx, dy) <= 6;
      });
    } else if (role === 'supervisor' && user) {
      prospects = prospects.filter((pr) => {
        const dx = (pr.lat - user.lat) * 111;
        const dy = (pr.lng - user.lng) * 111 * Math.cos(user.lat * Math.PI / 180);
        return Math.hypot(dx, dy) <= 12;
      });
    } else if (role === 'gerente_ventas' && user) {
      prospects = prospects.filter((pr) => {
        const dx = (pr.lat - user.lat) * 111;
        const dy = (pr.lng - user.lng) * 111 * Math.cos(user.lat * Math.PI / 180);
        return Math.hypot(dx, dy) <= 25;
      });
    }

    return { padron, prospects };
  }

  /**
   * Read the cosmetic tier of a prospect.  Order of preference:
   *   1) `quadrant` (Q1..Q4) → A/B/C/D — the new authoritative signal,
   *      from `staging.stg_marzam_master_scored_*.quadrant`
   *   2) `tier` / `pareto` (legacy A/B/C) — back-compat for snapshots
   *      synced before the master_scored switch
   *   3) fallback to 'D' so silent NULLs surface as low-priority instead
   *      of being dropped — better to show a row than hide a data issue
   */
  function prospectTier(p) {
    const q = (p.quadrant || '').toUpperCase();
    if (q === 'Q1') return 'A';
    if (q === 'Q2') return 'B';
    if (q === 'Q3') return 'C';
    if (q === 'Q4') return 'D';
    const t = (p.tier || p.pareto || '').toUpperCase();
    if (t === 'A' || t === 'B' || t === 'C') return t;
    return 'D';
  }

  function businessTypeOf(p) {
    return p.business_type === 'consultorio' ? 'consultorio' : 'pharmacy';
  }

  function applyFilters(padron, prospects) {
    const f = STATE.filters;
    const padronFiltered = padron.filter((p) => {
      if (p.pareto === 'A' && !f.padron_A) return false;
      if (p.pareto === 'B' && !f.padron_B) return false;
      if (p.pareto === 'C' && !f.padron_C) return false;
      return p.pareto === 'A' || p.pareto === 'B' || p.pareto === 'C';
    });
    const prospectsFiltered = prospects.filter((p) => {
      const t = prospectTier(p);
      const isCons = businessTypeOf(p) === 'consultorio';
      const key = isCons ? `prosp_cons_${t}` : `prosp_farm_${t}`;
      return f[key];
    });
    return { padron: padronFiltered, prospects: prospectsFiltered };
  }

  function paint(padron, prospects) {
    const map = getMap();
    if (!map) return;
    const apply = () => {
      clearLayer('marzam-pharmacies');

      // ── Padrón Marzam ──
      const padronFeatures = padron.map((p) => ({
        type: 'Feature',
        properties: {
          id: p.id,
          name: p.name || 'Farmacia',
          pareto: p.pareto || 'C',
          color: PARETO_COLORS[p.pareto] || PARETO_COLORS.C,
          chain: p.chain || '',
          address: p.address || '',
          municipality: p.municipality || '',
          source: 'padron',
          business_type: businessTypeOf(p),
          // Marzam-only: 0..1 from BlackPrint geocoder.  Used in popup
          // to flag locations we can't 100 % trust until Marzam ships
          // their real coordinates.
          geocoded_relevance: p.geocoded_relevance != null ? Number(p.geocoded_relevance) : null,
          final_score: p.final_score != null ? Number(p.final_score) : null,
        },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      }));
      map.addSource('marzam-pharmacies', { type: 'geojson', data: { type: 'FeatureCollection', features: padronFeatures } });
      map.addLayer({
        id: 'marzam-pharmacies',
        type: 'circle',
        source: 'marzam-pharmacies',
        paint: {
          'circle-radius': [
            'match', ['get', 'pareto'],
            'A', 8,
            'B', 6,
            'C', 4.5,
            5,
          ],
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      });

      // ── Prospectos ──
      const prospectFeatures = prospects.map((p) => {
        const tier = prospectTier(p);
        const bt = businessTypeOf(p);
        return {
          type: 'Feature',
          properties: {
            id: p.id,
            name: p.name || (bt === 'consultorio' ? 'Consultorio' : 'Prospecto'),
            tier,
            color: PROSPECT_TIER_COLORS[tier] || PROSPECT_TIER_COLORS.D,
            chain: p.chain || '',
            address: p.address || '',
            municipality: p.municipality || '',
            source: 'prospect',
            business_type: bt,
            potential_score: p.potential_score || 0,
            order_potential: p.order_potential || 0,
            distance_to_nearest_marzam_m: p.distance_to_nearest_marzam_m || 0,
            // Prospects come from Dataplor (field-collected lat/lng) so
            // geocoded_relevance is NULL — but we still pass final_score
            // through so the popup can render the potential bar.
            final_score: p.final_score != null ? Number(p.final_score) : null,
          },
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        };
      });
      map.addSource('marzam-pharmacies-prospects', { type: 'geojson', data: { type: 'FeatureCollection', features: prospectFeatures } });
      map.addLayer({
        id: 'marzam-pharmacies-prospects',
        type: 'circle',
        source: 'marzam-pharmacies-prospects',
        paint: {
          'circle-radius': [
            'match', ['get', 'tier'],
            'A', 7,
            'B', 5.5,
            'C', 4,
            'D', 3.5,
            5,
          ],
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.85,
        },
      });

      // Consultorio overlay: a white "+" cross stamped on top of the
      // colored circle.  Cheaper than a SymbolLayer with a sprite and
      // works without registering image assets.
      map.addLayer({
        id: 'marzam-pharmacies-prospects-cross',
        type: 'symbol',
        source: 'marzam-pharmacies-prospects',
        filter: ['==', ['get', 'business_type'], 'consultorio'],
        layout: {
          'text-field': '+',
          'text-size': [
            'match', ['get', 'tier'],
            'A', 14,
            'B', 12,
            'C', 10,
            'D', 9,
            10,
          ],
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': 'rgba(0,0,0,0.25)',
          'text-halo-width': 0.6,
        },
      });

      // Click handler — popup con info detallada.
      ['marzam-pharmacies', 'marzam-pharmacies-prospects'].forEach((layerId) => {
        map.on('click', layerId, (e) => {
          const f = e.features[0];
          const p = f.properties;
          const isProspect = p.source === 'prospect';
          const isConsultorio = p.business_type === 'consultorio';
          const typeLabel = isConsultorio ? 'CONSULTORIO' : 'FARMACIA';
          const badge = isProspect
            ? `<span class="font-bold" style="color:${p.color}">PROSPECTO · ${typeLabel} · TIER ${p.tier}</span>`
            : `<span class="font-bold" style="color:${p.color}">PADRÓN MARZAM · ${typeLabel} · PARETO ${p.pareto}</span>`;

          // Confianza de ubicación (sólo para clientes Marzam con
          // geocoded_relevance presente — el dot fue geocodificado, no
          // validado en campo).
          const geo = Number(p.geocoded_relevance);
          const geoBlock = (!isProspect && Number.isFinite(geo) && geo > 0)
            ? renderScoreBar({
              label: 'Confianza de ubicación',
              valuePct: Math.round(geo * 100),
              tone: 'warn',
              note: 'Geocodeada desde dirección — no validada en campo',
            })
            : '';

          // Potencial de venta (final_score, 0..100).  Tanto padrón como
          // prospectos lo tienen — viene de BlackPrint.
          const fs = Number(p.final_score);
          const scoreBlock = Number.isFinite(fs) && fs > 0
            ? renderScoreBar({
              label: 'Potencial de venta',
              valuePct: Math.round(Math.max(0, Math.min(100, fs))),
              tone: 'good',
            })
            : '';

          const html = `
            <div class="text-xs leading-tight" style="min-width:240px">
              <div class="text-[10px] uppercase tracking-wider mb-1">${badge}</div>
              <div class="text-sm font-bold text-slate-800 mb-1">${escapeHtml(p.name)}</div>
              ${p.address ? `<div class="text-[11px] text-slate-500">${escapeHtml(p.address)}</div>` : ''}
              ${p.chain ? `<div class="text-[10px] text-slate-400 mt-1">Cadena: ${escapeHtml(p.chain)}</div>` : ''}
              ${(geoBlock || scoreBlock) ? `<div class="mt-2 pt-2 border-t border-slate-200 space-y-2">${geoBlock}${scoreBlock}</div>` : ''}
              ${isProspect ? `
                <div class="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-slate-200">
                  ${p.order_potential ? `<div><div class="text-[9px] text-slate-400 uppercase font-bold">Pedido est.</div><div class="text-xs font-bold text-slate-700">$${Number(p.order_potential).toLocaleString()}</div></div>` : ''}
                  ${p.distance_to_nearest_marzam_m ? `<div><div class="text-[9px] text-slate-400 uppercase font-bold">A Marzam +cercano</div><div class="text-xs font-bold text-slate-700">${p.distance_to_nearest_marzam_m}m</div></div>` : ''}
                  <div><div class="text-[9px] text-slate-400 uppercase font-bold">Tier estimado</div><div class="text-xs font-bold" style="color:${p.color}">${p.tier}</div></div>
                </div>
              ` : ''}
            </div>
          `;
          new maplibregl.Popup({ offset: 12, closeButton: true })
            .setLngLat(f.geometry.coordinates)
            .setHTML(html)
            .addTo(map);
        });
        map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
      });
    };
    if (map.loaded()) apply(); else map.once('load', apply);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Tiny inline progress bar for popup metrics.  `tone` selects palette:
   *   'warn' (amber) for geocoded-not-validated.
   *   'good' (emerald) for sales potential.
   * `note` renders a sub-line below the label — used to spell out the
   * geocoded caveat so reps don't trust the dot blindly.
   */
  function renderScoreBar({ label, valuePct, tone = 'good', note = '' }) {
    const pct = Math.max(0, Math.min(100, valuePct));
    const palette = tone === 'warn'
      ? { fill: '#f59e0b', track: '#fef3c7', text: '#92400e' }
      : { fill: '#10b981', track: '#d1fae5', text: '#065f46' };
    return `
      <div>
        <div class="flex items-center justify-between mb-1">
          <span class="text-[9px] uppercase font-bold tracking-wider text-slate-500">${escapeHtml(label)}</span>
          <span class="text-[11px] font-bold tabular-nums" style="color:${palette.text}">${pct}%</span>
        </div>
        <div class="h-1.5 rounded-full overflow-hidden" style="background:${palette.track}">
          <div class="h-full rounded-full" style="background:${palette.fill}; width:${pct}%"></div>
        </div>
        ${note ? `<div class="text-[9px] text-amber-600 mt-1 italic">${escapeHtml(note)}</div>` : ''}
      </div>
    `;
  }

  function legendRow({ key, color, title, subtitle, countId, shape = 'circle' }) {
    const active = STATE.filters[key];
    // Two glyphs: filled circle for pharmacy, circle with white "+" for
    // consultorio.  Inline SVG keeps the legend self-contained — no font
    // or sprite dependencies.
    const swatch = shape === 'cross'
      ? `<span class="relative w-3 h-3 flex-shrink-0 inline-flex items-center justify-center">
           <span class="absolute inset-0 rounded-full ring-2 ring-white shadow" style="background:${color}"></span>
           <span class="relative text-white text-[8px] font-black leading-none">+</span>
         </span>`
      : `<span class="w-3 h-3 rounded-full ring-2 ring-white shadow flex-shrink-0" style="background:${color}"></span>`;
    return `
      <button type="button" data-filter-key="${key}"
        class="legend-row w-full flex items-center gap-2 py-1.5 px-1.5 rounded-lg text-left transition ${active ? '' : 'opacity-40'} hover:bg-slate-50">
        ${swatch}
        <span class="flex-1 min-w-0">
          <span class="block text-[11px] font-bold text-slate-800 leading-tight">${title}</span>
          ${subtitle ? `<span class="block text-[9px] text-slate-400 leading-tight">${subtitle}</span>` : ''}
        </span>
        <span class="ml-1 text-[10px] font-bold tabular-nums text-slate-500" id="${countId}">0</span>
        <svg class="w-3.5 h-3.5 ${active ? 'text-emerald-500' : 'text-slate-300'}" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
          ${active ? '<path d="M5 13l4 4L19 7"/>' : '<circle cx="12" cy="12" r="9"/>'}
        </svg>
      </button>
    `;
  }

  function renderLegend() {
    if (STATE.legendEl) STATE.legendEl.remove();
    const wrap = document.createElement('div');
    wrap.id = 'pharmacies-legend';
    wrap.className = 'fixed z-[55] bg-white/95 backdrop-blur-xl rounded-2xl shadow-xl border border-white/60 ring-1 ring-slate-200/50 p-3 text-xs '
      + 'md:bottom-4 md:right-4 md:w-[280px] md:max-h-[80vh] md:overflow-y-auto '
      + 'max-md:left-3 max-md:right-3 max-md:bottom-[88px] max-md:max-h-[60vh] max-md:overflow-y-auto';
    wrap.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <span class="text-[10px] font-black uppercase tracking-wider text-slate-700">Mapa de farmacias y consultorios</span>
        <button id="legend-collapse" class="text-slate-400 hover:text-slate-700 text-base leading-none w-5 h-5 flex items-center justify-center" title="Ocultar">−</button>
      </div>
      <div id="legend-body">
        <div class="text-[9px] uppercase font-bold tracking-wider text-rose-600 mb-1 mt-1">Padrón Marzam · Pareto</div>
        <div class="space-y-0.5 mb-1">
          ${legendRow({ key: 'padron_A', color: PARETO_COLORS.A, title: 'A · Crítico',    subtitle: 'Cuentas top de revenue',   countId: 'count-padron-A' })}
          ${legendRow({ key: 'padron_B', color: PARETO_COLORS.B, title: 'B · Medio',      subtitle: 'Cuentas intermedias',     countId: 'count-padron-B' })}
          ${legendRow({ key: 'padron_C', color: PARETO_COLORS.C, title: 'C · Largo tail', subtitle: 'Cuentas chicas',          countId: 'count-padron-C' })}
        </div>
        <div class="text-[9px] italic text-amber-600 mb-2 leading-tight">
          ⚠ Ubicaciones geocodeadas desde la dirección. Marzam aún no nos pasa lat/lng reales.
        </div>

        <div class="text-[9px] uppercase font-bold tracking-wider text-slate-600 mb-1 mt-2 pt-2 border-t border-slate-200">Prospectos · Tier estimado</div>

        <div class="text-[9px] uppercase font-semibold tracking-wider text-slate-500 mb-1 mt-1">Farmacias</div>
        <div class="space-y-0.5">
          ${legendRow({ key: 'prosp_farm_A', color: PROSPECT_TIER_COLORS.A, title: 'A · Alto potencial',  subtitle: 'quadrant Q1', countId: 'count-prosp-farm-A' })}
          ${legendRow({ key: 'prosp_farm_B', color: PROSPECT_TIER_COLORS.B, title: 'B · Potencial medio', subtitle: 'quadrant Q2', countId: 'count-prosp-farm-B' })}
          ${legendRow({ key: 'prosp_farm_C', color: PROSPECT_TIER_COLORS.C, title: 'C · Potencial bajo',  subtitle: 'quadrant Q3', countId: 'count-prosp-farm-C' })}
          ${legendRow({ key: 'prosp_farm_D', color: PROSPECT_TIER_COLORS.D, title: 'D · Descartable',     subtitle: 'quadrant Q4', countId: 'count-prosp-farm-D' })}
        </div>

        <div class="text-[9px] uppercase font-semibold tracking-wider text-slate-500 mb-1 mt-3">Consultorios</div>
        <div class="space-y-0.5">
          ${legendRow({ key: 'prosp_cons_A', color: PROSPECT_TIER_COLORS.A, title: 'A · Alto potencial',  subtitle: 'quadrant Q1', countId: 'count-prosp-cons-A', shape: 'cross' })}
          ${legendRow({ key: 'prosp_cons_B', color: PROSPECT_TIER_COLORS.B, title: 'B · Potencial medio', subtitle: 'quadrant Q2', countId: 'count-prosp-cons-B', shape: 'cross' })}
          ${legendRow({ key: 'prosp_cons_C', color: PROSPECT_TIER_COLORS.C, title: 'C · Potencial bajo',  subtitle: 'quadrant Q3', countId: 'count-prosp-cons-C', shape: 'cross' })}
          ${legendRow({ key: 'prosp_cons_D', color: PROSPECT_TIER_COLORS.D, title: 'D · Descartable',     subtitle: 'quadrant Q4', countId: 'count-prosp-cons-D', shape: 'cross' })}
        </div>

        <div class="flex items-center justify-between gap-2 mt-3 pt-2 border-t border-slate-200">
          <button id="legend-all" class="flex-1 text-[10px] font-bold text-slate-600 bg-slate-50 hover:bg-slate-100 py-1 rounded-lg transition">Todos</button>
          <button id="legend-none" class="flex-1 text-[10px] font-bold text-slate-600 bg-slate-50 hover:bg-slate-100 py-1 rounded-lg transition">Ninguno</button>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
    STATE.legendEl = wrap;

    wrap.querySelectorAll('[data-filter-key]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.filterKey;
        STATE.filters[k] = !STATE.filters[k];
        rerenderLegendBody();
        repaint();
      });
    });
    wrap.querySelector('#legend-all').addEventListener('click', () => {
      Object.keys(STATE.filters).forEach((k) => { STATE.filters[k] = true; });
      rerenderLegendBody();
      repaint();
    });
    wrap.querySelector('#legend-none').addEventListener('click', () => {
      Object.keys(STATE.filters).forEach((k) => { STATE.filters[k] = false; });
      rerenderLegendBody();
      repaint();
    });
    wrap.querySelector('#legend-collapse').addEventListener('click', () => {
      const body = wrap.querySelector('#legend-body');
      body.classList.toggle('hidden');
    });
  }

  function rerenderLegendBody() {
    if (!STATE.legendEl) return;
    STATE.legendEl.querySelectorAll('[data-filter-key]').forEach((btn) => {
      const active = STATE.filters[btn.dataset.filterKey];
      btn.classList.toggle('opacity-40', !active);
      const checkSvg = btn.querySelector('svg');
      if (checkSvg) {
        checkSvg.classList.toggle('text-emerald-500', active);
        checkSvg.classList.toggle('text-slate-300', !active);
        checkSvg.innerHTML = active ? '<path d="M5 13l4 4L19 7"/>' : '<circle cx="12" cy="12" r="9"/>';
      }
    });
  }

  function updateCounts(padron, prospects) {
    if (!STATE.legendEl) return;
    const counts = {
      'padron-A': 0, 'padron-B': 0, 'padron-C': 0,
      'prosp-farm-A': 0, 'prosp-farm-B': 0, 'prosp-farm-C': 0, 'prosp-farm-D': 0,
      'prosp-cons-A': 0, 'prosp-cons-B': 0, 'prosp-cons-C': 0, 'prosp-cons-D': 0,
    };
    padron.forEach((p) => {
      const k = `padron-${p.pareto}`;
      if (counts[k] != null) counts[k] += 1;
    });
    prospects.forEach((p) => {
      const t = prospectTier(p);
      const bt = businessTypeOf(p);
      const k = bt === 'consultorio' ? `prosp-cons-${t}` : `prosp-farm-${t}`;
      if (counts[k] != null) counts[k] += 1;
    });
    const setText = (sel, n) => {
      const el = STATE.legendEl.querySelector(sel);
      if (el) el.textContent = String(n);
    };
    Object.entries(counts).forEach(([k, n]) => setText(`#count-${k}`, n));
  }

  function repaint() {
    const user = getCurrentUser();
    const { padron, prospects } = pharmaciesVisibleToUser(user);
    const filtered = applyFilters(padron, prospects);
    paint(filtered.padron, filtered.prospects);
    updateCounts(padron, prospects);
  }

  function render() {
    STATE.visible = true;
    if (!STATE.legendEl) renderLegend();
    repaint();
  }

  function hide() {
    STATE.visible = false;
    clearLayer('marzam-pharmacies');
    if (STATE.legendEl) { STATE.legendEl.remove(); STATE.legendEl = null; }
  }

  function toggle() {
    if (STATE.visible) hide(); else render();
  }

  window.addEventListener('demoHierarchyEnriched', () => {
    if (STATE.visible) repaint();
  });

  window.MarzamPharmaciesMap = {
    render,
    hide,
    toggle,
    repaint,
    state: STATE,
  };
})();
