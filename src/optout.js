'use strict';

const db = require('./db');
const sender = require('./sender');

// ──────────────────────────────────────────
// Opt-out keyword detection
// 2025 FCC compliant — English + Spanish
// ──────────────────────────────────────────

const OPT_OUT_KEYWORDS_EN = [
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit',
  'stop all', 'opt out', 'optout', 'opt-out',
  'remove me', 'remove', 'no more', 'stop texting',
  'stop messaging', 'stop texts', 'do not text',
  'don\'t text', 'dont text', 'leave me alone',
  'stop it', 'enough', 'no more texts', 'no more messages'
];

const OPT_OUT_KEYWORDS_ES = [
  'parar', 'para', 'detener', 'alto', 'basta',
  'no mas', 'no más', 'cancelar', 'salir',
  'no me escribas', 'no me envíes', 'no me envies',
  'dejar de enviar', 'no quiero', 'eliminar',
  'quitar', 'detenerse'
];

const ALL_OPT_OUT_KEYWORDS = [...OPT_OUT_KEYWORDS_EN, ...OPT_OUT_KEYWORDS_ES];

function isOptOutMessage(messageBody) {
  if (!messageBody) return false;
  const normalized = messageBody.toLowerCase().trim()
    .replace(/[.!?,;:'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Exact match against keywords
  if (ALL_OPT_OUT_KEYWORDS.includes(normalized)) return true;

  // Check if message starts with STOP (handles "STOP please", "STOP now", etc.)
  if (normalized.startsWith('stop')) return true;

  return false;
}

// ──────────────────────────────────────────
// Process opt-out
// ──────────────────────────────────────────

async function processOptOut(customer, triggerMessage) {
  // Record the opt-out
  db.recordOptOut(customer.account_number, customer.cell_phone, triggerMessage);

  // Update customer state to OPTED_OUT
  db.updateCustomerState(customer.account_number, 'OPTED_OUT');

  // Send confirmation
  try {
    const confirmBody = sender.buildMessage(customer, 'optout');
    await sender.sendSms(customer.cell_phone, confirmBody);
    db.setOptOutConfirmationSent(customer.account_number);
    console.log(`[OptOut] Processed opt-out for ${customer.account_number} (${customer.cell_phone})`);
  } catch (err) {
    console.error(`[OptOut] Failed to send confirmation to ${customer.account_number}: ${err.message}`);
  }

  return true;
}

module.exports = {
  isOptOutMessage,
  processOptOut,
  OPT_OUT_KEYWORDS_EN,
  OPT_OUT_KEYWORDS_ES,
  ALL_OPT_OUT_KEYWORDS
};
