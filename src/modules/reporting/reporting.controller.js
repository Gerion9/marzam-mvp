const reportingService = require('./reporting.service');
const { toXlsx, toCsv } = require('../../utils/exporters');

async function dashboard(req, res, next) {
  try {
    const data = await reportingService.getDashboard();
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function repProductivity(req, res, next) {
  try {
    const data = await reportingService.getRepProductivity();
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function coverageByMunicipality(req, res, next) {
  try {
    const data = await reportingService.getCoverageByMunicipality();
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function assignmentProgress(req, res, next) {
  try {
    const data = await reportingService.getAssignmentProgress(req.query);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function refreshViews(req, res, next) {
  try {
    await reportingService.refreshViews();
    res.json({ message: 'Materialized views refreshed' });
  } catch (err) {
    next(err);
  }
}

// ── Marzam Execution Doc §10 — KPIs locked set ────────────────────────────
async function routeAdherence(req, res, next) {
  try { res.json(await reportingService.getRouteAdherence(req.query)); } catch (err) { next(err); }
}
async function visitDuration(req, res, next) {
  try { res.json(await reportingService.getVisitDuration(req.query)); } catch (err) { next(err); }
}
async function prospectFunnel(req, res, next) {
  try { res.json(await reportingService.getProspectFunnel(req.query)); } catch (err) { next(err); }
}
async function salesVsTarget(req, res, next) {
  try { res.json(await reportingService.getSalesVsTarget(req.query)); } catch (err) { next(err); }
}
async function routesOnTime(req, res, next) {
  try { res.json(await reportingService.getRoutesStartedOnTime(req.query)); } catch (err) { next(err); }
}

async function exportPharmacies(req, res, next) {
  try {
    const rows = await reportingService.exportPharmacies(req.query);
    const format = req.query.format || 'csv';

    if (format === 'xlsx') {
      const buffer = toXlsx(rows, 'Pharmacies');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename=pharmacies.xlsx');
      return res.send(buffer);
    }

    const csv = toCsv(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=pharmacies.csv');
    res.send(csv);
  } catch (err) {
    next(err);
  }
}

async function exportRepRoute(req, res, next) {
  try {
    const { buildRepWorkbook } = require('../../utils/repExcelExporter');
    const repsData = await reportingService.getRepAssignmentsForExport();
    const repId = req.params.repId;
    const rep = repsData.find((r) => r.repId === repId);
    if (!rep) return res.status(404).json({ error: 'Rep no encontrado o sin asignación activa' });

    const buffer = buildRepWorkbook(rep.repName, rep.repEmail, rep.stops, rep.waveId, rep.campaignObjective);
    const safeName = rep.repName.replace(/[^a-zA-Z0-9_ ]/g, '').replace(/\s+/g, '_');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=ruta_${safeName}.xlsx`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

async function exportAllRepRoutes(req, res, next) {
  try {
    const { buildAllRepsWorkbook } = require('../../utils/repExcelExporter');
    const repsData = await reportingService.getRepAssignmentsForExport();
    if (!repsData.length) return res.status(404).json({ error: 'No hay asignaciones activas' });

    const buffer = buildAllRepsWorkbook(repsData);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=rutas_todos_reps.xlsx');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

async function visitDetail(req, res, next) {
  try {
    const data = await reportingService.getVisitDetail(req.query);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function flotillaSummary(req, res, next) {
  try {
    const data = await reportingService.getFlotillaSummary();
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// Coverage actionable views (mig 079 — pharmacy_presence).
async function coveragePending(req, res, next) {
  try {
    res.json(await reportingService.getCoveragePending(req.query));
  } catch (err) { next(err); }
}

async function myCoverage(req, res, next) {
  try {
    res.json(await reportingService.getMyCoverage({
      userId: req.user?.id,
      days: req.query.days,
    }));
  } catch (err) { next(err); }
}

module.exports = {
  dashboard, repProductivity, coverageByMunicipality, assignmentProgress, refreshViews,
  exportPharmacies, exportRepRoute, exportAllRepRoutes, visitDetail, flotillaSummary,
  // Marzam Execution Doc §10 KPI set:
  routeAdherence, visitDuration, prospectFunnel, salesVsTarget, routesOnTime,
  // Coverage views (pharmacy_presence):
  coveragePending, myCoverage,
};
