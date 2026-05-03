/**
 * Imports service.
 *
 * Two flows:
 *   1) Pre-upload — issue a signed PUT URL to the client, then register the job.
 *   2) Worker — pick the next pending job, stream/parse rows, hand the alias-
 *      normalized rows to the appropriate processor in chunks, and persist
 *      cursor + counters between ticks.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../../config/database');
const { generateSignedUploadUrl, objectExists, downloadObjectBuffer, getImportsBucketName } = require('../../utils/gcsImports');
const { readSheetRows } = require('./xlsxParser');
const { applyAliasMap } = require('./columnAliases');
const { PROCESSORS } = require('./processors');

const SUPPORTED_KINDS = Object.keys(PROCESSORS);
const KIND_URL_TO_DB = {
  'marzam-clients': 'marzam_clients',
  'daily-sales': 'daily_sales',
  'sales-targets': 'sales_targets',
  employees: 'employees',
};

const DEFAULT_CHUNK_SIZE = Number(process.env.MARZAM_IMPORTS_CHUNK_SIZE) || 500;
const SOFT_TIMEOUT_MS = Number(process.env.MARZAM_IMPORTS_WORKER_SOFT_TIMEOUT_MS) || 45000;

function normalizeKind(kind) {
  return KIND_URL_TO_DB[kind] || kind;
}

function assertSupportedKind(kind) {
  if (!SUPPORTED_KINDS.includes(kind)) {
    const err = new Error(`Unsupported import kind '${kind}'`);
    err.status = 400;
    throw err;
  }
}

async function requestUploadUrl({ kind, originalFilename, contentType }) {
  const dbKind = normalizeKind(kind);
  assertSupportedKind(dbKind);
  const jobId = uuidv4();
  const signed = await generateSignedUploadUrl({
    kind: dbKind,
    jobId,
    originalFilename: originalFilename || 'upload.xlsx',
    contentType,
  });
  return {
    job_id: jobId,
    ...signed,
  };
}

async function registerJob({ kind, gcsPath, originalFilename, uploadedBy, jobId, meta }) {
  const dbKind = normalizeKind(kind);
  assertSupportedKind(dbKind);

  const bucketName = getImportsBucketName();
  const exists = await objectExists(gcsPath, bucketName);
  if (!exists) {
    const err = new Error(`Object ${gcsPath} not found in bucket ${bucketName}`);
    err.status = 400;
    throw err;
  }

  const id = jobId || uuidv4();
  const [row] = await db('import_jobs')
    .insert({
      id,
      kind: dbKind,
      uploaded_by: uploadedBy,
      file_storage_path: gcsPath,
      original_filename: originalFilename || null,
      status: 'pending',
      meta: meta || {},
    })
    .returning('*');
  return row;
}

async function getJob(id) {
  return db('import_jobs').where({ id }).first();
}

async function listJobs({ kind, status, limit = 50, offset = 0 } = {}) {
  const q = db('import_jobs')
    .select('*')
    .orderBy('created_at', 'desc')
    .limit(Math.min(Number(limit) || 50, 200))
    .offset(Number(offset) || 0);
  if (kind) q.where({ kind: normalizeKind(kind) });
  if (status) q.where({ status });
  return q;
}

/**
 * Worker tick — claim a single job and process up to one chunk of rows.
 * Designed for short-budget environments (Vercel functions): never blocks
 * forever, leaves cursor behind so the next tick resumes.
 */
