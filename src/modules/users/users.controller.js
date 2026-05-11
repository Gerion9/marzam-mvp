const authService = require('../auth/auth.service');
const { isGlobal } = require('../permissions/permissions');
const db = require('../../config/database');
const { canActorManage } = require('../../services/teamScope');
const { encode: geohashEncode } = require('../../utils/geohash');
const accessDirectory = require('../../services/accessDirectory');
const { normalizeSkillsArray, USER_SKILLS_CATALOG } = require('../../constants/userSkills');
const { isAdminRole, isManagementRole, normalizeRole } = require('../../constants/roles');

async function list(req, res, next) {
  try {
    if (req.user.role === 'field_rep') {
      return res.status(403).json({ error: 'Forbidden: field reps cannot list users' });
    }
    const filters = {};
    if (req.query.role) filters.role = req.query.role;
    if (req.query.is_active !== undefined) filters.is_active = req.query.is_active === 'true';
    if (req.query.territory_id) filters.territory_id = req.query.territory_id;
    if (!isGlobal(req.user.role) && !req.user.is_global) {
      filters.accessible_territory_ids = req.user.accessible_territory_ids || [];
    }
    const users = await authService.listUsers(filters);
    res.json(users);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const user = await authService.register({
      email: req.body.email,
      password: req.body.password,
      full_name: req.body.full_name,
      role: req.body.role,
      phone: req.body.phone || null,
      created_by: req.user.id,
      territory_ids: req.body.territory_ids || [],
    });
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const updated = await authService.updateUser(req.params.id, req.body, { actor: req.user });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function deactivate(req, res, next) {
  try {
    const row = await authService.deactivateUser(req.params.id);
    res.json(row);
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const result = await authService.resetPassword(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * Set / update a rep's home depot. Reps can edit their own; a manager can
 * edit any rep in their subtree.
 *
 * Routes through accessDirectory so a virtual id (demo / external mode)
 * resolves to the canonical UUID before hitting the users table.
 */
async function updateHome(req, res, next) {
  try {
    const targetId = accessDirectory.toCanonicalId(req.params.id);
    const { home_lat, home_lng } = req.body || {};
    if (!Number.isFinite(home_lat) || !Number.isFinite(home_lng)) {
      return res.status(400).json({ error: 'home_lat / home_lng must be numbers' });
    }
    if (home_lat < -90 || home_lat > 90 || home_lng < -180 || home_lng > 180) {
      return res.status(400).json({ error: 'home_lat / home_lng out of range' });
    }
    if (req.user.id !== targetId && !req.user.is_global) {
      if (!await canActorManage(req.user.id, targetId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    const [updated] = await db('users').where({ id: targetId }).update({
      home_lat,
      home_lng,
      home_geohash7: geohashEncode(home_lat, home_lng, 7),
    }).returning(['id', 'home_lat', 'home_lng', 'home_geohash7']);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/skills/catalog
 *
 * Devuelve el catálogo controlado de skills (codes, labels, descriptions)
 * para que el frontend liste opciones consistentes en pickers. No requiere
 * permisos especiales — cualquier authenticated user puede leer el catálogo.
 */
async function getSkillsCatalog(req, res) {
  res.json({ skills: USER_SKILLS_CATALOG });
}

/**
 * GET /api/users/me/skills
 *
 * Devuelve el array de skills del user autenticado. Útil para que el UI
 * cargue el estado inicial del picker sin tener que pedir el full user.
 */
async function getMySkills(req, res, next) {
  try {
    const row = await db('users').where({ id: req.user.id }).select('user_skills').first();
    if (!row) return res.status(404).json({ error: 'User not found' });
    const skills = Array.isArray(row.user_skills) ? row.user_skills : [];
    res.json({ user_skills: skills });
  } catch (err) { next(err); }
}

/**
 * PUT /api/users/me/skills
 *
 * El user actualiza sus propias skills. Solo management roles (supervisor +
 * arriba) — un rep no edita su propio perfil de skills, eso lo hace su
 * supervisor o un admin para evitar abuso.
 */
async function updateMySkills(req, res, next) {
  try {
    const role = normalizeRole(req.user.role);
    if (!isAdminRole(role) && !isManagementRole(role)) {
      return res.status(403).json({ error: 'Only management roles can edit their own skills. Ask an admin.' });
    }
    const skills = normalizeSkillsArray(req.body?.user_skills);
    const [updated] = await db('users')
      .where({ id: req.user.id })
      .update({ user_skills: JSON.stringify(skills) })
      .returning(['id', 'user_skills']);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.json(updated);
  } catch (err) { next(err); }
}

/**
 * PUT /api/users/:id/skills
 *
 * Admin actualiza skills de cualquier user. Auth gate lo hace `adminOnly`
 * (en la route); aquí solo validamos el array y persistimos. Vía
 * accessDirectory.toCanonicalId para soportar virtual ids (demo).
 */
async function updateUserSkills(req, res, next) {
  try {
    const targetId = accessDirectory.toCanonicalId(req.params.id);
    const skills = normalizeSkillsArray(req.body?.user_skills);
    const [updated] = await db('users')
      .where({ id: targetId })
      .update({ user_skills: JSON.stringify(skills) })
      .returning(['id', 'full_name', 'user_skills']);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    res.json(updated);
  } catch (err) { next(err); }
}

module.exports = {
  list, create, update, deactivate, resetPassword, updateHome,
  getSkillsCatalog, getMySkills, updateMySkills, updateUserSkills,
};
