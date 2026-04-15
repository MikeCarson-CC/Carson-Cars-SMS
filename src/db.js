'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { DateTime } = require('luxon');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sms-collections.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  const fs = require('fs');
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      account_number TEXT PRIMARY KEY,
      customer_nbr TEXT,
      first_name TEXT,
      nickname TEXT,
      last_name TEXT,
      co_buyer_name TEXT,
      cell_phone TEXT,
      language_pref TEXT DEFAULT 'en',
      vehicle_year TEXT,
      vehicle_make TEXT,
      vehicle_model TEXT,
      vin TEXT,
      past_due_amount REAL DEFAULT 0,
      days_past_due INTEGER DEFAULT 0,
      payment_amount REAL DEFAULT 0,
      payment_schedule TEXT,
      account_status TEXT DEFAULT 'active',
      bk_flag INTEGER DEFAULT 0,
      repo_flag INTEGER DEFAULT 0,
      legal_hold_flag INTEGER DEFAULT 0,
      payment_plan_flag INTEGER DEFAULT 0,
      do_not_contact_flag INTEGER DEFAULT 0,
      customer_state TEXT DEFAULT 'NEW' CHECK(customer_state IN ('NEW','TEXTED','IN_CONVERSATION','PROMISE_PENDING','BROKEN_PROMISE','OPTED_OUT')),
      template_a_sent INTEGER DEFAULT 0,
      template_a_sent_at TEXT,
      template_b_sent INTEGER DEFAULT 0,
      template_b_sent_at TEXT,
      template_d_sent INTEGER DEFAULT 0,
      template_d_sent_at TEXT,
      has_replied INTEGER DEFAULT 0,
      last_touched_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS send_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT NOT NULL REFERENCES customers(account_number),
      twilio_message_sid TEXT,
      template_used TEXT,
      message_body TEXT,
      sent_at TEXT DEFAULT (datetime('now')),
      delivered_at TEXT,
      delivery_status TEXT DEFAULT 'queued',
      error_code TEXT
    );

    CREATE TABLE IF NOT EXISTS replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT REFERENCES customers(account_number),
      twilio_message_sid TEXT,
      message_body TEXT,
      language_detected TEXT DEFAULT 'en',
      received_at TEXT DEFAULT (datetime('now')),
      ai_intent TEXT,
      ai_confidence REAL,
      ai_draft_reply TEXT,
      human_action TEXT,
      final_reply_sent TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS opt_outs (
      account_number TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      opted_out_at TEXT DEFAULT (datetime('now')),
      opt_out_trigger TEXT,
      confirmation_sent_at TEXT
    );

    CREATE TABLE IF NOT EXISTS exclusions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT NOT NULL REFERENCES customers(account_number),
      exclusion_reason TEXT NOT NULL,
      exclusion_date TEXT DEFAULT (date('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_commitments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT NOT NULL REFERENCES customers(account_number),
      promised_amount REAL,
      promised_date TEXT,
      source_reply_id INTEGER REFERENCES replies(id),
      created_at TEXT DEFAULT (datetime('now')),
      fulfilled INTEGER DEFAULT 0,
      fulfilled_at TEXT,
      broken_promise_processed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS click_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT NOT NULL,
      clicked_at TEXT DEFAULT (datetime('now')),
      ip_address TEXT,
      user_agent TEXT,
      referrer TEXT
    );

    CREATE TABLE IF NOT EXISTS called_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_number TEXT NOT NULL,
      called_by TEXT,
      called_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_send_log_account ON send_log(account_number);
    CREATE INDEX IF NOT EXISTS idx_send_log_sent_at ON send_log(sent_at);
    CREATE INDEX IF NOT EXISTS idx_replies_account ON replies(account_number);
    CREATE INDEX IF NOT EXISTS idx_replies_received ON replies(received_at);
    CREATE INDEX IF NOT EXISTS idx_click_log_account ON click_log(account_number);
    CREATE INDEX IF NOT EXISTS idx_click_log_clicked ON click_log(clicked_at);
    CREATE INDEX IF NOT EXISTS idx_called_log_account ON called_log(account_number);
    CREATE INDEX IF NOT EXISTS idx_called_log_called ON called_log(called_at);
    CREATE INDEX IF NOT EXISTS idx_customers_state ON customers(customer_state);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(cell_phone);
    CREATE INDEX IF NOT EXISTS idx_payment_commitments_account ON payment_commitments(account_number);
    CREATE INDEX IF NOT EXISTS idx_payment_commitments_date ON payment_commitments(promised_date);
  `);
}

// ──────────────────────────────────────────
// Customer CRUD
// ──────────────────────────────────────────

function upsertCustomer(c) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO customers (
      account_number, customer_nbr, first_name, nickname, last_name, co_buyer_name,
      cell_phone, language_pref, vehicle_year, vehicle_make, vehicle_model, vin,
      past_due_amount, days_past_due, payment_amount, payment_schedule,
      account_status, bk_flag, repo_flag, legal_hold_flag, payment_plan_flag,
      do_not_contact_flag, created_at, updated_at
    ) VALUES (
      @account_number, @customer_nbr, @first_name, @nickname, @last_name, @co_buyer_name,
      @cell_phone, @language_pref, @vehicle_year, @vehicle_make, @vehicle_model, @vin,
      @past_due_amount, @days_past_due, @payment_amount, @payment_schedule,
      @account_status, @bk_flag, @repo_flag, @legal_hold_flag, @payment_plan_flag,
      @do_not_contact_flag, datetime('now'), datetime('now')
    )
    ON CONFLICT(account_number) DO UPDATE SET
      customer_nbr = excluded.customer_nbr,
      first_name = excluded.first_name,
      nickname = excluded.nickname,
      last_name = excluded.last_name,
      co_buyer_name = excluded.co_buyer_name,
      cell_phone = excluded.cell_phone,
      language_pref = excluded.language_pref,
      vehicle_year = excluded.vehicle_year,
      vehicle_make = excluded.vehicle_make,
      vehicle_model = excluded.vehicle_model,
      vin = excluded.vin,
      past_due_amount = excluded.past_due_amount,
      days_past_due = excluded.days_past_due,
      payment_amount = excluded.payment_amount,
      payment_schedule = excluded.payment_schedule,
      account_status = excluded.account_status,
      bk_flag = excluded.bk_flag,
      repo_flag = excluded.repo_flag,
      legal_hold_flag = excluded.legal_hold_flag,
      payment_plan_flag = excluded.payment_plan_flag,
      do_not_contact_flag = excluded.do_not_contact_flag,
      updated_at = datetime('now')
  `);
  return stmt.run(c);
}

