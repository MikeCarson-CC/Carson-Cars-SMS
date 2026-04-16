'use strict';

const { getDb } = require('./db');
const { DateTime } = require('luxon');

/**
 * §12.5 — DealPack Action Items Email
 * Daily email to jessica@carsoncars.net + mike@carsoncars.net at 7:30 AM PT
 * Checklist for Jessica to update DealPack from yesterday's SMS conversations
 */

function getLastBusinessDay() {
  let dt = DateTime.now().setZone('America/Los_Angeles').minus({ days: 1 });
  // Skip weekends
  while (dt.weekday === 6 || dt.weekday === 7) {
    dt = dt.minus({ days: 1 });
  }
  return dt.toISODate();
}

function generateDealPackActions() {
  const db = getDb();
  const lastBizDay = getLastBusinessDay();
  const today = DateTime.now().setZone('America/Los_Angeles').toFormat('LLLL d, yyyy');
  
  const sections = [];
  let totalItems = 0;

  // 1. PROMISE TO PAY — commitments detected yesterday
  const ptps = db.prepare(`
    SELECT pc.*, c.first_name, c.nickname, c.last_name, c.vehicle_year, c.vehicle_make, 
           c.vehicle_model, c.account_number, c.cell_phone,
           r.message_body as customer_message, r.ai_draft_reply, r.final_reply_sent
    FROM payment_commitments pc
    JOIN customers c ON c.account_number = pc.account_number
    LEFT JOIN replies r ON r.id = pc.source_reply_id
    WHERE date(pc.created_at) = ?
      AND pc.fulfilled = 0
    ORDER BY pc.promised_date ASC
  `).all(lastBizDay);

  if (ptps.length > 0) {
    let section = 'PROMISE TO PAY — Update PTP date in DealPack\n\n';
    for (const p of ptps) {
      const name = (p.nickname || p.first_name) + ' ' + p.last_name;
      const vehicle = [p.vehicle_year, p.vehicle_make, p.vehicle_model].filter(Boolean).join(' ');
      section += `${name} — Acct #${p.account_number} — ${vehicle}\n`;
      section += `  Promised: $${(p.promised_amount || 0).toFixed(2)} by ${p.promised_date || 'TBD'}\n`;
      if (p.customer_message) {
        section += `  Conversation: Customer said "${p.customer_message.substring(0, 120)}"\n`;
      }
      if (p.final_reply_sent || p.ai_draft_reply) {
        section += `  Maria replied: "${(p.final_reply_sent || p.ai_draft_reply || '').substring(0, 120)}"\n`;
      }
      section += `  Action: Set PTP date to ${p.promised_date || 'TBD'}, amount $${(p.promised_amount || 0).toFixed(2)}\n\n`;
      totalItems++;
    }
    sections.push(section.trim());
  }

  // 2. ESCALATED TO PHONE — escalated replies from yesterday  
  const escalated = db.prepare(`
    SELECT r.*, c.first_name, c.nickname, c.last_name, c.vehicle_year, c.vehicle_make,
           c.vehicle_model, c.account_number, c.cell_phone
    FROM replies r
    JOIN customers c ON c.account_number = r.account_number
    WHERE date(r.received_at) = ?
      AND r.human_action = 'escalate'
    ORDER BY r.received_at ASC
  `).all(lastBizDay);

  if (escalated.length > 0) {
    let section = 'ESCALATED TO PHONE — Needs Jessica callback\n\n';
    for (const e of escalated) {
      const name = (e.nickname || e.first_name) + ' ' + e.last_name;
      const vehicle = [e.vehicle_year, e.vehicle_make, e.vehicle_model].filter(Boolean).join(' ');
      const phone = e.cell_phone || 'no phone';
      section += `${name} — Acct #${e.account_number} — ${vehicle}\n`;
      section += `  Customer said: "${e.message_body.substring(0, 150)}"\n`;
      if (e.ai_draft_reply) {
        section += `  Maria draft: "${e.ai_draft_reply.substring(0, 120)}"\n`;
      }
      section += `  Action: Call customer at ${phone}, discuss situation, log notes in DealPack\n\n`;
      totalItems++;
    }
    sections.push(section.trim());
  }

  // 3. CONVERSATION NOTES — approved replies from yesterday (not escalated, not PTP)
  const conversations = db.prepare(`
    SELECT r.*, c.first_name, c.nickname, c.last_name, c.vehicle_year, c.vehicle_make,
           c.vehicle_model, c.account_number
    FROM replies r
    JOIN customers c ON c.account_number = r.account_number
    WHERE date(r.received_at) = ?
      AND r.human_action IN ('send', 'edit')
      AND r.account_number NOT IN (
        SELECT account_number FROM payment_commitments WHERE date(created_at) = ?
      )
    ORDER BY r.received_at ASC
  `).all(lastBizDay, lastBizDay);

  if (conversations.length > 0) {
    let section = 'CONVERSATION NOTES — Log in DealPack account notes\n\n';
    for (const c of conversations) {
      const name = (c.nickname || c.first_name) + ' ' + c.last_name;
      const vehicle = [c.vehicle_year, c.vehicle_make, c.vehicle_model].filter(Boolean).join(' ');
      section += `${name} — Acct #${c.account_number} — ${vehicle}\n`;
      section += `  Customer said: "${c.message_body.substring(0, 150)}"\n`;
      if (c.final_reply_sent) {
        section += `  Maria replied: "${c.final_reply_sent.substring(0, 150)}"\n`;
      }
      const intent = c.ai_intent || 'general';
      let action = `Add note "Customer contacted via SMS ${lastBizDay}, ${intent} conversation"`;
      if (intent === 'dispute') {
        action = 'Verify payment in DealPack. If found, no further action. If not found, call customer to clarify.';
      }
      section += `  Action: ${action}\n\n`;
      totalItems++;
    }
    sections.push(section.trim());
  }

  // 4. DISPUTES — separate from general conversations
  const disputes = db.prepare(`
    SELECT r.*, c.first_name, c.nickname, c.last_name, c.vehicle_year, c.vehicle_make,
           c.vehicle_model, c.account_number
    FROM replies r
    JOIN customers c ON c.account_number = r.account_number
    WHERE date(r.received_at) = ?
      AND r.ai_intent = 'dispute'
    ORDER BY r.received_at ASC
  `).all(lastBizDay);

  if (disputes.length > 0) {
    let section = 'DISPUTES — Verify before responding\n\n';
    for (const d of disputes) {
      const name = (d.nickname || d.first_name) + ' ' + d.last_name;
      section += `${name} — Acct #${d.account_number}\n`;
      section += `  Customer claims: "${d.message_body.substring(0, 150)}"\n`;
      section += `  Action: Verify in DealPack, then respond or escalate to Mike\n\n`;
      totalItems++;
    }
    sections.push(section.trim());
  }

  // 5. OPT-OUTS — from yesterday
  const optOuts = db.prepare(`
    SELECT o.*, c.first_name, c.nickname, c.last_name, c.account_number
    FROM opt_outs o
    LEFT JOIN customers c ON c.cell_phone = o.phone
    WHERE date(o.opted_out_at) = ?
    ORDER BY o.opted_out_at ASC
  `).all(lastBizDay);

  if (optOuts.length > 0) {
    let section = 'OPT-OUTS — Update DealPack do-not-contact flag\n\n';
    for (const o of optOuts) {
      const name = o.first_name ? (o.nickname || o.first_name) + ' ' + (o.last_name || '') : 'Unknown';
      const acct = o.account_number || 'N/A';
      const time = DateTime.fromISO(o.opted_out_at).setZone('America/Los_Angeles').toFormat('h:mm a');
      section += `${name} — Acct #${acct} — opted out ${lastBizDay} at ${time}\n`;
      section += `  Action: Set do-not-contact flag in DealPack\n\n`;
      totalItems++;
    }
    sections.push(section.trim());
  }

  // 6. BROKEN PROMISES — Template D sent yesterday
  const broken = db.prepare(`
    SELECT pc.*, c.first_name, c.nickname, c.last_name, c.account_number, 
           c.vehicle_make, c.vehicle_model
    FROM payment_commitments pc
    JOIN customers c ON c.account_number = pc.account_number
    WHERE pc.broken_promise_processed = 1
      AND date(pc.fulfilled_at) = ?
    ORDER BY pc.promised_date ASC
  `).all(lastBizDay);

  if (broken.length > 0) {
    let section = 'BROKEN PROMISES — Template D was sent, log in DealPack\n\n';
    for (const b of broken) {
      const name = (b.nickname || b.first_name) + ' ' + b.last_name;
      section += `${name} — Acct #${b.account_number} — promised $${(b.promised_amount || 0).toFixed(2)} for ${b.promised_date}, no payment posted\n`;
      section += `  Action: Log broken PTP in DealPack, note that follow-up SMS was sent\n\n`;
      totalItems++;
    }
    sections.push(section.trim());
  }

  // 7. CLICKED BUT DIDN'T PAY — from yesterday (same as CALL FIRST)
  const clicks = db.prepare(`
    SELECT c.first_name, c.nickname, c.last_name, c.account_number, c.vehicle_make, 
           c.vehicle_model, c.cell_phone, c.past_due_amount,
           COUNT(cl.id) as click_count
    FROM click_log cl
    JOIN customers c ON c.account_number = cl.account_number
    WHERE date(cl.clicked_at) = ?
      AND c.customer_state NOT IN ('IN_CONVERSATION', 'PROMISE_PENDING', 'OPTED_OUT')
      AND c.account_number NOT IN (
        SELECT account_number FROM called_log 
        WHERE called_at > datetime('now', '-7 days')
      )
    GROUP BY c.account_number
    ORDER BY click_count DESC
  `).all(lastBizDay);

  if (clicks.length > 0) {
    let section = 'CLICKED BUT DIDN\'T PAY — High priority callbacks\n\n';
    for (const cl of clicks) {
      const name = (cl.nickname || cl.first_name) + ' ' + cl.last_name;
      section += `${name} — Acct #${cl.account_number} — clicked pay link ${cl.click_count}x yesterday, no payment posted\n`;
      section += `  Phone: ${cl.cell_phone || 'N/A'} | Past due: $${(cl.past_due_amount || 0).toFixed(2)}\n`;
      section += `  Action: Call customer, help them complete payment or troubleshoot registration\n\n`;
      totalItems++;
    }
    sections.push(section.trim());
  }

  // Build full email
  if (totalItems === 0) {
    return null; // No items — don't send email
  }

  let email = `Carson Cars AR — DealPack Action Items — ${today}\n\n`;
  email += `These items need to be updated in DealPack from yesterday's SMS conversations. Work through each section, update the account in DealPack, check it off.\n\n`;
  email += sections.join('\n\n---\n\n');
  email += `\n\n---\n\nTotal action items today: ${totalItems}`;

  return {
    subject: `Carson Cars AR — DealPack Action Items — ${today}`,
    body: email,
    totalItems,
    recipients: ['jessica@carsoncars.net', 'mike@carsoncars.net']
  };
}

module.exports = { generateDealPackActions, getLastBusinessDay };
