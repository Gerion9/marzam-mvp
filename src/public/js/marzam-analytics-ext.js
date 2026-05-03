/* =============================================================
   Marzam — Extensión de la pestaña Analíticas.
   Inyecta tres tarjetas debajo del contenido existente de Analíticas:
     1. Bloqueos de cuota (quotas-blockages)
     2. Efectividad por nivel jerárquico (hierarchy-effectiveness)
     3. Margen por producto (products-margin)
   ============================================================= */
(function () {
  'use strict';

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  }
  function fmtMoney(n) {
    const x = Number(n) || 0;
    return '$' + x.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) { return ((Number(n) || 0) * 100).toFixed(0) + '%'; }

  function block(title, html) {
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-4 mt-4 shadow-sm">
        <div class="text-xs font-black text-slate-700 uppercase tracking-wide mb-2">${title}</div>
        ${html}
      </div>`;
  }

  async function injectInto(container) {
    if (!container || container.dataset.marzamExtInjected) return;
    container.dataset.marzamExtInjected = '1';

    const wrap = document.createElement('div');
    wrap.id = 'analytics-ext';
    wrap.innerHTML = `
      ${block('Bloqueos de cuota (mes actual)', '<div id="ax-quotas">Cargando...</div>')}
      ${block('Efectividad por nivel jerárquico', '<div id="ax-eff">Cargando...</div>')}
      ${block('Margen por producto · Precio Farmacia − Precio Marzam', '<div id="ax-prod">Cargando...</div>')}
    `;
    container.appendChild(wrap);

    const role = window.APP?.role || '';
    const isManager = ['director_sucursal', 'gerente_ventas', 'supervisor'].includes(role);

    // Bloqueos: solo management
    if (!isManager) {
      wrap.querySelector('#ax-quotas').innerHTML = '<div class="text-xs text-slate-500">No disponible para tu rol.</div>';
    } else {
      try {
        const data = await API.get('/analytics/quotas-blockages');
        const rows = data.rows || [];
        const blocked = rows.filter((r) => r.blocked);
        if (!blocked.length) {
          wrap.querySelector('#ax-quotas').innerHTML = '<div class="text-xs text-emerald-700 font-bold">✓ Nadie tiene bloqueos en este período.</div>';
        } else {
          wrap.querySelector('#ax-quotas').innerHTML = `
            <div class="space-y-1.5">
              ${blocked.slice(0, 8).map((r) => `
                <div class="flex items-center gap-2 text-xs">
                  <span class="flex-1 font-bold text-slate-800 truncate">${escapeHtml(r.full_name || '')}</span>
                  <span class="text-slate-500">${escapeHtml(r.role || '')}</span>
                  ${r.gap_new > 0 ? `<span class="bg-emerald-100 text-emerald-700 font-bold rounded-full px-2">−${r.gap_new} nuevas</span>` : ''}
                  ${r.gap_existing > 0 ? `<span class="bg-blue-100 text-blue-700 font-bold rounded-full px-2">−${r.gap_existing} clientes</span>` : ''}
                </div>
              `).join('')}
              ${blocked.length > 8 ? `<div class="text-[11px] text-slate-500 mt-1">+${blocked.length - 8} más</div>` : ''}
            </div>`;
        }
      } catch (err) {
        wrap.querySelector('#ax-quotas').innerHTML = `<div class="text-xs text-rose-600">${escapeHtml(err?.error || 'Error')}</div>`;
      }
    }

    // Efectividad por nivel
    try {
      const data = await API.get('/analytics/hierarchy-effectiveness');
      const rows = data.rows || [];
      if (!rows.length) {
        wrap.querySelector('#ax-eff').innerHTML = '<div class="text-xs text-slate-500">Sin datos de visitas en el período.</div>';
      } else {
        wrap.querySelector('#ax-eff').innerHTML = `
          <div class="space-y-2">
            ${rows.map((r) => `
              <div>
                <div class="flex items-center justify-between text-xs mb-0.5">
                  <span class="font-bold text-slate-800">${escapeHtml(r.role)}</span>
                  <span class="text-slate-500">${r.visits} visitas · ${r.orders} pedidos · ${fmtPct(r.conversion_rate)}</span>
                </div>
                <div class="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div class="h-full bg-gradient-to-r from-[#e5730a] to-orange-400" style="width:${Math.min(100, r.conversion_rate * 100)}%"></div>
                </div>
                <div class="text-[10px] text-slate-500 mt-0.5">${fmtMoney(r.order_total)} en pedidos · ${r.visits_new} nuevas / ${r.visits_existing} clientes</div>
              </div>
            `).join('')}
          </div>`;
      }
    } catch (err) {
      wrap.querySelector('#ax-eff').innerHTML = `<div class="text-xs text-rose-600">${escapeHtml(err?.error || 'Error')}</div>`;
    }

    // Productos / margen
    try {
      const data = await API.get('/analytics/products-margin?limit=10');
      const rows = data.rows || [];
      if (!rows.length) {
        wrap.querySelector('#ax-prod').innerHTML = '<div class="text-xs text-slate-500">Sin productos capturados todavía.</div>';
      } else {
        wrap.querySelector('#ax-prod').innerHTML = `
          <div class="space-y-1.5">
            ${rows.map((r) => `
              <div class="flex items-center gap-2 text-xs py-1 border-b border-slate-100 last:border-0">
                <span class="flex-1 font-bold text-slate-800 truncate" title="${escapeHtml(r.product_name)}">${escapeHtml(r.product_name)}</span>
                <span class="text-slate-500">${r.samples}×</span>
                <span class="text-slate-700">${fmtMoney(r.avg_price_pharmacy)}</span>
                <span class="text-slate-300">→</span>
                <span class="text-orange-700 font-bold">${fmtMoney(r.avg_price_marzam)}</span>
                <span class="font-black ${Number(r.avg_margin) >= 0 ? 'text-emerald-700' : 'text-rose-700'}">${Number(r.avg_margin) >= 0 ? '+' : ''}${fmtMoney(r.avg_margin)}</span>
              </div>
            `).join('')}
          </div>`;
      }
    } catch (err) {
      wrap.querySelector('#ax-prod').innerHTML = `<div class="text-xs text-rose-600">${escapeHtml(err?.error || 'Error')}</div>`;
    }
  }

  // Hook: cuando el panel cambia de tab, si es analytics, inyectamos.
  const observer = new MutationObserver(() => {
    if (window.APP?.activeTab !== 'analytics') return;
    const body = document.getElementById('panel-body');
    if (!body) return;
    if (body.querySelector('#analytics-ext')) return;
    // Esperar a que MarzamViews.renderAnalytics haya pintado para evitar carrera con su skeleton
    if (body.querySelector('.skeleton')) return;
    injectInto(body);
  });
  document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('panel-body');
    if (root) observer.observe(root, { childList: true, subtree: true });
  });
})();
