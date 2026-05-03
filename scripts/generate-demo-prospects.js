#!/usr/bin/env node
/**
 * Genera /src/public/data/prospectos-demo.json: ~180 farmacias prospecto
 * (NO en el padrón Marzam) esparcidas por las zonas de cobertura. Cada
 * una trae lat/lng, nombre realista, categoría y `is_marzam: false` para
 * que el frontend las pinte distinto en el mapa.
 *
 * Idempotente: regenerar produce el mismo dataset (seed determinístico).
 */
const fs = require('fs');
const path = require('path');

// Seed determinístico
let seed = 1729;
function rand() {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}
function randomChoice(arr) { return arr[Math.floor(rand() * arr.length)]; }
function randomBetween(min, max) { return min + rand() * (max - min); }

// Centros geográficos por gerencia/zona (lat, lng, label, weight)
const ZONES = [
  { center: [19.605, -99.060], spread: 0.045, name: 'Ecatepec',         estado: 'Estado de México', count: 60 },
  { center: [19.435, -99.140], spread: 0.060, name: 'CDMX Centro',      estado: 'Ciudad de México', count: 30 },
  { center: [19.380, -99.180], spread: 0.040, name: 'Coyoacán/Tlalpan', estado: 'Ciudad de México', count: 20 },
  { center: [19.490, -99.230], spread: 0.040, name: 'Naucalpan',        estado: 'Estado de México', count: 18 },
  { center: [19.300, -99.190], spread: 0.040, name: 'Xochimilco',       estado: 'Ciudad de México', count: 12 },
  { center: [19.530, -99.140], spread: 0.050, name: 'GAM/Tlalnepantla', estado: 'Estado de México', count: 25 },
  { center: [19.290, -99.660], spread: 0.030, name: 'Toluca',           estado: 'Estado de México', count: 15 },
];

const PHARMACY_PREFIXES = [
  'Farmacia', 'Botica', 'Farmacia Familiar', 'Drogueria', 'Salud y Vida',
  'Farmacia Económica', 'Farmacia Express', 'FarmaPlus', 'Farmacia Comunitaria',
];
const PHARMACY_SURNAMES = [
  'San José', 'Guadalupe', 'Santa María', 'La Esperanza', 'El Sol', 'San Pedro',
  'Las Flores', 'La Cruz', 'San Francisco', 'Del Valle', 'Vista Hermosa',
  'San Juan', 'El Carmen', 'San Antonio', 'La Paz', 'Santa Fe', 'Reforma',
  'San Miguel', 'Insurgentes', 'Hidalgo', 'Juárez', 'Madero', 'Morelos',
  'Buenavista', 'San Rafael', 'La Merced', 'Tepeyac', 'Aragón', 'Lindavista',
];
const STREETS = [
  'Av. Insurgentes', 'Calle Hidalgo', 'Av. Reforma', 'Av. Juárez',
  'Calle Morelos', 'Av. Revolución', 'Calle 5 de Mayo', 'Av. Pdte. Madero',
  'Calle Allende', 'Av. Universidad', 'Calle Independencia', 'Av. Cuauhtémoc',
  'Calle Vicente Guerrero', 'Av. División del Norte', 'Calle Zaragoza',
];
const NEIGHBORHOODS = [
  'Centro', 'San Pedro', 'San Miguel', 'Lindavista', 'Las Flores', 'Reforma',
  'Buenavista', 'San José', 'Santa María', 'Vista Hermosa', 'El Carmen',
  'La Cruz', 'Aragón', 'Morelos', 'Insurgentes', 'Hidalgo', 'Juárez',
];
const STATUSES = ['active', 'active', 'active', 'active', 'pending_review'];
const PERFILES = ['Independiente', 'Independiente', 'Independiente', 'Mostrador', 'Cadena pequeña'];

function pharmacyName() {
  const useChain = rand() < 0.18;
  if (useChain) {
    return randomChoice(['Farmacias Similares', 'Farmacias del Ahorro', 'Farmacia Benavides',
      'Farmacia Guadalajara', 'Farmacia San Pablo', 'YZA']);
  }
  return `${randomChoice(PHARMACY_PREFIXES)} ${randomChoice(PHARMACY_SURNAMES)}`;
}

function genId(i) {
  return `pros_${String(i).padStart(4, '0')}`;
}

