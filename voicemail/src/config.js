'use strict';

require('dotenv').config({ path: '/root/carson-voicemail/.env' });

// Six Twilio lines: maps E.164 number → config
const LINES = {
  '+14253589295': {
    name: 'personal',
    label: 'Personal Cell',
    sid: 'PN9ab1a69f2ee16b3a614ef69d656ed4e1',
    greeting: "Hey, you've reached Mike Carson. I can't take your call right now. Leave a message and I'll get back to you shortly. This call may be recorded and transcribed.",
  },
  '+14259815654': {
    name: 'ext111',
    label: 'Lynnwood Desk Ext 111',
    sid: 'PN97af7849405006b7dbeaf4a0cd4fca43',
    greeting: "You've reached Mike Carson at Carson Cars. I'm away from my desk. Leave a message and I'll get back to you as soon as possible. This call may be recorded and transcribed.",
  },
  '+14255987070': {
    name: 'lynnwood_main',
    label: 'Lynnwood Store Main',
    sid: 'PNfae65e81cfd8a11bf04239ee7f0d10fa',
    greeting: "Thanks for calling Carson Cars. We can't take your call right now. Leave a message and someone will get back to you shortly. This call may be recorded and transcribed.",
  },
  '+14256715747': {
    name: 'everett_main',
    label: 'Everett Store Main',
    sid: 'PNd59d3730b4213ffc6fead2162f569154',
    greeting: "Thanks for calling Carson Cars Everett. We can't take your call right now. Leave a message and someone will get back to you shortly. This call may be recorded and transcribed.",
  },
  '+14255854885': {
    name: 'service_mgr',
    label: 'Service Dept Manager',
    sid: 'PN9eebf839a131460af75356e6f1f4a4d9',
    greeting: "You've reached the service manager at Carson Cars. I'm away from my desk. Leave a message and I'll get back to you as soon as possible. This call may be recorded and transcribed.",
  },
  '+14256992830': {
    name: 'service_general',
    label: 'Service Dept General',
    sid: 'PNae388c657e5719a8502eb3462756cbb9',
    greeting: "Thanks for calling Carson Auto Repair. We can't take your call right now. Leave a message and someone will get back to you shortly. This call may be recorded and transcribed.",
  },
};

// Reverse lookup: SID → line config
const LINE_BY_SID = {};
for (const [num, cfg] of Object.entries(LINES)) {
  LINE_BY_SID[cfg.sid] = { ...cfg, number: num };
}

// Reverse lookup: name → line config (includes number)
const LINE_BY_NAME = {};
for (const [num, cfg] of Object.entries(LINES)) {
  LINE_BY_NAME[cfg.name] = { ...cfg, number: num };
}

function getLineByNumber(num) {
  // Accept with or without +1 prefix
  const normalized = num.startsWith('+') ? num : '+1' + num.replace(/\D/g, '').slice(-10);
  return LINES[normalized] || null;
}

function getLineBySid(sid) {
  return LINE_BY_SID[sid] || null;
}

function getLineByName(name) {
  return LINE_BY_NAME[name] || null;
}

module.exports = {
  PORT: parseInt(process.env.PORT || '18799'),
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_MIKE_USER_ID: process.env.TELEGRAM_MIKE_USER_ID || '6432405200',
  WEBHOOK_BASE_URL: process.env.WEBHOOK_BASE_URL || 'http://204.168.149.236:18799',
  SMS_REPLIES_ENABLED: process.env.SMS_REPLIES_ENABLED === 'true',
  OUTLOOK_CLIENT_ID: process.env.OUTLOOK_CLIENT_ID || '',
  OUTLOOK_TENANT_ID: process.env.OUTLOOK_TENANT_ID || '',
  OUTLOOK_REFRESH_TOKEN: process.env.OUTLOOK_REFRESH_TOKEN || '',
  OUTLOOK_EMAIL_TO: process.env.OUTLOOK_EMAIL_TO || 'mike@carsoncars.net',
  RECORDING_DIR: process.env.RECORDING_DIR || '/root/carson-voicemail/data/recordings',
  LINES,
  LINE_BY_SID,
  getLineByNumber,
  getLineBySid,
  getLineByName,
};
