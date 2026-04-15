'use strict';

const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const sender = require('./sender');
const scheduler = require('./scheduler');
const report = require('./report');
const { DateTime } = require('luxon');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '-5134777570';

// Authorized user IDs (as strings)
const AUTHORIZED_USERS = new Set();
try {
  const fs = require('fs');
  const path = require('path');
  const authPath = path.join(__dirname, '..', 'config', 'auth.json');
  if (fs.existsSync(authPath)) {
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    for (const user of Object.values(auth.authorizedTelegramUsers || {})) {
      if (user.userId) AUTHORIZED_USERS.add(String(user.userId));
    }
  }
} catch (e) {
  console.warn('[Telegram] Could not load auth config:', e.message);
}
// Always include Mike
AUTHORIZED_USERS.add('6432405200');

let _bot = null;

// Track pending drafts: replyId → { customer, draft, timeout }
const pendingDrafts = new Map();

// ──────────────────────────────────────────
// Bot initialization
// ──────────────────────────────────────────

function getBot() {
  if (_bot) return _bot;
  if (!BOT_TOKEN) {
    console.warn('[Telegram] No bot token configured, Telegram features disabled');
    return null;
  }
  _bot = new TelegramBot(BOT_TOKEN, { polling: true });
  setupHandlers(_bot);
  console.log('[Telegram] Bot started with polling');
  return _bot;
}

function isAuthorized(userId) {
  return AUTHORIZED_USERS.has(String(userId));
}

// ──────────────────────────────────────────
// Message handlers
// ──────────────────────────────────────────

function setupHandlers(bot) {
  // PAUSE command
  bot.onText(/^PAUSE$/i, (msg) => {
    if (!isAuthorized(msg.from.id)) return;
    scheduler.setPaused(true, msg.from.first_name || msg.from.username || 'Unknown');
    bot.sendMessage(msg.chat.id, `⏸️ SMS sending PAUSED by ${msg.from.first_name || 'user'}. Inbound replies still being received.`);
  });

  // RESUME command
  bot.onText(/^RESUME$/i, (msg) => {
    if (!isAuthorized(msg.from.id)) return;
    scheduler.setPaused(false, null);
    bot.sendMessage(msg.chat.id, `▶️ SMS sending RESUMED by ${msg.from.first_name || 'user'}. Queue processing will begin at next send window.`);
  });

  // STATS command
  bot.onText(/^STATS$/i, (msg) => {
    if (!isAuthorized(msg.from.id)) return;
    const stats = db.getStats();
    const paused = scheduler.isPaused();
    const inWindow = scheduler.isWithinSendWindow();
    let text = `📊 SMS Collections Status\n\n`;
    text += `System: ${paused ? '⏸️ PAUSED' : inWindow ? '▶️ ACTIVE' : '⏳ Outside send window'}\n`;
    text += `Customers: ${stats.total}\n`;
    text += `Sends today: ${stats.sendsToday}\n`;
    text += `Total sends: ${stats.totalSends}\n`;
    text += `Total replies: ${stats.totalReplies}\n`;
    text += `Opt-outs: ${stats.optOuts}\n\n`;
    text += `By state:\n`;
    for (const s of stats.byState) {
      text += `  ${s.customer_state}: ${s.c}\n`;
    }
    bot.sendMessage(msg.chat.id, text);
  });

  // REPORT command
  bot.onText(/^REPORT$/i, async (msg) => {
    if (!isAuthorized(msg.from.id)) return;
    const reportText = report.generateDailyReport();
    await sendLongMessage(bot, msg.chat.id, reportText);
  });

  // Callback query handler (inline button presses)
  bot.on('callback_query', async (query) => {
    if (!isAuthorized(query.from.id)) {
      bot.answerCallbackQuery(query.id, { text: 'Not authorized' });
      return;
    }

    const data = query.data;
    const [action, ...rest] = data.split(':');
    const replyId = rest.join(':');

    try {
      switch (action) {
        case 'approve':
          await handleApprove(bot, query, replyId);
          break;
        case 'edit':
          await handleEdit(bot, query, replyId);
          break;
        case 'escalate':
          await handleEscalate(bot, query, replyId);
          break;
        case 'discard':
          await handleDiscard(bot, query, replyId);
          break;
        case 'called':
          await handleMarkCalled(bot, query, replyId);
          break;
        default:
          bot.answerCallbackQuery(query.id, { text: 'Unknown action' });
      }
    } catch (err) {
      console.error(`[Telegram] Callback error: ${err.message}`);
      bot.answerCallbackQuery(query.id, { text: `Error: ${err.message}` });
    }
  });

  // Handle text messages that might be edit responses
  bot.on('message', (msg) => {
    if (!msg.reply_to_message) return;
    if (!isAuthorized(msg.from.id)) return;

    // Check if this is a reply to an edit prompt
    const editKey = `edit_${msg.chat.id}_${msg.reply_to_message.message_id}`;
    if (pendingEdits.has(editKey)) {
      const { replyId } = pendingEdits.get(editKey);
      pendingEdits.delete(editKey);
      handleEditComplete(bot, msg, replyId, msg.text);
    }
  });
}

