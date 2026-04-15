'use strict';

const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const db = require('./db');

const PACING_PATH = path.join(__dirname, '..', 'config', 'pacing.json');
const RUNTIME_STATE_PATH = path.join(__dirname, '..', 'config', 'runtime-state.json');

// ──────────────────────────────────────────
// Config loading
// ──────────────────────────────────────────

function loadPacing() {
  return JSON.parse(fs.readFileSync(PACING_PATH, 'utf8'));
}

function loadRuntimeState() {
  if (!fs.existsSync(RUNTIME_STATE_PATH)) {
    return { paused: false, pausedBy: null, pausedAt: null };
  }
  return JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, 'utf8'));
}

function saveRuntimeState(state) {
  fs.writeFileSync(RUNTIME_STATE_PATH, JSON.stringify(state, null, 2));
}

function isPaused() {
  const pacing = loadPacing();
  const runtime = loadRuntimeState();
  return pacing.paused || runtime.paused;
}

function setPaused(paused, by) {
  const state = loadRuntimeState();
  state.paused = paused;
  state.pausedBy = paused ? by : null;
  state.pausedAt = paused ? DateTime.now().setZone('America/Los_Angeles').toISO() : null;
  saveRuntimeState(state);
}

// ──────────────────────────────────────────
// Time window checks
// ──────────────────────────────────────────

function isWithinSendWindow() {
  const pacing = loadPacing();
  const now = DateTime.now().setZone(pacing.sendWindow.timezone || 'America/Los_Angeles');

  // Check day of week (1=Mon, 7=Sun)
  const dow = now.weekday; // luxon: 1=Monday, 7=Sunday
  const allowedDays = pacing.sendWindow.daysOfWeek || [1, 2, 3, 4, 5];
  if (!allowedDays.includes(dow)) return false;

  // Check time window
  const startHour = pacing.sendWindow.startHour;
  const endHour = pacing.sendWindow.endHour;
  const currentHour = now.hour;
  const currentMinute = now.minute;

  if (currentHour < startHour || currentHour >= endHour) return false;

  // Check holidays
  const todayStr = now.toFormat('yyyy-MM-dd');
  if (pacing.holidays && pacing.holidays.includes(todayStr)) return false;

  return true;
}

function isHoliday(dateStr) {
  const pacing = loadPacing();
  return pacing.holidays && pacing.holidays.includes(dateStr);
}

function getNextBusinessDay(fromDate) {
  let d = fromDate.plus({ days: 1 });
  while (d.weekday > 5 || isHoliday(d.toFormat('yyyy-MM-dd'))) {
    d = d.plus({ days: 1 });
  }
  return d;
}

// ──────────────────────────────────────────
// Auto-pause checks
// ──────────────────────────────────────────

function checkAutoPauseTriggers() {
  const triggers = [];

  // >30% Twilio error rate in last hour
  const hourErrors = db.getRecentSendErrors(60);
  if (hourErrors.total >= 5 && hourErrors.errors / hourErrors.total > 0.30) {
    triggers.push({
      reason: 'twilio_error_rate',
      message: `🚨 AUTO-PAUSED: Twilio error rate exceeded 30% in the last hour. [${hourErrors.errors}/${hourErrors.total} sends failed]. Investigate before resuming.`
    });
  }

  // 5+ consecutive failures
  const consecutive = db.getConsecutiveFailures();
  if (consecutive >= 5) {
    triggers.push({
      reason: 'consecutive_failures',
      message: `🚨 AUTO-PAUSED: ${consecutive} consecutive Twilio send failures. Investigate before resuming.`
    });
  }

  // >10% opt-out rate today
  const optRate = db.getOptOutRateToday();
  if (optRate.sends >= 10 && optRate.rate > 0.10) {
    triggers.push({
      reason: 'opt_out_spike',
      message: `🚨 AUTO-PAUSED: Opt-out rate exceeded 10% today [${optRate.optOuts} opt-outs / ${optRate.sends} sends]. Review templates and customer list before resuming.`
    });
  }

  return triggers;
}

// ──────────────────────────────────────────
// Queue building
// ──────────────────────────────────────────