/**
 * Score sesgado hacia el medio-bajo, en bandas alineadas con los tiers
 * finales.  En producción la columna `tier_clean` que viene de BlackPrint
 * tiende a sesgarse a A en su muestra reducida (200 A / 275 B / 25 C
 * sobre 500), pero en el demo queremos un mix más conservador para que
 * el rep distinga visualmente que la mayoría de prospectos no son
 * automáticamente "alto potencial":
 *
 *   ~20 %  A  (score 75–95)
 *   ~40 %  B  (score 45–74)
 *   ~40 %  C  (score 5–44)
 */
function skewedScore() {
  const r = rand();
  if (r < 0.20) return 75 + rand() * 20;
  if (r < 0.60) return 45 + rand() * 30;
  return 5 + rand() * 39;
}

/**
 * Tier estimado por POTENCIAL DE VENTA (mismo concepto que la columna
 * `tier_clean` de `integration.int_marzam_prospect_scored` en BlackPrint).
 * Escala A/B/C en lugar de Q1..Q4 — el FE consume este campo con el mismo
 * nombre (`tier`) que en producción.
 *
 *   A — Alto potencial    (score ≥ 75)
 *   B — Potencial medio   (45 ≤ score < 75)
 *   C — Potencial bajo    (score < 45)
 *
 * Los cortes son ligeramente distintos a los Q1/Q2/Q3/Q4 anteriores
 * porque colapsamos 4 buckets a 3.  Si BlackPrint cambiara el criterio
 * exacto, el FE seguiría leyendo `tier` correctamente — sólo cambiarían
 * las proporciones.
 */
function classifyTier(potentialScore) {
  if (potentialScore >= 75) return 'A';
  if (potentialScore >= 45) return 'B';
  return 'C';
}

const prospects = [];
let i = 1;
for (const zone of ZONES) {
  for (let n = 0; n < zone.count; n++) {
    const lat = +randomBetween(zone.center[0] - zone.spread, zone.center[0] + zone.spread).toFixed(6);
    const lng = +randomBetween(zone.center[1] - zone.spread, zone.center[1] + zone.spread).toFixed(6);
    const street = randomChoice(STREETS);
    const num = Math.floor(randomBetween(10, 999));
    const neighborhood = randomChoice(NEIGHBORHOODS);
    const potential = Math.round(randomBetween(2000, 18000));
    const distancia_marzam_m = Math.round(randomBetween(150, 1800));
    // Distribución sesgada para que el demo sea realista: la mayoría de
    // farmacias prospecto NO son alto potencial.  Mezcla Beta(2,5) ≈ media
    // ~28 con cola larga hacia 95 (~10% Q1, ~25% Q2, ~35% Q3, ~30% Q4).
    const potentialScore = Math.round(skewedScore());
    const tier = classifyTier(potentialScore);
    prospects.push({
      id: genId(i),
      name: pharmacyName(),
      address: `${street} ${num}, ${neighborhood}, ${zone.name}, ${zone.estado}`,
      municipality: zone.name,
      neighborhood,
      state: zone.estado,
      lat,
      lng,
      is_marzam: false,        // <-- prospecto, no en el padrón
      pareto: null,             // pareto sólo aplica a clientes Marzam
      tier,                     // A / B / C — equivalente a tier_clean en BQ
      perfil: randomChoice(PERFILES),
      status: randomChoice(STATUSES),
      verification_status: rand() < 0.3 ? 'verified' : 'unverified',
      is_independent: rand() < 0.85,
      potential_score: potentialScore,
      order_potential: potential,
      contact_phone: rand() < 0.4 ? `55-${Math.floor(randomBetween(1000, 9999))}-${Math.floor(randomBetween(1000, 9999))}` : null,
      contact_person: rand() < 0.3 ? randomChoice(['María López', 'Juan Pérez', 'Ana Martínez', 'Carlos Ruiz', 'Laura Díaz']) : null,
      distance_to_nearest_marzam_m: distancia_marzam_m,
      source: 'blackprint_prospect',
      category: 'healthcare',
      subcategory: 'pharmacy_supplies',
      notes: rand() < 0.2 ? randomChoice([
        'Próxima a hospital — alto tráfico',
        'Zona comercial activa',
        'Cerca de plaza pública',
        'Esquina concurrida',
        'Junto a consultorio médico',
      ]) : null,
    });
    i++;
  }
}

const out = {
  meta: {
    generated_at: new Date().toISOString(),
    description: 'Farmacias prospecto (NO en padrón Marzam) — sintéticas para demo.',
    total: prospects.length,
    seed,
  },
  prospects,
};

const target = path.join(__dirname, '..', 'src', 'public', 'data', 'prospectos-demo.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2), 'utf8');
console.log(`✓ Generadas ${prospects.length} farmacias prospecto en ${target}`);
