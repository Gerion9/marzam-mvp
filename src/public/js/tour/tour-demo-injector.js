/* =============================================================
   Marzam tour demo injector.

   Cuando un tour declara prerequisites.fallbackToDemo y el usuario no
   tiene datos reales (sin assignments / sin equipo), inyectamos HTML
   "tour demo" en el #panel para que los steps puedan apuntar a algo
   visible. Al desactivar, removemos el HTML inyectado.

   No parchamos fetch ni tocamos el backend — todo es DOM puro y
   reversible. Esto evita conflictos con DEMO_H (cuando el user es
   `@demo.marzam.mx` el demoHierarchy ya tiene su propio sistema).

   Expone window.TourDemoInjector = { activate, deactivate, isActive }.
   ============================================================= */
(function () {
  'use strict';

  const State = {
    active: false,
    role: null,
    injectedNodes: [],
    panelObserver: null,
  };

  // ── Helpers ───────────────────────────────────────────────────
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset' && typeof v === 'object') {
          for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
        } else if (k === 'className') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  // ── Detection: does the user already have real data? ────────
  async function userHasAssignments() {
    try {
      const res = await fetch('/api/visit-plans/assignments', {
        headers: {
          'Authorization': 'Bearer ' + (localStorage.getItem('token') || ''),
          'Accept': 'application/json',
        },
      });
      if (!res.ok) return false;
      const body = await res.json();
      const list = Array.isArray(body) ? body : (body && body.data) || [];
      return list.length > 0;
    } catch (e) {
      return false;
    }
  }

  async function userHasTeam() {
    try {
      const res = await fetch('/api/team/', {
        headers: {
          'Authorization': 'Bearer ' + (localStorage.getItem('token') || ''),
          'Accept': 'application/json',
        },
      });
      if (!res.ok) return false;
      const body = await res.json();
      const members = Array.isArray(body) ? body
        : (body && (body.members || body.team || body.cascade)) || [];
      return Array.isArray(members) && members.length > 0;
    } catch (e) {
      return false;
    }
  }

  // ── Demo content ─────────────────────────────────────────────
  function buildDemoPharmacyCard() {
    const card = el('div', {
      className: 'tour-demo-card',
      'data-pharmacy-id': 'tour-demo-1',
      style: {
        margin: '12px 0',
        padding: '14px 16px',
        background: 'linear-gradient(135deg, rgba(229,115,10,0.08), rgba(37,99,235,0.04))',
        border: '2px dashed rgba(229,115,10,0.5)',
        borderRadius: '14px',
        position: 'relative',
        cursor: 'default',
      },
    });
    const tag = el('span', {
      style: {
        position: 'absolute',
        top: '-10px',
        left: '12px',
        background: '#e5730a',
        color: '#fff',
        fontSize: '10px',
        fontWeight: '800',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        padding: '3px 8px',
        borderRadius: '999px',
      },
    }, 'Ejemplo · Tutorial');
    card.appendChild(tag);

    card.appendChild(el('div', {
      style: { display: 'flex', alignItems: 'center', gap: '10px' },
    }, [
      el('div', {
        style: {
          width: '40px', height: '40px', borderRadius: '10px',
          background: 'linear-gradient(135deg, #1b365d, #2563eb)',
          color: '#fff', display: 'inline-flex',
          alignItems: 'center', justifyContent: 'center', flexShrink: '0',
        },
        html: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
      }),
      el('div', { style: { flex: '1', minWidth: '0' } }, [
        el('div', {
          style: { fontWeight: '800', fontSize: '14px', color: '#0f172a' },
        }, 'Farmacia Tour Demo'),
        el('div', {
          style: { fontSize: '12px', color: '#64748b', marginTop: '2px' },
        }, 'Av. Insurgentes Norte 1234 · Ecatepec, Edo. Méx.'),
      ]),
    ]));

    card.appendChild(el('div', {
      style: { marginTop: '10px', fontSize: '12px', color: '#475569', lineHeight: '1.4' },
    }, 'Esta es una farmacia de ejemplo solo visible durante el tutorial. Cuando tu Supervisor te asigne tus farmacias reales, aparecerán aquí.'));

    return card;
  }

  function buildDemoTeamCards() {
    const wrap = el('div', {
      'data-tour-demo': 'team',
      style: { margin: '12px 0' },
    });

    const banner = el('div', {
      style: {
        background: 'rgba(229,115,10,0.08)',
        border: '1px dashed rgba(229,115,10,0.4)',
        borderRadius: '12px',
        padding: '10px 14px',
        marginBottom: '12px',
        fontSize: '12px',
        color: '#92400e',
        fontWeight: '600',
      },
    }, 'Estos Representantes son ejemplos del tutorial. Cuando tu equipo real esté cargado aparecerá aquí.');
    wrap.appendChild(banner);

    const reps = [
      { name: 'Ana López', code: 'REP-001', status: 'En ruta' },
      { name: 'Carlos Ruiz', code: 'REP-002', status: 'Visitando' },
      { name: 'Marta Ortega', code: 'REP-003', status: 'Reportando' },
    ];
    for (const r of reps) {
      const card = el('div', {
        className: 'tour-demo-card',
        style: {
          padding: '12px 14px',
          background: '#fff',
          border: '1px dashed #cbd5e1',
          borderRadius: '12px',
          marginBottom: '8px',
          display: 'flex', alignItems: 'center', gap: '10px',
        },
      });
      card.appendChild(el('div', {
        style: {
          width: '36px', height: '36px', borderRadius: '999px',
          background: '#e2e8f0', color: '#475569',
          display: 'inline-flex', alignItems: 'center',
          justifyContent: 'center', fontWeight: '800', fontSize: '13px',
          flexShrink: '0',
        },
      }, r.name.split(' ').map((p) => p[0]).join('').slice(0, 2)));
      card.appendChild(el('div', { style: { flex: '1' } }, [
        el('div', {
          style: { fontWeight: '700', fontSize: '13px', color: '#0f172a' },
        }, r.name),
        el('div', {
          style: { fontSize: '11px', color: '#94a3b8', marginTop: '2px' },
        }, r.code),
      ]));
      card.appendChild(el('span', {
        style: {
          fontSize: '10px', fontWeight: '700', textTransform: 'uppercase',
          letterSpacing: '0.05em', color: '#059669',
          background: 'rgba(5,150,105,0.1)', padding: '4px 8px',
          borderRadius: '999px',
        },
      }, r.status));
      wrap.appendChild(card);
    }

    return wrap;
  }

  function injectInto(container, node) {
    container.insertBefore(node, container.firstChild);
    State.injectedNodes.push(node);
  }

  // ── Activate / deactivate ────────────────────────────────────
  async function activate(opts) {
    opts = opts || {};
    if (State.active) return;
    State.role = opts.role || null;

    const isRep = State.role === 'representante';
    const isManager = State.role === 'supervisor'
      || State.role === 'gerente_ventas'
      || State.role === 'director_sucursal';

    let needsPharmacy = false;
    let needsTeam = false;

    if (isRep) {
      needsPharmacy = !(await userHasAssignments());
    } else if (isManager) {
      needsTeam = !(await userHasTeam());
    }

    if (!needsPharmacy && !needsTeam) {
      // User has real data — nothing to inject. Tour will use real targets.
      State.active = false;
      return;
    }

    State.active = true;

    // Wait for the panel to exist; the engine tabs may take a beat to render
    const panelBody = await waitForElement('#panel-body', 3000);
    if (!panelBody) {
      State.active = false;
      return;
    }

    if (needsPharmacy) {
      injectInto(panelBody, buildDemoPharmacyCard());
    }
    if (needsTeam) {
      injectInto(panelBody, buildDemoTeamCards());
    }

    // If the active tab changes (engine.onEnter fires selectTab) the panel
    // re-renders and our injection gets nuked. Watch for re-renders and
    // re-inject.
    State.panelObserver = new MutationObserver(() => {
      // Only re-inject if our nodes are gone
      const stillThere = State.injectedNodes.every((n) => document.body.contains(n));
      if (stillThere) return;
      // Drop dead refs
      State.injectedNodes = State.injectedNodes.filter((n) => document.body.contains(n));
      // Re-inject what was removed
      const body = document.getElementById('panel-body');
      if (!body) return;
      if (needsPharmacy && !body.querySelector('[data-pharmacy-id="tour-demo-1"]')) {
        const node = buildDemoPharmacyCard();
        body.insertBefore(node, body.firstChild);
        State.injectedNodes.push(node);
      }
      if (needsTeam && !body.querySelector('[data-tour-demo="team"]')) {
        const node = buildDemoTeamCards();
        body.insertBefore(node, body.firstChild);
        State.injectedNodes.push(node);
      }
    });
    State.panelObserver.observe(document.getElementById('panel') || document.body, {
      childList: true,
      subtree: true,
    });
  }

  function deactivate() {
    if (!State.active && State.injectedNodes.length === 0) return;
    State.active = false;
    if (State.panelObserver) {
      try { State.panelObserver.disconnect(); } catch (e) { /* ignore */ }
      State.panelObserver = null;
    }
    for (const n of State.injectedNodes) {
      if (n && n.parentNode) n.parentNode.removeChild(n);
    }
    State.injectedNodes = [];
    State.role = null;
  }

  function waitForElement(selector, timeoutMs) {
    return new Promise((resolve) => {
      const node = document.querySelector(selector);
      if (node) return resolve(node);
      let done = false;
      const obs = new MutationObserver(() => {
        if (done) return;
        const n = document.querySelector(selector);
        if (n) { done = true; obs.disconnect(); clearTimeout(t); resolve(n); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const t = setTimeout(() => { if (!done) { done = true; obs.disconnect(); resolve(null); } }, timeoutMs);
    });
  }

  window.TourDemoInjector = {
    activate,
    deactivate,
    isActive() { return State.active; },
  };
})();
