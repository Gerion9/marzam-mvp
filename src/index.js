const fs = require('fs');
const config = require('./config');
const app = require('./app');

if (config.photos.provider === 'local') {
  const path = require('path');
  const photosDir = path.resolve(config.photos.storageDir);
  if (!fs.existsSync(photosDir)) {
    fs.mkdirSync(photosDir, { recursive: true });
  }
}

app.listen(config.port, () => {
  console.log(`Marzam MVP API listening on port ${config.port} [${config.env}]`);
});
