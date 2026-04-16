# Carson Voicemail — Build Progress Log

**Project:** Carson Voicemail
**Deploy target:** Helsinki VPS (204.168.149.236), port 18799
**Repo directory:** voicemail/
**Build started:** 2026-04-16 19:36 UTC
**Service live:** 2026-04-16 19:43 UTC

---

## Status Summary

| Component | Status | Notes |
|---|---|---|
| Project scaffold | ✅ Complete | /root/carson-voicemail/ on Helsinki |
| Node.js service code | ✅ Complete | All source in voicemail/src/ |
| SQLite database | ✅ Running | /root/carson-voicemail/data/voicemails.db |
| systemd service | ✅ Running | `systemctl status carson-voicemail` |
| Health check endpoint | ✅ Pass | `curl http://204.168.149.236:18799/health` → `{"status":"ok"}` |
| Telegram bot wired | ✅ Active | Using default Jarvis bot (token from openclaw.json) |
| Outlook/email creds | ✅ Pre-loaded | Loaded from /root/.outlook-mcp/ |
| Daily email (Outlook) | ✅ Scheduled | 6 AM Pacific cron |
| SMS replies | 🔴 Disabled | `SMS_REPLIES_ENABLED=false` — gate until A2P approved |
| Twilio webhooks wired | 🔴 Blocked | Need TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN in .env |
| OpenAI Whisper | 🔴 Blocked | Need `OPENAI_API_KEY` in .env |
| Anthropic Haiku | 🔴 Blocked | Need `ANTHROPIC_API_KEY` in .env |
| Call forwarding | 🔴 Pending | Mike must set conditional forwarding on physical phones |
| Greetings (TwiML) | ✅ Coded | Per-line greetings with consent disclosure |
| GitHub push | ✅ Complete | voicemail/ subdirectory |

---

## What's Live

The service is running on Helsinki at port 18799. Health check passes.

**What works now (no extra credentials needed):**
- HTTP server on port 18799
- SQLite DB initialized
- Telegram bot polling (default Jarvis bot)
- Daily summary cron scheduled
- Outlook token loading (from /root/.outlook-mcp/)

**What needs credentials to activate:**
1. `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` → enables webhook processing + recording download
2. `OPENAI_API_KEY` → enables Whisper transcription
3. `ANTHROPIC_API_KEY` → enables Haiku analysis and smart replies

---

## To Finish Activation

### Step 1 — Add credentials to .env

```bash
ssh root@204.168.149.236
nano /root/carson-voicemail/.env
# Fill in: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, OPENAI_API_KEY, ANTHROPIC_API_KEY
systemctl restart carson-voicemail
```

### Step 2 — Wire Twilio webhooks

```bash
ssh root@204.168.149.236
cd /root/carson-voicemail
node src/twilioWebhooks.js
```

This sets all 6 numbers' `voiceUrl` to `http://204.168.149.236:18799/voice/incoming`.

### Step 3 — Set up call forwarding

On each physical line, set conditional call forwarding (busy/no-answer) to forward to the corresponding Twilio number. The Twilio numbers are:

| Line | Physical Number | Forward To (Twilio) |
|------|----------------|---------------------|
| Personal Cell | Mike's cell | (425) 358-9295 |
| Lynnwood Ext 111 | Desk phone | (425) 981-5654 |
| Lynnwood Main | Main line | (425) 598-7070 |
| Everett Main | Main line | (425) 671-5747 |
| Service Manager | Desk | (425) 585-4885 |
| Service General | Main | (425) 699-2830 |

### Step 4 — Enable SMS replies (after A2P campaign approved)

```bash
# Edit .env on Helsinki
SMS_REPLIES_ENABLED=true
systemctl restart carson-voicemail
```

---

## Service Management

```bash
systemctl status carson-voicemail
systemctl restart carson-voicemail
journalctl -u carson-voicemail -f
tail -f /root/carson-voicemail/logs/voicemail-$(date +%Y-%m-%d).log
```

## Admin Endpoints

```bash
curl http://204.168.149.236:18799/health
curl http://204.168.149.236:18799/admin/voicemails
curl -X POST http://204.168.149.236:18799/admin/daily-summary
```
