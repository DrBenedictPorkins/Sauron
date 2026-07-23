require('dotenv').config();
const { createApp } = require('./api');

async function main() {
  const port = process.env.PORT || 7777;
  const host = process.env.HOST || '127.0.0.1';

  const app = createApp();
  app.listen(port, host, () => {
    console.log(`Sauron is watching at http://${host}:${port}`);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
