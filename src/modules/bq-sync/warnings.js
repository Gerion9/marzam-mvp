/**
 * Helper to emit (idempotent) warnings into `bq_sync_warnings`.
 *
 * Use the same `code` for the same kind of issue across runs — the unique
 * index on (job_name, code, COALESCE(subject,'')) means this is an UPSERT that
 * just bumps `occurrence_count` and `last_seen_at` for repeat findings.
 */

async function emitWarning(dbOrTrx, {
  jobName,
  code,
  subject = null,
  detail = {},
  severity = 'warn',
}) {
  if (!jobName || !code) {
    throw new Error('emitWarning requires { jobName, code }');
  }
  const subjectKey = subject || '';
  await dbOrTrx.raw(
    `
    INSERT INTO bq_sync_warnings (job_name, code, severity, subject, detail)
    VALUES (?, ?, ?, ?, ?::jsonb)
    ON CONFLICT (job_name, code, COALESCE(subject, ''))
    DO UPDATE SET
      last_seen_at      = now(),
      occurrence_count  = bq_sync_warnings.occurrence_count + 1,
      severity          = EXCLUDED.severity,
      detail            = EXCLUDED.detail,
      resolved          = false
    `,
    [jobName, code, severity, subject, JSON.stringify(detail)],
  );
  // also surface to console for the cron logs
  // eslint-disable-next-line no-console
  console.warn(`[bq-sync:${jobName}] ${severity.toUpperCase()} ${code}${subject ? ` (${subject})` : ''}`);
}

module.exports = { emitWarning };
