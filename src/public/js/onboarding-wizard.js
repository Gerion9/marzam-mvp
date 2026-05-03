/* =============================================================
   Marzam — Wizard "Alta de farmacia nueva"
   Mount point:  window.MarzamOnboarding.openWizard()
   Roles permitidos: supervisor, representante.
   ============================================================= */
(function () {
  'use strict';

  const ALLOWED_ROLES = ['supervisor', 'representante'];

  // Spec local — se sobreescribe con /api/pharmacy-onboarding/spec si es accesible.
  const DEFAULT_SPEC = {
    docs_fisica: [
      { type: 'constancia_fiscal',     label: 'Constancia de Situación Fiscal' },
      { type: 'comprobante_domicilio', label: 'Comprobante de Domicilio' },
      { type: 'ine',                   label: 'INE' },
    ],
    docs_moral: [
      { type: 'constancia_fiscal',     label: 'Constancia de Situación Fiscal' },
      { type: 'comprobante_domicilio', label: 'Comprobante de Domicilio' },
      { type: 'ine',                   label: 'INE' },
      { type: 'acta_constitutiva',     label: 'Acta Constitutiva' },
      { type: 'poder_legal',           label: 'Poder del Representante Legal' },
    ],
    facade_found: [
      { type: 'facade_front', label: 'Fachada (frente)' },
    ],
    facade_not_found: [
      { type: 'facade_no_exists_left',  label: 'Foto a tu izquierda' },
      { type: 'facade_no_exists_front', label: 'Foto al frente' },
      { type: 'facade_no_exists_right', label: 'Foto a tu derecha' },
    ],
  };

  // ──────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  }

  function getCurrentRole() {
    try {
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      const role = u?.role || '';
      const aliases = {
        manager: 'director_sucursal', national_admin: 'director_sucursal',
        regional_manager: 'gerente_ventas', area_coordinator: 'supervisor',
        field_rep: 'representante',
      };
      return aliases[role] || role;
    } catch { return ''; }
  }

  function canUseWizard() {
    return ALLOWED_ROLES.includes(getCurrentRole());
  }

  function geolocate() {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
      );
    });
  }

  // Compresión client-side antes de subir (ahorra ancho de banda en campo).
  async function compressImage(file, maxDim = 1600, quality = 0.82) {
    if (!/^image\//.test(file.type)) return file;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
      if (!blob) return file;
      return new File([blob], (file.name || 'foto').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch { return file; }
  }

  // ──────────────────────────────────────────────────────────
  // State del wizard
  // ──────────────────────────────────────────────────────────
  function makeState() {
    return {
      onboardingId: null,
      stepIndex: 0,
      // Decisiones
      not_in_directory: null,    // boolean
      dataplor_id: null,         // si eligió un candidato cercano
      candidate_pharmacy_id: null,
      candidate_name: null,
      candidates: null,          // cache de cercanos
      candidatesLoading: false,
      persona_tipo: null,        // 'fisica' | 'moral'
      forma_pago: null,          // 'efectivo' | 'credito'
      // Datos
      rfc: '',
      razon_social: '',
      nombre_comercial: '',
      contact_name: '',
      contact_phone: '',
      contact_email: '',
      address: '',
      notes: '',
      lat: null, lng: null, accuracy: null,
      // Fotos / documentos subidos: { [docType]: { id, photo_url, previewUrl } }
      uploaded: {},
      // Productos capturados (lista local; se persisten al backend al avanzar de ese paso)
      products: [],
      spec: DEFAULT_SPEC,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Definición de steps (función de orden, devuelve lista dinámica)
  // ──────────────────────────────────────────────────────────
  function buildSteps(state) {
    return [
      { id: 'intro',      title: '¿Encontraste la farmacia?' },
      ...(state.not_in_directory
        ? [{ id: 'no_exists_confirm', title: 'Confirma antes de marcar como inexistente' }]
        : []),
      { id: 'persona',    title: 'Tipo de persona' },
      { id: 'pago',       title: 'Forma de pago' },
      { id: 'datos',      title: 'Datos básicos' },
      { id: 'docs',       title: 'Documentos legales' },
      { id: 'facade',     title: state.not_in_directory ? 'Fotos del lugar' : 'Foto de fachada' },
      { id: 'productos',  title: 'Productos (opcional)' },
      { id: 'review',     title: 'Revisar y enviar' },
    ];
  }

  // ──────────────────────────────────────────────────────────
  // Renderers de cada step
  // ──────────────────────────────────────────────────────────
  function renderIntro(state, refresh) {
    const wrap = el(`
      <div>
        <h2 class="onb-step-title">Alta de farmacia nueva</h2>
        <p class="onb-step-sub">Solo se pueden dar de alta farmacias que <b>aún no son clientes Marzam</b>. Detectamos automáticamente los candidatos cerca de ti.</p>

        <div class="onb-banner info onb-section" id="onb-gps-banner">
          <span>📍</span>
          <div>${state.lat ? `GPS bloqueado · ${state.lat.toFixed(5)}, ${state.lng.toFixed(5)}` : 'Capturando tu ubicación...'}</div>
        </div>

        <div class="onb-section">
          <span class="onb-label">Candidatos cercanos (no clientes Marzam)</span>
          <div id="onb-candidates" class="onb-options" style="margin-top: 8px;">
            ${renderCandidatesInner(state)}
          </div>
        </div>

        <div class="onb-section">
          <button type="button" class="onb-option ${state.not_in_directory === true ? 'selected' : ''}" data-choice="missing">
            <div class="onb-option-icon">🚫</div>
            <div class="onb-option-body">
              <div class="onb-option-title">No está en la lista</div>
              <div class="onb-option-desc">Registrar una farmacia nueva no listada (requerirá 3 fotos del lugar)</div>
            </div>
          </button>
        </div>
      </div>
    `);

    wrap.querySelector('[data-choice="missing"]').addEventListener('click', () => {
      state.not_in_directory = true;
      state.dataplor_id = null;
      state.candidate_pharmacy_id = null;
      state.candidate_name = null;
      refresh();
    });

    // Lazy load: si tenemos GPS pero aún no candidatos, los pedimos.
    if (state.lat != null && state.candidates == null && !state.candidatesLoading) {
      state.candidatesLoading = true;
      API.get(`/pharmacy-onboarding/nearby?lat=${state.lat}&lng=${state.lng}&radius_m=300&limit=15`)
        .then((rows) => { state.candidates = rows || []; state.candidatesLoading = false; refresh(); })
        .catch(() => { state.candidates = []; state.candidatesLoading = false; refresh(); });
    }

    // Bind clicks dentro del contenedor de candidatos.
    wrap.querySelectorAll('[data-candidate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.candidate;
        const c = (state.candidates || []).find((x) => String(x.id) === String(id));
        if (!c) return;
        state.not_in_directory = false;
        state.candidate_pharmacy_id = c.id;
        state.candidate_name = c.name;
        state.dataplor_id = c.dataplor_id || null;
        if (!state.razon_social && c.name) state.razon_social = c.name;
        if (!state.address && c.address) state.address = c.address;
        refresh();
      });
    });

    return wrap;
  }

  function renderCandidatesInner(state) {
    if (state.lat == null) {
      return `<div class="onb-banner warn"><span>📡</span><div>Necesitamos tu GPS para mostrarte candidatos cercanos. Activa la ubicación.</div></div>`;
    }
    if (state.candidatesLoading || state.candidates == null) {
      return `<div class="onb-banner info"><span>⏳</span><div>Buscando candidatos no-clientes a 300m...</div></div>`;
    }
    if (!state.candidates.length) {
      return `<div class="onb-banner info"><span>ℹ️</span><div>No hay candidatos no-clientes Marzam en 300m. Si la farmacia que ves no aparece, marca "No está en la lista" abajo.</div></div>`;
    }
    return state.candidates.map((c) => {
      const dist = Math.round(Number(c.distance_m) || 0);
      const selected = String(state.candidate_pharmacy_id) === String(c.id);
      return `
        <button type="button" class="onb-option ${selected ? 'selected' : ''}" data-candidate="${escapeHtml(c.id)}">
          <div class="onb-option-icon">🏥</div>
          <div class="onb-option-body">
            <div class="onb-option-title">${escapeHtml(c.name || 'Sin nombre')}</div>
            <div class="onb-option-desc">${escapeHtml(c.address || c.municipality || '')} · a ${dist} m</div>
          </div>
        </button>
      `;
    }).join('');
  }

  function renderNoExistsConfirm(state, refresh) {
    const wrap = el(`
      <div>
        <h2 class="onb-step-title">Antes de continuar</h2>
        <p class="onb-step-sub">Para marcar una farmacia como "no existe", necesitamos que confirmes que ya revisaste alrededor.</p>

        <div class="onb-banner warn onb-section">
          <span>⚠️</span>
          <div>En el siguiente paso te pediremos <b>3 fotos obligatorias</b>: a tu izquierda, al frente y a tu derecha. Sin las 3 fotos no podrás enviar la alta.</div>
        </div>

        <div class="onb-options onb-section">
          <button type="button" class="onb-option" data-back="1">
            <div class="onb-option-icon">↩</div>
            <div class="onb-option-body">
              <div class="onb-option-title">Quiero revisar de nuevo</div>
              <div class="onb-option-desc">Volver al paso anterior</div>
            </div>
          </button>
          <button type="button" class="onb-option selected" data-confirm="1">
            <div class="onb-option-icon">✅</div>
            <div class="onb-option-body">
              <div class="onb-option-title">Sí, ya revisé alrededor</div>
              <div class="onb-option-desc">Continuar con el alta</div>
            </div>
          </button>
        </div>
      </div>
    `);
    wrap.querySelector('[data-back]').addEventListener('click', () => {
      state.not_in_directory = null;
      state.stepIndex = 0;
      refresh();
    });
    return wrap;
  }

  function renderPersona(state, refresh) {
    const wrap = el(`
      <div>
        <h2 class="onb-step-title">¿Persona física o moral?</h2>
        <p class="onb-step-sub">Esto define qué documentos vamos a necesitar.</p>
        <div class="onb-options onb-section">
          <button type="button" class="onb-option ${state.persona_tipo === 'fisica' ? 'selected' : ''}" data-pt="fisica">
            <div class="onb-option-icon">👤</div>
            <div class="onb-option-body">
              <div class="onb-option-title">Persona Física</div>
              <div class="onb-option-desc">3 documentos: Constancia, Comprobante de domicilio, INE</div>
            </div>
          </button>
          <button type="button" class="onb-option ${state.persona_tipo === 'moral' ? 'selected' : ''}" data-pt="moral">
            <div class="onb-option-icon">🏢</div>
            <div class="onb-option-body">
              <div class="onb-option-title">Persona Moral</div>
              <div class="onb-option-desc">5 documentos: Constancia, Comprobante, INE, Acta Constitutiva, Poder Legal</div>
            </div>
          </button>
        </div>
      </div>
    `);
    wrap.querySelectorAll('[data-pt]').forEach((b) => {
      b.addEventListener('click', () => { state.persona_tipo = b.dataset.pt; refresh(); });
    });
    return wrap;
  }

  function renderPago(state, refresh) {
    const wrap = el(`
      <div>
        <h2 class="onb-step-title">Forma de pago</h2>
        <p class="onb-step-sub">¿Cómo va a pagar el producto la farmacia?</p>
        <div class="onb-options onb-section">
          <button type="button" class="onb-option ${state.forma_pago === 'efectivo' ? 'selected' : ''}" data-fp="efectivo">
            <div class="onb-option-icon">💵</div>
            <div class="onb-option-body">
              <div class="onb-option-title">Efectivo</div>
              <div class="onb-option-desc">Aprobación casi inmediata</div>
            </div>
          </button>
          <button type="button" class="onb-option ${state.forma_pago === 'credito' ? 'selected' : ''}" data-fp="credito">
            <div class="onb-option-icon">📋</div>
            <div class="onb-option-body">
              <div class="onb-option-title">Crédito</div>
              <div class="onb-option-desc">Pasa a proceso de aprobación de crédito</div>
            </div>
          </button>
        </div>
        ${state.forma_pago === 'credito' ? `
          <div class="onb-banner warn onb-section">
            <span>⏳</span>
            <div>Esta alta entrará a revisión de crédito. La farmacia no podrá comprar a crédito hasta que un supervisor o representante con autorización confirme la decisión.</div>
          </div>
        ` : ''}
      </div>
    `);
    wrap.querySelectorAll('[data-fp]').forEach((b) => {
      b.addEventListener('click', () => { state.forma_pago = b.dataset.fp; refresh(); });
    });
    return wrap;
  }

  function renderDatos(state, refresh) {
    const wrap = el(`
      <div>
        <h2 class="onb-step-title">Datos básicos</h2>
        <p class="onb-step-sub">RFC y nombre se enviarán al correo de Datamaster cuando termines.</p>

        <label class="onb-field">
          <span class="onb-label">RFC <span class="opt">(opcional ahora — se valida con la Constancia)</span></span>
          <input class="onb-input" name="rfc" value="${escapeHtml(state.rfc)}" autocomplete="off" maxlength="20" placeholder="EJ: ABC010101AB1">
        </label>

        <label class="onb-field">
          <span class="onb-label">Razón social ${state.persona_tipo === 'moral' ? '' : '<span class="opt">(opcional)</span>'}</span>
          <input class="onb-input" name="razon_social" value="${escapeHtml(state.razon_social)}" placeholder="Como aparece en la Constancia">
        </label>

        <label class="onb-field">
          <span class="onb-label">Nombre comercial</span>
          <input class="onb-input" name="nombre_comercial" value="${escapeHtml(state.nombre_comercial)}" placeholder="Nombre con el que se conoce la farmacia">
        </label>

        <label class="onb-field">
          <span class="onb-label">Persona de contacto</span>
          <input class="onb-input" name="contact_name" value="${escapeHtml(state.contact_name)}" placeholder="Quién atiende en la farmacia">
        </label>

        <label class="onb-field">
          <span class="onb-label">Teléfono</span>
          <input class="onb-input" name="contact_phone" type="tel" inputmode="tel" value="${escapeHtml(state.contact_phone)}" placeholder="10 dígitos">
        </label>

        <label class="onb-field">
          <span class="onb-label">Correo <span class="opt">(opcional)</span></span>
          <input class="onb-input" name="contact_email" type="email" inputmode="email" value="${escapeHtml(state.contact_email)}" placeholder="contacto@ejemplo.com">
        </label>

        <label class="onb-field">
          <span class="onb-label">Dirección</span>
          <textarea class="onb-textarea" name="address" placeholder="Calle, número, colonia">${escapeHtml(state.address)}</textarea>
        </label>

        <label class="onb-field">
          <span class="onb-label">Notas <span class="opt">(opcional)</span></span>
          <textarea class="onb-textarea" name="notes" placeholder="Cualquier observación">${escapeHtml(state.notes)}</textarea>
        </label>
      </div>
    `);
    wrap.querySelectorAll('input,textarea').forEach((inp) => {
      inp.addEventListener('input', () => { state[inp.name] = inp.value; });
    });
    return wrap;
  }

  function renderDocList(state, refresh, items, opts = {}) {
    const wrap = el(`
      <div>
        <h2 class="onb-step-title">${opts.title || 'Documentos'}</h2>
        <p class="onb-step-sub">${opts.subtitle || ''}</p>
        <div class="onb-doclist"></div>
      </div>
    `);
    const list = wrap.querySelector('.onb-doclist');

    items.forEach((doc, idx) => {
      const uploaded = state.uploaded[doc.type];
      const card = el(`
        <div class="onb-doc ${uploaded ? 'uploaded' : ''}" data-doc="${doc.type}">
          <div class="onb-doc-head">
            <div class="onb-doc-num">${idx + 1}</div>
            <div class="onb-doc-name">${escapeHtml(doc.label)}</div>
            <div class="onb-doc-status">${uploaded ? '✓ Subida' : 'Pendiente'}</div>
          </div>
          ${uploaded ? `<img class="onb-doc-thumb" src="${escapeHtml(uploaded.previewUrl || uploaded.photo_url)}" alt="">` : ''}
          <div class="onb-doc-actions">
            <label class="onb-btn-cap primary">
              <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
              <span>Tomar foto</span>
              <input type="file" accept="image/*" capture="environment" hidden>
            </label>
            <label class="onb-btn-cap">
              <svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>
              <span>De galería</span>
              <input type="file" accept="image/*" hidden>
            </label>
          </div>
        </div>
      `);
      const inputs = card.querySelectorAll('input[type="file"]');
      inputs.forEach((inp) => {
        inp.addEventListener('change', async (e) => {
          const f = e.target.files && e.target.files[0];
          if (!f) return;
          await uploadDocFile(state, doc.type, f, refresh);
        });
      });
      list.appendChild(card);
    });

    return wrap;
  }

  async function uploadDocFile(state, docType, file, refresh) {
    if (!state.onboardingId) {
      // El draft se crea perezosamente la primera vez que se sube algo o se llega al paso datos.
      const draft = await ensureDraft(state);
      state.onboardingId = draft.id;
    }
    const previewUrl = URL.createObjectURL(file);
    state.uploaded[docType] = { uploading: true, previewUrl };
    refresh();

    try {
      const compressed = await compressImage(file);
      const fd = new FormData();
      fd.append('file', compressed, compressed.name || 'foto.jpg');
      fd.append('doc_type', docType);
      if (state.lat != null) fd.append('lat', state.lat);
      if (state.lng != null) fd.append('lng', state.lng);
      const doc = await API.upload(`/pharmacy-onboarding/${state.onboardingId}/documents`, fd);
      state.uploaded[docType] = { id: doc.id, photo_url: doc.photo_url, previewUrl };
      window.MarzamToast?.show('Foto subida ✓', 'success');
    } catch (err) {
      console.error('upload failed', err);
      delete state.uploaded[docType];
      window.MarzamToast?.show('Error subiendo la foto', 'error');
    }
    refresh();
  }

  function renderProductos(state, refresh) {
    const wrap = el(`
      <div>
        <h2 class="onb-step-title">Productos que maneja</h2>
        <p class="onb-step-sub">Captura los productos que la farmacia ya vende y compara su precio actual contra lo que le ofrece Marzam. Es <b>opcional</b> — puedes saltar si todavía no sabes qué productos maneja.</p>

        <div class="onb-doclist" id="onb-prod-list">
          ${state.products.length ? state.products.map((p, i) => productCard(p, i)).join('') : `
            <div class="onb-banner info"><span>💊</span><div>Aún no agregas productos. Toca el botón de abajo para capturar uno.</div></div>
          `}
        </div>

        <div class="onb-section">
          <button type="button" id="onb-prod-add" class="onb-btn onb-btn-next" style="width:100%;">
            <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
            Agregar producto
          </button>
        </div>
      </div>
    `);

    wrap.querySelectorAll('[data-prod-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.prodDel);
        const item = state.products[idx];
        if (item && item._serverId && state.onboardingId) {
          try { await API.delete(`/pharmacy-onboarding/${state.onboardingId}/products/${item._serverId}`); }
          catch (e) { console.warn('product delete failed', e); }
        }
        state.products.splice(idx, 1);
        refresh();
      });
    });

    wrap.querySelector('#onb-prod-add').addEventListener('click', () => openProductForm(state, refresh));

    return wrap;
  }

  function productCard(p, idx) {
    const diff = (p.price_pharmacy != null && p.price_marzam != null)
      ? (Number(p.price_pharmacy) - Number(p.price_marzam))
      : null;
    const diffLabel = diff == null ? '' :
      `<span style="color:${diff > 0 ? '#059669' : (diff < 0 ? '#b91c1c' : '#64748b')}; font-weight:800;">
        ${diff > 0 ? '+' : ''}$${diff.toFixed(2)}
      </span>`;
    return `
      <div class="onb-doc uploaded" style="background:#fff;">
        <div class="onb-doc-head">
          <div class="onb-doc-num">${idx + 1}</div>
          <div class="onb-doc-name">
            ${escapeHtml(p.product_name)}
            ${p.presentation ? `<span style="font-weight:500; color:#64748b; font-size:12px;"> · ${escapeHtml(p.presentation)}</span>` : ''}
          </div>
          <button type="button" data-prod-del="${idx}" style="background:none; border:0; cursor:pointer; color:#94a3b8; font-size:20px;">✕</button>
        </div>
        <div style="display:grid; grid-template-columns:1fr 1fr auto; gap:8px; align-items:center; font-size:13px;">
          <div>
            <div style="font-size:10px; font-weight:700; color:#64748b; text-transform:uppercase;">Precio Farmacia</div>
            <div style="font-weight:800; color:#0f172a;">${p.price_pharmacy != null ? '$' + Number(p.price_pharmacy).toFixed(2) : '—'}</div>
          </div>
          <div>
            <div style="font-size:10px; font-weight:700; color:#c2410c; text-transform:uppercase;">Precio Marzam</div>
            <div style="font-weight:800; color:#c2410c;">${p.price_marzam != null ? '$' + Number(p.price_marzam).toFixed(2) : '—'}</div>
          </div>
          <div style="text-align:right;">${diffLabel}</div>
        </div>
        ${p.notes ? `<div style="font-size:12px; color:#64748b; margin-top:4px;">${escapeHtml(p.notes)}</div>` : ''}
      </div>
    `;
  }

  function openProductForm(state, refresh) {
    const root = document.querySelector('.onb-shell');
    const overlay = el(`
      <div class="onb-confirm-mask">
        <div class="onb-confirm-card" style="max-width:420px;">
          <h3>Agregar producto</h3>
          <label class="onb-field">
            <span class="onb-label">Nombre del producto *</span>
            <input class="onb-input" id="pf-name" placeholder="Ej. Paracetamol 500mg">
          </label>
          <label class="onb-field">
            <span class="onb-label">Presentación <span class="opt">(opcional)</span></span>
            <input class="onb-input" id="pf-pres" placeholder="Ej. Caja 30 tabs">
          </label>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:14px;">
            <label class="onb-field" style="margin:0;">
              <span class="onb-label">Precio Farmacia</span>
              <input class="onb-input" id="pf-pp" type="number" inputmode="decimal" step="0.01" placeholder="0.00">
            </label>
            <label class="onb-field" style="margin:0;">
              <span class="onb-label" style="color:#c2410c;">Precio Marzam</span>
              <input class="onb-input" id="pf-pm" type="number" inputmode="decimal" step="0.01" placeholder="0.00">
            </label>
          </div>
          <label class="onb-field">
            <span class="onb-label">Notas <span class="opt">(opcional)</span></span>
            <textarea class="onb-textarea" id="pf-notes" placeholder="Cualquier observación"></textarea>
          </label>
          <div class="onb-confirm-actions">
            <button type="button" class="onb-btn onb-btn-back" data-cancel>Cancelar</button>
            <button type="button" class="onb-btn onb-btn-next" data-save>Guardar</button>
          </div>
        </div>
      </div>
    `);
    root.appendChild(overlay);

    overlay.querySelector('[data-cancel]').addEventListener('click', () => overlay.remove());
    overlay.querySelector('[data-save]').addEventListener('click', async () => {
      const name = overlay.querySelector('#pf-name').value.trim();
      if (!name) { window.MarzamToast?.show('Nombre del producto es requerido', 'error'); return; }
      const payload = {
        product_name: name,
        presentation: overlay.querySelector('#pf-pres').value.trim() || null,
        price_pharmacy: overlay.querySelector('#pf-pp').value || null,
        price_marzam: overlay.querySelector('#pf-pm').value || null,
        notes: overlay.querySelector('#pf-notes').value.trim() || null,
      };
      // Asegurar que existe el draft.
      try { await ensureDraft(state); } catch (err) {
        window.MarzamToast?.show('No se pudo guardar el borrador', 'error');
        return;
      }
      try {
        const created = await API.post(`/pharmacy-onboarding/${state.onboardingId}/products`, payload);
        state.products.push({ ...payload, _serverId: created.id });
        overlay.remove();
        refresh();
      } catch (err) {
        console.error(err);
        window.MarzamToast?.show(err?.error || 'Error al guardar el producto', 'error');
      }
    });
  }

  function renderReview(state, refresh) {
    const wrap = el(`
      <div>
        <h2 class="onb-step-title">Confirma y envía</h2>
        <p class="onb-step-sub">Esto se enviará a Datamaster por correo y quedará registrado.</p>

        <div class="onb-summary onb-section">
          <div class="onb-summary-row"><span class="k">Tipo</span><span class="v">${state.persona_tipo === 'moral' ? 'Persona Moral' : 'Persona Física'}</span></div>
          <div class="onb-summary-row"><span class="k">Pago</span><span class="v">${state.forma_pago === 'credito' ? 'Crédito (req. aprobación)' : 'Efectivo'}</span></div>
          <div class="onb-summary-row"><span class="k">RFC</span><span class="v">${escapeHtml(state.rfc) || '—'}</span></div>
          <div class="onb-summary-row"><span class="k">Razón social</span><span class="v">${escapeHtml(state.razon_social) || '—'}</span></div>
          <div class="onb-summary-row"><span class="k">Nombre comercial</span><span class="v">${escapeHtml(state.nombre_comercial) || '—'}</span></div>
          <div class="onb-summary-row"><span class="k">Contacto</span><span class="v">${escapeHtml(state.contact_name) || '—'}${state.contact_phone ? ' · '+escapeHtml(state.contact_phone) : ''}</span></div>
          <div class="onb-summary-row"><span class="k">Dirección</span><span class="v">${escapeHtml(state.address) || '—'}</span></div>
          <div class="onb-summary-row"><span class="k">Coordenadas</span><span class="v">${state.lat ? state.lat.toFixed(5)+', '+state.lng.toFixed(5) : '— sin GPS —'}</span></div>
          <div class="onb-summary-row"><span class="k">Documentos</span><span class="v">${Object.keys(state.uploaded).length} subidos</span></div>
          <div class="onb-summary-row"><span class="k">Productos</span><span class="v">${state.products.length} capturado(s)</span></div>
        </div>

        ${state.forma_pago === 'credito' ? `
          <div class="onb-banner warn onb-section">
            <span>📋</span>
            <div>Al ser pago a crédito, esta alta queda <b>pendiente de aprobación</b>. Tú o tu supervisor deben confirmar la decisión más adelante.</div>
          </div>
        ` : `
          <div class="onb-banner ok onb-section">
            <span>✅</span>
            <div>Al ser pago en efectivo, la aprobación es prácticamente inmediata.</div>
          </div>
        `}
      </div>
    `);
    return wrap;
  }

  // ──────────────────────────────────────────────────────────
  // Backend ops
  // ──────────────────────────────────────────────────────────
  async function loadSpec(state) {
    try {
      const spec = await API.get('/pharmacy-onboarding/spec');
      state.spec = { ...DEFAULT_SPEC, ...spec };
    } catch { /* usar defaults */ }
  }

  async function ensureDraft(state) {
    if (state.onboardingId) {
      // patch los datos actuales
      try {
        await API.patch(`/pharmacy-onboarding/${state.onboardingId}`, currentPayload(state));
      } catch (err) { console.warn('patch draft failed', err); }
      return { id: state.onboardingId };
    }
    const draft = await API.post('/pharmacy-onboarding', {
      ...currentPayload(state),
      not_in_directory: !!state.not_in_directory,
    });
    state.onboardingId = draft.id;
    return draft;
  }

  function currentPayload(state) {
    return {
      not_in_directory: !!state.not_in_directory,
      dataplor_id: state.dataplor_id || null,
      persona_tipo: state.persona_tipo || null,
      forma_pago: state.forma_pago || null,
      rfc: state.rfc || null,
      razon_social: state.razon_social || null,
      nombre_comercial: state.nombre_comercial || null,
      contact_name: state.contact_name || null,
      contact_phone: state.contact_phone || null,
      contact_email: state.contact_email || null,
      address: state.address || null,
      notes: state.notes || null,
      lat: state.lat,
      lng: state.lng,
    };
  }

  async function submit(state) {
    await ensureDraft(state); // patch reciente
    const result = await API.post(`/pharmacy-onboarding/${state.onboardingId}/submit`, {});
    return result;
  }

  // ──────────────────────────────────────────────────────────
  // Validación per step (gate del botón Siguiente)
  // ──────────────────────────────────────────────────────────
  function canAdvance(state, stepId) {
    switch (stepId) {
      case 'intro':              return state.not_in_directory === true || state.candidate_pharmacy_id != null;
      case 'no_exists_confirm':  return true;
      case 'persona':            return !!state.persona_tipo;
      case 'pago':               return !!state.forma_pago;
      case 'datos':              return state.razon_social || state.nombre_comercial;
      case 'docs': {
        const docs = state.persona_tipo === 'moral' ? state.spec.docs_moral : state.spec.docs_fisica;
        return docs.every((d) => state.uploaded[d.type]);
      }
      case 'facade': {
        const facade = state.not_in_directory ? state.spec.facade_not_found : state.spec.facade_found;
        return facade.every((d) => state.uploaded[d.type]);
      }
      case 'productos':          return true;
      case 'review':             return true;
      default:                   return true;
    }
  }

  function blockReason(state, stepId) {
    switch (stepId) {
      case 'intro': return 'Elige un candidato cercano o marca "No está en la lista"';
      case 'persona': return 'Elige persona física o moral';
      case 'pago': return 'Elige forma de pago';
      case 'datos': return 'Captura al menos razón social o nombre comercial';
      case 'docs': return 'Sube todos los documentos requeridos';
      case 'facade': return state.not_in_directory
        ? 'Necesitamos las 3 fotos (izquierda, frente, derecha)'
        : 'Necesitamos la foto de fachada';
      default: return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Mount
  // ──────────────────────────────────────────────────────────
  function open() {
    if (!canUseWizard()) {
      window.MarzamToast?.show('El alta de farmacia nueva está disponible solo para Supervisores y Representantes.', 'error');
      return;
    }

    const state = makeState();

    // GPS en background
    geolocate().then((g) => { if (g) Object.assign(state, g); });

    // Spec del backend
    loadSpec(state);

    const root = el(`
      <div class="onb-backdrop" role="dialog" aria-modal="true">
        <div class="onb-shell">
          <div class="onb-header">
            <div style="flex:1; min-width:0;">
              <h2>Alta de farmacia nueva</h2>
              <p>Asistente paso a paso</p>
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

    const body = root.querySelector('.onb-body');
    const progress = root.querySelector('.onb-progress');
    const btnBack = root.querySelector('.onb-btn-back');
    const btnNext = root.querySelector('.onb-btn-next');
    const btnClose = root.querySelector('.onb-close');

    function close() {
      // Si hay un draft, lo dejamos en el backend para que el rep pueda retomarlo después.
      root.remove();
    }

    btnClose.addEventListener('click', () => {
      askConfirm(root, '¿Cerrar el asistente?', 'El borrador queda guardado y puedes retomarlo después desde "Mis altas".', () => close());
    });

    function refresh() {
      const steps = buildSteps(state);
      // Clamp stepIndex (la lista cambia cuando not_in_directory cambia)
      if (state.stepIndex >= steps.length) state.stepIndex = steps.length - 1;
      const current = steps[state.stepIndex];

      // Progress bar
      progress.innerHTML = steps.map((_, i) =>
        `<span class="${i < state.stepIndex ? 'done' : (i === state.stepIndex ? 'active' : '')}"></span>`
      ).join('');

      // Body
      body.innerHTML = '';
      let view;
      switch (current.id) {
        case 'intro':              view = renderIntro(state, refresh); break;
        case 'no_exists_confirm':  view = renderNoExistsConfirm(state, refresh); break;
        case 'persona':            view = renderPersona(state, refresh); break;
        case 'pago':                view = renderPago(state, refresh); break;
        case 'datos':              view = renderDatos(state, refresh); break;
        case 'docs': {
          const items = state.persona_tipo === 'moral' ? state.spec.docs_moral : state.spec.docs_fisica;
          view = renderDocList(state, refresh, items, {
            title: state.persona_tipo === 'moral' ? 'Documentos de Persona Moral' : 'Documentos de Persona Física',
            subtitle: 'Toma una foto clara de cada documento. Puedes usar la cámara o subirla desde tu galería.',
          });
          break;
        }
        case 'facade': {
          const items = state.not_in_directory ? state.spec.facade_not_found : state.spec.facade_found;
          view = renderDocList(state, refresh, items, {
            title: state.not_in_directory ? 'Verifica que no existe (3 fotos)' : 'Foto de fachada',
            subtitle: state.not_in_directory
              ? 'Toma una foto a tu izquierda, otra al frente y otra a tu derecha. Las 3 son obligatorias.'
              : 'Toma una foto de la fachada de la farmacia.',
          });
          break;
        }
        case 'productos':          view = renderProductos(state, refresh); break;
        case 'review':             view = renderReview(state, refresh); break;
        default: view = el('<div></div>');
      }
      body.appendChild(view);

      // Footer state
      btnBack.disabled = state.stepIndex === 0;
      const isLast = current.id === 'review';
      btnNext.textContent = isLast ? 'Enviar alta' : 'Siguiente';
      const ok = canAdvance(state, current.id);
      btnNext.disabled = !ok;
      btnNext.classList.toggle('onb-btn-danger', false);
    }

    btnBack.addEventListener('click', () => {
      if (state.stepIndex > 0) { state.stepIndex -= 1; refresh(); }
    });

    btnNext.addEventListener('click', async () => {
      const steps = buildSteps(state);
      const current = steps[state.stepIndex];
      const reason = blockReason(state, current.id);
      if (!canAdvance(state, current.id)) {
        if (reason) window.MarzamToast?.show(reason, 'error');
        return;
      }

      // Cuando salimos de "datos" o más adelante, sincronizamos el draft.
      if (['persona', 'pago', 'datos'].includes(current.id)) {
        try { await ensureDraft(state); } catch (err) {
          console.error(err);
          window.MarzamToast?.show('No se pudo guardar el borrador', 'error');
          return;
        }
      }

      if (current.id === 'review') {
        btnNext.disabled = true;
        btnNext.textContent = 'Enviando...';
        try {
          const result = await submit(state);
          renderSuccess(root, result, close);
        } catch (err) {
          console.error(err);
          window.MarzamToast?.show(err?.error || 'Error al enviar el alta', 'error');
          btnNext.disabled = false;
          btnNext.textContent = 'Enviar alta';
        }
        return;
      }
      state.stepIndex += 1;
      refresh();
    });

    refresh();
  }

  function renderSuccess(root, result, close) {
    const onb = result?.onboarding || {};
    const mailOk = result?.mail?.status === 'sent';
    const credit = onb.requires_credit_approval;
    const html = `
      <div class="onb-confirm-card" style="max-width:420px;">
        <div style="font-size:48px; text-align:center; margin-bottom:6px;">${credit ? '⏳' : '🎉'}</div>
        <h3 style="text-align:center;">${credit ? 'Alta enviada · revisión de crédito' : 'Alta enviada y aprobada'}</h3>
        <p style="text-align:center;">
          ${credit
            ? 'La farmacia entró al flujo de aprobación de crédito. Recibirás una notificación al cerrarse la decisión.'
            : 'La aprobación es inmediata por ser pago en efectivo.'}
        </p>
        <p style="text-align:center; font-size:11px; color:${mailOk ? '#059669' : '#92400e'}; margin-top:10px;">
          Correo a Datamaster: ${mailOk ? '✓ enviado' : '⚠ pendiente — quedó en cola para reintento'}
        </p>
        <div class="onb-confirm-actions" style="grid-template-columns:1fr;">
          <button type="button" class="onb-btn onb-btn-next">Listo</button>
        </div>
      </div>
    `;
    const overlay = el(`<div class="onb-confirm-mask">${html}</div>`);
    root.querySelector('.onb-shell').appendChild(overlay);
    overlay.querySelector('button').addEventListener('click', () => close());
  }

  function askConfirm(root, title, body, onYes) {
    const overlay = el(`
      <div class="onb-confirm-mask">
        <div class="onb-confirm-card">
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(body)}</p>
          <div class="onb-confirm-actions">
            <button type="button" class="onb-btn onb-btn-back" data-no>No</button>
            <button type="button" class="onb-btn onb-btn-next" data-yes>Sí</button>
          </div>
        </div>
      </div>
    `);
    root.querySelector('.onb-shell').appendChild(overlay);
    overlay.querySelector('[data-no]').addEventListener('click', () => overlay.remove());
    overlay.querySelector('[data-yes]').addEventListener('click', () => { overlay.remove(); onYes(); });
  }

  // ──────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────
  window.MarzamOnboarding = {
    canUseWizard,
    openWizard: open,
    ALLOWED_ROLES,
  };
})();
