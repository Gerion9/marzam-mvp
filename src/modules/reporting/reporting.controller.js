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

module.exports = { dashboard, repProductivity, coverageByMunicipality, assignmentProgress, refreshViews, exportPharmacies };
