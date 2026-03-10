/* =================================================================
   Manager — Full PRD Map-Centric Controller
   ================================================================= */

let map;
let currentTab = 'pharmacies';
let drawingPolygon = false;
let polygonPoints = [];
let selectedInPolygon = [];
let pharmacyCache = [];
let bulkSelectedIds = new Set();
let pendingOverlapAction = null;
let reviewSelectedIds = new Set();
let clickSelectMode = false;
let clickSelectedPharmacies = [];
let repMotionFrame = null;
let repRouteCache = new Map();
let repPollingTimer = null;
const REP_POLLING_INTERVAL_MS = 30000;
let authUsers = [];

document.addEventListener('DOMContentLoaded', async () => {
  const isDemo = localStorage.getItem('marzam_demo') === '1';
  const user = API.user();
  if (!isDemo && (!API.isAuth() || user?.role !== 'manager')) { location.href = '/'; return; }

  if (isDemo) await DEMO.ready;
  if (!isDemo) await loadAuthUsers();

  const impersonating = user?.impersonated_by || localStorage.getItem('marzam_impersonating');
  document.getElementById('user-label').textContent = (user?.full_name || 'Gerente Demo') + (isDemo ? ' (Demo)' : '');

  if (isDemo) {
    DEMO.patchAPI();
    document.getElementById('demo-banner').classList.remove('hidden');
    document.getElementById('top-bar').classList.add('top-10');
  }

  if (impersonating) {
    const banner = document.getElementById('demo-banner');
    banner.textContent = `Viendo como: ${user?.full_name || 'Desconocido'} (${user?.role}) — Haz clic para volver`;
    banner.classList.remove('hidden');
    banner.style.cursor = 'pointer';
    banner.onclick = () => stopImpersonation();
    document.getElementById('top-bar').classList.add('top-10');
  }

  document.getElementById('btn-logout').onclick = isDemo
    ? () => { localStorage.clear(); location.href = '/'; }
    : API.logout;

  initMap();
  setupTabs();
  setupPanelDrag();
  setupFilters();
  loadKPIs();
  loadReviewBadge();
  populateFilterOptions();
  initCustomSelects();
  setDefaultWaveControls();
});

async function loadAuthUsers() {
  try {
    authUsers = await API.get('/auth/users');
  } catch {
    authUsers = [];
  }
}

function setDefaultWaveControls() {
  const waveIdInput = document.getElementById('wave-id');
  const dueDateInput = document.getElementById('wave-due-date');
  if (waveIdInput && !waveIdInput.value) {
    waveIdInput.value = `ecatepec-wave-${new Date().toISOString().slice(0, 10)}`;
  }
  if (dueDateInput && !dueDateInput.value) {
    const due = new Date();
    due.setDate(due.getDate() + 7);
    dueDateInput.value = due.toISOString().slice(0, 10);
  }
}

function initCustomSelects() {
  document.querySelectorAll('select.custom-select-raw').forEach(select => {
    const wrapper = document.createElement('div');
    wrapper.className = 'relative inline-block';
    
    const btn = document.createElement('button');
    btn.className = 'flex items-center justify-between gap-2 min-w-[130px] bg-white border border-slate-200/80 text-xs font-semibold text-slate-700 rounded-xl px-3 py-2 outline-none shadow-sm transition-all hover:bg-slate-50 focus:ring-2 focus:ring-[#1b365d]/30 focus:border-[#1b365d]';
    
    const textSpan = document.createElement('span');
    textSpan.className = 'truncate max-w-[100px] text-left';
    textSpan.textContent = select.options[select.selectedIndex]?.text || '';
    
    const icon = document.createElement('div');
    icon.innerHTML = `<svg class="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l4-4 4 4m0 6l-4 4-4-4"></path></svg>`;
    
    btn.appendChild(textSpan);
    btn.appendChild(icon);
    
    const menu = document.createElement('div');
    menu.className = 'absolute z-[100] left-0 mt-2 w-full min-w-[180px] bg-white/95 backdrop-blur-xl border border-slate-100 rounded-xl shadow-2xl opacity-0 invisible translate-y-[-10px] transition-all duration-300 ease-spring overflow-hidden';
    
    const renderOptions = () => {
      menu.innerHTML = '';
      Array.from(select.options).forEach(opt => {
         const item = document.createElement('div');
         item.className = 'px-3 py-2.5 text-xs text-slate-700 hover:bg-[#1b365d]/5 hover:text-[#1b365d] cursor-pointer transition-colors flex items-center gap-2 ' + (opt.selected ? 'font-bold bg-slate-50 text-[#1b365d]' : 'font-medium');
         
         const check = opt.selected ? `<svg class="w-3.5 h-3.5 text-[#e5730a] flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>` : `<div class="w-3.5 h-3.5 flex-shrink-0"></div>`;
         
         item.innerHTML = `${check} <span class="truncate">${opt.text}</span>`;
         
         item.onclick = (e) => {
             e.stopPropagation();
             select.value = opt.value;
             textSpan.textContent = opt.text;
             select.dispatchEvent(new Event('change'));
             closeMenu();
             renderOptions();
         };
         menu.appendChild(item);
      });
    };
    renderOptions();
    
    const closeMenu = () => {
        menu.classList.add('opacity-0', 'invisible', 'translate-y-[-10px]');
        menu.classList.remove('opacity-100', 'visible', 'translate-y-0');
        btn.classList.remove('ring-2', 'ring-[#1b365d]/30', 'border-[#1b365d]');
    };
    
    btn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const isOpen = menu.classList.contains('opacity-100');
        document.querySelectorAll('.custom-select-wrapper .absolute').forEach(m => {
            m.classList.add('opacity-0', 'invisible', 'translate-y-[-10px]');
            m.classList.remove('opacity-100', 'visible', 'translate-y-0');
        });
        document.querySelectorAll('.custom-select-wrapper button').forEach(b => {
             b.classList.remove('ring-2', 'ring-[#1b365d]/30', 'border-[#1b365d]');
        });
        if (!isOpen) {
            menu.classList.remove('opacity-0', 'invisible', 'translate-y-[-10px]');
            menu.classList.add('opacity-100', 'visible', 'translate-y-0');
            btn.classList.add('ring-2', 'ring-[#1b365d]/30', 'border-[#1b365d]');
        } else {
            closeMenu();
        }
    };
    
    document.addEventListener('click', closeMenu);
    
    select.style.display = 'none';
    wrapper.classList.add('custom-select-wrapper');
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);
    wrapper.appendChild(btn);
    wrapper.appendChild(menu);
    
    const observer = new MutationObserver(() => {
       renderOptions();
       textSpan.textContent = select.options[select.selectedIndex]?.text || '';
    });
    observer.observe(select, { childList: true });
  });
}

function initMap() {
  map = new maplibregl.Map({ container: 'map', style: MAP_STYLE, center: CDMX_CENTER, zoom: 12 });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  map.on('load', () => {
    map.addSource('pharmacies', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'pharmacy-dots', type: 'circle', source: 'pharmacies', paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7, 18, 11],
      'circle-color': ['match', ['get', 'status'], 'active', '#2563eb', 'pending_review', '#f59e0b', 'closed', '#e11d48', '#94a3b8'],
      'circle-stroke-width': 2, 'circle-stroke-color': '#fff',
    }});

    map.addSource('assignment-polygons', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'assignment-fill', type: 'fill', source: 'assignment-polygons', paint: { 'fill-color': '#6366f1', 'fill-opacity': 0.1 } });
    map.addLayer({ id: 'assignment-outline', type: 'line', source: 'assignment-polygons', paint: { 'line-color': '#6366f1', 'line-width': 2, 'line-dasharray': [3, 2] } });

    map.addSource('draw-polygon', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw-polygon', paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.15 } });
    map.addLayer({ id: 'draw-line', type: 'line', source: 'draw-polygon', paint: { 'line-color': '#3b82f6', 'line-width': 2.5 } });

    map.addSource('selected', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'selected-dots', type: 'circle', source: 'selected', paint: { 'circle-radius': 9, 'circle-color': '#10b981', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });

    map.addSource('review-markers', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'review-dots', type: 'circle', source: 'review-markers', paint: { 'circle-radius': 8, 'circle-color': '#f59e0b', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' } });

    map.addSource('rep-positions', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'rep-dots', type: 'circle', source: 'rep-positions', paint: {
      'circle-radius': 9,
      'circle-color': ['coalesce', ['get', 'color'], '#e11d48'],
      'circle-stroke-width': 3,
      'circle-stroke-color': '#fff',
    }});
    map.addLayer({ id: 'rep-labels', type: 'symbol', source: 'rep-positions', layout: { 'text-field': ['get', 'name'], 'text-offset': [0, 1.8], 'text-size': 12, 'text-font': ['Open Sans Bold'] }, paint: { 'text-color': '#1e293b', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } });

    map.addSource('breadcrumbs', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'breadcrumb-line', type: 'line', source: 'breadcrumbs', paint: { 'line-color': '#f97316', 'line-width': 3, 'line-opacity': 0.8, 'line-dasharray': [2, 1] } });
    map.addLayer({ id: 'breadcrumb-dots', type: 'circle', source: 'breadcrumbs', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#f97316', 'circle-stroke-width': 1.5, 'circle-stroke-color': '#fff' } });

    map.addSource('rep-assignment-links', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'rep-assignment-links', type: 'line', source: 'rep-assignment-links', paint: {
      'line-color': ['coalesce', ['get', 'color'], '#2563eb'],
      'line-width': 1.5,
      'line-opacity': 0.4,
      'line-dasharray': [1, 1.6],
    }});

    map.addSource('rep-assignment-routes', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'rep-assignment-routes', type: 'line', source: 'rep-assignment-routes', paint: {
      'line-color': ['coalesce', ['get', 'color'], '#2563eb'],
      'line-width': 3,
      'line-opacity': 0.6,
      'line-dasharray': [2, 2],
    }});

    map.addSource('rep-motion', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'rep-motion-ring', type: 'circle', source: 'rep-motion', paint: {
      'circle-radius': 16,
      'circle-color': ['coalesce', ['get', 'color'], '#2563eb'],
      'circle-opacity': 0.16,
    }});
    map.addLayer({ id: 'rep-motion-dot', type: 'circle', source: 'rep-motion', paint: {
      'circle-radius': 6,
      'circle-color': ['coalesce', ['get', 'color'], '#2563eb'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    }});

    map.on('click', 'pharmacy-dots', onPharmacyClick);
    map.on('mouseenter', 'pharmacy-dots', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'pharmacy-dots', () => { if (!drawingPolygon && !clickSelectMode) map.getCanvas().style.cursor = ''; });
    map.on('click', 'review-dots', onReviewMarkerClick);
    map.on('mouseenter', 'review-dots', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'review-dots', () => map.getCanvas().style.cursor = '');

    ['review-dots','rep-dots','rep-labels','assignment-fill','assignment-outline','breadcrumb-line','breadcrumb-dots','rep-assignment-links','rep-assignment-routes','rep-motion-ring','rep-motion-dot'].forEach(l =>
      map.setLayoutProperty(l, 'visibility', 'none'));

    map.on('moveend', debounce(loadPharmaciesInView, 300));
    loadPharmaciesInView();
  });

  document.getElementById('search-input').addEventListener('input', debounce(loadPharmaciesInView, 400));
}

