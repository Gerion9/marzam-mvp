/* =============================================================
   Marzam — Vista "Cumplimiento" (quotas por subordinado directo)
   API:
     window.MarzamDistribution.render(container)         ← entry standalone (legacy)
     window.MarzamDistribution.renderEmbedded(container) ← uso desde tab interno

   La diferencia es:
     - render: incluye guardia de rol (mostraba candado si no eras manager)
     - renderEmbedded: asume que el caller ya filtró acceso (la sección Plan
       solo se muestra a managers en el sidebar).  Sin guardia interna evita
       doble-bloqueo y reduce ruido visual.
   ============================================================= */
(function () {
  'use strict';

  const ALLOWED = ['director_sucursal', 'gerente_ventas', 'supervisor'];

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  }

  function canUse(role) {
    return ALLOWED.includes(role);
  }

  // Detecta plazas vacantes (full_name = 'VACANTE' o vacío).  Igual que en
  // views.js, no tiene sentido fijar meta del período a una posición sin
  // titular: se filtra del listado para que el manager solo vea personas.
  function isVacancy(r) {
    const name = String(r?.full_name || '').trim();
    return !name || /^vacante$/i.test(name);
  }

  function monthBounds(d = new Date()) {
    const start = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
    return { start, end };
  }

  async function renderEmbedded(container) {
    const { start, end } = monthBounds();
    // Pre-load team + clients + canonical EF list. clients sirve para
    // hidratar `u.poblaciones` cuando el backend no enriqueció (fallback
    // basado en rep_code/supervisor_code/gerencia_code del padrón).
    const [team, clientsRaw, pobCanonical] = await Promise.all([
      API.get('/team/descendants').catch(() => []),
      API.get('/marzam/clients?limit=2000').catch(() => []),
      API.get('/poblaciones').catch(() => null),
    ]);
    const clientList = Array.isArray(clientsRaw) ? clientsRaw : (clientsRaw?.clients || clientsRaw?.rows || clientsRaw?.data || []);
    if (window.MarzamEF?.hydrateTeam) window.MarzamEF.hydrateTeam(team, clientList);
    const polRaw = [];
    (team || []).forEach((u) => (Array.isArray(u.poblaciones) ? u.poblaciones : []).forEach((p) => polRaw.push(p)));
    if (pobCanonical?.options) {
      for (const opt of pobCanonical.options) {
        if (opt?.value && opt.value !== '__all__') polRaw.push(opt.value);
      }
    }
    const populations = window.MarzamEF ? window.MarzamEF.dedup(polRaw) : [...new Set(polRaw.filter(Boolean))].sort();
    let activeFilter = window.MarzamPlanZone || (window.APP?.poblacion && window.APP.poblacion !== '__all__' ? window.APP.poblacion : '');
    const efKey = window.MarzamEF ? window.MarzamEF.key : ((s) => String(s || '').trim().toLowerCase());
    // Index por efKey (sin acentos) para que el filtro tolere variantes.
    const userIdsByKey = new Map();
    const userWithoutPob = new Set(); // cobertura desconocida → incluir en cualquier filtro
    (team || []).forEach((u) => {
      const list = Array.isArray(u.poblaciones) ? u.poblaciones : [];
      if (!list.length) { userWithoutPob.add(u.id); return; }
      list.forEach((p) => {
        const k = efKey(p);
        if (!userIdsByKey.has(k)) userIdsByKey.set(k, new Set());
        userIdsByKey.get(k).add(u.id);
      });
    });

    container.innerHTML = `
      <div>
        <div class="bg-gradient-to-br from-slate-50 to-white border border-slate-200 rounded-2xl p-3 mb-3">
          <div class="flex items-start gap-2">
            <span class="text-base leading-none mt-0.5">🎯</span>
            <p class="text-[11px] text-slate-600 leading-snug">
              <b class="text-slate-800">Meta del período por subordinado.</b>
              Es la <b>vara de cumplimiento</b>: cuántas <b>nuevas</b> y cuántos <b>clientes</b> esperas
              de cada uno este mes.  El plan generado en <b>Cuotas</b> ya distribuye visitas día a día;
              estas metas son por las que evalúas el resultado.
            </p>
          </div>
        </div>

        <!-- Filtro Entidad Federativa (col. poblacion en marzam_clients) -->
        <div class="bg-white border border-slate-200 rounded-2xl p-3 mb-3">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            <label class="text-[10px] font-bold uppercase tracking-wider text-slate-500">Entidad federativa</label>
            <select id="dist-pob" class="flex-1 text-xs font-semibold bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 outline-none">
              <option value="">Toda la sucursal</option>
              ${populations.map((p) => `<option value="${escapeHtml(p)}" ${activeFilter === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
            </select>
            <span id="dist-pob-count" class="text-[10px] text-slate-400 font-bold whitespace-nowrap"></span>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 mb-3">
          <div class="text-[11px] font-bold text-slate-500 uppercase">Período</div>
          <input id="dist-start" type="date" value="${start}" class="text-xs border rounded-lg px-2 py-1">
          <span class="text-slate-400">→</span>
          <input id="dist-end" type="date" value="${end}" class="text-xs border rounded-lg px-2 py-1">
          <button id="dist-reload" class="ml-auto text-xs font-bold bg-slate-100 px-3 py-1.5 rounded-lg">Actualizar</button>
        </div>

        <!-- Acción principal: tarjeta por subordinado, cada una con su propia
             meta editable.  Va PRIMERO porque es lo que el manager hace todos
             los meses.  El "atajo uniforme" queda colapsado al fondo. -->
        <div id="dist-rows" class="space-y-2 mb-4"></div>

        <!-- Atajo opcional, colapsable.  Se abre solo si el manager lo
             necesita (push trimestral, baseline inicial). -->
        <div class="border border-slate-200 rounded-2xl overflow-hidden">
          <button id="uniform-toggle" type="button"
                  class="w-full flex items-center justify-between px-4 py-3 bg-slate-50 hover:bg-slate-100 transition">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-base leading-none">⚡</span>
              <div class="text-left min-w-0">
                <div class="text-xs font-bold text-slate-700">Pre-llenar todas las tarjetas</div>
                <div class="text-[10px] text-slate-500 truncate">Atajo: copia la misma meta a cada subordinado</div>
              </div>
            </div>
            <span id="uniform-chevron" class="text-slate-400 text-xs flex-shrink-0">▾</span>
          </button>
          <div id="uniform-body" class="hidden p-4 border-t border-slate-200 bg-orange-50/40">
            <p class="text-[11px] text-slate-600 mb-3 leading-snug">
              Útil para arrancar el mes con un baseline común o para un push trimestral.
              Después puedes ajustar cada tarjeta arriba y darle <b>Guardar meta</b> donde corresponda.
            </p>
            <div class="grid grid-cols-2 gap-2 mb-3">
              <div>
                <label class="text-[10px] font-bold text-slate-500 uppercase">Meta nuevas</label>
                <input id="uniform-new" type="number" min="0" value="0" class="w-full border rounded-lg px-2 py-2 text-sm">
              </div>
              <div>
                <label class="text-[10px] font-bold text-slate-500 uppercase">Meta clientes</label>
                <input id="uniform-existing" type="number" min="0" value="0" class="w-full border rounded-lg px-2 py-2 text-sm">
              </div>
            </div>
            <button id="uniform-apply" class="w-full bg-gradient-to-r from-[#e5730a] to-orange-400 text-white font-bold text-sm py-2.5 rounded-xl">
              Pre-llenar todas las tarjetas
            </button>
          </div>
        </div>
      </div>
    `;

    const startInp = container.querySelector('#dist-start');
    const endInp = container.querySelector('#dist-end');
    const reload = container.querySelector('#dist-reload');
    const rowsEl = container.querySelector('#dist-rows');
    const uniformBtn = container.querySelector('#uniform-apply');

    async function load() {
      rowsEl.innerHTML = window.MarzamSkeleton ? window.MarzamSkeleton() + window.MarzamSkeleton() : 'Cargando...';
      try {
        const data = await API.get(`/quotas?period_start=${startInp.value}&period_end=${endInp.value}`);
        // Filtrar plazas vacantes — no se les puede fijar meta y al manager
        // solo le interesa ver gente con quien medir cumplimiento.
        let rows = (data.rows || []).filter((r) => !isVacancy(r));
        // Filtrar por Entidad Federativa: solo subordinados que sirvan a la
        // EF activa. El set de user_ids por EF se construyó en init usando
        // los `poblaciones` enriquecidos del backend (marzam_clients.poblacion).
        if (activeFilter) {
          // Strict: post-hidratación, un user sin coincidencia genuinamente
          // no tiene padrón en la EF y no aparece en Avance. Esto hace que
          // los conteos varíen al cambiar de EF.
          const allowed = userIdsByKey.get(efKey(activeFilter)) || new Set();
          rows = rows.filter((r) => allowed.has(r.user_id));
        }
        const countEl = container.querySelector('#dist-pob-count');
        if (countEl) countEl.textContent = activeFilter ? `${rows.length} en ${activeFilter}` : '';
        renderRows(rows);
      } catch (err) {
        rowsEl.innerHTML = `<div class="text-center text-rose-600 text-sm py-4">${escapeHtml(err?.error || 'Error')}</div>`;
      }
    }

    function renderRows(rows) {
      if (!rows.length) {
        rowsEl.innerHTML = `<div class="text-center text-slate-500 text-sm py-6">No tienes subordinados activos.<br><span class="text-[11px] text-slate-300">Las plazas vacantes no se muestran.</span></div>`;
        return;
      }
      rowsEl.innerHTML = rows.map((r) => {
        // Iniciales seguras: si por algún motivo el nombre quedó vacío, "?"
        // en lugar de "..." que se veía mal en el avatar.
        const inits = String(r.full_name || '?').trim().split(/\s+/).slice(0, 2)
          .map((s) => s[0] || '').join('').toUpperCase() || '?';
        return `
        <div class="bg-white border border-slate-200 rounded-2xl p-3 shadow-sm" data-uid="${r.user_id}">
          <div class="flex items-center gap-3 mb-2">
            <div class="w-9 h-9 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center font-bold text-xs flex-shrink-0">
              ${escapeHtml(inits)}
            </div>
            <div class="flex-1 min-w-0">
              <div class="font-bold text-sm text-slate-800 truncate">${escapeHtml(r.full_name || '')}</div>
              <div class="text-[11px] text-slate-500">${escapeHtml(r.role || '')}</div>
            </div>
            ${(r.blocked_new || r.blocked_existing) ? `
              <span class="text-[10px] font-bold uppercase bg-rose-100 text-rose-700 rounded-full px-2 py-0.5 flex-shrink-0">Atrás de meta</span>
            ` : ''}
          </div>
          <div class="grid grid-cols-2 gap-2 mb-2">
            <div class="bg-emerald-50 rounded-xl p-2">
              <div class="text-[10px] font-bold text-emerald-700 uppercase">Nuevas</div>
              <div class="flex items-baseline gap-1">
                <span class="font-black text-lg text-emerald-800">${r.actuals?.visits_new || 0}</span>
                <span class="text-[11px] text-slate-500">/ <input data-tn type="number" min="0" value="${r.quota?.target_new || 0}" class="w-12 border-b border-slate-300 text-center font-bold focus:outline-none focus:border-emerald-600"></span>
              </div>
              ${r.gap_new > 0 ? `<div class="text-[10px] text-rose-600 font-bold mt-0.5">−${r.gap_new}</div>` : ''}
            </div>
            <div class="bg-blue-50 rounded-xl p-2">
              <div class="text-[10px] font-bold text-blue-700 uppercase">Clientes</div>
              <div class="flex items-baseline gap-1">
                <span class="font-black text-lg text-blue-800">${r.actuals?.visits_existing || 0}</span>
                <span class="text-[11px] text-slate-500">/ <input data-te type="number" min="0" value="${r.quota?.target_existing || 0}" class="w-12 border-b border-slate-300 text-center font-bold focus:outline-none focus:border-blue-600"></span>
              </div>
              ${r.gap_existing > 0 ? `<div class="text-[10px] text-rose-600 font-bold mt-0.5">−${r.gap_existing}</div>` : ''}
            </div>
          </div>
          <button data-save class="w-full bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold py-2 rounded-lg">Guardar meta</button>
        </div>
      `;
      }).join('');

      rowsEl.querySelectorAll('[data-uid]').forEach((card) => {
        card.querySelector('[data-save]').addEventListener('click', async () => {
          const uid = card.dataset.uid;
          const tn = Number(card.querySelector('[data-tn]').value) || 0;
          const te = Number(card.querySelector('[data-te]').value) || 0;
          try {
            await API.post('/quotas', {
              target_user_id: uid,
              period_start: startInp.value,
              period_end: endInp.value,
              target_new: tn,
              target_existing: te,
              mode: 'custom',
            });
            window.MarzamToast?.show('Meta guardada ✓', 'success');
            load();
          } catch (err) {
            window.MarzamToast?.show(err?.error || 'Error guardando meta', 'error');
          }
        });
      });
    }

    reload.addEventListener('click', load);
    // Filtro Entidad Federativa: cambia el set activo + dispara reload.
    // También sincroniza window.MarzamPlanZone para que Cuotas y Crear plan
    // hereden el mismo filtro al cambiar de sub-tab.
    const polSelect = container.querySelector('#dist-pob');
    if (polSelect) {
      polSelect.addEventListener('change', (e) => {
        activeFilter = e.target.value || '';
        window.MarzamPlanZone = activeFilter || null;
        load();
      });
    }

    // Acordeón del atajo uniforme — empieza cerrado para no robarle protagonismo
    // a las tarjetas individuales (que son la acción principal).
    const uniformToggle = container.querySelector('#uniform-toggle');
    const uniformBody = container.querySelector('#uniform-body');
    const uniformChevron = container.querySelector('#uniform-chevron');
    uniformToggle.addEventListener('click', () => {
      const isHidden = uniformBody.classList.toggle('hidden');
      uniformChevron.textContent = isHidden ? '▾' : '▴';
    });

    uniformBtn.addEventListener('click', async () => {
      try {
        await API.post('/quotas/uniform', {
          period_start: startInp.value,
          period_end: endInp.value,
          target_new: Number(container.querySelector('#uniform-new').value) || 0,
          target_existing: Number(container.querySelector('#uniform-existing').value) || 0,
        });
        window.MarzamToast?.show('Tarjetas pre-llenadas · ajusta y guarda cada una', 'success');
        // Cerrar el acordeón después de aplicar para que el manager regrese
        // su atención a las tarjetas (que es donde ahora vive el cambio).
        uniformBody.classList.add('hidden');
        uniformChevron.textContent = '▾';
        load();
      } catch (err) {
        window.MarzamToast?.show(err?.error || 'Error', 'error');
      }
    });

    load();
  }

  // Wrapper standalone: aplica el guard de rol y delega a renderEmbedded.
  // Se mantiene por compatibilidad con código legado que llamaba `render`.
  async function render(container) {
    const role = (window.APP?.role) || (JSON.parse(localStorage.getItem('user') || '{}').role);
    if (!canUse(role)) {
      container.innerHTML = `
        <div class="text-center py-10 px-4">
          <div class="text-4xl mb-2">🔒</div>
          <p class="text-slate-600 font-bold text-sm">Esta sección es solo para director, gerente y supervisor.</p>
        </div>`;
      return;
    }
    return renderEmbedded(container);
  }

  window.MarzamDistribution = { render, renderEmbedded, canUse };
})();