function getCustomerByAccount(accountNumber) {
  return getDb().prepare('SELECT * FROM customers WHERE account_number = ?').get(accountNumber);
}

function getCustomerByPhone(phone) {
  return getDb().prepare('SELECT * FROM customers WHERE cell_phone = ?').get(phone);
}

function updateCustomerState(accountNumber, newState) {
  return getDb().prepare(
    'UPDATE customers SET customer_state = ?, updated_at = datetime(\'now\') WHERE account_number = ?'
  ).run(newState, accountNumber);
}

function setTemplateSent(accountNumber, template) {
  const col = template === 'A' ? 'template_a' : template === 'B' ? 'template_b' : 'template_d';
  return getDb().prepare(`
    UPDATE customers
    SET ${col}_sent = 1, ${col}_sent_at = datetime('now'), last_touched_at = datetime('now'), updated_at = datetime('now')
    WHERE account_number = ?
  `).run(accountNumber);
}

function setCustomerReplied(accountNumber) {
  return getDb().prepare(
    'UPDATE customers SET has_replied = 1, updated_at = datetime(\'now\') WHERE account_number = ?'
  ).run(accountNumber);
}

// ──────────────────────────────────────────
// Queue queries
// ──────────────────────────────────────────

function getFirstTouchQueue() {
  return getDb().prepare(`
    SELECT c.* FROM customers c
    WHERE c.customer_state = 'NEW'
      AND c.template_a_sent = 0
      AND c.cell_phone IS NOT NULL AND c.cell_phone != ''
      AND c.account_number NOT IN (SELECT account_number FROM opt_outs)
      AND c.account_number NOT IN (
        SELECT DISTINCT account_number FROM click_log
        WHERE clicked_at > datetime('now', '-24 hours')
      )
    ORDER BY c.past_due_amount DESC
  `).all();
}