function setupTabs() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tabId = btn.dataset.tab;
      currentTab = tabId;
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      document.getElementById(`tab-${tabId}`).classList.remove('hidden');
      map.setLayoutProperty('review-dots', 'visibility', tabId === 'review' ? 'visible' : 'none');
      map.setLayoutProperty('rep-dots', 'visibility', tabId === 'reps' ? 'visible' : 'none');
      map.setLayoutProperty('rep-labels', 'visibility', tabId === 'reps' ? 'visible' : 'none');
      map.setLayoutProperty('breadcrumb-line', 'visibility', tabId === 'reps' ? 'visible' : 'none');
      map.setLayoutProperty('breadcrumb-dots', 'visibility', tabId === 'reps' ? 'visible' : 'none');
      map.setLayoutProperty('rep-assignment-links', 'visibility', tabId === 'reps' ? 'visible' : 'none');
      map.setLayoutProperty('rep-assignment-routes', 'visibility', tabId === 'reps' ? 'visible' : 'none');
      map.setLayoutProperty('rep-motion-ring', 'visibility', 'none');
      map.setLayoutProperty('rep-motion-dot', 'visibility', 'none');
      map.setLayoutProperty('assignment-fill', 'visibility', tabId === 'assignments' ? 'visible' : 'none');
      map.setLayoutProperty('assignment-outline', 'visibility', tabId === 'assignments' ? 'visible' : 'none');
      if (tabId !== 'reps') {
        stopRepMotionAnimation(true);
        stopRepPolling();
      }
      cancelAssign();
      if (tabId === 'assignments') { loadAssignmentPolygons(); loadAssignments(); }
      if (tabId === 'review') { loadReviewMarkers(); loadReviewList(); }
      if (tabId === 'reps') {
        loadRepSection();
        startRepPolling();
      }
      if (tabId === 'reporting') loadReporting();
      if (tabId === 'audit') loadAudit();
    });
  });
}

function startRepPolling() {
  stopRepPolling();
  repPollingTimer = setInterval(() => {
    if (currentTab === 'reps') loadRepSection();
  }, REP_POLLING_INTERVAL_MS);
}

function stopRepPolling() {
  if (repPollingTimer) clearInterval(repPollingTimer);
  repPollingTimer = null;
}

function setupPanelDrag() {
  const panel = document.getElementById('main-panel');
  const handle = document.getElementById('panel-handle');
  
  // Mobile states: 0 = collapsed (peek), 1 = normal, 2 = expanded (full)
  let state = 1; 
  let startY = 0;
  let currentTranslate = 0;
  let isDragging = false;
  let startTranslate = 0;
  
  // Calculate heights dynamically for responsiveness
  const getTranslateYForState = (s) => {
    // The panel's full height is set to calc(100vh - 90px) via Tailwind
    const panelHeight = panel.getBoundingClientRect().height;
    
    if (s === 0) {
      // Collapsed: Show only handle. The dock height + handle space is approx 110px from the bottom.
      // So translate down by full height minus what we want to keep visible.
      return panelHeight - 110; 
    }
    if (s === 1) {
      // Normal: show about 55vh, so we translate down by ~45vh.
      return window.innerHeight * 0.45; 
    }
    if (s === 2) {
      // Expanded: translate 0 to fill up to the search bar.
      return 0; 
    }
    return 0;
  };

  const applyState = (newState) => {
    state = newState;
    panel.style.transition = 'transform 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
    
    if (window.innerWidth < 768) {
      panel.classList.remove('max-md:translate-y-[45vh]'); // remove tailwind default
      panel.style.transform = `translateY(${getTranslateYForState(state)}px)`;
    } else {
      panel.style.transform = ''; // Clear on desktop so tailwind classes work
    }
  };

  const getEventY = (e) => e.touches ? e.touches[0].clientY : e.clientY;

  const onDragStart = (e) => {
    if (window.innerWidth >= 768) return; // Ignore on desktop
    startY = getEventY(e);
    isDragging = false;
    startTranslate = getTranslateYForState(state);
    panel.style.transition = 'none'; // Disable animation for 1:1 finger tracking
  };

  const onDragMove = (e) => {
    if (window.innerWidth >= 768 || startY === 0) return;
    
    const y = getEventY(e);
    const deltaY = y - startY;
    
    if (Math.abs(deltaY) > 5) {
      isDragging = true;
      e.preventDefault(); // Prevent pull-to-refresh or scrolling
    }

    if (isDragging) {
      currentTranslate = startTranslate + deltaY;
      
      // Top resistance (Rubber-banding when pulling too high)
      if (currentTranslate < 0) {
        currentTranslate = currentTranslate * 0.2;
      }
      
      // Bottom resistance (Rubber-banding when pulling too low)
      const maxTranslate = getTranslateYForState(0);
      if (currentTranslate > maxTranslate) {
        currentTranslate = maxTranslate + (currentTranslate - maxTranslate) * 0.2;
      }
      
      panel.style.transform = `translateY(${currentTranslate}px)`;
    }
  };

  const onDragEnd = (e) => {
    if (window.innerWidth >= 768 || startY === 0) return;
    startY = 0;
    
    if (!isDragging) {
      // It was just a tap/click
      applyState((state + 1) % 3);
      return;
    }

    const deltaY = currentTranslate - startTranslate;
    
    // Snap logic based on drag distance and direction
    if (deltaY < -40) {
      // Dragged up -> increase state (expand)
      applyState(Math.min(state + 1, 2));
    } else if (deltaY > 40) {
      // Dragged down -> decrease state (collapse)
      applyState(Math.max(state - 1, 0));
    } else {
      // Snap back to current state if drag wasn't far enough
      applyState(state);
    }
    
    setTimeout(() => isDragging = false, 50);
  };

  // Mouse events
  handle.addEventListener('mousedown', onDragStart);
  window.addEventListener('mousemove', onDragMove, { passive: false });
  window.addEventListener('mouseup', onDragEnd);
  
  // Touch events
  handle.addEventListener('touchstart', onDragStart, { passive: true });
  window.addEventListener('touchmove', onDragMove, { passive: false });
  window.addEventListener('touchend', onDragEnd);
  
  // Handle window resize to re-apply bounds dynamically
  window.addEventListener('resize', () => {
    if (window.innerWidth < 768) {
      applyState(state);
    } else {
      panel.style.transform = '';
    }
  });

  // Initial setup for mobile
  if (window.innerWidth < 768) {
    applyState(state);
  }
}

function setupFilters() {
  ['filter-status','filter-municipality','filter-outcome','filter-contact','filter-sort'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', loadPharmaciesInView);
  });
  document.getElementById('btn-export')?.addEventListener('click', () => exportData('csv'));
  document.getElementById('bulk-select-all')?.addEventListener('change', (e) => {
    if (e.target.checked) pharmacyCache.slice(0, 50).forEach(p => bulkSelectedIds.add(p.id));
    else bulkSelectedIds.clear();
    renderPharmacyList();
  });
}

