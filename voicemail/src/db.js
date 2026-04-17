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

module.exports = {
  getDb,
  isBlocked,
  blockNumber,
  unblockNumber,
  getBlockedNumbers,
  insertVoicemail,
  updateVoicemail,
  getVoicemailBySid,
  getVoicemailByTelegramMsgId,
  getVoicemailById,
  getYesterdayVoicemails,
  getPendingVoicemails,
};
