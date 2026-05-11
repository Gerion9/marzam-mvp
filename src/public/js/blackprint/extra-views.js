/**
 * BlackPrint admin — drawer extras.
 *
 * Registers 5 additional drawer views via window.AdminDrawer.registerView:
 *   costs       → /api/blackprint/cost-summary    (Routes + Geocoding USD)
 *   health      → /api/blackprint/system-health   (crons, errors, syncs)
 *   usage       → /api/blackprint/usage-metrics   (SSE, demo %, rate limit)
 *   geocoding   → /api/blackprint/geocoding-quality
 *   directory   → /api/blackprint/directory       (read-only user list)
 *
 * Reuses the helpers exposed by drawer.js (escapeHtml, formatNum, ...).
 * Keeps the same look-and-feel as the heredados Marzam tabs.
 */
(function () {
  if (!window.AdminDrawer || typeof window.AdminDrawer.registerView !== 'function') {
    console.error('[blackprint] AdminDrawer.registerView missing — admin/drawer.js must load first');
    return;
  }
  const H = window.AdminDrawer.helpers || {};
  const drawerBody = () => document.getElementById('drawer-body');

  function fmtUsd(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return '$' + Number(n).toFixed(2);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    return (Number(n) * 100).toFixed(1) + '%';
  }
  function fmtInt(n) {
    if (n === null || n === undefined) return '0';
    return Number(n).toLocaleString();
  }
  function escape(s) {
    return (H.escapeHtml ? H.escapeHtml : ((x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))))(s);
  }

  async function fetchJson(path) {
    const token = window.__ADMIN_TOKEN__;
    const res = await fetch(path, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' on ' + path);
    return res.json();
  }

  function statTile(label, value, sub) {
    return `
      <div class="stat-mini">
        <div class="stat-mini-label">${escape(label)}</div>
        <div class="stat-mini-value">${escape(value)}</div>
        ${sub ? `<div class="stat-mini-sub">${escape(sub)}</div>` : ''}
      </div>`;
  }

  function emptyState(title, sub) {
    return `<div class="empty"><div class="empty-title">${escape(title)}</div>${sub ? `<div class="empty-sub">${escape(sub)}</div>` : ''}</div>`;
  }

  // ── COSTS ────────────────────────────────────────────────────────
  window.AdminDrawer.registerView('costs', async () => {
    const data = await fetchJson('/api/blackprint/cost-summary');
    if (data._degraded) {
      drawerBody().innerHTML = emptyState('Cost tracking no disponible', data._reason);
      return;
    }
    const r = data.routes_api || {};
    const g = data.geocoding_api || {};
    drawerBody().innerHTML = `
      <div style="padding:18px 22px">
        <div class="drawer-grid-3" style="margin-bottom:18px">
          ${statTile('Total HOY (USD)', fmtUsd(data.total_today_usd), 'Routes + Geocoding')}
          ${statTile('Total MTD (USD)', fmtUsd(data.total_mtd_usd), 'Mes en curso')}
          ${statTile('Routes API · cache hit', r.cache_stats ? fmtPct(r.cache_stats.cache_hit_rate) : '—', r.cache_stats ? `${fmtInt(r.cache_stats.api_calls)} llamadas` : '')}
        </div>

        <h3 style="margin:18px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b">Google Routes API</h3>
        <div class="drawer-grid-3">
          ${statTile('USD hoy', fmtUsd(r.today_usd))}
          ${statTile('USD MTD', fmtUsd(r.mtd_usd))}
          ${statTile('USD YTD', fmtUsd(r.ytd_usd))}
          ${statTile('Llamadas matrix hoy', fmtInt(r.today_matrix_calls))}
          ${statTile('Llamadas matrix MTD', fmtInt(r.mtd_matrix_calls))}
          ${statTile('Rechazadas hoy (budget)', fmtInt(r.today_rejected_calls))}
        </div>

        <h3 style="margin:24px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b">Google Geocoding API</h3>
        <div class="drawer-grid-3">
          ${statTile('USD hoy', fmtUsd(g.today_usd))}
          ${statTile('USD MTD', fmtUsd(g.mtd_usd))}
          ${statTile('USD YTD', fmtUsd(g.ytd_usd))}
          ${statTile('Llamadas hoy', fmtInt(g.today_calls))}
          ${statTile('Cache hits MTD', fmtInt(g.mtd_cache_hits))}
          ${statTile('Cache hit rate MTD', fmtPct(g.mtd_cache_hit_rate))}
        </div>

        <h3 style="margin:24px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b">Routes · breakdown MTD</h3>
        <div style="overflow:auto"><table class="data-table"><thead><tr>
          <th>Día</th><th>Matrix calls</th><th>Elements</th><th>Route calls</th><th>USD</th><th>Rejected</th>
        </tr></thead><tbody>
          ${(r.mtd_breakdown || []).map((row) => `<tr>
            <td>${escape(row.day)}</td>
            <td>${fmtInt(row.matrix_calls)}</td>
            <td>${fmtInt(row.matrix_elements)}</td>
            <td>${fmtInt(row.route_calls)}</td>
            <td>${fmtUsd(row.usd)}</td>
            <td>${fmtInt(row.rejected)}</td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>`;
  });

  // ── SYSTEM HEALTH ────────────────────────────────────────────────
  window.AdminDrawer.registerView('health', async () => {
    const data = await fetchJson('/api/blackprint/system-health');
    if (data._degraded) {
      drawerBody().innerHTML = emptyState('System health no disponible', data._reason);
      return;
    }
    const crons = data.cron_runs || [];
    const okCount = crons.filter((c) => c.last_status === 'ok').length;
    const errorCount = crons.filter((c) => c.last_status === 'error').length;

    drawerBody().innerHTML = `
      <div style="padding:18px 22px">
        <div class="drawer-grid-3" style="margin-bottom:18px">
          ${statTile('Crons OK', fmtInt(okCount), `${crons.length} total`)}
          ${statTile('Crons ERROR', fmtInt(errorCount))}
          ${statTile('Errores 24h', fmtInt(data.error_log_24h_count))}
          ${statTile('BQ-sync warnings 7d', fmtInt((data.bq_sync_warnings_7d || []).reduce((a, w) => a + Number(w.n || 0), 0)))}
          ${statTile('Live outbox depth', fmtInt(data.live_outbox_depth))}
          ${statTile('Sync checkpoints', fmtInt((data.bq_sync_checkpoints || []).length))}
        </div>

        <h3 style="margin:18px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b">Cron jobs</h3>
        <div style="overflow:auto"><table class="data-table"><thead><tr>
          <th>Job</th><th>Status</th><th>Última ejecución</th><th>Payload</th>
        </tr></thead><tbody>
          ${crons.map((c) => `<tr>
            <td><strong>${escape(c.job_key)}</strong></td>
            <td><span class="status-pill status-${escape(c.last_status)}">${escape(c.last_status)}</span></td>
            <td>${c.last_run_at ? (H.timeAgo ? H.timeAgo(c.last_run_at) : escape(c.last_run_at)) : '—'}</td>
            <td><code style="font-size:11px">${escape(JSON.stringify(c.last_payload || {}).slice(0, 120))}</code></td>
          </tr>`).join('')}
        </tbody></table></div>

        <h3 style="margin:24px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b">Top error paths · 24h</h3>
        <div style="overflow:auto"><table class="data-table"><thead><tr>
          <th>Path</th><th>Status</th><th>Cuenta</th>
        </tr></thead><tbody>
          ${(data.error_log_top_paths_24h || []).map((row) => `<tr>
            <td><code>${escape(row.path)}</code></td>
            <td>${escape(row.status)}</td>
            <td>${fmtInt(row.n)}</td>
          </tr>`).join('')}
        </tbody></table></div>

        <h3 style="margin:24px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b">BQ-sync warnings · 7d (top)</h3>
        <div style="overflow:auto"><table class="data-table"><thead><tr>
          <th>Job</th><th>Code</th><th>Severity</th><th>Cuenta</th>
        </tr></thead><tbody>
          ${(data.bq_sync_warnings_7d || []).map((row) => `<tr>
            <td>${escape(row.job_name)}</td>
            <td><code>${escape(row.code)}</code></td>
            <td>${escape(row.severity || '—')}</td>
            <td>${fmtInt(row.n)}</td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>`;
  });

  // ── USAGE ────────────────────────────────────────────────────────
  window.AdminDrawer.registerView('usage', async () => {
    const data = await fetchJson('/api/blackprint/usage-metrics');
    if (data._degraded) {
      drawerBody().innerHTML = emptyState('Usage metrics no disponibles', data._reason);
      return;
    }
    const sse = data.sse || {};
    const demo = data.demo || {};
    const imp = data.imports_30d || {};
    const importPct = imp.total > 0 ? ((imp.done + imp.partial) / imp.total) : null;

    drawerBody().innerHTML = `
      <div style="padding:18px 22px">
        <div class="drawer-grid-3" style="margin-bottom:18px">
          ${statTile('SSE conexiones activas', fmtInt(sse.active_subscriptions), 'En esta instancia')}
          ${statTile('Reps activos 24h', fmtInt(data.active_reps_24h))}
          ${statTile('Pings GPS 24h', fmtInt(data.pings_24h))}
          ${statTile('Demo writes blocked', fmtInt(demo.blocked_writes))}
          ${statTile('Demo reads passthrough', fmtInt(demo.passthrough_reads))}
          ${statTile('Imports OK 30d', `${fmtInt(imp.done + imp.partial)}/${fmtInt(imp.total)}`, importPct !== null ? fmtPct(importPct) : '')}
        </div>

        <h3 style="margin:18px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b">Rate limit · top 24h</h3>
        <div style="overflow:auto"><table class="data-table"><thead><tr>
          <th>Bucket key</th><th>Peak count</th>
        </tr></thead><tbody>
          ${(data.rate_limit_24h || []).slice(0, 30).map((row) => `<tr>
            <td><code>${escape(row.bucket_key)}</code></td>
            <td>${fmtInt(row.peak)}</td>
          </tr>`).join('')}
        </tbody></table></div>

        <p style="margin-top:16px;font-size:12px;color:#64748b">
          SSE counter es per-instancia. Demo counters arrancaron: ${escape(demo.started_at || '—')}.
        </p>
      </div>`;
  });

  // ── GEOCODING QUALITY ────────────────────────────────────────────
  window.AdminDrawer.registerView('geocoding', async () => {
    const data = await fetchJson('/api/blackprint/geocoding-quality');
    if (data._degraded) {
      drawerBody().innerHTML = emptyState('Geocoding quality no disponible', data._reason);
      return;
    }
    const ph = data.pharmacies || {};
    const u = data.users || {};
    const c = data.cache || {};
    drawerBody().innerHTML = `
      <div style="padding:18px 22px">
        <div class="drawer-grid-3" style="margin-bottom:18px">
          ${statTile('Farmacias geocoded', `${fmtInt(ph.with_coords)}/${fmtInt(ph.total)}`, fmtPct(ph.pct_geocoded))}
          ${statTile('Sin coordenadas', fmtInt(ph.without_coords))}
          ${statTile('Reps con home_lat', `${fmtInt(u.reps_with_home)}/${fmtInt(u.reps_total)}`, fmtPct(u.pct_geocoded))}
          ${statTile('Reps geocoded 7d', fmtInt(u.geocoded_last_7d))}
          ${statTile('Cache entries', fmtInt(c.entries))}
          ${statTile('Cache total hits', fmtInt(c.total_hits))}
        </div>

        <h3 style="margin:18px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b">Top 50 farmacias sin coordenadas</h3>
        <div style="overflow:auto"><table class="data-table"><thead><tr>
          <th>ID</th><th>Nombre</th><th>Dirección</th>
        </tr></thead><tbody>
          ${(data.top_missing || []).map((row) => `<tr>
            <td><code>${escape(row.id)}</code></td>
            <td>${escape(row.name || '—')}</td>
            <td>${escape(row.address || '—')}</td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>`;
  });

  // ── DIRECTORY ────────────────────────────────────────────────────
  window.AdminDrawer.registerView('directory', async () => {
    const data = await fetchJson('/api/blackprint/directory');
    const byRole = data.by_role || {};
    drawerBody().innerHTML = `
      <div style="padding:18px 22px">
        <div class="drawer-grid-3" style="margin-bottom:18px">
          ${statTile('Total usuarios', fmtInt(data.count))}
          ${Object.entries(byRole).map(([k, v]) => statTile(k, fmtInt(v))).join('')}
        </div>

        <div style="overflow:auto"><table class="data-table"><thead><tr>
          <th>ID</th><th>Email</th><th>Nombre</th><th>Rol</th><th>Branch</th><th>Activo</th>
        </tr></thead><tbody>
          ${(data.users || []).map((row) => `<tr>
            <td><code style="font-size:11px">${escape(row.id)}</code></td>
            <td>${escape(row.email || '—')}</td>
            <td>${escape(row.full_name || '—')}</td>
            <td><span class="status-pill status-${escape(row.role)}">${escape(row.role)}</span></td>
            <td>${escape(row.branch_code || '—')}</td>
            <td>${row.is_active ? '✓' : '·'}</td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>`;
  });
})();
