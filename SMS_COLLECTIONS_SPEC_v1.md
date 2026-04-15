# Carson Cars SMS Collections System — v1 Spec

**Owner:** Mike Carson  
**Date:** April 13, 2026  
**Status:** Locked — ready for build  
**Build target:** J2 (Kilo-hosted Jarvis2 instance)

---

## 1. Purpose & Philosophy

This is an AI-assisted, human-in-the-loop collections SMS system for Carson Cars' in-house BHPH portfolio (~288 past-due accounts at launch).

**Core philosophy:**
- The goal is to open conversations, not deliver ultimatums. Most delinquent accounts will pay simply because the silence ended.
- Carson Cars is a first-party creditor collecting its own debt. FDCPA and Reg F do not apply. TCPA and WA state consumer protection laws do.
- All messages are transactional/informational (about an existing debt), not promotional. Lower consent bar under TCPA.
- AI does the drafting and pattern-matching; humans approve nearly all outbound replies. The AI's job is to make Jessica and Evelyn faster, not replace them.
- Ship simple. Iterate based on real data, not speculation.

---

## 2. Compliance Posture

### Applicable law:
- **TCPA (federal)** — applies to all SMS to cell phones
- **WA Consumer Protection Act / UDAP** — applies to tone and truthfulness of messages
- **WA HB 1497 (mini-TCPA)** — likely inapplicable (covers solicitation, not collections of existing debt); attorney to confirm
- **WA CEMA** — likely inapplicable (commercial/marketing, not transactional); attorney to confirm
- **FDCPA / Reg F** — does not apply (first-party creditor exemption)

### Consent basis:
- Prior express consent established when customer provided cell phone in BHPH transaction (2008 FCC ruling, reaffirmed in multiple court decisions)
- Attorney review of BHPH contract SMS language pending (via WSADA referral, not Bigsby)

### Non-negotiable in every outbound message:
- Business identification ("Carson Cars" / "Maria from Carson Cars")
- Opt-out instructions ("Reply STOP to opt out")
- Sent only within permitted hours **(10am–4pm PT, Mon–Fri)**
- About the debt only — no marketing crossover ever

### STOP handling (2025 FCC rule update):
- Must honor opt-outs through "any reasonable means," not just the word STOP
- Recognize: stop, unsubscribe, cancel, end, quit, remove me, leave me alone, don't text me, no more texts, take me off, and any clear variant
- Opt-outs are immediate — suppress before the next send cycle
- Auto-send confirmation reply on opt-out
- **When in doubt, opt them out** (can always call from AR line instead)

### Record retention:
- **5 years minimum.** All messages, replies, timestamps, opt-outs, consent events. Never auto-purge.

---

## 3. Architecture Overview

```
┌──────────────┐     ┌──────────────────┐     ┌────────────────┐
│  DealPack    │────▶│ SMS Collections  │◀───▶│  Twilio A2P    │
│  DMS export  │     │ System (J2)      │     │  SMS (425-     │
│  (xlsx/csv)  │     │ SQLite + Node    │     │  696-8488)     │
└──────────────┘     └────────┬─────────┘     └────────┬───────┘
                              │                        │
                              ▼                        ▼
                    ┌─────────────────┐     ┌─────────────────┐
                    │  Claude Haiku   │     │  Customer cell  │
                    │  (intent class, │     │  phones         │
                    │  draft replies) │     └────────┬────────┘
                    └────────┬────────┘              │
                             │                       │
                             ▼                       ▼
                    ┌──────────────────────────────────┐
                    │  "Carson Cars Collections"       │
                    │  Telegram channel                │
                    │  Members: Mike, Jessica V,       │
                    │  Evelyn (all full access)        │
                    └──────────────────────────────────┘
```

