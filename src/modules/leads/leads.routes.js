const { Router } = require('express');
const authenticate = require('../../middleware/auth');
const authorize = require('../../middleware/rbac');
const auditLog = require('../../middleware/auditLog');
const db = require('../../config/database');
const pharmacyService = require('../pharmacies/pharmacies.service');
const { assertLeadTransition } = require('./leads.stateMachine');
const { isExternalDataMode } = require('../../repositories/runtime');

const router = Router();

router.get('/', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), async (req, res, next) => {
  try {
    if (isExternalDataMode()) return res.json([]);
    const q = db('commercial_leads as cl')
      .join('pharmacies as p', 'p.id', 'cl.pharmacy_id')
      .select('cl.*', 'p.name as pharmacy_name', 'p.address as pharmacy_address');
    if (req.query.status) q.where('cl.status', req.query.status);
    if (req.query.pharmacy_id) q.where('cl.pharmacy_id', req.query.pharmacy_id);
    q.orderBy('cl.created_at', 'desc');
    res.json(await q);
  } catch (err) { next(err); }
});

router.get('/pharmacy/:pharmacyId', authenticate, async (req, res, next) => {
  try {
    if (isExternalDataMode()) return res.json([]);
    if (req.user.role === 'field_rep') {
      const assigned = await pharmacyService.isAssignedToRep(req.params.pharmacyId, req.user.id);
      if (!assigned) {
        return res.status(403).json({ error: 'You are not assigned to this pharmacy' });
      }
    }
    const leads = await db('commercial_leads')
      .where({ pharmacy_id: req.params.pharmacyId })
      .orderBy('created_at', 'desc');
    res.json(leads);
  } catch (err) { next(err); }
});

router.patch('/:id', authenticate, authorize({ roles: ['national_admin', 'regional_manager', 'area_coordinator'] }), auditLog('lead.updated'), async (req, res, next) => {
  try {
    if (isExternalDataMode()) {
      return res.status(501).json({ error: 'Commercial leads updates are not available in external data mode' });
    }
    const lead = await db('commercial_leads').where({ id: req.params.id }).first();
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    if (req.body.status && req.body.status !== lead.status) {
      assertLeadTransition(lead.status, req.body.status);
    }

    const { status, notes, potential_sales, contact_person, contact_phone } = req.body;
    const updatePayload = { updated_at: db.fn.now() };
    if (status !== undefined) updatePayload.status = status;
    if (notes !== undefined) updatePayload.notes = notes;
    if (potential_sales !== undefined) updatePayload.potential_sales = potential_sales;
    if (contact_person !== undefined) updatePayload.contact_person = contact_person;
    if (contact_phone !== undefined) updatePayload.contact_phone = contact_phone;

    const [updated] = await db('commercial_leads')
      .where({ id: req.params.id })
      .update(updatePayload)
      .returning('*');

    res.locals.auditDetail = {
      entityType: 'commercial_lead',
      entityId: lead.id,
      before: lead,
      after: updated,
    };

    res.json(updated);
  } catch (err) { next(err); }
});

module.exports = router;
