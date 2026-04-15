# Carson Cars SMS Collections — Architecture Plan

**Owner:** Mike Carson
**Prepared by:** Jarvis / J2
**Date:** April 14, 2026
**Status:** APPROVED — 4 fixes applied per Mike + Claude review
**Spec version:** v1 (April 13, 2026 revised) + compliance companion

---

## Table of Contents

1. [Server — Fresh Hetzner CX22](#1-server--fresh-hetzner-cx22)
2. [Server Provisioning](#2-server-provisioning)
3. [Deployment Process](#3-deployment-process)
4. [UptimeRobot Monitoring](#4-uptimerobot-monitoring)
5. [Backup Process](#5-backup-process)
6. [Kill Switch](#6-kill-switch)
7. [Recovery Runbook](#7-recovery-runbook)
8. [Cloudflare Workers — pay.carsoncars.net](#8-cloudflare-workers--paycarsoncarsnet)
9. [Twilio Webhook Configuration](#9-twilio-webhook-configuration)
10. [DealPack Email Ingestion](#10-dealpack-email-ingestion)
11. [Monthly Cost Estimate](#11-monthly-cost-estimate)
12. [SSH Hardening](#12-ssh-hardening)
13. [Certbot / TLS Setup](#13-certbot--tls-setup)
14. [Critical Data Model Reference](#14-critical-data-model-reference)

---

## 1. Server — Fresh Hetzner CX22

**Decision:** Provision a **new, isolated CX22** on Mike's existing Hetzner account.

| Detail | Value |
|---|---|
| **Server** | Hetzner Cloud CX22 |
| **OS** | Ubuntu 24.04 LTS |
| **Resources** | 2 vCPU (shared), 4 GB RAM, 40 GB SSD |
| **Location** | Hillsboro, OR (us-west) — closest Hetzner datacenter to WA customers (~10-20ms latency vs ~70ms from East Coast) |
| **Cost** | ~€4.35/mo (~$4.75/mo) |
| **Hostname** | `carson-sms` |
| **DNS** | `sms.carsoncars.net` → server public IPv4 (Cloudflare DNS, proxy OFF — direct to origin for Twilio webhooks) |

**Why NOT existing servers:**

- **Helsinki box (204.168.149.236):** Too many shared services (Jarvis v1, Mission Control, OpenClaw data). Shared infrastructure = shared blast radius. A bad deploy or compromise on one service affects everything.
- **jarvis-j2 (204.168.210.199):** Not confirmed available. Even if available, same argument — SMS collections should be isolated from Jarvis/OpenClaw workloads. Collections handles PII (customer phones, addresses, payment data) and needs a clean security perimeter.

**Isolation principle:** This server runs ONE thing — the SMS collections app. No other services, no OpenClaw, no Jarvis, no shared databases.

---

## 2. Server Provisioning

### 2.1 Base OS Setup

```bash
# After Hetzner creates the CX22 with Ubuntu 24.04:
apt update && apt upgrade -y
apt install -y curl git ufw fail2ban sqlite3 nginx
timedatectl set-timezone America/Los_Angeles
hostnamectl set-hostname carson-sms
```

### 2.2 Dedicated System User

```bash
# Create a no-login, no-sudo system user to own the app process
useradd --system --no-create-home --shell /usr/sbin/nologin carson-sms
mkdir -p /opt/carson-sms
chown carson-sms:carson-sms /opt/carson-sms
```

The app runs as `carson-sms` user — cannot SSH in, cannot sudo, cannot escalate. If the Node.js process is compromised, the attacker is sandboxed to `/opt/carson-sms` with no shell access.

### 2.3 Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node --version  # Confirm v22.x
npm --version
```

### 2.4 SQLite3

```bash
sqlite3 --version  # Already installed above, confirm 3.45+
```

SQLite is the right choice: single-writer workload, <1 QPS average, <1000 rows in the main table. No need for Postgres overhead.

### 2.5 UFW Firewall

```bash
ufw default deny incoming
ufw default allow outgoing

# SSH — restrict to known IPs after setup
ufw allow 22/tcp

# HTTPS for Twilio webhooks + nginx
ufw allow 443/tcp

# HTTP for Let's Encrypt ACME challenge (certbot)
ufw allow 80/tcp

# Twilio webhook source IPs (Twilio's published ranges)
# Twilio sends webhooks from these CIDR blocks:
# See: https://www.twilio.com/docs/usage/network#ip-addresses
# No additional UFW rules needed — Twilio hits port 443,
# and signature validation (see §9) handles authentication.
# UFW allows 443 from all sources; Twilio signature validation
# is the real access control.

ufw enable
ufw status verbose
```

### 2.6 fail2ban

```bash
# fail2ban is installed above; enable default SSH jail
systemctl enable fail2ban
systemctl start fail2ban

# Verify SSH jail is active
fail2ban-client status sshd
```

Default config: 5 failed login attempts → 10-minute ban. Sufficient for SSH hardening alongside key-only auth (see §12).

---

## 3. Deployment Process

### 3.1 Code Origin

Code is developed and tested in J2's Kilo workspace (`/root/.openclaw/workspace/projects/sms-collections/`). This is the **source of truth** — no code lives permanently on the Hetzner box except what's deployed there.

### 3.2 Deploy via SCP

```bash
# From J2 workspace:
SCP_TARGET="root@<carson-sms-ip>"

# Deploy application code (excludes data, node_modules, .env)
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude 'data/' \
  --exclude '.env' \
  --exclude '*.db' \
  /root/.openclaw/workspace/projects/sms-collections/ \
  ${SCP_TARGET}:/opt/carson-sms/

# On the Hetzner box: install deps and set ownership
ssh ${SCP_TARGET} "cd /opt/carson-sms && npm ci --production && chown -R carson-sms:carson-sms /opt/carson-sms"
```

### 3.3 systemd Service

```ini
# /etc/systemd/system/carson-sms.service
[Unit]
Description=Carson Cars SMS Collections
After=network.target

[Service]
Type=simple
User=carson-sms
Group=carson-sms
WorkingDirectory=/opt/carson-sms
ExecStart=/usr/bin/node /opt/carson-sms/src/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=carson-sms

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/carson-sms/data
PrivateTmp=true

# Environment
EnvironmentFile=/opt/carson-sms/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable carson-sms
systemctl start carson-sms
systemctl status carson-sms
```

### 3.4 Config Auto-Reload

The application watches config files (`templates/messages.json`, `config/pacing.json`, `config/sender.json`, `config/exclusions.json`, `config/auth.json`, `config/ai_prompt.md`) using Node.js `fs.watch()`. When a config file changes:

1. File change detected
2. New config loaded and validated in memory
3. If valid → hot-swap into running state (no restart)
4. If invalid → log error, keep previous config, alert to Telegram

**Config changes that DON'T require restart:**
- Template text edits
- Pacing changes (window, rate, cap)
- Exclusion list updates
- AI prompt changes
- Auth list updates

**Config changes that DO require restart:**
- `.env` changes (Twilio creds, API keys, DB path)
- Core application code changes (new deploy)

### 3.5 Deploy Checklist (every deploy)

1. `rsync` code to server
2. `npm ci --production` on server
3. `systemctl restart carson-sms`
4. Check `journalctl -u carson-sms -f` for startup errors
5. Hit health endpoint: `curl https://sms.carsoncars.net/health`
6. Verify Telegram bot responds to a test command

---

## 4. UptimeRobot Monitoring

**Tier:** Free (50 monitors, 5-minute intervals)

### 4.1 Monitors

| Monitor | Type | URL / Target | Check Interval | Alert Threshold |
|---|---|---|---|---|
| SMS Collections Health | HTTP(s) | `https://sms.carsoncars.net/health` | 5 min | 2 consecutive failures |
| Payment Link Worker | HTTP(s) | `https://pay.carsoncars.net/health` | 5 min | 2 consecutive failures |
| Webhook Endpoint | HTTP(s) | `https://sms.carsoncars.net/webhook/status` (expects 405 for GET) | 5 min | 2 consecutive failures |
| Server Ping | Ping | `<carson-sms-ip>` | 5 min | 3 consecutive failures |

### 4.2 Health Endpoint Response

```json
{
  "status": "ok",
  "uptime": 86400,
  "db": "connected",
  "twilio": "configured",
  "paused": false,
  "lastSend": "2026-04-14T18:45:00Z",
  "queueSize": 42
}
```

Returns HTTP 200 when healthy, HTTP 503 if DB connection fails or critical config is missing.

### 4.3 Alert Routing

- **Telegram:** Alerts sent to Mike's Telegram via UptimeRobot's Telegram integration
- **Email:** Alerts sent to mike@carsoncars.net
- **Alert types:** Down, up (recovery), SSL expiry warning (30 days)

### 4.4 Setup Steps

1. Create UptimeRobot account (free tier)
2. Add Telegram alert contact (UptimeRobot bot → Mike's Telegram)
3. Add email alert contact (mike@carsoncars.net)
4. Create 4 monitors per table above
5. Test by temporarily stopping the service: `systemctl stop carson-sms` → confirm alert fires within 10 minutes → restart

---

## 5. Backup Process

### 5.1 Backup Target

**Hetzner BX11 Storage Box** on Mike's Hetzner account.

| Detail | Value |
|---|---|
| **Product** | BX11 (1 TB, RAID-backed) |
| **Cost** | ~€3.54/mo (~$3.85/mo) |
| **Access** | SFTP / rsync over SSH |
| **Location** | Falkenstein, DE (separate datacenter from the CX22) |

**Why NOT Kilo:** Kilo instances are ephemeral — volumes can be recreated or migrated. Not suitable for critical backup storage.

**Why NOT Helsinki box:** Task explicitly requires separation. Helsinki has too many shared services.

### 5.2 Daily Backup Script

```bash
#!/bin/bash
# /opt/carson-sms/scripts/backup.sh
# Runs daily at 5:00 AM PT (after send window closes, before next day's ingest)

set -euo pipefail

BACKUP_DIR="/opt/carson-sms/data/backups"
DB_PATH="/opt/carson-sms/data/sms-collections.db"
DATE=$(date +%Y-%m-%d)
BACKUP_FILE="${BACKUP_DIR}/sms-collections-${DATE}.db"
STORAGE_BOX="u_XXXXXX@u_XXXXXX.your-storagebox.de"  # Hetzner BX11 credentials
REMOTE_DIR="/carson-sms-backups"

mkdir -p "${BACKUP_DIR}"

# Step 1: Safe SQLite backup (no lock, uses SQLite's .backup API)
sqlite3 "${DB_PATH}" ".backup '${BACKUP_FILE}'"

# Step 2: Verify backup integrity
INTEGRITY=$(sqlite3 "${BACKUP_FILE}" "PRAGMA integrity_check;")
if [ "${INTEGRITY}" != "ok" ]; then
  echo "BACKUP INTEGRITY FAILED: ${INTEGRITY}" >&2
  # Alert to Telegram via curl (webhook to bot)
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHANNEL_ID}" \
    -d "text=🚨 BACKUP INTEGRITY FAILED for ${DATE}. Manual intervention required."
  exit 1
fi

# Step 3: Compress
gzip -c "${BACKUP_FILE}" > "${BACKUP_FILE}.gz"
rm "${BACKUP_FILE}"

# Step 4: rsync to Hetzner Storage Box
rsync -avz -e "ssh -p 23" "${BACKUP_FILE}.gz" "${STORAGE_BOX}:${REMOTE_DIR}/"

# Step 5: Local retention — keep 90 days
find "${BACKUP_DIR}" -name "*.db.gz" -mtime +90 -delete

# Step 6: Log success
echo "[$(date)] Backup completed: ${BACKUP_FILE}.gz ($(du -h "${BACKUP_FILE}.gz" | cut -f1))"
```

### 5.3 Cron Schedule

```bash
# /etc/cron.d/carson-sms-backup
0 12 * * * root /opt/carson-sms/scripts/backup.sh >> /var/log/carson-sms-backup.log 2>&1
# 12:00 UTC = 5:00 AM PT
```

### 5.4 Restore Procedure (TESTED)

**Scenario:** Total data loss on the CX22 — DB file is gone or corrupted.

```bash
# Step 1: Stop the service
systemctl stop carson-sms

# Step 2: Download latest backup from Storage Box
STORAGE_BOX="u_XXXXXX@u_XXXXXX.your-storagebox.de"
LATEST=$(ssh -p 23 "${STORAGE_BOX}" "ls -t /carson-sms-backups/*.db.gz | head -1")
rsync -avz -e "ssh -p 23" "${STORAGE_BOX}:${LATEST}" /tmp/restore.db.gz

# Step 3: Decompress
gunzip /tmp/restore.db.gz

# Step 4: Verify integrity before replacing
INTEGRITY=$(sqlite3 /tmp/restore.db "PRAGMA integrity_check;")
echo "Integrity check: ${INTEGRITY}"
# MUST output "ok" before proceeding

# Step 5: Replace the database
mv /opt/carson-sms/data/sms-collections.db /opt/carson-sms/data/sms-collections.db.corrupted 2>/dev/null || true
mv /tmp/restore.db /opt/carson-sms/data/sms-collections.db
chown carson-sms:carson-sms /opt/carson-sms/data/sms-collections.db

# Step 6: Restart service (in PAUSED state)
systemctl start carson-sms

# Step 7: System auto-PAUSES after restore and posts Telegram alert:
# "⚠️ System restored from backup dated [X]. Review pending PTPs
#  or opt-outs from the last 24 hours via Twilio logs before RESUME.
#  No sends will occur until a human explicitly types RESUME."
# Rationale: backup restore may lose last 24h of opt-outs/replies.
# Don't risk re-texting someone who opted out during that window.

# Step 8: Human reviews Twilio logs for any opt-outs/replies since backup
# Step 9: Human types RESUME in Telegram when satisfied

# Step 10: Verify
curl https://sms.carsoncars.net/health
journalctl -u carson-sms --since "1 minute ago"
```

**Expected timing:**
- Download from Storage Box: ~10 seconds (DB will be <10 MB for 288 accounts)
- Decompress + integrity check: ~2 seconds
- Service restart: ~3 seconds
- **Total restore time: under 1 minute** (plus SSH login time)

**Maximum data loss:** Up to 24 hours (last backup to failure). Mitigated by the fact that the daily DealPack import re-populates customer data, and Twilio retains message logs independently.

### 5.5 Backup Verification (Monthly)

On the first Monday of each month, J2 performs a test restore to a temp directory on the CX22:

```bash
# Test restore (non-destructive — does NOT replace live DB)
mkdir -p /tmp/backup-test
rsync -avz -e "ssh -p 23" "${STORAGE_BOX}:$(ssh -p 23 ${STORAGE_BOX} 'ls -t /carson-sms-backups/*.db.gz | head -1')" /tmp/backup-test/
gunzip /tmp/backup-test/*.db.gz
sqlite3 /tmp/backup-test/*.db "PRAGMA integrity_check; SELECT count(*) FROM customers;"
rm -rf /tmp/backup-test
```

Result posted to Telegram channel. If integrity check fails, immediate investigation.

---

## 6. Kill Switch

Three independent layers, any one of which can halt outbound sending:

### Layer 1: Telegram PAUSE / RESUME

```
Authorized user sends: PAUSE
Bot responds: ⏸️ SMS sending PAUSED by [user]. Inbound replies still being received.

Authorized user sends: RESUME
Bot responds: ▶️ SMS sending RESUMED by [user]. Queue processing will begin at next send window.
```

**Authorized users:** Mike Carson, Jessica V, Evelyn (identified by Telegram user ID in `config/auth.json`).

**What PAUSE does:**
- Halts all outbound Template A, B, D sends immediately
- Inbound replies are still received, classified, and posted to Telegram for review
- STOP opt-outs are still processed and confirmations sent
- Click tracking still works (Cloudflare Worker is independent)
- Daily morning report still generates
- State persisted to `config/runtime-state.json` (survives restart)

**What PAUSE does NOT do:**
- Does not disconnect from Twilio
- Does not stop the Node.js process
- Does not affect the Cloudflare Worker

### Layer 2: Config File Flag (SSH)

```bash
# SSH to the server and set the paused flag directly:
ssh root@<carson-sms-ip> "jq '.paused = true' /opt/carson-sms/config/runtime-state.json > /tmp/state.json && mv /tmp/state.json /opt/carson-sms/config/runtime-state.json && chown carson-sms:carson-sms /opt/carson-sms/config/runtime-state.json"
```

The app's config auto-reload (see §3.4) picks up the change within seconds. Same effect as Telegram PAUSE.

### Layer 3: systemctl stop (Nuclear)

```bash
ssh root@<carson-sms-ip> "systemctl stop carson-sms"
```

Stops everything — no inbound processing, no click webhook receipt, no Telegram bot. Use only if the app itself is misbehaving (infinite loop, memory leak, runaway sends).

### Auto-Pause Triggers

The system automatically pauses outbound sending (equivalent to Layer 1 PAUSE) and alerts the Telegram channel when:

| Trigger | Condition | Alert Message |
|---|---|---|
| **High Twilio error rate** | >30% of sends in the last 1 hour received error status | 🚨 AUTO-PAUSED: Twilio error rate exceeded 30% in the last hour. [X/Y sends failed]. Investigate before resuming. |
| **Consecutive failures** | 5+ consecutive Twilio send failures (whichever hits first vs the 30% rule) | 🚨 AUTO-PAUSED: 5 consecutive Twilio send failures. Last error: [error_code]. Investigate before resuming. |
| **Opt-out spike** | >10% opt-out rate in a single calendar day (opt-outs / sends) | 🚨 AUTO-PAUSED: Opt-out rate exceeded 10% today ([X opt-outs / Y sends]). Review templates and customer list before resuming. |

Auto-pause requires **manual RESUME** — it does not auto-recover. This is intentional: auto-pause means something is wrong, and a human should investigate before resuming.

---

## 7. Recovery Runbook

**Scenario:** It's 2:00 PM Saturday. Mike gets an UptimeRobot alert that the SMS system is down.

**Important context:** No SMS sends happen on weekends (Mon-Fri only, 11 AM – 4 PM PT). The urgency is lower than it would be on a Tuesday, but the system should still be healthy for:
- Inbound replies from customers who text back on the weekend
- Click tracking (Cloudflare Worker is independent — unaffected by server downtime)
- Monday morning report generation (7:30 AM PT)

### Scenario A: Service Crashed (Server Still Reachable)

```bash
# 1. SSH into the server
ssh root@<carson-sms-ip>

# 2. Check service status
systemctl status carson-sms

# 3. Check recent logs for crash reason
journalctl -u carson-sms --since "1 hour ago" --no-pager

# 4. Restart the service
systemctl restart carson-sms

# 5. Verify health
curl https://sms.carsoncars.net/health

# 6. Watch logs for 30 seconds to confirm stability
journalctl -u carson-sms -f
# Ctrl+C after 30 seconds of clean output
```

**Expected resolution time:** 2-5 minutes.

### Scenario B: Server Unreachable (SSH Timeout)

```bash
# 1. Log into Hetzner Cloud Console
#    https://console.hetzner.cloud → select "carson-sms" server

# 2. Check server status in Hetzner dashboard
#    If status shows "Running" but SSH is dead → kernel panic or network issue

# 3. Hard reboot via Hetzner console
#    Dashboard → Power → Reset (hard reboot)
#    OR via Hetzner CLI:
hcloud server reboot carson-sms

# 4. Wait 60 seconds, then SSH in
ssh root@<carson-sms-ip>

# 5. Check service auto-started (systemd enabled)
systemctl status carson-sms

# 6. If not running, start manually
systemctl start carson-sms

# 7. Investigate root cause
journalctl --since "2 hours ago" | grep -i "error\|oom\|panic\|killed"
dmesg | tail -50
```

**Expected resolution time:** 3-5 minutes.

### Scenario C: Total Data Loss (DB Corrupted or Deleted)

```bash
# 1. Stop the service
systemctl stop carson-sms

# 2. Follow restore procedure from §5.4 (exact commands there)
#    Download latest backup from BX11 Storage Box
#    Decompress, integrity check, replace DB, restart

# 3. After restore: run today's DealPack import manually
#    (if the daily 10:30 AM import was missed due to downtime)
#    Trigger via Telegram fallback button or:
ssh root@<carson-sms-ip> "cd /opt/carson-sms && node src/ingest.js --manual"

# 4. Verify customer count and state
ssh root@<carson-sms-ip> "sqlite3 /opt/carson-sms/data/sms-collections.db 'SELECT customer_state, count(*) FROM customers GROUP BY customer_state;'"
```

**Expected resolution time:** 5-10 minutes (mostly download time).

### Scenario D: Hetzner Server Completely Gone (Destroyed)

```bash
# 1. Provision new CX22 via Hetzner Cloud Console
#    Follow §2 provisioning steps (Ubuntu 24.04, Node.js, etc.)

# 2. Deploy application code from J2
#    Follow §3.2 deploy via rsync

# 3. Restore database from BX11 Storage Box
#    Follow §5.4 restore procedure

# 4. Update DNS if IP changed
#    Cloudflare → sms.carsoncars.net → new IP

# 5. Re-run certbot for new TLS cert
#    Follow §13

# 6. Update UptimeRobot monitors with new IP

# 7. Verify end-to-end
```

**Expected resolution time:** 30-60 minutes (mostly provisioning + certbot DNS propagation).

**Weekend-specific note:** If the server is down Saturday, and Scenarios A or B don't work, it's acceptable to schedule Scenario C or D for Sunday evening — before Monday's 10:30 AM DealPack import. No sends are missed on weekends.

---

## 8. Cloudflare Workers — pay.carsoncars.net

### 8.1 Architecture

```
Customer taps link in SMS
    → pay.carsoncars.net/35668
    → Cloudflare Worker (edge, free tier)
    → Worker POSTs click data to sms.carsoncars.net/api/click-log
    → Worker 302 redirects customer to eAutoPayment registration
```

### 8.2 DNS Setup (Mike — in Cloudflare Dashboard)

1. Go to Cloudflare → carsoncars.net → DNS
2. Add CNAME record: `pay` → points to the Workers route (Cloudflare auto-handles this when you assign a custom domain to a Worker)
3. Alternatively, add a Worker Route: `pay.carsoncars.net/*`

### 8.3 Worker Code

```javascript
// pay.carsoncars.net Cloudflare Worker
const EAUTOPAYMENT_URL = 'https://www.eautopayment.com/Registration?merchantAccountId=1503-2413-1611';
const CLICK_LOG_WEBHOOK = 'https://sms.carsoncars.net/api/click-log';
const WEBHOOK_SECRET = '{{CLICK_LOG_SECRET}}'; // Shared secret for webhook auth

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check for UptimeRobot
    if (path === '/health') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Extract account number from path: /35668 or /pay/35668
    const accountMatch = path.match(/\/(\d{3,10})$/);
    if (!accountMatch) {
      return Response.redirect('https://carsoncars.net', 302);
    }

    const accountNumber = accountMatch[1];

    // Fire-and-forget: log the click to main app
    // Uses waitUntil to not block the redirect
    const clickData = {
      account_number: accountNumber,
      clicked_at: new Date().toISOString(),
      ip_address: request.headers.get('CF-Connecting-IP') || 'unknown',
      user_agent: request.headers.get('User-Agent') || 'unknown',
      referrer: request.headers.get('Referer') || 'none'
    };

    const logPromise = fetch(CLICK_LOG_WEBHOOK, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': WEBHOOK_SECRET
      },
      body: JSON.stringify(clickData)
    }).catch(err => {
      // Log failure but don't block redirect
      console.error('Click log failed:', err.message);
    });

    // Don't await — let it complete in background
    if (request.cf) {
      // Cloudflare Workers environment
      // waitUntil keeps the worker alive to complete the log POST
      // after the response is sent
    }

    // 302 redirect to eAutoPayment
    // Note: eAutoPayment does NOT support account-level prefill
    // Customer must complete 6-field registration manually
    return Response.redirect(EAUTOPAYMENT_URL, 302);
  }
};
```

### 8.4 Click Log Webhook Endpoint (Main App Side)

On the Hetzner SMS collections server, `/api/click-log` receives the POST from the Cloudflare Worker:

1. Validate `X-Webhook-Secret` header matches shared secret
2. Validate `account_number` exists in customers table
3. Insert into `click_log` table: `(account_number, clicked_at, ip_address, user_agent, referrer)`
4. Return 200 OK

### 8.5 24-Hour Click Guardrail

The daily scheduler (11 AM PT) checks the `click_log` table before queuing any customer for a send:

```sql
-- Exclude customers who clicked in the last 24 hours
SELECT DISTINCT account_number
FROM click_log
WHERE clicked_at > datetime('now', '-24 hours');
```

**Logic:** If a customer clicked the payment link in the last 24 hours, they may be in the process of paying. Don't send them another text while they might be mid-payment. This prevents the bad experience of "I'm trying to pay you and you're still texting me."

These customers appear in the "Excluded today" section of the morning report with reason `recent_click`.

### 8.6 Cloudflare Workers Limits (Free Tier)

| Limit | Free Tier | Our Usage |
|---|---|---|
| Requests/day | 100,000 | ~60-120 (payment link clicks) |
| CPU time/request | 10ms | <1ms (redirect + fetch) |
| Workers | 100 | 1 |

We are at <0.1% of free tier limits. No paid plan needed.

---

## 9. Twilio Webhook Configuration

### 9.1 Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `https://sms.carsoncars.net/webhook/inbound` | POST | Customer replies to 425-696-8488 |
| `https://sms.carsoncars.net/webhook/status` | POST | Delivery status callbacks (sent, delivered, failed, undelivered) |

### 9.2 Twilio Console Configuration

1. Log into Twilio Console → Phone Numbers → 425-696-8488
2. Under **Messaging**:
   - "A message comes in" → Webhook → `https://sms.carsoncars.net/webhook/inbound` → HTTP POST
   - "Status callback URL" → `https://sms.carsoncars.net/webhook/status` → HTTP POST

### 9.3 Twilio Signature Validation

**Every inbound request** is validated using Twilio's `X-Twilio-Signature` header before processing. This prevents spoofed webhooks.

```javascript
const twilio = require('twilio');

function validateTwilioRequest(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioSignature = req.headers['x-twilio-signature'];
  const url = `https://sms.carsoncars.net${req.originalUrl}`;
  const params = req.body;

  return twilio.validateRequest(authToken, twilioSignature, url, params);
}

// Middleware: reject unsigned requests
app.use('/webhook/*', (req, res, next) => {
  if (!validateTwilioRequest(req)) {
    console.warn('Invalid Twilio signature from:', req.ip);
    return res.status(403).send('Forbidden');
  }
  next();
});
```

### 9.4 Inbound Reply Flow (`/webhook/inbound`)

1. Receive POST from Twilio (fields: `From`, `Body`, `MessageSid`, etc.)
2. Validate Twilio signature
3. Look up customer by phone number (E.164 match)
4. If unknown number → log and ignore (no response)
5. Check for STOP / opt-out keywords → auto-process, send confirmation, terminal state
6. Otherwise → pass to Claude Haiku for intent classification + draft reply
7. Post draft to "Carson Cars Collections" Telegram channel with inline buttons
8. Transition customer to `IN_CONVERSATION` state if not already

### 9.5 Status Callback Flow (`/webhook/status`)

1. Receive POST from Twilio (fields: `MessageSid`, `MessageStatus`, `ErrorCode`, etc.)
2. Validate Twilio signature
3. Update `send_log.delivery_status` and `send_log.delivered_at` for the matching SID
4. If status is `failed` or `undelivered`:
   - Log error code
   - Increment failure counter for auto-pause logic (see §6)
   - If error code indicates invalid number (30003, 30005, 30006) → flag customer record

### 9.6 Rate Limiting

Nginx rate limiting on webhook endpoints to prevent abuse:

```nginx
# In nginx.conf http block
limit_req_zone $binary_remote_addr zone=webhooks:10m rate=30r/s;

# In server block
location /webhook/ {
    limit_req zone=webhooks burst=50 nodelay;
    proxy_pass http://127.0.0.1:3000;
    # ... proxy headers
}
```

This allows 30 requests/second sustained with bursts up to 50 — far above our expected load (a few per minute) but protects against abuse.

### 9.7 TLS

All webhook traffic over HTTPS with Let's Encrypt certificate on `sms.carsoncars.net`. See §13 for certbot setup.

---

## 10. DealPack Email Ingestion

### 10.1 Primary Path: Auto-Email at 10:30 AM

**DealPack configuration (Mike/Jessica):**
1. Create a saved report in DealPack with the required fields (see spec §4)
2. Schedule the report to auto-email at **10:30 AM PT daily** to a system inbox

**System inbox options (in order of preference):**

**Option A — Dedicated Gmail inbox:**
- Create `sms-collections@carsoncars.net` (Google Workspace) or use a dedicated Gmail
- App polls inbox via IMAP every 5 minutes starting at 10:25 AM PT
- When email with attachment arrives: download attachment, run ingest pipeline, archive email

**Option B — Direct IMAP to existing inbox:**
- Use a subfolder of an existing Carson Cars email
- App monitors a specific folder/label for DealPack reports

### 10.2 Ingest Pipeline

1. **Detect file type:** .xlsx or .csv (DealPack can export both)
2. **Parse file:** Read first sheet (xlsx) or full file (csv)
3. **Clean phone numbers:**
   - Strip Excel scientific notation artifacts (e.g., `4.2555E+09`)
   - Remove trailing `.0`
   - Normalize to E.164: `+1XXXXXXXXXX`
   - Reject anything that doesn't resolve to a valid 10-digit US number
4. **Resolve display name:**
   - If `Nickname` populated → use `Nickname`
   - Else if `Customer First Name` populated → use `Customer First Name`
   - Else parse first name from `Primary Name` (Last First Middle format)
5. **Apply exclusions:** Re-verify all DealPack status flags (belt and suspenders — DealPack filters first, system re-checks)
6. **Upsert customers:** Update existing records by `account_number` (= StockNbr), insert new
7. **Update state machine:**
   - Customer drops off the past-due export → payment posted → mark resolved
   - Customer reappears on export → re-enter state machine as `NEW` if previously resolved
   - Existing state machine positions preserved for in-flight conversations
8. **Archive file:** Move processed file to `data/imports/archive/YYYY-MM-DD_filename.xlsx`
9. **Log results:** Post summary to Telegram: `📥 DealPack import complete: X updated, Y new, Z excluded, W errors`

### 10.3 Fallback: Jessica Triggers via Telegram

If the auto-email fails (DealPack glitch, email delivery issue):

1. Jessica taps a "📤 Manual Import" button in the Telegram channel
2. Bot responds: "Upload the DealPack export file here"
3. Jessica uploads the .xlsx/.csv to the Telegram chat
4. Bot downloads the file and runs the same ingest pipeline
5. Results posted to channel

This is a fallback — the auto-email is the primary path and should work without human intervention on normal days.

### 10.4 Import Timing in Relation to Send Window

```
10:30 AM PT  — DealPack auto-email sent
10:30-10:35  — Email arrives in system inbox
10:35-10:45  — Ingest pipeline runs (parse, clean, upsert, state update)
10:45-11:00  — Buffer for edge cases, manual Jessica payments applied at 10:30
11:00 AM PT  — Send window opens, queue built from freshly imported data
```

The 30-minute buffer between DealPack export (10:30 AM) and send window open (11:00 AM) ensures the queue reflects current reality — including any morning payments Jessica processes between her 8 AM arrival and the 10:30 export.

---

## 11. Monthly Cost Estimate

### 11.1 Twilio Outbound SMS

| Parameter | Value |
|---|---|
| Sends per day | ~60 (cap) |
| Business days per month | ~20 |
| Total sends/month | ~1,200 |
| Cost per outbound SMS (A2P 10DLC) | ~$0.0079/segment |
| A2P 10DLC per-message fee | ~$0.005/message |
| **Outbound total** | **~$15.48/mo** |

### 11.2 Twilio Inbound SMS

| Parameter | Value |
|---|---|
| Expected reply rate | 15-25% (est. 20%) |
| Replies/month | ~240 |
| Cost per inbound SMS | ~$0.0079/segment |
| Auto-replies (opt-out confirms + holding) | ~50 |
| **Inbound total** | **~$2.29/mo** |

### 11.3 Twilio Phone Number

| Parameter | Value |
|---|---|
| 425-696-8488 (existing local number) | ~$1.15/mo |

### 11.4 Claude Haiku (via Anthropic API)

| Parameter | Value |
|---|---|
| Inbound replies to classify + draft | ~240/mo |
| Avg input tokens per call | ~1,500 (profile + history + prompt) |
| Avg output tokens per call | ~300 (intent + draft) |
| Haiku input cost | $0.25/M tokens |
| Haiku output cost | $1.25/M tokens |
| Monthly input tokens | ~360K |
| Monthly output tokens | ~72K |
| **Haiku total** | **~$0.18/mo** |

### 11.5 Infrastructure

| Item | Cost |
|---|---|
| Hetzner CX22 (2 vCPU, 4 GB RAM, 40 GB SSD) | ~€4.35/mo (~$4.75) |
| Hetzner BX11 Storage Box (1 TB, backup target) | ~€3.54/mo (~$3.85) |
| Cloudflare Workers (free tier) | $0.00 |
| UptimeRobot (free tier) | $0.00 |
| Let's Encrypt (free) | $0.00 |
| Domain (carsoncars.net — already owned) | $0.00 |

### 11.6 Total Monthly Cost

| Category | Monthly Cost |
|---|---|
| Twilio (outbound + inbound + number) | ~$18.92 |
| Claude Haiku | ~$0.18 |
| Hetzner CX22 | ~$4.75 |
| Hetzner BX11 Storage Box | ~$3.85 |
| Cloudflare Workers | $0.00 |
| UptimeRobot | $0.00 |
| Let's Encrypt | $0.00 |
| A2P 10DLC brand + campaign fees | ~$12.00 |
| Google Workspace mailbox (if new inbox needed for DealPack ingest) | ~$6-12.00 |
| **TOTAL** | **~$46-52/mo** |

**Note on A2P 10DLC:** Brand registration is a one-time fee ($4) but campaign fees are recurring (~$10-15/mo depending on use case). 425-696-8488 is already vetted but campaign registration may have monthly fees.

**Note on Gmail/Workspace:** If DealPack auto-email needs a dedicated inbox (e.g., ar-import@carsoncars.net), Mike's M365 Exchange plan may already cover it. If we use a Gmail inbox instead, Workspace is ~$6-12/mo. Mike to confirm which is cheaper.

**Realistic range: $30-50/mo** depending on mailbox choice and A2P fees.

**Compared to:** The ~$1,500/mo call review service this replaces (different function but same budget line). SMS collections adds a new collection channel at <3.5% of that cost.

**Cost at scale:** If the system expands to the full 500-account portfolio or adds insurance outreach (v2), Twilio costs scale linearly. At 120 sends/day (doubled), total would be ~$60-70/mo. Still trivial.

---

## 12. SSH Hardening

### 12.1 Initial Setup (During Provisioning)

When Hetzner creates the CX22, it sets up root with password auth. Immediately after first login:

```bash
# Step 1: Generate SSH key pair on J2 (if not already done)
ssh-keygen -t ed25519 -C "j2-carson-sms" -f ~/.ssh/carson-sms

# Step 2: Copy public key to the new server
ssh-copy-id -i ~/.ssh/carson-sms.pub root@<carson-sms-ip>

# Step 3: Test key-based login (in a NEW terminal — keep the current session open!)
ssh -i ~/.ssh/carson-sms root@<carson-sms-ip> "echo 'Key auth works'"
# Must output: Key auth works
```

### 12.2 Disable Password Auth

**CRITICAL: Do this ONLY after confirming key auth works in Step 3 above. If you disable password auth without working key auth, you are locked out.**

```bash
# Step 4: On the server, edit sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?KbdInteractiveAuthentication.*/KbdInteractiveAuthentication no/' /etc/ssh/sshd_config
# NOTE: Leave UsePAM yes — disabling it breaks other system services.
# The key change is PasswordAuthentication=no which prevents password login.

# Step 5: Also disable root password login specifically (key only)
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config

# Step 6: Restart sshd
systemctl restart sshd

# Step 7: Verify (from J2, in a NEW terminal — keep current session open!)
ssh -i ~/.ssh/carson-sms root@<carson-sms-ip> "echo 'Key-only auth confirmed'"
# Must output: Key-only auth confirmed

# Step 8: Verify password auth is rejected
ssh -o PasswordAuthentication=yes -o PubkeyAuthentication=no root@<carson-sms-ip>
# Must be rejected: Permission denied (publickey)
```

### 12.3 Additional Hardening

```bash
# Add Mike's SSH key too (if he needs direct access)
# Mike provides his public key → append to /root/.ssh/authorized_keys

# Optional: Change SSH port (reduces noise, not security)
# sed -i 's/^#\?Port.*/Port 2222/' /etc/ssh/sshd_config
# ufw allow 2222/tcp
# ufw delete allow 22/tcp
# systemctl restart sshd
```

---

## 13. Certbot / TLS Setup

### 13.1 Prerequisites

- `sms.carsoncars.net` DNS A record pointing to the CX22's public IP (Cloudflare DNS, **proxy OFF** — orange cloud off, grey cloud on — so Let's Encrypt and Twilio can reach the origin directly)
- Nginx installed (done in §2.1)
- Ports 80 and 443 open (done in §2.5)

### 13.2 Install Certbot

```bash
apt install -y certbot python3-certbot-nginx
```

### 13.3 Nginx Base Config (Pre-Cert)

```nginx
# /etc/nginx/sites-available/carson-sms
server {
    listen 80;
    server_name sms.carsoncars.net;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/carson-sms /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

### 13.4 Obtain Certificate

```bash
certbot --nginx -d sms.carsoncars.net \
  --non-interactive \
  --agree-tos \
  --email mike@carsoncars.net \
  --redirect
```

This command:
1. Obtains a Let's Encrypt certificate for `sms.carsoncars.net`
2. Automatically updates the nginx config to serve HTTPS
3. Adds HTTP → HTTPS redirect
4. Registers with email for expiry notices

### 13.5 Verify

```bash
# Check certificate
curl -vI https://sms.carsoncars.net/health 2>&1 | grep "SSL certificate"

# Check nginx config was updated
cat /etc/nginx/sites-available/carson-sms
# Should now show listen 443 ssl, certificate paths, and redirect block
```

### 13.6 Auto-Renewal

Certbot installs a systemd timer for auto-renewal by default on Ubuntu 24.04:

```bash
# Verify auto-renewal timer is active
systemctl status certbot.timer

# Test renewal (dry run)
certbot renew --dry-run
```

The timer runs twice daily and renews certificates within 30 days of expiry. Let's Encrypt certs are valid for 90 days, so renewal happens around the 60-day mark.

### 13.7 Final Nginx Config (Post-Cert)

After certbot modifies the config, it should look approximately like:

```nginx
# /etc/nginx/sites-available/carson-sms (after certbot)
server {
    listen 80;
    server_name sms.carsoncars.net;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl;
    server_name sms.carsoncars.net;

    ssl_certificate /etc/letsencrypt/live/sms.carsoncars.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sms.carsoncars.net/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Rate limiting for webhook endpoints
    limit_req_zone $binary_remote_addr zone=webhooks:10m rate=30r/s;

    location /webhook/ {
        limit_req zone=webhooks burst=50 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Note:** The `limit_req_zone` directive must be in the `http` block of `/etc/nginx/nginx.conf`, not in the server block. Move it there after certbot runs.

---

## 14. Critical Data Model Reference

These items are called out explicitly because they deviate from or clarify the spec in ways that affect implementation.

### 14.1 Customer State Machine (5 States + Terminal)

```
                          ┌─────────┐
                          │   NEW   │
                          └────┬────┘
                               │ Template A sent
                               ▼
                          ┌──────────┐
                    ┌─────│  TEXTED  │─────┐
                    │     └────┬─────┘     │
                    │          │            │
            7+ days,│     Any reply    STOP/opt-out
            no reply│    (non-STOP)        │
            no pay  │          │            ▼
                    │          ▼       ┌──────────┐
            Template B   ┌────────────┐│OPTED_OUT │
            sent, stay   │IN_CONVER-  ││(terminal)│
            TEXTED       │SATION      │└──────────┘
                         └─────┬──────┘     ▲
                               │            │
                    PTP made   │     STOP from any state
                               ▼
                         ┌───────────┐
                         │ PROMISE_  │
                         │ PENDING   │
                         └─────┬─────┘
                               │
                    promised_date +
                    1 biz day, no payment
                               │
                               ▼
                         ┌───────────┐
                         │ BROKEN_   │──── Reply → IN_CONVERSATION
                         │ PROMISE   │
                         └───────────┘
                         Template D sent
```

**States where scheduler sends messages:** `NEW`, `TEXTED` (follow-up after 7 days), `BROKEN_PROMISE`

**States where auto-sends are paused:** `IN_CONVERSATION`, `PROMISE_PENDING`

### 14.2 Template D — Broken Promise (1-Business-Day Grace)

When a `payment_commitments` row has `promised_date` that has passed:

1. Wait **1 business day** after `promised_date` (not calendar day — skip weekends and holidays)
2. Check next DealPack import to verify payment did NOT post
3. If no payment → transition customer to `BROKEN_PROMISE`, queue Template D
4. Template D references the specific promised date: *"looks like the payment you mentioned for [PromisedDate]..."*

**Grace period logic:**
```
promised_date = Friday → check Tuesday (skip Sat/Sun)
promised_date = Thursday → check Friday
promised_date = Wednesday before Thanksgiving → check following Monday
```

### 14.3 click_log 24-Hour Guardrail

Before the scheduler queues ANY customer for sending:

```sql
SELECT account_number FROM click_log
WHERE clicked_at > datetime('now', '-24 hours');
```

Customers in this result set are **excluded from the send queue** for this cycle. They appear in the morning report under "Excluded today: recent click" and in the "🔥 CALL FIRST" section if they clicked but no payment posted.

**Why:** If someone clicked the payment link, they might be mid-payment or attempted and hit a snag. Texting them again within 24 hours feels pushy and wastes a send slot.

### 14.4 called_log Table — "Mark as Called" Suppression

When Jessica taps "📞 Mark as Called" on a hot lead in the Telegram morning report:

1. Record inserted into `called_log`: `(account_number, called_by, called_at)`
2. That customer is suppressed from the "🔥 CALL FIRST" section for **5 business days**
3. The customer is NOT suppressed from SMS sends — only from the call-first list

**Query for call-first exclusion:**
```sql
SELECT account_number FROM called_log
WHERE called_at > datetime('now', '-7 days')  -- 7 calendar days ≈ 5 business days
```

### 14.5 Nickname Precedence

Display name resolution order:
1. `Nickname` (if populated in DealPack) → **use this**
2. `Customer First Name` → fallback
3. Parse from `Primary Name` (Last First Middle format) → last resort

**Why:** Many Carson Cars customers go by nicknames. "Bobby" doesn't want to get a text addressed to "Robert." DealPack tracks this — we use it.

### 14.6 Send Window: 11 AM – 4 PM PT

- **NOT 10 AM.** The spec explicitly moved the window start from 10 AM to 11 AM.
- **Reason:** DealPack exports at 10:30 AM. The system needs 30 minutes to ingest and process. Sending at 10 AM would use stale data from yesterday's export.
- The compliance document references 10 AM in §4.2 — this is superseded by the spec's 11 AM start time.

### 14.7 Daily Cap: 60 Sends

- **NOT 72.** The spec explicitly set the cap at 60.
- 12 sends/hour × 5 hours (11 AM – 4 PM) = 60 maximum.
- The compliance document references 72/day in §4.2 — this is superseded by the spec's 60/day cap.

### 14.8 DealPack Auto-Email: 10:30 AM PT

- DealPack sends the saved report at **10:30 AM PT** (not earlier, not later)
- System ingests immediately on arrival
- 30-minute buffer before 11 AM send window allows for processing + morning payment application by Jessica

---

## Appendix A: Full Provisioning Checklist

Run these in order on a fresh CX22:

```bash
# A1. Base system
apt update && apt upgrade -y
timedatectl set-timezone America/Los_Angeles
hostnamectl set-hostname carson-sms

# A2. System user
useradd --system --no-create-home --shell /usr/sbin/nologin carson-sms

# A3. Packages
apt install -y curl git ufw fail2ban sqlite3 nginx certbot python3-certbot-nginx

# A4. Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# A5. Firewall
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable

# A6. fail2ban
systemctl enable fail2ban
systemctl start fail2ban

# A7. App directory
mkdir -p /opt/carson-sms/data/backups
mkdir -p /opt/carson-sms/data/imports/archive
chown -R carson-sms:carson-sms /opt/carson-sms

# A8. SSH hardening (see §12 — after key auth confirmed)

# A9. Deploy code (see §3.2)

# A10. Nginx + Certbot (see §13)

# A11. systemd service (see §3.3)

# A12. Backup cron (see §5.3)

# A13. UptimeRobot monitors (see §4)
```

---

## Appendix B: Environment Variables (.env)

```bash
# /opt/carson-sms/.env
# Twilio
TWILIO_ACCOUNT_SID=ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TWILIO_AUTH_TOKEN=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TWILIO_PHONE_NUMBER=+14256968488

# Anthropic (Claude Haiku)
ANTHROPIC_API_KEY=sk-ant-XXXXXXXXXXXXXXXXXXXXX

# Telegram Bot
TELEGRAM_BOT_TOKEN=XXXXXXXXXX:XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TELEGRAM_CHANNEL_ID=-100XXXXXXXXXX

# Database
DB_PATH=/opt/carson-sms/data/sms-collections.db

# Click log webhook
CLICK_LOG_SECRET=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Email ingestion (IMAP)
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=sms-collections@carsoncars.net
IMAP_PASS=XXXXXXXXXXXXXXXX
# NOTE: Gmail/Workspace requires App Password or OAuth for IMAP.
# Regular password won't work. If using M365/Exchange inbox instead,
# use Graph API with Mail.Read scope (no Mail.Send needed).

# Environment
NODE_ENV=production
PORT=3000
```

Permissions: `chmod 600 /opt/carson-sms/.env` — readable only by root (systemd reads it as root before dropping to `carson-sms` user).

---

## Appendix C: Record Retention

Per compliance document §5 and TCPA statute of limitations:

| Record Type | Retention | Reason |
|---|---|---|
| All SMS messages (sent + received) | **5 years minimum** | TCPA statute of limitations = 4 years; 5 years provides buffer |
| Opt-out records | **Permanent** | Must never re-contact an opted-out customer |
| Click logs | **5 years** | Evidence of customer engagement (supports TCPA defense) |
| DealPack import archives | **2 years** | Data provenance audit trail |
| Backup files (BX11) | **90 days rolling** | Disaster recovery (not compliance — compliance data lives in SQLite) |

SQLite database itself is never purged of compliance-relevant records. Backups provide point-in-time recovery; the live DB is the compliance record of truth.

---

**NO CODE WILL BE WRITTEN UNTIL THIS PLAN IS APPROVED BY MIKE AND CLAUDE.**
