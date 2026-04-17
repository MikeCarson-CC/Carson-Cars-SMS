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
    setupSearchHandler(bot);
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

      // Show confirmation step — don't clear buttons or send yet
      // Post the reply text so Mike can read it, with a Send Confirm button
      await b.answerCallbackQuery(query.id, { text: '👇 Review reply below' });
      const confirmKeyboard = {
        inline_keyboard: [[
          { text: '✅ Confirm Send', callback_data: `confirmsend:${callSid}:${replyIndex}` },
          { text: '❌ Cancel', callback_data: `cancelreply:${callSid}` },
        ]]
      };
      const statusLabel = config.SMS_REPLIES_ENABLED ? 'Will send via SMS' : '⚠️ SMS disabled — will queue';
      await b.sendMessage(chatId,
        `📤 *${statusLabel}*\n\n*To:* ${escapeMarkdown(vm.caller_number)}\n\n${escapeMarkdown(replyText)}`,
        { parse_mode: 'MarkdownV2', reply_markup: confirmKeyboard }
      );

    } else if (data.startsWith('confirmsend:')) {
      const parts = data.replace('confirmsend:', '').split(':');
      const callSid = parts[0];
      const replyIndex = parseInt(parts[1]) - 1;
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
        db.updateVoicemail(callSid, { action_taken: 'replied', reply_sent_text: replyText, reply_sent_at: new Date().toISOString() });
        await b.answerCallbackQuery(query.id, { text: '✅ SMS sent!' });
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
        await b.sendMessage(chatId, `✅ Sent to ${vm.caller_number}`);
      } else {
        db.updateVoicemail(callSid, { action_taken: 'reply_queued', reply_sent_text: replyText, reply_sent_at: new Date().toISOString() });
        await b.answerCallbackQuery(query.id, { text: 'Queued (SMS disabled)' });
        await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
        await b.sendMessage(chatId, `📋 Queued for ${vm.caller_number} when SMS enabled`);
      }
      logger.info('Reply confirmed', { callSid, replyIndex, smsEnabled: config.SMS_REPLIES_ENABLED });

    } else if (data.startsWith('cancelreply:')) {
      await b.answerCallbackQuery(query.id, { text: 'Cancelled' });
      await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
      logger.info('Reply cancelled', { callSid: data.replace('cancelreply:', '') });

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

    } else if (data.startsWith('transcript:')) {
      const callSid = data.replace('transcript:', '');
      const vm = db.getVoicemailBySid(callSid);
      if (!vm) {
        await b.answerCallbackQuery(query.id, { text: 'Voicemail not found.' });
        return;
      }
      if (!vm.transcript) {
        await b.answerCallbackQuery(query.id, { text: 'No transcript available.' });
        return;
      }
      await b.answerCallbackQuery(query.id, { text: '📝 Sending transcript...' });
      const callerDisplay = vm.caller_name ? `${vm.caller_name} (${vm.caller_number})` : vm.caller_number;
      const header = `📝 Transcript — ${callerDisplay}`;
      // Send as plain text to avoid MarkdownV2 escaping issues with arbitrary transcript content
      await b.sendMessage(chatId, `${header}\n\n${vm.transcript}`, { parse_mode: undefined });
      logger.info('Transcript sent', { callSid });

    } else if (data.startsWith('savecontact:')) {
      const callSid = data.replace('savecontact:', '');
      const vm = db.getVoicemailBySid(callSid);
      if (!vm || !vm.caller_number) {
        await b.answerCallbackQuery(query.id, { text: 'No caller number available.' });
        return;
      }
      // Build vCard
      const name = vm.caller_name || vm.caller_number;
      const phone = vm.caller_number;
      const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${name}`,
        `TEL;TYPE=CELL:${phone}`,
        `NOTE:Voicemail received ${vm.timestamp_utc || ''} via Carson Voicemail`,
        'END:VCARD',
      ].join('\r\n');
      const fileName = `${phone.replace(/[^0-9]/g, '')}.vcf`;
      const vcfBuffer = Buffer.from(vcard, 'utf8');
      await b.answerCallbackQuery(query.id, { text: '💾 Sending contact...' });
      await b.sendDocument(chatId, vcfBuffer, {
        caption: `Contact: ${name}`,
      }, {
        filename: fileName,
        contentType: 'text/vcard',
      });
      logger.info('Save Contact: sent vCard', { callSid, phone });

    } else if (data.startsWith('block:')) {
      const callSid = data.replace('block:', '');
      const vm = db.getVoicemailBySid(callSid);
      if (!vm || !vm.caller_number) {
        await b.answerCallbackQuery(query.id, { text: 'Cannot block — no caller number.' });
        return;
      }
      db.blockNumber(vm.caller_number, `Blocked via Telegram ${new Date().toISOString()}`);
      db.updateVoicemail(callSid, { action_taken: 'blocked' });
      await b.answerCallbackQuery(query.id, { text: `Blocked ${vm.caller_number}` });
      await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
      await b.sendMessage(chatId,
        `🚫 *${escapeMarkdown(vm.caller_number)} blocked*\nFuture calls silently rejected\.`,
        { parse_mode: 'MarkdownV2' }
      );
      logger.info('Number blocked', { callSid, phone: vm.caller_number });

    } else if (data.startsWith('notspam:')) {
      const callSid = data.replace('notspam:', '');
      const vm = db.getVoicemailBySid(callSid);
      if (!vm) {
        await b.answerCallbackQuery(query.id, { text: 'Voicemail not found.' });
        return;
      }
      // Re-classify as real and send full card
      db.updateVoicemail(callSid, { category: 'real', action_taken: 'pending' });
      await b.answerCallbackQuery(query.id, { text: 'Marked as real — sending card...' });
      await b.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
      const smartReplies = JSON.parse(vm.smart_replies_json || '[]');
      const lineConfig = require('./config').getLineByName(vm.source_line);
      const lineLabel = lineConfig ? lineConfig.label : vm.source_line;
      await sendVoicemailCard({
        callSid: vm.twilio_call_sid,
        callerNumber: vm.caller_number,
        callerName: vm.caller_name,
        sourceLine: vm.source_line,
        lineLabel,
        timestampUtc: vm.timestamp_utc,
        summary: vm.summary,
        smartReplies,
      });
      logger.info('Not-spam override: resurfaced card', { callSid });

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

function buildVoicemailText({ callerNumber, callerName, lineLabel, timestampUtc, summary }) {
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

function buildButtons(callSid) {
  return {
    inline_keyboard: [
      // Row 1: primary actions
      [
        { text: '🎧 Listen', callback_data: `listen:${callSid}` },
        { text: '📝 Transcript', callback_data: `transcript:${callSid}` },
        { text: '💬 Reply', callback_data: `edit:${callSid}` },
      ],
      // Row 2: flag + block
      [
        { text: '📞 Callback', callback_data: `escalate:${callSid}` },
        { text: '🚫 Block', callback_data: `block:${callSid}` },
      ],
    ]
  };
}

async function sendVoicemailCard({ callSid, callerNumber, callerName, sourceLine, lineLabel, timestampUtc, summary, smartReplies }) {
  const b = getBot();
  if (!b) {
    logger.warn('Telegram bot not configured, skipping notification');
    return null;
  }

  const text = buildVoicemailText({ callerNumber, callerName, lineLabel, timestampUtc, summary });
  const keyboard = buildButtons(callSid);

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


function setupSearchHandler(b) {
  b.onText(/^\/search (.+)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from && msg.from.id;
    if (String(userId) !== String(config.TELEGRAM_MIKE_USER_ID)) return;

    const query = match[1].trim();
    const results = db.searchVoicemails(query);

    if (results.length === 0) {
      await b.sendMessage(chatId, `No voicemails found for: *${escapeMarkdown(query)}*`, { parse_mode: 'MarkdownV2' });
      return;
    }

    await b.sendMessage(chatId, `🔍 Found ${results.length} voicemail${results.length !== 1 ? 's' : ''} for *${escapeMarkdown(query)}*:`, { parse_mode: 'MarkdownV2' });

    for (const vm of results) {
      const callerDisplay = vm.caller_name ? `${vm.caller_name} (${vm.caller_number})` : vm.caller_number;
      const time = vm.timestamp_utc ? vm.timestamp_utc.substring(0, 16).replace('T', ' ') + ' UTC' : 'Unknown time';
      const text = `📞 *${escapeMarkdown(callerDisplay)}*\n` +
        `🕐 ${escapeMarkdown(time)}\n` +
        `📋 ${escapeMarkdown(vm.summary || 'No summary')}`;
      const keyboard = { inline_keyboard: [] };
      if (vm.recording_local_path) {
        keyboard.inline_keyboard.push([
          { text: '🎧 Listen', callback_data: `listen:${vm.twilio_call_sid}` },
          { text: '💾 Save Contact', callback_data: `savecontact:${vm.twilio_call_sid}` },
        ]);
      }
      await b.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
    }
  });
}

module.exports = { getBot, setupWebhook, processUpdate, sendVoicemailCard, sendAdminMessage, setupSearchHandler };
