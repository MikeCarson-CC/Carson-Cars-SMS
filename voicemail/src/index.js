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

// ─── Daily Summary Cron ───────────────────────────────────────────────────────
// 6 AM Pacific = 14:00 UTC (non-DST) / 13:00 UTC (DST)
// Using 14:00 UTC as stable anchor
cron.schedule('0 14 * * *', () => {
  logger.info('Daily summary cron triggered');
  sendDailySummary().catch(err => {
    logger.error('Daily summary cron error', { error: err.message });
  });
});

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
