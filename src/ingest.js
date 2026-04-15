'use strict';

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const db = require('./db');

// ──────────────────────────────────────────
// Phone normalization
// ──────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return null;
  let phone = String(raw).trim();

  // Handle Excel scientific notation (4.2555E+09)
  if (/^\d+\.\d+[eE]\+?\d+$/.test(phone)) {
    phone = String(Number(phone));
  }

  // Remove trailing .0
  phone = phone.replace(/\.0+$/, '');

  // Strip non-digits
  const digits = phone.replace(/\D/g, '');

  // Must be 10 or 11 digit US number
  let cleaned;
  if (digits.length === 10) {
    cleaned = digits;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    cleaned = digits.slice(1);
  } else {
    return null; // Invalid
  }

  // Basic validation: area code can't start with 0 or 1
  if (cleaned[0] === '0' || cleaned[0] === '1') return null;

  return `+1${cleaned}`;
}

// ──────────────────────────────────────────
// Name resolution
// ──────────────────────────────────────────

function resolveDisplayName(row) {
  const nickname = getField(row, ['Nickname']);
  if (nickname && nickname.trim()) return nickname.trim();

  const firstName = getField(row, ['Customer First Name']);
  if (firstName && firstName.trim()) return firstName.trim();

  // Fallback: parse Primary Name (Last First Middle format)
  const primaryName = getField(row, ['Primary Name']);
  if (primaryName && primaryName.trim()) {
    const parts = primaryName.trim().split(/\s+/);
    if (parts.length >= 2) return parts[1]; // Second part is first name
    return parts[0];
  }

  return 'Customer';
}

// ──────────────────────────────────────────
// Field mapping helpers
// ──────────────────────────────────────────

function getField(row, possibleNames) {
  for (const name of possibleNames) {
    if (row[name] !== undefined && row[name] !== null) {
      return String(row[name]).trim();
    }
    // Also try lowercase/variations
    const lower = name.toLowerCase();
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() === lower) {
        return String(row[key]).trim();
      }
    }
  }
  return null;
}

function getNumericField(row, possibleNames) {
  const val = getField(row, possibleNames);
  if (!val) return 0;
  const num = parseFloat(val.replace(/[$,]/g, ''));
  return isNaN(num) ? 0 : num;
}

function getIntField(row, possibleNames) {
  const val = getField(row, possibleNames);
  if (!val) return 0;
  const num = parseInt(val, 10);
  return isNaN(num) ? 0 : num;
}

function getBoolField(row, possibleNames) {
  const val = getField(row, possibleNames);
  if (!val) return 0;
  const upper = val.toUpperCase();
  return (upper === 'Y' || upper === 'YES' || upper === 'TRUE' || upper === '1') ? 1 : 0;
}

// ──────────────────────────────────────────
// Exclusion checking
// ──────────────────────────────────────────

function loadExclusions() {
  const confPath = path.join(__dirname, '..', 'config', 'exclusions.json');
  if (!fs.existsSync(confPath)) return { hardcodedIds: new Set() };
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  const ids = new Set();
  if (conf.hardcodedExclusions) {
    for (const group of Object.values(conf.hardcodedExclusions)) {
      if (Array.isArray(group)) {
        for (const entry of group) {
          if (entry.customerIds) entry.customerIds.forEach(id => ids.add(String(id)));
        }
      }
    }
  }
  return { hardcodedIds: ids, excludedStatuses: conf.excludedStatuses || [] };
}

function shouldExclude(record, exclusionConfig) {
  const reasons = [];

  // Status-based exclusions
  const excludedStatuses = exclusionConfig.excludedStatuses || ['repo', 'charged_off', 'paid_off', 'BK', 'legal_hold'];
  if (excludedStatuses.includes(record.account_status)) {
    reasons.push(record.account_status);
  }

  // Flag-based exclusions
  if (record.bk_flag) reasons.push('bankruptcy');
  if (record.repo_flag) reasons.push('repo');
  if (record.legal_hold_flag) reasons.push('legal_hold');
  if (record.payment_plan_flag) reasons.push('payment_plan');
  if (record.do_not_contact_flag) reasons.push('do_not_contact');

  // No valid phone
  if (!record.cell_phone) reasons.push('no_phone');

  // Hardcoded exclusions
  if (exclusionConfig.hardcodedIds.has(record.account_number)) {
    reasons.push('hardcoded_exclusion');
  }

  // Already opted out in DB
  if (db.isOptedOut(record.account_number)) {
    reasons.push('opted_out');
  }

  return reasons;
}

