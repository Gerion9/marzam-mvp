/**
 * Hierarchy tree — recursive expandable rendering with rolled-up KPIs.
 */
(function () {
  const ROLE_LABEL = {
    admin: 'Admin',
    director_sucursal: 'Director',
    gerente_ventas: 'Gerente',
    supervisor: 'Supervisor',
    representante: 'Rep',
  };

  const expanded = new Set();
  let cachedRoots = [];
  let containerEl = null;

  function render(container, roots) {
    containerEl = container;
    cachedRoots = roots || [];
    if (!cachedRoots.length) {
      container.innerHTML = '<div class="empty"><div class="empty-title">Sin jerarquía cargada</div><div class="empty-sub">Verifica que existan usuarios activos.</div></div>';
      return;
    }
    // auto-expand top-level
    cachedRoots.forEach((r) => expanded.add(r.id));
    container.innerHTML = '';
    cachedRoots.forEach((node) => container.appendChild(buildNode(node, 0)));
  }

  function buildNode(node, depth) {
    const wrap = document.createElement('div');
    wrap.style.padding = '0 14px';

    const row = document.createElement('div');
    row.className = 'htree-node';
    row.dataset.id = node.id;

    const hasChildren = node.children && node.children.length;
    const isOpen = expanded.has(node.id);

    const k = node.kpis || {};
    const teamTotals = k.team_totals;
    const visits = teamTotals?.visits ?? k.visits ?? 0;
    const orders = teamTotals?.orders ?? k.orders ?? 0;
    const compliance = k.compliance_pct;

    row.innerHTML = `
      <div class="htree-node-name">
        <span class="htree-toggle">${hasChildren ? (isOpen ? '▾' : '▸') : '·'}</span>
        <span class="htree-presence" data-status="${k.presence || 'offline'}"></span>
        <span class="htree-role">${escapeHtml(ROLE_LABEL[node.role] || node.role || '')}</span>
        <span class="table-strong" style="font-weight:500">${escapeHtml(node.full_name || '')}</span>
      </div>
      <div class="htree-kpi">
        <span class="htree-kpi-label">Visitas</span>
        ${formatNum(visits)}
      </div>
      <div class="htree-kpi">
        <span class="htree-kpi-label">${compliance == null ? 'Órdenes' : 'Compl.'}</span>
        ${compliance == null ? formatNum(orders) : compliance + '%'}
      </div>
    `;
    row.style.paddingLeft = (depth * 4) + 'px';

    row.addEventListener('click', () => {
      if (!hasChildren) return;
      if (expanded.has(node.id)) expanded.delete(node.id);
      else expanded.add(node.id);
      // re-render only this node's container
      render(containerEl, cachedRoots);
    });

    wrap.appendChild(row);

    if (hasChildren && isOpen) {
      const childWrap = document.createElement('div');
      childWrap.className = 'htree-children';
      node.children.forEach((c) => childWrap.appendChild(buildNode(c, depth + 1)));
      wrap.appendChild(childWrap);
    }
    return wrap;
  }

  function collapseAll() {
    expanded.clear();
    if (containerEl && cachedRoots.length) render(containerEl, cachedRoots);
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  function formatNum(n) {
    return Number(n || 0).toLocaleString('es-MX');
  }

  window.AdminHierarchyTree = { render, collapseAll };
})();