function getFollowUpQueue() {
  return getDb().prepare(`
    SELECT c.* FROM customers c
    WHERE c.customer_state = 'TEXTED'
      AND c.template_a_sent = 1
      AND c.has_replied = 0
      AND c.cell_phone IS NOT NULL AND c.cell_phone != ''
      AND c.account_number NOT IN (SELECT account_number FROM opt_outs)
      AND c.account_number NOT IN (
        SELECT DISTINCT account_number FROM click_log
        WHERE clicked_at > datetime('now', '-24 hours')
      )
      AND (
        c.template_a_sent_at IS NOT NULL
        AND datetime(c.template_a_sent_at, '+7 days') <= datetime('now')
      )
      AND (
        c.template_b_sent = 0
        OR (c.template_b_sent_at IS NOT NULL AND datetime(c.template_b_sent_at, '+7 days') <= datetime('now'))
      )
    ORDER BY c.last_touched_at ASC
  `).all();
}

function getBrokenPromiseQueue() {
  return getDb().prepare(`
    SELECT c.*, pc.promised_date, pc.promised_amount, pc.id as commitment_id
    FROM customers c
    JOIN payment_commitments pc ON pc.account_number = c.account_number
    WHERE c.customer_state = 'BROKEN_PROMISE'
      AND pc.fulfilled = 0
      AND pc.broken_promise_processed = 0
      AND c.cell_phone IS NOT NULL AND c.cell_phone != ''
      AND c.account_number NOT IN (SELECT account_number FROM opt_outs)
      AND c.account_number NOT IN (
        SELECT DISTINCT account_number FROM click_log
        WHERE clicked_at > datetime('now', '-24 hours')
      )
    ORDER BY c.past_due_amount DESC
  `).all();
}

function getExcludedCustomers() {
  return getDb().prepare(`
    SELECT c.account_number, c.first_name, c.nickname, c.last_name,
      CASE
        WHEN c.bk_flag = 1 THEN 'bankruptcy'
        WHEN c.repo_flag = 1 THEN 'repo'
        WHEN c.legal_hold_flag = 1 THEN 'legal_hold'
        WHEN c.payment_plan_flag = 1 THEN 'payment_plan'
        WHEN c.do_not_contact_flag = 1 THEN 'do_not_contact'
        WHEN c.account_status IN ('repo','charged_off','paid_off','BK','legal_hold') THEN c.account_status
        WHEN c.account_number IN (SELECT account_number FROM opt_outs) THEN 'opted_out'
        WHEN c.customer_state = 'IN_CONVERSATION' THEN 'in_conversation'
        WHEN c.customer_state = 'PROMISE_PENDING' THEN 'promise_pending'
        WHEN c.cell_phone IS NULL OR c.cell_phone = '' THEN 'no_phone'
        WHEN c.account_number IN (
          SELECT DISTINCT account_number FROM click_log WHERE clicked_at > datetime('now', '-24 hours')
        ) THEN 'recent_click'
        ELSE 'other'
      END as reason
    FROM customers c
    WHERE c.bk_flag = 1
      OR c.repo_flag = 1
      OR c.legal_hold_flag = 1
      OR c.payment_plan_flag = 1
      OR c.do_not_contact_flag = 1
      OR c.account_status IN ('repo','charged_off','paid_off','BK','legal_hold')
      OR c.account_number IN (SELECT account_number FROM opt_outs)
      OR c.customer_state IN ('IN_CONVERSATION', 'PROMISE_PENDING', 'OPTED_OUT')
      OR c.cell_phone IS NULL OR c.cell_phone = ''
      OR c.account_number IN (
        SELECT DISTINCT account_number FROM click_log WHERE clicked_at > datetime('now', '-24 hours')
      )
  `).all();
}

// ──────────────────────────────────────────
// Click-log guardrail
// ──────────────────────────────────────────

function hasRecentClick(accountNumber) {
  const row = getDb().prepare(`
    SELECT 1 FROM click_log
    WHERE account_number = ? AND clicked_at > datetime('now', '-24 hours')
    LIMIT 1
  `).get(accountNumber);
  return !!row;
}

function logClick(accountNumber, ip, userAgent, referrer) {
  return getDb().prepare(`
    INSERT INTO click_log (account_number, clicked_at, ip_address, user_agent, referrer)
    VALUES (?, datetime('now'), ?, ?, ?)
  `).run(accountNumber, ip, userAgent, referrer);
}

// ──────────────────────────────────────────
// Called-log: 5-business-day suppression
// ──────────────────────────────────────────

function markAsCalled(accountNumber, calledBy) {
  return getDb().prepare(`
    INSERT INTO called_log (account_number, called_by, called_at)
    VALUES (?, ?, datetime('now'))
  `).run(accountNumber, calledBy);
}