const pendingEdits = new Map();

// ──────────────────────────────────────────
// Button handlers
// ──────────────────────────────────────────

async function handleApprove(bot, query, replyId) {
  const replyRow = db.getReplyById(parseInt(replyId));
  if (!replyRow) {
    bot.answerCallbackQuery(query.id, { text: 'Reply not found' });
    return;
  }

  const customer = db.getCustomerByAccount(replyRow.account_number);
  if (!customer) {
    bot.answerCallbackQuery(query.id, { text: 'Customer not found' });
    return;
  }

  const draftText = replyRow.ai_draft_reply;
  if (!draftText) {
    bot.answerCallbackQuery(query.id, { text: 'No draft to send' });
    return;
  }

  // Send via Twilio
  const result = await sender.sendReply(customer, draftText);

  // Update reply record
  db.updateReplyHumanAction(parseInt(replyId), 'send', draftText, query.from.first_name || 'Unknown');

  // Clear holding reply timer
  clearDraftTimer(replyId);

  // Update the Telegram message
  const userName = query.from.first_name || 'Unknown';
  bot.editMessageText(
    `${query.message.text}\n\n✅ Sent by ${userName}`,
    { chat_id: query.message.chat.id, message_id: query.message.message_id }
  );

  bot.answerCallbackQuery(query.id, { text: '✅ Reply sent!' });
}

async function handleEdit(bot, query, replyId) {
  bot.answerCallbackQuery(query.id, { text: 'Reply with your edited message' });

  const editMsg = await bot.sendMessage(
    query.message.chat.id,
    '✏️ Reply to this message with your edited text:',
    { reply_markup: { force_reply: true } }
  );

  pendingEdits.set(`edit_${query.message.chat.id}_${editMsg.message_id}`, { replyId });
}

async function handleEditComplete(bot, msg, replyId, editedText) {
  const replyRow = db.getReplyById(parseInt(replyId));
  if (!replyRow) return;

  const customer = db.getCustomerByAccount(replyRow.account_number);
  if (!customer) return;

  // Send edited message
  const result = await sender.sendReply(customer, editedText);

  // Update reply record
  db.updateReplyHumanAction(parseInt(replyId), 'edit', editedText, msg.from.first_name || 'Unknown');

  clearDraftTimer(replyId);

  bot.sendMessage(msg.chat.id, `✅ Edited reply sent to ${sender.getDisplayName(customer)}`);
}

async function handleEscalate(bot, query, replyId) {
  const replyRow = db.getReplyById(parseInt(replyId));
  if (!replyRow) {
    bot.answerCallbackQuery(query.id, { text: 'Reply not found' });
    return;
  }

  db.updateReplyHumanAction(parseInt(replyId), 'escalate', null, query.from.first_name || 'Unknown');
  clearDraftTimer(replyId);

  bot.editMessageText(
    `${query.message.text}\n\n🚨 Escalated by ${query.from.first_name || 'Unknown'} — needs phone follow-up`,
    { chat_id: query.message.chat.id, message_id: query.message.message_id }
  );

  bot.answerCallbackQuery(query.id, { text: '🚨 Escalated for phone follow-up' });
}

