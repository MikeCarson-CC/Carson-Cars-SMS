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
    bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
    setupCallbackHandlers();
    setupMessageHandlers();
    logger.info('Telegram bot initialized');
  }
  return bot;
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

function buildVoicemailText({ callerNumber, callerName, lineLabel, timestampUtc, summary }) {
  const time = formatPacificTime(timestampUtc);
  const callerDisplay = callerName ? `${callerName} (${callerNumber})` : callerNumber;
  return `📞 *New Voicemail*\n\n` +
    `*From:* ${escapeMarkdown(callerDisplay)}\n` +
    `*Line:* ${escapeMarkdown(lineLabel)}\n` +
    `*Time:* ${escapeMarkdown(time)}\n\n` +
    `*Summary:* ${escapeMarkdown(summary)}`;
}

function escapeMarkdown(str) {
  if (!str) return '';
  // Escape MarkdownV2 special chars
  return String(str).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function buildButtons(callSid, smartReplies) {
  const buttons = [];

  // Row 1: smart reply buttons (up to 2)
  const replyRow = [];
  if (smartReplies[0]) replyRow.push({ text: '💬 Reply 1', callback_data: `reply:1:${callSid}` });
  if (smartReplies[1]) replyRow.push({ text: '💬 Reply 2', callback_data: `reply:2:${callSid}` });
  if (replyRow.length > 0) buttons.push(replyRow);

  // Row 2: actions
  buttons.push([
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

  const text = buildVoicemailText({ callerNumber, callerName, lineLabel, timestampUtc, summary });
  const keyboard = buildButtons(callSid, smartReplies);

  const sent = await b.sendMessage(config.TELEGRAM_MIKE_USER_ID, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard,
  });

  return sent.message_id;
}

function setupCallbackHandlers() {
  bot.on('callback_query', async (query) => {
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
          await bot.answerCallbackQuery(query.id, { text: 'Voicemail not found.' });
          return;
        }

        const replies = JSON.parse(vm.smart_replies_json || '[]');
        const replyText = replies[replyIndex];

        if (!replyText) {
          await bot.answerCallbackQuery(query.id, { text: 'Reply not available.' });
          return;
        }

        if (config.SMS_REPLIES_ENABLED) {
          await sendSms(vm.twilio_number, vm.caller_number, replyText);
          db.updateVoicemail(callSid, {
            action_taken: 'replied',
            reply_sent_text: replyText,
            reply_sent_at: new Date().toISOString(),
          });
          await bot.answerCallbackQuery(query.id, { text: '✅ SMS sent!' });
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
          await bot.sendMessage(chatId, `✅ Replied to ${vm.caller_number}:\n\n${replyText}`);
        } else {
          // SMS not enabled — show what would have been sent
          db.updateVoicemail(callSid, {
            action_taken: 'replied',
            reply_sent_text: replyText,
            reply_sent_at: new Date().toISOString(),
          });
          await bot.answerCallbackQuery(query.id, { text: 'SMS queued (sends disabled)' });
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
          await bot.sendMessage(chatId, `📋 SMS reply queued (SMS_REPLIES_ENABLED=false):\n\n*To:* ${vm.caller_number}\n*From:* ${vm.twilio_number}\n\n${replyText}`, { parse_mode: 'Markdown' });
        }

      } else if (data.startsWith('edit:')) {
        const callSid = data.replace('edit:', '');
        const vm = db.getVoicemailBySid(callSid);
        if (!vm) {
          await bot.answerCallbackQuery(query.id, { text: 'Voicemail not found.' });
          return;
        }

        editSessions.set(String(chatId), callSid);
        await bot.answerCallbackQuery(query.id, { text: 'Type your custom reply...' });
        await bot.sendMessage(chatId, `✏️ *Type your custom reply* to ${vm.caller_number}:\n_(Reply to this message or just type your next message)_`, { parse_mode: 'Markdown' });

      } else if (data.startsWith('escalate:')) {
        const callSid = data.replace('escalate:', '');
        db.updateVoicemail(callSid, { action_taken: 'escalated' });
        await bot.answerCallbackQuery(query.id, { text: '🚨 Escalated — will appear in daily summary.' });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
        await bot.sendMessage(chatId, '🚨 Voicemail escalated. It will appear in the daily summary until resolved.');

      } else if (data.startsWith('delete:')) {
        const callSid = data.replace('delete:', '');
        db.updateVoicemail(callSid, { action_taken: 'deleted' });
        await bot.answerCallbackQuery(query.id, { text: 'Dismissed.' });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
        await bot.sendMessage(chatId, '🗑️ Voicemail dismissed.');

      } else {
        await bot.answerCallbackQuery(query.id, { text: 'Unknown action.' });
      }
    } catch (err) {
      logger.error('Telegram callback error', { data, error: err.message });
      try { await bot.answerCallbackQuery(query.id, { text: 'Error processing action.' }); } catch {}
    }
  });
}

function setupMessageHandlers() {
  bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    const text = msg.text;

    // Check for pending edit session
    if (editSessions.has(chatId) && text && !text.startsWith('/')) {
      const callSid = editSessions.get(chatId);
      editSessions.delete(chatId);

      const vm = db.getVoicemailBySid(callSid);
      if (!vm) {
        await bot.sendMessage(chatId, '❌ Voicemail not found. Discarding reply.');
        return;
      }

      if (config.SMS_REPLIES_ENABLED) {
        await sendSms(vm.twilio_number, vm.caller_number, text);
        db.updateVoicemail(callSid, {
          action_taken: 'replied',
          reply_sent_text: text,
          reply_sent_at: new Date().toISOString(),
        });
        await bot.sendMessage(chatId, `✅ Custom reply sent to ${vm.caller_number}:\n\n${text}`);
      } else {
        db.updateVoicemail(callSid, {
          action_taken: 'replied',
          reply_sent_text: text,
          reply_sent_at: new Date().toISOString(),
        });
        await bot.sendMessage(chatId, `📋 Custom reply queued (SMS_REPLIES_ENABLED=false):\n\n*To:* ${vm.caller_number}\n*From:* ${vm.twilio_number}\n\n${text}`, { parse_mode: 'Markdown' });
      }
    }
  });
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

async function sendAdminMessage(text) {
  const b = getBot();
  if (!b) return;
  try {
    await b.sendMessage(config.TELEGRAM_MIKE_USER_ID, text, { parse_mode: 'Markdown' });
  } catch (err) {
    logger.error('Failed to send admin message', { error: err.message });
  }
}

module.exports = { getBot, sendVoicemailCard, sendAdminMessage };