async function runWorkerTick({ chunkSize = DEFAULT_CHUNK_SIZE, softTimeoutMs = SOFT_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  const result = { picked: false, job_id: null, processed: 0, status: null };

  const jobToProcess = await db.transaction(async (trx) => {
    const candidate = await trx('import_jobs')
      .select('*')
      .whereIn('status', ['pending', 'processing'])
      .orderBy('created_at', 'asc')
      .forUpdate()
      .skipLocked()
      .first();
    if (!candidate) return null;
    await trx('import_jobs')
      .where({ id: candidate.id })
      .update({
        status: 'processing',
        started_at: candidate.started_at || trx.fn.now(),
        updated_at: trx.fn.now(),
      });
    return candidate;
  });

  if (!jobToProcess) return result;

  result.picked = true;
  result.job_id = jobToProcess.id;

  const processor = PROCESSORS[jobToProcess.kind];
  if (!processor) {
    await db('import_jobs').where({ id: jobToProcess.id }).update({
      status: 'failed',
      finished_at: db.fn.now(),
      errors: db.raw(`errors || ?::jsonb`, [JSON.stringify([{ reason: `no processor for kind ${jobToProcess.kind}` }])]),
    });
    result.status = 'failed';
    return result;
  }

  let buffer;
  try {
    buffer = await downloadObjectBuffer(jobToProcess.file_storage_path);
  } catch (err) {
    await db('import_jobs').where({ id: jobToProcess.id }).update({
      status: 'failed',
      finished_at: db.fn.now(),
      errors: db.raw(`errors || ?::jsonb`, [JSON.stringify([{ reason: `download failed: ${err.message}` }])]),
    });
    result.status = 'failed';
    return result;
  }

  const rawRows = readSheetRows(buffer);
  if (!jobToProcess.rows_total) {
    await db('import_jobs').where({ id: jobToProcess.id }).update({ rows_total: rawRows.length });
  }

  let cursor = jobToProcess.cursor || 0;
  const totals = {
    inserted: jobToProcess.rows_inserted || 0,
    updated: jobToProcess.rows_updated || 0,
    skipped: jobToProcess.rows_skipped || 0,
    failed: jobToProcess.rows_failed || 0,
  };
  const accumulatedErrors = [];

  while (cursor < rawRows.length) {
    if (Date.now() - startedAt > softTimeoutMs) break;

    const slice = rawRows.slice(cursor, cursor + chunkSize);
    const normalized = slice.map((row, i) => ({
      rowNumber: cursor + i + 2, // +2 because Excel header is row 1 and data is 1-indexed
      row: applyAliasMap(row, processor.aliasMap),
    }));

    let chunkOutcome;
    try {
      chunkOutcome = await db.transaction((trx) => processor.processBatch(trx, normalized, {
        meta: jobToProcess.meta || {},
        job: jobToProcess,
      }));
    } catch (err) {
      await db('import_jobs').where({ id: jobToProcess.id }).update({
        status: 'failed',
        finished_at: db.fn.now(),
        errors: db.raw(`errors || ?::jsonb`, [JSON.stringify([{ reason: `chunk failed at cursor ${cursor}: ${err.message}` }])]),
        updated_at: db.fn.now(),
      });
      result.status = 'failed';
      return result;
    }

    totals.inserted += chunkOutcome.inserted;
    totals.updated += chunkOutcome.updated;
    totals.skipped += chunkOutcome.skipped;
    totals.failed += chunkOutcome.failed;
    if (chunkOutcome.errors?.length) {
      // cap errors persisted per job at ~500 to keep jsonb small
      const existing = Array.isArray(jobToProcess.errors) ? jobToProcess.errors.length : 0;
      const remainingBudget = 500 - existing - accumulatedErrors.length;
      if (remainingBudget > 0) {
        accumulatedErrors.push(...chunkOutcome.errors.slice(0, remainingBudget));
      }
    }
    cursor += slice.length;
    result.processed += slice.length;
  }

  const isDone = cursor >= rawRows.length;
  let status = 'processing';
  if (isDone) {
    status = totals.failed > 0 && (totals.inserted + totals.updated) > 0
      ? 'partial'
      : (totals.failed > 0 && totals.inserted + totals.updated === 0 ? 'failed' : 'done');
  }

  const updatePayload = {
    cursor,
    rows_inserted: totals.inserted,
    rows_updated: totals.updated,
    rows_skipped: totals.skipped,
    rows_failed: totals.failed,
    status,
    updated_at: db.fn.now(),
  };
  if (isDone) updatePayload.finished_at = db.fn.now();

  if (accumulatedErrors.length) {
    await db('import_jobs')
      .where({ id: jobToProcess.id })
      .update({
        ...updatePayload,
        errors: db.raw(`errors || ?::jsonb`, [JSON.stringify(accumulatedErrors)]),
      });
  } else {
    await db('import_jobs').where({ id: jobToProcess.id }).update(updatePayload);
  }

  result.status = status;
  return result;
}

module.exports = {
  SUPPORTED_KINDS,
  KIND_URL_TO_DB,
  normalizeKind,
  requestUploadUrl,
  registerJob,
  getJob,
  listJobs,
  runWorkerTick,
};
