require('dotenv').config();
const cron = require('node-cron');
const { createApp } = require('./api');
const { runScan } = require('./scanner/orchestrator');
const config = require('./config');

async function main() {
  const cfg = config.load();
  const port = cfg.port || 7777;

  const app = createApp();
  app.listen(port, () => {
    console.log(`Sauron is watching at http://localhost:${port}`);
  });

  if (cfg.scheduleEnabled && cfg.scheduleCron) {
    if (cron.validate(cfg.scheduleCron)) {
      cron.schedule(cfg.scheduleCron, () => {
        console.log('[scheduler] Running scheduled deep scan...');
        runScan(config.load(), 'deep').catch(console.error);
      });
      console.log(`[scheduler] Scheduled scan: ${cfg.scheduleCron}`);
    } else {
      console.warn(`[scheduler] Invalid cron expression: ${cfg.scheduleCron}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
