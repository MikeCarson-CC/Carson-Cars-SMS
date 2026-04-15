'use strict';

const db = require('./db');
const sender = require('./sender');
const scheduler = require('./scheduler');
const { DateTime } = require('luxon');

// ──────────────────────────────────────────
// Generate daily morning report
// Formatted for Telegram (no markdown tables)
// ──────────────────────────────────────────

function generateDailyReport() {
  const now = DateTime.now().setZone('America/Los_Angeles');
  const dateStr = now.toFormat('MMMM d, yyyy');

  let report = `📊 Carson Cars AR — Daily Collections Report — ${dateStr}\n\n`;

  // ──────────────────────────────────────────
  // 🔥 CALL FIRST — Clicked but didn't pay
  // ──────────────────────────────────────────

  const hotLeads = db.getHotLeads();

  report += `🔥 CALL FIRST — Clicked but didn't pay (last 24-48h):\n`;

  if (hotLeads.length === 0) {
    report += `None — no recent clicks without payment\n\n`;
  } else {
    report += `These customers clicked the payment link but no payment posted.\n`;
    report += `Likely stuck on registration or abandoned. High-priority calls.\n\n`;

    for (const lead of hotLeads) {
      const name = sender.getDisplayName(lead);
      const clicked = DateTime.fromISO(lead.clicked_at).setZone('America/Los_Angeles');
      report += `• ${name} ${lead.last_name || ''} — ${lead.vehicle_make || ''} ${lead.vehicle_model || ''} — Acct #${lead.account_number} — $${lead.past_due_amount || 0} past due\n`;
      report += `  Clicked: ${clicked.toFormat('h:mm a')} ${clicked.toRelativeCalendar()} (${lead.click_count || 1}x) | ${lead.cell_phone || 'no phone'}\n\n`;
    }

    report += `(Excludes active conversations, future-dated PTP, and customers called within 5 business days)\n\n`;
  }

  // ──────────────────────────────────────────
  // 💬 Open conversations needing attention
  // ──────────────────────────────────────────

  const openConvos = db.getOpenConversations();

  report += `💬 Open conversations needing attention:\n`;
  if (openConvos.length === 0) {
    report += `None\n\n`;
  } else {
    for (const convo of openConvos.slice(0, 10)) {
      const name = convo.nickname || convo.first_name || 'Customer';
      const msg = (convo.message_body || '').substring(0, 60);
      report += `• ${name} — Acct #${convo.account_number} — said: "${msg}${msg.length >= 60 ? '...' : ''}"\n`;
    }
    if (openConvos.length > 10) {
      report += `  ...and ${openConvos.length - 10} more\n`;
    }
    report += `\n`;
  }

  // ──────────────────────────────────────────
  // 💰 Payment commitments due today
  // ──────────────────────────────────────────

  const commitments = db.getCommitmentsDueToday();

  report += `💰 Payment commitments due today:\n`;
  if (commitments.length === 0) {
    report += `None\n\n`;
  } else {
    for (const c of commitments) {
      const name = c.nickname || c.first_name || 'Customer';
      report += `• ${name} — Acct #${c.account_number} — promised $${c.promised_amount || '?'} for today\n`;
    }
    report += `\n`;
  }

  // ──────────────────────────────────────────
  // ⚠️ Broken promises (yesterday)
  // ──────────────────────────────────────────

  const brokenPromises = db.getBrokenPromisesYesterday();

  report += `⚠️ Broken promises (yesterday):\n`;
  if (brokenPromises.length === 0) {
    report += `None\n\n`;
  } else {
    for (const bp of brokenPromises) {
      const name = bp.nickname || bp.first_name || 'Customer';
      report += `• ${name} — Acct #${bp.account_number} — promised $${bp.promised_amount || '?'} for ${bp.promised_date}\n`;
    }
    report += `\n`;
  }

  // ──────────────────────────────────────────
  // Yesterday's activity stats
  // ──────────────────────────────────────────

  const activity = db.getYesterdayActivity();

  report += `Yesterday's activity:\n`;
  report += `• Sent: ${activity.sent} messages\n`;
  report += `• Delivered: ${activity.delivered}\n`;
  report += `• Failed: ${activity.failed}\n`;
  report += `• Replies received: ${activity.replies}\n`;
  report += `• Payment portal clicks: ${activity.clicks} unique customers\n`;
  report += `• Opt-outs: ${activity.optOuts}\n\n`;

  // ──────────────────────────────────────────
  // 🚫 New opt-outs
  // ──────────────────────────────────────────

  const newOptOuts = db.getNewOptOutsYesterday();

  report += `🚫 New opt-outs:\n`;
  if (newOptOuts.length === 0) {
    report += `None\n\n`;
  } else {
    for (const o of newOptOuts) {
      const name = o.nickname || o.first_name || 'Unknown';
      report += `• ${name} — Acct #${o.account_number} — opted out ${o.opted_out_at || 'yesterday'}\n`;
    }
    report += `\n`;
  }

  // ──────────────────────────────────────────
  // 📋 Today's send queue
  // ──────────────────────────────────────────

  const { queue } = scheduler.buildSendQueue();
  const templateA = queue.filter(q => q.template === 'A').length;
  const templateB = queue.filter(q => q.template === 'B').length;
  const templateD = queue.filter(q => q.template === 'D').length;

  report += `📋 Today's send queue:\n`;
  report += `• First-touch (Template A): ${templateA} customers\n`;
  report += `• Follow-up (Template B, 7+ days): ${templateB} customers\n`;
  report += `• Broken-promise (Template D): ${templateD} customers\n`;
  report += `• Total planned: ${queue.length}\n\n`;

  // ──────────────────────────────────────────
  // 🛑 Excluded today
  // ──────────────────────────────────────────

  const excluded = db.getExcludedCustomers();
  const reasons = {};
  for (const e of excluded) {
    reasons[e.reason] = (reasons[e.reason] || 0) + 1;
  }

  report += `🛑 Excluded today:\n`;
  if (excluded.length === 0) {
    report += `None\n`;
  } else {
    report += `• ${excluded.length} total`;
    const reasonParts = [];
    for (const [reason, count] of Object.entries(reasons)) {
      reasonParts.push(`${reason}: ${count}`);
    }
    if (reasonParts.length > 0) {
      report += ` (${reasonParts.join(', ')})`;
    }
    report += `\n`;
  }

  // System status
  const paused = scheduler.isPaused();
  report += `\n📌 System: ${paused ? '⏸️ PAUSED' : '▶️ Active'}\n`;

  return report;
}

module.exports = { generateDailyReport };
