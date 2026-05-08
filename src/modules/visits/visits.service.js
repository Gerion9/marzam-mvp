const db = require('../../config/database');
const {
  validateOutcome,
  OUTCOMES_CREATING_LEAD,
  OUTCOMES_REQUIRING_FOLLOWUP,
  OUTCOMES_CREATING_FLAG,
  OUTCOMES_SKIPPING_STOP,
  OUTCOMES_REQUIRING_PHOTO,
} = require('./visits.stateMachine');
const verificationService = require('../verifications/verifications.service');
const externalFieldSurveyRepository = require('../../repositories/external/fieldSurveyRepository');
const { isExternalDataMode } = require('../../repositories/runtime');
const { parseStopId } = require('../externalData/externalAssignmentIds');
const { signVisitToken, verifyVisitToken } = require('./externalVisitToken');
const alertsEngine = require('../alerts/alerts.engine');

async function submitExternal(data) {
  const parsedStop = data.assignment_stop_id ? parseStopId(data.assignment_stop_id) : {};
  const [currentRow] = await externalFieldSurveyRepository.listCurrentState({
    pharmacy_id: data.pharmacy_id,
    rep_id: data.rep_id,
    assignment_id: parsedStop.assignment_id,
    limit: 100,
  });
  const visited_at = new Date().toISOString();

  await verificationService.syncVisitSubmission({
    payload: data,
    visit: null,
  });

  return {
    id: signVisitToken({
      pharmacy_id: data.pharmacy_id,
      rep_id: data.rep_id,
      assignment_id: parsedStop.assignment_id || currentRow?.assignment_id || null,
      assignment_stop_id: data.assignment_stop_id || null,
      wave_id: currentRow?.wave_id || null,
      visited_at,
      checkin_lat: data.checkin_lat || null,
      checkin_lng: data.checkin_lng || null,
      notes: data.notes || null,
      contact_person: data.contact_person || null,
      contact_phone: data.contact_phone || null,
      order_potential: data.order_potential || null,
    }),
    pharmacy_id: data.pharmacy_id,
    rep_id: data.rep_id,
    assignment_id: parsedStop.assignment_id || currentRow?.assignment_id || null,
    assignment_stop_id: data.assignment_stop_id || null,
    verification_id: parsedStop.assignment_id || currentRow?.assignment_id || null,
    visited_at,
  };
}

