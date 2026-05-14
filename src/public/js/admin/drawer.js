/**
 * Admin Cockpit drawer — 7 sub-views, lazy-loaded on tab click.
 *
 * Each subview owns a renderer that:
 *   1. Shows skeletons immediately
 *   2. Fetches data from /api/admin/cockpit/<endpoint>
 *   3. Renders rich content with tables, mini-stats, charts
 *
 * No framework — vanilla DOM + Chart.js for charts.
 */
(function () {
  const VIEWS = {};
  const charts = []; // active Chart.js instances to destroy on tab change
  let active = 'ops';
  let body = null;
  let onCounts = null; // optional callback for counters

  function init(bodyEl, opts = {}) {
    body = bodyEl;
    onCounts = opts.onCounts || null;
    // bind tabs
    document.querySelectorAll('.drawer-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.drawer-tab').forEach((b) => b.removeAttribute('data-active'));
        btn.setAttribute('data-active', 'true');
        switchTo(btn.dataset.drawer);
      });
    });
    switchTo(active);
  }

  function switchTo(viewKey) {
    active = viewKey;
    destroyCharts();
    skeleton();
    const view = VIEWS[viewKey];
    if (!view) {
      body.innerHTML = `<div class="empty"><div class="empty-title">Vista no implementada</div></div>`;
      return;
    }
    view().catch((err) => {
      console.error('[admin/drawer]', viewKey, err);
      body.innerHTML = `<div class="empty"><div class="empty-title">Error al cargar</div><div class="empty-sub">${escapeHtml(err.message || 'desconocido')}</div></div>`;
    });
  }

  function skeleton() {
    body.innerHTML = `
      <div class="drawer-grid-3" style="margin-bottom:18px">
        <div class="stat-mini"><div class="stat-mini-label">Cargando…</div><div class="skeleton skeleton-num" style="height:28px"></div></div>
        <div class="stat-mini"><div class="stat-mini-label">Cargando…</div><div class="skeleton skeleton-num" style="height:28px"></div></div>
        <div class="stat-mini"><div class="stat-mini-label">Cargando…</div><div class="skeleton skeleton-num" style="height:28px"></div></div>
      </div>
      <div class="skeleton skeleton-block"></div>
    `;
  }

  function destroyCharts() {
    while (charts.length) {
      try { charts.pop().destroy(); } catch (_) {}
    }
  }

  function pushChart(chart) {
    if (chart) charts.push(chart);
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  function formatNum(n) {
    return Number(n || 0).toLocaleString('es-MX');
  }

  function formatCurrency(n) {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(Number(n || 0));
  }

  function formatPct(n, decimals = 1) {
    if (n == null) return '—';
    return Number(n).toFixed(decimals) + '%';
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return `hace ${sec}s`;
    if (sec < 3600) return `hace ${Math.round(sec / 60)}m`;
    if (sec < 86400) return `hace ${Math.round(sec / 3600)}h`;
    return `hace ${Math.round(sec / 86400)}d`;
  }

  // Map of backend column keys → user-facing Spanish labels for CSV exports.
  // The platform UI is in Spanish, so the downloaded file should be too.
  // Keys not in the map fall through with a best-effort title-case render
  // (e.g. `assignment_id` → `Assignment id`) — add an entry here when you
  // see an English column slip into a CSV.
  const CSV_HEADER_LABELS_ES = {
    // people / activity matrix
    user_id: 'ID de usuario',
    full_name: 'Nombre completo',
    email: 'Correo',
    role: 'Rol',
    visits: 'Visitas',
    compliance_pct: 'Cumplimiento (%)',
    conversion_pct: 'Conversión (%)',
    n: 'Cantidad',
    count: 'Cantidad',
    hour: 'Hora',
    dow: 'Día',
    day: 'Día',
    day_of_week: 'Día de la semana',
    // coverage / untouched
    farmacia_nombre: 'Farmacia',
    cpadre: 'C-padre',
    pareto: 'Pareto',
    delegacion_municipio: 'Municipio',
    last_completed: 'Última visita',
    name: 'Nombre',
    total: 'Padrón',
    visited: 'Visitadas',
    pct: 'Cobertura (%)',
    // anomalies
    severity: 'Severidad',
    rep_id: 'ID del rep',
    rep_name: 'Rep',
    pharmacy_id: 'ID de farmacia',
    pharmacy_name: 'Farmacia',
    distance_to_pharmacy_m: 'Distancia (m)',
    accuracy_meters: 'Precisión GPS (m)',
    recorded_at: 'Registrado',
    created_at: 'Creado',
    updated_at: 'Actualizado',
    started_at: 'Inicio',
    ended_at: 'Fin',
    status: 'Estado',
    notes: 'Notas',
    outcome: 'Resultado',
  };

  function csvHeaderLabel(key) {
    if (CSV_HEADER_LABELS_ES[key]) return CSV_HEADER_LABELS_ES[key];
    // Best-effort title-case: "lat_min" → "Lat min".
    return String(key)
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function exportButton(label, filename, getRows, columnLabels = null) {
    const btn = document.createElement('button');
    btn.className = 'btn-export';
    btn.textContent = label || 'Exportar CSV';
    btn.addEventListener('click', () => {
      const rows = getRows();
      if (!rows || !rows.length) return;
      const keys = Object.keys(rows[0]);
      const headers = keys.map((k) => csvCell(
        columnLabels && columnLabels[k] ? columnLabels[k] : csvHeaderLabel(k),
      ));
      const csv = [headers.join(',')]
        .concat(rows.map((r) => keys.map((h) => csvCell(r[h])).join(',')))
        .join('\n');
      // BOM helps Excel render UTF-8 (acentos, ñ) correctly on Windows.
      const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename || 'export.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
    return btn;
  }

  function csvCell(v) {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  }

  function rangeQuery() {
    return window.AdminCockpit?.getRange?.() || {};
  }

  function rangeQS(extra = '') {
    const r = rangeQuery();
    const q = new URLSearchParams();
    if (r.from) q.set('from', r.from);
    if (r.to) q.set('to', r.to);
    const out = q.toString();
    return (out ? '?' + out : '') + (extra ? (out ? '&' : '?') + extra : '');
  }

  // ── OPERATIONS ─────────────────────────────────────────────────
  VIEWS.ops = async function renderOps() {
    const data = await API.get('/admin/cockpit/operations' + rangeQS());
    const rot = data.routes_on_time || {};
    const idle = data.idle || {};
    const dev = data.deviations || {};
    const drive = data.drive_time || {};

    body.innerHTML = `
      <div class="drawer-grid-3" style="margin-bottom:24px">
        <div class="stat-mini">
          <div class="stat-mini-label">Rutas a tiempo</div>
          <div class="stat-mini-value numeral">${rot.pct == null ? '—' : rot.pct + '%'}</div>
          <div class="stat-mini-foot">${formatNum(rot.on_time)} / ${formatNum(rot.started)} iniciadas</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Idle p50 / p90</div>
          <div class="stat-mini-value numeral">${Math.round(idle.p50_seconds / 60)}m</div>
          <div class="stat-mini-foot">p90: ${Math.round(idle.p90_seconds / 60)}m</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Desvíos registrados</div>
          <div class="stat-mini-value numeral">${formatNum(dev.total)}</div>
          <div class="stat-mini-foot">${formatNum(dev.traffic)} tráfico · ${formatNum(dev.closed_pharmacy)} cerrada</div>
        </div>
      </div>

      <div class="drawer-grid-2">
        <div>
          <div class="cockpit-section-sub">Reoptimizaciones intradía</div>
          ${renderReoptTable(data.reoptimizations || [])}
        </div>
        <div>
          <div class="cockpit-section-sub">Sesiones de visita</div>
          ${renderSessionsTable(data.sessions || [])}
        </div>
      </div>

      <div style="margin-top:24px">
        <div class="cockpit-section-sub">Tiempo de manejo: real vs esperado</div>
        <div style="display:flex; gap:24px; align-items:baseline">
          <div>
            <div class="stat-mini-label">Real</div>
            <div class="trend-totals-value numeral">${drive.avg_actual_min ? Math.round(drive.avg_actual_min) + 'm' : '—'}</div>
          </div>
          <div>
            <div class="stat-mini-label">Esperado</div>
            <div class="trend-totals-value numeral">${drive.avg_expected_min ? Math.round(drive.avg_expected_min) + 'm' : '—'}</div>
          </div>
          <div>
            <div class="stat-mini-label">Delta</div>
            <div class="trend-totals-value numeral ${(drive.avg_actual_min || 0) > (drive.avg_expected_min || 0) ? 'text-neg' : 'text-pos'}">
              ${drive.avg_actual_min && drive.avg_expected_min ? (drive.avg_actual_min - drive.avg_expected_min > 0 ? '+' : '') + Math.round(drive.avg_actual_min - drive.avg_expected_min) + 'm' : '—'}
            </div>
          </div>
        </div>
      </div>
    `;
  };

  function renderReoptTable(rows) {
    if (!rows.length) return '<div class="empty"><div class="empty-sub">Sin reoptimizaciones en el período.</div></div>';
    return `<table class="table">
      <thead><tr><th>Trigger</th><th>Outcome</th><th class="table-num">N</th><th class="table-num">Avg ms</th><th class="table-num">Avg locked</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="table-strong">${escapeHtml(r.trigger_kind || '—')}</td>
        <td><span class="badge badge-${r.outcome === 'success' ? 'pos' : r.outcome === 'rejected' ? 'neg' : 'warn'}">${escapeHtml(r.outcome || '—')}</span></td>
        <td class="table-num">${formatNum(r.n)}</td>
        <td class="table-num muted">${formatNum(r.avg_ms)}</td>
        <td class="table-num muted">${r.avg_locked == null ? '—' : Number(r.avg_locked).toFixed(1)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function renderSessionsTable(rows) {
    if (!rows.length) return '<div class="empty"><div class="empty-sub">Sin sesiones en el período.</div></div>';
    return `<table class="table">
      <thead><tr><th>Status</th><th>Razón</th><th class="table-num">N</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><span class="badge badge-${r.status === 'active' ? 'pos' : r.status === 'abandoned' ? 'neg' : ''}">${escapeHtml(r.status || '—')}</span></td>
        <td class="muted">${escapeHtml(r.ended_reason || '—')}</td>
        <td class="table-num table-strong">${formatNum(r.n)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  // ── GEOGRAPHIC ─────────────────────────────────────────────────
  VIEWS.geo = async function renderGeo() {
    const [coverage, untouched] = await Promise.all([
      API.get('/admin/cockpit/coverage-heatmap?level=poblacion&days=30'),
      API.get('/analytics/untouched?days_without=30&limit=50').catch(() => []),
    ]);
    const features = coverage.features || [];
    const totalFarms = features.reduce((s, f) => s + (f.total || 0), 0);
    const visited = features.reduce((s, f) => s + (f.visited || 0), 0);
    const pctOverall = totalFarms ? Number(((visited * 100) / totalFarms).toFixed(1)) : 0;

    body.innerHTML = `
      <div class="drawer-grid-3" style="margin-bottom:24px">
        <div class="stat-mini"><div class="stat-mini-label">Padrón total</div><div class="stat-mini-value numeral">${formatNum(totalFarms)}</div></div>
        <div class="stat-mini"><div class="stat-mini-label">Visitadas 30d</div><div class="stat-mini-value numeral">${formatNum(visited)}</div></div>
        <div class="stat-mini"><div class="stat-mini-label">Cobertura global</div><div class="stat-mini-value numeral">${pctOverall}%</div></div>
      </div>

      <div class="drawer-grid-2">
        <div>
          <div class="cockpit-section-sub">Top poblaciones por cobertura</div>
          ${renderCoverageTable(features.slice(0, 12), 'desc-pct')}
        </div>
        <div>
          <div class="cockpit-section-sub">Bottom poblaciones (oportunidad)</div>
          ${renderCoverageTable(features.slice().sort((a, b) => a.pct - b.pct).slice(0, 12), 'asc-pct')}
        </div>
      </div>

      <div style="margin-top:24px; display:flex; align-items:center; justify-content:space-between">
        <div class="cockpit-section-sub">Sin tocar (clientes Marzam sin visita 30d)</div>
        <div id="geo-export-btn-wrap"></div>
      </div>
      ${renderUntouchedTable(untouched)}
    `;

    const wrap = document.getElementById('geo-export-btn-wrap');
    if (wrap && untouched.length) wrap.appendChild(exportButton('Exportar CSV', 'sin-tocar.csv', () => untouched));

    // Update map untouched markers from this view
    if (window.AdminBigMap) window.AdminBigMap.setUntouchedData(untouched);
  };

  function renderCoverageTable(rows, sortLabel) {
    if (!rows || !rows.length) return '<div class="empty"><div class="empty-sub">Sin datos.</div></div>';
    return `<table class="table">
      <thead><tr><th>Población</th><th class="table-num">Padrón</th><th class="table-num">Visitadas</th><th class="table-num">%</th></tr></thead>
      <tbody>${rows.map((f) => `<tr>
        <td class="table-strong">${escapeHtml(f.name || '—')}</td>
        <td class="table-num">${formatNum(f.total)}</td>
        <td class="table-num">${formatNum(f.visited)}</td>
        <td class="table-num"><span class="badge badge-${f.pct >= 80 ? 'pos' : f.pct >= 40 ? 'warn' : 'neg'}">${f.pct}%</span></td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function renderUntouchedTable(rows) {
    if (!rows || !rows.length) return '<div class="empty"><div class="empty-sub">No hay clientes sin visita en este período.</div></div>';
    return `<table class="table">
      <thead><tr><th>Cliente</th><th>Cpadre</th><th>Pareto</th><th>Municipio</th><th>Última visita</th></tr></thead>
      <tbody>${rows.slice(0, 50).map((r) => `<tr>
        <td class="table-strong">${escapeHtml(r.farmacia_nombre || '—')}</td>
        <td class="muted">${escapeHtml(r.cpadre || '—')}</td>
        <td><span class="badge badge-${r.pareto === 'A' ? 'neg' : r.pareto === 'B' ? 'warn' : 'info'}">${escapeHtml(r.pareto || '—')}</span></td>
        <td class="muted">${escapeHtml(r.delegacion_municipio || '—')}</td>
        <td class="muted">${r.last_completed ? timeAgo(r.last_completed) : 'nunca'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  // ── PEOPLE ─────────────────────────────────────────────────────
  VIEWS.people = async function renderPeople() {
    const data = await API.get('/admin/cockpit/people' + rangeQS());
    const ranking = data.ranking || [];
    const heatmap = data.compliance_heatmap || [];

    body.innerHTML = `
      <div class="drawer-grid-2" style="margin-bottom:24px">
        <div>
          <div class="cockpit-section-sub">Ranking por visitas</div>
          ${renderPeopleTable(ranking.slice(0, 25))}
        </div>
        <div>
          <div class="cockpit-section-sub">Heatmap de compliance (28 días)</div>
          <div id="people-heatmap"></div>
        </div>
      </div>

      <div style="margin-top:24px; display:flex; justify-content:space-between; align-items:center">
        <div class="cockpit-section-sub">Activity matrix · hora × día</div>
        <div id="people-export-wrap"></div>
      </div>
      <div style="overflow-x:auto"><canvas id="people-activity-chart" style="height:200px;width:100%"></canvas></div>
    `;

    renderPeopleHeatmap(document.getElementById('people-heatmap'), heatmap, ranking.slice(0, 25));
    renderActivityMatrix(document.getElementById('people-activity-chart'), data.activity_matrix || []);

    const wrap = document.getElementById('people-export-wrap');
    if (wrap && ranking.length) wrap.appendChild(exportButton('Exportar ranking', 'ranking-personas.csv', () => ranking));
  };

  function renderPeopleTable(rows) {
    if (!rows.length) return '<div class="empty"><div class="empty-sub">Sin datos en el período.</div></div>';
    return `<table class="table">
      <thead><tr><th>Persona</th><th>Rol</th><th class="table-num">Visitas</th><th class="table-num">Compl.</th><th class="table-num">Conv.</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td class="table-strong">
          <span style="display:inline-block;width:18px;color:#a3a3a3;font-size:11px">${i + 1}</span>
          ${escapeHtml(r.full_name || '—')}
        </td>
        <td class="muted">${escapeHtml(r.role || '—')}</td>
        <td class="table-num">${formatNum(r.visits)}</td>
        <td class="table-num">${r.compliance_pct == null ? '—' : r.compliance_pct + '%'}</td>
        <td class="table-num muted">${r.conversion_pct == null ? '—' : r.conversion_pct + '%'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function renderPeopleHeatmap(container, heatmap, ranking) {
    if (!container) return;
    const userIds = ranking.map((r) => r.user_id);
    const userMap = new Map(ranking.map((r) => [r.user_id, r.full_name]));
    const days = [];
    const today = new Date();
    for (let i = 27; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    // pivot
    const grid = new Map();
    for (const cell of heatmap) {
      const key = cell.user_id + '|' + cell.day;
      grid.set(key, cell.pct);
    }

    function bucket(pct) {
      if (pct == null) return 0;
      if (pct < 25) return 1;
      if (pct < 50) return 2;
      if (pct < 70) return 3;
      if (pct < 85) return 4;
      if (pct < 95) return 5;
      return 6;
    }

    if (!userIds.length) {
      container.innerHTML = '<div class="empty"><div class="empty-sub">Sin datos para heatmap.</div></div>';
      return;
    }

    const html = userIds.slice(0, 18).map((uid) => {
      const name = (userMap.get(uid) || '').slice(0, 22);
      const cells = days.map((d) => {
        const pct = grid.get(uid + '|' + d);
        const b = bucket(pct);
        return `<div class="heatmap-cell" data-bucket="${b}" title="${escapeHtml(name)} · ${d} · ${pct == null ? 'sin plan' : pct + '%'}"></div>`;
      }).join('');
      return `<div style="display:flex; align-items:center; gap:8px; margin-bottom:3px">
        <div style="width:130px; font-size:11px; color:#525252; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${escapeHtml(name)}</div>
        <div style="display:grid; grid-template-columns: repeat(28, 14px); gap:2px">${cells}</div>
      </div>`;
    }).join('');
    container.innerHTML = html;
  }

  function renderActivityMatrix(canvas, rows) {
    if (!canvas) return;
    const dows = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const labels = [];
    const values = [];
    // group by hour-of-day across all dows (simpler heatmap: 24 hours)
    const byHour = new Array(24).fill(0);
    rows.forEach((r) => {
      byHour[r.hour] = (byHour[r.hour] || 0) + r.n;
    });
    for (let h = 6; h <= 22; h++) {
      labels.push(h + 'h');
      values.push(byHour[h]);
    }
    const c = window.AdminCharts.horizontalBars(canvas, labels, values);
    pushChart(c);
  }

  // ── COMMERCIAL ─────────────────────────────────────────────────
  VIEWS.commercial = async function renderCommercial() {
    const data = await API.get('/admin/cockpit/commercial' + rangeQS());
    const svt = data.sales_vs_target || {};
    const fn = data.funnel || {};

    body.innerHTML = `
      <div class="drawer-grid-3" style="margin-bottom:24px">
        <div class="stat-mini">
          <div class="stat-mini-label">Avance MTD</div>
          <div class="stat-mini-value numeral">${formatCurrency(svt.actual)}</div>
          <div class="stat-mini-foot">de ${formatCurrency(svt.target)} (${svt.pct == null ? '—' : svt.pct + '%'})</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Forecast cierre mes</div>
          <div class="stat-mini-value numeral">${formatCurrency(svt.forecast_eom)}</div>
          <div class="stat-mini-foot">${svt.forecast_pct_target == null ? '—' : svt.forecast_pct_target + '% target'}</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Conversión leads</div>
          <div class="stat-mini-value numeral">${fn.total ? Math.round((fn.converted * 100) / fn.total) + '%' : '—'}</div>
          <div class="stat-mini-foot">${formatNum(fn.converted)} de ${formatNum(fn.total)}</div>
        </div>
      </div>

      <div class="drawer-grid-2">
        <div>
          <div class="cockpit-section-sub">Top 20 clientes por monto</div>
          ${renderTopClients(data.top_clients || [])}
        </div>
        <div>
          <div class="cockpit-section-sub">Razones de no-orden</div>
          ${renderLostReasons(data.lost_reasons || [])}
        </div>
      </div>

      <div style="margin-top:24px">
        <div class="cockpit-section-sub">Funnel de leads</div>
        ${renderLeadsFunnel(fn)}
      </div>

      <div style="margin-top:24px">
        <div class="cockpit-section-sub">Segmentación RFM</div>
        ${renderRFM(data.rfm_buckets || [])}
      </div>
    `;
  };

  function renderTopClients(rows) {
    if (!rows.length) return '<div class="empty"><div class="empty-sub">Sin ventas en el período.</div></div>';
    const max = Math.max(...rows.map((r) => Number(r.amount) || 0), 1);
    return `<table class="table">
      <thead><tr><th>Cliente</th><th>Pareto</th><th class="table-num">Monto</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="table-strong" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.farmacia_nombre || '—')}</td>
        <td><span class="badge badge-${r.pareto === 'A' ? 'neg' : r.pareto === 'B' ? 'warn' : 'info'}">${escapeHtml(r.pareto || '—')}</span></td>
        <td class="table-num">
          <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
            <div style="width:60px;height:4px;background:#f0f0f0;border-radius:2px;position:relative;overflow:hidden">
              <div style="position:absolute;left:0;top:0;bottom:0;background:#0a0a0a;width:${(r.amount / max) * 100}%"></div>
            </div>
            <span class="table-strong">${formatCurrency(r.amount)}</span>
          </div>
        </td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function renderLostReasons(rows) {
    if (!rows.length) return '<div class="empty"><div class="empty-sub">Sin razones registradas.</div></div>';
    return `<table class="table">
      <thead><tr><th>Razón</th><th class="table-num">N</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${escapeHtml(r.reason || '—')}</td>
        <td class="table-num table-strong">${formatNum(r.n)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function renderLeadsFunnel(fn) {
    const stages = [
      { k: 'interested', label: 'Interesado' },
      { k: 'contact_captured', label: 'Contacto capturado' },
      { k: 'follow_up_required', label: 'Seguimiento' },
      { k: 'converted', label: 'Convertido' },
      { k: 'lost', label: 'Perdido' },
    ];
    const max = Math.max(...stages.map((s) => fn[s.k] || 0), 1);
    return `<div style="display:grid; gap:8px">
      ${stages.map((s) => `
        <div style="display:flex; align-items:center; gap:14px">
          <div style="width:160px; font-size:12px; color:#525252">${s.label}</div>
          <div style="flex:1; height:20px; background:#f5f5f5; border-radius:4px; position:relative">
            <div style="position:absolute; left:0; top:0; bottom:0; width:${((fn[s.k] || 0) / max) * 100}%; background:${s.k === 'converted' ? '#15803d' : s.k === 'lost' ? '#b91c1c' : '#0a0a0a'}; border-radius:4px"></div>
          </div>
          <div style="width:60px; text-align:right; font-variant-numeric:tabular-nums; font-weight:500">${formatNum(fn[s.k])}</div>
        </div>
      `).join('')}
    </div>`;
  }

  function renderRFM(rows) {
    if (!rows.length) return '<div class="empty"><div class="empty-sub">Sin segmentación disponible (mv_pharmacy_sales_rollups vacía).</div></div>';
    return `<table class="table">
      <thead><tr><th>Recencia</th><th>Frecuencia</th><th>Monetario</th><th class="table-num">N</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td><span class="badge badge-${r.recency_bucket === 'fresh' ? 'pos' : r.recency_bucket === 'warm' ? 'warn' : 'neg'}">${r.recency_bucket}</span></td>
        <td>${r.frequency_bucket}</td>
        <td>${r.monetary_bucket}</td>
        <td class="table-num table-strong">${formatNum(r.n)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  // ── ONBOARDING ─────────────────────────────────────────────────
  VIEWS.onboarding = async function renderOnboarding() {
    const data = await API.get('/admin/cockpit/onboarding' + rangeQS());
    const fn = data.funnel || [];
    const st = data.stage_times || {};
    const splits = data.splits || {};

    const total = fn.reduce((s, r) => s + (r.n || 0), 0);
    const approved = fn.filter((r) => /approved/.test(r.status)).reduce((s, r) => s + r.n, 0);
    const rejected = fn.find((r) => r.status === 'rejected')?.n || 0;

    body.innerHTML = `
      <div class="drawer-grid-3" style="margin-bottom:24px">
        <div class="stat-mini">
          <div class="stat-mini-label">Onboardings totales</div>
          <div class="stat-mini-value numeral">${formatNum(total)}</div>
          <div class="stat-mini-foot">${formatNum(approved)} aprobados · ${formatNum(rejected)} rechazados</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Tiempo a submit</div>
          <div class="stat-mini-value numeral">${st.avg_hours_to_submit == null ? '—' : st.avg_hours_to_submit + 'h'}</div>
          <div class="stat-mini-foot">promedio</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Tiempo a decisión</div>
          <div class="stat-mini-value numeral">${st.avg_hours_to_decision == null ? '—' : st.avg_hours_to_decision + 'h'}</div>
          <div class="stat-mini-foot">submit → aprobado/rechazado</div>
        </div>
      </div>

      <div class="drawer-grid-2">
        <div>
          <div class="cockpit-section-sub">Funnel por estado</div>
          <table class="table">
            <thead><tr><th>Estado</th><th class="table-num">N</th></tr></thead>
            <tbody>${fn.map((r) => `<tr>
              <td><span class="badge ${badgeForOnboardingStatus(r.status)}">${escapeHtml(r.status)}</span></td>
              <td class="table-num table-strong">${formatNum(r.n)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
        <div>
          <div class="cockpit-section-sub">Splits</div>
          <table class="table">
            <tbody>
              <tr><td>Persona física</td><td class="table-num table-strong">${formatNum(splits.fisica)}</td></tr>
              <tr><td>Persona moral</td><td class="table-num table-strong">${formatNum(splits.moral)}</td></tr>
              <tr><td>Pago efectivo</td><td class="table-num table-strong">${formatNum(splits.efectivo)}</td></tr>
              <tr><td>Pago crédito</td><td class="table-num table-strong">${formatNum(splits.credito)}</td></tr>
              <tr><td>Crédito aprobado</td><td class="table-num table-strong text-pos">${formatNum(splits.credit_approved)}</td></tr>
              <tr><td>Crédito rechazado</td><td class="table-num table-strong text-neg">${formatNum(splits.credit_rejected)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div style="margin-top:24px">
        <div class="cockpit-section-sub">Pendientes con menos documentos</div>
        ${renderPendingDocsTable(data.pending_docs || [])}
      </div>
    `;
  };

  function badgeForOnboardingStatus(s) {
    if (/approved/.test(s)) return 'badge-pos';
    if (s === 'rejected') return 'badge-neg';
    if (s === 'submitted' || s === 'pending_credit_review') return 'badge-warn';
    return '';
  }

  function renderPendingDocsTable(rows) {
    if (!rows.length) return '<div class="empty"><div class="empty-sub">Sin onboardings pendientes.</div></div>';
    return `<table class="table">
      <thead><tr><th>Comercial</th><th>RFC</th><th>Persona</th><th>Estado</th><th class="table-num">Docs</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="table-strong">${escapeHtml(r.nombre_comercial || '—')}</td>
        <td class="muted">${escapeHtml(r.rfc || '—')}</td>
        <td class="muted">${escapeHtml(r.persona_tipo || '—')}</td>
        <td><span class="badge ${badgeForOnboardingStatus(r.status)}">${escapeHtml(r.status)}</span></td>
        <td class="table-num"><span class="badge ${r.docs_uploaded === 0 ? 'badge-neg' : r.docs_uploaded < 3 ? 'badge-warn' : 'badge-pos'}">${r.docs_uploaded}</span></td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  // ── DATA QUALITY ───────────────────────────────────────────────
  VIEWS.quality = async function renderQuality() {
    const data = await API.get('/admin/cockpit/data-quality');
    const rq = data.review_queue || {};
    const q = data.quadrants || {};
    const p = data.pareto || {};
    const g = data.geocoding || {};
    const ij = data.import_jobs_30d || {};

    body.innerHTML = `
      <div class="drawer-grid-3" style="margin-bottom:24px">
        <div class="stat-mini">
          <div class="stat-mini-label">Cola de revisión</div>
          <div class="stat-mini-value numeral">${formatNum(rq.queue_total_pending)}</div>
          <div class="stat-mini-foot">${formatNum(rq.duplicates_pending)} duplicados · más antiguo ${rq.oldest_pending ? timeAgo(rq.oldest_pending) : '—'}</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Visitas sin foto (90d)</div>
          <div class="stat-mini-value numeral ${(data.missing_photos_90d || 0) > 0 ? 'text-neg' : 'text-pos'}">${formatNum(data.missing_photos_90d)}</div>
          <div class="stat-mini-foot">contrato: 0 esperado</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Reps geocodificados</div>
          <div class="stat-mini-value numeral">${g.pct == null ? '—' : g.pct + '%'}</div>
          <div class="stat-mini-foot">${formatNum(g.geocoded)} de ${formatNum(g.total)}</div>
        </div>
      </div>

      <div class="drawer-grid-3">
        <div class="stat-mini">
          <div class="stat-mini-label">Cuadrantes divergentes</div>
          <div class="stat-mini-value numeral">${formatNum(q.quadrant_divergence)}</div>
          <div class="stat-mini-foot">${formatNum(q.missing_quadrant)} sin cuadrante</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Pareto divergente</div>
          <div class="stat-mini-value numeral">${formatNum(p.pareto_divergence)}</div>
          <div class="stat-mini-foot">de ${formatNum(p.total_pairs)} pares</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Sync warnings (7d)</div>
          <div class="stat-mini-value numeral">${formatNum(data.sync_warnings_7d)}</div>
          <div class="stat-mini-foot">de bq_sync_warnings</div>
        </div>
      </div>

      <div style="margin-top:24px">
        <div class="cockpit-section-sub">Imports últimos 30 días</div>
        <div class="drawer-grid-3">
          <div class="stat-mini"><div class="stat-mini-label">Total</div><div class="stat-mini-value numeral">${formatNum(ij.total)}</div></div>
          <div class="stat-mini"><div class="stat-mini-label">Fallidos</div><div class="stat-mini-value numeral text-neg">${formatNum(ij.failed)}</div></div>
          <div class="stat-mini"><div class="stat-mini-label">Parciales</div><div class="stat-mini-value numeral text-warn">${formatNum(ij.partial)}</div></div>
        </div>
      </div>

      <div style="margin-top:24px">
        <div class="cockpit-section-sub">Distribución por fuente de farmacias</div>
        ${(data.pharmacy_sources || []).length ? `<table class="table">
          <thead><tr><th>Source</th><th class="table-num">N</th></tr></thead>
          <tbody>${data.pharmacy_sources.map((r) => `<tr>
            <td><span class="badge">${escapeHtml(r.source || '—')}</span></td>
            <td class="table-num table-strong">${formatNum(r.n)}</td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="empty"><div class="empty-sub">Sin datos.</div></div>'}
      </div>
    `;
  };

  // ── SYSTEM ─────────────────────────────────────────────────────
  VIEWS.system = async function renderSystem() {
    const data = await API.get('/admin/cockpit/system');
    const ra = data.routes_api || {};
    // El backend solo devuelve today_usd / mtd_usd / daily_cap_usd al
    // blackprint_admin. Para admin Marzam mostramos uso operativo (matrix
    // calls + % del cap) sin dólares.
    const hasUsd = ra.today_usd != null || ra.mtd_usd != null;

    body.innerHTML = `
      <div class="drawer-grid-3" style="margin-bottom:24px">
        ${hasUsd ? `
        <div class="stat-mini">
          <div class="stat-mini-label">Routes API hoy</div>
          <div class="stat-mini-value numeral">$${(ra.today_usd || 0).toFixed(2)}</div>
          <div class="stat-mini-foot">${ra.pct_used == null ? '—' : ra.pct_used + '% del cap $' + ra.daily_cap_usd}</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Routes API MTD</div>
          <div class="stat-mini-value numeral">$${(ra.mtd_usd || 0).toFixed(2)}</div>
          <div class="stat-mini-foot">${formatNum(ra.today_matrix_calls)} matrix calls hoy</div>
        </div>
        ` : `
        <div class="stat-mini">
          <div class="stat-mini-label">Routes API hoy</div>
          <div class="stat-mini-value numeral">${ra.pct_used == null ? '—' : ra.pct_used + '%'}</div>
          <div class="stat-mini-foot">${formatNum(ra.today_matrix_calls)} matrix calls hoy</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Rechazos hoy</div>
          <div class="stat-mini-value numeral">${formatNum(ra.today_rejected_calls)}</div>
          <div class="stat-mini-foot">llamadas bloqueadas por cap</div>
        </div>
        `}
        <div class="stat-mini">
          <div class="stat-mini-label">Sesiones activas</div>
          <div class="stat-mini-value numeral">${formatNum(data.active_sessions)}</div>
          <div class="stat-mini-foot">visit_sessions WHERE status='active'</div>
        </div>
      </div>

      <div class="drawer-grid-2">
        <div>
          <div class="cockpit-section-sub">Cron jobs</div>
          ${renderCronTable(data.cron_runs || [])}
        </div>
        <div>
          <div class="cockpit-section-sub">Frescura de sync</div>
          ${renderSyncTable(data.sync_freshness || [])}
        </div>
      </div>

      <div style="margin-top:24px">
        <div class="cockpit-section-sub">Audit volume últimos 14 días</div>
        <div style="height:120px"><canvas id="audit-spark"></canvas></div>
      </div>

      <div style="margin-top:24px" class="drawer-grid-2">
        <div>
          <div class="cockpit-section-sub">Top entidades modificadas (7d)</div>
          ${renderTopEntities(data.audit_top_entities_7d || [])}
        </div>
        <div>
          <div class="cockpit-section-sub">Live event outbox</div>
          ${renderOutboxTable(data.live_outbox || [])}
        </div>
      </div>
    `;

    const canvas = document.getElementById('audit-spark');
    if (canvas && (data.audit_volume_14d || []).length) {
      const c = window.AdminCharts.sparkline(canvas, data.audit_volume_14d.map((r) => r.n));
      pushChart(c);
    }
  };

  function renderCronTable(rows) {
    if (!rows.length) return '<div class="empty"><div class="empty-sub">Sin cron runs registrados.</div></div>';
    return `<table class="table">
      <thead><tr><th>Job</th><th>Status</th><th>Última corrida</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="table-strong">${escapeHtml(r.job_key)}</td>
        <td><span class="badge badge-${r.last_status === 'ok' ? 'pos' : r.last_status === 'error' ? 'neg' : 'warn'}">${escapeHtml(r.last_status || '—')}</span></td>
        <td class="muted">${r.last_run_at ? timeAgo(r.last_run_at) : '—'}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function renderSyncTable(rows) {
    if (!rows.length) return '<div class="empty"><div class="empty-sub">Sin imports.</div></div>';
    return `<table class="table">
      <thead><tr><th>Tipo</th><th>Última corrida OK</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="table-strong">${escapeHtml(r.kind)}</td>
        <td class="muted">${r.last_ok ? timeAgo(r.last_ok) : 'nunca'}${r.lag_hours != null && r.lag_hours > 12 ? ' <span class="badge badge-warn">stale</span>' : ''}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function renderTopEntities(rows) {
    if (!rows.length) return '<div class="empty"><div class="empty-sub">Sin actividad audit.</div></div>';
    const max = Math.max(...rows.map((r) => r.n), 1);
    return `<table class="table">
      <thead><tr><th>Entidad</th><th class="table-num">Cambios</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="table-strong">${escapeHtml(r.entity_type || '—')}</td>
        <td class="table-num">
          <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
            <div style="width:60px;height:4px;background:#f0f0f0;border-radius:2px;position:relative">
              <div style="position:absolute;left:0;top:0;bottom:0;background:#0a0a0a;width:${(r.n / max) * 100}%"></div>
            </div>
            <span class="table-strong">${formatNum(r.n)}</span>
          </div>
        </td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function renderOutboxTable(rows) {
    if (!rows.length) return '<div class="empty"><div class="empty-sub">Outbox vacío.</div></div>';
    return `<table class="table">
      <thead><tr><th>Event</th><th class="table-num">N</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="table-strong">${escapeHtml(r.event_type || '—')}</td>
        <td class="table-num">${formatNum(r.n)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  // ── ANOMALIES ──────────────────────────────────────────────────
  VIEWS.anomalies = async function renderAnomalies() {
    const data = await API.get('/admin/cockpit/anomalies');
    const items = data.items || [];
    const by = data.counts_by_severity || {};

    if (typeof onCounts === 'function') onCounts(items.length);

    body.innerHTML = `
      <div class="drawer-grid-3" style="margin-bottom:24px">
        <div class="stat-mini"><div class="stat-mini-label">Críticas</div><div class="stat-mini-value numeral text-neg">${formatNum(by.critical)}</div></div>
        <div class="stat-mini"><div class="stat-mini-label">Warnings</div><div class="stat-mini-value numeral text-warn">${formatNum(by.warn)}</div></div>
        <div class="stat-mini"><div class="stat-mini-label">Info</div><div class="stat-mini-value numeral">${formatNum(by.info)}</div></div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="cockpit-section-sub">Feed unificado</div>
        <div id="anomaly-export-wrap"></div>
      </div>
      ${items.length ? items.map((it) => `
        <div class="anomaly-row">
          <div class="anomaly-dot" data-severity="${escapeHtml(it.severity || 'info')}"></div>
          <div>
            <div class="anomaly-title">${escapeHtml(it.title || '—')}</div>
            <div class="anomaly-meta">
              <span class="badge">${escapeHtml(it.source)}</span>
              ${it.subject ? '· ' + escapeHtml(it.subject) : ''}
              ${it.payload ? '· ' + escapeHtml(JSON.stringify(it.payload).slice(0, 80)) : ''}
            </div>
          </div>
          <div class="muted text-xs">${it.at ? timeAgo(it.at) : '—'}</div>
        </div>
      `).join('') : '<div class="empty"><div class="empty-title">Todo en orden</div><div class="empty-sub">Sin anomalías en el período.</div></div>'}
    `;

    const wrap = document.getElementById('anomaly-export-wrap');
    if (wrap && items.length) wrap.appendChild(exportButton('Exportar CSV', 'anomalias.csv', () => items.map((it) => ({
      source: it.source, severity: it.severity, title: it.title, subject: it.subject || '', at: it.at || '',
    }))));
  };

  // ── USERS — admin-only CRUD for the platform user directory ────
  // Built in response to the QA report's open question: "¿Cómo se asignan
  // roles a un usuario nuevo?". The endpoints already exist
  // (GET / POST / PATCH / DELETE on /api/users) — this view just exposes
  // them visually so admins don't need to script against the API.
  //
  // Roles dropdown intentionally lists only the canonical 5 roles plus
  // 'admin'; legacy aliases (national_admin, etc.) are accepted by the
  // backend but not surfaced here to avoid creating new accounts in the
  // soon-to-be-deprecated naming scheme.
  const USER_ROLES_FOR_CREATE = [
    { value: 'admin',              label: 'Admin (acceso global)' },
    { value: 'director_sucursal',  label: 'Director de Sucursal' },
    { value: 'gerente_ventas',     label: 'Gerente de Ventas' },
    { value: 'supervisor',         label: 'Supervisor' },
    { value: 'representante',      label: 'Representante' },
  ];

  const ROLE_LABEL_ES = {
    admin: 'Admin',
    director_sucursal: 'Director',
    gerente_ventas: 'Gerente',
    supervisor: 'Supervisor',
    representante: 'Representante',
    national_admin: 'Admin (legacy)',
    regional_manager: 'Gerente (legacy)',
    area_coordinator: 'Supervisor (legacy)',
    field_rep: 'Rep (legacy)',
    manager: 'Director (legacy)',
  };

  VIEWS.users = async function renderUsers() {
    const users = await API.get('/users').catch((err) => {
      // Some non-admin roles can hit /users as well (mgr/sup) but field_rep
      // gets 403 — we surface the message rather than crashing.
      throw err;
    });
    const list = Array.isArray(users) ? users : [];
    const total = list.length;
    const active = list.filter((u) => u.is_active !== false).length;
    const byRole = list.reduce((acc, u) => {
      const k = String(u.role || 'unknown').toLowerCase();
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    body.innerHTML = `
      <div class="drawer-grid-3" style="margin-bottom:24px">
        <div class="stat-mini">
          <div class="stat-mini-label">Total usuarios</div>
          <div class="stat-mini-value numeral">${formatNum(total)}</div>
          <div class="stat-mini-foot">${formatNum(active)} activos</div>
        </div>
        <div class="stat-mini">
          <div class="stat-mini-label">Por rol</div>
          <div class="stat-mini-value numeral" style="font-size:14px">${USER_ROLES_FOR_CREATE.map((r) => `${ROLE_LABEL_ES[r.value]}: ${byRole[r.value] || 0}`).slice(0, 3).join(' · ')}</div>
          <div class="stat-mini-foot">${USER_ROLES_FOR_CREATE.map((r) => `${ROLE_LABEL_ES[r.value]}: ${byRole[r.value] || 0}`).slice(3).join(' · ') || ''}</div>
        </div>
        <div class="stat-mini" style="display:flex;flex-direction:column;justify-content:space-between">
          <div>
            <div class="stat-mini-label">Crear nuevo</div>
            <div class="stat-mini-foot">Email + rol + contraseña inicial</div>
          </div>
          <button id="users-new-btn" class="btn-export" style="background:#0f766e;color:#fff;border-color:#0f766e;align-self:flex-start;margin-top:8px">+ Nuevo usuario</button>
        </div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div class="cockpit-section-sub">Directorio de usuarios</div>
        <div style="display:flex;gap:6px;align-items:center">
          <input id="users-search" placeholder="Buscar por nombre, email o clave…" style="font-size:11px;padding:5px 8px;border:1px solid var(--border, #e2e8f0);border-radius:4px;width:220px"/>
          <select id="users-role-filter" style="font-size:11px;padding:5px 8px;border:1px solid var(--border, #e2e8f0);border-radius:4px">
            <option value="">Todos los roles</option>
            ${USER_ROLES_FOR_CREATE.map((r) => `<option value="${r.value}">${ROLE_LABEL_ES[r.value]}</option>`).join('')}
          </select>
          <div id="users-export-wrap"></div>
        </div>
      </div>

      <div id="users-table-wrap"></div>
    `;

    const renderTable = (rows) => {
      const wrap = document.getElementById('users-table-wrap');
      if (!rows.length) {
        wrap.innerHTML = '<div class="empty"><div class="empty-sub">No se encontraron usuarios con esos filtros.</div></div>';
        return;
      }
      wrap.innerHTML = `<table class="table">
        <thead><tr>
          <th>Nombre</th><th>Email</th><th>Rol</th><th>Clave</th><th>Skills</th><th>Estado</th><th>Última sesión</th><th></th>
        </tr></thead>
        <tbody>${rows.map((u) => {
          const skills = Array.isArray(u.user_skills) ? u.user_skills : [];
          const skillsCell = skills.length === 0
            ? '<span class="muted" style="font-size:10px">— sin restricción —</span>'
            : skills.map((s) => `<span class="badge" style="margin-right:2px;font-size:9px">${escapeHtml(s)}</span>`).join('');
          return `<tr>
            <td class="table-strong">${escapeHtml(u.full_name || '—')}</td>
            <td class="muted">${escapeHtml(u.email || '—')}</td>
            <td><span class="badge">${escapeHtml(ROLE_LABEL_ES[u.role] || u.role || '—')}</span></td>
            <td class="muted">${escapeHtml(u.employee_code || '—')}</td>
            <td>${skillsCell}</td>
            <td>${u.is_active === false
              ? '<span class="badge badge-neg">Inactivo</span>'
              : '<span class="badge badge-pos">Activo</span>'}</td>
            <td class="muted">${u.last_login_at ? timeAgo(u.last_login_at) : 'nunca'}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn-export" data-user-action="skills" data-user-id="${escapeHtml(u.id)}" data-user-name="${escapeHtml(u.full_name || u.email)}" title="Editar skills">⚡</button>
              <button class="btn-export" data-user-action="reset" data-user-id="${escapeHtml(u.id)}" title="Resetear contraseña">↻</button>
              ${u.is_active === false
                ? '<span class="muted" style="font-size:10px">desactivado</span>'
                : `<button class="btn-export" data-user-action="deactivate" data-user-id="${escapeHtml(u.id)}" data-user-name="${escapeHtml(u.full_name || u.email)}" title="Desactivar usuario" style="color:#b91c1c">✕</button>`}
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
      // Wire row actions.
      wrap.querySelectorAll('[data-user-action]').forEach((btn) => {
        btn.addEventListener('click', () => onUserAction(btn));
      });
    };

    let filterRole = '';
    let filterText = '';
    const applyFilters = () => {
      const t = filterText.trim().toLowerCase();
      const filtered = list.filter((u) => {
        if (filterRole && u.role !== filterRole) return false;
        if (!t) return true;
        return [u.full_name, u.email, u.employee_code, u.role]
          .filter(Boolean).some((v) => String(v).toLowerCase().includes(t));
      });
      renderTable(filtered);
    };
    applyFilters();

    document.getElementById('users-search').addEventListener('input', (e) => {
      filterText = e.target.value;
      applyFilters();
    });
    document.getElementById('users-role-filter').addEventListener('change', (e) => {
      filterRole = e.target.value;
      applyFilters();
    });
    document.getElementById('users-new-btn').addEventListener('click', () => openCreateUserModal());
    const expWrap = document.getElementById('users-export-wrap');
    if (expWrap && list.length) {
      expWrap.appendChild(exportButton('CSV', 'usuarios.csv', () => list.map((u) => ({
        full_name: u.full_name,
        email: u.email,
        role: ROLE_LABEL_ES[u.role] || u.role,
        employee_code: u.employee_code || '',
        is_active: u.is_active === false ? 'No' : 'Sí',
        last_login_at: u.last_login_at || '',
      }))));
    }
  };

  async function onUserAction(btn) {
    const action = btn.dataset.userAction;
    const id = btn.dataset.userId;
    if (action === 'reset') {
      if (!confirm('¿Generar una contraseña temporal para este usuario? Tendrá que cambiarla en su próximo inicio de sesión.')) return;
      try {
        const r = await API.post(`/users/${id}/reset-password`, {});
        // Show the temp password — the API returns it once, we display it
        // in a prompt-like dialog because there's no email-delivery wired
        // on the QA env yet.
        if (r && r.temporary_password) {
          window.prompt('Contraseña temporal generada (copia y entrégala al usuario):', r.temporary_password);
        } else {
          alert('Contraseña reseteada.');
        }
      } catch (err) {
        alert('No se pudo resetear: ' + (err?.error || err?.message || 'error'));
      }
    } else if (action === 'deactivate') {
      const name = btn.dataset.userName || 'este usuario';
      if (!confirm(`¿Desactivar a ${name}? No podrá iniciar sesión hasta que se reactive manualmente desde la base de datos.`)) return;
      try {
        await API.delete(`/users/${id}`);
        // Reload the view so the row flips to "Inactivo".
        switchTo('users');
      } catch (err) {
        alert('No se pudo desactivar: ' + (err?.error || err?.message || 'error'));
      }
    } else if (action === 'skills') {
      openSkillsModal(id, btn.dataset.userName || '');
    }
  }

  async function openSkillsModal(userId, userName) {
    let catalog = [];
    try {
      const r = await API.get('/users/skills/catalog');
      catalog = Array.isArray(r?.skills) ? r.skills : [];
    } catch (err) {
      alert('No se pudo cargar el catálogo de skills: ' + (err?.error || err?.message || 'error'));
      return;
    }
    // Load current state. The /users list already brought user_skills, but
    // we re-fetch a single row to guarantee fresh state (admin may have
    // edited from another tab seconds before).
    let current = [];
    try {
      const all = await API.get('/users');
      const u = (Array.isArray(all) ? all : []).find((x) => x.id === userId);
      current = Array.isArray(u?.user_skills) ? u.user_skills : [];
    } catch { /* keep [] */ }

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,0.55);display:flex;align-items:center;justify-content:center;padding:24px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;max-width:460px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.25);font-family:Inter,sans-serif;padding:20px">
        <div style="font-weight:700;font-size:15px;margin-bottom:6px">Editar skills · ${escapeHtml(userName)}</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:14px">
          Selecciona las skills que el usuario puede ejecutar en campo. Sin checkboxes marcados =
          el usuario es elegible para cualquier farmacia (sin restricción).
        </div>
        <div id="skills-modal-list" style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="skills-modal-cancel" class="btn-export">Cancelar</button>
          <button id="skills-modal-save" class="btn-export" style="background:#0f766e;color:#fff;border-color:#0f766e">Guardar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const list = overlay.querySelector('#skills-modal-list');
    list.innerHTML = catalog.map((s) => `
      <label style="display:flex;align-items:flex-start;gap:8px;padding:8px;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer">
        <input type="checkbox" value="${escapeHtml(s.code)}" ${current.includes(s.code) ? 'checked' : ''}>
        <div style="flex:1">
          <div style="font-weight:600;font-size:13px">${escapeHtml(s.label)}</div>
          <div style="font-size:11px;color:#64748b">${escapeHtml(s.description)}</div>
        </div>
      </label>
    `).join('');

    overlay.querySelector('#skills-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#skills-modal-save').addEventListener('click', async () => {
      const picked = [...list.querySelectorAll('input[type=checkbox]:checked')].map((el) => el.value);
      try {
        await API.put(`/users/${userId}/skills`, { user_skills: picked });
        overlay.remove();
        switchTo('users'); // reload to refresh the row
      } catch (err) {
        alert('No se pudo guardar: ' + (err?.error || err?.message || 'error'));
      }
    });
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) overlay.remove();
    });
  }

  // Hierarchical parent map — mirrors server-side enforcement in
  // auth.service.register (ver MARZAM-5). admin y director_sucursal son
  // globales y NO requieren padre; el resto sí.
  const HIERARCHY_PARENT_ROLE = {
    representante: 'supervisor',
    supervisor: 'gerente_ventas',
    gerente_ventas: 'director_sucursal',
  };

  async function openCreateUserModal() {
    // Pre-fetch the directory so we can populate the manager picker per role.
    let allUsers = [];
    try {
      const resp = await API.get('/users');
      allUsers = Array.isArray(resp) ? resp : [];
    } catch { /* sin lista, el picker queda vacío y el server bloqueará */ }

    // Self-contained modal — no MarzamModal here because admin.html doesn't
    // load views.js. Built with the same visual language as other admin
    // dialogs (stat-mini cards, btn-export). Validation happens client-side
    // first; the server re-validates per /auth/register's validate() schema
    // (12-char password minimum, email format, role oneOf, manager_id
    // requerido para roles jerárquicos).
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,0.55);display:flex;align-items:center;justify-content:center;padding:24px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;max-width:460px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.25);overflow:hidden;font-family:Inter,sans-serif">
        <div style="padding:16px 20px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-weight:700;font-size:14px;color:#0f172a">Nuevo usuario</div>
            <div style="font-size:11px;color:#64748b">Se crea con la contraseña que proporciones; el usuario deberá cambiarla en su primer login.</div>
          </div>
          <button id="cu-close" style="background:none;border:none;font-size:18px;color:#94a3b8;cursor:pointer">×</button>
        </div>
        <div style="padding:18px 20px;display:flex;flex-direction:column;gap:12px;font-size:12px">
          <label style="display:flex;flex-direction:column;gap:4px">
            <span style="font-weight:600;color:#334155">Nombre completo *</span>
            <input id="cu-fullname" type="text" maxlength="200" placeholder="Ej. María Hernández García" style="padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px">
            <span style="font-weight:600;color:#334155">Correo *</span>
            <input id="cu-email" type="email" maxlength="200" placeholder="usuario@marzam.mx" style="padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px">
            <span style="font-weight:600;color:#334155">Rol *</span>
            <select id="cu-role" style="padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;background:#fff">
              ${USER_ROLES_FOR_CREATE.map((r) => `<option value="${r.value}">${escapeHtml(r.label)}</option>`).join('')}
            </select>
          </label>
          <label id="cu-manager-wrap" style="display:none;flex-direction:column;gap:4px">
            <span style="font-weight:600;color:#334155">Superior jerárquico <span id="cu-manager-required" style="color:#dc2626">*</span></span>
            <select id="cu-manager" style="padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;background:#fff">
              <option value="">— Selecciona un superior —</option>
            </select>
            <span id="cu-manager-hint" style="font-size:10px;color:#64748b">No puede existir un representante sin supervisor, supervisor sin gerente, ni gerente sin director.</span>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px">
            <span style="font-weight:600;color:#334155">Contraseña inicial *</span>
            <input id="cu-password" type="text" minlength="12" maxlength="200" placeholder="Mínimo 12 caracteres" style="padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;font-family:JetBrains Mono,monospace" />
            <span style="font-size:10px;color:#64748b">El usuario podrá (y deberá) cambiarla en su primer inicio de sesión.</span>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px">
            <span style="font-weight:600;color:#334155">Teléfono <span style="font-weight:400;color:#94a3b8">(opcional)</span></span>
            <input id="cu-phone" type="tel" maxlength="32" placeholder="55 1234 5678" style="padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px" />
          </label>
          <div id="cu-error" style="display:none;background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;padding:8px 10px;border-radius:6px;font-size:11px"></div>
        </div>
        <div style="padding:14px 20px;border-top:1px solid #e5e7eb;background:#f8fafc;display:flex;justify-content:flex-end;gap:8px">
          <button id="cu-cancel" class="btn-export">Cancelar</button>
          <button id="cu-save" class="btn-export" style="background:#0f766e;color:#fff;border-color:#0f766e">Crear usuario</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#cu-close').addEventListener('click', close);
    overlay.querySelector('#cu-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const roleEl = overlay.querySelector('#cu-role');
    const mgrWrap = overlay.querySelector('#cu-manager-wrap');
    const mgrSel = overlay.querySelector('#cu-manager');
    const mgrHint = overlay.querySelector('#cu-manager-hint');

    const refreshManagerPicker = () => {
      const role = roleEl.value;
      const parentRole = HIERARCHY_PARENT_ROLE[role];
      if (!parentRole) {
        mgrWrap.style.display = 'none';
        mgrSel.innerHTML = '<option value="">— No aplica —</option>';
        mgrSel.value = '';
        return;
      }
      mgrWrap.style.display = 'flex';
      const candidates = (allUsers || []).filter((u) => {
        if (u.is_active === false) return false;
        const r = String(u.role || '').toLowerCase();
        return r === parentRole || r === 'admin';
      });
      const parentLabel = ROLE_LABEL_ES[parentRole] || parentRole;
      mgrHint.textContent = `Selecciona el ${parentLabel} al que reportará este ${ROLE_LABEL_ES[role] || role}.`;
      if (!candidates.length) {
        mgrSel.innerHTML = `<option value="">— No hay ${parentLabel}s activos —</option>`;
      } else {
        mgrSel.innerHTML = '<option value="">— Selecciona un superior —</option>'
          + candidates.map((u) => `<option value="${u.id}">${escapeHtml(u.full_name)} · ${escapeHtml(u.email || '')}</option>`).join('');
      }
    };
    roleEl.addEventListener('change', refreshManagerPicker);
    refreshManagerPicker();

    const errEl = overlay.querySelector('#cu-error');
    const saveBtn = overlay.querySelector('#cu-save');
    saveBtn.addEventListener('click', async () => {
      errEl.style.display = 'none';
      const fullname = overlay.querySelector('#cu-fullname').value.trim();
      const email = overlay.querySelector('#cu-email').value.trim();
      const role = roleEl.value;
      const password = overlay.querySelector('#cu-password').value;
      const phone = overlay.querySelector('#cu-phone').value.trim() || null;
      const managerId = mgrSel.value || null;
      // Client-side guards mirror the server's validate() schema. Surface
      // the most-likely failure first so the user fixes one thing at a
      // time instead of seeing a wall of validation errors.
      if (fullname.length < 2) {
        errEl.textContent = 'Captura el nombre completo (mínimo 2 caracteres).';
        errEl.style.display = 'block';
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errEl.textContent = 'El correo electrónico no es válido.';
        errEl.style.display = 'block';
        return;
      }
      if (password.length < 12) {
        errEl.textContent = 'La contraseña debe tener al menos 12 caracteres.';
        errEl.style.display = 'block';
        return;
      }
      if (HIERARCHY_PARENT_ROLE[role] && !managerId) {
        const parentLabel = ROLE_LABEL_ES[HIERARCHY_PARENT_ROLE[role]] || HIERARCHY_PARENT_ROLE[role];
        errEl.textContent = `Asigna un ${parentLabel} como superior jerárquico — es obligatorio para este rol.`;
        errEl.style.display = 'block';
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Creando…';
      try {
        await API.post('/users', { email, password, full_name: fullname, role, phone, manager_id: managerId });
        close();
        switchTo('users'); // Reload list to show the new user.
      } catch (err) {
        errEl.textContent = err?.error || err?.message || 'No se pudo crear el usuario. Intenta de nuevo.';
        errEl.style.display = 'block';
        saveBtn.disabled = false;
        saveBtn.textContent = 'Crear usuario';
      }
    });
  }

  // ── exposed API ─────────────────────────────────────────────────
  // registerView lets a sibling script (e.g. /js/blackprint/extra-views.js)
  // attach additional drawer panels without forking this file. Helpers are
  // exposed so registered views can render with the same look-and-feel as
  // the built-in panels.
  window.AdminDrawer = {
    init,
    switchTo,
    registerView(key, fn) {
      if (typeof key !== 'string' || typeof fn !== 'function') return;
      VIEWS[key] = fn;
    },
    helpers: {
      escapeHtml, formatNum, formatCurrency, formatPct, timeAgo,
      exportButton, rangeQS, pushChart, destroyCharts,
    },
  };
})();
