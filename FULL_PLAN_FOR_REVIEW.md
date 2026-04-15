# CARSON CARS SMS COLLECTIONS — COMPLETE SPEC + ARCHITECTURE PLAN

**Owner:** Mike Carson | Carson Cars, Lynnwood WA
**Build Lead:** Jarvis2 (AI assistant, KiloClaw-hosted)
**Date:** April 14, 2026
**Status:** Core system built, architecture plan pending approval before final build

---

# PART 1: SYSTEM SPECIFICATION (v1)

---

## 1. Purpose & Philosophy

This is an AI-assisted, human-in-the-loop collections SMS system for Carson Cars' in-house BHPH portfolio (~350 eligible past-due accounts at launch).

**Core philosophy:**
- The goal is to open conversations, not deliver ultimatums. Most delinquent accounts will pay simply because the silence ended.
- Carson Cars is a first-party creditor collecting its own debt. FDCPA and Reg F do not apply. TCPA and WA state consumer protection laws do.
- All messages are transactional/informational (about an existing debt), not promotional. Lower consent bar under TCPA.
- AI does the drafting and pattern-matching; humans approve nearly all outbound replies. The AI's job is to make Jessica and Evelyn faster, not replace them.
- Ship simple. Iterate based on real data, not speculation.

---

## 2. Business Problem & Opportunity

### Current Portfolio (as of April 13, 2026)

| Metric | Count |
|--------|-------|
| Total open accounts with balance | 425 |
| Current (on time) | 121 (28.5%) |
| Past due | 304 (71.5%) |
| Total past-due balance | $2,279,098 |
| Average past-due balance | $7,497 |

### Aging Breakdown of Past-Due Accounts

| Bucket | Accounts | % of Past Due |
|--------|----------|---------------|
| 1-30 days | 69 | 22.7% |
| 31-60 days | 34 | 11.2% |
| 61-90 days | 20 | 6.6% |
| 91+ days | 181 | 59.5% |
| **Total** | **304** | **100%** |

Nearly 60% of past-due accounts are 91+ days delinquent. One AR manager (Jessica Velasquez) cannot manually chase 304 accounts. This system handles the outreach volume so she can focus on customers who respond.

### Projected Impact
- If 10% of $2.28M is recovered: **$228,000**
- Industry BHPH first-party SMS reply rates: 15-25%
- Break-even: recovering literally any single payment vs. ~$11/mo operating cost

---

## 3. Compliance Posture

### Applicable Law
- **TCPA (federal)** — applies to all SMS to cell phones
- **WA Consumer Protection Act / UDAP** — applies to tone and truthfulness of messages
- **WA HB 1497 (mini-TCPA)** — likely inapplicable (covers solicitation, not collections of existing debt); attorney to confirm
- **WA CEMA** — likely inapplicable (commercial/marketing, not transactional); attorney to confirm
- **FDCPA / Reg F** — DOES NOT APPLY (first-party creditor exemption)

### Consent Basis
- Prior express consent established when customer provided cell phone in BHPH transaction (2008 FCC ruling, reaffirmed in multiple court decisions)
- Attorney review of BHPH contract SMS language pending (via WSADA referral, not Bigsby — need dealership-specific counsel)

### Non-Negotiable in Every Outbound Message
1. Business identification ("Carson Cars" / "Maria from Carson Cars")
2. Opt-out instructions ("Reply STOP to opt out")
3. Sent only within permitted hours **(10 AM – 4 PM PT, Monday–Friday)**
4. About the debt only — no marketing crossover ever

### STOP Handling (2025 FCC Rule Update)
- Must honor opt-outs through "any reasonable means," not just the word STOP
- Recognize: stop, unsubscribe, cancel, end, quit, remove me, leave me alone, don't text me, no more texts, take me off, and any clear variant
- Spanish equivalents: para, basta, no mas, no más, dejar de, no me mandes, quitar, eliminar, ya no quiero
- Opt-outs are immediate — suppress before the next send cycle
- Auto-send confirmation reply on opt-out
- **When in doubt, opt them out** (can always call from AR line instead)

### Record Retention
**5 years minimum.** All messages, replies, timestamps, opt-outs, consent events. Never auto-purge.

---

## 4. System Architecture