async function handleDiscard(bot, query, replyId) {
  db.updateReplyHumanAction(parseInt(replyId), 'discard', null, query.from.first_name || 'Unknown');
  clearDraftTimer(replyId);

  bot.editMessageText(
    `${query.message.text}\n\n🗑️ Discarded by ${query.from.first_name || 'Unknown'}`,
    { chat_id: query.message.chat.id, message_id: query.message.message_id }
  );

  bot.answerCallbackQuery(query.id, { text: '🗑️ Draft discarded' });
}

async function handleMarkCalled(bot, query, accountNumber) {
  db.markAsCalled(accountNumber, query.from.first_name || 'Unknown');

  bot.editMessageText(
    `${query.message.text}\n\n📞 Marked as called by ${query.from.first_name || 'Unknown'}`,
    { chat_id: query.message.chat.id, message_id: query.message.message_id }
  );

  bot.answerCallbackQuery(query.id, { text: '📞 Marked as called — suppressed for 5 business days' });
}

// ──────────────────────────────────────────
// Post draft to Telegram
// ──────────────────────────────────────────

async function postDraft(replyId, customer, inboundMsg, aiResult) {
  const bot = getBot();
  if (!bot) return;

  const displayName = sender.getDisplayName(customer);
  const phone = customer.cell_phone || 'unknown';

  let text = `💬 New reply from ${displayName} ${customer.last_name || ''} — `;
  text += `${customer.vehicle_year || ''} ${customer.vehicle_make || ''} ${customer.vehicle_model || ''} — `;
  text += `Acct #${customer.account_number}\n`;
  text += `📞 ${phone}\n`;
  text += `💰 $${customer.past_due_amount || 0} past due — ${customer.days_past_due || 0} days\n\n`;

  text += `${displayName} said: "${inboundMsg}"\n`;

  if (aiResult.intent) {
    text += `\n🤖 Intent: ${aiResult.intent} (${Math.round((aiResult.confidence || 0) * 100)}%)\n`;
  }

  if (aiResult.language && aiResult.language !== 'en') {
    text += `🌐 Language: ${aiResult.language.toUpperCase()}\n`;
  }

  if (aiResult.escalation_flag) {
    text += `⚠️ ESCALATION RECOMMENDED\n`;
  }

  if (aiResult.commitment_detected) {
    text += `💰 Payment commitment detected: ${aiResult.commitment_details || 'see message'}\n`;
  }

  if (aiResult.suggested_reply) {
    text += `\nMaria's draft reply:\n"${aiResult.suggested_reply}"\n`;

    // If Spanish, show English translation note
    if (aiResult.language === 'es') {
      text += `\n(Spanish draft — English translation above for reviewer)\n`;
    }
  } else {
    text += `\n⚠️ No auto-draft generated — human response needed\n`;
  }

  const buttons = [
    [
      { text: '✅ Send', callback_data: `approve:${replyId}` },
      { text: '✏️ Edit', callback_data: `edit:${replyId}` },
      { text: '🚨 Escalate', callback_data: `escalate:${replyId}` },
      { text: '🗑️ Discard', callback_data: `discard:${replyId}` }
    ]
  ];

  try {
    await bot.sendMessage(CHANNEL_ID, text, {
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    console.error(`[Telegram] Failed to post draft: ${err.message}`);
  }

  // Set 15-minute auto-holding-reply timer
  setDraftTimer(replyId, customer);
}

// ──────────────────────────────────────────
// 15-minute holding reply timer
// ──────────────────────────────────────────

function setDraftTimer(replyId, customer) {
  const timeout = setTimeout(async () => {
    // Check if still pending
    const reply = db.getReplyById(parseInt(replyId));
    if (!reply || reply.human_action) return; // Already handled

    try {
      // Send holding reply
      const holdingBody = sender.buildMessage(customer, 'holding');
      await sender.sendReply(customer, holdingBody);

      // Mark as holding
      db.updateReplyHumanAction(parseInt(replyId), 'holding', holdingBody, 'auto');

      // Notify Telegram
      const bot = getBot();
      if (bot) {
        const name = sender.getDisplayName(customer);
        bot.sendMessage(CHANNEL_ID,
          `⏰ Auto-holding reply sent to ${name} (Acct #${customer.account_number}) — no human review after 15 min. Original draft still needs follow-up.`
        );
      }

      console.log(`[Telegram] Auto-holding reply sent for reply ${replyId}`);
    } catch (err) {
      console.error(`[Telegram] Failed to send holding reply: ${err.message}`);
    }
  }, 15 * 60 * 1000); // 15 minutes

  pendingDrafts.set(String(replyId), { timeout, customer });
}

function clearDraftTimer(replyId) {
  const entry = pendingDrafts.get(String(replyId));
  if (entry) {
    clearTimeout(entry.timeout);
    pendingDrafts.delete(String(replyId));
  }
}

// ──────────────────────────────────────────
// Post hot lead (for daily report)
// ──────────────────────────────────────────

async function postHotLead(customer, clickedAt, clickCount) {
  const bot = getBot();
  if (!bot) return;

  const displayName = sender.getDisplayName(customer);
  const phone = customer.cell_phone || 'unknown';

  let text = `🔥 ${displayName} ${customer.last_name || ''} — `;
  text += `${customer.vehicle_make || ''} ${customer.vehicle_model || ''} — `;
  text += `Acct #${customer.account_number} — $${customer.past_due_amount || 0} past due\n`;
  text += `Clicked: ${clickedAt} (${clickCount}x) | ${phone}`;

  const buttons = [
    [{ text: '📞 Mark as Called', callback_data: `called:${customer.account_number}` }]
  ];

  try {
    await bot.sendMessage(CHANNEL_ID, text, {
      reply_markup: { inline_keyboard: buttons }
    });
  } catch (err) {
    console.error(`[Telegram] Failed to post hot lead: ${err.message}`);
  }
}

// ──────────────────────────────────────────
// Send notification
// ──────────────────────────────────────────

async function sendNotification(message) {
  const bot = getBot();
  if (!bot) {
    console.log(`[Telegram] (no bot) ${message}`);
    return;
  }
  try {
    await sendLongMessage(bot, CHANNEL_ID, message);
  } catch (err) {
    console.error(`[Telegram] Failed to send notification: ${err.message}`);
  }
}

// ──────────────────────────────────────────
// Send long message (split if needed)
// ──────────────────────────────────────────

async function sendLongMessage(bot, chatId, text) {
  const MAX_LEN = 4096;
  if (text.length <= MAX_LEN) {
    return bot.sendMessage(chatId, text);
  }

  // Split on newlines
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > MAX_LEN) {
      parts.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) parts.push(current);

  for (const part of parts) {
    await bot.sendMessage(chatId, part);
  }
}

// ──────────────────────────────────────────
// Schedule daily report at 7:30 AM PT
// ──────────────────────────────────────────

let reportInterval = null;

function scheduleDailyReport() {
  // Check every minute if it's 7:30 AM PT
  reportInterval = setInterval(async () => {
    const now = DateTime.now().setZone('America/Los_Angeles');
    if (now.hour === 7 && now.minute === 30) {
      console.log('[Telegram] Sending daily morning report');
      const reportText = report.generateDailyReport();
      await sendNotification(reportText);

      // Also post hot leads with buttons
      const hotLeads = db.getHotLeads();
      for (const lead of hotLeads) {
        await postHotLead(lead, lead.clicked_at, lead.click_count);
      }
    }
  }, 60 * 1000);
}

function stopBot() {
  if (_bot) {
    _bot.stopPolling();
    _bot = null;
  }
  if (reportInterval) {
    clearInterval(reportInterval);
    reportInterval = null;
  }
}

module.exports = {
  getBot,
  postDraft,
  postHotLead,
  sendNotification,
  scheduleDailyReport,
  stopBot,
  CHANNEL_ID
};