function populateFilterOptions() {
  if (!DEMO.active) return;
  const munis = [...new Set(DEMO.STORE.pharmacies.map(p => p.municipality).filter(Boolean))].sort();
  const sel = document.getElementById('filter-municipality');
  munis.forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); });
}

/* ─── Pharmacies ────────────────────────────────────────────────── */
async function loadKPIs() {
  try {
    const data = await API.get('/reporting/dashboard');
    const f = data.funnel || {};
    const chips = [
      { label: 'Total Ubicaciones', value: f.total_pharmacies },
      { label: 'Visitadas', value: f.visited },
      { label: 'Interesados', value: f.interested },
      { label: 'Cobertura', value: f.coverage_pct, suffix: '%' },
    ];
    document.getElementById('kpi-grid').innerHTML = chips.map(c => `
      <div class="bg-white border border-slate-100 p-3 rounded-xl shadow-sm">
        <p class="text-[10px] text-slate-500 uppercase tracking-wide font-medium">${c.label}</p>
        <p class="text-xl font-bold text-slate-800 mt-0.5">${num(c.value)}${c.suffix || ''}</p>
      </div>`).join('');
  } catch {
    document.getElementById('kpi-grid').innerHTML = '<div class="text-slate-400 text-xs p-2">Error al cargar indicadores</div>';
  }
}

async function loadPharmaciesInView() {
  const status = document.getElementById('filter-status')?.value || '';
  const search = document.getElementById('search-input')?.value || '';
  const municipality = document.getElementById('filter-municipality')?.value || '';
  const outcome = document.getElementById('filter-outcome')?.value || '';
  const hasContact = document.getElementById('filter-contact')?.value || '';
  const sortBy = document.getElementById('filter-sort')?.value || 'name';

  try {
    let rows;
    if (DEMO.active) {
      const bounds = map?.getBounds?.();
      rows = DEMO.STORE.pharmacies.filter(p => {
        if (bounds && (p.lng < bounds.getWest() || p.lng > bounds.getEast() || p.lat < bounds.getSouth() || p.lat > bounds.getNorth())) return false;
        if (status && p.status !== status) return false;
        if (municipality && p.municipality !== municipality) return false;
        if (outcome && p.last_visit_outcome !== outcome) return false;
        if (hasContact === 'true' && !p.contact_phone && !p.contact_person) return false;
        if (hasContact === 'false' && (p.contact_phone || p.contact_person)) return false;
        if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !(p.municipality||'').toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      });
      rows.sort((a, b) => {
        if (sortBy === 'potential_score') return (b.potential_score||0) - (a.potential_score||0);
        if (sortBy === 'last_visited_at') return (b.last_visited_at||'').localeCompare(a.last_visited_at||'');
        return (a[sortBy]||'').toString().localeCompare((b[sortBy]||'').toString());
      });
    } else {
      const bounds = map.getBounds();
      const bbox = `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`;
      let qs = `?bbox=${bbox}&limit=500&sort_by=${sortBy}`;
      if (status) qs += `&status=${status}`;
      if (search) qs += `&search=${encodeURIComponent(search)}`;
      if (municipality) qs += `&municipality=${encodeURIComponent(municipality)}`;
      if (outcome) qs += `&visit_outcome=${outcome}`;
      if (hasContact) qs += `&has_contact=${hasContact}`;
      rows = await API.get(`/pharmacies${qs}`);
    }
    pharmacyCache = rows;
    
    const features = pharmacyCache.map(p => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [Number(p.lng), Number(p.lat)] },
      properties: { id: p.id, name: p.name, status: p.status }
    }));
    map.getSource('pharmacies')?.setData({ type: 'FeatureCollection', features });
    document.getElementById('pharmacy-count').textContent = `${pharmacyCache.length} encontradas`;
    renderPharmacyList();
  } catch (err) {
    console.error('Failed to load pharmacies:', err);
  }
}

function renderPharmacyList() {
  const btnBulk = document.getElementById('btn-bulk-assign');
  if (bulkSelectedIds.size > 0) {
    btnBulk.classList.remove('hidden');
    btnBulk.textContent = `Asignar ${bulkSelectedIds.size} seleccionadas`;
    btnBulk.onclick = () => bulkAssign();
  } else btnBulk.classList.add('hidden');

  document.getElementById('pharmacy-list').innerHTML = pharmacyCache.slice(0, 50).map(r => `
    <div class="p-3.5 bg-white border border-slate-200 rounded-xl shadow-sm hover:border-blue-400 hover:shadow-md transition cursor-pointer group flex items-start gap-3"
         onclick="openPharmacyDrawer('${r.id}'); map.flyTo({center:[${r.lng},${r.lat}],zoom:16,duration:800})">
      <input type="checkbox" class="bulk-cb mt-1 rounded border-slate-300" data-id="${r.id}" ${bulkSelectedIds.has(r.id)?'checked':''}
        onclick="event.stopPropagation(); toggleBulk('${r.id}', this.checked)">
      <div class="flex-1 min-w-0">
        <div class="flex justify-between items-start mb-1.5">
          <h4 class="font-semibold text-sm text-slate-800 group-hover:text-blue-600 transition-colors truncate">${esc(r.name)}</h4>
          <span class="badge ${badgeColor(r.status)} ml-2 flex-shrink-0">${r.status}</span>
        </div>
        <div class="flex justify-between items-center text-xs text-slate-500">
          <span>${esc(r.municipality || '')}</span>
          <div class="flex items-center gap-3">
            ${r.last_visit_outcome ? `<span class="badge ${badgeColor(r.last_visit_outcome)}">${r.last_visit_outcome}</span>` : ''}
            <span>Pot.: ${r.potential_score || r.order_potential || '—'}</span>
          </div>
        </div>
        ${r.contact_person ? `<p class="text-[10px] text-slate-400 mt-1 truncate">${esc(r.contact_person)} ${r.contact_phone ? '| '+r.contact_phone : ''}</p>` : ''}
      </div>
    </div>`).join('');
}

function toggleBulk(id, checked) {
  if (checked) bulkSelectedIds.add(id); else bulkSelectedIds.delete(id);
  renderPharmacyList();
}

function bulkAssign() {
  const ids = [...bulkSelectedIds];
  if (!ids.length) return;
  selectedInPolygon = pharmacyCache.filter(p => ids.includes(p.id));
  showAssignForm();
}

function onPharmacyClick(e) {
  if (drawingPolygon) return;
  const p = e.features[0].properties;

  if (clickSelectMode) {
    toggleClickSelection(p.id);
    return;
  }

  map.flyTo({ center: e.lngLat, zoom: Math.max(map.getZoom(), 15), duration: 600 });
  openPharmacyDrawer(p.id);
}

