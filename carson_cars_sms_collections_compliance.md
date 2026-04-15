# Carson Cars SMS Collections — Compliance Reference

**Owner:** Mike Carson
**Date:** April 14, 2026 (revised to align with spec v1)
**Purpose:** Single source of truth for the legal, regulatory, and operational compliance posture of the Carson Cars SMS collections program. Use this for internal reference, team training, and as the starting document when reviewing with legal counsel.

> ⚠️ **This document is not legal advice.** It summarizes research on applicable laws and industry practice as of April 2026. All compliance positions must be independently reviewed and confirmed by a qualified attorney with TCPA and Washington state consumer protection experience before any messages are sent to customers.

---

## 1. What This Program Is — And What It Is Not

**What it is:**
- Outbound SMS from Carson Cars to Carson Cars' own BHPH customers
- Messages about existing debts the customer owes to Carson Cars (the original creditor)
- Transactional / account-servicing communication — NOT marketing
- Human-in-the-loop: AI drafts replies, humans approve before nearly all outbound sends

**What it is not:**
- Not third-party debt collection (Carson Cars is not a collection agency)
- Not telemarketing or solicitation
- Not promotional or marketing SMS
- Not automated without human oversight

This distinction is the foundation for almost every compliance advantage Carson Cars has.

---

## 2. Legal & Regulatory Framework

### 2.1 Telephone Consumer Protection Act (TCPA) — Federal

**Applies to Carson Cars:** Yes. TCPA governs all SMS to cell phones regardless of purpose.

**Penalties:** $500 per violation, up to $1,500 per willful violation. No cap on aggregate damages. Private right of action (consumers can sue directly). Class actions are common and well-organized.

**Carson Cars' compliance basis:**
- **Prior express consent** established when the customer provided their cell phone in the BHPH transaction that created the debt. The FCC's 2008 ACA International ruling held that a consumer who gives a creditor their number during a transaction consents to calls/texts about that debt. This has been reaffirmed in multiple court decisions since.
- Consent is **transactional**, not marketing — lower bar than the "prior express written consent" required for promotional SMS.
- Consent is limited to messages about the specific debt. Any marketing crossover (promotions, new inventory, service offers) triggers the higher consent standard and is not permitted in this program.

**Required in every outbound message:**
1. Business identification — "Carson Cars" is present in every message (e.g., "Hi [Name], this is Maria from Carson Cars...")
2. Opt-out language — "Reply STOP to opt out" in every message
3. Sent only within permitted hours — 8 AM to 9 PM recipient's local time is the federal ceiling; Carson Cars uses a tighter 11 AM – 4 PM PT, Mon-Fri window
4. About the debt only — no marketing content mixed in

**STOP / opt-out handling (2025 FCC rule):**
Consumers can now revoke consent through any reasonable means, not just the keyword STOP. The system recognizes:
- stop, unsubscribe, cancel, end, quit
- remove me, leave me alone, don't text me, no more texts, take me off
- Any clear variant expressing a desire not to be contacted

Opt-outs are processed **immediately** — before the next send cycle. Confirmation reply is auto-sent. Opted-out numbers are permanently suppressed.

**Record retention:** All messages, replies, timestamps, consent events, and opt-outs are retained for **minimum 5 years**. The TCPA statute of limitations is 4 years; records must outlast it.

### 2.2 Fair Debt Collection Practices Act (FDCPA) — Federal

**Applies to Carson Cars:** NO.

The FDCPA governs third-party debt collectors — companies collecting debt on behalf of someone else. It does not apply to original creditors collecting their own debts. Carson Cars is the original creditor on every account in this program. The FDCPA and its implementing regulation (Regulation F, effective 2021) do not apply.

Note: If Carson Cars ever sends accounts to an outside collection agency, the FDCPA applies to that agency — but not to Carson Cars' conduct with the same customer prior to that handoff.

### 2.3 Washington State Consumer Protection Act (CPA) / UDAP — RCW 19.86

