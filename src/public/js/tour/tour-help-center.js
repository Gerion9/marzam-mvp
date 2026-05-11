/* =============================================================
   Marzam tour help center.

   Drawer derecho en desktop, bottom-sheet en mobile, con índice de
   capítulos del rol del usuario actual. Marca completados con ✓ y
   permite re-iniciar cualquier capítulo. Botón "ver introducción"
   abre el welcome modal otra vez.

   Expone window.TourHelp = { open, close, toggle, isOpen }.

   No depende del engine para construir su UI — solo lo invoca via
   MarzamTour.start(tourId) cuando el usuario elige un capítulo.
   ============================================================= */
(function () {
  'use strict';

  const State = {
    isOpen: false,
    backdropEl: null,
    drawerEl: null,
    keyHandler: null,
    celebrateTourId: null,
  };

  // ── DOM helpers ───────────────────────────────────────────────
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'style' && typeof v === 'object') {
          Object.assign(node.style, v);
        } else if (k === 'dataset' && typeof v === 'object') {
          for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
        } else if (k.startsWith('on') && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'className') {
          node.className = v;
        } else if (k === 'html') {
          node.innerHTML = v;
        } else {
          node.setAttribute(k, v);
        }
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

  // ── Render ────────────────────────────────────────────────────
  function rolesOfCurrentUser() {
    const tourState = window.MarzamTour && window.MarzamTour.getState && window.MarzamTour.getState();
    return tourState ? tourState.role : null;
  }

  function chaptersForRole(role) {
    const reg = window.TOUR_REGISTRY || {};
    const out = [];
    for (const id of Object.keys(reg)) {
      const t = reg[id];
      if (!t || !t.role) continue;
      if (t.role !== role) continue;
      out.push(t);
    }
    // Stable order — onboarding first, others by registry order
    out.sort((a, b) => {
      const ao = a.id.endsWith('-onboarding') ? 0 : 1;
      const bo = b.id.endsWith('-onboarding') ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return 0;
    });
    return out;
  }

  function iconSvg(name) {
    const ICONS = {
      map: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M9 20l-5-3V4l5 3 5-3 5 3v13l-5-3-5 3z"/><path d="M9 4v13"/><path d="M14 7v13"/></svg>',
      camera: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M3 7h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13" r="4"/></svg>',
      team: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><circle cx="17" cy="7" r="3"/><path d="M21 21v-2a3 3 0 0 0-2-2.83"/></svg>',
      analytics: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>',
      plan: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><path d="M9.5 12.2l1.8 1.8 3.5-3.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      live: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M5 12a7 7 0 0 1 7-7"/><path d="M19 12a7 7 0 0 0-7-7"/><path d="M9 18a4 4 0 0 1-4-4"/><path d="M19 14a4 4 0 0 1-4 4"/></svg>',
      assign: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>',
      review: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
      hierarchy: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M12 7v4"/><path d="M12 11l-6 6"/><path d="M12 11l6 6"/></svg>',
      branch: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    };
    return ICONS[name] || ICONS.map;
  }

  function checkSvg() {
    return '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function buildCard(tour, completed) {
    const card = el('button', {
      className: 'tour-help-card' + (completed ? ' is-completed' : ''),
      type: 'button',
      'aria-label': tour.title + (completed ? ' (ya completado)' : ''),
      onClick: () => {
        close();
        // Small delay so the drawer animation finishes before the engine
        // mounts its overlay over our backdrop.
        setTimeout(() => {
          if (window.MarzamTour && typeof window.MarzamTour.start === 'function') {
            window.MarzamTour.start(tour.id);
          }
        }, 220);
      },
    });
    const iconWrap = el('div', {
      className: 'tour-help-card-icon',
      html: completed ? checkSvg() : iconSvg(tour.icon || 'map'),
    });
    card.appendChild(iconWrap);

    const text = el('div', { className: 'tour-help-card-text' });
    text.appendChild(el('h3', null, tour.title));
    text.appendChild(el('p', null, tour.summary || ''));
    card.appendChild(text);

    if (completed) {
      const status = el('span', {
        className: 'tour-help-card-status',
        html: checkSvg() + ' Listo',
      });
      card.appendChild(status);
    }

    return card;
  }

  function buildDrawer() {
    const role = rolesOfCurrentUser();
    const chapters = role ? chaptersForRole(role) : [];
    const tourState = window.MarzamTour && window.MarzamTour.getState && window.MarzamTour.getState();
    const completed = (tourState && tourState.persisted && tourState.persisted.completedTours) || [];

    const drawer = el('div', {
      className: 'tour-help-drawer',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tour-help-title',
    });

    drawer.appendChild(el('div', { className: 'tour-help-handle' }));

    const header = el('div', { className: 'tour-help-header' });
    const headerText = el('div', { style: { flex: '1', minWidth: '0' } });
    headerText.appendChild(el('h2', { id: 'tour-help-title' }, 'Tutorial y ayuda'));
    headerText.appendChild(el('p', null,
      role ? labelForRole(role) + ' — ' + chapters.length + ' capítulos disponibles' : 'Capítulos disponibles'));
    header.appendChild(headerText);

    const closeBtn = el('button', {
      className: 'tour-help-close',
      type: 'button',
      'aria-label': 'Cerrar',
      onClick: () => close(),
      html: '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6"/></svg>',
    });
    header.appendChild(closeBtn);
    drawer.appendChild(header);

    const body = el('div', { className: 'tour-help-body' });

    if (State.celebrateTourId) {
      const celebrated = (window.TOUR_REGISTRY || {})[State.celebrateTourId];
      if (celebrated) {
        const banner = el('div', {
          style: {
            background: 'linear-gradient(135deg, rgba(5,150,105,0.1), rgba(16,185,129,0.05))',
            border: '1px solid rgba(5,150,105,0.25)',
            borderRadius: '14px',
            padding: '14px 16px',
            marginBottom: '14px',
            color: '#065f46',
            fontWeight: '700',
            fontSize: '13px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          },
          html: '<span style="font-size:20px;">✓</span><span>¡Capítulo completado!  Sigue otro tema cuando quieras.</span>',
        });
        body.appendChild(banner);
      }
      State.celebrateTourId = null;
    }

    if (chapters.length === 0) {
      const empty = el('div', {
        style: { textAlign: 'center', padding: '32px 8px', color: '#94a3b8' },
      });
      empty.appendChild(el('p', null, 'Aún no hay capítulos disponibles para tu rol.'));
      body.appendChild(empty);
    } else {
      // Section: Onboarding (first chapter)
      const onboarding = chapters.find((c) => c.id.endsWith('-onboarding'));
      if (onboarding) {
        body.appendChild(el('div', { className: 'tour-help-section-label' }, 'Empezar aquí'));
        body.appendChild(buildCard(onboarding, completed.includes(onboarding.id)));
      }
      // Section: Other chapters
      const others = chapters.filter((c) => !c.id.endsWith('-onboarding'));
      if (others.length) {
        body.appendChild(el('div', { className: 'tour-help-section-label' }, 'Funcionalidades'));
        for (const c of others) {
          body.appendChild(buildCard(c, completed.includes(c.id)));
        }
      }
    }

    // Footer: link to re-show welcome
    body.appendChild(el('div', { className: 'tour-help-section-label' }, 'Otros'));
    const welcomeBtn = el('button', {
      className: 'tour-help-card',
      type: 'button',
      onClick: () => {
        close();
        setTimeout(() => {
          if (window.MarzamTour && typeof window.MarzamTour.showWelcome === 'function') {
            window.MarzamTour.showWelcome();
          }
        }, 220);
      },
    });
    welcomeBtn.appendChild(el('div', {
      className: 'tour-help-card-icon',
      html: '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    }));
    const welcomeText = el('div', { className: 'tour-help-card-text' });
    welcomeText.appendChild(el('h3', null, 'Ver introducción otra vez'));
    welcomeText.appendChild(el('p', null, 'Vuelve a ver el saludo inicial.'));
    welcomeBtn.appendChild(welcomeText);
    body.appendChild(welcomeBtn);

    drawer.appendChild(body);
    return drawer;
  }

  function labelForRole(role) {
    const map = {
      director_sucursal: 'Director',
      gerente_ventas: 'Gerente',
      supervisor: 'Supervisor',
      representante: 'Representante',
    };
    return map[role] || 'Tu rol';
  }

  // ── API ───────────────────────────────────────────────────────
  function open(opts) {
    opts = opts || {};
    if (opts.celebrate) State.celebrateTourId = opts.celebrate;
    if (State.isOpen) {
      // Re-render so completed flags update
      if (State.drawerEl && State.drawerEl.parentNode) {
        State.drawerEl.parentNode.removeChild(State.drawerEl);
      }
      State.drawerEl = buildDrawer();
      document.body.appendChild(State.drawerEl);
      requestAnimationFrame(() => State.drawerEl.classList.add('is-visible'));
      return;
    }
    State.isOpen = true;

    State.backdropEl = el('div', {
      className: 'tour-help-backdrop',
      onClick: () => close(),
    });
    document.body.appendChild(State.backdropEl);

    State.drawerEl = buildDrawer();
    document.body.appendChild(State.drawerEl);

    requestAnimationFrame(() => {
      if (State.backdropEl) State.backdropEl.classList.add('is-visible');
      if (State.drawerEl) State.drawerEl.classList.add('is-visible');
    });

    // Focus close button so Esc + Tab work natively
    setTimeout(() => {
      const closeBtn = State.drawerEl && State.drawerEl.querySelector('.tour-help-close');
      if (closeBtn) try { closeBtn.focus(); } catch (e) { /* ignore */ }
    }, 200);

    State.keyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('keydown', State.keyHandler);
  }

  function close() {
    if (!State.isOpen) return;
    State.isOpen = false;
    if (State.drawerEl) State.drawerEl.classList.remove('is-visible');
    if (State.backdropEl) State.backdropEl.classList.remove('is-visible');
    if (State.keyHandler) {
      document.removeEventListener('keydown', State.keyHandler);
      State.keyHandler = null;
    }
    setTimeout(() => {
      if (State.drawerEl && State.drawerEl.parentNode) {
        State.drawerEl.parentNode.removeChild(State.drawerEl);
        State.drawerEl = null;
      }
      if (State.backdropEl && State.backdropEl.parentNode) {
        State.backdropEl.parentNode.removeChild(State.backdropEl);
        State.backdropEl = null;
      }
    }, 320);
  }

  function toggle() {
    if (State.isOpen) close();
    else open();
  }

  window.TourHelp = {
    open,
    close,
    toggle,
    isOpen() { return State.isOpen; },
  };
})();
