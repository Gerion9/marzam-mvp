const importsService = require('./imports.service');

async function uploadUrl(req, res, next) {
  try {
    const { kind } = req.params;
    const { original_filename: originalFilename, content_type: contentType } = req.body || {};
    const result = await importsService.requestUploadUrl({ kind, originalFilename, contentType });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

async function register(req, res, next) {
  try {
    const { kind } = req.params;
    const { gcs_path: gcsPath, original_filename: originalFilename, job_id: jobId, meta } = req.body || {};
    if (!gcsPath) {
      return res.status(400).json({ error: 'gcs_path is required' });
    }
    const job = await importsService.registerJob({
      kind,
      gcsPath,
      originalFilename,
      uploadedBy: req.user.id,
      jobId,
      meta,
    });
    res.status(201).json(job);
  } catch (err) {
    next(err);
  }
}

async function show(req, res, next) {
  try {
    const job = await importsService.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const { kind, status, limit, offset } = req.query;
    const rows = await importsService.listJobs({ kind, status, limit, offset });
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

/**
 * Worker entrypoint — invoked by Vercel cron.
 *
 * Auth: requires a shared secret in the `x-cron-secret` header (matches
 * MARZAM_CRON_SECRET env var). If unset, falls back to authenticated requests
 * from a director_sucursal so we have a manual escape hatch.
 */
async function workerTick(req, res, next) {
  try {
    // Accept either:
    //   - Vercel cron pattern: Authorization: Bearer ${CRON_SECRET}
    //   - x-cron-secret header (manual / external schedulers)
    //   - ?secret= query param (manual smoke test)
    //   - An authenticated director_sucursal session
    const secret = process.env.CRON_SECRET || process.env.MARZAM_CRON_SECRET;
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const presented = bearer || req.headers['x-cron-secret'] || req.query.secret;
    const authedDirector = req.user && (req.user.role === 'director_sucursal' || req.user.role === 'national_admin');

    if (secret) {
      if (presented !== secret && !authedDirector) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    } else if (!authedDirector) {
      return res.status(401).json({ error: 'Worker secret not configured and request is not authenticated' });
    }

    const result = await importsService.runWorkerTick();
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  uploadUrl,
  register,
  show,
  list,
  workerTick,
};
