/**
 * Chart.js wrappers for the admin cockpit — monochromatic, editorial.
 * All charts use a near-black palette plus a single colored accent so the
 * data is the protagonist (vs the manager's role-colored palette).
 *
 * Palette pulls live values from the BlackPrint Design System tokens on
 * <html>:root, so body.bp-mode automatically flips the accent from blue
 * to pink without duplicating chart code.
 */
(function () {
  if (!window.Chart) { console.warn('[admin/charts] Chart.js not loaded'); return; }

  const rootStyle = getComputedStyle(document.documentElement);
  const tok = (name, fallback) => {
    const v = rootStyle.getPropertyValue(name).trim();
    return v || fallback;
  };
  const INK_1 = tok('--on-secondary', '#231F20');
  const INK_2 = tok('--depth-6', '#646669');
  const INK_4 = tok('--depth-5', '#8D9398');
  const GRID = tok('--border-2', '#E7E6EA');
  const POS = tok('--success', '#0CA036');
  const ACCENT = document.body.classList.contains('bp-mode')
    ? tok('--pink-p', '#FE2B7C')
    : tok('--blue-p', '#0875E3');

  Chart.defaults.font.family = "'Work Sans', 'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = INK_4;
  Chart.defaults.scale.grid.color = GRID;
  Chart.defaults.scale.grid.borderColor = GRID;

  function sparkline(canvas, values, opts = {}) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    return new Chart(ctx, {
      type: 'line',
      data: {
        labels: values.map((_, i) => i),
        datasets: [{
          data: values,
          borderColor: opts.color || INK_1,
          borderWidth: 1.5,
          fill: false,
          tension: 0.32,
          pointRadius: 0,
          pointHoverRadius: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false, grace: '10%' },
        },
        animation: false,
      },
    });
  }

  function trendChart(canvas, series) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const labels = (series.visits || []).map((p) => p.bucket);
    const visits = (series.visits || []).map((p) => p.value);
    const compliance = (series.compliance || []).map((p) => p.value);

    return new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Visitas',
            data: visits,
            borderColor: INK_1,
            backgroundColor: 'rgba(35,31,32,0.06)',
            borderWidth: 2,
            fill: true,
            tension: 0.32,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointBackgroundColor: INK_1,
            yAxisID: 'y',
          },
          {
            label: 'Compliance %',
            data: compliance,
            borderColor: ACCENT,
            borderWidth: 1.4,
            borderDash: [4, 4],
            fill: false,
            tension: 0.2,
            pointRadius: 0,
            pointHoverRadius: 3,
            yAxisID: 'y2',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            align: 'start',
            labels: { boxWidth: 8, boxHeight: 8, color: INK_2, padding: 12, font: { size: 11 } },
          },
          tooltip: {
            backgroundColor: INK_1,
            titleColor: '#fff', bodyColor: '#fff',
            padding: 10,
            cornerRadius: 6,
            displayColors: false,
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { maxTicksLimit: 7, font: { size: 10 } },
          },
          y: {
            position: 'left',
            grid: { color: GRID, lineWidth: 1 },
            ticks: { font: { size: 10 } },
          },
          y2: {
            position: 'right',
            grid: { display: false },
            ticks: { font: { size: 10 }, callback: (v) => v + '%' },
            min: 0, max: 100,
          },
        },
      },
    });
  }

  function horizontalBars(canvas, labels, values, opts = {}) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    return new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: opts.color || INK_1,
          borderRadius: 3,
          barThickness: 14,
        }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { backgroundColor: INK_1 } },
        scales: {
          x: { grid: { color: GRID }, ticks: { font: { size: 10 } } },
          y: { grid: { display: false }, ticks: { font: { size: 11 }, color: INK_2 } },
        },
      },
    });
  }

  function donut(canvas, labels, values) {
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const palette = [INK_1, INK_2, tok('--depth-6', '#646669'), INK_4, tok('--depth-3', '#B7BCC0'), ACCENT, POS];
    return new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: labels.map((_, i) => palette[i % palette.length]),
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 8, color: INK_2, padding: 10, font: { size: 11 } } },
          tooltip: { backgroundColor: INK_1 },
        },
      },
    });
  }

  function destroy(chart) {
    if (chart && typeof chart.destroy === 'function') chart.destroy();
  }

  window.AdminCharts = { sparkline, trendChart, horizontalBars, donut, destroy };
})();