async function submit(data) {
  validateOutcome(data.outcome);

  if (OUTCOMES_REQUIRING_FOLLOWUP.includes(data.outcome)) {
    if (!data.follow_up_date) {
      const err = new Error('follow_up_date is required for needs_follow_up outcome');
      err.status = 422;
      throw err;
    }
    if (!data.follow_up_reason) {
      const err = new Error('follow_up_reason is required for needs_follow_up outcome');
      err.status = 422;
      throw err;
    }
  }

  // Skip outcomes (closed/duplicate/moved/etc.) require an explicit reason —
  // legacy flag_reason fallback to notes is dropped because the brief mandates
  // a structured reason. The frontend exposes a dropdown.
  if (OUTCOMES_CREATING_FLAG.includes(data.outcome)) {
    if (!data.flag_reason || !String(data.flag_reason).trim()) {
      const err = new Error('flag_reason is required for skip/flag outcomes');
      err.status = 422;
      err.code = 'flag_reason_required';
      throw err;
    }
  }

  // Hard-block: every outcome listed in OUTCOMES_REQUIRING_PHOTO needs at
  // least one photo at submit time. We accept any of: an explicit photo_url
  // in the payload, a verification with a photo, or a precomputed photo_count.
  // This matches Marzam Execution Doc §6.3: "blocked if missing".
  if (OUTCOMES_REQUIRING_PHOTO.includes(data.outcome)) {
    const hasInlinePhoto = Boolean(
      data.photo_url
      || data.evidence_photo_url
      || (Array.isArray(data.photos) && data.photos.length > 0)
      || data.verification?.photo_url,
    );
    const declaredCount = Number(data.photo_count || 0) > 0;
    if (!hasInlinePhoto && !declaredCount) {
      // Fire alert (best-effort; never let alerting break visit submission)
      // so a manager sees repeated photo-block attempts as a quality signal.
      try {
        await alertsEngine.fireVisitMissingPhoto({
          repId: data.rep_id,
          pharmacyId: data.pharmacy_id,
          attemptedOutcome: data.outcome,
        });
      } catch (_e) { /* swallow — table may not exist yet pre-migration */ }
      const err = new Error('Photo evidence is required to close this visit');
      err.status = 422;
      err.code = 'photo_required';
      throw err;
    }
  }

  // 1 visit per pharmacy per day per Marzam Execution Doc §6.3 "Constraints".
  // We check before insert so we return a friendlier 409 rather than a raw
  // unique-constraint error, but the DB-level UNIQUE index (added in mig 053)
  // is the source of truth.
  if (!isExternalDataMode() && data.pharmacy_id && data.rep_id) {
    const today = new Date().toISOString().slice(0, 10);
    const dup = await db('visit_reports')
      .where({ pharmacy_id: data.pharmacy_id, rep_id: data.rep_id })
      .andWhereRaw('date(created_at) = ?', [today])
      .first();
    if (dup) {
      const err = new Error('Esta farmacia ya fue visitada hoy por este representante');
      err.status = 409;
      err.code = 'visit_already_today';
      throw err;
    }
  }

  if (isExternalDataMode()) {
    return submitExternal(data);
  }

  const idempotencyKey = data._idempotencyKey || null;

  if (idempotencyKey) {
    const existing = await db('visit_reports').where({ idempotency_key: idempotencyKey }).first();
    if (existing) return existing;
  }

  return db.transaction(async (trx) => {
    const [visit] = await trx('visit_reports')
      .insert({
        assignment_stop_id: data.assignment_stop_id,
        pharmacy_id: data.pharmacy_id,
        rep_id: data.rep_id,
        outcome: data.outcome,
        notes: data.notes || null,
        order_potential: data.order_potential || null,
        contact_person: data.contact_person || null,
        contact_phone: data.contact_phone || null,
        contact_name: data.contact_name || null,
        contact_email: data.contact_email || null,
        competitor_products: data.competitor_products || null,
        stock_observations: data.stock_observations || null,
        wholesalers: data.wholesalers || null,
        visit_observations: data.visit_observations || null,
        competition_info: data.competition_info || null,
        competition_prices: data.competition_prices || null,
        competition_offers: data.competition_offers || null,
        follow_up_date: data.follow_up_date || null,
        follow_up_reason: data.follow_up_reason || null,
        flag_reason: data.flag_reason || null,
        checkin_lat: data.checkin_lat || null,
        checkin_lng: data.checkin_lng || null,
        order_placed: !!data.order_placed,
        no_order_reason: data.order_placed ? null : (data.no_order_reason || null),
        order_amount: data.order_amount != null && data.order_amount !== '' ? Number(data.order_amount) : null,
        idempotency_key: idempotencyKey,
      })
      .returning('*');

    if (Array.isArray(data.products) && data.products.length) {
      const rows = data.products
        .filter((p) => p && p.product_name && String(p.product_name).trim())
        .map((p) => ({
          visit_id: visit.id,
          product_name: String(p.product_name).trim(),
          presentation: p.presentation || null,
          price_pharmacy: p.price_pharmacy != null && p.price_pharmacy !== '' ? Number(p.price_pharmacy) : null,
          price_marzam: p.price_marzam != null && p.price_marzam !== '' ? Number(p.price_marzam) : null,
          included_in_order: !!p.included_in_order,
          notes: p.notes || null,
        }));
      if (rows.length) await trx('visit_products').insert(rows);
    }

    if (data.assignment_stop_id) {
      const stopStatus = OUTCOMES_SKIPPING_STOP.includes(data.outcome) ? 'skipped' : 'completed';
      await trx('assignment_stops')
        .where({ id: data.assignment_stop_id })
        .update({ stop_status: stopStatus, completed_at: trx.fn.now() });
    }

    const pharmacyUpdates = {
      last_visit_outcome: data.outcome,
      last_visited_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    };
    if (data.contact_person) pharmacyUpdates.contact_person = data.contact_person;
    if (data.contact_phone) pharmacyUpdates.contact_phone = data.contact_phone;
    if (data.contact_email) pharmacyUpdates.contact_email = data.contact_email;
    if (data.contact_name) pharmacyUpdates.contact_person = data.contact_name;

    await trx('pharmacies')
      .where({ id: data.pharmacy_id })
      .update(pharmacyUpdates);

    // Side-effect: create commercial lead
    if (OUTCOMES_CREATING_LEAD.includes(data.outcome)) {
      await trx('commercial_leads').insert({
        pharmacy_id: data.pharmacy_id,
        visit_id: visit.id,
        status: 'interested',
        potential_sales: data.order_potential || null,
        contact_person: data.contact_person || null,
        contact_phone: data.contact_phone || null,
        notes: data.notes || null,
        created_by: data.rep_id,
      });
    }

    // Side-effect: enqueue flag for review
    if (OUTCOMES_CREATING_FLAG.includes(data.outcome)) {
      await trx('review_queue_items').insert({
        pharmacy_id: data.pharmacy_id,
        visit_id: visit.id,
        flag_type: data.outcome,
        reason: data.flag_reason || data.notes || null,
        submitted_by: data.rep_id,
        queue_status: 'pending',
      });
      // Fire manager alert for closed/duplicate cases (Marzam Execution Doc §8 #5).
      // Best-effort: outside the transaction is fine, this is a notification.
      try {
        await alertsEngine.fireCustomerClosed({
          repId: data.rep_id,
          pharmacyId: data.pharmacy_id,
          outcome: data.outcome,
          flagReason: data.flag_reason || null,
        });
      } catch (_e) { /* swallow */ }
    }

    if (data.assignment_stop_id) {
      const stop = await trx('assignment_stops').where({ id: data.assignment_stop_id }).first();
      const pending = await trx('assignment_stops')
        .where({ assignment_id: stop.assignment_id, stop_status: 'pending' })
        .count('id as cnt')
        .first();

      if (Number(pending.cnt) === 0) {
        await trx('territory_assignments')
          .where({ id: stop.assignment_id })
          .update({ status: 'completed', updated_at: trx.fn.now() });
      }
    }

    const { verification } = await verificationService.syncVisitSubmission({
      trx,
      visit,
      payload: data,
    });

    return {
      ...visit,
      verification_id: verification?.id || null,
      photo_url: verification?.photo_url || null,
    };
  });
}

