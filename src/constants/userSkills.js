/**
 * Catálogo controlado de skills por usuario (cualquier rol).
 *
 * El campo `users.user_skills JSONB` (mig 093) contiene un array de strings de
 * este catálogo. Las farmacias y clientes Marzam exponen `required_skills`
 * (mig 094) — un array NULL/vacío significa "cualquier usuario elegible"; un
 * array poblado exige que el `user_skills` del visitor contenga AL MENOS UNO
 * de los skills listados (intersección no-vacía).
 *
 * Por qué a nivel `users` y no `reps`: directores/gerentes/supervisores también
 * pueden ejecutar visitas en campo. Algunos hacen captación de prospectos
 * (new_pharmacy_capture), otros únicamente mantenimiento de cuentas Marzam
 * existentes (marzam_maintenance). El modelo de skills es por persona,
 * independiente del rol jerárquico.
 *
 * Extender este catálogo NO requiere migration — basta con agregar el string
 * aquí. El frontend lista las opciones leyendo `USER_SKILLS_CATALOG`.
 */

const USER_SKILLS = Object.freeze({
  NEW_PHARMACY_CAPTURE: 'new_pharmacy_capture',
  MARZAM_MAINTENANCE: 'marzam_maintenance',
});

const USER_SKILLS_CATALOG = Object.freeze([
  {
    code: USER_SKILLS.NEW_PHARMACY_CAPTURE,
    label: 'Captación de farmacias nuevas',
    description: 'Visita prospectos / farmacias independientes sin Marzam activo',
  },
  {
    code: USER_SKILLS.MARZAM_MAINTENANCE,
    label: 'Mantenimiento Marzam',
    description: 'Visita cuentas Marzam ya activas (clave de mostrador)',
  },
]);

const VALID_SKILL_CODES = Object.freeze(new Set(USER_SKILLS_CATALOG.map((s) => s.code)));

function isValidSkill(code) {
  return typeof code === 'string' && VALID_SKILL_CODES.has(code);
}

/**
 * Normaliza un array arbitrario a un array de skills válidos, único y ordenado.
 * Strings desconocidos se descartan silenciosamente. Devuelve `[]` si la
 * entrada no es un array.
 */
function normalizeSkillsArray(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const v of input) {
    if (typeof v !== 'string') continue;
    if (!VALID_SKILL_CODES.has(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.sort();
}

/**
 * ¿El visitor `user` puede atender el `target` (pharmacy / marzam_client)?
 *
 * - target.required_skills NULL o [] → cualquier user puede.
 * - array poblado → intersección no-vacía con user.user_skills.
 * - user.user_skills NULL o [] cuando required_skills tiene contenido → NO puede.
 */
function userCanVisit(user, target) {
  if (!target) return true;
  const required = target.required_skills;
  if (required == null) return true;
  if (!Array.isArray(required)) return true;
  if (required.length === 0) return true;
  const skills = Array.isArray(user?.user_skills) ? user.user_skills : [];
  if (skills.length === 0) return false;
  const set = new Set(skills);
  for (const s of required) {
    if (set.has(s)) return true;
  }
  return false;
}

module.exports = {
  USER_SKILLS,
  USER_SKILLS_CATALOG,
  VALID_SKILL_CODES,
  isValidSkill,
  normalizeSkillsArray,
  userCanVisit,
};
