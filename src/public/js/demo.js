/**
 * DemoRouter + DemoStore — Full PRD demo without database.
 * Activated when localStorage.marzam_demo === '1'.
 * Intercepts all API calls and routes to in-memory handlers.
 */
const DEMO = (() => {
  const active = localStorage.getItem('marzam_demo') === '1';
  const DATASET_URL = '/data/ecatepec-demo.json';

  const OUTCOMES_SKIPPING_STOP = [
    'duplicate', 'closed', 'moved', 'wrong_category', 'chain_not_independent', 'invalid',
  ];

  const LEAD_TRANSITIONS = {
    interested: ['follow_up_required', 'contact_captured', 'converted', 'lost'],
    follow_up_required: ['contact_captured', 'converted', 'lost'],
    contact_captured: ['converted', 'lost'],
    converted: [],
    lost: ['interested'],
  };

  const STORE = {
    pharmacies: [
      { id:'d1', name:'Farmacia del Ahorro - Insurgentes', chain:'Ahorro', municipality:'Benito Juarez',
        address:'Av. Insurgentes Sur 1350, Col. Del Valle', status:'active', potential_score:85, order_potential:12500,
        contact_phone:'55-1234-5678', contact_person:'Maria Lopez', verification_status:'verified',
        is_independent:true, last_visit_outcome:'interested', last_visited_at:'2026-02-28T14:30:00Z',
        lat:19.3910, lng:-99.1780, source:'blackprint', notes:'High traffic corner location' },
      { id:'d2', name:'Benavides - Roma Norte', chain:'Benavides', municipality:'Cuauhtemoc',
        address:'Alvaro Obregon 89, Roma Norte', status:'active', potential_score:72, order_potential:8900,
        contact_phone:'55-2345-6789', contact_person:'Carlos Ruiz', verification_status:'verified',
        is_independent:true, last_visit_outcome:'contact_made', last_visited_at:'2026-03-01T10:15:00Z',
        lat:19.4190, lng:-99.1620, source:'blackprint', notes:'' },
      { id:'d3', name:'Farmacias Similares - Coyoacan', chain:'Similares', municipality:'Coyoacan',
        address:'Francisco Sosa 412, Coyoacan', status:'pending_review', potential_score:60, order_potential:5500,
        contact_phone:null, contact_person:null, verification_status:'unverified',
        is_independent:true, last_visit_outcome:null, last_visited_at:null,
        lat:19.3500, lng:-99.1620, source:'field_rep', notes:'Discovered during patrol' },
      { id:'d4', name:'San Pablo - Centro Medico', chain:'San Pablo', municipality:'Cuauhtemoc',
        address:'Dr. Jimenez 223, Centro', status:'active', potential_score:91, order_potential:18000,
        contact_phone:'55-3456-7890', contact_person:'Ana Martinez', verification_status:'verified',
        is_independent:true, last_visit_outcome:'interested', last_visited_at:'2026-03-02T09:00:00Z',
        lat:19.4115, lng:-99.1530, source:'blackprint', notes:'Near hospital complex, high potential' },
      { id:'d5', name:'Farmacia del Ahorro - Polanco', chain:'Ahorro', municipality:'Miguel Hidalgo',
        address:'Av. Presidente Masaryk 340, Polanco', status:'active', potential_score:78, order_potential:14200,
        contact_phone:'55-4567-8901', contact_person:'Roberto Sanchez', verification_status:'verified',
        is_independent:true, last_visit_outcome:'needs_follow_up', last_visited_at:'2026-02-25T16:45:00Z',
        lat:19.4320, lng:-99.1920, source:'blackprint', notes:'Premium zone pharmacy' },
      { id:'d6', name:'Walmart Pharmacy - Perisur', chain:'Walmart', municipality:'Tlalpan',
        address:'Periferico Sur 4690, Perisur', status:'active', potential_score:66, order_potential:7800,
        contact_phone:null, contact_person:null, verification_status:'verified',
        is_independent:true, last_visit_outcome:'visited', last_visited_at:'2026-03-01T11:30:00Z',
        lat:19.3040, lng:-99.1900, source:'blackprint', notes:'' },
      { id:'d7', name:'Costco Pharmacy - Satelite', chain:'Costco', municipality:'Naucalpan',
        address:'Blvd. Manuel Avila Camacho 647', status:'active', potential_score:55, order_potential:4500,
        contact_phone:null, contact_person:null, verification_status:'unverified',
        is_independent:true, last_visit_outcome:null, last_visited_at:null,
        lat:19.5100, lng:-99.2330, source:'blackprint', notes:'' },
      { id:'d8', name:'Benavides - Napoles', chain:'Benavides', municipality:'Benito Juarez',
        address:'Luz Savinon 17, Napoles', status:'closed', potential_score:30, order_potential:0,
        contact_phone:null, contact_person:null, verification_status:'verified',
        is_independent:true, last_visit_outcome:'closed', last_visited_at:'2026-02-20T13:00:00Z',
        lat:19.3880, lng:-99.1710, source:'blackprint', notes:'Permanently closed' },
      { id:'d9', name:'Farmacias Similares - Tepito', chain:'Similares', municipality:'Cuauhtemoc',
        address:'Eje 1 Nte. 42, Tepito', status:'active', potential_score:45, order_potential:3200,
        contact_phone:'55-5678-9012', contact_person:'Pedro Flores', verification_status:'verified',
        is_independent:true, last_visit_outcome:'not_interested', last_visited_at:'2026-02-27T15:00:00Z',
        lat:19.4430, lng:-99.1250, source:'blackprint', notes:'' },
      { id:'d10', name:'San Pablo - Xochimilco', chain:'San Pablo', municipality:'Xochimilco',
        address:'Av. Guadalupe 302, Xochimilco', status:'active', potential_score:58, order_potential:4800,
        contact_phone:null, contact_person:null, verification_status:'unverified',
        is_independent:true, last_visit_outcome:null, last_visited_at:null,
        lat:19.2600, lng:-99.1050, source:'blackprint', notes:'' },
      { id:'d11', name:'Farmacia del Ahorro - Santa Fe', chain:'Ahorro', municipality:'Alvaro Obregon',
        address:'Av. Vasco de Quiroga 3880', status:'active', potential_score:82, order_potential:15600,
        contact_phone:'55-6789-0123', contact_person:'Laura Diaz', verification_status:'verified',
        is_independent:true, last_visit_outcome:'contact_made', last_visited_at:'2026-03-03T08:30:00Z',
        lat:19.3660, lng:-99.2610, source:'blackprint', notes:'Corporate zone, premium traffic' },
      { id:'d12', name:'Benavides - Peralvillo', chain:'Benavides', municipality:'Cuauhtemoc',
        address:'Peralvillo 15, Morelos', status:'active', potential_score:40, order_potential:2800,
        contact_phone:null, contact_person:null, verification_status:'flagged',
        is_independent:false, last_visit_outcome:'chain_not_independent', last_visited_at:'2026-02-22T10:00:00Z',
        lat:19.4480, lng:-99.1380, source:'blackprint', notes:'Flagged as chain' },
    ],

    assignments: [
      { id:'a1', campaign_objective:'Prospecting', status:'in_progress', priority:'high',
        rep_id:'rep1', rep_name:'Carlos Lopez',
        due_date:'2026-03-15', visit_goal:8, pharmacy_count:8, completed_stops:3, total_stops:8,
        pharmacy_ids:['d1','d2','d4','d5','d6','d9','d11','d12'],
        stop_statuses:{ d1:'completed', d4:'completed', d5:'completed' },
        polygon_geojson:{type:'Polygon',coordinates:[[[-99.20,19.38],[-99.14,19.38],[-99.14,19.42],[-99.20,19.42],[-99.20,19.38]]]} },
      { id:'a2', campaign_objective:'Follow-up', status:'assigned', priority:'normal',
        rep_id:'rep2', rep_name:'Ana Martinez',
        due_date:'2026-03-20', visit_goal:6, pharmacy_count:6, completed_stops:0, total_stops:6,
        pharmacy_ids:['d2','d3','d7','d8','d9','d10'],
        stop_statuses:{},
        polygon_geojson:{type:'Polygon',coordinates:[[[-99.20,19.42],[-99.12,19.42],[-99.12,19.46],[-99.20,19.46],[-99.20,19.42]]]} },
      { id:'a3', campaign_objective:'Validation', status:'completed', priority:'low',
        rep_id:'rep1', rep_name:'Carlos Lopez',
        due_date:'2026-02-28', visit_goal:4, pharmacy_count:4, completed_stops:4, total_stops:4,
        pharmacy_ids:['d1','d3','d6','d10'],
        stop_statuses:{ d1:'completed', d3:'completed', d6:'completed', d10:'completed' },
        polygon_geojson:{type:'Polygon',coordinates:[[[-99.15,19.34],[-99.10,19.34],[-99.10,19.38],[-99.15,19.38],[-99.15,19.34]]]} },
    ],

    reviewItems: [
      { id:'r1', pharmacy_id:'d3', pharmacy_name:'Farmacias Similares - Coyoacan',
        flag_type:'new_pharmacy', reason:'Discovered during patrol near Coyoacan center',
        queue_status:'pending', submitted_by:'rep1', rep_name:'Carlos Lopez',
        pharmacy_lat:19.3500, pharmacy_lng:-99.1620, created_at:'2026-03-04T14:00:00Z' },
      { id:'r2', pharmacy_id:'d12', pharmacy_name:'Benavides - Peralvillo',
        flag_type:'chain_not_independent', reason:'Belongs to Benavides chain, confirmed on site',
        queue_status:'pending', submitted_by:'rep2', rep_name:'Ana Martinez',
        pharmacy_lat:19.4480, pharmacy_lng:-99.1380, created_at:'2026-03-03T11:00:00Z' },
      { id:'r3', pharmacy_id:'d9', pharmacy_name:'Farmacias Similares - Tepito',
        flag_type:'duplicate', reason:'Same pharmacy listed under different address nearby',
        queue_status:'pending', submitted_by:'rep1', rep_name:'Carlos Lopez',
        pharmacy_lat:19.4430, pharmacy_lng:-99.1250, created_at:'2026-03-04T09:30:00Z' },
    ],

    visits: [
      { id:'v1', pharmacy_id:'d1', rep_id:'rep1', outcome:'interested', notes:'Owner very interested in Marzam product catalog, wants pricing sheet.',
        order_potential:12500, contact_person:'Maria Lopez', contact_phone:'55-1234-5678',
        competitor_products:'Genomma Lab, Bayer OTC', stock_observations:'Low stock on analgesics',
        created_at:'2026-02-28T14:30:00Z' },
      { id:'v2', pharmacy_id:'d4', rep_id:'rep1', outcome:'interested', notes:'Pharmacist eager to stock our line. Already familiar with Marzam.',
        order_potential:18000, contact_person:'Ana Martinez', contact_phone:'55-3456-7890',
        competitor_products:'Sanofi, Pfizer generics', stock_observations:'Well-stocked, modern shelving',
        created_at:'2026-03-02T09:00:00Z' },
      { id:'v3', pharmacy_id:'d2', rep_id:'rep2', outcome:'contact_made', notes:'Spoke with manager, will schedule follow-up next week.',
        order_potential:8900, contact_person:'Carlos Ruiz', contact_phone:'55-2345-6789',
        competitor_products:'Similares generics', stock_observations:'Normal stock levels',
        created_at:'2026-03-01T10:15:00Z' },
      { id:'v4', pharmacy_id:'d5', rep_id:'rep1', outcome:'needs_follow_up', notes:'Owner traveling, assistant asked to come back March 10.',
        order_potential:14200, contact_person:'Roberto Sanchez', contact_phone:'55-4567-8901',
        follow_up_date:'2026-03-10', follow_up_reason:'Owner traveling, return after March 10',
        created_at:'2026-02-25T16:45:00Z' },
      { id:'v5', pharmacy_id:'d8', rep_id:'rep2', outcome:'closed', notes:'Location permanently closed. Building under renovation.',
        flag_reason:'Permanently closed, building undergoing renovation', created_at:'2026-02-20T13:00:00Z' },
      { id:'v6', pharmacy_id:'d9', rep_id:'rep1', outcome:'not_interested', notes:'Owner declined, already has exclusive agreement.',
        created_at:'2026-02-27T15:00:00Z' },
      { id:'v7', pharmacy_id:'d11', rep_id:'rep2', outcome:'contact_made', notes:'Left materials with pharmacist, will call back.',
        order_potential:15600, contact_person:'Laura Diaz', contact_phone:'55-6789-0123',
        created_at:'2026-03-03T08:30:00Z' },
    ],

    commercialLeads: [
      { id:'cl1', pharmacy_id:'d1', visit_id:'v1', status:'interested',
        potential_sales:12500, contact_person:'Maria Lopez', contact_phone:'55-1234-5678',
        notes:'Wants pricing sheet', created_at:'2026-02-28T14:30:00Z' },
      { id:'cl2', pharmacy_id:'d4', visit_id:'v2', status:'interested',
        potential_sales:18000, contact_person:'Ana Martinez', contact_phone:'55-3456-7890',
        notes:'Ready to place first order', created_at:'2026-03-02T09:00:00Z' },
    ],

    auditEvents: [
      { id:'ae1', action:'assignment.created', entity_type:'assignment', entity_id:'a1',
        user_name:'Demo Manager', created_at:'2026-02-15T09:00:00Z' },
      { id:'ae2', action:'assignment.created', entity_type:'assignment', entity_id:'a2',
        user_name:'Demo Manager', created_at:'2026-02-16T10:00:00Z' },
      { id:'ae3', action:'visit.submitted', entity_type:'visit', entity_id:'v1',
        user_name:'Carlos Lopez', created_at:'2026-02-28T14:30:00Z' },
      { id:'ae4', action:'visit.submitted', entity_type:'visit', entity_id:'v2',
        user_name:'Carlos Lopez', created_at:'2026-03-02T09:00:00Z' },
      { id:'ae5', action:'review.resolved', entity_type:'review_item', entity_id:'r0',
        user_name:'Demo Manager', created_at:'2026-03-01T16:00:00Z' },
    ],

    reps: [
      { user_id:'rep1', full_name:'Carlos Lopez', email:'carlos@marzam.mx',
        last_lat:19.4150, last_lng:-99.1600, last_seen:'2026-03-05T10:30:00Z',
        total_visits:4, interested_count:2, unique_pharmacies:4 },
      { user_id:'rep2', full_name:'Ana Martinez', email:'ana@marzam.mx',
        last_lat:19.4330, last_lng:-99.1950, last_seen:'2026-03-05T10:45:00Z',
        total_visits:3, interested_count:0, unique_pharmacies:3 },
      { user_id:'rep3', full_name:'Miguel Torres', email:'miguel@marzam.mx',
        last_lat:19.3800, last_lng:-99.1700, last_seen:'2026-03-05T09:15:00Z',
        total_visits:0, interested_count:0, unique_pharmacies:0 },
    ],

    breadcrumbsByRep: {},

    checkins: [],

    savedViews: [],

    currentUser: {
      id: 'mgr1', email: 'manager@marzam.mx', full_name: 'Demo Manager',
      role: 'manager', impersonated_by: null, original_role: null,
    },
  };

  const ready = active ? loadGeneratedDataset() : Promise.resolve();

  let _idCounter = 100;
  function genId(prefix) { return `${prefix}_${++_idCounter}`; }

  async function loadGeneratedDataset() {
    try {
      const res = await fetch(DATASET_URL, { cache: 'no-store' });
      if (!res.ok) return;
      const dataset = await res.json();
      hydrateStoreFromDataset(dataset);
    } catch (err) {
      console.warn('Demo dataset fallback enabled:', err);
    }
  }

  function hydrateStoreFromDataset(dataset) {
    if (!dataset || !Array.isArray(dataset.pharmacies) || !dataset.pharmacies.length) return;

    STORE.pharmacies = dataset.pharmacies;
    STORE.assignments = Array.isArray(dataset.assignments) ? dataset.assignments : STORE.assignments;
    STORE.reviewItems = Array.isArray(dataset.reviewItems) ? dataset.reviewItems : STORE.reviewItems;
    STORE.visits = Array.isArray(dataset.visits) ? dataset.visits : STORE.visits;
    STORE.commercialLeads = Array.isArray(dataset.commercialLeads) ? dataset.commercialLeads : STORE.commercialLeads;
    STORE.auditEvents = Array.isArray(dataset.auditEvents) ? dataset.auditEvents : STORE.auditEvents;
    STORE.reps = Array.isArray(dataset.reps) ? dataset.reps : STORE.reps;
    STORE.breadcrumbsByRep = dataset.breadcrumbsByRep && typeof dataset.breadcrumbsByRep === 'object'
      ? dataset.breadcrumbsByRep
      : {};
  }

  function pointInBBox(lat, lng, west, south, east, north) {
    return lng >= west && lng <= east && lat >= south && lat <= north;
  }

  function pointInPolygon(lat, lng, polygon) {
    if (!polygon || !polygon.coordinates) return false;
    const ring = polygon.coordinates[0];
    const lngs = ring.map(c => c[0]);
    const lats = ring.map(c => c[1]);
    return lng >= Math.min(...lngs) && lng <= Math.max(...lngs) &&
           lat >= Math.min(...lats) && lat <= Math.max(...lats);
  }

  function matchPath(pattern, path) {
    const patParts = pattern.split('/');
    const pathParts = path.split('/');
    if (patParts.length !== pathParts.length) return null;
    const params = {};
    for (let i = 0; i < patParts.length; i++) {
      if (patParts[i].startsWith(':')) {
        params[patParts[i].slice(1)] = pathParts[i];
      } else if (patParts[i] !== pathParts[i]) {
        return null;
      }
    }
    return params;
  }

  function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function currentUserName() {
    return STORE.currentUser.full_name || 'Demo Manager';
  }

  function buildKPIs() {
    const ph = STORE.pharmacies;
    return {
      total_pharmacies: ph.length,
      active_pharmacies: ph.filter(p => p.status === 'active').length,
      assigned_pharmacies: STORE.assignments.filter(a => ['assigned','in_progress'].includes(a.status)).reduce((s,a) => s + (a.pharmacy_count||0), 0),
      visited: ph.filter(p => p.last_visited_at).length,
      interested: ph.filter(p => p.last_visit_outcome === 'interested').length,
      needs_follow_up: ph.filter(p => p.last_visit_outcome === 'needs_follow_up').length,
      invalid_closed: ph.filter(p => ['closed','invalid','duplicate','moved'].includes(p.status)).length,
      visits_this_month: STORE.visits.length,
      coverage_pct: Math.round(ph.filter(p => p.last_visited_at).length / Math.max(ph.length,1) * 100),
      contact_made: ph.filter(p => p.last_visit_outcome === 'contact_made').length,
      total_leads: STORE.commercialLeads.length,
      total_potential: STORE.commercialLeads.reduce((s,l) => s + (l.potential_sales||0), 0),
    };
  }

  function buildCoverage() {
    const byMuni = {};
    STORE.pharmacies.forEach(p => {
      const m = p.municipality || 'Unknown';
      if (!byMuni[m]) byMuni[m] = { municipality: m, total: 0, visited: 0, assigned: 0 };
      byMuni[m].total++;
      if (p.last_visited_at) byMuni[m].visited++;
    });
    return Object.values(byMuni).map(m => ({ ...m, visit_pct: Math.round(m.visited / Math.max(m.total,1) * 100) }));
  }

  function buildStopsForAssignment(a) {
    const ids = a.pharmacy_ids || [];
    const statuses = a.stop_statuses || {};
    return ids.map((pid, i) => {
      const p = STORE.pharmacies.find(ph => ph.id === pid);
      if (!p) return null;
      const stopStatus = statuses[pid] || 'pending';
      return {
        ...p,
        id: `stop_${a.id}_${i}`,
        pharmacy_id: p.id,
        route_order: i + 1,
        stop_status: stopStatus,
      };
    }).filter(Boolean);
  }

  function recomputeAssignmentCounts(a) {
    const statuses = a.stop_statuses || {};
    const vals = Object.values(statuses);
    a.completed_stops = vals.filter(s => s === 'completed' || s === 'skipped').length;
    a.total_stops = (a.pharmacy_ids || []).length;
    a.pharmacy_count = a.total_stops;
  }

  function generateBreadcrumbs(rep, count) {
    const base_lat = rep.last_lat || 19.41;
    const base_lng = rep.last_lng || -99.16;
    const now = Date.now();
    const points = [];
    for (let i = count - 1; i >= 0; i--) {
      const drift_lat = (Math.random() - 0.5) * 0.008 * (i / count);
      const drift_lng = (Math.random() - 0.5) * 0.008 * (i / count);
      points.push({
        lat: +(base_lat + drift_lat).toFixed(6),
        lng: +(base_lng + drift_lng).toFixed(6),
        recorded_at: new Date(now - i * 60000).toISOString(),
        accuracy_meters: Math.round(5 + Math.random() * 20),
      });
    }
    return points;
  }

  function route(method, path, body) {
    let params;

    /* ─── Auth: Users list ────────────────────────────────────── */
    if (method === 'GET' && path === '/auth/users') {
      const manager = {
        id: 'mgr1', email: 'manager@marzam.mx', full_name: 'Demo Manager',
        role: 'manager', is_active: true, created_at: '2026-01-01T00:00:00Z',
      };
      const reps = STORE.reps.map(r => ({
        id: r.user_id, email: r.email, full_name: r.full_name,
        role: 'field_rep', is_active: true, created_at: '2026-01-15T00:00:00Z',
      }));
      return [manager, ...reps];
    }

    /* ─── Auth: Impersonate ───────────────────────────────────── */
    if (method === 'POST' && path === '/auth/impersonate') {
      const targetId = body && body.target_user_id;
      const rep = STORE.reps.find(r => r.user_id === targetId);
      if (!rep) return { error: 'Target user not found', status: 404 };
      STORE.currentUser = {
        id: rep.user_id, email: rep.email, full_name: rep.full_name,
        role: 'field_rep', impersonated_by: 'mgr1', original_role: 'manager',
      };
      return {
        token: 'demo_impersonate_token',
        user: { id: rep.user_id, email: rep.email, full_name: rep.full_name, role: 'field_rep' },
        impersonated_by: 'mgr1',
      };
    }

    if (method === 'POST' && path === '/auth/impersonate/stop') {
      STORE.currentUser = {
        id: 'mgr1', email: 'manager@marzam.mx', full_name: 'Demo Manager',
        role: 'manager', impersonated_by: null, original_role: null,
      };
      return {
        token: 'demo_manager_token',
        user: { id: 'mgr1', email: 'manager@marzam.mx', full_name: 'Demo Manager', role: 'manager' },
      };
    }

    if (method === 'GET' && path === '/auth/me') {
      return { ...STORE.currentUser };
    }

    /* ─── Reporting ────────────────────────────────────────────── */
    if (method === 'GET' && path === '/reporting/dashboard') {
      const kpis = buildKPIs();
      return {
        funnel: kpis,
        reps: STORE.reps.map(r => ({ rep_id: r.user_id, rep_name: r.full_name, total_visits: r.total_visits, interested_count: r.interested_count, unique_pharmacies_visited: r.unique_pharmacies })),
        coverage: buildCoverage(),
        sales: { total_potential: kpis.total_potential, total_leads: kpis.total_leads },
      };
    }

    if (method === 'GET' && path === '/reporting/reps') {
      return STORE.reps.map(r => ({
        rep_id: r.user_id, rep_name: r.full_name,
        total_visits: r.total_visits, interested_count: r.interested_count,
        unique_pharmacies_visited: r.unique_pharmacies,
      }));
    }

    if (method === 'GET' && path === '/reporting/coverage') {
      return buildCoverage();
    }

    if (method === 'GET' && path === '/reporting/assignments') {
      return STORE.assignments.map(a => ({
        assignment_id: a.id, assignment_status: a.status, campaign_objective: a.campaign_objective,
        rep_id: a.rep_id, rep_name: a.rep_name,
        total_stops: a.total_stops||a.pharmacy_count, completed_stops: a.completed_stops||0,
        completion_pct: Math.round((a.completed_stops||0) / Math.max(a.total_stops||a.pharmacy_count||1, 1) * 100),
        due_date: a.due_date, created_at: a.created_at,
      }));
    }

    /* ─── Pharmacies ───────────────────────────────────────────── */
    if (method === 'GET' && path.startsWith('/pharmacies')) {
      if ((params = matchPath('/pharmacies/:id', path))) {
        const p = STORE.pharmacies.find(ph => ph.id === params.id);
        return p || { id: params.id, name: 'Unknown', status: 'active' };
      }
      return STORE.pharmacies;
    }

    if (method === 'POST' && path === '/pharmacies/find-in-polygon') {
      if (!body || !body.polygon) return [];
      return STORE.pharmacies.filter(p => pointInPolygon(p.lat, p.lng, body.polygon));
    }

    if (method === 'POST' && path === '/pharmacies') {
      const np = { id: genId('d'), name: body.name, address: body.address || '', lat: body.lat, lng: body.lng,
        municipality: body.municipality || '', status: 'pending_review', verification_status: 'unverified',
        is_independent: body.is_independent ?? true, source: 'field_rep', potential_score: 0,
        contact_phone: body.contact_phone || null, contact_person: body.contact_person || null,
        notes: body.notes || '', last_visit_outcome: null, last_visited_at: null, order_potential: 0 };
      STORE.pharmacies.push(np);
      STORE.reviewItems.push({ id: genId('r'), pharmacy_id: np.id, pharmacy_name: np.name,
        flag_type: 'new_pharmacy', reason: body.notes || 'New pharmacy discovered',
        queue_status: 'pending', submitted_by: STORE.currentUser.id, rep_name: currentUserName(),
        pharmacy_lat: np.lat, pharmacy_lng: np.lng, created_at: new Date().toISOString() });
      STORE.auditEvents.unshift({ id: genId('ae'), action: 'pharmacy.created', entity_type: 'pharmacy',
        entity_id: np.id, user_name: currentUserName(), created_at: new Date().toISOString() });
      return np;
    }

    /* ─── Assignments ──────────────────────────────────────────── */
    if (method === 'GET' && path === '/assignments') {
      return STORE.assignments;
    }

    if ((params = matchPath('/assignments/:id', path)) && method === 'GET') {
      const a = STORE.assignments.find(as => as.id === params.id);
      if (!a) return { id: params.id, stops: [] };
      const stops = buildStopsForAssignment(a);
      const first = stops[0];
      const last = stops[stops.length - 1];
      const mapsUrl = first && last
        ? `https://www.google.com/maps/dir/?api=1&origin=${first.lat},${first.lng}&destination=${last.lat},${last.lng}&travelmode=driving`
        : null;
      return { ...a, stops, google_maps_url: mapsUrl };
    }

    if (method === 'POST' && path === '/assignments') {
      const pids = body.pharmacy_ids || [];
      const na = { id: genId('a'), campaign_objective: body.campaign_objective || 'Prospecting',
        status: body.rep_id ? 'assigned' : 'unassigned', priority: body.priority || 'normal',
        rep_id: body.rep_id || null, rep_name: STORE.reps.find(r => r.user_id === body.rep_id)?.full_name || 'Unassigned',
        due_date: body.due_date || null, visit_goal: body.visit_goal || pids.length,
        pharmacy_count: pids.length, completed_stops: 0, total_stops: pids.length,
        pharmacy_ids: pids, stop_statuses: {},
        polygon_geojson: body.polygon_geojson };
      STORE.assignments.push(na);
      STORE.auditEvents.unshift({ id: genId('ae'), action: 'assignment.created', entity_type: 'assignment',
        entity_id: na.id, user_name: currentUserName(), created_at: new Date().toISOString() });
      return na;
    }

    if (method === 'POST' && path === '/assignments/check-overlap') {
      if (!body || !body.polygon) return { overlapping: [], has_overlap: false };
      const overlapping = STORE.assignments.filter(a =>
        ['assigned','in_progress'].includes(a.status) && a.polygon_geojson &&
        polygonsOverlap(body.polygon, a.polygon_geojson));
      return { overlapping, has_overlap: overlapping.length > 0 };
    }

    if ((params = matchPath('/assignments/:id/status', path)) && method === 'PATCH') {
      const a = STORE.assignments.find(as => as.id === params.id);
      if (a) a.status = body.status;
      return a || {};
    }

    if ((params = matchPath('/assignments/:id', path)) && method === 'PATCH') {
      const a = STORE.assignments.find(as => as.id === params.id);
      if (a) {
        if (body.rep_id !== undefined) { a.rep_id = body.rep_id; a.rep_name = STORE.reps.find(r => r.user_id === body.rep_id)?.full_name || 'Unassigned'; }
        if (body.campaign_objective) a.campaign_objective = body.campaign_objective;
        if (body.priority) a.priority = body.priority;
        if (body.due_date !== undefined) a.due_date = body.due_date;
        if (body.visit_goal !== undefined) a.visit_goal = body.visit_goal;
        STORE.auditEvents.unshift({ id: genId('ae'), action: 'assignment.updated', entity_type: 'assignment',
          entity_id: a.id, user_name: currentUserName(), created_at: new Date().toISOString() });
      }
      return a || {};
    }

    /* ─── Review ───────────────────────────────────────────────── */
    if (method === 'GET' && path.startsWith('/review')) {
      if (path === '/review/pending-count') {
        return { pending: STORE.reviewItems.filter(r => r.queue_status === 'pending').length };
      }
      return STORE.reviewItems.filter(r => r.queue_status === 'pending');
    }

    if ((params = matchPath('/review/:id/resolve', path)) && method === 'PATCH') {
      const item = STORE.reviewItems.find(r => r.id === params.id);
      if (item) {
        item.queue_status = body.decision;
        item.resolved_at = new Date().toISOString();
        item.resolved_by = STORE.currentUser.id;
        STORE.auditEvents.unshift({ id: genId('ae'), action: 'review.resolved', entity_type: 'review_item',
          entity_id: item.id, user_name: currentUserName(), created_at: new Date().toISOString() });
        if (body.decision === 'approved') {
          const ph = STORE.pharmacies.find(p => p.id === item.pharmacy_id);
          if (ph && item.flag_type === 'new_pharmacy') { ph.status = 'active'; ph.verification_status = 'verified'; }
          else if (ph) { ph.status = item.flag_type === 'closed' ? 'closed' : 'invalid'; ph.verification_status = 'verified'; }
        }
      }
      return item || {};
    }

    if (method === 'POST' && path === '/review/batch-resolve') {
      const ids = (body && body.ids) || [];
      const decision = body && body.decision;
      if (!decision || !ids.length) return { resolved: 0, errors: [] };
      const resolved = [];
      const errors = [];
      ids.forEach(id => {
        const item = STORE.reviewItems.find(r => r.id === id);
        if (!item) { errors.push({ id, error: 'Not found' }); return; }
        if (item.queue_status !== 'pending') { errors.push({ id, error: 'Already resolved' }); return; }
        item.queue_status = decision;
        item.resolved_at = new Date().toISOString();
        item.resolved_by = STORE.currentUser.id;
        if (decision === 'approved') {
          const ph = STORE.pharmacies.find(p => p.id === item.pharmacy_id);
          if (ph && item.flag_type === 'new_pharmacy') { ph.status = 'active'; ph.verification_status = 'verified'; }
          else if (ph) { ph.status = item.flag_type === 'closed' ? 'closed' : 'invalid'; ph.verification_status = 'verified'; }
        }
        resolved.push(id);
      });
      STORE.auditEvents.unshift({ id: genId('ae'), action: 'review.batch_resolved', entity_type: 'review_item',
        entity_id: resolved.join(','), user_name: currentUserName(), created_at: new Date().toISOString() });
      return { resolved: resolved.length, errors };
    }

    /* ─── Tracking ─────────────────────────────────────────────── */
    if (method === 'GET' && path === '/tracking/positions') {
      return STORE.reps.map(r => ({
        rep_id: r.user_id,
        full_name: r.full_name,
        lat: r.last_lat,
        lng: r.last_lng,
        recorded_at: r.last_seen,
        color: r.color || null,
        home_lat: r.home_lat || null,
        home_lng: r.home_lng || null,
      }));
    }

    if (method === 'POST' && path === '/tracking/ping') {
      if (body && body.lat && body.lng) {
        const rep = STORE.reps.find(r => r.user_id === (body.rep_id || STORE.currentUser.id));
        if (rep) {
          rep.last_lat = body.lat;
          rep.last_lng = body.lng;
          rep.last_seen = new Date().toISOString();
        }
      }
      return { id: genId('ping'), status: 'ok' };
    }

    if (method === 'POST' && path === '/tracking/checkin') {
      const pharmacy = STORE.pharmacies.find(p => p.id === body.pharmacy_id);
      let distanceM = null;
      if (pharmacy && body.lat != null && body.lng != null) {
        distanceM = Math.round(haversineMeters(body.lat, body.lng, pharmacy.lat, pharmacy.lng));
      } else {
        const roll = Math.random();
        if (roll < 0.6) distanceM = Math.round(Math.random() * 50);
        else if (roll < 0.85) distanceM = Math.round(50 + Math.random() * 450);
        else distanceM = Math.round(500 + Math.random() * 1500);
      }
      const checkin = {
        id: genId('ci'),
        rep_id: body.rep_id || STORE.currentUser.id,
        pharmacy_id: body.pharmacy_id,
        assignment_stop_id: body.assignment_stop_id || null,
        lat: body.lat || null,
        lng: body.lng || null,
        distance_to_pharmacy_m: distanceM,
        distance_warning: distanceM != null && distanceM > 500,
        created_at: new Date().toISOString(),
      };
      STORE.checkins.push(checkin);
      return checkin;
    }

    if ((params = matchPath('/tracking/checkins/:repId', path)) && method === 'GET') {
      const repCheckins = STORE.checkins.filter(c => c.rep_id === params.repId);
      return repCheckins.map(c => {
        const ph = STORE.pharmacies.find(p => p.id === c.pharmacy_id);
        return { ...c, pharmacy_name: ph ? ph.name : 'Unknown' };
      });
    }

    if ((params = matchPath('/tracking/breadcrumbs/:repId', path)) && method === 'GET') {
      const rep = STORE.reps.find(r => r.user_id === params.repId);
      if (!rep) return [];
      const generatedTrail = STORE.breadcrumbsByRep[params.repId];
      return Array.isArray(generatedTrail) && generatedTrail.length ? generatedTrail : generateBreadcrumbs(rep, 30);
    }

    /* ─── Visits ───────────────────────────────────────────────── */
    if (method === 'GET' && path.startsWith('/visits/pharmacy/')) {
      const pharmaId = path.split('/').pop();
      return STORE.visits.filter(v => v.pharmacy_id === pharmaId);
    }

    if (method === 'POST' && path === '/visits') {
      const nv = { id: genId('v'), pharmacy_id: body.pharmacy_id, rep_id: body.rep_id || STORE.currentUser.id,
        outcome: body.outcome, notes: body.notes, order_potential: body.order_potential,
        contact_person: body.contact_person, contact_phone: body.contact_phone,
        competitor_products: body.competitor_products, stock_observations: body.stock_observations,
        follow_up_date: body.follow_up_date, follow_up_reason: body.follow_up_reason,
        flag_reason: body.flag_reason, checkin_lat: body.checkin_lat, checkin_lng: body.checkin_lng,
        created_at: new Date().toISOString() };
      STORE.visits.push(nv);

      const ph = STORE.pharmacies.find(p => p.id === body.pharmacy_id);
      if (ph) { ph.last_visit_outcome = body.outcome; ph.last_visited_at = nv.created_at; }

      if (body.assignment_stop_id) {
        const isSkip = OUTCOMES_SKIPPING_STOP.includes(body.outcome);
        const stopStatus = isSkip ? 'skipped' : 'completed';
        for (const a of STORE.assignments) {
          if (!a.pharmacy_ids) continue;
          const pidIndex = a.pharmacy_ids.indexOf(body.pharmacy_id);
          if (pidIndex === -1) continue;
          const expectedStopId = `stop_${a.id}_${pidIndex}`;
          if (expectedStopId === body.assignment_stop_id || a.pharmacy_ids.includes(body.pharmacy_id)) {
            if (!a.stop_statuses) a.stop_statuses = {};
            a.stop_statuses[body.pharmacy_id] = stopStatus;
            recomputeAssignmentCounts(a);
            break;
          }
        }
      }

      if (body.outcome === 'interested') {
        STORE.commercialLeads.push({ id: genId('cl'), pharmacy_id: body.pharmacy_id, visit_id: nv.id,
          status: 'interested', potential_sales: body.order_potential || 0,
          contact_person: body.contact_person, contact_phone: body.contact_phone,
          notes: body.notes, created_at: nv.created_at });
      }

      const repObj = STORE.reps.find(r => r.user_id === nv.rep_id);
      if (repObj) {
        repObj.total_visits++;
        if (body.outcome === 'interested') repObj.interested_count++;
        const repPharmacies = new Set(STORE.visits.filter(v => v.rep_id === nv.rep_id).map(v => v.pharmacy_id));
        repObj.unique_pharmacies = repPharmacies.size;
      }

      STORE.auditEvents.unshift({ id: genId('ae'), action: 'visit.submitted', entity_type: 'visit',
        entity_id: nv.id, user_name: currentUserName(), created_at: nv.created_at });

      return nv;
    }

    if (method === 'POST' && path.includes('/photos')) {
      return { id: genId('ph'), status: 'uploaded' };
    }

    /* ─── Commercial Leads ─────────────────────────────────────── */
    if (method === 'GET' && path.startsWith('/commercial-leads')) {
      if ((params = matchPath('/commercial-leads/pharmacy/:pharmacyId', path))) {
        return STORE.commercialLeads.filter(l => l.pharmacy_id === params.pharmacyId);
      }
      return STORE.commercialLeads;
    }

    if ((params = matchPath('/commercial-leads/:id', path)) && method === 'PATCH') {
      const lead = STORE.commercialLeads.find(l => l.id === params.id);
      if (!lead) return { error: 'Lead not found', status: 404 };

      if (body.status && body.status !== lead.status) {
        const allowed = LEAD_TRANSITIONS[lead.status] || [];
        if (!allowed.includes(body.status)) {
          return { error: `Invalid lead transition: ${lead.status} → ${body.status}`, status: 422 };
        }
      }

      const before = { ...lead };
      if (body.status !== undefined) lead.status = body.status;
      if (body.notes !== undefined) lead.notes = body.notes;
      if (body.potential_sales !== undefined) lead.potential_sales = body.potential_sales;
      if (body.contact_person !== undefined) lead.contact_person = body.contact_person;
      if (body.contact_phone !== undefined) lead.contact_phone = body.contact_phone;
      lead.updated_at = new Date().toISOString();

      STORE.auditEvents.unshift({ id: genId('ae'), action: 'lead.updated', entity_type: 'commercial_lead',
        entity_id: lead.id, user_name: currentUserName(), created_at: lead.updated_at,
        detail: { before_status: before.status, after_status: lead.status } });

      return lead;
    }

    /* ─── Audit ────────────────────────────────────────────────── */
    if (method === 'GET' && path === '/audit') {
      return STORE.auditEvents;
    }

    if ((params = matchPath('/audit/:entityType/:entityId', path)) && method === 'GET') {
      return STORE.auditEvents.filter(e => e.entity_type === params.entityType && e.entity_id === params.entityId);
    }

    /* ─── Reporting Export ─────────────────────────────────────── */
    if (method === 'GET' && path.startsWith('/reporting/export')) {
      return STORE.pharmacies;
    }

    return null;
  }

  function polygonsOverlap(p1, p2) {
    if (!p1?.coordinates?.[0] || !p2?.coordinates?.[0]) return false;
    const r1 = p1.coordinates[0], r2 = p2.coordinates[0];
    const b1 = ringBBox(r1), b2 = ringBBox(r2);
    return !(b1.maxLng < b2.minLng || b1.minLng > b2.maxLng || b1.maxLat < b2.minLat || b1.minLat > b2.maxLat);
  }
  function ringBBox(ring) {
    const lngs = ring.map(c => c[0]), lats = ring.map(c => c[1]);
    return { minLng: Math.min(...lngs), maxLng: Math.max(...lngs), minLat: Math.min(...lats), maxLat: Math.max(...lats) };
  }

  function patchAPI() {
    const origGet = API.get.bind(API);
    const origPost = API.post.bind(API);
    const origPatch = API.patch.bind(API);
    const origUpload = API.upload.bind(API);

    API.get = async (path) => {
      const result = route('GET', path);
      return result !== null ? result : origGet(path);
    };
    API.post = async (path, body) => {
      const result = route('POST', path, body);
      return result !== null ? result : origPost(path, body);
    };
    API.patch = async (path, body) => {
      const result = route('PATCH', path, body);
      return result !== null ? result : origPatch(path, body);
    };
    API.upload = async (path, formData) => {
      const result = route('POST', path);
      return result !== null ? result : origUpload(path, formData);
    };
  }

  return { active, ready, STORE, PHARMACIES: STORE.pharmacies, ASSIGNMENTS: STORE.assignments,
    REVIEW_ITEMS: STORE.reviewItems, KPIS: buildKPIs(), REPS: STORE.reps,
    VISITS: STORE.visits, LEADS: STORE.commercialLeads, AUDIT: STORE.auditEvents,
    patchAPI, route, genId, pointInPolygon, buildKPIs, buildCoverage };
})();