function wasRecentlyCalled(accountNumber) {
  // 7 calendar days approximates 5 business days
  const row = getDb().prepare(`
    SELECT 1 FROM called_log
    WHERE account_number = ? AND called_at > datetime('now', '-7 days')
    LIMIT 1
  `).get(accountNumber);
  return !!row;
}

// ──────────────────────────────────────────
// Send log
// ──────────────────────────────────────────

function logSend(accountNumber, sid, template, body) {
  return getDb().prepare(`
    INSERT INTO send_log (account_number, twilio_message_sid, template_used, message_body, sent_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(accountNumber, sid, template, body);
}

function updateSendStatus(sid, status, errorCode) {
  const deliveredAt = (status === 'delivered') ? "datetime('now')" : 'NULL';
  return getDb().prepare(`
    UPDATE send_log
    SET delivery_status = ?,
        error_code = ?,
        delivered_at = CASE WHEN ? = 'delivered' THEN datetime('now') ELSE delivered_at END
    WHERE twilio_message_sid = ?
  `).run(status, errorCode, status, sid);
}

function getSendsToday() {
  return getDb().prepare(`
    SELECT COUNT(*) as count FROM send_log
    WHERE date(sent_at) = date('now')
  `).get().count;
}

function getRecentSendErrors(minutes) {
  const rows = getDb().prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN delivery_status IN ('failed','undelivered') THEN 1 ELSE 0 END) as errors
    FROM send_log
    WHERE sent_at > datetime('now', '-' || ? || ' minutes')
  `).get(minutes);
  return rows;
}

function getConsecutiveFailures() {
  const rows = getDb().prepare(`
    SELECT delivery_status FROM send_log
    ORDER BY id DESC LIMIT 10
  `).all();
  let count = 0;
  for (const r of rows) {
    if (r.delivery_status === 'failed' || r.delivery_status === 'undelivered') count++;
    else break;
  }
  return count;
}

// ──────────────────────────────────────────
// Replies
// ──────────────────────────────────────────