// ──────────────────────────────────────────
// Main ingest function
// ──────────────────────────────────────────

function ingestFile(filePath, options = {}) {
  const { dryRun = false } = options;

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  let rows;

  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.readFile(filePath, { cellDates: true, cellNF: true, raw: false });
    const sheetName = workbook.SheetNames[0];
    console.log(`Reading sheet: "${sheetName}"`);
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  } else if (ext === '.csv') {
    const workbook = XLSX.readFile(filePath, { type: 'file' });
    const sheetName = workbook.SheetNames[0];
    rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  } else {
    throw new Error(`Unsupported file type: ${ext}. Use .xlsx, .xls, or .csv`);
  }

  if (!rows || rows.length === 0) {
    throw new Error('No data rows found in file');
  }

  console.log(`Found ${rows.length} rows in file`);

  const exclusionConfig = loadExclusions();
  const results = { updated: 0, inserted: 0, excluded: 0, errors: 0, skipped: 0 };
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      // Map DealPack columns to our schema
      const stockNbr = getField(row, ['StockNbr', 'Stock Nbr', 'Stock Number', 'StockNumber']);
      if (!stockNbr) {
        results.skipped++;
        continue;
      }

      const customerNbr = getField(row, ['CustomerNbr', 'Customer Nbr', 'CustomerNumber', 'Customer Number']);
      const firstName = getField(row, ['Customer First Name', 'First Name', 'FirstName']);
      const nickname = getField(row, ['Nickname', 'Nick Name']);
      const lastName = getField(row, ['Customer Last Name', 'Last Name', 'LastName']);
      const coBuyer = getField(row, ['Joint Name', 'Co-Buyer', 'CoBuyer', 'Co Buyer Name']);
      const primaryName = getField(row, ['Primary Name', 'PrimaryName']);

      // Phone normalization - only use Cell Phone Nbr
      const cellPhone = normalizePhone(getField(row, ['Cell Phone Nbr', 'Cell Phone', 'CellPhone', 'Cell']));
      // Joint Cell Phone and Phone Nbr1/Nbr2 are NOT used for texting
      // const jointCell = normalizePhone(getField(row, ['Joint Cell Phone']));

      // Loan info
      const pastDueAmount = getNumericField(row, ['Past Due Amount', 'PastDueAmount', 'Amount Past Due']);
      const daysPastDue = getIntField(row, ['Days Late', 'Days Past Due', 'DaysPastDue', 'DaysLate']);
      const paymentAmount = getNumericField(row, ['PaymentAmount', 'Payment Amount', 'Payment']);
      const paymentSchedule = getField(row, ['Payment Schedule', 'PaymentSchedule', 'PaymentFrequency', 'Payment Frequency']);

      // Vehicle
      const vehicleYear = getField(row, ['Year', 'Vehicle Year', 'VehicleYear']);
      const vehicleMake = getField(row, ['Make', 'Vehicle Make', 'VehicleMake']);
      const vehicleModel = getField(row, ['Model', 'Vehicle Model', 'VehicleModel']);
      const vin = getField(row, ['VIN', 'Vin']);

      // Status flags
      const bkFlag = getBoolField(row, ['Bankruptcy YN', 'Bankruptcy Flag', 'BankruptcyFlag', 'BK Flag']);
      const repoFlag = getBoolField(row, ['Out for Repo YN', 'Repo Status Flag', 'RepoFlag', 'Out For Repo']);
      const legalHoldFlag = getBoolField(row, ['Legal Hold Flag', 'LegalHoldFlag', 'Legal Hold']);
      const callsProhibited = getBoolField(row, ['Calls Prohibited YN', 'Do Not Contact Flag', 'DoNotContact', 'Calls Prohibited']);
      const accountFreeze = getBoolField(row, ['Account Freeze YN', 'Payment Plan Flag', 'PaymentPlanFlag', 'Account Freeze']);

      // Determine account status
      let accountStatus = 'active';
      if (bkFlag) accountStatus = 'BK';
      else if (repoFlag) accountStatus = 'repo';
      else if (legalHoldFlag) accountStatus = 'legal_hold';

      // Skip zero-balance accounts
      const balanceRemaining = getNumericField(row, ['Balance Remaining', 'BalanceRemaining', 'Principal Balance']);
      if (balanceRemaining <= 0 && pastDueAmount <= 0) {
        results.skipped++;
        continue;
      }

      const record = {
        account_number: String(stockNbr).trim(),
        customer_nbr: customerNbr || null,
        first_name: firstName || (primaryName ? resolveDisplayName(row) : null),
        nickname: nickname || null,
        last_name: lastName || null,
        co_buyer_name: coBuyer || null,
        cell_phone: cellPhone,
        language_pref: getField(row, ['Preferred Language', 'Language']) || 'en',
        vehicle_year: vehicleYear || null,
        vehicle_make: vehicleMake || null,
        vehicle_model: vehicleModel || null,
        vin: vin || null,
        past_due_amount: pastDueAmount,
        days_past_due: daysPastDue,
        payment_amount: paymentAmount,
        payment_schedule: paymentSchedule || null,
        account_status: accountStatus,
        bk_flag: bkFlag,
        repo_flag: repoFlag,
        legal_hold_flag: legalHoldFlag,
        payment_plan_flag: accountFreeze,
        do_not_contact_flag: callsProhibited
      };

      // Check exclusions
      const exclusionReasons = shouldExclude(record, exclusionConfig);

      if (dryRun) {
        const existing = db.getCustomerByAccount(record.account_number);
        if (existing) results.updated++;
        else results.inserted++;
        if (exclusionReasons.length > 0) {
          results.excluded++;
        }
        continue;
      }

      // Check if this is an existing customer
      const existing = db.getCustomerByAccount(record.account_number);

      // Upsert
      db.upsertCustomer(record);

      if (existing) {
        results.updated++;
      } else {
        results.inserted++;
      }

      // Log exclusions
      if (exclusionReasons.length > 0) {
        results.excluded++;
        for (const reason of exclusionReasons) {
          db.logExclusion(record.account_number, reason);
        }
      }

      // State machine updates based on new data
      if (existing) {
        // If customer was past due but now has zero balance → resolved
        if (existing.past_due_amount > 0 && pastDueAmount <= 0) {
          // Payment posted — check for fulfilled commitments
          // Don't change state if they're opted out
          if (existing.customer_state !== 'OPTED_OUT') {
            // Mark any unfulfilled commitments as fulfilled
            const commitments = db.getDb().prepare(`
              SELECT id FROM payment_commitments
              WHERE account_number = ? AND fulfilled = 0
            `).all(record.account_number);
            for (const c of commitments) {
              db.getDb().prepare(
                'UPDATE payment_commitments SET fulfilled = 1, fulfilled_at = datetime(\'now\') WHERE id = ?'
              ).run(c.id);
            }
          }
        }
      }
    } catch (err) {
      results.errors++;
      errors.push({ row: i + 1, error: err.message });
      console.error(`Error on row ${i + 1}: ${err.message}`);
    }
  }

  // Archive the processed file
  if (!dryRun) {
    try {
      const archiveDir = path.join(__dirname, '..', 'data', 'imports', 'archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      const dateStr = new Date().toISOString().slice(0, 10);
      const archiveName = `${dateStr}_${path.basename(filePath)}`;
      const archivePath = path.join(archiveDir, archiveName);
      fs.copyFileSync(filePath, archivePath);
      console.log(`Archived to: ${archivePath}`);
    } catch (err) {
      console.error(`Archive failed: ${err.message}`);
    }
  }

  return { results, errors };
}

