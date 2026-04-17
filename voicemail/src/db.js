'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const DB_DIR = '/root/carson-voicemail/data';
const DB_PATH = path.join(DB_DIR, 'voicemails.db');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
    logger.info('Database initialized', { path: DB_PATH });
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voicemails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      twilio_call_sid TEXT UNIQUE,
      source_line TEXT,
      twilio_number TEXT,
      caller_number TEXT,
      caller_name TEXT,
      timestamp_utc TEXT,
      recording_url TEXT,
      recording_local_path TEXT,
      transcript TEXT,
      summary TEXT,
      category TEXT,
      smart_replies_json TEXT,
      action_taken TEXT,
      reply_sent_text TEXT,
      reply_sent_at TEXT,
      telegram_message_id TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocked_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      blocked_by TEXT DEFAULT 'manual',
      blocked_at TEXT DEFAULT (datetime('now')),
      note TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_voicemails_call_sid ON voicemails(twilio_call_sid);
    CREATE INDEX IF NOT EXISTS idx_voicemails_category ON voicemails(category);
    CREATE INDEX IF NOT EXISTS idx_voicemails_created_at ON voicemails(created_at);
    CREATE INDEX IF NOT EXISTS idx_voicemails_action_taken ON voicemails(action_taken);

    CREATE TABLE IF NOT EXISTS sms_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller_number TEXT NOT NULL,
      twilio_number TEXT NOT NULL,
      source_line TEXT,
      direction TEXT NOT NULL,
      message_body TEXT NOT NULL,
      twilio_message_sid TEXT,
      sent_at TEXT DEFAULT (datetime('now')),
      linked_voicemail_sid TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sms_caller_number ON sms_messages(caller_number);
    CREATE INDEX IF NOT EXISTS idx_sms_sent_at ON sms_messages(sent_at);
    CREATE INDEX IF NOT EXISTS idx_sms_direction ON sms_messages(direction);
  `);
}

function insertVoicemail(data) {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT OR REPLACE INTO voicemails 
    (twilio_call_sid, source_line, twilio_number, caller_number, caller_name,
     timestamp_utc, recording_url, recording_local_path, transcript, summary,
     category, smart_replies_json, action_taken, reply_sent_text, reply_sent_at, telegram_message_id)
    VALUES
    (@twilio_call_sid, @source_line, @twilio_number, @caller_number, @caller_name,
     @timestamp_utc, @recording_url, @recording_local_path, @transcript, @summary,
     @category, @smart_replies_json, @action_taken, @reply_sent_text, @reply_sent_at, @telegram_message_id)
  `);
  return stmt.run(data);
}

function updateVoicemail(twilio_call_sid, updates) {
  const d = getDb();
  const keys = Object.keys(updates);
  if (keys.length === 0) return;
  const setClause = keys.map(k => `${k} = @${k}`).join(', ');
  const stmt = d.prepare(`UPDATE voicemails SET ${setClause} WHERE twilio_call_sid = @twilio_call_sid`);
  return stmt.run({ ...updates, twilio_call_sid });
}

function getVoicemailBySid(sid) {
  const d = getDb();
  return d.prepare('SELECT * FROM voicemails WHERE twilio_call_sid = ?').get(sid);
}

function getVoicemailByTelegramMsgId(msgId) {
  const d = getDb();
  return d.prepare('SELECT * FROM voicemails WHERE telegram_message_id = ?').get(String(msgId));
}

function getVoicemailById(id) {
  const d = getDb();
  return d.prepare('SELECT * FROM voicemails WHERE id = ?').get(id);
}

// Get voicemails for yesterday (UTC) for daily summary
function getYesterdayVoicemails() {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM voicemails
    WHERE date(created_at) = date('now', '-1 day')
    ORDER BY created_at ASC
  `).all();
}

// Get all pending/escalated voicemails (not yet resolved)
function getPendingVoicemails() {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM voicemails
    WHERE action_taken = 'escalated' OR action_taken = 'pending'
    ORDER BY created_at ASC
  `).all();
}


function isBlocked(phone) {
  const d = getDb();
  return !!d.prepare('SELECT 1 FROM blocked_numbers WHERE phone = ?').get(phone);
}

function blockNumber(phone, note) {
  const d = getDb();
  d.prepare('INSERT OR IGNORE INTO blocked_numbers (phone, note) VALUES (?, ?)').run(phone, note || '');
}

function unblockNumber(phone) {
  const d = getDb();
  d.prepare('DELETE FROM blocked_numbers WHERE phone = ?').run(phone);
}

