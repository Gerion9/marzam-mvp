/**
 * Ecatepec Match Analysis — offline, precision-first, hybrid.
 *
 * Reads 192 Marzam-Ecatepec pharmacies from the Excel file and
 * 1,903 POIs from ingestion.ing_poi_farmacias_ecatepec, then runs
 * multiple matching strategies and reports safe-match-rate metrics.
 *
 * Usage:  node scripts/match-ecatepec-analysis.js [--out results.json]
 */

const path = require('path');
const XLSX = require('xlsx');
const knex = require('../src/config/database');

// ─────────────────────────────────────────────
// 1. EXTRACTION HELPERS
// ─────────────────────────────────────────────

function loadMarzamEcatepec() {
  const filePath = path.resolve(__dirname, '..', 'data', 'Clientes de arranque y pareto.xlsx');
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['CLIENTES VENTA (2)'];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1 });

  const headerIdx = raw.findIndex(
    (r) => String(r[0] || '').trim() === 'Gerencia' && String(r[3] || '').trim() === 'CuentaMostrador',
  );
  if (headerIdx < 0) throw new Error('Cannot find header row in CLIENTES VENTA (2)');

  const rows = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    const gerencia = String(r[0] || '').trim();
    if (!gerencia || gerencia === 'Gerencia') continue;

    const municipio = String(r[7] || '').trim().toUpperCase();
    if (!municipio.includes('ECATEPEC')) continue;

    rows.push({
      cuenta: String(r[3] || '').trim(),
      padre: r[4] != null ? String(r[4]).trim() : null,
      cadena: r[5] != null ? String(r[5]).trim() : null,
      nombre: String(r[6] || '').trim(),
      municipio,
      pareto: String(r[10] || '').trim(),
    });
  }
  return rows;
}

async function loadPois() {
  const result = await knex.raw(`
    SELECT
      name,
      address,
      neighborhood,
      chain_name_clean,
      chain_classification,
      latitude,
      longitude,
      data_quality_confidence_score AS dq_score,
      validity_score,
      phone
    FROM ingestion.ing_poi_farmacias_ecatepec
  `);
  return result.rows;
}

// ─────────────────────────────────────────────
// 2. NORMALIZATION RULES
// ─────────────────────────────────────────────

const STOPWORDS = new Set([
  'DE', 'DEL', 'LA', 'LAS', 'EL', 'LOS', 'Y', 'E', 'EN', 'CON', 'A',
]);

const PHARMACY_PREFIXES = [
  'CONSULTORIO MEDICO Y FARMACIA',
  'CONSULTORIO MEDICO FARMACIA',
  'CONSULTORIO MEDICO Y',
  'CONSULTORIO MEDICO',
  'CONSULTORIO DENTAL Y FARMACIA',
  'CONSULTORIO Y FARMACIA',
  'CONSULTORIO FARMACIA',
  'CONSULTORIO DE ESPECIALIDADES Y FARMACIA',
  'CONSULTORIO DE ENFERMERIA Y FARMACIA',
  'FARMACIAS',
  'FARMACIA ALOPATICA',
  'FARMACIA GENERICOS INTERCAMBIABLES',
  'FARMACIA GENERICOS DE MARCA',
  'FARMACIA GENERICOS Y SIMILARES',
  'FARMACIA GENERICOS',
  'FARMACIA',
  'FARMACI',
  'FARMA',
];

const LEGAL_SUFFIXES = [
  'SA DE CV', 'S.A. DE C.V.', 'S.A. DE C.V', 'S A DE C V',
  'S DE RL DE CV', 'S DE RL',
];

