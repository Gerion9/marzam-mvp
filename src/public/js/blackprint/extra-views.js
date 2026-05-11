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

  /**
   * Comparativa Real vs Naive con badge de ahorro. `real`/`naive` ya vienen en
   * USD; `savings` se renderiza como pill verde si > $0.
   */
  function statTileCompare(label, real, naive, savings) {
    const realFmt = fmtUsd(real);
    const naiveFmt = fmtUsd(naive);
    const savePct = naive > 0 ? (savings / naive) : 0;
    const savePill = savings > 0
      ? `<span class="bp-savings-pill">−${fmtUsd(savings)} (${(savePct * 100).toFixed(0)}%)</span>`
      : '';
    return `
      <div class="stat-mini">
        <div class="stat-mini-label">${escape(label)}</div>
        <div class="stat-mini-value">${realFmt} ${savePill}</div>
        <div class="stat-mini-sub">naive: ${naiveFmt}</div>
      </div>`;
  }

  /**
   * Barra de progreso del free tier. `used` y `limit` en elementos.
   *   verde   → < 80% usado
   *   ámbar   → 80–100%
   *   gris    → 100%+ (free tier agotado, ya está pagando)
   */
  function freeTierBar(label, used, limit) {
    const pct = Math.max(0, Math.min(1, limit > 0 ? used / limit : 0));
    const exhausted = used >= limit;
    const color = exhausted ? '#94a3b8' : (pct >= 0.8 ? '#f59e0b' : '#10b981');
    const widthPct = exhausted ? 100 : Math.round(pct * 100);
    return `
      <div class="bp-free-tier">
        <div class="bp-free-tier-head">
          <span class="bp-free-tier-label">${escape(label)}</span>
          <span class="bp-free-tier-num">${fmtInt(Math.min(used, limit))} / ${fmtInt(limit)}</span>
        </div>
        <div class="bp-free-tier-bar"><div class="bp-free-tier-fill" style="width:${widthPct}%;background:${color}"></div></div>
        ${exhausted
    ? `<div class="bp-free-tier-sub" style="color:#64748b">Free tier agotado · facturando ${fmtInt(Math.max(0, used - limit))} elements adicionales</div>`
    : `<div class="bp-free-tier-sub" style="color:${color}">${fmtInt(limit - used)} elements gratis restantes</div>`}
      </div>`;
  }

  function subscriptionWidget(sug) {
    if (!sug) return '';
    return `
      <div class="bp-subscription-suggest">
        <div class="bp-subscription-suggest-title">💡 Sugerencia: negociar suscripción</div>
        <div class="bp-subscription-suggest-body">
          <p>Llevas <strong>${fmtUsd(sug.current_mtd_naive_usd)}</strong> de gasto pesimista MTD
          (umbral: ${fmtUsd(sug.threshold_usd)}).</p>
          <p>A tarifas reales con free tier y degradación: <strong>${fmtUsd(sug.estimated_real_mtd_usd)}</strong>
          (ya estás ahorrando <strong>${fmtUsd(sug.potential_savings_usd)}</strong>).</p>
          <p style="color:#64748b;margin-top:6px;font-size:12px">${escape(sug.break_even_hint)}</p>
        </div>
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
    const opt = data.route_optimization_api || {};
    const totalNaive = Number(data.total_mtd_usd || 0);
    const totalReal = Number(data.total_mtd_real_usd || 0);
    const totalSavings = Number(data.total_mtd_savings_usd || 0);

    drawerBody().innerHTML = `
      <div style="padding:18px 22px">
        ${subscriptionWidget(data.subscription_suggestion)}

        <div class="drawer-grid-3" style="margin-bottom:18px">
          ${statTile('Total HOY (USD)', fmtUsd(data.total_today_usd), 'Naive · Routes + Geocoding + Opt')}
          ${statTileCompare('Total MTD', totalReal, totalNaive, totalSavings)}
          ${statTile('Routes API · cache hit', r.cache_stats ? fmtPct(r.cache_stats.cache_hit_rate) : '—', r.cache_stats ? `${fmtInt(r.cache_stats.api_calls)} llamadas` : '')}
        </div>

        <h3 style="margin:18px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b">Free tier · estado mensual</h3>
        <div class="drawer-grid-3" style="margin-bottom:18px">
          ${r.mtd_billable_elements != null ? freeTierBar('Routes API', r.mtd_billable_elements, r.free_tier_limit || 10000) : ''}
          ${g.mtd_calls != null ? freeTierBar('Geocoding API', g.mtd_calls, g.free_tier_limit || 10000) : ''}
        </div>

        <h3 style="margin:18px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b">Google Routes API</h3>
        <div class="drawer-grid-3">
          ${statTile('USD hoy', fmtUsd(r.today_usd))}
          ${statTileCompare('USD MTD', r.mtd_real_usd, r.mtd_naive_usd ?? r.mtd_usd, r.mtd_savings_usd || 0)}
          ${statTile('USD YTD', fmtUsd(r.ytd_usd))}
          ${statTile('Matrix elements MTD', fmtInt(r.mtd_matrix_elements ?? r.mtd_matrix_calls))}
          ${statTile('Route calls MTD', fmtInt(r.mtd_route_calls))}
          ${statTile('Rechazadas hoy (budget)', fmtInt(r.today_rejected_calls))}
        </div>

        <h3 style="margin:24px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b">Google Geocoding API</h3>
        <div class="drawer-grid-3">
          ${statTile('USD hoy', fmtUsd(g.today_usd))}
          ${statTileCompare('USD MTD', g.mtd_real_usd, g.mtd_naive_usd ?? g.mtd_usd, g.mtd_savings_usd || 0)}
          ${statTile('USD YTD', fmtUsd(g.ytd_usd))}
          ${statTile('Llamadas hoy', fmtInt(g.today_calls))}
          ${statTile('Cache hits MTD', fmtInt(g.mtd_cache_hits))}
          ${statTile('Cache hit rate MTD', fmtPct(g.mtd_cache_hit_rate))}
        </div>

        ${data.route_optimization_api ? `
        <h3 style="margin:24px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b">Route Optimization API <span style="font-size:10px;background:#fde68a;color:#92400e;padding:2px 6px;border-radius:4px;margin-left:6px">feature-flagged</span></h3>
        <div class="drawer-grid-3">
          ${statTile('USD hoy', fmtUsd(opt.today_usd))}
          ${statTile('USD MTD', fmtUsd(opt.mtd_usd))}
          ${statTile('USD YTD', fmtUsd(opt.ytd_usd))}
          ${statTile('Optimizaciones MTD', fmtInt(opt.mtd_calls), opt.mtd_validate_only_calls ? `+${fmtInt(opt.mtd_validate_only_calls)} validate-only (\$0)` : '')}
          ${statTile('Shipments MTD', fmtInt(opt.mtd_shipments), 'Pricing piecewise por SKU')}
          ${statTile('Fallidas MTD', fmtInt(opt.mtd_failed || 0))}
        </div>

        ${opt.single_vehicle || opt.fleet_routing ? `
        <h4 style="margin:18px 0 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#64748b">SKU split — pricing oficial Google (post-marzo 2025)</h4>
        <div class="drawer-grid-3">
          ${opt.single_vehicle ? statTileCompare(
    'Single Vehicle (Pro)',
    opt.single_vehicle.est_cost_real_usd,
    opt.single_vehicle.est_cost_naive_usd,
    opt.single_vehicle.est_savings_vs_naive,
  ) : ''}
          ${opt.single_vehicle ? freeTierBar('Single · free 5k/mes', opt.single_vehicle.mtd_shipments, 5000) : ''}
          ${opt.single_vehicle ? statTile('Optimizaciones Single MTD', fmtInt(opt.single_vehicle.mtd_calls), `${fmtInt(opt.single_vehicle.mtd_shipments)} shipments`) : ''}

          ${opt.fleet_routing ? statTileCompare(
    'Fleet Routing (Enterprise)',
    opt.fleet_routing.est_cost_real_usd,
    opt.fleet_routing.est_cost_naive_usd,
    opt.fleet_routing.est_savings_vs_naive,
  ) : ''}
          ${opt.fleet_routing ? freeTierBar('Fleet · free 1k/mes', opt.fleet_routing.mtd_shipments, 1000) : ''}
          ${opt.fleet_routing ? statTile('Optimizaciones Fleet MTD', fmtInt(opt.fleet_routing.mtd_calls), `${fmtInt(opt.fleet_routing.mtd_shipments)} shipments`) : ''}
        </div>
        <p style="margin-top:8px;font-size:11px;color:#64748b">
          Google factura el SKU según <code>vehicles.length</code> del payload: 1 = Single (Pro, free 5k), 2+ = Fleet (Enterprise, free 1k, ~3× más caro post-free). Validate-only no factura ningún shipment.
        </p>
        ` : ''}` : ''}

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

        <p style="margin-top:14px;font-size:11px;color:#64748b">
          Real vs Naive: el código pesimista del budget gate cobra al tier base sin free.
          Los números "Real" reflejan el costo aplicando free tier (10k/mes Essentials,
          5k/mes Pro) + degradación de bandas. La diferencia es cuánto te <em>habrías</em>
          cobrado de más si no existiera la curva — útil para reportes financieros.
        </p>
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
