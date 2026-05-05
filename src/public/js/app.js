/* =============================================================
   Marzam Unified App Shell — drives /app.html for all 4 roles.
   Handles:
    - Auth bootstrap + role normalization (legacy roles → canonical)
    - Sidebar tabs adaptados por rol
    - Mode pill (Mis rutas / Mi equipo)
    - Vista loader (lazy)
    - Live state (sesión activa, presence, demo router)
   ============================================================= */
(function () {
  'use strict';

  const ROLES = {
    DIRECTOR: 'director_sucursal',
    GERENTE: 'gerente_ventas',
    SUPERVISOR: 'supervisor',
    REPRESENTANTE: 'representante',
  };

  const ROLE_ALIASES = {
    manager: ROLES.DIRECTOR,
    national_admin: ROLES.DIRECTOR,
    regional_manager: ROLES.GERENTE,
    area_coordinator: ROLES.SUPERVISOR,
    field_rep: ROLES.REPRESENTANTE,
  };

  function normalizeRole(role) {
    return ROLE_ALIASES[role] || role || ROLES.REPRESENTANTE;
  }

  const ROLE_LABEL = {
    [ROLES.DIRECTOR]: 'Director',
    [ROLES.GERENTE]: 'Gerente',
    [ROLES.SUPERVISOR]: 'Supervisor',
    [ROLES.REPRESENTANTE]: 'Representante',
  };

  const ROLE_RANK = {
    [ROLES.DIRECTOR]: 0,
    [ROLES.GERENTE]: 1,
    [ROLES.SUPERVISOR]: 2,
    [ROLES.REPRESENTANTE]: 3,
  };

  // ──────────────────────────────────────────────────────────
  // Tabs por rol
  // ──────────────────────────────────────────────────────────
  const TAB_ICONS = {
    routes: '<svg fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M9 20l-5-3V4l5 3 5-3 5 3v13l-5-3-5 3z"/><path d="M9 4v13"/><path d="M14 7v13"/></svg>',
    team:   '<svg fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><circle cx="17" cy="7" r="3"/><path d="M21 21v-2a3 3 0 0 0-2-2.83"/></svg>',
    analytics: '<svg fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>',
    // Icono unificado para "Plan & Metas" — diana con marca de check al
    // centro: comunica simultáneamente "objetivo configurado" + "logrado".
    plan: '<svg fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><path stroke-linecap="round" stroke-linejoin="round" d="M9.5 12.2l1.8 1.8 3.5-3.7"/></svg>',
    planEditor: '<svg fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h12"/><circle cx="20" cy="18" r="2"/></svg>',
    live: '<svg fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M5 12a7 7 0 0 1 7-7"/><path d="M19 12a7 7 0 0 0-7-7"/><path d="M9 18a4 4 0 0 1-4-4"/><path d="M19 14a4 4 0 0 1-4 4"/></svg>',
    postMortem: '<svg fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>',
  };

  function tabsForRole(role) {
    const norm = normalizeRole(role);
    const tabs = [
      { id: 'routes', label: 'Mis rutas', icon: TAB_ICONS.routes },
    ];
    if (norm !== ROLES.REPRESENTANTE) {
      tabs.push({ id: 'team', label: 'Mi equipo', icon: TAB_ICONS.team });
      tabs.push({ id: 'live', label: 'En vivo', icon: TAB_ICONS.live });
    }
    tabs.push({ id: 'analytics', label: 'Analíticas', icon: TAB_ICONS.analytics });
    if (norm !== ROLES.REPRESENTANTE) {
      // Plan & Metas absorbió "Planificar" (Generar) y "Análisis" (Resultados)
      // como sub-tabs internos para evitar duplicación. Ver views.js → renderPlan.
      tabs.push({ id: 'plan', label: 'Plan & Metas', icon: TAB_ICONS.plan });
    }
    return tabs;
  }

  // ──────────────────────────────────────────────────────────
  // App state (global)
  // ──────────────────────────────────────────────────────────
  const APP = {
    user: null,
    role: null,
    isDemo: false,
    map: null,
    activeTab: 'routes',
    mode: 'self',           // 'self' | 'team'
    activeSession: null,    // visit_session activa, si hay
    timer: null,            // setInterval handle del cronómetro
    drillStack: [],         // pila de userIds para drill-down
    teamPositionsLayer: null,
  };
  window.APP = APP;

  // ──────────────────────────────────────────────────────────
  // Bootstrap
  // ──────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', async () => {
    let user = API.user();
    if (!user || (!user.id && !user.email)) {
      location.href = '/';
      return;
    }
    APP.user = user;
    APP.role = normalizeRole(user.role);

    // Auto-activate demo mode when the authenticated user is a demo account.
    // This catches users who log in via the form (which doesn't set the flag)
    // instead of the quick-pick buttons. Any user with data_scope='demo' or
    // an @demo.marzam.mx email triggers the in-memory demo router.
    APP.isDemo = localStorage.getItem('marzam_demo') === '1'
      || user.data_scope === 'demo'
      || (user.email || '').endsWith('@demo.marzam.mx');
    if (APP.isDemo) localStorage.setItem('marzam_demo', '1');

    if (APP.isDemo) {
      // Patch API with demo router (hierarchy + base demo for pharmacies/visits)
      await DEMO_H.ready;
      DEMO_H.patchAPI();
      // Also patch base demo if present (so /pharmacies, /visits etc. still demo-respond)
      if (window.DEMO && DEMO.patchAPI) {
        await DEMO.ready;
        DEMO.patchAPI();
      }
      const banner = document.getElementById('demo-banner');
      if (banner) {
        banner.classList.remove('hidden');
        document.getElementById('demo-banner-text').textContent = `Modo Demo · Sesión como ${ROLE_LABEL[APP.role]} · ${user.full_name}`;
      }
    }

    renderTopbar();
    renderSidebar();
    setupPoblacionPill();
    setupModePill();
    setupVisitFAB();
    setupUserMenu();
    setupCollapsePanel();
    setupMobilePanelDrag();
    initMap();
    await loadActiveSession();
    selectTab('routes');

    // Stop impersonation banner click
    document.getElementById('demo-banner').addEventListener('click', async () => {
      const orig = JSON.parse(localStorage.getItem('marzam_original_user') || 'null');
      if (orig) {
        try {
          const r = await API.post('/auth/impersonate/stop', {});
          localStorage.setItem('user', JSON.stringify(r.user));
          localStorage.removeItem('marzam_original_user');
          location.reload();
        } catch {
          localStorage.removeItem('marzam_original_user');
          localStorage.setItem('user', JSON.stringify(orig));
          location.reload();
        }
      }
    });
  });

  // ──────────────────────────────────────────────────────────
  // Topbar / Sidebar / Pill
  // ──────────────────────────────────────────────────────────
  function renderTopbar() {
    const badge = document.getElementById('topbar-role-badge');
    const username = document.getElementById('topbar-username');
    badge.textContent = ROLE_LABEL[APP.role] || 'Usuario';
    badge.classList.add(`role-badge--${APP.role}`);
    username.textContent = APP.user.full_name || APP.user.email;
    document.getElementById('usermenu-name').textContent = APP.user.full_name;
    document.getElementById('usermenu-email').textContent = APP.user.email;
    const fullUser = APP.isDemo ? (DEMO_H.STORE.users.find((u) => u.id === APP.user.id) || {}) : {};
    document.getElementById('usermenu-zone').textContent = fullUser.zone ? `Zona · ${fullUser.zone}` : '';

    const stopBtn = document.getElementById('usermenu-stop-impersonate');
    if (APP.user.impersonated_by) stopBtn.classList.remove('hidden');

    document.getElementById('btn-logout').addEventListener('click', () => {
      localStorage.clear();
      location.href = '/';
    });

    stopBtn.addEventListener('click', async () => {
      const r = await API.post('/auth/impersonate/stop', {}).catch(() => null);
      if (r && r.user) {
        localStorage.setItem('user', JSON.stringify(r.user));
        if (r.token) localStorage.setItem('token', r.token);
        location.reload();
      }
    });
  }

  function renderSidebar() {
    const tabs = tabsForRole(APP.role);
    const wrap = document.getElementById('nav-tabs');
    wrap.innerHTML = tabs.map((t) => `
      <button class="nav-tab" data-tab="${t.id}" aria-label="${t.label}">
        <div class="nav-icon-box"><div class="w-5 h-5 flex items-center justify-center">${t.icon}</div></div>
        <div class="tab-text-wrapper"><span class="tab-text-inner">${t.label}</span></div>
      </button>
    `).join('');
    wrap.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => selectTab(btn.dataset.tab));
    });

    // Sidebar role icon theme
    document.getElementById('sidebar-role-icon').classList.add(`role-gradient--${APP.role}`);
    document.getElementById('sidebar-role-label').textContent = ROLE_LABEL[APP.role];
  }

  async function setupPoblacionPill() {
    const pill = document.getElementById('poblacion-pill');
    const sel = document.getElementById('poblacion-select');
    if (!pill || !sel) return;
    try {
      const data = await API.get('/poblaciones');
      const opts = (data?.options || []);
      sel.innerHTML = opts.map((o) =>
        `<option value="${o.value}" ${o.enabled ? '' : 'disabled style="color:#94a3b8"'}>${o.value}${o.enabled ? '' : ' (no disponible)'}</option>`
      ).join('');
      sel.value = data.active;
      APP.poblacion = data.active;
      pill.classList.remove('hidden');
      pill.classList.add('flex');
      sel.addEventListener('change', () => {
        const opt = opts.find((o) => o.value === sel.value);
        if (!opt || !opt.enabled) {
          sel.value = APP.poblacion;
          window.MarzamToast?.show('Esa población aún no está habilitada en piloto', 'info');
          return;
        }
        APP.poblacion = sel.value;
        // Re-render del tab activo para que tome el filtro nuevo (si la vista lo usa).
        selectTab(APP.activeTab);
      });
    } catch (err) {
      console.warn('[app] poblaciones no disponibles', err);
    }
  }

  function setupModePill() {
    const pill = document.getElementById('mode-pill');
    if (APP.role === ROLES.REPRESENTANTE) {
      pill.classList.add('hidden');
      return;
    }
    pill.classList.remove('hidden');
    pill.classList.add('flex');
    pill.querySelectorAll('.mode-pill-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        APP.mode = btn.dataset.mode;
        pill.querySelectorAll('.mode-pill-btn').forEach((b) => b.classList.toggle('active', b === btn));
        if (APP.mode === 'team') selectTab('team');
        else selectTab('routes');
      });
    });
  }

  function setupVisitFAB() {
    const fab = document.getElementById('fab-start-visit');
    fab.classList.remove('hidden');
    fab.addEventListener('click', async () => {
      if (APP.activeSession) {
        await endVisitSession();
      } else {
        await startVisitSession();
      }
    });
    document.getElementById('vm-pill-end').addEventListener('click', async (e) => {
      e.stopPropagation();
      await endVisitSession();
    });
    document.getElementById('visit-mode-pill').addEventListener('click', () => {
      // Tap on pill jumps to routes view
      selectTab('routes');
    });
  }

  function setupUserMenu() {
    const menu = document.getElementById('user-menu');
    const btn = document.getElementById('user-menu-btn');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });
    document.addEventListener('click', () => menu.classList.add('hidden'));
  }

  /**
   * Habilita el botón flotante "‹" del panel para colapsarlo y revelar
   * el mapa al 100%. Click vuelve a abrirlo. Persiste el estado en
   * sessionStorage para que la preferencia sobreviva navegación entre tabs.
   */
  function setupCollapsePanel() {
    const btn = document.getElementById('btn-collapse-panel');
    const panel = document.getElementById('panel');
    if (!btn || !panel) return;
    const arrowOpen = '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M15 19l-7-7 7-7"/></svg>';
    const arrowClosed = '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>';
    const initial = sessionStorage.getItem('marzam_panel_collapsed') === '1';
    if (initial) panel.classList.add('panel-collapsed');
    btn.innerHTML = initial ? arrowClosed : arrowOpen;
    btn.setAttribute('aria-label', initial ? 'Mostrar panel' : 'Ocultar panel');
    btn.addEventListener('click', () => {
      const isCollapsed = panel.classList.toggle('panel-collapsed');
      btn.innerHTML = isCollapsed ? arrowClosed : arrowOpen;
      btn.setAttribute('aria-label', isCollapsed ? 'Mostrar panel' : 'Ocultar panel');
      sessionStorage.setItem('marzam_panel_collapsed', isCollapsed ? '1' : '0');
      // Re-fitea el mapa cuando cambia el espacio visible.
      setTimeout(() => { if (APP.map) APP.map.resize(); }, 320);
    });
  }

  /**
   * Mobile bottom-sheet drag — el `#panel-handle` (la barrita gris arriba
   * del panel en móvil) deja al usuario arrastrar el panel para revelar
   * más mapa (drag down) o cubrir el mapa (drag up).
   *
   * Estados snap (porcentaje de viewport hacia abajo desde top):
   *   - 'expanded'  →  0     (panel ocupa todo lo disponible bajo topbar)
   *   - 'half'      → 35vh   (estado neutro, lo que ve el user al cargar)
   *   - 'collapsed' → 70vh   (sólo el handle visible al fondo, encima del nav)
   *
   * El usuario suelta y snapeamos al estado más cercano.  Velocidad >0.5px/ms
   * fuerza la dirección (flick).
   *
   * No interfiere con scroll dentro del panel: si el touch empezó en el
   * body y el panel está en 'expanded', dejamos que el scroll suba.  El
   * drag SÓLO actúa cuando el touch nace en el handle.
   */
  function setupMobilePanelDrag() {
    const panel = document.getElementById('panel');
    const handle = document.getElementById('panel-handle');
    if (!panel || !handle) return;

    // Solo aplica en mobile.  En desktop el panel es lateral fijo.
    const isMobile = () => window.matchMedia('(max-width: 767px)').matches;

    // Snap targets en vh.  Si cambia el viewport (rotación), recomputamos.
    const SNAPS = { expanded: 0, half: 35, collapsed: 70 };
    let currentState = 'half';

    function applyState(state, animate = true) {
      currentState = state;
      panel.style.transition = animate ? 'transform 320ms cubic-bezier(0.32, 0.72, 0, 1)' : 'none';
      panel.style.transform = `translateY(${SNAPS[state]}vh)`;
      panel.dataset.state = state;
      // Sincroniza una clase en <body> para que CSS pueda condicionar
      // los overlays (legend del mapa, FAB) según el estado del panel.
      // No usamos el atributo del panel directamente porque el FAB y la
      // leyenda viven en el DOM ANTES o aparte del panel — el selector
      // `~` no aplica.
      document.body.classList.remove('panel-state-expanded', 'panel-state-half', 'panel-state-collapsed');
      document.body.classList.add(`panel-state-${state}`);
      // Re-fitea el mapa cuando cambia el área visible.
      setTimeout(() => { if (APP.map) APP.map.resize(); }, animate ? 350 : 0);
    }

    // Estado inicial: half cuando el viewport es móvil.
    if (isMobile()) applyState('half', false);

    let dragging = false;
    let startY = 0;
    let startTime = 0;
    let startTransformPx = 0;

    function viewportPx(vh) { return (window.innerHeight * vh) / 100; }

    function onStart(clientY) {
      if (!isMobile()) return;
      dragging = true;
      startY = clientY;
      startTime = Date.now();
      startTransformPx = viewportPx(SNAPS[currentState]);
      panel.style.transition = 'none';
    }

    function onMove(clientY, evt) {
      if (!dragging) return;
      evt?.preventDefault?.();
      const delta = clientY - startY;
      let nextPx = startTransformPx + delta;
      // Clamp entre expanded y collapsed (no permitir pasar más allá).
      const minPx = viewportPx(SNAPS.expanded);
      const maxPx = viewportPx(SNAPS.collapsed);
      if (nextPx < minPx) nextPx = minPx;
      if (nextPx > maxPx) nextPx = maxPx;
      panel.style.transform = `translateY(${nextPx}px)`;
    }

    function onEnd(clientY) {
      if (!dragging) return;
      dragging = false;
      const elapsed = Math.max(1, Date.now() - startTime);
      const delta = clientY - startY;
      const velocity = delta / elapsed; // px/ms — positivo = swipe down

      // Si fue un flick (>0.5 px/ms), respeta dirección.
      if (Math.abs(velocity) > 0.5) {
        if (velocity > 0) {
          // Swipe down: bajar al siguiente estado.
          if (currentState === 'expanded') return applyState('half');
          return applyState('collapsed');
        }
        // Swipe up: subir al siguiente estado.
        if (currentState === 'collapsed') return applyState('half');
        return applyState('expanded');
      }

      // Drag normal: snap al estado más cercano.
      const finalPx = startTransformPx + delta;
      const candidates = Object.entries(SNAPS).map(([k, vh]) => ({
        state: k,
        px: viewportPx(vh),
      }));
      candidates.sort((a, b) => Math.abs(a.px - finalPx) - Math.abs(b.px - finalPx));
      applyState(candidates[0].state);
    }

    // Touch
    handle.addEventListener('touchstart', (e) => onStart(e.touches[0].clientY), { passive: true });
    handle.addEventListener('touchmove',  (e) => onMove(e.touches[0].clientY, e), { passive: false });
    handle.addEventListener('touchend',   (e) => onEnd(e.changedTouches[0].clientY));

    // Mouse (DevTools, tablet con mouse)
    handle.addEventListener('mousedown', (e) => {
      onStart(e.clientY);
      const move = (ev) => onMove(ev.clientY, ev);
      const up = (ev) => {
        onEnd(ev.clientY);
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // Tap simple en el handle: alterna entre half y expanded.
    handle.addEventListener('click', (e) => {
      if (Math.abs((e.clientY || 0) - startY) > 5) return; // fue drag, no tap
      applyState(currentState === 'expanded' ? 'half' : 'expanded');
    });

    // Re-snap si cambia el tamaño del viewport (rotación, teclado virtual).
    window.addEventListener('resize', () => {
      if (isMobile()) applyState(currentState, false);
      else {
        // Salimos a desktop: limpia el transform inline para que las
        // utilities de Tailwind (md:translate-y-0) tomen control.
        panel.style.transform = '';
        panel.style.transition = '';
      }
    });
  }

  // ──────────────────────────────────────────────────────────
  // Tab switching
  // ──────────────────────────────────────────────────────────
  async function selectTab(tabId) {
    APP.activeTab = tabId;
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tabId));
    setPanelTitle(tabId);
    renderActions(tabId);
    // Wide panel for Analytics and Plan & Metas (also covers legacy aliases that resolve to them)
    const WIDE_TABS = new Set(['analytics', 'plan', 'planEditor', 'postMortem', 'targets', 'distribution']);
    document.getElementById('panel').classList.toggle('panel-wide', WIDE_TABS.has(tabId));
    const body = document.getElementById('panel-body');
    body.innerHTML = `<div class="space-y-3">${skeletonBlock()}${skeletonBlock()}${skeletonBlock()}</div>`;
    try {
      if (!window.MarzamViews) {
        throw new Error('Vistas no cargadas (MarzamViews undefined). Recarga la página con Ctrl+Shift+R.');
      }
      if (tabId === 'routes')          await window.MarzamViews.renderMyRoutes(body);
      else if (tabId === 'team')       await window.MarzamViews.renderMyTeam(body);
      else if (tabId === 'analytics')  await window.MarzamViews.renderAnalytics(body);
      else if (tabId === 'plan')       await window.MarzamViews.renderTargets(body);
      else if (tabId === 'live')       await window.MarzamViews.renderLiveOps(body);
      // Legacy aliases — old links/bookmarks redirect into the consolidated tab.
      else if (tabId === 'planEditor' || tabId === 'postMortem') {
        APP.activeTab = 'plan';
        document.querySelectorAll('.nav-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'plan'));
        setPanelTitle('plan');
        await window.MarzamViews.renderTargets(body);
      }
      // Aliases legacy por si algún deep-link o bookmark sigue apuntando
      // a los tabs viejos. Redirigen al nuevo tab unificado.
      else if (tabId === 'targets' || tabId === 'distribution') {
        APP.activeTab = 'plan';
        document.querySelectorAll('.nav-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'plan'));
        setPanelTitle('plan');
        await window.MarzamViews.renderTargets(body);
      }
    } catch (err) {
      console.error('[app] view render failed:', err);
      const msg = (err && err.message) || (err && err.error) || String(err);
      const stack = err && err.stack ? `<pre class="text-[10px] text-slate-400 mt-2 text-left overflow-auto max-h-40 bg-slate-50 p-2 rounded">${stack(err)}</pre>` : '';
      body.innerHTML = `
        <div class="text-center py-8 px-4">
          <div class="text-3xl mb-2">⚠️</div>
          <p class="text-rose-600 font-bold">Error cargando la vista</p>
          <p class="text-xs text-slate-500 mt-1">${msg}</p>
          ${stack}
          <button onclick="location.reload()" class="mt-4 btn btn-primary text-xs py-1.5 px-3">Recargar</button>
        </div>
      `;
    }
    function stack(e){ return (e.stack || '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  }

  function setPanelTitle(tabId) {
    const titles = {
      routes:    { title: APP.mode === 'team' ? 'Equipo · Plan del día' : 'Mis rutas', subtitle: APP.mode === 'team' ? 'Plan agregado de tu equipo' : `${ROLE_LABEL[APP.role]} · Plan del día` },
      team:      { title: 'Mi equipo', subtitle: 'Cascada · Tracking en vivo' },
      analytics: { title: 'Analíticas', subtitle: 'Cumplimiento, PARETO y tiempo' },
      plan:      { title: 'Plan & Metas', subtitle: 'Capacidad, overrides y cumplimiento mensual' },
      planEditor: { title: 'Planificar', subtitle: 'Mapa interactivo · drag & drop · ETAs reales' },
      live:      { title: 'En vivo', subtitle: 'Posiciones · alertas · jornada en curso' },
      postMortem:{ title: 'Análisis', subtitle: 'Plan vs ejecutado · replay · ranking' },
      // Aliases legacy — mismo título que el nuevo tab unificado.
      targets:      { title: 'Plan & Metas', subtitle: 'Capacidad, overrides y cumplimiento mensual' },
      distribution: { title: 'Plan & Metas', subtitle: 'Capacidad, overrides y cumplimiento mensual' },
    };
    const t = titles[tabId] || { title: '', subtitle: '' };
    document.getElementById('panel-title').textContent = t.title;
    document.getElementById('panel-subtitle').textContent = t.subtitle;
  }

  function renderActions(tabId) {
    const actions = document.getElementById('panel-header-actions');
    actions.innerHTML = '';

    // El botón "Nueva farmacia" se removió a propósito (Apr-30):
    // el universo de farmacias ya se sincroniza completo desde
    // `int_marzam_prospect_scored` (Marzam + prospectos), así que el alta
    // manual genera duplicados.  Para registrar una visita a un prospecto
    // ya en mapa, se usa el botón "Iniciar proceso" en cada parada del
    // plan diario (views.js → wireStopVisitButtons).
    //
    // Si en algún momento BlackPrint deja de tener cobertura completa y
    // hay que volver a permitir altas manuales, el wizard sigue vivo en
    // `window.MarzamOnboarding.openWizard()` — simplemente no hay
    // entrypoint visual.

    if (tabId === 'team') {
      actions.innerHTML = `
        <select id="team-level-filter" class="text-xs font-semibold bg-slate-100 border-0 rounded-lg px-2 py-1.5 outline-none">
          <option value="all">Todos los niveles</option>
          ${APP.role === ROLES.DIRECTOR ? '<option value="gerente_ventas">Gerentes</option>' : ''}
          ${[ROLES.DIRECTOR, ROLES.GERENTE].includes(APP.role) ? '<option value="supervisor">Supervisores</option>' : ''}
          <option value="representante">Representantes</option>
        </select>
      `;
    }
  }

  function skeletonBlock() {
    return '<div class="skeleton h-24 mb-3"></div>';
  }
  window.MarzamSkeleton = skeletonBlock;

  // ──────────────────────────────────────────────────────────
  // Map setup
  // ──────────────────────────────────────────────────────────
  function initMap() {
    const center = [-99.060, 19.605]; // Ecatepec
    // Carto basemaps: no API key required and no Referer policy issues
    // (unlike tile.openstreetmap.org which blocks anonymous browser referers).
    APP.map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: {
          carto: {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
              'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
              'https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
            ],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors © CARTO',
          },
        },
        layers: [{ id: 'carto', type: 'raster', source: 'carto' }],
      },
      center,
      zoom: 12.2,
    });
    window.APP_MAP = APP.map;
  }

  // ──────────────────────────────────────────────────────────
  // Visit Session lifecycle
  // ──────────────────────────────────────────────────────────
  async function loadActiveSession() {
    try {
      const session = await API.get(`/visit-sessions/active/${APP.user.id}`);
      if (session && session.id) setActiveSession(session);
    } catch { /* no-op */ }
  }

  async function startVisitSession() {
    try {
      const userInDemo = APP.isDemo ? DEMO_H.STORE.users.find((u) => u.id === APP.user.id) : null;
      const dayTarget = userInDemo ? (DEMO_H.STORE.day_targets[userInDemo.role] || 5) : 5;
      const session = await API.post('/visit-sessions/start', { pharmacies_planned: dayTarget });
      setActiveSession(session);
      window.MarzamToast?.show('Modo Visita iniciado · ¡A campo!', 'success');
      if (APP.activeTab === 'routes') selectTab('routes');
    } catch (err) {
      console.error(err);
      window.MarzamToast?.show('No se pudo iniciar Modo Visita', 'error');
    }
  }

  async function endVisitSession() {
    if (!APP.activeSession) return;
    try {
      const ended = await API.patch(`/visit-sessions/${APP.activeSession.id}/end`, { reason: 'manual' });
      const summary = { ...APP.activeSession, ...ended };
      clearActiveSession();
      window.MarzamViews?.showSessionSummary?.(summary);
    } catch (err) {
      console.error(err);
      window.MarzamToast?.show('Error al cerrar la sesión', 'error');
    }
  }

  function setActiveSession(session) {
    APP.activeSession = session;
    const pill = document.getElementById('visit-mode-pill');
    pill.classList.remove('hidden');
    document.getElementById('vm-pill-progress').textContent = `${session.pharmacies_visited || 0}/${session.pharmacies_planned || 0}`;
    document.getElementById('vm-pill-next').textContent = session.current_pharmacy || 'Comenzando ruta...';
    document.getElementById('fab-start-visit').innerHTML = `
      <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
      <span>Cerrar Modo Visita</span>
    `;
    document.getElementById('fab-start-visit').classList.add('!bg-rose-600');
    if (APP.timer) clearInterval(APP.timer);
    APP.timer = setInterval(updateTimer, 1000);
    updateTimer();
  }

  function clearActiveSession() {
    APP.activeSession = null;
    document.getElementById('visit-mode-pill').classList.add('hidden');
    if (APP.timer) clearInterval(APP.timer);
    APP.timer = null;
    document.getElementById('fab-start-visit').innerHTML = `
      <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4z"/></svg>
      <span>Iniciar Modo Visita</span>
    `;
    document.getElementById('fab-start-visit').classList.remove('!bg-rose-600');
  }

  function updateTimer() {
    if (!APP.activeSession) return;
    const start = Date.parse(APP.activeSession.started_at);
    const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    document.getElementById('vm-pill-timer').textContent = `${h}:${m}:${s}`;
  }

  // ──────────────────────────────────────────────────────────
  // Toast (small util)
  // ──────────────────────────────────────────────────────────
  window.MarzamToast = {
    show(text, kind = 'info') {
      const t = document.createElement('div');
      t.className = `fixed top-20 left-1/2 -translate-x-1/2 z-[300] px-4 py-2.5 rounded-xl shadow-2xl font-semibold text-sm backdrop-blur-md ${
        kind === 'success' ? 'bg-emerald-500/95 text-white' :
        kind === 'error' ? 'bg-rose-500/95 text-white' :
        'bg-slate-800/95 text-white'
      }`;
      t.textContent = text;
      document.body.appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, 2400);
    },
  };

  // ──────────────────────────────────────────────────────────
  // Modal helper
  // ──────────────────────────────────────────────────────────
  window.MarzamModal = {
    show({ title, html, footer }) {
      const root = document.getElementById('modals-root');
      const wrap = document.createElement('div');
      wrap.className = 'app-modal-backdrop';
      wrap.innerHTML = `
        <div class="app-modal-card">
          <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <h3 class="font-bold text-base text-slate-800">${title}</h3>
            <button class="modal-close p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6"/></svg>
            </button>
          </div>
          <div class="flex-1 overflow-y-auto p-5">${html}</div>
          ${footer ? `<div class="px-5 py-3 border-t border-slate-100 bg-slate-50 flex justify-end gap-2">${footer}</div>` : ''}
        </div>
      `;
      root.appendChild(wrap);
      const close = () => wrap.remove();
      wrap.querySelector('.modal-close').addEventListener('click', close);
      wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
      return { close, root: wrap };
    },
  };

  // Expose helpers
  window.MarzamApp = {
    ROLES, normalizeRole, ROLE_LABEL, ROLE_RANK,
    selectTab, setActiveSession, clearActiveSession,
    pushDrill(userId) { APP.drillStack.push(userId); selectTab('team'); },
    popDrill() { APP.drillStack.pop(); selectTab('team'); },
    drillStack() { return APP.drillStack.slice(); },
    state: APP,
  };
})();

// Views are loaded synchronously via <script> tag in app.html (after app.js).
