const { Router } = require('express');
const multer = require('multer');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const auditLog = require('../../middleware/auditLog');
const controller = require('./onboarding.controller');
const { ALLOWED_ROLES } = require('./onboarding.spec');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype));
  },
});

const router = Router();

// Spec del wizard — accesible para cualquier rol autenticado (los managers también
// pueden necesitar ver la estructura para aprobar / consultar).
router.get('/spec', authenticate, controller.getSpec);
router.get('/nearby', authenticate, controller.nearby);

// Mutaciones: solo supervisor + representante.
const repsOnly = authorize({ roles: ALLOWED_ROLES });

router.post('/', authenticate, repsOnly, auditLog('onboarding.created'), controller.create);
router.get('/', authenticate, controller.listMine);
router.get('/:id', authenticate, controller.getOne);
router.patch('/:id', authenticate, repsOnly, auditLog('onboarding.updated'), controller.update);

router.post(
  '/:id/documents',
  authenticate,
  repsOnly,
  upload.single('file'),
  auditLog('onboarding.doc_uploaded'),
  controller.uploadDoc,
);

router.get('/:id/products', authenticate, controller.listProducts);
router.post('/:id/products', authenticate, repsOnly, auditLog('onboarding.product_added'), controller.addProduct);
router.delete('/:id/products/:productId', authenticate, repsOnly, auditLog('onboarding.product_deleted'), controller.deleteProduct);

router.post('/:id/submit', authenticate, repsOnly, auditLog('onboarding.submitted'), controller.submit);
router.post('/:id/credit-decision', authenticate, repsOnly, auditLog('onboarding.credit_decided'), controller.creditDecision);

module.exports = router;
