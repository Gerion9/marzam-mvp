const fs = require('fs');
const path = require('path');

const {
  DEFAULT_INPUT_PATH,
  DEFAULT_OUTPUT_PATH,
  readRawRows,
  normalizePharmacies,
  createDemoDataset,
} = require('./ecatepec-data');

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT_PATH, output: DEFAULT_OUTPUT_PATH };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--input' && argv[index + 1]) {
      args.input = path.resolve(argv[index + 1]);
      index += 1;
    } else if (token === '--output' && argv[index + 1]) {
      args.output = path.resolve(argv[index + 1]);
      index += 1;
    }
  }

  return args;
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const rows = readRawRows(args.input);
  const pharmacies = normalizePharmacies(rows);
  const dataset = createDemoDataset(pharmacies);

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, JSON.stringify(dataset, null, 2), 'utf8');

  console.log(`Ecatepec demo dataset generated.`);
  console.log(`Input:  ${args.input}`);
  console.log(`Output: ${args.output}`);
  console.log(`Pharmacies: ${dataset.meta.pharmacy_count}`);
  console.log(`Assigned:   ${dataset.meta.assigned_pharmacy_count}`);
  console.log(`Review:     ${dataset.meta.review_count}`);
}

run();
