const { Router } = require('express');
const controller = require('./users.controller');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const validate = require('../../middleware/validate');
const auditLog = require('../../middleware/auditLog');

const router = Router();

router.get(
  '/',
  authenticate,
  authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }),
  controller.list,
);

// User CRUD (create/update/deactivate/reset-password) is admin-only per
// Marzam Execution Doc §3. Listing is allowed to all management roles since
// supervisores and gerentes need to see their team rosters.
router.post(
  '/',
  authenticate,
  authorize({ adminOnly: true }),
  validate({
    email: { required: true, type: 'string' },
    password: { required: true, type: 'string' },
    full_name: { required: true, type: 'string' },
    role: {
      required: true,
      type: 'string',
      oneOf: [
        'admin',
        'director_sucursal', 'gerente_ventas', 'supervisor', 'representante',
        'national_admin', 'regional_manager', 'area_coordinator', 'field_rep',
      ],
    },
    // manager_id es opcional aquí; el service valida en register() que sea
    // requerido para representante/supervisor/gerente_ventas y que apunte al
    // rol del nivel inmediato superior. Ver MARZAM-5.
    manager_id: { type: 'string' },
  }),
  auditLog('user.created'),
  controller.create,
);

router.patch(
  '/:id',
  authenticate,
  authorize({ adminOnly: true }),
  auditLog('user.updated'),
  controller.update,
);

router.delete(
  '/:id',
  authenticate,
  authorize({ adminOnly: true }),
  auditLog('user.deactivated'),
  controller.deactivate,
);

router.post(
  '/:id/reset-password',
  authenticate,
  authorize({ adminOnly: true }),
  auditLog('user.password_reset'),
  controller.resetPassword,
);

// Set / update a rep's home depot. The rep can update their own home; a
// manager can update any rep they manage (canActorManage).
router.put(
  '/:id/home',
  authenticate,
  validate({
    home_lat: { required: true, type: 'number' },
    home_lng: { required: true, type: 'number' },
  }),
  auditLog('user.home_updated'),
  controller.updateHome,
);

// ── User skills (mig 093) ────────────────────────────────────────────────
// Catálogo abierto — cualquier authenticated user puede listarlo para
// renderizar pickers (no expone secret state).
router.get('/skills/catalog', authenticate, controller.getSkillsCatalog);

// GET / PUT del propio perfil de skills. PUT solo para management+ (un rep
// no edita su propio perfil de skills; eso lo hace su supervisor o admin
// para evitar abuso — el gate vive en el controller).
router.get('/me/skills', authenticate, controller.getMySkills);
router.put(
  '/me/skills',
  authenticate,
  auditLog('user.skills_self_updated'),
  controller.updateMySkills,
);

// Admin edita skills de cualquier user. adminOnly (Marzam admin) — blackprint
// queda fuera porque es read-only sobre Marzam data per denyBlackprintWrites.
router.put(
  '/:id/skills',
  authenticate,
  authorize({ adminOnly: true }),
  auditLog('user.skills_updated_by_admin'),
  controller.updateUserSkills,
);

// ── User preferences (mig 097) ────────────────────────────────────────────
// Bag jsonb por-user para preferencias de UI. Primer consumidor: estado del
// sistema de tutorial guiado (preferences.tutorial). No requiere auditLog —
// son preferencias personales de UI, no eventos auditables.
router.get('/me/preferences', authenticate, controller.getMyPreferences);
router.patch(
  '/me/preferences',
  authenticate,
  validate({ tutorial: { type: 'object' } }),
  controller.updateMyPreferences,
);

module.exports = router;
