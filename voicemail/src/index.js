'use strict';

require('dotenv').config({ path: '/root/carson-voicemail/.env' });

const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const voiceRoutes = require('./voiceRoutes');
const { sendDailySummary } = require('./dailySummary');
const { getBot, setupWebhook, processUpdate } = require('./telegram');

// Ensure directories exist
const DIRS = [
  '/root/carson-voicemail/data',
  '/root/carson-voicemail/data/recordings',
  '/root/carson-voicemail/logs',
  config.RECORDING_DIR,
];
for (const d of DIRS) {
  fs.mkdirSync(d, { recursive: true });
}

// Initialize DB
db.getDb();

// Initialize Express
const app = express();

// Trust proxy
app.set('trust proxy', true);

// Body parsing
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  if (req.path !== '/health') {
    logger.info(`${req.method} ${req.path}`, {
      ip: req.ip,
      userAgent: req.headers['user-agent']?.slice(0, 80),
    });
  }
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'carson-voicemail',
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Twilio voice webhooks
app.use('/voice', voiceRoutes);

// Telegram webhook endpoint (receives updates from Telegram)
app.post('/telegram/webhook', async (req, res) => {
  res.sendStatus(200); // Always respond fast
  try {
    await processUpdate(req.body);
  } catch (err) {
    logger.error('Telegram webhook error', { error: err.message });
  }
});

// Admin: list recent voicemails (local access only)
app.get('/admin/voicemails', (req, res) => {
  try {
    const d = db.getDb();
    const rows = d.prepare('SELECT * FROM voicemails ORDER BY created_at DESC LIMIT 50').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: trigger daily summary manually
app.post('/admin/daily-summary', async (req, res) => {
  res.json({ status: 'triggered' });
  sendDailySummary().catch(logger.error.bind(logger));
});

// Admin: view/manage blocked numbers
app.get('/admin/blocked', (req, res) => {
  const blocked = db.getBlockedNumbers();
  res.json({ count: blocked.length, blocked });

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled request error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
if (config.TELEGRAM_BOT_TOKEN) {
  try {
    getBot(); // Initialize in webhook mode (no polling)
    // Register webhook after server starts (see below)
  } catch (err) {
    logger.error('Telegram bot init failed', { error: err.message });
  }
} else {
  logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram notifications disabled');
}


});

app.delete('/admin/blocked/:phone', (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  db.unblockNumber(phone);
  logger.info('Number unblocked via admin', { phone });
  res.json({ ok: true, phone });
});


// ─── Weekly Recording Cleanup (Sunday 2 AM PT) ────────────────────────────────
// Deletes recordings + DB records older than 48 months (except escalated)
cron.schedule('0 2 * * 0', () => {
  logger.info('Weekly cleanup cron triggered');
  try {
    const expired = db.getExpiredVoicemails();
    let deleted = 0;
    for (const vm of expired) {
      // Delete the MP3 file if it exists
      if (vm.recording_local_path) {
        try {
          const fs = require('fs');
          if (fs.existsSync(vm.recording_local_path)) {
            fs.unlinkSync(vm.recording_local_path);
          }
        } catch (fileErr) {
          logger.warn('Could not delete recording file', { path: vm.recording_local_path, error: fileErr.message });
        }
      }
      // Delete DB record
      db.deleteVoicemailRecord(vm.twilio_call_sid);
      deleted++;
    }
    logger.info('Weekly cleanup complete', { deleted, checked: expired.length });
    if (deleted > 0) {
      const tg = require('./telegram');
      const bot = tg.getBot();
      if (bot) {
        bot.sendMessage(config.TELEGRAM_MIKE_USER_ID,
          `🗑️ Weekly cleanup: deleted ${deleted} voicemail${deleted !== 1 ? 's' : ''} older than 48 months.`
        ).catch(() => {});
      }
    }
  } catch (err) {
    logger.error('Weekly cleanup error', { error: err.message });
  }
}, { timezone: 'America/Los_Angeles' });

// ─── Daily Summary Cron ───────────────────────────────────────────────────────
// 6 AM Pacific — uses timezone option so it always fires at 6 AM PT regardless of DST
cron.schedule('0 6 * * *', () => {
  logger.info('Daily summary cron triggered');
  sendDailySummary().catch(err => {
    logger.error('Daily summary cron error', { error: err.message });
  });
}, { timezone: 'America/Los_Angeles' });

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = config.PORT;
app.listen(PORT, '0.0.0.0', async () => {
  logger.info('Carson Voicemail service started', {
    port: PORT,
    webhookBase: config.WEBHOOK_BASE_URL,
    smsEnabled: config.SMS_REPLIES_ENABLED,
    telegramConfigured: !!config.TELEGRAM_BOT_TOKEN,
  });

  // Register Telegram webhook
  if (config.TELEGRAM_BOT_TOKEN) {
    try {
      await setupWebhook(config.WEBHOOK_BASE_URL);
    } catch (err) {
      logger.error('Telegram webhook setup failed', { error: err.message });
    }
  }
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received — shutting down');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});
