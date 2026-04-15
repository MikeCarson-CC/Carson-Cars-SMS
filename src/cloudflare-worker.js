/**
 * Carson Cars Payment Link Redirect — Cloudflare Worker
 *
 * Deploy to Cloudflare Workers and assign to:
 *   Route: pay.carsoncars.net/*
 *
 * Environment variables (set in Cloudflare Workers dashboard):
 *   CLICK_LOG_WEBHOOK — e.g. https://sms.carsoncars.net/api/click
 *   CLICK_LOG_SECRET  — shared secret for webhook auth
 */

const EAUTOPAYMENT_URL = 'https://www.eautopayment.com/Registration?merchantAccountId=1503-2413-1611';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check for UptimeRobot
    if (path === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'pay.carsoncars.net' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Extract account number from path: /35668 or /pay/35668
    const accountMatch = path.match(/\/(\d{3,10})$/);
    if (!accountMatch) {
      // No valid account number — redirect to main site
      return Response.redirect('https://carsoncars.net', 302);
    }

    const accountNumber = accountMatch[1];

    // Fire-and-forget: log the click to main app
    const clickData = {
      account_number: accountNumber,
      clicked_at: new Date().toISOString(),
      ip_address: request.headers.get('CF-Connecting-IP') || 'unknown',
      user_agent: request.headers.get('User-Agent') || 'unknown',
      referrer: request.headers.get('Referer') || 'none'
    };

    const webhookUrl = env.CLICK_LOG_WEBHOOK || 'https://sms.carsoncars.net/api/click';
    const webhookSecret = env.CLICK_LOG_SECRET || '';

    // Use waitUntil to log the click without blocking the redirect
    ctx.waitUntil(
      fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': webhookSecret
        },
        body: JSON.stringify(clickData)
      }).catch(err => {
        // Log failure but don't block redirect
        console.error('Click log failed:', err.message);
      })
    );

    // 302 redirect to eAutoPayment
    // Note: eAutoPayment does NOT support account-level prefill
    // Customer must complete 6-field registration manually
    return Response.redirect(EAUTOPAYMENT_URL, 302);
  }
};
