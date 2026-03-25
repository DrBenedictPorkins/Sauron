// Model and pricing — read from env, fallback to alias
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';

// Haiku pricing — https://www.anthropic.com/pricing
const PRICE_PER_INPUT_TOKEN = parseFloat(process.env.PRICE_INPUT_MTOK || '0.80') / 1_000_000;
const PRICE_PER_OUTPUT_TOKEN = parseFloat(process.env.PRICE_OUTPUT_MTOK || '4.00') / 1_000_000;

module.exports = { MODEL, PRICE_PER_INPUT_TOKEN, PRICE_PER_OUTPUT_TOKEN };
