/**
 * DemoHierarchy — extends demo.js with the multi-level org features:
 *  - /api/team, /api/team/:userId
 *  - /api/analytics/team, /pareto-mix, /untouched
 *  - /api/visit-plans, /api/visit-targets
 *  - /api/visit-sessions/*
 *  - /api/tracking/positions, /breadcrumbs/:userId
 *
 * Activated when localStorage.marzam_demo === '1'. Loaded by app.js after demo.js.
 * Intercepts via the same monkey-patch pattern; falls through to demo.js when
 * the path is not multi-level related.
 */
(function () {
  'use strict';

  const DATASET_URL = '/data/demo-hierarchy.json';
  const ROLES = {
    DIRECTOR: 'director_sucursal',
    GERENTE: 'gerente_ventas',
    SUPERVISOR: 'supervisor',
    REPRESENTANTE: 'representante',
  };
  const PARETO_COLORS = { A: '#dc2626', B: '#f59e0b', C: '#2563eb' };
  const ROLE_RANK = {
    [ROLES.DIRECTOR]: 0, [ROLES.GERENTE]: 1,
    [ROLES.SUPERVISOR]: 2, [ROLES.REPRESENTANTE]: 3,
  };

  const STORE = {
    branches: [],
    users: [],
    pharmacies: [],         // Real-named pharmacies from ecatepec-demo.json (padrón Marzam)
    prospects: [],          // Farmacias NO en padrón Marzam (prospectos)
    visit_targets: [],
    visit_target_overrides: [],
    active_sessions: [],
    historical_sessions: [],
    visit_plans: [],
    visit_plan_assignments: [],
    visits: [],             // Synthetic visit history with outcome/distance/timestamp
    compliance_seeds: {},
    day_targets: {},
    role_pareto_default: {},
    untouched_seed: [],
    breadcrumbs: {},
    real_clients: null,     // Datos crudos de /api/marzam/clients (si BD reachable)
    real_branches: null,    // Datos crudos de /api/marzam/branches
    real_reps: null,        // Datos crudos de /api/marzam/representatives
  };

  // Reglas de negocio "Frecuencia y Efecto Espejo" (slide 23 de Estrategia
  // Comercial Abr-May 2026). Codificadas como datos para que la UI las pueda
  // renderizar sin hardcodearlas.
  const VISIT_RULES = {
    A: {
      label: 'PARETO A',
      eligible_roles: ['director_sucursal', 'gerente_ventas', 'supervisor', 'representante'],
      cadence_per_role: 'weekly',
      visits_per_role_per_month: 4,
      description: '1 vez/semana por cada rol (efecto espejo: 3-4 visitas distintas/sem)',
    },
    B: {
      label: 'PARETO B',
      eligible_roles: ['supervisor', 'representante'],
      cadence_per_role: 'biweekly',
      visits_per_role_per_month: 2,
      description: '1 vez cada 2 semanas por Supervisor y Representante',
    },
    C: {
      label: 'PARETO C',
      eligible_roles: ['representante'],
      cadence_per_role: 'monthly',
      visits_per_role_per_month: 1,
      description: '1 vez al mes por Representante',
    },
  };

  let _ready = false;
  let _readyPromise = null;
  let _idCounter = 1000;
  let _enrichmentDone = false;
  function genId(prefix) { return `${prefix}_${++_idCounter}`; }

  // Bypass-the-patch fetch helper. Used to call /api/marzam/* without being
  // intercepted by ourselves (which would create infinite recursion).
  async function fetchRaw(path, { timeoutMs = 8000 } = {}) {
    const token = localStorage.getItem('token');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch('/api' + path, {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  /* ========================================================================
   * Load + hydrate
   * ====================================================================== */
  async function load() {
    if (_ready) return STORE;
    if (_readyPromise) return _readyPromise;
    _readyPromise = (async () => {
      try {
        const res = await fetch(DATASET_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load hierarchy dataset');
        const data = await res.json();
        STORE.branches = data.branches || [];
        STORE.users = data.users || [];
        STORE.visit_targets = data.visit_targets || [];
        STORE.active_sessions_seed = data.active_sessions || [];
        STORE.compliance_seeds = data.compliance_seeds || {};
        STORE.day_targets = data.day_targets || {};
        STORE.role_pareto_default = data.role_pareto_default || {};
        STORE.untouched_seed = data.untouched_seed || [];
        hydrateActiveSessions();
        hydrateHistoricalSessions();
        hydrateBreadcrumbs();
        hydrateVisitPlans();
        await Promise.all([hydratePharmacies(), hydrateProspects()]);
        hydrateVisitHistory();
        // Asegura compliance seeds para 100% de los users (sintetiza si falta).
        ensureComplianceForAllUsers();
        _ready = true;
      } catch (err) {
        console.error('[demoHierarchy] hydration failed:', err);
        // Set ready anyway so the demo router doesn't fall through to backend.
        _ready = true;
      }
      // Fire-and-forget enrichment with real data from /api/marzam/*. Doesn't
      // block ready — views render with synthetic data first, then re-render
      // with real names if/when enrichment succeeds.
      enrichWithRealData().catch((err) => {
        console.warn('[demoHierarchy] real-data enrichment skipped:', err.message || err);
      });
      return STORE;
    })();
    return _readyPromise;
  }

  /**
   * Best-effort enrichment: pulls real names/branches/clients from
   * /api/marzam/* (the read-through layer that reads `josue_user` →
   * integration/staging schemas). Maps real reps to our synthetic slots
   * by role+order so the UI looks like real production data without
   * losing the deterministic demo structure.
   */
  async function enrichWithRealData() {
    if (_enrichmentDone) return;
    let payload;
    try {
      payload = await fetchRaw('/marzam/representatives', { timeoutMs: 10000 });
    } catch (err) {
      // BD inalcanzable o token expirado — mantenemos sintético.
      return;
    }
    // Endpoint puede devolver un array crudo o { total, reps }.
    const reps = Array.isArray(payload) ? payload : (payload && payload.reps) || [];
    if (!reps.length) return;

    STORE.real_reps = reps;

    const byRole = {
      director_sucursal: reps.filter((r) => r.role === 'director_sucursal'),
      gerente_ventas:    reps.filter((r) => r.role === 'gerente_ventas'),
      supervisor:        reps.filter((r) => r.role === 'supervisor'),
      representante:     reps.filter((r) => r.role === 'representante'),
    };

    // Reemplazar nombres sintéticos por reales, posición a posición.
    const KNOWN_DIRECTORS = ['Arturo Serrano', 'Carlos González'];
    STORE.users.forEach((u) => {
      if (u.role === 'director_sucursal') {
        const real = byRole.director_sucursal[0];
        if (real && real.full_name) u.full_name = humanize(real.full_name);
        else u.full_name = KNOWN_DIRECTORS[0];
        return;
      }
      const pool = byRole[u.role] || [];
      const idx = parseInt((u.id.match(/-(\d+)$/) || ['', '0'])[1], 10) - 1;
      const real = pool[idx];
      if (!real) return;
      if (real.full_name) u.full_name = humanize(real.full_name);
      if (real.poblacion) u.zone = humanize(real.poblacion);
      if (real.clave_cuadro_basico) u.clave_cuadro_basico = real.clave_cuadro_basico;
      if (real.gerencia_code) u.gerencia_code = real.gerencia_code;
      if (real.supervisor_code) u.supervisor_code = real.supervisor_code;
      if (real.agente_code) u.agente_code = real.agente_code;
      if (real.employee_code) u.real_employee_code = real.employee_code;
    });

    // Sintetizar usuarios extra cuando hay MÁS reps reales que sintéticos
    // — para que el director/gerente vean toda la jerarquía real, no solo
    // los 16 reps de demo. Conservan un id `u-rep-real-N` para no chocar
    // con los anchors del demo.
    addExtraRealUsers(byRole);

    // Clientes (farmacias en padrón) — pedimos un pool grande para que
    // director/gerente vean todas las del padrón, no solo 80.
    try {
      const clientsResp = await fetchRaw('/marzam/clients?limit=2000', { timeoutMs: 15000 });
      const clients = Array.isArray(clientsResp) ? clientsResp : (clientsResp && clientsResp.clients) || [];
      if (clients.length) STORE.real_clients = clients;
    } catch { /* mantenemos sintéticos */ }

    // Universo COMPLETO (Marzam + prospectos) desde /api/marzam/universe.
    // A diferencia de /marzam/clients (que da datos de detalle_mostrador
    // sin coords), este endpoint devuelve filas de la tabla LOCAL
    // `pharmacies` con lat/lng poblados — listas para pintar.
    //
    // Si responde con datos, REEMPLAZAMOS el contenido sintético de
    // STORE.pharmacies y STORE.prospects.  Así la leyenda y el mapa
    // reflejan la realidad de BD en vez de los JSONs estáticos.
    try {
      const universeResp = await fetchRaw('/marzam/universe?limit=10000', { timeoutMs: 20000 });
      if (universeResp) {
        const realMarzam = Array.isArray(universeResp.marzam) ? universeResp.marzam : [];
        const realProsp = Array.isArray(universeResp.prospects) ? universeResp.prospects : [];
        if (realMarzam.length || realProsp.length) {
          STORE.real_universe = universeResp;
          // Reemplaza pharmacies SOLO si llegan datos reales — si la BD
          // no tiene padrón sincronizado todavía, mantenemos sintético.
          if (realMarzam.length) {
            STORE.pharmacies = realMarzam.map((m) => ({
              id: m.id,
              name: m.name,
              address: m.address || '',
              municipality: m.municipality,
              state: m.state,
              lat: m.lat,
              lng: m.lng,
              pareto: m.pareto,
              quadrant: m.quadrant,
              final_score: m.final_score,
              dataplor_id: m.dataplor_id,
              clave_mostrador: m.clave_mostrador,
              business_type: m.business_type || 'pharmacy',
              category: m.category,
              // For Marzam clients: address-geocoded by BlackPrint.  Real
              // lat/lng from Marzam isn't available yet, so the FE warns
              // about location confidence using this score.
              geocoded_relevance: m.geocoded_relevance,
              is_marzam: true,
              source: 'marzam',
              status: 'active',
              assigned_rep_id: null,        // se asigna lazy si hace falta
              assigned_supervisor_id: null,
              last_visited_at: null,
            }));
          }
          if (realProsp.length) {
            STORE.prospects = realProsp.map((p) => ({
              id: p.id,
              name: p.name,
              address: p.address || '',
              municipality: p.municipality,
              state: p.state,
              lat: p.lat,
              lng: p.lng,
              // Tier for prospects is now derived from `quadrant` at render
              // time (Q1→A, Q2→B, Q3→C, Q4→D).  We keep the raw quadrant
              // so the FE has the full 4-bucket signal — `tier` is left
              // as a back-compat alias mirroring whatever pareto/tier_clean
              // the API still happens to send.
              quadrant: p.quadrant,
              tier: p.pareto,
              final_score: p.final_score,
              potential_score: p.final_score,
              business_type: p.business_type || 'pharmacy',
              category: p.category,
              // NULL for prospects — coords are field-collected (Dataplor).
              geocoded_relevance: p.geocoded_relevance,
              is_marzam: false,
              pareto: null,       // pareto sólo aplica a Marzam
              source: 'blackprint',
              assigned_rep_id: null,
            }));
          }
        }
      }
    } catch { /* mantenemos sintéticos */ }

    // Sucursales (gerencias) para display.
    try {
      const branchesResp = await fetchRaw('/marzam/branches', { timeoutMs: 8000 });
      const branches = Array.isArray(branchesResp) ? branchesResp : (branchesResp && branchesResp.branches) || [];
      if (branches.length) STORE.real_branches = branches;
    } catch { /* no-op */ }

    // Asegura que TODO usuario tenga compliance seed (sintetiza determinístico)
    ensureComplianceForAllUsers();

    _enrichmentDone = true;
    try { window.dispatchEvent(new CustomEvent('demoHierarchyEnriched')); } catch { /* no-op */ }
  }

  /**
   * Crea entradas u-XXX-real-N para reps reales que NO pudieron mapearse
   * 1-a-1 con los anchors sintéticos. Esto permite que el director vea
   * todos los gerentes/supervisores/reps reales en su jerarquía, en
   * lugar de quedarse con los 16 sintéticos de Ecatepec.
   */
  function addExtraRealUsers(byRole) {
    const colorByRole = {
      gerente_ventas: '#3B82F6',
      supervisor: '#10B981',
      representante: '#E5730A',
    };
    const directorAnchor = STORE.users.find((u) => u.role === 'director_sucursal');
    const directorId = directorAnchor ? directorAnchor.id : 'u-dir-001';

    Object.keys(byRole).forEach((role) => {
      if (role === 'director_sucursal') return;
      const pool = byRole[role];
      const existing = STORE.users.filter((u) => u.role === role).length;
      // Tomamos del pool real los que están más allá del slot sintético.
      pool.forEach((real, idx) => {
        if (idx < existing) return; // ya mapeado
        const empCode = real.employee_code || real.clave_cuadro_basico || `${role.slice(0, 3).toUpperCase()}_${idx}`;
        const newId = `u-${role.slice(0, 3)}-real-${idx + 1}`;
        if (STORE.users.some((u) => u.id === newId)) return;
        // Manager: para reps usamos el supervisor sintético/real más cercano
        // por código. Para supervisores → gerente. Para gerentes → director.
        let managerId = directorId;
        if (role === 'representante') {
          const supCode = real.supervisor_code || (real.employee_code || '').slice(0, 3);
          const sup = STORE.users.find((u) => u.role === 'supervisor' && u.supervisor_code === supCode);
          managerId = sup ? sup.id : directorId;
        } else if (role === 'supervisor') {
          const gerCode = real.gerencia_code || (real.employee_code || '').slice(0, 2);
          const ger = STORE.users.find((u) => u.role === 'gerente_ventas' && u.gerencia_code === gerCode);
          managerId = ger ? ger.id : directorId;
        }
        // Coordenadas: usamos las del manager como ancla para que el mapa
        // se vea coherente. Si no, centro de Ecatepec.
        const anchor = STORE.users.find((u) => u.id === managerId) || directorAnchor;
        const baseLat = anchor ? anchor.lat : 19.605;
        const baseLng = anchor ? anchor.lng : -99.060;
        STORE.users.push({
          id: newId,
          employee_code: empCode,
          clave_cuadro_basico: real.clave_cuadro_basico || empCode,
          agente_code: real.agente_code || null,
          supervisor_code: real.supervisor_code || null,
          gerencia_code: real.gerencia_code || null,
          full_name: humanize(real.full_name || empCode),
          role,
          branch_id: 'branch-ecatepec',
          manager_id: managerId,
          email: `${empCode.toLowerCase()}@marzam.mx`,
          zone: humanize(real.poblacion || 'Sucursal Ecatepec'),
          lat: baseLat + (Math.random() - 0.5) * 0.025,
          lng: baseLng + (Math.random() - 0.5) * 0.025,
          color: colorByRole[role] || '#64748B',
          is_real_extra: true,
        });
      });
    });
  }

  /**
   * Para cualquier user sin compliance_seed, genera uno determinístico
   * basado en su id (hash simple → bucket de cumplimiento). Así toda la
   * jerarquía tiene KPIs poblados aunque sean reps reales que no
   * estaban en el seed original.
   */
  function ensureComplianceForAllUsers() {
    STORE.users.forEach((u) => {
      if (STORE.compliance_seeds[u.id]) return;
      // Hash simple del id
      let h = 0;
      for (let i = 0; i < u.id.length; i++) h = ((h << 5) - h + u.id.charCodeAt(i)) | 0;
      const monthBase = 55 + Math.abs(h % 40);   // entre 55 y 95
      const todayBase = 30 + Math.abs((h * 13) % 70);
      const trend = [];
      for (let i = 0; i < 14; i++) {
        const wobble = ((h * (i + 7)) % 25) - 12;
        trend.push(Math.max(20, Math.min(100, monthBase + wobble)));
      }
      STORE.compliance_seeds[u.id] = { month: monthBase, today: todayBase, trend };
    });
  }

  // "MERCADO LOPEZ ADRIANA" → "Adriana Mercado López"-ish. Source data is
  // ALL CAPS surname-first; this just title-cases for display.
  function humanize(s) {
    if (!s || typeof s !== 'string') return s;
    return s.toLowerCase().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }

  function hydrateActiveSessions() {
    const now = Date.now();
    STORE.active_sessions = STORE.active_sessions_seed.map((s) => {
      const startedAt = new Date(now - s.started_minutes_ago * 60_000).toISOString();
      const lastPingAt = new Date(now - (s.last_idle_minutes || 0) * 60_000).toISOString();
      return {
        id: genId('vs'),
        user_id: s.user_id,
        started_at: startedAt,
        ended_at: null,
        pharmacies_planned: s.pharmacies_planned,
        pharmacies_visited: s.pharmacies_visited,
        total_distance_m: Math.round(s.pharmacies_visited * 1700 + Math.random() * 800),
        idle_seconds: (s.last_idle_minutes || 0) * 60,
        status: 'active',
        ended_reason: null,
        notes: null,
        current_pharmacy: s.current_pharmacy,
        last_ping_at: lastPingAt,
      };
    });
  }

  function hydrateHistoricalSessions() {
    // For each user with a seed, generate 8-14 finished sessions in the past 30 days
    const now = Date.now();
    Object.keys(STORE.compliance_seeds).forEach((userId) => {
      const user = STORE.users.find((u) => u.id === userId);
      if (!user) return;
      const dayTarget = STORE.day_targets[user.role] || 5;
      const trend = STORE.compliance_seeds[userId].trend || [];
      const numSessions = Math.min(trend.length, 14);
      for (let i = 0; i < numSessions; i++) {
        const dayOffset = numSessions - i;
        const start = new Date(now - dayOffset * 86_400_000 + 9 * 3600_000);
        const planned = dayTarget;
        const done = Math.round((trend[i] / 100) * planned);
        const durationMin = 240 + Math.random() * 180;
        const end = new Date(start.getTime() + durationMin * 60_000);
        STORE.historical_sessions.push({
          id: genId('vs-h'),
          user_id: userId,
          started_at: start.toISOString(),
          ended_at: end.toISOString(),
          pharmacies_planned: planned,
          pharmacies_visited: done,
          total_distance_m: Math.round(done * 1900 + 1500),
          idle_seconds: Math.round(durationMin * 60 * 0.15),
          status: 'ended',
          ended_reason: 'manual',
        });
      }
    });
  }

  function hydrateBreadcrumbs() {
    // Generate a 30-point breadcrumb trail for each active session, around their home zone
    STORE.active_sessions.forEach((session) => {
      const user = STORE.users.find((u) => u.id === session.user_id);
      if (!user) return;
      const startMs = Date.parse(session.started_at);
      const points = [];
      const totalPoints = Math.min(60, Math.floor((Date.now() - startMs) / 60_000));
      let lat = user.lat, lng = user.lng;
      for (let i = 0; i < totalPoints; i++) {
        const t = new Date(startMs + i * 60_000).toISOString();
        // Bias drift toward "moving around the zone"
        lat += (Math.random() - 0.5) * 0.0008;
        lng += (Math.random() - 0.5) * 0.0008;
        points.push({
          lat: +lat.toFixed(6),
          lng: +lng.toFixed(6),
          recorded_at: t,
          accuracy_meters: Math.round(8 + Math.random() * 18),
        });
      }
      STORE.breadcrumbs[session.user_id] = points;
    });
  }

  /**
   * Load real-named pharmacies from /data/ecatepec-demo.json (~2k entries
   * from BlackPrint with real names + addresses + lat/lng). Tag each with
   * a synthesized PARETO class so analytics can group by it. Then assign
   * each pharmacy to a rep based on geographic proximity (zone).
   */
  /**
   * Demo padron sizing — calibrated 1:1 against the real BQ count.
   *
   * En `marzam_clients` hoy hay 32 clientes reales (13 A, 11 B, 8 C).  El
   * demo refleja ese mismo conteo para que la leyenda del mapa cuadre con
   * la realidad: 32 Marzam + 180 prospectos = 212 puntos en total, ratio
   * ~15 % Marzam (vs el 40 % cuando teníamos 120 sintéticos).
   *
   * Cuando `enrichWithRealData()` consulta `/api/marzam/clients`, los
   * nombres y atributos se sobreescriben con los reales — manteniendo
   * los 32 placeholder coordenados con datos del dataset de Ecatepec
   * (que sí trae lat/lng, a diferencia de detalle_mostrador).
   *
   * Si en algún momento subimos el padrón real de Marzam, basta cambiar
   * este número.  La distribución 10/30/60 (A/B/C) se preserva siempre
   * vía la fórmula `r = (i * 13) % 100` en hydratePharmacies.
   */
  const DEMO_MARZAM_LIMIT = 32;

  async function hydratePharmacies() {
    try {
      const res = await fetch('/data/ecatepec-demo.json', { cache: 'no-cache' });
      if (!res.ok) return;
      const dataset = await res.json();
      const raw = dataset.pharmacies || [];
      if (!raw.length) return;

      // Distribución PARETO calibrada con el conteo real de `marzam_clients`
      // en BD (13 A / 11 B / 8 C de 32).  No es la pareto clásica 10/30/60
      // de retail genérico — el universo Marzam está sesgado a clientes de
      // alto revenue porque detalle_mostrador prioriza cuentas activas con
      // mostradores monitoreados.  Si el conteo de Marzam cambia, la regla
      // de proporciones aquí (40.6 % A · 34.4 % B · 25 % C) se preserva.
      const reps = STORE.users.filter((u) => u.role === ROLES.REPRESENTANTE);
      STORE.pharmacies = raw.slice(0, DEMO_MARZAM_LIMIT).map((p, i) => {
        const r = (i * 13) % 100;
        const pareto = r < 41 ? 'A' : r < 75 ? 'B' : 'C';
        let nearestRep = null;
        let nearestDist = Infinity;
        for (const rep of reps) {
          const d = Math.hypot((rep.lat - p.lat), (rep.lng - p.lng));
          if (d < nearestDist) { nearestDist = d; nearestRep = rep; }
        }
        return {
          id: p.id,
          name: p.name,
          chain: p.chain || null,
          address: p.address || '',
          municipality: p.municipality || 'Ecatepec',
          neighborhood: p.metadata?.neighborhood || null,
          postal_code: p.metadata?.postal_code || null,
          state: p.state || 'Estado de México',
          lat: p.lat,
          lng: p.lng,
          pareto,
          is_marzam: true,            // <-- está en padrón
          status: p.status || 'active',
          potential_score: p.potential_score || 0,
          assigned_rep_id: nearestRep ? nearestRep.id : null,
          assigned_supervisor_id: nearestRep ? nearestRep.manager_id : null,
          last_visited_at: null,
        };
      });
    } catch (err) {
      console.warn('[demoHierarchy] pharmacy hydration failed:', err.message || err);
    }
  }

  /**
   * Carga las farmacias prospecto (NO en padrón Marzam) desde
   * /data/prospectos-demo.json. Cada una se etiqueta `is_marzam: false`
   * y `pareto: null` para diferenciarlas en el mapa.
   *
   * Cache:
   *   `cache: 'no-cache'` fuerza al browser a revalidar contra el server
   *   en cada load (manda If-Modified-Since/ETag).  Antes era
   *   'force-cache', que servía una versión congelada y nos hacía mostrar
   *   prospectos sin el campo `quadrant` cada vez que regenerábamos el
   *   JSON.  No usamos 'no-store' porque queremos que el response se
   *   guarde en disk-cache para que el render inmediato sea rápido — sólo
   *   queremos que el browser confirme que sigue fresco.
   *
   * Salvaguardas:
   *   - Si por alguna razón un prospecto llega sin `quadrant`, lo derivamos
   *     en runtime desde `potential_score` con los mismos cortes que usa
   *     `scripts/generate-demo-prospects.js`.  Esto evita el síntoma que
   *     vimos en la leyenda (todos los 180 cayendo a Q4 por el fallback
   *     `p.quadrant || 'Q4'` en marzam-pharmacies-map.js).
   */
  async function hydrateProspects() {
    try {
      const res = await fetch('/data/prospectos-demo.json', { cache: 'no-cache' });
      if (!res.ok) return;
      const dataset = await res.json();
      const raw = dataset.prospects || [];
      if (!raw.length) return;
      STORE.prospects = raw.map((p) => ({
        ...p,
        is_marzam: false,
        pareto: null,
        assigned_rep_id: null,        // los prospectos no están asignados aún
        tier: p.tier || tierFromScore(p.potential_score),
      }));
    } catch (err) {
      console.warn('[demoHierarchy] prospect hydration failed:', err.message || err);
    }
  }

  /**
   * Mismos cortes que `scripts/generate-demo-prospects.js` y que la
   * columna `tier_clean` de BlackPrint (escala 0..100, A/B/C).
   */
  function tierFromScore(score) {
    const s = Number(score);
    if (!Number.isFinite(s)) return 'C';
    if (s >= 75) return 'A';
    if (s >= 45) return 'B';
    return 'C';
  }

  /**
   * Synthesize ~30 visits per active user over the last 30 days, with
   * realistic outcome distribution and distance metrics. Powers the rich
   * analytics view (outcome donut, distance compliance, anomalies, etc).
   */
  function hydrateVisitHistory() {
    if (!STORE.pharmacies.length) return;
    const OUTCOMES = [
      { code: 'visited',           weight: 50, label: 'Visitada' },
      { code: 'contact_made',      weight: 15, label: 'Contacto realizado' },
      { code: 'interested',        weight: 12, label: 'Interesado' },
      { code: 'needs_follow_up',   weight: 8,  label: 'Requiere seguimiento' },
      { code: 'not_interested',    weight: 5,  label: 'No interesado' },
      { code: 'closed',            weight: 4,  label: 'Cerrado' },
      { code: 'invalid',           weight: 3,  label: 'No existe / inválido' },
      { code: 'chain_not_independent', weight: 2, label: 'Cadena' },
      { code: 'duplicate',         weight: 1,  label: 'Duplicado' },
    ];
    const totalWeight = OUTCOMES.reduce((s, o) => s + o.weight, 0);
    const pickOutcome = (seed) => {
      let r = (seed * 9301 + 49297) % totalWeight;
      for (const o of OUTCOMES) { if ((r -= o.weight) < 0) return o.code; }
      return 'visited';
    };
    const now = Date.now();
    const visits = [];
    let visitId = 0;

    STORE.users.forEach((user) => {
      const seed = STORE.compliance_seeds[user.id];
      if (!seed) return;
      const dayTarget = STORE.day_targets[user.role] || 5;
      // For each of the last 14 days, generate ~target visits scaled by trend pct
      const trend = seed.trend || [];
      for (let day = 0; day < trend.length; day++) {
        const pct = trend[day] / 100;
        const count = Math.max(0, Math.round(dayTarget * pct));
        const dayBase = now - (trend.length - 1 - day) * 86_400_000;
        // Pharmacies pool relevant to this user (assigned + nearby fallback)
        const myPharmacies = STORE.pharmacies.filter((p) => p.assigned_rep_id === user.id);
        const pool = myPharmacies.length ? myPharmacies : STORE.pharmacies.slice(0, 60);
        for (let i = 0; i < count; i++) {
          const ph = pool[(visitId * 7 + i) % pool.length];
          if (!ph) break;
          const outcome = pickOutcome(visitId + day * 31);
          // Distance: 75% within 50m, 15% 50-200, 7% 200-500, 3% >500m.
          const r = (visitId * 17 + day * 53) % 100;
          let distance;
          if (r < 75) distance = Math.round(Math.random() * 50);
          else if (r < 90) distance = Math.round(50 + Math.random() * 150);
          else if (r < 97) distance = Math.round(200 + Math.random() * 300);
          else distance = Math.round(550 + Math.random() * 1500);
          // Time of day: 9am-7pm bell curve
          const hour = 9 + Math.floor(((visitId + i) * 7) % 10);
          const minute = ((visitId + i) * 13) % 60;
          const ts = new Date(dayBase);
          ts.setHours(hour, minute, 0, 0);
          visits.push({
            id: `v${++visitId}`,
            pharmacy_id: ph.id,
            pharmacy_name: ph.name,
            pharmacy_lat: ph.lat,
            pharmacy_lng: ph.lng,
            pharmacy_pareto: ph.pareto,
            user_id: user.id,
            user_role: user.role,
            outcome,
            distance_to_pharmacy_m: distance,
            distance_warning: distance > 500,
            checkin_lat: ph.lat + (Math.random() - 0.5) * 0.001 * (distance / 100),
            checkin_lng: ph.lng + (Math.random() - 0.5) * 0.001 * (distance / 100),
            recorded_at: ts.toISOString(),
          });
        }
      }
    });
    STORE.visits = visits;
  }

  function hydrateVisitPlans() {
    // Synthesize one monthly plan per supervisor (scope = their reps)
    const supervisors = STORE.users.filter((u) => u.role === ROLES.SUPERVISOR);
    const today = new Date();
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    supervisors.forEach((sup) => {
      const reps = STORE.users.filter((u) => u.manager_id === sup.id);
      const plan = {
        id: genId('vp'),
        owner_user_id: sup.id,
        scope_user_id: sup.id,
        branch_id: sup.branch_id,
        granularity: 'monthly',
        period_start: monthStart.toISOString().slice(0, 10),
        period_end: monthEnd.toISOString().slice(0, 10),
        status: 'published',
        owner_name: sup.full_name,
        scope_user_name: sup.full_name,
        created_at: new Date(today.getTime() - 4 * 86_400_000).toISOString(),
        config: {
          targets_snapshot: STORE.visit_targets,
          scope_user_ids: reps.map((r) => r.id),
        },
      };
      STORE.visit_plans.push(plan);
    });
  }

  /* ========================================================================
   * Helpers
   * ====================================================================== */
  function getCurrentUser() {
    try {
      const stored = JSON.parse(localStorage.getItem('user'));
      if (!stored) return null;
      // 1) Match by id
      let match = STORE.users.find((u) => u.id === stored.id);
      if (match) return match;
      // 2) Stale localStorage from a previous demo (e.g. "mgr-demo"): fall back
      //    to the canonical demo anchor whose role matches the stored user.
      if (stored.role) {
        const ANCHORS = {
          director_sucursal: 'u-dir-001',
          gerente_ventas:    'u-ger-001',
          supervisor:        'u-sup-001',
          representante:     'u-rep-001',
          // Legacy aliases still floating around in old localStorage payloads.
          manager:    'u-dir-001',
          field_rep:  'u-rep-001',
        };
        const anchorId = ANCHORS[stored.role];
        if (anchorId) {
          match = STORE.users.find((u) => u.id === anchorId);
          if (match) return match;
        }
      }
      // 3) Match by email as last resort
      if (stored.email) {
        match = STORE.users.find((u) => u.email === stored.email);
        if (match) return match;
      }
      return stored;
    } catch { return null; }
  }

  function getDescendants(userId) {
    const out = [];
    const queue = [userId];
    while (queue.length) {
      const id = queue.shift();
      const directs = STORE.users.filter((u) => u.manager_id === id);
      for (const d of directs) {
        out.push(d);
        queue.push(d.id);
      }
    }
    return out;
  }

  function getDirectReports(userId) {
    return STORE.users.filter((u) => u.manager_id === userId);
  }

  function isAncestor(actorId, targetId) {
    let cur = STORE.users.find((u) => u.id === targetId);
    while (cur && cur.manager_id) {
      if (cur.manager_id === actorId) return true;
      cur = STORE.users.find((u) => u.id === cur.manager_id);
    }
    return false;
  }

  function metricsFor(userId, { dateFrom, dateTo } = {}) {
    const seed = STORE.compliance_seeds[userId];
    const user = STORE.users.find((u) => u.id === userId);
    if (!seed || !user) {
      return { planned: 0, done: 0, planned_today: 0, done_today: 0, compliance_pct: null };
    }
    const dayTarget = STORE.day_targets[user.role] || 5;
    const trend = seed.trend || [];
    const today = new Date().toISOString().slice(0, 10);
    const from = dateFrom || today.slice(0, 7) + '-01';
    const to = dateTo || today;
    const fromTime = Date.parse(from + 'T00:00:00Z');
    const toTime = Date.parse(to + 'T00:00:00Z');
    const days = Math.floor((toTime - fromTime) / 86_400_000) + 1;
    const planned = days * dayTarget;
    const done = Math.round((seed.month / 100) * planned);
    return {
      planned,
      done,
      planned_today: dayTarget,
      done_today: Math.round((seed.today / 100) * dayTarget),
      compliance_pct: seed.month,
    };
  }

  function presenceFor(userId) {
    const session = STORE.active_sessions.find((s) => s.user_id === userId);
    if (!session) return { status: 'offline', last_seen: null };
    const idle = session.idle_seconds || 0;
    if (idle > 15 * 60) return { status: 'idle', last_seen: session.last_ping_at, session };
    return { status: 'live', last_seen: session.last_ping_at, session };
  }

  function userWithExtras(user, opts = {}) {
    return {
      ...user,
      // Plan Editor expects home_lat/home_lng; demo stores the position as lat/lng.
      home_lat: user.home_lat ?? user.lat ?? null,
      home_lng: user.home_lng ?? user.lng ?? null,
      has_home: (user.home_lat ?? user.lat) != null,
      metrics: metricsFor(user.id, opts),
      presence: presenceFor(user.id),
      sparkline: (STORE.compliance_seeds[user.id] || {}).trend || [],
    };
  }

  const OUTCOME_LABELS = {
    visited: 'Visitada',
    contact_made: 'Contacto realizado',
    interested: 'Interesado',
    needs_follow_up: 'Requiere seguimiento',
    not_interested: 'No interesado',
    closed: 'Cerrado',
    invalid: 'No existe / inválido',
    chain_not_independent: 'Cadena',
    duplicate: 'Duplicado',
    moved: 'Se mudó',
    wrong_category: 'Categoría incorrecta',
  };
  function outcomeLabel(code) { return OUTCOME_LABELS[code] || code; }

  /* ========================================================================
   * Routes
   * ====================================================================== */
  function matchPath(pattern, path) {
    const patParts = pattern.split('/');
    const pathParts = path.split('/');
    if (patParts.length !== pathParts.length) return null;
    const params = {};
    for (let i = 0; i < patParts.length; i++) {
      if (patParts[i].startsWith(':')) params[patParts[i].slice(1)] = pathParts[i];
      else if (patParts[i] !== pathParts[i]) return null;
    }
    return params;
  }

  // Route handler contract:
  //   - Returns `undefined` when this router does NOT handle the path
  //     (so the caller falls through to the next interceptor or the
  //     real backend).
  //   - Any other value (including `null`, `[]`, `{}`) is a valid response.
  // List of path prefixes/exact-paths this router OWNS. When in demo mode,
  // any request to these paths must NEVER fall through to the real backend
  // (which doesn't have the destination tables yet).
  const OWNED_PATHS = [
    '/team', '/analytics/team', '/analytics/pareto-mix', '/analytics/untouched', '/analytics/funnel',
    '/visit-plans', '/visit-targets', '/visit-targets/resolve', '/visit-targets/overrides',
    '/visit-sessions',
    '/tracking/positions', '/tracking/breadcrumbs/',
    '/auth/impersonate',
  ];

  function isOwnedPath(url) {
    return OWNED_PATHS.some((p) => url === p || url.startsWith(p + '/') || url.startsWith(p + '?'));
  }

  function route(method, path, body) {
    if (!_ready) return undefined;
    const url = path.split('?')[0];
    const queryString = path.split('?')[1] || '';
    const query = Object.fromEntries(new URLSearchParams(queryString));
    let params;
    const me = getCurrentUser();
    const isDemo = localStorage.getItem('marzam_demo') === '1';

    /* ── /auth/me with full user shape ─────────────────────────── */
    if (method === 'GET' && url === '/auth/me' && me) {
      return { ...me };
    }

    /* ── /auth/users (people I can impersonate / see) ──────────── */
    if (method === 'GET' && url === '/auth/users' && me) {
      const descendants = getDescendants(me.id);
      return [me, ...descendants].map((u) => ({
        id: u.id,
        email: u.email,
        full_name: u.full_name,
        role: u.role,
        is_active: true,
        created_at: '2026-01-01T00:00:00Z',
      }));
    }

    /* ── /auth/impersonate ─────────────────────────────────────── */
    if (method === 'POST' && url === '/auth/impersonate' && me) {
      const targetId = body && body.target_user_id;
      const target = STORE.users.find((u) => u.id === targetId);
      if (!target) return { error: 'Target user not found', status: 404 };
      if (!isAncestor(me.id, targetId) && me.id !== targetId) {
        return { error: 'Forbidden', status: 403 };
      }
      const userPayload = {
        id: target.id, email: target.email, full_name: target.full_name,
        role: target.role, employee_code: target.employee_code,
        impersonated_by: me.id, original_role: me.role,
      };
      return { token: `demo_imp_${target.id}`, user: userPayload, impersonated_by: me.id };
    }
    if (method === 'POST' && url === '/auth/impersonate/stop' && me) {
      const original = JSON.parse(localStorage.getItem('marzam_original_user') || 'null');
      const restored = original || me;
      return { token: `demo_${restored.id}`, user: restored };
    }

    /* ── /team/descendants — flat list used by Plan Editor ─────── */
    if (method === 'GET' && url === '/team/descendants' && me) {
      const descendants = getDescendants(me.id);
      return descendants.map((u) => userWithExtras(u, query));
    }

    /* ── /team — cascade for current user ──────────────────────── */
    if (method === 'GET' && url === '/team' && me) {
      const descendants = getDescendants(me.id);
      const byRole = {};
      descendants.forEach((u) => {
        if (!byRole[u.role]) byRole[u.role] = [];
        byRole[u.role].push(userWithExtras(u, query));
      });
      return {
        descendants: descendants.map((u) => userWithExtras(u, query)),
        by_role: byRole,
        actor: userWithExtras(me, query),
      };
    }

    /* ── /team/:userId — drill-down ────────────────────────────── */
    if (method === 'GET' && (params = matchPath('/team/:userId', url)) && me) {
      const target = STORE.users.find((u) => u.id === params.userId);
      if (!target) return { error: 'User not found', status: 404 };
      if (target.id !== me.id && !isAncestor(me.id, target.id)) {
        return { error: 'Forbidden', status: 403 };
      }
      const reports = getDirectReports(target.id);
      return {
        user: userWithExtras(target, query),
        direct_reports: reports.map((r) => userWithExtras(r, query)),
      };
    }

    /* ── /analytics/team — heatmap ─────────────────────────────── */
    if (method === 'GET' && url === '/analytics/team' && me) {
      const scopeId = query.scope_user_id || me.id;
      const scopeUser = STORE.users.find((u) => u.id === scopeId);
      if (!scopeUser) return { rows: [], users: [] };
      let userIds;
      if (scopeId === me.id) {
        const descendants = getDescendants(me.id);
        userIds = descendants.map((d) => d.id);
        if (!userIds.length) userIds = [me.id];
      } else {
        const desc = getDescendants(scopeId);
        userIds = [scopeId, ...desc.map((d) => d.id)];
      }
      const today = new Date();
      const from = query.date_from || today.toISOString().slice(0, 7) + '-01';
      const to = query.date_to || today.toISOString().slice(0, 10);
      const fromTime = Date.parse(from + 'T00:00:00Z');
      const toTime = Date.parse(to + 'T00:00:00Z');
      const days = Math.floor((toTime - fromTime) / 86_400_000) + 1;
      const users = userIds.map((id) => {
        const u = STORE.users.find((x) => x.id === id);
        return u ? { user_id: u.id, full_name: u.full_name, role: u.role } : null;
      }).filter(Boolean);
      const rows = [];
      userIds.forEach((id) => {
        const u = STORE.users.find((x) => x.id === id);
        const seed = STORE.compliance_seeds[id];
        if (!u || !seed) return;
        const dayTarget = STORE.day_targets[u.role] || 5;
        for (let d = 0; d < days; d++) {
          const date = new Date(fromTime + d * 86_400_000).toISOString().slice(0, 10);
          const trendIdx = seed.trend.length - days + d;
          const pct = trendIdx >= 0 ? seed.trend[trendIdx] : seed.month;
          const planned = dayTarget;
          const done = Math.round((pct / 100) * planned);
          rows.push({
            user_id: id,
            date,
            planned,
            done,
            compliance_pct: planned > 0 ? Math.round((done / planned) * 1000) / 10 : null,
          });
        }
      });
      return { period: { from, to }, users, rows };
    }

    /* ── /analytics/pareto-mix ─────────────────────────────────── */
    if (method === 'GET' && url === '/analytics/pareto-mix' && me) {
      const scopeId = query.scope_user_id || me.id;
      let userIds;
      if (scopeId === me.id) {
        userIds = [me.id, ...getDescendants(me.id).map((d) => d.id)];
      } else {
        userIds = [scopeId, ...getDescendants(scopeId).map((d) => d.id)];
      }
      // Allocation: A → director+gerente, B → supervisor, C → representante
      const out = { A: { planned: 0, done: 0 }, B: { planned: 0, done: 0 }, C: { planned: 0, done: 0 } };
      userIds.forEach((id) => {
        const u = STORE.users.find((x) => x.id === id);
        const seed = STORE.compliance_seeds[id];
        if (!u || !seed) return;
        const pareto = STORE.role_pareto_default[u.role] || 'C';
        const dayTarget = STORE.day_targets[u.role] || 5;
        const planned = dayTarget * 22;
        const done = Math.round((seed.month / 100) * planned);
        out[pareto].planned += planned;
        out[pareto].done += done;
      });
      return ['A', 'B', 'C'].map((p) => ({ pareto: p, planned: out[p].planned, done: out[p].done }));
    }

    /* ── /analytics/untouched ──────────────────────────────────── */
    if (method === 'GET' && url === '/analytics/untouched' && me) {
      // Build from real pharmacy pool: pharmacies with no recent visit.
      const cutoff = Date.now() - 30 * 86_400_000;
      const recentlyVisited = new Set(
        STORE.visits.filter((v) => Date.parse(v.recorded_at) > cutoff).map((v) => v.pharmacy_id),
      );
      const list = STORE.pharmacies
        .filter((p) => !recentlyVisited.has(p.id) && p.pareto !== 'C')
        .slice(0, 12)
        .map((p) => ({
          cpadre: p.id,
          farmacia_nombre: p.name,
          pareto: p.pareto,
          delegacion_municipio: p.municipality,
          neighborhood: p.neighborhood,
          days_without: 30 + Math.floor(Math.random() * 25),
          last_visited_at: null,
          owner_role: p.pareto === 'A' ? 'gerente_ventas' : 'supervisor',
        }))
        .sort((a, b) => b.days_without - a.days_without);
      return list.length ? list : STORE.untouched_seed;
    }

    /* ── /analytics/funnel — agregados ricos ─────────────────── */
    if (method === 'GET' && url === '/analytics/funnel' && me) {
      const scopeId = query.scope_user_id || me.id;
      const filterRole = query.role || null;
      const filterUser = query.user_id || null;
      const days = Number(query.days) || 30;
      const cutoff = Date.now() - days * 86_400_000;

      // Determine scope userIds
      let userIds;
      if (scopeId === me.id) {
        userIds = [me.id, ...getDescendants(me.id).map((d) => d.id)];
      } else {
        userIds = [scopeId, ...getDescendants(scopeId).map((d) => d.id)];
      }
      if (filterRole) userIds = userIds.filter((id) => {
        const u = STORE.users.find((x) => x.id === id);
        return u && u.role === filterRole;
      });
      if (filterUser) userIds = userIds.filter((id) => id === filterUser);
      const userIdSet = new Set(userIds);

      const visits = STORE.visits.filter((v) =>
        userIdSet.has(v.user_id) && Date.parse(v.recorded_at) > cutoff,
      );

      // Outcome breakdown
      const byOutcome = {};
      visits.forEach((v) => { byOutcome[v.outcome] = (byOutcome[v.outcome] || 0) + 1; });

      // Distance compliance buckets
      const distance = { '0-50': 0, '50-200': 0, '200-500': 0, '500+': 0 };
      visits.forEach((v) => {
        const d = v.distance_to_pharmacy_m || 0;
        if (d <= 50) distance['0-50']++;
        else if (d <= 200) distance['50-200']++;
        else if (d <= 500) distance['200-500']++;
        else distance['500+']++;
      });

      // Per-user aggregates
      const perUser = {};
      visits.forEach((v) => {
        if (!perUser[v.user_id]) perUser[v.user_id] = {
          user_id: v.user_id, total: 0, far_checkins: 0, invalid_count: 0,
          interested_count: 0, last_visit_at: null,
        };
        const u = perUser[v.user_id];
        u.total += 1;
        if (v.distance_warning) u.far_checkins += 1;
        if (v.outcome === 'invalid') u.invalid_count += 1;
        if (v.outcome === 'interested') u.interested_count += 1;
        if (!u.last_visit_at || Date.parse(v.recorded_at) > Date.parse(u.last_visit_at)) {
          u.last_visit_at = v.recorded_at;
        }
      });
      const userList = Object.values(perUser).map((u) => {
        const userObj = STORE.users.find((x) => x.id === u.user_id) || {};
        return {
          ...u,
          full_name: userObj.full_name || u.user_id,
          role: userObj.role,
          zone: userObj.zone,
          compliance_pct: STORE.compliance_seeds[u.user_id]?.month || null,
          far_pct: u.total > 0 ? Math.round((u.far_checkins / u.total) * 100) : 0,
        };
      });

      // Top / bottom by visits
      const topByVisits = userList.slice().sort((a, b) => b.total - a.total).slice(0, 5);
      const bottomByCompliance = userList.slice()
        .filter((u) => u.compliance_pct != null)
        .sort((a, b) => (a.compliance_pct || 0) - (b.compliance_pct || 0))
        .slice(0, 5);

      // Anomalies feed (most recent first)
      const anomalies = [];
      visits.slice().reverse().forEach((v) => {
        if (anomalies.length >= 12) return;
        if (v.distance_warning) {
          const u = STORE.users.find((x) => x.id === v.user_id);
          anomalies.push({
            type: 'far_checkin',
            severity: v.distance_to_pharmacy_m > 1000 ? 'high' : 'medium',
            title: `${u?.full_name || v.user_id} hizo checkin a ${v.distance_to_pharmacy_m}m`,
            detail: `${v.pharmacy_name} · ${v.outcome}`,
            recorded_at: v.recorded_at,
            user_id: v.user_id,
          });
        } else if (v.outcome === 'invalid' || v.outcome === 'duplicate') {
          const u = STORE.users.find((x) => x.id === v.user_id);
          anomalies.push({
            type: 'invalid',
            severity: 'low',
            title: `${u?.full_name || v.user_id} reportó "${v.outcome}"`,
            detail: v.pharmacy_name,
            recorded_at: v.recorded_at,
            user_id: v.user_id,
          });
        }
      });

      // Hourly distribution
      const hourly = Array.from({ length: 12 }, (_, h) => ({ hour: h + 8, count: 0 }));
      visits.forEach((v) => {
        const h = new Date(v.recorded_at).getHours();
        const slot = hourly.find((s) => s.hour === h);
        if (slot) slot.count += 1;
      });

      // Coverage of padron
      const totalPadron = STORE.pharmacies.length;
      const covered = new Set(visits.map((v) => v.pharmacy_id)).size;

      return {
        period: { days, from: new Date(cutoff).toISOString().slice(0, 10) },
        scope: { user_ids: userIds.slice(0, 50), size: userIds.length },
        totals: {
          visits: visits.length,
          unique_pharmacies_covered: covered,
          padron_size: totalPadron,
          coverage_pct: totalPadron > 0 ? Math.round((covered / totalPadron) * 100) : 0,
          far_checkins: distance['200-500'] + distance['500+'],
          invalid_pharmacies: byOutcome.invalid || 0,
          interested: byOutcome.interested || 0,
        },
        outcome_breakdown: Object.entries(byOutcome)
          .map(([code, count]) => ({ code, count, label: outcomeLabel(code) }))
          .sort((a, b) => b.count - a.count),
        distance_buckets: Object.entries(distance).map(([bucket, count]) => ({ bucket, count })),
        per_user: userList.sort((a, b) => b.total - a.total),
        top_performers: topByVisits,
        underperformers: bottomByCompliance,
        anomalies,
        hourly_distribution: hourly,
      };
    }

    /* ── /visit-plans (list/get) ───────────────────────────────── */
    if (method === 'GET' && url === '/visit-plans' && me) {
      const visible = STORE.visit_plans.filter((p) =>
        p.owner_user_id === me.id ||
        p.scope_user_id === me.id ||
        isAncestor(me.id, p.scope_user_id),
      );
      return visible;
    }
    if (method === 'GET' && (params = matchPath('/visit-plans/:id', url)) && me) {
      const plan = STORE.visit_plans.find((p) => p.id === params.id);
      if (!plan) return { error: 'Plan not found', status: 404 };
      return { ...plan, assignments: [] };
    }
    if (method === 'POST' && url === '/visit-plans' && me) {
      const plan = {
        id: genId('vp'),
        owner_user_id: me.id,
        scope_user_id: body.scope_user_id || me.id,
        branch_id: me.branch_id,
        granularity: body.granularity || 'monthly',
        period_start: body.period_start,
        period_end: body.period_end,
        status: 'draft',
        config: body.config || {},
        owner_name: me.full_name,
        scope_user_name: me.full_name,
        created_at: new Date().toISOString(),
      };
      STORE.visit_plans.push(plan);
      return plan;
    }
    if (method === 'POST' && url === '/visit-plans/preview' && me) {
      const targets = body.targets || STORE.visit_targets;
      const scopeIds = body.scope_user_ids || [me.id, ...getDescendants(me.id).map((d) => d.id)];
      const scopeUsers = STORE.users.filter((u) => scopeIds.includes(u.id));
      let totalEstimated = 0;
      const workingDays = 22;
      scopeUsers.forEach((u) => {
        const target = targets.find((t) => t.role === u.role && t.channel !== 'contact_center');
        if (target) totalEstimated += target.daily_contacts_per_person * workingDays;
      });
      return {
        total_estimated: totalEstimated,
        coverage_pct: Math.min(100, Math.round((totalEstimated / 5000) * 100)),
        working_days: workingDays,
        scope_size: scopeUsers.length,
      };
    }

    /* ── /visit-targets ────────────────────────────────────────── */
    if (method === 'GET' && url === '/visit-targets' && me) {
      return STORE.visit_targets;
    }
    if (method === 'POST' && url === '/visit-targets' && me) {
      const idx = STORE.visit_targets.findIndex((t) => t.role === body.role && t.pareto_class === body.pareto_class && t.channel === (body.channel || 'visit'));
      if (idx >= 0) {
        STORE.visit_targets[idx] = { ...STORE.visit_targets[idx], ...body };
        return STORE.visit_targets[idx];
      }
      STORE.visit_targets.push(body);
      return body;
    }

    /* ── /visit-targets/resolve ──────────────────────────────── */
    // Returns the effective daily_contacts_per_person for (user_id, pareto)
    // following the resolution chain: override → branch default → global.
    if (method === 'GET' && url === '/visit-targets/resolve' && me) {
      const userId = query.user_id;
      const pareto = query.pareto || query.pareto_class;
      if (!userId || !pareto) return { value: null, source: 'none' };
      const target = STORE.users.find((u) => u.id === userId);
      if (!target) return { value: null, source: 'none' };

      // 1) Override
      const override = STORE.visit_target_overrides
        .filter((o) => o.subordinate_user_id === userId && o.pareto_class === pareto)
        .sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from))[0];
      if (override) {
        return {
          value: override.daily_contacts_per_person,
          source: 'override',
          set_by_user_id: override.set_by_user_id,
          set_by_name: override.set_by_name,
          set_by_role: override.set_by_role,
          effective_from: override.effective_from,
          reason: override.reason,
        };
      }
      // 2) Branch default for the user's role
      const branch = STORE.visit_targets.find((t) =>
        t.role === target.role && t.pareto_class === pareto && (t.channel || 'visit') === 'visit',
      );
      if (branch) {
        return { value: branch.daily_contacts_per_person, source: 'branch_default' };
      }
      return { value: null, source: 'none' };
    }

    /* ── /visit-targets/overrides/:userId ────────────────────── */
    if (method === 'GET' && (params = matchPath('/visit-targets/overrides/:userId', url)) && me) {
      const target = params.userId;
      if (target !== me.id && !isAncestor(me.id, target)) return [];
      return STORE.visit_target_overrides
        .filter((o) => o.subordinate_user_id === target)
        .sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from));
    }

    if (method === 'POST' && url === '/visit-targets/overrides' && me) {
      const subId = body.subordinate_user_id;
      const sub = STORE.users.find((u) => u.id === subId);
      if (!sub) return { error: 'Subordinate not found', status: 404 };
      if (!isAncestor(me.id, subId)) return { error: 'Forbidden', status: 403 };

      const override = {
        id: genId('vto'),
        subordinate_user_id: subId,
        set_by_user_id: me.id,
        set_by_name: me.full_name,
        set_by_role: me.role,
        pareto_class: body.pareto_class,
        channel: body.channel || 'visit',
        daily_contacts_per_person: Number(body.daily_contacts_per_person) || 0,
        reason: body.reason || null,
        effective_from: body.effective_from || new Date().toISOString().slice(0, 10),
      };

      // Close any prior active override for the same (sub, pareto)
      STORE.visit_target_overrides = STORE.visit_target_overrides.filter(
        (o) => !(o.subordinate_user_id === subId && o.pareto_class === body.pareto_class),
      );
      STORE.visit_target_overrides.push(override);
      return override;
    }

    /* ── /visit-sessions ───────────────────────────────────────── */
    if (method === 'GET' && (params = matchPath('/visit-sessions/active/:userId', url)) && me) {
      const target = params.userId;
      if (target !== me.id && !isAncestor(me.id, target)) return { error: 'Forbidden', status: 403 };
      return STORE.active_sessions.find((s) => s.user_id === target) || null;
    }
    if (method === 'POST' && url === '/visit-sessions/start' && me) {
      // Close any abandoned previous
      STORE.active_sessions = STORE.active_sessions.filter((s) => s.user_id !== me.id);
      const session = {
        id: genId('vs'),
        user_id: me.id,
        started_at: new Date().toISOString(),
        ended_at: null,
        pharmacies_planned: body.pharmacies_planned || STORE.day_targets[me.role] || 5,
        pharmacies_visited: 0,
        total_distance_m: 0,
        idle_seconds: 0,
        status: 'active',
        ended_reason: null,
        notes: body.notes || null,
        last_ping_at: new Date().toISOString(),
      };
      STORE.active_sessions.push(session);
      return session;
    }
    if (method === 'PATCH' && (params = matchPath('/visit-sessions/:id/end', url)) && me) {
      const idx = STORE.active_sessions.findIndex((s) => s.id === params.id);
      if (idx < 0) return { error: 'Session not found', status: 404 };
      const session = STORE.active_sessions[idx];
      session.ended_at = new Date().toISOString();
      session.status = 'ended';
      session.ended_reason = (body && body.reason) || 'manual';
      const startMs = Date.parse(session.started_at);
      const durationMin = Math.max(1, (Date.parse(session.ended_at) - startMs) / 60_000);
      session.total_distance_m = session.total_distance_m || Math.round(session.pharmacies_visited * 1700 + 800);
      session.idle_seconds = session.idle_seconds || Math.round(durationMin * 60 * 0.12);
      STORE.active_sessions.splice(idx, 1);
      STORE.historical_sessions.push(session);
      return session;
    }
    if (method === 'GET' && url.startsWith('/visit-sessions') && !url.includes('/active/')) {
      const userId = query.user_id || me.id;
      if (userId !== me.id && !isAncestor(me.id, userId)) return [];
      const active = STORE.active_sessions.find((s) => s.user_id === userId);
      const past = STORE.historical_sessions
        .filter((s) => s.user_id === userId)
        .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
        .slice(0, 30);
      return active ? [active, ...past] : past;
    }

    /* ── /tracking/positions (with descendants only) ───────────── */
    if (method === 'GET' && url === '/tracking/positions' && me) {
      const descendants = getDescendants(me.id);
      const visible = [me, ...descendants];
      return visible.map((u) => {
        const presence = presenceFor(u.id);
        const session = presence.session;
        const trail = STORE.breadcrumbs[u.id] || [];
        const last = trail.length ? trail[trail.length - 1] : { lat: u.lat, lng: u.lng };
        return {
          rep_id: u.id,
          full_name: u.full_name,
          role: u.role,
          zone: u.zone,
          lat: last.lat,
          lng: last.lng,
          recorded_at: presence.last_seen,
          color: u.color,
          presence_status: presence.status,
          home_lat: u.lat,
          home_lng: u.lng,
          active_session_id: session ? session.id : null,
          current_pharmacy: session ? session.current_pharmacy : null,
        };
      });
    }

    /* ── /tracking/breadcrumbs/:userId ─────────────────────────── */
    if (method === 'GET' && (params = matchPath('/tracking/breadcrumbs/:repId', url))) {
      return STORE.breadcrumbs[params.repId] || [];
    }

    // preview-routing is a pure-computation endpoint that calls Google Routes API.
    // It has no DB reads/writes, so it must reach the real backend even in demo mode.
    if (url === '/visit-plans/preview-routing') return undefined;

    /* ── POST /visit-plans/preview-full — real routing in demo ──── */
    // The real preview-full requires manager role and database tables.
    // We intercept it here, build demo users+stops from STORE, and call
    // the role-unrestricted preview-routing endpoint to get actual Google
    // Routes API results, then return them in preview-full shape so the
    // Plan Editor can draw coloured polylines on the map.
    if (method === 'POST' && url === '/visit-plans/preview-full') {
      return (async () => {
        const { scope_user_ids = [], period_start } = body || {};
        const date = period_start || new Date().toISOString().slice(0, 10);

        // Only route reps (not supervisors/gerentes — they don't have stop lists).
        const reps = STORE.users.filter(
          (u) => u.role === ROLES.REPRESENTANTE
            && (scope_user_ids.length === 0 || scope_user_ids.includes(u.id))
            && u.is_active !== false,
        );
        if (!reps.length) return { plan: { config: { working_days: 1 } }, assignments: [] };

        const users = reps.map((r) => ({
          id: r.id,
          home_lat: r.lat,
          home_lng: r.lng,
          service_minutes_per_stop: 45,
        }));

        // Distribute pharmacies: each stop belongs to the rep whose home is nearest.
        // Cap at 10 per rep so the API call stays well within quota.
        const MAX_PER_REP = 10;
        const stops = [];
        for (const rep of reps) {
          const repPharms = STORE.pharmacies
            .filter((p) => p.assigned_rep_id === rep.id && p.lat != null && p.lng != null)
            .slice(0, MAX_PER_REP);
          for (const p of repPharms) {
            stops.push({ id: p.id, user_id: rep.id, lat: p.lat, lng: p.lng, name: p.name, pareto: p.pareto });
          }
        }
        if (!stops.length) return { plan: { config: { working_days: 1 } }, assignments: [] };

        // Call the real endpoint with the demo user's token.
        const token = localStorage.getItem('token');
        let routingResult;
        try {
          const resp = await fetch('/api/visit-plans/preview-routing', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: 'Bearer ' + token } : {}),
            },
            body: JSON.stringify({ users, stops, date }),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          routingResult = await resp.json();
        } catch (err) {
          console.warn('[demoHierarchy] preview-routing call failed:', err.message || err);
          return { plan: { config: { working_days: 1 } }, assignments: [] };
        }

        // Transform to the shape expected by plan-editor.js generatePreview().
        const assignments = [];
        for (const route of (routingResult.routes || [])) {
          for (const stop of (route.stops || [])) {
            assignments.push({
              visitor_user_id: route.user_id,
              scheduled_date: date,
              route_order: stop.route_order,
              marzam_client_id: stop.id,
              pharmacy_id: null,
              farmacia_nombre: stop.name || 'Farmacia',
              pareto: stop.pareto || 'B',
              expected_arrival_time: stop.expected_arrival_iso || null,
              expected_travel_minutes: stop.travel_minutes || 0,
              expected_service_minutes: stop.service_minutes || 45,
              polyline_to_next: stop.polyline_to_next || null,
              lat: stop.lat,
              lng: stop.lng,
            });
          }
        }

        return {
          plan: { config: { working_days: 1 } },
          assignments,
          _cost: routingResult.cost_estimate || null,
          _demo: true,
        };
      })();
    }

    // Safety net: if we're in demo mode and this is one of OUR endpoints,
    // never fall through to the real backend (which would return 500
    // because the tables don't exist yet). Return a neutral empty default.
    if (isDemo && isOwnedPath(url)) {
      if (method === 'GET') {
        if (url === '/team') return { descendants: [], by_role: {}, actor: me || null };
        if (url.startsWith('/team/')) return { user: null, direct_reports: [] };
        if (url.startsWith('/visit-sessions/active/')) return null;
        if (url.startsWith('/visit-sessions')) return [];
        if (url === '/visit-plans') return [];
        if (url.startsWith('/visit-plans/')) return null;
        if (url === '/visit-targets') return STORE.visit_targets;
        if (url === '/visit-targets/resolve') return { value: null, source: 'none' };
        if (url.startsWith('/visit-targets/overrides/')) return [];
        if (url === '/analytics/team') return { period: {}, users: [], rows: [] };
        if (url === '/analytics/pareto-mix') return [];
        if (url === '/analytics/untouched') return STORE.untouched_seed || [];
        if (url === '/tracking/positions') return [];
        return null;
      }
      if (method === 'POST') {
        if (url === '/visit-plans/preview') return { total_estimated: 0, coverage_pct: 0, working_days: 22, scope_size: 0 };
        return null;
      }
      if (method === 'PATCH') return null;
    }

    return undefined;
  }

  /* ========================================================================
   * Patch the API client
   * ====================================================================== */
  function patchAPI() {
    if (!window.API) return;
    const origGet = API.get.bind(API);
    const origPost = API.post.bind(API);
    const origPatch = API.patch.bind(API);
    // Use `undefined` sentinel: a `null` result is a valid response (e.g.
    // "no active visit session for this user"), and we should NOT fall
    // through to the real backend in that case.
    API.get = async (path) => {
      const result = route('GET', path);
      return result !== undefined ? result : origGet(path);
    };
    API.post = async (path, body) => {
      const result = route('POST', path, body);
      return result !== undefined ? result : origPost(path, body);
    };
    API.patch = async (path, body) => {
      const result = route('PATCH', path, body);
      return result !== undefined ? result : origPatch(path, body);
    };
  }

  window.DEMO_H = {
    ROLES,
    PARETO_COLORS,
    ROLE_RANK,
    VISIT_RULES,
    ready: load(),
    load,
    STORE,
    route,
    patchAPI,
    helpers: {
      getCurrentUser,
      getDescendants,
      getDirectReports,
      isAncestor,
      metricsFor,
      presenceFor,
      userWithExtras,
    },
  };
})();
