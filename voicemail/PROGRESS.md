# Carson Voicemail — Build Progress Log

**Project:** Carson Voicemail
**Deploy target:** Helsinki VPS (204.168.149.236), port 18799
**Repo directory:** voicemail/
**Build started:** 2026-04-16 19:36 UTC
**Last updated:** 2026-04-16 20:34 UTC

---

## Current Status: DEPLOYED, AWAITING CLAUDE REVIEW

| Component | Status | Notes |
|---|---|---|
| Project scaffold | ✅ Complete | /root/carson-voicemail/ on Helsinki |
| Twilio numbers | ✅ Purchased | 6 × 425 numbers |
| Number assignment | ✅ Complete | All 6 assigned to lines |
| Node.js service code | ✅ Complete | 10 source files |
| Deploy to Helsinki | ✅ Complete | Service running on port 18799 |
| Health check | ✅ Live | http://204.168.149.236:18799/health → {"status":"ok"} |
| SQLite DB | ✅ Initialized | data/voicemails.db |
| systemd service | ✅ Running | auto-start at boot |
| Twilio credentials | ✅ Wired | In .env on Helsinki |
| OpenAI (Whisper) | ✅ Wired | Validated — 120 models accessible |
| Anthropic (Haiku) | ✅ Wired | Validated — Jarvis-April2-Clean key |
| Outlook email | ✅ Configured | Reads from /root/.outlook-mcp/ automatically |
| Telegram bot | ✅ Active | Using alarm bot (avoids J1 conflict) |
| Twilio webhooks | ✅ Wired | All 6 numbers → /voice/incoming on port 18799 |
| Daily 6AM email | ✅ Scheduled | node-cron, sends to mike@carsoncars.net |
| SMS replies | 🔴 Gated | SMS_REPLIES_ENABLED=false until A2P approved |
| Code in GitHub | ✅ Pushed | voicemail/ subdirectory, source files visible |
| Claude review | ⏳ Pending | Mike sends to Claude, iterate |
| Call forwarding | 🔴 HOLD | Do NOT set up until Claude approves code |
| A2P campaign (voicemail) | 🔴 Blocked | Must fix SMS collections campaign first |
| Greetings approved | ⏳ Pending | Mike to review/re-record 6 draft greetings |

---

## ✅ Completed Log

### 2026-04-16 16:13 UTC — Project scaffold
- Created /root/carson-voicemail/{src,config,logs,data} on Helsinki

### 2026-04-16 16:32 UTC — 6 Twilio numbers purchased
| Line | Number |
|---|---|
| Personal cell VM | (425) 358-9295 |
| Lynnwood desk ext 111 | (425) 981-5654 |
| Lynnwood store main | (425) 598-7070 |
| Everett store main | (425) 671-5747 |
| Service dept manager | (425) 585-4885 |
| Service dept general | (425) 699-2830 |

### 2026-04-16 19:36–19:55 UTC — Full service build + deploy
- 10 source files written and deployed to Helsinki
- npm install (327 packages)
- All 4 API credentials wired (Twilio, OpenAI, Anthropic, Outlook)
- systemd service created, enabled, started
- All 6 Twilio webhooks wired to /voice/incoming
- Health check confirmed: {"status":"ok"}

---

## 🔴 Blocked / Waiting on Mike

### HOLD: Call forwarding
Do NOT set up conditional forwarding on any phone line until Claude reviews the code and Mike gives green light.

### HOLD: SMS replies
SMS_REPLIES_ENABLED=false. Enable only after A2P voicemail campaign is approved.
Prerequisite: fix SMS collections A2P campaign (ACCOUNT_NOTIFICATION use case) first.

### MIKE ACTION REQUIRED (after Claude review)
1. Set conditional forwarding on each line to the assigned Twilio number
2. Review and approve (or re-record) the 6 draft greetings
3. Set SMS_REPLIES_ENABLED=true after A2P approval

---

## Architecture Reference

```
Caller → your line → rings 4-5x → conditional forward → Twilio number
  → Twilio: /voice/incoming webhook → TwiML (greeting + <Record>)
  → Caller leaves message
  → Twilio: /voice/recording webhook (recording URL)
  → Download MP3
  → OpenAI Whisper: transcription
  → Claude Haiku: category + summary + 3 smart reply drafts
    ├─ spam/robocall → log, dismiss, no Telegram
    └─ real → Telegram card to Mike:
         [Reply 1] [Reply 2] [Edit] [Escalate] [Delete]
         → buttons: SMS (when enabled), flag, dismiss

Daily 6:00 AM PT → email summary → mike@carsoncars.net
```

---

## Source Files

| File | Purpose |
|---|---|
| src/index.js | Main entry point, Express server startup |
| src/voiceRoutes.js | Twilio webhook handlers (/voice/incoming, /voice/recording) |
| src/processor.js | Core pipeline: download → Whisper → Haiku → Telegram |
| src/telegram.js | Telegram card formatting + inline button callbacks |
| src/dailySummary.js | Daily 6AM email generation + sending |
| src/db.js | SQLite operations |
| src/config.js | Line config (6 numbers → source labels + greetings) |
| src/outlook.js | Outlook email via Graph API |
| src/logger.js | Winston logging setup |
| src/twilioWebhooks.js | One-time setup script to wire Twilio webhooks |
| .env.example | All required environment variables |
| package.json | Dependencies |