async function openPharmacyDrawer(id) {
  try {
    const p = await API.get(`/pharmacies/${id}`);
    const verifications = await API.get(`/verifications/pharmacy/${id}`);
    let leadsHtml = '';
    try {
      const leads = DEMO.active ? DEMO.STORE.commercialLeads.filter(l => l.pharmacy_id === id) : await API.get(`/commercial-leads/pharmacy/${id}`).catch(() => []);
      if (leads.length) {
        const nextStatus = { interested: ['follow_up_required','lost'], follow_up_required: ['contact_captured','lost'], contact_captured: ['converted','lost'], converted: [], lost: ['interested'] };
        leadsHtml = `
          <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 mt-6">Oportunidades Comerciales</h4>
          ${leads.map(l => {
            const transitions = nextStatus[l.status] || [];
            const btns = transitions.map(s => `<button onclick="advanceLead('${l.id}','${s}')" class="text-[10px] px-2 py-1 rounded-md font-bold ${s==='lost'?'bg-rose-50 text-rose-600':'bg-blue-50 text-blue-600'} hover:opacity-80">${s.replace(/_/g,' ')}</button>`).join('');
            return `
            <div class="bg-emerald-50 border border-emerald-200 p-3 rounded-xl mb-2">
              <div class="flex items-center justify-between mb-1">
                <span class="badge badge-green">${l.status}</span>
                <span class="text-xs text-slate-400">${l.created_at ? new Date(l.created_at).toLocaleDateString() : ''}</span>
              </div>
              <p class="text-sm font-bold text-emerald-700">$${num(l.potential_sales || 0)} potencial</p>
              <p class="text-xs text-slate-600 mt-1">${esc(l.notes || '')}</p>
              ${btns ? `<div class="flex gap-1 mt-2 flex-wrap">${btns}</div>` : ''}
            </div>`;
          }).join('')}`;
      }
    } catch {}

    document.getElementById('drawer-title').textContent = p.name;
    document.getElementById('drawer-body').innerHTML = `
      <div class="mb-6">
        <span class="badge ${badgeColor(p.status)} mb-2">${p.status}</span>
        ${p.verification_status ? `<span class="badge ${p.verification_status === 'verified' ? 'badge-green' : 'badge-yellow'} ml-1">${p.verification_status}</span>` : ''}
        <p class="text-sm text-slate-600 mt-2">${esc(p.address || 'Sin dirección')}</p>
      </div>

      <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Detalles</h4>
      <div class="grid grid-cols-2 gap-3 mb-6">
        <div class="bg-white p-3 rounded-xl border border-slate-100 shadow-sm">
          <p class="text-[10px] text-slate-400 font-bold uppercase">Municipio</p>
          <p class="text-sm font-medium text-slate-800 mt-0.5">${esc(p.municipality || '—')}</p>
        </div>
        <div class="bg-white p-3 rounded-xl border border-slate-100 shadow-sm">
          <p class="text-[10px] text-slate-400 font-bold uppercase">Potencial</p>
          <p class="text-sm font-medium text-emerald-600 mt-0.5">${p.potential_score || p.order_potential || '—'}</p>
        </div>
        <div class="bg-white p-3 rounded-xl border border-slate-100 shadow-sm">
          <p class="text-[10px] text-slate-400 font-bold uppercase">Contacto</p>
          <p class="text-sm font-medium text-slate-800 mt-0.5">${esc(p.contact_person || '—')}</p>
          ${p.contact_phone ? `<p class="text-xs text-slate-500">${p.contact_phone}</p>` : ''}
        </div>
        <div class="bg-white p-3 rounded-xl border border-slate-100 shadow-sm">
          <p class="text-[10px] text-slate-400 font-bold uppercase">Última Visita</p>
          <p class="text-sm font-medium text-slate-800 mt-0.5">${p.last_visited_at ? new Date(p.last_visited_at).toLocaleDateString() : '—'}</p>
          ${p.last_visit_outcome ? `<span class="badge ${badgeColor(p.last_visit_outcome)} mt-0.5">${p.last_visit_outcome}</span>` : ''}
        </div>
      </div>

      ${leadsHtml}

      <h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 mt-6">Historial de Verificación</h4>
      <div class="space-y-3">
        ${verifications.length ? verifications.map(v => `
          <div class="bg-white p-4 rounded-xl border border-slate-100 shadow-sm">
            <div class="flex items-center justify-between mb-2">
              <div class="flex items-center gap-1.5 flex-wrap">
                <span class="badge ${badgeColor(v.visit_status)}">${v.visit_status}</span>
                <span class="badge ${badgeColor(v.assignment_status)}">${v.assignment_status}</span>
                ${v.regularization_status ? `<span class="badge ${v.regularization_status === 'verified' ? 'badge-green' : v.regularization_status === 'requires_follow_up' ? 'badge-yellow' : 'badge-red'}">${v.regularization_status}</span>` : ''}
              </div>
              <span class="text-xs text-slate-400">${new Date(v.visited_at || v.assigned_at || v.created_at).toLocaleDateString()}</span>
            </div>
            <p class="text-[11px] text-slate-500 mb-2">Rep: ${esc(v.rep_name || 'Desconocido')} ${v.route_order ? `| Parada ${v.route_order}` : ''}</p>
            <p class="text-sm text-slate-600">${esc(v.comment || 'Sin comentarios registrados.')}</p>
            ${v.order_potential ? `<p class="text-xs text-emerald-600 mt-1 font-medium">Potencial: $${num(v.order_potential)}</p>` : ''}
            ${v.contact_name ? `<p class="text-[10px] text-slate-400 mt-1">Contacto: ${esc(v.contact_name)} ${v.contact_phone ? `| ${esc(v.contact_phone)}` : ''}</p>` : ''}
            ${v.distance_to_pharmacy_m != null ? `<p class="text-[10px] ${Number(v.distance_to_pharmacy_m) > 500 ? 'text-rose-500' : 'text-slate-400'} mt-1">Distancia check-in: ${Math.round(Number(v.distance_to_pharmacy_m))}m</p>` : ''}
            ${v.photo_url ? `
              <a href="${v.photo_url}" target="_blank" rel="noopener noreferrer" class="block mt-3">
                <img src="${v.photo_url}" alt="Foto de evidencia" class="w-full h-40 object-cover rounded-xl border border-slate-100">
              </a>` : '<p class="text-[10px] text-amber-600 mt-2 font-medium">Sin foto de evidencia.</p>'}
          </div>`).join('') : '<p class="text-sm text-slate-400 italic">Sin historial de verificación.</p>'}
      </div>

      ${p.notes ? `<div class="mt-6"><h4 class="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Notas</h4><p class="text-sm text-slate-600 bg-white p-3 rounded-xl border border-slate-100">${esc(p.notes)}</p></div>` : ''}
    `;
    
    document.getElementById('context-drawer').classList.add('open');
  } catch { showToast('No se pudieron cargar los detalles de la farmacia', 'error'); }
}

function closeDrawer() {
  document.getElementById('context-drawer').classList.remove('open');
}

/* ─── Assignments ──────────────────────────────────────────────── */
function startAssignMode() {
  document.getElementById('main-panel').style.transform = 'translateY(150%)';
  document.getElementById('assign-toolbar').classList.remove('hidden');
  drawingPolygon = true;
  polygonPoints = [];
  map.getCanvas().style.cursor = 'crosshair';
  map._drawClick = (e) => { polygonPoints.push([e.lngLat.lng, e.lngLat.lat]); updateDrawPoly(); };
  map._drawDbl = async (e) => {
    e.preventDefault();
    if (polygonPoints.length < 3) { cancelAssign(); return; }
    drawingPolygon = false;
    map.getCanvas().style.cursor = '';
    map.off('click', map._drawClick);
    map.off('dblclick', map._drawDbl);
    await checkOverlapAndSelect();
  };
  map.on('click', map._drawClick);
  map.on('dblclick', map._drawDbl);
}

function updateDrawPoly() {
  if (polygonPoints.length < 2) return;
  const ring = [...polygonPoints, polygonPoints[0]];
  map.getSource('draw-polygon')?.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } }] });
}

async function checkOverlapAndSelect() {
  const ring = [...polygonPoints, polygonPoints[0]];
  const polygon = { type: 'Polygon', coordinates: [ring] };
  
  try {
    const overlapResult = await API.post('/assignments/check-overlap', { polygon });
    if (overlapResult.has_overlap) {
      document.getElementById('overlap-count').textContent = overlapResult.overlapping.length;
      document.getElementById('overlap-modal').classList.remove('hidden');
      pendingOverlapAction = () => selectInPolygon();
      return;
    }
    await selectInPolygon();
  } catch {
    await selectInPolygon();
  }
}

function cancelOverlap() {
  document.getElementById('overlap-modal').classList.add('hidden');
  pendingOverlapAction = null;
  cancelAssign();
}

function proceedAfterOverlap() {
  document.getElementById('overlap-modal').classList.add('hidden');
  if (pendingOverlapAction) pendingOverlapAction();
  pendingOverlapAction = null;
}

async function selectInPolygon() {
  const ring = [...polygonPoints, polygonPoints[0]];
  const polygon = { type: 'Polygon', coordinates: [ring] };
  try {
    selectedInPolygon = await API.post('/pharmacies/find-in-polygon', { polygon });
    const features = selectedInPolygon.map(p => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [Number(p.lng), Number(p.lat)] }
    }));
    map.getSource('selected')?.setData({ type: 'FeatureCollection', features });
    document.getElementById('assign-toolbar').classList.add('hidden');
    document.getElementById('main-panel').style.transform = '';
    showAssignForm();
  } catch {
    showToast('Error al seleccionar área', 'error');
    cancelAssign();
  }
}

function showAssignForm() {
  const repList = DEMO.active
    ? (DEMO.STORE.reps || []).map((rep) => ({ id: rep.user_id, full_name: rep.full_name }))
    : (authUsers || [])
      .filter((user) => user.role === 'field_rep')
      .map((user) => ({ id: user.id, full_name: user.full_name }));
  const repsOptions = repList.map((rep) => `<option value="${rep.id}">${rep.full_name}</option>`).join('');
  
  document.getElementById('tab-assignments').innerHTML = `
    <div class="animate-in">
      <h3 class="font-bold text-lg mb-1">Nuevo Territorio</h3>
      <p class="text-sm text-emerald-600 font-medium mb-4">${selectedInPolygon.length} farmacias seleccionadas</p>
      
      <div id="deselect-list" class="max-h-32 overflow-y-auto mb-4 space-y-1">
        ${selectedInPolygon.map(p => `
          <label class="flex items-center gap-2 text-xs text-slate-700 p-1.5 bg-white rounded-lg border border-slate-100 cursor-pointer hover:bg-slate-50">
            <input type="checkbox" checked class="deselect-cb rounded border-slate-300" data-id="${p.id}">
            <span class="truncate">${esc(p.name)}</span>
          </label>`).join('')}
      </div>

      <div class="space-y-3">
        <div><label class="block text-xs font-bold text-slate-400 mb-1">Objetivo</label>
        <select id="f-obj" class="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-sm outline-none">
          <option>Prospección</option><option>Seguimiento</option><option>Validación</option>
        </select></div>
        
        <div><label class="block text-xs font-bold text-slate-400 mb-1">Assign to Rep</label>
        <select id="f-rep" class="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-sm outline-none">
          <option value="">Unassigned</option>${repsOptions}
        </select></div>

        <div class="grid grid-cols-2 gap-3">
          <div><label class="block text-xs font-bold text-slate-400 mb-1">Prioridad</label>
          <select id="f-priority" class="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-sm outline-none">
            <option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="urgent">Urgent</option>
          </select></div>
          <div><label class="block text-xs font-bold text-slate-400 mb-1">Fecha Límite</label>
          <input id="f-due" type="date" class="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-sm outline-none"></div>
        </div>
        
        <div><label class="block text-xs font-bold text-slate-400 mb-1">Meta de Visitas</label>
        <input id="f-goal" type="number" class="w-full bg-white border border-slate-200 rounded-lg p-2.5 text-sm outline-none" placeholder="Número de visitas esperadas" value="${selectedInPolygon.length}"></div>
        
        <div class="flex gap-2 pt-2">
          <button onclick="cancelAssignForm()" class="flex-1 btn btn-ghost border border-slate-200 text-sm py-2">Cancelar</button>
          <button onclick="submitAssignForm()" class="flex-1 btn btn-primary text-sm py-2">Crear Asignación</button>
        </div>
      </div>
    </div>`;
}

function cancelAssign() {
  drawingPolygon = false;
  polygonPoints = [];
  selectedInPolygon = [];
  clickSelectMode = false;
  clickSelectedPharmacies = [];
  if (map._drawClick) { map.off('click', map._drawClick); map.off('dblclick', map._drawDbl); }
  map.getCanvas().style.cursor = '';
  map.getSource('draw-polygon')?.setData(emptyFC());
  map.getSource('selected')?.setData(emptyFC());
  document.getElementById('assign-toolbar').classList.add('hidden');
  document.getElementById('click-select-toolbar').classList.add('hidden');
  if (currentTab === 'assignments') document.getElementById('main-panel').style.transform = '';
}

function cancelAssignForm() {
  cancelAssign();
  bulkSelectedIds.clear();
  document.getElementById('tab-assignments').innerHTML = `
    <div class="flex gap-2 mb-5">
      <button onclick="startAssignMode()" class="flex-1 bg-[#1b365d] hover:bg-[#152845] text-white font-medium text-sm py-2.5 rounded-xl shadow-sm transition flex items-center justify-center gap-2">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 20l-5-3V4l5 3 5-3 5 3v13l-5-3-5 3z"/></svg>
        Dibujar Área
      </button>
      <button onclick="startClickSelectMode()" class="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-sm py-2.5 rounded-xl shadow-sm transition flex items-center justify-center gap-2">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4m10-10h-4M6 12H2"/></svg>
        Seleccionar Puntos
      </button>
    </div>
    <div id="assignments-list" class="space-y-3"></div>`;
  loadAssignments();
}

/* ─── Click-Select Mode ────────────────────────────────────────── */
function startClickSelectMode() {
  clickSelectMode = true;
  clickSelectedPharmacies = [];
  document.getElementById('main-panel').style.transform = 'translateY(150%)';
  document.getElementById('click-select-toolbar').classList.remove('hidden');
  document.getElementById('click-select-count').textContent = '0';
  map.getCanvas().style.cursor = 'pointer';
}

function toggleClickSelection(pharmacyId) {
  const idx = clickSelectedPharmacies.findIndex(p => p.id === pharmacyId);
  if (idx > -1) {
    clickSelectedPharmacies.splice(idx, 1);
  } else {
    const pharmacy = pharmacyCache.find(p => p.id === pharmacyId);
    if (pharmacy) clickSelectedPharmacies.push(pharmacy);
  }
  updateClickSelectionMap();
  const el = document.getElementById('click-select-count');
  if (el) el.textContent = clickSelectedPharmacies.length;
}

function updateClickSelectionMap() {
  const features = clickSelectedPharmacies.map(p => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [Number(p.lng), Number(p.lat)] },
  }));
  map.getSource('selected')?.setData({ type: 'FeatureCollection', features });
}

function finishClickSelect() {
  if (!clickSelectedPharmacies.length) {
    showToast('Selecciona al menos una farmacia', 'error');
    return;
  }
  clickSelectMode = false;
  selectedInPolygon = [...clickSelectedPharmacies];
  clickSelectedPharmacies = [];
  map.getCanvas().style.cursor = '';
  document.getElementById('click-select-toolbar').classList.add('hidden');
  document.getElementById('main-panel').style.transform = '';
  showAssignForm();
}

function cancelClickSelect() {
  clickSelectMode = false;
  clickSelectedPharmacies = [];
  map.getCanvas().style.cursor = '';
  map.getSource('selected')?.setData(emptyFC());
  document.getElementById('click-select-toolbar').classList.add('hidden');
  document.getElementById('main-panel').style.transform = '';
}

let isPanelCollapsed = false;
function togglePanel() {
  const panel = document.getElementById('main-panel');
  const btnOpen = document.getElementById('btn-open-panel');
  isPanelCollapsed = !isPanelCollapsed;
  
  if (isPanelCollapsed) {
    // Hide panel (translate left offscreen, passing under sidebar)
    panel.classList.add('md:-translate-x-[150%]');
    // Show fixed open button
    btnOpen.classList.remove('-translate-x-[150%]');
  } else {
    // Show panel
    panel.classList.remove('md:-translate-x-[150%]');
    // Hide fixed open button
    btnOpen.classList.add('-translate-x-[150%]');
  }
}

async function submitAssignForm() {
  const checked = document.querySelectorAll('.deselect-cb:checked');
  const selectedIds = [...checked].map(cb => cb.dataset.id);
  
  if (!selectedIds.length) { showToast('Selecciona al menos una farmacia', 'error'); return; }

  const ring = polygonPoints.length >= 3 ? [...polygonPoints, polygonPoints[0]] : null;
  
  try {
    await API.post('/assignments', {
      polygon_geojson: ring ? { type: 'Polygon', coordinates: [ring] } : { type: 'Polygon', coordinates: [[[0,0],[0,0],[0,0],[0,0]]] },
      pharmacy_ids: selectedIds,
      campaign_objective: document.getElementById('f-obj').value,
      priority: document.getElementById('f-priority').value,
      due_date: document.getElementById('f-due').value || null,
      visit_goal: Number(document.getElementById('f-goal').value) || selectedIds.length,
      rep_id: document.getElementById('f-rep').value || null,
    });
    showToast('Asignación creada', 'success');
    cancelAssignForm();
    loadAssignmentPolygons();
    loadAssignments();
  } catch (err) { showToast(err.error || 'Error al crear asignación', 'error'); }
}

async function previewWaveDistribution() {
  const summary = document.getElementById('wave-summary');
  const previewEl = document.getElementById('wave-preview-result');
  const payload = {
    wave_id: document.getElementById('wave-id').value || undefined,
    municipality: document.getElementById('wave-municipality').value || undefined,
    campaign_objective: document.getElementById('wave-objective').value || 'Prospección',
    priority: document.getElementById('wave-priority').value || 'high',
    dry_run: true,
  };

  try {
    summary.textContent = 'Calculando distribución...';
    const result = await API.post('/assignments/distribute', payload);
    const sizes = (result.cluster_sizes || []).map(c => c.size);
    previewEl.innerHTML = `
      <div class="grid grid-cols-2 gap-2 mb-2">
        <div><span class="font-bold text-slate-800">Farmacias libres:</span> ${result.pharmacy_count}</div>
        <div><span class="font-bold text-slate-800">Representantes:</span> ${result.rep_count}</div>
        <div><span class="font-bold text-slate-800">Zonas creadas:</span> ${result.clusters_created}</div>
        <div><span class="font-bold text-slate-800">Promedio/rep:</span> ${result.avg_size}</div>
        <div><span class="font-bold text-slate-800">Mín/Máx:</span> ${result.min_size} / ${result.max_size}</div>
        <div><span class="font-bold text-slate-800">Dispersión máx:</span> ${result.max_dispersion_km} km</div>
      </div>
      <p class="text-[10px] text-slate-400">Haz clic en "Distribuir" para confirmar y crear las asignaciones.</p>`;
    previewEl.classList.remove('hidden');
    summary.textContent = `Vista previa: ${result.pharmacy_count} farmacias en ${result.clusters_created} zonas.`;
  } catch (err) {
    summary.textContent = err.error || 'Error al calcular vista previa.';
    previewEl.classList.add('hidden');
  }
}

async function submitWaveDistribution() {
  const summary = document.getElementById('wave-summary');
  const payload = {
    wave_id: document.getElementById('wave-id').value || undefined,
    municipality: document.getElementById('wave-municipality').value || undefined,
    campaign_objective: document.getElementById('wave-objective').value || 'Prospecting',
    priority: document.getElementById('wave-priority').value || 'high',
    due_date: document.getElementById('wave-due-date').value || undefined,
  };
  const maxPerRep = Number(document.getElementById('wave-max-per-rep').value);
  if (Number.isFinite(maxPerRep) && maxPerRep > 0) {
    payload.max_pharmacies_per_rep = maxPerRep;
  }

  try {
    summary.textContent = 'Distribuyendo farmacias entre representantes activos...';
    const result = await API.post('/assignments/distribute', payload);
    summary.textContent = `Oleada ${result.wave_id}: ${result.pharmacy_count} farmacias en ${result.assignments_created} asignaciones.`;
    showToast('Distribución completada', 'success');
    loadAssignmentPolygons();
    loadAssignments();
    loadKPIs();
  } catch (err) {
    summary.textContent = err.error || 'La distribución falló.';
    showToast(err.error || 'La distribución falló', 'error');
  }
}

async function loadAssignmentPolygons() {
  try {
    const list = await API.get('/assignments');
    const features = list.filter(a => a.polygon_geojson).map(a => {
      const geom = typeof a.polygon_geojson === 'string' ? JSON.parse(a.polygon_geojson) : a.polygon_geojson;
      return { type: 'Feature', geometry: geom, properties: { id: a.id, status: a.status } };
    });
    map.getSource('assignment-polygons')?.setData({ type: 'FeatureCollection', features });
  } catch {}
}

async function loadAssignments() {
  try {
    const list = await API.get('/assignments');
    const el = document.getElementById('assignments-list');
    if (!el) return;
    el.innerHTML = list.length ? list.map(a => `
      <div class="bg-white border border-slate-200 p-4 rounded-xl shadow-sm">
        <div class="flex items-center justify-between mb-2">
          <h4 class="font-bold text-sm text-slate-800">${esc(a.campaign_objective)}</h4>
          <span class="badge ${badgeColor(a.status)}">${a.status}</span>
        </div>
        <div class="flex items-center justify-between text-xs text-slate-500 mb-3">
          <span>${esc(a.rep_name || 'Sin asignar')}</span>
          <div class="flex items-center gap-2">
            ${a.priority && a.priority !== 'normal' ? `<span class="badge ${a.priority==='high'||a.priority==='urgent'?'badge-red':'badge-gray'}">${a.priority}</span>` : ''}
            ${a.due_date ? `<span>Vence: ${new Date(a.due_date).toLocaleDateString()}</span>` : ''}
          </div>
        </div>
        <div class="w-full bg-slate-100 rounded-full h-1.5 mb-1.5 overflow-hidden">
          <div class="bg-[#1b365d] h-1.5 rounded-full transition-all" style="width: ${a.total_stops||a.pharmacy_count ? ((a.completed_stops||0)/(a.total_stops||a.pharmacy_count)*100) : 0}%"></div>
        </div>
        <p class="text-[10px] text-slate-400 text-right uppercase tracking-wider">${a.completed_stops||0} / ${a.total_stops||a.pharmacy_count||0} visitadas</p>
      </div>`).join('') : '<p class="text-sm text-slate-400">No hay territorios asignados aún.</p>';
  } catch {}
}

/* ─── Review ──────────────────────────────────────────────────── */
async function loadReviewBadge() {
  try {
    const data = await API.get('/review/pending-count');
    const count = typeof data === 'object' ? data.pending : data;
    const badge = document.getElementById('review-badge');
    if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  } catch {}
}

async function loadReviewMarkers() {
  try {
    const items = await API.get('/review?queue_status=pending');
    const features = items.filter(i => i.pharmacy_lat && i.pharmacy_lng).map(i => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [Number(i.pharmacy_lng), Number(i.pharmacy_lat)] },
      properties: { id: i.id, name: i.pharmacy_name, flag_type: i.flag_type || 'candidate' },
    }));
    map.getSource('review-markers')?.setData({ type: 'FeatureCollection', features });
  } catch {}
}

function onReviewMarkerClick(e) {
  const p = e.features[0].properties;
  new maplibregl.Popup({ offset: 12 })
    .setLngLat(e.lngLat)
    .setHTML(`<div class="p-2 min-w-[200px]">
      <h4 class="font-bold text-sm text-slate-800 mb-1">${esc(p.name)}</h4>
      <span class="badge badge-yellow mb-3">${p.flag_type}</span>
      <div class="flex gap-2 mt-2">
        <button class="flex-1 btn btn-sm btn-success" onclick="resolveReview('${p.id}','approved')">Aprobar</button>
        <button class="flex-1 btn btn-sm btn-danger" onclick="resolveReview('${p.id}','rejected')">Rechazar</button>
      </div></div>`)
    .addTo(map);
}

async function loadReviewList() {
  reviewSelectedIds.clear();
  try {
    const items = await API.get('/review?queue_status=pending');
    const batchBar = items.length ? `
      <div class="flex items-center justify-between mb-4 bg-slate-50 p-2 rounded-lg border border-slate-100">
        <label class="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
          <input type="checkbox" id="review-select-all" onchange="toggleAllReview(this.checked)" class="rounded border-slate-300"> Seleccionar todo
        </label>
        <div class="flex gap-1.5" id="batch-review-btns" style="display:none">
          <button onclick="batchResolveReview('approved')" class="text-[10px] px-2 py-1 font-bold bg-emerald-100 text-emerald-700 rounded-md">Aprobar Lote</button>
          <button onclick="batchResolveReview('rejected')" class="text-[10px] px-2 py-1 font-bold bg-rose-100 text-rose-700 rounded-md">Rechazar Lote</button>
        </div>
      </div>` : '';
    document.getElementById('review-list').innerHTML = batchBar + (items.length ? items.map(i => `
      <div class="bg-white border border-slate-200 p-3 rounded-xl shadow-sm" id="rv-${i.id}">
        <div class="flex items-start gap-2 mb-2">
          <input type="checkbox" class="rv-cb rounded border-slate-300 mt-0.5" data-id="${i.id}" onchange="toggleReviewItem('${i.id}',this.checked)">
          <div class="flex-1">
            <span class="badge badge-yellow mb-1">${i.flag_type || 'Candidate'}</span>
            <h4 class="font-semibold text-sm text-slate-800">${esc(i.pharmacy_name)}</h4>
            <p class="text-xs text-slate-500 mt-0.5">Por ${esc(i.rep_name||i.submitted_by_name||'Desconocido')}</p>
            ${i.reason ? `<p class="text-xs text-slate-400 mt-1 italic">"${esc(i.reason)}"</p>` : ''}
          </div>
        </div>
        <div class="flex gap-2">
          <button onclick="resolveReview('${i.id}','approved')" class="flex-1 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs font-bold rounded-lg transition">APROBAR</button>
          <button onclick="resolveReview('${i.id}','rejected')" class="flex-1 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold rounded-lg transition">RECHAZAR</button>
        </div>
      </div>`).join('') : '<p class="text-sm text-slate-400">La cola está vacía.</p>');
  } catch {}
}

async function resolveReview(id, decision) {
  try {
    await API.patch(`/review/${id}/resolve`, { decision, review_notes: '' });
    document.getElementById(`rv-${id}`)?.remove();
    loadReviewBadge();
    loadReviewMarkers();
    showToast(decision === 'approved' ? 'Aprobado' : 'Rechazado', 'success');
  } catch (err) { showToast(err.error || 'Error', 'error'); }
}

/* ─── Reps ────────────────────────────────────────────────────── */
function getRepColor(repId, index = 0) {
  const palette = ['#e11d48', '#2563eb', '#10b981', '#f59e0b', '#8b5cf6'];
  if (DEMO.active) {
    const rep = DEMO.STORE.reps.find((item) => item.user_id === repId);
    if (rep?.color) return rep.color;
  }
  return palette[index % palette.length];
}

function stopRepMotionAnimation(clear = false) {
  if (repMotionFrame) cancelAnimationFrame(repMotionFrame);
  repMotionFrame = null;
  if (clear) {
    repRouteCache = new Map();
    map.getSource('rep-motion')?.setData(emptyFC());
    map.getSource('rep-assignment-links')?.setData(emptyFC());
    map.getSource('rep-assignment-routes')?.setData(emptyFC());
  }
}

function startRepMotionAnimation(routes) {
  stopRepMotionAnimation(false);
  if (!routes.length) {
    map.getSource('rep-motion')?.setData(emptyFC());
    return;
  }

  const startedAt = performance.now();
  const animate = (now) => {
    const features = routes.map((route, index) => {
      const cycleMs = route.durationMs + route.pauseMs;
      const elapsedMs = (now - startedAt + index * 1800) % cycleMs;
      const rawProgress = elapsedMs >= route.durationMs ? 1 : elapsedMs / route.durationMs;
      const easedProgress = rawProgress < 0.5
        ? 2 * rawProgress * rawProgress
        : 1 - ((-2 * rawProgress + 2) ** 2) / 2;
      const coordinate = samplePolylineCoordinate(route.coordinates, easedProgress);
      return coordinate ? {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coordinate },
        properties: { rep_id: route.repId, color: route.color },
      } : null;
    }).filter(Boolean);

    map.getSource('rep-motion')?.setData({ type: 'FeatureCollection', features });
    repMotionFrame = requestAnimationFrame(animate);
  };

  repMotionFrame = requestAnimationFrame(animate);
}

async function loadRepSection() {
  const positions = await loadRepPositions();
  await Promise.all([loadRepRouteVisuals(positions), loadRepsList()]);
}

async function loadRepRouteVisuals(positions = null) {
  try {
    const repPositions = positions || await API.get('/tracking/positions');
    const assignments = await API.get('/assignments');
    const activeAssignments = assignments.filter(a => a.rep_id && ['assigned', 'in_progress'].includes(a.status));
    const details = await Promise.all(activeAssignments.map(a => API.get(`/assignments/${a.id}`).catch(() => null)));
    const repById = new Map(repPositions.map((rep, index) => [rep.rep_id, { ...rep, color: rep.color || getRepColor(rep.rep_id, index) }]));
    const linkFeatures = [];
    const routeFeatures = [];
    const motionRoutes = [];
    const routeBounds = [];

    repRouteCache = new Map();

    details.filter(Boolean).forEach((assignment, index) => {
      const stops = (assignment.stops || [])
        .map(stop => [Number(stop.lng), Number(stop.lat)])
        .filter(coord => Number.isFinite(coord[0]) && Number.isFinite(coord[1]));
      if (!stops.length) return;

      const rep = repById.get(assignment.rep_id);
      const repCoord = rep
        ? [Number(rep.lng || rep.last_lng || rep.home_lng), Number(rep.lat || rep.last_lat || rep.home_lat)]
        : stops[0];
      if (!Number.isFinite(repCoord[0]) || !Number.isFinite(repCoord[1])) return;

      const color = rep?.color || getRepColor(assignment.rep_id, index);
      const routeCoords = [repCoord, ...stops];
      repRouteCache.set(assignment.rep_id, routeCoords);

      routeFeatures.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: routeCoords },
        properties: { rep_id: assignment.rep_id, color },
      });

      stops.forEach((stopCoord) => {
        linkFeatures.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [repCoord, stopCoord] },
          properties: { rep_id: assignment.rep_id, color },
        });
      });

      motionRoutes.push({
        repId: assignment.rep_id,
        color,
        coordinates: routeCoords,
        durationMs: Math.max(14000, routeCoords.length * 2600),
        pauseMs: 1200,
      });

      routeBounds.push(...routeCoords);
    });

    map.getSource('rep-assignment-links')?.setData({ type: 'FeatureCollection', features: linkFeatures });
    map.getSource('rep-assignment-routes')?.setData({ type: 'FeatureCollection', features: routeFeatures });
    /* startRepMotionAnimation(motionRoutes); — disabled for production; enable for demos */

    if (routeBounds.length) {
      map.fitBounds(boundsFromCoords(routeBounds), { padding: 70, maxZoom: 13.8, duration: 800 });
    }
  } catch {
    stopRepMotionAnimation(true);
  }
}

function focusRepRoute(repId) {
  const coords = repRouteCache.get(repId);
  if (!coords?.length) {
    showToast('No hay ruta activa para este representante', 'info');
    return;
  }
  map.fitBounds(boundsFromCoords(coords), { padding: 70, maxZoom: 14.5, duration: 800 });
}

async function loadRepPositions() {
  try {
    const positions = await API.get('/tracking/positions');
    const features = positions.map(p => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [Number(p.lng || p.last_lng), Number(p.lat || p.last_lat)] },
      properties: { rep_id: p.rep_id, name: p.full_name, time: p.recorded_at || p.last_seen, color: p.color || getRepColor(p.rep_id) },
    }));
    map.getSource('rep-positions')?.setData({ type: 'FeatureCollection', features });
    return positions;
  } catch {}
  return [];
}

async function loadRepsList() {
  try {
    const reps = await API.get('/reporting/reps');
    document.getElementById('reps-list').innerHTML = reps.length ? reps.map(r => `
      <div class="bg-white border border-slate-200 p-3 rounded-xl shadow-sm">
        <div class="flex justify-between items-center mb-2">
          <div>
            <h4 class="font-bold text-sm text-slate-800">${esc(r.rep_name)}</h4>
            <p class="text-xs text-slate-500 mt-0.5">${r.total_visits || 0} visits | ${r.unique_pharmacies_visited || 0} unique | ${r.assigned_total || 0} assigned</p>
          </div>
          <div class="text-right">
            <p class="text-sm font-bold text-emerald-600">${r.interested_count || 0} Interesados</p>
            <p class="text-[10px] text-slate-500">${r.with_photo_total || 0} fotos | ${r.with_comment_total || 0} comentarios</p>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-2 mb-2 text-[10px]">
          <div class="bg-slate-50 rounded-lg px-2 py-1.5 text-slate-600">Completadas <span class="font-bold text-slate-800">${r.completed_total || 0}</span></div>
          <div class="bg-slate-50 rounded-lg px-2 py-1.5 text-slate-600">Con Foto <span class="font-bold text-slate-800">${r.with_photo_total || 0}</span></div>
          <div class="bg-slate-50 rounded-lg px-2 py-1.5 text-slate-600">Seguimiento <span class="font-bold text-slate-800">${r.regularization_follow_up_total || 0}</span></div>
        </div>
        <div class="flex gap-1.5">
          <button onclick="focusRepRoute('${r.rep_id}')" class="flex-1 text-[10px] font-bold bg-sky-50 text-sky-600 hover:bg-sky-100 px-2 py-1.5 rounded-lg transition">Ver Ruta</button>
          <button onclick="loadBreadcrumbs('${r.rep_id}')" class="flex-1 text-[10px] font-bold bg-orange-50 text-orange-600 hover:bg-orange-100 px-2 py-1.5 rounded-lg transition">Recorrido</button>
          <button onclick="openRepEvidence('${r.rep_id}')" class="flex-1 text-[10px] font-bold bg-emerald-50 text-emerald-600 hover:bg-emerald-100 px-2 py-1.5 rounded-lg transition">Evidencia</button>
          <button onclick="impersonateUser('${r.rep_id}')" class="flex-1 text-[10px] font-bold bg-violet-50 text-violet-600 hover:bg-violet-100 px-2 py-1.5 rounded-lg transition">Ver como Rep</button>
        </div>
      </div>`).join('') : '<p class="text-sm text-slate-400">No hay representantes activos.</p>';
  } catch {}
}

async function openRepEvidence(repId) {
  try {
    const summary = await API.get(`/verifications/reps/${encodeURIComponent(repId)}/summary`).catch(() => null);
    const items = await API.get(`/verifications/evidence?rep_id=${encodeURIComponent(repId)}&limit=12`);
    document.getElementById('drawer-title').textContent = `Evidencia — ${summary?.rep_name || repId}`;
    document.getElementById('drawer-body').innerHTML = items.length ? items.map(item => `
      <div class="bg-white p-4 rounded-xl border border-slate-100 shadow-sm mb-3">
        <div class="flex items-start justify-between gap-3 mb-2">
          <div>
            <h4 class="font-semibold text-sm text-slate-800">${esc(item.pharmacy_name)}</h4>
            <p class="text-[10px] text-slate-500 mt-0.5">${esc(item.municipality || '')}</p>
          </div>
          <div class="text-right">
            <span class="badge ${badgeColor(item.visit_status)}">${item.visit_status}</span>
            ${item.regularization_status ? `<div class="text-[10px] text-slate-400 mt-1">${item.regularization_status}</div>` : ''}
          </div>
        </div>
        <p class="text-sm text-slate-600">${esc(item.comment || 'Sin comentarios.')}</p>
        ${item.photo_url ? `<a href="${item.photo_url}" target="_blank" rel="noopener noreferrer" class="block mt-3"><img src="${item.photo_url}" alt="Foto de evidencia" class="w-full h-40 object-cover rounded-xl border border-slate-100"></a>` : '<p class="text-[10px] text-amber-600 mt-2 font-medium">Sin foto de evidencia.</p>'}
        <div class="flex items-center justify-between mt-2 text-[10px] text-slate-400">
          <span>${item.visited_at ? new Date(item.visited_at).toLocaleString() : 'Aún no visitada'}</span>
          ${item.distance_to_pharmacy_m != null ? `<span>${Math.round(Number(item.distance_to_pharmacy_m))}m check-in</span>` : ''}
        </div>
      </div>`).join('') : '<p class="text-sm text-slate-400">No se encontró evidencia para este representante.</p>';
    document.getElementById('context-drawer').classList.add('open');
  } catch (err) {
    showToast(err.error || 'No se pudo cargar la evidencia', 'error');
  }
}

async function loadBreadcrumbs(repId) {
  try {
    const pings = await API.get(`/tracking/breadcrumbs/${repId}`);
    if (!pings.length) { showToast('No hay datos de recorrido para este representante', 'info'); return; }
    const coords = pings.map(p => [Number(p.lng), Number(p.lat)]);
    const pointFeatures = pings.map(p => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [Number(p.lng), Number(p.lat)] },
      properties: { time: p.recorded_at },
    }));
    const lineFeature = { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };
    map.getSource('breadcrumbs')?.setData({ type: 'FeatureCollection', features: [...pointFeatures, lineFeature] });
    map.setLayoutProperty('breadcrumb-line', 'visibility', 'visible');
    map.setLayoutProperty('breadcrumb-dots', 'visibility', 'visible');
    const bounds = new maplibregl.LngLatBounds();
    coords.forEach(c => bounds.extend(c));
    map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 800 });
    showToast(`Mostrando recorrido del representante (${pings.length} puntos)`, 'success');
  } catch { showToast('No se pudo cargar el recorrido', 'error'); }
}

/* ─── Reporting ────────────────────────────────────────────────── */
async function loadReporting() {
  try {
    const data = await API.get('/reporting/dashboard');
    const f = data.funnel || {};
    const extKpis = [
      { label: 'Total Farmacias', value: f.total_pharmacies },
      { label: 'Asignadas', value: f.assigned_pharmacies || f.assigned },
      { label: 'Visitadas', value: f.visited },
      { label: 'Interesados', value: f.interested },
      { label: 'Seguimiento', value: f.needs_follow_up },
      { label: 'Inválidas/Cerradas', value: f.invalid_closed },
      { label: 'Cobertura', value: f.coverage_pct, suffix: '%' },
      { label: 'Total Oportunidades', value: data.sales?.total_leads || f.total_leads },
      { label: 'Potencial de Venta', value: data.sales?.total_potential || f.total_potential, prefix: '$' },
      { label: 'Reps Activos', value: (data.reps||[]).filter(r => (r.total_visits||0) > 0).length },
    ];
    document.getElementById('reporting-kpis').innerHTML = extKpis.map(c => `
      <div class="bg-white border border-slate-100 p-3 rounded-xl shadow-sm">
        <p class="text-[10px] text-slate-500 uppercase tracking-wide font-medium">${c.label}</p>
        <p class="text-lg font-bold text-slate-800 mt-0.5">${c.prefix||''}${num(c.value)}${c.suffix||''}</p>
      </div>`).join('');

    const coverage = data.coverage || [];
    document.getElementById('coverage-list').innerHTML = coverage.length ? coverage.map(c => /* municipio */ `
      <div class="bg-white border border-slate-100 p-2.5 rounded-lg shadow-sm flex justify-between items-center">
        <span class="text-sm font-medium text-slate-700">${esc(c.municipality)}</span>
        <div class="flex items-center gap-3">
          <div class="w-20 bg-slate-100 rounded-full h-1.5"><div class="bg-[#1b365d] h-1.5 rounded-full" style="width:${c.visit_pct||0}%"></div></div>
          <span class="text-xs text-slate-500 w-16 text-right">${c.visited||0}/${c.total||0}</span>
        </div>
      </div>`).join('') : '<p class="text-xs text-slate-400">Sin datos de cobertura.</p>';

    const reps = data.reps || [];
    document.getElementById('rep-productivity-list').innerHTML = reps.length ? reps.map(r => `
      <div class="bg-white border border-slate-100 p-2.5 rounded-lg shadow-sm flex justify-between items-center">
        <span class="text-sm font-medium text-slate-700">${esc(r.rep_name)}</span>
        <div class="text-right">
          <span class="text-xs text-slate-600">${r.total_visits||0} visitas</span>
          <span class="text-xs text-emerald-600 ml-2">${r.interested_count||0} interesados</span>
        </div>
      </div>`).join('') : '<p class="text-xs text-slate-400">Sin datos de representantes.</p>';

    try {
      const assignments = await API.get('/reporting/assignments');
      document.getElementById('assignment-progress-list').innerHTML = assignments.length ? assignments.map(a => `
        <div class="bg-white border border-slate-100 p-2.5 rounded-lg shadow-sm">
          <div class="flex justify-between items-center mb-1">
            <span class="text-sm font-medium text-slate-700">${esc(a.campaign_objective)}</span>
            <span class="badge ${badgeColor(a.assignment_status)}">${a.assignment_status}</span>
          </div>
          <div class="w-full bg-slate-100 rounded-full h-1.5"><div class="bg-[#1b365d] h-1.5 rounded-full" style="width:${a.completion_pct||0}%"></div></div>
          <p class="text-[10px] text-slate-400 mt-1">${a.rep_name||'Sin asignar'} | ${a.completed_stops||0}/${a.total_stops||0}</p>
        </div>`).join('') : '<p class="text-xs text-slate-400">Sin asignaciones.</p>';
    } catch {}
  } catch {}
}

/* ─── Audit ────────────────────────────────────────────────────── */
async function loadAudit() {
  try {
    const events = await API.get('/audit');
    document.getElementById('audit-list').innerHTML = events.length ? events.map(e => `
      <div class="bg-white border border-slate-100 p-3 rounded-xl shadow-sm flex items-start gap-3">
        <div class="w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${e.action.includes('created')?'bg-emerald-500':e.action.includes('resolved')?'bg-amber-500':'bg-blue-500'}"></div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-slate-800">${esc(e.action.replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase()))}</p>
          <p class="text-xs text-slate-500 mt-0.5">${esc(e.user_name||'System')} | ${e.entity_type ? e.entity_type + ' ' + (e.entity_id||'') : ''}</p>
          <p class="text-[10px] text-slate-400 mt-0.5">${new Date(e.created_at).toLocaleString()}</p>
        </div>
      </div>`).join('') : '<p class="text-sm text-slate-400">Sin actividad registrada.</p>';
  } catch {}
}

/* ─── Impersonation ────────────────────────────────────────────── */
async function impersonateUser(targetUserId) {
  try {
    const result = await API.post('/auth/impersonate', { target_user_id: targetUserId });
    localStorage.setItem('token', result.token);
    localStorage.setItem('user', JSON.stringify(result.user));
    localStorage.setItem('marzam_impersonating', '1');
    const dest = result.user.role === 'field_rep' ? '/rep.html' : '/manager.html';
    location.href = dest;
  } catch (err) { showToast(err.error || 'Error al cambiar de usuario', 'error'); }
}

async function stopImpersonation() {
  try {
    const result = await API.post('/auth/impersonate/stop', {});
    localStorage.setItem('token', result.token);
    localStorage.setItem('user', JSON.stringify(result.user));
    localStorage.removeItem('marzam_impersonating');
    location.href = '/manager.html';
  } catch {
    localStorage.removeItem('marzam_impersonating');
    location.href = '/manager.html';
  }
}

/* ─── Batch Review ─────────────────────────────────────────────── */
function toggleReviewItem(id, checked) {
  if (checked) reviewSelectedIds.add(id); else reviewSelectedIds.delete(id);
  const btns = document.getElementById('batch-review-btns');
  if (btns) btns.style.display = reviewSelectedIds.size > 0 ? 'flex' : 'none';
}

function toggleAllReview(checked) {
  document.querySelectorAll('.rv-cb').forEach(cb => {
    cb.checked = checked;
    toggleReviewItem(cb.dataset.id, checked);
  });
}

async function batchResolveReview(decision) {
  const ids = [...reviewSelectedIds];
  if (!ids.length) return;
  try {
    await API.post('/review/batch-resolve', { ids, decision });
    showToast(`${ids.length} elementos ${decision === 'approved' ? 'aprobados' : 'rechazados'}`, 'success');
    loadReviewList();
    loadReviewBadge();
    loadReviewMarkers();
  } catch (err) { showToast(err.error || 'Operación por lote falló', 'error'); }
}

/* ─── Lead Lifecycle ───────────────────────────────────────────── */
async function advanceLead(leadId, newStatus) {
  try {
    await API.patch(`/commercial-leads/${leadId}`, { status: newStatus });
    showToast(`Oportunidad actualizada a ${newStatus.replace(/_/g, ' ')}`, 'success');
  } catch (err) { showToast(err.error || 'Error al actualizar oportunidad', 'error'); }
}

/* ─── Export ────────────────────────────────────────────────────── */
async function exportData(format) {
  if (DEMO.active) {
    const rows = DEMO.STORE.pharmacies;
    if (!rows.length) { showToast('No hay datos para exportar', 'error'); return; }
    const headers = ['name','address','municipality','status','contact_person','contact_phone','last_visit_outcome','potential_score','order_potential','source','verification_status'];
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => `"${(r[h]||'').toString().replace(/"/g,'""')}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'marzam_pharmacies_enriched.csv';
    a.click();
    showToast('CSV exportado', 'success');
    return;
  }
  try {
    const fmt = format || 'csv';
    const qs = new URLSearchParams();
    qs.set('format', fmt);
    const municipality = document.getElementById('filter-municipality')?.value;
    const status = document.getElementById('filter-status')?.value;
    if (municipality) qs.set('municipality', municipality);
    if (status) qs.set('status', status);
    const ext = fmt === 'xlsx' ? 'xlsx' : 'csv';
    await API.download(`/reporting/export/pharmacies?${qs}`, `pharmacies_export.${ext}`);
    showToast(`Exportado ${ext.toUpperCase()}`, 'success');
  } catch (err) {
    showToast(err.error || 'Error al exportar', 'error');
  }
}
