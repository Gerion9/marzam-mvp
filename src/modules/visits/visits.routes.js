const { Router } = require('express');
const multer = require('multer');
const controller = require('./visits.controller');
const authenticate = require('../../middleware/auth');
const auditLog = require('../../middleware/auditLog');
const validate = require('../../middleware/validate');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const router = Router();

router.post(
  '/',
  authenticate,
  validate({
    pharmacy_id: { required: true, type: 'string' },
    outcome: { required: true, type: 'string' },
    notes: { required: true, type: 'string' },
  }),
  auditLog('visit.submitted'),
  controller.submit,
);

router.get('/pharmacy/:pharmacyId', authenticate, controller.listByPharmacy);

router.post(
  '/:visitId/photos',
  authenticate,
  upload.single('photo'),
  auditLog('visit.photo_uploaded'),
  controller.uploadPhoto,
);

module.exports = router;