// ──────────────────────────────────────────
// Broken promise processing
// ──────────────────────────────────────────

function processBrokenPromises() {
  const commitments = db.getUnfulfilledCommitmentsPastDue();
  let processed = 0;
  for (const c of commitments) {
    // Check if the customer is still past due after grace period
    const customer = db.getCustomerByAccount(c.account_number);
    if (customer && customer.past_due_amount > 0 && customer.customer_state === 'PROMISE_PENDING') {
      db.updateCustomerState(c.account_number, 'BROKEN_PROMISE');
      db.markBrokenPromiseProcessed(c.id);
      processed++;
    }
  }
  return processed;
}

// ──────────────────────────────────────────
// Stale conversation cleanup
// ──────────────────────────────────────────

function processStaleConversations() {
  // Conversations quiet for 7+ days, customer still past due → back to TEXTED
  const stale = db.getDb().prepare(`
    SELECT c.account_number FROM customers c
    WHERE c.customer_state = 'IN_CONVERSATION'
      AND c.past_due_amount > 0
      AND c.updated_at < datetime('now', '-7 days')
      AND c.account_number NOT IN (
        SELECT account_number FROM replies
        WHERE received_at > datetime('now', '-7 days')
      )
  `).all();
  let processed = 0;
  for (const row of stale) {
    db.updateCustomerState(row.account_number, 'TEXTED');
    processed++;
  }
  return processed;
}

module.exports = {
  ingestFile,
  processBrokenPromises,
  processStaleConversations,
  normalizePhone,
  resolveDisplayName
};
