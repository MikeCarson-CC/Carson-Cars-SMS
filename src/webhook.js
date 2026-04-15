'use strict';

const express = require('express');
const db = require('./db');
const optout = require('./optout');
const haiku = require('./haiku');
const telegram = require('./telegram');
const sender = require('./sender');

const PORT = process.env.PORT || 3000;

function createApp() {
  const app = express();

  // Parse URL-encoded bodies (Twilio sends this)
  app.use(express.urlencoded({ extended: false }));
  // Parse JSON bodies (click tracker sends this)
  app.use(express.json());

  // ──────────────────────────────────────────
  // Twilio signature validation middleware
  // ──────────────────────────────────────────

  function validateTwilio(req, res, next) {
    // Skip validation in development
    if (process.env.NODE_ENV === 'development' || process.env.SKIP_TWILIO_VALIDATION === 'true') {
      return next();
    }

    const twilio = require('twilio');
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      console.warn('[Webhook] No TWILIO_AUTH_TOKEN, skipping validation');
      return next();
    }

    const signature = req.headers['x-twilio-signature'];
    if (!signature) {
      console.warn(`[Webhook] Missing Twilio signature from ${req.ip}`);
      return res.status(403).send('Forbidden');
    }

    const baseUrl = process.env.WEBHOOK_BASE_URL || `https://sms.carsoncars.net`;
    const url = `${baseUrl}${req.originalUrl}`;

    const valid = twilio.validateRequest(authToken, signature, url, req.body || {});
    if (!valid) {
      console.warn(`[Webhook] Invalid Twilio signature from ${req.ip}`);
      return res.status(403).send('Forbidden');
    }

    next();
  }

  // ──────────────────────────────────────────
  // Click webhook validation middleware
  // ──────────────────────────────────────────

  function validateClickWebhook(req, res, next) {
    const secret = process.env.CLICK_LOG_SECRET;
    if (!secret) return next(); // No secret configured, skip
    const headerSecret = req.headers['x-webhook-secret'];
    if (headerSecret !== secret) {
      console.warn(`[Webhook] Invalid click webhook secret from ${req.ip}`);
      return res.status(403).send('Forbidden');
    }
    next();
  }

  // ──────────────────────────────────────────
  // GET /health
  // ──────────────────────────────────────────

  app.get('/health', (req, res) => {
    try {
      const stats = db.getStats();
      const scheduler = require('./scheduler');
      const paused = scheduler.isPaused();

      // Get last send time
      const lastSend = db.getDb().prepare(
        'SELECT sent_at FROM send_log ORDER BY id DESC LIMIT 1'
      ).get();

      res.json({
        status: 'ok',
        uptime: process.uptime(),
        db: 'connected',
        twilio: process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'not_configured',
        paused,
        lastSend: lastSend ? lastSend.sent_at : null,
        queueSize: stats.total,
        sendsToday: stats.sendsToday
      });
    } catch (err) {
      res.status(503).json({
        status: 'error',
        error: err.message
      });
    }
  });

  // ──────────────────────────────────────────
  // POST /webhook/inbound — Twilio inbound SMS
  // ──────────────────────────────────────────

  app.post('/webhook/inbound', validateTwilio, async (req, res) => {
    try {
      const { From: fromPhone, Body: body, MessageSid: sid } = req.body;

      console.log(`[Webhook] Inbound from ${fromPhone}: "${body}"`);

      // Acknowledge immediately (Twilio expects quick response)
      res.type('text/xml').send('<Response></Response>');

      // Look up customer by phone
      const customer = db.getCustomerByPhone(fromPhone);
      if (!customer) {
        console.log(`[Webhook] Unknown number: ${fromPhone} — ignoring`);
        return;
      }

      // Check for STOP / opt-out
      if (optout.isOptOutMessage(body)) {
        console.log(`[Webhook] Opt-out from ${customer.account_number}`);
        await optout.processOptOut(customer, body);
        await telegram.sendNotification(
          `🚫 Opt-out: ${sender.getDisplayName(customer)} (Acct #${customer.account_number}) replied "${body}"`
        );
        return;
      }

      // Log the reply
      const result = db.logReply(customer.account_number, sid, body, 'en');
      const replyId = result.lastInsertRowid;

      // Mark customer as replied
      db.setCustomerReplied(customer.account_number);

      // Transition to IN_CONVERSATION if not already
      if (customer.customer_state !== 'IN_CONVERSATION' &&
          customer.customer_state !== 'PROMISE_PENDING' &&
          customer.customer_state !== 'OPTED_OUT') {
        db.updateCustomerState(customer.account_number, 'IN_CONVERSATION');
      }

      // Get conversation history
      const history = db.getConversationHistory(customer.account_number, 10);

      // Classify with Haiku
      let aiResult;
      try {
        aiResult = await haiku.classifyAndDraft(customer, history, body);
      } catch (err) {
        console.error(`[Webhook] Haiku error: ${err.message}`);
        aiResult = {
          intent: 'unclear',
          confidence: 0,
          suggested_reply: null,
          escalation_flag: true,
          commitment_detected: false,
          language: 'en'
        };
      }

      // Update reply with AI analysis
      db.updateReplyAI(replyId, aiResult.intent, aiResult.confidence, aiResult.suggested_reply);

      // Handle commitment detection
      if (aiResult.commitment_detected && aiResult.commitment_details) {
        db.addPaymentCommitment(
          customer.account_number,
          aiResult.commitment_amount || null,
          aiResult.commitment_details,
          replyId
        );
        // Don't transition to PROMISE_PENDING yet — wait for human approval
      }

      // Post to Telegram with buttons
      await telegram.postDraft(replyId, customer, body, aiResult);

    } catch (err) {
      console.error(`[Webhook] Inbound error: ${err.message}`);
      if (!res.headersSent) {
        res.type('text/xml').send('<Response></Response>');
      }
    }
  });

  // ──────────────────────────────────────────
  // POST /webhook/status — Twilio delivery status
  // ──────────────────────────────────────────

  app.post('/webhook/status', validateTwilio, (req, res) => {
    try {
      const { MessageSid: sid, MessageStatus: status, ErrorCode: errorCode } = req.body;

      console.log(`[Webhook] Status update: ${sid} → ${status}${errorCode ? ` (error: ${errorCode})` : ''}`);

      db.updateSendStatus(sid, status, errorCode || null);

      // Check for bad number errors
      const badNumberCodes = ['30003', '30005', '30006', '21211', '21612'];
      if (errorCode && badNumberCodes.includes(String(errorCode))) {
        console.warn(`[Webhook] Bad number detected for SID ${sid} (error ${errorCode})`);
      }

      res.sendStatus(200);
    } catch (err) {
      console.error(`[Webhook] Status error: ${err.message}`);
      res.sendStatus(500);
    }
  });

  // ──────────────────────────────────────────
  // POST /api/click — Click tracker from Cloudflare Worker
  // ──────────────────────────────────────────

  app.post('/api/click', validateClickWebhook, (req, res) => {
    try {
      const { account_number, ip_address, user_agent, referrer } = req.body;

      if (!account_number) {
        return res.status(400).json({ error: 'account_number required' });
      }

      console.log(`[Webhook] Click logged: account ${account_number} from ${ip_address}`);

      db.logClick(account_number, ip_address || 'unknown', user_agent || 'unknown', referrer || 'none');

      res.json({ ok: true });
    } catch (err) {
      console.error(`[Webhook] Click log error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

function startServer() {
  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`[Webhook] Server listening on port ${PORT}`);
  });
  return server;
}

module.exports = { createApp, startServer };
