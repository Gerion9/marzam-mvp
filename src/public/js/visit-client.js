/* =============================================================
   Marzam — Modal de visita unificado
   ============================================================= 

   API:
     window.MarzamVisitClient.open({ pharmacy })

   El modal se ramifica internamente segun el tipo de farmacia:

     - pharmacy.is_marzam === true       → flow CLIENTE MARZAM
                                           (visitada → pedido → razón → productos → review)
     - pharmacy.is_marzam === false      → flow PROSPECTO
       (o source === 'blackprint')        (resultado → notas → datos generales →
                                           comercial → observaciones → contacto →
                                           review)

   Reutiliza el CSS del onboarding-wizard (onb-*).

   Diseño del flow PROSPECT:
     1) RESULTADO  — dropdown obligatorio.  Si el outcome es "negativo"
                     (cerrado / inválido / duplicado / se_mudó / cadena /
                     categoría_incorrecta) saltamos directo a review — no
                     tiene sentido pedir más datos sobre una farmacia que
                     no existe / no aplica.
     2) NOTAS      — textarea obligatorio.
     3) DATOS GENERALES
                   — nombre, correo, persona física / moral.
     4) COMERCIAL  — potencial de compra ($) + mayoristas con los que
                     trabaja.
     5) OBSERVACIONES DE VISITA
                   — generales, información de competencia, precios,
                     ofertas/promociones.
     6) CONTACTO   — persona de contacto + teléfono.
     7) REVIEW     — resumen + Registrar visita.
   ============================================================= */