function getBlockedNumbers() {
  const d = getDb();
  return d.prepare('SELECT * FROM blocked_numbers ORDER BY blocked_at DESC').all();
}


function searchVoicemails(query) {
  const d = getDb();
  const q = '%' + query + '%';
  return d.prepare(`
    SELECT * FROM voicemails
    WHERE caller_number LIKE ? 
       OR caller_name LIKE ?
       OR transcript LIKE ?
       OR summary LIKE ?
    ORDER BY timestamp_utc DESC
    LIMIT 10
  `).all(q, q, q, q);
}

function getExpiredVoicemails() {
  const d = getDb();
  // Older than 48 months (4 years, WA SOL), not escalated
  return d.prepare(`
    SELECT twilio_call_sid, recording_local_path 
    FROM voicemails
    WHERE created_at < datetime('now', '-48 months')
      AND action_taken != 'escalated'
  `).all();
}

function deleteVoicemailRecord(callSid) {
  const d = getDb();
  d.prepare('DELETE FROM voicemails WHERE twilio_call_sid = ?').run(callSid);
}

// ─── SMS Messages ─────────────────────────────────────────────────────────────

/**
 * hasRepliedBefore — returns true if any voicemail from this caller has a reply_sent_text.
 */
function hasRepliedBefore(callerNumber) {
  const d = getDb();
  const row = d.prepare(
    `SELECT 1 FROM voicemails WHERE caller_number = ? AND reply_sent_text IS NOT NULL LIMIT 1`
  ).get(callerNumber);
  return !!row;
}

/**
 * logSmsMessage — inserts a row into sms_messages and returns the new row id.
 */
function logSmsMessage({ callerNumber, twilioNumber, sourceLine, direction, messageBody, twilioMessageSid, linkedVoicemailSid }) {
  const d = getDb();
  const result = d.prepare(`
    INSERT INTO sms_messages
      (caller_number, twilio_number, source_line, direction, message_body, twilio_message_sid, linked_voicemail_sid)
    VALUES
      (@callerNumber, @twilioNumber, @sourceLine, @direction, @messageBody, @twilioMessageSid, @linkedVoicemailSid)
  `).run({ callerNumber, twilioNumber, sourceLine: sourceLine || null, direction, messageBody, twilioMessageSid: twilioMessageSid || null, linkedVoicemailSid: linkedVoicemailSid || null });
  return result.lastInsertRowid;
}

/**
 * getSmsById — fetches a single sms_messages row by id.
 */
function getSmsById(id) {
  const d = getDb();
  return d.prepare('SELECT * FROM sms_messages WHERE id = ?').get(id);
}

/**
 * getSmsHistory — all messages for a caller, oldest first.
 */
function getSmsHistory(callerNumber) {
  const d = getDb();
  return d.prepare(
    `SELECT * FROM sms_messages WHERE caller_number = ? ORDER BY sent_at ASC`
  ).all(callerNumber);
}

/**
 * searchSmsMessages — searches caller_number and message_body, returns 10 most recent.
 */
function searchSmsMessages(query) {
  const d = getDb();
  const q = '%' + query + '%';
  return d.prepare(`
    SELECT * FROM sms_messages
    WHERE caller_number LIKE ? OR message_body LIKE ?
    ORDER BY sent_at DESC
    LIMIT 10
  `).all(q, q);
}

/**
 * getExpiredSmsMessages — SMS rows older than 48 months.
 */
function getExpiredSmsMessages() {
  const d = getDb();
  return d.prepare(
    `SELECT id FROM sms_messages WHERE created_at < datetime('now', '-48 months')`
  ).all();
}

/**
 * deleteSmsMessage — delete a single sms_messages row by id.
 */
function deleteSmsMessage(id) {
  const d = getDb();
  d.prepare('DELETE FROM sms_messages WHERE id = ?').run(id);
}

module.exports = {
  getDb,
  isBlocked,
  blockNumber,
  unblockNumber,
  getBlockedNumbers,
  searchVoicemails,
  getExpiredVoicemails,
  deleteVoicemailRecord,
  insertVoicemail,
  updateVoicemail,
  getVoicemailBySid,
  getVoicemailByTelegramMsgId,
  getVoicemailById,
  getYesterdayVoicemails,
  getPendingVoicemails,
  hasRepliedBefore,
  logSmsMessage,
  getSmsById,
  getSmsHistory,
  searchSmsMessages,
  getExpiredSmsMessages,
  deleteSmsMessage,
};
