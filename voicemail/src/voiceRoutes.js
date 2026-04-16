'use strict';

const express = require('express');
const router = express.Router();
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const processor = require('./processor');

// POST /voice/incoming — Twilio hits this when a call arrives
router.post('/incoming', (req, res) => {
  try {
    const callSid = req.body.CallSid;
    const to = req.body.To || '';       // Twilio number that was called
    const from = req.body.From || '';   // Caller's number
    const callerName = req.body.CallerName || '';

    // Identify the line
    const line = config.getLineByNumber(to);
    if (!line) {
      logger.warn('Unknown Twilio number received call', { to, from, callSid });
      // Fallback: generic greeting
    }

    const greeting = line ? line.greeting : "You've reached Carson Cars. Please leave a message after the tone.";
    const sourceName = line ? line.name : 'unknown';

    logger.info('Incoming call', { callSid, to, from, callerName, line: sourceName });

    // Log initial record in DB (we'll update with transcript later)
    db.insertVoicemail({
      twilio_call_sid: callSid,
      source_line: sourceName,
      twilio_number: to,
      caller_number: from,
      caller_name: callerName || null,
      timestamp_utc: new Date().toISOString(),
      recording_url: null,
      recording_local_path: null,
      transcript: null,
      summary: null,
      category: null,
      smart_replies_json: null,
      action_taken: 'pending',
      reply_sent_text: null,
      reply_sent_at: null,
      telegram_message_id: null,
    });

    // Build TwiML response
    const twiml = new VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' }, greeting);
    twiml.record({
      maxLength: 120,
      playBeep: true,
      action: `${config.WEBHOOK_BASE_URL}/voice/recording`,
      method: 'POST',
      recordingStatusCallback: `${config.WEBHOOK_BASE_URL}/voice/recording`,
      recordingStatusCallbackMethod: 'POST',
    });
    twiml.say({ voice: 'Polly.Joanna' }, 'We did not receive a recording. Goodbye.');

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    logger.error('Error handling incoming call', { error: err.message, stack: err.stack });
    const twiml = new VoiceResponse();
    twiml.say('An error occurred. Please try your call again.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// POST /voice/recording — Twilio hits this with recording details
router.post('/recording', async (req, res) => {
  // Respond immediately to Twilio (must be fast)
  res.status(200).send('<Response></Response>');

  try {
    const callSid = req.body.CallSid;
    const recordingUrl = req.body.RecordingUrl;
    const recordingStatus = req.body.RecordingStatus;
    const recordingSid = req.body.RecordingSid;

    logger.info('Recording callback', { callSid, recordingUrl, recordingStatus, recordingSid });

    if (recordingStatus && recordingStatus !== 'completed') {
      logger.warn('Recording not completed, skipping processing', { recordingStatus, callSid });
      return;
    }

    if (!recordingUrl) {
      logger.warn('No recording URL provided', { callSid });
      return;
    }

    // Get the existing record to find the line info
    const existing = db.getVoicemailBySid(callSid);
    if (!existing) {
      logger.warn('No DB record for call SID', { callSid });
      return;
    }

    // Process async (download, transcribe, analyze, notify)
    await processor.processRecording({
      callSid,
      recordingUrl: recordingUrl + '.mp3',
      sourceLine: existing.source_line,
      twilioNumber: existing.twilio_number,
      callerNumber: existing.caller_number,
      callerName: existing.caller_name,
      timestampUtc: existing.timestamp_utc,
    });
  } catch (err) {
    logger.error('Error handling recording callback', { error: err.message, stack: err.stack });
  }
});

module.exports = router;
