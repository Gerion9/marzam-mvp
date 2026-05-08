/* =============================================================
   Marzam UI Components — small HTML helpers used across renderers.
   Pure functions returning string templates (no DOM mutation here).
   Plus a Spanish title-case utility for displaying pharmacy names
   that arrive as MAYÚSCULAS from the source data.

   Phase 5 of the redesign (post-Phases 1–4) — extracted after we
   saw which patterns actually repeated. See refactored-imagining-papert.md.
   ============================================================= */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────
  // Spanish title-case for display (data is preserved as-is in storage).
  //
  // Rules:
  //   - Each word is lowercased then capitalized first letter (PT-style).
  //   - Spanish stopwords (de, del, la, los, las, y, e, o, con, sin, por,
  //     a, al, en) stay lowercase EXCEPT when first word.
  //   - Letters with combining accents (N̄, Ñ) are preserved.
  //   - Preserves existing accents (FÁRMACIA → Fármacia).
  //   - Numbers and ampersands pass through.
  //
  // Memoized via WeakMap-keyed string cache to keep ~3,000 pharmacy names
  // cheap on render.
  // ──────────────────────────────────────────────────────────
  const STOPWORDS = new Set([
    'de', 'del', 'la', 'las', 'los', 'el',
    'y', 'e', 'o', 'u',
    'con', 'sin', 'por', 'para',
    'a', 'al', 'en',
  ]);
  const TITLE_CACHE = new Map();
  const CACHE_LIMIT = 4096;

  function titleCaseEs(input) {
    if (!input) return '';
    if (typeof input !== 'string') return String(input);
    if (TITLE_CACHE.has(input)) return TITLE_CACHE.get(input);
    // Skip already mixed-case strings (data was clean).
    if (/[a-z]/.test(input) && /[A-Z]/.test(input)) {
      _cacheAdd(input, input);
      return input;
    }
    const lower = input.toLowerCase();
    const words = lower.split(/(\s+|[/\-,])/);
    const out = words.map((w, i) => {
      if (!w || /^\s+$/.test(w) || /^[\/\-,]$/.test(w)) return w;
      // Stopwords stay lowercase unless they're the first word of the string.
      if (i > 0 && STOPWORDS.has(w)) return w;
      // Capitalize first character (handles accented letters too).
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join('');
    _cacheAdd(input, out);
    return out;
  }

  function _cacheAdd(k, v) {
    if (TITLE_CACHE.size >= CACHE_LIMIT) {
      // Drop the oldest 25% to keep the cache bounded.
      const drop = Math.floor(CACHE_LIMIT * 0.25);
      let i = 0;
      for (const key of TITLE_CACHE.keys()) {
        TITLE_CACHE.delete(key);
        if (++i >= drop) break;
      }
    }
    TITLE_CACHE.set(k, v);
  }

  // ──────────────────────────────────────────────────────────
  // KPI card — used by Mis rutas hero stats and Rep scorecard.
  // {value, label, color?: 'slate'|'emerald'|'amber'|'rose'|'orange'}
  // ──────────────────────────────────────────────────────────
  function kpiCard({ value, label, color = 'slate', sub = null }) {
    const safeValue = String(value == null ? '—' : value);
    const safeLabel = String(label || '');
    return `
      <div class="bg-white border border-slate-200 rounded-2xl p-3 text-center shadow-sm">
        <div class="text-2xl font-black text-${color}-700 tabular-nums">${escapeHtml(safeValue)}</div>
        <div class="text-[10px] font-bold uppercase tracking-wider text-slate-400 mt-0.5">${escapeHtml(safeLabel)}</div>
        ${sub ? `<div class="text-[10px] text-slate-500 mt-1">${escapeHtml(sub)}</div>` : ''}
      </div>
    `;
  }

  // ──────────────────────────────────────────────────────────
  // Empty state — single component to replace the 5+ inline patterns
  // ("Sin datos", "Sin visitas en el período", "Tu cascada está vacía").
  // ──────────────────────────────────────────────────────────
  function emptyState({ icon, title, message, cta = null, ctaHandler = null }) {
    const ctaHtml = cta
      ? `<button type="button" class="mt-3 btn btn-primary text-xs py-1.5 px-3"${ctaHandler ? ` data-empty-cta="${escapeHtml(ctaHandler)}"` : ''}>${escapeHtml(cta)}</button>`
      : '';
    return `
      <div class="text-center py-8 px-4">
        ${icon ? `<div class="text-3xl mb-2">${icon}</div>` : ''}
        ${title ? `<p class="text-sm font-bold text-slate-700">${escapeHtml(title)}</p>` : ''}
        ${message ? `<p class="text-xs text-slate-500 mt-1">${escapeHtml(message)}</p>` : ''}
        ${ctaHtml}
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Expose globally — used by views.js, my-route.js, marzam-analytics-ext.js.
  window.MarzamUI = {
    titleCaseEs,
    kpiCard,
    emptyState,
  };
  // Convenience: prettyName(pharmacy) returns the title-cased name.
  window.MarzamUI.prettyName = function prettyName(p) {
    if (!p) return '';
    if (typeof p === 'string') return titleCaseEs(p);
    return titleCaseEs(p.farmacia_nombre || p.name || p.pharmacy_name || '');
  };
})();