**Applies to Carson Cars:** Yes, generally. The WA CPA prohibits "unfair or deceptive acts or practices" in trade or commerce. It is enforced by the WA Attorney General and through private lawsuits (with treble damages and attorneys' fees available).

**What this means for messaging:**
- No threats of action Carson Cars does not actually take or cannot legally take
- No false or misleading statements about amounts, deadlines, or consequences
- Tone must be non-deceptive and non-abusive

**Program alignment:** Templates are friendly and factual. Escalation messages only mention consequences that match what Carson Cars actually does (e.g., no threats of lawsuit or repo unless those actions are truly on the table for that account).

### 2.4 Washington Mini-TCPA (HB 1497 / RCW 80.36.400) — State

**Applies to Carson Cars:** Likely NO, but attorney to confirm.

HB 1497 (effective June 9, 2022) regulates "telephone solicitation," defined as unsolicited calls or texts to encourage someone to purchase goods or services. Texting an existing customer about an existing debt is not solicitation. The statute also excludes calls related to items purchased within the past 12 months.

**Penalties if it did apply:** $100-$2,000 per violation plus attorneys' fees.

**Action item:** Confirm inapplicability in writing with counsel before launch.

### 2.5 Washington Commercial Electronic Mail Act (CEMA) — RCW 19.190

**Applies to Carson Cars:** Likely NO for this program, but attorney to confirm.

CEMA primarily targets commercial/marketing electronic communications. It has been applied to SMS in Washington federal courts (e.g., cases against Block, Robinhood, Capital One over refer-a-friend programs). Transactional account-servicing texts to existing customers generally fall outside its scope.

**Why this matters:** WA federal courts have been receptive to CEMA-based SMS class actions. Even if inapplicable here, attorney review should confirm in writing.

### 2.6 Carrier Rules — CTIA / 10DLC

**Applies to Carson Cars:** Yes.

These are not laws but are enforced via carrier filtering and number deactivation. Carson Cars' 10 Twilio numbers completed A2P 10DLC vetting, which helps — but does not grant immunity from:
- Spam filtering based on content (all-caps, excessive punctuation, public URL shorteners)
- Throttling if complaint rates exceed ~1%
- Carrier deactivation for persistent abuse reports

**Program mitigations:**
- Own-domain short URL (pay.carsoncars.net) instead of bit.ly / tinyurl
- Natural-language content, no SHOUTING or clustered $$$ symbols
- Easy opt-out to reduce "report as junk" complaints
- Single dedicated sending number (425-696-8488), no rotation — builds trust/recognition
- Monitor delivery rate; action if it drops below 90%

---

## 3. Consent — The Foundation

**The whole program depends on this being solid.** If consent is shaky, every send is a potential TCPA violation at $500-$1,500 a pop.

### What we rely on

Every customer in the program provided their cell phone number when entering the BHPH retail installment contract that created the debt. Under the 2008 FCC ACA International ruling and subsequent case law, this constitutes prior express consent for the creditor to contact the customer about that debt via the provided number, including via autodialed texts.

### What the attorney needs to confirm

1. **Does the current Carson Cars BHPH retail installment contract contain explicit SMS/text messaging consent language?** If yes, consent is bulletproof. If no, we rely on the 2008 FCC ruling (strong but litigated).
2. **If explicit SMS language is absent from the current contract, should Carson Cars add it going forward?** Recommended yes — future deals become even cleaner. Language should:
   - Clearly disclose text messaging about the account
   - Clearly disclose that messages may be automated
   - Be conspicuous (not buried in fine print)
   - Have a separate signature or initial line if possible
3. **Should Carson Cars develop a standalone SMS consent form** to backfill consent for customers with older contracts? (Optional — nice-to-have, not required given the 2008 ruling.)

### Consent is revocable

A customer can withdraw consent at any time, by any reasonable means. When they do, they go on the opt-out list permanently. Re-consent requires a new, documented agreement.

---

## 4. Operational Rules — What the System Does and Doesn't Do

### 4.1 Who gets texted

**Included:** Customers with an active account, past-due balance, valid cell phone on file, and no exclusion flag.

**Excluded from all SMS (system-enforced):**
- Bankruptcy (Chapter 7 or 13 — texting in active BK = automatic stay violation, federal sanctions)
- Repossession status
- Charged-off accounts
- Paid-off accounts
- Accounts on a documented payment plan or deferral
- Accounts with a "do not contact" flag
- Accounts in active legal hold or litigation (including the Banks v. Carson Cars plaintiff class)
- Accounts associated with trespass notices (e.g., Lundquist / Max Bladez)
- Customers on the opt-out list (permanent)
- Customers without a valid cell phone
- Customers currently in IN_CONVERSATION or PROMISE_PENDING state (auto-sends paused while in active dialogue or awaiting promised payment)
- Customers who clicked the payment link in the last 24 hours (click-log guardrail — possible payment in flight)

### 4.2 When texts are sent

- **Days:** Monday through Friday only
- **Hours:** 11:00 AM to 4:00 PM Pacific Time
- **Holidays:** Suppressed on federal holidays
- **Rate:** 1 text every 5 minutes maximum (12/hour)
- **Daily cap:** 60 messages maximum
- **Frequency per customer:** Maximum 1 message per 7-day period

This is significantly more conservative than the federal TCPA ceiling (8 AM – 9 PM, 7 days a week). Conservatism here is deliberate: the program is building trust and minimizing complaint risk, not optimizing send volume.

### 4.3 What the texts say

Every outbound message:
- Identifies Carson Cars and "Maria" (the consistent program persona)
- References the customer's specific vehicle make (e.g., "Chevy loan")
- Includes the account number
- Includes a clear opt-out instruction
- Includes a payment link (pay.carsoncars.net/[AcctNum]) or callback number
- Does not contain marketing content, urgency language, threats, or consequences not actually intended

### 4.4 Replies — human-in-the-loop review

**Every inbound reply goes through human review before most outbound responses are sent.** AI drafts a suggested reply; a human (Mike, Jessica V, or Evelyn) approves it via Telegram before it is sent to the customer.

**The only auto-sent cases:**
1. STOP / opt-out confirmations
2. "Holding reply" if no human has reviewed an inbound message within 15 minutes ("I got your message and someone from our team will respond shortly")

**"Are you a real person?"** If a customer directly asks whether they're texting a human, the approved response is honest: *"I'm Maria, Carson Cars' AR assistant — our team reviews every message. What can I help you with?"* This is both the ethical and legally safer answer.

**AI does not negotiate payment plans.** Payment plan requests are escalated to Jessica V for a human conversation.

**Off-topic requests stay off-topic.** If a customer asks about new inventory, trade-ins, or service, the response directs them to call the main number. The collections system stays in its lane; sales and service are not mixed in (both compliance best practice and TCPA safer).

---

## 5. Data Handling and Security

- Customer data is pulled from DealPack and stored locally in SQLite on Carson Cars infrastructure
- Messages, replies, and consent events are logged with timestamps and retained for 5 years minimum
- Short URL click logs (IP, user agent, timestamp) are retained as evidence of customer engagement (supports both ROI measurement and TCPA defense)
- Telegram channel access is limited to Mike Carson, Jessica V, and Evelyn
- Twilio credentials, AI API keys, and database access are secured via environment variables with restricted file permissions; SSH key-only authentication; disabled password login
- Daily encrypted backups to Hetzner BX11 storage box with monthly verified restore testing
- Customer data stored on fresh isolated Hetzner CX22 (not shared with Jarvis/OpenClaw)

---

## 6. Roles and Responsibilities

**Mike Carson (Owner)**
- Program sponsor and final decision authority
- Signs off on templates, policy changes, and escalation paths
- Receives daily morning report
- Authorized to issue PAUSE/RESUME

**Jessica V (AR Manager / Collector)**
- Day-to-day operator of the collections function
- Primary reviewer of inbound draft replies via Telegram
- Handles escalated customer conversations (payment plans, hardship, disputes)
- Maintains DealPack data quality (invalid phones, status flag updates)
- Authorized to issue PAUSE/RESUME

**Evelyn (Assistant Manager, Carson Auto Repair; former AR Manager)**
- Backup reviewer of inbound drafts
- Steps in when Jessica is unavailable
- 7 years of AR experience with Carson Cars — trusted judgment
- Authorized to issue PAUSE/RESUME

**Not on this program:** Robert (Finance Manager) — intentionally excluded to keep the operational chain clean.

---

## 7. What To Do If Something Goes Wrong

### A customer complains directly about receiving texts
1. Immediately opt them out (add to `opt_outs` table)
2. Send confirmation reply
3. Jessica V follows up with a phone call from the AR line to address the underlying concern
4. Log the incident

### A customer threatens legal action
1. Immediately opt them out
2. No further contact via any channel until reviewed by Mike
3. Do not delete any records — preserve the full message history
4. Contact counsel before any further action

### System restored from backup
1. System auto-PAUSES after any restore — will NOT auto-resume
2. Telegram alert posted identifying backup date and data gap
3. Review Twilio message logs for the gap window to identify any opt-outs, replies, or PTPs not captured in restored DB
4. Update DB manually if any opt-outs need to be re-applied
5. Only RESUME after gap has been reconciled

### A TCPA demand letter or class action is received
1. Do not respond directly to the complainant
2. Preserve all records — do not delete, modify, or purge anything
3. Immediately contact TCPA counsel (WSADA referral on file)
4. Pause the program (PAUSE command) pending counsel review of the issue

### Delivery rate drops below 90% or complaint rate rises
1. Investigate cause (content, volume, number reputation)
2. Pause the program if necessary
3. Adjust templates or pacing before resuming

### AI drafts something inappropriate
1. Reviewer discards the draft (🗑️)
2. Reviewer sends a human-written reply
3. Issue logged for prompt tuning
4. Repeated issues → escalate to Mike for template / prompt review

---

## 8. Open Items Requiring Attorney Sign-Off Before Launch

| Item | Status |
|---|---|
| Confirm current BHPH contract contains SMS consent language | Pending |
| Confirm WA HB 1497 (mini-TCPA) does not apply to this program | Pending |
| Confirm WA CEMA does not apply to this program | Pending |
| Review Templates A, B, D, and representative C drafts for TCPA/UDAP compliance | Pending |
| Confirm 5-year record retention policy meets statute of limitations | Pending |
| Recommend updates to BHPH contract SMS language for future deals | Pending |
| Review opt-out procedures for FCC 2025 rule compliance | Pending |
| Review escalation procedures for hardship, dispute, hostile, and BK reveals | Pending |

**Recommended attorney pathway:**
1. Call WSADA (Washington State Auto Dealers Association) member services — they maintain a referral panel of dealer-experienced attorneys with TCPA expertise
2. If no fit via WSADA, Davis Wright Tremaine (Seattle) is the WA firm with the deepest published track record on WA mini-TCPA and CEMA
3. Request a flat-fee compliance review for the scope of items above — likely $1,500-$3,500 for the full package

**Do not use:** Bigsby (wrong practice area — landlord/tenant, general business). Retain him for the trespass and customer-dispute matters he already handles.

---

## 9. Pre-Launch Compliance Checklist

Before the first live SMS goes out to a customer, confirm every box below is checked:

- [ ] Attorney review completed on all open items in section 8
- [ ] BHPH contract SMS consent language confirmed
- [ ] Templates A, B, D and sample C drafts reviewed and approved
- [ ] All 10 Twilio numbers confirmed A2P 10DLC registered and active
- [ ] Dedicated AR number (425-696-8488) voicemail greeting recorded ("You've reached Carson Cars accounts receivable...")
- [ ] pay.carsoncars.net DNS live and tested
- [ ] Inbound Twilio webhook live and STOP handling tested with Mike's personal phone
- [ ] "Carson Cars Collections" Telegram channel created, all three members added, inline buttons tested
- [ ] DealPack saved report configured and tested with one real export
- [ ] Full dry run on the 288-account list completed, output spot-checked
- [ ] Test batch of 10 customers sent, inbound replies monitored for 48 hours
- [ ] No TCPA red flags surfaced in test batch
- [ ] Daily morning report delivering cleanly to Telegram + mike@carsoncars.net

---

## 10. Revision Log

| Date | Change | By |
|---|---|---|
| 2026-04-13 | Initial document — pre-launch compliance posture | Mike Carson / Claude |
| 2026-04-14 | Corrected send window to 11 AM – 4 PM PT and daily cap to 60 to match spec. Added click-log guardrail and state machine exclusions to §4.1. Added post-restore procedure to §7. Updated security details in §5 to reflect isolated Hetzner infrastructure. Added Template D to pre-launch checklist. | Mike Carson / Claude |

---

## 11. Reference Materials

Key sources consulted in developing this document:
- Telephone Consumer Protection Act (TCPA) — 47 U.S.C. § 227
- FCC 2008 ACA International Ruling (prior express consent for debt collection)
- FCC 2025 Opt-Out Rule (any reasonable means of revocation)
- Fair Debt Collection Practices Act (FDCPA) — 15 U.S.C. § 1692 et seq. (confirms first-party exemption)
- Regulation F — 12 C.F.R. § 1006 (CFPB debt collection rule — third-party only)
- Washington Consumer Protection Act — RCW 19.86
- Washington HB 1497 / RCW 80.36.400 (WA mini-TCPA, eff. June 2022)
- Washington Commercial Electronic Mail Act (CEMA) — RCW 19.190
- CTIA Short Code Monitoring Handbook (carrier best practices)
- A2P 10DLC registration requirements (Campaign Registry)

---

*End of compliance reference.*
