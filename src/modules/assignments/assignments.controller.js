const assignmentService = require('./assignments.service');

async function create(req, res, next) {
  try {
    const assignment = await assignmentService.create({
      ...req.body,
      created_by: req.user.id,
    });
    res.locals.auditDetail = {
      entityType: 'assignment',
      entityId: assignment.id,
      after: assignment,
    };
    res.status(201).json(assignment);
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    // Field reps only see their own assignments
    const filters = req.user.role === 'field_rep'
      ? { ...req.query, rep_id: req.user.id }
      : req.query;
    const assignments = await assignmentService.list(filters);
    res.json(assignments);
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const assignment = await assignmentService.getById(req.params.id);
    if (req.user.role === 'field_rep' && assignment.rep_id !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden: not your assignment' });
    }
    res.json(assignment);
  } catch (err) {
    next(err);
  }
}

async function updateStatus(req, res, next) {
  try {
    const { before, after } = await assignmentService.updateStatus(
      req.params.id,
      req.body.status,
      req.user.id,
    );
    res.locals.auditDetail = { entityType: 'assignment', entityId: req.params.id, before, after };
    res.json(after);
  } catch (err) {
    next(err);
  }
}

async function checkOverlap(req, res, next) {
  try {
    const overlapping = await assignmentService.checkOverlap(req.body.polygon);
    res.json({ overlapping, has_overlap: overlapping.length > 0 });
  } catch (err) {
    next(err);
  }
}

async function reassign(req, res, next) {
  try {
    const { before, after } = await assignmentService.reassign(req.params.id, req.body, req.user.id);
    res.locals.auditDetail = { entityType: 'assignment', entityId: req.params.id, before, after };
    res.json(after);
  } catch (err) {
    next(err);
  }
}

async function distributeWave(req, res, next) {
  try {
    const result = await assignmentService.distributeWave({
      ...req.body,
      created_by: req.user.id,
    });
    res.locals.auditDetail = {
      entityType: 'assignment_wave',
      entityId: result.wave_id,
      after: {
        assignments_created: result.assignments_created,
        pharmacy_count: result.pharmacy_count,
        rep_count: result.rep_count,
      },
    };
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

async function resetAll(req, res, next) {
  try {
    const result = await assignmentService.resetAllAssignments();
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  create,
  list,
  getById,
  updateStatus,
  checkOverlap,
  reassign,
  distributeWave,
  resetAll,
};