(function () {
  'use strict';

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  }

  // ──────────────────────────────────────────────────────────
  // Constantes — outcomes de visita y razones de no-pedido.
  // ──────────────────────────────────────────────────────────

  const VISIT_OUTCOMES = [
    { code: 'visited',                  label: 'Visitado',                 positive: true  },
    { code: 'contact_made',             label: 'Contacto realizado',       positive: true  },
    { code: 'interested',               label: 'Interesado',               positive: true  },
    { code: 'not_interested',           label: 'No interesado',            positive: false },
    { code: 'needs_follow_up',          label: 'Requiere seguimiento',     positive: true  },
    { code: 'closed',                   label: 'Cerrado',                  positive: false },
    { code: 'invalid',                  label: 'Inválido',                 positive: false },
    { code: 'duplicate',                label: 'Duplicado',                positive: false },
    { code: 'moved',                    label: 'Se mudó',                  positive: false },
    { code: 'wrong_category',           label: 'Categoría incorrecta',     positive: false },
    { code: 'chain_not_independent',    label: 'Cadena / No independiente', positive: false },
  ];
  const POSITIVE_OUTCOMES = new Set(VISIT_OUTCOMES.filter((o) => o.positive).map((o) => o.code));

  const NO_ORDER_REASONS = [
    { code: 'sin_inventario_marzam', label: 'Sin inventario en Marzam' },
    { code: 'precio_alto',           label: 'Precio alto vs competencia' },
    { code: 'no_decision_maker',     label: 'No estaba quien decide' },
    { code: 'cliente_no_estaba',     label: 'Cliente no estaba' },
    { code: 'cerrado',               label: 'Cerrado al momento de visitar' },
    { code: 'sin_interes',           label: 'No mostró interés' },
    { code: 'otra',                  label: 'Otra (especificar en notas)' },
  ];

  // Documentos legales que el rep debe capturar al levantar una farmacia
  // nueva (prospecto que dio outcome positivo).  Espejo de DOCS_FISICA /
  // DOCS_MORAL en src/modules/pharmacy-onboarding/onboarding.spec.js —
  // si cambias uno, cambia el otro.
  const DOCS_FISICA = [
    { type: 'constancia_fiscal',     label: 'Constancia de Situación Fiscal' },
    { type: 'comprobante_domicilio', label: 'Comprobante de Domicilio' },
    { type: 'ine',                   label: 'INE' },
  ];
  const DOCS_MORAL = [
    ...DOCS_FISICA,
    { type: 'acta_constitutiva',     label: 'Acta Constitutiva' },
    { type: 'poder_legal',           label: 'Poder del Representante Legal' },
  ];

  function legalDocsFor(personaTipo) {
    return personaTipo === 'moral' ? DOCS_MORAL : DOCS_FISICA;
  }

  function geolocate() {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
      );
    });
  }

  /**
   * Heurística defensiva: una farmacia es Marzam si la marca está
   * explícita en `is_marzam`, o si el `source` viene de la BD como
   * 'marzam'.  Cualquier otro caso se trata como prospecto (incluyendo
   * cuando la propiedad no está definida — modo seguro).
   */
  function isMarzamPharmacy(pharmacy) {
    if (!pharmacy) return false;
    if (typeof pharmacy.is_marzam === 'boolean') return pharmacy.is_marzam;
    if (pharmacy.source) return pharmacy.source === 'marzam';
    // Fallback: si trae pareto A/B/C es porque está en padrón.
    return ['A', 'B', 'C'].includes(pharmacy.pareto);
  }

  // ──────────────────────────────────────────────────────────
  // Entry point
  // ──────────────────────────────────────────────────────────

  function open({ pharmacy } = {}) {
    if (!pharmacy?.id) {
      window.MarzamToast?.show('Falta la farmacia para registrar la visita', 'error');
      return;
    }
    if (isMarzamPharmacy(pharmacy)) {
      return openMarzamFlow(pharmacy);
    }
    // Para farmacias NO Marzam (prospectos / "Nuevas"), abrimos el wizard
    // completo de alta — RFC, persona física/moral, forma de pago efectivo
    // /crédito, razón social vs nombre comercial, dirección, fachada (1
    // foto si está en padrón, 3 si no), docs legales (3 ó 5 según persona),
    // productos.  El wizard también crea la visita al final para que la
    // parada se marque como completada en el plan diario.
    //
    // Fallback: si el rol no puede usar el wizard (director_sucursal /
    // gerente_ventas) o el script no está cargado, caemos al openProspectFlow
    // corto — al menos queda registrada la visita.
    if (window.MarzamOnboarding?.openWizard && window.MarzamOnboarding.canUseWizard?.()) {
      return window.MarzamOnboarding.openWizard({ pharmacy });
    }
    return openProspectFlow(pharmacy);
  }

  // ==========================================================
  // FLOW 1 — Cliente Marzam (mantiene comportamiento existente)
  // ==========================================================

  function openMarzamFlow(pharmacy) {
    const state = {
      step: 0,
      visited: null,
      order_placed: null,
      no_order_reason: null,
      order_amount: '',
      products: [],
      notes: '',
      // Foto de evidencia.  Obligatoria SIEMPRE que se haya visitado
      // (haya o no pedido) — es la prueba para Marzam de que el rep
      // estuvo físicamente en la farmacia.  Cuando NO visitó, no
      // tiene sentido pedirla.
      evidence_photo: null,
      lat: null, lng: null,
    };
    geolocate().then((g) => { if (g) Object.assign(state, g); });

    const root = mountShell({
      title: 'Visita a cliente Marzam',
      subtitle: pharmacy.name || 'Farmacia cliente',
    });
    const { body, progress, btnBack, btnNext, close } = root;

    function steps() {
      const arr = ['intro'];
      if (state.visited) {
        arr.push('order');
        if (state.order_placed === false) arr.push('reason');
        arr.push('products');
        arr.push('evidence');     // ← foto in situ obligatoria si visitó
      } else if (state.visited === false) {
        arr.push('reason_no_visit');
      }
      arr.push('review');
      return arr;
    }

    function refresh() {
      const list = steps();
      if (state.step >= list.length) state.step = list.length - 1;
      const cur = list[state.step];
      progress.innerHTML = list.map((_, i) =>
        `<span class="${i < state.step ? 'done' : (i === state.step ? 'active' : '')}"></span>`).join('');
      body.innerHTML = '';
      body.appendChild(viewFor(cur));
      btnBack.disabled = state.step === 0;
      btnNext.textContent = cur === 'review' ? 'Registrar visita' : 'Siguiente';
      btnNext.disabled = !canAdvance(cur);
    }

    function canAdvance(cur) {
      switch (cur) {
        case 'intro':           return state.visited !== null;
        case 'order':           return state.order_placed !== null;
        case 'reason':          return !!state.no_order_reason;
        case 'reason_no_visit': return !!state.notes && state.notes.trim().length >= 3;
        case 'products':        return true;
        case 'evidence':        return !!state.evidence_photo;
        case 'review':          return true;
        default: return true;
      }
    }

    function viewFor(cur) {
      switch (cur) {
        case 'intro':           return renderMarzamIntro(state, refresh);
        case 'order':           return renderMarzamOrder(state, refresh);
        case 'reason':          return renderMarzamReason(state, refresh);
        case 'reason_no_visit': return renderMarzamReasonNoVisit(state, refresh);
        case 'products':        return renderMarzamProducts(state, refresh, root.shellRoot);
        case 'evidence':        return renderEvidencePhoto(state, refresh, 'evidence_photo', {
          title: '📸 Foto de evidencia *',
          subtitle: 'Toma una foto que demuestre que estuviste en sitio (fachada, anaquel, ticket o pedido capturado).  Marzam la archiva como prueba de la visita.',
        });
        case 'review':          return renderMarzamReview(state);
      }
      return el('<div></div>');
    }

    btnBack.addEventListener('click', () => {
      if (state.step > 0) { state.step -= 1; refresh(); }
    });
    btnNext.addEventListener('click', async () => {
      const list = steps();
      const cur = list[state.step];
      if (!canAdvance(cur)) {
        window.MarzamToast?.show('Falta información en este paso', 'error');
        return;
      }
      if (cur !== 'review') {
        state.step += 1; refresh(); return;
      }
      btnNext.disabled = true;
      btnNext.textContent = 'Registrando...';
      try {
        const visit = await API.post('/visits', {
          pharmacy_id: pharmacy.id,
          outcome: state.visited
            ? (state.order_placed ? 'completed' : 'visited')
            : 'cancelled',
          notes: state.notes || (state.visited ? 'Visita cliente' : 'No visitada'),
          order_placed: !!state.order_placed,
          no_order_reason: state.no_order_reason || null,
          order_amount: state.order_amount || null,
          products: state.products,
          checkin_lat: state.lat,
          checkin_lng: state.lng,
        });
        // Si visitó → sube la foto de evidencia (best-effort: si falla,
        // la visita queda registrada igual y mostramos warning).
        if (state.visited && state.evidence_photo && visit?.id) {
          try { await uploadVisitPhoto(visit.id, state.evidence_photo); }
          catch (e) {
            window.MarzamToast?.show('Visita guardada, pero la foto no subió: ' + (e?.error || e?.message || 'error'), 'warn');
          }
        }
        window.MarzamToast?.show('Visita registrada ✓', 'success');
        close();
      } catch (err) {
        console.error(err);
        window.MarzamToast?.show(err?.error || 'Error al registrar la visita', 'error');
        btnNext.disabled = false;
        btnNext.textContent = 'Registrar visita';
      }
    });

    refresh();
  }

  // ==========================================================
  // FLOW 2 — Prospecto (nuevo)
  // ==========================================================

  function openProspectFlow(pharmacy) {
    const state = {
      step: 0,
      // Step 1
      outcome: '',
      // Step 2
      notes: '',
      // Step 3
      contact_name: '',
      contact_email: '',
      persona_tipo: null,    // 'fisica' | 'moral'
      // Step 4
      order_potential: '',
      wholesalers: '',
      // Step 5
      visit_observations: '',
      competition_info: '',
      competition_prices: '',
      competition_offers: '',
      // Step 6
      contact_person: '',
      contact_phone: '',
      // Step 7 — productos que vende la farmacia HOY (con la competencia).
      // Cada item: { product_name, competitor_brand, competitor_price,
      //              monthly_volume, comment }
      products: [],
      // Step 8 — foto de evidencia in situ (obligatoria si outcome positivo).
      evidence_photo: null,
      // Step 9 — documentos legales para alta.  Map { doc_type: File } —
      // 3 entradas si persona_tipo='fisica', 5 si 'moral'.
      legal_docs: {},
      // GPS
      lat: null, lng: null,
    };
    geolocate().then((g) => { if (g) Object.assign(state, g); });

    const root = mountShell({
      title: 'Registrar visita a prospecto',
      subtitle: pharmacy.name || 'Farmacia (no cliente Marzam)',
    });
    const { body, progress, btnBack, btnNext, close } = root;

    /**
     * Computa la lista dinámica de pasos.  Si el outcome ya se eligió y
     * es un outcome "negativo" (cadena / inválido / etc.) saltamos
     * directo a review; no hace sentido pedir potencial de compra de una
     * farmacia que cerró o resultó ser cadena.
     */
    function steps() {
      if (state.outcome && !POSITIVE_OUTCOMES.has(state.outcome)) {
        // Outcome negativo: pedimos foto MÍNIMA (prueba de visita) y
        // saltamos el resto.  Sin foto Marzam no puede confirmar que el
        // rep estuvo en sitio.
        return ['outcome', 'notes', 'evidence', 'review'];
      }
      return [
        'outcome',
        'notes',
        'datos_generales',
        'comercial',
        'productos',          // productos que la farmacia vende con la competencia
        'observaciones',
        'contacto',
        'evidence',           // foto in situ (obligatoria)
        'docs_legales',       // CSF + comp. domicilio + INE  (+ acta + poder si moral)
        'review',
      ];
    }

    function refresh() {
      const list = steps();
      if (state.step >= list.length) state.step = list.length - 1;
      const cur = list[state.step];
      progress.innerHTML = list.map((_, i) =>
        `<span class="${i < state.step ? 'done' : (i === state.step ? 'active' : '')}"></span>`).join('');
      body.innerHTML = '';
      body.appendChild(viewFor(cur));
      btnBack.disabled = state.step === 0;
      btnNext.textContent = cur === 'review' ? 'Registrar visita' : 'Siguiente';
      btnNext.disabled = !canAdvance(cur);
    }

    function canAdvance(cur) {
      switch (cur) {
        case 'outcome':           return !!state.outcome;
        case 'notes':             return state.notes.trim().length >= 3;
        case 'datos_generales':   return !!state.persona_tipo;
        case 'comercial':         return true;       // todo opcional
        case 'productos':         return true;       // opcional, 0..N
        case 'observaciones':     return true;
        case 'contacto':          return true;
        case 'evidence':          return !!state.evidence_photo;
        case 'docs_legales': {
          // Todos los docs requeridos según persona_tipo deben tener foto.
          const required = legalDocsFor(state.persona_tipo);
          return required.every((d) => !!state.legal_docs[d.type]);
        }
        case 'review':            return true;
        default: return true;
      }
    }

    function viewFor(cur) {
      switch (cur) {
        case 'outcome':           return renderProspectOutcome(state, refresh);
        case 'notes':             return renderProspectNotes(state, refresh);
        case 'datos_generales':   return renderProspectDatosGenerales(state, refresh);
        case 'comercial':         return renderProspectComercial(state, refresh);
        case 'productos':         return renderProspectProductos(state, refresh, root.shellRoot);
        case 'observaciones':     return renderProspectObservaciones(state, refresh);
        case 'contacto':          return renderProspectContacto(state, refresh);
        case 'evidence':          return renderEvidencePhoto(state, refresh, 'evidence_photo', {
          title: '📸 Foto de evidencia *',
          subtitle: POSITIVE_OUTCOMES.has(state.outcome)
            ? 'Toma una foto en sitio (fachada, anaquel o el contacto firmando) para que Marzam pueda confirmar que estuviste en la farmacia.'
            : 'Aunque no hubo proceso, necesitamos una foto del lugar (fachada cerrada, dirección distinta, etc.) para que el supervisor pueda validar.',
        });
        case 'docs_legales':      return renderProspectLegalDocs(state, refresh);
        case 'review':            return renderProspectReview(state);
      }
      return el('<div></div>');
    }

    btnBack.addEventListener('click', () => {
      if (state.step > 0) { state.step -= 1; refresh(); }
    });
    btnNext.addEventListener('click', async () => {
      const list = steps();
      const cur = list[state.step];
      if (!canAdvance(cur)) {
        window.MarzamToast?.show(blockReason(cur), 'error');
        return;
      }
      if (cur !== 'review') {
        state.step += 1; refresh(); return;
      }
      btnNext.disabled = true;
      btnNext.textContent = 'Registrando...';
      try {
        const { onboarding } = await submitProspectFull(pharmacy, state);
        if (onboarding?.id) {
          window.MarzamToast?.show('Visita + alta enviadas ✓ Datamaster fue notificado.', 'success');
        } else {
          window.MarzamToast?.show('Visita registrada ✓', 'success');
        }
        close();
      } catch (err) {
        console.error(err);
        window.MarzamToast?.show(err?.error || 'Error al registrar la visita', 'error');
        btnNext.disabled = false;
        btnNext.textContent = 'Registrar visita';
      }
    });

    refresh();
  }

  function blockReason(cur) {
    switch (cur) {
      case 'outcome':         return 'Selecciona un resultado de visita';
      case 'notes':           return 'Escribe al menos una nota breve (3+ caracteres)';
      case 'datos_generales': return 'Indica si es persona física o moral';
      case 'evidence':        return 'Toma o sube la foto de evidencia';
      case 'docs_legales':    return 'Faltan documentos legales — sube todos los requeridos';
      default:                return 'Falta información en este paso';
    }
  }

  // ──────────────────────────────────────────────────────────
  // Photo capture — usado por el paso "evidence" en ambos flows.
  //
  // En mobile, `<input capture="environment">` abre la cámara
  // directamente.  En desktop abre el file picker normal.  Mostramos
  // thumbnail con FileReader y permitimos retomar la foto.
  // ──────────────────────────────────────────────────────────

  function renderEvidencePhoto(state, refresh, fieldKey, { title, subtitle }) {
    const file = state[fieldKey];
    const w = el(`
      <div>
        <h2 class="onb-step-title">${escapeHtml(title)}</h2>
        <p class="onb-step-sub">${escapeHtml(subtitle)}</p>

        <div class="onb-section" style="display:flex; flex-direction:column; align-items:center; gap:12px;">
          ${file ? `
            <div style="width:100%; max-width:320px; border-radius:14px; overflow:hidden; border:1px solid #e2e8f0; background:#f8fafc;">
              <img id="vp-photo-preview" alt="Evidencia" style="display:block; width:100%; height:auto; max-height:280px; object-fit:contain;">
            </div>
            <div style="font-size:11px; color:#64748b; text-align:center;">
              ${escapeHtml(file.name || 'Foto.jpg')} · ${(file.size / 1024).toFixed(0)} KB
            </div>
          ` : `
            <div style="width:100%; max-width:320px; aspect-ratio:4/3; border-radius:14px; border:2px dashed #cbd5e1; background:#f8fafc; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#94a3b8; font-size:14px;">
              <svg width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2"/><circle cx="12" cy="13" r="4"/><path d="M9 6l1.5-2h3L15 6"/></svg>
              <div style="margin-top:8px;">Aún no hay foto</div>
            </div>
          `}

          <input type="file" id="vp-photo-input" accept="image/*" capture="environment" style="display:none;">
          <button type="button" class="onb-btn onb-btn-next" id="vp-photo-take" style="width:100%; max-width:320px;">
            ${file ? 'Volver a tomar foto' : '📷 Tomar foto'}
          </button>
        </div>
      </div>
    `);

    const input = w.querySelector('#vp-photo-input');
    const btn = w.querySelector('#vp-photo-take');
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      // Limita a 10 MB para no romper el upload (multer también lo limita).
      if (f.size > 10 * 1024 * 1024) {
        window.MarzamToast?.show('La foto excede 10 MB, usa una de menor resolución.', 'error');
        return;
      }
      state[fieldKey] = f;
      refresh();
    });

    // Si ya había foto, mostrar el preview con FileReader.
    if (file) {
      const img = w.querySelector('#vp-photo-preview');
      const reader = new FileReader();
      reader.onload = (ev) => { if (img) img.src = ev.target.result; };
      reader.readAsDataURL(file);
    }
    return w;
  }

  // ──────────────────────────────────────────────────────────
  // Documentos legales (alta de prospecto).  Espejo de la spec del
  // backend: 3 docs si Persona Física, 5 si Persona Moral.
  // ──────────────────────────────────────────────────────────

  function renderProspectLegalDocs(state, refresh) {
    const docs = legalDocsFor(state.persona_tipo);
    const w = el(`
      <div>
        <h2 class="onb-step-title">Documentos legales para alta</h2>
        <p class="onb-step-sub">
          ${state.persona_tipo === 'moral'
            ? 'Persona Moral — necesitamos 5 fotos.  Toma una foto clara de cada documento (puede ser desde galería).'
            : 'Persona Física — necesitamos 3 fotos.  Toma una foto clara de cada documento.'}
        </p>
        <div class="onb-doclist">
          ${docs.map((d) => {
            const f = state.legal_docs[d.type];
            return `
              <div class="onb-doc ${f ? 'uploaded' : ''}">
                <div class="onb-doc-head">
                  <div class="onb-doc-num">${f ? '✓' : '!'}</div>
                  <div class="onb-doc-name">${escapeHtml(d.label)}</div>
                </div>
                ${f ? `
                  <div style="font-size:11px; color:#64748b; padding:4px 0;">
                    ${escapeHtml(f.name || 'Foto.jpg')} · ${(f.size / 1024).toFixed(0)} KB
                  </div>
                ` : ''}
                <input type="file" data-doc-input="${d.type}" accept="image/*" capture="environment" style="display:none;">
                <button type="button" class="onb-btn onb-btn-back" data-doc-take="${d.type}" style="width:100%; margin-top:6px;">
                  ${f ? '↻ Cambiar foto' : '📷 Tomar foto'}
                </button>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `);

    w.querySelectorAll('[data-doc-take]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.docTake;
        const inp = w.querySelector(`[data-doc-input="${type}"]`);
        if (inp) inp.click();
      });
    });
    w.querySelectorAll('[data-doc-input]').forEach((inp) => {
      inp.addEventListener('change', (e) => {
        const type = inp.dataset.docInput;
        const f = e.target.files && e.target.files[0];
        if (!f) return;
        if (f.size > 10 * 1024 * 1024) {
          window.MarzamToast?.show('La foto excede 10 MB.', 'error');
          return;
        }
        state.legal_docs[type] = f;
        refresh();
      });
    });
    return w;
  }

  // ──────────────────────────────────────────────────────────
  // API helpers
  // ──────────────────────────────────────────────────────────

  async function uploadVisitPhoto(visitId, file) {
    const fd = new FormData();
    fd.append('photo', file);
    return API.upload(`/visits/${visitId}/photos`, fd);
  }

  async function uploadOnboardingDoc(onboardingId, docType, file) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('doc_type', docType);
    return API.upload(`/pharmacy-onboarding/${onboardingId}/documents`, fd);
  }

  /**
   * Pipeline completo de un prospecto con outcome positivo:
   *   1) POST /visits   (guarda la visita + productos competencia)
   *   2) POST /visits/:id/photos   (foto de evidencia)
   *   3) POST /pharmacy-onboarding   (crea draft del alta con persona_tipo)
   *   4) for each legal_doc:  POST /pharmacy-onboarding/:id/documents
   *   5) POST /pharmacy-onboarding/:id/submit   (dispara email a datamaster)
   *
   * Cada paso es best-effort: si uno falla, los anteriores ya quedaron
   * persistidos y notificamos por toast.  La visita NUNCA se pierde.
   */
  async function submitProspectFull(pharmacy, state) {
    const isPositive = POSITIVE_OUTCOMES.has(state.outcome);

    // Step 1 — visit.
    const visit = await API.post('/visits', buildProspectPayload(pharmacy, state));

    // Step 2 — foto de evidencia (best-effort).
    if (state.evidence_photo && visit?.id) {
      try { await uploadVisitPhoto(visit.id, state.evidence_photo); }
      catch (e) {
        console.warn('[visit-client] evidence photo upload failed:', e?.error || e);
        window.MarzamToast?.show('Visita guardada — la foto no subió.', 'warn');
      }
    }

    // Pasos 3-5 solo aplican a outcomes positivos con persona_tipo.
    if (!isPositive || !state.persona_tipo) {
      return { visit, onboarding: null };
    }

    // Step 3 — crear pharmacy_onboarding draft.
    let onboarding = null;
    try {
      onboarding = await API.post('/pharmacy-onboarding', {
        dataplor_id: pharmacy.dataplor_id || null,
        not_in_directory: !pharmacy.dataplor_id,
        persona_tipo: state.persona_tipo,
        // forma_pago no se captura en este wizard corto — backend lo
        // dejará null y el director lo decide al revisar.
        razon_social: state.contact_name || pharmacy.name || null,
        nombre_comercial: pharmacy.name || null,
        contact_name: state.contact_name || state.contact_person || null,
        contact_phone: state.contact_phone || null,
        contact_email: state.contact_email || null,
        lat: state.lat || pharmacy.lat || null,
        lng: state.lng || pharmacy.lng || null,
        address: pharmacy.address || null,
        notes: state.notes,
      });
    } catch (e) {
      console.warn('[visit-client] onboarding creation failed:', e?.error || e);
      // Si el rol no tiene permiso (director_sucursal en demo) el endpoint
      // devuelve 403.  No bloqueamos al usuario — la visita queda igual.
      window.MarzamToast?.show(
        e?.status === 403
          ? 'Visita guardada. El alta de farmacia requiere rol Representante / Supervisor.'
          : 'Visita guardada — el alta no pudo iniciar: ' + (e?.error || e?.message || 'error'),
        'warn',
      );
      return { visit, onboarding: null };
    }

    // Step 4 — subir documentos legales en paralelo.
    if (onboarding?.id) {
      const uploads = Object.entries(state.legal_docs || {})
        .map(([type, file]) => uploadOnboardingDoc(onboarding.id, type, file)
          .catch((e) => {
            console.warn(`[visit-client] doc upload failed (${type}):`, e?.error || e);
            return { failed: type, reason: e?.error || e?.message || 'error' };
          }));
      const results = await Promise.all(uploads);
      const failed = results.filter((r) => r && r.failed);
      if (failed.length) {
        window.MarzamToast?.show(`Subieron ${results.length - failed.length}/${results.length} docs. Reintenta los faltantes desde "Mis altas".`, 'warn');
      }
    }

    // Step 5 — submit final → dispara email a datamaster@marzam.com.mx.
    try {
      await API.post(`/pharmacy-onboarding/${onboarding.id}/submit`, {});
    } catch (e) {
      console.warn('[visit-client] onboarding submit failed:', e?.error || e);
      window.MarzamToast?.show('Alta creada como borrador — envía manualmente desde "Mis altas".', 'warn');
    }

    return { visit, onboarding };
  }

  function buildProspectPayload(pharmacy, state) {
    return {
      pharmacy_id: pharmacy.id,
      outcome: state.outcome,
      notes: state.notes,
      // Comercial
      order_potential: state.order_potential ? Number(state.order_potential) : undefined,
      wholesalers: state.wholesalers || undefined,
      // Productos que la farmacia vende hoy con su competencia.  El backend
      // ya acepta `products[]` para visitas Marzam (visit_products).
      // Reusamos el mismo schema con nombres compatibles:
      //   - product_name
      //   - price_pharmacy   = lo que el cliente vende al consumidor
      //   - price_marzam     = NULL (todavía no es cliente)
      //   - competitor_brand = quién se lo abastece hoy
      //   - competitor_price = precio al que se lo compra (si lo dijo)
      //   - monthly_volume   = piezas / mes estimadas
      //   - comment          = nota libre
      // Si products es [], el backend no inserta nada.
      products: (state.products || []).map((p) => ({
        product_name: p.product_name,
        price_pharmacy: p.shelf_price ? Number(p.shelf_price) : null,
        price_marzam: null,
        competitor_brand: p.competitor_brand || null,
        competitor_price: p.competitor_price ? Number(p.competitor_price) : null,
        monthly_volume: p.monthly_volume ? Number(p.monthly_volume) : null,
        comment: p.comment || null,
      })),
      // Observaciones
      visit_observations: state.visit_observations || undefined,
      competition_info: state.competition_info || undefined,
      competition_prices: state.competition_prices || undefined,
      competition_offers: state.competition_offers || undefined,
      // Contacto
      contact_name: state.contact_name || undefined,
      contact_email: state.contact_email || undefined,
      contact_person: state.contact_person || state.contact_name || undefined,
      contact_phone: state.contact_phone || undefined,
      // Persona física / moral — se envía como meta en notas si el backend
      // no tiene la columna; el módulo de pharmacy_onboarding sí lo
      // entiende como `persona_tipo`.
      persona_tipo: state.persona_tipo,
      checkin_lat: state.lat,
      checkin_lng: state.lng,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Shell común — header + progress + body + footer
  // ──────────────────────────────────────────────────────────

  function mountShell({ title, subtitle }) {
    const root = el(`
      <div class="onb-backdrop" role="dialog" aria-modal="true">
        <div class="onb-shell">
          <div class="onb-header">
            <div style="flex:1; min-width:0;">
              <h2>${escapeHtml(title)}</h2>
              <p>${escapeHtml(subtitle)}</p>
            </div>
            <button class="onb-close" aria-label="Cerrar">
              <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M6 6l12 12M6 18L18 6"/></svg>
            </button>
          </div>
          <div class="onb-progress"></div>
          <div class="onb-body"></div>
          <div class="onb-footer">
            <button type="button" class="onb-btn onb-btn-back">Atrás</button>
            <button type="button" class="onb-btn onb-btn-next">Siguiente</button>
          </div>
        </div>
      </div>
    `);
    document.body.appendChild(root);
    const close = () => root.remove();
    root.querySelector('.onb-close').addEventListener('click', close);
    return {
      shellRoot: root,
      body: root.querySelector('.onb-body'),
      progress: root.querySelector('.onb-progress'),
      btnBack: root.querySelector('.onb-btn-back'),
      btnNext: root.querySelector('.onb-btn-next'),
      close,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Marzam — renders (sin cambios respecto al diseño anterior)
  // ──────────────────────────────────────────────────────────

  function renderMarzamIntro(state, refresh) {
    const w = el(`
      <div>
        <h2 class="onb-step-title">¿Visitaste la farmacia?</h2>
        <p class="onb-step-sub">Confirma si lograste el contacto en sitio.</p>
        <div class="onb-options onb-section">
          <button type="button" class="onb-option ${state.visited === true ? 'selected' : ''}" data-v="1">
            <div class="onb-option-icon">✅</div>
            <div class="onb-option-body">
              <div class="onb-option-title">Sí, visité</div>
              <div class="onb-option-desc">Continúo con detalles del pedido</div>
            </div>
          </button>
          <button type="button" class="onb-option ${state.visited === false ? 'selected' : ''}" data-v="0">
            <div class="onb-option-icon">🚷</div>
            <div class="onb-option-body">
              <div class="onb-option-title">No pude visitar</div>
              <div class="onb-option-desc">Voy a explicar por qué</div>
            </div>
          </button>
        </div>
      </div>
    `);
    w.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => {
      state.visited = b.dataset.v === '1';
      refresh();
    }));
    return w;
  }

  function renderMarzamOrder(state, refresh) {
    const w = el(`
      <div>
        <h2 class="onb-step-title">¿Se realizó el pedido?</h2>
        <p class="onb-step-sub">Si la farmacia hizo pedido, captura el monto aproximado.</p>
        <div class="onb-options onb-section">
          <button type="button" class="onb-option ${state.order_placed === true ? 'selected' : ''}" data-o="1">
            <div class="onb-option-icon">🧾</div>
            <div class="onb-option-body">
              <div class="onb-option-title">Sí, hubo pedido</div>
              <div class="onb-option-desc">Capturamos monto y productos</div>
            </div>
          </button>
          <button type="button" class="onb-option ${state.order_placed === false ? 'selected' : ''}" data-o="0">
            <div class="onb-option-icon">⏭️</div>
            <div class="onb-option-body">
              <div class="onb-option-title">No hubo pedido</div>
              <div class="onb-option-desc">Te pedimos la razón en el siguiente paso</div>
            </div>
          </button>
        </div>
        ${state.order_placed === true ? `
          <label class="onb-field">
            <span class="onb-label">Monto del pedido (MXN) <span class="opt">opcional</span></span>
            <input class="onb-input" type="number" inputmode="decimal" step="0.01" id="vc-amt" value="${escapeHtml(state.order_amount)}" placeholder="0.00">
          </label>
        ` : ''}
      </div>
    `);
    w.querySelectorAll('[data-o]').forEach((b) => b.addEventListener('click', () => {
      state.order_placed = b.dataset.o === '1';
      if (state.order_placed) state.no_order_reason = null;
      refresh();
    }));
    const amt = w.querySelector('#vc-amt');
    if (amt) amt.addEventListener('input', () => { state.order_amount = amt.value; });
    return w;
  }

  function renderMarzamReason(state, refresh) {
    const w = el(`
      <div>
        <h2 class="onb-step-title">¿Por qué no hubo pedido?</h2>
        <p class="onb-step-sub">Esta razón nos ayuda a detectar bloqueos comunes.</p>
        <div class="onb-options onb-section">
          ${NO_ORDER_REASONS.map((r) => `
            <button type="button" class="onb-option ${state.no_order_reason === r.code ? 'selected' : ''}" data-r="${r.code}">
              <div class="onb-option-icon">📌</div>
              <div class="onb-option-body">
                <div class="onb-option-title">${escapeHtml(r.label)}</div>
              </div>
            </button>
          `).join('')}
        </div>
        <label class="onb-field">
          <span class="onb-label">Notas <span class="opt">(opcional)</span></span>
          <textarea class="onb-textarea" id="vc-notes" placeholder="Detalle adicional">${escapeHtml(state.notes)}</textarea>
        </label>
      </div>
    `);
    w.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => {
      state.no_order_reason = b.dataset.r;
      refresh();
    }));
    const n = w.querySelector('#vc-notes');
    if (n) n.addEventListener('input', () => { state.notes = n.value; });
    return w;
  }

  function renderMarzamReasonNoVisit(state, refresh) {
    const w = el(`
      <div>
        <h2 class="onb-step-title">¿Por qué no pudiste visitar?</h2>
        <p class="onb-step-sub">Describe brevemente para que tu supervisor entienda el bloqueo.</p>
        <label class="onb-field">
          <span class="onb-label">Razón *</span>
          <textarea class="onb-textarea" id="vc-notes" placeholder="Ej. cerrado por remodelación, dirección incorrecta...">${escapeHtml(state.notes)}</textarea>
        </label>
      </div>
    `);
    w.querySelector('#vc-notes').addEventListener('input', (e) => { state.notes = e.target.value; refresh(); });
    return w;
  }

  function renderMarzamProducts(state, refresh, shellRoot) {
    const w = el(`
      <div>
        <h2 class="onb-step-title">Productos del pedido <span class="opt">opcional</span></h2>
        <p class="onb-step-sub">Captura producto + Precio Farmacia + Precio Marzam para tracking de margen.</p>
        <div class="onb-doclist">
          ${state.products.length ? state.products.map((p, i) => `
            <div class="onb-doc uploaded" style="background:#fff;">
              <div class="onb-doc-head">
                <div class="onb-doc-num">${i+1}</div>
                <div class="onb-doc-name">${escapeHtml(p.product_name)}</div>
                <button type="button" data-pdel="${i}" style="background:none; border:0; cursor:pointer; color:#94a3b8; font-size:20px;">✕</button>
              </div>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:13px;">
                <div><div style="font-size:10px; color:#64748b; font-weight:700;">P. FARMACIA</div><div style="font-weight:800;">${p.price_pharmacy != null ? '$'+Number(p.price_pharmacy).toFixed(2) : '—'}</div></div>
                <div><div style="font-size:10px; color:#c2410c; font-weight:700;">P. MARZAM</div><div style="font-weight:800; color:#c2410c;">${p.price_marzam != null ? '$'+Number(p.price_marzam).toFixed(2) : '—'}</div></div>
              </div>
            </div>
          `).join('') : '<div class="onb-banner info"><span>💊</span><div>Sin productos. Toca abajo para agregar (opcional).</div></div>'}
        </div>
        <div class="onb-section">
          <button type="button" id="vc-padd" class="onb-btn onb-btn-next" style="width:100%;">+ Agregar producto</button>
        </div>
      </div>
    `);
    w.querySelectorAll('[data-pdel]').forEach((b) => b.addEventListener('click', () => {
      state.products.splice(Number(b.dataset.pdel), 1); refresh();
    }));
    w.querySelector('#vc-padd').addEventListener('click', () => {
      const overlay = el(`
        <div class="onb-confirm-mask">
          <div class="onb-confirm-card">
            <h3>Producto</h3>
            <label class="onb-field"><span class="onb-label">Nombre *</span><input class="onb-input" id="vp-n"></label>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <label class="onb-field" style="margin-top:10px;"><span class="onb-label">P. Farmacia</span><input class="onb-input" id="vp-pp" type="number" step="0.01"></label>
              <label class="onb-field" style="margin-top:10px;"><span class="onb-label" style="color:#c2410c;">P. Marzam</span><input class="onb-input" id="vp-pm" type="number" step="0.01"></label>
            </div>
            <label class="onb-field"><input type="checkbox" id="vp-inc"> <span style="font-size:13px; margin-left:6px;">Se incluyó en el pedido</span></label>
            <div class="onb-confirm-actions">
              <button type="button" class="onb-btn onb-btn-back" data-c>Cancelar</button>
              <button type="button" class="onb-btn onb-btn-next" data-s>Guardar</button>
            </div>
          </div>
        </div>
      `);
      shellRoot.querySelector('.onb-shell').appendChild(overlay);
      overlay.querySelector('[data-c]').addEventListener('click', () => overlay.remove());
      overlay.querySelector('[data-s]').addEventListener('click', () => {
        const name = overlay.querySelector('#vp-n').value.trim();
        if (!name) { window.MarzamToast?.show('Nombre requerido', 'error'); return; }
        state.products.push({
          product_name: name,
          price_pharmacy: overlay.querySelector('#vp-pp').value || null,
          price_marzam: overlay.querySelector('#vp-pm').value || null,
          included_in_order: overlay.querySelector('#vp-inc').checked,
        });
        overlay.remove();
        refresh();
      });
    });
    return w;
  }

  function renderMarzamReview(state) {
    const reasonLabel = NO_ORDER_REASONS.find((r) => r.code === state.no_order_reason)?.label || '—';
    return el(`
      <div>
        <h2 class="onb-step-title">Confirma y registra</h2>
        <div class="onb-summary onb-section">
          <div class="onb-summary-row"><span class="k">Visitada</span><span class="v">${state.visited ? 'Sí' : 'No'}</span></div>
          ${state.visited ? `
            <div class="onb-summary-row"><span class="k">Pedido</span><span class="v">${state.order_placed ? 'Sí ($'+(state.order_amount || '0.00')+')' : 'No · '+escapeHtml(reasonLabel)}</span></div>
            <div class="onb-summary-row"><span class="k">Productos</span><span class="v">${state.products.length}</span></div>
          ` : `
            <div class="onb-summary-row"><span class="k">Razón</span><span class="v">${escapeHtml(state.notes) || '—'}</span></div>
          `}
          <div class="onb-summary-row"><span class="k">GPS</span><span class="v">${state.lat ? state.lat.toFixed(5)+', '+state.lng.toFixed(5) : '— sin GPS —'}</span></div>
        </div>
      </div>
    `);
  }

  // ──────────────────────────────────────────────────────────
  // Prospecto — renders (nuevo)
  // ──────────────────────────────────────────────────────────

  function renderProspectOutcome(state, refresh) {
    const w = el(`
      <div>
        <h2 class="onb-step-title">Resultado de la visita *</h2>
        <p class="onb-step-sub">Selecciona qué pasó cuando visitaste la farmacia.</p>
        <label class="onb-field">
          <select class="onb-input" id="vp-outcome">
            <option value="">Seleccionar...</option>
            ${VISIT_OUTCOMES.map((o) => `
              <option value="${o.code}" ${state.outcome === o.code ? 'selected' : ''}>${escapeHtml(o.label)}</option>
            `).join('')}
          </select>
        </label>
      </div>
    `);
    w.querySelector('#vp-outcome').addEventListener('change', (e) => {
      state.outcome = e.target.value;
      refresh();
    });
    return w;
  }

  function renderProspectNotes(state, refresh) {
    const w = el(`
      <div>
        <h2 class="onb-step-title">Notas *</h2>
        <p class="onb-step-sub">Resumen de lo que observaste y siguientes pasos sugeridos.</p>
        <label class="onb-field">
          <textarea class="onb-textarea" id="vp-notes" rows="5" placeholder="Observaciones..." style="min-height:120px;">${escapeHtml(state.notes)}</textarea>
        </label>
      </div>
    `);
    w.querySelector('#vp-notes').addEventListener('input', (e) => {
      state.notes = e.target.value;
      refresh();
    });
    return w;
  }

  function renderProspectDatosGenerales(state, refresh) {
    const w = el(`
      <div>
        <h2 class="onb-step-title">Datos generales</h2>
        <p class="onb-step-sub">Captura los datos del contacto y el régimen fiscal.</p>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          <label class="onb-field">
            <span class="onb-label">Nombre <span class="opt">(opcional)</span></span>
            <input class="onb-input" id="vp-cname" placeholder="Nombre del contacto" value="${escapeHtml(state.contact_name)}">
          </label>
          <label class="onb-field">
            <span class="onb-label">Correo <span class="opt">(opcional)</span></span>
            <input class="onb-input" id="vp-cemail" type="email" placeholder="correo@ejemplo.com" value="${escapeHtml(state.contact_email)}">
          </label>
        </div>

        <div class="onb-section">
          <span class="onb-label" style="display:block; margin-bottom:8px;">Régimen fiscal *</span>
          <div class="onb-options" style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
            <button type="button" class="onb-option ${state.persona_tipo === 'fisica' ? 'selected' : ''}" data-pt="fisica">
              <div class="onb-option-icon">👤</div>
              <div class="onb-option-body">
                <div class="onb-option-title">Persona Física</div>
                <div class="onb-option-desc">Individuo</div>
              </div>
            </button>
            <button type="button" class="onb-option ${state.persona_tipo === 'moral' ? 'selected' : ''}" data-pt="moral">
              <div class="onb-option-icon">🏢</div>
              <div class="onb-option-body">
                <div class="onb-option-title">Persona Moral</div>
                <div class="onb-option-desc">Razón social</div>
              </div>
            </button>
          </div>
        </div>
      </div>
    `);
    w.querySelector('#vp-cname').addEventListener('input', (e) => { state.contact_name = e.target.value; });
    w.querySelector('#vp-cemail').addEventListener('input', (e) => { state.contact_email = e.target.value; });
    w.querySelectorAll('[data-pt]').forEach((b) => b.addEventListener('click', () => {
      state.persona_tipo = b.dataset.pt;
      refresh();
    }));
    return w;
  }

  function renderProspectComercial(state, refresh) {
    const w = el(`
      <div>
        <h2 class="onb-step-title">Información comercial</h2>
        <p class="onb-step-sub">Capacidad estimada de compra y proveedores actuales.</p>
        <label class="onb-field">
          <span class="onb-label">Potencial de compra de cliente ($)</span>
          <input class="onb-input" id="vp-pot" type="number" inputmode="decimal" step="100" placeholder="Demanda estimada" value="${escapeHtml(state.order_potential)}">
        </label>
        <label class="onb-field">
          <span class="onb-label">Mayoristas con los que trabajan</span>
          <input class="onb-input" id="vp-whole" placeholder="Mayoristas actuales del cliente" value="${escapeHtml(state.wholesalers)}">
        </label>
      </div>
    `);
    w.querySelector('#vp-pot').addEventListener('input', (e) => { state.order_potential = e.target.value; refresh(); });
    w.querySelector('#vp-whole').addEventListener('input', (e) => { state.wholesalers = e.target.value; refresh(); });
    return w;
  }

  function renderProspectProductos(state, refresh, shellRoot) {
    const w = el(`
      <div>
        <h2 class="onb-step-title">Productos que vende hoy <span class="opt">opcional</span></h2>
        <p class="onb-step-sub">Captura los productos que el cliente está abasteciendo con la competencia, con el precio al que se los compra.  Esto alimenta el dashboard de oportunidades de margen.</p>
        <div class="onb-doclist">
          ${state.products.length ? state.products.map((p, i) => `
            <div class="onb-doc uploaded" style="background:#fff;">
              <div class="onb-doc-head">
                <div class="onb-doc-num">${i+1}</div>
                <div class="onb-doc-name">${escapeHtml(p.product_name)}${p.competitor_brand ? ` · ${escapeHtml(p.competitor_brand)}` : ''}</div>
                <button type="button" data-pdel="${i}" style="background:none; border:0; cursor:pointer; color:#94a3b8; font-size:20px;">✕</button>
              </div>
              <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; font-size:13px;">
                <div>
                  <div style="font-size:10px; color:#64748b; font-weight:700;">P. ANAQUEL</div>
                  <div style="font-weight:800;">${p.shelf_price != null ? '$'+Number(p.shelf_price).toFixed(2) : '—'}</div>
                </div>
                <div>
                  <div style="font-size:10px; color:#c2410c; font-weight:700;">P. COMPETENCIA</div>
                  <div style="font-weight:800; color:#c2410c;">${p.competitor_price != null ? '$'+Number(p.competitor_price).toFixed(2) : '—'}</div>
                </div>
                <div>
                  <div style="font-size:10px; color:#64748b; font-weight:700;">VOL/MES</div>
                  <div style="font-weight:800;">${p.monthly_volume != null ? Number(p.monthly_volume).toLocaleString() : '—'}</div>
                </div>
              </div>
              ${p.comment ? `<div style="font-size:11px; color:#64748b; margin-top:6px;">${escapeHtml(p.comment)}</div>` : ''}
            </div>
          `).join('') : '<div class="onb-banner info"><span>💊</span><div>Aún no hay productos. Agrega los que vimos en anaquel para tracking de oportunidad.</div></div>'}
        </div>
        <div class="onb-section">
          <button type="button" id="vp-padd" class="onb-btn onb-btn-next" style="width:100%;">+ Agregar producto</button>
        </div>
      </div>
    `);
    w.querySelectorAll('[data-pdel]').forEach((b) => b.addEventListener('click', () => {
      state.products.splice(Number(b.dataset.pdel), 1);
      refresh();
    }));
    w.querySelector('#vp-padd').addEventListener('click', () => {
      const overlay = el(`
        <div class="onb-confirm-mask">
          <div class="onb-confirm-card">
            <h3>Producto en anaquel</h3>
            <label class="onb-field">
              <span class="onb-label">Nombre del producto *</span>
              <input class="onb-input" id="vpr-name" placeholder="Ej. Paracetamol 500mg caja x20">
            </label>
            <label class="onb-field" style="margin-top:10px;">
              <span class="onb-label">Marca o mayorista que se lo abastece</span>
              <input class="onb-input" id="vpr-brand" placeholder="Ej. Marfrim, Fármacos Nacionales, Casa Saba…">
            </label>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
              <label class="onb-field" style="margin-top:10px;">
                <span class="onb-label">P. anaquel ($)</span>
                <input class="onb-input" id="vpr-shelf" type="number" inputmode="decimal" step="0.01" placeholder="precio al consumidor">
              </label>
              <label class="onb-field" style="margin-top:10px;">
                <span class="onb-label" style="color:#c2410c;">P. competencia ($)</span>
                <input class="onb-input" id="vpr-comp" type="number" inputmode="decimal" step="0.01" placeholder="precio que él paga">
              </label>
            </div>
            <label class="onb-field" style="margin-top:10px;">
              <span class="onb-label">Volumen mensual estimado (piezas)</span>
              <input class="onb-input" id="vpr-vol" type="number" inputmode="numeric" step="1" placeholder="Ej. 30">
            </label>
            <label class="onb-field" style="margin-top:10px;">
              <span class="onb-label">Notas <span class="opt">(opcional)</span></span>
              <textarea class="onb-textarea" id="vpr-comment" rows="2" placeholder="Ej. está abierto a probar otra fuente, vence en 3 meses…"></textarea>
            </label>
            <div class="onb-confirm-actions">
              <button type="button" class="onb-btn onb-btn-back" data-c>Cancelar</button>
              <button type="button" class="onb-btn onb-btn-next" data-s>Guardar producto</button>
            </div>
          </div>
        </div>
      `);
      shellRoot.querySelector('.onb-shell').appendChild(overlay);
      overlay.querySelector('[data-c]').addEventListener('click', () => overlay.remove());
      overlay.querySelector('[data-s]').addEventListener('click', () => {
        const name = overlay.querySelector('#vpr-name').value.trim();
        if (!name) {
          window.MarzamToast?.show('El nombre del producto es obligatorio', 'error');
          return;
        }
        state.products.push({
          product_name: name,
          competitor_brand: overlay.querySelector('#vpr-brand').value.trim() || null,
          shelf_price: overlay.querySelector('#vpr-shelf').value || null,
          competitor_price: overlay.querySelector('#vpr-comp').value || null,
          monthly_volume: overlay.querySelector('#vpr-vol').value || null,
          comment: overlay.querySelector('#vpr-comment').value.trim() || null,
        });
        overlay.remove();
        refresh();
      });
    });
    return w;
  }

  function renderProspectObservaciones(state, refresh) {
    const w = el(`
      <div>
        <h2 class="onb-step-title">Observaciones de visita</h2>
        <p class="onb-step-sub">Información cualitativa para inteligencia comercial.</p>
        <label class="onb-field">
          <span class="onb-label">Observaciones generales</span>
          <textarea class="onb-textarea" id="vp-obs" rows="3" placeholder="Observaciones de la visita...">${escapeHtml(state.visit_observations)}</textarea>
        </label>
        <label class="onb-field">
          <span class="onb-label">Información de la competencia</span>
          <input class="onb-input" id="vp-comp" placeholder="Marcas, productos y presencia en anaquel" value="${escapeHtml(state.competition_info)}">
        </label>
        <label class="onb-field">
          <span class="onb-label">Precios</span>
          <input class="onb-input" id="vp-prices" placeholder="Precios observados de competencia" value="${escapeHtml(state.competition_prices)}">
        </label>
        <label class="onb-field">
          <span class="onb-label">Ofertas</span>
          <input class="onb-input" id="vp-offers" placeholder="Promociones y ofertas activas" value="${escapeHtml(state.competition_offers)}">
        </label>
      </div>
    `);
    w.querySelector('#vp-obs').addEventListener('input', (e) => { state.visit_observations = e.target.value; refresh(); });
    w.querySelector('#vp-comp').addEventListener('input', (e) => { state.competition_info = e.target.value; refresh(); });
    w.querySelector('#vp-prices').addEventListener('input', (e) => { state.competition_prices = e.target.value; refresh(); });
    w.querySelector('#vp-offers').addEventListener('input', (e) => { state.competition_offers = e.target.value; refresh(); });
    return w;
  }

  function renderProspectContacto(state, refresh) {
    const w = el(`
      <div>
        <h2 class="onb-step-title">Contacto en sitio</h2>
        <p class="onb-step-sub">Persona que viste y cómo localizarla en el futuro.</p>
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
          <label class="onb-field">
            <span class="onb-label">Contacto</span>
            <input class="onb-input" id="vp-contact" placeholder="Nombre" value="${escapeHtml(state.contact_person)}">
          </label>
          <label class="onb-field">
            <span class="onb-label">Teléfono</span>
            <input class="onb-input" id="vp-phone" type="tel" placeholder="55 1234 5678" value="${escapeHtml(state.contact_phone)}">
          </label>
        </div>
      </div>
    `);
    w.querySelector('#vp-contact').addEventListener('input', (e) => { state.contact_person = e.target.value; refresh(); });
    w.querySelector('#vp-phone').addEventListener('input', (e) => { state.contact_phone = e.target.value; refresh(); });
    return w;
  }

  function renderProspectReview(state) {
    const outcomeLabel = VISIT_OUTCOMES.find((o) => o.code === state.outcome)?.label || state.outcome;
    const personaLabel = state.persona_tipo === 'moral' ? 'Persona Moral' : (state.persona_tipo === 'fisica' ? 'Persona Física' : '—');
    const isPositive = POSITIVE_OUTCOMES.has(state.outcome);
    const requiredDocs = isPositive && state.persona_tipo ? legalDocsFor(state.persona_tipo).length : 0;
    const uploadedDocs = Object.keys(state.legal_docs || {}).length;
    const photoBadge = state.evidence_photo ? '✓' : '—';
    return el(`
      <div>
        <h2 class="onb-step-title">Confirma y registra</h2>
        <div class="onb-summary onb-section">
          <div class="onb-summary-row"><span class="k">Resultado</span><span class="v">${escapeHtml(outcomeLabel)}</span></div>
          <div class="onb-summary-row"><span class="k">Notas</span><span class="v">${escapeHtml(state.notes.length > 60 ? state.notes.slice(0, 57) + '...' : state.notes) || '—'}</span></div>
          <div class="onb-summary-row"><span class="k">Foto de evidencia</span><span class="v">${photoBadge}</span></div>
          ${isPositive ? `
            <div class="onb-summary-row"><span class="k">Régimen</span><span class="v">${escapeHtml(personaLabel)}</span></div>
            ${state.contact_name ? `<div class="onb-summary-row"><span class="k">Nombre</span><span class="v">${escapeHtml(state.contact_name)}</span></div>` : ''}
            ${state.order_potential ? `<div class="onb-summary-row"><span class="k">Potencial</span><span class="v">$${Number(state.order_potential).toLocaleString()}</span></div>` : ''}
            ${state.wholesalers ? `<div class="onb-summary-row"><span class="k">Mayoristas</span><span class="v">${escapeHtml(state.wholesalers)}</span></div>` : ''}
            <div class="onb-summary-row"><span class="k">Productos capturados</span><span class="v">${state.products.length}${state.products.length ? ' · '+state.products.slice(0, 2).map((p) => escapeHtml(p.product_name)).join(', ') + (state.products.length > 2 ? ' …' : '') : ''}</span></div>
            <div class="onb-summary-row"><span class="k">Docs legales</span><span class="v">${uploadedDocs}/${requiredDocs}</span></div>
            ${state.contact_phone ? `<div class="onb-summary-row"><span class="k">Teléfono</span><span class="v">${escapeHtml(state.contact_phone)}</span></div>` : ''}
          ` : ''}
          <div class="onb-summary-row"><span class="k">GPS</span><span class="v">${state.lat ? state.lat.toFixed(5)+', '+state.lng.toFixed(5) : '— sin GPS —'}</span></div>
        </div>
        ${isPositive ? `
          <div class="onb-banner info" style="margin-top:12px;">
            <span>📨</span>
            <div>Al registrar, Marzam recibirá un correo a <b>datamaster@marzam.com.mx</b> con todos los documentos para iniciar el proceso de alta.</div>
          </div>
        ` : ''}
      </div>
    `);
  }

  window.MarzamVisitClient = { open };
})();
