'use strict';

const db = require('./db');
const outlook = require('./outlook');
const config = require('./config');
const logger = require('./logger');

const LINE_LABELS = {
  personal: 'Personal Cell',
  ext111: 'Lynnwood Desk Ext 111',
  lynnwood_main: 'Lynnwood Store Main',
  everett_main: 'Everett Store Main',
  service_mgr: 'Service Dept Manager',
  service_general: 'Service Dept General',
};

function formatPacificDate(utcIso) {
  try {
    const d = new Date(utcIso);
    return d.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return utcIso;
  }
}

function getYesterdayDateString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

async function sendDailySummary() {
  logger.info('Running daily summary job');

  try {
    const yesterdayVMs = db.getYesterdayVoicemails();
    const pendingVMs = db.getPendingVoicemails();
    const dateStr = getYesterdayDateString();

    const real = yesterdayVMs.filter(v => v.category === 'real');
    const spam = yesterdayVMs.filter(v => v.category === 'spam' || v.category === 'robocall');

    // Group real VMs by line
    const byLine = {};
    for (const vm of real) {
      if (!byLine[vm.source_line]) byLine[vm.source_line] = [];
      byLine[vm.source_line].push(vm);
    }

    // Build HTML
    let html = `
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: Arial, sans-serif; font-size: 14px; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
  h1 { color: #1a1a2e; border-bottom: 2px solid #e94560; padding-bottom: 8px; }
  h2 { color: #e94560; margin-top: 24px; }
  h3 { color: #555; margin-top: 16px; }
  .stat { font-size: 16px; font-weight: bold; margin: 4px 0; }
  .vm-card { background: #f9f9f9; border-left: 4px solid #e94560; padding: 10px 14px; margin: 10px 0; border-radius: 2px; }
  .vm-meta { color: #666; font-size: 12px; margin-bottom: 6px; }
  .vm-summary { font-weight: bold; margin-bottom: 6px; }
  .vm-action { font-size: 12px; color: #888; }
  .pending-badge { background: #e94560; color: white; padding: 2px 8px; border-radius: 12px; font-size: 11px; }
  .spam-note { color: #999; font-style: italic; }
  .no-vms { color: #999; font-style: italic; }
</style>
</head>
<body>
<h1>🔊 Voicemail Summary — ${dateStr}</h1>

<div class="stat">Total voicemails: ${yesterdayVMs.length}</div>
<div class="stat">Real calls: ${real.length}</div>
<div class="stat spam-note">Spam/robocalls auto-dismissed: ${spam.length}</div>
`;

    // Pending section
    if (pendingVMs.length > 0) {
      html += `<h2>⚠️ PENDING — Needs Attention</h2>`;
      for (const vm of pendingVMs) {
        const daysAgo = Math.floor((Date.now() - new Date(vm.created_at).getTime()) / 86400000);
        const lineLabel = LINE_LABELS[vm.source_line] || vm.source_line;
        html += `
<div class="vm-card" style="border-left-color: #ff6b35;">
  <div class="vm-meta">
    <span class="pending-badge">PENDING ${daysAgo > 0 ? daysAgo + 'd ago' : 'today'}</span>
    &nbsp; ${lineLabel} &nbsp;|&nbsp; ${formatPacificDate(vm.timestamp_utc)}
  </div>
  <div class="vm-summary">${vm.summary || '(no summary)'}</div>
  <div class="vm-meta">From: ${vm.caller_name ? vm.caller_name + ' — ' : ''}${vm.caller_number || 'Unknown'}</div>
</div>`;
      }
    }

    // Real VMs by line
    if (real.length > 0) {
      html += `<h2>📞 Yesterday's Real Voicemails</h2>`;

      for (const [lineName, vms] of Object.entries(byLine)) {
        const lineLabel = LINE_LABELS[lineName] || lineName;
        html += `<h3>${lineLabel} (${vms.length})</h3>`;
        for (const vm of vms) {
          html += `
<div class="vm-card">
  <div class="vm-meta">${formatPacificDate(vm.timestamp_utc)} &nbsp;|&nbsp; From: ${vm.caller_name ? vm.caller_name + ' — ' : ''}${vm.caller_number || 'Unknown'}</div>
  <div class="vm-summary">${vm.summary || '(no summary)'}</div>
  <div class="vm-action">Action: ${vm.action_taken || 'pending'}${vm.reply_sent_text ? ' — "' + vm.reply_sent_text.slice(0, 60) + '..."' : ''}</div>
</div>`;
        }
      }
    } else {
      html += `<p class="no-vms">No real voicemails received yesterday.</p>`;
    }

    html += `
<hr style="margin-top: 32px; border: none; border-top: 1px solid #eee;">
<p style="color: #999; font-size: 12px;">Carson Voicemail System — Powered by Jarvis</p>
</body>
</html>`;

    const subject = `Voicemail Summary — ${dateStr}`;
    await outlook.sendEmail({ to: config.OUTLOOK_EMAIL_TO, subject, htmlBody: html });

    logger.info('Daily summary sent', {
      date: dateStr,
      total: yesterdayVMs.length,
      real: real.length,
      spam: spam.length,
      pending: pendingVMs.length,
    });
  } catch (err) {
    logger.error('Daily summary failed', { error: err.message, stack: err.stack });
  }
}

module.exports = { sendDailySummary };
