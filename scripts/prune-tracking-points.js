const db = require('../src/config/database');
const config = require('../src/config');

function parseArgs(argv) {
  const args = {
    days: config.gps.retentionDays,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--days' && argv[index + 1]) {
      args.days = Number.parseInt(argv[index + 1], 10);
      index += 1;
    }
  }

  return args;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const result = await db('rep_tracking_points')
    .whereRaw(`recorded_at < now() - (? || ' days')::interval`, [String(args.days)])
    .del();

  console.log(`Deleted ${result} tracking points older than ${args.days} days.`);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
