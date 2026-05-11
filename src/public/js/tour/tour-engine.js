/* =============================================================
   Marzam guided-tour engine.

   Vanilla JS, no bundler. Exposes:
     window.MarzamTour = { boot, start, stop, resume, getState, isActive, waitForTarget }

   Persistence: hybrid localStorage + backend.
     - localStorage key: marzam_tour_state_v1
     - backend: GET/PATCH /api/users/me/preferences (preferences.tutorial)
   On boot, last-write-wins by updated_at.

   The engine knows nothing about the contents of any tour. Tour definitions
   live in tour-content.js as TOUR_REGISTRY[id] entries with steps, role,
   prerequisites, and hierarchy. Demo data injection lives in
   tour-demo-injector.js and is opt-in per tour.
   ============================================================= */
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────
  const STORAGE_KEY = 'marzam_tour_state_v1';
  const PERSIST_DEBOUNCE_MS = 1500;
  const DEFAULT_TARGET_TIMEOUT_MS = 5000;
  const SPOTLIGHT_PADDING = 8;
  const CALLOUT_GAP = 16; // distance from target to callout edge
  const CALLOUT_MAX_WIDTH = 380;

  // ── State ────────────────────────────────────────────────────
  const State = {
    user: null,
    role: null,
    isDemo: false,
    booted: false,
    persisted: {
      seen: false,
      seenAt: null,
      dismissedForever: false,
      completedTours: [],
      lastTourId: null,
      lastStepIdx: 0,
    },
    backendUpdatedAt: null,
    persistTimer: null,
    pendingPersist: false,

    // Active tour runtime
    activeTour: null,        // current TOUR_REGISTRY entry
    activeStepIdx: 0,
    activeStep: null,
    targetEl: null,
    overlayEl: null,
    ringEl: null,
    calloutEl: null,
    srLiveEl: null,
    focusedBefore: null,
    keyHandler: null,
    resizeHandler: null,
    interactiveCleanup: null,
    repositionRaf: 0,
  };

  // ── Storage helpers ──────────────────────────────────────────
  function loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) { /* ignore */ }
    return null;
  }

  function saveToLocalStorage(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* ignore quota */ }
  }

  async function loadFromBackend() {
    try {
      const res = await fetch('/api/users/me/preferences', {
        headers: {
          'Authorization': 'Bearer ' + (localStorage.getItem('token') || ''),
          'Accept': 'application/json',
        },
      });
      if (!res.ok) return null;
      const body = await res.json();
      return body || null;
    } catch (e) {
      return null;
    }
  }

  function saveToBackend(tutorialPatch) {
    try {
      return fetch('/api/users/me/preferences', {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + (localStorage.getItem('token') || ''),
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ tutorial: tutorialPatch }),
      });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function schedulePersist() {
    State.pendingPersist = true;
    if (State.persistTimer) clearTimeout(State.persistTimer);
    State.persistTimer = setTimeout(() => {
      State.pendingPersist = false;
      State.persisted.seenAt = State.persisted.seenAt || new Date().toISOString();
      saveToLocalStorage(State.persisted);
      // Backend sync — fire and forget. demoReadonly will mock-respond for
      // demo users, which is fine: localStorage is the source of truth.
      saveToBackend(State.persisted);
    }, PERSIST_DEBOUNCE_MS);
  }

  function persistNow() {
    if (State.persistTimer) {
      clearTimeout(State.persistTimer);
      State.persistTimer = null;
    }
    State.persisted.seenAt = State.persisted.seenAt || new Date().toISOString();
    saveToLocalStorage(State.persisted);
    return saveToBackend(State.persisted);
  }

  // ── DOM helpers ──────────────────────────────────────────────
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

  function isVisible(node) {
    if (!node || !node.getBoundingClientRect) return false;
    const r = node.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(node);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    return true;
  }

  function waitForTarget(selector, timeoutMs) {
    timeoutMs = typeof timeoutMs === 'number' ? timeoutMs : DEFAULT_TARGET_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const initial = document.querySelector(selector);
      if (initial && isVisible(initial)) return resolve(initial);
      let done = false;
      const obs = new MutationObserver(() => {
        if (done) return;
        const node = document.querySelector(selector);
        if (node && isVisible(node)) {
          done = true;
          obs.disconnect();
          clearTimeout(timer);
          resolve(node);
        }
      });
      obs.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden'],
      });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        obs.disconnect();
        reject(new Error('tour:target-timeout:' + selector));
      }, timeoutMs);
    });
  }

  // ── Spotlight + callout positioning ──────────────────────────
  function setOverlayCutout(rect) {
    if (!State.overlayEl) return;
    if (!rect) {
      State.overlayEl.style.clipPath = '';
      return;
    }
    const pad = SPOTLIGHT_PADDING;
    const top = Math.max(0, rect.top - pad);
    const left = Math.max(0, rect.left - pad);
    const right = Math.max(0, window.innerWidth - rect.right - pad);
    const bottom = Math.max(0, window.innerHeight - rect.bottom - pad);
    // inset(top right bottom left round 12px) — cutout is the inverse of inset.
    // We use a polygon to "punch a hole" in the overlay because clip-path:inset
    // alone clips OUT the overlay; we want to KEEP the overlay everywhere
    // except the target. Trick: use evenodd fill rule via SVG mask not
    // supported on clip-path uniformly, so we layer two polygons that
    // together draw the donut.
    const w = window.innerWidth;
    const h = window.innerHeight;
    const t = rect.top - pad;
    const l = rect.left - pad;
    const r = rect.right + pad;
    const b = rect.bottom + pad;
    // Outer rect path going clockwise + inner rect path going counterclockwise,
    // joined by a thin connector. This produces a hole.
    State.overlayEl.style.clipPath = 'polygon('
      + '0 0, '
      + w + 'px 0, '
      + w + 'px ' + h + 'px, '
      + '0 ' + h + 'px, '
      + '0 ' + t + 'px, '
      + l + 'px ' + t + 'px, '
      + l + 'px ' + b + 'px, '
      + r + 'px ' + b + 'px, '
      + r + 'px ' + t + 'px, '
      + '0 ' + t + 'px'
      + ')';

    // Update ring
    if (State.ringEl) {
      State.ringEl.style.top = (rect.top - 4) + 'px';
      State.ringEl.style.left = (rect.left - 4) + 'px';
      State.ringEl.style.width = (rect.width + 8) + 'px';
      State.ringEl.style.height = (rect.height + 8) + 'px';
      State.ringEl.style.display = 'block';
    }
  }

  function clearOverlayCutout() {
    if (State.overlayEl) State.overlayEl.style.clipPath = '';
    if (State.ringEl) State.ringEl.style.display = 'none';
  }

  function placementForViewport(step) {
    const isMobile = window.innerWidth < 768;
    if (isMobile && step.placementMobile) return step.placementMobile;
    return step.placement || 'auto';
  }

  function tryPlace(targetRect, calloutSize, placement) {
    const margin = CALLOUT_GAP;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top; let left;
    if (placement === 'top') {
      top = targetRect.top - calloutSize.height - margin;
      left = targetRect.left + (targetRect.width / 2) - (calloutSize.width / 2);
    } else if (placement === 'bottom') {
      top = targetRect.bottom + margin;
      left = targetRect.left + (targetRect.width / 2) - (calloutSize.width / 2);
    } else if (placement === 'left') {
      top = targetRect.top + (targetRect.height / 2) - (calloutSize.height / 2);
      left = targetRect.left - calloutSize.width - margin;
    } else if (placement === 'right') {
      top = targetRect.top + (targetRect.height / 2) - (calloutSize.height / 2);
      left = targetRect.right + margin;
    } else {
      return null;
    }
    // Clamp into viewport with 8px gutter
    const minPad = 8;
    if (top < minPad || left < minPad
        || top + calloutSize.height > vh - minPad
        || left + calloutSize.width > vw - minPad) {
      // Clamp first; if it still overlaps the target meaningfully, return null
      const clampedTop = Math.max(minPad, Math.min(top, vh - calloutSize.height - minPad));
      const clampedLeft = Math.max(minPad, Math.min(left, vw - calloutSize.width - minPad));
      // Reject if clamp moved the callout INTO the target rect
      const overlapsTarget = !(
        clampedLeft + calloutSize.width < targetRect.left
        || clampedLeft > targetRect.right
        || clampedTop + calloutSize.height < targetRect.top
        || clampedTop > targetRect.bottom
      );
      if (overlapsTarget) return null;
      return { top: clampedTop, left: clampedLeft, placement };
    }
    return { top, left, placement };
  }

  function autoPosition(targetRect) {
    if (!State.calloutEl) return;
    // Mobile: pin to bottom by default, callout no longer needs autoplacement.
    const isMobile = window.innerWidth < 768;
    const requested = placementForViewport(State.activeStep);

    // Special placement: 'center' = modal style
    if (requested === 'center') {
      State.calloutEl.dataset.placement = 'center';
      State.calloutEl.style.top = '';
      State.calloutEl.style.left = '';
      return;
    }

    // Force mobile pin if requested
    if (isMobile && (requested === 'mobile-pinned' || (!targetRect))) {
      State.calloutEl.dataset.placement = 'top';
      State.calloutEl.dataset.mobilePinned = 'true';
      return;
    }
    State.calloutEl.dataset.mobilePinned = 'false';

    if (!targetRect) {
      // No target rect available — fall back to centered modal
      State.calloutEl.dataset.placement = 'center';
      State.calloutEl.style.top = '';
      State.calloutEl.style.left = '';
      return;
    }

    // Get callout natural size by reading current bbox after layout
    State.calloutEl.style.top = '0px';
    State.calloutEl.style.left = '0px';
    State.calloutEl.dataset.placement = requested === 'auto' ? 'top' : requested;
    State.calloutEl.style.maxWidth = CALLOUT_MAX_WIDTH + 'px';
    const cb = State.calloutEl.getBoundingClientRect();
    const calloutSize = {
      width: Math.min(cb.width || CALLOUT_MAX_WIDTH, CALLOUT_MAX_WIDTH),
      height: cb.height || 200,
    };

    const order = requested === 'auto'
      ? ['top', 'bottom', 'right', 'left']
      : [requested, 'top', 'bottom', 'right', 'left'];
    let chosen = null;
    for (const p of order) {
      const r = tryPlace(targetRect, calloutSize, p);
      if (r) { chosen = r; break; }
    }
    if (!chosen) {
      // Last resort — pin to bottom
      State.calloutEl.dataset.placement = 'top';
      if (isMobile) State.calloutEl.dataset.mobilePinned = 'true';
      State.calloutEl.style.top = '';
      State.calloutEl.style.left = '';
      return;
    }
    State.calloutEl.dataset.placement = chosen.placement;
    State.calloutEl.style.top = chosen.top + 'px';
    State.calloutEl.style.left = chosen.left + 'px';
  }

  function recomputeSpotlight() {
    if (!State.activeStep) return;
    if (State.repositionRaf) cancelAnimationFrame(State.repositionRaf);
    State.repositionRaf = requestAnimationFrame(() => {
      State.repositionRaf = 0;
      if (State.targetEl && isVisible(State.targetEl)) {
        const rect = State.targetEl.getBoundingClientRect();
        setOverlayCutout(rect);
        autoPosition(rect);
      } else {
        clearOverlayCutout();
        autoPosition(null);
      }
    });
  }

  // ── Focus management ─────────────────────────────────────────
  function trapFocus(container) {
    const handler = (e) => {
      if (e.key !== 'Tab') return;
      const focusable = container.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    container.addEventListener('keydown', handler);
    return () => container.removeEventListener('keydown', handler);
  }

  // ── Build engine UI ──────────────────────────────────────────
  function getRoot() {
    let root = document.getElementById('tour-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'tour-root';
      document.body.appendChild(root);
    }
    return root;
  }

  function mount() {
    const root = getRoot();
    root.classList.remove('hidden');
    root.innerHTML = '';

    State.overlayEl = el('div', {
      className: 'tour-overlay',
      'aria-hidden': 'true',
    });
    State.ringEl = el('div', { className: 'tour-spotlight-ring', style: { display: 'none' } });
    State.srLiveEl = el('div', {
      className: 'tour-sr-only',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    });

    root.appendChild(State.overlayEl);
    root.appendChild(State.ringEl);
    root.appendChild(State.srLiveEl);

    // Block clicks on the dim area from reaching the underlying app, but only
    // for spotlight steps. For modal steps the entire viewport is "tour space".
    State.overlayEl.addEventListener('click', () => {
      // Soft dismiss — confirm if mid-tour
      if (State.activeStep && State.activeStep.kind === 'interactive') return;
      requestExit();
    });
  }

  function unmount() {
    const root = getRoot();
    root.innerHTML = '';
    root.classList.add('hidden');
    State.overlayEl = null;
    State.ringEl = null;
    State.calloutEl = null;
    State.srLiveEl = null;
    if (State.keyHandler) {
      document.removeEventListener('keydown', State.keyHandler);
      State.keyHandler = null;
    }
    if (State.resizeHandler) {
      window.removeEventListener('resize', State.resizeHandler);
      window.removeEventListener('scroll', State.resizeHandler, true);
      State.resizeHandler = null;
    }
    if (State.interactiveCleanup) {
      try { State.interactiveCleanup(); } catch (e) { /* ignore */ }
      State.interactiveCleanup = null;
    }
    if (State.focusedBefore && typeof State.focusedBefore.focus === 'function') {
      try { State.focusedBefore.focus(); } catch (e) { /* ignore */ }
    }
    State.focusedBefore = null;
    State.targetEl = null;
  }

  // ── Step rendering ───────────────────────────────────────────
  function buildHierarchyDiagram(tour) {
    const h = tour.hierarchy || {};
    const selfLabel = (window.MarzamApp && window.MarzamApp.ROLE_LABEL)
      ? window.MarzamApp.ROLE_LABEL[tour.role] || tour.role
      : tour.role;

    const wrap = el('div', { className: 'tour-hierarchy' });

    if (h.canBeAssignedBy && h.canBeAssignedBy.length) {
      for (const r of h.canBeAssignedBy) {
        wrap.appendChild(el('div', { className: 'tour-hierarchy-row' }, [
          el('span', { className: 'tour-hierarchy-pill' }, r),
          el('span', null, ' te asigna trabajo'),
        ]));
      }
      wrap.appendChild(el('div', { className: 'tour-hierarchy-direction' }, '↓'));
    }

    wrap.appendChild(el('div', { className: 'tour-hierarchy-row is-self' }, [
      el('span', { className: 'tour-hierarchy-pill' }, 'Tú'),
      el('span', null, ' (' + selfLabel + ')'),
    ]));

    if (h.canAssignTo && h.canAssignTo.length) {
      wrap.appendChild(el('div', { className: 'tour-hierarchy-direction' }, '↓'));
      for (const r of h.canAssignTo) {
        wrap.appendChild(el('div', { className: 'tour-hierarchy-row' }, [
          el('span', { className: 'tour-hierarchy-pill' }, r),
          el('span', null, ' recibe trabajo de ti'),
        ]));
      }
    }

    return wrap;
  }

  function renderCallout(step) {
    const totalSteps = State.activeTour.steps.length;
    const stepNum = State.activeStepIdx + 1;
    const isFirst = State.activeStepIdx === 0;
    const isLast = State.activeStepIdx === totalSteps - 1;

    const callout = el('div', {
      className: 'tour-callout',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tour-step-title',
      'aria-describedby': 'tour-step-body',
    });
    const arrow = el('div', { className: 'tour-callout-arrow' });
    callout.appendChild(arrow);

    const header = el('div', { className: 'tour-callout-header' });
    header.appendChild(el('span', { className: 'tour-callout-step-pill' },
      'Paso ' + stepNum + ' de ' + totalSteps));
    header.appendChild(el('h3', {
      className: 'tour-callout-title',
      id: 'tour-step-title',
    }, step.title || State.activeTour.title));
    const closeBtn = el('button', {
      className: 'tour-callout-close',
      'aria-label': 'Cerrar tutorial',
      type: 'button',
      onClick: () => requestExit(),
      html: '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6"/></svg>',
    });
    header.appendChild(closeBtn);
    callout.appendChild(header);

    const body = el('div', {
      className: 'tour-callout-body',
      id: 'tour-step-body',
    });
    if (step.bodyComponent === 'hierarchyDiagram') {
      if (step.body) body.appendChild(el('p', null, step.body));
      body.appendChild(buildHierarchyDiagram(State.activeTour));
    } else if (step.bodyHtml) {
      body.innerHTML = step.bodyHtml;
    } else {
      const bodyText = step.body || '';
      // Split paragraphs by \n\n, allow simple <strong> via convention not
      // raw HTML for safety.
      bodyText.split('\n\n').forEach((para) => {
        if (!para.trim()) return;
        body.appendChild(el('p', null, para));
      });
    }
    callout.appendChild(body);

    const footer = el('div', { className: 'tour-callout-footer' });

    // Skip / dismiss
    const skipBtn = el('button', {
      className: 'tour-btn tour-btn-ghost',
      type: 'button',
      onClick: () => requestExit(),
    }, 'Salir');
    footer.appendChild(skipBtn);

    footer.appendChild(el('span', { className: 'spacer' }));

    if (!isFirst) {
      const backBtn = el('button', {
        className: 'tour-btn tour-btn-secondary',
        type: 'button',
        onClick: () => goPrev(),
      }, 'Atrás');
      footer.appendChild(backBtn);
    }

    const nextLabel = (step.next && step.next.label)
      ? step.next.label
      : (isLast ? 'Terminar' : 'Siguiente');
    const nextBtn = el('button', {
      className: 'tour-btn tour-btn-primary',
      type: 'button',
      onClick: () => {
        if (isLast) completeTour();
        else goNext();
      },
    }, nextLabel);
    footer.appendChild(nextBtn);
    // Hide "Siguiente" when step is interactive — user must click target.
    if (step.requireClick) {
      nextBtn.style.display = 'none';
    }
    callout.appendChild(footer);

    return { callout, primaryBtn: nextBtn };
  }

  async function renderStep() {
    const step = State.activeTour.steps[State.activeStepIdx];
    State.activeStep = step;

    // Run onEnter hook (e.g. switch tab) BEFORE waiting for target.
    if (typeof step.onEnter === 'function') {
      try { await step.onEnter(); } catch (e) { console.warn('[tour] onEnter failed', e); }
    }

    // Resolve target
    let targetRect = null;
    State.targetEl = null;
    if (step.target && step.kind !== 'modal') {
      try {
        const node = await waitForTarget(step.target, step.waitForTarget || DEFAULT_TARGET_TIMEOUT_MS);
        State.targetEl = node;
        // Scroll into view if needed
        try {
          const r0 = node.getBoundingClientRect();
          const inView = r0.top >= 0 && r0.bottom <= window.innerHeight;
          if (!inView) node.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Give scroll a beat to settle
          await new Promise((res) => setTimeout(res, 320));
        } catch (e) { /* ignore */ }
        targetRect = node.getBoundingClientRect();
      } catch (err) {
        console.warn('[tour] target not found, falling back to modal:', step.target);
        document.dispatchEvent(new CustomEvent('tour:target-missing', {
          detail: { tourId: State.activeTour.id, stepId: step.id, selector: step.target },
        }));
        // Fall through with no target — render as modal-style centered
      }
    }

    // Tear down previous callout
    if (State.calloutEl && State.calloutEl.parentNode) {
      State.calloutEl.parentNode.removeChild(State.calloutEl);
      State.calloutEl = null;
    }
    if (State.interactiveCleanup) {
      try { State.interactiveCleanup(); } catch (e) { /* ignore */ }
      State.interactiveCleanup = null;
    }

    // Build callout
    const { callout, primaryBtn } = renderCallout(step);
    State.calloutEl = callout;
    getRoot().appendChild(callout);

    // Spotlight
    if (targetRect) {
      setOverlayCutout(targetRect);
    } else {
      clearOverlayCutout();
    }
    autoPosition(targetRect);

    // Animate in
    requestAnimationFrame(() => {
      callout.classList.add('is-visible');
    });

    // Aria announce
    if (State.srLiveEl) {
      State.srLiveEl.textContent = 'Paso ' + (State.activeStepIdx + 1) + ' de '
        + State.activeTour.steps.length + ': ' + (step.title || State.activeTour.title);
    }

    // Focus
    try { primaryBtn.focus(); } catch (e) { /* ignore */ }

    // Interactive step: install one-shot click on target
    if (step.requireClick && State.targetEl) {
      const onClick = () => {
        // Cleanup happens in goNext/teardown
        goNext();
      };
      State.targetEl.addEventListener('click', onClick, { once: true });
      State.interactiveCleanup = () => {
        State.targetEl.removeEventListener('click', onClick);
      };
      // Make sure clicks on the target actually reach it (overlay clip-path
      // already does this physically — but ensure no other tour element blocks).
    }

    // Persist progress as we move forward
    State.persisted.lastTourId = State.activeTour.id;
    State.persisted.lastStepIdx = State.activeStepIdx;
    schedulePersist();

    // Custom event for telemetry
    document.dispatchEvent(new CustomEvent('tour:step:enter', {
      detail: {
        tourId: State.activeTour.id,
        stepId: step.id,
        idx: State.activeStepIdx,
        total: State.activeTour.steps.length,
      },
    }));
  }

  // ── Transitions ──────────────────────────────────────────────
  function goNext() {
    if (!State.activeTour) return;
    if (State.activeStepIdx >= State.activeTour.steps.length - 1) {
      completeTour();
      return;
    }
    State.activeStepIdx += 1;
    renderStep();
  }

  function goPrev() {
    if (!State.activeTour) return;
    if (State.activeStepIdx <= 0) return;
    State.activeStepIdx -= 1;
    renderStep();
  }

  function completeTour() {
    const tourId = State.activeTour ? State.activeTour.id : null;
    if (tourId && !State.persisted.completedTours.includes(tourId)) {
      State.persisted.completedTours.push(tourId);
    }
    State.persisted.lastTourId = null;
    State.persisted.lastStepIdx = 0;
    State.persisted.seen = true;
    document.dispatchEvent(new CustomEvent('tour:complete', { detail: { tourId } }));
    persistNow();
    teardownActive();
    // Offer next steps via help center
    if (window.TourHelp && typeof window.TourHelp.open === 'function') {
      setTimeout(() => window.TourHelp.open({ celebrate: tourId }), 280);
    }
  }

  function requestExit() {
    if (!State.activeTour) return;
    // Confirm on non-trivial progress
    if (State.activeStepIdx > 0) {
      const ok = window.confirm('¿Salir del tutorial?\n\nPuedes volver desde el botón ? en la barra superior cuando quieras.');
      if (!ok) return;
    }
    document.dispatchEvent(new CustomEvent('tour:dismissed', {
      detail: { tourId: State.activeTour.id, stepIdx: State.activeStepIdx },
    }));
    persistNow();
    teardownActive();
  }

  function teardownActive() {
    if (window.TourDemoInjector && typeof window.TourDemoInjector.deactivate === 'function') {
      try { window.TourDemoInjector.deactivate(); } catch (e) { /* ignore */ }
    }
    State.activeTour = null;
    State.activeStep = null;
    State.activeStepIdx = 0;
    unmount();
  }

  // ── Public start ─────────────────────────────────────────────
  async function start(tourId, opts) {
    opts = opts || {};
    const reg = window.TOUR_REGISTRY || {};
    const tour = reg[tourId];
    if (!tour) {
      console.warn('[tour] unknown tour id:', tourId);
      return;
    }
    if (tour.role && State.role && tour.role !== State.role && !opts.force) {
      console.warn('[tour] tour role mismatch:', tour.role, 'vs user role', State.role);
      return;
    }
    // Demo data injection
    if (window.TourDemoInjector && typeof window.TourDemoInjector.activate === 'function'
        && tour.prerequisites && tour.prerequisites.fallbackToDemo) {
      try {
        await window.TourDemoInjector.activate({ role: State.role, tour });
      } catch (e) { console.warn('[tour] demo injector failed', e); }
    }

    State.activeTour = tour;
    State.activeStepIdx = (typeof opts.startAt === 'number')
      ? Math.max(0, Math.min(opts.startAt, tour.steps.length - 1))
      : 0;

    // Mount overlay
    State.focusedBefore = document.activeElement;
    mount();

    // Global key handler
    State.keyHandler = (e) => {
      if (!State.activeStep) return;
      if (e.key === 'Escape') {
        if (State.activeStep.kind === 'interactive') return;
        e.preventDefault();
        requestExit();
      } else if (e.key === 'ArrowRight') {
        if (!State.activeStep.requireClick) {
          e.preventDefault();
          goNext();
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      }
    };
    document.addEventListener('keydown', State.keyHandler);

    // Reposition on resize / scroll
    State.resizeHandler = () => recomputeSpotlight();
    window.addEventListener('resize', State.resizeHandler);
    window.addEventListener('scroll', State.resizeHandler, true);

    await renderStep();
  }

  function stop(opts) {
    opts = opts || {};
    if (opts.silent) {
      teardownActive();
      return;
    }
    requestExit();
  }

  // ── Welcome modal ────────────────────────────────────────────
  function buildWelcomeModal() {
    const role = State.role;
    const tourId = role + '-onboarding';
    const tour = (window.TOUR_REGISTRY || {})[tourId];
    const hasResume = State.persisted.lastTourId
      && !State.persisted.completedTours.includes(State.persisted.lastTourId)
      && (window.TOUR_REGISTRY || {})[State.persisted.lastTourId];

    // Ensure overlay base mounted (we use the same root for the welcome modal)
    mount();
    State.activeTour = null;
    State.activeStep = { kind: 'modal' };

    const callout = el('div', {
      className: 'tour-callout',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tour-welcome-title',
      'aria-describedby': 'tour-welcome-body',
    });
    callout.dataset.placement = 'center';

    const header = el('div', { className: 'tour-callout-header' });
    header.appendChild(el('span', { className: 'tour-callout-step-pill' }, 'Bienvenida'));
    header.appendChild(el('h3', {
      className: 'tour-callout-title',
      id: 'tour-welcome-title',
    }, '¡Hola, ' + (firstNameOf(State.user) || 'qué tal') + '!'));
    const closeBtn = el('button', {
      className: 'tour-callout-close',
      'aria-label': 'Cerrar',
      type: 'button',
      onClick: () => dismissWelcomeOnce(),
      html: '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6"/></svg>',
    });
    header.appendChild(closeBtn);
    callout.appendChild(header);

    const body = el('div', {
      className: 'tour-callout-body',
      id: 'tour-welcome-body',
    });
    const illu = el('div', {
      className: 'tour-welcome-illustration',
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 20l-5-3V4l5 3 5-3 5 3v13l-5-3-5 3z"/><circle cx="12" cy="11" r="2"/></svg>',
    });
    body.appendChild(illu);
    const intro = (tour && tour.summary)
      ? tour.summary
      : 'Te muestro en menos de 2 minutos cómo aprovechar la plataforma.';
    body.appendChild(el('p', null, intro));
    body.appendChild(el('p', null,
      'Puedes saltar el tutorial y volver cuando quieras desde el botón ? en la barra superior.'));
    callout.appendChild(body);

    const footer = el('div', { className: 'tour-callout-footer' });

    if (hasResume) {
      const resumeBtn = el('button', {
        className: 'tour-btn tour-btn-secondary',
        type: 'button',
        onClick: () => {
          teardownWelcome(callout);
          start(State.persisted.lastTourId, { startAt: State.persisted.lastStepIdx });
        },
      }, 'Continuar donde lo dejé');
      footer.appendChild(resumeBtn);
    }

    const dismissBtn = el('button', {
      className: 'tour-btn tour-btn-ghost',
      type: 'button',
      onClick: () => {
        State.persisted.dismissedForever = true;
        State.persisted.seen = true;
        persistNow();
        teardownWelcome(callout);
      },
    }, 'No mostrar de nuevo');
    footer.appendChild(dismissBtn);

    footer.appendChild(el('span', { className: 'spacer' }));

    const skipBtn = el('button', {
      className: 'tour-btn tour-btn-secondary',
      type: 'button',
      onClick: () => {
        State.persisted.seen = true;
        schedulePersist();
        teardownWelcome(callout);
      },
    }, 'Ahora no');
    footer.appendChild(skipBtn);

    const startBtn = el('button', {
      className: 'tour-btn tour-btn-primary',
      type: 'button',
      onClick: () => {
        teardownWelcome(callout);
        if (tour) start(tourId);
        else if (window.TourHelp) window.TourHelp.open();
      },
    }, hasResume ? 'Empezar de nuevo' : 'Comenzar');
    footer.appendChild(startBtn);

    callout.appendChild(footer);
    getRoot().appendChild(callout);
    requestAnimationFrame(() => callout.classList.add('is-visible'));
    try { startBtn.focus(); } catch (e) { /* ignore */ }

    // ESC closes welcome (counts as "ahora no")
    State.keyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismissWelcomeOnce();
      }
    };
    document.addEventListener('keydown', State.keyHandler);
  }

  function teardownWelcome(callout) {
    if (callout && callout.parentNode) callout.parentNode.removeChild(callout);
    State.activeStep = null;
    if (State.keyHandler) {
      document.removeEventListener('keydown', State.keyHandler);
      State.keyHandler = null;
    }
    if (!State.activeTour) {
      // Nothing else uses the overlay — tear down completely.
      unmount();
    }
  }

  function dismissWelcomeOnce() {
    State.persisted.seen = true;
    schedulePersist();
    const root = getRoot();
    const callout = root.querySelector('.tour-callout');
    teardownWelcome(callout);
  }

  function firstNameOf(user) {
    if (!user) return '';
    const f = (user.full_name || '').trim().split(/\s+/)[0] || '';
    return f;
  }

  // ── Boot ─────────────────────────────────────────────────────
  async function boot(opts) {
    if (State.booted) return;
    State.booted = true;
    State.user = (opts && opts.user) || null;
    State.role = (opts && opts.role) || null;
    State.isDemo = Boolean(opts && opts.isDemo);

    // Hydrate from localStorage immediately
    const local = loadFromLocalStorage();
    if (local && typeof local === 'object') {
      Object.assign(State.persisted, local);
    }

    // Hydrate from backend (last-write-wins by updated_at)
    const backend = await loadFromBackend();
    if (backend && backend.preferences && backend.preferences.tutorial) {
      const beTutorial = backend.preferences.tutorial || {};
      const beUpdated = backend.updated_at ? new Date(backend.updated_at).getTime() : 0;
      const localUpdated = (local && local.seenAt) ? new Date(local.seenAt).getTime() : 0;
      if (beUpdated >= localUpdated) {
        Object.assign(State.persisted, beTutorial);
        saveToLocalStorage(State.persisted);
      }
    }

    State.backendUpdatedAt = backend ? backend.updated_at : null;

    // Decide whether to show welcome
    if (State.persisted.dismissedForever) return;
    if (!State.persisted.seen) {
      // Defer slightly so the rest of the app finishes painting
      setTimeout(() => buildWelcomeModal(), 800);
    }

    // Cleanup on unload
    window.addEventListener('beforeunload', () => {
      if (State.activeTour && window.TourDemoInjector) {
        try { window.TourDemoInjector.deactivate(); } catch (e) { /* ignore */ }
      }
      if (State.pendingPersist) {
        try { persistNow(); } catch (e) { /* ignore */ }
      }
    });
  }

  // ── Public API ───────────────────────────────────────────────
  window.MarzamTour = {
    boot,
    start,
    stop,
    resume() {
      if (State.persisted.lastTourId) {
        start(State.persisted.lastTourId, { startAt: State.persisted.lastStepIdx });
      }
    },
    isActive() { return Boolean(State.activeTour); },
    getState() {
      return {
        role: State.role,
        persisted: Object.assign({}, State.persisted),
        active: State.activeTour ? {
          id: State.activeTour.id,
          stepIdx: State.activeStepIdx,
          stepId: State.activeStep ? State.activeStep.id : null,
        } : null,
      };
    },
    waitForTarget,
    // Used by TourHelp to surface welcome again from the help center if user
    // clicks "ver introducción".
    showWelcome: buildWelcomeModal,
  };
})();
