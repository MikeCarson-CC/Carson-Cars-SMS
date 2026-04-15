#!/bin/bash
# Carson Cars SMS Collections — Daily Backup Script
# Runs daily at 5:00 AM PT (after send window closes, before next day's ingest)
# Cron: 0 12 * * * /opt/carson-sms/scripts/backup.sh >> /var/log/carson-sms-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="/opt/carson-sms/data/backups"
DB_PATH="/opt/carson-sms/data/sms-collections.db"
DATE=$(date +%Y-%m-%d)
BACKUP_FILE="${BACKUP_DIR}/sms-collections-${DATE}.db"
STORAGE_BOX="${STORAGE_BOX_USER:-u_XXXXXX}@${STORAGE_BOX_HOST:-u_XXXXXX.your-storagebox.de}"
REMOTE_DIR="/carson-sms-backups"

# Telegram alert function
alert_telegram() {
  local msg="$1"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHANNEL_ID:-}" ]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHANNEL_ID}" \
      -d "text=${msg}" > /dev/null 2>&1 || true
  fi
}

# Load environment if available
if [ -f /opt/carson-sms/.env ]; then
  set -a
  source /opt/carson-sms/.env
  set +a
fi

mkdir -p "${BACKUP_DIR}"

echo "[$(date)] Starting backup..."

# Step 1: Check if DB exists
if [ ! -f "${DB_PATH}" ]; then
  echo "[$(date)] ERROR: Database not found at ${DB_PATH}"
  alert_telegram "🚨 BACKUP FAILED: Database file not found at ${DB_PATH}"
  exit 1
fi

# Step 2: Safe SQLite backup (uses SQLite's .backup API — no lock contention)
sqlite3 "${DB_PATH}" ".backup '${BACKUP_FILE}'"
echo "[$(date)] SQLite backup created: ${BACKUP_FILE}"

# Step 3: Verify backup integrity
INTEGRITY=$(sqlite3 "${BACKUP_FILE}" "PRAGMA integrity_check;")
if [ "${INTEGRITY}" != "ok" ]; then
  echo "[$(date)] BACKUP INTEGRITY FAILED: ${INTEGRITY}"
  alert_telegram "🚨 BACKUP INTEGRITY FAILED for ${DATE}. Manual intervention required. Check: ${INTEGRITY}"
  rm -f "${BACKUP_FILE}"
  exit 1
fi
echo "[$(date)] Integrity check passed"

# Step 4: Get row count for verification
ROW_COUNT=$(sqlite3 "${BACKUP_FILE}" "SELECT COUNT(*) FROM customers;")
echo "[$(date)] Backup contains ${ROW_COUNT} customer records"

# Step 5: Compress
gzip -c "${BACKUP_FILE}" > "${BACKUP_FILE}.gz"
rm "${BACKUP_FILE}"
BACKUP_SIZE=$(du -h "${BACKUP_FILE}.gz" | cut -f1)
echo "[$(date)] Compressed: ${BACKUP_FILE}.gz (${BACKUP_SIZE})"

# Step 6: rsync to Hetzner Storage Box (if configured)
if [ "${STORAGE_BOX}" != "u_XXXXXX@u_XXXXXX.your-storagebox.de" ]; then
  rsync -avz -e "ssh -p 23" "${BACKUP_FILE}.gz" "${STORAGE_BOX}:${REMOTE_DIR}/" 2>&1
  echo "[$(date)] Synced to Storage Box"
else
  echo "[$(date)] Storage Box not configured — local backup only"
fi

# Step 7: Local retention — keep 90 days
DELETED=$(find "${BACKUP_DIR}" -name "*.db.gz" -mtime +90 -delete -print | wc -l)
if [ "${DELETED}" -gt 0 ]; then
  echo "[$(date)] Cleaned up ${DELETED} backups older than 90 days"
fi

# Step 8: Log success
echo "[$(date)] ✅ Backup completed: ${BACKUP_FILE}.gz (${BACKUP_SIZE}, ${ROW_COUNT} customers)"
