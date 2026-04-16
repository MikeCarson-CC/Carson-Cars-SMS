'use strict';

/**
 * Twilio webhook configuration utility.
 * Wires all 6 phone numbers to point at /voice/incoming on this server.
 * Run: node src/twilioWebhooks.js
 */

require('dotenv').config({ path: '/root/carson-voicemail/.env' });

const twilio = require('twilio');
const config = require('./config');

async function wireWebhooks() {
  if (!config.TWILIO_ACCOUNT_SID || !config.TWILIO_AUTH_TOKEN) {
    console.error('ERROR: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env');
    process.exit(1);
  }

  const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  const webhookUrl = `${config.WEBHOOK_BASE_URL}/voice/incoming`;

  const lines = Object.values(config.LINES);

  console.log(`Wiring ${lines.length} numbers to ${webhookUrl}`);

  for (const line of lines) {
    try {
      const updated = await client.incomingPhoneNumbers(line.sid).update({
        voiceUrl: webhookUrl,
        voiceMethod: 'POST',
      });
      console.log(`✅ ${line.label} (${line.sid}) → ${webhookUrl}`);
    } catch (err) {
      console.error(`❌ Failed to update ${line.label} (${line.sid}): ${err.message}`);
    }
  }

  console.log('\nDone. Verify in Twilio Console → Phone Numbers → Manage Numbers.');
}

wireWebhooks().catch(console.error);