### Data Flow
```
DealPack DMS → Excel export (.xlsx/.csv) → Ingest Script → SQLite DB
    → Scheduler → Twilio API → Customer's Phone

Customer replies → Twilio Webhook → System → Claude Haiku (intent + draft)
    → Telegram Channel → Human Review → Approved Reply → Twilio → Customer
```

### Key Components
1. **Ingest:** DealPack .xlsx/.csv → normalized SQLite records
2. **Scheduler:** Selects who to text, respects pacing + exclusions
3. **Sender:** Twilio outbound via dedicated AR number (425-696-8488)
4. **Inbound Webhook:** Receives replies, classifies intent via Haiku, drafts Maria's response
5. **Telegram Bot:** Posts drafts with inline approval buttons, handles PAUSE/RESUME, delivers daily report
6. **Click Tracker:** Pay.CarsonCars.Net/[StockNbr] → logs click → redirects to eAutoPayment
7. **Database:** SQLite — customers, send_log, replies, opt_outs, exclusions, payment_commitments, click_log

---

## 5. Data Source — DealPack Export

Mike or Jessica V configures a saved DealPack report filtered to OPEN accounts only, exported as .xlsx or .csv weekly (moving to daily once stable).

### Field Mapping (verified against real DealPack exports)

**Identity:**
- CustomerNbr → Internal database key (never shown to customer)
- StockNbr → Customer-facing account number (used in SMS + payment links)
- Customer First Name / Customer Last Name → Personalization
- Joint Name → Co-buyer

**Contact:**
- Cell Phone Nbr → Primary SMS target (normalized to +1XXXXXXXXXX)
- Joint Cell Phone → Co-buyer cell
- Phone Nb1 / Phone Nbr2 → Reference only (never texted)
- Email Address → Future use

**Loan:**
- Amount Financed → Original loan amount
- Principal Balance → Current balance
- Balance Remaining → Alternative balance field
- PaymentAmount → Per-period payment
- Payment Schedule → M (monthly), S (semi-monthly/every 2 weeks), B (bi-weekly)
- Last Payment Date / Next Payment Date → Excel serial numbers, auto-converted
- Days Late → Days past due
- Nbr Days Since Last Pmt → Staleness metric
- Interest Due → Interest portion

**Collateral:**
- Year / Make / Model → Used in SMS template ("your Chevy loan")
- VIN → Vehicle identification
- Odometer → Mileage at sale
- Body Type → Vehicle description

**Status Flags:**
- Bankruptcy YN → Exclusion flag
- Out for Repo YN → Exclusion flag
- Calls Prohibited YN → DNC flag
- Account Freeze YN → Legal hold flag
- Restrict SMS YN → DealPack native SMS restriction (to be added to export)

### Ingest Logic
- Accept .xlsx (read first sheet) or .csv
- Flexible column mapping (handles DealPack naming variants)
- Strip Excel phone number artifacts (scientific notation, trailing .0)
- Normalize phones to E.164 (+1XXXXXXXXXX); reject invalid with logged reason
- Apply exclusion rules (see Section 6)
- Compute derived fields: LTV proxy (payoff ÷ original loan)
- Skip zero-balance accounts
- Upsert into customers table — update existing, insert new
- Archive processed file to data/imports/archive/YYYY-MM-DD_filename.xlsx

### Data Quality Issues Found
- 71 "Binford/Metals Binford" accounts = scrap yard sales sitting in AR because not "posted" on accounting side. Mike emailed Jess Godfrey to clear these.
- DealPack zeros out Principal Balance on repos/charge-offs but keeps Deficiency/Tag Balance
- Older records have ALL CAPS names — system normalizes to title case

---

## 6. Exclusion Logic

A customer is excluded from SMS sending if **ANY** of these are true:

1. account_status in ['repo', 'charged_off', 'paid_off', 'BK', 'legal_hold']
2. Bankruptcy YN = Y
3. Out for Repo YN = Y
4. Account Freeze YN = Y (legal hold)
5. Calls Prohibited YN = Y (DNC)
6. payment_plan_flag = true (on modified arrangement)
7. Customer is in the opt_outs table (ever opted out)
8. No valid cell phone on file
9. Customer on Banks v. Carson Cars litigation list (Case No. 24-2-04734-31)
10. Customer on Lundquist / Max Bladez trespass list

Excluded customers logged to daily report with reason.

---

## 7. Message Templates

**