const CHAIN_CROSSWALK = {
  FARMAPRONTO: ['FARMAPRONTO'],
  FRADONI: ['FRADONI'],
  SANTOYO: ['SANTOYO'],
  INTERFARM: ['INTERFARM', 'INTERFAR'],
  'GRUPO FARMA AZTECA': ['FARMA AZTECA'],
  'GRUPO SAN JUAN': ['SAN JUAN'],
  'NUEVA SAN JUAN': ['NUEVA SAN JUAN'],
  'HIPER FARM': ['HIPER FARM', 'HIPERFARM'],
  UFARMICH: ['UFARMICH', 'URUAPAN', 'UNION DE FARMACEUTICOS'],
  URUAPAN: ['URUAPAN', 'UFARMICH'],
  TRADICIONALES: [],
  'GRUPO ALMONTE': ['ALMONTE'],
  FARMAVIDA: ['FARMAVIDA', 'VITA'],
  OTUMBA: ['OTUMBA'],
  'GRUPO FARMAFE': ['FARMAFE'],
  'MEGA DISTRIBUCION 24 HORAS': ['MEGA'],
  'FARMACIAS INTEGRALES   (CANACO)': ['CANACO', 'INTEGRALES'],
  'GRUPO SAN JUAN': ['SAN JUAN'],
};

