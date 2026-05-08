/**
 * Admin Cockpit — bootstrap + state + Hero + Trend + audit polling.
 * Coordinates the other admin/* modules (charts, big-map, hierarchy-tree, drawer).
 */
(function () {
  const state = {
    user: window.__ADMIN_USER__ || null,
    range: { preset: '7d', from: null, to: null },
  };

  let trendChart = null;
  const sparkCharts = [];
  let auditTimer = null;

  // ── Range helpers ───────────────────────────────────────────────
  function applyPresetRange(preset) {
    const today = new Date();
    const to = today.toISOString().slice(0, 10);
    let from;
    switch (preset) {
      case 'today': from = to; break;
      case '7d': {
        const d = new Date(today); d.setDate(d.getDate() - 7);
        from = d.toISOString().slice(0, 10); break;
      }
      case '30d': {
        const d = new Date(today); d.setDate(d.getDate() - 30);
        from = d.toISOString().slice(0, 10); break;
      }
      case 'mtd': {
        from = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10); break;
      }
      case 'ytd': {
        from = new Date(today.getFullYear(), 0, 1).toISOString().slice(0, 10); break;
      }
      default: {
        const d = new Date(today); d.setDate(d.getDate() - 7);
        from = d.toISOString().slice(0, 10);
      }
    }
    state.range = { preset, from, to };
  }

  function getRange() { return state.range; }

  // ── Boot ────────────────────────────────────────────────────────
  function boot() {
    if (!state.user) return;

    // user header
    const initial = (state.user.full_name || state.user.email || 'A').slice(0, 1).toUpperCase();
    document.getElementById('user-avatar').textContent = initial;
    document.getElementById('user-name').textContent = state.user.full_name || state.user.email || '—';

    // demo mode banner
    if (String(state.user.email || '').endsWith('@demo.marzam.mx') || state.user.data_scope === 'demo') {
      const banner = document.getElementById('demo-banner');
      if (banner) {
        banner.style.display = 'block';
        document.body.style.paddingTop = '24px';
      }
    }

    // logout
    document.getElementById('btn-logout').addEventListener('click', () => {
      localStorage.clear();
      window.location.href = '/';
    });

    // refresh button
    document.getElementById('btn-refresh').addEventListener('click', () => {
      loadAll();
    });

    // range picker
    document.querySelectorAll('.range-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.range-preset').forEach((b) => b.removeAttribute('data-active'));
        btn.setAttribute('data-active', 'true');
        applyPresetRange(btn.dataset.range);
        loadAll();
      });
    });

    // hierarchy collapse button
    const htreeCollapse = document.getElementById('htree-collapse');
    if (htreeCollapse) htreeCollapse.addEventListener('click', () => window.AdminHierarchyTree.collapseAll());

    // map layer toggles
    document.querySelectorAll('.layer-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const isActive = btn.getAttribute('data-active') === 'true';
        const next = !isActive;
        btn.setAttribute('data-active', String(next));
        btn.setAttribute('aria-pressed', String(next));
        if (window.AdminBigMap) window.AdminBigMap.setLayerActive(btn.dataset.layer, next);
      });
    });

    // anomaly banner click → switch to anomalies tab
    document.getElementById('anomaly-banner').addEventListener('click', () => {
      document.querySelectorAll('.drawer-tab').forEach((b) => b.removeAttribute('data-active'));
      const tab = document.querySelector('.drawer-tab[data-drawer="anomalies"]');
      if (tab) tab.setAttribute('data-active', 'true');
      window.AdminDrawer.switchTo('anomalies');
    });

    // hero tile clicks → drawer routing
    document.getElementById('hero-grid').addEventListener('click', (e) => {
      const tile = e.target.closest('.kpi-tile[data-drawer]');
      if (!tile) return;
      const drawerKey = tile.dataset.drawer;
      document.querySelectorAll('.drawer-tab').forEach((b) => b.removeAttribute('data-active'));
      const tab = document.querySelector(`.drawer-tab[data-drawer="${drawerKey}"]`);
      if (tab) tab.setAttribute('data-active', 'true');
      window.AdminDrawer.switchTo(drawerKey);
      document.getElementById('drawer').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // initialize range
    applyPresetRange('7d');

    // init map
    if (window.AdminBigMap) window.AdminBigMap.init('big-map');

    // init drawer
    if (window.AdminDrawer) window.AdminDrawer.init(document.getElementById('drawer-body'), {
      onCounts: updateAnomalyCount,
    });

    // first load
    loadAll();

    // audit polling (every 10s)
    pollAuditFeed();
    auditTimer = setInterval(pollAuditFeed, 10_000);

    // keyboard shortcuts
    setupKeyboardShortcuts();
  }

  // ── Loading orchestrator ────────────────────────────────────────
  async function loadAll() {
    const tasks = [
      loadHero().catch(handleErr('hero')),
      loadTrend().catch(handleErr('trend')),
      loadCoverage().catch(handleErr('coverage')),
      loadHierarchy().catch(handleErr('hierarchy')),
      loadAnomaliesCount().catch(handleErr('anomalies')),
    ];
    await Promise.all(tasks);
  }

  function handleErr(label) {
    return (err) => {
      console.warn('[admin/cockpit]', label, err);
    };
  }

  // ── Hero ────────────────────────────────────────────────────────
  async function loadHero() {
    const data = await API.get('/admin/cockpit/hero');
    renderHero(data);
    document.getElementById('hero-updated').textContent = data.degraded ? 'modo degradado' : timeAgo(data.generated_at);
  }

  function renderHero(d) {
    const grid = document.getElementById('hero-grid');
    const sp = d.sparklines || {};
    const dl = d.deltas || {};
    const cs = d.components || {};

    const tiles = [
      {
        label: 'Visitas hoy',
        value: formatNum(d.visits_today),
        delta: dl.visits_vs_yesterday_pct,
        deltaMeta: 'vs ayer',
        spark: sp.visits_14d || [],
        drawer: 'people',
      },
      {
        label: 'Cobertura padrón',
        value: (d.coverage_pct == null ? '—' : d.coverage_pct + '%'),
        delta: null,
        deltaMeta: 'rolling 30d',
        spark: [],
        drawer: 'geo',
      },
      {
        label: 'Monto MTD',
        value: formatCurrency(d.mtd_amount),
        delta: dl.mtd_vs_prev_month_pct,
        deltaMeta: 'mismo día mes prev.',
        spark: sp.sales_14d || [],
        drawer: 'commercial',
      },
      {
        label: 'Reps activos',
        value: formatNum(d.active_reps),
        delta: null,
        deltaMeta: 'últimos 5 min',
        spark: [],
        drawer: 'ops',
      },
      {
        label: 'Compliance MTD',
        value: (d.compliance_mtd == null ? '—' : d.compliance_mtd + '%'),
        delta: null,
        deltaMeta: 'plan vs ejecutado',
        spark: sp.compliance_14d || [],
        drawer: 'people',
      },
      {
        label: 'Health score',
        value: (d.system_score == null ? '—' : d.system_score),
        delta: null,
        deltaMeta: `cron ${cs.cron_ok_pct ?? '—'}% · budget ${cs.budget_remaining_pct ?? '—'}%`,
        spark: [],
        drawer: 'system',
      },
    ];

    // destroy old sparklines
    sparkCharts.splice(0, sparkCharts.length).forEach((c) => { try { c.destroy(); } catch (_) {} });

    grid.innerHTML = tiles.map((t, i) => `
      <div class="kpi-tile" data-drawer="${t.drawer}">
        <div class="kpi-tile-label">${escapeHtml(t.label)}</div>
        <div class="kpi-tile-value display numeral">${t.value}</div>
        <div class="kpi-tile-delta">
          ${t.delta == null
            ? `<span class="kpi-tile-delta-meta">${escapeHtml(t.deltaMeta || '')}</span>`
            : `<span class="${t.delta > 0 ? 'kpi-tile-delta-pos' : t.delta < 0 ? 'kpi-tile-delta-neg' : 'kpi-tile-delta-neutral'}">${t.delta > 0 ? '+' : ''}${t.delta}%</span>
               <span class="kpi-tile-delta-meta">${escapeHtml(t.deltaMeta || '')}</span>`}
        </div>
        ${t.spark.length ? `<div class="kpi-tile-spark"><canvas data-spark-idx="${i}"></canvas></div>` : '<div class="kpi-tile-spark"></div>'}
      </div>
    `).join('');

    // mount sparklines (next tick so canvases are in DOM)
    setTimeout(() => {
      tiles.forEach((t, i) => {
        if (!t.spark.length) return;
        const canvas = grid.querySelector(`canvas[data-spark-idx="${i}"]`);
        if (canvas && window.AdminCharts) {
          const c = window.AdminCharts.sparkline(canvas, t.spark);
          if (c) sparkCharts.push(c);
        }
      });
    }, 0);
  }

  // ── Trend ───────────────────────────────────────────────────────
  async function loadTrend() {
    const r = getRange();
    const qs = new URLSearchParams();
    if (r.from) qs.set('from', r.from);
    if (r.to) qs.set('to', r.to);
    const data = await API.get('/admin/cockpit/trend?' + qs.toString());
    renderTrend(data);
  }

  function renderTrend(d) {
    if (trendChart) try { trendChart.destroy(); } catch (_) {}
    const canvas = document.getElementById('trend-chart');
    if (canvas && window.AdminCharts) {
      trendChart = window.AdminCharts.trendChart(canvas, d.series || {});
    }
    const tv = document.getElementById('trend-total-visits');
    const ta = document.getElementById('trend-total-amount');
    const yv = document.getElementById('trend-yoy-visits');
    const ya = document.getElementById('trend-yoy-amount');
    if (tv) { tv.textContent = formatNum(d.totals?.visits); tv.classList.remove('skeleton', 'skeleton-num'); }
    if (ta) { ta.textContent = formatCurrency(d.totals?.orders_amount); ta.classList.remove('skeleton', 'skeleton-num'); }
    if (yv) yv.textContent = d.yoy?.visits_pct == null ? 'YoY: —' : `YoY: ${d.yoy.visits_pct > 0 ? '+' : ''}${d.yoy.visits_pct}%`;
    if (ya) ya.textContent = d.yoy?.orders_amount_pct == null ? 'YoY: —' : `YoY: ${d.yoy.orders_amount_pct > 0 ? '+' : ''}${d.yoy.orders_amount_pct}%`;
  }

  // ── Coverage map ────────────────────────────────────────────────
  async function loadCoverage() {
    const data = await API.get('/admin/cockpit/coverage-heatmap?level=poblacion&days=30');
    if (window.AdminBigMap) window.AdminBigMap.setCoverageData(data.features || []);
    const meta = document.getElementById('map-meta');
    if (meta) meta.textContent = `${(data.features || []).length} regiones · ${data.days || 30} días`;
  }

  // ── Hierarchy ───────────────────────────────────────────────────
  async function loadHierarchy() {
    const r = getRange();
    const qs = new URLSearchParams();
    if (r.from) qs.set('period_start', r.from);
    if (r.to) qs.set('period_end', r.to);
    const data = await API.get('/admin/cockpit/hierarchy?' + qs.toString());
    if (window.AdminHierarchyTree) {
      window.AdminHierarchyTree.render(document.getElementById('htree'), data.roots || []);
    }
  }

  // ── Anomalies count (banner + drawer tab) ───────────────────────
  async function loadAnomaliesCount() {
    const data = await API.get('/admin/cockpit/anomalies').catch(() => ({ items: [] }));
    const items = data.items || [];
    updateAnomalyCount(items.length, data.counts_by_severity || {});
  }

  function updateAnomalyCount(n, by = {}) {
    const banner = document.getElementById('anomaly-banner');
    const text = document.getElementById('anomaly-banner-text');
    const tabCount = document.getElementById('anomaly-tab-count');
    if (tabCount) tabCount.textContent = n > 0 ? `· ${n}` : '';
    if (banner && text) {
      const critical = by.critical || 0;
      if (critical > 0) {
        banner.setAttribute('data-visible', 'true');
        text.textContent = `${critical} crítica${critical === 1 ? '' : 's'} · ${n} total`;
      } else if (n > 0) {
        banner.setAttribute('data-visible', 'true');
        text.textContent = `${n} ${n === 1 ? 'anomalía' : 'anomalías'}`;
      } else {
        banner.removeAttribute('data-visible');
      }
    }
  }

  // ── Audit live tail ─────────────────────────────────────────────
  async function pollAuditFeed() {
    try {
      const data = await API.get('/admin/cockpit/audit-feed?limit=30');
      renderAuditFeed(data.items || []);
      const status = document.getElementById('audit-status');
      if (status) status.textContent = `Refresca cada 10s · ${(data.items || []).length} eventos`;
    } catch (e) {
      const status = document.getElementById('audit-status');
      if (status) status.textContent = 'Error al refrescar';
    }
  }

  function renderAuditFeed(items) {
    const list = document.getElementById('audit-list');
    if (!list) return;
    if (!items.length) {
      list.innerHTML = `<div class="empty"><div class="empty-title">Sin eventos recientes</div><div class="empty-sub">Cuando alguien modifique datos del sistema aparecerá aquí.</div></div>`;
      return;
    }
    list.innerHTML = items.map((it) => `
      <div class="audit-item">
        <div class="audit-item-time">${it.created_at ? timeAgo(it.created_at) : '—'}</div>
        <div>
          <span class="audit-item-action">${escapeHtml(it.action || '—')}</span>
          <span class="muted text-xs"> · ${escapeHtml(it.entity_type || '—')}${it.entity_id ? ' #' + String(it.entity_id).slice(0, 8) : ''}</span>
        </div>
        <div class="muted">${escapeHtml(it.user_name || it.user_id || 'sistema')}</div>
        <div class="muted text-xs">${escapeHtml(it.user_role || '—')}</div>
      </div>
    `).join('');
  }

  // ── Keyboard shortcuts ──────────────────────────────────────────
  function setupKeyboardShortcuts() {
    let leader = null;
    let leaderTimer = null;
    document.addEventListener('keydown', (e) => {
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === 'g') {
        leader = 'g';
        clearTimeout(leaderTimer);
        leaderTimer = setTimeout(() => { leader = null; }, 800);
        return;
      }
      if (leader === 'g') {
        const map = { o: 'ops', g: 'geo', p: 'people', c: 'commercial', n: 'onboarding', q: 'quality', s: 'system', a: 'anomalies' };
        const target = map[e.key];
        if (target) {
          document.querySelectorAll('.drawer-tab').forEach((b) => b.removeAttribute('data-active'));
          const tab = document.querySelector(`.drawer-tab[data-drawer="${target}"]`);
          if (tab) tab.setAttribute('data-active', 'true');
          window.AdminDrawer.switchTo(target);
          document.getElementById('drawer').scrollIntoView({ behavior: 'smooth', block: 'start' });
          leader = null;
        }
      }
      if (e.key === 'r' && (e.metaKey || e.ctrlKey) === false) {
        loadAll();
      }
    });
  }

  // ── Utilities ───────────────────────────────────────────────────
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

  function timeAgo(iso) {
    if (!iso) return '—';
    const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return `hace ${sec}s`;
    if (sec < 3600) return `hace ${Math.round(sec / 60)}m`;
    if (sec < 86400) return `hace ${Math.round(sec / 3600)}h`;
    return `hace ${Math.round(sec / 86400)}d`;
  }

  // expose for drawer (range query)
  window.AdminCockpit = { getRange };

  // boot when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
