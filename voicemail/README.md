# Carson Voicemail Service

Voicemail processing for 6 Carson Cars/Auto Repair phone lines.

## What It Does

- Twilio forwards calls → service plays greeting + records voicemail
- Recording downloaded, transcribed via OpenAI Whisper
- Analyzed by Claude Haiku (real/spam/robocall + summary + smart replies)
- Real calls → Telegram card to Mike with inline reply buttons
- Daily email summary at 6 AM Pacific via Outlook Graph API

## Phone Lines

| Line | Number | Source Name |
|------|--------|-------------|
| Personal Cell | (425) 358-9295 | `personal` |
| Lynnwood Desk Ext 111 | (425) 981-5654 | `ext111` |
| Lynnwood Store Main | (425) 598-7070 | `lynnwood_main` |
| Everett Store Main | (425) 671-5747 | `everett_main` |
| Service Dept Manager | (425) 585-4885 | `service_mgr` |
| Service Dept General | (425) 699-2830 | `service_general` |

## Setup

### 1. Install dependencies

```bash
cd /root/carson-voicemail
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
nano .env  # Fill in all credentials
```

Required values:
- `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` — Twilio console
- `OPENAI_API_KEY` — for Whisper transcription
- `ANTHROPIC_API_KEY` — for Claude Haiku analysis
- `TELEGRAM_BOT_TOKEN` — already set from Hetzner openclaw.json
- Outlook credentials — loaded from `/root/.outlook-mcp/` automatically if env vars not set

### 3. Wire Twilio webhooks

Once credentials are in `.env`:

```bash
node src/twilioWebhooks.js
```

This sets all 6 numbers to point at `http://204.168.149.236:18799/voice/incoming`.

### 4. Start service

```bash
systemctl start carson-voicemail
systemctl enable carson-voicemail
systemctl status carson-voicemail
```

### 5. Verify

```bash
curl http://204.168.149.236:18799/health
```

## SMS Replies

SMS replies are **disabled by default** (`SMS_REPLIES_ENABLED=false`). When a reply button is pressed, the system shows what would be sent but doesn't actually send. Set `SMS_REPLIES_ENABLED=true` once the Twilio SMS campaign is approved.

## Logs

```bash
tail -f /root/carson-voicemail/logs/voicemail-$(date +%Y-%m-%d).log
```

## Admin Endpoints

- `GET /health` — health check
- `GET /admin/voicemails` — last 50 voicemails
- `POST /admin/daily-summary` — trigger summary email manually

## Architecture

```
Twilio call → POST /voice/incoming
  → TwiML: say greeting + <Record>
  → POST /voice/recording (callback)
    → download MP3
    → Whisper transcription
    → Claude Haiku analysis
    → if real: Telegram card
    → if spam: auto-dismiss
  → Daily 6AM: email summary via Outlook Graph
```
