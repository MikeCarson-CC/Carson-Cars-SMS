'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const AI_PROMPT_PATH = path.join(__dirname, '..', 'config', 'ai_prompt.md');

let _client = null;

function getClient() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY must be set');
  _client = new Anthropic({ apiKey });
  return _client;
}

function loadSystemPrompt() {
  return fs.readFileSync(AI_PROMPT_PATH, 'utf8');
}

// ──────────────────────────────────────────
// Build context for Haiku
// ──────────────────────────────────────────

function buildContext(customer, conversationHistory, inboundMessage) {
  const displayName = customer.nickname || customer.first_name || 'Customer';

  let context = `## Customer Profile\n`;
  context += `- Name: ${displayName} ${customer.last_name || ''}\n`;
  context += `- Account #: ${customer.account_number}\n`;
  context += `- Vehicle: ${customer.vehicle_year || ''} ${customer.vehicle_make || ''} ${customer.vehicle_model || ''}\n`;
  context += `- Past Due: $${customer.past_due_amount || 0}\n`;
  context += `- Days Past Due: ${customer.days_past_due || 0}\n`;
  context += `- Payment Amount: $${customer.payment_amount || 0}\n`;
  context += `- Payment Schedule: ${customer.payment_schedule || 'unknown'}\n`;
  context += `- Current State: ${customer.customer_state}\n`;
  context += `- Payment Link: Pay.CarsonCars.Net/${customer.account_number}\n\n`;

  if (conversationHistory && conversationHistory.length > 0) {
    context += `## Conversation History\n`;
    for (const msg of conversationHistory) {
      const dir = msg.direction === 'outbound' ? 'Maria (outbound)' : `${displayName} (inbound)`;
      context += `[${msg.timestamp}] ${dir}: ${msg.body}\n`;
    }
    context += '\n';
  }

  context += `## Latest Inbound Message\n`;
  context += `${displayName}: "${inboundMessage}"\n`;

  return context;
}

// ──────────────────────────────────────────
// Classify and draft
// ──────────────────────────────────────────

async function classifyAndDraft(customer, conversationHistory, inboundMessage) {
  const client = getClient();
  const systemPrompt = loadSystemPrompt();
  const userContext = buildContext(customer, conversationHistory, inboundMessage);

  try {
    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 500,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userContext }
      ]
    });

    const text = response.content[0]?.text || '';

    // Try to parse JSON from response
    let result;
    try {
      // Extract JSON from response (might be wrapped in markdown code block)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseErr) {
      console.error(`[Haiku] Failed to parse response: ${parseErr.message}`);
      console.error(`[Haiku] Raw response: ${text}`);
      result = {
        intent: 'unclear',
        confidence: 0.3,
        suggested_reply: null,
        escalation_flag: true,
        commitment_detected: false,
        commitment_details: null,
        language: 'en',
        notes: `Parse error: ${parseErr.message}. Raw: ${text.substring(0, 200)}`
      };
    }

    // Normalize the result
    return {
      intent: result.intent || 'unclear',
      confidence: result.confidence || 0.5,
      suggested_reply: result.suggested_reply || null,
      escalation_flag: !!result.escalation_flag,
      commitment_detected: !!result.commitment_detected,
      commitment_details: result.commitment_date || result.commitment_details || null,
      commitment_amount: result.commitment_amount || null,
      language: result.language || 'en',
      notes: result.notes || ''
    };
  } catch (err) {
    console.error(`[Haiku] API error: ${err.message}`);
    return {
      intent: 'unclear',
      confidence: 0,
      suggested_reply: null,
      escalation_flag: true,
      commitment_detected: false,
      commitment_details: null,
      language: 'en',
      notes: `API error: ${err.message}`
    };
  }
}

module.exports = {
  classifyAndDraft,
  buildContext,
  loadSystemPrompt
};
