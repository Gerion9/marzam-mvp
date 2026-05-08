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
    pharmacy_id: { required: true, type: 'string', minLength: 3, maxLength: 64 },
    outcome: { required: true, type: 'string', maxLength: 64 },
    notes: { required: true, type: 'string', minLength: 1, maxLength: 2000 },
    flag_reason: { type: 'string', maxLength: 200 },
    follow_up_reason: { type: 'string', maxLength: 200 },
    contact_person: { type: 'string', maxLength: 200 },
    contact_phone: { type: 'string', maxLength: 32 },
    checkin_lat: { type: 'number', min: -90, max: 90 },
    checkin_lng: { type: 'number', min: -180, max: 180 },
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

// Pre-submit photo upload — returns a stable photo_url that the FE includes
// in the visit submit payload to satisfy the OUTCOMES_REQUIRING_PHOTO gate.
// See visits.service.js#submit() for the consumer contract.
router.post(
  '/staging-photo',
  authenticate,
  upload.single('photo'),
  auditLog('visit.staging_photo_uploaded'),
  controller.uploadStagingPhoto,
);

module.exports = router;
