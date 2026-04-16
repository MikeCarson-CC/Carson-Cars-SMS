'use strict';

const axios = require('axios');
const fs = require('fs');
const config = require('./config');
const logger = require('./logger');

const CREDENTIALS_PATH = '/root/.outlook-mcp/credentials.json';
const CONFIG_PATH = '/root/.outlook-mcp/config.json';

async function getAccessToken() {
  // Load credentials
  let refreshToken = config.OUTLOOK_REFRESH_TOKEN;
  let clientId = config.OUTLOOK_CLIENT_ID;
  let tenantId = config.OUTLOOK_TENANT_ID;

  // Fall back to Hetzner credential files if env vars not set
  if (!refreshToken || !clientId) {
    try {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      refreshToken = refreshToken || creds.refresh_token;
      clientId = clientId || cfg.client_id;
      tenantId = tenantId || cfg.tenant_id;
    } catch (e) {
      logger.error('Failed to load Outlook credentials from files', { error: e.message });
      throw new Error('Outlook credentials not available');
    }
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite offline_access',
  });

  const response = await axios.post(tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  // Persist new refresh token if provided
  if (response.data.refresh_token && fs.existsSync(CREDENTIALS_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      existing.refresh_token = response.data.refresh_token;
      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(existing, null, 2));
    } catch (e) {
      logger.warn('Could not persist refreshed token', { error: e.message });
    }
  }

  return response.data.access_token;
}

async function sendEmail({ to, subject, htmlBody }) {
  const accessToken = await getAccessToken();

  const emailPayload = {
    message: {
      subject,
      body: { contentType: 'HTML', content: htmlBody },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: true,
  };

  await axios.post('https://graph.microsoft.com/v1.0/me/sendMail', emailPayload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  logger.info('Email sent via Outlook Graph', { to, subject });
}

module.exports = { sendEmail };
