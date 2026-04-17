'use strict';

const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');

let bot = null;

// Tracks pending "Edit" sessions: userId → callSid
const editSessions = new Map();

function getBot() {
  if (!bot && config.TELEGRAM_BOT_TOKEN) {
    // Use polling mode with dropPendingUpdates to handle button callbacks.
    // We use the ALARM bot (disabled in J1 openclaw) to avoid 409 conflicts.
    bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, {
      polling: {
        params: {
          allowed_updates: JSON.stringify(['message', 'callback_query']),
        },
      },
    });
    setupCallbackHandlers();
    setupMessageHandlers();
    logger.info('Telegram bot initialized (polling mode)');
  }
  return bot;
}

/**
 * setupWebhook — no-op in polling mode, kept for compatibility.
 */
async function setupWebhook(webhookUrl) {
  // Clear any existing webhook so polling works
  const b = getBot();
  if (!b) return;
  try {
    await b.deleteWebHook();
    logger.info('Telegram webhook cleared (using polling)');
  } catch (err) {
    logger.warn('Could not clear Telegram webhook', { error: err.message });
  }
}

/**
 * Process an incoming update from Telegram (called by Express route).
 */
async function processUpdate(update) {
  const b = getBot();
  if (!b) return;

  // Handle callback queries (button presses)
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  // Handle regular messages (for Edit flow)
  if (update.message) {
    await handleMessage(update.message);
    return;
  }
}

async function handleCallbackQuery(query) {
  const b = getBot();
  const data = query.data || '';
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    if (data.startsWith('reply:')) {
      const parts = data.split(':');
      const replyIndex = parseInt(parts[1]) - 1; // 0-based
      const callSid = parts.slice(2).join(':');

      const vm = db.getVoicemailBySid(callSid);
      if (!vm) {
        await b.answerCallbackQuery(query.id, { text: 'Voicemail not found.' });
        return;
      }

      const replies = JSON.parse(vm.smart_replies_json || '[]');
      const replyText = replies[replyIndex];

      if (!replyText) {
        await b.answerCallbackQuery(query.id, { text: 'Reply not available.' });
        return;
      }

      if (config.SMS_REPLIES_ENABLED) {
        await sendSms(vm.twilio_number, vm.caller_number, replyText);
        db.updateVoicemail(callSid, {
          action_taken: 'replied',
          reply_sent_text: replyText,
          reply_sent_at: new Date().toISOString(),
        });
        await b.answerCallbackQuery(query.id, { text: '✅ SMS sent!' });
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
        await b.sendMessage(chatId, `✅ Replied to ${vm.caller_number}:\n\n${replyText}`);
      } else {
        db.updateVoicemail(callSid, {
          action_taken: 'reply_queued',
          reply_sent_text: replyText,
          reply_sent_at: new Date().toISOString(),
        });
        await b.answerCallbackQuery(query.id, { text: 'SMS queued (sends disabled)' });
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
        await b.sendMessage(chatId, `📋 SMS reply queued \\(SMS\\_REPLIES\\_ENABLED=false\\):\n\n*To:* ${escapeMarkdown(vm.caller_number)}\n*From:* ${escapeMarkdown(vm.twilio_number)}\n\n${escapeMarkdown(replyText)}`, { parse_mode: 'MarkdownV2' });
      }

    } else if (data.startsWith('edit:')) {
      const callSid = data.replace('edit:', '');
      const vm = db.getVoicemailBySid(callSid);
      if (!vm) {
        await b.answerCallbackQuery(query.id, { text: 'Voicemail not found.' });
        return;
      }

      editSessions.set(String(chatId), callSid);
      await b.answerCallbackQuery(query.id, { text: 'Type your custom reply...' });
      await b.sendMessage(chatId, `✏️ *Type your custom reply* to ${vm.caller_number}:\n_(Just type it and send)_`, { parse_mode: 'Markdown' });

    } else if (data.startsWith('listen:')) {
      const callSid = data.replace('listen:', '');
      const vm = db.getVoicemailBySid(callSid);
      if (!vm) {
        await b.answerCallbackQuery(query.id, { text: 'Recording not found.' });
        return;
      }
      const fs = require('fs');
      const localPath = vm.recording_local_path;
      if (!localPath || !fs.existsSync(localPath)) {
        await b.answerCallbackQuery(query.id, { text: 'Recording file not available.' });
        return;
      }
      await b.answerCallbackQuery(query.id, { text: '🎧 Sending audio...' });
      await b.sendVoice(chatId, fs.createReadStream(localPath), {
        caption: `Voicemail from ${vm.caller_number} — ${vm.source_line}`,
      });
      logger.info('Listen: sent recording', { callSid, chatId });

    } else if (data.startsWith('escalate:')) {
      const callSid = data.replace('escalate:', '');
      db.updateVoicemail(callSid, { action_taken: 'escalated' });
      await b.answerCallbackQuery(query.id, { text: '🚨 Escalated.' });
      await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
      await b.sendMessage(chatId, '🚨 Voicemail escalated. It will appear in the daily summary until resolved.');

    } else if (data.startsWith('delete:')) {
      const callSid = data.replace('delete:', '');
      db.updateVoicemail(callSid, { action_taken: 'deleted' });
      await b.answerCallbackQuery(query.id, { text: 'Dismissed.' });
      await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
      await b.sendMessage(chatId, '🗑️ Voicemail dismissed.');

    } else {
      await b.answerCallbackQuery(query.id, { text: 'Unknown action.' });
    }
  } catch (err) {
    logger.error('Telegram callback error', { data, error: err.message });
    try { await b.answerCallbackQuery(query.id, { text: 'Error processing action.' }); } catch {}
  }
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id);
  const text = msg.text;

  // Check for pending edit session
  if (editSessions.has(chatId) && text && !text.startsWith('/')) {
    const callSid = editSessions.get(chatId);
    editSessions.delete(chatId);

    const b = getBot();
    const vm = db.getVoicemailBySid(callSid);
    if (!vm) {
      await b.sendMessage(chatId, '❌ Voicemail not found. Discarding reply.');
      return;
    }

    if (config.SMS_REPLIES_ENABLED) {
      await sendSms(vm.twilio_number, vm.caller_number, text);
      db.updateVoicemail(callSid, {
        action_taken: 'replied',
        reply_sent_text: text,
        reply_sent_at: new Date().toISOString(),
      });
      await b.sendMessage(chatId, `✅ Custom reply sent to ${vm.caller_number}:\n\n${text}`);
    } else {
      db.updateVoicemail(callSid, {
        action_taken: 'reply_queued',
        reply_sent_text: text,
        reply_sent_at: new Date().toISOString(),
      });
      await b.sendMessage(chatId, `📋 Custom reply queued \\(SMS disabled\\):\n\n*To:* ${escapeMarkdown(vm.caller_number)}\n\n${escapeMarkdown(text)}`, { parse_mode: 'MarkdownV2' });
    }
  }
}