### Key components:
- **Ingest:** DealPack .xlsx/.csv → normalized SQLite records
- **Scheduler:** selects who to text, respects pacing + exclusions
- **Sender:** Twilio outbound via dedicated AR number (425-696-8488)
- **Inbound webhook:** receives replies, classifies intent, drafts Maria's response
- **Telegram bot:** posts drafts with inline approval buttons, handles PAUSE/RESUME commands, delivers daily report
- **Click tracker:** pay.carsoncars.net/[AcctNum] short-link redirector
- **DB:** SQLite — customers, send_log, replies, opt_outs, exclusions, payment_commitments, click_log

---

## 4. Data Source — DealPack Export

Mike (or Jessica V) will configure a saved DealPack report with the fields below, exported weekly (or more often) as .xlsx or .csv into `data/imports/`.

### Required fields

#### Identity
- Account number
- Customer first name
- Customer last name
- Co-buyer first name (if applicable)
- Co-buyer last name (if applicable)
- Preferred language (if DealPack supports — Mike to confirm; default English if not available)

#### Contact
- Cell phone (primary)
- Cell phone (co-buyer, if applicable)
- Home phone (do not text, reference only)
- Email (for future use, not v1)

#### Loan
- Original loan amount
- Current principal balance
- Total payoff (principal + interest + fees)
- Monthly/bi-weekly payment amount
- Payment frequency (monthly / bi-weekly / weekly)
- Past-due amount
- Number of past-due payments
- Days past due
- Last payment date
- Last payment amount
- Next payment due date
- Account open date
- Maturity date

#### Collateral
- Vehicle year
- Vehicle make ← used in outbound message template
- Vehicle model
- VIN
- ACV at time of sale (current book value skipped for v1)
- Mileage at sale
- Collateral type

#### Status flags (for exclusion logic)
- Account status (active / repo / charged off / paid off / BK / legal hold)
- Bankruptcy flag (DP filters these, but system double-checks)
- Repo status flag
- Legal/litigation hold flag
- Payment plan / deferral flag
- Do-not-contact flag
- Insurance on file flag
- Insurance expiration date (for v2 insurance outreach)