function logReply(accountNumber, sid, body, language) {
  return getDb().prepare(`
    INSERT INTO replies (account_number, twilio_message_sid, message_body, language_detected, received_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(accountNumber, sid, body, language || 'en');
}

function updateReplyAI(replyId, intent, confidence, draftReply) {
  return getDb().prepare(`
    UPDATE replies SET ai_intent = ?, ai_confidence = ?, ai_draft_reply = ? WHERE id = ?
  `).run(intent, confidence, draftReply, replyId);
}

function updateReplyHumanAction(replyId, action, finalReply, reviewedBy) {
  return getDb().prepare(`
    UPDATE replies SET human_action = ?, final_reply_sent = ?, reviewed_by = ?, reviewed_at = datetime('now')
    WHERE id = ?
  `).run(action, finalReply, reviewedBy, replyId);
}

function getReplyById(id) {
  return getDb().prepare('SELECT * FROM replies WHERE id = ?').get(id);
}

function getConversationHistory(accountNumber, limit) {
  limit = limit || 20;
  // Combine sends and replies into a chronological conversation
  const sends = getDb().prepare(`
    SELECT 'outbound' as direction, message_body as body, sent_at as timestamp
    FROM send_log WHERE account_number = ? ORDER BY sent_at DESC LIMIT ?
  `).all(accountNumber, limit);
  const replies = getDb().prepare(`
    SELECT 'inbound' as direction, message_body as body, received_at as timestamp
    FROM replies WHERE account_number = ? ORDER BY received_at DESC LIMIT ?
  `).all(accountNumber, limit);
  return [...sends, ...replies].sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
}

function getPendingDrafts() {
  return getDb().prepare(`
    SELECT r.*, c.first_name, c.nickname, c.last_name, c.vehicle_make, c.vehicle_model,
           c.vehicle_year, c.past_due_amount, c.cell_phone
    FROM replies r
    JOIN customers c ON c.account_number = r.account_number
    WHERE r.human_action IS NULL
      AND r.received_at > datetime('now', '-24 hours')
    ORDER BY r.received_at ASC
  `).all();
}

// ──────────────────────────────────────────
// Opt-outs
// ──────────────────────────────────────────

function isOptedOut(accountNumber) {
  const row = getDb().prepare('SELECT 1 FROM opt_outs WHERE account_number = ?').get(accountNumber);
  return !!row;
}

function isPhoneOptedOut(phone) {
  const row = getDb().prepare('SELECT 1 FROM opt_outs WHERE phone = ?').get(phone);
  return !!row;
}

function recordOptOut(accountNumber, phone, trigger) {
  return getDb().prepare(`
    INSERT OR IGNORE INTO opt_outs (account_number, phone, opted_out_at, opt_out_trigger)
    VALUES (?, ?, datetime('now'), ?)
  `).run(accountNumber, phone, trigger);
}

function setOptOutConfirmationSent(accountNumber) {
  return getDb().prepare(
    'UPDATE opt_outs SET confirmation_sent_at = datetime(\'now\') WHERE account_number = ?'
  ).run(accountNumber);
}

// ──────────────────────────────────────────
// Payment commitments
// ──────────────────────────────────────────

function addPaymentCommitment(accountNumber, amount, date, replyId) {
  return getDb().prepare(`
    INSERT INTO payment_commitments (account_number, promised_amount, promised_date, source_reply_id, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(accountNumber, amount, date, replyId);
}

function getUnfulfilledCommitmentsPastDue() {
  // Returns commitments where promised_date + 1 business day has passed
  // We approximate 1 business day as 1-3 calendar days depending on day of week
  return getDb().prepare(`
    SELECT pc.*, c.first_name, c.nickname, c.last_name, c.vehicle_make, c.account_number,
           c.past_due_amount, c.cell_phone
    FROM payment_commitments pc
    JOIN customers c ON c.account_number = pc.account_number
    WHERE pc.fulfilled = 0
      AND pc.broken_promise_processed = 0
      AND c.customer_state = 'PROMISE_PENDING'
      AND date(pc.promised_date, '+3 days') <= date('now')
  `).all();
}

function markBrokenPromiseProcessed(commitmentId) {
  return getDb().prepare(
    'UPDATE payment_commitments SET broken_promise_processed = 1 WHERE id = ?'
  ).run(commitmentId);
}

function getCommitmentsDueToday() {
  return getDb().prepare(`
    SELECT pc.*, c.first_name, c.nickname, c.last_name, c.vehicle_make, c.account_number,
           c.past_due_amount
    FROM payment_commitments pc
    JOIN customers c ON c.account_number = pc.account_number
    WHERE pc.fulfilled = 0
      AND date(pc.promised_date) = date('now')
  `).all();
}

function getBrokenPromisesYesterday() {
  return getDb().prepare(`
    SELECT pc.*, c.first_name, c.nickname, c.last_name, c.vehicle_make, c.account_number,
           c.past_due_amount
    FROM payment_commitments pc
    JOIN customers c ON c.account_number = pc.account_number
    WHERE pc.fulfilled = 0
      AND pc.broken_promise_processed = 1
      AND date(pc.promised_date) = date('now', '-1 day')
  `).all();
}

// ──────────────────────────────────────────
// Exclusion audit log
// ──────────────────────────────────────────

function logExclusion(accountNumber, reason) {
  return getDb().prepare(`
    INSERT INTO exclusions (account_number, exclusion_reason, exclusion_date)
    VALUES (?, ?, date('now'))
  `).run(accountNumber, reason);
}

// ──────────────────────────────────────────
// Report / Stats queries
// ──────────────────────────────────────────

function getStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM customers').get().c;
  const byState = db.prepare(`
    SELECT customer_state, COUNT(*) as c FROM customers GROUP BY customer_state
  `).all();
  const sendsToday = getSendsToday();
  const optOuts = db.prepare('SELECT COUNT(*) as c FROM opt_outs').get().c;
  const totalSends = db.prepare('SELECT COUNT(*) as c FROM send_log').get().c;
  const totalReplies = db.prepare('SELECT COUNT(*) as c FROM replies').get().c;
  return { total, byState, sendsToday, optOuts, totalSends, totalReplies };
}

function getYesterdayActivity() {
  const db = getDb();
  const sent = db.prepare(`
    SELECT COUNT(*) as c FROM send_log WHERE date(sent_at) = date('now', '-1 day')
  `).get().c;
  const delivered = db.prepare(`
    SELECT COUNT(*) as c FROM send_log
    WHERE date(sent_at) = date('now', '-1 day') AND delivery_status = 'delivered'
  `).get().c;
  const failed = db.prepare(`
    SELECT COUNT(*) as c FROM send_log
    WHERE date(sent_at) = date('now', '-1 day') AND delivery_status IN ('failed','undelivered')
  `).get().c;
  const replies = db.prepare(`
    SELECT COUNT(*) as c FROM replies WHERE date(received_at) = date('now', '-1 day')
  `).get().c;
  const clicks = db.prepare(`
    SELECT COUNT(DISTINCT account_number) as c FROM click_log
    WHERE date(clicked_at) = date('now', '-1 day')
  `).get().c;
  const optOuts = db.prepare(`
    SELECT COUNT(*) as c FROM opt_outs WHERE date(opted_out_at) = date('now', '-1 day')
  `).get().c;
  return { sent, delivered, failed, replies, clicks, optOuts };
}

function getHotLeads() {
  // Clicked in last 24-48h but no payment posted (still past due)
  // Exclude: in active conversation, future PTP, called in last 5 biz days
  return getDb().prepare(`
    SELECT c.*, cl.clicked_at, cl.click_count
    FROM customers c
    JOIN (
      SELECT account_number, MAX(clicked_at) as clicked_at, COUNT(*) as click_count
      FROM click_log
      WHERE clicked_at > datetime('now', '-48 hours')
      GROUP BY account_number
    ) cl ON cl.account_number = c.account_number
    WHERE c.past_due_amount > 0
      AND c.customer_state NOT IN ('IN_CONVERSATION', 'OPTED_OUT')
      AND c.account_number NOT IN (
        SELECT account_number FROM payment_commitments
        WHERE fulfilled = 0 AND date(promised_date) >= date('now')
      )
      AND c.account_number NOT IN (
        SELECT account_number FROM called_log
        WHERE called_at > datetime('now', '-7 days')
      )
    ORDER BY cl.clicked_at DESC
  `).all();
}

function getNewOptOutsYesterday() {
  return getDb().prepare(`
    SELECT o.*, c.first_name, c.nickname, c.last_name
    FROM opt_outs o
    LEFT JOIN customers c ON c.account_number = o.account_number
    WHERE date(o.opted_out_at) = date('now', '-1 day')
  `).all();
}

function getOptOutRateToday() {
  const db = getDb();
  const sends = db.prepare(`
    SELECT COUNT(*) as c FROM send_log WHERE date(sent_at) = date('now')
  `).get().c;
  const optOuts = db.prepare(`
    SELECT COUNT(*) as c FROM opt_outs WHERE date(opted_out_at) = date('now')
  `).get().c;
  return { sends, optOuts, rate: sends > 0 ? optOuts / sends : 0 };
}

function getAllCustomers() {
  return getDb().prepare('SELECT * FROM customers ORDER BY past_due_amount DESC').all();
}

function getOpenConversations() {
  return getDb().prepare(`
    SELECT r.*, c.first_name, c.nickname, c.last_name, c.vehicle_make,
           c.account_number, c.past_due_amount
    FROM replies r
    JOIN customers c ON c.account_number = r.account_number
    WHERE r.human_action IS NULL
      AND c.customer_state = 'IN_CONVERSATION'
    ORDER BY r.received_at ASC
  `).all();
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = {
  getDb,
  upsertCustomer,
  getCustomerByAccount,
  getCustomerByPhone,
  updateCustomerState,
  setTemplateSent,
  setCustomerReplied,
  getFirstTouchQueue,
  getFollowUpQueue,
  getBrokenPromiseQueue,
  getExcludedCustomers,
  hasRecentClick,
  logClick,
  markAsCalled,
  wasRecentlyCalled,
  logSend,
  updateSendStatus,
  getSendsToday,
  getRecentSendErrors,
  getConsecutiveFailures,
  logReply,
  updateReplyAI,
  updateReplyHumanAction,
  getReplyById,
  getConversationHistory,
  getPendingDrafts,
  isOptedOut,
  isPhoneOptedOut,
  recordOptOut,
  setOptOutConfirmationSent,
  addPaymentCommitment,
  getUnfulfilledCommitmentsPastDue,
  markBrokenPromiseProcessed,
  getCommitmentsDueToday,
  getBrokenPromisesYesterday,
  logExclusion,
  getStats,
  getYesterdayActivity,
  getHotLeads,
  getNewOptOutsYesterday,
  getOptOutRateToday,
  getAllCustomers,
  getOpenConversations,
  closeDb
};
