'use strict';

const path = require('path');
const fs = require('fs');

// Load .env if it exists
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    const val = trimmed.substring(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

const db = require('./db');
const ingest = require('./ingest');
const scheduler = require('./scheduler');
const sender = require('./sender');
const report = require('./report');

const command = process.argv[2] || 'help';

// ──────────────────────────────────────────
// CLI commands
// ──────────────────────────────────────────

async function main() {
  switch (command) {
    case 'import': {
      const filePath = process.argv[3];
      if (!filePath) {
        console.error('Usage: node src/index.js import <file.xlsx|file.csv>');
        process.exit(1);
      }
      const absPath = path.resolve(filePath);
      console.log(`Importing from: ${absPath}`);
      const { results, errors } = ingest.ingestFile(absPath);
      console.log('\nImport Results:');
      console.log(`  Updated: ${results.updated}`);
      console.log(`  Inserted: ${results.inserted}`);
      console.log(`  Excluded: ${results.excluded}`);
      console.log(`  Skipped: ${results.skipped}`);
      console.log(`  Errors: ${results.errors}`);
      if (errors.length > 0) {
        console.log('\nErrors:');
        for (const e of errors) {
          console.log(`  Row ${e.row}: ${e.error}`);
        }
      }

      // Process broken promises
      const broken = ingest.processBrokenPromises();
      if (broken > 0) console.log(`\nBroken promises processed: ${broken}`);

      // Process stale conversations
      const stale = ingest.processStaleConversations();
      if (stale > 0) console.log(`Stale conversations returned to TEXTED: ${stale}`);

      break;
    }

    case 'dry-run': {
      const { queue, sentToday, dailyCap } = scheduler.buildSendQueue();
      console.log(`\nDry Run — Send Queue (${queue.length} customers)`);
      console.log(`Sent today: ${sentToday} / ${dailyCap} cap\n`);

      if (queue.length === 0) {
        console.log('No customers in queue.');
        break;
      }

      for (const customer of queue) {
        const preview = sender.dryRunMessage(customer, customer.template, {
          PromisedDate: customer.promised_date || ''
        });
        console.log(`[${preview.template}] ${preview.name} (${preview.account_number}) — $${preview.pastDue} past due — ${preview.phone}`);
        console.log(`  → ${preview.message.replace(/\n/g, ' ')}`);
        console.log('');
      }

      // Show exclusions
      const excluded = db.getExcludedCustomers();
      if (excluded.length > 0) {
        console.log(`\nExcluded (${excluded.length}):`);
        const reasons = {};
        for (const e of excluded) {
          reasons[e.reason] = (reasons[e.reason] || 0) + 1;
        }
        for (const [reason, count] of Object.entries(reasons)) {
          console.log(`  ${reason}: ${count}`);
        }
      }

      break;
    }

    case 'send': {
      // One-shot send: send next in queue
      if (!scheduler.isWithinSendWindow()) {
        console.log('Outside send window (11 AM – 4 PM PT, Mon-Fri). Use --force to override.');
        if (process.argv[3] !== '--force') {
          process.exit(0);
        }
      }

      if (scheduler.isPaused()) {
        console.log('System is PAUSED. Use RESUME via Telegram or update config.');
        process.exit(0);
      }

      const { queue } = scheduler.buildSendQueue();
      if (queue.length === 0) {
        console.log('Queue is empty — nothing to send.');
        break;
      }

      const next = queue[0];
      console.log(`Sending Template ${next.template} to ${next.account_number} (${sender.getDisplayName(next)})`);

      try {
        const result = await sender.sendToCustomer(next, next.template, {
          PromisedDate: next.promised_date || ''
        });
        console.log(`Sent! SID: ${result.sid}`);
      } catch (err) {
        console.error(`Send failed: ${err.message}`);
        process.exit(1);
      }

      break;
    }

    case 'stats': {
      const stats = db.getStats();
      const paused = scheduler.isPaused();
      const inWindow = scheduler.isWithinSendWindow();
      const { queue } = scheduler.buildSendQueue();

      console.log('\n📊 Carson Cars SMS Collections — Stats\n');
      console.log(`System: ${paused ? '⏸️ PAUSED' : inWindow ? '▶️ ACTIVE (in send window)' : '⏳ Outside send window'}`);
      console.log(`Total customers: ${stats.total}`);
      console.log(`Sends today: ${stats.sendsToday}`);
      console.log(`Total sends (all time): ${stats.totalSends}`);
      console.log(`Total replies: ${stats.totalReplies}`);
      console.log(`Opt-outs: ${stats.optOuts}`);
      console.log(`Queue ready: ${queue.length}`);
      console.log(`\nBy state:`);
      for (const s of stats.byState) {
        console.log(`  ${s.customer_state}: ${s.c}`);
      }

      const templateA = queue.filter(q => q.template === 'A').length;
      const templateB = queue.filter(q => q.template === 'B').length;
      const templateD = queue.filter(q => q.template === 'D').length;
      console.log(`\nQueue breakdown:`);
      console.log(`  Template A (first touch): ${templateA}`);
      console.log(`  Template B (follow-up): ${templateB}`);
      console.log(`  Template D (broken promise): ${templateD}`);

      break;
    }

    case 'report': {
      const reportText = report.generateDailyReport();
      console.log(reportText);
      break;
    }

    case 'serve': {
      console.log('Starting Carson Cars SMS Collections System...');

      // Start webhook server
      const webhook = require('./webhook');
      webhook.startServer();

      // Start Telegram bot
      const telegram = require('./telegram');
      telegram.getBot();
      telegram.scheduleDailyReport();

      // Start scheduler
      scheduler.startScheduler(
        async (customer, template) => {
          try {
            await sender.sendToCustomer(customer, template, {
              PromisedDate: customer.promised_date || ''
            });
          } catch (err) {
            console.error(`[Main] Send failed for ${customer.account_number}: ${err.message}`);
          }
        },
        async (message) => {
          await telegram.sendNotification(message);
        }
      );

      // Send window notifications
      const { DateTime } = require('luxon');
      setInterval(() => {
        const now = DateTime.now().setZone('America/Los_Angeles');
        // Notify at 11:00 AM
        if (now.hour === 11 && now.minute === 0 && now.weekday <= 5) {
          telegram.sendNotification('▶️ Send window open (11 AM – 4 PM PT)');
        }
        // Notify at 4:00 PM
        if (now.hour === 16 && now.minute === 0 && now.weekday <= 5) {
          telegram.sendNotification('⏹️ Send window closed. Resuming tomorrow at 11 AM PT.');
        }
      }, 60 * 1000);

      // Process broken promises and stale conversations periodically (every hour)
      setInterval(() => {
        try {
          const broken = ingest.processBrokenPromises();
          const stale = ingest.processStaleConversations();
          if (broken > 0 || stale > 0) {
            console.log(`[Main] Processed: ${broken} broken promises, ${stale} stale conversations`);
          }
        } catch (err) {
          console.error(`[Main] Processing error: ${err.message}`);
        }
      }, 60 * 60 * 1000);

      console.log('System ready. Press Ctrl+C to stop.');

      // Handle graceful shutdown
      process.on('SIGTERM', () => {
        console.log('Received SIGTERM, shutting down...');
        scheduler.stopScheduler();
        telegram.stopBot();
        db.closeDb();
        process.exit(0);
      });

      process.on('SIGINT', () => {
        console.log('Received SIGINT, shutting down...');
        scheduler.stopScheduler();
        telegram.stopBot();
        db.closeDb();
        process.exit(0);
      });

      break;
    }

    case 'help':
    default:
      console.log(`
Carson Cars SMS Collections System v2.0

Usage: node src/index.js <command> [options]

Commands:
  import <file>    Import DealPack export (.xlsx or .csv)
  dry-run          Show what would be sent without sending
  send [--force]   Send next message in queue
  stats            Show system statistics
  report           Generate daily report
  serve            Start the full system (webhook server + scheduler + Telegram bot)
  help             Show this help message

Examples:
  node src/index.js import data/dealpack-export.xlsx
  node src/index.js dry-run
  node src/index.js stats
  node src/index.js serve
`);
  }

  // Close DB for CLI commands (not serve)
  if (command !== 'serve') {
    db.closeDb();
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
