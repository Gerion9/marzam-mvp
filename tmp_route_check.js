// Temporary smoke: load app, list routes, exit. Cleaned up after.
const app = require('./src/app');

function listRoutes(layer, prefix = '') {
  const out = [];
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
    out.push({ path: prefix + layer.route.path, methods });
  } else if (layer.name === 'router' && layer.handle.stack) {
    let p = prefix;
    if (layer.regexp && layer.regexp.source) {
      const src = layer.regexp.source;
      const m = src.match(/^\^\\\/([^\\?]+)/);
      if (m) p = prefix + '/' + m[1].replace(/\\\//g, '/');
    }
    for (const sub of layer.handle.stack) out.push(...listRoutes(sub, p));
  }
  return out;
}

const all = [];
for (const l of app._router.stack) all.push(...listRoutes(l));
const newRoutes = all.filter((r) => r.path && (
  r.path.includes('reoptimiz')
  || r.path.includes('parse-opening-hours')
));
console.log('Total routes registered:', all.length);
console.log('New PR routes:');
for (const r of newRoutes) {
  console.log('  ' + r.methods.map((m) => m.toUpperCase()).join(',') + ' ' + r.path);
}
process.exit(0);
