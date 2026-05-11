/**
 * Audit O5 — central catalog of `audit_events.action` strings.
 *
 * Pre-audit, every call site used a string literal: `auditLog('user.created')`,
 * `auditLog('assignment.reordered')`, etc. There were 30+ event names with no
 * single registry, so reviewers had to grep to find what had been emitted and
 * frontend dashboards had no authoritative list. This file fixes that.
 *
 * Convention: `<entity>.<verb>` lowercase snake_case. Every audit-tracked write
 * in src/modules/* should reference one of these constants. The companion test
 * (tests/audit/auditEventsCatalog.test.js) parses src/ and fails CI if any
 * `auditLog('...')` literal is not present in this catalog — that's the
 * tripwire so no event slips into prod undocumented.
 */

const AUDIT_EVENTS = Object.freeze({
  // ── Assignment lifecycle ─────────────────────────────────────────────────
  ASSIGNMENT_CREATED: 'assignment.created',
  ASSIGNMENT_WAVE_CREATED: 'assignment.wave_created',
  ASSIGNMENT_STATUS_CHANGED: 'assignment.status_changed',
  ASSIGNMENT_UPDATED: 'assignment.updated',
  ASSIGNMENT_REORDERED: 'assignment.reordered',
  ASSIGNMENT_STOPS_ADDED: 'assignment.stops_added',
  ASSIGNMENT_STOP_REMOVED: 'assignment.stop_removed',

  // ── Pharmacy & territory ─────────────────────────────────────────────────
  PHARMACY_UPDATED: 'pharmacy.updated',
  COLONIA_SECURITY_UPDATED: 'colonia.security_updated',
  COLONIA_BATCH_SECURITY_UPDATED: 'colonia.batch_security_updated',

  // ── Visit lifecycle ──────────────────────────────────────────────────────
  VISIT_SUBMITTED: 'visit.submitted',
  VISIT_PHOTO_UPLOADED: 'visit.photo_uploaded',
  VISIT_STAGING_PHOTO_UPLOADED: 'visit.staging_photo_uploaded',

  // ── Onboarding (alta de farmacia) ────────────────────────────────────────
  ONBOARDING_CREATED: 'onboarding.created',
  ONBOARDING_UPDATED: 'onboarding.updated',
  ONBOARDING_DOC_UPLOADED: 'onboarding.doc_uploaded',
  ONBOARDING_PRODUCT_ADDED: 'onboarding.product_added',
  ONBOARDING_PRODUCT_DELETED: 'onboarding.product_deleted',
  ONBOARDING_SUBMITTED: 'onboarding.submitted',
  ONBOARDING_CREDIT_DECIDED: 'onboarding.credit_decided',

  // ── Review queue ─────────────────────────────────────────────────────────
  REVIEW_RESOLVED: 'review.resolved',
  REVIEW_BATCH_RESOLVED: 'review.batch_resolved',

  // ── User lifecycle ───────────────────────────────────────────────────────
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DEACTIVATED: 'user.deactivated',
  USER_PASSWORD_RESET: 'user.password_reset',
  USER_HOME_UPDATED: 'user.home_updated',
  USER_SKILLS_SELF_UPDATED: 'user.skills_self_updated',
  USER_SKILLS_UPDATED_BY_ADMIN: 'user.skills_updated_by_admin',

  // ── Leads ────────────────────────────────────────────────────────────────
  LEAD_UPDATED: 'lead.updated',

  // ── Quotas ───────────────────────────────────────────────────────────────
  QUOTA_ROLE_CAPACITY_UPSERT: 'quota.role_capacity.upsert',
  QUOTA_UPSERT: 'quota.upsert',
  QUOTA_UNIFORM: 'quota.uniform',

  // ── Invitations ──────────────────────────────────────────────────────────
  INVITATION_CREATED: 'invitation.created',
  INVITATION_BULK_CREATED: 'invitation.bulk_created',
});

const ALL_AUDIT_EVENT_NAMES = Object.freeze(
  Object.values(AUDIT_EVENTS).slice().sort(),
);

const AUDIT_EVENT_NAME_SET = new Set(ALL_AUDIT_EVENT_NAMES);

function isKnownAuditEvent(name) {
  return AUDIT_EVENT_NAME_SET.has(name);
}

module.exports = {
  AUDIT_EVENTS,
  ALL_AUDIT_EVENT_NAMES,
  isKnownAuditEvent,
};