### Ingest logic
- Accept .xlsx (read first sheet, log sheet name) or .csv
- Flexible column mapping (handle common DP naming variants)
- Strip Excel phone number artifacts (scientific notation, trailing .0)
- Normalize phones to E.164 (+1XXXXXXXXXX); reject anything else with logged reason
- Apply exclusions (see section 5)
- Compute derived fields: LTV proxy (payoff ÷ original loan as rough stand-in since we're skipping current ACV)
- Upsert into customers table — update existing, insert new
- Archive processed file to `data/imports/archive/YYYY-MM-DD_filename.xlsx`

---

## 5. Exclusion Logic

A customer is excluded from SMS sending if **ANY** of these are true:

1. `account_status` in ['repo', 'charged_off', 'paid_off', 'BK', 'legal_hold']
2. `bankruptcy_flag` = true (belt and suspenders on top of DP's filter)
3. `repo_status_flag` = true
4. `legal_hold_flag` = true
5. `payment_plan_flag` = true (customer already on a modified arrangement)
6. `do_not_contact_flag` = true
7. Customer is in the `opt_outs` table (ever opted out)
8. No valid cell phone on file
9. Customer is on the Banks v. Carson Cars litigation list (hardcoded exclusion)
10. Customer is on the Lundquist / Max Bladez trespass list (hardcoded exclusion)

Excluded customers are logged to the daily report under "Excluded today" with the reason.

---

## 6. Message Templates

**Persona:** "Maria from Carson Cars." Consistent name across all outbound so customers can reference the thread later ("that text I got from Maria").

### Template A — First touch (everyone eligible gets this once)
```
Hi [FirstName], this is Maria from Carson Cars about
your [Make] loan, account #[AcctNum]. Just reply and
I'll help you out, or pay at pay.carsoncars.net/[AcctNum].
Reply STOP to opt out.
```

### Template B — Follow-up (7+ days after Template A, no reply, no payment)
```
Hi [FirstName], Maria at Carson Cars again — still
haven't heard back on your [Make] loan, account
#[AcctNum]. Reply here, call 425-697-6969, or pay at
pay.carsoncars.net/[AcctNum]. Reply STOP to opt out.
```

### Template C — Reply drafts (AI-generated, human-approved via Telegram)

The AI classifies the inbound reply into an intent and drafts Maria's response:

| Customer Intent | Draft Behavior |
|----------------|----------------|
| Balance question | Quote past-due amount + make + payment link |
| Payment commitment ("I'll pay Friday") | Confirm commitment, log in payment_commitments table, flag to Telegram for Friday follow-up |
| Hardship ("lost my job", "medical emergency") | Empathy + "Jessica from our team is reaching out now" + urgent escalation flag |
| Dispute ("I already paid") | Acknowledge + escalate to human (no auto-resolution) |
| Hostile / profanity | No draft — flag to Telegram for human decision |
| Spanish language | Draft in Spanish, show English translation below for reviewer |
| "Are you a real person?" | "I'm Maria, Carson Cars' AR assistant — our team reviews every message. What can I help you with?" |
| Off-topic (trade-in, service, new car) | "I'm just helping with your account today — for that, give us a call at 425-697-6969 and someone will help you out." |
| STOP or equivalent | Auto-process opt-out, send confirmation, no human review needed |

### Auto-send cases (no human review required)
- Opt-out confirmations
- Holding reply when no human has reviewed a draft within 15 minutes of an inbound reply:
```
Hi [FirstName], this is Maria at Carson Cars — I got
your message and someone from our team will respond shortly.
```
(The original draft stays in Telegram for human follow-up.)

### Editable templates
All templates live in `templates/messages.json`. Mike or Jessica can request edits — J2 updates the file, no rebuild required.

---

## 7. Send Pacing & Scheduling

- **Window:** 10:00 AM – 4:00 PM PT, Mon-Fri
- **Rate:** 1 send per 5 minutes (12/hour)
- **Daily cap:** 72 sends maximum
- **Full initial cycle:** ~4 business days for 288 accounts
- **Re-touch interval:** Template B sent 7+ days after Template A if no reply / no payment
- **Sender number:** 425-696-8488 (dedicated AR line, no rotation)
- **Queue order:** First cycle = highest past-due dollar amount first (max ROI). After first cycle = oldest "last touched" first.

### Kill switch
Any authorized user (Mike, Jessica V, Evelyn) can text the Telegram bot:
- **PAUSE** — halts all outbound sending immediately
- **RESUME** — resumes from where it paused
- Confirmation posted to channel in both cases

### Holiday suppression
Send window also suppressed on national holidays (hardcoded list): New Year's, MLK, Presidents', Memorial, Juneteenth, July 4, Labor, Columbus/Indigenous, Veterans, Thanksgiving, Christmas.

---

## 8. Click Tracking — pay.carsoncars.net/[AcctNum]

**DNS / hosting:** Set up pay.carsoncars.net as a subdomain. Recommend Cloudflare Workers (fast, cheap, reliable) or a small Express redirector on Helsinki box.

**Behavior:** Any request to pay.carsoncars.net/[AcctNum] →
1. Log entry in `click_log`: timestamp, account #, IP, user agent, referrer
2. 302 redirect to `https://www.eautopayment.com/Registration?merchantAccountId=1503-2413-1611` (eAutoPayment does not support account-level prefill — customer completes registration manually)

**Privacy note:** Account number in the URL is not PII by itself (no SSN, no name). Low risk. If desired later, can swap to opaque hashed IDs — not needed for v1.

---

## 9. Inbound Reply Handling

Twilio inbound webhook → system:

1. Receive SMS from customer
2. Match to customer record by phone number
3. Check if STOP or equivalent → auto opt-out + confirmation (see §2)
4. Otherwise, pass to Claude Haiku with:
   - Customer profile (name, make, account #, past-due, days late)
   - Full conversation history with this customer
   - Intent classification + drafting instructions (system prompt)
   - Language detection (English vs Spanish)
5. Haiku returns: `{intent, confidence, suggested_reply, escalation_flag, commitment_detected}`
6. Post to Telegram "Carson Cars Collections" channel:

```
💬 New reply from John Smith — 2018 Chevy Silverado — Acct #35668
📞 (425) 555-1234 — [tap to call]

John said: "How much do I owe?"

Maria's draft reply:
"Hi John, you're at $425 past due on the Silverado.
You can pay at pay.carsoncars.net/35668 or let me know
if you want to set up a payment."

[✅ Send] [✏️ Edit] [🚨 Escalate] [🗑 Discard]
```

- If reviewer taps **✅** → Twilio sends the draft to the customer
- If **✏️** → reviewer types replacement → sends
- If **🚨** → draft is discarded; thread flagged for phone follow-up by Jessica
- If **🗑** → draft discarded, no reply sent
- If **no action in 15 minutes** → auto-send holding reply (see §6)

**Spanish flow:** If customer replies in Spanish, draft appears in Spanish in Telegram with English translation below. Reviewer approves Spanish reply.

---

## 10. Telegram Channel — "Carson Cars Collections"

### Members (all full access):
- Mike Carson
- Jessica V (AR Manager / Collector)
- Evelyn (Assistant Manager Carson Auto Repair, former AR Manager)

### Bot posts:
- Inbound reply drafts (real-time)
- Daily 7:30 AM morning report
- Send window start/stop ("Starting today's batch — 47 queued")
- Failures / alerts (Twilio errors, delivery failures, high bounce rate)
- Kill-switch confirmations

### Bot accepts:
- PAUSE / RESUME commands (from any authorized member)
- Inline button actions on draft messages

### Setup tasks (Mike):
1. Create Telegram group "Carson Cars Collections"
2. Add Jessica V and Evelyn (they may need to install Telegram)
3. Provide J2 with each member's Telegram user ID for bot authorization

---

## 11. Daily Morning Report (7:30 AM PT)

Delivered to Telegram channel AND emailed to mike@carsoncars.net.

```
📊 Carson Cars AR — Daily Collections Report — [Date]

Yesterday's activity:
- Sent: X messages
- Delivered: X
- Failed: X (bad numbers — see list below)
- Replies received: X
- Payment portal clicks: X unique customers
- Payments via portal in last 24h: $X across X customers
- Opt-outs: X

🔥 Hot leads — call these first today:
(customers who clicked but haven't paid)
- [Name] — Acct #[X] — $[X] past due — clicked [N]x — last [time]

💬 Open threads needing attention:
(replies where no draft was sent yet)
- [Name] — Acct #[X] — said: "[...]"

💰 Payment commitments due today:
(customers who promised a payment for today)
- [Name] — Acct #[X] — promised $[X]

🚫 New opt-outs (do not contact via SMS):
- [Name] — Acct #[X] — opted out [date/time]

📋 Today's send queue:
- First-touch: X customers
- Follow-up (7+ days): X customers
- Total planned: X

🛑 Excluded today:
- X total (BK: X, repo: X, payment plan: X, legal hold: X, opted out: X)

📈 Program totals:
- Total messaged: X
- Reply rate: X%
- Click rate: X%
- Payments attributed: $X
- Opt-out rate: X%
```

---

## 12. Database Schema (SQLite)

### customers
`account_number` (PK), `first_name`, `last_name`, `co_buyer_name`, `cell_phone` (E.164), `language_pref`, `vehicle_year`, `vehicle_make`, `vehicle_model`, `vin`, `past_due_amount`, `days_past_due`, `account_status`, `bk_flag`, `repo_flag`, `legal_hold_flag`, `payment_plan_flag`, `do_not_contact_flag`, `last_touched_at`, `created_at`, `updated_at`

### send_log
`id` (PK), `account_number` (FK), `twilio_message_sid`, `template_used`, `message_body`, `sent_at`, `delivered_at`, `delivery_status`, `error_code`

### replies
`id` (PK), `account_number` (FK), `twilio_message_sid`, `message_body`, `language_detected`, `received_at`, `ai_intent`, `ai_confidence`, `ai_draft_reply`, `human_action` (send/edit/escalate/discard/holding), `final_reply_sent`, `reviewed_by`, `reviewed_at`

### opt_outs
`account_number` (PK), `phone`, `opted_out_at`, `opt_out_trigger` (STOP / "leave me alone" / etc.), `confirmation_sent_at`

### exclusions (audit log)
`id` (PK), `account_number` (FK), `exclusion_reason`, `exclusion_date`

### payment_commitments
`id` (PK), `account_number` (FK), `promised_amount`, `promised_date`, `source_reply_id` (FK), `created_at`, `fulfilled` (bool), `fulfilled_at`

### click_log
`id` (PK), `account_number`, `clicked_at`, `ip_address`, `user_agent`, `referrer`

---

## 13. Rollout Plan

### Week 1 — spec + prerequisites
- Mike: create Telegram group, add Jessica V + Evelyn
- Mike: contact WSADA for attorney referral, schedule compliance review
- Mike/Jessica V: configure DealPack saved report, pull sample export
- Mike: confirm DealPack language preference field availability
- Mike: set up pay.carsoncars.net DNS (Cloudflare Workers or Helsinki)

### Week 2 — J2 build
- J2 adapts existing skeleton to this spec
- Ingest tested against real DealPack export
- Haiku intent-classifier + drafter prompt developed and tested
- Telegram bot with inline buttons wired
- Inbound Twilio webhook wired and STOP-handling tested with Mike's personal phone

### Week 2 end — dry run
- Full 288-account dry run (no sends) — review output, spot-check 20
- Fix any data quality issues surfaced

### Week 3 — test batch
- Send Template A to 10 hand-picked accounts
- Monitor inbound for 48 hours, review all drafts, watch for edge cases
- Tune templates/prompts based on real replies

### Week 3+ — scale up
- 30 sends/day → 50/day → full 72/day pacing
- Daily report reviewed each morning, templates/pacing tuned weekly

### Acceptance criteria per stage
- No TCPA red flags (opt-outs honored, no off-hours sends, no promotional drift)
- Delivery rate ≥ 90%
- Reply rate ≥ 10% (expected 15-25%)
- Zero wrong-customer sends (verified via spot-checks)
- Jessica confirms the Telegram approval UX is actually faster than manual texting

---

## 14. Configuration Philosophy

All of these are editable via config files, no rebuild needed:

- `templates/messages.json` — message templates A, B, C intents
- `config/pacing.json` — send window, rate, daily cap, queue ordering
- `config/sender.json` — Twilio number, channel settings
- `config/exclusions.json` — exclusion rules, hardcoded names
- `config/ai_prompt.md` — Haiku system prompt for intent + drafting
- `config/auth.json` — Telegram user IDs authorized for PAUSE/RESUME

---

## 15. Open Follow-ups (not blocking build, but need to resolve)

| Item | Owner | Status |
|------|-------|--------|
| WSADA attorney referral for BHPH contract SMS consent review | Mike | Pending |
| Sample DealPack export with real field names | Mike / Jessica V | Pending |
| DealPack language preference field — does it exist? | Mike | Pending |
| Telegram group creation + member user IDs | Mike | Pending |
| pay.carsoncars.net DNS setup | Mike | Pending |
| Twilio Account SID + Auth Token + verified sender number | Mike | Pending (already have account) |

---

## 16. Explicitly Out of Scope for v1

(Content cut off in email)
