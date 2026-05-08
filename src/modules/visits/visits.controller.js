const fs = require('fs/promises');
const path = require('path');

const config = require('../../config');
const { uploadVerificationPhoto } = require('../../utils/gcsEvidence');
const { assertImageBuffer } = require('../../utils/imageMagicBytes');
const visitService = require('./visits.service');
const pharmacyService = require('../pharmacies/pharmacies.service');

function resolvePhotoExtension(originalName = '') {
  return path.extname(originalName).replace(/^\./, '').toLowerCase() || 'jpg';
}

async function persistPhoto(file, visit, pharmacy) {
  // [S9] Defense in depth — the GCS path checks magic bytes too, but the local
  // dev path skips it without this guard, leaving local devs vulnerable to
  // crafted uploads if they expose their dev port.
  assertImageBuffer(file.buffer, file.mimetype);
  if (config.photos.provider === 'local') {
    if (config.env === 'production') {
      const err = new Error('Local photo storage is disabled in production. Set PHOTO_STORAGE_PROVIDER=gcs.');
      err.status = 501;
      throw err;
    }
    const ext = resolvePhotoExtension(file.originalname);
    const fileName = `${visit.id}_${Date.now()}.${ext}`;
    const destination = path.resolve(config.photos.storageDir, fileName);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.buffer);
    return {
      bucket: null,
      objectPath: fileName,
      photoUrl: `/uploads/photos/${fileName}`,
    };
  }

  return uploadVerificationPhoto({
    state: pharmacy.state,
    municipality: pharmacy.municipality,
    verificationId: visit.id,
    pharmacyId: visit.pharmacy_id,
    originalName: file.originalname,
    buffer: file.buffer,
    contentType: file.mimetype,
  });
}

async function submit(req, res, next) {
  try {
    const visit = await visitService.submit({
      ...req.body,
      rep_id: req.user.id,
    });
    res.locals.auditDetail = { entityType: 'visit', entityId: visit.id, after: visit };
    res.status(201).json(visit);
  } catch (err) {
    next(err);
  }
}

async function listByPharmacy(req, res, next) {
  try {
    if (req.user.role === 'field_rep') {
      const assigned = await pharmacyService.isAssignedToRep(req.params.pharmacyId, req.user.id);
      if (!assigned) {
        return res.status(403).json({ error: 'You are not assigned to this pharmacy' });
      }
    }
    const visits = await visitService.listByPharmacy(req.params.pharmacyId);
    res.json(visits);
  } catch (err) {
    next(err);
  }
}

// Pre-visit photo upload — Marzam Execution Doc §6.3 mandates that photo
// evidence is "blocked if missing" at submit time, but the photo had to be
// uploaded BEFORE the visit_report exists. This endpoint stores the photo to
// GCS (or local in dev) and returns the URL so the FE can include it in the
// `submit` payload as `photo_url`. The visit submission then attaches the
// photo to the freshly-created visit row.
//
// Auth: any authenticated rep can upload to their own staging area; the
// returned URL is stable and the rep proves ownership at submit time.
async function uploadStagingPhoto(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Photo file is required' });
    }
    // [S9] Magic-byte check before either branch (local or GCS).
    assertImageBuffer(req.file.buffer, req.file.mimetype);
    if (config.photos.provider === 'local') {
      if (config.env === 'production') {
        const err = new Error('Local photo storage is disabled in production');
        err.status = 501;
        throw err;
      }
      const ext = resolvePhotoExtension(req.file.originalname);
      const fileName = `staging_${req.user.id}_${Date.now()}.${ext}`;
      const destination = path.resolve(config.photos.storageDir, fileName);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, req.file.buffer);
      return res.status(201).json({
        photo_url: `/uploads/photos/${fileName}`,
        object_path: fileName,
        bucket: null,
        size_bytes: req.file.size,
        mime_type: req.file.mimetype,
      });
    }
    // GCS path: namespace under `visits/staging/<rep>/<ts>` so the cleanup job
    // can find orphaned uploads that never got attached to a visit.
    const stored = await uploadVerificationPhoto({
      state: 'mx',                                // staging is geography-agnostic
      municipality: 'staging',
      verificationId: `${req.user.id}_${Date.now()}`,
      pharmacyId: req.body?.pharmacy_id || 'unknown',
      originalName: req.file.originalname,
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
    });
    res.status(201).json({
      photo_url: stored.photoUrl,
      object_path: stored.objectPath,
      bucket: stored.bucket,
      size_bytes: req.file.size,
      mime_type: req.file.mimetype,
    });
  } catch (err) { next(err); }
}

async function uploadPhoto(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Photo file is required' });
    }

    const visit = await visitService.getById(req.params.visitId);
    if (req.user.role === 'field_rep' && visit.rep_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only upload evidence to your own visit' });
    }

    const pharmacy = await pharmacyService.getById(visit.pharmacy_id);
    const stored = await persistPhoto(req.file, visit, pharmacy);

    const photo = await visitService.addPhoto(req.params.visitId, {
      bucket: stored.bucket,
      object_path: stored.objectPath,
      photo_url: stored.photoUrl,
      original_name: req.file.originalname,
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
    });
    res.locals.auditDetail = {
      entityType: 'visit_photo',
      entityId: photo.id,
      after: {
        visit_id: req.params.visitId,
        original_name: req.file.originalname,
        photo_url: photo.photo_url,
      },
    };
    res.status(201).json(photo);
  } catch (err) {
    next(err);
  }
}

module.exports = { submit, listByPharmacy, uploadPhoto, uploadStagingPhoto };