function formatPacificTime(utcIso) {
  try {
    const d = new Date(utcIso);
    return d.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return utcIso;
  }
}

function escapeMarkdown(str) {
  if (!str) return '';
  return String(str).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function buildVoicemailText({ callerNumber, callerName, lineLabel, timestampUtc, summary, smartReplies }) {
  const time = formatPacificTime(timestampUtc);
  const callerDisplay = callerName ? `${callerName} (${callerNumber})` : callerNumber;
  let text = `📞 *New Voicemail*\n\n` +
    `*From:* ${escapeMarkdown(callerDisplay)}\n` +
    `*Line:* ${escapeMarkdown(lineLabel)}\n` +
    `*Time:* ${escapeMarkdown(time)}\n\n` +
    `*Summary:* ${escapeMarkdown(summary)}`;
  if (smartReplies && smartReplies.length > 0) {
    text += `\n\n*Reply 1:* _${escapeMarkdown(smartReplies[0])}_`;
    if (smartReplies[1]) text += `\n*Reply 2:* _${escapeMarkdown(smartReplies[1])}_`;
  }
  return text;
}

function buildButtons(callSid, smartReplies) {
  const buttons = [];

  // Row 1: smart reply buttons (up to 2)
  const replyRow = [];
  if (smartReplies[0]) replyRow.push({ text: '💬 Reply 1', callback_data: `reply:1:${callSid}` });
  if (smartReplies[1]) replyRow.push({ text: '💬 Reply 2', callback_data: `reply:2:${callSid}` });
  if (replyRow.length > 0) buttons.push(replyRow);

  // Row 2: Listen + actions
  buttons.push([
    { text: '🎧 Listen', callback_data: `listen:${callSid}` },
    { text: '✏️ Edit', callback_data: `edit:${callSid}` },
    { text: '🚨 Escalate', callback_data: `escalate:${callSid}` },
    { text: '🗑️ Delete', callback_data: `delete:${callSid}` },
  ]);

  return { inline_keyboard: buttons };
}

async function sendVoicemailCard({ callSid, callerNumber, callerName, sourceLine, lineLabel, timestampUtc, summary, smartReplies }) {
  const b = getBot();
  if (!b) {
    logger.warn('Telegram bot not configured, skipping notification');
    return null;
  }

  const text = buildVoicemailText({ callerNumber, callerName, lineLabel, timestampUtc, summary, smartReplies });
  const keyboard = buildButtons(callSid, smartReplies);

  const sent = await b.sendMessage(config.TELEGRAM_MIKE_USER_ID, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard,
  });

  return sent.message_id;
}

async function sendSms(fromNumber, toNumber, text) {
  if (!config.SMS_REPLIES_ENABLED) {
    logger.info('SMS send skipped (disabled)', { from: fromNumber, to: toNumber });
    return;
  }

  const twilio = require('twilio')(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  const message = await twilio.messages.create({
    from: fromNumber,
    to: toNumber,
    body: text,
  });
  logger.info('SMS sent', { from: fromNumber, to: toNumber, sid: message.sid });
  return message;
}

function setupCallbackHandlers() {
  bot.on('callback_query', async (query) => {
    try {
      await handleCallbackQuery(query);
    } catch (err) {
      logger.error('Telegram callback handler error', { error: err.message });
    }
  });
  bot.on('polling_error', (err) => {
    if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
      logger.error('Telegram polling 409 conflict — another instance is polling this bot. Set a unique TELEGRAM_BOT_TOKEN in .env', { error: err.message });
    } else {
      logger.warn('Telegram polling error', { error: err.message });
    }
  });
}

function setupMessageHandlers() {
  bot.on('message', async (msg) => {
    try {
      await handleMessage(msg);
    } catch (err) {
      logger.error('Telegram message handler error', { error: err.message });
    }
  });
}

async function sendAdminMessage(text) {
  const b = getBot();
  if (!b) return;
  try {
    await b.sendMessage(config.TELEGRAM_MIKE_USER_ID, text, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('Failed to send admin message', { error: err.message });
  }
}

module.exports = { getBot, setupWebhook, processUpdate, sendVoicemailCard, sendAdminMessage };
