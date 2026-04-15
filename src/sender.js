'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');

const TEMPLATES_PATH = path.join(__dirname, '..', 'templates', 'messages.json');

// ──────────────────────────────────────────
// Template loading
// ──────────────────────────────────────────

function loadTemplates() {
  return JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf8'));
}

function getDisplayName(customer) {
  // Nickname takes precedence over first_name
  if (customer.nickname && customer.nickname.trim()) return customer.nickname.trim();
  if (customer.first_name && customer.first_name.trim()) return customer.first_name.trim();
  return 'Customer';
}

function fillTemplate(template, customer, extra = {}) {
  let msg = template;
  const name = getDisplayName(customer);

  msg = msg.replace(/\{\{firstName\}\}/g, name);
  msg = msg.replace(/\{\{name\}\}/g, name);
  msg = msg.replace(/\{\{make\}\}/g, customer.vehicle_make || '');
  msg = msg.replace(/\{\{model\}\}/g, customer.vehicle_model || '');
  msg = msg.replace(/\{\{stockNbr\}\}/g, customer.account_number || '');
  msg = msg.replace(/\{\{AcctNum\}\}/g, customer.account_number || '');
  msg = msg.replace(/\{\{pastDue\}\}/g, formatCurrency(customer.past_due_amount));

  // Extra fields (e.g. promised_date for Template D)
  for (const [key, val] of Object.entries(extra)) {
    msg = msg.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), val || '');
  }

  return msg;
}

function formatCurrency(amount) {
  if (!amount && amount !== 0) return '$0';
  return '$' + Number(amount).toFixed(0);
}

// ──────────────────────────────────────────
// Build message for a given template
// ──────────────────────────────────────────

function buildMessage(customer, templateType, extra = {}) {
  const templates = loadTemplates();

  let templateKey, templateObj;
  if (templateType === 'A') {
    templateObj = templates.templateA;
    // Use noMake variant if no make available
    const tmpl = customer.vehicle_make ? templateObj.template : (templateObj.templateNoMake || templateObj.template);
    return fillTemplate(tmpl, customer, extra);
  } else if (templateType === 'B') {
    templateObj = templates.templateB;
    const tmpl = customer.vehicle_make ? templateObj.template : (templateObj.templateNoMake || templateObj.template);
    return fillTemplate(tmpl, customer, extra);
  } else if (templateType === 'D') {
    templateObj = templates.templateD;
    if (!templateObj) {
      // Fallback if Template D not in config
      const fallback = `Hi ${getDisplayName(customer)}, Maria at Carson Cars — looks like the payment you mentioned for ${extra.PromisedDate || 'recently'} on account #${customer.account_number} hasn't hit yet. Everything ok? Reply here or pay at Pay.CarsonCars.Net/${customer.account_number}.\nReply STOP to opt out.`;
      return fallback;
    }
    return fillTemplate(templateObj.template, customer, extra);
  } else if (templateType === 'holding') {
    templateObj = templates.holdingReply;
    return fillTemplate(templateObj.template, customer, extra);
  } else if (templateType === 'optout') {
    templateObj = templates.optOutConfirmation;
    return fillTemplate(templateObj.template, customer, extra);
  }

  throw new Error(`Unknown template type: ${templateType}`);
}

// ──────────────────────────────────────────
// Twilio send
// ──────────────────────────────────────────

let _twilioClient = null;

function getTwilioClient() {
  if (_twilioClient) return _twilioClient;
  const twilio = require('twilio');
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
  }
  _twilioClient = twilio(accountSid, authToken);
  return _twilioClient;
}

async function sendSms(to, body) {
  const fromNumber = process.env.TWILIO_FROM_NUMBER || '+14256968488';
  const statusCallback = process.env.STATUS_CALLBACK_URL || null;

  const msgOptions = {
    body,
    from: fromNumber,
    to
  };

  if (statusCallback) {
    msgOptions.statusCallback = statusCallback;
  }

  const client = getTwilioClient();
  const message = await client.messages.create(msgOptions);
  return message;
}

// ──────────────────────────────────────────
// Send to customer (full workflow)
// ──────────────────────────────────────────

async function sendToCustomer(customer, templateType, extra = {}) {
  if (!customer.cell_phone) {
    throw new Error(`No phone number for account ${customer.account_number}`);
  }

  // Build message
  const body = buildMessage(customer, templateType, extra);

  // Send via Twilio
  const message = await sendSms(customer.cell_phone, body);

  // Log the send
  db.logSend(customer.account_number, message.sid, templateType, body);

  // Update template sent flags
  if (templateType === 'A' || templateType === 'B' || templateType === 'D') {
    db.setTemplateSent(customer.account_number, templateType);
  }

  // State transitions
  if (templateType === 'A') {
    // NEW → TEXTED
    db.updateCustomerState(customer.account_number, 'TEXTED');
  } else if (templateType === 'B') {
    // Stay TEXTED (no state change)
  } else if (templateType === 'D') {
    // BROKEN_PROMISE → TEXTED
    db.updateCustomerState(customer.account_number, 'TEXTED');
    // Mark the commitment as processed
    if (customer.commitment_id) {
      db.markBrokenPromiseProcessed(customer.commitment_id);
    }
  }

  console.log(`[Sender] Sent Template ${templateType} to ${customer.account_number} (${getDisplayName(customer)}) — SID: ${message.sid}`);

  return { sid: message.sid, body };
}

// ──────────────────────────────────────────
// Send arbitrary reply (for approved drafts)
// ──────────────────────────────────────────

async function sendReply(customer, body) {
  if (!customer.cell_phone) {
    throw new Error(`No phone number for account ${customer.account_number}`);
  }

  const message = await sendSms(customer.cell_phone, body);
  db.logSend(customer.account_number, message.sid, 'reply', body);

  console.log(`[Sender] Sent reply to ${customer.account_number} — SID: ${message.sid}`);
  return { sid: message.sid, body };
}

// ──────────────────────────────────────────
// Dry run (no actual send)
// ──────────────────────────────────────────

function dryRunMessage(customer, templateType, extra = {}) {
  const body = buildMessage(customer, templateType, extra);
  return {
    account_number: customer.account_number,
    name: getDisplayName(customer),
    phone: customer.cell_phone,
    template: templateType,
    message: body,
    pastDue: customer.past_due_amount,
    daysPastDue: customer.days_past_due,
    make: customer.vehicle_make
  };
}

module.exports = {
  loadTemplates,
  getDisplayName,
  buildMessage,
  sendSms,
  sendToCustomer,
  sendReply,
  dryRunMessage,
  fillTemplate,
  getTwilioClient
};