function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeBase(raw) {
  if (!raw) return '';
  let s = stripAccents(String(raw)).toUpperCase().trim();
  s = s.replace(/[^A-Z0-9\s]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function stripLegalSuffix(s) {
  let out = s;
  for (const sfx of LEGAL_SUFFIXES) {
    const norm = normalizeBase(sfx);
    if (out.endsWith(norm)) {
      out = out.slice(0, -norm.length).trim();
    }
  }
  return out;
}

function stripPharmacyPrefix(s) {
  let out = s;
  for (const pfx of PHARMACY_PREFIXES) {
    const norm = normalizeBase(pfx);
    if (out.startsWith(norm + ' ')) {
      out = out.slice(norm.length).trim();
      break;
    }
    if (out === norm) {
      out = '';
      break;
    }
  }
  return out;
}

function extractCore(raw) {
  let s = normalizeBase(raw);
  s = stripLegalSuffix(s);
  s = stripPharmacyPrefix(s);
  s = s.replace(/\bSUCURSAL\b.*/, '').trim();
  s = s.replace(/\bSUC\b.*/, '').trim();
  return s;
}

function tokenize(s) {
  return normalizeBase(s)
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function tokenizeCore(s) {
  return extractCore(s)
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// ─────────────────────────────────────────────
// 3. FLAGS / PENALTIES
// ─────────────────────────────────────────────

const COMMON_FIRST_NAMES = new Set([
  'JOSE', 'JUAN', 'MARIA', 'CARLOS', 'MIGUEL', 'ANGEL', 'FRANCISCO', 'JAVIER',
  'PEDRO', 'LUIS', 'ANTONIO', 'MANUEL', 'RAFAEL', 'JESUS', 'ARMANDO', 'EDUARDO',
  'SERGIO', 'NORMA', 'GUADALUPE', 'ANGELICA', 'LORENA', 'PERLA', 'KARINA',
  'PRIMITIVO', 'DIONICIO', 'ANDRES', 'MARTIN', 'ALEJANDRO', 'ARTURO',
]);

const COMMON_LAST_NAMES = new Set([
  'GARCIA', 'HERNANDEZ', 'LOPEZ', 'MARTINEZ', 'GONZALEZ', 'RODRIGUEZ', 'PEREZ',
  'SANCHEZ', 'RAMIREZ', 'TORRES', 'FLORES', 'REYES', 'MORALES', 'CRUZ', 'GOMEZ',
  'DIAZ', 'ORTIZ', 'GUERRERO', 'MENDOZA', 'RUIZ', 'AGUILAR', 'SOLIS', 'CAMPERO',
  'NOLASCO', 'ESTEVEZ', 'OROSCO', 'ZARCO', 'ESQUIVEL', 'TELLEZ', 'SAUCEDO',
  'ESPINOSA', 'TABOADA', 'URIBE', 'CORREA', 'MONTIEL', 'TREJO', 'GALEANA',
  'NIETO', 'AVINA',
]);

const GENERIC_CORES = new Set([
  '', 'FARMACIA', 'FARMACIAS', 'CONSULTORIO', 'GENERICOS', 'MEDICAMENTOS',
]);

function isLikelyPersonName(nombre) {
  const tokens = tokenize(nombre);
  if (tokens.length < 2) return false;
  const hasFirst = tokens.some((t) => COMMON_FIRST_NAMES.has(t));
  const hasLast = tokens.some((t) => COMMON_LAST_NAMES.has(t));
  return hasFirst && hasLast;
}

function isLegalEntity(nombre) {
  const up = normalizeBase(nombre);
  return LEGAL_SUFFIXES.some((sfx) => {
    const norm = normalizeBase(sfx);
    const idx = up.indexOf(norm);
    if (idx < 0) return false;
    const after = idx + norm.length;
    return after >= up.length || up[after] === ' ';
  });
}

function isGenericCore(nombre) {
  const core = extractCore(nombre);
  return GENERIC_CORES.has(core);
}

const AMBIGUOUS_CORES = new Set([
  'SAN JUAN', 'SAN JOSE', 'SAN ANTONIO', 'SAN MIGUEL', 'SAN FRANCISCO',
  'GUADALUPE', 'LUPITA', 'ROSARIO', 'JAZMIN', 'MIMI', 'DANI', 'SARITA',
  'ANDREA', 'ANGELICA', 'FLORIDA', 'EDITH', 'LAURA', 'DIANA',
  'ANA MARIA', 'MARIA', 'JESUS', 'CRISTO REY', 'SAGRADO CORAZON',
  'SAN ISIDRO', 'SANTA MARIA', 'SAN CARLOS',
]);

function isAmbiguousCore(nombre) {
  const core = extractCore(nombre);
  return AMBIGUOUS_CORES.has(core) || core.length <= 3;
}

// ─────────────────────────────────────────────
// 4. SIMILARITY METRICS
// ─────────────────────────────────────────────

function trigrams(s) {
  const padded = `  ${s} `;
  const set = new Set();
  for (let i = 0; i <= padded.length - 3; i++) {
    set.add(padded.slice(i, i + 3));
  }
  return set;
}

function trigramSimilarity(a, b) {
  if (!a || !b) return 0;
  const sa = trigrams(a);
  const sb = trigrams(b);
  let intersection = 0;
  for (const t of sa) {
    if (sb.has(t)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenJaccard(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setB = new Set(tokensB);
  let inter = 0;
  for (const t of tokensA) {
    if (setB.has(t)) inter++;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : inter / union;
}

function containsDistinctiveToken(coreTokensA, coreTokensB) {
  if (!coreTokensA.length || !coreTokensB.length) return false;
  const setB = new Set(coreTokensB);
  return coreTokensA.some((t) => t.length >= 4 && setB.has(t));
}

function chainCrosswalkMatch(marzamCadena, poiName) {
  if (!marzamCadena) return false;
  const key = normalizeBase(marzamCadena);
  const patterns = CHAIN_CROSSWALK[marzamCadena.trim()] || CHAIN_CROSSWALK[key];
  if (!patterns || !patterns.length) return false;
  const poiNorm = normalizeBase(poiName);
  return patterns.some((p) => poiNorm.includes(normalizeBase(p)));
}

// ─────────────────────────────────────────────
// 5. SCORING STRATEGIES
// ─────────────────────────────────────────────

function scoreExactNormalized(mz, poi) {
  const mzNorm = normalizeBase(mz.nombre);
  const poiNorm = normalizeBase(poi.name);
  if (mzNorm === poiNorm) return 1.0;

  const mzCore = extractCore(mz.nombre);
  const poiCore = extractCore(poi.name);
  if (mzCore && poiCore && mzCore === poiCore) return 0.95;

  return 0;
}

function scoreTrigramOnly(mz, poi) {
  const mzNorm = normalizeBase(mz.nombre);
  const poiNorm = normalizeBase(poi.name);
  return trigramSimilarity(mzNorm, poiNorm);
}

function scoreTokenCoreRules(mz, poi) {
  const mzCoreTokens = tokenizeCore(mz.nombre);
  const poiCoreTokens = tokenizeCore(poi.name);
  const jaccard = tokenJaccard(mzCoreTokens, poiCoreTokens);
  const hasDistinctive = containsDistinctiveToken(mzCoreTokens, poiCoreTokens);
  const coreSim = trigramSimilarity(extractCore(mz.nombre), extractCore(poi.name));

  let score = 0;
  if (jaccard >= 0.8) score = 0.9;
  else if (jaccard >= 0.5 && hasDistinctive) score = 0.75;
  else if (coreSim >= 0.7) score = 0.7;
  else if (hasDistinctive) score = 0.5;
  else score = Math.max(jaccard, coreSim) * 0.6;

  return score;
}

function scoreEnsemble(mz, poi) {
  const fullNorm_mz = normalizeBase(mz.nombre);
  const fullNorm_poi = normalizeBase(poi.name);
  const core_mz = extractCore(mz.nombre);
  const core_poi = extractCore(poi.name);
  const tokMz = tokenizeCore(mz.nombre);
  const tokPoi = tokenizeCore(poi.name);

  const simFull = trigramSimilarity(fullNorm_mz, fullNorm_poi);
  const simCore = trigramSimilarity(core_mz, core_poi);
  const jaccard = tokenJaccard(tokMz, tokPoi);
  const chainMatch = chainCrosswalkMatch(mz.cadena, poi.name) ? 1.0 : 0;

  let penalty = 0;
  if (isLikelyPersonName(mz.nombre)) penalty += 0.15;
  if (isGenericCore(mz.nombre)) penalty += 0.25;
  if (isAmbiguousCore(mz.nombre)) penalty += 0.10;
  if (isLegalEntity(mz.nombre) && extractCore(mz.nombre).length < 3) penalty += 0.05;

  const poiQuality = Math.min((poi.validity_score || 0.3) + (poi.dq_score || 0.5), 1.0);
  const qualityBonus = (poiQuality - 0.5) * 0.1;

  const raw = simFull * 0.35
    + simCore * 0.20
    + jaccard * 0.20
    + chainMatch * 0.15
    + qualityBonus;

  return Math.max(0, Math.min(1, raw - penalty));
}

const STRATEGIES = {
  exact_normalized: scoreExactNormalized,
  trigram_only: scoreTrigramOnly,
  token_core_rules: scoreTokenCoreRules,
  ensemble_precision: scoreEnsemble,
};

// ─────────────────────────────────────────────
// 6. CANDIDATE GENERATION (blocking + top-k)
// ─────────────────────────────────────────────

function generateCandidates(mz, pois, strategyFn, topK = 5) {
  const candidates = [];

  for (const poi of pois) {
    const mzTokens = tokenizeCore(mz.nombre);
    const poiTokens = tokenizeCore(poi.name);
    const hasTokenOverlap = mzTokens.some((t) => t.length >= 3 && poiTokens.some((pt) => pt === t));
    const hasChainMatch = chainCrosswalkMatch(mz.cadena, poi.name);

    if (!hasTokenOverlap && !hasChainMatch) {
      const quickSim = trigramSimilarity(normalizeBase(mz.nombre), normalizeBase(poi.name));
      if (quickSim < 0.15) continue;
    }

    const score = strategyFn(mz, poi);
    if (score > 0.05) {
      candidates.push({ poi, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topK);
}

// ─────────────────────────────────────────────
// 7. BUCKET CLASSIFICATION
// ─────────────────────────────────────────────

function classifyMatch(mz, topCandidates) {
  if (!topCandidates.length) return { bucket: 'reject', reason: 'no_candidates' };

  const top1 = topCandidates[0];
  const top2 = topCandidates[1];
  const margin = top2 ? top1.score - top2.score : 1.0;

  const flags = [];
  if (isLikelyPersonName(mz.nombre)) flags.push('person_name');
  if (isGenericCore(mz.nombre)) flags.push('generic_core');
  if (isAmbiguousCore(mz.nombre)) flags.push('ambiguous_core');
  if (isLegalEntity(mz.nombre)) flags.push('legal_entity');

  const hasGraveFlag = flags.includes('person_name') || flags.includes('generic_core');

  // Near-identical names (score >= 0.70) with clear separation
  if (top1.score >= 0.70 && margin >= 0.15 && !hasGraveFlag) {
    return { bucket: 'auto_accept', reason: 'high_score_clear_margin', flags };
  }

  // Near-identical core but low margin due to POI duplicates (same name, different location).
  // If the core names are essentially the same string, the low margin is a data-quality
  // artifact rather than true ambiguity -- safe to accept.
  if (top1.score >= 0.70 && !hasGraveFlag && !flags.includes('ambiguous_core')) {
    const core_mz = extractCore(mz.nombre);
    const core_poi = extractCore(top1.poi.name);
    if (core_mz && core_poi && trigramSimilarity(core_mz, core_poi) >= 0.85) {
      return { bucket: 'auto_accept', reason: 'near_identical_core', flags };
    }
  }

  if (top1.score >= 0.55 && margin >= 0.10 && !hasGraveFlag) {
    return { bucket: 'auto_accept', reason: 'good_score_decent_margin', flags };
  }

  // Chain crosswalk + decent score
  if (top1.score >= 0.50 && chainCrosswalkMatch(mz.cadena, top1.poi.name) && !hasGraveFlag) {
    return { bucket: 'auto_accept', reason: 'chain_match_confirmed', flags };
  }

  if (top1.score >= 0.40 || (top1.score >= 0.30 && flags.length === 0)) {
    return { bucket: 'manual_review', reason: 'moderate_score', flags };
  }

  if (hasGraveFlag && top1.score >= 0.35) {
    return { bucket: 'manual_review', reason: 'flagged_but_possible', flags };
  }

  return { bucket: 'reject', reason: 'low_score', flags };
}

// ─────────────────────────────────────────────
// 8. MAIN ANALYSIS
// ─────────────────────────────────────────────

async function runAnalysis() {
  console.log('Loading Marzam Ecatepec data from Excel...');
  const marzam = loadMarzamEcatepec();
  console.log(`  → ${marzam.length} pharmacies loaded\n`);

  console.log('Loading POIs from database...');
  const pois = await loadPois();
  console.log(`  → ${pois.length} POIs loaded\n`);

  const strategyResults = {};

  for (const [stratName, stratFn] of Object.entries(STRATEGIES)) {
    console.log(`Running strategy: ${stratName}...`);
    const results = [];

    for (const mz of marzam) {
      const candidates = generateCandidates(mz, pois, stratFn, 5);
      const classification = classifyMatch(mz, candidates);

      results.push({
        cuenta: mz.cuenta,
        nombre_marzam: mz.nombre,
        cadena: mz.cadena,
        pareto: mz.pareto,
        flags: {
          is_person: isLikelyPersonName(mz.nombre),
          is_generic: isGenericCore(mz.nombre),
          is_ambiguous: isAmbiguousCore(mz.nombre),
          is_legal: isLegalEntity(mz.nombre),
        },
        core_marzam: extractCore(mz.nombre),
        top1_name: candidates[0]?.poi.name || null,
        top1_score: candidates[0]?.score || 0,
        top1_address: candidates[0]?.poi.address || null,
        top1_neighborhood: candidates[0]?.poi.neighborhood || null,
        top2_name: candidates[1]?.poi.name || null,
        top2_score: candidates[1]?.score || 0,
        margin: candidates.length >= 2 ? candidates[0].score - candidates[1].score : (candidates[0]?.score || 0),
        bucket: classification.bucket,
        bucket_reason: classification.reason,
        all_candidates: candidates.map((c) => ({
          name: c.poi.name,
          score: Number(c.score.toFixed(4)),
          address: c.poi.address,
          neighborhood: c.poi.neighborhood,
        })),
      });
    }

    const autoAccept = results.filter((r) => r.bucket === 'auto_accept');
    const manualReview = results.filter((r) => r.bucket === 'manual_review');
    const reject = results.filter((r) => r.bucket === 'reject');

    strategyResults[stratName] = {
      total: results.length,
      auto_accept: autoAccept.length,
      manual_review: manualReview.length,
      reject: reject.length,
      safe_match_rate: (autoAccept.length / results.length * 100).toFixed(1) + '%',
      review_rate: (manualReview.length / results.length * 100).toFixed(1) + '%',
      unmatched_rate: (reject.length / results.length * 100).toFixed(1) + '%',
      results,
    };

    console.log(`  auto_accept: ${autoAccept.length}  manual_review: ${manualReview.length}  reject: ${reject.length}`);
    console.log(`  safe_match_rate: ${strategyResults[stratName].safe_match_rate}\n`);
  }

  // ─── GOLD SAMPLE: pick representative cases for each difficulty tier ───

  const ensemble = strategyResults.ensemble_precision.results;

  const goldSample = {
    easy: ensemble
      .filter((r) => r.bucket === 'auto_accept')
      .sort((a, b) => b.top1_score - a.top1_score)
      .slice(0, 20),
    ambiguous: ensemble
      .filter((r) => r.bucket === 'manual_review')
      .sort((a, b) => b.top1_score - a.top1_score)
      .slice(0, 20),
    hard: ensemble
      .filter((r) => r.bucket === 'reject' || r.flags.is_person || r.flags.is_generic)
      .sort((a, b) => b.top1_score - a.top1_score)
      .slice(0, 20),
  };

  // ─── PRINT DETAILED REPORT ───

  console.log('\n' + '='.repeat(80));
  console.log('  STRATEGY COMPARISON SUMMARY');
  console.log('='.repeat(80));
  console.log(
    'Strategy'.padEnd(25)
    + 'Auto-Accept'.padStart(14)
    + 'Review'.padStart(10)
    + 'Reject'.padStart(10)
    + 'Safe%'.padStart(10),
  );
  console.log('-'.repeat(69));
  for (const [name, data] of Object.entries(strategyResults)) {
    console.log(
      name.padEnd(25)
      + String(data.auto_accept).padStart(14)
      + String(data.manual_review).padStart(10)
      + String(data.reject).padStart(10)
      + data.safe_match_rate.padStart(10),
    );
  }

  console.log('\n' + '='.repeat(80));
  console.log('  ENSEMBLE PRECISION-FIRST — DETAILED RESULTS');
  console.log('='.repeat(80));

  console.log('\n── AUTO-ACCEPT (' + strategyResults.ensemble_precision.auto_accept + ') ──');
  for (const r of ensemble.filter((r) => r.bucket === 'auto_accept').sort((a, b) => b.top1_score - a.top1_score)) {
    console.log(
      `  [${r.pareto}] ${r.nombre_marzam.padEnd(45)} → ${(r.top1_name || '???').padEnd(50)} score=${r.top1_score.toFixed(3)}  margin=${r.margin.toFixed(3)}  ${r.cadena || ''}`,
    );
  }

  console.log('\n── MANUAL REVIEW (' + strategyResults.ensemble_precision.manual_review + ') ──');
  for (const r of ensemble.filter((r) => r.bucket === 'manual_review').sort((a, b) => b.top1_score - a.top1_score)) {
    const flagStr = Object.entries(r.flags).filter(([, v]) => v).map(([k]) => k).join(',') || '-';
    console.log(
      `  [${r.pareto}] ${r.nombre_marzam.padEnd(45)} → ${(r.top1_name || '???').padEnd(50)} score=${r.top1_score.toFixed(3)}  flags=${flagStr}  ${r.cadena || ''}`,
    );
  }

  console.log('\n── REJECT (' + strategyResults.ensemble_precision.reject + ') ──');
  for (const r of ensemble.filter((r) => r.bucket === 'reject').sort((a, b) => b.top1_score - a.top1_score)) {
    const flagStr = Object.entries(r.flags).filter(([, v]) => v).map(([k]) => k).join(',') || '-';
    console.log(
      `  [${r.pareto}] ${r.nombre_marzam.padEnd(45)} → ${(r.top1_name || '???').padEnd(50)} score=${r.top1_score.toFixed(3)}  reason=${r.bucket_reason}  flags=${flagStr}`,
    );
  }

  // ─── ERROR ANALYSIS BY TYPE ───

  console.log('\n' + '='.repeat(80));
  console.log('  ERROR ANALYSIS — WHY CASES FAIL');
  console.log('='.repeat(80));

  const rejected = ensemble.filter((r) => r.bucket === 'reject');
  const byReason = {};
  for (const r of rejected) {
    const key = r.bucket_reason + (r.flags.is_person ? '+person' : '') + (r.flags.is_generic ? '+generic' : '');
    byReason[key] = (byReason[key] || 0) + 1;
  }
  console.log('\nReject breakdown:');
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  // flag distribution across all
  const flagCounts = { person: 0, generic: 0, ambiguous: 0, legal: 0 };
  for (const r of ensemble) {
    if (r.flags.is_person) flagCounts.person++;
    if (r.flags.is_generic) flagCounts.generic++;
    if (r.flags.is_ambiguous) flagCounts.ambiguous++;
    if (r.flags.is_legal) flagCounts.legal++;
  }
  console.log('\nFlag distribution (all 192):');
  for (const [k, v] of Object.entries(flagCounts)) {
    console.log(`  ${k}: ${v}`);
  }

  // Pareto breakdown
  console.log('\nBy Pareto class (ensemble):');
  for (const pareto of ['A', 'B', 'C']) {
    const sub = ensemble.filter((r) => r.pareto === pareto);
    const aa = sub.filter((r) => r.bucket === 'auto_accept').length;
    const mr = sub.filter((r) => r.bucket === 'manual_review').length;
    const rj = sub.filter((r) => r.bucket === 'reject').length;
    console.log(`  Pareto ${pareto}: total=${sub.length}  accept=${aa}  review=${mr}  reject=${rj}  safe_rate=${(aa / sub.length * 100).toFixed(1)}%`);
  }

  // ─── GOLD SAMPLE SUMMARY ───

  console.log('\n' + '='.repeat(80));
  console.log('  GOLD SAMPLE FOR MANUAL VALIDATION');
  console.log('='.repeat(80));
  for (const tier of ['easy', 'ambiguous', 'hard']) {
    console.log(`\n── ${tier.toUpperCase()} (${goldSample[tier].length} cases) ──`);
    for (const r of goldSample[tier]) {
      console.log(
        `  ${r.nombre_marzam.padEnd(45)} → ${(r.top1_name || '-').padEnd(45)} score=${r.top1_score.toFixed(3)}  bucket=${r.bucket}`,
      );
    }
  }

  // ─── WRITE JSON OUTPUT ───

  const outArg = process.argv.indexOf('--out');
  const outPath = outArg >= 0 && process.argv[outArg + 1]
    ? path.resolve(process.argv[outArg + 1])
    : path.resolve(__dirname, '..', 'data', 'ecatepec-match-results.json');

  const output = {
    generated_at: new Date().toISOString(),
    marzam_count: marzam.length,
    poi_count: pois.length,
    strategy_summary: Object.fromEntries(
      Object.entries(strategyResults).map(([k, v]) => [k, {
        auto_accept: v.auto_accept,
        manual_review: v.manual_review,
        reject: v.reject,
        safe_match_rate: v.safe_match_rate,
      }]),
    ),
    ensemble_results: ensemble.map((r) => ({
      cuenta: r.cuenta,
      nombre_marzam: r.nombre_marzam,
      cadena: r.cadena,
      pareto: r.pareto,
      core_marzam: r.core_marzam,
      flags: r.flags,
      bucket: r.bucket,
      bucket_reason: r.bucket_reason,
      top1_name: r.top1_name,
      top1_score: Number(r.top1_score.toFixed(4)),
      top1_address: r.top1_address,
      top1_neighborhood: r.top1_neighborhood,
      top2_name: r.top2_name,
      top2_score: Number(r.top2_score.toFixed(4)),
      margin: Number(r.margin.toFixed(4)),
      candidates: r.all_candidates,
    })),
    gold_sample: goldSample,
  };

  require('fs').writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nResults written to ${outPath}`);

  return strategyResults;
}

// ─────────────────────────────────────────────
// ENTRYPOINT
// ─────────────────────────────────────────────

runAnalysis()
  .catch((err) => {
    console.error('Analysis failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await knex.destroy();
  });
