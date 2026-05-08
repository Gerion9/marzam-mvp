const { Router } = require('express');
const authenticate = require('../../middleware/auth');
const scope = require('../../services/poblacionScope');

const router = Router();

/**
 * GET /api/poblaciones
 *  → { active, default, options: [{ value, enabled }] }
 *
 * Por defecto TODAS las poblaciones conocidas vienen `enabled: true`,
 * para que el director / gerente / supervisor puedan filtrar por
 * cualquiera. La opción `__all__` (label "Todas las zonas") se inserta
 * al inicio de la lista para representar "sin filtro".
 *
 * Si la env `MARZAM_RESTRICT_POBLACION=1` está activa, sólo la zona
 * activa aparece habilitada (modo piloto cerrado).
 */
router.get('/', authenticate, async (_req, res, next) => {
  try {
    const active = scope.getActivePoblacion();
    const restricted = scope.isRestrictedToActive();
    const known = await scope.listKnownPoblaciones();
    const set = new Set(known);
    set.add(active);
    const options = [
      { value: '__all__', label: 'Todas las zonas', enabled: !restricted },
      ...[...set].sort().map((value) => ({
        value,
        label: value,
        enabled: restricted ? value === active : true,
      })),
    ];
    res.json({
      active: restricted ? active : '__all__',
      default: scope.DEFAULT_ACTIVE,
      restricted,
      options,
    });
  } catch (err) { next(err); }
});

module.exports = router;
