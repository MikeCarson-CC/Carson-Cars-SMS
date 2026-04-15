# Carson Cars — SMS Collections System

## Overview
Automated SMS outreach for past-due BHPH (Buy Here Pay Here) customer accounts.
Replaces manual follow-up with tiered, scheduled text messages via Twilio.

## Status: IN DEVELOPMENT
- Phase 1: Collections only
- Phase 2: Insurance compliance outreach (future)

## System Flow

```
DealPack CSV Export → Ingestion Script → Database → SMS Scheduler → Twilio API
                                                          ↓
                                              Customer gets SMS
                                                          ↓
                                              Reply → Forwarded to staff
                                              STOP → Auto opt-out
```

## Data Source
- **DealPack DMS** — manual CSV export (initially)
- **Required fields:** customer_name, phone, amount_due, days_past_due, last_payment_date, account_number
- **Frequency:** Weekly export (move to daily once stable)
- **Owner:** Jess Godfrey exports, uploads to designated location

## Message Tiers

### Tier 1 — Friendly Reminder (1-15 days past due)
```
Hi [FIRST_NAME], this is Carson Cars. Your payment of $[AMOUNT] was due on [DATE]. 
Please call us at (425) 697-6969 or visit our office to get current. Thank you!
Reply STOP to opt out.
```

### Tier 2 — Firm Reminder (16-30 days past due)
```
[FIRST_NAME], your Carson Cars account is $[AMOUNT] past due. 
Please contact us today at (425) 697-6969 to make arrangements. 
We want to help you stay on track.
Reply STOP to opt out.
```

### Tier 3 — Urgent Notice (31-60 days past due)
```
[FIRST_NAME], your Carson Cars account is $[AMOUNT] past due and requires 
immediate attention. Please call (425) 697-6969 today. Failure to respond 
may result in further collection action.
Reply STOP to opt out.
```

### Tier 4 — Final Notice (61+ days past due)
```
IMPORTANT: [FIRST_NAME], your Carson Cars account is seriously past due at $[AMOUNT]. 
Contact us immediately at (425) 697-6969. This is a final notice before 
additional recovery steps are taken.
Reply STOP to opt out.
```

## Sending Rules
- **Schedule:** One message per tier, per customer, per week (no daily spam)
- **Send window:** Monday-Friday, 9:00 AM - 6:00 PM PT only (TCPA compliant)
- **No send:** Weekends, holidays, before 8 AM or after 9 PM local time
- **Max frequency:** 1 SMS per customer per 7 days
- **Tier escalation:** Customer moves to next tier only after 1 week at current tier with no payment
- **Re-entry:** If customer makes partial payment, reset to Tier 1

## Opt-Out / Compliance
- Every message includes "Reply STOP to opt out"
- Twilio Advanced Opt-Out handles STOP/UNSUBSCRIBE/CANCEL automatically
- Opted-out numbers stored in do-not-contact list
- **CRITICAL:** BHPH contracts MUST include SMS consent language
- All messages logged with timestamp, content, and delivery status

## Twilio Configuration
- **Sending number:** TBD — recommend AR line (425) 696-8488 or new dedicated number
- **Account SID:** (from existing Twilio account)
- **Messaging service:** Create dedicated service for collections
- **Webhook URL:** For inbound replies and delivery status

## Reply Handling
- Customer replies forwarded to designated staff member via:
  - Email notification to staff
  - Telegram alert to Mike
- Common replies auto-categorized:
  - Payment promise → log and flag for follow-up
  - Question → forward to Jess
  - Angry/dispute → flag for Mike

## Logging & Reporting
- Every SMS logged: timestamp, recipient, message tier, delivery status
- Daily summary: messages sent, replies received, opt-outs
- Weekly report: collection effectiveness by tier
- Stored in: SQLite database (simple, no external DB needed)

## Technical Stack
- **Runtime:** Node.js (matches KiloClaw environment)
- **SMS API:** Twilio Node SDK
- **Database:** SQLite (via better-sqlite3)
- **Scheduler:** Cron job via OpenClaw or system cron
- **Config:** Environment variables for Twilio creds, sending number

## File Structure
```
projects/sms-collections/
├── SPEC.md              ← This file
├── src/
│   ├── index.js         ← Main entry point
│   ├── ingest.js        ← CSV import logic
│   ├── scheduler.js     ← Determines who gets texted today
│   ├── sender.js        ← Twilio SMS sending
│   ├── replies.js       ← Inbound reply handler
│   └── db.js            ← SQLite database layer
├── data/
│   ├── imports/         ← Drop CSV files here
│   └── exports/         ← Reports output
├── templates/
│   └── messages.json    ← Message templates by tier
└── package.json
```

## Open Questions (Need Mike's Input)
1. ☐ DealPack CSV export — can Jess do this? What format?
2. ☐ SMS consent in BHPH contracts — confirm language exists
3. ☐ Which Twilio number for collections?
4. ☐ Who handles inbound replies? (Jess? Mike? Dedicated person?)
5. ☐ Any customers who should NEVER be texted? (active legal, disputes, etc.)
6. ☐ Dollar threshold — skip accounts under $X past due?

## TCPA Compliance Notes
- Prior express consent required for autodialed/prerecorded messages
- BHPH contracts should include: "By signing this agreement, you consent to receive 
  text messages from Carson Cars regarding your account, including payment reminders 
  and collection notices, at the phone number(s) you have provided."
- Must honor opt-out within 10 days (Twilio handles instantly)
- No messages before 8 AM or after 9 PM recipient's local time
- Maintain records of consent and opt-out for minimum 4 years
