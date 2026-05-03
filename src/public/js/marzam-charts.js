/* ====================================================================
   Marzam Charts — wrappers Chart.js para los dashboards de analítica.

   Expone window.MarzamCharts.{
     trendLine,        // Línea: cumplimiento últimos N días
     paretoBar,        // Barras: PARETO A / B / C planeadas vs hechas
     outcomeDoughnut,  // Donut: outcome breakdown (visited, interested, ...)
     hourlyBar,        // Barras: distribución horaria de visitas
     coverageGauge,    // Gauge horizontal: cobertura de padrón
   }

   Cada función recibe (canvasEl, dataset) y devuelve la instancia de
   Chart para que el caller pueda destruirla cuando re-renderiza.
   ==================================================================== */
(function () {
  'use strict';

  if (typeof Chart === 'undefined') {
    console.warn('[charts] Chart.js no cargado — los gráficos se omiten');
    return;
  }

  // Defaults estéticos consistentes con la paleta Marzam.
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.color = '#475569'; // slate-600
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
  Chart.defaults.plugins.legend.labels.boxHeight = 12;

  const PARETO_COLORS = { A: '#dc2626', B: '#f59e0b', C: '#2563eb' };

  function destroyIfExists(canvasEl) {
    if (!canvasEl) return;
    const existing = Chart.getChart(canvasEl);
    if (existing) existing.destroy();
  }

  /**
   * trendLine — línea de cumplimiento últimos N días.
   * dataset: { labels: [], values: [], target?: number }
   */
  function trendLine(canvasEl, dataset) {
    if (!canvasEl) return null;
    destroyIfExists(canvasEl);
    const labels = dataset.labels || dataset.values.map((_, i) => `D-${dataset.values.length - i}`);
    return new Chart(canvasEl, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Cumplimiento',
          data: dataset.values,
          borderColor: '#1b365d',
          backgroundColor: 'rgba(27, 54, 93, 0.08)',
          borderWidth: 2.5,
          tension: 0.35,
          fill: true,
          pointRadius: 2.5,
          pointHoverRadius: 5,
          pointBackgroundColor: '#1b365d',
        }, ...(dataset.target ? [{
          label: 'Meta',
          data: labels.map(() => dataset.target),
          borderColor: '#10b981',
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        }] : [])],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: !!dataset.target, position: 'bottom', labels: { padding: 12 } },
          tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y}%` } },
        },
        scales: {
          y: { beginAtZero: true, max: 100, ticks: { callback: (v) => v + '%' }, grid: { color: 'rgba(0,0,0,0.04)' } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  /**
   * paretoBar — barras planificado vs realizado por categoría PARETO.
   * dataset: [{ pareto: 'A', planned: 100, done: 78 }, ...]
   */
  function paretoBar(canvasEl, dataset) {
    if (!canvasEl) return null;
    destroyIfExists(canvasEl);
    const labels = dataset.map((d) => `PARETO ${d.pareto}`);
    return new Chart(canvasEl, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Planeadas',
            data: dataset.map((d) => d.planned || 0),
            backgroundColor: dataset.map((d) => (PARETO_COLORS[d.pareto] || '#64748b') + '33'),
            borderColor: dataset.map((d) => PARETO_COLORS[d.pareto] || '#64748b'),
            borderWidth: 1.5,
            borderRadius: 6,
          },
          {
            label: 'Realizadas',
            data: dataset.map((d) => d.done || 0),
            backgroundColor: dataset.map((d) => PARETO_COLORS[d.pareto] || '#64748b'),
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { padding: 12 } },
        },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.04)' } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  /**
   * outcomeDoughnut — donut de outcomes.
   * dataset: [{ code, label, count }]
   */
  function outcomeDoughnut(canvasEl, dataset) {
    if (!canvasEl) return null;
    destroyIfExists(canvasEl);
    const palette = ['#10b981', '#0ea5e9', '#6366f1', '#f59e0b', '#ec4899', '#dc2626', '#64748b', '#a855f7', '#14b8a6'];
    const data = dataset.map((d, i) => ({
      label: d.label || d.code,
      count: d.count,
      color: palette[i % palette.length],
    }));
    return new Chart(canvasEl, {
      type: 'doughnut',
      data: {
        labels: data.map((d) => d.label),
        datasets: [{
          data: data.map((d) => d.count),
          backgroundColor: data.map((d) => d.color),
          borderWidth: 2,
          borderColor: '#ffffff',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'right',
            labels: { boxWidth: 10, boxHeight: 10, padding: 8, font: { size: 10 } },
          },
          tooltip: {
            callbacks: {
              label: (c) => `${c.label}: ${c.parsed} (${Math.round((c.parsed / c.dataset.data.reduce((a, b) => a + b, 0)) * 100)}%)`,
            },
          },
        },
      },
    });
  }

  /**
   * hourlyBar — barras por hora del día.
   * dataset: [{ hour: 9, count: 12 }, ...]
   */
  function hourlyBar(canvasEl, dataset) {
    if (!canvasEl) return null;
    destroyIfExists(canvasEl);
    return new Chart(canvasEl, {
      type: 'bar',
      data: {
        labels: dataset.map((d) => `${d.hour}:00`),
        datasets: [{
          label: 'Visitas',
          data: dataset.map((d) => d.count || 0),
          backgroundColor: '#e5730a',
          hoverBackgroundColor: '#c96205',
          borderRadius: 6,
          barPercentage: 0.7,
          categoryPercentage: 0.8,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { precision: 0 } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  /**
   * coverageGauge — gauge horizontal (barra) de cobertura.
   * dataset: { value: 45, max: 100, label?: 'Cobertura' }
   */
  function coverageGauge(canvasEl, dataset) {
    if (!canvasEl) return null;
    destroyIfExists(canvasEl);
    const value = Math.max(0, Math.min(dataset.max || 100, dataset.value || 0));
    const remaining = (dataset.max || 100) - value;
    return new Chart(canvasEl, {
      type: 'doughnut',
      data: {
        datasets: [{
          data: [value, remaining],
          backgroundColor: ['#1b365d', '#e2e8f0'],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        rotation: -90,
        circumference: 180,
        cutout: '75%',
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
        },
      },
    });
  }

  /**
   * stackedTeamBar — barra apilada por miembro del equipo (planned vs done).
   * dataset: [{ name, planned, done }]
   */
  function stackedTeamBar(canvasEl, dataset) {
    if (!canvasEl) return null;
    destroyIfExists(canvasEl);
    return new Chart(canvasEl, {
      type: 'bar',
      data: {
        labels: dataset.map((d) => d.name),
        datasets: [
          {
            label: 'Realizadas',
            data: dataset.map((d) => d.done || 0),
            backgroundColor: '#10b981',
            borderRadius: 4,
          },
          {
            label: 'Pendientes',
            data: dataset.map((d) => Math.max(0, (d.planned || 0) - (d.done || 0))),
            backgroundColor: '#e2e8f0',
            borderRadius: 4,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { padding: 12 } } },
        scales: {
          x: { stacked: true, beginAtZero: true, grid: { color: 'rgba(0,0,0,0.04)' } },
          y: { stacked: true, grid: { display: false } },
        },
      },
    });
  }

  window.MarzamCharts = {
    trendLine,
    paretoBar,
    outcomeDoughnut,
    hourlyBar,
    coverageGauge,
    stackedTeamBar,
    PARETO_COLORS,
  };
})();
