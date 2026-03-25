require('dotenv').config();
const cron = require('node-cron');
const { createApp } = require('./api');
const { runScan } = require('./scanner/orchestrator');
const config = require('./config');

async function main() {
  const port = process.env.PORT || 7777;
  const host = process.env.HOST || '127.0.0.1';

  const app = createApp();
  app.listen(port, host, () => {
    console.log(`Sauron is watching at http://${host}:${port}`);
  });

  const scheduleEnabled = process.env.SCHEDULE_ENABLED === 'true';
  if (scheduleEnabled) {
    const quickCron = process.env.SCHEDULE_QUICK_CRON;
    const deepCron = process.env.SCHEDULE_DEEP_CRON;

    if (quickCron && cron.validate(quickCron)) {
      cron.schedule(quickCron, () => {
        console.log('[scheduler] Running scheduled quick scan...');
        runScan(config.load(), 'quick').catch(console.error);
      });
      console.log(`[scheduler] Quick scan: ${quickCron}`);
    }

    if (deepCron && cron.validate(deepCron)) {
      cron.schedule(deepCron, () => {
        console.log('[scheduler] Running scheduled deep scan...');
        runScan(config.load(), 'deep').catch(console.error);
      });
      console.log(`[scheduler] Deep scan: ${deepCron}`);
    }

    if (!quickCron && !deepCron) {
      console.warn('[scheduler] SCHEDULE_ENABLED=true but no cron expressions set');
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
