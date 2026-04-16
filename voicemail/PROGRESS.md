# Carson Voicemail — Build Progress Log

**Project:** Carson Voicemail
**Deploy target:** Helsinki VPS (204.168.149.236), port 18799
**Repo directory:** voicemail/
**Build started:** 2026-04-16 19:36 UTC

---

## Status Summary

| Component | Status | Notes |
|---|---|---|
| Project scaffold | ✅ Complete | /root/carson-voicemail/ on Helsinki |
| Twilio numbers | ✅ Purchased | 6 × 425 numbers |
| Number assignment | ✅ Complete | All 6 assigned to lines |
| Node.js service code | 🔄 Building | Sub-agent building now |
| Twilio webhooks wired | ⏳ Pending | After service is deployed |
| systemd service | ⏳ Pending | After code is deployed |
| Health check endpoint | ⏳ Pending | /health on port 18799 |
| Telegram bot wired | ⏳ Pending | Using Helsinki Jarvis bot |
| OpenAI Whisper | ⏳ Blocked | Need API key |
| Anthropic Haiku | ⏳ Blocked | Need API key |
| Daily email (Outlook) | ⏳ Pending | Hetzner credentials available |
| SMS replies | 🔴 Disabled | SMS_REPLIES_ENABLED=false until A2P campaign approved |
| A2P campaign (voicemail) | 🔴 Blocked | Must fix SMS collections A2P first |
| Greetings approved | ⏳ Pending | Mike to review/re-record |
| Forwarding configured | ⏳ Pending | Mike to set conditional forwarding on each line |

---

## ✅ Completed

### 2026-04-16 16:13 UTC — Project scaffold created
- /root/carson-voicemail/{src,config,logs,data} on Helsinki

### 2026-04-16 16:32 UTC — 6 Twilio numbers purchased
| Line | Number | SID |
|---|---|---|
| Personal cell VM | (425) 358-9295 | PN9ab1a69f2ee16b3a614ef69d656ed4e1 |
| Lynnwood desk ext 111 | (425) 981-5654 | PN97af7849405006b7dbeaf4a0cd4fca43 |
| Lynnwood store main | (425) 598-7070 | PNfae65e81cfd8a11bf04239ee7f0d10fa |
| Everett store main | (425) 671-5747 | PNd59d3730b4213ffc6fead2162f569154 |
| Service dept manager | (425) 585-4885 | PN9eebf839a131460af75356e6f1f4a4d9 |
| Service dept general | (425) 699-2830 | PNae388c657e5719a8502eb3462756cbb9 |

---

## 🔄 In Progress

### 2026-04-16 19:36 UTC — Full service build started
Building via sub-agent:
- Express server with 3 webhook routes (/voice/incoming, /voice/recording, /telegram/callback)
- SQLite DB (voicemails table)
- OpenAI Whisper transcription
- Claude Haiku analysis (category + summary + smart replies)
- Telegram inline buttons (Reply 1, Reply 2, Edit, Escalate, Delete)
- Daily 6 AM Pacific summary email via Outlook
- systemd service
- Winston logging with rotation

---

## 🔴 Blocked / Waiting on Mike

### CREDENTIALS NEEDED
- **OpenAI API key** — for Whisper transcription. Get from platform.openai.com → API Keys. Add to .env as OPENAI_API_KEY.
- **Anthropic API key** — for Claude Haiku analysis. Get from console.anthropic.com → API Keys. Add to .env as ANTHROPIC_API_KEY. (Spec mentions "Jarvis-April2-Clean" key on Helsinki — J2 to locate and use if still valid.)

### MIKE ACTION REQUIRED AFTER BUILD
1. **Conditional forwarding** — program each of 6 phone lines to forward-on-no-answer to the assigned Twilio number above. This requires:
   - Verizon cell: dial *71 + 10-digit Twilio number (or set in Verizon app)
   - Xfinity VoiceEdge (ext 111, Lynnwood main, Everett main, service lines): set in VoiceEdge portal or call Xfinity Business
2. **Review greetings** — 6 draft greetings are in the code. Mike to approve or record actual audio.
3. **SMS replies** — Set SMS_REPLIES_ENABLED=true after A2P voicemail campaign is approved.

### A2P CAMPAIGN STATUS (Blocking SMS replies)
- SMS Collections campaign: FAILED (must fix first with ACCOUNT_NOTIFICATION use case)
- Voicemail A2P campaign: not yet created (register after SMS collections clears)
- SMS_REPLIES_ENABLED=false until campaign approved

---

## 📋 Decisions Needed

1. **Anthropic key source:** Spec says "Jarvis-April2-Clean" key on Helsinki. J2 will try to locate. If not found, Mike needs to provide one.
2. **Greeting recordings:** Use TTS (text-to-speech via Twilio) or actual recordings from Mike? Current plan: TTS until Mike records real versions.
3. **Bot token:** Using Helsinki Jarvis bot (from openclaw.json) — this sends voicemail cards to Mike's personal Telegram, NOT the Carson Cars Collections group. Is that correct? Voicemail should go direct to Mike only.

---

## Architecture Reference

```
Caller dials Mike's line
  ↓ rings 4-5 times
  ↓ conditional forward to Twilio number
Twilio answers → /voice/incoming webhook
  ↓ TwiML: play greeting + Record (max 120s)
Recording complete → /voice/recording webhook
  ↓ download MP3
  ↓ Whisper transcription
  ↓ Haiku analysis (category + summary + 3 reply drafts)
  ├─ spam/robocall → log + dismiss (no Telegram)
  └─ real → Telegram card to Mike
       ↓ inline buttons
       ├─ Reply 1/2 → send SMS via Twilio (if enabled)
       ├─ Edit → ask Mike for custom text → send SMS
       ├─ Escalate → mark pending, include in daily email
       └─ Delete → dismiss, log

Daily 6 AM PT → email summary to mike@carsoncars.net
```
