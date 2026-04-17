'use strict';

/**
 * wireSmsSenders.js — Sets SmsUrl on all 6 Twilio numbers to the inbound SMS handler.
 * Run once after deploying the inbound SMS feature:
 *   node src/wireSmsSenders.js
 */

require('dotenv').config({ path: '/root/carson-voicemail/.env' });

const twilio = require('twilio');
const config = require('./config');

async function wireSmsSenders() {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    console.error('ERROR: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env');
    process.exit(1);
  }

  const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  const smsUrl = `${config.WEBHOOK_BASE_URL}/sms/incoming`;

  const lines = Object.values(config.LINES);
  console.log(`Wiring SMS webhooks for ${lines.length} numbers → ${smsUrl}\n`);

  let ok = 0;
  let fail = 0;

  for (const line of lines) {
    try {
      await client.incomingPhoneNumbers(line.sid).update({
        smsUrl,
        smsMethod: 'POST',
      });
      console.log(`✅  ${line.label.padEnd(30)} (${line.sid}) → ${smsUrl}`);
      ok++;
    } catch (err) {
      console.error(`❌  ${line.label.padEnd(30)} (${line.sid}) — FAILED: ${err.message}`);
      fail++;
    }
  }

  console.log(`\nDone. ${ok} succeeded, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

wireSmsSenders().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
