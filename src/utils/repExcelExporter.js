const XLSX = require('xlsx');

const GOOGLE_MAPS_MAX_WAYPOINTS = 8;

function buildSinglePointUrl(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function buildDirectionsUrl(points) {
  if (!points.length) return null;
  if (points.length === 1) return buildSinglePointUrl(points[0].lat, points[0].lng);
  const origin = `${points[0].lat},${points[0].lng}`;
  const destination = `${points[points.length - 1].lat},${points[points.length - 1].lng}`;
  const waypoints = points.slice(1, -1).map((p) => `${p.lat},${p.lng}`).join('|');
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
  if (waypoints) url += `&waypoints=${encodeURIComponent(waypoints)}&dir_action=navigate`;
  return url;
}

function buildChunkedRouteUrls(points) {
  const maxPerChunk = GOOGLE_MAPS_MAX_WAYPOINTS + 2;
  if (points.length <= maxPerChunk) return [buildDirectionsUrl(points)];
  const urls = [];
  let i = 0;
  while (i < points.length - 1) {
    const end = Math.min(i + maxPerChunk, points.length);
    urls.push(buildDirectionsUrl(points.slice(i, end)));
    i = end - 1;
  }
  return urls.filter(Boolean);
}

function buildRepWorkbook(repName, repEmail, stops, waveId, campaignObjective) {
  const wb = XLSX.utils.book_new();

  const validStops = stops.filter((s) => s.lat != null && s.lng != null);
  const routePoints = validStops.map((s) => ({ lat: s.lat, lng: s.lng }));
  const routeUrls = buildChunkedRouteUrls(routePoints);

  const infoRows = [
    ['Representante', repName],
    ['Correo', repEmail],
    ['Oleada', waveId || ''],
    ['Objetivo', campaignObjective || ''],
    ['Total Farmacias', stops.length],
    [''],
    ['Ruta Completa en Google Maps'],
  ];
  routeUrls.forEach((url, i) => {
    infoRows.push([`Tramo ${i + 1} de ${routeUrls.length}`, url]);
  });

  const wsInfo = XLSX.utils.aoa_to_sheet(infoRows);
  wsInfo['!cols'] = [{ wch: 35 }, { wch: 120 }];
  XLSX.utils.book_append_sheet(wb, wsInfo, 'Info');

  const stopsData = stops.map((s, i) => ({
    '#': s.route_order || i + 1,
    'Nombre Farmacia': s.name || '',
    'Dirección': s.address || '',
    'Municipio': s.municipality || '',
    'Latitud': s.lat,
    'Longitud': s.lng,
    'Link Google Maps': s.lat != null ? buildSinglePointUrl(s.lat, s.lng) : '',
    'Resultado': '',
    'Notas / Observaciones': '',
    'Potencial de Pedido ($)': '',
    'Productos Competencia': '',
    'Observaciones Inventario': '',
    'Contacto': '',
    'Teléfono': '',
    'Requiere Seguimiento (Sí/No)': '',
    'Fecha Seguimiento': '',
    'Motivo Seguimiento': '',
    'Foto Tomada (Sí/No)': '',
  }));

  const wsStops = XLSX.utils.json_to_sheet(stopsData);
  wsStops['!cols'] = [
    { wch: 4 }, { wch: 35 }, { wch: 40 }, { wch: 22 },
    { wch: 10 }, { wch: 10 }, { wch: 55 },
    { wch: 20 }, { wch: 35 }, { wch: 18 },
    { wch: 25 }, { wch: 25 }, { wch: 20 }, { wch: 15 },
    { wch: 22 }, { wch: 16 }, { wch: 25 }, { wch: 18 },
  ];

  const resultOptions = '"Visitado,Contacto realizado,Interesado,No interesado,Requiere seguimiento,Cerrado,Inválido,Duplicado,Se mudó,Categoría incorrecta,Cadena / No independiente"';
  const siNoOptions = '"Sí,No"';
  const dataValidations = [];
  for (let row = 1; row <= stops.length; row++) {
    dataValidations.push(
      { sqref: `H${row + 1}`, type: 'list', formula1: resultOptions },
      { sqref: `O${row + 1}`, type: 'list', formula1: siNoOptions },
      { sqref: `R${row + 1}`, type: 'list', formula1: siNoOptions },
    );
  }

  XLSX.utils.book_append_sheet(wb, wsStops, 'Ruta');

  const outcomeRef = [
    ['Valor App', 'Valor Excel'],
    ['visited', 'Visitado'],
    ['contact_made', 'Contacto realizado'],
    ['interested', 'Interesado'],
    ['not_interested', 'No interesado'],
    ['needs_follow_up', 'Requiere seguimiento'],
    ['closed', 'Cerrado'],
    ['invalid', 'Inválido'],
    ['duplicate', 'Duplicado'],
    ['moved', 'Se mudó'],
    ['wrong_category', 'Categoría incorrecta'],
    ['chain_not_independent', 'Cadena / No independiente'],
  ];
  const wsRef = XLSX.utils.aoa_to_sheet(outcomeRef);
  wsRef['!cols'] = [{ wch: 25 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, wsRef, 'Referencia');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function buildAllRepsWorkbook(repsWithStops) {
  const wb = XLSX.utils.book_new();

  const summaryRows = repsWithStops.map((r) => ({
    'Representante': r.repName,
    'Correo': r.repEmail,
    'Farmacias Asignadas': r.stops.length,
    'Oleada': r.waveId || '',
  }));
  const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
  wsSummary['!cols'] = [{ wch: 25 }, { wch: 30 }, { wch: 18 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, wsSummary, 'Resumen');

  const allStops = [];
  for (const rep of repsWithStops) {
    for (const s of rep.stops) {
      allStops.push({
        'Representante': rep.repName,
        '#': s.route_order,
        'Nombre Farmacia': s.name || '',
        'Dirección': s.address || '',
        'Municipio': s.municipality || '',
        'Latitud': s.lat,
        'Longitud': s.lng,
        'Link Google Maps': s.lat != null ? buildSinglePointUrl(s.lat, s.lng) : '',
        'Resultado': '',
        'Notas / Observaciones': '',
        'Potencial de Pedido ($)': '',
        'Contacto': '',
        'Teléfono': '',
      });
    }
  }
  const wsAll = XLSX.utils.json_to_sheet(allStops);
  wsAll['!cols'] = [
    { wch: 25 }, { wch: 4 }, { wch: 35 }, { wch: 40 }, { wch: 22 },
    { wch: 10 }, { wch: 10 }, { wch: 55 },
    { wch: 20 }, { wch: 35 }, { wch: 18 }, { wch: 20 }, { wch: 15 },
  ];
  XLSX.utils.book_append_sheet(wb, wsAll, 'Todas las Rutas');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildRepWorkbook, buildAllRepsWorkbook };