async function listByPharmacy(pharmacyId) {
  if (isExternalDataMode()) {
    const rows = await verificationService.listByPharmacy(pharmacyId);
    return rows.map((row) => ({
      id: row.id,
      pharmacy_id: row.pharmacy_id,
      rep_id: row.rep_id,
      outcome: row.visit_status,
      notes: row.comment,
      order_potential: row.order_potential,
      contact_person: row.contact_name,
      contact_phone: row.contact_phone,
      checkin_lat: row.checkin_lat,
      checkin_lng: row.checkin_lng,
      created_at: row.visited_at || row.assigned_at,
      photo_url: row.photo_url,
    }));
  }

  return db('visit_reports')
    .where({ pharmacy_id: pharmacyId })
    .orderBy('created_at', 'desc');
}

async function listByRep(repId, filters = {}) {
  if (isExternalDataMode()) {
    const rows = await verificationService.listEvidence({ rep_id: repId, limit: filters.limit || 500 });
    return rows.map((row) => ({
      id: row.id,
      pharmacy_id: row.pharmacy_id,
      rep_id: row.rep_id,
      outcome: row.visit_status,
      notes: row.comment,
      order_potential: row.order_potential,
      created_at: row.visited_at || row.assigned_at,
      photo_url: row.photo_url,
    }));
  }

  const q = db('visit_reports').where({ rep_id: repId });
  if (filters.from) q.where('created_at', '>=', filters.from);
  if (filters.to) q.where('created_at', '<=', filters.to);
  return q.orderBy('created_at', 'desc');
}

async function getById(id) {
  if (isExternalDataMode()) {
    return { id, ...verifyVisitToken(id) };
  }

  const visit = await db('visit_reports').where({ id }).first();
  if (!visit) {
    const err = new Error('Visit not found');
    err.status = 404;
    throw err;
  }
  return visit;
}

async function addPhoto(visitId, photoData) {
  if (isExternalDataMode()) {
    const visit = verifyVisitToken(visitId);
    const verification = await verificationService.attachPhotoToVisit({
      visitId: visit,
      photoUrl: photoData.photo_url,
      bucket: photoData.bucket,
      objectPath: photoData.object_path,
      mimeType: photoData.mime_type,
      sizeBytes: photoData.size_bytes,
    });
    return {
      id: visitId,
      visit_id: visitId,
      photo_url: verification?.photo_url || photoData.photo_url,
      verification_id: verification?.assignmentId || visit.assignment_id || null,
      original_name: photoData.original_name,
      mime_type: photoData.mime_type,
      size_bytes: photoData.size_bytes,
    };
  }

  return db.transaction(async (trx) => {
    const [photo] = await trx('visit_photos')
      .insert({
        visit_id: visitId,
        file_path: photoData.object_path,
        original_name: photoData.original_name,
        mime_type: photoData.mime_type,
        size_bytes: photoData.size_bytes,
      })
      .returning('*');

    const verification = await verificationService.attachPhotoToVisit({
      trx,
      visitId,
      photoUrl: photoData.photo_url,
      bucket: photoData.bucket,
      objectPath: photoData.object_path,
      mimeType: photoData.mime_type,
      sizeBytes: photoData.size_bytes,
    });

    return {
      ...photo,
      photo_url: verification?.photo_url || photoData.photo_url,
      verification_id: verification?.id || null,
    };
  });
}

async function listProducts(visitId) {
  return db('visit_products').where({ visit_id: visitId }).orderBy('created_at', 'asc');
}

module.exports = { submit, listByPharmacy, listByRep, getById, addPhoto, listProducts };
