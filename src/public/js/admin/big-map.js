/**
 * Big Map for admin cockpit.
 *
 * Layers (toggleable, mutually visible):
 *   - pharmacies : every Marzam client + prospect (default ON)
 *   - coverage   : poblacion-level cobertura bubbles (default ON)
 *   - pareto     : Pareto density heat (off by default)
 *   - live       : real-time rep positions via SSE (off by default)
 *   - untouched  : Pareto-A pharmacies sin visita reciente (off by default)
 *
 * The map carries an inline legend (top-left) that updates with the
 * currently active layers — only relevant swatches are shown so the
 * panel never feels crowded.
 */
(function () {
  const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
  const ECATEPEC_CENTER = [-99.060, 19.605];

  const PARETO_COLOR = { A: '#dc2626', B: '#f59e0b', C: '#2563eb' };
  const PROSPECT_TIER_COLOR = { A: '#f87171', B: '#fbbf24', C: '#94a3b8', D: '#64748b' };
  const COVERAGE_RAMP = [
    { pct: 0, color: '#fee2e2', label: '0%' },
    { pct: 25, color: '#fecaca', label: '25%' },
    { pct: 50, color: '#fde68a', label: '50%' },
    { pct: 75, color: '#bbf7d0', label: '75%' },
    { pct: 100, color: '#15803d', label: '100%' },
  ];

  let map = null;
  // Default: pharmacies + coverage. The user explicitly asked that
  // managers/admin see pharmacies from the start — coverage stays as the
  // hero overlay.
  let activeLayers = new Set(['pharmacies', 'coverage']);
  let liveSource = null;
  const liveStore = new Map();
  let lastCoverage = null;
  let pharmaciesLoaded = false;
  let pharmaciesLoading = null;
  let pharmaciesCount = 0;
  let legendEl = null;

  function init(containerId) {
    map = new maplibregl.Map({
      container: containerId,
      style: MAP_STYLE,
      center: ECATEPEC_CENTER,
      zoom: 11.5,
      attributionControl: false,
      cooperativeGestures: false,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      // Order matters: pharmacies (small dots) below coverage (large
      // bubbles) so labels stay readable; live + untouched on top.
      addPharmaciesLayer();
      addCoverageLayer();
      addParetoLayer();
      addUntouchedLayer();
      addLiveLayer();
      refreshVisibility();
      // Auto-load pharmacies for default ON state. Doesn't block boot.
      ensurePharmaciesLoaded().then(() => {
        refreshVisibility();
        renderLegend();
      });
      renderLegend();
      // Reflect the default activeLayers in the toolbar UI.
      syncToolbarToggles();
    });

    return map;
  }

  // ── Layers ──────────────────────────────────────────────────────────

  function addPharmaciesLayer() {
    map.addSource('pharmacies-all', { type: 'geojson', data: emptyFC() });

    // Outer colored circle — sized by pareto/tier.
    map.addLayer({
      id: 'pharmacies-all-point',
      type: 'circle',
      source: 'pharmacies-all',
      paint: {
        'circle-radius': [
          'match', ['get', 'kind'],
          'marzam', [
            'match', ['get', 'pareto'],
            'A', 7, 'B', 5.5, 'C', 4, 4,
          ],
          [
            'match', ['get', 'tier'],
            'A', 5, 'B', 4, 'C', 3.2, 'D', 2.8, 3,
          ],
        ],
        'circle-color': [
          'match', ['get', 'kind'],
          'marzam', [
            'match', ['get', 'pareto'],
            'A', PARETO_COLOR.A, 'B', PARETO_COLOR.B, 'C', PARETO_COLOR.C, '#64748b',
          ],
          [
            'match', ['get', 'tier'],
            'A', PROSPECT_TIER_COLOR.A,
            'B', PROSPECT_TIER_COLOR.B,
            'C', PROSPECT_TIER_COLOR.C,
            'D', PROSPECT_TIER_COLOR.D,
            PROSPECT_TIER_COLOR.D,
          ],
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
        'circle-opacity': 0.92,
      },
      layout: { visibility: activeLayers.has('pharmacies') ? 'visible' : 'none' },
    });

    // Inner ring overlay for consultorios — guarantees a visual distinction
    // without depending on the basemap font glyphs (the previous "+"
    // symbol layer silently dropped on glyph misses).
    map.addLayer({
      id: 'pharmacies-all-consultorio-ring',
      type: 'circle',
      source: 'pharmacies-all',
      filter: ['==', ['get', 'is_consultorio'], 1],
      paint: {
        'circle-radius': [
          'match', ['get', 'tier'],
          'A', 2, 'B', 1.6, 'C', 1.3, 'D', 1.1, 1.4,
        ],
        'circle-color': '#ffffff',
        'circle-stroke-width': 0.8,
        'circle-stroke-color': 'rgba(0,0,0,0.3)',
      },
      layout: { visibility: activeLayers.has('pharmacies') ? 'visible' : 'none' },
    });

    map.on('click', 'pharmacies-all-point', (e) => {
      const feat = e.features[0];
      const p = feat.properties;
      const isMarzam = p.kind === 'marzam';
      const typeLabel = String(p.is_consultorio) === '1' ? 'CONSULTORIO' : 'FARMACIA';
      const swatch = isMarzam
        ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${PARETO_COLOR[p.pareto] || '#64748b'};margin-right:6px;vertical-align:middle"></span>`
        : `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${PROSPECT_TIER_COLOR[p.tier] || '#94a3b8'};margin-right:6px;vertical-align:middle"></span>`;
      const meta = isMarzam
        ? `Padrón Marzam · Pareto ${p.pareto || '—'} · ${typeLabel}`
        : `Prospecto · Tier ${p.tier || '—'} · ${typeLabel}`;
      new maplibregl.Popup({ offset: 12, closeButton: true })
        .setLngLat(feat.geometry.coordinates)
        .setHTML(`
          <div style="font-family:Inter,sans-serif;font-size:12px;padding:8px 4px 4px;min-width:220px">
            <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#525252;margin-bottom:6px">${swatch}${escapeHtml(meta)}</div>
            <div style="font-weight:600;color:#0a0a0a;margin-bottom:4px;font-size:13px">${escapeHtml(p.name || '—')}</div>
            ${p.address ? `<div style="color:#525252;font-size:11px;line-height:1.4">${escapeHtml(p.address)}</div>` : ''}
            ${p.municipality ? `<div style="color:#737373;font-size:10px;margin-top:4px">${escapeHtml(p.municipality)}${p.state ? ' · ' + escapeHtml(p.state) : ''}</div>` : ''}
          </div>
        `).addTo(map);
    });
    map.on('mouseenter', 'pharmacies-all-point', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'pharmacies-all-point', () => { map.getCanvas().style.cursor = ''; });
  }

  function addCoverageLayer() {
    map.addSource('coverage-bubbles', { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'coverage-bubbles',
      type: 'circle',
      source: 'coverage-bubbles',
      paint: {
        'circle-radius': [
          'interpolate', ['linear'], ['get', 'total'],
          0, 8, 50, 14, 200, 24, 800, 38, 2000, 56,
        ],
        'circle-color': [
          'interpolate', ['linear'], ['get', 'pct'],
          0, COVERAGE_RAMP[0].color,
          25, COVERAGE_RAMP[1].color,
          50, COVERAGE_RAMP[2].color,
          75, COVERAGE_RAMP[3].color,
          100, COVERAGE_RAMP[4].color,
        ],
        'circle-stroke-color': '#0a0a0a',
        'circle-stroke-width': 1,
        'circle-opacity': 0.78,
      },
      layout: { visibility: activeLayers.has('coverage') ? 'visible' : 'none' },
    });
    map.addLayer({
      id: 'coverage-labels',
      type: 'symbol',
      source: 'coverage-bubbles',
      layout: {
        'text-field': ['concat', ['to-string', ['round', ['get', 'pct']]], '%'],
        'text-size': 11,
        'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
        'text-allow-overlap': false,
        visibility: activeLayers.has('coverage') ? 'visible' : 'none',
      },
      paint: {
        'text-color': '#0a0a0a',
        'text-halo-color': 'rgba(255,255,255,0.92)',
        'text-halo-width': 1.6,
      },
    });

    map.on('click', 'coverage-bubbles', (e) => {
      const f = e.features[0];
      const p = f.properties;
      new maplibregl.Popup({ offset: 12, closeButton: false })
        .setLngLat(e.lngLat)
        .setHTML(`
          <div style="font-family:Inter,sans-serif;font-size:12px;padding:8px 4px 4px;min-width:200px">
            <div style="font-weight:600;color:#0a0a0a;margin-bottom:6px;font-size:13px">${escapeHtml(p.name || '—')}</div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;color:#525252">
              <span>Padrón:</span><strong style="color:#0a0a0a;text-align:right">${p.total}</strong>
              <span>Visitadas:</span><strong style="color:#0a0a0a;text-align:right">${p.visited}</strong>
              <span>Cobertura:</span><strong style="color:#15803d;text-align:right">${p.pct}%</strong>
            </div>
          </div>
        `).addTo(map);
    });
    map.on('mouseenter', 'coverage-bubbles', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'coverage-bubbles', () => { map.getCanvas().style.cursor = ''; });
  }

  function addParetoLayer() {
    map.addSource('pareto-heat', { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'pareto-heat',
      type: 'circle',
      source: 'pareto-heat',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'weight'], 0, 6, 1, 26],
        'circle-color': [
          'match', ['get', 'pareto'],
          'A', PARETO_COLOR.A,
          'B', PARETO_COLOR.B,
          'C', PARETO_COLOR.C,
          '#737373',
        ],
        'circle-opacity': 0.5,
        'circle-blur': 0.5,
      },
      layout: { visibility: activeLayers.has('pareto') ? 'visible' : 'none' },
    });
  }

  function addLiveLayer() {
    map.addSource('live-reps', { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'live-reps-point',
      type: 'circle',
      source: 'live-reps',
      paint: {
        'circle-radius': 9,
        'circle-color': [
          'match', ['get', 'status'],
          'live', '#16a34a',
          'idle', '#d97706',
          '#737373',
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
      },
      layout: { visibility: activeLayers.has('live') ? 'visible' : 'none' },
    });
    map.addLayer({
      id: 'live-reps-label',
      type: 'symbol',
      source: 'live-reps',
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 10,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        visibility: activeLayers.has('live') ? 'visible' : 'none',
      },
      paint: {
        'text-color': '#0a0a0a',
        'text-halo-color': 'rgba(255,255,255,0.92)',
        'text-halo-width': 1.6,
      },
    });
  }

  function addUntouchedLayer() {
    map.addSource('untouched', { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'untouched-point',
      type: 'circle',
      source: 'untouched',
      paint: {
        'circle-radius': 6,
        'circle-color': '#ef4444',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-opacity': 0.85,
      },
      layout: { visibility: activeLayers.has('untouched') ? 'visible' : 'none' },
    });
    map.on('click', 'untouched-point', (e) => {
      const f = e.features[0];
      const p = f.properties;
      new maplibregl.Popup({ offset: 12, closeButton: true })
        .setLngLat(e.lngLat)
        .setHTML(`
          <div style="font-family:Inter,sans-serif;font-size:12px;padding:8px 4px 4px;min-width:180px">
            <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#b91c1c;margin-bottom:4px">Sin tocar · Pareto ${p.pareto || '—'}</div>
            <div style="font-weight:600;color:#0a0a0a;font-size:13px">${escapeHtml(p.name)}</div>
            ${p.cpadre ? `<div style="color:#737373;font-size:10px;margin-top:4px;font-family:JetBrains Mono,monospace">${escapeHtml(p.cpadre)}</div>` : ''}
          </div>
        `).addTo(map);
    });
    map.on('mouseenter', 'untouched-point', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'untouched-point', () => { map.getCanvas().style.cursor = ''; });
  }

  // ── Data setters ────────────────────────────────────────────────────

  function setCoverageData(features) {
    lastCoverage = features;
    if (!map || !map.getSource('coverage-bubbles')) return;
    const fc = {
      type: 'FeatureCollection',
      features: (features || [])
        .filter((f) => f.lat != null && f.lng != null)
        .map((f) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
          properties: { name: f.name, total: f.total, visited: f.visited, pct: f.pct },
        })),
    };
    map.getSource('coverage-bubbles').setData(fc);

    const paretoFeatures = [];
    (features || []).forEach((f) => {
      if (f.lat == null || f.lng == null) return;
      const total = (f.pareto?.A || 0) + (f.pareto?.B || 0) + (f.pareto?.C || 0);
      if (!total) return;
      ['A', 'B', 'C'].forEach((p) => {
        const weight = (f.pareto?.[p] || 0) / total;
        if (weight > 0) {
          paretoFeatures.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [f.lng, f.lat] },
            properties: { pareto: p, weight },
          });
        }
      });
    });
    if (map.getSource('pareto-heat')) {
      map.getSource('pareto-heat').setData({ type: 'FeatureCollection', features: paretoFeatures });
    }

    // Only fit bounds on first load — refits on every refresh feel jarring
    // when admins are panning around. Frame rebound respects pharmacies if
    // coverage is sparse.
    if (!fc.features.length && pharmaciesCount > 0) {
      // fit to pharmacies happens in pharmacies setter
      return;
    }
    if (fc.features.length) {
      const bounds = new maplibregl.LngLatBounds();
      fc.features.forEach((feat) => bounds.extend(feat.geometry.coordinates));
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 60, maxZoom: 13, duration: 600 });
    }
    renderLegend();
  }

  function setUntouchedData(items) {
    if (!map || !map.getSource('untouched')) return;
    const fc = {
      type: 'FeatureCollection',
      features: (items || [])
        .filter((it) => it.lat != null && it.lng != null)
        .map((it) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [Number(it.lng), Number(it.lat)] },
          properties: {
            name: it.farmacia_nombre || it.name || '—',
            cpadre: it.cpadre,
            pareto: it.pareto,
          },
        })),
    };
    map.getSource('untouched').setData(fc);
    renderLegend();
  }

  // ── Pharmacies (lazy fetch) ─────────────────────────────────────────

  async function ensurePharmaciesLoaded() {
    if (pharmaciesLoaded) return;
    if (pharmaciesLoading) return pharmaciesLoading;
    const token = window.__ADMIN_TOKEN__ || localStorage.getItem('token');
    if (!token) return;

    pharmaciesLoading = (async () => {
      try {
        const res = await fetch('/api/marzam/universe?limit=20000', {
          headers: { Authorization: 'Bearer ' + token },
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const features = [];
        for (const m of data.marzam || []) {
          if (m.lat == null || m.lng == null) continue;
          const isCons = m.business_type === 'consultorio' ? 1 : 0;
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [Number(m.lng), Number(m.lat)] },
            properties: {
              kind: 'marzam',
              name: m.name || '—',
              pareto: m.pareto || 'C',
              tier: null,
              is_consultorio: isCons,
              address: m.address || '',
              municipality: m.municipality || '',
              state: m.state || '',
            },
          });
        }
        for (const p of data.prospects || []) {
          if (p.lat == null || p.lng == null) continue;
          const t = (p.quadrant || '').toUpperCase();
          const tier = t === 'Q1' ? 'A' : t === 'Q2' ? 'B' : t === 'Q3' ? 'C' : t === 'Q4' ? 'D'
            : (p.pareto || 'D');
          const isCons = p.business_type === 'consultorio' ? 1 : 0;
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [Number(p.lng), Number(p.lat)] },
            properties: {
              kind: 'prospect',
              name: p.name || '—',
              tier,
              pareto: null,
              is_consultorio: isCons,
              address: p.address || '',
              municipality: p.municipality || '',
              state: p.state || '',
            },
          });
        }
        if (map && map.getSource('pharmacies-all')) {
          map.getSource('pharmacies-all').setData({ type: 'FeatureCollection', features });
        }
        pharmaciesCount = features.length;
        pharmaciesLoaded = true;
        renderLegend();
      } catch (err) {
        console.warn('[admin/big-map] pharmacies fetch failed', err);
      } finally {
        pharmaciesLoading = null;
      }
    })();
    return pharmaciesLoading;
  }

  // ── Layer toggling + visibility ─────────────────────────────────────

  function setLayerActive(name, active) {
    if (active) activeLayers.add(name); else activeLayers.delete(name);
    if (active && name === 'live') startLiveStream();
    if (!active && name === 'live') stopLiveStream();
    if (active && name === 'pharmacies') {
      ensurePharmaciesLoaded().then(() => {
        refreshVisibility();
        renderLegend();
      });
    }
    refreshVisibility();
    renderLegend();
  }

  function refreshVisibility() {
    if (!map || !map.isStyleLoaded || !map.isStyleLoaded()) {
      if (map) map.once('idle', refreshVisibility);
      return;
    }
    const setVis = (id, on) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    };
    setVis('coverage-bubbles', activeLayers.has('coverage'));
    setVis('coverage-labels', activeLayers.has('coverage'));
    setVis('pareto-heat', activeLayers.has('pareto'));
    setVis('live-reps-point', activeLayers.has('live'));
    setVis('live-reps-label', activeLayers.has('live'));
    setVis('untouched-point', activeLayers.has('untouched'));
    setVis('pharmacies-all-point', activeLayers.has('pharmacies'));
    setVis('pharmacies-all-consultorio-ring', activeLayers.has('pharmacies'));
  }

  function syncToolbarToggles() {
    document.querySelectorAll('.layer-toggle[data-layer]').forEach((btn) => {
      const isOn = activeLayers.has(btn.dataset.layer);
      btn.setAttribute('data-active', String(isOn));
    });
  }

  // ── Inline color legend ─────────────────────────────────────────────
  // The legend lives inside the map card (top-left) and only shows
  // swatches for layers that are currently visible. This prevents the
  // panel from being permanently crowded.

  function legendBlock(title, items) {
    return `
      <div class="legend-block">
        <div class="legend-block-title">${title}</div>
        <div class="legend-block-rows">
          ${items.map((it) => `
            <div class="legend-row">
              <span class="legend-swatch" style="${it.swatchStyle}"></span>
              <span class="legend-label">${escapeHtml(it.label)}</span>
              ${it.value != null ? `<span class="legend-value">${escapeHtml(String(it.value))}</span>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderLegend() {
    if (!map) return;
    if (!legendEl) {
      legendEl = document.createElement('div');
      legendEl.className = 'big-map-legend';
      const container = map.getContainer();
      container.style.position = container.style.position || 'relative';
      container.appendChild(legendEl);
    }

    const blocks = [];
    if (activeLayers.has('pharmacies')) {
      blocks.push(legendBlock('Padrón Marzam', [
        { swatchStyle: `background:${PARETO_COLOR.A}`, label: 'Pareto A · Crítico' },
        { swatchStyle: `background:${PARETO_COLOR.B}`, label: 'Pareto B · Medio' },
        { swatchStyle: `background:${PARETO_COLOR.C}`, label: 'Pareto C · Long-tail' },
      ]));
      blocks.push(legendBlock('Prospectos', [
        { swatchStyle: `background:${PROSPECT_TIER_COLOR.A}`, label: 'A · Alto potencial' },
        { swatchStyle: `background:${PROSPECT_TIER_COLOR.B}`, label: 'B · Potencial medio' },
        { swatchStyle: `background:${PROSPECT_TIER_COLOR.C}`, label: 'C · Bajo' },
        { swatchStyle: `background:${PROSPECT_TIER_COLOR.D}`, label: 'D · Descartable' },
      ]));
      blocks.push(`
        <div class="legend-block legend-block-note">
          <span class="legend-swatch" style="background:#94a3b8;position:relative">
            <span style="position:absolute;inset:35%;background:#ffffff;border-radius:50%;border:0.5px solid rgba(0,0,0,0.3)"></span>
          </span>
          <span class="legend-label">Anillo blanco = consultorio</span>
        </div>
      `);
    }
    if (activeLayers.has('coverage')) {
      const ramp = COVERAGE_RAMP.map((s) => ({
        swatchStyle: `background:${s.color}`,
        label: s.label,
      }));
      blocks.push(legendBlock('Cobertura padrón', ramp));
    }
    if (activeLayers.has('pareto')) {
      blocks.push(legendBlock('Pareto density', [
        { swatchStyle: `background:${PARETO_COLOR.A};opacity:0.55`, label: 'Pareto A' },
        { swatchStyle: `background:${PARETO_COLOR.B};opacity:0.55`, label: 'Pareto B' },
        { swatchStyle: `background:${PARETO_COLOR.C};opacity:0.55`, label: 'Pareto C' },
      ]));
    }
    if (activeLayers.has('live')) {
      blocks.push(legendBlock('Reps en vivo', [
        { swatchStyle: 'background:#16a34a', label: 'En visita (<5 min)' },
        { swatchStyle: 'background:#d97706', label: 'Inactivo (5-25 min)' },
        { swatchStyle: 'background:#737373', label: 'Offline' },
      ]));
    }
    if (activeLayers.has('untouched')) {
      blocks.push(legendBlock('Sin tocar', [
        { swatchStyle: 'background:#ef4444', label: 'Pareto A sin visita reciente' },
      ]));
    }

    if (!blocks.length) {
      legendEl.innerHTML = '';
      legendEl.style.display = 'none';
      return;
    }
    legendEl.style.display = '';
    legendEl.innerHTML = `
      <div class="big-map-legend-header">
        <span class="big-map-legend-title">Capas activas</span>
        <button class="big-map-legend-collapse" type="button" aria-label="Ocultar leyenda">−</button>
      </div>
      <div class="big-map-legend-body">
        ${blocks.join('')}
      </div>
    `;

    const collapseBtn = legendEl.querySelector('.big-map-legend-collapse');
    const body = legendEl.querySelector('.big-map-legend-body');
    if (collapseBtn && body) {
      collapseBtn.addEventListener('click', () => {
        const isHidden = body.style.display === 'none';
        body.style.display = isHidden ? '' : 'none';
        collapseBtn.textContent = isHidden ? '−' : '+';
      });
    }
  }

  // ── Live SSE ────────────────────────────────────────────────────────

  function startLiveStream() {
    if (liveSource) return;
    const token = window.__ADMIN_TOKEN__;
    if (!token) return;
    try {
      liveSource = new EventSource(`/api/live/stream?token=${encodeURIComponent(token)}`);
      liveSource.addEventListener('position', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data || data.lat == null || data.lng == null) return;
          liveStore.set(data.rep_id || data.user_id, { ...data, updated: Date.now() });
          renderLiveReps();
        } catch (_) { /* ignore */ }
      });
      liveSource.onerror = () => {
        try { liveSource.close(); } catch (_) { /* ignore */ }
        liveSource = null;
      };
    } catch (e) {
      console.warn('[admin/big-map] live stream failed', e);
    }
  }

  function stopLiveStream() {
    if (liveSource) try { liveSource.close(); } catch (_) { /* ignore */ }
    liveSource = null;
  }

  function renderLiveReps() {
    if (!map || !map.getSource('live-reps')) return;
    const now = Date.now();
    const features = [];
    for (const [id, rep] of liveStore.entries()) {
      const ageMin = (now - rep.updated) / 60000;
      const status = ageMin < 5 ? 'live' : ageMin < 25 ? 'idle' : 'offline';
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(rep.lng), Number(rep.lat)] },
        properties: { rep_id: id, name: rep.name || rep.full_name || '—', status },
      });
    }
    map.getSource('live-reps').setData({ type: 'FeatureCollection', features });
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  window.AdminBigMap = {
    init,
    setCoverageData,
    setUntouchedData,
    setLayerActive,
    isActive: (name) => activeLayers.has(name),
    getMap: () => map,
  };
})();