function buildSendQueue() {
  const pacing = loadPacing();
  const dailyCap = pacing.rate.dailyCap || 60;
  const sentToday = db.getSendsToday();
  const remaining = Math.max(0, dailyCap - sentToday);

  if (remaining === 0) {
    return { queue: [], reason: 'daily_cap_reached', sentToday, dailyCap };
  }

  // Load exclusion config
  const exclusionsPath = path.join(__dirname, '..', 'config', 'exclusions.json');
  const exclusionConfig = fs.existsSync(exclusionsPath)
    ? JSON.parse(fs.readFileSync(exclusionsPath, 'utf8'))
    : {};
  const hardcodedIds = new Set();
  if (exclusionConfig.hardcodedExclusions) {
    for (const group of Object.values(exclusionConfig.hardcodedExclusions)) {
      if (Array.isArray(group)) {
        for (const entry of group) {
          if (entry.customerIds) entry.customerIds.forEach(id => hardcodedIds.add(String(id)));
        }
      }
    }
  }

  const queue = [];

  // Priority 1: First touch (NEW → Template A) — highest past-due first
  const firstTouch = db.getFirstTouchQueue();
  for (const c of firstTouch) {
    if (queue.length >= remaining) break;
    if (hardcodedIds.has(c.account_number)) continue;
    queue.push({ ...c, template: 'A', reason: 'first_touch' });
  }

  // Priority 2: Follow-up (TEXTED, 7+ days, no reply → Template B) — oldest last_touched first
  const followUp = db.getFollowUpQueue();
  for (const c of followUp) {
    if (queue.length >= remaining) break;
    if (hardcodedIds.has(c.account_number)) continue;
    queue.push({ ...c, template: 'B', reason: 'follow_up' });
  }

  // Priority 3: Broken promise (BROKEN_PROMISE → Template D)
  const brokenPromise = db.getBrokenPromiseQueue();
  for (const c of brokenPromise) {
    if (queue.length >= remaining) break;
    if (hardcodedIds.has(c.account_number)) continue;
    queue.push({ ...c, template: 'D', reason: 'broken_promise' });
  }

  return { queue, sentToday, dailyCap, remaining };
}

// ──────────────────────────────────────────
// Scheduler loop
// ──────────────────────────────────────────

let schedulerInterval = null;

function startScheduler(sendFn, notifyFn) {
  const pacing = loadPacing();
  const intervalMs = (pacing.rate.intervalMinutes || 5) * 60 * 1000;

  console.log(`[Scheduler] Starting — interval: ${pacing.rate.intervalMinutes}min, cap: ${pacing.rate.dailyCap}/day, window: ${pacing.sendWindow.startHour}:00-${pacing.sendWindow.endHour}:00 PT`);

  async function tick() {
    try {
      // Check if paused
      if (isPaused()) {
        return;
      }

      // Check if within send window
      if (!isWithinSendWindow()) {
        return;
      }

      // Check auto-pause triggers
      const triggers = checkAutoPauseTriggers();
      if (triggers.length > 0) {
        setPaused(true, 'system');
        for (const t of triggers) {
          console.warn(`[Scheduler] ${t.message}`);
          if (notifyFn) await notifyFn(t.message);
        }
        return;
      }

      // Build queue and send next
      const { queue, reason, sentToday, dailyCap } = buildSendQueue();

      if (queue.length === 0) {
        if (reason === 'daily_cap_reached') {
          console.log(`[Scheduler] Daily cap reached (${sentToday}/${dailyCap})`);
        }
        return;
      }

      // Send the first item in the queue
      const next = queue[0];
      console.log(`[Scheduler] Sending Template ${next.template} to ${next.account_number} (${next.nickname || next.first_name || 'Customer'})`);

      if (sendFn) {
        await sendFn(next, next.template);
      }
    } catch (err) {
      console.error(`[Scheduler] Error: ${err.message}`);
    }
  }

  // Run immediately once, then on interval
  tick();
  schedulerInterval = setInterval(tick, intervalMs);

  return schedulerInterval;
}

function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Stopped');
  }
}

module.exports = {
  loadPacing,
  loadRuntimeState,
  saveRuntimeState,
  isPaused,
  setPaused,
  isWithinSendWindow,
  isHoliday,
  getNextBusinessDay,
  checkAutoPauseTriggers,
  buildSendQueue,
  startScheduler,
  stopScheduler
};
