'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const telegram = require('./telegram');

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const HAIKU_SYSTEM = `You analyze voicemail transcripts for Mike Carson at Carson Cars, a Buy Here Pay Here car dealership in Lynnwood, WA.

For each transcript:
1. Determine category:
   - 'real': any message from a human that could plausibly be a customer, vendor, employee, or anyone with a legitimate need — even if vague or unclear. When in doubt, classify as real.
   - 'spam': ONLY clear sales pitches, solicitations, or marketing calls with NO customer context whatsoever (e.g. "Hi, I'm calling to offer you SEO services...")
   - 'robocall': clearly automated messages with no human voice (e.g. "This is an automated message from...")
   IMPORTANT: Err heavily toward 'real'. Questions about checks, payments, cars, service, or accounts are ALWAYS real even if the caller mentions another business name. Callers from other businesses (lenders, vendors, auction houses) are real.
2. Write a one-line summary (max 100 chars) of what the caller wants
3. Draft 2-3 smart SMS reply options appropriate for the source line and content

Source line context:
- personal: casual tone, signed 'Mike'
- ext111: professional, signed 'Mike Carson, Carson Cars'
- lynnwood_main/everett_main: professional, signed 'Carson Cars'
- service_mgr/service_general: professional, signed 'Carson Auto Repair'

Return JSON only (no markdown): {"category": "real|spam|robocall", "summary": "...", "smart_replies": ["...", "...", "..."]}`;

async function downloadRecording(url, callSid) {
  const dir = config.RECORDING_DIR;
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${callSid}.mp3`;
  const localPath = path.join(dir, filename);

  // Twilio requires auth to download recordings
  const response = await axios.get(url, {
    auth: {
      username: config.TWILIO_ACCOUNT_SID,
      password: config.TWILIO_AUTH_TOKEN,
    },
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  fs.writeFileSync(localPath, response.data);
  logger.info('Recording downloaded', { callSid, localPath, size: response.data.length });
  return localPath;
}

async function transcribeAudio(localPath, callSid) {
  const fileStream = fs.createReadStream(localPath);
  
  const transcription = await openai.audio.transcriptions.create({
    file: fileStream,
    model: 'whisper-1',
    language: 'en',
  });

  const transcript = transcription.text || '';
  logger.info('Transcription complete', { callSid, length: transcript.length, preview: transcript.slice(0, 80) });
  return transcript;
}

async function analyzeWithHaiku(transcript, sourceLine, callSid) {
  if (!transcript || transcript.trim().length < 3) {
    logger.warn('Transcript too short, classifying as robocall', { callSid });
    return {
      category: 'robocall',
      summary: 'Empty or near-empty recording',
      smart_replies: [],
    };
  }

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    system: HAIKU_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Source line: ${sourceLine}\n\nTranscript:\n${transcript}`,
      },
    ],
  });

  const raw = message.content[0].text.trim();
  logger.info('Haiku analysis raw', { callSid, raw: raw.slice(0, 200) });

  try {
    // Strip any markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      category: parsed.category || 'real',
      summary: parsed.summary || '',
      smart_replies: Array.isArray(parsed.smart_replies) ? parsed.smart_replies.slice(0, 3) : [],
    };
  } catch (e) {
    logger.error('Failed to parse Haiku JSON', { callSid, raw, error: e.message });
    return {
      category: 'real',
      summary: 'Unable to analyze — review manually',
      smart_replies: [],
    };
  }
}

async function processRecording({ callSid, recordingUrl, sourceLine, twilioNumber, callerNumber, callerName, timestampUtc }) {
  logger.info('Processing recording', { callSid, sourceLine, callerNumber });

  let localPath = null;

  try {
    // 1. Download recording
    localPath = await downloadRecording(recordingUrl, callSid);
    db.updateVoicemail(callSid, { recording_url: recordingUrl, recording_local_path: localPath });

    // 2. Transcribe
    const transcript = await transcribeAudio(localPath, callSid);
    db.updateVoicemail(callSid, { transcript });

    // 3. Analyze with Haiku
    const analysis = await analyzeWithHaiku(transcript, sourceLine, callSid);
    db.updateVoicemail(callSid, {
      summary: analysis.summary,
      category: analysis.category,
      smart_replies_json: JSON.stringify(analysis.smart_replies),
    });

    logger.info('Analysis complete', { callSid, category: analysis.category, summary: analysis.summary });

    // 4. Route based on category
    if (analysis.category === 'spam' || analysis.category === 'robocall') {
      db.updateVoicemail(callSid, { action_taken: 'auto_dismissed' });
      logger.info('Auto-dismissed spam/robocall', { callSid, category: analysis.category });
      return;
    }

    // 5. Send Telegram card for real voicemails
    const lineConfig = config.getLineByName(sourceLine);
    const lineLabel = lineConfig ? lineConfig.label : sourceLine;

    const msgId = await telegram.sendVoicemailCard({
      callSid,
      callerNumber,
      callerName,
      sourceLine,
      lineLabel,
      timestampUtc,
      summary: analysis.summary,
      smartReplies: analysis.smart_replies,
    });

    db.updateVoicemail(callSid, { telegram_message_id: String(msgId) });
    logger.info('Telegram notification sent', { callSid, msgId });
  } catch (err) {
    logger.error('Error processing recording', { callSid, error: err.message, stack: err.stack });
    db.updateVoicemail(callSid, { action_taken: 'pending' });
  }
}

module.exports = { processRecording };
